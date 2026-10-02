/**
 * @plugin    Heizung
 * @version   1.0.0
 * @author    Christian Brauwers
 */
const states = new Map();
const clamp = value => Math.max(0, Math.min(100, value));
function number(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return NaN;
  return Number(value);
}
function flag(value, fallback) {
  if (value === undefined) return fallback;
  if ([true, 1, '1'].includes(value)) return true;
  if ([false, 0, '0'].includes(value)) return false;
  return null;
}
function send(s, handle, value, force = false) {
  const now = Date.now();
  const changed = handle === 'ventil' ? s.sent[handle] === undefined || Math.abs(s.sent[handle] - value) >= s.settings.sendDelta
    || (value !== s.sent[handle] && (value === 0 || value === 100)) : s.sent[handle] !== value;
  if (!force && !changed && !(handle === 'ventil' && now - (s.sentAt || 0) >= s.settings.resend * 1000)) return;
  s.sent[handle] = value;
  if (handle === 'ventil') s.sentAt = now;
  s.context.emitOutput(handle, value);
}
function regulate(s, integrate) {
  const now = Date.now(), cfg = s.settings;
  const setpoint = number(s.inputs.temperaturSoll ?? cfg.setpoint);
  const temp = number(s.inputs.temperaturIst);
  const enabled = flag(s.inputs.freigabe, true), windowOpen = flag(s.inputs.fenster, false);
  const validSetpoint = Number.isFinite(setpoint) && setpoint >= 5 && setpoint <= 35;
  if (validSetpoint) send(s, 'temperaturSoll', setpoint);
  let status = 'OK';
  if (!cfg.valid || !validSetpoint || enabled === null || windowOpen === null) status = 'Ungültige Konfiguration / Solltemperatur / Freigabe';
  else if (!enabled || windowOpen) status = windowOpen ? 'Fenster offen' : 'Gesperrt';
  else if (!Number.isFinite(temp) || temp < -20 || temp > 60 || s.measuredAt === null) status = 'Isttemperatur fehlt / ungültig';
  else if (now - s.measuredAt >= cfg.timeout * 1000) status = 'Isttemperatur veraltet';
  if (status !== 'OK') {
    s.integral = 0; s.lastStep = now;
    send(s, 'ventil', status === 'Gesperrt' || status === 'Fenster offen' ? 0 : cfg.failSafe, s.sent.status !== status);
    send(s, 'status', status);
    return;
  }
  const error = setpoint - temp;
  const p = 100 / cfg.band * error;
  // Conditional integration prevents windup at both actuator limits. Real elapsed
  // time makes PI independent of telegram frequency; long scheduler stalls are capped.
  if (integrate) {
    const dt = Math.max(0, Math.min(now - s.lastStep, cfg.cycle * 2000)) / 60000;
    const increment = 100 / cfg.band * error * dt / cfg.integralMinutes;
    const candidate = s.integral + increment;
    const output = p + candidate;
    if ((output >= 0 && output <= 100) || (output > 100 && increment < 0) || (output < 0 && increment > 0)) {
      s.integral = clamp(candidate);
    }
    s.lastStep = now;
  }
  send(s, 'ventil', Math.round(clamp(p + s.integral) * 10) / 10);
  send(s, 'status', status);
}
function schedule(s) {
  s.timer = setTimeout(() => {
    s.timer = null;
    if (s.disposed) return;
    regulate(s, true);
    if (!s.disposed) schedule(s);
  }, s.settings.cycle * 1000);
  s.timer.unref?.();
}
function settings(data) {
  const read = (key, fallback) => number(data[key] ?? fallback);
  const cfg = { setpoint: read('temperaturSoll', 21), band: read('proportionalband', 4), integralMinutes: read('nachstellzeit', 200),
    cycle: read('zyklus', 30), timeout: read('messwertTimeout', 1800), sendDelta: read('sendeDifferenz', 1),
    resend: read('wiederholung', 300), failSafe: read('stoerstellung', 0) };
  cfg.valid = Object.values(cfg).every(Number.isFinite) && cfg.band >= 0.1 && cfg.band <= 20
    && cfg.integralMinutes >= 1 && cfg.integralMinutes <= 1440 && cfg.cycle >= 1 && cfg.cycle <= 300
    && cfg.timeout >= cfg.cycle && cfg.timeout <= 86400 && cfg.sendDelta >= 0.1 && cfg.sendDelta <= 10
    && cfg.resend >= cfg.cycle && cfg.resend <= 86400 && cfg.failSafe >= 0 && cfg.failSafe <= 100;
  // Invalid settings must neither produce NaN outputs nor create a busy timer loop.
  if (!cfg.valid) { cfg.cycle = 30; cfg.sendDelta = 1; cfg.resend = 300; cfg.failSafe = 0; }
  return cfg;
}
module.exports = {
  type: 'heizung', category: 'Energie', label: 'Heizung', color: '#f97316',
  description: 'Zyklischer PI-Raumtemperaturregler mit Anti-Windup. Ventil 0–100 % (DPT 5.001), Solltemperatur in °C (DPT 9.001). Messwertüberwachung, Fensterkontakt und Freigabe.',
  inputs: [
    { handle: 'temperaturIst', label: 'Temperatur Ist (°C)' },
    { handle: 'temperaturSoll', label: 'Temperatur Soll (°C)' },
    { handle: 'freigabe', label: 'Freigabe (0/1)' },
    { handle: 'fenster', label: 'Fenster offen (0/1)' },
  ],
  outputs: [
    { handle: 'ventil', label: 'Ventil (%)' },
    { handle: 'temperaturSoll', label: 'Temperatur Soll (°C)' },
    { handle: 'status', label: 'Status' },
  ],
  config: [
    { key: 'temperaturSoll', label: 'Temperatur Soll (5–35 °C)', type: 'number', default: 21 },
    { key: 'proportionalband', label: 'Proportionalband (0,1–20 K)', type: 'number', default: 4 },
    { key: 'nachstellzeit', label: 'Nachstellzeit (1–1440 min)', type: 'number', default: 200 },
    { key: 'zyklus', label: 'Regelzyklus (1–300 s)', type: 'number', default: 30 },
    { key: 'messwertTimeout', label: 'Isttemperatur-Timeout (s)', type: 'number', default: 1800 },
    { key: 'sendeDifferenz', label: 'Sendedifferenz (0,1–10 Prozentpunkte)', type: 'number', default: 1 },
    { key: 'wiederholung', label: 'Zyklisches Senden (s)', type: 'number', default: 300 },
    { key: 'stoerstellung', label: 'Ventil bei Messwertfehler (0–100 %)', type: 'number', default: 0 },
  ],
  execute(inputs, data, context) {
    const id = context.nodeId;
    if (!id) { context.warn?.('Heizung benötigt eine eindeutige Node-ID'); return {}; }
    let s = states.get(id);
    if (!s) {
      s = { inputs: { ...context.initialInputs }, sent: {}, integral: 0, measuredAt: null, lastStep: Date.now(), timer: null };
      states.set(id, s);
    }
    s.context = context;
    s.inputs = { ...s.inputs, ...inputs };
    // Only actual temperature telegrams refresh the watchdog. Cached startup
    // values and setpoint/freigabe events must not keep a silent sensor alive.
    if (context.triggerHandle === 'temperaturIst' || (context.triggerHandle === undefined && Object.hasOwn(inputs, 'temperaturIst'))) {
      s.measuredAt = Date.now();
    }
    const cfg = settings(data);
    const changed = !s.settings || JSON.stringify(cfg) !== JSON.stringify(s.settings);
    if (changed) { s.integral = 0; s.lastStep = Date.now(); }
    s.settings = cfg;
    if (changed) { clearTimeout(s.timer); s.timer = null; }
    regulate(s, false);
    if (!s.timer && !s.disposed) schedule(s);
    return {};
  },
  dispose(nodeId) {
    for (const [id, s] of states) {
      if (nodeId != null && id !== nodeId) continue;
      s.disposed = true;
      clearTimeout(s.timer);
      states.delete(id);
    }
  },
};
