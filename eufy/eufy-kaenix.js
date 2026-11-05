/**
 * @plugin Eufy Kameras
 * @version 1.0.0
 * @author kaenix
 */
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");

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
            .catch(() => finish(new Error("eufy_connection_failed")));
    });
}

class EufyProvider {
    constructor(context, { sdk, spawnProcess = spawn } = {}) {
        this.context = context;
        this.sdk = sdk;
        this.spawnProcess = spawnProcess;
        this.status = "eufy_disconnected";
        this.sessions = new Map();
        this.disposed = false;
        this.controller = new AbortController();
    }

    async getClient() {
        if (this.disposed) throw new Error("camera_provider_unavailable");
        if (this.initializing) return this.initializing;
        const username = this.context.globalSetting("username");
        const password = this.context.globalSetting("password");
        if (!username || !password)
            throw new Error("eufy_credentials_required");
        const country = this.context.globalSetting("country") || "DE";
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
            const sdk = this.sdk || require("eufy-security-client");
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
            client.on("connection error", () => {
                this.status = "eufy_connection_failed";
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
            .catch(() => {
                throw new Error("eufy_connection_failed");
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
                throw new Error("eufy_connection_failed");
            return { message: this.status };
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
        signal = AbortSignal.any([signal, this.controller.signal]);
        const client = await this.connectedClient();
        if (signal.aborted || this.disposed)
            throw new Error("eufy_stream_unavailable");
        if (this.sessions.has(id)) throw new Error("eufy_busy");
        const output = new PassThrough({ highWaterMark: 256 * 1024 });
        // Keep errors handled even if the HTTP caller disappears before the first bytes.
        output.on("error", () => {});
        const session = { output };
        this.sessions.set(id, session);
        let child,
            video,
            audio,
            watchdog,
            lastData = Date.now(),
            stopped = false;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            clearInterval(watchdog);
            signal.removeEventListener("abort", stop);
            client.removeListener("station livestream stop", onStopped);
            this.sessions.delete(id);
            video?.unpipe();
            video?.destroy();
            audio?.destroy();
            child?.stdin.destroy();
            child?.stdout.destroy();
            if (child && child.exitCode === null) {
                child.kill("SIGTERM");
                const timer = setTimeout(() => {
                    if (child.exitCode === null) child.kill("SIGKILL");
                }, 2000);
                timer.unref?.();
            }
            output.destroy();
            void client.stopStationLivestream(id).catch(() => {});
        };
        const onStopped = (_station, device) => {
            if (device.getSerial() === id) stop();
        };
        session.stop = stop;
        signal.addEventListener("abort", stop, { once: true });
        output.once("close", stop);
        client.on("station livestream stop", onStopped);
        try {
            const { args } = await waitFor(
                client,
                {
                    "station livestream start": (_station, device) =>
                        device.getSerial() === id,
                },
                () => client.startStationLivestream(id),
                { signal },
            );
            const metadata = args[2];
            video = args[3];
            audio = args[4];
            if (signal.aborted || stopped)
                throw new Error("eufy_stream_unavailable");
            if (![0, 1].includes(metadata.videoCodec))
                throw new Error("eufy_codec_unsupported");
            // Consume unused audio so the SDK cannot accumulate an unbounded audio queue.
            audio?.on("error", stop);
            audio?.resume();
            const fps = Math.min(
                60,
                Math.max(1, Number(metadata.videoFPS) || 15),
            );
            const codec = metadata.videoCodec === 1 ? "hevc" : "h264";
            const encoding =
                codec === "h264"
                    ? ["-c:v", "copy"]
                    : [
                          "-c:v",
                          "libx264",
                          "-preset",
                          "ultrafast",
                          "-tune",
                          "zerolatency",
                          "-pix_fmt",
                          "yuv420p",
                      ];
            child = this.spawnProcess(
                "ffmpeg",
                [
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-fflags",
                    "+genpts",
                    "-f",
                    codec,
                    "-r",
                    String(fps),
                    "-i",
                    "pipe:0",
                    "-an",
                    ...encoding,
                    "-f",
                    "mpegts",
                    "-mpegts_flags",
                    "+resend_headers",
                    "-muxdelay",
                    "0",
                    "pipe:1",
                ],
                { stdio: ["pipe", "pipe", "ignore"], shell: false },
            );
            child.once("error", stop);
            child.once("exit", stop);
            child.stdin.on("error", stop);
            child.stdout.on("error", stop);
            video.on("error", stop);
            video.on("data", () => {
                lastData = Date.now();
            });
            video.once("end", () => child.stdin.end());
            video.pipe(child.stdin);
            child.stdout.pipe(output);
            watchdog = setInterval(() => {
                if (
                    Date.now() - lastData > 10000 ||
                    video.readableLength > 4 * 1024 * 1024
                )
                    stop();
            }, 1000);
            watchdog.unref?.();
            await new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => finish(new Error("eufy_timeout")),
                    15000,
                );
                const ready = () => finish();
                const closed = () =>
                    finish(new Error("eufy_stream_unavailable"));
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
            stop();
            throw new Error(
                ["eufy_timeout", "eufy_codec_unsupported"].includes(
                    error.message,
                )
                    ? error.message
                    : "eufy_stream_unavailable",
            );
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
    type: "eufy",
    label: "Eufy",
    category: "Kameras",
    description: "eufy_plugin_description",
    version: "1.0.0",
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
    _testing: { EufyProvider, waitFor },
};
