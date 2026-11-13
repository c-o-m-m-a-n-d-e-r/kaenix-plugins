/**
 * @plugin    Scaler
 * @version   1.0.1
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */
module.exports = {
    translations: {
        de: {
            native_value: "Wert",
            sch_widget_value: "Wert",
            dash_col_value: "Wert",
            addr_value_placeholder: "Wert",
            sch_col_value: "Wert",
            scn_action_value: "Wert",
            ui_in_57: "in",
            ui_out: "out",
            ui_nachkommastellen: "Nachkommastellen",
            common_logic_math: "Mathematik",
            logic_result: "Ergebnis",
            logic_convert_number: "number",
            hvac_value: "Wert",
            history_value_axis: "Wert",
        },
        en: {
            native_value: "Value",
            sch_widget_value: "Value",
            dash_col_value: "Value",
            addr_value_placeholder: "Value",
            sch_col_value: "Value",
            scn_action_value: "Value",
            ui_in_57: "in",
            ui_out: "out",
            ui_nachkommastellen: "Decimal places",
            common_logic_math: "Math",
            logic_result: "Result",
            logic_convert_number: "Number",
            hvac_value: "Value",
            history_value_axis: "Value",
        },
    },
    type: "scaler",
    category: "Mathematik",
    label: "Scaler",
    description: "Skaliert einen Wert: (in × Faktor) + Offset",
    color: "#0d9488",

    inputs: [{ handle: "in", label: "Wert" }],
    outputs: [{ handle: "out", label: "Ergebnis" }],

    config: [
        { key: "factor", label: "Faktor", type: "number" },
        { key: "offset", label: "Offset", type: "number" },
        { key: "digits", label: "Nachkommastellen", type: "number" },
    ],

    execute(inputs, data, context) {
        const val = parseFloat(inputs.in ?? 0);
        const factor = parseFloat(data.factor ?? 1);
        const offset = parseFloat(data.offset ?? 0);
        const digits = parseInt(data.digits ?? 1, 10);

        const result = parseFloat((val * factor + offset).toFixed(digits));
        context.log(`${val} × ${factor} + ${offset} = ${result}`);
        return result;
    },
};
