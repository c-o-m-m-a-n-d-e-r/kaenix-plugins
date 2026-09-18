/**
 * @plugin    Naim Audio Player
 * @version   1.0.8
 * @author    Christian Brauwers
 * @website   https://www.kaenix.net
 */

'use strict';

const http = require('http');
const dgram = require('dgram');
const dns = require('dns').promises;

// ── Modulweiter Zustand pro Node-Instanz ──────────────────────────────────────

const _states = new Map();

// A request stays pending until a fresh playback report confirms the start.
function finishFavorite(state, request, status, error = '') {
  if (state.favoriteRequest !== request) return;
  clearTimeout(request.timer);
  clearTimeout(request.pollTimer);
  state.favoriteRequest = null;
  const result = { id: request.id, requestId: request.requestId, status, error };
  state.updateMediaState?.({ favoriteStatus: result });
}

function startFavorite(cfg, state, selection, action) {
  clearTimeout(state.favoriteRequest?.timer);
  clearTimeout(state.favoriteRequest?.pollTimer);
  const request = { id: String(selection.id), requestId: selection.requestId || String(Date.now()), accepted: false };
  state.favoriteRequest = request;
  const result = { id: request.id, requestId: request.requestId, status: 'loading' };
  state.updateMediaState?.({ favoriteStatus: result });
  request.timer = setTimeout(() => finishFavorite(state, request, 'error', 'Wiedergabe wurde nicht bestätigt.'), 20000);
  // Existing commands report failures through warn; keep the error tied to this request.
  const commandState = new Proxy(state, { get(target, key) {
    if (key === 'warn') return (...args) => {
      finishFavorite(state, request, 'error', args.join(' '));
      target.warn?.(...args);
    };
    return Reflect.get(target, key);
  } });
  Promise.resolve().then(() => state.favoriteRequest === request ? action(commandState) : undefined).then(() => {
    if (state.favoriteRequest !== request) return;
    request.accepted = true;
    const poll = async () => {
      if (state.favoriteRequest !== request) return;
      try { await fetchStatus(cfg, commandState); }
      catch (error) { finishFavorite(state, request, 'error', error.message); }
      if (state.favoriteRequest === request) request.pollTimer = setTimeout(poll, 1000);
    };
    return poll();
  }).catch(error => finishFavorite(state, request, 'error', error.message));
}

function confirmFavorite(state, data, request) {
  if (request && request === state.favoriteRequest && request.accepted && data.isPlaying && ['play', 'playing', 'stream'].includes(data.state)) {
    finishFavorite(state, request, 'playing');
  }
}


function getState(nodeId) {
  if (!_states.has(nodeId)) {
    _states.set(nodeId, {
      emit:        null,
      warn:        null,
      log:         null,
      nodeLog:     null,
      setStatus:   null,
      prevInputs:  {},
      prevEmitted: {},     // send-by-change
      timer:       null,
      ip:          null,
      port:        15081,
      power:       0,      // 0 = Standby / Aus, 1 = Ein
      state:       'standby', // 'playing' | 'paused' | 'stopped' | 'buffering' | 'standby'
      isPlaying:   0,
      volume:      0,
      mute:        0,
      title:       '',
      artist:      '',
      album:       '',
      source:      '',
      imageUrl:    '',
      trackText:   '',
      duration:    0,
      position:    0,
      shuffle:     0,
      repeat:      0,
      isFetching:  false,
      cfg:         null,
    });
  }
  return _states.get(nodeId);
}

// ── HTTP-Hilfsfunktionen ───────────────────────────────────────────────────────

function httpRequest(ip, port, method, path, bodyData = null, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let bodyStr = '';
    const headers = {
      'Connection': 'close',
      'User-Agent': 'kaenix-naim-plugin/1.0',
    };

    if (bodyData != null) {
      if (typeof bodyData === 'object') {
        bodyStr = JSON.stringify(bodyData);
        headers['Content-Type'] = 'application/json';
      } else {
        bodyStr = String(bodyData);
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(
      {
        hostname: ip,
        port: port || 15081,
        path,
        method: method || 'GET',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          if (raw && (raw.startsWith('{') || raw.startsWith('['))) {
            try {
              json = JSON.parse(raw);
            } catch (_) {}
          }
          resolve({ status: res.statusCode, body: raw, json });
        });
      }
    );

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP Timeout'));
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

// ── Status abrufen und Outputs emittieren ──────────────────────────────────────

// Polling darf identische Statusmeldungen nicht wiederholt ins Debug-Log schreiben.
function logStatusChange(state, message) {
  if (state.prevEmitted._debugStatus === message) return;
  state.prevEmitted._debugStatus = message;
  state.nodeLog?.(message);
}

function emitStatus(data, state, cfg, favoriteAtStart = null) {
  if (!state.emit || !data) return;
  confirmFavorite(state, data, favoriteAtStart);

  delete state.prevEmitted._connectionError;
  state.setStatus?.(true);
  state.power     = data.power;
  state.state     = data.state;
  state.isPlaying = data.isPlaying;
  state.volume    = data.volume;
  state.mute      = data.mute;
  state.title     = data.title;
  state.artist    = data.artist;
  state.album     = data.album;
  state.source    = data.source;
  state.imageUrl  = data.imageUrl;
  state.trackText = data.trackText;
  state.duration  = data.duration;
  state.position  = data.position;
  state.shuffle   = data.shuffle;
  state.repeat    = data.repeat;

  // Send-by-change Helfer
  const changed = (handle, value) => {
    if (value === undefined) return false;
    const cur = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
    if (state.prevEmitted[handle] === cur) return false;
    state.prevEmitted[handle] = cur;
    return true;
  };

  if (changed('connected', 1))              state.emit('connected', 1);
  if (changed('power', data.power))         state.emit('power', data.power);
  if (changed('isPlaying', data.isPlaying)) state.emit('isPlaying', data.isPlaying);
  if (changed('state', data.state))         state.emit('state', data.state);
  if (changed('volume', data.volume))       state.emit('volume', data.volume);
  if (changed('mute', data.mute))           state.emit('mute', data.mute);
  if (changed('title', data.title))         state.emit('title', data.title);
  if (changed('artist', data.artist))       state.emit('artist', data.artist);
  if (changed('album', data.album))         state.emit('album', data.album);
  if (changed('source', data.source))       state.emit('source', data.source);
  if (changed('imageUrl', data.imageUrl))   state.emit('imageUrl', data.imageUrl);
  if (changed('trackText', data.trackText)) state.emit('trackText', data.trackText);
  if (changed('duration', data.duration))   state.emit('duration', data.duration);
  if (changed('position', data.position))   state.emit('position', data.position);
  if (changed('shuffle', data.shuffle))     state.emit('shuffle', data.shuffle);
  if (changed('repeat', data.repeat))       state.emit('repeat', data.repeat);

  // Status an verknüpftes Musik-Widget senden
  if (state.updateMediaState) {
    let favoritesList = [];
    if (state.presets && state.presets.length > 0) {
      favoritesList = state.presets;
    }
    if (!favoritesList.length && state.globalSetting) {
      try {
        favoritesList = JSON.parse(state.globalSetting('mediaFavorites') || '[]');
      } catch (_) {}
    }

    state.updateMediaState({
      isPlaying: Boolean(data.isPlaying),
      state: data.state,
      volume: data.volume,
      isMuted: Boolean(data.mute),
      isPowerOn: Boolean(data.power),
      title: data.title,
      artist: data.artist,
      album: data.album,
      coverUrl: data.imageUrl,
      duration: data.duration,
      position: data.position,
      shuffle: Boolean(data.shuffle),
      repeat: data.repeat,
      favorites: favoritesList,
    });
  }

  // Status nur bei Änderung in der zentralen Debug-Ansicht ausgeben
  if (data.power === 0) {
    logStatusChange(state, '⏻ Standby');
  } else {
    const stateIcon = data.isPlaying ? '▶' : (data.state === 'paused' ? '⏸' : '⏹');
    const shortInfo = data.trackText
      ? data.trackText
      : (data.source || data.state);
    logStatusChange(state, `${stateIcon} ${shortInfo} (${data.volume}%)`);
  }
}

async function readPresets(cfg, state) {
  if (state.presetsReadAt && state.presets?.length && (Date.now() - state.presetsReadAt < 60000)) return state.presets || [];
  state.presetsReadAt = Date.now();
  try {
    const res = await httpRequest(cfg.ip, cfg.port, 'GET', '/presets', null, 3000);
    if (res.status === 200) {
      let rawList = [];
      if (res.json) {
        if (Array.isArray(res.json)) {
          rawList = res.json;
        } else if (Array.isArray(res.json.presets)) {
          rawList = res.json.presets;
        } else if (Array.isArray(res.json.item)) {
          rawList = res.json.item;
        } else if (Array.isArray(res.json.items)) {
          rawList = res.json.items;
        } else if (Array.isArray(res.json.data)) {
          rawList = res.json.data;
        } else if (Array.isArray(res.json.list)) {
          rawList = res.json.list;
        } else if (typeof res.json === 'object') {
          rawList = Object.entries(res.json).map(([k, v]) => ({ id: k, ...(typeof v === 'object' ? v : { name: v }) }));
        }
      }

      if (rawList.length > 0) {
        state.presets = rawList
          .filter(p => p && (p.name || p.title || p.id))
          .map((p, idx) => {
            let cover = p.artwork_url || p.artwork || p.icon || p.image || '';
            if (cover && cover.startsWith('/')) {
              cover = `http://${cfg.ip}:${cfg.port || 15081}${cover}`;
            }
            return {
              id: String(p.id ?? idx + 1),
              name: p.name || p.title || `Preset ${p.id ?? idx + 1}`,
              coverUrl: cover,
              kind: 'preset',
              value: String(p.id ?? idx + 1),
            };
          });
        return state.presets;
      }

      // XML Fallback
      if (res.body && typeof res.body === 'string') {
        const presets = [];
        const regex = /<(?:preset|item)(?:\s+([^>]*?))?>([\s\S]*?)<\/(?:preset|item)>/gi;
        let m;
        while ((m = regex.exec(res.body)) !== null) {
          const attrStr = m[1] || '';
          const innerXml = m[2] || '';
          const id = attrStr.match(/id=["']([^"']*)["']/i)?.[1] || upnpTag(innerXml, 'id') || String(presets.length + 1);
          const name = upnpTag(innerXml, 'name') || upnpTag(innerXml, 'title') || attrStr.match(/name=["']([^"']*)["']/i)?.[1] || `Preset ${id}`;
          let cover = upnpTag(innerXml, 'artwork_url') || upnpTag(innerXml, 'icon') || upnpTag(innerXml, 'image') || attrStr.match(/artwork_url=["']([^"']*)["']/i)?.[1] || '';
          if (cover && cover.startsWith('/')) {
            cover = `http://${cfg.ip}:${cfg.port || 15081}${cover}`;
          }
          presets.push({ id: String(id), name, coverUrl: cover, kind: 'preset', value: String(id) });
        }
        if (presets.length > 0) {
          state.presets = presets;
          return presets;
        }
      }
    }
  } catch (_) {}
  return state.presets || [];
}

async function fetchStatus(cfg, state) {
  if (!cfg.ip || state.isFetching || state.disposed) return;
  state.isFetching = true;
  const favoriteAtStart = state.favoriteRequest?.accepted ? state.favoriteRequest : null;

  try {
    const [resPower, resNowPlaying, resLevels] = await Promise.allSettled([
      httpRequest(cfg.ip, cfg.port, 'GET', '/power', null, 3000),
      httpRequest(cfg.ip, cfg.port, 'GET', '/nowplaying', null, 3000),
      httpRequest(cfg.ip, cfg.port, 'GET', '/levels/room', null, 3000),
      readPresets(cfg, state),
    ]);

    // Mindestens eine Anfrage muss erfolgreich sein
    const hasAnySuccess = (resPower.status === 'fulfilled' && resPower.value.status === 200) ||
                          (resNowPlaying.status === 'fulfilled' && resNowPlaying.value.status === 200) ||
                          (resLevels.status === 'fulfilled' && resLevels.value.status === 200);

    if (!hasAnySuccess) {
      const errReason = resPower.reason || resNowPlaying.reason || resLevels.reason || new Error('Keine Antwort');
      handleConnectionError(state, errReason);
      state.isFetching = false;
      return;
    }

    // 1. Power State
    let power = 1;
    if (resPower.status === 'fulfilled' && resPower.value.json) {
      const sys = String(resPower.value.json.system || '').toLowerCase();
      if (sys === 'lona' || sys === 'standby' || sys === 'networkstandby' || sys === 'off') {
        power = 0;
      } else if (sys === 'on' || sys === 'ready') {
        power = 1;
      }
    }

    // 2. Levels / Volume / Mute
    let volume = state.volume || 0;
    let mute   = state.mute || 0;
    if (resLevels.status === 'fulfilled' && resLevels.value.json) {
      const lj = resLevels.value.json;
      if (lj.volume != null) {
        volume = Math.max(0, Math.min(100, parseInt(lj.volume, 10) || 0));
      }
      if (lj.mute != null) {
        mute = (lj.mute === 1 || lj.mute === true || lj.mute === '1') ? 1 : 0;
      }
    }

    // 3. Now Playing / Metadata
    let rawState  = power === 0 ? 'standby' : 'stopped';
    let title     = '';
    let artist    = '';
    let album     = '';
    let source    = '';
    let image     = '';
    let duration  = 0;
    let position  = 0;
    let shuffle   = 0;
    let repeat    = 0;

    if (resNowPlaying.status === 'fulfilled' && resNowPlaying.value.json) {
      const np = resNowPlaying.value.json;
      const st = String(np.state || np.transportState || '').toLowerCase();
      if (st) {
        rawState = st;
      }

      title    = np.trackName || np.title || np.name || (rawState !== 'standby' ? state.title : '') || '';
      artist   = np.artistName || np.artist || ((title === state.title || !title) ? state.artist : '') || '';
      album    = np.albumName || np.album || ((title === state.title || !title) ? state.album : '') || '';
      source   = np.source || np.activeInput || state.source || '';
      image    = np.albumArtUrl || np.artwork || np.image || ((title === state.title || !title) ? state.imageUrl : '') || '';
      duration = parseInt(np.duration || 0, 10) || 0;
      position = parseInt(np.timePosition || np.position || 0, 10) || 0;

      // Shuffle
      if (np.shuffle === true || np.shuffle === 1 || np.shuffle === '1' || np.shuffle === 'on') {
        shuffle = 1;
      }

      // Repeat: off (0), all (1), one (2)
      if (np.repeat === 'all' || np.repeat === 1 || np.repeat === '1') {
        repeat = 1;
      } else if (np.repeat === 'one' || np.repeat === 2 || np.repeat === '2') {
        repeat = 2;
      } else {
        repeat = 0;
      }
    }

    const isPlaying = (power === 1 && (rawState === 'playing' || rawState === 'play' || rawState === 'buffering')) ? 1 : 0;

    // Formatierter Track-Text
    let trackText = '';
    if (artist && title) {
      trackText = `${artist} - ${title}`;
    } else if (title) {
      trackText = title;
    } else if (artist) {
      trackText = artist;
    }

    // Cover-URL absolut zusammensetzen wenn relativ
    let fullImageUrl = image;
    if (fullImageUrl && fullImageUrl.startsWith('/')) {
      fullImageUrl = `http://${cfg.ip}:${cfg.port || 15081}${fullImageUrl}`;
    }

    emitStatus({
      power,
      state: power === 0 ? 'standby' : rawState,
      isPlaying,
      volume,
      mute,
      title,
      artist,
      album,
      source,
      imageUrl: fullImageUrl,
      trackText,
      duration,
      position,
      shuffle,
      repeat,
    }, state, cfg, favoriteAtStart);

  } catch (e) {
    handleConnectionError(state, e);
  } finally {
    state.isFetching = false;
  }
}

function handleConnectionError(state, err) {
  if (state.prevEmitted['connected'] !== '0') {
    state.prevEmitted['connected'] = '0';
    state.emit?.('connected', 0);
  }
  state.setStatus?.(false);
  logStatusChange(state, '✗ getrennt');
  if (state.prevEmitted._connectionError !== err.message) {
    state.prevEmitted._connectionError = err.message;
    state.warn?.(`Naim Verbindungsfehler: ${err.message}`);
  }
}

// ── Steuerbefehle (Naim Player Commands) ───────────────────────────────────────

async function sendCommand(cfg, state, method, path, body = null) {
  if (!cfg.ip) {
    state.warn?.('Naim IP-Adresse nicht konfiguriert');
    return;
  }
  try {
    const response = await httpRequest(cfg.ip, cfg.port, method, path, body, 4000);
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    // Nach Befehl kurz warten und Status aktualisieren
    setTimeout(() => {
      fetchStatus(cfg, state);
    }, 200);
  } catch (e) {
    state.warn?.(`Naim Befehl (${method} ${path}) fehlgeschlagen: ${e.message}`);
  }
}

// ── Power ──

async function cmdPower(cfg, state, on) {
  const sysVal = on ? 'on' : 'lona';
  await sendCommand(cfg, state, 'POST', `/power?system=${sysVal}`);
}

async function cmdPowerToggle(cfg, state) {
  const newOn = state.power ? false : true;
  await cmdPower(cfg, state, newOn);
}

// ── Playback Controls ──

async function cmdPlay(cfg, state) {
  await sendCommand(cfg, state, 'POST', '/nowplaying?cmd=play');
}

async function cmdPause(cfg, state) {
  await sendCommand(cfg, state, 'POST', '/nowplaying?cmd=pause');
}

async function cmdStop(cfg, state) {
  await sendCommand(cfg, state, 'POST', '/nowplaying?cmd=stop');
}

async function cmdPlayPause(cfg, state) {
  if (state.isPlaying) {
    await cmdPause(cfg, state);
  } else {
    await cmdPlay(cfg, state);
  }
}

async function cmdNext(cfg, state) {
  await sendCommand(cfg, state, 'POST', '/nowplaying?cmd=next');
}

async function cmdPrev(cfg, state) {
  await sendCommand(cfg, state, 'POST', '/nowplaying?cmd=prev');
}

// ── Volume & Mute ──

async function cmdVolume(cfg, state, volume) {
  const level = Math.max(0, Math.min(100, parseInt(volume, 10) || 0));
  await sendCommand(cfg, state, 'POST', `/levels/room?volume=${level}`);
}

async function cmdVolumeInc(cfg, state, step = 2) {
  const s = Math.max(1, parseInt(step, 10) || 2);
  const newVol = Math.min(100, (state.volume || 0) + s);
  await cmdVolume(cfg, state, newVol);
}

async function cmdVolumeDec(cfg, state, step = 2) {
  const s = Math.max(1, parseInt(step, 10) || 2);
  const newVol = Math.max(0, (state.volume || 0) - s);
  await cmdVolume(cfg, state, newVol);
}

// KNX 4-Bit Relativdimmer (DPT 3.007):
// Bit 3 = Richtung (1=lauter, 0=leiser), Bits 0–2 = Schrittweite (1–7)
// Byte 0x00 = Stopp-Telegramm
async function cmdDim(cfg, state, val) {
  const byte = typeof val === 'number' ? val & 0xFF : parseInt(val, 10) & 0xFF;
  const step = byte & 0x07;
  if (step === 0) return; // Stopp-Telegramm

  const direction = (byte & 0x08) ? 1 : -1;
  const factor = cfg.volumeStep || 2;
  const change = step * factor;

  if (direction > 0) {
    await cmdVolumeInc(cfg, state, change);
  } else {
    await cmdVolumeDec(cfg, state, change);
  }
}

async function cmdMute(cfg, state, val) {
  const muteVal = (val === 1 || val === '1' || val === true) ? 1 : 0;
  await sendCommand(cfg, state, 'POST', `/levels/room?mute=${muteVal}`);
}

async function cmdMuteToggle(cfg, state) {
  const newMute = state.mute ? 0 : 1;
  await cmdMute(cfg, state, newMute);
}

// ── Quelle & Preset ──

async function cmdSource(cfg, state, sourceName) {
  if (!sourceName) return;
  const src = String(sourceName).trim();
  await sendCommand(cfg, state, 'POST', `/inputs?select=${encodeURIComponent(src)}`);
}

async function cmdPreset(cfg, state, presetId) {
  const id = parseInt(presetId, 10);
  if (isNaN(id) || id < 1) {
    state.warn?.(`Ungültige Preset-ID: ${presetId}`);
    return;
  }
  await sendCommand(cfg, state, 'POST', `/presets?id=${id}`);
}

// URL-Wiedergabe über den vom Gerät angekündigten UPnP-AVTransport-Service.
// Der Control-Pfad und Port werden aus der Gerätebeschreibung gelesen.
function upnpTag(xml, tag) {
  const value = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i'))?.[1] || '';
  return value.trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseUpnpTransport(xml, location) {
  const services = xml.match(/<(?:[\w-]+:)?service>[\s\S]*?<\/(?:[\w-]+:)?service>/gi) || [];
  const service = services.find(item => /^urn:schemas-upnp-org:service:AVTransport:\d+$/.test(upnpTag(item, 'serviceType')));
  if (!service || !upnpTag(service, 'controlURL')) throw new Error('Naim meldet keinen UPnP-AVTransport für URL-Wiedergabe');
  return { service: upnpTag(service, 'serviceType'), url: new URL(upnpTag(service, 'controlURL'), upnpTag(xml, 'URLBase') || location).href };
}

async function discoverUpnpTransport(cfg) {
  const { address } = await dns.lookup(cfg.ip, { family: 4 });
  const location = await new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Naim UPnP-Geräteerkennung: keine Antwort')), 4000);
    socket.on('error', error => finish(error));
    socket.on('message', (message, remote) => {
      if (remote.address !== address) return;
      const location = message.toString().match(/^location:\s*(.+)$/im)?.[1]?.trim();
      if (location) finish(null, location);
    });
    socket.bind(0, () => {
      const query = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:service:AVTransport:1\r\n\r\n');
      socket.send(query, 1900, '239.255.255.250', error => { if (error) finish(error); });
    });
  });
  const endpoint = new URL(location);
  if (endpoint.protocol !== 'http:') throw new Error('Nicht unterstützte UPnP-Gerätebeschreibung');
  const result = await httpRequest(endpoint.hostname, Number(endpoint.port) || 80, 'GET', endpoint.pathname + endpoint.search);
  if (result.status !== 200) throw new Error(`UPnP-Gerätebeschreibung HTTP ${result.status}`);
  return parseUpnpTransport(result.body, location);
}

function upnpAction(transport, action, args) {
  return new Promise((resolve, reject) => {
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${transport.service}">${args}</u:${action}></s:Body></s:Envelope>`;
    const req = http.request(transport.url, {
      method: 'POST', timeout: 4000,
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${transport.service}#${action}"`, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      res.resume();
      res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`UPnP ${action}: HTTP ${res.statusCode}`)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('UPnP Timeout')));
    req.end(body);
  });
}

async function cmdPlayUri(cfg, state, uri) {
  try {
    if (state.upnpHost !== cfg.ip || !state.upnpTransport) {
      state.upnpTransport = await discoverUpnpTransport(cfg);
      state.upnpHost = cfg.ip;
    }
    const escapedUri = String(uri).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    await upnpAction(state.upnpTransport, 'SetAVTransportURI', `<InstanceID>0</InstanceID><CurrentURI>${escapedUri}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>`);
    await upnpAction(state.upnpTransport, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
    fetchStatus(cfg, state);
  } catch (error) {
    state.upnpTransport = null;
    state.warn?.(`Naim URL-Wiedergabe: ${error.message}`);
  }
}

// ── Shuffle & Repeat ──

async function cmdShuffle(cfg, state, val) {
  const s = (val === 1 || val === '1' || val === true) ? 1 : 0;
  await sendCommand(cfg, state, 'POST', `/nowplaying?cmd=shuffle&value=${s}`);
}

async function cmdRepeat(cfg, state, val) {
  let repStr = 'off';
  const num = parseInt(val, 10);
  if (val === 'all' || num === 1) {
    repStr = 'all';
  } else if (val === 'one' || num === 2) {
    repStr = 'one';
  } else if (val === 'off' || num === 0) {
    repStr = 'off';
  }
  await sendCommand(cfg, state, 'POST', `/nowplaying?cmd=repeat&value=${repStr}`);
}

// ── Plugin-Export ──────────────────────────────────────────────────────────────

module.exports = {
  dispose(nodeId) {
    for (const id of nodeId == null ? [..._states.keys()] : [nodeId]) {
      const state = _states.get(id);
      if (!state) continue;
      clearTimeout(state.favoriteRequest?.timer);
      clearTimeout(state.favoriteRequest?.pollTimer);
      state.favoriteRequest = null;
      clearInterval(state.timer);
      state.disposed = true;
      state.emit = state.warn = state.nodeLog = state.setStatus = null;
      _states.delete(id);
    }
  },
  type:        'naim',
  category:    'Geräte',
  label:       'Naim Audio Player',
  description: 'Steuert Naim Audio Streaming-Geräte (Mu-so, Mu-so Qb, Uniti Atom/Star/Nova, ND5 XS 2, NDX 2, ND 555, NSC 222 etc.) über die Naim HTTP/REST-API. ' +
               'Unterstützt Power, Play/Pause, Stop, Next/Prev, Lautstärke (absolut, relativ, KNX 4-Bit DPT 3.007 Dimmer), ' +
               'Mute, Quellenwahl, Presets, Shuffle, Repeat und Status-Polling.',
  color:       '#009E49',

  inputs: [
    { handle: 'mediaFavorite', label: 'Favorit aus Musik-Widget (DPT28.001)' },
    { handle: 'power',         label: 'Power (0=Standby, 1=Ein)' },
    { handle: 'powerToggle',   label: 'Power Toggle (Trigger)' },
    { handle: 'play',          label: 'Play (Trigger)' },
    { handle: 'pause',         label: 'Pause (Trigger)' },
    { handle: 'stop',          label: 'Stop (Trigger)' },
    { handle: 'playPause',     label: 'Play/Pause Toggle (Trigger)' },
    { handle: 'next',          label: 'Nächster Titel (Trigger)' },
    { handle: 'prev',          label: 'Vorheriger Titel (Trigger)' },
    { handle: 'volume',        label: 'Lautstärke (0–100 %)' },
    { handle: 'volumeInc',     label: 'Lauter (Trigger)' },
    { handle: 'volumeDec',     label: 'Leiser (Trigger)' },
    { handle: 'dim',           label: 'Lautstärke Dimmer (KNX 4-Bit DPT 3.007)' },
    { handle: 'mute',          label: 'Stumm (0=Ton, 1=Mute)' },
    { handle: 'muteToggle',    label: 'Mute Toggle (Trigger)' },
    { handle: 'source',        label: 'Quelle / Eingang wählen (Name)' },
    { handle: 'preset',        label: 'Preset / Favorit abrufen (1–40)' },
    { handle: 'shuffle',       label: 'Zufallswiedergabe (0/1)' },
    { handle: 'repeat',        label: 'Wiederholung (0=Aus, 1=Alle, 2=Titel)' },
    { handle: 'triggerStatus', label: 'Status abfragen (Trigger)' },
  ],

  outputs: [
    { handle: 'connected',  label: 'Verbunden (0/1)' },
    { handle: 'power',      label: 'Power (0/1)' },
    { handle: 'isPlaying',  label: 'Wiedergabe aktiv (0/1)' },
    { handle: 'state',      label: 'Status (playing/paused/stopped/standby)' },
    { handle: 'volume',     label: 'Lautstärke (0–100 %)' },
    { handle: 'mute',       label: 'Stumm (0/1)' },
    { handle: 'title',      label: 'Titel / Song / Sender' },
    { handle: 'artist',     label: 'Künstler / Interpret' },
    { handle: 'album',      label: 'Album' },
    { handle: 'source',     label: 'Aktive Quelle / Eingang' },
    { handle: 'imageUrl',   label: 'Cover Art URL' },
    { handle: 'trackText',  label: 'Titelanzeige (Artist - Title)' },
    { handle: 'duration',   label: 'Dauer (Sekunden)' },
    { handle: 'position',   label: 'Position (Sekunden)' },
    { handle: 'shuffle',    label: 'Shuffle (0/1)' },
    { handle: 'repeat',     label: 'Repeat (0/1/2)' },
  ],

  mediaFavorites: true,
  globalSettings: [
    { key: 'mediaFavorites', label: 'Favoriten', type: 'favorites',
      description: 'Gemeinsame Favoritenliste für Musik-Widgets. IP und Port werden pro Baustein eingestellt.' },
  ],

  config: [
    {
      key:         'widgetId',
      label:       'Verknüpftes Musik-Widget (interne Steuerung)',
      type:        'media-widget-picker',
      description: 'Verknüpft diesen Player direkt mit einem Musik-Widget. Steuerung und Favoriten laufen intern ohne Gruppenadressen.',
    },
    {
      key:         'ip',
      label:       'IP-Adresse',
      type:        'text',
      placeholder: '192.168.1.60',
    },
    {
      key:         'port',
      label:       'Port (Standard: 15081)',
      type:        'number',
      placeholder: '15081',
    },
    {
      key:         'volumeStep',
      label:       'Schrittweite für Lauter/Leiser %',
      type:        'number',
      placeholder: '2',
      default:     2,
    },
    {
      key:         'interval',
      label:       'Status-Polling Intervall in Sekunden',
      type:        'number',
      placeholder: '2',
      default:     2,
    },
  ],

  handleCommand(command, value, data, context) {
    const nodeId = context.nodeId || 'default';
    const state  = getState(nodeId);
    state.emit             = (h, v) => context.emitOutput(h, v);
    state.warn             = (...a) => context.warn(...a);
    state.log              = (...a) => context.log(...a);
    state.nodeLog          = (...a) => context.nodeLog(...a);
    state.updateMediaState = (st) => context.updateMediaState?.(st);
    state.globalSetting    = (k) => context.globalSetting?.(k);

    const cfg = {
      ip:         String(data.ip || state.cfg?.ip || '').trim(),
      port:       parseInt(data.port || state.cfg?.port || '15081', 10),
      volumeStep: parseInt(data.volumeStep || state.cfg?.volumeStep || '2', 10),
      interval:   Math.max(1, parseInt(data.interval || state.cfg?.interval || '2', 10)),
    };
    state.cfg = cfg;

    if (!cfg.ip) {
      context.warn('Naim IP-Adresse nicht konfiguriert');
      return false;
    }

    switch (command) {
      case 'power':
        cmdPower(cfg, state, !!value);
        break;
      case 'powerToggle':
        cmdPowerToggle(cfg, state);
        break;
      case 'play':
        cmdPlay(cfg, state);
        break;
      case 'pause':
        cmdPause(cfg, state);
        break;
      case 'stop':
        cmdStop(cfg, state);
        break;
      case 'playPause':
      case 'togglePlay':
        cmdPlayPause(cfg, state);
        break;
      case 'next':
        cmdNext(cfg, state);
        break;
      case 'prev':
        cmdPrev(cfg, state);
        break;
      case 'volume':
        cmdVolume(cfg, state, value);
        break;
      case 'volumeInc':
        cmdVolumeInc(cfg, state, value || cfg.volumeStep);
        break;
      case 'volumeDec':
        cmdVolumeDec(cfg, state, value || cfg.volumeStep);
        break;
      case 'mute':
        cmdMute(cfg, state, value);
        break;
      case 'muteToggle':
        cmdMuteToggle(cfg, state);
        break;
      case 'source':
        cmdSource(cfg, state, value);
        break;
      case 'shuffle':
        cmdShuffle(cfg, state, value);
        break;
      case 'repeat':
        cmdRepeat(cfg, state, value);
        break;
      case 'favorite': {
        const selection = typeof value === 'object' && value !== null ? value : { id: value };
        startFavorite(cfg, state, selection, async commandState => {
          const entries = JSON.parse(context.globalSetting('mediaFavorites') || '[]');
          const entry = selection.kind ? selection : entries.find(f => String(f.id) === String(selection.id));
          if (entry?.kind === 'url') await cmdPlayUri(cfg, commandState, entry.value);
          else await cmdPreset(cfg, commandState, entry?.value || selection.id);
        });
        break;
      }
      default:
        return false;
    }
    return true;
  },

  execute(inputs, data, context) {
    const nodeId = context.nodeId || 'default';
    const state  = getState(nodeId);

    // Callbacks aktualisieren
    state.emit             = (h, v) => context.emitOutput(h, v);
    state.warn             = (...a) => context.warn(...a);
    state.log              = (...a) => context.log(...a);
    state.nodeLog          = (...a) => context.nodeLog(...a);
    state.setStatus        = (connected) => context.setNodeStatus(connected);
    state.updateMediaState = (st) => context.updateMediaState?.(st);
    state.globalSetting    = (k) => context.globalSetting?.(k);

    // Konfiguration zusammenführen
    const cfg = {
      ip:         String(data.ip || '').trim(),
      port:       parseInt(data.port || '15081', 10),
      volumeStep: parseInt(data.volumeStep || '2', 10),
      interval:   Math.max(1, parseInt(data.interval || '2', 10)),
    };
    state.cfg = cfg;

    if (!cfg.ip) {
      context.warn('Naim IP-Adresse nicht konfiguriert (im Baustein einstellen)');
      context.nodeLog('✗ Keine IP');
      context.setNodeStatus(false);
      return {};
    }

    // Verbindungsparameter geändert → Zustand zurücksetzen
    const endpointChanged = state.ip !== cfg.ip || state.port !== cfg.port;
    if (endpointChanged) {
      state.ip = cfg.ip;
      state.port = cfg.port;
      state.prevEmitted = {};
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
    }

    // Polling-Timer verwalten
    if (!state.timer) {
      state.timer = setInterval(() => fetchStatus(cfg, state), cfg.interval * 1000);
      fetchStatus(cfg, state);
    }

    if (context.initialInputs) {
      state.prevInputs = { ...context.initialInputs };
      return {};
    }

    // Prüfen, ob sich ein Eingang geändert hat (Flankenerkennung für Trigger & Wertänderungen)
    const prev = state.prevInputs;
    const isTriggered = (handle) => {
      const val = inputs[handle];
      if (val === undefined || val === null) return false;
      if (prev[handle] === val) return false;
      return !!val;
    };

    const hasChanged = (handle) => {
      const val = inputs[handle];
      if (val === undefined || val === null) return false;
      return prev[handle] !== val;
    };

    // Auswahl enthält nur die ID; Name, Art und Wert stammen aus der gespeicherten Liste.
    if (hasChanged('mediaFavorite')) {
      try {
        const selection = JSON.parse(String(inputs.mediaFavorite));
        startFavorite(cfg, state, selection, async commandState => {
          if (selection.list !== 'naim') throw new Error('Favoritenliste passt nicht zum Plugin');
          const entries = JSON.parse(context.globalSetting('mediaFavorites') || '[]');
          const entry = entries.find(item => item.id === selection.id);
          if (!entry) throw new Error('Favorit nicht mehr vorhanden');
          if (entry.kind === 'preset') await cmdPreset(cfg, commandState, entry.value);
          else if (entry.kind === 'url') await cmdPlayUri(cfg, commandState, entry.value);
          else throw new Error('Unbekannte Favoritenart');
        });
      } catch (error) { state.warn?.(`Favorit: ${error.message}`); }
      state.prevInputs = { ...inputs };
      return {};
    }

    // ── Befehle ausführen ──

    if (hasChanged('power')) {
      cmdPower(cfg, state, !!inputs.power);
    } else if (isTriggered('powerToggle')) {
      cmdPowerToggle(cfg, state);
    } else if (isTriggered('play')) {
      cmdPlay(cfg, state);
    } else if (isTriggered('pause')) {
      cmdPause(cfg, state);
    } else if (isTriggered('stop')) {
      cmdStop(cfg, state);
    } else if (isTriggered('playPause')) {
      cmdPlayPause(cfg, state);
    } else if (isTriggered('next')) {
      cmdNext(cfg, state);
    } else if (isTriggered('prev')) {
      cmdPrev(cfg, state);
    } else if (isTriggered('volumeInc')) {
      const step = typeof inputs.volumeInc === 'number' && inputs.volumeInc > 1 ? inputs.volumeInc : cfg.volumeStep;
      cmdVolumeInc(cfg, state, step);
    } else if (isTriggered('volumeDec')) {
      const step = typeof inputs.volumeDec === 'number' && inputs.volumeDec > 1 ? inputs.volumeDec : cfg.volumeStep;
      cmdVolumeDec(cfg, state, step);
    } else if (hasChanged('dim')) {
      cmdDim(cfg, state, inputs.dim);
    } else if (hasChanged('volume')) {
      cmdVolume(cfg, state, inputs.volume);
    } else if (hasChanged('mute')) {
      cmdMute(cfg, state, inputs.mute);
    } else if (isTriggered('muteToggle')) {
      cmdMuteToggle(cfg, state);
    } else if (hasChanged('source')) {
      if (inputs.source) cmdSource(cfg, state, inputs.source);
    } else if (hasChanged('preset')) {
      if (inputs.preset) cmdPreset(cfg, state, inputs.preset);
    } else if (hasChanged('shuffle')) {
      cmdShuffle(cfg, state, inputs.shuffle);
    } else if (hasChanged('repeat')) {
      cmdRepeat(cfg, state, inputs.repeat);
    } else if (isTriggered('triggerStatus')) {
      fetchStatus(cfg, state);
    } else if (Object.keys(inputs).length === 0) {
      // Erstaufruf ohne Inputs → Initialen Status holen
      fetchStatus(cfg, state);
    }

    // Vorherige Inputs sichern
    state.prevInputs = { ...inputs };

    return {};
  },
};
