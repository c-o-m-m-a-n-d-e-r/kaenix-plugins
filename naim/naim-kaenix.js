/**
 * @plugin    Naim Audio Player
 * @version   1.0.1
 * @author    Christian Brauwers
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

function emitStatus(data, state, cfg) {
  if (!state.emit || !data) return;

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
    const cur = typeof value === 'object' ? JSON.stringify(value) : String(value);
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

  // Status-Text für die Logic-Node im Editor
  if (data.power === 0) {
    state.nodeLog?.('⏻ Standby');
  } else {
    const stateIcon = data.isPlaying ? '▶' : (data.state === 'paused' ? '⏸' : '⏹');
    const shortInfo = data.trackText
      ? (data.trackText.length > 25 ? data.trackText.substring(0, 22) + '...' : data.trackText)
      : (data.source || data.state);
    state.nodeLog?.(`${stateIcon} ${shortInfo} (${data.volume}%)`);
  }
}

async function fetchStatus(cfg, state) {
  if (!cfg.ip || state.isFetching) return;
  state.isFetching = true;

  try {
    const [resPower, resNowPlaying, resLevels] = await Promise.allSettled([
      httpRequest(cfg.ip, cfg.port, 'GET', '/power', null, 3000),
      httpRequest(cfg.ip, cfg.port, 'GET', '/nowplaying', null, 3000),
      httpRequest(cfg.ip, cfg.port, 'GET', '/levels/room', null, 3000),
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

      title    = np.trackName || np.title || np.name || '';
      artist   = np.artistName || np.artist || '';
      album    = np.albumName || np.album || '';
      source   = np.source || np.activeInput || '';
      image    = np.albumArtUrl || np.artwork || np.image || '';
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
    }, state, cfg);

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
  state.nodeLog?.('✗ getrennt');
  state.warn?.(`Naim Verbindungsfehler: ${err.message}`);
}

// ── Steuerbefehle (Naim Player Commands) ───────────────────────────────────────

async function sendCommand(cfg, state, method, path, body = null) {
  if (!cfg.ip) {
    state.warn?.('Naim IP-Adresse nicht konfiguriert');
    return;
  }
  try {
    await httpRequest(cfg.ip, cfg.port, method, path, body, 4000);
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
  type:        'naim',
  category:    'Geräte',
  label:       'Naim Audio Player',
  description: 'Steuert Naim Audio Streaming-Geräte (Mu-so, Mu-so Qb, Uniti Atom/Star/Nova, ND5 XS 2, NDX 2, ND 555, NSC 222 etc.) über die Naim HTTP/REST-API. ' +
               'Unterstützt Power, Play/Pause, Stop, Next/Prev, Lautstärke (absolut, relativ, KNX 4-Bit DPT 3.007 Dimmer), ' +
               'Mute, Quellenwahl, Presets, Shuffle, Repeat und Status-Polling.',
  color:       '#009E49',

  inputs: [
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

  globalSettings: [
    {
      key:         'ip',
      label:       'Naim Player IP-Adresse',
      type:        'text',
      placeholder: '192.168.1.60',
      description: 'Standard-IP-Adresse des Naim Audio Players',
    },
    {
      key:         'port',
      label:       'Port',
      type:        'number',
      placeholder: '15081',
      description: 'Standard-Port der Naim HTTP/REST-API (15081)',
    },
  ],

  config: [
    {
      key:         'ip',
      label:       'IP-Adresse (überschreibt globale Einstellung)',
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
      port:       parseInt(data.port || context.globalSetting('port') || '15081', 10),
      volumeStep: parseInt(data.volumeStep || '2', 10),
      interval:   Math.max(1, parseInt(data.interval || '2', 10)),
    };
    state.cfg = cfg;

    if (!cfg.ip) {
      context.warn('Naim IP-Adresse nicht konfiguriert (weder in Node-Config noch in globalen Einstellungen)');
      context.nodeLog('✗ Keine IP');
      context.setNodeStatus(false);
      return {};
    }

    // Polling-Timer verwalten
    if (!state.timer) {
      state.timer = setInterval(() => fetchStatus(cfg, state), cfg.interval * 1000);
      fetchStatus(cfg, state);
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
