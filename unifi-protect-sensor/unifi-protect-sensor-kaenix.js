/**
 * @plugin    UniFi Protect Sensor Trigger
 * @version   1.0.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */

'use strict';

const https = require('https');

// Führt einen HTTPS-POST an den UniFi Protect Sensor-Trigger-Endpoint aus.
// UniFi verwendet selbst-signierte Zertifikate → rejectUnauthorized: false.
function triggerSensor(host, port, apiKey, triggerId) {
  return new Promise((resolve, reject) => {
    const body = '{}';
    const options = {
      hostname: host,
      port,
      path: `/proxy/protect/integration/v1/alarm-manager/webhook/${encodeURIComponent(triggerId)}`,
      method: 'POST',
      headers: {
        'X-API-KEY':     apiKey,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      rejectUnauthorized: false,
    };

    const chunks = [];
    const req = https.request(options, (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  type:        'unifi-protect-sensor',
  category:    'UniFi',
  label:       'UniFi Protect Alarm Trigger',
  description: 'Löst einen UniFi Protect Alarm-Trigger über den Alarm-Manager-Webhook aus (X-API-KEY). ' +
               'Die Webhook-ID findet sich in UniFi Protect unter Automatisierung → Alarm Manager → Webhooks.',
  color:       '#0059b3',

  inputs:  [{ handle: 'trigger', label: 'Auslösen' }],
  outputs: [{ handle: 'status',  label: 'Status (1 = OK)' }],

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
      description: 'UniFi Protect Public API Key (unter "Integrationen" erstellen)',
    },
  ],

  config: [
    {
      key:         'triggerId',
      label:       'Webhook ID',
      type:        'text',
      placeholder: 'z.B. 12cec865-32c6-4eaa-8d6f-4f33040ef9b7',
      description: 'UUID des Webhooks in UniFi Protect (Automatisierung → Alarm Manager → Webhooks)',
    },
  ],

  execute(inputs, data, context) {
    // Nur auslösen wenn Eingang truthy
    if (!inputs.trigger) return {};

    const host      = (context.globalSetting('host') || '').trim();
    const port      = parseInt(context.globalSetting('port') || '443', 10);
    const apiKey    = (context.globalSetting('apiKey') || '').trim();
    const triggerId = (data.triggerId || '').trim();

    if (!host) {
      context.warn('UniFi Host nicht konfiguriert (globale Einstellungen)');
      return {};
    }
    if (!apiKey) {
      context.warn('API Key nicht konfiguriert (globale Einstellungen)');
      return {};
    }
    if (!triggerId) {
      context.warn('Trigger ID nicht konfiguriert');
      return {};
    }

    triggerSensor(host, port, apiKey, triggerId)
      .then(({ status, body }) => {
        if (status >= 200 && status < 300) {
          context.nodeLog(`✓ HTTP ${status}`);
          context.log(`UniFi Alarm Webhook ${triggerId} ausgelöst – HTTP ${status}`);
          context.emitOutput('status', 1);
        } else {
          const msg = body.slice(0, 120);
          context.warn(`UniFi HTTP ${status}: ${msg}`);
          context.nodeLog(`✗ HTTP ${status}`);
          context.emitOutput('status', 0);
        }
      })
      .catch((e) => {
        context.warn(`Verbindungsfehler: ${e.message}`);
        context.nodeLog('✗ Verbindungsfehler');
        context.emitOutput('status', 0);
      });

    return {};
  },
};
