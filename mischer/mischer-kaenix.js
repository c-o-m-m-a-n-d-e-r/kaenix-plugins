/**
 * @plugin    Mischer
 * @version   1.0.2
 * @author    Christian Brauwers
 */
const states = new Map();
const number = value => {
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') return NaN;
  return Number(value);
};
const clamp = value => Math.max(0, Math.min(100, value));

function stop(s) {
  clearTimeout(s.timer);
  s.timer = null;
  s.previousTemp = null;
  s.direction = 0;
  s.pendingDirection = 0;
  s.active = false;
}
function emit(s, value, force = false) {
  value = Math.round(clamp(value));
  if (!force && s.target === value) return;
  s.target = value;
  s.context.emitOutput('ventilSoll', value);
}
function trace(s, reason) {
  s.context.log?.('Mischer', reason, { ...s.values, target: s.target });
}
function regulate(s) {
  const { temp, setpoint, valve, hysteresis } = s.values;
  const error = setpoint - temp;
  const trend = s.previousTemp == null ? 0 : temp - s.previousTemp;
  s.previousTemp = temp;

  // Erst den bisherigen Stellauftrag erreichen, keine Befehle aufstapeln.
  if (s.target != null && Math.abs(valve - s.target) > 1) {
    s.waitCycles = (s.waitCycles || 0) + 1;
    trace(s, 'WAIT_FEEDBACK');
    // Verlorene Telegramme erneut senden, ohne weitere Öffnung aufzustapeln.
    if (s.waitCycles % 3 === 0) emit(s, s.target, true);
    return;
  }
  s.waitCycles = 0;
  // Am letzten Auftrag weiterrechnen: KNX-Quantisierung und die 1-%-Toleranz
  // dürfen kleine Schritte nicht bei jedem Zyklus wieder verschlucken.
  const position = s.target ?? Math.round(valve);
  if (Math.abs(error) <= hysteresis / 2) s.active = false;
  if (Math.abs(error) > hysteresis) s.active = true;
  if (!s.active) {
    s.pendingDirection = 0;
    if (s.target == null) emit(s, valve);
    trace(s, 'DEADBAND');
    return;
  }

  const temperatureDirection = Math.sign(error);
  const direction = temperatureDirection * s.values.effect;
  // Ein Gegensteuern erst nach zwei aufeinanderfolgenden Zyklen zulassen.
  if (s.direction && direction !== s.direction && s.pendingDirection !== direction) {
    s.pendingDirection = direction;
    trace(s, 'WAIT_DIRECTION');
    return;
  }
  s.pendingDirection = 0;
  // Schon ausreichend schnelle Annäherung: thermische Reaktion abwarten.
  const remaining = Math.abs(error) - hysteresis / 2;
  const approach = temperatureDirection * trend;
  if (approach > 0 && approach * 2 >= remaining) { trace(s, 'WAIT_TREND'); return; }
  const step = Math.min(3, Math.max(1, Math.round(remaining * 0.5 - Math.max(0, approach))));
  const target = clamp(position + direction * step);
  s.direction = direction;
  emit(s, target);
  trace(s, target === position ? 'LIMIT' : 'ADJUST');
}
function schedule(s) {
  s.timer = setTimeout(() => {
    s.timer = null;
    if (s.disposed) return;
    regulate(s);
    if (!s.disposed && s.running) schedule(s);
  }, s.values.cycle * 1000);
  s.timer.unref?.();
}

module.exports = {
  type: 'mischer', category: 'Energie', label: 'Mischer', color: '#f97316',
  description: 'Gedämpfte 3-Wege-Mischerregelung. Heizen: Öffnen erhöht die Temperatur. Kühlen: Öffnen senkt die Temperatur. Pumpen-Aus fährt in beiden Betriebsarten auf 0 %.',
  inputs: [
    { handle: 'temperaturIst', label: 'Temperatur Ist (°C)' },
    { handle: 'temperaturSoll', label: 'Temperatur Soll (°C)' },
    { handle: 'ventilIst', label: 'Ventil Ist (%)' },
    { handle: 'hysterese', label: 'Hysterese (K)' },
    { handle: 'zyklus', label: 'Zyklus (s)' },
    { handle: 'pumpenstatus', label: 'Pumpenstatus (0/1)' },
  ],
  outputs: [{ handle: 'ventilSoll', label: 'Ventil Soll (%)' }],
  config: [
    { key: 'modus', label: 'Betriebsart', type: 'select', default: 'heizen',
      options: [{ value: 'heizen', label: 'Heizen' }, { value: 'kuehlen', label: 'Kühlen' }] },
    { key: 'temperaturSoll', label: 'Temperatur Soll (°C)', type: 'number' },
    { key: 'hysterese', label: 'Hysterese (±K)', type: 'number', default: 1 },
    { key: 'zyklus', label: 'Zyklus (s)', type: 'number', default: 30 },
  ],
  execute(inputs, data, context) {
    const id = context.nodeId || 'default';
    let s = states.get(id);
    if (!s) {
      s = { inputs: { ...context.initialInputs }, target: null, timer: null, running: false };
      states.set(id, s);
      stop(s);
    }
    s.inputs = { ...s.inputs, ...inputs };
    s.context = context;
    const pump = s.inputs.pumpenstatus;
    if (!(pump === true || pump === 1 || pump === '1')) {
      s.running = false;
      stop(s);
      emit(s, 0);
      context.nodeLog?.('Pumpe aus – Ventil 0 %');
      return {};
    }
    const pick = (key, fallback) => number(s.inputs[key] ?? data[key] ?? fallback);
    const mode = data.modus || 'heizen';
    const values = {
      effect: mode === 'heizen' ? 1 : mode === 'kuehlen' ? -1 : NaN,
      temp: number(s.inputs.temperaturIst), setpoint: pick('temperaturSoll'),
      valve: number(s.inputs.ventilIst), hysteresis: pick('hysterese', 1), cycle: pick('zyklus', 30),
    };
    if (!Object.values(values).every(Number.isFinite) || values.valve < 0 || values.valve > 100
        || values.hysteresis <= 0 || values.cycle < 1 || values.cycle > 86400) {
      s.running = false;
      stop(s);
      context.nodeLog?.('Regelung pausiert – Eingänge prüfen');
      return {};
    }
    const restart = !s.running || values.cycle !== s.values?.cycle || values.effect !== s.values?.effect;
    if (values.setpoint !== s.values?.setpoint || values.hysteresis !== s.values?.hysteresis) {
      s.previousTemp = null;
      s.pendingDirection = 0;
      s.active = false;
    }
    if (!s.running) {
      // Pumpen-Ein bzw. Wiederanlauf übernimmt die reale Position. Ein früherer
      // Abschaltauftrag (auch bei noch fehlendem Pumpenstatus) ist kein Fahrziel
      // der neu gestarteten Regelung.
      s.target = null;
      s.waitCycles = 0;
    }
    s.values = values;
    s.running = true;
    if (restart) {
      stop(s);
      schedule(s);
    }
    context.nodeLog?.(`Regelung alle ${values.cycle} s`);
    return {};
  },
  dispose(nodeId) {
    for (const [id, s] of states) {
      if (nodeId != null && id !== nodeId) continue;
      s.disposed = true;
      s.running = false;
      stop(s);
      states.delete(id);
    }
  },
};
