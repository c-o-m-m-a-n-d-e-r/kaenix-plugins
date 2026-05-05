/**
 * @plugin    Heizstab
 * @version   1.0.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */

/**
 * PV-Überschuss-Heizstab-Steuerung mit bis zu 3 Phasen.
 * Port vom Gira Homeserver Python-Plugin "Heizstab" (v0.67).
 *
 * Funktionsweise:
 * - Liegt die Speichertemperatur unter minTemp → sofort heizen (heatOn)
 * - Liegt sie über maxTemp + 0,2 °C → sofort abschalten (heatOff)
 * - Liegt sie dazwischen → PV-Überschuss-Heizung prüfen (checkPVHeat)
 * - Sinkt der PV-Überschuss unter 1 W während geheizt wird, startet ein
 *   Watchdog-Timer. Nach Ablauf des Beobachtungsfensters schaltet der
 *   Heizstab ab. Kehrt der Überschuss vorher zurück, wird der Timer abgebrochen.
 * - Boost: schaltet alle 3 Phasen unabhängig vom Überschuss ein.
 * - Turbo Boost: wie Boost, schaltet zusätzlich den Alternativ-Ausgang.
 */

const _states = {};

function getState(nodeId) {
  if (!_states[nodeId]) {
    _states[nodeId] = {
      isHeating:     false,
      lastPhase:     0,
      lastPowerOff:  0,
      lastCheck:     false,
      watchdogTimer: null,
      prevInputs:    {},
    };
  }
  return _states[nodeId];
}

function toNum(val, fallback) {
  const n = parseFloat(val);
  return isNaN(n) ? fallback : n;
}

module.exports = {
  type:        'heizstab',
  category:    'Energie',
  label:       'Heizstab',
  description: 'Steuert einen PV-Überschuss-Heizstab mit bis zu 3 Phasen, Boost und Temperaturüberwachung',
  color:       '#f97316',

  inputs: [
    { handle: 'speicherTemp',  label: 'Speicher Temperatur (°C)' },
    { handle: 'pv',            label: 'PV Leistung (W)' },
    { handle: 'verbrauch',     label: 'Verbrauch (W)' },
    { handle: 'minTemp',       label: 'min. Temperatur (°C)' },
    { handle: 'maxTemp',       label: 'max. Temperatur (°C)' },
    { handle: 'warten',        label: 'Warten (0 = nein / 1 = ja)' },
    { handle: 'phasen',        label: 'Phasen (1–3)' },
    { handle: 'phasePower',    label: 'Leistung pro Phase (W)' },
    { handle: 'boost',         label: 'Boost (0/1)' },
    { handle: 'turboBoost',    label: 'Turbo Boost (0/1)' },
    { handle: 'batterie',      label: 'Batterie (%)' },
    { handle: 'batterieLimit', label: 'Batterie Limit (%)' },
    { handle: 'ueberschuss',   label: 'Überschussregel (Abw. in °C)' },
    { handle: 'beobachtung',   label: 'Beobachtungsfenster (s)' },
    { handle: 'aktiv',         label: 'Aktiv (0/1)' },
  ],

  outputs: [
    { handle: 'l1',         label: 'L1' },
    { handle: 'l2',         label: 'L2' },
    { handle: 'l3',         label: 'L3' },
    { handle: 'alternativ', label: 'Alternativ heizen' },
    { handle: 'leistung',   label: 'Leistung (%)' },
    { handle: 'debug',      label: 'Debug' },
  ],

  config: [
    {
      key:         'minTemp',
      label:       'min. Temperatur (°C)',
      type:        'number',
      default:     0,
      placeholder: '0',
    },
    {
      key:         'maxTemp',
      label:       'max. Temperatur (°C)',
      type:        'number',
      default:     60,
      placeholder: '60',
    },
    {
      key:     'phasen',
      label:   'Phasen (1–3)',
      type:    'select',
      default: '3',
      options: [
        { value: '1', label: '1 Phase' },
        { value: '2', label: '2 Phasen' },
        { value: '3', label: '3 Phasen' },
      ],
    },
    {
      key:         'phasePower',
      label:       'Leistung pro Phase (W)',
      type:        'number',
      default:     2000,
      placeholder: '2000',
    },
    {
      key:     'warten',
      label:   'Kein Überschuss → warten',
      type:    'select',
      default: '0',
      options: [
        { value: '0', label: 'Nein – alternativ heizen' },
        { value: '1', label: 'Ja – nicht alternativ heizen' },
      ],
    },
    {
      key:         'batterieLimit',
      label:       'Batterie Limit (%)',
      type:        'number',
      default:     20,
      placeholder: '20',
    },
    {
      key:         'ueberschuss',
      label:       'Überschussregel – Abweichung (°C)',
      type:        'number',
      default:     0,
      placeholder: '0',
    },
    {
      key:         'beobachtung',
      label:       'Beobachtungsfenster (s)',
      type:        'number',
      default:     30,
      placeholder: '30',
    },
    {
      key:     'aktiv',
      label:   'Aktiv',
      type:    'select',
      default: '1',
      options: [
        { value: '1', label: 'Ja' },
        { value: '0', label: 'Nein' },
      ],
    },
  ],

  execute(inputs, data, context) {
    const nodeId = context.nodeId || 'default';
    const s      = getState(nodeId);
    const nowSec = Date.now() / 1000;

    // Auflösung: KNX-Eingang hat Vorrang vor Node-Konfiguration hat Vorrang vor Fallback
    function get(inputKey, configKey, fallback) {
      const iv = inputs[inputKey];
      if (iv != null && iv !== '') {
        const n = parseFloat(iv);
        if (!isNaN(n)) return n;
      }
      const cv = data[configKey];
      if (cv != null && cv !== '') {
        const n = parseFloat(cv);
        if (!isNaN(n)) return n;
      }
      return fallback;
    }

    const aktiv      = get('aktiv',         'aktiv',         1) === 1;
    const minTemp    = get('minTemp',        'minTemp',       0);
    const maxTemp    = get('maxTemp',        'maxTemp',       60);
    const phasen     = Math.max(1, Math.min(3, get('phasen',     'phasen',     3)));
    const phasePower = Math.max(1, get('phasePower', 'phasePower', 2000));
    const totalPower = phasen * phasePower;
    const warten     = get('warten',        'warten',        0) === 1;
    const batterie   = get('batterie',      'batterie',      0);
    const batLimit   = get('batterieLimit', 'batterieLimit', 20);
    const pvDiff     = get('ueberschuss',   'ueberschuss',   0);
    const watchtime  = Math.max(1, get('beobachtung', 'beobachtung', 30));
    const boostVal   = toNum(inputs.boost,     0);
    const turboVal   = toNum(inputs.turboBoost, 0);

    const temp      = inputs.speicherTemp != null ? toNum(inputs.speicherTemp, null) : null;
    const pv        = toNum(inputs.pv,        0);
    const verbrauch = toNum(inputs.verbrauch, 0);
    const surplus   = pv - verbrauch;

    // ---- Hilfsfunktionen ----

    function emit(handle, value) {
      context.emitOutput(handle, value);
    }

    // Anzahl heizbarer Phasen aus aktuellem PV-Überschuss berechnen
    function checkPower() {
      return Math.max(0, Math.min(phasen, Math.floor(surplus / phasePower)));
    }

    // n Phasen reihum einschalten (Verschleiß-Rotation)
    function turnPhaseOn(phases) {
      let count = 0;
      while (count < phases) {
        count++;
        s.lastPhase++;
        if (s.lastPhase > phasen) s.lastPhase = 1;
        emit(`l${s.lastPhase}`, 1);
        s.isHeating = true;
      }
      const pct = Math.min(100, Math.floor((surplus / totalPower) * 100));
      emit('leistung', pct);
    }

    // Heizstab ausschalten; alternativOff=true → auch Alternativ-Ausgang aus
    function heatOff(alternativOff) {
      s.lastPowerOff = nowSec;
      s.lastCheck    = false;
      if (s.watchdogTimer) {
        clearTimeout(s.watchdogTimer);
        s.watchdogTimer = null;
      }
      s.isHeating = false;
      emit('l1', 0);
      emit('l2', 0);
      emit('l3', 0);
      emit('leistung', 0);
      if (alternativOff) emit('alternativ', 0);
    }

    // Boost: alle 3 Phasen unabhängig vom PV-Überschuss
    function boost(on) {
      if (on) {
        s.isHeating = false;
        emit('l1', 1);
        emit('l2', 1);
        emit('l3', 1);
      } else {
        heatOff(false);
      }
    }

    // Turbo Boost: Boost + Alternativ-Ausgang
    function turboboost(on) {
      if (on) {
        s.isHeating = false;
        boost(true);
        emit('alternativ', 1);
      } else {
        heatOff(true);
      }
    }

    // PV-Überschuss-Heizung: greift wenn Temp zwischen Min und Max liegt
    function checkPVHeat() {
      const restartDiff = nowSec - s.lastPowerOff;
      if (restartDiff >= watchtime && pvDiff > 0 && temp !== null) {
        const breakpoint = maxTemp - pvDiff;
        if (temp <= breakpoint) {
          const phases = checkPower();
          if (phases > 0) turnPhaseOn(phases);
        }
      }
    }

    // Einschalten: PV → Boost (Batterie) → Alternativ
    function heatOn() {
      const phases = checkPower();
      if (phases > 0) {
        turnPhaseOn(phases);
      } else if (batterie >= batLimit) {
        boost(true);
      } else if (!warten) {
        emit('alternativ', 1);
      }
    }

    // ---- Haupt-Logik ----

    const prev    = s.prevInputs;
    const changed = (key) =>
      inputs[key] != null && String(inputs[key]) !== String(prev[key]);

    // Aktiv → 0: alles ausschalten
    if (changed('aktiv') && !aktiv) {
      heatOff(true);
      emit('debug', 'inaktiv');
      s.prevInputs = { ...inputs };
      return {};
    }

    if (!aktiv) {
      s.prevInputs = { ...inputs };
      return {};
    }

    // Turbo Boost (steigende Flanke)
    if (changed('turboBoost') && turboVal === 1) {
      turboboost(true);
      emit('debug', 'turbo boost ein');
      s.prevInputs = { ...inputs };
      return {};
    }

    // Boost (steigende Flanke)
    if (changed('boost') && boostVal === 1) {
      boost(true);
      emit('debug', 'boost ein');
      s.prevInputs = { ...inputs };
      return {};
    }

    // Temperaturänderung → Heiz-Entscheidung
    if (changed('speicherTemp') && temp !== null) {
      if (temp >= maxTemp + 0.2) {
        heatOff(true);
        emit('debug', `Maxtemp erreicht (${temp.toFixed(1)} °C)`);
      } else if (temp <= minTemp) {
        heatOn();
        emit('debug', `Mintemp (${temp.toFixed(1)} °C) → heizen`);
      } else {
        checkPVHeat();
        emit('debug', `Temp ${temp.toFixed(1)} °C, Überschuss: ${surplus.toFixed(0)} W`);
      }
    }

    // PV / Verbrauch → Watchdog für laufende Heizung
    const pvChanged =
      (changed('pv') || changed('verbrauch')) && s.isHeating;

    if (pvChanged) {
      if (surplus < 1) {
        // Überschuss weggefallen → Watchdog starten (nur einmal)
        if (s.lastCheck === false) {
          s.lastCheck = nowSec;
          if (s.watchdogTimer) clearTimeout(s.watchdogTimer);
          s.watchdogTimer = setTimeout(() => {
            heatOff(false);
            context.emitOutput('debug', `Watchdog: kein Überschuss für ${watchtime} s`);
          }, watchtime * 1000);
          emit('debug', `Überschuss < 1 W – Watchdog läuft (${watchtime} s)`);
        }
      } else {
        // Überschuss zurück → Watchdog abbrechen
        if (s.watchdogTimer) {
          clearTimeout(s.watchdogTimer);
          s.watchdogTimer = null;
        }
        s.lastCheck = false;
        emit('debug', `Überschuss: ${surplus.toFixed(0)} W`);
      }
    }

    s.prevInputs = { ...inputs };
    return {};
  },
};
