/**
 * @plugin    BWM – Bewegungsmelder mit Helligkeits- & Nachlaufsteuerung
 * @version   1.0.4
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 *
 * Portierung des Python-Logikbausteins "BWM" (v0.67) für kaenix.
 *
 * Eingänge:
 *   trigger         – Bewegungsmelder-Impuls (1 = Bewegung erkannt)
 *   helligkeit      – Aktueller Helligkeitswert (Lux o.ä.)
 *   schwelle        – Optional; nach erstem Telegramm nur bei Helligkeit ≤ Schwelle einschalten
 *   nachlaufzeit    – Nachlaufzeit in Minuten
 *   freigabe        – Freigabe (1 = aktiv)
 *   grundbeleuchtung – Grundbeleuchtung nach Ablauf aktivieren (1 = ja)
 *
 * Ausgänge:
 *   an_aus          – An / Aus  (1 / 0)
 *   an              – Einschalt-Impuls (1 bei jedem Einschalten)
 *   aus             – Ausschalt-Telegramm (0 bei jedem Ausschalten)
 *   grund           – Grundbeleuchtung aktiv (1)
 *   aktiv           – Läuft gerade (1 = Nachlauf läuft)
 *   restzeit        – Verbleibende Nachlaufzeit in Sekunden
 */

const _states = {};
const inputSettings = [
    ["helligkeit", null, parseFloat],
    ["schwelle", null, parseFloat],
    ["nachlaufzeit", "nachlaufzeitDefault", parseFloat],
    ["freigabe", "freigabeDefault", parseBinaryInput],
    ["grundbeleuchtung", "grundDefault", parseBinaryInput],
];

function configuredValue(data, key, parse) {
    const value = key && data[key];
    if (value == null || value === "" || !key) return NaN;
    return parse(value);
}

function hasInputValue(s, data, handle) {
    const [, key, parse] = inputSettings.find(([name]) => name === handle);
    return (
        Number.isFinite(s[handle]) ||
        Number.isFinite(configuredValue(data, key, parse))
    );
}

function resumeTrigger(s) {
    clearTimeout(s.readTimer);
    s.readTimer = null;
    const pending = s.pendingTrigger;
    s.pendingTrigger = null;
    s.waitingInputs.clear();
    if (pending)
        module.exports.execute({ trigger: 1 }, pending.data, pending.context);
}

function parseBinaryInput(value) {
    // KNX- und Logikeingänge liefern sowohl boolesche als auch numerische Werte.
    return typeof value === "boolean" ? Number(value) : parseFloat(value);
}

function getState(nodeId) {
    if (!_states[nodeId]) {
        _states[nodeId] = {
            timer: null, // setTimeout-Handle für Ablauf
            interval: null, // setInterval-Handle für Restzeit
            endsAt: 0, // Timestamp des Timer-Endes
            isRunning: false,
            // gespeicherte Eingangswerte für Inputs 2–6
            helligkeit: NaN,
            schwelle: null,
            nachlaufzeit: NaN, // Minuten; bis zum ersten Telegramm gilt die Konfiguration
            freigabe: NaN,
            grundbeleuchtung: NaN,
            requestedInputs: new Set(),
            waitingInputs: new Set(),
            readingInputs: false,
            pendingTrigger: null,
            readTimer: null,
        };
    }
    return _states[nodeId];
}

function clearTimer(s) {
    if (s.timer) {
        clearTimeout(s.timer);
        s.timer = null;
    }
    if (s.interval) {
        clearInterval(s.interval);
        s.interval = null;
    }
    s.endsAt = 0;
    s.isRunning = false;
}

module.exports = {
    type: "bwm",
    category: "Automatisierung",
    label: "BWM",
    description:
        "Bewegungsmelder mit Helligkeitsschwelle, Nachlaufzeit und Grundbeleuchtung",
    color: "#0ea5e9",

    inputs: [
        { handle: "trigger", label: "Trigger" },
        { handle: "helligkeit", label: "Helligkeit" },
        { handle: "schwelle", label: "Schwelle" },
        { handle: "nachlaufzeit", label: "Nachlaufzeit (Min.)" },
        { handle: "freigabe", label: "Freigabe" },
        { handle: "grundbeleuchtung", label: "Grundbeleuchtung" },
    ],

    outputs: [
        { handle: "an_aus", label: "An / Aus" },
        { handle: "an", label: "An" },
        { handle: "aus", label: "Aus" },
        { handle: "grund", label: "Grund" },
        { handle: "aktiv", label: "Aktiv" },
        { handle: "restzeit", label: "Restzeit (Sek.)" },
    ],

    config: [
        {
            key: "nachlaufzeitDefault",
            label: "Nachlaufzeit in Minuten",
            type: "number",
            placeholder: "1",
        },
        {
            key: "freigabeDefault",
            label: "Freigabe beim Start (1/0)",
            type: "number",
            placeholder: "1",
        },
        {
            key: "grundDefault",
            label: "Grundbeleuchtung beim Start (1/0)",
            type: "number",
            placeholder: "0",
        },
    ],

    dispose(nodeId) {
        for (const id of nodeId == null ? Object.keys(_states) : [nodeId]) {
            const s = _states[id];
            if (!s) continue;
            clearTimer(s);
            clearTimeout(s.readTimer);
            delete _states[id];
        }
    },

    execute(inputs, data, context) {
        const nodeId = context.nodeId || "default";
        const s = getState(nodeId);

        // Nur tatsächlich vorhandene Werte speichern; 0 und false sind gültig.
        const currentInputs = { ...context.initialInputs, ...inputs };
        for (const [handle, , parse] of inputSettings) {
            if (currentInputs[handle] == null || currentInputs[handle] === "")
                continue;
            if (
                handle === "schwelle" &&
                context.triggerHandle != null &&
                !["schwelle", "_config"].includes(context.triggerHandle)
            )
                continue;
            const value = parse(currentInputs[handle]);
            if (Number.isFinite(value)) s[handle] = value;
        }

        if (
            !s.pendingTrigger &&
            !s.readingInputs &&
            s.waitingInputs.size &&
            [...s.waitingInputs].every((handle) =>
                hasInputValue(s, data, handle),
            )
        ) {
            resumeTrigger(s);
        }

        if (s.pendingTrigger) {
            // Während der Abfrage weitere Einschalttrigger zusammenfassen.
            if (
                context.triggerHandle === "trigger" &&
                parseBinaryInput(inputs.trigger) === 1
            ) {
                s.pendingTrigger = { data, context };
            }
            if (
                !s.readingInputs &&
                [...s.waitingInputs].every((handle) =>
                    hasInputValue(s, data, handle),
                )
            ) {
                resumeTrigger(s);
            }
            return {};
        }

        // Nur ein echtes Trigger-Telegramm startet die einmalige Eingangsabfrage.
        if (
            context.triggerHandle != null &&
            context.triggerHandle !== "trigger"
        )
            return {};
        if (context.initialInputs || inputs.trigger == null) return {};
        const triggerVal = parseBinaryInput(inputs.trigger);
        if (triggerVal !== 0 && triggerVal !== 1) return {};
        if (s.waitingInputs.size && triggerVal === 1) {
            s.pendingTrigger = { data, context };
            return {};
        }

        const missing = inputSettings
            .map(([handle]) => handle)
            .filter(
                (handle) =>
                    !hasInputValue(s, data, handle) &&
                    !s.requestedInputs.has(handle),
            );
        if (missing.length && typeof context.requestInputReads === "function") {
            for (const handle of missing) s.requestedInputs.add(handle);
            s.pendingTrigger = triggerVal === 1 ? { data, context } : null;
            s.readingInputs = true;
            let requested;
            try {
                requested = context.requestInputReads(missing);
            } catch (error) {
                context.warn?.(error);
                requested = [];
            } finally {
                s.readingInputs = false;
            }
            s.waitingInputs = new Set(
                (requested || []).filter(
                    (handle) =>
                        missing.includes(handle) &&
                        !hasInputValue(s, data, handle),
                ),
            );
            if (s.waitingInputs.size) {
                // Nicht antwortende Geräte dürfen den Baustein nicht dauerhaft blockieren.
                s.readTimer = setTimeout(() => resumeTrigger(s), 1000);
                return {};
            }
            s.pendingTrigger = null;
        }
        if (triggerVal !== 1) return {};

        // Explizite Startwerte zählen als vorhandene Werte; implizite Fallbacks nicht.
        const resolve = (handle, key, parse, fallback) => {
            if (Number.isFinite(s[handle])) return s[handle];
            const configured = configuredValue(data, key, parse);
            return Number.isFinite(configured) ? configured : fallback;
        };
        const schwelle = s.schwelle;
        const nachlauf = resolve(
            "nachlaufzeit",
            "nachlaufzeitDefault",
            parseFloat,
            1,
        );
        const freigabe = resolve(
            "freigabe",
            "freigabeDefault",
            parseBinaryInput,
            1,
        );
        const grundEnable = resolve(
            "grundbeleuchtung",
            "grundDefault",
            parseBinaryInput,
            0,
        );
        const helligkeit = Number.isFinite(s.helligkeit) ? s.helligkeit : 0;

        // ── Trigger ausgelöst ─────────────────────────────────────────────────
        if (!freigabe) {
            context.nodeLog("⛔ Freigabe inaktiv");
            return {};
        }

        if (schwelle != null && helligkeit > schwelle) {
            context.nodeLog(
                `☀️ Zu hell (${helligkeit} > ${schwelle}) – kein Einschalten`,
            );
            return {};
        }

        // Nachlaufzeit berechnen (Minuten → Sekunden)
        const sekunden = Math.max(1, Math.round(nachlauf * 60));

        if (s.isRunning) {
            // Timer verlängern + erneut Ein-Signal senden
            clearTimeout(s.timer);
            s.endsAt = Date.now() + sekunden * 1000;
            s.timer = setTimeout(finish, sekunden * 1000);
            context.emitOutput("restzeit", sekunden);
            context.emitOutput("an", 1);
            context.nodeLog(`🔄 Nachläuft – Timer verlängert auf ${sekunden}s`);
            return {};
        }

        // ── Neu starten ───────────────────────────────────────────────────────
        clearTimer(s);
        s.isRunning = true;
        s.endsAt = Date.now() + sekunden * 1000;

        context.emitOutput("an_aus", 1);
        context.emitOutput("an", 1);
        context.emitOutput("aktiv", 1);
        context.emitOutput("restzeit", sekunden);
        context.nodeLog(`▶ gestartet – ${sekunden}s Nachlaufzeit`);

        // Restzeit sekündlich ausgeben + im Baustein anzeigen
        s.interval = setInterval(() => {
            const rest = Math.max(
                0,
                Math.round((s.endsAt - Date.now()) / 1000),
            );
            context.emitOutput("restzeit", rest);
            context.nodeLog(`⏱ ${rest}s`);
        }, 1000);

        // Nach Ablauf: Aus oder Grundbeleuchtung
        function finish() {
            clearTimer(s);

            context.emitOutput("aktiv", 0);
            context.emitOutput("restzeit", 0);

            if (grundEnable && (schwelle == null || helligkeit < schwelle)) {
                // Grundbeleuchtung aktivieren statt vollständig ausschalten
                context.emitOutput("an_aus", 0);
                context.emitOutput("grund", 1);
                context.nodeLog("🌙 Grundbeleuchtung aktiv");
            } else {
                context.emitOutput("an_aus", 0);
                context.emitOutput("aus", 0);
                context.nodeLog("⏹ Aus");
            }
        }
        s.timer = setTimeout(finish, sekunden * 1000);

        return {};
    },
};
