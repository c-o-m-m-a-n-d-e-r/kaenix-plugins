/**
 * @plugin Netatmo Wetterstation
 * @version 1.0.1
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 * https://dev.netatmo.com/apidocumentation/weather
 * https://dev.netatmo.com/apidocumentation/oauth
 */
"use strict";
const crypto = require("node:crypto");
const accounts = new Map();
const nodes = new Map();
const ID = /^[a-zA-Z0-9:_-]{1,128}$/;
const validId = (value) => typeof value === "string" && ID.test(value);
const TYPES = new Set([
    "NAMain",
    "NAModule1",
    "NAModule2",
    "NAModule3",
    "NAModule4",
]);
const METRICS = {
    temperature: "Temperature",
    humidity: "Humidity",
    co2: "CO2",
    pressure: "Pressure",
    noise: "Noise",
    rain: "Rain",
    rainHour: "sum_rain_1",
    rainDay: "sum_rain_24",
    wind: "WindStrength",
    windAngle: "WindAngle",
    gust: "GustStrength",
    gustAngle: "GustAngle",
};
const fail = (key) => new Error(`netatmo_${key}`);
function numeric(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function settings(context) {
    const cfg = {};
    for (const key of ["clientId", "clientSecret", "refreshToken"])
        cfg[key] = String(context.globalSetting(key) ?? "").trim();
    if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken)
        throw fail("credentials");
    const raw = context.globalSetting("interval");
    cfg.interval = raw == null || raw === "" ? 300 : Number(raw);
    if (
        !Number.isInteger(cfg.interval) ||
        (cfg.interval !== 0 && (cfg.interval < 60 || cfg.interval > 86400))
    )
        throw fail("interval_invalid");
    return cfg;
}
function keyOf(cfg) {
    return crypto
        .createHash("sha256")
        .update(
            JSON.stringify([cfg.clientId, cfg.clientSecret, cfg.refreshToken]),
        )
        .digest("hex");
}
function stop(a) {
    a.abort.abort();
    clearTimeout(a.idle);
    for (const [key, value] of accounts) if (value === a) accounts.delete(key);
}
function idle(a) {
    clearTimeout(a.idle);
    if (a.abort.signal.aborted) return;
    if (!a.nodes.size && !a.actions) {
        a.idle = setTimeout(() => stop(a), 300000);
        a.idle.unref?.();
    }
}
function acquire(cfg) {
    const key = keyOf(cfg);
    let a = accounts.get(key);
    if (!a) {
        a = {
            cfg: { ...cfg },
            initialKey: key,
            currentKey: key,
            abort: new AbortController(),
            nodes: new Set(),
            actions: 0,
            devices: new Map(),
            token: "",
            expires: 0,
            readAt: 0,
            blocked: 0,
            failures: 0,
            error: "",
        };
        accounts.set(key, a);
    }
    clearTimeout(a.idle);
    return a;
}
function alive(node) {
    return nodes.get(node.id) === node && !node.account.abort.signal.aborted;
}
function emit(node, handle, value) {
    if (
        !alive(node) ||
        (Object.hasOwn(node.outputs, handle) && node.outputs[handle] === value)
    )
        return;
    node.outputs[handle] = value;
    node.context.emitOutput(handle, value);
}
function diagnostic(error) {
    return /^netatmo_[a-z_]+$/.test(error?.message)
        ? error.message
        : "netatmo_network";
}
async function http(a, path, options = {}) {
    const response = await fetch(`https://api.netatmo.com${path}`, {
        ...options,
        redirect: "error",
        signal: AbortSignal.any([a.abort.signal, AbortSignal.timeout(10000)]),
    });
    if (response.status === 429) {
        const raw = response.headers.get("retry-after");
        const delay =
            raw && /^\d+(\.\d+)?$/.test(raw)
                ? Number(raw) * 1000
                : Date.parse(raw) - Date.now();
        a.blocked =
            Date.now() + Math.max(60000, Number.isFinite(delay) ? delay : 0);
        throw fail("rate_limit");
    }
    if (
        response.status === 401 ||
        (response.status === 400 && path === "/oauth2/token")
    )
        throw fail("unauthorized");
    if (response.status === 403) throw fail("forbidden");
    if (!response.ok) throw fail("api_error");
    let body;
    try {
        body = await response.json();
    } catch {
        throw fail("invalid_response");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
        throw fail("invalid_response");
    if (body.error) {
        if ([1, 2, 3].includes(body.error.code)) throw fail("unauthorized");
        throw fail("api_error");
    }
    return body;
}
function persist(a, context) {
    if (!a.pendingRefresh) return;
    if (
        String(context.globalSetting("clientId") ?? "").trim() !==
            a.cfg.clientId ||
        String(context.globalSetting("clientSecret") ?? "").trim() !==
            a.cfg.clientSecret ||
        String(context.globalSetting("refreshToken") ?? "").trim() !==
            a.persistedToken
    )
        throw fail("credentials_changed");
    if (context.setGlobalSetting("refreshToken", a.cfg.refreshToken) !== true)
        throw fail("persistence");
    a.persistedToken = a.cfg.refreshToken;
    a.pendingRefresh = false;
}
async function token(a, context) {
    persist(a, context);
    if (a.token && a.expires > Date.now()) return;
    // Refresh tokens rotate. Serialize all reads and persist before using the access token.
    const body = await http(a, "/oauth2/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: a.cfg.clientId,
            client_secret: a.cfg.clientSecret,
            refresh_token: a.cfg.refreshToken,
        }).toString(),
    });
    if (a.abort.signal.aborted) throw fail("stopped");
    if (
        typeof body.access_token !== "string" ||
        !body.access_token ||
        typeof body.refresh_token !== "string" ||
        !body.refresh_token ||
        numeric(body.expires_in) === null ||
        body.expires_in <= 0
    )
        throw fail("invalid_response");
    a.persistedToken = a.cfg.refreshToken;
    a.cfg.refreshToken = body.refresh_token;
    a.pendingRefresh = true;
    if (a.currentKey !== a.initialKey) accounts.delete(a.currentKey);
    a.currentKey = keyOf(a.cfg);
    accounts.set(a.currentKey, a);
    a.token = body.access_token;
    a.expires = Date.now() + Math.max(0, body.expires_in * 1000 - 30000);
    persist(a, context);
}
function parseDevices(body) {
    if (!Array.isArray(body.body?.devices)) throw fail("invalid_response");
    const result = new Map();
    for (const station of body.body.devices) {
        if (!station || !validId(station._id) || !TYPES.has(station.type))
            continue;
        const name = station.station_name || station.module_name || station._id;
        for (const device of [
            station,
            ...(Array.isArray(station.modules) ? station.modules : []),
        ]) {
            if (!device || !validId(device._id) || !TYPES.has(device.type))
                continue;
            const id = `${station._id}/${device._id}`;
            result.set(id, {
                device,
                station,
                label:
                    device === station
                        ? name
                        : `${name} · ${device.module_name || device._id}`,
            });
        }
    }
    return result;
}
function publish(node) {
    const a = node.account;
    const found = a.devices.get(node.deviceId);
    const device = found?.device;
    const dashboard = device?.dashboard_data;
    const time = numeric(dashboard?.time_utc);
    const fresh =
        time !== null &&
        time * 1000 <= Date.now() + 300000 &&
        Date.now() - time * 1000 <= 1200000;
    const available =
        !a.error &&
        !!device &&
        device.reachable !== false &&
        found.station.reachable !== false &&
        fresh;
    emit(node, "connected", !!a.readAt && !a.error);
    emit(node, "available", available);
    for (const [handle, field] of Object.entries(METRICS))
        emit(node, handle, available ? numeric(dashboard[field]) : null);
    emit(node, "battery", available ? numeric(device?.battery_percent) : null);
    emit(node, "updated", time);
    emit(
        node,
        "error",
        a.error ||
            (!found && a.readAt
                ? "netatmo_missing_device"
                : device && !available
                  ? "netatmo_stale"
                  : ""),
    );
    node.context.setNodeStatus?.(available);
    clearTimeout(node.staleTimer);
    if (available && alive(node)) {
        node.staleTimer = setTimeout(
            () => publish(node),
            Math.max(1, time * 1000 + 1200001 - Date.now()),
        );
        node.staleTimer.unref?.();
    }
}
function refresh(a, context) {
    if (a.pending) return a.pending;
    if (a.abort.signal.aborted) return Promise.reject(fail("stopped"));
    if (a.blocked > Date.now())
        return Promise.reject(
            fail(a.error === "netatmo_rate_limit" ? "rate_limit" : "backoff"),
        );
    if (a.readAt && Date.now() - a.readAt < 60000 && !a.error)
        return Promise.resolve();
    a.pending = (async () => {
        try {
            await token(a, context);
            const get = () =>
                http(a, "/api/getstationsdata?get_favorites=false", {
                    headers: {
                        Accept: "application/json",
                        Authorization: `Bearer ${a.token}`,
                    },
                });
            let body;
            try {
                body = await get();
            } catch (error) {
                if (error.message !== "netatmo_unauthorized") throw error;
                a.token = "";
                await token(a, context);
                body = await get();
            }
            if (a.abort.signal.aborted) return;
            a.devices = parseDevices(body);
            a.readAt = Date.now();
            a.error = "";
            a.failures = 0;
        } catch (error) {
            if (!a.abort.signal.aborted) {
                a.error = diagnostic(error);
                a.failures++;
                a.blocked = Math.max(
                    a.blocked,
                    Date.now() +
                        Math.min(
                            3600000,
                            60000 * 2 ** Math.min(a.failures - 1, 6),
                        ),
                );
                for (const node of a.nodes) node.context.warn?.(a.error);
            }
            throw error;
        } finally {
            a.pending = null;
            for (const node of a.nodes) publish(node);
            idle(a);
        }
    })();
    return a.pending;
}
function schedule(node) {
    clearTimeout(node.timer);
    if (!alive(node) || !node.interval) return;
    node.timer = setTimeout(() => {
        refresh(node.account, node.context)
            .catch(() => {})
            .finally(() => {
                if (alive(node)) {
                    publish(node);
                    schedule(node);
                }
            });
    }, node.interval * 1000);
    node.timer.unref?.();
}
function detach(id) {
    const node = nodes.get(id);
    if (!node) return;
    clearTimeout(node.timer);
    clearTimeout(node.staleTimer);
    nodes.delete(id);
    node.account.nodes.delete(node);
    if (
        !node.account.nodes.size &&
        !node.account.actions &&
        node.account.pending
    )
        stop(node.account);
    else idle(node.account);
}

module.exports = {
    type: "netatmo",
    label: "Netatmo",
    category: "Geräte",
    color: "#f97316",
    description: "netatmo_description",
    translations: {
        de: {
            netatmo_description:
                "Liest Netatmo-Wetterstationen und ihre Außen- und Innenmodule sowie Regen- und Windsensoren über die Cloud aus. Zur Einrichtung Client-ID, Client-Secret und ein Refresh-Token mit der Berechtigung read_station in den globalen Plugin-Einstellungen hinterlegen. Pro Station oder Modul eine Node anlegen und das Gerät aus der Liste auswählen. Je nach Modul stehen Temperatur, Luftfeuchtigkeit, CO₂, Luftdruck, Geräuschpegel, Regenmengen, Wind- und Böengeschwindigkeit, Windrichtung sowie Batteriestand und Messzeitpunkt zur Verfügung. Abfragen erfolgen beim Start und standardmäßig alle 300 Sekunden; 0 deaktiviert periodische Abfragen, der Eingang refresh = 1 fragt manuell ab. Mehrere Nodes teilen Cloud-Abfragen; erfolgreiche Antworten werden 60 Sekunden wiederverwendet. OAuth-Tokens werden automatisch erneuert und gespeichert. Die Cloud liefert keine Echtzeitdaten: Bei Fehlern, nicht erreichbaren Modulen oder über 20 Minuten alten Messwerten wird available = false und die Messausgänge werden auf null gesetzt. Nicht vom Modul unterstützte Messwerte sind ebenfalls null.",
            netatmo_client_id: "Client-ID",
            netatmo_client_secret: "Client-Secret",
            netatmo_refresh_token: "Refresh-Token (read_station)",
            netatmo_interval:
                "Abfrageintervall (s, 0 = manuell, mindestens 60)",
            netatmo_device: "Station / Modul",
            netatmo_devices: "Stationen und Module laden",
            netatmo_refresh: "Messwerte abfragen",
            netatmo_temperature: "Temperatur (°C)",
            netatmo_humidity: "Luftfeuchtigkeit (%)",
            netatmo_co2: "CO₂ (ppm)",
            netatmo_pressure: "Luftdruck (hPa)",
            netatmo_noise: "Geräuschpegel (dB)",
            netatmo_rain: "Regen (mm)",
            netatmo_rain_hour: "Regen letzte Stunde (mm)",
            netatmo_rain_day: "Regen letzte 24 Stunden (mm)",
            netatmo_wind: "Wind (km/h)",
            netatmo_wind_angle: "Windrichtung (°)",
            netatmo_gust: "Böen (km/h)",
            netatmo_gust_angle: "Böenrichtung (°)",
            netatmo_battery: "Batterie (%)",
            netatmo_updated: "Messzeitpunkt (Unix-Sekunden)",
            netatmo_connected: "Cloud erreichbar",
            netatmo_available: "Aktuelle Messwerte verfügbar",
            netatmo_error: "Fehler",
            netatmo_credentials:
                "Netatmo: Client-ID, Client-Secret und Refresh-Token in den Plugin-Einstellungen eintragen",
            netatmo_interval_invalid:
                "Netatmo: Intervall muss 0 oder eine ganze Zahl zwischen 60 und 86400 Sekunden sein",
            netatmo_device_invalid: "Netatmo: Station / Modul auswählen",
            netatmo_network:
                "Netatmo: Cloud-Anfrage fehlgeschlagen oder Zeitlimit erreicht",
            netatmo_unauthorized:
                "Netatmo: Anmeldung abgelehnt; Refresh-Token prüfen oder neu autorisieren",
            netatmo_forbidden:
                "Netatmo: Zugriff verweigert; Berechtigung read_station prüfen",
            netatmo_rate_limit:
                "Netatmo: API-Limit erreicht; Anfragen pausiert",
            netatmo_backoff:
                "Netatmo: Anfragen nach Fehler vorübergehend pausiert",
            netatmo_api_error:
                "Netatmo: Cloud-Anfrage abgelehnt oder Dienst nicht verfügbar",
            netatmo_invalid_response: "Netatmo: Ungültige Cloud-Antwort",
            netatmo_missing_device:
                "Netatmo: Station oder Modul nicht gefunden",
            netatmo_stale:
                "Netatmo: Modul offline oder Messwerte älter als 20 Minuten",
            netatmo_persistence:
                "Netatmo: Erneuertes Refresh-Token konnte nicht gespeichert werden",
            netatmo_credentials_changed:
                "Netatmo: Zugangsdaten während der Anfrage geändert; erneut abfragen",
            netatmo_stopped: "Netatmo: Verbindung beendet",
            netatmo_unknown_action: "Netatmo: Unbekannte Plugin-Aktion",
        },
        en: {
            netatmo_description:
                "Reads Netatmo weather stations, outdoor and indoor modules, rain gauges and wind sensors through the cloud. To set up, enter the client ID, client secret and a refresh token with read_station permission in the global plugin settings. Create one node per station or module and select the device from the list. Depending on the module, outputs provide temperature, humidity, CO₂, pressure, noise, rainfall, wind and gust speeds, wind direction, battery level and measurement time. Data is fetched on startup and every 300 seconds by default; 0 disables periodic polling, and the refresh = 1 input requests a manual read. Multiple nodes share cloud requests; successful responses are reused for 60 seconds. OAuth tokens are renewed and saved automatically. Cloud data is not real-time: errors, unreachable modules or measurements older than 20 minutes set available = false and clear measurement outputs to null. Measurements unsupported by the module are also null.",
            netatmo_client_id: "Client ID",
            netatmo_client_secret: "Client secret",
            netatmo_refresh_token: "Refresh token (read_station)",
            netatmo_interval: "Polling interval (s, 0 = manual, minimum 60)",
            netatmo_device: "Station / module",
            netatmo_devices: "Load stations and modules",
            netatmo_refresh: "Refresh measurements",
            netatmo_temperature: "Temperature (°C)",
            netatmo_humidity: "Humidity (%)",
            netatmo_co2: "CO₂ (ppm)",
            netatmo_pressure: "Pressure (hPa)",
            netatmo_noise: "Noise (dB)",
            netatmo_rain: "Rain (mm)",
            netatmo_rain_hour: "Rain last hour (mm)",
            netatmo_rain_day: "Rain last 24 hours (mm)",
            netatmo_wind: "Wind (km/h)",
            netatmo_wind_angle: "Wind direction (°)",
            netatmo_gust: "Gusts (km/h)",
            netatmo_gust_angle: "Gust direction (°)",
            netatmo_battery: "Battery (%)",
            netatmo_updated: "Measurement time (Unix seconds)",
            netatmo_connected: "Cloud reachable",
            netatmo_available: "Current measurements available",
            netatmo_error: "Error",
            netatmo_credentials:
                "Netatmo: Enter client ID, client secret and refresh token in the plugin settings",
            netatmo_interval_invalid:
                "Netatmo: Interval must be 0 or an integer between 60 and 86400 seconds",
            netatmo_device_invalid: "Netatmo: Select a station / module",
            netatmo_network: "Netatmo: Cloud request failed or timed out",
            netatmo_unauthorized:
                "Netatmo: Authentication rejected; check refresh token or authorize again",
            netatmo_forbidden:
                "Netatmo: Access denied; check read_station permission",
            netatmo_rate_limit: "Netatmo: API limit reached; requests paused",
            netatmo_backoff:
                "Netatmo: Requests temporarily paused after an error",
            netatmo_api_error:
                "Netatmo: Cloud request rejected or service unavailable",
            netatmo_invalid_response: "Netatmo: Invalid cloud response",
            netatmo_missing_device: "Netatmo: Station or module not found",
            netatmo_stale:
                "Netatmo: Module offline or measurements older than 20 minutes",
            netatmo_persistence:
                "Netatmo: Could not save renewed refresh token",
            netatmo_credentials_changed:
                "Netatmo: Credentials changed during request; refresh again",
            netatmo_stopped: "Netatmo: Connection closed",
            netatmo_unknown_action: "Netatmo: Unknown plugin action",
        },
    },
    globalSettings: [
        { key: "clientId", label: "netatmo_client_id", type: "text" },
        {
            key: "clientSecret",
            label: "netatmo_client_secret",
            type: "password",
        },
        {
            key: "refreshToken",
            label: "netatmo_refresh_token",
            type: "password",
        },
        {
            key: "interval",
            label: "netatmo_interval",
            type: "number",
            default: 300,
        },
    ],
    globalActions: [{ key: "listDevices", label: "netatmo_devices" }],
    config: [
        {
            key: "deviceId",
            label: "netatmo_device",
            type: "async-select",
            showValue: true,
            allowCustomValue: true,
            optionsSource: { action: "listDevices", parameters: [] },
        },
    ],
    inputs: [{ handle: "refresh", label: "netatmo_refresh" }],
    outputs: [
        { handle: "temperature", label: "netatmo_temperature" },
        { handle: "humidity", label: "netatmo_humidity" },
        { handle: "co2", label: "netatmo_co2" },
        { handle: "pressure", label: "netatmo_pressure" },
        { handle: "noise", label: "netatmo_noise" },
        { handle: "rain", label: "netatmo_rain" },
        { handle: "rainHour", label: "netatmo_rain_hour" },
        { handle: "rainDay", label: "netatmo_rain_day" },
        { handle: "wind", label: "netatmo_wind" },
        { handle: "windAngle", label: "netatmo_wind_angle" },
        { handle: "gust", label: "netatmo_gust" },
        { handle: "gustAngle", label: "netatmo_gust_angle" },
        { handle: "battery", label: "netatmo_battery" },
        { handle: "updated", label: "netatmo_updated" },
        { handle: "connected", label: "netatmo_connected" },
        { handle: "available", label: "netatmo_available" },
        { handle: "error", label: "netatmo_error" },
    ],
    async handleGlobalAction(action, values, context) {
        if (action !== "listDevices") throw fail("unknown_action");
        const a = acquire(settings(context));
        a.actions++;
        try {
            await refresh(a, context);
            return {
                options: [...a.devices].map(([value, entry]) => ({
                    value,
                    label: entry.label,
                })),
            };
        } finally {
            a.actions--;
            idle(a);
        }
    },
    execute(inputs, data, context) {
        try {
            const cfg = settings(context);
            const parts =
                typeof data.deviceId === "string"
                    ? data.deviceId.split("/")
                    : [];
            if (parts.length !== 2 || !parts.every(validId))
                throw fail("device_invalid");
            const a = acquire(cfg);
            let node = nodes.get(context.nodeId);
            if (
                !node ||
                node.account !== a ||
                node.deviceId !== data.deviceId ||
                node.interval !== cfg.interval
            ) {
                detach(context.nodeId);
                clearTimeout(a.idle);
                node = {
                    id: context.nodeId,
                    account: a,
                    deviceId: data.deviceId,
                    interval: cfg.interval,
                    context,
                    outputs: {},
                };
                nodes.set(node.id, node);
                a.nodes.add(node);
                publish(node);
                refresh(a, context).catch(() => {});
                schedule(node);
            }
            node.context = context;
            if (
                context.triggerHandle === "refresh" &&
                [true, 1, "1"].includes(inputs.refresh)
            )
                refresh(a, context)
                    .catch(() => {})
                    .finally(() => publish(node));
        } catch (error) {
            detach(context.nodeId);
            context.setNodeStatus?.(false);
            for (const handle of [
                ...Object.keys(METRICS),
                "battery",
                "updated",
            ])
                context.emitOutput(handle, null);
            context.emitOutput("connected", false);
            context.emitOutput("available", false);
            context.emitOutput("error", diagnostic(error));
            context.warn?.(diagnostic(error));
        }
        return {};
    },
    dispose(nodeId) {
        if (nodeId != null) detach(nodeId);
        else {
            for (const id of nodes.keys()) detach(id);
            for (const a of new Set(accounts.values())) stop(a);
        }
    },
};
