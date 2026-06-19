/**
 * @plugin    UniFi Protect Snapshot
 * @version   1.2.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */

'use strict';

const https = require('https');

/**
 * Führt einen HTTPS-Request aus und gibt { status, headers, body (Buffer) } zurück.
 */
function httpsReq(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...opts, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Loggt sich an der internen UniFi Protect API ein.
 * Gibt { token, csrf } zurück.
 */
async function unifiLogin(host, port, username, password) {
  const loginBody = JSON.stringify({ username, password });
  const res = await httpsReq({
    hostname: host, port,
    path: '/api/auth/login', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody) },
  }, loginBody);

  if (res.status !== 200) {
    throw new Error(`Login fehlgeschlagen HTTP ${res.status}`);
  }
  const cookies = res.headers['set-cookie'] || [];
  const token = (cookies.find((c) => c.startsWith('TOKEN=')) || '').split(';')[0];
  const csrf  = (JSON.parse(res.body.toString()).csrfToken) || '';
  if (!token) throw new Error('Kein TOKEN-Cookie nach Login');
  return { token, csrf };
}

/**
 * Holt einen JPEG-Snapshot von UniFi Protect (Public Integration API).
 */
function fetchSnapshot(host, port, apiKey, cameraId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, port,
      path: `/proxy/protect/integration/v1/cameras/${encodeURIComponent(cameraId)}/snapshot`,
      method: 'GET',
      headers: { 'X-API-KEY': apiKey, 'Accept': 'image/jpeg' },
      rejectUnauthorized: false,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Holt das letzte Event einer Kamera und lädt den zugehörigen Clip herunter.
 * Verwendet die interne API mit Cookie-Auth.
 */
async function fetchLastEventClip(host, port, token, csrf, cameraId) {
  // Letztes abgeschlossenes Event laden
  const evRes = await httpsReq({
    hostname: host, port,
    path: '/proxy/protect/api/events?cameras=' + encodeURIComponent(cameraId) + '&limit=5&orderDirection=DESC',
    method: 'GET',
    headers: { 'Cookie': token, 'X-CSRF-Token': csrf },
  });
  if (evRes.status !== 200) throw new Error(`Events HTTP ${evRes.status}`);

  const events = JSON.parse(evRes.body.toString());
  // Erstes Event mit einem end-Timestamp nehmen (abgeschlossen)
  const ev = events.find((e) => e.end);
  if (!ev) throw new Error('Kein abgeschlossenes Event gefunden');

  // Clip exportieren
  const clipPath = '/proxy/protect/api/video/export'
    + '?camera=' + encodeURIComponent(cameraId)
    + '&start=' + ev.start
    + '&end='   + ev.end
    + '&channel=0';
  const clipRes = await httpsReq({
    hostname: host, port,
    path: clipPath, method: 'GET',
    headers: { 'Cookie': token, 'X-CSRF-Token': csrf },
  });
  if (clipRes.status !== 200) throw new Error(`Clip-Export HTTP ${clipRes.status}`);
  return clipRes.body;
}

module.exports = {
  type:        'unifi-protect-snapshot',
  category:    'UniFi',
  label:       'UniFi Protect Snapshot',
  description: 'Holt bei einem Trigger einen Snapshot oder den letzten Event-Clip von einer UniFi Protect Kamera und gibt ihn als Base64 zurück.',
  color:       '#0059b3',

  inputs:  [{ handle: 'trigger', label: 'Auslösen' }],
  outputs: [
    { handle: 'image',  label: 'Bild (Base64 JPEG)' },
    { handle: 'video',  label: 'Video (Base64 MP4)' },
    { handle: 'status', label: 'Status (1 = OK)' },
  ],

  globalSettings: [
    {
      key:         'host',
      label:       'UniFi Protect Host',
      type:        'text',
      placeholder: '192.168.10.1',
      description: 'IP-Adresse oder Hostname der UniFi Protect Konsole',
    },
    {
      key:         'port',
      label:       'Port',
      type:        'number',
      placeholder: '443',
      description: 'HTTPS-Port (Standard: 443)',
    },
    {
      key:         'apiKey',
      label:       'API Key',
      type:        'password',
      description: 'UniFi Protect Public API Key – für Snapshot-Modus (Einstellungen → Integrationen → API Credentials)',
    },
    {
      key:         'username',
      label:       'Benutzername',
      type:        'text',
      placeholder: 'admin',
      description: 'UniFi-Benutzername – für Videoclip-Modus (interne API)',
    },
    {
      key:         'password',
      label:       'Passwort',
      type:        'password',
      description: 'UniFi-Passwort – für Videoclip-Modus (interne API)',
    },
  ],

  config: [
    {
      key:         'mode',
      label:       'Modus',
      type:        'select',
      options: [
        { value: 'image', label: 'Snapshot (JPEG) – Public API' },
        { value: 'video', label: 'Letzter Event-Clip (MP4) – interne API' },
      ],
      description: 'Snapshot: Public API + API Key · Video: interne API + Benutzername/Passwort',
    },
    {
      key:         'cameraId',
      label:       'Kamera ID',
      type:        'text',
      placeholder: 'z.B. 69fc84a502ec6d03e4008002',
      description: 'Interne ID der Kamera in UniFi Protect (sichtbar in der Kameraliste)',
    },
    {
      key:         'prefix',
      label:       'Base64-Präfix hinzufügen',
      type:        'select',
      options: [
        { value: '1', label: 'Ja – data:…;base64,…' },
        { value: '0', label: 'Nein – reiner Base64-String' },
      ],
      description: 'Mit Präfix direkt als src in <img>-Tags oder im Pushover-Plugin verwendbar',
    },
  ],

  execute(inputs, data, context) {
    if (!inputs.trigger) return {};

    const host      = (context.globalSetting('host')     || '').trim();
    const port      = parseInt(context.globalSetting('port') || '443', 10);
    const apiKey    = (context.globalSetting('apiKey')   || '').trim();
    const username  = (context.globalSetting('username') || '').trim();
    const password  = (context.globalSetting('password') || '').trim();
    const mode      = String(data.mode || 'image');
    const cameraId  = (data.cameraId || '').trim();
    const addPrefix = String(data.prefix ?? '1') === '1';

    if (!host) {
      context.warn('UniFi Host nicht konfiguriert (globale Einstellungen)');
      return {};
    }
    if (!cameraId) {
      context.warn('Kamera ID nicht konfiguriert');
      return {};
    }

    if (mode === 'video') {
      if (!username || !password) {
        context.warn('Benutzername/Passwort nicht konfiguriert (für Videoclip-Modus erforderlich)');
        return {};
      }
      context.nodeLog('⏳ Letztes Event laden…');
      unifiLogin(host, port, username, password)
        .then(({ token, csrf }) => fetchLastEventClip(host, port, token, csrf, cameraId))
        .then((buf) => {
          const b64    = buf.toString('base64');
          const result = addPrefix ? `data:video/mp4;base64,${b64}` : b64;
          context.nodeLog(`✓ ${Math.round(buf.length / 1024)} KB`);
          context.log(`Event-Clip ${cameraId}: ${Math.round(buf.length / 1024)} KB`);
          context.emitOutput('video', result);
          context.emitOutput('status', 1);
        })
        .catch((e) => {
          context.warn(`Event-Clip fehlgeschlagen: ${e.message}`);
          context.nodeLog('✗ ' + e.message.slice(0, 30));
          context.emitOutput('status', 0);
        });
    } else {
      if (!apiKey) {
        context.warn('API Key nicht konfiguriert (für Snapshot-Modus erforderlich)');
        return {};
      }
      fetchSnapshot(host, port, apiKey, cameraId)
        .then((buf) => {
          const b64    = buf.toString('base64');
          const result = addPrefix ? `data:image/jpeg;base64,${b64}` : b64;
          context.nodeLog(`✓ ${Math.round(buf.length / 1024)} KB`);
          context.log(`Snapshot ${cameraId}: ${Math.round(buf.length / 1024)} KB`);
          context.emitOutput('image', result);
          context.emitOutput('status', 1);
        })
        .catch((e) => {
          context.warn(`Snapshot fehlgeschlagen: ${e.message}`);
          context.nodeLog('✗ ' + e.message.slice(0, 30));
          context.emitOutput('status', 0);
        });
    }

    return {};
  },
};
