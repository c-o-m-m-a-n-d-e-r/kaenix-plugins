/**
 * @plugin    Somfy Tahoma
 * @version   1.0.0
 * @author    Christian Brauwers
 * @website   https://www.kaenix.net
 * Local API: https://github.com/Somfy-Developer/Somfy-TaHoma-Developer-Mode
 */
'use strict';
const https = require('https');
const net = require('net');
const tls = require('tls');
const states = new Map();
const BASE = '/enduser-mobile-web/1/enduserAPI';
// Public CA from https://ca.overkiz.com/overkiz-root-ca-2048.crt (not a private key).
const CA = `-----BEGIN CERTIFICATE-----
MIIDPDCCAiSgAwIBAgIJAOvswclbF4QnMA0GCSqGSIb3DQEBCwUAMEsxEDAOBgNV
BAoTB092ZXJraXoxEDAOBgNVBAsTB1Jvb3QgQ0ExGDAWBgNVBAMTD092ZXJraXog
Um9vdCBDQTELMAkGA1UEBhMCRlIwHhcNMTYwNDI3MTI1ODE1WhcNMzYwNDI3MTI1
ODE1WjBLMRAwDgYDVQQKEwdPdmVya2l6MRAwDgYDVQQLEwdSb290IENBMRgwFgYD
VQQDEw9PdmVya2l6IFJvb3QgQ0ExCzAJBgNVBAYTAkZSMIIBIjANBgkqhkiG9w0B
AQEFAAOCAQ8AMIIBCgKCAQEAsszRfbcNCEoD9ZfzTbXfuMK8CrXGqBR/ZOCk4guN
aRKqZ/rLQm3V6Q+dlJ/8qle5J3KN5bZmqT4qXKHwJsaOiLfPyAptSM6vuIlls2N+
UsKkv3m5+gTyLaSGMS4wh2GoOCa21V9t5wYUQnoFaQByVNyl+kkrWLpKw5gQasU0
xkVsjAVKgkkb3puBl7sZgiSoz97I9U9JUkg3spH0I84CZRI+JejioDHvkZEyf83j
+QFxSTV/hZkUwUY/X0zt2dTZuliCTePeCdANryo6+9TbBp98j/SB1s59FcO8NSSK
sV07rTFlM9/soko2/J0aTtXHE86wFq7vfFVZzZxsQpIBbwIDAQABoyMwITAPBgNV
HRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAQEA
GU7xUWlZZEVnEK0k3Z1FoRl9xA7cLOiDVCQ5qQDFfQgGpMtXv1PKsQNZ6T6tZN3d
bdzsqcQXtLhXknz6aGBZNR4g6liQhVuCaiyURaI+LM2KuSZnbixs3+1SPBvxHrJh
/gOsxctxq+0DALnOK9qbGl6N5DtjM/EC5Qve71c+UVTEcJjJ3L2S1Ne+PxDOJuUC
JsOLUk96G+uLn6CQB5Wu8fYrkWAjF3yrxkCoZCqOvVrnbL77vXmz2mlqNHSJt3Ur
ndWJLVvrRFKdSG6WiNCh/Q+ARQAorN60JD9x8+IyXRGvlZl7KVeRduE2rjZuom7h
QLMnmaF+oFW5mnhh9gu6Gg==
-----END CERTIFICATE-----`;

function request(state, method, path, body) {
  return new Promise((resolve, reject) => {
    if (state.disposed) return reject(new Error('Node gestoppt'));
    const payload = body == null ? null : JSON.stringify(body);
    const req = https.request({
      hostname: state.cfg.ip, port: 8443, path: BASE + path, method,
      ca: CA, rejectUnauthorized: true,
      // Certificates identify gateway-<PIN>.local, not its LAN IP. For IP access
      // verify the vendor CA chain; an optional PIN also pins the gateway identity.
      checkServerIdentity: (host, cert) => state.cfg.gatewayPin
        ? tls.checkServerIdentity(`gateway-${state.cfg.gatewayPin}.local`, cert)
        : net.isIP(host) ? undefined : tls.checkServerIdentity(host, cert),
      headers: { Authorization: `Bearer ${state.cfg.token}`, 'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      timeout: 8000,
    }, res => {
      let raw = '';
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('TaHoma-Antwort abgebrochen')));
      res.on('data', chunk => {
        raw += chunk;
        if (raw.length > 4 * 1024 * 1024) req.destroy(new Error('TaHoma-Antwort zu groß'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`TaHoma HTTP ${res.statusCode}${res.statusCode === 401 ? ' – Token prüfen' : ''}`));
        }
        try { resolve(raw ? JSON.parse(raw) : null); }
        catch { reject(new Error('Ungültige TaHoma-JSON-Antwort')); }
      });
    });
    state.requests.add(req);
    req.on('close', () => state.requests.delete(req));
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('TaHoma Zeitüberschreitung')));
    req.end(payload);
  });
}

function bit(value) {
  if ([true, 1, '1', 'true', 'on'].includes(value)) return 1;
  if ([false, 0, '0', 'false', 'off'].includes(value)) return 0;
  return undefined;
}
function percent(value) {
  if (value == null || value === '' || typeof value === 'boolean') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : undefined;
}
function emit(state, handle, value) {
  if (!state.disposed && value !== undefined && state.outputs[handle] !== value) {
    state.outputs[handle] = value;
    state.context.emitOutput(handle, value);
  }
}
function report(state, values) {
  const data = Object.fromEntries((values || []).map(s => [s.name, s.value]));
  emit(state, 'status', bit(data['core:OnOffState']));
  emit(state, 'brightness', percent(data['core:LightIntensityState']));
  emit(state, 'position', percent(data['core:ClosureState']));
  emit(state, 'slats', percent(data['core:SlateOrientationState']));
  emit(state, 'moving', bit(data['core:MovingState']));
}
async function device(state) {
  if (state.device) return state.device;
  const list = await request(state, 'GET', '/setup/devices');
  if (!Array.isArray(list)) throw new Error('Ungültige TaHoma-Geräteliste');
  const matches = list.filter(d => state.cfg.deviceId
    ? d.deviceURL === state.cfg.deviceId : d.label === state.cfg.deviceName);
  if (matches.length !== 1) throw new Error(matches.length
    ? 'Gerätename ist nicht eindeutig – vollständige Geräte-ID verwenden'
    : 'TaHoma-Gerät nicht gefunden – Namen oder vollständige Geräte-ID prüfen');
  if (state.disposed) throw new Error('Node gestoppt');
  state.device = matches[0];
  state.context.setNodeStatus?.(true);
  report(state, state.device.states);
  return state.device;
}
async function refresh(state) {
  const d = await device(state);
  const values = await request(state, 'GET', `/setup/devices/${encodeURIComponent(d.deviceURL)}/states`);
  if (state.disposed) return;
  if (!Array.isArray(values)) throw new Error('Ungültige TaHoma-Statusantwort');
  d.states = values;
  report(state, values);
  state.context.setNodeStatus?.(true);
}
async function command(state, handle, value) {
  const d = await device(state);
  const supported = (name, count) => (d.definition?.commands || [])
    .some(c => c.commandName === name && (c.nparams == null || c.nparams === count));
  let names, parameters = [];
  switch (handle) {
    case 'switch':
      if (bit(value) === undefined) throw new Error('Schalten erwartet 0 oder 1');
      names = [bit(value) ? 'on' : 'off']; break;
    case 'toggle':
      if (bit(value) === undefined) throw new Error('Toggle erwartet 0 oder 1');
      if (supported('toggle', 0)) names = ['toggle'];
      else {
        await refresh(state);
        const current = bit(d.states.find(s => s.name === 'core:OnOffState')?.value);
        if (current === undefined) throw new Error('Toggle benötigt einen Ein/Aus-Status oder den Gerätebefehl toggle');
        names = [current ? 'off' : 'on'];
      }
      break;
    case 'brightness': names = ['setIntensity']; parameters = [percent(value)]; break;
    case 'position': names = ['setClosure']; parameters = [percent(value)]; break;
    case 'slats': names = ['setOrientation']; parameters = [percent(value)]; break;
    case 'open': names = ['open', 'up']; break;
    case 'close': names = ['close', 'down']; break;
    case 'upDown':
      if (bit(value) === undefined) throw new Error('Auf/Ab erwartet 0 oder 1');
      names = bit(value) ? ['close', 'down'] : ['open', 'up']; break;
    case 'stop': names = ['stop']; break;
    default: return;
  }
  if (parameters.includes(undefined)) throw new Error('Wert muss zwischen 0 und 100 % liegen');
  const name = names.find(n => supported(n, parameters.length));
  if (!name) throw new Error(`Gerät unterstützt ${names.join('/')} nicht`);
  await request(state, 'POST', '/exec/apply', {
    label: 'kaenix Somfy Tahoma', actions: [{ deviceURL: d.deviceURL, commands: [{ name, parameters }] }],
  });
  // Do not invent feedback: execution acceptance is not physical completion.
  await refresh(state);
}
function enqueue(state, work) {
  state.queue = state.queue.then(() => state.disposed ? undefined : work()).catch(error => {
    if (state.disposed) return;
    state.context.setNodeStatus?.(false);
    // Never include API response bodies or credentials in logs.
    const message = String(error.message).split(state.cfg.token).join('[Token]');
    state.context.warn?.(`Somfy Tahoma: ${message}`);
  });
  return state.queue;
}
function dispose(state) {
  state.disposed = true;
  clearInterval(state.timer);
  for (const req of state.requests) req.destroy();
}
const actions = ['switch', 'toggle', 'brightness', 'open', 'close', 'upDown', 'stop', 'position', 'slats', 'triggerStatus'];
const settings = ['ip', 'token', 'deviceName', 'deviceId', 'interval'];

module.exports = {
  type: 'somfy-tahoma', category: 'Geräte', label: 'Somfy Tahoma', color: '#f5a623',
  description: 'Lokale TaHoma-API (Developer Mode). Geräte-ID = vollständige deviceURL; alternativ eindeutiger Gerätename. Auf/Ab: 0=Auf, 1=Ab. Position: 0=offen, 100=geschlossen. Toggle und Trigger reagieren auf jedes 0/1-Telegramm. Rückmeldungen nur soweit vom Gerät unterstützt.',
  inputs: [
    { handle: 'ip', label: 'IP Adresse' },
    { handle: 'token', label: 'Token' },
    { handle: 'deviceName', label: 'Gerätename' },
    { handle: 'deviceId', label: 'Geräte ID' },
    { handle: 'switch', label: 'Schalten (0/1)' },
    { handle: 'toggle', label: 'Toggle (0/1)' },
    { handle: 'brightness', label: 'Dimmwert (0–100 %)' },
    { handle: 'open', label: 'Öffnen' },
    { handle: 'close', label: 'Schliessen' },
    { handle: 'upDown', label: 'Auf/Ab (0/1)' },
    { handle: 'stop', label: 'Stop' },
    { handle: 'position', label: 'Position (0–100 %)' },
    { handle: 'slats', label: 'Lamellenwinkel (0–100 %)' },
    { handle: 'triggerStatus', label: 'Status Trigger' },
    { handle: 'interval', label: 'Status Intervall (Sekunden)' },
  ],
  outputs: [
    { handle: 'status', label: 'Status (0/1)' },
    { handle: 'brightness', label: 'Helligkeit (0–100 %)' },
    { handle: 'position', label: 'Position (0–100 %)' },
    { handle: 'slats', label: 'Lamellenwinkel (0–100 %)' },
    { handle: 'moving', label: 'Fährt (0/1)' },
  ],
  globalSettings: [
    { key: 'ip', label: 'TaHoma IP-Adresse', type: 'text' },
    { key: 'token', label: 'Developer-Mode Token', type: 'password' },
    { key: 'gatewayPin', label: 'Gateway-PIN (optional, zusätzliche Zertifikatsprüfung)', type: 'text', placeholder: '1234-5678-9012' },
  ],
  config: [
    { key: 'deviceName', label: 'Gerätename', type: 'text' },
    { key: 'deviceId', label: 'Geräte-ID (deviceURL, hat Vorrang vor Name)', type: 'text', placeholder: 'io://1234-5678-9012/123456#1' },
    { key: 'interval', label: 'Status Intervall in Sekunden (Standard 10, 0 = aus)', type: 'number', placeholder: '10' },
  ],
  execute(inputs, data, context) {
    const id = context.nodeId || 'default';
    let state = states.get(id);
    const stored = { ...(state?.inputs || context.initialInputs || {}), ...inputs };
    const pick = key => stored[key] !== undefined && stored[key] !== '' ? stored[key]
      : data[key] !== undefined && data[key] !== '' ? data[key] : context.globalSetting?.(key);
    const cfg = Object.fromEntries(settings.map(key => [key, pick(key)]));
    for (const key of ['ip', 'token', 'deviceName', 'deviceId']) cfg[key] = String(cfg[key] ?? '').trim();
    cfg.gatewayPin = String(context.globalSetting?.('gatewayPin') || '').trim();
    const n = cfg.interval == null ? 10 : Number(cfg.interval);
    cfg.interval = Number.isFinite(n) && n >= 0 ? Math.min(86400, n === 0 ? 0 : Math.max(1, n)) : 10;
    const changed = !state || JSON.stringify(state.cfg) !== JSON.stringify(cfg);
    const previous = state?.inputs || context.initialInputs || {};
    if (changed) {
      if (state) dispose(state);
      state = { cfg, inputs: stored, context, outputs: {}, requests: new Set(), queue: Promise.resolve(), disposed: false, timer: null };
      states.set(id, state);
    }
    state.inputs = stored;
    state.context = context;
    if (!cfg.ip || !cfg.token || (!cfg.deviceId && !cfg.deviceName)) {
      context.setNodeStatus?.(false);
      return {};
    }
    if (changed) {
      enqueue(state, () => refresh(state));
      if (cfg.interval) {
        state.timer = setInterval(() => {
          if (state.pollPending) return;
          state.pollPending = true;
          enqueue(state, () => refresh(state)).finally(() => { state.pollPending = false; });
        }, cfg.interval * 1000);
        state.timer.unref?.();
      }
    }
    // A server start/reload restores configuration only; never replay saved commands.
    const handles = context.triggerHandle != null
      ? actions.filter(h => h === context.triggerHandle && inputs[h] !== undefined)
      : actions.filter(h => inputs[h] !== undefined && inputs[h] !== previous[h]);
    for (const handle of handles) {
      const value = inputs[handle];
      enqueue(state, () => {
        if (['open', 'close', 'stop', 'triggerStatus'].includes(handle) && bit(value) === undefined) {
          throw new Error('Trigger erwartet 0 oder 1');
        }
        return handle === 'triggerStatus' ? refresh(state) : command(state, handle, value);
      });
    }
    return {};
  },
  dispose(nodeId) {
    if (nodeId != null) {
      const state = states.get(nodeId);
      if (state) dispose(state);
      states.delete(nodeId);
    } else {
      for (const state of states.values()) dispose(state);
      states.clear();
    }
  },
};
