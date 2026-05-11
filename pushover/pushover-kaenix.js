/**
 * @plugin    Pushover
 * @version   1.0.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */

'use strict';

const https = require('https');

/**
 * Sendet eine Pushover-Benachrichtigung.
 * Endpoint: POST https://api.pushover.net/1/messages.json
 */
function sendPushover(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.pushover.net',
      port: 443,
      path: '/1/messages.json',
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(text);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  type:        'pushover',
  category:    'Benachrichtigung',
  label:       'Pushover',
  description: 'Sendet eine Push-Benachrichtigung über Pushover (pushover.net)',
  color:       '#249DF1',

  inputs: [
    { handle: 'in',      label: 'Wert' },
    { handle: 'trigger', label: 'Trigger', type: 'boolean' },
    { handle: 'image',   label: 'Bild (Base64)' },
  ],
  outputs: [
    { handle: 'status', label: 'Status (1 = OK)' },
  ],

  globalSettings: [
    {
      key:         'apiToken',
      label:       'API Token (App)',
      type:        'password',
      description: 'Anwendungs-Token aus dem Pushover-Dashboard (pushover.net/apps)',
    },
    {
      key:         'userKey',
      label:       'User / Group Key',
      type:        'password',
      description: 'Dein Pushover-Benutzerschlüssel oder Gruppen-Key',
    },
  ],

  config: [
    {
      key:         'title',
      label:       'Titel',
      type:        'text',
      placeholder: 'KNX Homeserver',
      description: 'Betreffzeile der Benachrichtigung (leer = App-Name)',
    },
    {
      key:         'message',
      label:       'Nachricht ({value} als Platzhalter)',
      type:        'text',
      placeholder: 'Neuer Wert: {value}',
    },
    {
      key:         'priority',
      label:       'Priorität',
      type:        'select',
      options: [
        { value: '-2', label: 'Keine Benachrichtigung (-2)' },
        { value: '-1', label: 'Leise (-1)' },
        { value:  '0', label: 'Normal (0)' },
        { value:  '1', label: 'Hoch (1)' },
      ],
      description: 'Priorität 1 = Ton + Vibration erzwingen; -2 = nur in Liste',
    },
    {
      key:         'sound',
      label:       'Sound (optional)',
      type:        'text',
      placeholder: 'z.B. pushover, bike, siren …',
      description: 'Pushover-Soundname (leer = Standard-Sound)',
    },
    {
      key:         'device',
      label:       'Gerät (optional)',
      type:        'text',
      placeholder: 'z.B. iphone',
      description: 'Geräte-Name für gezielten Versand (leer = alle Geräte)',
    },
    {
      key:         'url',
      label:       'URL (optional)',
      type:        'text',
      placeholder: 'https://…',
      description: 'Wird beim Klick auf die Benachrichtigung geöffnet',
    },
    {
      key:         'urlTitle',
      label:       'URL-Titel (optional)',
      type:        'text',
      placeholder: 'Öffnen',
      description: 'Beschriftung des Links in der Benachrichtigung',
    },
  ],

  execute(inputs, data, context) {
    // Nur senden wenn Trigger gesetzt
    if (!inputs.trigger) return {};

    const apiToken = (context.globalSetting('apiToken') || '').trim();
    const userKey  = (context.globalSetting('userKey')  || '').trim();

    if (!apiToken) {
      context.warn('Pushover: API Token nicht konfiguriert (globale Einstellungen)');
      return {};
    }
    if (!userKey) {
      context.warn('Pushover: User Key nicht konfiguriert (globale Einstellungen)');
      return {};
    }

    const value   = inputs.in == null ? '' : String(inputs.in);
    const template = String(data.message || '{value}');
    const message  = template.replace(/\{value\}/g, value);
    const title    = String(data.title || '').trim();
    const priority = parseInt(data.priority ?? '0', 10);
    const sound    = String(data.sound   || '').trim();
    const device   = String(data.device  || '').trim();
    const url      = String(data.url     || '').trim();
    const urlTitle = String(data.urlTitle || '').trim();

    // Base64-Bild: data:-Präfix entfernen, MIME-Typ extrahieren
    let attachmentBase64 = null;
    let attachmentType   = 'image/jpeg';
    const rawImage = inputs.image ? String(inputs.image).trim() : '';
    if (rawImage) {
      const match = rawImage.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        attachmentType   = match[1];
        attachmentBase64 = match[2];
      } else {
        // reiner Base64-String ohne Präfix
        attachmentBase64 = rawImage;
      }
    }

    const payload = {
      token:    apiToken,
      user:     userKey,
      message,
      priority,
      ...(title            ? { title }                                          : {}),
      ...(sound            ? { sound }                                          : {}),
      ...(device           ? { device }                                         : {}),
      ...(url              ? { url }                                             : {}),
      ...(urlTitle         ? { url_title: urlTitle }                             : {}),
      ...(attachmentBase64 ? { attachment_base64: attachmentBase64,
                               attachment_type:   attachmentType }              : {}),
    };

    sendPushover(payload)
      .then(() => {
        context.log(`Pushover gesendet${device ? ` → ${device}` : ''}: "${message.slice(0, 50)}"`);
        context.nodeLog('✓ gesendet');
        context.emitOutput('status', 1);
      })
      .catch((e) => {
        context.warn(`Pushover Fehler: ${e.message}`);
        context.nodeLog('✗ ' + e.message.slice(0, 30));
        context.emitOutput('status', 0);
      });

    return {};
  },
};
