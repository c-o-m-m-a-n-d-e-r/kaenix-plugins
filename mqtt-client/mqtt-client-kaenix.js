/**
 * @plugin MQTT Client
 * @version 1.0.0
 */
const path = require('path');
let mqtt;
try { mqtt = require('mqtt'); }
catch { mqtt = require(require.resolve('mqtt', { paths: [process.cwd(), path.resolve(__dirname, '../../backend')] })); }
const states = new Map();

function close(id) {
  const state = states.get(id);
  if (!state) return;
  states.delete(id);
  state.client?.end(true);
}

function options(data, context) {
  const host = String(context.globalSetting('ip') || '').trim();
  const port = Number(context.globalSetting('port') || 1883);
  const topic = String(data.topic || '');
  const qos = Number(data.qos ?? 0);
  const protocolVersion = Number(data.protocolVersion ?? 4);
  if (!host || /[\s/]/u.test(host)) throw new Error('Broker-IP oder Hostname fehlt oder ist ungültig');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port muss zwischen 1 und 65535 liegen');
  if (!topic || /[\u0000+#]/u.test(topic) || Buffer.byteLength(topic) > 65535) {
    throw new Error('Ein konkretes Topic ohne Wildcards (+/#) ist erforderlich');
  }
  if (![0, 1, 2].includes(qos)) throw new Error('QoS muss 0, 1 oder 2 sein');
  if (![3, 4, 5].includes(protocolVersion)) throw new Error('Ungültige MQTT-Version');
  const format = data.format || 'auto';
  if (!['auto', 'text', 'json'].includes(format)) throw new Error('Ungültiges Nachrichtenformat');
  return { host, port, topic, qos, protocolVersion, format,
    username: String(context.globalSetting('username') || ''),
    password: String(context.globalSetting('password') || ''),
    clientId: String(data.clientId || '').trim(),
    retain: data.retain === true || data.retain === 'true' || data.retain === 1 || data.retain === '1' };
}

function start(id, cfg, context) {
  const s = { cfg, context, connected: false };
  states.set(id, s);
  const active = () => states.get(id) === s;
  const status = (connected, message) => {
    if (!active()) return;
    s.connected = connected;
    s.context.setNodeStatus?.(connected);
    s.context.emitOutput('connected', connected);
    s.context.emitOutput('status', message);
  };
  s.fail = (message) => {
    if (!active()) return;
    s.context.warn(message);
    s.context.emitOutput('error', message);
  };
  status(false, 'Verbinde …');
  s.client = mqtt.connect({ protocol: 'mqtt', host: cfg.host, port: cfg.port,
    protocolVersion: cfg.protocolVersion,
    ...(cfg.protocolVersion === 3 ? { protocolId: 'MQIsdp' } : {}),
    ...(cfg.clientId ? { clientId: cfg.clientId } : {}),
    ...(cfg.username ? { username: cfg.username } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
    clean: true, reconnectPeriod: 5000, connectTimeout: 10000,
    resubscribe: false, queueQoSZero: false });
  s.client.on('connect', () => {
    if (!active()) return;
    status(true, 'Verbunden');
    s.client.subscribe(cfg.topic, { qos: cfg.qos }, (err, granted) => {
      if (!active() || !s.connected) return;
      if (err || !granted?.length || granted.some(item => item.qos > 2)) {
        s.fail('Topic-Abonnement fehlgeschlagen');
        s.context.emitOutput('status', 'Abonnement fehlgeschlagen');
      } else {
        s.context.emitOutput('error', '');
        s.context.emitOutput('status', 'Abonniert');
      }
    });
  });
  s.client.on('close', () => status(false, 'Getrennt'));
  s.client.on('reconnect', () => status(false, 'Verbinde erneut …'));
  // Keine Broker-Fehlertexte ausgeben: Sie können Verbindungsdaten enthalten.
  s.client.on('error', () => s.fail('MQTT-Verbindungsfehler; Broker und Zugangsdaten prüfen'));
  s.client.on('message', (topic, payload) => {
    if (!active() || topic !== cfg.topic) return;
    const raw = payload.toString('utf8');
    let value = raw;
    if (cfg.format !== 'text') {
      try { value = JSON.parse(raw); }
      catch {
        if (cfg.format === 'json') { s.fail('Empfangene Nachricht ist kein gültiges JSON'); return; }
      }
    }
    s.context.emitOutput('out', value);
  });
  return s;
}

module.exports = {
  type: 'mqtt-client', label: 'MQTT Client', category: 'Datenaustausch', color: '#0d9488',
  description: 'Sendet und empfängt Nachrichten auf einem MQTT-Topic. Broker-Zugangsdaten gelten global.',
  globalSettings: [
    { key: 'ip', label: 'Broker-IP / Hostname', type: 'text' },
    { key: 'port', label: 'Port', type: 'number', default: 1883 },
    { key: 'username', label: 'Benutzername', type: 'text' },
    { key: 'password', label: 'Passwort', type: 'password' },
  ],
  inputs: [{ handle: 'in', label: 'Nachricht senden' }, { handle: 'reconnect', label: 'Neu verbinden' }],
  outputs: [
    { handle: 'out', label: 'Nachricht empfangen' },
    { handle: 'connected', label: 'Verbunden' },
    { handle: 'status', label: 'Status' },
    { handle: 'error', label: 'Fehler' },
  ],
  config: [
    { key: 'topic', label: 'Topic', type: 'text', placeholder: 'haus/wohnzimmer/licht' },
    { key: 'qos', label: 'QoS', type: 'select', default: '0', options: [
      { value: '0', label: '0 – Höchstens einmal' }, { value: '1', label: '1 – Mindestens einmal' },
      { value: '2', label: '2 – Genau einmal' },
    ] },
    { key: 'retain', label: 'Letzte Nachricht im Broker speichern (Retain)', type: 'checkbox', default: false },
    { key: 'format', label: 'Nachrichtenformat', type: 'select', default: 'auto', options: [
      { value: 'auto', label: 'Automatisch (native Werte / Text)' },
      { value: 'text', label: 'Text' }, { value: 'json', label: 'JSON' },
    ] },
    { key: 'protocolVersion', label: 'MQTT-Version', type: 'select', default: '4', options: [
      { value: '3', label: '3.1' }, { value: '4', label: '3.1.1' }, { value: '5', label: '5.0' },
    ] },
    { key: 'clientId', label: 'Client-ID (leer = automatisch)', type: 'text' },
  ],
  execute(inputs, data, context) {
    const id = context.nodeId;
    let s = states.get(id);
    try {
      const cfg = options(data, context);
      const restart = context.triggerHandle === 'reconnect' && [true, 1, '1'].includes(inputs.reconnect);
      if (!s || JSON.stringify(cfg) !== JSON.stringify(s.cfg) || restart) {
        close(id);
        s = start(id, cfg, context);
      }
      s.context = context;
      // Only publish actual telegrams, including repeated values, false, 0 and empty text.
      if (context.triggerHandle !== 'in' || inputs.in === undefined) return {};
      if (!s.connected) { s.fail('Nicht verbunden; Nachricht wurde nicht gesendet'); return {}; }
      let payload;
      if (cfg.format === 'text') payload = String(inputs.in);
      else if (cfg.format === 'json') payload = JSON.stringify(inputs.in);
      else payload = typeof inputs.in === 'string' ? inputs.in : JSON.stringify(inputs.in);
      if (payload === undefined) throw new Error('Nachricht kann nicht serialisiert werden');
      s.client.publish(cfg.topic, payload, { qos: cfg.qos, retain: cfg.retain }, (err) => {
        if (err) s.fail('MQTT-Nachricht konnte nicht gesendet werden');
      });
    } catch (err) {
      close(id);
      context.setNodeStatus?.(false);
      context.emitOutput('connected', false);
      context.emitOutput('error', err.message);
      context.warn(err.message);
    }
    return {};
  },
  dispose(nodeId) {
    if (nodeId != null) close(nodeId);
    else for (const id of states.keys()) close(id);
  },
};
