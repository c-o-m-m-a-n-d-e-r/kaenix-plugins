/**
 * @plugin    Hyseresis
 * @version   1.0.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.org
 */
const states = {};

module.exports = {
  type:        'hysteresis',
  category:    'Logik',
  label:       'Hysterese',
  description: 'Schaltet mit Totband (Zweipunktregelung)',
  color:       '#7c3aed',

  inputs:  [{ handle: 'in',    label: 'Messwert' }],
  outputs: [{ handle: 'out',   label: 'Ein/Aus'  }],

  config: [
    { key: 'low',  label: 'Untere Schwelle (Einschalten)',  type: 'number' },
    { key: 'high', label: 'Obere Schwelle (Ausschalten)',   type: 'number' },
  ],

  execute(inputs, data, context) {
    const val  = parseFloat(inputs.in ?? 0);
    const low  = parseFloat(data.low  ?? 19);
    const high = parseFloat(data.high ?? 21);

    // Node-ID ist nicht direkt verfügbar, daher über inputs-Referenz als Schlüssel
    // (In der Praxis: separater State pro Instanz durch Plugin-Loader gewährleistet)
    const key  = `${low}_${high}`;
    let state  = states[key] ?? false;

    if (val <= low)  state = true;  // Unter Untergrenze → einschalten
    if (val >= high) state = false; // Über Obergrenze   → ausschalten

    states[key] = state;
    context.log(`${val} [${low}…${high}] → ${state ? 'EIN' : 'AUS'}`);
    return state;
  },
};
