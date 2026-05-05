/**
 * @plugin    Push
 * @version   1.0.1
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */
module.exports = {
  type: 'push',
  category: 'Benachrichtigung',
  label: 'Push',
  description: 'Sendet Web Push an alle Geräte oder ein bestimmtes Gerät',
  color: '#f97316',

  inputs: [{ handle: 'in', label: 'Wert' }],
  outputs: [],

  config: [
    { key: 'targetDevice', label: 'Zielgerät', type: 'select', options: ['all'] },
    { key: 'title', label: 'Titel', type: 'text' },
    { key: 'text', label: 'Text ({value} als Platzhalter)', type: 'text' },
    { key: 'icon', label: 'Icon-URL (optional)', type: 'text' },
    { key: 'url', label: 'URL beim Klick', type: 'text' },
  ],

  execute(inputs, data, context) {
    const value = inputs.in;
    let target = 'all';
    let deviceId = null;

    const targetDevice = data.targetDevice == null ? '' : String(data.targetDevice);
    if (targetDevice === 'all') {
      target = 'all';
    } else if (targetDevice.startsWith('device:')) {
      const parsedId = parseInt(targetDevice.split(':')[1], 10);
      target = 'device';
      deviceId = Number.isNaN(parsedId) ? null : parsedId;
    } else {
      // Legacy-Fallback fuer bestehende Flows mit getrennten Feldern.
      const legacyTarget = (data.target || 'all') === 'device' ? 'device' : 'all';
      const legacyDeviceId = data.deviceId ? parseInt(data.deviceId, 10) : null;
      if (legacyTarget === 'device') {
        target = 'device';
        deviceId = Number.isNaN(legacyDeviceId) ? null : legacyDeviceId;
      }
    }

    const title = String(data.title || 'KNX Homeserver');
    const template = String(data.text || 'Neuer Wert: {value}');
    const body = template.replaceAll('{value}', value == null ? '' : String(value));
    const icon = String(data.icon || '').trim();
    const url = String(data.url || '/');

    if (target === 'device' && !deviceId) {
      context.warn('targetDevice auf Einzelgeraet gesetzt, aber keine gueltige deviceId gefunden');
      return {};
    }

    context.push({
      target,
      deviceId,
      title,
      body,
      ...(icon ? { icon } : {}),
      url,
    });

    context.log(`Push gesendet (target=${target}${target === 'device' ? `, deviceId=${deviceId || 'n/a'}` : ''})`);
    return {};
  },
};
