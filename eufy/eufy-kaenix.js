/**
 * @plugin Eufy Kameras
 * @version 1.0.3
 * @author kaenix
 */
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");

const CLIENT_VERSION = "3.8.0";
const NETWORK_CODES = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
]);
const ERROR_TYPES = new Set([
    "Error",
    "TypeError",
    "SyntaxError",
    "RangeError",
    "ApiResponseCodeError",
    "ApiInvalidResponseError",
    "ApiHTTPResponseCodeError",
    "ApiGenericError",
    "ApiBaseLoadError",
    "ApiRequestError",
    "HTTPError",
    "RequestError",
    "TimeoutError",
    "InvalidCountryCodeError",
    "EufyDependencyOutdatedError",
]);

// Never serialize provider messages, request options, URLs, stacks or response bodies.
function safeLoginFailure(
    error,
    phase,
    nodeVersion,
    sdkVersion = CLIENT_VERSION,
) {
    const diagnostic = { phase, sdk: sdkVersion, node: nodeVersion };
    const seen = new Set();
    for (
        let current = error;
        current && seen.size < 5 && !seen.has(current);
        current = current.cause
    ) {
        seen.add(current);
        if (!diagnostic.type && ERROR_TYPES.has(current.name))
            diagnostic.type = current.name;
        const apiCode = current.context?.code;
        if (
            Number.isSafeInteger(apiCode) &&
            Math.abs(apiCode) <= 2147483647 &&
            diagnostic.api === undefined
        )
            diagnostic.api = apiCode;
        const status = current.context?.status ?? current.response?.statusCode;
        if (
            Number.isInteger(status) &&
            status >= 100 &&
            status <= 599 &&
            diagnostic.http === undefined
        )
            diagnostic.http = status;
        if (NETWORK_CODES.has(current.code)) diagnostic.network = current.code;
        if (current.code === "MODULE_NOT_FOUND") diagnostic.module = "missing";
        if (
            [
                "ERR_REQUIRE_ESM",
                "ERR_REQUIRE_ASYNC_MODULE",
                "ERR_UNKNOWN_BUILTIN_MODULE",
            ].includes(current.code)
        )
            diagnostic.module = "incompatible";
    }
    let key =
        phase === "initialize"
            ? "eufy_sdk_init_failed"
            : "eufy_connection_failed";
    if (diagnostic.module === "missing") key = "eufy_dependency_missing";
    else if (
        diagnostic.module === "incompatible" ||
        Number(nodeVersion.split(".")[0]) < 20
    )
        key = "eufy_runtime_unsupported";
    else if (diagnostic.type === "EufyDependencyOutdatedError")
        key = "eufy_dependency_outdated";
    else if (diagnostic.network || diagnostic.type === "TimeoutError")
        key = "eufy_network_failed";
    else if (
        diagnostic.http === 429 ||
        [100028, 250999].includes(diagnostic.api)
    )
        key = "eufy_rate_limited";
    else if ([26006, 26055, 22008].includes(diagnostic.api))
        key = "eufy_auth_rejected";
    return {
        key,
        code: Object.entries(diagnostic)
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
    };
}

function waitFor(client, events, action, { signal, timeout = 25000 } = {}) {
    return new Promise((resolve, reject) => {
        const listeners = [];
        const finish = (error, value) => {
            clearTimeout(timer);
            for (const [event, listener] of listeners)
                client.removeListener(event, listener);
            signal?.removeEventListener("abort", abort);
            error ? reject(error) : resolve(value);
        };
        const abort = () => finish(new Error("eufy_stream_unavailable"));
        const timer = setTimeout(
            () => finish(new Error("eufy_timeout")),
            timeout,
        );
        for (const [event, filter] of Object.entries(events)) {
            const listener = (...args) => {
                if (!filter || filter(...args)) finish(null, { event, args });
            };
            listeners.push([event, listener]);
            client.on(event, listener);
        }
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) return abort();
        Promise.resolve()
            .then(action)
            .catch((error) =>
                finish(
                    error instanceof Error
                        ? error
                        : new Error("eufy_connection_failed"),
                ),
            );
    });
}

class EufyProvider {
    constructor(
        context,
        {
            sdk,
            nodeVersion = process.versions.node,
            streamTimeoutMs = 18000,
        } = {},
    ) {
        this.context = context;
        this.sdk = sdk;
        this.nodeVersion = nodeVersion;
        this.sdkVersion = CLIENT_VERSION;
        this.streamTimeoutMs = streamTimeoutMs;
        this.status = "eufy_disconnected";
        this.sessions = new Map();
        this.disposed = false;
        this.controller = new AbortController();
    }

    recordFailure(error, phase) {
        const failure = safeLoginFailure(
            error,
            phase,
            this.nodeVersion,
            this.sdkVersion,
        );
        this.status = failure.key;
        this.diagnosticCode = failure.code;
        this.context.warn?.(failure.code);
        return new Error(failure.key);
    }

    async getClient() {
        if (this.disposed) throw new Error("camera_provider_unavailable");
        if (this.initializing) return this.initializing;
        const username = String(
            this.context.globalSetting("username") || "",
        ).trim();
        const password = this.context.globalSetting("password");
        if (!username || !password)
            throw new Error("eufy_credentials_required");
        const country = String(this.context.globalSetting("country") || "DE")
            .trim()
            .toUpperCase();
        if (!/^[A-Z]{2}$/.test(country))
            throw new Error("eufy_country_invalid");
        const account = JSON.stringify([username, password, country]);
        if (this.client && this.account === account) return this.client;
        if (this.client) {
            this.client.close();
            this.client = null;
            this.captcha = null;
            fs.rmSync(path.join(this.context.dataDir, "persistent.json"), {
                force: true,
            });
        }
        this.account = account;
        this.initializing = (async () => {
            if (Number(this.nodeVersion.split(".")[0]) < 20)
                throw new Error("eufy_runtime_unsupported");
            const sdk = this.sdk || require("eufy-security-client");
            if (
                typeof sdk.libVersion === "string" &&
                /^\d+\.\d+\.\d+$/.test(sdk.libVersion)
            ) {
                this.sdkVersion = sdk.libVersion;
                if (sdk.libVersion !== CLIENT_VERSION) {
                    const error = new Error("eufy_dependency_outdated");
                    error.name = "EufyDependencyOutdatedError";
                    throw error;
                }
            }
            const client = await sdk.EufySecurity.initialize({
                username,
                password,
                country,
                language: "en",
                persistentDir: this.context.dataDir,
                trustedDeviceName: "kaenix-eufy-plugin",
                p2pConnectionSetup: 2,
                pollingIntervalMinutes: 10,
                eventDurationSeconds: 10,
                acceptInvitations: false,
                enableEmbeddedPKCS1Support: true,
            });
            if (this.disposed) {
                client.close();
                throw new Error("camera_provider_unavailable");
            }
            this.client = client;
            client.setCameraMaxLivestreamDuration(0);
            client.on("connect", () => {
                this.status = "eufy_connected";
                this.captcha = null;
                this.diagnosticCode = null;
            });
            client.on("close", () => {
                this.status = "eufy_disconnected";
            });
            client.on("tfa request", () => {
                this.status = "eufy_mfa_required";
            });
            client.on("captcha request", (id, image) => {
                this.status = "eufy_captcha_required";
                this.captcha = { id, image };
            });
            client.on("connection error", (error) => {
                this.recordFailure(error, "login");
            });
            client.on(
                "station livestream start",
                (_station, device, _metadata, video, audio) => {
                    // A start command can complete after a caller has timed out or disconnected.
                    if (
                        this.disposed ||
                        !this.sessions.has(device.getSerial())
                    ) {
                        video.destroy();
                        audio?.destroy();
                        void client
                            .stopStationLivestream(device.getSerial())
                            .catch(() => {});
                    }
                },
            );
            return client;
        })()
            .catch((error) => {
                if (this.disposed)
                    throw new Error("camera_provider_unavailable");
                throw this.recordFailure(error, "initialize");
            })
            .finally(() => {
                this.initializing = null;
            });
        return this.initializing;
    }

    async login(options = {}) {
        if (this.loginPending) throw new Error("eufy_busy");
        this.loginPending = true;
        try {
            const client = await this.getClient();
            if (client.isConnected() && !options.verifyCode && !options.captcha)
                return { message: "eufy_connected" };
            this.status = "eufy_connecting";
            this.diagnosticCode = null;
            const response = await waitFor(
                client,
                {
                    connect: null,
                    "tfa request": null,
                    "captcha request": null,
                    "connection error": null,
                },
                () => client.connect({ force: false, ...options }),
                { signal: this.controller.signal },
            );
            if (response.event === "connection error")
                throw new Error(this.status);
            return { message: this.status };
        } catch (error) {
            if (
                error instanceof Error &&
                new Set([
                    "eufy_credentials_required",
                    "eufy_country_invalid",
                    "eufy_runtime_unsupported",
                    "eufy_dependency_outdated",
                    "eufy_sdk_init_failed",
                    "eufy_dependency_missing",
                    "eufy_network_failed",
                    "eufy_rate_limited",
                    "eufy_auth_rejected",
                    "eufy_timeout",
                    "eufy_stream_unavailable",
                    "eufy_connection_failed",
                    "camera_provider_unavailable",
                ]).has(error.message)
            ) {
                if (!this.disposed) this.status = error.message;
                throw error;
            }
            throw this.recordFailure(error, "login");
        } finally {
            this.loginPending = false;
        }
    }

    async connectedClient() {
        const client = await this.getClient();
        if (!client.isConnected()) await this.login();
        if (!client.isConnected()) throw new Error(this.status);
        return client;
    }

    async discover() {
        const client = await this.connectedClient();
        await client.refreshCloudData();
        if (this.disposed) throw new Error("camera_provider_unavailable");
        return (await client.getDevices())
            .filter((device) => device.isCamera())
            .map((device) => ({
                id: device.getSerial(),
                name: device.getName(),
                model: device.getModel(),
                station: device.getStationSerial(),
            }));
    }

    async openStream(id, signal) {
        const sessionController = new AbortController();
        signal = AbortSignal.any([
            signal,
            this.controller.signal,
            sessionController.signal,
        ]);
        const client = await this.connectedClient();
        if (signal.aborted || this.disposed)
            throw new Error("eufy_stream_unavailable");
        if (this.sessions.has(id)) throw new Error("eufy_busy");
        const output = new PassThrough({ highWaterMark: 256 * 1024 });
        output.on("error", () => {});
        const session = { output };
        this.sessions.set(id, session);
        let video, audio, station, channel, watchdog, failure, codec;
        let bytes = 0,
            lastData = Date.now(),
            stopped = false,
            stage = "p2p-start";
        const report = (key, warn = false) => {
            this.streamStatus = key;
            this.diagnosticCode = `phase=stream; sdk=${this.sdkVersion}; stage=${stage}; codec=${codec || "unknown"}; bytes=${bytes}`;
            if (warn) this.context.warn?.(`${key}; ${this.diagnosticCode}`);
        };
        const stop = () => {
            if (stopped) return;
            stopped = true;
            clearInterval(watchdog);
            signal.removeEventListener("abort", stop);
            client.removeListener("station livestream stop", onStopped);
            station?.removeListener("livestream error", onMediaError);
            this.sessions.delete(id);
            video?.unpipe(output);
            video?.destroy();
            audio?.destroy();
            if (!failure)
                report(bytes ? "eufy_stream_stopped" : "eufy_stream_cancelled");
            sessionController.abort();
            output.destroy();
            void client.stopStationLivestream(id).catch(() => {});
        };
        const fail = (key) => {
            if (stopped) return;
            failure = key;
            report(key, true);
            stop();
        };
        const onStopped = (_station, device) => {
            if (device.getSerial() === id) fail("eufy_stream_p2p_stopped");
        };
        const onMediaError = (_station, streamChannel) => {
            if (streamChannel === channel) fail("eufy_stream_p2p_error");
        };
        session.stop = stop;
        signal.addEventListener("abort", stop, { once: true });
        output.once("close", stop);
        client.on("station livestream stop", onStopped);
        report("eufy_stream_starting");
        try {
            // The SDK does not forward decryption/media errors to the client emitter.
            const device = await client.getDevice(id);
            if (signal.aborted) throw new Error("eufy_stream_unavailable");
            channel = device.getChannel();
            station = await client.getStation(device.getStationSerial());
            if (signal.aborted) throw new Error("eufy_stream_unavailable");
            station.on("livestream error", onMediaError);
            const { args } = await waitFor(
                client,
                {
                    "station livestream start": (_station, streamDevice) =>
                        streamDevice.getSerial() === id,
                },
                () => client.startStationLivestream(id),
                { signal, timeout: this.streamTimeoutMs },
            );
            const metadata = args[2];
            video = args[3];
            audio = args[4];
            if (signal.aborted || stopped)
                throw new Error("eufy_stream_unavailable");
            if (![0, 1].includes(metadata.videoCodec))
                throw new Error("eufy_codec_unsupported");
            codec = metadata.videoCodec === 1 ? "H265" : "H264";
            // go2rtc detects Annex-B H.264/H.265 directly; no remux process is needed.
            output.contentType =
                metadata.videoCodec === 1 ? "video/h265" : "video/h264";
            stage = "video-input";
            report("eufy_stream_waiting");
            audio?.on("error", () => fail("eufy_stream_p2p_error"));
            audio?.resume();
            video.on("error", () => fail("eufy_stream_p2p_error"));
            video.pipe(output);
            video.on("data", (chunk) => {
                if (stopped) return;
                bytes += chunk.length;
                lastData = Date.now();
                if (stage !== "forwarding") {
                    stage = "forwarding";
                    report("eufy_stream_receiving");
                }
            });
            watchdog = setInterval(() => {
                if (Date.now() - lastData > 10000) fail("eufy_stream_no_data");
                else if (video.readableLength > 4 * 1024 * 1024)
                    fail("eufy_stream_backpressure");
            }, 1000);
            watchdog.unref?.();
            await new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => finish(new Error("eufy_stream_no_data")),
                    5000,
                );
                const ready = () => finish();
                const closed = () =>
                    finish(new Error(failure || "eufy_stream_unavailable"));
                const finish = (error) => {
                    clearTimeout(timer);
                    output.removeListener("readable", ready);
                    output.removeListener("close", closed);
                    error ? reject(error) : resolve();
                };
                output.once("readable", ready);
                output.once("close", closed);
                if (output.readableLength) ready();
                else if (output.destroyed) closed();
            });
            return output;
        } catch (error) {
            if (!stopped)
                fail(
                    error.message === "eufy_timeout"
                        ? "eufy_stream_start_timeout"
                        : [
                                "eufy_codec_unsupported",
                                "eufy_stream_no_data",
                            ].includes(error.message)
                          ? error.message
                          : "eufy_stream_p2p_error",
                );
            throw new Error(failure || "eufy_stream_unavailable");
        }
    }

    uiState() {
        const connected = this.status === "eufy_connected";
        const challenge =
            this.status === "eufy_mfa_required" ||
            this.status === "eufy_captcha_required";
        return {
            hideSave: true,
            status: this.status,
            streamStatus: this.streamStatus,
            diagnosticCode: this.diagnosticCode,
            visibleActionKeys: connected
                ? ["logout"]
                : this.status === "eufy_mfa_required"
                  ? ["verifyCode", "logout"]
                  : this.status === "eufy_captcha_required"
                    ? ["verifyCaptcha", "logout"]
                    : ["login", "logout"],
            readOnlyKeys:
                connected || challenge || this.loginPending
                    ? ["username", "password", "country"]
                    : [],
            captchaImage:
                typeof this.captcha?.image === "string" &&
                /^[A-Za-z0-9+/=]+$/.test(this.captcha.image)
                    ? `data:image/png;base64,${this.captcha.image}`
                    : this.captcha?.image,
        };
    }

    dispose() {
        this.disposed = true;
        this.controller.abort();
        for (const session of [...this.sessions.values()]) session.stop();
        this.client?.close();
        this.client = null;
    }
}

let provider;
module.exports = {
    translations: {
        de: {
            nav_visu_cameras: "Kameras",
            eufy_stream_starting: "P2P-Livestream wird angefordert.",
            eufy_stream_waiting: "P2P-Stream geöffnet; warte auf Videodaten.",
            eufy_stream_receiving:
                "P2P-Videodaten werden an go2rtc weitergegeben.",
            eufy_stream_stopped: "Der Videoabnehmer hat den Stream beendet.",
            eufy_stream_cancelled:
                "Der Videoabruf wurde vor dem ersten Bild beendet.",
            eufy_stream_start_timeout:
                "Eufy liefert nach dem P2P-Start kein Stream-Ereignis. Anmeldung und Kamerasuche sind davon unabhängig.",
            eufy_stream_no_data:
                "Der Eufy-P2P-Stream liefert keine weiteren Videodaten.",
            eufy_stream_backpressure:
                "Der Videoabnehmer verarbeitet den Eufy-Stream nicht rechtzeitig.",
            eufy_stream_p2p_error:
                "Der Eufy-P2P-Stream konnte nicht geöffnet oder entschlüsselt werden.",
            eufy_stream_p2p_stopped: "Eufy hat den P2P-Stream beendet.",
            eufy_dependency_missing:
                "Die Eufy-Bibliothek fehlt. Bitte das Plugin vollständig aktualisieren.",
            eufy_dependency_outdated:
                "Die installierte Eufy-Bibliothek passt nicht zum Plugin. Bitte das Plugin einschließlich Abhängigkeiten aktualisieren.",
            eufy_runtime_unsupported:
                "Die Laufzeit ist mit der Eufy-Bibliothek nicht kompatibel. Bitte Homeserver und Plugin gemeinsam aktualisieren.",
            eufy_sdk_init_failed:
                "Die Eufy-Bibliothek konnte nicht initialisiert werden. Bitte die Verbindungsdetails prüfen.",
            eufy_auth_rejected:
                "Eufy hat die Plugin-Anmeldung zurückgewiesen. Bitte Kontoregion und Anmeldung mit E-Mail und Passwort prüfen.",
            eufy_rate_limited:
                "Eufy hat Anmeldeversuche vorübergehend begrenzt. Bitte später erneut versuchen.",
            eufy_network_failed:
                "Der Homeserver konnte die Eufy-Anmeldung nicht erreichen. Bitte die Verbindungsdetails prüfen.",
            camera_provider_invalid: "Ungültige Kamera-Plugin-Schnittstelle",
            camera_provider_unavailable:
                "Das Kamera-Plugin ist nicht verfügbar.",
            eufy_plugin_description:
                "Eufy-Kameras über P2P mit bestehender HomeBase-Anbindung einbinden.",
            eufy_username: "Eufy-Konto (E-Mail)",
            eufy_password: "Eufy-Passwort",
            eufy_country_invalid:
                "Bitte die Kontoregion als zweistelligen Großbuchstabencode eingeben (z. B. DE).",
            eufy_country: "Kontoregion (z. B. DE)",
            eufy_login: "Bei Eufy anmelden",
            eufy_verify_code: "Anmeldung bestätigen",
            eufy_verify_captcha: "Bildcode bestätigen",
            eufy_code: "Bestätigungscode",
            eufy_captcha_code: "Code aus dem Bild",
            eufy_captcha_image: "Eufy-Bildcode zur Anmeldung",
            eufy_logout: "Abmelden",
            eufy_disconnected: "Nicht bei Eufy angemeldet.",
            eufy_connected: "Mit Eufy verbunden.",
            eufy_connecting: "Verbindung zu Eufy wird aufgebaut.",
            eufy_mfa_required: "Eufy benötigt einen Bestätigungscode.",
            eufy_captcha_required:
                "Eufy benötigt den Code aus dem angezeigten Bild.",
            eufy_credentials_required:
                "Bitte Eufy-Konto und Passwort eingeben.",
            eufy_connection_failed:
                "Die Verbindung zu Eufy ist fehlgeschlagen.",
            eufy_timeout: "Eufy hat nicht rechtzeitig geantwortet.",
            eufy_stream_unavailable: "Der Eufy-Livestream ist nicht verfügbar.",
            eufy_codec_unsupported:
                "Der Eufy-Video-Codec wird nicht unterstützt.",
            eufy_busy: "Die Eufy-Anbindung ist noch beschäftigt.",
            eufy_code_invalid: "Bitte einen gültigen Eufy-Code eingeben.",
            ui_platziert: " platziert.",
            philips_error: "Fehler",
            logic_convert_string: "string",
            leica_error: "Fehler",
        },
        en: {
            nav_visu_cameras: "Cameras",
            eufy_stream_starting: "Requesting the P2P livestream.",
            eufy_stream_waiting: "P2P stream opened; waiting for video data.",
            eufy_stream_receiving: "Forwarding P2P video data to go2rtc.",
            eufy_stream_stopped: "The video consumer closed the stream.",
            eufy_stream_cancelled:
                "The video request ended before the first frame.",
            eufy_stream_start_timeout:
                "Eufy did not produce a stream event after the P2P start. Sign-in and camera discovery are independent of this.",
            eufy_stream_no_data:
                "The Eufy P2P stream is not delivering further video data.",
            eufy_stream_backpressure:
                "The video consumer is not processing the Eufy stream in time.",
            eufy_stream_p2p_error:
                "The Eufy P2P stream could not be opened or decrypted.",
            eufy_stream_p2p_stopped: "Eufy ended the P2P stream.",
            eufy_dependency_missing:
                "The Eufy library is missing. Please update the complete plugin.",
            eufy_dependency_outdated:
                "The installed Eufy library does not match the plugin. Please update the plugin including its dependencies.",
            eufy_runtime_unsupported:
                "The runtime is incompatible with the Eufy library. Please update the homeserver and plugin together.",
            eufy_sdk_init_failed:
                "The Eufy library could not be initialized. Please check the connection details.",
            eufy_auth_rejected:
                "Eufy rejected the plugin sign-in. Please check the account region and email/password sign-in.",
            eufy_rate_limited:
                "Eufy has temporarily limited sign-in attempts. Please try again later.",
            eufy_network_failed:
                "The homeserver could not reach Eufy sign-in. Please check the connection details.",
            camera_provider_invalid: "Invalid camera plugin interface",
            camera_provider_unavailable: "The camera plugin is unavailable.",
            eufy_plugin_description:
                "Connect Eufy cameras over P2P while keeping their HomeBase connection.",
            eufy_username: "Eufy account (email)",
            eufy_password: "Eufy password",
            eufy_country_invalid:
                "Please enter the account region as a two-letter uppercase code (e.g. DE).",
            eufy_country: "Account region (e.g. DE)",
            eufy_login: "Sign in to Eufy",
            eufy_verify_code: "Confirm sign-in",
            eufy_verify_captcha: "Confirm image code",
            eufy_code: "Verification code",
            eufy_captcha_code: "Code from the image",
            eufy_captcha_image: "Eufy sign-in image challenge",
            eufy_logout: "Sign out",
            eufy_disconnected: "Not signed in to Eufy.",
            eufy_connected: "Connected to Eufy.",
            eufy_connecting: "Connecting to Eufy.",
            eufy_mfa_required: "Eufy requires a verification code.",
            eufy_captcha_required:
                "Eufy requires the code from the displayed image.",
            eufy_credentials_required:
                "Please enter your Eufy account and password.",
            eufy_connection_failed: "The connection to Eufy failed.",
            eufy_timeout: "Eufy did not respond in time.",
            eufy_stream_unavailable: "The Eufy livestream is unavailable.",
            eufy_codec_unsupported: "The Eufy video codec is unsupported.",
            eufy_busy: "The Eufy connection is still busy.",
            eufy_code_invalid: "Please enter a valid Eufy code.",
            ui_platziert: ".",
            philips_error: "Error",
            logic_convert_string: "Text",
            leica_error: "Error",
        },
    },
    type: "eufy",
    label: "Eufy",
    category: "Kameras",
    description: "eufy_plugin_description",
    version: "1.0.3",
    requiresDependencies: true,
    globalSettings: [
        { key: "username", label: "eufy_username", type: "text" },
        {
            key: "password",
            label: "eufy_password",
            type: "password",
            secret: true,
        },
        {
            key: "country",
            label: "eufy_country",
            type: "text",
            placeholder: "DE",
        },
    ],
    globalActions: [
        { key: "login", label: "eufy_login" },
        {
            key: "verifyCode",
            label: "eufy_verify_code",
            fields: [
                {
                    key: "code",
                    label: "eufy_code",
                    type: "password",
                    autoComplete: "one-time-code",
                },
            ],
        },
        {
            key: "verifyCaptcha",
            label: "eufy_verify_captcha",
            fields: [{ key: "code", label: "eufy_captcha_code", type: "text" }],
        },
        { key: "logout", label: "eufy_logout" },
    ],
    createCameraProvider(context) {
        provider = new EufyProvider(context);
        return {
            discover: () => provider.discover(),
            openStream: (id, signal) => provider.openStream(id, signal),
            dispose: () => provider.dispose(),
        };
    },
    getGlobalUiState() {
        return provider?.uiState() || {};
    },
    async handleGlobalAction(action, values, context) {
        if (!provider) throw new Error("camera_provider_unavailable");
        if (action === "login") return provider.login();
        if (action === "verifyCode") {
            if (!/^\d{4,10}$/.test(values.code || ""))
                throw new Error("eufy_code_invalid");
            return provider.login({ verifyCode: values.code });
        }
        if (action === "verifyCaptcha") {
            if (
                !provider.captcha ||
                typeof values.code !== "string" ||
                !values.code.trim() ||
                values.code.length > 32
            )
                throw new Error("eufy_code_invalid");
            return provider.login({
                captcha: {
                    captchaId: provider.captcha.id,
                    captchaCode: values.code.trim(),
                },
            });
        }
        if (action === "logout") {
            const old = provider;
            old.dispose();
            if (old.initializing) await old.initializing.catch(() => {});
            fs.rmSync(path.join(old.context.dataDir, "persistent.json"), {
                force: true,
            });
            context.setGlobalSetting("password", "");
            provider = new EufyProvider(old.context);
            return { message: "eufy_disconnected" };
        }
        throw new Error("camera_provider_invalid");
    },
    _testing: { EufyProvider, waitFor, safeLoginFailure },
};
