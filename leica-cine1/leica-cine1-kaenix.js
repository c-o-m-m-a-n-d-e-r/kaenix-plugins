/**
 * @plugin Leica Cine 1
 * @version 1.0.0
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 *
 * Experimental VIDAA transport, not yet verified on Leica hardware.
 * Protocol reference (independent implementation, no bundled app certificates):
 * https://github.com/V4n1X/ha_hisense_tv/blob/main/docs/PROTOCOL.md
 */
"use strict";
const path = require("node:path");
const { isIP } = require("node:net");
const { createHash } = require("node:crypto");
const dgram = require("node:dgram");
const states = new Map();
let mqtt;

// The marketplace installs this file on its own.
function getMqtt() {
    if (!mqtt) {
        try {
            mqtt = require("mqtt");
        } catch {
            try {
                mqtt = require(
                    require.resolve("mqtt", {
                        paths: [
                            process.cwd(),
                            path.resolve(__dirname, "../../backend"),
                        ],
                    }),
                );
            } catch {
                throw new Error("Leica: MQTT-Bibliothek fehlt");
            }
        }
    }
    return mqtt;
}

function options(data, id) {
    const host = String(data.ip || "").trim();
    const port = Number(data.port ?? 36669);
    const broadcast = String(data.broadcast || "255.255.255.255").trim();
    const mac = String(data.mac || "").trim();
    if (isIP(host) !== 4)
        throw new Error("Leica: Gültige IPv4-Adresse erforderlich");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("Leica: Ungültiger MQTT-Port");
    if (isIP(broadcast) !== 4)
        throw new Error("Leica: Ungültige Broadcast-Adresse");
    if (mac && !/^(?:[a-f\d]{2}:){5}[a-f\d]{2}$/i.test(mac))
        throw new Error("Leica: Ungültige MAC-Adresse");
    const pem = (value) =>
        String(value || "")
            .trim()
            .replace(/\\n/g, "\n");
    const cert = pem(data.cert),
        key = pem(data.key);
    if (!!cert !== !!key)
        throw new Error(
            "Leica: Client-Zertifikat und Schlüssel gemeinsam eintragen",
        );
    const protocol = data.transport || "mqtts";
    if (!["mqtt", "mqtts"].includes(protocol))
        throw new Error("Leica: Ungültiger Transport");
    const clientId =
        String(data.clientId || "").trim() ||
        `${createHash("sha256").update(String(id)).digest("hex").slice(0, 12).match(/../g).join(":")}$normal`;
    if (!/^[a-zA-Z\d:$._-]{1,80}$/.test(clientId))
        throw new Error("Leica: Ungültige Client-ID");
    return {
        host,
        port,
        broadcast,
        mac,
        cert,
        key,
        protocol,
        clientId,
        verifyTLS: [true, 1, "1", "true"].includes(data.verifyTLS),
    };
}

function close(id) {
    const s = states.get(id);
    if (!s) return;
    states.delete(id);
    clearInterval(s.poll);
    clearTimeout(s.watchdog);
    clearTimeout(s.confirm);
    clearTimeout(s.wakeTimer);
    clearTimeout(s.wakeDeadline);
    s.stopWake?.();
    s.client?.end(true);
}

function start(id, cfg, context) {
    const s = {
        cfg,
        context,
        online: false,
        ready: false,
        values: new Map(),
        sources: [],
        stateAt: 0,
        session: 0,
    };
    states.set(id, s);
    s.active = () => states.get(id) === s;
    s.output = (handle, value) => {
        if (!s.active()) return;
        if (s.values.has(handle) && s.values.get(handle) === value) return;
        s.values.set(handle, value);
        s.context.emitOutput(handle, value);
    };
    s.status = (message) => s.output("status", message);
    s.fail = (message) => {
        s.output("error", message);
        s.context.warn(message);
    };
    s.connected = (value) => {
        s.ready = value;
        s.output("connected", value ? 1 : 0);
        s.context.setNodeStatus?.(value);
    };
    s.publish = (service, action, body = "") => {
        if (!s.online)
            throw new Error("Leica: Nicht verbunden; Befehl nicht gesendet");
        const client = s.client;
        client.publish(
            `/remoteapp/tv/${service}/${cfg.clientId}/actions/${action}`,
            body,
            { qos: 0, retain: false },
            (error) => {
                if (s.active() && client === s.client && error)
                    s.fail("Leica: Senden fehlgeschlagen");
            },
        );
    };
    s.request = () => {
        if (!s.online) return;
        s.publish("ui_service", "gettvstate");
        if (s.ready) s.publish("ui_service", "sourcelist");
    };
    const stale = () => {
        clearTimeout(s.watchdog);
        s.watchdog = setTimeout(() => {
            if (!s.active()) return;
            s.stateAt = 0;
            s.connected(false);
            s.output("power", null);
            s.output("source", null);
            s.fail("Leica: Keine aktuelle Geräterückmeldung");
        }, 45000);
        s.watchdog.unref?.();
    };
    const disconnected = () => {
        if (!s.active()) return;
        s.session++;
        s.online = false;
        s.stateAt = 0;
        s.connected(false);
        s.output("power", null);
        s.output("source", null);
        clearInterval(s.poll);
        clearTimeout(s.watchdog);
        clearTimeout(s.confirm);
        s.pendingSource = undefined;
        s.status("Leica: Nicht verbunden; Betriebszustand unbekannt");
    };
    s.client = getMqtt().connect({
        host: cfg.host,
        port: cfg.port,
        protocol: cfg.protocol,
        protocolId: "MQIsdp",
        protocolVersion: 3,
        clientId: cfg.clientId,
        username: "hisenseservice",
        password: "multimqttservice",
        clean: false,
        keepalive: 45,
        connectTimeout: 5000,
        reconnectPeriod: 5000,
        resubscribe: false,
        queueQoSZero: false,
        rejectUnauthorized: cfg.verifyTLS,
        ...(cfg.protocol === "mqtts" && cfg.cert
            ? { cert: cfg.cert, key: cfg.key }
            : {}),
    });
    s.client.on("connect", () => {
        if (!s.active()) return;
        disconnected();
        const session = s.session;
        s.client.subscribe(
            [
                `/remoteapp/mobile/broadcast/#`,
                `/remoteapp/mobile/${cfg.clientId}/#`,
            ],
            { qos: 0 },
            (error, grants) => {
                if (!s.active() || !s.client.connected || session !== s.session)
                    return;
                if (
                    error ||
                    !grants?.length ||
                    grants.some((grant) => grant.qos === 128)
                ) {
                    s.fail("Leica: MQTT-Abonnement abgelehnt");
                    return;
                }
                s.online = true;
                s.status("Leica: Verbunden; warte auf Gerätestatus");
                s.request();
                stale();
                s.poll = setInterval(() => s.request(), 15000);
                s.poll.unref?.();
            },
        );
    });
    s.client.on("message", (topic, payload) => {
        if (!s.active() || !s.online || payload.length > 65536) return;
        const parts = topic.split("/");
        if (
            parts.length !== 7 ||
            parts[1] !== "remoteapp" ||
            parts[2] !== "mobile" ||
            ![cfg.clientId, "broadcast"].includes(parts[3])
        )
            return;
        const own = parts[3] === cfg.clientId;
        const action = parts[6];
        // Broadcast traffic must never establish authentication for our client.
        if (
            own &&
            [
                "authentication",
                "authenticationcodetoast",
                "authenticationcodeclose",
            ].includes(action)
        ) {
            s.connected(false);
            s.stateAt = 0;
            s.output("power", null);
            s.output("source", null);
            s.status(
                action === "authentication"
                    ? "Leica: PIN am Gerät ablesen und koppeln"
                    : action === "authenticationcodetoast"
                      ? "Leica: Fernbedienungsverbindung belegt; andere App schließen"
                      : "Leica: PIN-Kopplung beendet; erneut Status abfragen",
            );
            return;
        }
        if (
            ![
                "authenticationcode",
                "state",
                "gettvstate",
                "sourcelist",
            ].includes(action)
        )
            return;
        let value;
        try {
            value = JSON.parse(payload.toString());
        } catch {
            s.fail("Leica: Ungültige Geräteantwort");
            return;
        }
        if (action === "authenticationcode" && own) {
            if (value?.result === 1 || value?.result === "1") {
                s.connected(true);
                s.output("error", "");
                s.status("Leica: PIN-Kopplung erfolgreich");
                s.request();
            } else {
                s.connected(false);
                s.fail("Leica: PIN falsch oder abgelaufen");
            }
            return;
        }
        if (action === "sourcelist") {
            if (!own || !s.ready || !Array.isArray(value)) return;
            s.sources = value
                .filter(
                    (item) =>
                        item &&
                        /^[\w.-]{1,32}$/.test(String(item.sourceid)) &&
                        typeof item.sourcename === "string",
                )
                .map((item) => ({
                    id: String(item.sourceid),
                    name: item.sourcename,
                }));
            s.output("sources", s.sources);
            return;
        }
        const running = [
            "sourceswitch",
            "livetv",
            "app",
            "mediadmp",
            "mediadlna",
            "tshift",
        ];
        if (!value || !running.includes(value.statetype) || (!own && !s.ready))
            return;
        const wasReady = s.ready;
        s.connected(true);
        s.stateAt = Date.now();
        s.output("power", 1);
        s.output("error", "");
        stale();
        if (
            value.sourceid !== undefined &&
            /^[\w.-]{1,32}$/.test(String(value.sourceid))
        ) {
            const source = String(value.sourceid);
            s.output("source", source);
            if (source === s.pendingSource) {
                clearTimeout(s.confirm);
                s.pendingSource = undefined;
                s.status("Leica: Quelle durch Gerät bestätigt");
            }
        }
        if (!wasReady) {
            s.status("Leica: Gerätestatus empfangen");
            s.publish("ui_service", "sourcelist");
        }
    });
    s.client.on("close", disconnected);
    s.client.on("offline", disconnected);
    s.client.on("error", () => {
        if (s.active())
            s.fail(
                "Leica: MQTT-Verbindung fehlgeschlagen; Transport und Zertifikate prüfen",
            );
    });
    s.connected(false);
    s.output("power", null);
    s.output("source", null);
    return s;
}

function wake(s) {
    if (!s.cfg.mac)
        throw new Error("Leica: Zum Einschalten MAC-Adresse eintragen");
    if (s.socket) return;
    const mac = Buffer.from(s.cfg.mac.replaceAll(":", ""), "hex");
    const packet = Buffer.concat([
        Buffer.alloc(6, 255),
        ...Array(16).fill(mac),
    ]);
    const socket = dgram.createSocket("udp4");
    s.socket = socket;
    let sent = 0,
        ended = false;
    const finish = () => {
        if (ended) return;
        ended = true;
        clearTimeout(s.wakeTimer);
        clearTimeout(s.wakeDeadline);
        if (s.socket === socket) s.socket = undefined;
        try {
            socket.close();
        } catch (error) {
            if (error.code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error;
        }
    };
    s.stopWake = finish;
    socket.on("error", () => {
        if (s.active())
            s.fail("Leica: Wake-on-LAN konnte nicht gesendet werden");
        finish();
    });
    s.wakeDeadline = setTimeout(() => {
        if (s.active())
            s.fail("Leica: Wake-on-LAN konnte nicht gesendet werden");
        finish();
    }, 3000);
    s.wakeDeadline.unref?.();
    socket.bind(0, () => {
        if (!s.active()) {
            finish();
            return;
        }
        try {
            socket.setBroadcast(true);
        } catch {
            s.fail("Leica: Wake-on-LAN konnte nicht gesendet werden");
            finish();
            return;
        }
        const send = () => {
            if (!s.active() || ended) return;
            socket.send(packet, 33129, s.cfg.broadcast, (error) => {
                if (!s.active() || ended) return;
                if (error) {
                    s.fail("Leica: Wake-on-LAN konnte nicht gesendet werden");
                    finish();
                    return;
                }
                if (++sent === 5) {
                    s.status(
                        "Leica: Wake-on-LAN gesendet; Einschalten unbestätigt",
                    );
                    finish();
                } else s.wakeTimer = setTimeout(send, 100);
            });
        };
        send();
    });
}

function command(s, inputs, data, handle) {
    if (handle === "power") {
        if (![true, false, 0, 1, "0", "1"].includes(inputs.power))
            throw new Error("Leica: Ein/Aus erwartet 0 oder 1");
        if ([true, 1, "1"].includes(inputs.power)) {
            s.offPending = false;
            wake(s);
            return;
        }
        if (s.offPending) return;
        // KEY_POWER is a toggle. Never send it blind or repeat it after a timeout.
        if (!s.ready || !s.stateAt || Date.now() - s.stateAt > 45000) {
            throw new Error(
                "Leica: Ausschalten benötigt aktuellen eingeschalteten Gerätestatus",
            );
        }
        s.offPending = true;
        s.publish("remote_service", "sendkey", "KEY_POWER");
        s.status("Leica: Ausschaltbefehl gesendet; Ausschalten unbestätigt");
    } else if (
        handle === "source" ||
        (handle === "selectSource" &&
            [true, 1, "1"].includes(inputs.selectSource))
    ) {
        if (!s.ready || !s.online)
            throw new Error("Leica: Nicht verbunden; Befehl nicht gesendet");
        const requested = String(
            handle === "source"
                ? (inputs.source ?? "")
                : (data.source ?? "HDMI1"),
        ).trim();
        const normalize = (text) => text.replace(/\s/g, "").toUpperCase();
        const match = s.sources.find(
            (item) =>
                item.id === requested ||
                normalize(item.name) === normalize(requested),
        );
        // Never guess model-specific HDMI IDs. Explicit numeric IDs also work before discovery.
        const source =
            match?.id ?? (/^\d{1,5}$/.test(requested) ? requested : undefined);
        if (source === undefined)
            throw new Error(
                "Leica: Quelle unbekannt; Quellenliste oder numerische Quellen-ID verwenden",
            );
        s.publish(
            "ui_service",
            "changesource",
            JSON.stringify({ sourceid: source }),
        );
        clearTimeout(s.confirm);
        s.pendingSource = source;
        s.status("Leica: Quellenbefehl gesendet; warte auf Bestätigung");
        s.confirm = setTimeout(() => {
            if (!s.active()) return;
            s.pendingSource = undefined;
            s.fail("Leica: Quellenwechsel vom Gerät nicht bestätigt");
        }, 8000);
        s.confirm.unref?.();
        s.publish("ui_service", "gettvstate");
    } else if (handle === "pair" && [true, 1, "1"].includes(inputs.pair)) {
        const pin = String(data.pin || "").trim();
        if (!/^\d{4}$/.test(pin))
            throw new Error("Leica: Vierstellige PIN eintragen");
        s.publish(
            "ui_service",
            "authenticationcode",
            JSON.stringify({ authNum: pin }),
        );
    } else if (
        handle === "refresh" &&
        [true, 1, "1"].includes(inputs.refresh)
    ) {
        if (!s.online)
            throw new Error("Leica: Nicht verbunden; Befehl nicht gesendet");
        s.request();
    }
}

module.exports = {
    type: "leica-cine1",
    label: "Leica Cine 1",
    category: "Geräte",
    color: "#f97316",
    description:
        "Leica Cine 1: Ein/Aus und Quellenwahl über VIDAA (experimentell, am Gerät ungeprüft)",
    inputs: [
        { handle: "power", label: "Ein/Aus (1/0)" },
        { handle: "source", label: "Quelle (Name oder ID)" },
        { handle: "selectSource", label: "Konfigurierte Quelle wählen" },
        { handle: "pair", label: "PIN-Kopplung bestätigen" },
        { handle: "refresh", label: "Status abfragen" },
        { handle: "reconnect", label: "Neu verbinden" },
    ],
    outputs: [
        { handle: "connected", label: "Geräteverbindung (1/0)" },
        { handle: "power", label: "Betrieb (1 = bestätigt, null = unbekannt)" },
        { handle: "source", label: "Aktive Quellen-ID" },
        { handle: "sources", label: "Verfügbare Quellen" },
        { handle: "status", label: "Status" },
        { handle: "error", label: "Fehler" },
    ],
    config: [
        {
            key: "ip",
            label: "Projektor-IP",
            type: "text",
            placeholder: "192.168.2.147",
        },
        {
            key: "mac",
            label: "MAC-Adresse (Wake-on-LAN)",
            type: "text",
            placeholder: "00:11:22:33:44:55",
        },
        {
            key: "source",
            label: "Quelle (Name oder ID)",
            type: "text",
            default: "HDMI1",
        },
        {
            key: "broadcast",
            label: "Wake-on-LAN Broadcast-Adresse",
            type: "text",
            default: "255.255.255.255",
        },
        {
            key: "transport",
            label: "MQTT-Transport",
            type: "select",
            default: "mqtts",
            options: [
                { value: "mqtts", label: "TLS" },
                { value: "mqtt", label: "Unverschlüsselt (lokales Netz)" },
            ],
        },
        { key: "port", label: "MQTT-Port", type: "number", default: 36669 },
        {
            key: "verifyTLS",
            label: "TLS-Zertifikat prüfen",
            type: "checkbox",
            default: false,
        },
        {
            key: "clientId",
            label: "VIDAA Client-ID (leer = automatisch)",
            type: "text",
        },
        {
            key: "cert",
            label: "Client-Zertifikat (PEM, optional)",
            type: "password",
        },
        {
            key: "key",
            label: "Client-Schlüssel (PEM, optional)",
            type: "password",
        },
        { key: "pin", label: "Kopplungs-PIN (vierstellig)", type: "password" },
    ],
    execute(inputs, data, context) {
        const id = context.nodeId;
        let s = states.get(id);
        let validated = false;
        try {
            const cfg = options(data, id);
            validated = true;
            const reconnect =
                context.triggerHandle === "reconnect" &&
                [true, 1, "1"].includes(inputs.reconnect);
            if (
                !s ||
                JSON.stringify(cfg) !== JSON.stringify(s.cfg) ||
                reconnect
            ) {
                close(id);
                s = start(id, cfg, context);
            }
            s.context = context;
            command(s, inputs, data, context.triggerHandle);
        } catch (error) {
            // Only controlled messages are exposed; MQTT/TLS errors can include credentials.
            const message = error.message?.startsWith("Leica: ")
                ? error.message
                : "Leica: Verbindung konnte nicht gestartet werden";
            if (validated && s?.active()) s.fail(message);
            else {
                close(id);
                context.setNodeStatus?.(false);
                context.emitOutput("connected", 0);
                context.emitOutput("power", null);
                context.emitOutput("source", null);
                context.emitOutput("error", message);
                context.warn(message);
            }
        }
        return {};
    },
    dispose(id) {
        if (id != null) close(id);
        else for (const key of states.keys()) close(key);
    },
};
