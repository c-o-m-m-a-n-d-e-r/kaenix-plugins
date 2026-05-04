/**
 * @plugin    Treppenhauslicht
 * @version   1.0.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.org
 */

/**
 * Pro Instanz (nodeId) wird ein Timer-State gehalten:
 * { timer: Timeout|null, interval: Interval|null, endsAt: number }
 */
const _states = {};

function getState(nodeId) {
  if (!_states[nodeId]) {
    _states[nodeId] = { timer: null, interval: null, endsAt: 0 };
  }
  return _states[nodeId];
}

function clearState(nodeId) {
  const s = _states[nodeId];
  if (!s) return;
  if (s.timer)    { clearTimeout(s.timer);    s.timer    = null; }
  if (s.interval) { clearInterval(s.interval); s.interval = null; }
  s.endsAt = 0;
}

module.exports = {
  type:        'treppenhauslicht',
  category:    'Automatisierung',
  label:       'Treppenhauslicht',
  description: 'Schaltet ein Licht für eine konfigurierbare Zeit nach einem Trigger-Impuls',
  color:       '#f59e0b',

  inputs: [
    { handle: 'trigger', label: 'Trigger' },
    { handle: 'zeit',    label: 'Zeit (Sek.)' },
  ],
  outputs: [
    { handle: 'telegram', label: 'Telegram (Ein/Aus)' },
    { handle: 'restzeit', label: 'Restzeit (Sek.)' },
  ],

  config: [
    {
      key:         'zeitSekunden',
      label:       'Zeit in Sekunden',
      type:        'number',
      placeholder: '60',
    },
  ],

  execute(inputs, data, context) {
    if (inputs.trigger == null) return {};

    const nodeId = context.nodeId || 'default';

    // Trigger = 0 → Timer sofort abbrechen und Aus-Telegramm senden
    if (!inputs.trigger || inputs.trigger === '0' || inputs.trigger === 0) {
      clearState(nodeId);
      context.nodeLog(`⏹ aus (manuell)`);
      context.emitOutput('restzeit', 0);
      context.emitOutput('telegram', 0);
      return {};
    }

    // Zeit bestimmen (Priorität: Input > Config > Fallback 60 s)
    const zeitInput  = inputs.zeit != null ? parseFloat(inputs.zeit) : NaN;
    const zeitConfig = parseFloat(data.zeitSekunden);
    const sek = (!isNaN(zeitInput) && zeitInput > 0)
      ? zeitInput
      : (!isNaN(zeitConfig) && zeitConfig > 0)
        ? zeitConfig
        : 60;

    // Laufenden Timer neu starten
    clearState(nodeId);

    const s = getState(nodeId);
    s.endsAt = Date.now() + sek * 1000;

    // Sofort Einschalttelegramm senden
    context.emitOutput('telegram', 1);
    context.emitOutput('restzeit', Math.round(sek));
    context.nodeLog(`▶ ${Math.round(sek)}s`);

    // Restzeit jede Sekunde ausgeben
    s.interval = setInterval(() => {
      const rest = Math.max(0, Math.round((s.endsAt - Date.now()) / 1000));
      context.emitOutput('restzeit', rest);
      context.nodeLog(`⏱ ${rest}s`);
    }, 1000);

    // Nach Ablauf Ausschalttelegramm + Aufäumen
    s.timer = setTimeout(() => {
      clearState(nodeId);
      context.log(`Zeit abgelaufen – sende Ausschalttelegramm`);
      context.nodeLog(`⏹ aus`);
      context.emitOutput('restzeit',  0);
      context.emitOutput('telegram', 0);
    }, sek * 1000);

    return {};
  },
};
