/**
 * @plugin Magnetar
 * @version 1.0.0
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 *
 * MAGNETAR UDP900 User Manual, RS-232 / Network Control, pp. 50–53.
 * https://magnetar-audio.com/wp-content/uploads/2023/11/UDP900_User_Manual-English.pdf
 * TCP 8102: #<three-character code>\r\n, response: ack.
 */
"use strict";
const net = require("node:net");
const states = new Map();
const keys = new Set(
    "POW EJT PON POF DIM PUR VUP VDN MUT NU0 NU1 NU2 NU3 NU4 NU5 NU6 NU7 NU8 NU9 CLR GOT HOM OSD TTL MNU NUP NLT NRT NDN SEL SET RET RED GRN BLU YLW STP PLA PAU PRE REV FWD NXT AUD SUB ANG ZOM SAP ATB RPT PIP HDM SUH OPT SEH HDR".split(
        " ",
    ),
);
const buttons = {
    play: ["PLA", "Wiedergabe (Trigger)"],
    pause: ["PAU", "Pause (Trigger)"],
    stop: ["STP", "Stopp (Trigger)"],
    next: ["NXT", "Nächstes Kapitel (Trigger)"],
    previous: ["PRE", "Vorheriges Kapitel (Trigger)"],
    forward: ["FWD", "Vorlauf (Trigger)"],
    rewind: ["REV", "Rücklauf (Trigger)"],
    eject: ["EJT", "Disc-Lade öffnen/schließen (Trigger)"],
    home: ["HOM", "Hauptmenü (Trigger)"],
    menu: ["TTL", "Disc-Menü (Trigger)"],
    popup: ["MNU", "Popup-Menü (Trigger)"],
    up: ["NUP", "Nach oben (Trigger)"],
    down: ["NDN", "Nach unten (Trigger)"],
    left: ["NLT", "Nach links (Trigger)"],
    right: ["NRT", "Nach rechts (Trigger)"],
    enter: ["SEL", "Bestätigen (Trigger)"],
    back: ["RET", "Zurück (Trigger)"],
    audio: ["AUD", "Tonspur wechseln (Trigger)"],
    subtitle: ["SUB", "Untertitel wechseln (Trigger)"],
    volumeInc: ["VUP", "Lauter (Trigger)"],
    volumeDec: ["VDN", "Leiser (Trigger)"],
    muteToggle: ["MUT", "Stumm umschalten (Trigger)"],
};
const triggered = (value) => [true, 1, "1"].includes(value);

function emit(s, handle, value) {
    if (s.values[handle] === value) return;
    s.values[handle] = value;
    s.context.emitOutput(handle, value);
}

function report(s, message) {
    emit(s, "error", message);
    s.context.warn?.(message);
    s.context.nodeLog?.(message);
}

function stop(id) {
    const s = states.get(id);
    if (!s) return;
    states.delete(id);
    clearTimeout(s.retry);
    clearTimeout(s.deadline);
    clearTimeout(s.gap);
    s.socket?.destroy();
}

function pump(s) {
    if (!s.connected || s.pending || s.gap || !s.queue.length) return;
    s.pending = s.queue.shift();
    // One in-flight command: the protocol's bare ack has no command identifier.
    s.deadline = setTimeout(() => {
        report(s, "Magnetar: Keine Befehlsbestätigung; Ausführung unbekannt");
        s.socket.destroy();
    }, s.cfg.timeout * 1000);
    s.deadline.unref?.();
    try {
        s.socket.write(`#${s.pending}\r\n`);
    } catch {
        report(s, "Magnetar: Senden fehlgeschlagen; Ausführung unbekannt");
        s.socket.destroy();
    }
}

function connect(s) {
    if (states.get(s.id) !== s) return;
    const socket = new net.Socket();
    s.socket = socket;
    s.buffer = "";
    const active = () => states.get(s.id) === s && s.socket === socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    socket.setEncoding("ascii");
    s.deadline = setTimeout(() => {
        report(s, "Magnetar: Verbindungsaufbau fehlgeschlagen");
        socket.destroy();
    }, s.cfg.timeout * 1000);
    s.deadline.unref?.();
    socket.on("connect", () => {
        if (!active()) return;
        clearTimeout(s.deadline);
        s.connected = true;
        s.attempts = 0;
        emit(s, "connected", 1);
        // A TCP connection is not confirmation that a command was executed.
    });
    socket.on("data", (chunk) => {
        if (!active()) return;
        s.buffer += chunk;
        // Support bare ack, CR/LF, fragmented a|ck and combined TCP packets.
        s.buffer = s.buffer.replace(/^[\r\n ]+/, "");
        while (s.buffer.startsWith("ack")) {
            s.buffer = s.buffer.slice(3).replace(/^[\r\n ]+/, "");
            if (!s.pending) continue;
            clearTimeout(s.deadline);
            const command = s.pending;
            s.pending = null;
            s.gap = setTimeout(() => {
                s.gap = null;
                pump(s);
            }, 100);
            s.gap.unref?.();
            emit(s, "error", "");
            s.context.setNodeStatus?.(true);
            // Event output: repeated identical commands need repeated confirmations.
            s.context.emitOutput("acknowledged", command);
        }
        if (s.buffer && !["a", "ac"].includes(s.buffer)) {
            report(s, "Magnetar: Ungültige Geräteantwort");
            socket.destroy();
        }
    });
    socket.on("error", () => {
        if (active())
            report(s, "Magnetar: Netzwerkfehler; Ausführung unbekannt");
        socket.destroy();
    });
    socket.on("close", () => {
        if (!active()) return;
        clearTimeout(s.deadline);
        clearTimeout(s.gap);
        s.gap = null;
        s.connected = false;
        emit(s, "connected", 0);
        s.context.setNodeStatus?.(false);
        if (s.pending || s.queue.length)
            report(
                s,
                "Magnetar: Verbindung unterbrochen; ausstehende Befehle verworfen",
            );
        else if (!s.values.error)
            report(
                s,
                "Magnetar: Verbindung unterbrochen; erneuter Verbindungsversuch folgt",
            );
        // Never replay commands whose execution is uncertain (eject, mute, etc.).
        s.pending = null;
        s.queue = [];
        s.retry = setTimeout(
            () => connect(s),
            Math.min(30000, 1000 * 2 ** Math.min(s.attempts++, 5)),
        );
        s.retry.unref?.();
    });
    socket.connect(s.cfg.port, s.cfg.host);
}

function options(data) {
    const host = typeof data.ip === "string" ? data.ip.trim() : "";
    const port = data.port ?? 8102;
    const timeout = data.timeout ?? 5;
    const validNumber = (value, min, max) =>
        ["number", "string"].includes(typeof value) &&
        String(value).trim() !== "" &&
        Number.isInteger(Number(value)) &&
        Number(value) >= min &&
        Number(value) <= max;
    if (
        !net.isIP(host) ||
        !validNumber(port, 1, 65535) ||
        !validNumber(timeout, 1, 30)
    )
        throw new Error("Magnetar: IP-Adresse, Port oder Zeitlimit ungültig");
    return { host, port: Number(port), timeout: Number(timeout) };
}

function commandFor(handle, value) {
    if (handle === "power") {
        if ([true, 1, "1"].includes(value)) return "PON";
        if ([false, 0, "0"].includes(value)) return "POF";
        throw new Error("Magnetar: Ein/Aus erwartet 0 oder 1");
    }
    if (handle === "command") {
        if (typeof value !== "string" || !keys.has(value))
            throw new Error("Magnetar: Unbekannter Fernbedienungscode");
        return value;
    }
    if (Object.hasOwn(buttons, handle) && triggered(value))
        return buttons[handle][0];
    return null;
}

module.exports = {
    type: "magnetar",
    label: "Magnetar",
    category: "Geräte",
    color: "#f97316",
    description:
        "Magnetar Blu-ray-Player über TCP steuern; Befehlsbestätigung ohne Gerätestatus",
    inputs: [
        { handle: "power", label: "Ein/Aus (1/0)" },
        ...Object.entries(buttons).map(([handle, [, label]]) => ({
            handle,
            label,
        })),
        {
            handle: "command",
            label: "Fernbedienungscode (z. B. RED, NU1, SET)",
        },
        { handle: "reconnect", label: "Neu verbinden" },
    ],
    outputs: [
        { handle: "connected", label: "TCP-Verbindung (1/0)" },
        { handle: "acknowledged", label: "Bestätigter Befehl (Code)" },
        { handle: "error", label: "Fehler" },
    ],
    config: [
        {
            key: "ip",
            label: "IP-Adresse",
            type: "text",
            placeholder: "192.168.1.80",
        },
        { key: "port", label: "TCP-Port", type: "number", default: 8102 },
        {
            key: "timeout",
            label: "Antwortzeitlimit in Sekunden (1–30)",
            type: "number",
            default: 5,
        },
    ],
    execute(inputs, data, context) {
        const id = context.nodeId;
        let s = states.get(id);
        try {
            let cfg;
            try {
                cfg = options(data);
            } catch (error) {
                stop(id);
                throw error;
            }
            if (
                !s ||
                JSON.stringify(cfg) !== JSON.stringify(s.cfg) ||
                (context.triggerHandle === "reconnect" &&
                    triggered(inputs.reconnect))
            ) {
                stop(id);
                s = {
                    id,
                    cfg,
                    context,
                    values: {},
                    queue: [],
                    attempts: 0,
                    connected: false,
                };
                states.set(id, s);
                emit(s, "connected", 0);
                s.context.setNodeStatus?.(false);
                connect(s);
            }
            s.context = context;
            // Startup and persisted inputs never cause remote-control actions.
            const command = commandFor(
                context.triggerHandle,
                inputs[context.triggerHandle],
            );
            if (!command) return {};
            if (!s.connected)
                throw new Error("Magnetar: Nicht verbunden; Befehl verworfen");
            if (s.queue.length >= 16)
                throw new Error(
                    "Magnetar: Befehlswarteschlange voll; Befehl verworfen",
                );
            s.queue.push(command);
            pump(s);
        } catch (error) {
            const message = error.message.startsWith("Magnetar:")
                ? error.message
                : "Magnetar: Verbindungsaufbau fehlgeschlagen";
            if (!s || states.get(id) !== s) {
                s = { context, values: {} };
                emit(s, "connected", 0);
                context.setNodeStatus?.(false);
            }
            report(s, message);
        }
        return {};
    },
    dispose(id) {
        if (id != null) stop(id);
        else for (const key of states.keys()) stop(key);
    },
};
