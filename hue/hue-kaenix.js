/**
 * @plugin    Philips Hue
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
      setStatus:   null,   // context.setNodeStatus-Referenz
      prevInputs:  {},
      timer:       null,
      ip:          null,
      port:        null,
      apiKey:      null,
      onoff:       false,
      bri:         254,
      gamutType:   null,  // wird aus capabilities der Bridge gelesen
    });
  }
  return _states.get(nodeId);
}

// ── Farbgamut-Definitionen ─────────────────────────────────────────────────────
// Jede Lampen-Generation unterstützt einen anderen Farbbereich im CIE 1931 xy-Farbraum.
// Quelle: Philips Hue Developer Documentation

const GAMUTS = {
  A: { r: [0.704, 0.296],   g: [0.2151, 0.7106], b: [0.138,  0.08]   }, // LivingColors, Bloom, Aura
  B: { r: [0.675, 0.322],   g: [0.4091, 0.518],  b: [0.167,  0.04]   }, // Hue A19 (Gen 1/2)
  C: { r: [0.6915, 0.3083], g: [0.1700, 0.7000], b: [0.1532, 0.0475] }, // Hue Go, BR30, LightStrips+
};

function crossProduct(p1, p2) {
  return p1[0] * p2[1] - p1[1] * p2[0];
}

function checkInGamut(gamut, p) {
  const { r, g, b } = gamut;
  const v1 = [g[0] - r[0], g[1] - r[1]];
  const v2 = [b[0] - r[0], b[1] - r[1]];
  const q  = [p[0] - r[0], p[1] - r[1]];
  const s  = crossProduct(q, v2) / crossProduct(v1, v2);
  const t  = crossProduct(v1, q) / crossProduct(v1, v2);
  return s >= 0 && t >= 0 && s + t <= 1;
}

function closestOnLine(A, B, P) {
  const AP = [P[0] - A[0], P[1] - A[1]];
  const AB = [B[0] - A[0], B[1] - A[1]];
  const ab2 = AB[0] ** 2 + AB[1] ** 2;
  const t   = Math.max(0, Math.min(1, (AP[0] * AB[0] + AP[1] * AB[1]) / ab2));
  return [A[0] + AB[0] * t, A[1] + AB[1] * t];
}

function dist2D(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
}

function clampToGamut(gamut, p) {
  const { r, g, b } = gamut;
  const candidates = [
    closestOnLine(r, g, p),
    closestOnLine(b, r, p),
    closestOnLine(g, b, p),
  ];
  return candidates.reduce((best, c) => dist2D(p, c) < dist2D(p, best) ? c : best);
}

// RGB (0–255) → CIE 1931 xy mit Gamut-Korrektur
function rgbToXY(r, g, b, gamutKey = 'B') {
  r /= 255; g /= 255; b /= 255;

  // Inverse sRGB Gamma-Korrektur
  const toLinear = (v) => v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  r = toLinear(r); g = toLinear(g); b = toLinear(b);

  // Wide RGB D65 → XYZ
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.072310 + b * 0.986039;

  const sum = X + Y + Z;
  let xy = sum === 0 ? [0.3127, 0.3290] : [X / sum, Y / sum]; // Weißpunkt als Fallback

  const gamut = GAMUTS[gamutKey] || GAMUTS.B;
  if (!checkInGamut(gamut, xy)) {
    xy = clampToGamut(gamut, xy);
  }
  return xy;
}

// CIE 1931 xy + Helligkeit → RGB (0–255)
function xyToRGB(x, y, bri = 1) {
  const Y = bri;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);

  let r =  X *  3.2406 - Y * 1.5372 - Z * 0.4986;
  let g = -X *  0.9689 + Y * 1.8758 + Z * 0.0415;
  let b =  X *  0.0557 - Y * 0.2040 + Z * 1.0570;

  // sRGB Gamma-Korrektur
  const toSRGB = (v) => Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  [r, g, b] = [r, g, b].map(toSRGB);

  const mx = Math.max(r, g, b);
  if (mx > 1) [r, g, b] = [r / mx, g / mx, b / mx];

  return [r, g, b].map(v => Math.round(v * 255));
}

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
  let h = 0;
  if (mx !== mn) {
    if      (mx === r) h = ((g - b) / df + 6) % 6 * 60;
    else if (mx === g) h = ((b - r) / df + 2) * 60;
    else               h = ((r - g) / df + 4) * 60;
  }
  return [Math.round(h), mx === 0 ? 0 : Math.round(df / mx * 100), Math.round(mx * 100)];
}

// Hilfsfunktionen für Wertkonvertierungen
const pctToBri  = (pct) => Math.max(1, Math.min(254, Math.round(254 * pct / 100)));
const briToPct  = (bri) => Math.round(bri * 100 / 254);
const pctToCT   = (pct) => Math.max(153, Math.min(500, Math.round(153 + pct * (500 - 153) / 100)));
const ctToPct   = (ct)  => Math.round((ct - 153) * 100 / (500 - 153));

// ── HTTP-Helfer ────────────────────────────────────────────────────────────────

function httpRequest(ip, port, method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', 'Connection': 'close' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request(
      { hostname: ip, port, path, method, headers, timeout: 8000 },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end',  () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Liefert Basispfad und Modus ('state' | 'action') abhängig von Lampen- oder Gruppen-ID
function buildEndpoint(apiKey, lightId, groupId) {
  if (lightId > 0) return { base: `/api/${apiKey}/lights/${lightId}`, mode: 'state'  };
  if (groupId > 0) return { base: `/api/${apiKey}/groups/${groupId}`, mode: 'action' };
  return null;
}

// ── Status abrufen & parsen ────────────────────────────────────────────────────

async function fetchStatus(cfg, state) {
  try {
    const ep = buildEndpoint(cfg.apiKey, cfg.lightId, cfg.groupId);
    if (!ep) return;

    const res = await httpRequest(cfg.ip, cfg.port, 'GET', ep.base, null);
    if (res.status !== 200) {
      if (state.emit) state.emit('connected', 0);
      state.setStatus?.(false);
      return;
    }

    const data = JSON.parse(res.body);
    parseAndEmit(data, ep.mode, state, cfg);
  } catch (e) {
    if (state.emit) state.emit('connected', 0);
    state.setStatus?.(false);
    if (state.warn) state.warn(`Status-Fehler: ${e.message}`);
  }
}

function parseAndEmit(data, mode, state, cfg) {
  if (!state.emit) return;

  // Gamut-Typ aus Lampen-Capabilities übernehmen
  if (data.capabilities?.control?.colorgamuttype) {
    state.gamutType = data.capabilities.control.colorgamuttype;
  }

  const s = data[mode];
  if (!s) return;

  state.emit('connected', 1);
  state.setStatus?.(true);

  if (s.on    != null) { state.onoff = s.on;  state.emit('onOff',      s.on ? 1 : 0); }
  if (s.bri   != null) { state.bri   = s.bri; state.emit('brightness', briToPct(s.bri)); }
  if (s.sat   != null) state.emit('saturation', briToPct(s.sat));
  if (s.ct    != null) state.emit('colorTemp',  ctToPct(s.ct));

  // XY → RGB → HSV
  if (s.xy) {
    const brightness = s.bri != null ? s.bri / 254 : 1;
    const [r, g, b]  = xyToRGB(s.xy[0], s.xy[1], brightness);

    state.emit('red',   Math.round(r * 100 / 255));
    state.emit('green', Math.round(g * 100 / 255));
    state.emit('blue',  Math.round(b * 100 / 255));

    // HSV als gepackter Dezimalwert (RRGGBB hex → integer)
    const hexVal = (r << 16) | (g << 8) | b;
    state.emit('hsv', hexVal);
  }
}

// ── Steuerungsbefehle ──────────────────────────────────────────────────────────

async function setLightState(cfg, payload) {
  const ep = buildEndpoint(cfg.apiKey, cfg.lightId, cfg.groupId);
  if (!ep) return;
  await httpRequest(cfg.ip, cfg.port, 'PUT', `${ep.base}/${ep.mode}`, payload);
}

async function cmdOnOff(cfg, state, value) {
  const on = !!parseInt(value, 10);
  state.onoff = on;

  const payload = { on };

  // Intelli Start: Szene bei Einschalten setzen
  if (on && cfg.intelliStart && cfg.scene) {
    payload.scene = cfg.scene;
  } else if (on && cfg.startBri > 0) {
    // Starthelligkeit
    payload.bri = pctToBri(cfg.startBri);
  }

  await setLightState(cfg, payload);
}

async function cmdBrightness(cfg, pct) {
  await setLightState(cfg, { bri: pctToBri(pct) });
}

async function cmdSaturation(cfg, pct) {
  await setLightState(cfg, { sat: pctToBri(pct) });
}

async function cmdColorTemp(cfg, pct) {
  await setLightState(cfg, { ct: pctToCT(pct) });
}

async function cmdRGB(cfg, r, g, b, gamutKey) {
  const R = Math.round(Math.min(100, Math.max(0, r)) * 255 / 100);
  const G = Math.round(Math.min(100, Math.max(0, g)) * 255 / 100);
  const B = Math.round(Math.min(100, Math.max(0, b)) * 255 / 100);
  const xy = rgbToXY(R, G, B, gamutKey || 'B');
  await setLightState(cfg, { xy });
}

async function cmdHsv(cfg, decimal, gamutKey) {
  // Dezimalwert entspricht einem gepackten RGB-Farbwert (z.B. 0xFF8800 = Orange)
  const n   = parseInt(decimal, 10) || 0;
  const r   = (n >> 16) & 0xFF;
  const g   = (n >>  8) & 0xFF;
  const b   =  n        & 0xFF;

  const [hue, sat, val] = rgb2hsv(r, g, b);

  await setLightState(cfg, {
    hue: Math.round(182.04 * hue),     // Hue-API: 0–65535
    sat: Math.round(2.54   * sat),     // Hue-API: 0–254
    bri: Math.round(2.54   * val),     // Hue-API: 1–254
  });
}

async function cmdScene(cfg, scene) {
  await setLightState(cfg, { scene: String(scene) });
}

// KNX 4-Bit Relativdimmer (DPT 3.007):
// Bit 3 = Richtung (1=heller, 0=dunkler), Bits 0–2 = Schrittweite (1–7)
// Byte 0x00 = Stopp-Telegramm → ignorieren
async function cmdDim(cfg, state, val) {
  const byte = typeof val === 'number' ? val & 0xFF : parseInt(val, 10) & 0xFF;
  const step = byte & 0x07;
  if (step === 0) return; // Stopp-Telegramm

  const direction = (byte & 0x08) ? 1 : -1;
  const currentPct = briToPct(state.bri || 254);
  const newPct = Math.max(0, Math.min(100, currentPct + direction * step));
  await cmdBrightness(cfg, newPct);
}

// ── Plugin-Export ──────────────────────────────────────────────────────────────

module.exports = {
  type:        'philips-hue',
  category:    'Geräte',
  label:       'Philips Hue',
  description: 'Steuert Philips Hue Lampen und Gruppen über die Hue Bridge (API v1). Unterstützt Ein/Aus, Helligkeit, Sättigung, Farbtemperatur, RGB, HSV und Szenen.',
  color:       '#FFD700',

  inputs: [
    { handle: 'onOff',         label: 'Ein/Aus (0/1)' },
    { handle: 'brightness',    label: 'Helligkeit (0–100 %)' },
    { handle: 'saturation',    label: 'Sättigung (0–100 %)' },
    { handle: 'colorTemp',     label: 'Farbtemperatur (0 = kalt … 100 = warm)' },
    { handle: 'red',           label: 'Rot (0–100)' },
    { handle: 'green',         label: 'Grün (0–100)' },
    { handle: 'blue',          label: 'Blau (0–100)' },
    { handle: 'hsv',           label: 'HSV / Farbe (Dezimalwert RRGGBB)' },
    { handle: 'scene',         label: 'Szene (ID-String)' },
    { handle: 'dim',           label: 'Dimmer (KNX 4-Bit DPT 3.007)' },
    { handle: 'triggerStatus', label: 'Status abfragen (Trigger)' },
  ],

  outputs: [
    { handle: 'connected',  label: 'Verbunden (0/1)' },
    { handle: 'onOff',      label: 'Status Ein/Aus (0/1)' },
    { handle: 'brightness', label: 'Helligkeit (0–100 %)' },
    { handle: 'saturation', label: 'Sättigung (0–100 %)' },
    { handle: 'colorTemp',  label: 'Farbtemperatur (0–100)' },
    { handle: 'red',        label: 'Rot (0–100)' },
    { handle: 'green',      label: 'Grün (0–100)' },
    { handle: 'blue',       label: 'Blau (0–100)' },
    { handle: 'hsv',        label: 'HSV / Farbe (Dezimalwert RRGGBB)' },
  ],

  globalSettings: [
    { key: 'ip',     label: 'Hue Bridge IP-Adresse',    type: 'text',     placeholder: '192.168.1.100' },
    { key: 'port',   label: 'Port',                     type: 'number',   placeholder: '80' },
    { key: 'apiKey', label: 'API Key (Bridge Username)', type: 'text',     placeholder: 'abc123def456...' },
  ],

  config: [
    // ── Bridge-Einstellungen (überschreibt globale Einstellung) ───────────────
    { key: 'ip',     label: 'Hue Bridge IP (überschreibt globale Einstellung)',    type: 'text',   placeholder: '192.168.1.100' },
    { key: 'port',   label: 'Port (überschreibt globale Einstellung)',             type: 'number', placeholder: '80' },
    { key: 'apiKey', label: 'API Key (überschreibt globale Einstellung)',          type: 'text',   placeholder: 'abc123def456...' },

    // ── Lampe / Gruppe ────────────────────────────────────────────────────────
    { key: 'lightId', label: 'Lampen-ID (0 = deaktiviert)',  type: 'number', placeholder: '0' },
    { key: 'groupId', label: 'Gruppen-ID (0 = deaktiviert)', type: 'number', placeholder: '0' },

    // ── Farbeinstellungen ─────────────────────────────────────────────────────
    {
      key: 'gamut', label: 'Farbgamut', type: 'select',
      options: [
        { value: 'B', label: 'Gamut B – Hue A19, Standard (empfohlen)' },
        { value: 'A', label: 'Gamut A – LivingColors, Bloom, Aura' },
        { value: 'C', label: 'Gamut C – Hue Go, BR30, LightStrips+' },
      ],
    },

    // ── Einschaltverhalten ────────────────────────────────────────────────────
    {
      key: 'intelliStart', label: 'Intelli Start (Szene beim Einschalten)', type: 'select',
      options: [{ value: '0', label: 'Nein' }, { value: '1', label: 'Ja' }],
    },
    { key: 'scene',    label: 'Szene bei Einschalten (ID-String)', type: 'text',   placeholder: '' },
    { key: 'startBri', label: 'Starthelligkeit % (0 = deaktiviert)', type: 'number', placeholder: '0' },

    // ── Status-Polling ────────────────────────────────────────────────────────
    { key: 'interval', label: 'Status-Intervall Sek. (0 = deaktiviert)', type: 'number', placeholder: '0' },
  ],

  // ── Ausführung ────────────────────────────────────────────────────────────────
  execute(inputs, data, context) {
    const nodeId = context.nodeId || 'default';
    const state  = getState(nodeId);

    // Emit-Referenzen immer aktuell halten (wichtig für laufende Timer)
    state.emit    = (h, v) => context.emitOutput(h, v);
    state.warn    = (...a) => context.warn(...a);
    state.log     = (...a) => context.log(...a);
    state.nodeLog = (...a) => context.nodeLog(...a);
    state.setStatus = (connected) => context.setNodeStatus(connected);

    // Konfiguration normalisieren – lokale Einstellung hat Vorrang vor globaler
    const cfg = {
      ip:           (String(data.ip     || '').trim()) || String(context.globalSetting('ip')     || '').trim(),
      port:         parseInt(data.port,  10) || parseInt(context.globalSetting('port'),  10) || 80,
      apiKey:       (String(data.apiKey || '').trim()) || String(context.globalSetting('apiKey') || '').trim(),
      lightId:      parseInt(data.lightId, 10) || 0,
      groupId:      parseInt(data.groupId, 10) || 0,
      gamut:        String(data.gamut    || 'B'),
      intelliStart: parseInt(data.intelliStart, 10) || 0,
      scene:        String(data.scene    || '').trim(),
      startBri:     parseInt(data.startBri, 10) || 0,
      interval:     parseInt(data.interval, 10) || 0,
    };

    // Pflichtfelder prüfen
    if (!cfg.ip)     { context.warn('Hue Bridge IP-Adresse nicht konfiguriert'); return {}; }
    if (!cfg.apiKey) { context.warn('API Key nicht konfiguriert'); return {}; }
    if (cfg.lightId === 0 && cfg.groupId === 0) {
      context.warn('Weder Lampen-ID noch Gruppen-ID konfiguriert');
      return {};
    }

    // Verbindungsparameter geändert → Timer zurücksetzen und neu verbinden
    if (state.ip !== cfg.ip || state.port !== cfg.port || state.apiKey !== cfg.apiKey) {
      state.ip     = cfg.ip;
      state.port   = cfg.port;
      state.apiKey = cfg.apiKey;
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
    }

    // Status-Polling starten / stoppen
    if (cfg.interval > 0 && !state.timer) {
      state.timer = setInterval(() => fetchStatus(cfg, state), cfg.interval * 1000);
      fetchStatus(cfg, state); // Sofortiger erster Abruf
    } else if (cfg.interval === 0 && state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }

    // ── Eingangsauswertung ────────────────────────────────────────────────────
    const prev    = state.prevInputs;
    const changed = (key) => inputs[key] !== undefined && inputs[key] !== prev[key];
    const gamut   = state.gamutType || cfg.gamut;

    // Status-Trigger
    if (changed('triggerStatus')) {
      fetchStatus(cfg, state);
    }

    // Ein/Aus
    if (changed('onOff')) {
      cmdOnOff(cfg, state, inputs.onOff)
        .then(() => fetchStatus(cfg, state))
        .catch((e) => context.warn(`Ein/Aus-Fehler: ${e.message}`));
    }

    // Helligkeit
    if (changed('brightness')) {
      cmdBrightness(cfg, inputs.brightness)
        .then(() => fetchStatus(cfg, state))
        .catch((e) => context.warn(`Helligkeit-Fehler: ${e.message}`));
    }

    // Sättigung
    if (changed('saturation')) {
      cmdSaturation(cfg, inputs.saturation)
        .catch((e) => context.warn(`Sättigungs-Fehler: ${e.message}`));
    }

    // Farbtemperatur
    if (changed('colorTemp')) {
      cmdColorTemp(cfg, inputs.colorTemp)
        .catch((e) => context.warn(`Farbtemperatur-Fehler: ${e.message}`));
    }

    // RGB – bei Änderung an einer Komponente alle drei senden
    if (changed('red') || changed('green') || changed('blue')) {
      cmdRGB(
        cfg,
        inputs.red   != null ? inputs.red   : (prev.red   || 0),
        inputs.green != null ? inputs.green : (prev.green || 0),
        inputs.blue  != null ? inputs.blue  : (prev.blue  || 0),
        gamut
      ).catch((e) => context.warn(`RGB-Fehler: ${e.message}`));
    }

    // HSV
    if (changed('hsv')) {
      cmdHsv(cfg, inputs.hsv, gamut)
        .catch((e) => context.warn(`HSV-Fehler: ${e.message}`));
    }

    // Szene
    if (changed('scene') && inputs.scene) {
      cmdScene(cfg, inputs.scene)
        .catch((e) => context.warn(`Szenen-Fehler: ${e.message}`));
    }

    // KNX 4-Bit Dimmer
    if (changed('dim')) {
      cmdDim(cfg, state, inputs.dim)
        .catch((e) => context.warn(`Dimmer-Fehler: ${e.message}`));
    }

    state.prevInputs = { ...inputs };
    return {};
  },
};
