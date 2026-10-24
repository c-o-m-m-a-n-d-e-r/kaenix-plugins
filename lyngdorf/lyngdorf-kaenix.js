/**
 * @plugin Lyngdorf MP-60
 * @version 1.0.1
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 *
 * MP-60 External Control Manual 2020, TCP port 84.
 * https://lyngdorf.steinwaylyngdorf.com/downloads/lyngdorf-mp-60-external-control-manual/
 */
"use strict";
const net = require("node:net");
const states = new Map();
// Keep the existing writable MP-60 range, expressed in protocol units (0.1 dB).
const MIN_VOLUME = -999;
const MAX_VOLUME = 200;
const VOLUME_RANGE = MAX_VOLUME - MIN_VOLUME;

function percentToVolume(percent) {
    return MIN_VOLUME + Math.round((percent / 100) * VOLUME_RANGE);
}

function volumeToPercent(volume) {
    return (
        Math.round(
            Math.max(
                0,
                Math.min(100, ((volume - MIN_VOLUME) / VOLUME_RANGE) * 100),
            ) * 100,
        ) / 100
    );
}
const queries = [
    "POWER",
    "VOL",
    "MUTE",
    "SRC",
    "RPFOC",
    "RPVOI",
    "AUDMODE",
    "AUDTYPE",
    "VIDTYPE",
];
const statusHandles = [
    "power",
    "volume",
    "mute",
    "source",
    "sourceName",
    "roomPerfect",
    "voicing",
    "audioMode",
    "audioType",
    "videoType",
];

function number(value, min, max, integer = false) {
    if (
        !["number", "string"].includes(typeof value) ||
        String(value).trim() === ""
    )
        return null;
    const n = Number(value);
    return Number.isFinite(n) &&
        n >= min &&
        n <= max &&
        (!integer || Number.isInteger(n))
        ? n
        : null;
}

function options(data) {
    const host = String(data.ip || "").trim();
    const port = number(data.port ?? 84, 1, 65535, true);
    const interval = number(data.interval ?? 10, 2, 300, true);
    const step = number(data.volumeStep ?? 1, 0.1, 10);
    if (
        !net.isIP(host) ||
        port === null ||
        interval === null ||
        step === null
    ) {
        throw new Error(
            "Lyngdorf: IP-Adresse, Port, Intervall oder Schrittweite ungültig",
        );
    }
    return { host, port, interval, step };
}

function emit(s, handle, value) {
    if (s.values[handle] === value) return;
    s.values[handle] = value;
    s.context.emitOutput(handle, value);
}

function report(s, message) {
    emit(s, "error", message);
    s.context.nodeLog?.(message);
    s.context.warn?.(message);
}

function unknown(s) {
    s.context.setNodeStatus?.(false);
    emit(s, "connected", 0);
    for (const handle of statusHandles) emit(s, handle, null);
}

function stop(id) {
    const s = states.get(id);
    if (!s) return;
    states.delete(id);
    clearTimeout(s.retry);
    clearTimeout(s.deadline);
    clearInterval(s.poll);
    s.socket?.destroy();
}

function write(s, command) {
    if (s.socket?.destroyed || !s.transport) return false;
    // Do not grow the TCP write buffer indefinitely on a blocked receiver.
    if (s.socket.writableLength > 8192) {
        s.socket.destroy();
        return false;
    }
    s.socket.write(`${command}\r`);
    return true;
}

function refresh(s) {
    for (const query of queries) write(s, `!${query}?`);
}

function parse(s, line) {
    let match;
    const publish = (handle, value) => {
        s.lastResponse = Date.now();
        clearTimeout(s.deadline);
        s.online = true;
        s.attempts = 0;
        s.context.setNodeStatus?.(true);
        emit(s, "connected", 1);
        // Connection recovery does not confirm a previously sent command.
        if (s.connectionError) {
            s.connectionError = false;
            emit(s, "error", "");
        }
        emit(s, handle, value);
    };
    if ((match = line.match(/^!POWER\(([01])\)$/)))
        publish("power", Number(match[1]));
    else if ((match = line.match(/^!VOL\((-?\d+)\)$/))) {
        const value = number(match[1], -999, 240, true);
        if (value !== null) publish("volume", volumeToPercent(value));
    } else if (/^!MUTE(?:ON|OFF)$/.test(line))
        publish("mute", line === "!MUTEON" ? 1 : 0);
    else if (
        (match = line.match(
            /^!(SRC|RPFOC|RPVOI|AUDMODE)\((\d+)\)(?:["“”](.*)["“”])?$/,
        ))
    ) {
        const handles = {
            SRC: "source",
            RPFOC: "roomPerfect",
            RPVOI: "voicing",
            AUDMODE: "audioMode",
        };
        const value = number(match[2], 0, 65535, true);
        if (value !== null) {
            publish(handles[match[1]], value);
            if (match[1] === "SRC" && match[3] !== undefined)
                publish("sourceName", match[3]);
        }
    } else if ((match = line.match(/^!(AUDTYPE|VIDTYPE)\((.*)\)$/))) {
        publish(match[1] === "AUDTYPE" ? "audioType" : "videoType", match[2]);
    }
}

function connect(s) {
    if (states.get(s.id) !== s) return;
    s.transport = false;
    s.online = false;
    s.connectionError = true;
    s.buffer = "";
    const socket = new net.Socket();
    s.socket = socket;
    const active = () => states.get(s.id) === s && s.socket === socket;
    s.deadline = setTimeout(() => socket.destroy(), 5000);
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.setKeepAlive(true, 10000);
    socket.on("connect", () => {
        if (!active()) return;
        s.transport = true;
        write(s, "!VERB(1)");
        refresh(s);
        clearTimeout(s.deadline);
        s.deadline = setTimeout(() => socket.destroy(), 5000);
        s.lastResponse = Date.now();
        s.poll = setInterval(() => {
            if (Date.now() - s.lastResponse > s.cfg.interval * 2000 + 5000)
                socket.destroy();
            else refresh(s);
        }, s.cfg.interval * 1000);
        s.poll.unref?.();
    });
    socket.on("data", (chunk) => {
        if (!active()) return;
        s.buffer += chunk.toString("utf8");
        // CR-delimited messages may be fragmented or combined in any TCP packet.
        let index;
        while ((index = s.buffer.indexOf("\r")) !== -1) {
            const line = s.buffer.slice(0, index).replace(/^\n/, "");
            s.buffer = s.buffer.slice(index + 1);
            if (line.length > 4096) {
                socket.destroy();
                return;
            }
            parse(s, line);
        }
        if (s.buffer.length > 4096) socket.destroy();
    });
    socket.on("error", () => {}); // close handles errors without exposing network internals.
    socket.on("close", () => {
        if (!active()) return;
        s.transport = false;
        s.online = false;
        clearTimeout(s.deadline);
        clearInterval(s.poll);
        unknown(s);
        s.connectionError = true;
        report(
            s,
            "Lyngdorf: Verbindung unterbrochen; erneuter Verbindungsversuch folgt",
        );
        const delay = Math.min(60000, 2000 * 2 ** Math.min(s.attempts++, 5));
        s.retry = setTimeout(() => connect(s), delay);
        s.retry.unref?.();
    });
    socket.connect(s.cfg.port, s.cfg.host);
}

function command(s, handle, value) {
    const triggers = {
        volumeInc: "!VOL+",
        volumeDec: "!VOL-",
        muteToggle: "!MUTE",
        sourceNext: "!SRC+",
        sourcePrev: "!SRC-",
    };
    const isTrigger = [true, 1, "1"].includes(value);
    let cmd;
    if (handle === "triggerStatus") {
        if (isTrigger && s.transport) refresh(s);
        return;
    }
    if (handle in triggers) {
        if (!isTrigger) return;
        cmd = triggers[handle];
        if (handle === "volumeInc" || handle === "volumeDec")
            cmd += `(${Math.round((s.cfg.step / 100) * VOLUME_RANGE)})`;
    } else if (handle === "power" || handle === "mute") {
        if (![true, false, 0, 1, "0", "1"].includes(value))
            throw new Error("Lyngdorf: Ein/Aus und Stumm erwarten 0 oder 1");
        const on = [true, 1, "1"].includes(value);
        cmd =
            handle === "power"
                ? on
                    ? "!POWERONMAIN"
                    : "!POWEROFFMAIN"
                : on
                  ? "!MUTEON"
                  : "!MUTEOFF";
    } else if (handle === "volume") {
        const n = number(value, 0, 100);
        if (n === null)
            throw new Error("Lyngdorf: Lautstärke erwartet 0 bis 100 %");
        cmd = `!VOL(${percentToVolume(n)})`;
    } else if (
        ["source", "roomPerfect", "voicing", "audioMode"].includes(handle)
    ) {
        const n = number(value, 0, 65535, true);
        if (
            n === null ||
            (handle === "roomPerfect" && ![0, 1, 2, 3, 4, 9].includes(n))
        )
            throw new Error(
                "Lyngdorf: Ungültige Quellen-, RoomPerfect-, Voicing- oder Audiomodus-ID",
            );
        const names = {
            source: "SRC",
            roomPerfect: "RPFOC",
            voicing: "RPVOI",
            audioMode: "AUDMODE",
        };
        cmd = `!${names[handle]}(${n})`;
    } else return;
    if (!s.online || !write(s, cmd))
        throw new Error("Lyngdorf: Nicht verbunden; Befehl verworfen");
    emit(s, "error", "");
    refresh(s);
}

module.exports = {
    type: "lyngdorf",
    label: "Lyngdorf MP-60",
    category: "Geräte",
    color: "#f97316",
    description:
        "Lyngdorf MP-60: Hauptzone über TCP mit Power, Lautstärke, Quellen und RoomPerfect steuern",
    inputs: [
        { handle: "power", label: "Ein/Aus (1/0)" },
        { handle: "volume", label: "Lautstärke (0–100 %)" },
        { handle: "volumeInc", label: "Lauter (Trigger)" },
        { handle: "volumeDec", label: "Leiser (Trigger)" },
        { handle: "mute", label: "Stumm (0/1)" },
        { handle: "muteToggle", label: "Stumm umschalten (Trigger)" },
        { handle: "source", label: "Quellen-ID (ab 0)" },
        { handle: "sourceNext", label: "Nächste Quelle (Trigger)" },
        { handle: "sourcePrev", label: "Vorherige Quelle (Trigger)" },
        {
            handle: "roomPerfect",
            label: "RoomPerfect (0=Bypass, 1–4=Fokus, 9=Global)",
        },
        { handle: "voicing", label: "Voicing-ID (ab 0)" },
        { handle: "audioMode", label: "Audiomodus-ID (ab 0)" },
        { handle: "triggerStatus", label: "Status abfragen (Trigger)" },
        { handle: "reconnect", label: "Neu verbinden" },
    ],
    outputs: [
        { handle: "connected", label: "Geräteverbindung (1/0)" },
        { handle: "power", label: "Ein/Aus (1/0)" },
        { handle: "volume", label: "Lautstärke (0–100 %)" },
        { handle: "mute", label: "Stumm (0/1)" },
        { handle: "source", label: "Aktive Quellen-ID" },
        { handle: "sourceName", label: "Aktiver Quellenname" },
        { handle: "roomPerfect", label: "Aktive RoomPerfect-Position" },
        { handle: "voicing", label: "Aktive Voicing-ID" },
        { handle: "audioMode", label: "Aktive Audiomodus-ID" },
        { handle: "audioType", label: "Audio-Signalformat" },
        { handle: "videoType", label: "Video-Signalformat" },
        { handle: "error", label: "Fehler" },
    ],
    config: [
        {
            key: "ip",
            label: "IP-Adresse",
            type: "text",
            placeholder: "192.168.1.60",
        },
        { key: "port", label: "TCP-Port", type: "number", default: 84 },
        {
            key: "interval",
            label: "Statusintervall in Sekunden (2–300)",
            type: "number",
            default: 10,
        },
        {
            key: "volumeStep",
            label: "Lautstärkeschritt in Prozentpunkten (0,1–10)",
            type: "number",
            default: 1,
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
                    [true, 1, "1"].includes(inputs.reconnect))
            ) {
                stop(id);
                s = { id, cfg, context, values: {}, attempts: 0 };
                states.set(id, s);
                unknown(s);
                connect(s);
            }
            s.context = context;
            // Only the arriving telegram is a command; startup and saved inputs are not.
            command(s, context.triggerHandle, inputs[context.triggerHandle]);
        } catch (error) {
            const message = error.message.startsWith("Lyngdorf:")
                ? error.message
                : "Lyngdorf: Verbindung konnte nicht gestartet werden";
            if (s && states.get(id) === s) report(s, message);
            else {
                const failed = { context, values: {} };
                unknown(failed);
                report(failed, message);
            }
        }
        return {};
    },
    dispose(id) {
        if (id != null) stop(id);
        else for (const key of states.keys()) stop(key);
    },
};
