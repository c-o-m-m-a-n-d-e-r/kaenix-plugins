/**
 * @plugin Danfoss Ally
 * @version 1.0.1
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 * Cloud protocol references (independent implementation):
 * https://developer.danfoss.com/get-started
 * https://github.com/MTrab/pydanfossally/blob/master/docs/openapi-spec
 * https://github.com/MTrab/pydanfossally/blob/master/pydanfossally/const.py
 */
"use strict";
const crypto = require("node:crypto");
const HOST = "https://api.danfoss.com";
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const nodes = new Map();
const accounts = new Map();
const SETPOINTS = {
    manual: "manual_mode_fast",
    at_home: "at_home_setting",
    leaving_home: "leaving_home_setting",
    pause: "pause_setting",
    holiday: "holiday_setting",
    holiday_sat: "at_home_setting",
};

function fault(key) {
    return new Error(`ally_${key}`);
}
function number(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && !value.trim()) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function on(value) {
    return value === true || value === 1 || value === "1";
}
function settings(context, values = {}) {
    const read = (key) => values[key] ?? context.globalSetting(key);
    const clientId = String(read("clientId") ?? "").trim();
    const clientSecret = String(read("clientSecret") ?? "").trim();
    if (!clientId || !clientSecret || clientId.includes(":"))
        throw fault("credentials");
    const raw = read("interval");
    const interval = raw == null || raw === "" ? 300 : number(raw);
    if (
        interval === null ||
        !Number.isInteger(interval) ||
        (interval !== 0 && (interval < 60 || interval > 86400))
    )
        throw fault("interval_invalid");
    return { clientId, clientSecret, interval };
}
function active(node) {
    return nodes.get(node.id) === node && !node.account.abort.signal.aborted;
}
function emit(node, handle, value, force = false) {
    if (!active(node) || (!force && node.outputs[handle] === value)) return;
    node.outputs[handle] = value;
    node.context.emitOutput(handle, value);
}
function fail(node, error) {
    if (!active(node)) return;
    const key = /^ally_[a-z_]+$/.test(error?.message)
        ? error.message
        : "ally_network";
    emit(node, "error", key);
    node.context.warn?.(key);
}
function stopAccount(a) {
    if (a.abort.signal.aborted) return;
    a.abort.abort();
    clearTimeout(a.poll);
    clearTimeout(a.followup);
    clearTimeout(a.idle);
    accounts.delete(a.key);
    a.token = "";
    a.cfg.clientSecret = "";
}
function release(a) {
    if (--a.refs > 0 || a.abort.signal.aborted) return;
    // Retain token and rate-limit state briefly between device-picker requests.
    a.idle = setTimeout(() => stopAccount(a), 300000);
    a.idle.unref?.();
}
function acquire(cfg) {
    const key = crypto
        .createHash("sha256")
        .update(JSON.stringify([cfg.clientId, cfg.clientSecret]))
        .digest("hex");
    let a = accounts.get(key);
    if (!a) {
        a = {
            key,
            cfg: { ...cfg },
            refs: 0,
            nodes: new Set(),
            abort: new AbortController(),
            token: "",
            expires: 0,
            blocked: 0,
            next: 0,
            queued: 0,
            tail: Promise.resolve(),
            devices: new Map(),
            writes: new Set(),
            readAt: 0,
        };
        accounts.set(key, a);
    }
    clearTimeout(a.idle);
    a.refs++;
    a.cfg.interval = cfg.interval;
    return a;
}
function ready(a) {
    if (a.abort.signal.aborted) throw fault("stopped");
    if (a.blocked > Date.now()) throw fault("rate_limit");
}
function wait(a, milliseconds) {
    if (milliseconds <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const cancel = () => {
            clearTimeout(timer);
            reject(fault("stopped"));
        };
        const timer = setTimeout(() => {
            a.abort.signal.removeEventListener("abort", cancel);
            resolve();
        }, milliseconds);
        a.abort.signal.addEventListener("abort", cancel, { once: true });
    });
}
function queue(a, work) {
    try {
        ready(a);
        if (a.queued >= 20) throw fault("busy_error");
    } catch (error) {
        return Promise.reject(error);
    }
    a.queued++;
    const task = a.tail.then(() => {
        ready(a);
        return work();
    });
    a.tail = task.catch(() => {}).finally(() => a.queued--);
    return task;
}
async function http(a, path, options) {
    ready(a);
    await wait(a, a.next - Date.now());
    ready(a);
    a.next = Date.now() + 500;
    let response;
    try {
        response = await fetch(HOST + path, {
            ...options,
            redirect: "error",
            signal: AbortSignal.any([
                a.abort.signal,
                AbortSignal.timeout(10000),
            ]),
        });
    } catch {
        throw fault(a.abort.signal.aborted ? "stopped" : "network");
    }
    if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const seconds = number(header);
        const delay =
            seconds === null ? Date.parse(header) - Date.now() : seconds * 1000;
        a.blocked =
            Date.now() + Math.max(60000, Number.isFinite(delay) ? delay : 0);
        throw fault("rate_limit");
    }
    if (response.status === 401) {
        a.token = "";
        throw fault("unauthorized");
    }
    if (response.status === 403) throw fault("forbidden");
    if (response.status === 404) throw fault("missing_device");
    if (!response.ok) throw fault("api_error");
    let body;
    try {
        body = await response.json();
    } catch {
        throw fault("invalid_response");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
        throw fault("invalid_response");
    if (body.success === false) throw fault("rejected");
    return body;
}
async function token(a) {
    if (a.token && a.expires > Date.now()) return;
    const body = await http(a, "/oauth2/token", {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(`${a.cfg.clientId}:${a.cfg.clientSecret}`).toString("base64")}`,
        },
        body: "grant_type=client_credentials",
    });
    const seconds = number(body.expires_in);
    if (
        typeof body.access_token !== "string" ||
        !body.access_token ||
        seconds === null ||
        seconds <= 0
    )
        throw fault("invalid_response");
    a.token = body.access_token;
    a.expires =
        Date.now() +
        Math.max(0, seconds * 1000 - Math.min(30000, seconds * 100));
}
async function api(a, path, commands) {
    await token(a);
    const options = () => ({
        method: commands ? "POST" : "GET",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${a.token}`,
            ...(commands ? { "Content-Type": "application/json" } : {}),
        },
        ...(commands ? { body: JSON.stringify({ commands }) } : {}),
    });
    try {
        return await http(a, `/ally${path}`, options());
    } catch (error) {
        // Only reads can be repeated safely. Never replay a thermostat command.
        if (commands || error.message !== "ally_unauthorized") throw error;
        await token(a);
        return http(a, `/ally${path}`, options());
    }
}
function values(device) {
    if (!Array.isArray(device?.status)) return {};
    return Object.fromEntries(
        device.status
            .filter((entry) => entry && typeof entry.code === "string")
            .map((entry) => [entry.code, entry.value]),
    );
}
function thermostat(device) {
    const v = values(device);
    return Object.hasOwn(v, "manual_mode_fast") || Object.hasOwn(v, "temp_set");
}
function scaled(v, key, divisor = 10, min = -50, max = 100) {
    const raw = number(v[key]);
    if (raw === null || raw === -8000) return null;
    const n = raw / divisor;
    return n >= min && n <= max ? n : null;
}
function publish(node) {
    const a = node.account;
    const device = a.devices.get(node.deviceId);
    const available =
        a.connected === true && device?.online === true && thermostat(device);
    node.context.setNodeStatus?.(available);
    emit(node, "connected", a.connected === true);
    emit(node, "available", available);
    if (!a.connected) return;
    if (!device || !thermostat(device)) {
        fail(node, fault("missing_device"));
        return;
    }
    const v = values(device);
    const setpoint = SETPOINTS[v.mode];
    emit(
        node,
        "temperature",
        scaled(v, "temp_current") ?? scaled(v, "local_temperature", 100),
    );
    emit(node, "target", scaled(v, setpoint) ?? scaled(v, "temp_set"));
    emit(node, "battery", scaled(v, "battery_percentage", 1, 0, 100));
    emit(node, "demand", scaled(v, "pi_heating_demand", 1, 0, 100));
    emit(node, "mode", typeof v.mode === "string" ? v.mode : null);
    emit(node, "status", "ally_read");
    emit(node, "error", "");
}
function schedule(a) {
    clearTimeout(a.poll);
    if (!a.nodes.size || !a.cfg.interval || a.abort.signal.aborted) return;
    const delay = Math.max(a.cfg.interval * 1000, a.blocked - Date.now());
    a.poll = setTimeout(
        () => refresh(a).catch(() => {}),
        Math.min(2147483647, delay),
    );
    a.poll.unref?.();
}
function refresh(a, cached = false) {
    if (a.reading) return a.reading;
    if (cached && a.connected && Date.now() - a.readAt < 5000)
        return Promise.resolve();
    a.reading = queue(a, async () => {
        const body = await api(a, "/devices");
        if (!Array.isArray(body.result) || body.result.length > 2000)
            throw fault("invalid_response");
        const devices = new Map();
        for (const device of body.result) {
            if (
                !device ||
                typeof device.id !== "string" ||
                !ID.test(device.id) ||
                devices.has(device.id)
            )
                throw fault("invalid_response");
            devices.set(device.id, device);
        }
        ready(a);
        a.devices = devices;
        a.readAt = Date.now();
        a.connected = true;
        for (const node of a.nodes) publish(node);
    })
        .catch((error) => {
            a.connected = false;
            for (const node of a.nodes) {
                publish(node);
                fail(node, error);
            }
            throw error;
        })
        .finally(() => {
            a.reading = null;
            schedule(a);
        });
    return a.reading;
}
function detach(id) {
    const node = nodes.get(id);
    if (!node) return;
    nodes.delete(id);
    const a = node.account;
    a.nodes.delete(node);
    if (!a.nodes.size) {
        clearTimeout(a.poll);
        clearTimeout(a.followup);
        a.followup = null;
        // Stop all in-flight requests when the last running node is removed.
        // A concurrent device picker owns its own reference and may finish.
        if (a.refs === 1) stopAccount(a);
    }
    release(a);
}
function modeCommands(mode, v, device) {
    if (
        !Object.hasOwn(SETPOINTS, mode) ||
        mode === "holiday_sat" ||
        !Object.hasOwn(v, SETPOINTS[mode]) ||
        !Object.hasOwn(v, "mode")
    )
        throw fault("mode_invalid");
    const commands = [{ code: "mode", value: mode }];
    if (mode === "at_home" || mode === "leaving_home") {
        // Danfoss's preset-switch marker uses the gateway's local wall clock.
        const zone = /^([+-])(\d{2}):(\d{2})$/.exec(device.time_zone || "");
        if (!zone || Number(zone[2]) > 14 || Number(zone[3]) > 59)
            throw fault("timezone_invalid");
        const offset =
            (Number(zone[2]) * 60 + Number(zone[3])) *
            (zone[1] === "+" ? 1 : -1);
        const local = new Date(Date.now() + offset * 60000);
        const stamp = local.toISOString().slice(0, 16).replace(/[-T:]/g, "");
        commands.push({
            code: "last_click_time",
            value: stamp + (mode === "at_home" ? "010000" : "000101"),
        });
    }
    return commands;
}
async function command(node, handle, input) {
    const a = node.account;
    emit(node, "accepted", false, true);
    if (a.writes.has(node.deviceId)) throw fault("busy_error");
    a.writes.add(node.deviceId);
    emit(node, "busy", true);
    const deadline = Date.now() + 10000;
    try {
        await refresh(a, true);
        await queue(a, async () => {
            if (!active(node) || Date.now() > deadline)
                throw fault("expired_command");
            const device = a.devices.get(node.deviceId);
            if (!device || !thermostat(device)) throw fault("missing_device");
            if (device.online !== true) throw fault("offline");
            const v = values(device);
            let commands;
            if (handle === "temperature") {
                const temperature = number(input);
                const min = Math.max(5, scaled(v, "lower_temp") ?? 5);
                const max = Math.min(35, scaled(v, "upper_temp") ?? 35);
                if (
                    temperature === null ||
                    temperature < min ||
                    temperature > max ||
                    !Number.isInteger(temperature * 2)
                )
                    throw fault("temperature_invalid");
                commands = Object.hasOwn(v, "manual_mode_fast")
                    ? [
                          ...modeCommands("manual", v, device),
                          {
                              code: "manual_mode_fast",
                              value: Math.round(temperature * 10),
                          },
                      ]
                    : [
                          {
                              code: "temp_set",
                              value: Math.round(temperature * 10),
                          },
                      ];
            } else {
                commands = modeCommands(String(input), v, device);
            }
            // Check again immediately before fetch, including token renewal / pacing.
            await token(a);
            await wait(a, a.next - Date.now());
            if (!active(node) || Date.now() > deadline)
                throw fault("expired_command");
            const body = await api(
                a,
                `/devices/${node.deviceId}/commands`,
                commands,
            );
            if (
                body.result !== true &&
                !(body.result === undefined && number(body.t) !== null)
            )
                throw fault("rejected");
            emit(node, "accepted", true, true);
            emit(node, "error", "");
            emit(node, "status", "ally_sent");
            // Acknowledgement is not a physical device-state confirmation.
            if (!a.followup && a.nodes.size) {
                a.followup = setTimeout(() => {
                    a.followup = null;
                    refresh(a).catch(() => {});
                }, 10000);
                a.followup.unref?.();
            }
        });
    } finally {
        a.writes.delete(node.deviceId);
        emit(node, "busy", false);
    }
}

module.exports = {
    type: "danfoss-ally",
    label: "Danfoss Ally",
    category: "Geräte",
    color: "#f97316",
    description: "ally_description",
    translations: {
        de: {
            ally_description:
                "Verbindet Danfoss-Ally-Thermostate über die Cloud mit dem Logic Editor. Das vorhandene Ally-Gateway bleibt in Betrieb. Zur Einrichtung Client-ID (Consumer Key) und Client-Secret (Consumer Secret) der freigeschalteten Ally-API in den globalen Plugin-Einstellungen hinterlegen und pro Thermostat eine Node mit Geräteauswahl anlegen. Über die Eingänge lassen sich Solltemperatur und Betriebsmodus setzen sowie Statuswerte abfragen. Die Ausgänge liefern Ist- und Solltemperatur, Betriebsmodus sowie, sofern vom Gerät gemeldet, Batteriestand und Heizbedarf. Das Statusintervall beträgt standardmäßig 300 Sekunden; 0 aktiviert manuelle Abfragen, bei periodischen Abfragen sind mindestens 60 Sekunden erforderlich. Ein Solltemperaturbefehl aktiviert bei Ally-Heizkörperthermostaten den manuellen Betrieb. Cloud-Rückmeldungen können verzögert sein; accepted bestätigt nur die Befehlsannahme. Für Automatisierungen available prüfen, da letzte Messwerte bei Cloud-Ausfall erhalten bleiben.",
            ally_client_id: "Client-ID (Consumer Key)",
            ally_client_secret: "Client-Secret (Consumer Secret)",
            ally_interval: "Statusintervall (s, 0 = manuell, mindestens 60)",
            ally_device: "Thermostat",
            ally_devices: "Thermostate laden",
            ally_temperature: "Solltemperatur setzen (°C)",
            ally_mode_input:
                "Modus setzen (manual / at_home / leaving_home / pause / holiday)",
            ally_refresh: "Status abfragen",
            ally_actual: "Isttemperatur (°C)",
            ally_target: "Gemeldete Solltemperatur (°C)",
            ally_battery: "Batterie (%)",
            ally_demand: "Heizbedarf (%)",
            ally_mode: "Gemeldeter Modus",
            ally_connected: "Cloud erreichbar",
            ally_available: "Thermostat erreichbar",
            ally_busy: "Befehl läuft",
            ally_accepted: "Befehl angenommen (keine Zustandsbestätigung)",
            ally_status: "Status",
            ally_error: "Fehler",
            ally_sent:
                "Befehl von der Cloud angenommen; Geräterückmeldung abwarten",
            ally_read: "Status von der Cloud empfangen",
            ally_credentials:
                "Danfoss Ally: Client-ID und Client-Secret in den Plugin-Einstellungen eintragen",
            ally_interval_invalid:
                "Danfoss Ally: Statusintervall muss 0 oder eine ganze Zahl zwischen 60 und 86400 Sekunden sein",
            ally_device_invalid:
                "Danfoss Ally: Gültige Thermostat-ID auswählen",
            ally_network:
                "Danfoss Ally: Cloud-Anfrage fehlgeschlagen oder Zeitlimit erreicht; gesendete Befehle werden nicht wiederholt",
            ally_unauthorized:
                "Danfoss Ally: Anmeldung abgelehnt; API-Zugangsdaten prüfen",
            ally_forbidden:
                "Danfoss Ally: Zugriff verweigert; Ally-API und Kontozuordnung im Entwicklerportal prüfen",
            ally_rate_limit:
                "Danfoss Ally: API-Limit erreicht; Anfragen vorübergehend pausiert",
            ally_api_error:
                "Danfoss Ally: Cloud-Anfrage abgelehnt oder Dienst nicht verfügbar",
            ally_invalid_response: "Danfoss Ally: Ungültige Cloud-Antwort",
            ally_rejected: "Danfoss Ally: Befehl oder Anfrage nicht bestätigt",
            ally_missing_device:
                "Danfoss Ally: Thermostat fehlt oder wird nicht unterstützt",
            ally_offline: "Danfoss Ally: Thermostat offline; Befehl verworfen",
            ally_temperature_invalid:
                "Danfoss Ally: Solltemperatur muss innerhalb der Gerätegrenzen (5–35 °C) in Schritten von 0,5 °C liegen",
            ally_mode_invalid:
                "Danfoss Ally: Modus ungültig oder vom Gerät nicht unterstützt",
            ally_timezone_invalid:
                "Danfoss Ally: Gateway-Zeitzone fehlt oder ist ungültig; Moduswechsel abgebrochen",
            ally_busy_error:
                "Danfoss Ally: Verbindung oder Thermostat beschäftigt; Befehl verworfen",
            ally_expired_command:
                "Danfoss Ally: Befehl vor dem Senden abgebrochen oder veraltet",
            ally_stopped: "Danfoss Ally: Verbindung beendet",
            ally_unknown_action: "Danfoss Ally: Unbekannte Plugin-Aktion",
        },
        en: {
            ally_description:
                "Connects Danfoss Ally thermostats to the Logic Editor through the cloud. The existing Ally gateway remains in use. To set up, enter the client ID (Consumer Key) and client secret (Consumer Secret) for the enabled Ally API in the global plugin settings, then create one node per thermostat and select its device. Inputs set the target temperature and operating mode or refresh the status. Outputs provide measured and target temperatures, operating mode and, when reported by the device, battery level and heating demand. The default status interval is 300 seconds; 0 enables manual polling, while periodic polling requires at least 60 seconds. Setting a temperature activates manual mode on Ally radiator thermostats. Cloud feedback may be delayed; accepted confirms only command acceptance. Check available in automations because the last measurements are retained during cloud outages.",
            ally_client_id: "Client ID (Consumer Key)",
            ally_client_secret: "Client Secret (Consumer Secret)",
            ally_interval: "Status interval (s, 0 = manual, minimum 60)",
            ally_device: "Thermostat",
            ally_devices: "Load thermostats",
            ally_temperature: "Set target temperature (°C)",
            ally_mode_input:
                "Set mode (manual / at_home / leaving_home / pause / holiday)",
            ally_refresh: "Refresh status",
            ally_actual: "Measured temperature (°C)",
            ally_target: "Reported target temperature (°C)",
            ally_battery: "Battery (%)",
            ally_demand: "Heating demand (%)",
            ally_mode: "Reported mode",
            ally_connected: "Cloud reachable",
            ally_available: "Thermostat reachable",
            ally_busy: "Command in progress",
            ally_accepted: "Command accepted (no state confirmation)",
            ally_status: "Status",
            ally_error: "Error",
            ally_sent:
                "Command accepted by the cloud; waiting for device feedback",
            ally_read: "Status received from the cloud",
            ally_credentials:
                "Danfoss Ally: Enter the client ID and client secret in the plugin settings",
            ally_interval_invalid:
                "Danfoss Ally: Status interval must be 0 or an integer between 60 and 86400 seconds",
            ally_device_invalid: "Danfoss Ally: Select a valid thermostat ID",
            ally_network:
                "Danfoss Ally: Cloud request failed or timed out; sent commands are not retried",
            ally_unauthorized:
                "Danfoss Ally: Authentication rejected; check API credentials",
            ally_forbidden:
                "Danfoss Ally: Access denied; check Ally API access and account association in the developer portal",
            ally_rate_limit:
                "Danfoss Ally: API limit reached; requests temporarily paused",
            ally_api_error:
                "Danfoss Ally: Cloud request rejected or service unavailable",
            ally_invalid_response: "Danfoss Ally: Invalid cloud response",
            ally_rejected: "Danfoss Ally: Command or request not acknowledged",
            ally_missing_device:
                "Danfoss Ally: Thermostat missing or unsupported",
            ally_offline: "Danfoss Ally: Thermostat offline; command discarded",
            ally_temperature_invalid:
                "Danfoss Ally: Target temperature must be within device limits (5–35 °C) in 0.5 °C steps",
            ally_mode_invalid:
                "Danfoss Ally: Mode invalid or unsupported by this device",
            ally_timezone_invalid:
                "Danfoss Ally: Gateway time zone missing or invalid; mode change cancelled",
            ally_busy_error:
                "Danfoss Ally: Connection or thermostat busy; command discarded",
            ally_expired_command:
                "Danfoss Ally: Command cancelled or expired before sending",
            ally_stopped: "Danfoss Ally: Connection closed",
            ally_unknown_action: "Danfoss Ally: Unknown plugin action",
        },
    },
    globalSettings: [
        { key: "clientId", label: "ally_client_id", type: "text" },
        { key: "clientSecret", label: "ally_client_secret", type: "password" },
        {
            key: "interval",
            label: "ally_interval",
            type: "number",
            default: 300,
        },
    ],
    globalActions: [{ key: "listDevices", label: "ally_devices" }],
    config: [
        {
            key: "deviceId",
            label: "ally_device",
            type: "async-select",
            showValue: true,
            allowCustomValue: true,
            optionsSource: { action: "listDevices", parameters: [] },
        },
    ],
    inputs: [
        { handle: "temperature", label: "ally_temperature" },
        { handle: "mode", label: "ally_mode_input" },
        { handle: "refresh", label: "ally_refresh" },
    ],
    outputs: [
        { handle: "temperature", label: "ally_actual" },
        { handle: "target", label: "ally_target" },
        { handle: "battery", label: "ally_battery" },
        { handle: "demand", label: "ally_demand" },
        { handle: "mode", label: "ally_mode" },
        { handle: "connected", label: "ally_connected" },
        { handle: "available", label: "ally_available" },
        { handle: "busy", label: "ally_busy" },
        { handle: "accepted", label: "ally_accepted" },
        { handle: "status", label: "ally_status" },
        { handle: "error", label: "ally_error" },
    ],
    async handleGlobalAction(action, input, context) {
        if (action !== "listDevices") throw fault("unknown_action");
        const a = acquire(settings(context, input));
        try {
            await refresh(a);
            return {
                options: [...a.devices.values()]
                    .filter(thermostat)
                    .map((device) => ({
                        value: device.id,
                        label:
                            typeof device.name === "string" && device.name
                                ? device.name
                                : device.id,
                    })),
            };
        } finally {
            release(a);
        }
    },
    execute(inputs, data, context) {
        let node = nodes.get(context.nodeId);
        try {
            const cfg = settings(context);
            const deviceId =
                typeof data.deviceId === "string" ? data.deviceId.trim() : "";
            if (!ID.test(deviceId)) throw fault("device_invalid");
            const signature = JSON.stringify([cfg, deviceId]);
            if (!node || node.signature !== signature) {
                detach(context.nodeId);
                const a = acquire(cfg);
                node = {
                    id: context.nodeId,
                    context,
                    deviceId,
                    signature,
                    account: a,
                    outputs: {},
                };
                nodes.set(node.id, node);
                a.nodes.add(node);
                emit(node, "busy", false);
                emit(node, "accepted", false);
                publish(node);
                refresh(a, true).catch(() => {});
                schedule(a);
            }
            node.context = context;
            const handle = context.triggerHandle;
            if (handle === "temperature" || handle === "mode") {
                command(node, handle, inputs[handle]).catch((error) =>
                    fail(node, error),
                );
            } else if (handle === "refresh" && on(inputs.refresh)) {
                refresh(node.account).catch(() => {});
            }
        } catch (error) {
            detach(context.nodeId);
            context.setNodeStatus?.(false);
            for (const handle of ["connected", "available", "busy", "accepted"])
                context.emitOutput(handle, false);
            const key = /^ally_[a-z_]+$/.test(error?.message)
                ? error.message
                : "ally_network";
            context.emitOutput("error", key);
            context.warn?.(key);
        }
        return {};
    },
    dispose(nodeId) {
        if (nodeId != null) detach(nodeId);
        else {
            for (const id of nodes.keys()) detach(id);
            for (const a of accounts.values()) stopAccount(a);
        }
    },
};
