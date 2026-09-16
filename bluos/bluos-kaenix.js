/**
 * @plugin    BluOS Player
 * @version   1.0.0
 * @author    kaenix
 * @website   https://www.kaenix.net
 */

'use strict';

const http = require('http');

// ── Modulweiter Zustand pro Node-Instanz ──────────────────────────────────────

const _states = new Map();

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
      port:        11000,
      state:       'stop', // 'play' | 'pause' | 'stop' | 'stream' | 'connecting'
      volume:      0,
      mute:        0,
      title:       '',
      artist:      '',
      album:       '',
      service:     '',
      imageUrl:    '',
      lpRunning:   false,  // Long-Poll-Loop aktiv
      lpAbort:     false,  // Flag zum Beenden der Loop
      lpEtag:      null,   // letzter empfangener ETag
      lpReq:       null,   // aktiver HTTP-Request
      cfg:         null,
    });
  }
  return _states.get(nodeId);
}

// ── XML-Hilfsfunktionen ────────────────────────────────────────────────────────

function unescapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function getXmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? unescapeXml(m[1].trim()) : null;
}

function getXmlAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']*)["']`, 'i'));
  return m ? unescapeXml(m[1].trim()) : null;
}

function parseStatusXml(xml) {
  if (!xml || typeof xml !== 'string') return null;

  // ETag kann als Tag oder Attribut vorliegen
  const etagAttr = getXmlAttr(xml, 'status', 'etag');
  const etagTag  = getXmlTag(xml, 'etag');
  const etag     = etagAttr || etagTag || null;

  const state      = (getXmlTag(xml, 'state') || 'stop').toLowerCase();
  const rawVol     = getXmlTag(xml, 'volume');
  const rawMute    = getXmlTag(xml, 'mute');
  const title1     = getXmlTag(xml, 'title1') || '';
  const title2     = getXmlTag(xml, 'title2') || '';
  const title3     = getXmlTag(xml, 'title3') || '';
  const rawArtist  = getXmlTag(xml, 'artist') || '';
  const rawAlbum   = getXmlTag(xml, 'album') || '';
  const image      = getXmlTag(xml, 'image') || '';
  const service    = getXmlTag(xml, 'service') || '';
  const rawShuffle = getXmlTag(xml, 'shuffle');
  const rawRepeat  = getXmlTag(xml, 'repeat');
  const name       = getXmlTag(xml, 'name') || '';

  // Titel/Künstler-Zuordnung bei BluOS:
  // title1 = Song-Titel (oder Sendername bei Radio)
  // title2 = Artist (oder Unterzeile)
  // title3 = Album
  const title  = title1;
  const artist = rawArtist || title2;
  const album  = rawAlbum || title3;

  // Formatierter Track-Text
  let trackText = '';
  if (artist && title) {
    trackText = `${artist} - ${title}`;
  } else if (title) {
    trackText = title;
  } else if (artist) {
    trackText = artist;
  }

  const volume = rawVol != null && rawVol !== '' ? Math.max(0, Math.min(100, parseInt(rawVol, 10))) : 0;
  const mute   = rawMute === '1' || rawMute === 'true' ? 1 : 0;
  const isPlaying = (state === 'play' || state === 'stream') ? 1 : 0;
  const shuffle   = rawShuffle === '1' ? 1 : 0;
  const repeat    = rawRepeat != null ? parseInt(rawRepeat, 10) || 0 : 0;

  return {
    etag,
    state,
    isPlaying,
    volume,
    mute,
    title,
    artist,
    album,
    service,
    image,
    trackText,
    shuffle,
    repeat,
    name,
  };
}

// ── HTTP-Hilfsfunktionen ───────────────────────────────────────────────────────

function httpRequest(ip, port, path, timeoutMs = 8000, reqRef = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: ip,
        port: port || 11000,
        path,
        method: 'GET',
        headers: {
          'Connection': 'close',
          'User-Agent': 'kaenix-bluos-plugin/1.0',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );

    if (reqRef && typeof reqRef === 'object') {
      reqRef.current = req;
    }

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP Timeout'));
    });

    req.end();
  });
}

// ── Status abrufen und Outputs emittieren ──────────────────────────────────────

function emitStatus(statusData, state, cfg) {
  if (!state.emit || !statusData) return;

  state.setStatus?.(true);
  state.state   = statusData.state;
  state.volume  = statusData.volume;
  state.mute    = statusData.mute;
  state.title   = statusData.title;
  state.artist  = statusData.artist;
  state.album   = statusData.album;
  state.service = statusData.service;

  // Vollständige Image-URL zusammensetzen
  let fullImageUrl = statusData.image || '';
  if (fullImageUrl && fullImageUrl.startsWith('/')) {
    fullImageUrl = `http://${cfg.ip}:${cfg.port || 11000}${fullImageUrl}`;
  }
  state.imageUrl = fullImageUrl;

  // Send-by-change Helfer
  const changed = (handle, value) => {
    const cur = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (state.prevEmitted[handle] === cur) return false;
    state.prevEmitted[handle] = cur;
    return true;
  };

  if (changed('connected', 1)) state.emit('connected', 1);
  if (changed('isPlaying', statusData.isPlaying)) state.emit('isPlaying', statusData.isPlaying);
  if (changed('state', statusData.state)) state.emit('state', statusData.state);
  if (changed('volume', statusData.volume)) state.emit('volume', statusData.volume);
  if (changed('mute', statusData.mute)) state.emit('mute', statusData.mute);
  if (changed('title', statusData.title)) state.emit('title', statusData.title);
  if (changed('artist', statusData.artist)) state.emit('artist', statusData.artist);
  if (changed('album', statusData.album)) state.emit('album', statusData.album);
  if (changed('service', statusData.service)) state.emit('service', statusData.service);
  if (changed('imageUrl', fullImageUrl)) state.emit('imageUrl', fullImageUrl);
  if (changed('trackText', statusData.trackText)) state.emit('trackText', statusData.trackText);
  if (changed('shuffle', statusData.shuffle)) state.emit('shuffle', statusData.shuffle);
  if (changed('repeat', statusData.repeat)) state.emit('repeat', statusData.repeat);

  // Status-Text für die Logic-Node im Editor
  const stateIcon = statusData.isPlaying ? '▶' : (statusData.state === 'pause' ? '⏸' : '⏹');
  const shortInfo = statusData.trackText
    ? (statusData.trackText.length > 25 ? statusData.trackText.substring(0, 22) + '...' : statusData.trackText)
    : statusData.state;
  state.nodeLog?.(`${stateIcon} ${shortInfo} (${statusData.volume}%)`);
}

async function fetchStatus(cfg, state) {
  if (!cfg.ip) return;
  try {
    const res = await httpRequest(cfg.ip, cfg.port, '/Status', 5000);
    if (res.status === 200) {
      const parsed = parseStatusXml(res.body);
      if (parsed) {
        if (parsed.etag) state.lpEtag = parsed.etag;
        emitStatus(parsed, state, cfg);
      }
    } else {
      handleConnectionError(state, new Error(`HTTP ${res.status}`));
    }
  } catch (e) {
    handleConnectionError(state, e);
  }
}

function handleConnectionError(state, err) {
  if (state.prevEmitted['connected'] !== '0') {
    state.prevEmitted['connected'] = '0';
    state.emit?.('connected', 0);
  }
  state.setStatus?.(false);
  state.nodeLog?.('✗ getrennt');
  state.warn?.(`BluOS Verbindungsfehler: ${err.message}`);
}

// ── Long-Polling Schleife ─────────────────────────────────────────────────────

function stopLongPoll(state) {
  state.lpAbort = true;
  if (state.lpReq?.current) {
    try {
      state.lpReq.current.destroy();
    } catch (_) {}
    state.lpReq = null;
  }
}

function startLongPoll(cfg, state) {
  if (state.lpRunning) return;
  state.lpAbort   = false;
  state.lpRunning = true;

  (async () => {
    while (!state.lpAbort && (state.cfg?.longPoll ?? cfg.longPoll)) {
      const currentCfg = state.cfg || cfg;
      if (!currentCfg.ip) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      try {
        const etagParam = state.lpEtag ? `&etag=${encodeURIComponent(state.lpEtag)}` : '';
        const path = `/Status?timeout=30${etagParam}`;
        const reqRef = { current: null };
        state.lpReq = reqRef;

        const res = await httpRequest(currentCfg.ip, currentCfg.port, path, 35000, reqRef);
        state.lpReq = null;

        if (state.lpAbort) break;

        if (res.status === 200) {
          const parsed = parseStatusXml(res.body);
          if (parsed) {
            if (parsed.etag) state.lpEtag = parsed.etag;
            emitStatus(parsed, state, currentCfg);
          }
        } else {
          handleConnectionError(state, new Error(`HTTP ${res.status}`));
          await new Promise((r) => setTimeout(r, 4000));
        }
      } catch (e) {
        state.lpReq = null;
        if (state.lpAbort) break;

        // Wenn es nur ein Timeout war, sofort weiter pollen
        if (e.message === 'HTTP Timeout' || e.code === 'ECONNRESET') {
          // Normales Long-Poll Timeout – sofort wieder anfragen
          await new Promise((r) => setTimeout(r, 200));
        } else {
          handleConnectionError(state, e);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
    state.lpRunning = false;
  })();
}

// ── Steuerbefehle (Player Commands) ───────────────────────────────────────────

async function sendCommand(cfg, state, cmdPath) {
  if (!cfg.ip) {
    state.warn?.('BluOS IP-Adresse nicht konfiguriert');
    return;
  }
  try {
    const res = await httpRequest(cfg.ip, cfg.port, cmdPath, 5000);
    if (res.status === 200) {
      const parsed = parseStatusXml(res.body);
      if (parsed) {
        if (parsed.etag) state.lpEtag = parsed.etag;
        emitStatus(parsed, state, cfg);
      }
    }
  } catch (e) {
    state.warn?.(`BluOS Befehl (${cmdPath}) fehlgeschlagen: ${e.message}`);
  }
}

async function cmdPlay(cfg, state) {
  await sendCommand(cfg, state, '/Play');
}

async function cmdPause(cfg, state) {
  await sendCommand(cfg, state, '/Pause');
}

async function cmdStop(cfg, state) {
  await sendCommand(cfg, state, '/Stop');
}

async function cmdPlayPause(cfg, state) {
  await sendCommand(cfg, state, '/Pause?toggle=1');
}

async function cmdNext(cfg, state) {
  await sendCommand(cfg, state, '/Skip');
}

async function cmdPrev(cfg, state) {
  await sendCommand(cfg, state, '/Back');
}

async function cmdVolume(cfg, state, volume) {
  const level = Math.max(0, Math.min(100, parseInt(volume, 10) || 0));
  await sendCommand(cfg, state, `/Volume?level=${level}`);
}

async function cmdVolumeInc(cfg, state, step = 2) {
  const s = Math.max(1, parseInt(step, 10) || 2);
  await sendCommand(cfg, state, `/Volume?inc=${s}`);
}

async function cmdVolumeDec(cfg, state, step = 2) {
  const s = Math.max(1, parseInt(step, 10) || 2);
  await sendCommand(cfg, state, `/Volume?dec=${s}`);
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
  await sendCommand(cfg, state, `/Volume?mute=${muteVal}`);
}

async function cmdMuteToggle(cfg, state) {
  const newMute = state.mute ? 0 : 1;
  await sendCommand(cfg, state, `/Volume?mute=${newMute}`);
}

async function cmdPreset(cfg, state, presetId) {
  const id = parseInt(presetId, 10);
  if (isNaN(id) || id < 1) {
    state.warn?.(`Ungültige Preset-ID: ${presetId}`);
    return;
  }
  await sendCommand(cfg, state, `/Preset?id=${id}`);
}

async function cmdShuffle(cfg, state, val) {
  const s = (val === 1 || val === '1' || val === true) ? 1 : 0;
  await sendCommand(cfg, state, `/Shuffle?state=${s}`);
}

async function cmdRepeat(cfg, state, val) {
  const r = Math.max(0, Math.min(2, parseInt(val, 10) || 0));
  await sendCommand(cfg, state, `/Repeat?state=${r}`);
}

// ── Plugin-Export ──────────────────────────────────────────────────────────────

module.exports = {
  type:        'bluos',
  category:    'Geräte',
  label:       'BluOS Player',
  description: 'Steuert BluOS-fähige Audioplayer (Bluesound, NAD, DALI etc.) über die BluOS HTTP-API. ' +
               'Unterstützt Play/Pause, Stop, Next/Prev, Lautstärke (absolut, relativ, KNX 4-Bit DPT 3.007 Dimmer), ' +
               'Mute, Presets, Shuffle, Repeat und Status-Long-Polling.',
  color:       '#0070BA',

  inputs: [
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
    { handle: 'preset',        label: 'Preset abrufen (1–40)' },
    { handle: 'shuffle',       label: 'Zufallswiedergabe (0/1)' },
    { handle: 'repeat',        label: 'Wiederholung (0=Aus, 1=Alle, 2=Titel)' },
    { handle: 'triggerStatus', label: 'Status abfragen (Trigger)' },
  ],

  outputs: [
    { handle: 'connected',  label: 'Verbunden (0/1)' },
    { handle: 'isPlaying',  label: 'Wiedergabe aktiv (0/1)' },
    { handle: 'state',      label: 'Status (play/pause/stop/stream)' },
    { handle: 'volume',     label: 'Lautstärke (0–100 %)' },
    { handle: 'mute',       label: 'Stumm (0/1)' },
    { handle: 'title',      label: 'Titel / Song / Sender' },
    { handle: 'artist',     label: 'Künstler / Interpret' },
    { handle: 'album',      label: 'Album' },
    { handle: 'service',    label: 'Musikdienst / Quelle' },
    { handle: 'imageUrl',   label: 'Cover Art URL' },
    { handle: 'trackText',  label: 'Titelanzeige (Artist - Title)' },
    { handle: 'shuffle',    label: 'Shuffle (0/1)' },
    { handle: 'repeat',     label: 'Repeat (0/1/2)' },
  ],

  globalSettings: [
    {
      key:         'ip',
      label:       'BluOS Player IP-Adresse',
      type:        'text',
      placeholder: '192.168.1.50',
      description: 'Standard-IP-Adresse des BluOS Players',
    },
    {
      key:         'port',
      label:       'Port',
      type:        'number',
      placeholder: '11000',
      description: 'Standard-Port der BluOS HTTP-API (11000)',
    },
  ],

  config: [
    {
      key:         'ip',
      label:       'IP-Adresse (überschreibt globale Einstellung)',
      type:        'text',
      placeholder: '192.168.1.50',
    },
    {
      key:         'port',
      label:       'Port (Standard: 11000)',
      type:        'number',
      placeholder: '11000',
    },
    {
      key:         'volumeStep',
      label:       'Schrittweite für Lauter/Leiser %',
      type:        'number',
      placeholder: '2',
      default:     2,
    },
    {
      key:         'longPoll',
      label:       'Long-Polling (Sofort-Updates bei Track/Volume/Status-Wechsel)',
      type:        'select',
      options: [
        { value: '1', label: 'Aktiviert (empfohlen)' },
        { value: '0', label: 'Deaktiviert' },
      ],
      default: '1',
    },
    {
      key:         'interval',
      label:       'Intervall-Polling Sek. (Fallback bei deaktiviertem Long-Polling)',
      type:        'number',
      placeholder: '10',
    },
  ],

  execute(inputs, data, context) {
    const nodeId = context.nodeId || 'default';
    const state  = getState(nodeId);

    // Callbacks aktualisieren
    state.emit      = (h, v) => context.emitOutput(h, v);
    state.warn      = (...a) => context.warn(...a);
    state.log       = (...a) => context.log(...a);
    state.nodeLog   = (...a) => context.nodeLog(...a);
    state.setStatus = (connected) => context.setNodeStatus(connected);

    // Konfiguration zusammenführen
    const cfg = {
      ip:         (data.ip && String(data.ip).trim()) || (context.globalSetting('ip') || '').trim(),
      port:       parseInt(data.port || context.globalSetting('port') || '11000', 10),
      volumeStep: parseInt(data.volumeStep || '2', 10),
      longPoll:   data.longPoll !== '0',
      interval:   parseInt(data.interval || '0', 10),
    };
    state.cfg = cfg;

    if (!cfg.ip) {
      context.warn('BluOS IP-Adresse nicht konfiguriert (weder in Node-Config noch in globalen Einstellungen)');
      context.nodeLog('✗ Keine IP');
      context.setNodeStatus(false);
      return {};
    }

    // Polling / Long-Polling initialisieren
    if (cfg.longPoll) {
      if (!state.lpRunning) {
        startLongPoll(cfg, state);
      }
    } else {
      stopLongPoll(state);
      if (cfg.interval > 0 && !state.timer) {
        state.timer = setInterval(() => fetchStatus(cfg, state), cfg.interval * 1000);
        fetchStatus(cfg, state);
      }
    }

    // Prüfen, ob sich ein Eingang geändert hat (Flankenerkennung für Trigger & Wertänderungen)
    const prev = state.prevInputs;
    const isTriggered = (handle) => {
      const val = inputs[handle];
      if (val === undefined || val === null) return false;
      // Bei boolean/numerischen Triggern: nur wenn neu und truthy
      if (prev[handle] === val) return false;
      return !!val;
    };

    const hasChanged = (handle) => {
      const val = inputs[handle];
      if (val === undefined || val === null) return false;
      return prev[handle] !== val;
    };

    // ── Befehle ausführen ──

    if (isTriggered('play')) {
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
