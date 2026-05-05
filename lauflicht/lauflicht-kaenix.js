/**
 * @plugin    Lauflicht
 * @version   1.0.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */

/**
 * Sequenziell werden bis zu 8 Ausgänge ein- oder ausgeschaltet.
 * Bei Trigger=1 läuft die Sequenz in der konfigurierten Richtung.
 * Bei Trigger=0 kann die Richtung optional umgekehrt werden.
 *
 * Port vom Gira Homeserver Python-Plugin "Lauflicht".
 */

const _states = {};

function getState(nodeId) {
  if (!_states[nodeId]) _states[nodeId] = { timers: [] };
  return _states[nodeId];
}

function cancelRunning(nodeId) {
  const s = _states[nodeId];
  if (!s) return;
  s.timers.forEach((t) => clearTimeout(t));
  s.timers = [];
}

module.exports = {
  type:        'lauflicht',
  category:    'Automatisierung',
  label:       'Lauflicht',
  description: 'Schaltet N Ausgänge nacheinander ein oder aus (sequenzielles Lauflicht)',
  color:       '#10b981',

  inputs: [
    { handle: 'trigger', label: 'Ein (1) / Aus (0)' },
  ],

  dynamicOutputs(data) {
    const n = Math.max(1, parseInt(data?.outputs ?? 4, 10));
    return Array.from({ length: n }, (_, i) => ({
      handle: `out${i + 1}`,
      label:  `Ausgang ${i + 1}`,
    }));
  },

  config: [
    {
      key:         'outputs',
      label:       'Anzahl Ausgänge',
      type:        'number',
      default:     4,
      placeholder: '4',
    },
    {
      key:         'delay',
      label:       'Verzögerung zwischen Ausgängen (ms)',
      type:        'number',
      default:     200,
      placeholder: '200',
    },
    {
      key:     'direction',
      label:   'Richtung beim Einschalten',
      type:    'select',
      options: [
        { value: 'forward',  label: 'Vorwärts (1 → N)' },
        { value: 'backward', label: 'Rückwärts (N → 1)' },
      ],
    },
    {
      key:     'reverseOnOff',
      label:   'Beim Ausschalten Richtung umkehren',
      type:    'select',
      options: [
        { value: '0', label: 'Nein (gleiche Richtung)' },
        { value: '1', label: 'Ja (umgekehrte Richtung)' },
      ],
    },
  ],

  execute(inputs, data, context) {
    if (inputs.trigger == null) return {};

    const nodeId    = context.nodeId || 'default';
    const n         = Math.max(1, parseInt(data.outputs ?? 4, 10));
    const delayMs   = Math.max(0, parseFloat(data.delay ?? 200));
    const dirFwd    = (data.direction ?? 'forward') === 'forward';
    const reverse   = (data.reverseOnOff ?? '0') === '1';
    const state     = inputs.trigger === 1 || inputs.trigger === '1' || inputs.trigger === true ? 1 : 0;

    // Laufende Sequenz abbrechen
    cancelRunning(nodeId);
    const s = getState(nodeId);

    // Richtung für diese Aktion bestimmen
    // Beim Einschalten (state=1): konfigurierte Richtung
    // Beim Ausschalten (state=0): reverse=true → Gegenrichtung, reverse=false → gleiche Richtung
    let runForward;
    if (state === 1) {
      runForward = dirFwd;
    } else {
      runForward = reverse ? !dirFwd : dirFwd;
    }

    // Ausgabe-Reihenfolge aufbauen: 0-basierte Indizes
    const sequence = [];
    if (runForward) {
      for (let i = 0; i < n; i++) sequence.push(i);
    } else {
      for (let i = n - 1; i >= 0; i--) sequence.push(i);
    }

    const dir = runForward ? `1→${n}` : `${n}→1`;
    context.nodeLog(`${state ? '▶ EIN' : '⏹ AUS'} ${dir} (${n} Ausg., ${delayMs}ms)`);

    // Ausgänge zeitverzögert senden
    sequence.forEach((idx, step) => {
      const handle = `out${idx + 1}`;
      const t = setTimeout(() => {
        context.emitOutput(handle, state);
      }, step * delayMs);
      s.timers.push(t);
    });

    return {};
  },
};
