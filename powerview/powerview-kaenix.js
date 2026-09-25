/**
 * @plugin    PowerView
 * @version   1.0.4
 * @author    Christian Brauwers
 * @website   https://www.kaenix.net
 * Protocol reference: https://github.com/sander76/aio-powerview-api
 */
'use strict';
const http = require('http');
const states = new Map();
const commands = [
    'upDown',
    'open',
    'close',
    'stop',
    'position',
    'slats',
    'scene',
    'triggerStatus',
];
const configKeys = ['ip', 'port', 'deviceName', 'deviceId', 'interval'];
const bit = (v) =>
    [0, '0', false].includes(v)
        ? 0
        : [1, '1', true].includes(v)
          ? 1
          : undefined;
const numeric = (v) =>
    v !== null &&
    v !== undefined &&
    v !== '' &&
    typeof v !== 'boolean' &&
    Number.isFinite(Number(v));
const pct = (v) =>
    numeric(v) && Number(v) >= 0 && Number(v) <= 100 ? Number(v) : undefined;
function emit(s, key, value) {
    if (!s.disposed && value !== undefined && s.outputs[key] !== value) {
        s.outputs[key] = value;
        s.context.emitOutput(key, value);
    }
}
function connected(s, value) {
    if (s.disposed) return;
    emit(s, 'connected', value);
    s.context.setNodeStatus?.(!!value);
}
function request(s, method, path, body) {
    return new Promise((resolve, reject) => {
        if (s.disposed) return reject(new Error('Node gestoppt'));
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(
            {
                hostname: s.cfg.ip,
                port: s.cfg.port,
                path,
                method,
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json',
                    ...(payload
                        ? { 'Content-Length': Buffer.byteLength(payload) }
                        : {}),
                },
            },
            (res) => {
                let raw = '';
                res.on('error', reject);
                res.on('aborted', () =>
                    reject(new Error('PowerView-Antwort abgebrochen')),
                );
                res.on('data', (chunk) => {
                    raw += chunk;
                    if (raw.length > 4 * 1024 * 1024)
                        req.destroy(new Error('Antwort zu groß'));
                });
                res.on('end', () => {
                    if (
                        res.statusCode < 200 ||
                        res.statusCode >= 300 ||
                        res.statusCode === 204
                    ) {
                        const error = new Error(
                            `PowerView HTTP ${res.statusCode}${[204, 423].includes(res.statusCode) ? ' – Hub in Wartung' : ''}`,
                        );
                        error.status = res.statusCode;
                        return reject(error);
                    }
                    try {
                        resolve(raw ? JSON.parse(raw) : null);
                    } catch {
                        const error = new Error(
                            'Ungültige PowerView-JSON-Antwort',
                        );
                        error.invalidJSON = true;
                        reject(error);
                    }
                });
            },
        );
        s.requests.add(req);
        req.on('close', () => s.requests.delete(req));
        req.on('error', reject);
        req.on('timeout', () =>
            req.destroy(new Error('PowerView Zeitüberschreitung')),
        );
        req.end(payload);
    });
}
async function detect(s) {
    if (s.version) return;
    if (s.cfg.apiVersion !== 'auto') {
        s.version = Number(s.cfg.apiVersion);
        return;
    }
    try {
        const raw = await request(s, 'GET', '/api/fwversion');
        const fw = (raw?.userData || raw?.config || raw)?.firmware
            ?.mainProcessor;
        if (fw && numeric(fw.revision)) {
            s.version =
                Number(fw.revision) >= 3 ? 3 : Number(fw.revision) >= 2 ? 2 : 1;
            return;
        }
    } catch (error) {
        // Do not mistake outages, authentication or maintenance for another generation.
        if (![404, 405].includes(error.status) && !error.invalidJSON)
            throw error;
    }
    const gateway = await request(s, 'GET', '/gateway/info');
    if (!gateway || (!gateway.fwVersion && !gateway.firmware))
        throw new Error(
            'PowerView-API nicht erkannt; API-Version manuell auswählen',
        );
    s.version = 3;
}
const base = (s) => (s.version === 3 ? '/home' : '/api');
function list(raw, key, version) {
    const result = version === 3 ? raw : raw?.[key];
    if (!Array.isArray(result)) throw new Error('Ungültige PowerView-Liste');
    return result;
}
function name(item) {
    return (
        item.ptName ||
        item.name_unicode ||
        (item.name ? Buffer.from(item.name, 'base64').toString('utf8') : '')
    );
}
function select(items, id, label, kind) {
    const matches = items.filter((d) =>
        id !== '' ? String(d.id) === String(id) : name(d) === label,
    );
    if (matches.length !== 1)
        throw new Error(
            `${kind} ${matches.length ? 'nicht eindeutig – ID verwenden' : 'nicht gefunden'}`,
        );
    return matches[0];
}
function capability(d) {
    // Legacy hubs use shade type IDs; Gen 3 exposes a capability code.
    if (Number(d.type) === 44) return 1;
    if (Number.isInteger(d.capabilities)) return d.capabilities;
    const groups = [
        [0, [1, 4, 5, 6, 10, 19, 31, 32, 42, 49, 52, 53, 57, 84]],
        [1, [18, 23, 43, 72]],
        [2, [51, 62]],
        [3, [26, 27, 28, 69, 70, 71]],
        [4, [54, 55, 56]],
        [5, [40, 66]],
        [6, [7]],
        [7, [8, 9, 33, 47]],
        [8, [65, 79]],
        [9, [38]],
    ];
    return groups.find(([, types]) => types.includes(Number(d.type)))?.[0];
}
function axes(s, d) {
    const p = d.positions || {};
    if (s.version === 3) return p;
    const result = {};
    for (const i of [1, 2]) {
        const key = { 1: 'primary', 2: 'secondary', 3: 'tilt' }[
            p[`posKind${i}`]
        ];
        if (key && numeric(p[`position${i}`]))
            result[key] = Number(p[`position${i}`]) / 65535;
    }
    return result;
}
function tiltMax(s, d) {
    return s.version < 3 &&
        [1, 9].includes(capability(d)) &&
        Number(d.type) !== 44
        ? 0.5
        : 1;
}
const parsePercentValue = (v) => {
    if (v === null || v === undefined || typeof v === 'boolean') return undefined;
    const clean = String(v).replace('%', '').trim();
    if (clean === '') return undefined;
    const n = Number(clean);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
};
function parseBattery(s, d) {
    if (!d || typeof d !== 'object') return { battery: undefined, warning: undefined };

    // Explicit hardwired power supply (1 = hardwired, 12 = fixed hardwired)
    const powerSource = s.version === 3 ? d.powerType : d.batteryKind;
    if (powerSource === 1 || powerSource === 12) {
        return { battery: undefined, warning: undefined };
    }

    let batPct = undefined;
    let batWarn = undefined;

    // 1. Check nested battery object or direct battery value
    const bat = d.battery;
    if (bat && typeof bat === 'object') {
        for (const k of ['percentage', 'percent', 'level', 'charge', 'value']) {
            const parsed = parsePercentValue(bat[k]);
            if (parsed !== undefined) {
                batPct = parsed;
                break;
            }
        }
        const statusStr = String(bat.status ?? '').toLowerCase();
        if (['low', 'critical', 'warning', 'replace', '1'].includes(statusStr)) {
            batWarn = 1;
        }
    } else {
        const parsed = parsePercentValue(bat);
        if (parsed !== undefined) batPct = parsed;
    }

    // 2. Check root attributes (Gen 2/3 variants)
    if (batPct === undefined) {
        for (const k of ['batteryPercentage', 'batteryPercent', 'battery_percent', 'batteryLevel', 'battery_level']) {
            const parsed = parsePercentValue(d[k]);
            if (parsed !== undefined) {
                batPct = parsed;
                break;
            }
        }
    }

    // 3. Check batteryStrength (raw voltage, tenths of a volt, max typically 180-200)
    if (batPct === undefined && numeric(d.batteryStrength) && Number(d.batteryStrength) >= 0) {
        const rawStrength = Number(d.batteryStrength);
        if (rawStrength > 100 || s.version < 3) {
            batPct = Math.min(100, Math.round((rawStrength / 180) * 100));
        } else {
            batPct = Math.min(100, Math.round(rawStrength));
        }
    }

    // 4. Fallback via batteryStatus (0: 0%, 1: 20%, 2: 50%, 3/4: 100%)
    if (d.batteryStatus !== undefined && d.batteryStatus !== null && d.batteryStatus !== '') {
        const st = Number(d.batteryStatus);
        if (st === 1) {
            batWarn = 1;
            if (batPct === undefined) batPct = 20;
        } else if (st === 0) {
            batWarn = 1;
            if (batPct === undefined) batPct = 0;
        } else if (st === 2) {
            if (batPct === undefined) batPct = 50;
        } else if (st === 3 || st === 4) {
            if (batPct === undefined) batPct = 100;
        } else if (['low', 'critical', 'warning'].includes(String(d.batteryStatus).toLowerCase())) {
            batWarn = 1;
        }
    }

    if (batPct !== undefined) {
        // If delivered as decimal fraction between 0.0 and 1.0 (and not 0)
        if (batPct > 0 && batPct <= 1.0 && !numeric(d.batteryStrength)) {
            batPct = batPct * 100;
        }
        batPct = Math.max(0, Math.min(100, Math.round(batPct)));
        if (batWarn === undefined) {
            batWarn = batPct <= 20 ? 1 : 0;
        }
    }

    if (batWarn === undefined && (d.batteryStatus !== undefined || batPct !== undefined)) {
        batWarn = 0;
    }

    return { battery: batPct, warning: batWarn };
}
function report(s, d) {
    const p = axes(s, d),
        cap = capability(d);
    if (cap !== 5 && numeric(p.primary)) {
        const value = pct(Number(p.primary) * 100);
        if (value !== undefined)
            emit(s, 'position', Math.round(cap === 6 ? value : 100 - value));
    }
    const tilt = cap === 5 ? (p.tilt ?? p.primary) : p.tilt;
    if ([1, 2, 4, 5, 9, 10].includes(cap) && numeric(tilt)) {
        const value = pct((Number(tilt) / tiltMax(s, d)) * 100);
        if (value !== undefined) emit(s, 'slats', Math.round(value));
    }
    const { battery, warning } = parseBattery(s, d);
    if (battery !== undefined) emit(s, 'battery', battery);
    if (warning !== undefined) emit(s, 'batteryWarning', warning);
    // Only explicit feedback is a measured motion state. positions.velocity is a
    // configured speed, and motion can be a command: neither proves motor activity.
    const moving = bit(d.isMoving);
    if (moving !== undefined) {
        clearTimeout(s.motionTimer);
        emit(s, 'moving', moving);
    }
}
async function refresh(s, force = false) {
    await detect(s);
    if (!s.cfg.deviceId && !s.cfg.deviceName) {
        list(
            await request(s, 'GET', base(s) + '/shades'),
            'shadeData',
            s.version,
        );
        connected(s, 1);
        return;
    }
    if (!s.device) {
        const devices = list(
            await request(s, 'GET', base(s) + '/shades'),
            'shadeData',
            s.version,
        );
        s.device = select(devices, s.cfg.deviceId, s.cfg.deviceName, 'Gerät');
    }
    const raw = await request(
        s,
        'GET',
        `${base(s)}/shades/${encodeURIComponent(s.device.id)}${force ? '?refresh=true' : ''}`,
    );
    const d = s.version === 3 ? raw : raw?.shade;
    if (!d || String(d.id) !== String(s.device.id))
        throw new Error('Ungültiger PowerView-Gerätestatus');
    if (s.disposed) return;
    s.device = d;
    connected(s, 1);
    report(s, d);
}
function estimateMotion(s, moving) {
    if (!s.cfg.travelSeconds) return;
    clearTimeout(s.motionTimer);
    emit(s, 'moving', moving);
    if (moving) {
        s.motionTimer = setTimeout(
            () => emit(s, 'moving', 0),
            s.cfg.travelSeconds * 1000,
        );
        s.motionTimer.unref?.();
    }
}
function encodePositions(version, targets) {
    if (version === 3) return targets;
    const positions = {};
    Object.entries(targets).forEach(([axis, target], index) => {
        positions[`posKind${index + 1}`] = {
            primary: 1,
            secondary: 2,
            tilt: 3,
        }[axis];
        positions[`position${index + 1}`] = Math.round(target * 65535);
    });
    return positions;
}
async function command(s, handle, value) {
    await detect(s);
    if (handle === 'scene') {
        const selector = String(value ?? '').trim();
        if (!selector) throw new Error('Szenen-ID oder Name fehlt');
        const scenes = list(
            await request(s, 'GET', base(s) + '/scenes'),
            'sceneData',
            s.version,
        );
        const byId = scenes.filter((d) => String(d.id) === selector);
        const scene =
            byId.length === 1 ? byId[0] : select(scenes, '', selector, 'Szene');
        await request(
            s,
            s.version === 3 ? 'PUT' : 'GET',
            s.version === 3
                ? `/home/scenes/${encodeURIComponent(scene.id)}/activate`
                : `/api/scenes?sceneId=${encodeURIComponent(scene.id)}`,
        );
        // A scene may affect other shades; do not claim this node's motor is moving.
        await refresh(s);
        return;
    }
    if (!s.cfg.deviceId && !s.cfg.deviceName)
        throw new Error('Gerätename oder Geräte-ID fehlt');
    if (!s.device) await refresh(s);
    const d = s.device,
        id = encodeURIComponent(d.id),
        cap = capability(d);
    if (handle === 'stop') {
        if (s.version === 1)
            throw new Error('Stop wird von PowerView Gen 1 nicht unterstützt');
        await request(
            s,
            'PUT',
            s.version === 3
                ? `/home/shades/stop?ids=${id}`
                : `/api/shades/${id}`,
            s.version === 3 ? undefined : { shade: { motion: 'stop' } },
        );
        estimateMotion(s, 0);
    } else {
        const p = axes(s, d);
        const tilt = handle === 'slats';
        if (tilt && ![1, 2, 4, 5, 9, 10].includes(cap))
            throw new Error(
                'Gerät unterstützt keine bekannte Lamellensteuerung',
            );
        if (!tilt && cap === 5)
            throw new Error('Gerät unterstützt nur Lamellensteuerung');
        if (handle === 'upDown' && bit(value) === undefined)
            throw new Error('Auf/Ab erwartet 0 oder 1');
        const position =
            handle === 'open'
                ? 0
                : handle === 'close'
                  ? 100
                  : handle === 'upDown'
                    ? bit(value) * 100
                    : pct(value);
        if (position === undefined)
            throw new Error('Position muss zwischen 0 und 100 % liegen');
        const axis = tilt ? 'tilt' : 'primary';
        const target = tilt
            ? (position / 100) * tiltMax(s, d)
            : (cap === 6 ? position : 100 - position) / 100;
        if (
            tilt &&
            [1, 9, 10].includes(cap) &&
            (!numeric(p.primary) || Number(p.primary) > 0.001)
        )
            throw new Error(
                'Lamellen können bei diesem Gerät erst im geschlossenen Zustand verstellt werden',
            );
        if (
            tilt &&
            [9, 10].includes(cap) &&
            (!numeric(p.secondary) || Number(p.secondary) < 0.999)
        ) {
            throw new Error(
                'Lamellen benötigen bei Duolite einen geöffneten hinteren Behang',
            );
        }
        const targets = { [axis]: target };
        const travelCommand = ['open', 'close', 'upDown'].includes(handle);
        if (travelCommand && cap === 7) targets.secondary = 0;
        if (travelCommand && [8, 9, 10, 11].includes(cap) && position === 100) {
            delete targets.primary;
            targets.secondary = 0;
        }
        if (travelCommand && [2, 4].includes(cap)) {
            targets.tilt = s.version === 3 ? 1 : position === 0 ? 0.5 : 0;
        }
        const positions = encodePositions(s.version, targets);
        await request(
            s,
            'PUT',
            s.version === 3
                ? `/home/shades/positions?ids=${id}`
                : `/api/shades/${id}`,
            s.version === 3
                ? { positions }
                : { shade: { id: d.id, positions } },
        );
        estimateMotion(s, 1);
    }
    await refresh(s);
}
function enqueue(s, work) {
    s.queue = s.queue
        .then(() => (s.disposed ? undefined : work()))
        .catch((error) => {
            if (s.disposed) return;
            // A rejected/unsupported command does not imply a lost network connection.
            if (
                error.status ||
                error.code ||
                /Zeitüberschreitung|Antwort|Gerätestatus/.test(error.message)
            )
                connected(s, 0);
            s.context.warn?.(`PowerView: ${error.message}`);
        });
    return s.queue;
}
function dispose(s) {
    s.disposed = true;
    clearInterval(s.timer);
    clearTimeout(s.motionTimer);
    for (const req of s.requests) req.destroy();
}
module.exports = {
    type: 'powerview',
    category: 'Geräte',
    label: 'PowerView',
    color: '#f97316',
    description:
        'Lokale PowerView-Steuerung Gen 1/2/3. Auf/Ab: 0=Auf, 1=Ab. Position: 0=offen, 100=geschlossen. Öffnen/Schliessen/Status nur bei 1; Stop bei jedem 0/1-Telegramm. Geräte-ID hat Vorrang. Fährt nur bei expliziter Rückmeldung oder aktivierter Laufzeitschätzung; Stop nicht bei Gen 1.',
    inputs: [
        { handle: 'ip', label: 'IP Adresse' },
        { handle: 'port', label: 'Port (Standard 80)' },
        { handle: 'deviceName', label: 'Gerätename' },
        { handle: 'deviceId', label: 'Geräte ID' },
        { handle: 'upDown', label: 'Auf/Ab (0=Auf, 1=Ab)' },
        { handle: 'open', label: 'Öffnen (1)' },
        { handle: 'close', label: 'Schliessen (1)' },
        { handle: 'stop', label: 'Stop (0/1)' },
        { handle: 'position', label: 'Position (0=offen, 100=geschlossen)' },
        { handle: 'slats', label: 'Lamellenwinkel (0–100 %)' },
        { handle: 'scene', label: 'Szene aktivieren (ID oder Name)' },
        { handle: 'triggerStatus', label: 'Status Trigger (1)' },
        { handle: 'interval', label: 'Status Intervall (Sekunden)' },
    ],
    outputs: [
        { handle: 'connected', label: 'Verbindungsstatus (0/1)' },
        { handle: 'position', label: 'Position (0=offen, 100=geschlossen)' },
        { handle: 'slats', label: 'Lamellenwinkel (0–100 %)' },
        { handle: 'battery', label: 'Batterie (0–100 %)' },
        { handle: 'batteryWarning', label: 'Batteriewarnung (0/1)' },
        { handle: 'moving', label: 'Fährt (0/1)' },
    ],
    globalSettings: [
        { key: 'ip', label: 'PowerView Hub IP-Adresse', type: 'text' },
        {
            key: 'port',
            label: 'Port (Standard 80)',
            type: 'number',
            placeholder: '80',
        },
    ],
    config: [
        { key: 'deviceName', label: 'Gerätename', type: 'text' },
        { key: 'deviceId', label: 'Geräte-ID (hat Vorrang)', type: 'text' },
        {
            key: 'apiVersion',
            label: 'PowerView-API',
            type: 'select',
            options: [
                { value: 'auto', label: 'Automatisch' },
                { value: '1', label: 'Gen 1' },
                { value: '2', label: 'Gen 2' },
                { value: '3', label: 'Gen 3' },
            ],
        },
        {
            key: 'interval',
            label: 'Statusintervall in Sekunden (Standard 10, 0=aus)',
            type: 'number',
            placeholder: '10',
        },
        {
            key: 'travelSeconds',
            label: 'Optionale Fahrstatus-Schätzung in Sekunden (0=aus)',
            type: 'number',
            placeholder: '0',
        },
    ],
    execute(inputs, data, context) {
        const id = context.nodeId || 'default';
        let s = states.get(id);
        const previous = s?.inputs || context.initialInputs || {};
        const stored = { ...previous, ...inputs };
        const pick = (key) =>
            stored[key] != null && stored[key] !== ''
                ? stored[key]
                : data[key] != null && data[key] !== ''
                  ? data[key]
                  : context.globalSetting?.(key);
        const cfg = Object.fromEntries(
            configKeys.map((key) => [key, pick(key)]),
        );
        for (const key of ['ip', 'deviceId', 'deviceName'])
            cfg[key] = String(cfg[key] ?? '').trim();
        cfg.port = cfg.port == null || cfg.port === '' ? 80 : Number(cfg.port);
        cfg.interval =
            cfg.interval == null || cfg.interval === ''
                ? 10
                : Number(cfg.interval);
        cfg.apiVersion = ['1', '2', '3'].includes(String(data.apiVersion))
            ? String(data.apiVersion)
            : 'auto';
        cfg.travelSeconds = Math.max(
            0,
            Math.min(600, Number(data.travelSeconds) || 0),
        );
        const changed = !s || JSON.stringify(s.cfg) !== JSON.stringify(cfg);
        if (changed) {
            if (s) dispose(s);
            s = {
                cfg,
                inputs: stored,
                context,
                requests: new Set(),
                outputs: {},
                queue: Promise.resolve(),
                disposed: false,
            };
            states.set(id, s);
        }
        s.context = context;
        s.inputs = stored;
        if (
            !cfg.ip ||
            !Number.isInteger(cfg.port) ||
            cfg.port < 1 ||
            cfg.port > 65535 ||
            !Number.isFinite(cfg.interval) ||
            cfg.interval < 0 ||
            cfg.interval > 86400
        ) {
            connected(s, 0);
            if (changed && cfg.ip)
                context.warn?.('PowerView: Port oder Statusintervall ungültig');
            return {};
        }
        if (changed) {
            connected(s, 0);
            enqueue(s, () => refresh(s));
            if (cfg.interval) {
                s.timer = setInterval(
                    () => {
                        if (s.pollPending) return;
                        s.pollPending = true;
                        enqueue(s, () => refresh(s)).finally(() => {
                            s.pollPending = false;
                        });
                    },
                    Math.max(1, cfg.interval) * 1000,
                );
                s.timer.unref?.();
            }
        }
        const handles =
            context.triggerHandle != null
                ? commands.filter(
                      (h) =>
                          h === context.triggerHandle &&
                          inputs[h] !== undefined,
                  )
                : commands.filter(
                      (h) =>
                          inputs[h] !== undefined && inputs[h] !== previous[h],
                  );
        for (const handle of handles) {
            const value = inputs[handle];
            // KNX/Visu stop telegrams carry the previous direction: both bits stop.
            if (handle === 'stop' && bit(value) === undefined) continue;
            if (
                ['open', 'close', 'triggerStatus'].includes(handle) &&
                bit(value) !== 1
            )
                continue;
            enqueue(s, () =>
                handle === 'triggerStatus'
                    ? refresh(s, true)
                    : command(s, handle, value),
            );
        }
        return {};
    },
    dispose(nodeId) {
        if (nodeId != null) {
            const s = states.get(nodeId);
            if (s) dispose(s);
            states.delete(nodeId);
        } else {
            for (const s of states.values()) dispose(s);
            states.clear();
        }
    },
};
