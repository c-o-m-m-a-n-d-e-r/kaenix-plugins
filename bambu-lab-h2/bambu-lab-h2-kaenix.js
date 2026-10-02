/**
 * @plugin Bambu Lab H2
 * @version 1.0.0
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 */
'use strict';
const path = require('path');
const { isIP } = require('net');
let mqtt;
const states = new Map();

// A marketplace installation copies only this file. Resolve backend dependencies lazily.
function getMqtt() {
    if (mqtt) return mqtt;
    try { mqtt = require('mqtt'); }
    catch {
        try {
            mqtt = require(require.resolve('mqtt', {
                paths: [process.cwd(), path.resolve(__dirname, '../../backend')],
            }));
        } catch {
            throw new Error('MQTT-Bibliothek fehlt. Homeserver-Backend aktualisieren '
                + '(bei Quellcode-Installation: npm ci im Backend), Server neu starten und Plugins neu laden.');
        }
    }
    return mqtt;
}

function close(id) {
    const s = states.get(id);
    if (!s) return;
    states.delete(id);
    clearInterval(s.poll);
    clearTimeout(s.watchdog);
    s.client?.end(true);
}

function options(data) {
    const host = String(data.ip || '').trim();
    const password = String(data.accessCode || '').trim();
    const serial = String(data.serial || '').trim();
    const port = Number(data.port ?? 8883);
    const interval = Number(data.interval ?? 60);
    if (!isIP(host)) throw new Error('Eine gültige Drucker-IP ist erforderlich');
    if (!password || /[\s\u0000]/u.test(password)) throw new Error('Access Code fehlt oder ist ungültig');
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(serial)) throw new Error('Drucker-Seriennummer fehlt oder ist ungültig');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port muss zwischen 1 und 65535 liegen');
    if (!Number.isInteger(interval) || interval < 0 || interval > 3600 || (interval > 0 && interval < 10)) {
        throw new Error('Statusintervall muss 0 oder 10–3600 Sekunden sein');
    }
    return { host, password, serial, port, interval,
        verifyTLS: [true, 1, '1', 'true'].includes(data.verifyTLS) };
}

const fields = {
    gcode_state: 'printState', mc_percent: 'progress', mc_remaining_time: 'remaining',
    layer_num: 'layer', total_layer_num: 'layers', subtask_name: 'job', gcode_file: 'file',
    nozzle_temper: 'nozzleTemp', nozzle_target_temper: 'nozzleTarget',
    bed_temper: 'bedTemp', bed_target_temper: 'bedTarget',
    chamber_temper: 'chamberTemp', ctt: 'chamberTarget', print_error: 'printError',
    spd_mag: 'speed', stg_cur: 'stage', wifi_signal: 'wifi',
};
const texts = new Set(['printState', 'job', 'file', 'wifi']);
function numeric(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}
function packedTemp(value) {
    const n = numeric(value);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [n & 0xffff, (n >>> 16) & 0xffff];
}

function report(s, p) {
    let valid = false;
    const output = (handle, value) => { valid = true; s.output(handle, value); };
    for (const [key, handle] of Object.entries(fields)) {
        const value = texts.has(handle) ? (typeof p[key] === 'string' ? p[key] : undefined) : numeric(p[key]);
        if (value !== undefined) output(handle, value);
    }
    if (typeof p.gcode_state === 'string') {
        s.output('printing', p.gcode_state === 'RUNNING');
        s.output('paused', p.gcode_state === 'PAUSE');
        s.output('finished', p.gcode_state === 'FINISH');
    }
    // H2 protocol v2: low 16 bits = actual temperature, high 16 bits = target.
    const device = p.device;
    for (const [value, actual, target] of [
        [device?.bed_temp, 'bedTemp', 'bedTarget'],
        [device?.ctc?.info?.temp, 'chamberTemp', 'chamberTarget'],
    ]) {
        const temperatures = packedTemp(value);
        if (temperatures) {
            output(actual, temperatures[0]);
            output(target, temperatures[1]);
        }
    }
    if (Array.isArray(device?.extruder?.info)) {
        for (const extruder of device.extruder.info) {
            if (!extruder || ![0, 1].includes(extruder.id)) continue;
            const temperatures = packedTemp(extruder.temp);
            if (!temperatures) continue;
            const side = extruder.id === 0 ? 'right' : 'left';
            output(`${side}Temp`, temperatures[0]);
            output(`${side}Target`, temperatures[1]);
        }
    }
    if (Array.isArray(p.hms)) { valid = true; s.context.emitOutput('hms', p.hms); }
    if (p.ams && typeof p.ams === 'object' && !Array.isArray(p.ams)) {
        valid = true;
        s.context.emitOutput('ams', p.ams);
    }
    return valid;
}

function start(id, cfg, context, library) {
    const s = { cfg, context, connected: false, values: new Map(), session: 0 };
    states.set(id, s);
    const active = () => states.get(id) === s;
    s.output = (handle, value) => {
        if (!active() || (s.values.has(handle) && s.values.get(handle) === value)) return;
        s.values.set(handle, value);
        s.context.emitOutput(handle, value);
    };
    s.fail = message => {
        if (!active()) return;
        s.output('error', message);
        s.context.warn(message);
    };
    const fresh = value => {
        s.output('dataFresh', value);
        s.context.setNodeStatus?.(value);
    };
    const watch = () => {
        clearTimeout(s.watchdog);
        s.watchdog = setTimeout(() => {
            if (!active()) return;
            fresh(false);
            s.output('status', 'Keine aktuellen Druckerdaten');
            s.fail('Seit 120 Sekunden keine Druckerdaten; Seriennummer und LAN-Zugriff prüfen');
        }, 120000);
        s.watchdog.unref?.();
    };
    const disconnected = message => {
        if (!active()) return;
        s.session++;
        s.connected = false;
        s.receiving = false;
        clearInterval(s.poll);
        clearTimeout(s.watchdog);
        s.output('connected', false);
        fresh(false);
        s.output('status', message);
    };
    s.request = () => {
        if (!active() || !s.connected) return;
        const session = s.session;
        s.client.publish(`device/${cfg.serial}/request`, JSON.stringify({
            pushing: { sequence_id: '0', command: 'pushall' },
        }), { qos: 0, retain: false }, err => {
            if (active() && s.connected && s.session === session && err) s.fail('Statusabfrage konnte nicht gesendet werden');
        });
    };
    disconnected('Verbinde …');
    s.output('error', '');
    s.client = library.connect({ protocol: 'mqtts', host: cfg.host, port: cfg.port,
        username: 'bblp', password: cfg.password, rejectUnauthorized: cfg.verifyTLS,
        protocolVersion: 4, clean: true, reconnectPeriod: 5000, connectTimeout: 10000,
        resubscribe: false, queueQoSZero: false });
    s.client.on('connect', () => {
        if (!active()) return;
        disconnected('Abonniere Druckerdaten …');
        s.receiving = true;
        // Allow the first report immediately, even if it arrives before SUBACK.
        const session = s.session;
        s.client.subscribe(`device/${cfg.serial}/report`, { qos: 0 }, (err, granted) => {
            if (!active() || session !== s.session) return;
            if (err || !granted?.length || granted.some(item => item.qos > 2)) {
                s.receiving = false;
                clearTimeout(s.watchdog);
                fresh(false);
                s.fail('Druckerdaten-Abonnement fehlgeschlagen');
                s.output('status', 'Abonnement fehlgeschlagen');
                return;
            }
            s.connected = true;
            s.output('connected', true);
            s.output('error', '');
            s.output('status', 'Verbunden');
            watch();
            s.request();
            if (cfg.interval > 0) {
                s.poll = setInterval(s.request, cfg.interval * 1000);
                s.poll.unref?.();
            }
        });
    });
    s.client.on('close', () => disconnected('Getrennt'));
    s.client.on('reconnect', () => disconnected('Verbinde erneut …'));
    // Never expose broker errors: these may contain credentials.
    s.client.on('error', () => {
        if (!active()) return;
        s.fail('MQTT-Verbindungsfehler; IP, Access Code und LAN-Zugriff prüfen');
    });
    s.client.on('message', (topic, payload) => {
        if (!active() || !s.receiving || topic !== `device/${cfg.serial}/report`) return;
        if (payload.length > 2 * 1024 * 1024) { s.fail('Druckernachricht zu groß'); return; }
        let message;
        try { message = JSON.parse(payload.toString('utf8')); }
        catch { s.fail('Druckernachricht enthält kein gültiges JSON'); return; }
        const p = message?.print;
        if (!p || typeof p !== 'object' || Array.isArray(p)) return;
        s.context.emitOutput('raw', message);
        // Command acknowledgements alone must not make stale telemetry appear current.
        if (!report(s, p)) return;
        fresh(true);
        s.output('error', '');
        s.output('status', 'Druckerdaten empfangen');
        watch();
    });
    return s;
}

module.exports = {
    type: 'bambu-lab-h2', label: 'Bambu Lab H2', category: 'Geräte', color: '#f97316',
    description: 'Liest Druckerdaten der Bambu Lab H2-Serie über lokales MQTT/TLS. Zugangsdaten pro Node, ohne Kamera.',
    inputs: [
        { handle: 'refresh', label: 'Status abfragen' },
        { handle: 'reconnect', label: 'Neu verbinden' },
    ],
    outputs: [
        { handle: 'connected', label: 'MQTT verbunden' },
        { handle: 'dataFresh', label: 'Daten aktuell' },
        { handle: 'printState', label: 'Druckstatus' },
        { handle: 'printing', label: 'Druck läuft' },
        { handle: 'paused', label: 'Pausiert' },
        { handle: 'finished', label: 'Fertig' },
        { handle: 'progress', label: 'Fortschritt (%)' },
        { handle: 'remaining', label: 'Restzeit (min)' },
        { handle: 'layer', label: 'Aktuelle Schicht' },
        { handle: 'layers', label: 'Schichten gesamt' },
        { handle: 'job', label: 'Druckauftrag' },
        { handle: 'file', label: 'G-Code-Datei' },
        { handle: 'nozzleTemp', label: 'Düse Ist (°C, Legacy)' },
        { handle: 'nozzleTarget', label: 'Düse Soll (°C, Legacy)' },
        { handle: 'rightTemp', label: 'Düse rechts Ist (°C)' },
        { handle: 'rightTarget', label: 'Düse rechts Soll (°C)' },
        { handle: 'leftTemp', label: 'Düse links Ist (°C)' },
        { handle: 'leftTarget', label: 'Düse links Soll (°C)' },
        { handle: 'bedTemp', label: 'Druckbett Ist (°C)' },
        { handle: 'bedTarget', label: 'Druckbett Soll (°C)' },
        { handle: 'chamberTemp', label: 'Kammer Ist (°C)' },
        { handle: 'chamberTarget', label: 'Kammer Soll (°C)' },
        { handle: 'speed', label: 'Geschwindigkeit (%)' },
        { handle: 'stage', label: 'Druckphase (Code)' },
        { handle: 'wifi', label: 'WLAN-Signal' },
        { handle: 'printError', label: 'Druckerfehler (Code)' },
        { handle: 'hms', label: 'HMS-Meldungen (JSON)' },
        { handle: 'ams', label: 'AMS-Daten (JSON)' },
        { handle: 'raw', label: 'MQTT-Report (JSON)' },
        { handle: 'status', label: 'Verbindungsstatus' },
        { handle: 'error', label: 'Verbindungs-/Datenfehler' },
    ],
    config: [
        { key: 'ip', label: 'Drucker-IP', type: 'text', placeholder: '192.168.1.100' },
        { key: 'accessCode', label: 'LAN Access Code', type: 'password' },
        { key: 'serial', label: 'Drucker-Seriennummer (MQTT-Topic)', type: 'text' },
        { key: 'interval', label: 'Statusabfrage (s, 0 = nur Push)', type: 'number', default: 60 },
        { key: 'port', label: 'MQTT-TLS-Port', type: 'number', default: 8883 },
        { key: 'verifyTLS', label: 'TLS-Zertifikat prüfen', type: 'checkbox', default: false },
    ],
    execute(inputs, data, context) {
        const id = context.nodeId;
        let s = states.get(id);
        let cfg, library;
        try { cfg = options(data); library = getMqtt(); }
        catch (err) {
            close(id);
            context.setNodeStatus?.(false);
            context.emitOutput('connected', false);
            context.emitOutput('dataFresh', false);
            context.emitOutput('status', 'Fehler');
            context.emitOutput('error', err.message);
            context.warn(err.message);
            return {};
        }
        try {
            const restart = context.triggerHandle === 'reconnect' && [true, 1, '1'].includes(inputs.reconnect);
            if (!s || JSON.stringify(cfg) !== JSON.stringify(s.cfg) || restart) {
                close(id);
                s = start(id, cfg, context, library);
            }
            s.context = context;
            if (context.triggerHandle === 'refresh' && [true, 1, '1'].includes(inputs.refresh)) {
                if (s.connected) s.request();
                else s.fail('Nicht verbunden; Statusabfrage wurde nicht gesendet');
            }
        } catch {
            close(id);
            context.setNodeStatus?.(false);
            context.emitOutput('connected', false);
            context.emitOutput('dataFresh', false);
            context.emitOutput('status', 'Fehler');
            context.emitOutput('error', 'MQTT-Verbindung konnte nicht gestartet werden');
            context.warn('MQTT-Verbindung konnte nicht gestartet werden');
        }
        return {};
    },
    dispose(nodeId) {
        if (nodeId != null) close(nodeId);
        else for (const id of states.keys()) close(id);
    },
};
