/**
 * @plugin    Push
 * @version   1.0.5
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */
// Each node owns its data object. Weak keys release state when a flow is removed
// or replaced, without persisting runtime timestamps in the saved configuration.
const lastSentAt = new WeakMap();

module.exports = {
    translations: {
        de: {
            push_cooldown_seconds: "Sperrzeit (Sekunden, 0 = aus)",
            native_value: "Wert",
            sch_widget_value: "Wert",
            dash_col_value: "Wert",
            addr_value_placeholder: "Wert",
            sch_col_value: "Wert",
            scn_action_value: "Wert",
            ui_in_57: "in",
            ui_titel: "Titel",
            logic_convert_number: "number",
            hvac_value: "Wert",
            history_value_axis: "Wert",
        },
        en: {
            push_cooldown_seconds: "Cooldown (seconds, 0 = off)",
            native_value: "Value",
            sch_widget_value: "Value",
            dash_col_value: "Value",
            addr_value_placeholder: "Value",
            sch_col_value: "Value",
            scn_action_value: "Value",
            ui_in_57: "in",
            ui_titel: "Title",
            logic_convert_number: "Number",
            hvac_value: "Value",
            history_value_axis: "Value",
        },
    },
    type: "push",
    category: "Benachrichtigung",
    label: "Push",
    description: "Sendet Web Push an alle Geräte oder ein bestimmtes Gerät",
    color: "#f97316",

    inputs: [{ handle: "in", label: "Wert" }],
    outputs: [],

    config: [
        {
            key: "targetDevice",
            label: "Zielgerät",
            type: "select",
            options: ["all"],
        },
        { key: "title", label: "Titel", type: "text" },
        { key: "text", label: "Text ({value} als Platzhalter)", type: "text" },
        { key: "icon", label: "Icon-URL (optional)", type: "text" },
        { key: "url", label: "URL beim Klick", type: "text" },
        {
            key: "cooldownSeconds",
            label: "push_cooldown_seconds",
            type: "number",
            min: 0,
            default: 0,
        },
    ],

    execute(inputs, data, context) {
        // Engine startup/reload initializes plugins without a real input event.
        if (
            context.triggerHandle === "_config" ||
            ![true, 1, "1"].includes(inputs.in)
        )
            return {};
        const value = inputs.in;
        let target = "all";
        let deviceId = null;

        const targetDevice =
            data.targetDevice == null ? "" : String(data.targetDevice);
        if (targetDevice === "all") {
            target = "all";
        } else if (targetDevice.startsWith("device:")) {
            const parsedId = parseInt(targetDevice.split(":")[1], 10);
            target = "device";
            deviceId = Number.isNaN(parsedId) ? null : parsedId;
        } else {
            // Legacy-Fallback fuer bestehende Flows mit getrennten Feldern.
            const legacyTarget =
                (data.target || "all") === "device" ? "device" : "all";
            const legacyDeviceId = data.deviceId
                ? parseInt(data.deviceId, 10)
                : null;
            if (legacyTarget === "device") {
                target = "device";
                deviceId = Number.isNaN(legacyDeviceId) ? null : legacyDeviceId;
            }
        }

        const title = String(data.title || "KNX Homeserver");
        const template = String(data.text || "Neuer Wert: {value}");
        const body = template.replaceAll(
            "{value}",
            value == null ? "" : String(value),
        );
        const icon = String(data.icon || "").trim();
        const url = String(data.url || "/");

        if (target === "device" && !deviceId) {
            context.warn(
                "targetDevice auf Einzelgeraet gesetzt, aber keine gueltige deviceId gefunden",
            );
            return {};
        }

        const seconds = Number(data.cooldownSeconds);
        const cooldownMs =
            Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
        const now = Date.now();
        const previous = lastSentAt.get(data);
        if (
            cooldownMs > 0 &&
            previous !== undefined &&
            now - previous < cooldownMs
        )
            return {};

        // Reserve the slot before sending so bursts cannot start parallel pushes.
        lastSentAt.set(data, now);
        context.push({
            target,
            deviceId,
            title,
            body,
            ...(icon ? { icon } : {}),
            url,
        });

        context.log(
            `Push gesendet (target=${target}${target === "device" ? `, deviceId=${deviceId || "n/a"}` : ""})`,
        );
        return {};
    },
};
