/**
 * @plugin Philips Air Plus
 * @version 1.0.4
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 *
 * Protocol/authentication adapted from NikGro/philips-air-plus-homeassistant,
 * revision e091838cbea4444899694431f57bbf78992c834e (MIT).
 * Additional Air+ API/shadow protocol: same project, revision
 * 45c68df11fa8bb4bc1b851943a9912886a84a3e3 (MIT), and
 * kwesolowski/node-red-contrib-philips-airplus, revision
 * acbffa3683e728512dde7da824184586d3f4f9f9 (MIT).
 * Copyright (c) 2025-2026 ShorMeneses
 * Portions copyright (c) 2026 Markus Stephany
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const CDC = 'https://cdc.accounts.home.id';
const API_KEY = '4_JGZWlP8eQHpEqkvQElolbA';
const ISSUER = `${CDC}/oidc/op/v1.0/${API_KEY}`;
const CLIENT_ID = '-XsK7O6iEkLml77yDGDUi0ku';
const REDIRECT = 'com.philips.air://loginredirect';
const SCOPES = 'openid email profile address DI.Account.read DI.Account.write DI.AccountProfile.read '
    + 'DI.AccountProfile.write DI.AccountGeneralConsent.read DI.AccountGeneralConsent.write '
    + 'DI.GeneralConsent.read subscriptions profile_extended consents DI.AccountSubscription.read DI.AccountSubscription.write';
const API = 'https://prod.eu-da.iot.versuni.com/api/da/user/self';
const MODES = { auto: 0, medium: 1, sleep: 17, turbo: 18 };
const AIR_API = 'https://www.api.air.philips.com/';
const AIR_APP = '9fd505fa9c7111e9a1e3061302926720';
// Public application signing value documented in the pinned protocol reference.
// This is not a user's account credential. Account IDs and tokens stay private.
const AIR_SIGNING = 'a_zagf9sb2dpbiImtycwibgfzd6nksd65m';
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const AIR_MODES = { auto: 0, medium: 19, sleep: 17, turbo: 18,
    speed1: 1, speed2: 2, speed3: 3, speed4: 4, speed5: 5 };
const AIR_UPGRADE = 'Philips Air+: Für die Erkennung neuer Geräte einmal abmelden und per E-Mail-Code erneut anmelden';
const nodes = new Map();
let account;
let mqtt;

function getMqtt() {
    if (mqtt) return mqtt;
    try { mqtt = require('mqtt'); }
    catch {
        try { mqtt = require(require.resolve('mqtt', { paths: [process.cwd(), path.resolve(__dirname, '../../backend')] })); }
        catch { throw new Error('MQTT-Bibliothek fehlt. Homeserver-Backend aktualisieren und neu starten.'); }
    }
    return mqtt;
}

function emit(node, handle, value) {
    if (nodes.get(node.id) !== node || node.last[handle] === value) return;
    node.last[handle] = value;
    node.context.emitOutput(handle, value);
}
function status(node, connected, message) {
    node.context.setNodeStatus?.(connected);
    emit(node, 'connected', connected ? 1 : 0);
    if (message) emit(node, 'status', message);
}
function fail(node, message) {
    emit(node, 'error', message);
    node.context.warn(message);
}
function notify(a, message, error = false) {
    if (account !== a) return;
    a.message = message;
    for (const node of nodes.values()) {
        if (error) fail(node, message);
        else emit(node, 'status', message);
    }
}
function closeConnections(a) {
    for (const connection of a.connections.values()) {
        clearTimeout(connection.retry);
        clearTimeout(connection.watchdog);
        clearVerification(connection);
        connection.closed = true;
        connection.client?.end(true);
    }
    a.connections.clear();
    for (const node of nodes.values()) { node.uuid = undefined; status(node, false); }
}
function stopAccount(a) {
    clearTimeout(a.refreshTimer);
    a.abort.abort();
    closeConnections(a);
}
function disposeNode(id, preserveAccount = false) {
    const node = nodes.get(id);
    if (!node) return;
    nodes.delete(id);
    if (account) {
        for (const [uuid, connection] of account.connections) {
            if (![...nodes.values()].some(n => n.uuid === uuid)) {
                connection.closed = true;
                clearTimeout(connection.retry);
                clearTimeout(connection.watchdog);
                clearVerification(connection);
                connection.client?.end(true);
                account.connections.delete(uuid);
            }
        }
        if (!nodes.size && !preserveAccount) { stopAccount(account); account = undefined; }
    }
}

// Provider bodies and URLs can contain tokens: only emit controlled error messages.
async function request(a, url, options = {}, redirect = false, step = 'Philips-Cloud') {
    let response;
    try {
        response = await fetch(url, { ...options, redirect: 'manual',
            signal: AbortSignal.any([a.abort.signal, AbortSignal.timeout(20000)]) });
    } catch (error) {
        const reasons = { ENOTFOUND: 'DNS-Auflösung fehlgeschlagen', EAI_AGAIN: 'DNS-Auflösung fehlgeschlagen',
            ECONNREFUSED: 'Verbindung abgelehnt', ETIMEDOUT: 'Zeitüberschreitung',
            CERT_HAS_EXPIRED: 'TLS-Zertifikat abgelaufen', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS-Zertifikat nicht vertrauenswürdig' };
        const reason = reasons[error.cause?.code] || (error.name === 'TimeoutError' ? 'Zeitüberschreitung' : 'Cloud nicht erreichbar');
        throw new Error(`${step}: ${reason}`);
    }
    if (account !== a) throw new Error('Verbindung beendet');
    if (redirect) {
        if (![301, 302, 303, 307, 308].includes(response.status)) throw new Error('Philips-Anmeldung: Weiterleitung fehlt');
        const location = response.headers.get('location');
        if (!location) throw new Error('Philips-Anmeldung: Weiterleitung fehlt');
        return new URL(location, url);
    }
    if (!response.ok) {
        const err = new Error(`${step}: HTTP ${response.status}`);
        err.auth = [400, 401, 403].includes(response.status);
        throw err;
    }
    let body;
    try { body = await response.json(); }
    catch { throw new Error(`${step}: ungültige JSON-Antwort`); }
    if (!body || typeof body !== 'object') throw new Error('Philips-Cloud: ungültige Antwort');
    if (body.errorCode !== undefined && Number(body.errorCode) !== 0) {
        throw new Error(Number(body.errorCode) === 206001
            ? 'Philips-Konto unvollständig. Registrierung in der offiziellen App abschließen.'
            : `${step}: Philips hat die Anfrage abgelehnt (Code ${Number(body.errorCode) || 'unbekannt'})`);
    }
    return body;
}
function form(a, url, data, step = 'Philips-Anmeldung') {
    return request(a, url, { method: 'POST', body: new URLSearchParams(data), headers: {
        Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'okhttp/4.12.0 (Android 14; Pixel 7)',
    } }, false, step);
}
function providerSucceeded(result) { return result.errorCode === 0 || result.errorCode === '0'; }
function api(a, suffix) {
    return request(a, API + suffix, { headers: { Authorization: `Bearer ${a.tokens.access_token}`,
        Accept: 'application/json', 'User-Agent': 'okhttp/4.12.0 (Android 14; Pixel 7)' } });
}
function saveTokens(a, result) {
    if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('Philips-Anmeldung: Access Token fehlt');
    const lifetime = Number(result.expires_in);
    const expiry = Number(result.exp);
    a.tokens = { access_token: result.access_token,
        refresh_token: result.refresh_token || a.tokens?.refresh_token || '',
        expiresAt: expiry > 0 ? expiry * 1000 : Date.now() + (lifetime > 0 ? lifetime : 3600) * 1000 };
    persist(a);
}
function persist(a) {
    const context = a.context;
    if (!context || context.setGlobalSetting('session', JSON.stringify({ email: a.email, ...a.tokens, otpAt: a.otpAt, airUid: a.airUid,
        ...(a.vToken ? { vToken: a.vToken, otpAt: a.otpAt } : {}) })) === false) {
        throw new Error('Philips-Sitzung konnte nicht gespeichert werden');
    }
}
async function login(a, code) {
    if (!a.vToken || Date.now() - a.otpAt > 10 * 60 * 1000) throw new Error('Zuerst einen neuen E-Mail-Code anfordern');
    if (!/^\d{4,10}$/.test(code)) throw new Error('Gültigen E-Mail-Code eintragen');
    const verification = await form(a, `${CDC}/accounts.auth.otp.email.login`, {
        email: a.email, code, vToken: a.vToken, apiKey: API_KEY, format: 'json' }, 'Code bestätigen');
    if (!providerSucceeded(verification)) throw new Error('Code bestätigen: Erfolgsbestätigung von Philips fehlt');
    const session = verification.sessionInfo?.cookieValue;
    if (!session) throw new Error('Philips-Anmeldung: Sitzung fehlt');
    const verifier = crypto.randomBytes(64).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    const location = await request(a, `${ISSUER}/authorize?${new URLSearchParams({
        client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES,
        state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'none' })}`, {}, true);
    const context = location.searchParams.get('context');
    if (!context) throw new Error('Philips-Anmeldung: OAuth-Kontext fehlt');
    const ids = await form(a, `${CDC}/socialize.getIDs`, { APIKey: API_KEY, includeTicket: 'true', format: 'json' });
    if (!ids.gmidTicket) throw new Error('Philips-Anmeldung: Ticket fehlt');
    const redirect = await request(a, `${ISSUER}/authorize/continue?${new URLSearchParams({
        context, login_token: session, gmidTicket: ids.gmidTicket, client_id: CLIENT_ID })}`, {}, true);
    if (!redirect.href.startsWith(REDIRECT) || redirect.searchParams.has('error')
        || (redirect.searchParams.has('state') && redirect.searchParams.get('state') !== state)) {
        throw new Error('Philips-Anmeldung: ungültige OAuth-Weiterleitung');
    }
    const authCode = redirect.searchParams.get('code');
    if (!authCode) throw new Error('Philips-Anmeldung: Autorisierungscode fehlt');
    const tokens = await form(a, `${ISSUER}/token`, { client_id: CLIENT_ID, grant_type: 'authorization_code',
        code: authCode, redirect_uri: REDIRECT, code_verifier: verifier });
    // A new login must not inherit the previous account's refresh token.
    a.tokens = undefined;
    a.vToken = undefined;
    a.airUid = typeof verification.UID === 'string' && IDENTIFIER.test(verification.UID) ? verification.UID : undefined;
    a.airToken = undefined;
    saveTokens(a, tokens);
}

// The same Air+ account has a separate MxChip device registry. Its account ID
// comes from the verified OTP response, never from a manually entered device ID.
async function airRequest(a, suffix, body, headers = {}) {
    const result = await request(a, AIR_API + suffix, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    }, false, 'Philips Air+');
    if (result.meta?.code !== 0) {
        const error = new Error('Philips Air+: Anfrage abgelehnt');
        error.auth = [10001, 10002].includes(result.meta?.code);
        throw error;
    }
    return result.data;
}
async function airToken(a) {
    if (a.airToken?.expiresAt > Date.now() + 15 * 60 * 1000) return a.airToken.value;
    if (a.airTokenRequest) return a.airTokenRequest;
    a.airTokenRequest = (async () => {
        let clock = await airRequest(a, 'device/serverTime/');
        if (typeof clock === 'string') {
            try { clock = JSON.parse(clock); } catch { clock = null; }
        }
        const timestamp = String(clock?.timestamp2 ?? '');
        if (!/^\d{1,20}$/.test(timestamp)) throw new Error('Philips Air+: ungültige Serverzeit');
        const username = `PHILIPS:${a.airUid}`;
        // URLSearchParams follows the app's Java form encoding (including spaces).
        const canonical = new URLSearchParams({ app_id: AIR_APP, timestamp, username }).toString();
        const inner = crypto.createHmac('sha256', AIR_SIGNING).update(canonical).digest('hex');
        const signature = crypto.createHmac('sha256', username).update(inner).digest('hex');
        const data = await airRequest(a, 'enduser/v2/getToken/', { app_id: AIR_APP, timestamp, username }, { Signature: signature });
        let expiry;
        try { expiry = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64url').toString('utf8')).exp; } catch { /* Invalid token */ }
        if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry * 1000 <= Date.now()) {
            throw new Error('Philips Air+: ungültiger Sitzungstoken');
        }
        a.airToken = { value: data.token, expiresAt: expiry * 1000 };
        return data.token;
    })();
    try { return await a.airTokenRequest; }
    finally { a.airTokenRequest = undefined; }
}
async function airApi(a, suffix, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const token = await airToken(a);
        try { return await airRequest(a, suffix, body, { Authorization: `jwt ${token}` }); }
        catch (error) {
            if (!error.auth || attempt) throw error;
            if (a.airToken?.value === token) a.airToken = undefined;
        }
    }
}
function scheduleRefresh(a, delay) {
    clearTimeout(a.refreshTimer);
    if (!nodes.size) return;
    a.refreshTimer = setTimeout(() => {
        if (account !== a) return;
        if (a.busy) { scheduleRefresh(a, 30000); return; }
        run(a, async () => {
            await refresh(a);
            await discover(a);
        });
    }, delay ?? Math.max(60000, a.tokens.expiresAt - Date.now() - 5 * 60 * 1000));
    a.refreshTimer.unref?.();
}
async function refresh(a) {
    if (!a.tokens?.refresh_token) {
        const err = new Error('Philips-Sitzung abgelaufen. Per E-Mail-Code erneut anmelden');
        err.auth = true;
        throw err;
    }
    const tokens = await form(a, `${ISSUER}/token`, { client_id: CLIENT_ID,
        grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token });
    saveTokens(a, tokens);
}
async function discover(a) {
    closeConnections(a);
    a.devices = undefined;
    const found = new Map(), warnings = [];
    const registryKey = id => /^[a-f\d]{32}$/i.test(id.replace(/-/g, '')) ? id.replace(/-/g, '').toLowerCase() : id;
    let successes = 0;
    try {
        const raw = await api(a, '/device');
        const devices = Array.isArray(raw) ? raw : raw.devices
            || Object.values(raw).find(v => Array.isArray(v) && v.some(d => d?.uuid)) || [];
        if (!Array.isArray(devices)) throw new Error('Philips-Cloud: ungültige Antwort');
        for (const d of devices) {
            const uuid = typeof (d?.uuid || d?.id) === 'string' ? (d.uuid || d.id).replace(/^da-/, '') : '';
            if (UUID.test(uuid)) found.set(registryKey(uuid), { uuid, name: String(d.name || d.deviceName || d.friendlyName || 'Philips Air+'), backend: 'legacy' });
        }
        if (nodes.size && found.size) {
            const signature = await api(a, '/signature');
            const user = await api(a, '');
            if (!signature.signature || !user.id) throw new Error('Philips-Cloud: MQTT-Signatur oder Benutzer-ID fehlt');
            a.signature = signature.signature;
            a.userId = String(user.id).replace(/^([a-f\d]{8})([a-f\d]{4})([a-f\d]{4})([a-f\d]{4})([a-f\d]{12})$/i, '$1-$2-$3-$4-$5');
        }
        successes++;
    } catch (error) {
        if (account !== a) throw error;
        found.clear();
        warnings.push(error.message);
    }
    if (a.airUid) {
        try {
            const devices = await airApi(a, 'enduser/deviceList/');
            if (!Array.isArray(devices) || devices.some(d => typeof d?.device_id !== 'string' || !IDENTIFIER.test(d.device_id)
                || !d.device_info || typeof d.device_info !== 'object' || Array.isArray(d.device_info))) {
                throw new Error('Philips Air+: ungültige Geräteliste');
            }
            for (const d of devices) {
                const info = d.device_info;
                const key = registryKey(d.device_id);
                if (found.has(key) && info.modelid !== 'AC2220/10') continue;
                found.set(key, { uuid: d.device_id, backend: 'air',
                    name: String(info.name || info.device_alias || 'Philips Air+'),
                    model: typeof info.modelid === 'string' ? info.modelid : '' });
            }
            successes++;
        } catch (error) {
            if (account !== a) throw error;
            warnings.push(error.message);
        }
    } else warnings.push(AIR_UPGRADE);
    if (!successes) throw new Error(warnings[0]);
    a.devices = [...found.values()];
    a.discoveryWarning = warnings.join('; ');
    if (!nodes.size) return;
    for (const node of nodes.values()) bind(a, node);
    scheduleRefresh(a, warnings.length && a.airUid ? 5 * 60 * 1000 : undefined);
    if (a.discoveryWarning) notify(a, a.discoveryWarning, true);
}
function run(a, task) {
    if (a.busy) { notify(a, 'Philips-Anfrage läuft bereits', true); return; }
    a.busy = true;
    Promise.resolve().then(task).catch(err => {
        if (account !== a) return;
        notify(a, err.message, true);
        if (err.auth) {
            clearTimeout(a.refreshTimer);
            closeConnections(a);
            notify(a, 'Per E-Mail-Code erneut anmelden');
        } else if (a.tokens) scheduleRefresh(a, 5 * 60 * 1000);
    }).finally(() => { a.busy = false; });
}

function bind(a, node) {
    emit(node, 'devices', JSON.stringify(a.devices));
    const chosen = node.configuredUuid || (a.devices.length === 1 ? a.devices[0].uuid : '');
    if (!chosen || !a.devices.some(d => d.uuid === chosen)) {
        status(node, false, 'Geräte-ID auswählen (siehe Geräte-Liste)');
        return;
    }
    node.uuid = chosen;
    let connection = a.connections.get(chosen);
    if (!connection) {
        const device = a.devices.find(d => d.uuid === chosen);
        connection = { uuid: chosen, backend: device.backend, model: device.model, properties: {}, ready: false, failures: 0, version: -1 };
        a.connections.set(chosen, connection);
        connect(a, connection);
    }
    status(node, connection.ready, connection.ready ? 'Verbunden' : 'Verbinde …');
    values(node, connection.properties);
}
function connectionNodes(connection) { return [...nodes.values()].filter(n => n.uuid === connection.uuid); }
function send(connection, topic, payload, qos = 0, onSent) {
    if (!connection.ready) throw new Error('Nicht verbunden; Befehl wurde verworfen');
    const client = connection.client;
    client.publish(topic, JSON.stringify(payload), { qos, retain: false }, err => {
        if (connection.closed || !connection.ready || connection.client !== client) return;
        if (err) {
            for (const node of connectionNodes(connection)) fail(node, 'MQTT-Befehl konnte nicht gesendet werden');
        } else onSent?.();
    });
}
function port(connection, cn, portName, properties = {}, qos = 0, onSent) {
    send(connection, `da_ctrl/da-${connection.uuid}/to_ncp`, { cid: crypto.randomBytes(4).toString('hex'),
        time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), type: 'command', cn, ct: 'mobile',
        data: { portName, properties } }, qos, onSent);
}
function snapshot(connection) {
    connection.lastSnapshot = Date.now();
    if (connection.backend === 'air') {
        connection.readToken = crypto.randomBytes(12).toString('hex');
        send(connection, `$aws/things/${connection.uuid}/shadow/get`, { clientToken: connection.readToken }, 1);
        return;
    }
    for (const name of ['Status', 'Config', 'filtRd']) port(connection, 'getPort', name);
    send(connection, `$aws/things/da-${connection.uuid}/shadow/get`, {});
}
function airControl(connection, desired) {
    connection.writeToken = crypto.randomBytes(12).toString('hex');
    const [key, expected] = Object.entries(desired)[0];
    send(connection, `$aws/things/${connection.uuid}/shadow/update`, {
        clientToken: connection.writeToken, state: { desired },
    }, 1, () => verifyCommand(connection, key, expected));
}
// Read back after writes; never treat the cached value or a shadow desired state as confirmation.
function clearVerification(connection) {
    clearTimeout(connection.verificationTimer);
    connection.verificationTimer = undefined;
    connection.pending = undefined;
}
function verifyCommand(connection, key, expected) {
    connection.pending ||= new Map();
    connection.pending.set(key, { expected, requested: false });
    clearTimeout(connection.verificationTimer);
    let attempts = 0;
    const poll = () => {
        if (connection.closed || !connection.ready || !connection.pending?.size) return;
        if (attempts++ >= 3) {
            clearVerification(connection);
            for (const node of connectionNodes(connection)) fail(node, 'Philips-Befehl nicht bestätigt: Gerätestatus fehlt oder weicht vom Sollwert ab');
            return;
        }
        for (const pending of connection.pending.values()) pending.requested = true;
        try { snapshot(connection); }
        catch {
            clearVerification(connection);
            for (const node of connectionNodes(connection)) fail(node, 'Philips-Befehl nicht bestätigt: Gerätestatus fehlt oder weicht vom Sollwert ab');
            return;
        }
        // MQTT mocks (and fast clients) may deliver the response during publish.
        if (!connection.pending?.size) return;
        connection.verificationTimer = setTimeout(poll, 4000);
        connection.verificationTimer.unref?.();
    };
    connection.verificationTimer = setTimeout(poll, 1000);
    connection.verificationTimer.unref?.();
}
function checkCommand(connection, properties) {
    if (!connection.pending) return;
    for (const [key, pending] of connection.pending) {
        const actual = numeric(properties[key]);
        if (!pending.requested || actual === undefined) continue;
        const matches = key === 'D0310D' ? (actual > 0) === pending.expected : actual === pending.expected;
        if (matches) connection.pending.delete(key);
    }
    if (connection.pending.size) return;
    clearVerification(connection);
    for (const node of connectionNodes(connection)) {
        emit(node, 'error', '');
        emit(node, 'status', 'Philips-Befehl durch Gerätestatus bestätigt');
    }
}
// Some devices batch JSON objects without separators in one MQTT message.
function decode(payload) {
    const text = payload.toString('utf8');
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Nachricht zu groß');
    const result = [];
    let start = 0, depth = 0, quoted = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (depth === 0) {
            if (/\s/.test(c)) continue;
            if (c !== '{') throw new Error('Ungültiges JSON');
            start = i;
        }
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0) result.push(JSON.parse(text.slice(start, i + 1)));
        }
    }
    if (depth || quoted || !result.length) throw new Error('Ungültiges JSON');
    return result;
}
function numeric(value) {
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function values(node, properties) {
    const air = account?.connections.get(node.uuid)?.backend === 'air';
    if (typeof properties.ctn === 'string') emit(node, 'model', properties.ctn);
    for (const [handle, key] of Object.entries({ mode: 'D0310C', fanLevel: 'D0310D', pm25: 'D03221',
        allergenIndex: 'D03120', standbyMonitor: 'D03134', filterCleanHours: 'D0520D', filterReplaceHours: 'D0540E' })) {
        const value = numeric(properties[key]);
        if (value !== undefined) {
            emit(node, handle, value);
            if (handle === 'fanLevel' && !air) emit(node, 'power', value === 0 ? 0 : 1);
        }
    }
    for (const [handle, nominal, remaining] of [
        ['filterCleanPercent', 'D05207', 'D0520D'], ['filterReplacePercent', 'D05408', 'D0540E']]) {
        const total = numeric(properties[nominal]), hours = numeric(properties[remaining]);
        if (total > 0 && hours !== undefined) emit(node, handle, Math.min(100, Math.round(hours / total * 1000) / 10));
    }
    if (air) {
        const power = numeric(properties.D03102);
        if ([0, 1].includes(power)) emit(node, 'power', power);
    }
}
function airTopics(connection) {
    return ['/get/accepted', '/get/rejected', '/update/documents', '/update/accepted', '/update/rejected']
        .map(suffix => `$aws/things/${connection.uuid}/shadow${suffix}`);
}
async function prepareAirConnection(a, connection) {
    const active = () => account === a && !connection.closed && a.connections.get(connection.uuid) === connection;
    try {
        const data = await airApi(a, 'enduser/v2/mqttInfo/', { device_id: [connection.uuid] });
        if (!active()) return;
        const matches = Array.isArray(data?.mqttinfos) ? data.mqttinfos.filter(d => d?.device_id === connection.uuid) : [];
        const info = matches.length === 1 ? matches[0] : null;
        if (!info || typeof info.endpoint !== 'string' || !/^[a-z0-9-]+-ats\.iot\.[a-z0-9-]+\.amazonaws\.com$/.test(info.endpoint)
            || typeof info.path !== 'string' || !info.path.startsWith('/mqtt?') || info.path.length > 8192 || /[\r\n#]/.test(info.path)
            || typeof info.client_id !== 'string' || !IDENTIFIER.test(info.client_id)) {
            throw new Error('Philips Air+: ungültige MQTT-Verbindungsdaten');
        }
        // Use exactly the account-owned device's server-issued client ID/path.
        // Every reconnect retrieves a new signed URL rather than reusing it.
        connect(a, connection, info);
    } catch (error) {
        if (!active()) return;
        for (const node of connectionNodes(connection)) {
            status(node, false, 'Getrennt; verbinde erneut …');
            fail(node, error.message);
        }
        connection.retry = setTimeout(() => {
            connection.retry = undefined;
            if (active()) connect(a, connection);
        }, Math.min(300000, 30000 * 2 ** Math.min(connection.failures++, 4)));
        connection.retry.unref?.();
    }
}
function receiveShadow(connection, topic, message) {
    const prefix = `$aws/things/${connection.uuid}/shadow`;
    if (topic.endsWith('/rejected')) {
        if (message.clientToken && [connection.readToken, connection.writeToken].includes(message.clientToken)) {
            clearVerification(connection);
            for (const node of connectionNodes(connection)) fail(node, 'Philips Air+: Gerätestatus oder Befehl abgelehnt');
        }
        return;
    }
    const document = topic === `${prefix}/update/documents` ? message.current : message;
    const reported = document?.state?.reported;
    if (!reported || typeof reported !== 'object' || Array.isArray(reported)
        || !Number.isSafeInteger(document.version) || document.version < connection.version) return;
    const full = topic === `${prefix}/get/accepted` || topic === `${prefix}/update/documents`;
    const properties = full ? {} : { ...connection.properties };
    for (const [key, value] of Object.entries(reported)) {
        if (value === null) delete properties[key];
        else if (/^D[0-9A-F]{5}$/.test(key) || key === 'ctn') properties[key] = value;
    }
    connection.version = document.version;
    connection.properties = properties;
    // Registry metadata identifies the model even when the shadow omits ctn.
    if (!properties.ctn && connection.model) properties.ctn = connection.model;
    for (const node of connectionNodes(connection)) values(node, properties);
    // Only a response to our fresh read verifies a command. Desired states and
    // update acknowledgements are not evidence that the purifier applied it.
    if (topic === `${prefix}/get/accepted` && message.clientToken === connection.readToken) checkCommand(connection, reported);
}
function connect(a, connection, info) {
    if (connection.backend === 'air' && !info) { void prepareAirConnection(a, connection); return; }
    const active = () => account === a && !connection.closed && a.connections.get(connection.uuid) === connection
        && connection.client === client && !connection.retry;
    const options = {
        clientId: info ? info.client_id : `${a.userId}_${connection.uuid}_kaenix_${a.instance}`, protocolVersion: 4,
        clean: true, keepalive: 60, connectTimeout: 20000, reconnectPeriod: 0,
        resubscribe: false, queueQoSZero: false,
    };
    if (!info) options.wsOptions = { headers: { 'x-amz-customauthorizer-name': 'CustomAuthorizer',
        'x-amz-customauthorizer-signature': a.signature, tenant: 'da', 'content-type': 'application/json',
        'token-header': `Bearer ${a.tokens.access_token}` } };
    const library = getMqtt();
    let client;
    try { client = library.connect(info ? `wss://${info.endpoint}:443${info.path}` : 'wss://ats.prod.eu-da.iot.versuni.com:443/mqtt', options); }
    catch { throw new Error('Philips-MQTT-Verbindungsfehler'); }
    connection.client = client;
    const retry = () => {
        if (!active() || connection.retry) return;
        connection.ready = false;
        clearVerification(connection);
        clearTimeout(connection.watchdog);
        for (const node of connectionNodes(connection)) status(node, false, 'Getrennt; verbinde erneut …');
        const delay = Math.min(300000, 30000 * 2 ** Math.min(connection.failures++, 4));
        connection.retry = setTimeout(() => {
            connection.retry = undefined;
            if (!active()) return;
            if (connection.backend !== 'air' && a.tokens.expiresAt < Date.now() + 60000) run(a, async () => { await refresh(a); await discover(a); });
            else connect(a, connection);
        }, delay);
        connection.retry.unref?.();
        client.end(true);
    };
    connection.watchdog = setTimeout(retry, 25000);
    connection.watchdog.unref?.();
    const inbound = `da_ctrl/da-${connection.uuid}/from_ncp`;
    const topics = info ? airTopics(connection) : inbound;
    client.on('connect', () => {
        if (!active()) return;
        client.subscribe(topics, { qos: info ? 1 : 0 }, (err, granted) => {
            if (!active()) return;
            if (err || granted?.length !== (info ? topics.length : 1) || granted.some(g => g.qos > 2)) { retry(); return; }
            clearTimeout(connection.watchdog);
            connection.ready = true;
            connection.failures = 0;
            for (const node of connectionNodes(connection)) { status(node, true, 'Verbunden'); emit(node, 'error', ''); }
            try { snapshot(connection); } catch { retry(); }
        });
    });
    client.on('close', retry);
    client.on('error', () => {
        if (!active()) return;
        for (const node of connectionNodes(connection)) fail(node, 'Philips-MQTT-Verbindungsfehler');
        retry();
    });
    client.on('message', (topic, payload) => {
        if (!active() || (info ? !topics.includes(topic) : topic !== inbound)) return;
        try {
            for (const message of decode(payload)) {
                if (info) { receiveShadow(connection, topic, message); continue; }
                const data = message.data;
                if (!data || Array.isArray(data) || ![undefined, 'Status', 'Config', 'filtRd'].includes(data.portName)) continue;
                if (!data.properties || typeof data.properties !== 'object' || Array.isArray(data.properties)) continue;
                Object.assign(connection.properties, data.properties);
                for (const node of connectionNodes(connection)) values(node, connection.properties);
                checkCommand(connection, data.properties);
            }
        } catch { for (const node of connectionNodes(connection)) fail(node, 'Ungültige Philips-MQTT-Nachricht'); }
    });
}

function ensureAccount(context) {
    const email = String(context.globalSetting('email') || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (account) { stopAccount(account); account = undefined; }
        throw new Error('Philips-Konto-E-Mail in den globalen Plugin-Einstellungen eintragen');
    }
    const stored = String(context.globalSetting('session') || '');
    if (account && (account.email !== email || (!stored && (account.tokens || account.vToken)))) {
        stopAccount(account);
        account = undefined;
        for (const node of nodes.values()) { node.uuid = undefined; node.last = {}; }
    }
    if (!account) {
        account = { email, context, abort: new AbortController(), connections: new Map(), instance: crypto.randomBytes(4).toString('hex') };
        try {
            const saved = JSON.parse(stored);
            if (saved.email === email) {
                if (typeof saved.airUid === 'string' && IDENTIFIER.test(saved.airUid)) account.airUid = saved.airUid;
                if (saved.access_token) account.tokens = { access_token: saved.access_token,
                    refresh_token: saved.refresh_token, expiresAt: saved.expiresAt };
                if (Number.isFinite(saved.otpAt)) account.otpAt = saved.otpAt;
                if (saved.vToken && Date.now() - saved.otpAt < 10 * 60 * 1000) {
                    account.vToken = saved.vToken;
                    account.otpAt = saved.otpAt;
                }
            }
        } catch { /* New account */ }
    }
    account.context = context;
    return account;
}
async function globalAction(action, values, context) {
    if (!['requestCode', 'verifyCode', 'refreshDevices', 'logout'].includes(action)) throw new Error('Unbekannte Philips-Aktion');
    if (action === 'logout') {
        if (account?.busy) throw new Error('Philips-Anfrage läuft bereits; bitte warten');
        if (context.setGlobalSetting('session', '') === false) throw new Error('Abmelden konnte nicht gespeichert werden');
        if (account) { stopAccount(account); account = undefined; }
        for (const node of nodes.values()) { node.uuid = undefined; node.last = {}; status(node, false, 'Abgemeldet'); }
        return { message: 'Abgemeldet', devices: [] };
    }
    const a = ensureAccount(context);
    if (a.busy) throw new Error('Philips-Anfrage läuft bereits; bitte warten');
    a.busy = true;
    try {
        if (action === 'refreshDevices') {
            if (!a.tokens) throw new Error('Zuerst per E-Mail-Code anmelden');
            if (!(a.tokens.expiresAt > Date.now() + 60000)) await refresh(a);
            await discover(a);
            return { message: a.discoveryWarning || 'Geräteliste aktualisiert', signedIn: true, devices: a.devices };
        }
        if (action === 'requestCode') {
            if (a.otpAt && Date.now() - a.otpAt < 60000) throw new Error('Bitte mindestens 60 Sekunden vor einem neuen E-Mail-Code warten');
            a.otpAt = Date.now();
            a.vToken = undefined;
            persist(a); // Cooldown and invalidation survive reloads, including failed sends.
            context.info?.('Philips: E-Mail-Code-Anforderung gestartet');
            const result = await form(a, `${CDC}/accounts.auth.otp.email.sendCode`, {
                email: a.email, apiKey: API_KEY, format: 'json' }, 'Code anfordern');
            if (!providerSucceeded(result) || !result.vToken) throw new Error('Code anfordern: Erfolgsbestätigung oder Verifikationstoken von Philips fehlt');
            a.vToken = result.vToken;
            persist(a);
            const message = 'Philips hat die Code-Anforderung bestätigt. Posteingang und Spam-Ordner prüfen, Code eingeben und Anmeldung bestätigen.';
            notify(a, message);
            context.info?.('Philips: E-Mail-Code-Anforderung vom Anbieter bestätigt');
            return { message, codeRequested: true };
        }
        await login(a, String(values.code || '').trim());
        notify(a, 'Bei Philips angemeldet');
        try { await discover(a); }
        catch (error) {
            if (account !== a) throw error;
            notify(a, error.message, true);
            context.warn(error.message);
            scheduleRefresh(a, 5 * 60 * 1000);
            return { message: `Anmeldung erfolgreich. Geräteabruf fehlgeschlagen: ${error.message}`, devices: [], signedIn: true };
        }
        const message = a.discoveryWarning || (a.devices.length ? 'Anmeldung erfolgreich' : 'Anmeldung erfolgreich, aber keine Air+-Geräte gefunden. Konto in der offiziellen App prüfen.');
        notify(a, message);
        context.info?.('Philips: Anmeldung erfolgreich');
        return { message, signedIn: true, devices: a.devices };
    } catch (error) {
        notify(a, error.message, true);
        context.warn(error.message);
        throw error;
    } finally { a.busy = false; }
}

// Expose only flow state; verification tokens and OAuth sessions stay server-side.
function getGlobalUiState(settings) {
    let session;
    try { session = JSON.parse(settings.session || '{}'); } catch { session = {}; }
    const sameAccount = session.email === String(settings.email || '').trim();
    const phase = sameAccount && session.access_token ? 'signedIn'
        : sameAccount && session.vToken ? 'codeRequested' : 'unpaired';
    return {
        phase,
        readOnlyKeys: phase === 'unpaired' ? [] : ['email'],
        visibleActionKeys: phase === 'signedIn' ? ['refreshDevices', 'logout']
            : phase === 'codeRequested' ? ['verifyCode', 'requestCode', 'logout'] : ['requestCode'],
        hideSave: true,
    };
}

module.exports = {
    type: 'philips-air-plus', label: 'Philips Air Plus', category: 'Geräte', color: '#f97316',
    description: 'Philips AC0651/10 und AC2220/10 über Air+ Cloud/MQTT steuern. Anmeldung per E-Mail-Code, Live-Sensoren und Filterstatus.',
    globalSettings: [
        { key: 'email', label: 'Philips Air+ Konto (E-Mail)', type: 'text' },
    ],
    globalActions: [
        { key: 'requestCode', label: 'E-Mail-Code anfordern' },
        { key: 'verifyCode', label: 'Anmeldung bestätigen', fields: [
            { key: 'code', label: 'E-Mail-Code', type: 'password', placeholder: 'Code aus der E-Mail',
                inputMode: 'numeric', autoComplete: 'one-time-code' },
        ] },
        { key: 'logout', label: 'Abmelden' },
        { key: 'refreshDevices', label: 'Geräteliste aktualisieren' },
    ],
    handleGlobalAction: globalAction,
    getGlobalUiState,
    config: [
        { key: 'deviceUuid', label: 'Geräte-ID (leer bei genau einem Gerät)', type: 'text' },
    ],
    inputs: [
        { handle: 'power', label: 'Ein/Aus (1/0)' },
        { handle: 'mode', label: 'Modus (modellabhängig, siehe Plugin-Dokumentation)' },
        { handle: 'standbyMonitor', label: 'Standby-Monitor (1/0)' },
        { handle: 'triggerStatus', label: 'Status abfragen' },
        { handle: 'resetFilterClean', label: 'Filter gereinigt (Trigger)' },
        { handle: 'resetFilterReplace', label: 'Filter ersetzt (Trigger)' },
        { handle: 'reconnect', label: 'Neu verbinden' },
    ],
    outputs: [
        { handle: 'connected', label: 'Cloud verbunden (1/0)' },
        { handle: 'power', label: 'Ein/Aus Rückmeldung' },
        { handle: 'mode', label: 'Modus Rückmeldung' },
        { handle: 'fanLevel', label: 'Lüfterstufe' },
        { handle: 'pm25', label: 'PM2.5 (µg/m³)' },
        { handle: 'allergenIndex', label: 'Allergenindex' },
        { handle: 'standbyMonitor', label: 'Standby-Monitor Rückmeldung' },
        { handle: 'filterCleanHours', label: 'Filter reinigen in (h)' },
        { handle: 'filterCleanPercent', label: 'Filter Reinigung Rest (%)' },
        { handle: 'filterReplaceHours', label: 'Filter ersetzen in (h)' },
        { handle: 'filterReplacePercent', label: 'Filter Lebensdauer Rest (%)' },
        { handle: 'model', label: 'Modell' },
        { handle: 'devices', label: 'Geräte-Liste (JSON)' },
        { handle: 'status', label: 'Status' },
        { handle: 'error', label: 'Fehler' },
    ],
    execute(inputs, data, context) {
        const id = context.nodeId;
        try {
            const a = ensureAccount(context);
            const configuredUuid = String(data.deviceUuid || '').trim().replace(/^da-/, '');
            if (configuredUuid && !IDENTIFIER.test(configuredUuid)) {
                disposeNode(id);
                throw new Error('Ungültige Geräte-ID');
            }
            let node = nodes.get(id);
            if (node && node.configuredUuid !== configuredUuid) { disposeNode(id, true); node = undefined; }
            if (!node) {
                node = { id, configuredUuid, context, last: {} };
                nodes.set(id, node);
            }
            node.context = context;
            if (!a.started) {
                a.started = true;
                status(node, false, a.tokens ? 'Verbinde …' : a.vToken
                    ? 'E-Mail-Code eintragen und Anmeldung bestätigen' : 'E-Mail-Code anfordern');
                if (a.tokens) run(a, async () => {
                    if (!(a.tokens.expiresAt > Date.now() + 60000)) await refresh(a);
                    await discover(a);
                });
            } else if (!node.uuid && a.devices) bind(a, node);
            const handle = context.triggerHandle;
            const value = inputs[handle];
            const pulse = [true, 1, '1'].includes(value);
            if (handle === 'reconnect' && pulse) {
                if (!a.tokens) throw new Error('Zuerst per E-Mail-Code anmelden');
                if (a.reconnectAt && Date.now() - a.reconnectAt < 30000) throw new Error('Bitte 30 Sekunden vor erneutem Verbindungsaufbau warten');
                a.reconnectAt = Date.now();
                run(a, async () => { if (a.tokens.expiresAt < Date.now() + 60000) await refresh(a); await discover(a); });
                return {};
            }
            if (!['power', 'mode', 'standbyMonitor', 'triggerStatus', 'resetFilterClean', 'resetFilterReplace'].includes(handle)) return {};
            if (['triggerStatus', 'resetFilterClean', 'resetFilterReplace'].includes(handle) && !pulse) return {};
            const connection = a.connections.get(node.uuid);
            if (!connection?.ready) throw new Error('Nicht verbunden; Befehl wurde verworfen');
            const air = connection.backend === 'air';
            const model = connection.properties.ctn || (air ? connection.model : '');
            if (handle !== 'triggerStatus' && (air ? model !== 'AC2220/10' : model !== 'AC0651/10')) {
                throw new Error('Philips: Modell wird für diese Verbindung nicht unterstützt oder noch nicht gemeldet');
            }
            if (air && ['standbyMonitor', 'resetFilterClean', 'resetFilterReplace'].includes(handle)) {
                throw new Error('Philips AC2220/10: Standby-Monitor und Filter-Reset werden nicht unterstützt');
            }
            if (handle === 'power' || handle === 'standbyMonitor') {
                if (![true, false, 0, 1, '0', '1'].includes(value)) throw new Error('Ein/Aus muss 0 oder 1 sein');
                const on = [true, 1, '1'].includes(value);
                if (air) airControl(connection, { D03102: on ? 1 : 0 });
                else if (handle === 'power') send(connection, `$aws/things/da-${node.uuid}/shadow/update`, { state: { desired: { powerOn: on } } }, 0,
                    () => verifyCommand(connection, 'D0310D', on));
                else port(connection, 'setPort', 'Control', { D03134: on ? 1 : 0 }, 0,
                    () => verifyCommand(connection, 'D03134', on ? 1 : 0));
            } else if (handle === 'mode') {
                const modes = air ? AIR_MODES : MODES;
                const mode = typeof value === 'string' && Object.hasOwn(modes, value.toLowerCase()) ? modes[value.toLowerCase()] : numeric(value);
                if (!Object.values(modes).includes(mode)) throw new Error(air
                    ? 'Philips AC2220/10: Modus muss 0, 1–5, 17, 18 oder 19 sein'
                    : 'Modus muss 0, 1, 17 oder 18 sein (auto/medium/sleep/turbo)');
                if (air) airControl(connection, { D0310C: mode });
                else port(connection, 'setPort', 'Control', { D0310C: mode }, 0,
                    () => verifyCommand(connection, 'D0310C', mode));
            } else if (handle === 'resetFilterClean') port(connection, 'setPort', 'filtWr', { D0520D: 720 }, 1,
                () => verifyCommand(connection, 'D0520D', 720));
            else if (handle === 'resetFilterReplace') port(connection, 'setPort', 'filtWr', { D0540E: 4800 }, 1,
                () => verifyCommand(connection, 'D0540E', 4800));
            else {
                if (connection.lastSnapshot && Date.now() - connection.lastSnapshot < 30000) return {};
                snapshot(connection);
            }
        } catch (err) {
            const node = nodes.get(id);
            if (node) fail(node, err.message);
            else { context.setNodeStatus?.(false); context.emitOutput('connected', 0); context.emitOutput('error', err.message); context.warn(err.message); }
        }
        return {};
    },
    dispose(nodeId) {
        if (nodeId != null) disposeNode(nodeId);
        else {
            for (const id of [...nodes.keys()]) disposeNode(id);
            if (account) { stopAccount(account); account = undefined; }
        }
    },
};
