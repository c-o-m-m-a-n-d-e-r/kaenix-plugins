/**
 * @plugin Nuki
 * @version 1.0.4
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 */
'use strict';
const http = require('http');
const https = require('https');
const path = require('path');
const { createHash } = require('crypto');
const callbackListeners = new Map();
const callbackSessions = new Map();
const states = new Map();
let mqtt;

// Marketplace installations copy this file alone; keep all implementation here.
function getMqtt() {
    if (mqtt) return mqtt;
    try {
        mqtt = require('mqtt');
    } catch {
        try {
            mqtt = require(
                require.resolve('mqtt', {
                    paths: [
                        process.cwd(),
                        path.resolve(__dirname, '../../backend'),
                    ],
                }),
            );
        } catch {
            throw new Error(
                'Nuki: MQTT-Bibliothek fehlt; Homeserver-Backend aktualisieren',
            );
        }
    }
    return mqtt;
}
const on = (value) => [true, 1, '1', 'true'].includes(value);
function number(value, min, max) {
    if (
        typeof value !== 'number' &&
        (typeof value !== 'string' || !value.trim())
    )
        return undefined;
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}
function boolean(value) {
    if ([true, 1, '1', 'true'].includes(value)) return true;
    if ([false, 0, '0', 'false'].includes(value)) return false;
    return undefined;
}
function callbackAddress(context) {
    const value = String(context.getServerIp?.() || '').trim();
    if (!value) {
        throw new Error(
            'Nuki: HomeServer-IP fehlt; in den Einstellungen eintragen',
        );
    }
    try {
        const url = new URL(
            /^https?:\/\//iu.test(value) ? value : `http://${value}`,
        );
        if (
            !url.hostname ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (!/^https?:\/\//iu.test(value) &&
                (url.pathname !== '/' || url.hostname !== value.toLowerCase()))
        )
            throw new Error();
        return url.hostname;
    } catch {
        throw new Error(
            'Nuki: HomeServer-IP in den Einstellungen ist ungültig',
        );
    }
}
function options(data, context) {
    const mode = data.mode || 'bridge';
    if (!['bridge', 'mqtt', 'web'].includes(mode))
        throw new Error('Nuki: ungültige Verbindungsart');
    const interval = number(data.interval ?? 60, 0, 3600);
    if (interval === undefined || (interval > 0 && interval < 30)) {
        throw new Error(
            'Nuki: Statusintervall muss 0 oder 30–3600 Sekunden sein',
        );
    }
    const cfg = { mode, interval };
    const id = String(data.deviceId ?? '').trim();
    if (mode === 'mqtt') {
        if (!/^[a-fA-F0-9]{1,16}$/u.test(id))
            throw new Error('Nuki: MQTT-Geräte-ID muss hexadezimal sein');
        cfg.topic = `nuki/${id}`;
        cfg.host = String(data.host || '').trim();
        cfg.tls = on(data.mqttTLS);
        cfg.port = number(
            Number(data.port) === 0 || data.port == null
                ? cfg.tls
                    ? 8883
                    : 1883
                : data.port,
            1,
            65535,
        );
        cfg.username = String(data.username || '');
        cfg.password = String(data.password || '');
    } else {
        // HTTP IDs are decimal, or explicitly hexadecimal with 0x prefix.
        if (
            !/^(?:[0-9]+|0x[a-fA-F0-9]+)$/u.test(id) ||
            !Number.isSafeInteger(Number(id)) ||
            Number(id) <= 0
        ) {
            throw new Error(
                'Nuki: Geräte-ID muss dezimal oder hexadezimal mit 0x-Präfix sein',
            );
        }
        cfg.id = Number(id);
        cfg.token = String(data.token || '').trim();
        if (!cfg.token || /[\s\u0000-\u001f\u007f]/u.test(cfg.token))
            throw new Error('Nuki: API-Token fehlt oder ist ungültig');
        if (mode === 'bridge') {
            cfg.host = String(data.host || '').trim();
            cfg.port = number(
                Number(data.port) === 0 || data.port == null ? 8080 : data.port,
                1,
                65535,
            );
            cfg.callback = on(data.callback);
            if (cfg.callback) {
                cfg.callbackHost = callbackAddress(context);
                cfg.callbackPort = number(
                    data.callbackPort == null || data.callbackPort === ''
                        ? 8099
                        : data.callbackPort,
                    1,
                    65535,
                );
                if (!cfg.callbackPort) {
                    throw new Error(
                        'Nuki: Callback-Port muss zwischen 1 und 65535 liegen',
                    );
                }
                if (/[\s/\\?#@\u0000-\u001f]/u.test(cfg.callbackHost)) {
                    throw new Error(
                        'Nuki: Callback-Adresse oder Port ist ungültig',
                    );
                }
                const callbackUrl = new URL(
                    `http://${cfg.callbackHost}:${cfg.callbackPort}`,
                );
                if (callbackUrl.hostname !== cfg.callbackHost.toLowerCase()) {
                    throw new Error(
                        'Nuki: Callback-Adresse oder Port ist ungültig',
                    );
                }
            }
            cfg.deviceType =
                data.deviceType == null ||
                data.deviceType === '' ||
                data.deviceType === 'auto'
                    ? 'auto'
                    : number(data.deviceType, 0, 5);
            if (
                cfg.deviceType !== 'auto' &&
                ![0, 3, 4, 5].includes(cfg.deviceType)
            ) {
                throw new Error('Nuki: nicht unterstützter Gerätetyp');
            }
        }
    }
    if (mode !== 'web') {
        if (
            !cfg.host ||
            /[\s/\\?#@\u0000-\u001f]/u.test(cfg.host) ||
            !cfg.port
        ) {
            throw new Error('Nuki: Hostname oder Port ist ungültig');
        }
        // Validate host syntax without allowing credentials, paths or query strings.
        const url = new URL(`http://${cfg.host}:${cfg.port}`);
        if (url.port && Number(url.port) !== cfg.port)
            throw new Error('Nuki: Hostname oder Port ist ungültig');
    }
    return cfg;
}
function close(id) {
    const s = states.get(id);
    if (!s) return;
    states.delete(id);
    releaseCallback(s);
    clearInterval(s.poll);
    clearTimeout(s.commandTimer);
    for (const timer of s.timers) clearTimeout(timer);
    for (const req of s.requests) req.destroy();
    s.client?.end(true);
}
function later(s, fn, ms) {
    const timer = setTimeout(() => {
        s.timers.delete(timer);
        if (s.active()) fn();
    }, ms);
    timer.unref?.();
    s.timers.add(timer);
}

// Never expose raw provider errors, response bodies or URLs containing credentials.
function request(s, endpoint, { action, simple, query } = {}) {
    const cfg = s.cfg;
    const url =
        cfg.mode === 'web'
            ? new URL(`https://api.nuki.io/smartlock/${cfg.id}${endpoint}`)
            : new URL(`http://${cfg.host}:${cfg.port}${endpoint}`);
    let body;
    const headers = { Accept: 'application/json' };
    if (cfg.mode === 'web') {
        headers.Authorization = `Bearer ${cfg.token}`;
        if (action !== undefined && !simple) {
            body = JSON.stringify({ action });
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(body);
        }
    } else {
        url.searchParams.set('token', cfg.token);
        if (endpoint !== '/list' && !endpoint.startsWith('/callback/')) {
            url.searchParams.set('nukiId', cfg.id);
            url.searchParams.set('deviceType', s.deviceType);
        }
        if (action !== undefined && !simple)
            url.searchParams.set('action', action);
        for (const [key, value] of Object.entries(query || {}))
            url.searchParams.set(key, value);
        // Wait for the bridge's result; noWait=1 only acknowledges receipt.
    }
    return new Promise((resolve, reject) => {
        let timer;
        const fail = (message) => reject(new Error(message));
        const req = (url.protocol === 'https:' ? https : http).request(
            url,
            {
                method:
                    cfg.mode === 'web' && action !== undefined ? 'POST' : 'GET',
                headers,
            },
            (res) => {
                const code = res.statusCode;
                if (code === 429) {
                    const retry = res.headers['retry-after'];
                    const seconds = /^\d+$/u.test(retry || '')
                        ? Number(retry)
                        : (Date.parse(retry) - Date.now()) / 1000;
                    s.retryAt =
                        Date.now() +
                        Math.min(3600, Math.max(60, seconds || 60)) * 1000;
                }
                if (code < 200 || code >= 300) {
                    res.resume();
                    fail(`Nuki: HTTP ${code}`);
                    return;
                }
                const chunks = [];
                let size = 0;
                res.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > 256 * 1024) {
                        fail('Nuki: ungültige API-Antwort');
                        req.destroy();
                    } else chunks.push(chunk);
                });
                res.on('error', () =>
                    fail(
                        'Nuki: Verbindung fehlgeschlagen oder Zeitüberschreitung',
                    ),
                );
                res.on('end', () => {
                    if (code === 204 && action !== undefined) {
                        resolve(null);
                        return;
                    }
                    try {
                        resolve(
                            JSON.parse(Buffer.concat(chunks).toString('utf8')),
                        );
                    } catch {
                        fail('Nuki: ungültige API-Antwort');
                    }
                });
            },
        );
        s.requests.add(req);
        timer = setTimeout(() => req.destroy(), 20000);
        timer.unref?.();
        req.on('close', () => {
            clearTimeout(timer);
            s.requests.delete(req);
            fail('Nuki: Verbindung fehlgeschlagen oder Zeitüberschreitung');
        });
        req.on('error', () =>
            fail('Nuki: Verbindung fehlgeschlagen oder Zeitüberschreitung'),
        );
        req.end(body);
    });
}
// A single listener serves all bridge sessions on a port. The unguessable, stable
// path allows reuse after a restart without putting API credentials in the URL.
function receiveCallback(listener, req, res) {
    const session = [...listener.sessions].find(
        (item) => item.path === req.url,
    );
    if (!session || req.method !== 'POST') {
        res.writeHead(session ? 405 : 404).end();
        req.resume();
        return;
    }
    const chunks = [];
    let size = 0;
    req.on('error', () => {});
    req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024) {
            if (!res.headersSent) res.writeHead(413).end();
        } else chunks.push(chunk);
    });
    req.on('end', () => {
        if (size > 16 * 1024) return;
        let payload;
        try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (
                !payload ||
                Array.isArray(payload) ||
                typeof payload !== 'object' ||
                !Number.isSafeInteger(payload.nukiId) ||
                number(payload.state, 0, 255) === undefined
            ) {
                throw new Error();
            }
        } catch {
            res.writeHead(400).end();
            return;
        }
        const members = [...session.members].filter(
            (s) => s.active() && s.cfg.id === payload.nukiId,
        );
        // Older bridges omit deviceType. Do not route an ambiguous ID to another type.
        const types = new Set(members.map((s) => s.deviceType));
        for (const s of members) {
            if (
                s.deviceType === undefined ||
                (payload.deviceType === undefined
                    ? types.size !== 1
                    : payload.deviceType !== s.deviceType)
            )
                continue;
            s.epoch++;
            report(s, payload);
        }
        res.writeHead(204).end();
    });
}
function attachCallback(s) {
    const cfg = s.cfg;
    const digest = createHash('sha256')
        .update(
            JSON.stringify([
                cfg.host.toLowerCase(),
                cfg.port,
                cfg.token,
                cfg.callbackHost.toLowerCase(),
                cfg.callbackPort,
            ]),
        )
        .digest('hex');
    const callbackPath = `/nuki/callback/${digest}`;
    const url = `http://${cfg.callbackHost.toLowerCase()}:${cfg.callbackPort}${callbackPath}`;
    if (url.length > 254)
        throw new Error('Nuki: Callback-Adresse oder Port ist ungültig');
    let session = callbackSessions.get(url);
    if (!session) {
        let listener = callbackListeners.get(cfg.callbackPort);
        if (!listener) {
            listener = { sessions: new Set() };
            listener.server = http.createServer((req, res) =>
                receiveCallback(listener, req, res),
            );
            listener.server.requestTimeout = 10000;
            listener.server.headersTimeout = 10000;
            listener.ready = new Promise((resolve, reject) => {
                listener.server.once('error', reject);
                listener.server.listen(cfg.callbackPort, resolve);
            });
            listener.server.unref();
            callbackListeners.set(cfg.callbackPort, listener);
        }
        session = {
            cfg,
            listener,
            path: callbackPath,
            url,
            members: new Set(),
            requests: new Set(),
            retryAt: 0,
        };
        callbackSessions.set(url, session);
        listener.sessions.add(session);
    }
    session.members.add(s);
    s.callbackSession = session;
    return session;
}
function releaseCallback(s) {
    const session = s.callbackSession;
    s.callbackSession = null;
    if (!session) return;
    session.members.delete(s);
    if (session.members.size) return;
    callbackSessions.delete(session.url);
    for (const req of session.requests) req.destroy();
    const listener = session.listener;
    listener.sessions.delete(session);
    if (!listener.sessions.size) {
        callbackListeners.delete(session.cfg.callbackPort);
        listener.server.close();
        listener.server.closeAllConnections?.();
    }
    // Keep the bridge entry so a restart can reuse it without deleting other callbacks.
}
async function ensureCallback(s) {
    const session = s.callbackSession || attachCallback(s);
    if (session.registered) return;
    if (!session.pending) {
        session.pending = (async () => {
            await session.listener.ready;
            if (Date.now() < session.retryAt)
                throw new Error('Nuki: Callback-Einrichtung fehlgeschlagen');
            if (!session.members.size) return;
            const result = await request(session, '/callback/list');
            if (!session.members.size) return;
            if (
                !Array.isArray(result?.callbacks) ||
                result.callbacks.some(
                    (item) =>
                        !Number.isInteger(item?.id) ||
                        item.id < 0 ||
                        typeof item.url !== 'string',
                )
            ) {
                throw new Error('Nuki: ungültige API-Antwort');
            }
            if (!result.callbacks.some((item) => item.url === session.url)) {
                if (result.callbacks.length >= 3) {
                    const removed = await request(session, '/callback/remove', {
                        query: { id: result.callbacks.at(-1).id },
                    });
                    if (!session.members.size) return;
                    if (removed?.success !== true)
                        throw new Error(
                            'Nuki: Callback-Einrichtung fehlgeschlagen',
                        );
                }
                const added = await request(session, '/callback/add', {
                    query: { url: session.url },
                });
                if (added?.success !== true)
                    throw new Error(
                        'Nuki: Callback-Einrichtung fehlgeschlagen',
                    );
            }
            session.registered = true;
        })().finally(() => {
            session.pending = null;
        });
    }
    await session.pending;
}
const stateTexts = {
    0: 'Nicht kalibriert',
    1: 'Abgeschlossen',
    2: 'Wird aufgeschlossen',
    3: 'Aufgeschlossen',
    4: 'Wird abgeschlossen',
    5: 'Falle zurückgezogen',
    6: 'Aufgeschlossen (Lock ’n’ Go)',
    7: 'Falle wird zurückgezogen',
    224: 'Ungültiger Zugangscode',
    225: 'Ungültiger Fingerabdruck',
    254: 'Motor blockiert',
    255: 'Unbekannter Schlosszustand',
};
function report(s, p) {
    if (!p || typeof p !== 'object' || Array.isArray(p))
        throw new Error('Nuki: ungültige API-Antwort');
    const state = number(p.state, 0, 255);
    if (state !== undefined) {
        s.output('state', state);
        s.output('stateText', stateTexts[state] || stateTexts[255]);
        // Clear the previous boolean during movements/errors rather than claiming a settled state.
        s.output(
            'locked',
            state === 1 ? true : [3, 5, 6].includes(state) ? false : null,
        );
    }
    for (const key of [
        'batteryCritical',
        'batteryCharging',
        'keypadBatteryCritical',
        'doorsensorBatteryCritical',
    ]) {
        const value = boolean(p[key]);
        if (value !== undefined) s.output(key, value);
    }
    const charge = number(p.batteryChargeState ?? p.batteryCharge, 0, 100);
    if (charge !== undefined) s.output('batteryCharge', charge);
    const door = number(p.doorsensorState ?? p.doorState, 0, 255);
    if (door !== undefined) {
        s.output('doorState', door);
        s.output('doorClosed', door === 2 ? true : door === 3 ? false : null);
    }
    return state !== undefined;
}
function deviceType(s, value) {
    if (![0, 3, 4, 5].includes(value))
        throw new Error('Nuki: nicht unterstützter Gerätetyp');
    s.deviceType = value;
    s.output('deviceType', value);
}
async function read(s, direct = false) {
    if (!s.active() || s.reading || s.busy || Date.now() < s.retryAt) return;
    s.reading = true;
    const epoch = s.epoch;
    try {
        if (s.cfg.mode === 'bridge' && s.cfg.callback) {
            let host;
            try {
                host = callbackAddress(s.context);
            } catch (error) {
                releaseCallback(s);
                throw error;
            }
            if (host !== s.cfg.callbackHost) {
                releaseCallback(s);
                s.cfg = { ...s.cfg, callbackHost: host };
            }
        }
        let p,
            available = true;
        if (s.cfg.mode === 'web') {
            const result = await request(s, '');
            if (!s.active() || epoch !== s.epoch) return;
            if (result?.smartlockId !== s.cfg.id)
                throw new Error('Nuki: ungültige API-Antwort');
            deviceType(s, result.type);
            available = result.serverState === 0;
            p = result.state;
        } else {
            const list = await request(s, '/list');
            if (!s.active() || epoch !== s.epoch) return;
            if (!Array.isArray(list))
                throw new Error('Nuki: ungültige API-Antwort');
            const matches = list.filter(
                (item) =>
                    item?.nukiId === s.cfg.id &&
                    (s.cfg.deviceType === 'auto' ||
                        item.deviceType === s.cfg.deviceType),
            );
            if (matches.length !== 1)
                throw new Error(
                    'Nuki: Gerät nicht eindeutig gefunden; ID und Gerätetyp prüfen',
                );
            deviceType(s, matches[0].deviceType);
            p = matches[0].lastKnownState;
            if (direct) {
                p = await request(s, '/lockState');
                if (!s.active() || epoch !== s.epoch) return;
                if (p?.success !== true)
                    throw new Error('Nuki: Statusabfrage abgelehnt');
            }
        }
        if (!report(s, p)) throw new Error('Nuki: ungültige API-Antwort');
        s.ready = available;
        s.output('connected', true);
        s.output('available', available);
        s.context.setNodeStatus?.(available);
        if (!available) s.fail('Nuki: Schloss nicht erreichbar');
        else s.output('error', '');
        if (s.cfg.mode === 'bridge' && s.cfg.callback) {
            try {
                await ensureCallback(s);
            } catch {
                s.fail('Nuki: Callback-Einrichtung fehlgeschlagen');
            }
        }
    } catch (err) {
        if (!s.active() || epoch !== s.epoch) return;
        s.ready = false;
        s.output('connected', false);
        s.output('available', false);
        s.context.setNodeStatus?.(false);
        s.fail(err.message);
    } finally {
        s.reading = false;
    }
}
function finish(s) {
    clearTimeout(s.commandTimer);
    s.busy = false;
    s.output('busy', false);
}
async function command(s, action) {
    if (s.busy) {
        s.fail('Nuki: Befehl läuft bereits; neues Telegramm verworfen');
        return;
    }
    if (!s.ready || Date.now() < s.retryAt) {
        s.fail('Nuki: nicht bereit; Befehl wurde nicht gesendet');
        return;
    }
    s.busy = true;
    s.epoch++;
    s.output('busy', true);
    s.output('commandAccepted', false);
    s.output('error', '');
    if (s.cfg.mode === 'mqtt') {
        const session = s.session;
        const epoch = s.epoch;
        s.commandTimer = setTimeout(() => {
            if (!s.active() || session !== s.session) return;
            finish(s);
            s.fail(
                'Nuki: Befehlsausgang unklar; Schlosszustand vor erneutem Senden prüfen',
            );
        }, 30000);
        s.commandTimer.unref?.();
        // QoS 0 deliberately prevents MQTT.js from replaying an in-flight unlock on reconnect.
        s.client.publish(
            `${s.cfg.topic}/${action === 'unlock' ? 'unlock' : 'lockAction'}`,
            action === 'unlock' ? 'true' : String(action),
            { qos: 0, retain: false },
            (err) => {
                if (
                    !s.active() ||
                    session !== s.session ||
                    epoch !== s.epoch ||
                    !s.busy
                )
                    return;
                if (err) {
                    finish(s);
                    s.fail(
                        'Nuki: Befehlsausgang unklar; Schlosszustand vor erneutem Senden prüfen',
                    );
                } else s.output('commandAccepted', true);
            },
        );
        return;
    }
    try {
        const simple = action === 'unlock';
        const endpoint =
            s.cfg.mode === 'web'
                ? simple
                    ? '/action/unlock'
                    : '/action'
                : simple
                  ? '/unlock'
                  : '/lockAction';
        const result = await request(s, endpoint, { action, simple });
        if (!s.active()) return;
        if (
            result?.success === false ||
            (s.cfg.mode === 'bridge' && result?.success !== true)
        )
            throw new Error('Nuki: Befehl abgelehnt');
        // Web HTTP 204 only means accepted. Only report actual state from subsequent GETs.
        s.output('commandAccepted', true);
    } catch (err) {
        if (!s.active()) return;
        s.fail(err.message);
        s.context.warn(
            'Nuki: Befehlsausgang unklar; Schlosszustand vor erneutem Senden prüfen',
        );
    } finally {
        if (s.active()) {
            finish(s);
            for (const delay of [2000, 10000])
                later(s, () => read(s, true), delay);
        }
    }
}
function startMqtt(s) {
    const cfg = s.cfg;
    const library = getMqtt();
    s.client = library.connect({
        protocol: cfg.tls ? 'mqtts' : 'mqtt',
        host: cfg.host.replace(/^\[|\]$/gu, ''),
        port: cfg.port,
        username: cfg.username || undefined,
        password: cfg.password || undefined,
        rejectUnauthorized: true,
        protocolVersion: 4,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
        resubscribe: false,
        queueQoSZero: false,
    });
    const disconnected = () => {
        if (!s.active()) return;
        s.session++;
        s.ready = false;
        s.subscribed = false;
        s.online = false;
        s.hasState = false;
        s.deviceType = undefined;
        finish(s);
        s.output('connected', false);
        s.output('available', false);
        s.context.setNodeStatus?.(false);
    };
    const ready = () => {
        s.ready =
            s.subscribed &&
            s.online &&
            s.hasState &&
            [0, 3, 4, 5].includes(s.deviceType);
        s.output('available', s.ready);
        s.context.setNodeStatus?.(s.ready);
    };
    s.client.on('connect', () => {
        if (!s.active()) return;
        disconnected();
        s.receiving = true;
        const session = s.session;
        s.client.subscribe(`${cfg.topic}/+`, { qos: 0 }, (err, granted) => {
            if (!s.active() || session !== s.session) return;
            if (
                err ||
                !granted?.length ||
                granted.some((item) => item.qos > 2)
            ) {
                s.receiving = false;
                s.fail('Nuki: MQTT-Abonnement fehlgeschlagen');
                return;
            }
            s.subscribed = true;
            s.output('connected', true);
            s.output('error', '');
            ready();
        });
    });
    s.client.on('close', () => {
        if (s.busy && s.active())
            s.fail(
                'Nuki: Befehlsausgang unklar; Schlosszustand vor erneutem Senden prüfen',
            );
        s.receiving = false;
        disconnected();
    });
    s.client.on('error', () =>
        s.fail(
            'Nuki: MQTT-Verbindung fehlgeschlagen; Broker und Zugangsdaten prüfen',
        ),
    );
    s.client.on('message', (topic, payload, packet) => {
        if (!s.active() || !s.receiving || !topic.startsWith(`${cfg.topic}/`))
            return;
        if (payload.length > 256) {
            s.fail('Nuki: ungültige MQTT-Nachricht');
            return;
        }
        const key = topic.slice(cfg.topic.length + 1);
        const value = payload.toString('utf8').trim();
        if (key === 'connected') {
            const connected = boolean(value);
            if (connected === undefined) {
                s.fail('Nuki: ungültige MQTT-Nachricht');
                return;
            }
            s.online = connected;
            if (!connected && s.busy) {
                finish(s);
                s.fail(
                    'Nuki: Befehlsausgang unklar; Schlosszustand vor erneutem Senden prüfen',
                );
            }
        } else if (key === 'deviceType') {
            try {
                deviceType(s, number(value, 0, 5));
            } catch (err) {
                s.deviceType = undefined;
                s.fail(err.message);
            }
        } else if (key === 'commandResponse') {
            const code = number(value, 0, 255);
            // Retained replies belong to an earlier session, never to a new command.
            if (code !== undefined && !packet?.retain && s.busy) {
                s.output('commandResult', code);
                finish(s);
                if (code !== 0) s.fail('Nuki: Befehl abgelehnt');
            }
        } else if (
            ['state', 'batteryChargeState', 'doorsensorState'].includes(key)
        ) {
            const n = number(
                value,
                0,
                key === 'batteryChargeState' ? 100 : 255,
            );
            if (n === undefined) {
                s.fail('Nuki: ungültige MQTT-Nachricht');
                return;
            }
            report(s, { [key]: n });
            if (key === 'state') s.hasState = true;
        } else if (
            [
                'batteryCritical',
                'batteryCharging',
                'keypadBatteryCritical',
                'doorsensorBatteryCritical',
            ].includes(key)
        ) {
            const b = boolean(value);
            if (b === undefined) {
                s.fail('Nuki: ungültige MQTT-Nachricht');
                return;
            }
            report(s, { [key]: b });
        } else return;
        ready();
    });
}
function start(id, cfg, context) {
    const s = {
        cfg,
        context,
        timers: new Set(),
        requests: new Set(),
        values: new Map(),
        epoch: 0,
        session: 0,
        retryAt: 0,
        busy: false,
        ready: false,
    };
    states.set(id, s);
    s.active = () => states.get(id) === s;
    s.output = (handle, value) => {
        if (
            !s.active() ||
            (s.values.has(handle) && s.values.get(handle) === value)
        )
            return;
        s.values.set(handle, value);
        s.context.emitOutput(handle, value);
    };
    s.fail = (message) => {
        if (!s.active()) return;
        s.output('error', message);
        s.context.warn(message);
    };
    s.output('locked', null);
    s.output('doorClosed', null);
    s.output('connected', false);
    s.output('available', false);
    s.output('busy', false);
    s.output('commandAccepted', false);
    s.output('error', '');
    context.setNodeStatus?.(false);
    if (cfg.mode === 'mqtt') startMqtt(s);
    else {
        read(s);
        if (cfg.interval > 0) {
            s.poll = setInterval(() => read(s), cfg.interval * 1000);
            s.poll.unref?.();
        }
    }
    return s;
}
module.exports = {
    type: 'nuki',
    label: 'Nuki',
    category: 'Geräte',
    color: '#f97316',
    description:
        'Nuki Smart Locks über lokale Bridge, MQTT oder Nuki Web steuern und überwachen.',
    inputs: [
        { handle: 'unlock', label: 'Aufschließen' },
        { handle: 'lock', label: 'Abschließen' },
        { handle: 'unlatch', label: 'Falle zurückziehen' },
        { handle: 'deviceUnlock', label: 'Öffnen gemäß Nuki-Konfiguration' },
        { handle: 'locked', label: 'Sollzustand (1 = abgeschlossen)' },
        { handle: 'refresh', label: 'Status abfragen' },
        { handle: 'reconnect', label: 'Neu verbinden' },
    ],
    outputs: [
        { handle: 'state', label: 'Schlosszustand (Code)' },
        { handle: 'stateText', label: 'Schlosszustand (Text)' },
        { handle: 'locked', label: 'Abgeschlossen (1/0/null)' },
        { handle: 'batteryCritical', label: 'Schlossbatterie kritisch' },
        { handle: 'batteryCharge', label: 'Schlossbatterie (%)' },
        { handle: 'batteryCharging', label: 'Schlossbatterie lädt' },
        { handle: 'keypadBatteryCritical', label: 'Keypad-Batterie kritisch' },
        {
            handle: 'doorsensorBatteryCritical',
            label: 'Türsensor-Batterie kritisch',
        },
        { handle: 'doorState', label: 'Türsensorzustand (Code)' },
        { handle: 'doorClosed', label: 'Tür geschlossen (1/0/null)' },
        { handle: 'deviceType', label: 'Nuki-Gerätetyp (Code)' },
        { handle: 'connected', label: 'API / Broker verbunden' },
        { handle: 'available', label: 'Schloss zur Steuerung bereit' },
        { handle: 'busy', label: 'Befehl läuft' },
        {
            handle: 'commandAccepted',
            label: 'Befehl übertragen (keine Zustandsbestätigung)',
        },
        { handle: 'commandResult', label: 'MQTT-Befehlsergebnis (Code)' },
        { handle: 'error', label: 'Fehler' },
    ],
    config: [
        {
            key: 'mode',
            label: 'Nuki-Verbindung',
            type: 'select',
            default: 'bridge',
            options: [
                { value: 'bridge', label: 'Lokale Nuki Bridge' },
                { value: 'mqtt', label: 'Lokales MQTT' },
                { value: 'web', label: 'Nuki Web (Cloud)' },
            ],
        },
        {
            key: 'deviceId',
            label: 'Nuki-ID (HTTP: dezimal/0x; MQTT: hex, exakt wie Topic)',
            type: 'text',
        },
        {
            key: 'host',
            visibleWhen: { mode: ['bridge', 'mqtt'] },
            label: 'Bridge / MQTT-Broker (Hostname oder IP)',
            type: 'text',
        },
        {
            key: 'port',
            visibleWhen: { mode: ['bridge', 'mqtt'] },
            label: 'Port (0 = Standard der Verbindungsart)',
            type: 'number',
            default: 0,
        },
        {
            key: 'token',
            visibleWhen: { mode: ['bridge', 'web'] },
            label: 'Bridge- oder Nuki-Web-API-Token',
            type: 'password',
        },
        {
            key: 'deviceType',
            visibleWhen: { mode: ['bridge'] },
            label: 'Bridge-Gerätetyp',
            type: 'select',
            default: 'auto',
            options: [
                { value: 'auto', label: 'Automatisch erkennen' },
                { value: '0', label: 'Smart Lock 1 / 2' },
                { value: '4', label: 'Smart Lock 3 / 4' },
                { value: '5', label: 'Smart Lock 5 / Go / Pro / Ultra' },
                { value: '3', label: 'Smart Door' },
            ],
        },
        {
            key: 'callback',
            visibleWhen: { mode: ['bridge'] },
            label: 'Bridge-Callback automatisch einrichten',
            type: 'checkbox',
            default: false,
        },
        {
            key: 'callbackPort',
            visibleWhen: { mode: ['bridge'], callback: [true, 1, '1', 'true'] },
            label: 'Callback: lokaler Empfangsport',
            type: 'number',
            default: 8099,
        },
        {
            key: 'username',
            visibleWhen: { mode: ['mqtt'] },
            label: 'MQTT-Benutzername',
            type: 'text',
        },
        {
            key: 'password',
            visibleWhen: { mode: ['mqtt'] },
            label: 'MQTT-Passwort',
            type: 'password',
        },
        {
            key: 'mqttTLS',
            visibleWhen: { mode: ['mqtt'] },
            label: 'MQTT mit TLS (Broker-Zertifikat prüfen)',
            type: 'checkbox',
            default: false,
        },
        {
            key: 'interval',
            visibleWhen: { mode: ['bridge', 'web'] },
            label: 'HTTP-Statusintervall (s, 0 = manuell)',
            type: 'number',
            default: 60,
        },
    ],
    execute(inputs, data, context) {
        const id = context.nodeId;
        let s = states.get(id);
        try {
            const cfg = options(data, context);
            const restart =
                context.triggerHandle === 'reconnect' && on(inputs.reconnect);
            if (
                !s ||
                JSON.stringify(cfg) !== JSON.stringify(s.cfg) ||
                restart
            ) {
                close(id);
                s = start(id, cfg, context);
            }
            s.context = context;
            const handle = context.triggerHandle;
            // Only the actual telegram may act; ignore all cached input values at startup/reconnect.
            let action;
            if (handle === 'locked') {
                const value = boolean(inputs.locked);
                if (value === undefined) {
                    s.fail('Nuki: Sollzustand muss 0 oder 1 sein');
                    return {};
                }
                action = value ? 2 : 1;
            } else if (on(inputs[handle])) {
                action = {
                    unlock: 1,
                    lock: 2,
                    unlatch: 3,
                    deviceUnlock: 'unlock',
                }[handle];
                if (handle === 'refresh' && cfg.mode !== 'mqtt') read(s, true);
            }
            if (action !== undefined)
                command(s, action).catch(() => {
                    if (!s.active()) return;
                    finish(s);
                    s.fail(
                        'Nuki: Befehlsausgang unklar; Schlosszustand vor erneutem Senden prüfen',
                    );
                });
        } catch (err) {
            close(id);
            context.setNodeStatus?.(false);
            context.emitOutput('connected', false);
            context.emitOutput('available', false);
            context.emitOutput('busy', false);
            context.emitOutput('commandAccepted', false);
            context.emitOutput(
                'error',
                err.message.startsWith('Nuki:')
                    ? err.message
                    : 'Nuki: Verbindung konnte nicht gestartet werden',
            );
            context.warn('Nuki: Verbindung konnte nicht gestartet werden');
        }
        return {};
    },
    dispose(nodeId) {
        if (nodeId != null) close(nodeId);
        else for (const id of states.keys()) close(id);
    },
};
