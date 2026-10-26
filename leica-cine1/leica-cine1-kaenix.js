/**
 * @plugin Leica Cine 1
 * @version 1.0.2
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 *
 * VIDAA transport: TLS connection verified on Leica Cine 1.
 * Protocol reference (independent implementation):
 * https://github.com/V4n1X/ha_hisense_tv/blob/main/docs/PROTOCOL.md
 */
"use strict";
const path = require("node:path");
const { isIP } = require("node:net");
const { createHash } = require("node:crypto");
const dgram = require("node:dgram");
const states = new Map();
let mqtt;

// Public VIDAA/RemoteNOW compatibility identity, not a user's private credential.
// Bundled with explicit user authorization; avoids runtime downloads and manual PEM entry.
// Source: https://github.com/d3nd3/Hisense-mqtt-keyfiles/blob/main/hi_keys.zip
// Archive SHA-256: 2d1a0615928bb96424a539c2d0bdb73afeef4c61ccdc2c8125e04a589bf9e381
// Certificate SHA-256: 85:7E:4D:1A:D9:4F:89:24:04:37:1F:F1:CB:28:2C:1B:89:0F:73:CE:D3:FD:47:05:1E:6E:20:D5:90:55:7C:59
const BUILTIN_CLIENT = Object.freeze({
    cert: "-----BEGIN CERTIFICATE-----\nMIIDvTCCAqWgAwIBAgIBAjANBgkqhkiG9w0BAQsFADBnMQswCQYDVQQGEwJDTjER\nMA8GA1UECAwIc2hhbmRvbmcxEDAOBgNVBAcMB3FpbmdkYW8xCzAJBgNVBAoMAmho\nMRMwEQYDVQQLDAptdWx0aW1lZGlhMREwDwYDVQQDDAhSZW1vdGVDQTAeFw0xODA0\nMTkwMjAxMTdaFw00MzA0MTMwMjAxMTdaMGAxCzAJBgNVBAYTAkNOMREwDwYDVQQI\nDAhzaGFuZG9uZzELMAkGA1UECgwCaGgxFDASBgNVBAsMC211bHRpc2NyZWVuMRsw\nGQYDVQQDDBJyZW1vdGVjbGllbnRtb2JpbGUwggEiMA0GCSqGSIb3DQEBAQUAA4IB\nDwAwggEKAoIBAQDu/o3p42CAraBA19IrYteEt8N8dyAvUmEyTVZMwHobwzNUABra\nzUXhmFvduh02q/1y2TblB8dHSf53WKV+5O+sRpD7dc1lbhgoYLmHp3yVxrVDDKTo\nz22fH54LrLm3t2k3j3ShXMbJIBEQqFJxW0P0I4Kj7wktKWBQ1rJjK3gFgHxaRugC\n0oGZuv16M9Dn7tKpg+VX9SQ5Uj6nFjHv5scFUOBC7rPPlcFNQhkZT4Mdg/fcCFlJ\n0hF5R6BDniRkRLEmsyNWhFSUf6UKDcNIDuPlcjYEmZNB5p4OGVWt0c/A5q057ZVO\nRsSq9dwUgkSjj4Zz8nGK1lf3P5KVFMdocvzDAgMBAAGjezB5MAkGA1UdEwQCMAAw\nLAYJYIZIAYb4QgENBB8WHU9wZW5TU0wgR2VuZXJhdGVkIENlcnRpZmljYXRlMB0G\nA1UdDgQWBBSoDVzwztBO4zBMk73za2OMYSa+3DAfBgNVHSMEGDAWgBQjQIKRqSQG\nhzF4k4+glDyqSfz8OzANBgkqhkiG9w0BAQsFAAOCAQEAgrk7ZK0/eGlY8uqAql25\nR+cm17C+3MAvAj7yuU889CewPDPTtZmM05/1i0bV1oo2Pp9fLf0dxLovTwBpvAN8\nlcxYNPxbZ824+sSncwx2AujmTJk7eIUoHczhluiU6rapK8apkU/iN4GNcBZkbccn\n1FghvHaAKmUefzOwbY2LOAd7Z1KhKmf6MyL7RqN8LAgx3i2uiW1GM4C8KeFxZ090\n9+e4R6eufW/V+58/HJtF9jECeNikLvJpxveCC6Q/N49s72hHZC0L0NeJ7GNKzoOi\n8lXL5QgNGCg/bawsx9q5YvWLsDOVJIEhWv3MxmnC/reIeDf7iMEK3BP5E4u8uTzJ\nHg==\n-----END CERTIFICATE-----\n",
    key: "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDu/o3p42CAraBA\n19IrYteEt8N8dyAvUmEyTVZMwHobwzNUABrazUXhmFvduh02q/1y2TblB8dHSf53\nWKV+5O+sRpD7dc1lbhgoYLmHp3yVxrVDDKToz22fH54LrLm3t2k3j3ShXMbJIBEQ\nqFJxW0P0I4Kj7wktKWBQ1rJjK3gFgHxaRugC0oGZuv16M9Dn7tKpg+VX9SQ5Uj6n\nFjHv5scFUOBC7rPPlcFNQhkZT4Mdg/fcCFlJ0hF5R6BDniRkRLEmsyNWhFSUf6UK\nDcNIDuPlcjYEmZNB5p4OGVWt0c/A5q057ZVORsSq9dwUgkSjj4Zz8nGK1lf3P5KV\nFMdocvzDAgMBAAECggEBAIwImx5wHBtJoJxd2MeTIrSg9+n14uXXXxwaNHbEUMfz\nmB+f8BxEKq4El89TPcrK+7ZPj9qitCEROgiz6ERx3/0RW+H7JF5KI92EzzCs8lLQ\nG2UuA3JmF9UksXYlvqvmy7/CTpQ9yDwQje80sRm6YBast99WMApGNCkpo1x4G9sc\nS994P5wQwE+aC4encNDfrbPmDco2vjTIhVmcFJ9hxfPvkZbecxlMnKnh1eQtLYzB\nDxWTTtpKzCg+EDhp67aE9MlB/HJ06hCHyrt/QaUGfrAa0lGOOJq2tHK+D7ZCi1BW\nY7FXHwrkgO+PiEtjCex6d4I7gZKoZuO8oIhRbaWvMAECgYEA+d6kCnOk7z+AJFzm\nMuITuASBxTZovguGuQ2hKX479pKLw+ehs0J/srR35SPHeLaAzsuG8Xi5tKNpbnY9\nc/aHfEdj+CYP8k5aWvhuGO3dZYyGTHlDcex4Tmx1ytOeC74RWJxHRPWg21l29Nfd\nMmlW2+UW8+TEDPY/if6AGMW4Pd8CgYEA9Nub1OP5wX8sllRuGBnMm14Mx+p6bEnp\nAEB81Nj8DwYKMaWlrq+l6R0RB/jsnaSRe0KfdL1MKN5VSOfevd2gwgET0vJCRhPk\nrlBG8BVyG9ma1Fd+K00CQ2iOMVSIqW6OKDDiXVif2/U51mrc0oz3JXXFR14ck3TR\nEl5auO9WVZ0CgYBNxy/o0PaWQn3w07oUPKtGrKB4cudHwO6+y69O6yxfJF69LGz5\nD8oQJnzrpqeAu858kH4AzEOCJxu6drPKVQL3fIFxzOdJ1Xnqt0oOGHzCD2v+ggCs\nhZ8tSjWgXR7lKNTdcEf+/zaDEOYmcMs51fBjonvyj1M3da9xlPbqvyEKoQKBgQDm\ncomHI8i7w+VC1tOG+0EGOM3umU/++tC/2/GgoVcZDKYrc6srbUTI0QJmbnDDLU9+\nooVQaZh0HkxGAXQxXZUfAcSWlEqria2AIS2iZ4ytiW+eyXmFZ0TqDE1HQDgevl4s\nlVV2ZSKO8Y0tsAWEZAd2yhCRypE6docOsp7PzvGCQQKBgQCinwRjA6qjSEUcXwR1\nF7ep46RNe8JGpJ2ZMffneFct8P4fyKYMSY5zZBc9kYSxpgJPZc5Y+V5Tq+vWc4SX\n/QNCZLcC5wMVs2jp8LYruoR0QoQdizpvlKQC2s4UD7Lp12lntJsCDULN9G9lzKUI\nLgVhEy5cFTsByGHGWF6LAKrpHA==\n-----END PRIVATE KEY-----\n",
});

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

function options(data) {
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
        `${createHash("sha256")
            .update(`leica-cine1:${mac.toLowerCase() || host}`)
            .digest("hex")
            .slice(0, 12)
            .match(/../g)
            .join(":")}$normal`;
    if (!/^[a-zA-Z\d:$._-]{1,80}$/.test(clientId))
        throw new Error("Leica: Ungültige Client-ID");
    return {
        host,
        port,
        broadcast,
        mac,
        cert: protocol === "mqtts" ? cert || BUILTIN_CLIENT.cert : "",
        key: protocol === "mqtts" ? key || BUILTIN_CLIENT.key : "",
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
        paired: context.globalSetting?.(`paired:${cfg.clientId}`) === "1",
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
    s.rememberPairing = (value) => {
        if (s.paired === value) return;
        s.paired = value;
        s.context.setGlobalSetting?.(
            `paired:${cfg.clientId}`,
            value ? "1" : "0",
        );
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
        if (!s.online || s.needsPin) return;
        s.publish("ui_service", "gettvstate");
        s.publish("ui_service", "sourcelist");
    };
    s.tryPin = () => {
        if (
            !s.online ||
            !s.needsPin ||
            !/^\d{4}$/.test(s.pin || "") ||
            s.lastPin === s.pin
        )
            return;
        s.lastPin = s.pin;
        s.publish(
            "ui_service",
            "authenticationcode",
            JSON.stringify({ authNum: s.pin }),
        );
    };
    const stale = () => {
        clearTimeout(s.watchdog);
        s.watchdog = setTimeout(() => {
            if (!s.active()) return;
            if (s.needsPin) return;
            s.stateAt = 0;
            s.connected(false);
            s.output("power", null);
            s.output("source", null);
            s.fail("Leica: Keine aktuelle Geräterückmeldung");
        }, 45000);
        s.watchdog.unref?.();
    };
    s.applyState = (value, receivedAt = Date.now()) => {
        const wasReady = s.ready;
        s.connected(true);
        s.stateAt = receivedAt;
        s.lastResponseAt = receivedAt;
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
    };
    const disconnected = () => {
        if (!s.active()) return;
        s.session++;
        s.online = false;
        s.needsPin = false;
        s.authBlocked = false;
        s.observedState = undefined;
        s.stateAt = 0;
        s.connected(false);
        s.output("power", null);
        s.output("source", null);
        clearInterval(s.poll);
        clearTimeout(s.watchdog);
        clearTimeout(s.confirm);
        s.pendingSource = undefined;
        s.status(
            s.connectionError ||
                "Leica: Nicht verbunden; Betriebszustand unbekannt",
        );
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
        s.connectionError = undefined;
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
            ![6, 7].includes(parts.length) ||
            parts[1] !== "remoteapp" ||
            parts[2] !== "mobile" ||
            ![cfg.clientId, "broadcast"].includes(parts[3])
        )
            return;
        const own = parts[3] === cfg.clientId;
        const action = parts.at(-1);
        // Broadcast traffic must never establish authentication for our client.
        if (
            own &&
            [
                "authentication",
                "authenticationcodetoast",
                "authenticationcodeclose",
            ].includes(action)
        ) {
            if (
                action === "authenticationcodeclose" &&
                !s.needsPin &&
                !s.authBlocked
            )
                return;
            if (action === "authentication") s.rememberPairing(false);
            s.connected(false);
            s.stateAt = 0;
            s.output("power", null);
            s.output("source", null);
            s.needsPin = action === "authentication";
            s.authBlocked = true;
            // Repeated gettvstate calls can replace the PIN while the user types it.
            clearTimeout(s.watchdog);
            s.status(
                action === "authentication"
                    ? "Leica: PIN am Gerät ablesen und koppeln"
                    : action === "authenticationcodetoast"
                      ? "Leica: Fernbedienungsverbindung belegt; andere App schließen"
                      : "Leica: PIN-Kopplung beendet; erneut Status abfragen",
            );
            s.tryPin();
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
                s.needsPin = false;
                s.authBlocked = false;
                s.rememberPairing(true);
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
            if (!own || s.authBlocked || !Array.isArray(value)) return;
            const wasReady = s.ready;
            s.rememberPairing(true);
            s.lastResponseAt = Date.now();
            s.connected(true);
            s.output("error", "");
            stale();
            if (!wasReady) s.status("Leica: Gerätestatus empfangen");
            if (s.observedState && Date.now() - s.observedState.at <= 45000) {
                s.applyState(s.observedState.value, s.observedState.at);
                s.observedState = undefined;
            }
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
            const digest = JSON.stringify(s.sources);
            if (digest !== s.sourcesDigest) {
                s.sourcesDigest = digest;
                s.output("sources", s.sources);
            }
            return;
        }
        if (/^fake_sleep_[01]$/.test(value?.statetype)) {
            s.stateAt = 0;
            s.output("power", null);
            s.output("source", null);
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
        if (!value || !running.includes(value.statetype)) return;
        if (!own && !s.ready && !s.paired) {
            s.observedState = { value, at: Date.now() };
            return;
        }
        if (s.authBlocked) return;
        if (own) {
            s.authBlocked = false;
            s.rememberPairing(true);
        }
        s.applyState(value);
    });
    s.client.on("close", disconnected);
    s.client.on("offline", disconnected);
    s.client.on("error", (error) => {
        if (!s.active()) return;
        // Map only known codes; OpenSSL messages may expose certificate/key details.
        let message =
            "Leica: MQTT-Verbindung fehlgeschlagen; Transport und Zertifikate prüfen";
        if (
            [
                "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
                "ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE",
            ].includes(error?.code)
        ) {
            message =
                "Leica: Gerät verlangt ein Client-Zertifikat; kompatibles PEM-Zertifikat und Schlüssel eintragen";
        } else if (
            [
                "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
                "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
                "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
                "ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED",
            ].includes(error?.code)
        ) {
            message =
                "Leica: Gerät hat das Client-Zertifikat abgelehnt; Zertifikat und Schlüssel prüfen";
        }
        s.connectionError = message;
        disconnected();
        s.fail(message);
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
        if (!s.ready || !s.stateAt || Date.now() - s.lastResponseAt > 45000) {
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
        // Cine 1 uses HDMI1/2/3 directly; other devices can use discovered or numeric IDs.
        const source =
            match?.id ??
            (/^(?:\d{1,5}|HDMI[1-3])$/i.test(requested)
                ? requested.toUpperCase()
                : undefined);
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
        "Leica Cine 1: Ein/Aus und Quellenwahl über VIDAA (Steuerung noch nicht vollständig am Gerät geprüft)",
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
            placeholder: "192.168.2.146",
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
            type: "select",
            options: [
                { value: "HDMI1", label: "HDMI1" },
                { value: "HDMI2", label: "HDMI2" },
                { value: "HDMI3", label: "HDMI3" },
            ],
            default: "HDMI1",
        },
        { key: "pin", label: "Kopplungs-PIN (vierstellig)", type: "password" },
        {
            key: "broadcast",
            advanced: true,
            label: "Wake-on-LAN Broadcast-Adresse",
            type: "text",
            default: "255.255.255.255",
        },
        {
            key: "transport",
            advanced: true,
            label: "MQTT-Transport",
            type: "select",
            default: "mqtts",
            options: [
                { value: "mqtts", label: "TLS" },
                { value: "mqtt", label: "Unverschlüsselt (lokales Netz)" },
            ],
        },
        {
            key: "port",
            advanced: true,
            label: "MQTT-Port",
            type: "number",
            default: 36669,
        },
        {
            key: "verifyTLS",
            advanced: true,
            label: "TLS-Zertifikat prüfen",
            type: "checkbox",
            default: false,
        },
        {
            key: "clientId",
            advanced: true,
            label: "VIDAA Client-ID (leer = automatisch)",
            type: "text",
        },
        {
            key: "cert",
            advanced: true,
            label: "Client-Zertifikat (PEM, optional)",
            type: "password",
        },
        {
            key: "key",
            advanced: true,
            label: "Client-Schlüssel (PEM, optional)",
            type: "password",
        },
    ],
    execute(inputs, data, context) {
        const id = context.nodeId;
        let s = states.get(id);
        let validated = false;
        try {
            const cfg = options(data);
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
            s.pin = String(data.pin || "").trim();
            if (context.triggerHandle !== "pair") s.tryPin();
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
