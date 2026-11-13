/**
 * @plugin    Raum
 * @version   1.0.7
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */
module.exports = {
    translations: {
        de: {
            room_description:
                "Überwacht ausgewählte Widgets eines Raums. Status = 1, sobald mindestens ein Widget eingeschaltet ist. Schaltet über Befehlsadressen; optional wird beim Einschalten die Helligkeit mitgesendet.",
            room_switch: "Schalten (0=Aus, 1=Ein)",
            room_status: "Status (1=Ein)",
            room_widgets: "Überwachte Widgets",
            room_brightness: "Helligkeit (%)",
            room_send_brightness: "Helligkeit beim Einschalten mitsenden",
            room_brightness_preset:
                "Helligkeit vorbelegen (0–100 %, Eingang hat Vorrang)",
            room_invalid_brightness:
                "Helligkeit erwartet einen Wert von 0 bis 100 %.",
            room_invalid_switch: "Schalteingang erwartet 0 oder 1.",
            sch_widget_room: "Raum",
            ui_out: "out",
            logic_category: "Logik",
            logic_convert_number: "number",
            logic_convert_string: "string",
        },
        en: {
            room_description:
                "Monitors selected widgets in a room. Status = 1 when any widget is on. Uses command addresses for switching; optionally sends brightness when switching on.",
            room_switch: "Switch (0=Off, 1=On)",
            room_status: "Status (1=On)",
            room_widgets: "Monitored widgets",
            room_brightness: "Brightness (%)",
            room_send_brightness: "Send brightness when switching on",
            room_brightness_preset:
                "Brightness preset (0–100%, input takes precedence)",
            room_invalid_brightness:
                "Brightness requires a value from 0 to 100%.",
            room_invalid_switch: "Switch input requires 0 or 1.",
            sch_widget_room: "Room",
            ui_out: "out",
            logic_category: "Logic",
            logic_convert_number: "Number",
            logic_convert_string: "Text",
        },
    },
    type: "raum",
    category: "Logik",
    label: "Raum",
    description: "room_description",
    color: "#0ea5e9",

    inputs: [{ handle: "switch", label: "room_switch" }],
    dynamicInputs(data) {
        const inputs = [{ handle: "switch", label: "room_switch" }];
        if (data?.sendBrightness === true) {
            inputs.push({
                handle: "brightness",
                label: "room_brightness",
                configKey: "brightness",
            });
        }
        return inputs;
    },
    outputs: [{ handle: "out", label: "room_status" }],

    // Lässt die Logic Engine diesen Node-Typ bei JEDEM Bus-Telegramm neu auswerten,
    // statt nur bei Änderungen an einer fest verdrahteten Eingangs-GA.
    watchesKnxBus: true,
    // Lokale Writes sind bereits im Cache, bevor sie hier eintreffen. Ihr
    // Bus-Echo wird vom KNX-Manager unterdrückt; den Status daher sofort auswerten.
    // _knxEvent führt den gespeicherten Schaltbefehl nicht erneut aus.
    watchesLocalKnxWrites: true,

    config: [
        { key: "pageId", label: "sch_widget_room", type: "room-picker" },
        {
            key: "excludedAddresses",
            label: "room_widgets",
            type: "room-widget-checklist",
        },
        {
            key: "sendBrightness",
            label: "room_send_brightness",
            type: "checkbox",
            default: false,
        },
        {
            key: "brightness",
            label: "room_brightness_preset",
            type: "number",
            min: 0,
            max: 100,
            visibleWhen: { sendBrightness: [true] },
        },
    ],

    // Begrenzt die Neuauswertung auf Telegramme, die tatsächlich eine nicht abgewählte
    // Status-GA eines Widgets im gewählten Raum betreffen (statt bei jedem Telegramm im Haus).
    getWatchedAddresses(data, helpers) {
        if (!data.pageId) return new Set();
        const excluded = new Set(data.excludedAddresses || []);
        const all = helpers
            .getRoomWidgetStatuses(data.pageId)
            .map((w) => w.address);
        return new Set(all.filter((a) => !excluded.has(a)));
    },

    execute(inputs, data, context) {
        if (!data.pageId) return { out: 0 };
        // Jedes Eingangstelegramm zählt, auch mit identischem Wert. Statusereignisse
        // und Initialisierung dürfen den gespeicherten Befehl nicht erneut senden.
        if (context.triggerHandle === "switch" && !context.initialInputs) {
            const value = inputs.switch;
            if ([0, 1, false, true, "0", "1"].includes(value)) {
                let brightness;
                if (Number(value) === 1 && data.sendBrightness === true) {
                    const raw = inputs.brightness ?? data.brightness;
                    if (raw !== undefined && raw !== null && raw !== "") {
                        brightness =
                            typeof raw === "number" ||
                            (typeof raw === "string" && raw.trim() !== "")
                                ? Number(raw)
                                : NaN;
                        if (
                            !Number.isFinite(brightness) ||
                            brightness < 0 ||
                            brightness > 100
                        ) {
                            context.warn("room_invalid_brightness");
                            brightness = undefined;
                        }
                    }
                }
                context.switchRoom(
                    data.pageId,
                    Number(value),
                    data.excludedAddresses,
                    brightness,
                );
            } else {
                context.warn("room_invalid_switch");
            }
        }
        const on = context.isRoomOn(data.pageId, data.excludedAddresses);
        return { out: on ? 1 : 0 };
    },
};
