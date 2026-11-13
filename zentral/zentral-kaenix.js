/**
 * @plugin Zentral
 * @version 1.0.2
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

// Category-specific keys prevent old presets from controlling a different widget type.
function presetKey(category, handle) {
    return `preset_${category}_${handle}`;
}
function inputValue(inputs, data, port) {
    const value =
        inputs[port[0]] ?? data[presetKey(data.widgetCategory, port[0])];
    if (port[4] === "DPT232.600" && typeof value === "string") {
        try {
            return JSON.parse(value);
        } catch (_) {
            return undefined;
        }
    }
    return value;
}
function presetFields() {
    return Object.entries(schemas).flatMap(([category, ports]) =>
        ports
            .filter((port) => port[2])
            .map(([handle, label, , , dpt]) => ({
                key: presetKey(category, handle),
                label: dpt === "DPT232.600" ? "central_preset_color" : label,
                type: dpt === "DPT232.600" ? "text" : "number",
                ...(/^DPT1\./.test(dpt) ? { min: 0, max: 1 } : {}),
                ...(dpt === "DPT5.001" ? { min: 0, max: 100 } : {}),
                ...(/^DPT7\./.test(dpt) ? { min: 0, max: 65535 } : {}),
                ...(/^DPT17\./.test(dpt) ? { min: 0, max: 63 } : {}),
                ...(/^DPT20\./.test(dpt) ? { min: 0, max: 255 } : {}),
                visibleWhen: { widgetCategory: [category] },
            })),
    );
}

module.exports = {
    translations: {
        de: {
            central_title: "Zentral",
            central_description:
                "Steuert ausgewählte Widgets einer Kategorie gemeinsam und fasst deren Rückmeldungen zusammen.",
            central_presets_description:
                "Steuert ausgewählte Widgets einer Kategorie gemeinsam und fasst deren Rückmeldungen zusammen. Eingabefelder sind optionale Vorgaben. Beim Einschalten (Schalten, Power oder Play = 1) werden vorbelegte Parameter mitgesendet; empfangene Eingangswerte haben Vorrang. Leere Felder bleiben unberücksichtigt.",
            central_preset_color:
                'Farbe (RGB-JSON, z. B. {"red":255,"green":0,"blue":0})',
            central_category: "Widgetkategorie",
            central_widgets: "Widgets",
            central_widget_search: "Widgets nach Name oder Seite suchen …",
            central_widget_search_empty: "Keine passenden Widgets gefunden.",
            central_blinds: "Jalousien",
            central_choose_category:
                "Bitte zuerst eine Widgetkategorie wählen.",
            central_load_error: "Widgets konnten nicht geladen werden.",
            central_no_widgets: "Keine Widgets in dieser Kategorie vorhanden.",
            central_feedback_hint:
                "Status: mindestens eines aktiv. Zahlen: Mittelwert. Andere Werte: nur bei Übereinstimmung.",
            central_invalid_value:
                "Ungültiger Eingangswert für die Gruppenadresse {{address}}",
            sch_widget_value: "Wert",
            scn_number_short: "Szene",
            ui_helligkeit: "Helligkeit",
            ui_temperatur: "Temperatur",
            ui_power_ein_aus: "Power Ein/Aus",
            ui_stopp: "Stopp",
            ui_schalter: "Schalter",
            ui_dimmer: "Dimmer",
            ui_messwert: "Messwert",
            ui_wertgeber: "Wertgeber",
            ui_taster: "Taster",
            ui_colorpicker: "Colorpicker",
            ui_musik_player: "Musik-Player",
            ui_text: "Text",
            ui_status_icon: "Status-Icon",
            ui_menu_link: "Menü-Link",
            ui_schalten: "Schalten",
            ui_sollwert_setzen: "Sollwert setzen",
            ui_hvac_modus_setzen: "HVAC-Modus setzen",
            ui_fahren_auf_ab: "Fahren Auf/Ab",
            ui_position_setzen: "Position setzen",
            ui_lamellen_setzen: "Lamellen setzen",
            ui_farbtemperatur_setzen: "Farbtemperatur setzen",
            ui_farbe_setzen: "Farbe setzen",
            ui_play_pause: "Play / Pause",
            ui_nachster_titel_vorwarts: "Nächster Titel (Vorwärts)",
            ui_vorheriger_titel_zuruck: "Vorheriger Titel (Zurück)",
            ui_lautstarke_setzen: "Lautstärke setzen",
            ui_stummschaltung_mute: "Stummschaltung (Mute)",
            ui_szene_aufrufen: "Szene aufrufen",
            logic_convert_number: "number",
            logic_convert_string: "string",
            climate_title: "Klima",
            climate_mode_command: "HVAC-Modus setzen",
            climate_power_command: "Ein/Aus schalten",
        },
        en: {
            central_title: "Central",
            central_description:
                "Controls selected widgets of one category together and aggregates their feedback.",
            central_presets_description:
                "Controls selected widgets of one category together and aggregates their feedback. Input fields are optional presets. Switching on (switch, power or play = 1) also sends preset parameters; received input values take precedence. Empty fields are ignored.",
            central_preset_color:
                'Color (RGB JSON, e.g. {"red":255,"green":0,"blue":0})',
            central_category: "Widget category",
            central_widgets: "Widgets",
            central_widget_search: "Search widgets by name or page …",
            central_widget_search_empty: "No matching widgets found.",
            central_blinds: "Blinds",
            central_choose_category: "Choose a widget category first.",
            central_load_error: "Could not load widgets.",
            central_no_widgets: "No widgets in this category.",
            central_feedback_hint:
                "Status: any active. Numbers: average. Other values: only when matching.",
            central_invalid_value:
                "Invalid input value for the group address {{address}}",
            sch_widget_value: "Value",
            scn_number_short: "Scene",
            ui_helligkeit: "Brightness",
            ui_temperatur: "Temperature",
            ui_power_ein_aus: "Power on/off",
            ui_stopp: "Stop",
            ui_schalter: "Switch",
            ui_dimmer: "Dimmer",
            ui_messwert: "Measurement",
            ui_wertgeber: "Value control",
            ui_taster: "Button",
            ui_colorpicker: "Color picker",
            ui_musik_player: "Music player",
            ui_text: "Text",
            ui_status_icon: "Status icon",
            ui_menu_link: "Menu link",
            ui_schalten: "Switching",
            ui_sollwert_setzen: "Set setpoint",
            ui_hvac_modus_setzen: "Set HVAC mode",
            ui_fahren_auf_ab: "Move up/down",
            ui_position_setzen: "Set position",
            ui_lamellen_setzen: "Set slats",
            ui_farbtemperatur_setzen: "Set color temperature",
            ui_farbe_setzen: "Set color",
            ui_play_pause: "Play / pause",
            ui_nachster_titel_vorwarts: "Next track",
            ui_vorheriger_titel_zuruck: "Previous track",
            ui_lautstarke_setzen: "Set volume",
            ui_stummschaltung_mute: "Mute",
            ui_szene_aufrufen: "Run scene",
            logic_convert_number: "Number",
            logic_convert_string: "Text",
            climate_title: "Climate",
            climate_mode_command: "Set HVAC mode",
            climate_power_command: "Switch on/off",
        },
    },
    type: "zentral",
    category: "Automatisierung",
    label: "Zentral",
    description: "central_presets_description",
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
        ...presetFields(),
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
        return (ports[data?.widgetCategory] || []).map((port) => ({
            ...port,
            configKey: `preset_${data.widgetCategory}_${port.handle}`,
        }));
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
        const commands = [];
        if (command && !context.initialInputs) {
            // Switching on applies optional parameter presets. Stop/next/etc.
            // stay independent commands and are never replayed as companions.
            if (
                ["switch", "power", "play"].includes(command[0]) &&
                [true, 1, "1"].includes(inputValue(inputs, data, command))
            ) {
                commands.push(
                    ...ports.filter(
                        (port) =>
                            port[2] &&
                            port !== command &&
                            !/^DPT1\./.test(port[4]) &&
                            data[presetKey(data.widgetCategory, port[0])] !==
                                undefined &&
                            data[presetKey(data.widgetCategory, port[0])] !==
                                null &&
                            data[presetKey(data.widgetCategory, port[0])] !==
                                "",
                    ),
                );
            }
            commands.push(command);
        }
        for (const command of commands) {
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
                const value = inputValue(inputs, data, command);
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
