/**
 * @plugin Philips Air Plus
 * @version 1.0.1
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 *
 * Protocol/authentication adapted from NikGro/philips-air-plus-homeassistant,
 * revision e091838cbea4444899694431f57bbf78992c834e (MIT).
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
        connection.closed = true;
        connection.client?.end(true);
    }
    a.connections.clear();
    for (const node of nodes.values()) status(node, false);
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
    if (!context || context.setGlobalSetting('session', JSON.stringify({ email: a.email, ...a.tokens, otpAt: a.otpAt,
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
    saveTokens(a, tokens);
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
    const raw = await api(a, '/device');
    const devices = Array.isArray(raw) ? raw : raw.devices
        || Object.values(raw).find(v => Array.isArray(v) && v.some(d => d?.uuid)) || [];
    a.devices = devices.filter(d => typeof (d?.uuid || d?.id) === 'string').map(d => ({
        uuid: (d.uuid || d.id).replace(/^da-/, ''), name: String(d.name || d.deviceName || d.friendlyName || 'Philips Air+'),
    })).filter(d => /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(d.uuid));
    if (!nodes.size) return;
    const signature = await api(a, '/signature');
    const user = await api(a, '');
    if (!signature.signature || !user.id) throw new Error('Philips-Cloud: MQTT-Signatur oder Benutzer-ID fehlt');
    a.signature = signature.signature;
    a.userId = String(user.id).replace(/^([a-f\d]{8})([a-f\d]{4})([a-f\d]{4})([a-f\d]{4})([a-f\d]{12})$/i, '$1-$2-$3-$4-$5');
    for (const node of nodes.values()) bind(a, node);
    scheduleRefresh(a);
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
        status(node, false, 'Geräte-UUID auswählen (siehe Geräte-Liste)');
        return;
    }
    node.uuid = chosen;
    let connection = a.connections.get(chosen);
    if (!connection) {
        connection = { uuid: chosen, properties: {}, ready: false, failures: 0 };
        a.connections.set(chosen, connection);
        connect(a, connection);
    }
    status(node, connection.ready, connection.ready ? 'Verbunden' : 'Verbinde …');
    values(node, connection.properties);
}
function connectionNodes(connection) { return [...nodes.values()].filter(n => n.uuid === connection.uuid); }
function send(connection, topic, payload, qos = 0) {
    if (!connection.ready) throw new Error('Nicht verbunden; Befehl wurde verworfen');
    connection.client.publish(topic, JSON.stringify(payload), { qos, retain: false }, err => {
        if (connection.closed || !err) return;
        for (const node of connectionNodes(connection)) fail(node, 'MQTT-Befehl konnte nicht gesendet werden');
    });
}
function port(connection, cn, portName, properties = {}, qos = 0) {
    send(connection, `da_ctrl/da-${connection.uuid}/to_ncp`, { cid: crypto.randomBytes(4).toString('hex'),
        time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), type: 'command', cn, ct: 'mobile',
        data: { portName, properties } }, qos);
}
function snapshot(connection) {
    connection.lastSnapshot = Date.now();
    for (const name of ['Status', 'Config', 'filtRd']) port(connection, 'getPort', name);
    send(connection, `$aws/things/da-${connection.uuid}/shadow/get`, {});
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
    if (typeof properties.ctn === 'string') emit(node, 'model', properties.ctn);
    for (const [handle, key] of Object.entries({ mode: 'D0310C', fanLevel: 'D0310D', pm25: 'D03221',
        allergenIndex: 'D03120', standbyMonitor: 'D03134', filterCleanHours: 'D0520D', filterReplaceHours: 'D0540E' })) {
        const value = numeric(properties[key]);
        if (value !== undefined) {
            emit(node, handle, value);
            if (handle === 'fanLevel') emit(node, 'power', value === 0 ? 0 : 1);
        }
    }
    for (const [handle, nominal, remaining] of [
        ['filterCleanPercent', 'D05207', 'D0520D'], ['filterReplacePercent', 'D05408', 'D0540E']]) {
        const total = numeric(properties[nominal]), hours = numeric(properties[remaining]);
        if (total > 0 && hours !== undefined) emit(node, handle, Math.min(100, Math.round(hours / total * 1000) / 10));
    }
}
function connect(a, connection) {
    const active = () => account === a && !connection.closed && a.connections.get(connection.uuid) === connection
        && connection.client === client && !connection.retry;
    const client = getMqtt().connect('wss://ats.prod.eu-da.iot.versuni.com:443/mqtt', {
        clientId: `${a.userId}_${connection.uuid}_kaenix_${a.instance}`, protocolVersion: 4,
        clean: true, keepalive: 60, connectTimeout: 20000, reconnectPeriod: 0,
        resubscribe: false, queueQoSZero: false,
        wsOptions: { headers: { 'x-amz-customauthorizer-name': 'CustomAuthorizer',
            'x-amz-customauthorizer-signature': a.signature, tenant: 'da', 'content-type': 'application/json',
            'token-header': `Bearer ${a.tokens.access_token}` } },
    });
    connection.client = client;
    const retry = () => {
        if (!active() || connection.retry) return;
        connection.ready = false;
        clearTimeout(connection.watchdog);
        for (const node of connectionNodes(connection)) status(node, false, 'Getrennt; verbinde erneut …');
        const delay = Math.min(300000, 30000 * 2 ** Math.min(connection.failures++, 4));
        connection.retry = setTimeout(() => {
            connection.retry = undefined;
            if (!active()) return;
            if (a.tokens.expiresAt < Date.now() + 60000) run(a, async () => { await refresh(a); await discover(a); });
            else connect(a, connection);
        }, delay);
        connection.retry.unref?.();
        client.end(true);
    };
    connection.watchdog = setTimeout(retry, 25000);
    connection.watchdog.unref?.();
    const inbound = `da_ctrl/da-${connection.uuid}/from_ncp`;
    client.on('connect', () => {
        if (!active()) return;
        client.subscribe(inbound, { qos: 0 }, (err, granted) => {
            if (!active()) return;
            if (err || !granted?.length || granted.some(g => g.qos > 2)) { retry(); return; }
            clearTimeout(connection.watchdog);
            connection.ready = true;
            connection.failures = 0;
            for (const node of connectionNodes(connection)) { status(node, true, 'Verbunden'); emit(node, 'error', ''); }
            snapshot(connection);
        });
    });
    client.on('close', retry);
    client.on('error', () => {
        if (!active()) return;
        for (const node of connectionNodes(connection)) fail(node, 'Philips-MQTT-Verbindungsfehler');
        retry();
    });
    client.on('message', (topic, payload) => {
        if (!active() || topic !== inbound) return;
        try {
            for (const message of decode(payload)) {
                const data = message.data;
                if (!data || Array.isArray(data) || ![undefined, 'Status', 'Config', 'filtRd'].includes(data.portName)) continue;
                if (!data.properties || typeof data.properties !== 'object' || Array.isArray(data.properties)) continue;
                Object.assign(connection.properties, data.properties);
                for (const node of connectionNodes(connection)) values(node, connection.properties);
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
    if (!['requestCode', 'verifyCode', 'logout'].includes(action)) throw new Error('Unbekannte Philips-Aktion');
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
        const message = a.devices.length ? 'Anmeldung erfolgreich' : 'Anmeldung erfolgreich, aber keine Air+-Geräte gefunden. Konto in der offiziellen App prüfen.';
        notify(a, message);
        context.info?.('Philips: Anmeldung erfolgreich');
        return { message, signedIn: true, devices: a.devices };
    } catch (error) {
        notify(a, error.message, true);
        context.warn(error.message);
        throw error;
    } finally { a.busy = false; }
}

module.exports = {
    type: 'philips-air-plus', label: 'Philips Air Plus', category: 'Geräte', color: '#f97316',
    description: 'Philips AC0651/10 über Air+ Cloud/MQTT steuern. Anmeldung per E-Mail-Code, Live-Sensoren und Filterstatus.',
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
    ],
    handleGlobalAction: globalAction,
    config: [
        { key: 'deviceUuid', label: 'Geräte-UUID (leer bei genau einem Gerät)', type: 'text' },
    ],
    inputs: [
        { handle: 'power', label: 'Ein/Aus (1/0)' },
        { handle: 'mode', label: 'Modus (0 Auto, 1 Mittel, 17 Schlaf, 18 Turbo)' },
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
            if (configuredUuid && !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(configuredUuid)) {
                disposeNode(id);
                throw new Error('Ungültige Geräte-UUID');
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
            if (connection.properties.ctn !== 'AC0651/10' && handle !== 'triggerStatus') {
                throw new Error('Steuerung erst nach Modell-Rückmeldung AC0651/10 möglich');
            }
            if (handle === 'power' || handle === 'standbyMonitor') {
                if (![true, false, 0, 1, '0', '1'].includes(value)) throw new Error('Ein/Aus muss 0 oder 1 sein');
                const on = [true, 1, '1'].includes(value);
                if (handle === 'power') send(connection, `$aws/things/da-${node.uuid}/shadow/update`, { state: { desired: { powerOn: on } } });
                else port(connection, 'setPort', 'Control', { D03134: on ? 1 : 0 });
            } else if (handle === 'mode') {
                const mode = typeof value === 'string' && Object.hasOwn(MODES, value.toLowerCase()) ? MODES[value.toLowerCase()] : numeric(value);
                if (!Object.values(MODES).includes(mode)) throw new Error('Modus muss 0, 1, 17 oder 18 sein (auto/medium/sleep/turbo)');
                port(connection, 'setPort', 'Control', { D0310C: mode });
            } else if (handle === 'resetFilterClean') port(connection, 'setPort', 'filtWr', { D0520D: 720 }, 1);
            else if (handle === 'resetFilterReplace') port(connection, 'setPort', 'filtWr', { D0540E: 4800 }, 1);
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
