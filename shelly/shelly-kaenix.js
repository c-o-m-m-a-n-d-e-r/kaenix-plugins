/**
 * @plugin    Shelly
 * @version   1.0.0
 * @author    kaenix
 * @website   https://www.kaenix.net
 */

'use strict';

const http   = require('http');
const crypto = require('crypto');

// ── Modulweiter Zustand pro Node-Instanz ──────────────────────────────────────
const _states = new Map();

function getState(nodeId) {
  if (!_states.has(nodeId)) {
    _states.set(nodeId, {
      generation:  null,   // null = unbekannt | 1 = Gen1 | 2/3/4 = Gen2+
      authEn:      false,
      deviceId:    '',
      detecting:   false,
      timer:       null,
      emit:        null,   // Referenz auf context.emitOutput – immer aktuell
      warn:        null,
      log:         null,
      nodeLog:     null,
      prevInputs:  {},
      ip:          null,
      port:        null,
    });
  }
  return _states.get(nodeId);
}

// ── HTTP-Helfer ────────────────────────────────────────────────────────────────

function httpRequest(ip, port, method, path, bodyObj, extraHeaders) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj != null ? JSON.stringify(bodyObj) : '';
    const headers = {
      'Content-Type': 'application/json',
      'Connection':   'close',
      ...extraHeaders,
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request(
      { hostname: ip, port, path, method, headers, timeout: 5000 },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: raw, headers: res.headers })
        );
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Auth-Helfer ────────────────────────────────────────────────────────────────

function parseDigestChallenge(header) {
  const result = {};
  (header || '').replace(/(\w+)=(?:"([^"]+)"|([^,\s]+))/g, (_, k, v1, v2) => {
    result[k] = v1 !== undefined ? v1 : (v2 || '');
  });
  return result; // { realm, nonce, qop, algorithm }
}

function buildDigestAuthBody(username, password, realm, nonce) {
  const sha    = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const ha1    = sha(`${username}:${realm}:${password}`);
  const ha2    = sha('dummy_method:dummy_uri');
  const nc     = 1;
  const cnonce = parseInt(nonce, 16) + 1 || Date.now();
  const resp   = sha(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return { username, realm, nonce, nc, cnonce, response: resp, algorithm: 'SHA-256' };
}

// ── Gen 1: REST-API ────────────────────────────────────────────────────────────

function gen1Get(cfg, path, params) {
  const query = params
    ? '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : '';
  const headers =
    cfg.username && cfg.password
      ? { Authorization: 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64') }
      : {};
  return httpRequest(cfg.ip, cfg.port, 'GET', path + query, null, headers);
}

// ── Gen 2/3/4: RPC-API ────────────────────────────────────────────────────────

async function rpc(state, cfg, method, params) {
  const body = { id: 1, method, ...(params ? { params } : {}) };
  let res = await httpRequest(cfg.ip, cfg.port, 'POST', '/rpc', body, {});

  // Digest-Auth bei 401 (Gen 2+)
  if (res.status === 401 && cfg.password) {
    const ch = parseDigestChallenge(res.headers['www-authenticate'] || '');
    if (ch.realm && ch.nonce) {
      body.auth = buildDigestAuthBody(
        cfg.username || 'admin',
        cfg.password,
        ch.realm,
        ch.nonce
      );
      res = await httpRequest(cfg.ip, cfg.port, 'POST', '/rpc', body, {});
    }
  }
  return res;
}

// ── Generationserkennung via GET /shelly ──────────────────────────────────────
// Funktioniert für alle Generationen:
//   Gen 1 → { type:"SHSW-25", auth:false }          (kein "gen"-Feld)
//   Gen 2+ → { gen:2, id:"shellyplus1-xxx", auth_en:false }

async function detectGeneration(cfg, state) {
  const res = await httpRequest(cfg.ip, cfg.port, 'GET', '/shelly', null, {});
  if (res.status === 200) {
    const info       = JSON.parse(res.body);
    state.generation = info.gen != null ? parseInt(info.gen, 10) : 1;
    state.authEn     = !!info.auth_en;
    state.deviceId   = info.id || info.type || '';
  } else {
    // Fallback: nehmen Gen 1 an
    state.generation = 1;
    state.authEn     = false;
    state.deviceId   = '';
  }
}

// ── Status parsen: Gen 1 (/status) ────────────────────────────────────────────

function parseGen1Status(jdat, cfg, emit) {
  emit('connected', 1);
  const ch = cfg.channel;

  if (jdat.relays && jdat.relays[ch] != null) {
    emit('onOff', jdat.relays[ch].ison ? 1 : 0);
  }

  if (jdat.lights && jdat.lights[ch] != null) {
    const l = jdat.lights[ch];
    emit('onOff', l.ison ? 1 : 0);
    if (l.brightness != null) emit('brightness', l.brightness);
    ['red', 'green', 'blue', 'white'].forEach((k) => {
      if (l[k] != null)
        emit(k, cfg.rgbwRange === 'raw' ? l[k] : Math.round(l[k] / 2.55));
    });
    if (l.gain != null) emit('gain', l.gain);
  }

  // Top-level RGBW (color-Modus, Antwort von /color/CH)
  ['red', 'green', 'blue', 'white'].forEach((k) => {
    if (jdat[k] != null)
      emit(k, cfg.rgbwRange === 'raw' ? jdat[k] : Math.round(jdat[k] / 2.55));
  });
  if (jdat.gain != null) emit('gain', jdat.gain);

  if (jdat.rollers && jdat.rollers[ch] != null) {
    if (jdat.rollers[ch].current_pos != null)
      emit('positionOut', jdat.rollers[ch].current_pos);
  }

  const mArr = jdat.emeters || jdat.meters;
  if (mArr && mArr[ch] != null) {
    const m = mArr[ch];
    if (m.power     != null) emit('power',    Math.round(m.power));
    if (m.total     != null) emit('energy',   Math.round((m.total / 60 / 1000) * 100) / 100);
    if (m.overpower != null) emit('overpower', m.overpower ? 1 : 0);
  }

  if (jdat.inputs && jdat.inputs[ch] != null) {
    if (jdat.inputs[ch].input != null) emit('inputState', jdat.inputs[ch].input);
    if (jdat.inputs[ch].event != null) emit('inputEvent', jdat.inputs[ch].event);
  }

  if (jdat.sensor && jdat.sensor.state != null)
    emit('onOff', jdat.sensor.state === 'open' ? 1 : 0);

  if (jdat.overtemperature != null) emit('overtemp',    jdat.overtemperature ? 1 : 0);
  if (jdat.has_update      != null) emit('fwAvailable', jdat.has_update      ? 1 : 0);
  if (jdat.tmp && jdat.tmp.tC != null)
    emit('temp', Math.round(jdat.tmp.tC * 10) / 10);

  if (jdat.ext_temperature) {
    [0, 1, 2].forEach((i) => {
      const t = jdat.ext_temperature[String(i)];
      if (t && t.tC != null)
        emit(`extTemp${i + 1}`, Math.round(t.tC * 10) / 10);
    });
  }
  if (jdat.ext_humidity && jdat.ext_humidity['0'] && jdat.ext_humidity['0'].hum != null)
    emit('humidity', Math.round(jdat.ext_humidity['0'].hum * 10) / 10);
  if (jdat.hum && jdat.hum.value != null) emit('humidity', Math.round(jdat.hum.value * 10) / 10);
  if (jdat.bat && jdat.bat.value != null) emit('battery',  Math.round(jdat.bat.value * 10) / 10);
  if (jdat.flood    != null) emit('flood',  jdat.flood    ? 1 : 0);
  if (jdat.motion   != null) emit('motion', jdat.motion   ? 1 : 0);
  if (jdat.vibration != null) emit('tamper', jdat.vibration ? 1 : 0);
}

// ── Status parsen: Gen 2/3/4 (Shelly.GetStatus RPC) ──────────────────────────
// RPC-Antwort nutzt namespaced Keys: "switch:0", "light:0", "cover:0", …

function parseGen2Status(jdat, cfg, emit) {
  emit('connected', 1);
  const ch = cfg.channel;

  // Switch / Relay
  const sw = jdat[`switch:${ch}`];
  if (sw) {
    emit('onOff', sw.output ? 1 : 0);
    if (sw.apower      != null) emit('power',  Math.round(sw.apower));
    if (sw.aenergy && sw.aenergy.total != null)
      emit('energy', Math.round(sw.aenergy.total * 100) / 100);
    if (sw.temperature && sw.temperature.tC != null)
      emit('temp', Math.round(sw.temperature.tC * 10) / 10);
  }

  // Light / Dimmer
  const lt = jdat[`light:${ch}`];
  if (lt) {
    emit('onOff', lt.output ? 1 : 0);
    if (lt.brightness  != null) emit('brightness', lt.brightness);
    if (lt.apower      != null) emit('power',  Math.round(lt.apower));
    if (lt.aenergy && lt.aenergy.total != null)
      emit('energy', Math.round(lt.aenergy.total * 100) / 100);
    if (lt.temperature && lt.temperature.tC != null)
      emit('temp', Math.round(lt.temperature.tC * 10) / 10);
  }

  // RGBW (z.B. Shelly RGBW2 Gen2, Pro RGBW PM)
  const rg = jdat[`rgbw:${ch}`];
  if (rg) {
    emit('onOff', rg.output ? 1 : 0);
    if (Array.isArray(rg.rgb)) {
      const toOut = cfg.rgbwRange === 'raw' ? (v) => v : (v) => Math.round(v / 2.55);
      emit('red',   toOut(rg.rgb[0]));
      emit('green', toOut(rg.rgb[1]));
      emit('blue',  toOut(rg.rgb[2]));
    }
    if (rg.white != null)
      emit('white', cfg.rgbwRange === 'raw' ? rg.white : Math.round(rg.white / 2.55));
    if (rg.gain  != null) emit('gain', rg.gain);
    if (rg.apower != null) emit('power', Math.round(rg.apower));
  }

  // Cover / Jalousie / Rolladen
  const cv = jdat[`cover:${ch}`];
  if (cv) {
    if (cv.current_pos != null) emit('positionOut', cv.current_pos);
    // state: "open"|"closed"|"opening"|"closing"|"stopped"|"calibrating"
    if (cv.state != null)
      emit('onOff', (cv.state === 'open' || cv.state === 'opening') ? 1 : 0);
    if (cv.apower != null) emit('power', Math.round(cv.apower));
    if (cv.aenergy && cv.aenergy.total != null)
      emit('energy', Math.round(cv.aenergy.total * 100) / 100);
  }

  // Input
  const inp = jdat[`input:${ch}`];
  if (inp) {
    if (inp.state != null) emit('inputState', inp.state ? 1 : 0);
    if (inp.event != null) emit('inputEvent', String(inp.event));
  }

  // Temperatursensor (z.B. Shelly Plus HT, Shelly BLU TRV)
  const tmpSensor = jdat[`temperature:${ch}`] || jdat['temperature:0'];
  if (tmpSensor && tmpSensor.tC != null)
    emit('temp', Math.round(tmpSensor.tC * 10) / 10);

  // Feuchtesensor
  const humSensor = jdat[`humidity:${ch}`] || jdat['humidity:0'];
  if (humSensor && humSensor.rh != null)
    emit('humidity', Math.round(humSensor.rh * 10) / 10);

  // Batterie (DevicePower-Komponente)
  const dp = jdat['devicepower:0'];
  if (dp && dp.battery && dp.battery.percent != null)
    emit('battery', dp.battery.percent);

  // Bewegungsmelder
  const mot = jdat['motion:0'] || jdat[`motion:${ch}`];
  if (mot && mot.active != null) emit('motion', mot.active ? 1 : 0);

  // Leckage-/Wassersensor
  const fl = jdat['flood:0'] || jdat[`flood:${ch}`];
  if (fl && fl.wet != null) emit('flood', fl.wet ? 1 : 0);

  // Rauchmelder / Tamper
  const sm = jdat['smoke:0'] || jdat[`smoke:${ch}`];
  if (sm && sm.alarm != null) emit('tamper', sm.alarm ? 1 : 0);

  // Firmware-Update (available_updates enthält "stable"/"beta"-Keys)
  if (jdat.sys && jdat.sys.available_updates != null) {
    emit('fwAvailable', Object.keys(jdat.sys.available_updates).length > 0 ? 1 : 0);
  }

  // Externe Temperaturen (Shelly Plus AddOn)
  const addon = jdat['temperature:100'] || jdat['temperature:101'] || jdat['temperature:102'];
  if (jdat['temperature:100'] && jdat['temperature:100'].tC != null)
    emit('extTemp1', Math.round(jdat['temperature:100'].tC * 10) / 10);
  if (jdat['temperature:101'] && jdat['temperature:101'].tC != null)
    emit('extTemp2', Math.round(jdat['temperature:101'].tC * 10) / 10);
  if (jdat['temperature:102'] && jdat['temperature:102'].tC != null)
    emit('extTemp3', Math.round(jdat['temperature:102'].tC * 10) / 10);
}

// ── Status abrufen ─────────────────────────────────────────────────────────────

async function fetchStatus(cfg, state) {
  try {
    let res;
    if (state.generation >= 2) {
      res = await rpc(state, cfg, 'Shelly.GetStatus');
    } else {
      res = await gen1Get(cfg, '/status');
    }
    if (res.status !== 200) {
      if (state.emit) state.emit('connected', 0);
      return;
    }
    const jdat = JSON.parse(res.body);
    const fn   = state.generation >= 2 ? parseGen2Status : parseGen1Status;
    fn(jdat, cfg, state.emit || (() => {}));
  } catch (e) {
    if (state.emit)  state.emit('connected', 0);
    if (state.warn)  state.warn(`Status-Fehler: ${e.message}`);
  }
}

// ── Befehle ────────────────────────────────────────────────────────────────────

async function cmdOnOff(state, cfg, value) {
  const on = !!parseInt(value, 10);
  const ch = cfg.channel;
  if (state.generation >= 2) {
    await rpc(state, cfg, 'Switch.Set', { id: ch, on });
  } else {
    await gen1Get(cfg, `/relay/${ch}`, { turn: on ? 'on' : 'off' });
  }
}

async function cmdBrightness(state, cfg, value) {
  const v  = Math.min(100, Math.max(0, parseInt(value, 10)));
  const ch = cfg.channel;
  if (state.generation >= 2) {
    const params = { id: ch, brightness: v };
    if (v > 0  && cfg.dimmOn)  params.on = true;
    if (v === 0 && cfg.dimmOff) params.on = false;
    await rpc(state, cfg, 'Light.Set', params);
  } else {
    const bv = v < 1 ? 1 : v;
    await gen1Get(cfg, `/light/${ch}`, { brightness: bv });
    if (v > 0  && cfg.dimmOn)  await gen1Get(cfg, `/light/${ch}`, { turn: 'on'  });
    if (v === 0 && cfg.dimmOff) await gen1Get(cfg, `/light/${ch}`, { turn: 'off' });
  }
}

async function cmdColor(state, cfg, r, g, b, w, raw) {
  const clamp  = (v, max) => Math.min(max, Math.max(0, parseInt(v, 10) || 0));
  const toRaw  = (pct)    => Math.round(255 * pct / 100);
  const ch = cfg.channel;
  let R, G, B, W;
  if (raw) {
    R = clamp(r, 255); G = clamp(g, 255); B = clamp(b, 255); W = clamp(w, 255);
  } else {
    R = toRaw(clamp(r, 100)); G = toRaw(clamp(g, 100));
    B = toRaw(clamp(b, 100)); W = toRaw(clamp(w, 100));
  }
  if (state.generation >= 2) {
    await rpc(state, cfg, 'RGBW.Set', { id: ch, rgb: [R, G, B], white: W });
  } else {
    await gen1Get(cfg, `/color/${ch}`, { red: R, green: G, blue: B, white: W });
  }
}

async function cmdGain(state, cfg, value) {
  const v  = Math.min(100, Math.max(0, parseInt(value, 10) || 0));
  const ch = cfg.channel;
  if (state.generation >= 2) {
    await rpc(state, cfg, 'RGBW.Set', { id: ch, gain: v });
  } else {
    await gen1Get(cfg, `/color/${ch}`, { gain: v });
  }
}

async function cmdCover(state, cfg, action, position) {
  const ch = cfg.channel;
  if (state.generation >= 2) {
    const methodMap = { open: 'Cover.Open', close: 'Cover.Close', stop: 'Cover.Stop' };
    if (action === 'to_pos') {
      await rpc(state, cfg, 'Cover.GoToPosition', { id: ch, pos: parseInt(position, 10) || 0 });
    } else {
      await rpc(state, cfg, methodMap[action] || 'Cover.Stop', { id: ch });
    }
  } else {
    if (action === 'to_pos') {
      await gen1Get(cfg, `/roller/${ch}`, { go: 'to_pos', roller_pos: parseInt(position, 10) || 0 });
    } else {
      await gen1Get(cfg, `/roller/${ch}`, { go: action });
    }
  }
}

async function cmdReboot(state, cfg) {
  if (state.generation >= 2) {
    await rpc(state, cfg, 'Shelly.Reboot');
  } else {
    await gen1Get(cfg, '/reboot');
  }
}

async function cmdFwUpdate(state, cfg) {
  if (state.generation >= 2) {
    await rpc(state, cfg, 'Shelly.Update', { stage: 'stable' });
  } else {
    await gen1Get(cfg, '/ota', { update: 1 });
  }
}

// ── Plugin-Export ──────────────────────────────────────────────────────────────

module.exports = {
  type:        'shelly',
  category:    'Geräte',
  label:       'Shelly',
  description: 'Steuert Shelly-Geräte Gen 1–4. Unterstützt Relays, Dimmer, RGBW, Jalousien und Sensoren. Gen 1 nutzt die REST-API, Gen 2/3/4 die RPC-API mit Digest-Auth.',
  color:       '#e67e22',

  inputs: [
    { handle: 'onOff',         label: 'Ein/Aus (0/1)' },
    { handle: 'brightness',    label: 'Helligkeit (0–100)' },
    { handle: 'triggerStatus', label: 'Status abfragen (Trigger)' },
    { handle: 'fwUpdate',      label: 'FW-Update auslösen (Trigger)' },
    { handle: 'reboot',        label: 'Neustart (Trigger)' },
    { handle: 'openClose',     label: 'Jalousie Auf/Zu (1=Auf, 0=Zu)' },
    { handle: 'stop',          label: 'Jalousie Stop (Trigger)' },
    { handle: 'position',      label: 'Jalousie Position (0–100)' },
    { handle: 'red',           label: 'Rot' },
    { handle: 'green',         label: 'Grün' },
    { handle: 'blue',          label: 'Blau' },
    { handle: 'white',         label: 'Weiß' },
    { handle: 'gain',          label: 'Gain (0–100 %)' },
  ],

  outputs: [
    { handle: 'connected',   label: 'Verbindung (0/1)' },
    { handle: 'onOff',       label: 'Status Ein/Aus (0/1)' },
    { handle: 'brightness',  label: 'Helligkeit (0–100 %)' },
    { handle: 'power',       label: 'Leistung akt. (W)' },
    { handle: 'energy',      label: 'Energie ges. (kWh)' },
    { handle: 'overpower',   label: 'Überlast (0/1)' },
    { handle: 'temp',        label: 'Temperatur (°C)' },
    { handle: 'overtemp',    label: 'Übertemperatur (0/1)' },
    { handle: 'fwAvailable', label: 'FW-Update verfügbar (0/1)' },
    { handle: 'red',         label: 'Rot' },
    { handle: 'green',       label: 'Grün' },
    { handle: 'blue',        label: 'Blau' },
    { handle: 'white',       label: 'Weiß' },
    { handle: 'gain',        label: 'Gain (0–100 %)' },
    { handle: 'extTemp1',    label: 'Ext. Temp 1 (°C)' },
    { handle: 'extTemp2',    label: 'Ext. Temp 2 (°C)' },
    { handle: 'extTemp3',    label: 'Ext. Temp 3 (°C)' },
    { handle: 'positionOut', label: 'Akt. Position (0–100)' },
    { handle: 'inputState',  label: 'Eingang Status (0/1)' },
    { handle: 'inputEvent',  label: 'Eingang Event' },
    { handle: 'humidity',    label: 'Feuchtigkeit (%)' },
    { handle: 'battery',     label: 'Batterie (%)' },
    { handle: 'flood',       label: 'Leckage (0/1)' },
    { handle: 'motion',      label: 'Bewegung (0/1)' },
    { handle: 'tamper',      label: 'Tamper / Alarm (0/1)' },
  ],

  config: [
    { key: 'ip',       label: 'IP-Adresse',                   type: 'text',   placeholder: '192.168.1.100' },
    { key: 'port',     label: 'Port',                         type: 'number', placeholder: '80' },
    { key: 'channel',  label: 'Kanal (0-basiert)',            type: 'number', placeholder: '0' },
    {
      key: 'type', label: 'Gerätetyp', type: 'select',
      options: [
        { value: 'relay',  label: 'Relay / Schalter' },
        { value: 'light',  label: 'Dimmer / Light' },
        { value: 'color',  label: 'RGBW (0–100 %)' },
        { value: 'white',  label: 'Weiß-LED (0–100 %)' },
        { value: 'roller', label: 'Jalousie / Rolladen' },
        { value: 'sensor', label: 'Sensor' },
      ],
    },
    {
      key: 'rgbwRange', label: 'RGBW-Wertebereich', type: 'select',
      options: [{ value: 'percent', label: '0–100 %' }, { value: 'raw', label: '0–255' }],
    },
    { key: 'interval', label: 'Status-Intervall Sek. (0 = deaktiviert)', type: 'number', placeholder: '30' },
    {
      key: 'dimmOn', label: 'Bei Dim > 0 automatisch einschalten', type: 'select',
      options: [{ value: '0', label: 'Nein' }, { value: '1', label: 'Ja' }],
    },
    {
      key: 'dimmOff', label: 'Bei Dim = 0 automatisch ausschalten', type: 'select',
      options: [{ value: '0', label: 'Nein' }, { value: '1', label: 'Ja' }],
    },
    {
      key: 'autoFwUpdate', label: 'Auto-FW-Update bei verfügbarem Update', type: 'select',
      options: [{ value: '0', label: 'Nein' }, { value: '1', label: 'Ja' }],
    },
    { key: 'username', label: 'Benutzername', type: 'text',     placeholder: 'admin' },
    { key: 'password', label: 'Passwort',     type: 'password' },
  ],

  // ── execute ────────────────────────────────────────────────────────────────
  execute(inputs, data, context) {
    const nodeId = context.nodeId || 'default';
    const state  = getState(nodeId);

    // Emit-Referenz bei jedem Aufruf aktualisieren, damit laufende Timer
    // immer die aktuellste propagateFn-Referenz nutzen.
    state.emit    = (h, v) => context.emitOutput(h, v);
    state.warn    = (...a) => context.warn(...a);
    state.log     = (...a) => context.log(...a);
    state.nodeLog = (...a) => context.nodeLog(...a);

    const cfg = {
      ip:       String(data.ip       || '').trim(),
      port:     parseInt(data.port,   10) || 80,
      channel:  parseInt(data.channel, 10) || 0,
      type:     String(data.type     || 'relay'),
      interval: parseInt(data.interval, 10) || 0,
      dimmOn:   parseInt(data.dimmOn,  10) || 0,
      dimmOff:  parseInt(data.dimmOff, 10) || 0,
      autoFw:     parseInt(data.autoFwUpdate, 10) || 0,
      rgbwRange:  String(data.rgbwRange || 'percent'),
      username:   String(data.username || '').trim(),
      password:   String(data.password || '').trim(),
    };

    if (!cfg.ip) {
      context.warn('IP-Adresse nicht konfiguriert');
      return {};
    }

    // IP oder Port hat sich geändert → Zustand zurücksetzen
    if (state.ip !== cfg.ip || state.port !== cfg.port) {
      state.generation = null;
      state.detecting  = false;
      state.ip         = cfg.ip;
      state.port       = cfg.port;
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
    }

    // Erstmalige Generationserkennung (einmalig pro IP:Port)
    if (!state.generation && !state.detecting) {
      state.detecting = true;
      detectGeneration(cfg, state)
        .then(() => {
          state.detecting = false;
          context.nodeLog(`Gen ${state.generation} | ${state.deviceId}`);
          context.log(
            `Shelly ${cfg.ip}:${cfg.port} – Gen ${state.generation}, ` +
            `Auth: ${state.authEn}, ID: ${state.deviceId}`
          );

          // Status-Polling starten
          if (cfg.interval > 0 && !state.timer) {
            state.timer = setInterval(
              () => fetchStatus(cfg, state),
              cfg.interval * 1000
            );
          }
          // Sofortiger erster Status-Abruf
          fetchStatus(cfg, state);
        })
        .catch((e) => {
          state.detecting = false;
          context.warn(`Verbindung zu ${cfg.ip} fehlgeschlagen: ${e.message}`);
          context.emitOutput('connected', 0);
        });
      return {};
    }

    // Solange Erkennung läuft, nichts weiter tun
    if (state.detecting) return {};

    // ── Eingänge auswerten ──────────────────────────────────────────────────
    const prev    = state.prevInputs;
    const changed = (key) =>
      inputs[key] !== undefined && inputs[key] !== prev[key];

    // Status-Trigger
    if (changed('triggerStatus')) {
      fetchStatus(cfg, state);
    }

    // FW-Update
    if (changed('fwUpdate') && inputs.fwUpdate) {
      cmdFwUpdate(state, cfg).catch((e) => context.warn(`FW-Update Fehler: ${e.message}`));
    }

    // Neustart
    if (changed('reboot') && inputs.reboot) {
      cmdReboot(state, cfg).catch((e) => context.warn(`Neustart-Fehler: ${e.message}`));
    }

    // Ein/Aus
    if (changed('onOff')) {
      cmdOnOff(state, cfg, inputs.onOff)
        .then(() => fetchStatus(cfg, state))
        .catch((e) => context.warn(`Ein/Aus-Fehler: ${e.message}`));
    }

    // Helligkeit
    if (changed('brightness')) {
      cmdBrightness(state, cfg, inputs.brightness)
        .then(() => fetchStatus(cfg, state))
        .catch((e) => context.warn(`Dimm-Fehler: ${e.message}`));
    }

    // Farbe (Bereich je nach rgbwRange-Konfig: 0–100 % oder 0–255)
    if (changed('red') || changed('green') || changed('blue') || changed('white')) {
      cmdColor(
        state, cfg,
        inputs.red   != null ? inputs.red   : (prev.red   || 0),
        inputs.green != null ? inputs.green : (prev.green || 0),
        inputs.blue  != null ? inputs.blue  : (prev.blue  || 0),
        inputs.white != null ? inputs.white : (prev.white || 0),
        cfg.rgbwRange === 'raw'
      ).catch((e) => context.warn(`Farb-Fehler: ${e.message}`));
    }

    // Gain
    if (changed('gain')) {
      cmdGain(state, cfg, inputs.gain).catch((e) => context.warn(`Gain-Fehler: ${e.message}`));
    }

    // Jalousie Auf/Zu
    if (changed('openClose')) {
      cmdCover(state, cfg, inputs.openClose ? 'open' : 'close')
        .catch((e) => context.warn(`Jalousie-Fehler: ${e.message}`));
    }

    // Jalousie Stop
    if (changed('stop') && inputs.stop) {
      cmdCover(state, cfg, 'stop').catch((e) => context.warn(`Jalousie-Stop-Fehler: ${e.message}`));
    }

    // Jalousie Position
    if (changed('position')) {
      cmdCover(state, cfg, 'to_pos', inputs.position)
        .catch((e) => context.warn(`Positions-Fehler: ${e.message}`));
    }

    // Vorherige Eingangswerte speichern
    state.prevInputs = { ...inputs };
    return {};
  },
};
