/**
 * @plugin    Hyseresis
 * @version   1.0.1
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */
const states = {};

module.exports = {
    translations: {
        de: {
            ui_in_57: "in",
            ui_out: "out",
            ui_messwert: "Messwert",
            ui_ein_aus: "Ein/Aus",
            logic_category: "Logik",
            logic_convert_number: "number",
        },
        en: {
            ui_in_57: "in",
            ui_out: "out",
            ui_messwert: "Measurement",
            ui_ein_aus: "On/off",
            logic_category: "Logic",
            logic_convert_number: "Number",
        },
    },
    type: "hysteresis",
    category: "Logik",
    label: "Hysterese",
    description: "Schaltet mit Totband (Zweipunktregelung)",
    color: "#7c3aed",

    inputs: [{ handle: "in", label: "Messwert" }],
    outputs: [{ handle: "out", label: "Ein/Aus" }],

    config: [
        { key: "low", label: "Untere Schwelle (Einschalten)", type: "number" },
        { key: "high", label: "Obere Schwelle (Ausschalten)", type: "number" },
    ],

    execute(inputs, data, context) {
        const val = parseFloat(inputs.in ?? 0);
        const low = parseFloat(data.low ?? 19);
        const high = parseFloat(data.high ?? 21);

        // Node-ID ist nicht direkt verfügbar, daher über inputs-Referenz als Schlüssel
        // (In der Praxis: separater State pro Instanz durch Plugin-Loader gewährleistet)
        const key = `${low}_${high}`;
        let state = states[key] ?? false;

        if (val <= low) state = true; // Unter Untergrenze → einschalten
        if (val >= high) state = false; // Über Obergrenze   → ausschalten

        states[key] = state;
        context.log(`${val} [${low}…${high}] → ${state ? "EIN" : "AUS"}`);
        return state;
    },
};
