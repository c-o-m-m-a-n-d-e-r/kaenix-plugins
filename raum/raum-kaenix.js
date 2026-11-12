/**
 * @plugin    Raum
 * @version   1.0.6
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */
module.exports = {
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
