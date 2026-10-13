/**
 * @plugin Zentral
 * @version 1.0.0
 * @author Christian Brauwers
 */
const schemas = {
    switch: [
        [
            "switch",
            "ui_schalten",
            "group_address",
            "feedback_address",
            "DPT1.001",
        ],
    ],
    button: [
        [
            "switch",
            "ui_schalten",
            "group_address",
            "feedback_address",
            "DPT1.001",
        ],
    ],
    dimmer: [
        ["switch", "ui_schalten", "gaSwitch", "gaSwitchFb", "DPT1.001"],
        [
            "brightness",
            "ui_helligkeit",
            "group_address",
            "feedback_address",
            "DPT5.001",
        ],
    ],
    blinds: [
        ["move", "ui_fahren_auf_ab", "group_address", null, "DPT1.008"],
        ["stop", "ui_stopp", "gaStop", null, "DPT1.010"],
        [
            "position",
            "ui_position_setzen",
            "gaPosition",
            "feedback_address",
            "DPT5.001",
        ],
        ["slat", "ui_lamellen_setzen", "gaSlat", "gaSlatFb", "DPT5.001"],
    ],
    slider: [
        [
            "value",
            "sch_widget_value",
            "group_address",
            "feedback_address",
            "DPT9.001",
        ],
    ],
    number: [["value", "sch_widget_value", null, "group_address", "DPT9.001"]],
    text: [["value", "ui_text", null, "group_address", "DPT16.000"]],
    status: [
        ["status", "ui_status_icon", null, "feedback_address", "DPT1.001"],
    ],
    menu: [["status", "ui_status_icon", null, "gaStatus", "DPT1.001"]],
    temperature: [
        ["temperature", "ui_temperatur", null, "group_address", "DPT9.001"],
        [
            "setpoint",
            "ui_sollwert_setzen",
            "gaSetpoint",
            "gaSetpointFb",
            "DPT9.001",
        ],
        [
            "mode",
            "ui_hvac_modus_setzen",
            "gaHvacMode",
            "gaHvacModeFb",
            "DPT20.102",
        ],
    ],
    climate: [
        ["power", "climate_power_command", "gaPower", "gaPowerFb", "DPT1.001"],
        [
            "mode",
            "climate_mode_command",
            "gaHvacMode",
            "gaHvacModeFb",
            "DPT20.105",
        ],
    ],
    color: [
        ["switch", "ui_schalten", "gaSwitch", "gaSwitchFb", "DPT1.001"],
        [
            "brightness",
            "ui_helligkeit",
            "gaBrightness",
            "gaBrightnessFb",
            "DPT5.001",
        ],
        [
            "temperature",
            "ui_farbtemperatur_setzen",
            "gaColorTemp",
            "gaColorTempFb",
            "DPT7.600",
        ],
        [
            "color",
            "ui_farbe_setzen",
            "group_address",
            "feedback_address",
            "DPT232.600",
        ],
    ],
    scene: [["scene", "ui_szene_aufrufen", "group_address", null, "DPT17.001"]],
    media: [
        ["play", "ui_play_pause", "gaPlay", "gaPlayFb", "DPT1.001"],
        ["stop", "ui_stopp", "gaStop", null, "DPT1.001"],
        ["next", "ui_nachster_titel_vorwarts", "gaNext", null, "DPT1.001"],
        ["previous", "ui_vorheriger_titel_zuruck", "gaPrev", null, "DPT1.001"],
        ["mute", "ui_stummschaltung_mute", "gaMute", "gaMuteFb", "DPT1.001"],
        ["power", "ui_power_ein_aus", "gaPower", "gaPowerFb", "DPT1.001"],
        [
            "volume",
            "ui_lautstarke_setzen",
            "gaVolume",
            "gaVolumeFb",
            "DPT5.001",
        ],
    ],
};

function widgets(data, helpers, refresh = false) {
    const ids = new Set(
        (Array.isArray(data.widgetIds) ? data.widgetIds : []).map(String),
    );
    if (!ids.size) return [];
    return (helpers.getCentralWidgets?.(refresh) || []).filter(
        (w) => w.type === data.widgetCategory && ids.has(String(w.id)),
    );
}
function address(widget, field) {
    if (!field) return null;
    return field.includes("_address") ? widget[field] : widget.config?.[field];
}
function feedback(widget, port) {
    if (
        ["number", "text", "temperature"].includes(widget.type) &&
        port[3] === "group_address"
    )
        return widget.feedback_address || widget.group_address;
    if (widget.type === "status")
        return widget.feedback_address || widget.config?.gaStatus;
    if (widget.type === "media" && port[0] === "play")
        return (
            widget.config?.gaPlayFb ||
            widget.feedback_address ||
            widget.config?.gaPlay ||
            widget.group_address
        );
    return address(widget, port[3]) || address(widget, port[2]);
}
function valid(value, dpt) {
    if (/^DPT1\./.test(dpt))
        return [0, 1, false, true, "0", "1"].includes(value);
    if (/^DPT232\./.test(dpt))
        return (
            value &&
            ["red", "green", "blue"].every(
                (k) =>
                    Number.isInteger(value[k]) &&
                    value[k] >= 0 &&
                    value[k] <= 255,
            )
        );
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (dpt === "DPT5.001") return value >= 0 && value <= 100;
    if (/^DPT5\./.test(dpt))
        return Number.isInteger(value) && value >= 0 && value <= 255;
    if (/^DPT7\./.test(dpt))
        return Number.isInteger(value) && value >= 0 && value <= 65535;
    if (/^DPT(?:17|20)\./.test(dpt))
        return (
            Number.isInteger(value) &&
            value >= 0 &&
            value <= (dpt.startsWith("DPT17.") ? 63 : 255)
        );
    return true;
}

module.exports = {
    type: "zentral",
    category: "Automatisierung",
    label: "Zentral",
    description:
        "Steuert ausgewählte Widgets einer Kategorie gemeinsam und fasst deren Rückmeldungen zusammen.",
    color: "#f59e0b",
    inputs: [],
    outputs: [],
    watchesKnxBus: true,
    watchesLocalKnxWrites: true,
    config: [
        {
            key: "widgetCategory",
            label: "central_category",
            type: "select",
            default: "switch",
            options: [
                { value: "switch", label: "ui_schalter" },
                { value: "button", label: "ui_taster" },
                { value: "dimmer", label: "ui_dimmer" },
                { value: "blinds", label: "central_blinds" },
                { value: "slider", label: "ui_wertgeber" },
                { value: "number", label: "ui_messwert" },
                { value: "text", label: "ui_text" },
                { value: "status", label: "ui_status_icon" },
                { value: "menu", label: "ui_menu_link" },
                { value: "temperature", label: "ui_temperatur" },
                { value: "climate", label: "climate_title" },
                { value: "color", label: "ui_colorpicker" },
                { value: "scene", label: "scn_number_short" },
                { value: "media", label: "ui_musik_player" },
            ],
        },
        {
            key: "widgetIds",
            label: "central_widgets",
            type: "category-widget-checklist",
        },
    ],
    dynamicInputs(data) {
        const ports = {
            switch: [{ handle: "switch", label: "ui_schalten" }],
            button: [{ handle: "switch", label: "ui_schalten" }],
            dimmer: [
                { handle: "switch", label: "ui_schalten" },
                { handle: "brightness", label: "ui_helligkeit" },
            ],
            blinds: [
                { handle: "move", label: "ui_fahren_auf_ab" },
                { handle: "stop", label: "ui_stopp" },
                { handle: "position", label: "ui_position_setzen" },
                { handle: "slat", label: "ui_lamellen_setzen" },
            ],
            slider: [{ handle: "value", label: "sch_widget_value" }],
            number: [],
            text: [],
            status: [],
            menu: [],
            temperature: [
                { handle: "setpoint", label: "ui_sollwert_setzen" },
                { handle: "mode", label: "ui_hvac_modus_setzen" },
            ],
            climate: [
                { handle: "power", label: "climate_power_command" },
                { handle: "mode", label: "climate_mode_command" },
            ],
            color: [
                { handle: "switch", label: "ui_schalten" },
                { handle: "brightness", label: "ui_helligkeit" },
                { handle: "temperature", label: "ui_farbtemperatur_setzen" },
                { handle: "color", label: "ui_farbe_setzen" },
            ],
            scene: [{ handle: "scene", label: "ui_szene_aufrufen" }],
            media: [
                { handle: "play", label: "ui_play_pause" },
                { handle: "stop", label: "ui_stopp" },
                { handle: "next", label: "ui_nachster_titel_vorwarts" },
                { handle: "previous", label: "ui_vorheriger_titel_zuruck" },
                { handle: "mute", label: "ui_stummschaltung_mute" },
                { handle: "power", label: "ui_power_ein_aus" },
                { handle: "volume", label: "ui_lautstarke_setzen" },
            ],
        };
        return ports[data?.widgetCategory] || [];
    },
    dynamicOutputs(data) {
        const ports = {
            switch: [{ handle: "switch", label: "ui_schalten" }],
            button: [{ handle: "switch", label: "ui_schalten" }],
            dimmer: [
                { handle: "switch", label: "ui_schalten" },
                { handle: "brightness", label: "ui_helligkeit" },
            ],
            blinds: [
                { handle: "position", label: "ui_position_setzen" },
                { handle: "slat", label: "ui_lamellen_setzen" },
            ],
            slider: [{ handle: "value", label: "sch_widget_value" }],
            number: [{ handle: "value", label: "sch_widget_value" }],
            text: [{ handle: "value", label: "ui_text" }],
            status: [{ handle: "status", label: "ui_status_icon" }],
            menu: [{ handle: "status", label: "ui_status_icon" }],
            temperature: [
                { handle: "temperature", label: "ui_temperatur" },
                { handle: "setpoint", label: "ui_sollwert_setzen" },
                { handle: "mode", label: "ui_hvac_modus_setzen" },
            ],
            climate: [
                { handle: "power", label: "climate_power_command" },
                { handle: "mode", label: "climate_mode_command" },
            ],
            color: [
                { handle: "switch", label: "ui_schalten" },
                { handle: "brightness", label: "ui_helligkeit" },
                { handle: "temperature", label: "ui_farbtemperatur_setzen" },
                { handle: "color", label: "ui_farbe_setzen" },
            ],
            scene: [],
            media: [
                { handle: "play", label: "ui_play_pause" },
                { handle: "mute", label: "ui_stummschaltung_mute" },
                { handle: "power", label: "ui_power_ein_aus" },
                { handle: "volume", label: "ui_lautstarke_setzen" },
            ],
        };
        return ports[data?.widgetCategory] || [];
    },
    getWatchedAddresses(data, helpers) {
        return new Set(
            widgets(data, helpers)
                .flatMap((w) =>
                    (schemas[data.widgetCategory] || [])
                        .filter((p) => p[3])
                        .map((p) => feedback(w, p)),
                )
                .filter(Boolean),
        );
    },
    execute(inputs, data, context) {
        const selected = widgets(
            data,
            context,
            !context.initialInputs &&
                ![undefined, "_knxEvent"].includes(context.triggerHandle),
        );
        const ports = schemas[data.widgetCategory] || [];
        const command = ports.find(
            (p) => p[0] === context.triggerHandle && p[2],
        );
        if (command && !context.initialInputs) {
            const sent = new Set();
            for (const widget of selected) {
                // A feedback address must never be used as a command address.
                const target =
                    address(widget, command[2]) ||
                    (widget.type === "media" && command[0] === "play"
                        ? widget.group_address
                        : null);
                if (!target || sent.has(target)) continue;
                if (
                    widget.type === "climate" &&
                    command[0] === "mode" &&
                    widget.config?.hvacSetMissing
                )
                    continue;
                const dpt =
                    context.getCentralDpt(target) ||
                    (widget.type === "climate" && command[0] === "mode"
                        ? widget.config?.hvacDpt
                        : null) ||
                    (command[2] === "group_address" && widget.type !== "blinds"
                        ? widget.config?.dpt
                        : null) ||
                    command[4];
                const value = inputs[command[0]];
                if (!valid(value, dpt)) {
                    context.warn(
                        `Ungültiger Eingangswert für die Gruppenadresse ${target}`,
                    );
                    continue;
                }
                sent.add(target);
                context.writeCentralAddress(
                    target,
                    /^DPT1\./.test(dpt) ? Number(value) : value,
                    dpt,
                );
            }
        }
        const outputs = {};
        for (const port of ports.filter((p) => p[3])) {
            const values = selected
                .map((w) => context.readCentralAddress(feedback(w, port)))
                .filter((v) => v !== undefined && v !== null);
            if (!values.length) continue;
            // Boolean status: any active. Numeric status: mean. Modes/text/color:
            // publish only when all known values agree, avoiding invented modes.
            if (/^DPT1\./.test(port[4]))
                outputs[port[0]] = values.some((v) =>
                    [true, 1, "1"].includes(v),
                )
                    ? 1
                    : 0;
            else if (
                /^DPT(?:5|7|9)\./.test(port[4]) &&
                values.every((v) => typeof v === "number" && Number.isFinite(v))
            )
                outputs[port[0]] =
                    values.reduce((a, b) => a + b, 0) / values.length;
            else if (
                values.every(
                    (v) => JSON.stringify(v) === JSON.stringify(values[0]),
                )
            )
                outputs[port[0]] = values[0];
        }
        return outputs;
    },
};
