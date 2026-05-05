/**
 * @plugin    CallMeBot
 * @version   1.0.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */
module.exports = {
  type: 'callmebot',
  category: 'Benachrichtigung',
  label: 'CallMeBot',
  description: 'Sendet eine WhatsApp an ein bestimmtes Gerät über den Dienst CallMeBot',
  color: '#f97316',

  inputs: [{ handle: 'in', label: 'Wert' }, { handle: 'trigger', label: 'Trigger', type: 'boolean' }],
  outputs: [{ handle: 'status', label: 'Status' }],

  globalSettings: [
    { key: 'apiToken', label: 'API Token', type: 'password', description: 'API Token' },
    { key: 'phoneNumber', label: 'Handy Nummer', type: 'text', placeholder: 'Handy Nummer' },
  ],

  config: [
    { key: 'phoneNumber', label: 'Handy Nummer', type: 'text', placeholder: 'Handy Nummer (überschreibt globale Einstellung)' },
    { key: 'msg', label: 'Nachricht ({value} als Platzhalter)', type: 'text' },
  ],

  execute(inputs, data, context) {
    const val = inputs.in || '';

    // Trigger-Modus: nur senden wenn Eingang truthy
    if (!inputs.trigger) return {};

    const apiToken  = context.globalSetting('apiToken') || '';
    const phone     = (data.phoneNumber && String(data.phoneNumber).trim())
                      || (context.globalSetting('phoneNumber') || '').trim();

    if (!phone) {
      context.warn('Keine Telefonnummer konfiguriert – Nachricht nicht gesendet');
      return {};
    }
    if (!apiToken) {
      context.warn('Kein API Token konfiguriert – Nachricht nicht gesendet');
      return {};
    }

    const rawMsg = (data.msg || '{value}').replace(/\{value\}/g, String(val ?? ''));
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(rawMsg)}&apikey=${encodeURIComponent(apiToken)}`;

    fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
      },
    })
      .then((res) => {
        if (res.ok) {
          context.log(`WhatsApp gesendet an ${phone}`);
          context.emitOutput('status', 1);
        } else {
          context.warn(`CallMeBot HTTP ${res.status} für ${phone}`);
          context.emitOutput('status', 0);
        }
      })
      .catch((e) => {
        context.warn(`CallMeBot Fehler: ${e.message}`);
        context.emitOutput('status', 0);
      });

    return {};
  },
};
