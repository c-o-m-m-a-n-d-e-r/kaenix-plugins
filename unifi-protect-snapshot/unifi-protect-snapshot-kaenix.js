/**
 * @plugin    UniFi Protect Snapshot
 * @version   1.0.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */

'use strict';

const https = require('https');

/**
 * Holt einen JPEG-Snapshot von UniFi Protect und gibt ihn als Buffer zurück.
 * Endpoint: GET /proxy/protect/integration/v1/cameras/{cameraId}/snapshot
 */
function fetchSnapshot(host, port, apiKey, cameraId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port,
      path: `/proxy/protect/integration/v1/cameras/${encodeURIComponent(cameraId)}/snapshot`,
      method: 'GET',
      headers: {
        'X-API-KEY': apiKey,
        'Accept':    'image/jpeg',
      },
      rejectUnauthorized: false,
    };

    const chunks = [];
    const req = https.request(options, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = {
  type:        'unifi-protect-snapshot',
  category:    'UniFi',
  label:       'UniFi Protect Snapshot',
  description: 'Holt bei einem Trigger einen JPEG-Snapshot von einer UniFi Protect Kamera und gibt ihn als Base64-String zurück.',
  color:       '#0059b3',

  inputs:  [{ handle: 'trigger', label: 'Auslösen' }],
  outputs: [
    { handle: 'base64', label: 'Base64 (JPEG)' },
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
      description: 'UniFi Protect Public API Key (unter Einstellungen → Integrationen → API Credentials)',
    },
  ],

  config: [
    {
      key:         'cameraId',
      label:       'Kamera ID',
      type:        'text',
      placeholder: 'z.B. 69fc84a502ec6d03e4008002',
      description: 'Interne ID der Kamera in UniFi Protect (aus dem Import oder der URL im Protect-Dashboard)',
    },
    {
      key:         'prefix',
      label:       'Base64-Präfix hinzufügen',
      type:        'select',
      options: [
        { value: '1', label: 'Ja – data:image/jpeg;base64,…' },
        { value: '0', label: 'Nein – reiner Base64-String' },
      ],
      description: 'Mit Präfix direkt als src in <img>-Tags verwendbar',
    },
  ],

  execute(inputs, data, context) {
    if (!inputs.trigger) return {};

    const host     = (context.globalSetting('host') || '').trim();
    const port     = parseInt(context.globalSetting('port') || '443', 10);
    const apiKey   = (context.globalSetting('apiKey') || '').trim();
    const cameraId = (data.cameraId || '').trim();
    const addPrefix = String(data.prefix ?? '1') === '1';

    if (!host) {
      context.warn('UniFi Host nicht konfiguriert (globale Einstellungen)');
      return {};
    }
    if (!apiKey) {
      context.warn('API Key nicht konfiguriert (globale Einstellungen)');
      return {};
    }
    if (!cameraId) {
      context.warn('Kamera ID nicht konfiguriert');
      return {};
    }

    fetchSnapshot(host, port, apiKey, cameraId)
      .then((buf) => {
        const b64 = buf.toString('base64');
        const result = addPrefix ? `data:image/jpeg;base64,${b64}` : b64;
        context.nodeLog(`✓ ${Math.round(buf.length / 1024)} KB`);
        context.log(`Snapshot ${cameraId}: ${Math.round(buf.length / 1024)} KB`);
        context.emitOutput('base64', result);
        context.emitOutput('status', 1);
      })
      .catch((e) => {
        context.warn(`Snapshot fehlgeschlagen: ${e.message}`);
        context.nodeLog('✗ ' + e.message.slice(0, 30));
        context.emitOutput('status', 0);
      });

    return {};
  },
};
