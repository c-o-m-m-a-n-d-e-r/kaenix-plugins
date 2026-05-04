/**
 * @plugin    Scaler
 * @version   1.0.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.org
 */
module.exports = {
  type:        'scaler',
  category:    'Mathematik',
  label:       'Scaler',
  description: 'Skaliert einen Wert: (in × Faktor) + Offset',
  color:       '#0d9488',

  inputs:  [{ handle: 'in',  label: 'Wert' }],
  outputs: [{ handle: 'out', label: 'Ergebnis' }],

  config: [
    { key: 'factor', label: 'Faktor',   type: 'number' },
    { key: 'offset', label: 'Offset',   type: 'number' },
    { key: 'digits', label: 'Nachkommastellen', type: 'number' },
  ],

  execute(inputs, data, context) {
    const val    = parseFloat(inputs.in ?? 0);
    const factor = parseFloat(data.factor ?? 1);
    const offset = parseFloat(data.offset ?? 0);
    const digits = parseInt(data.digits   ?? 1, 10);

    const result = parseFloat((val * factor + offset).toFixed(digits));
    context.log(`${val} × ${factor} + ${offset} = ${result}`);
    return result;
  },
};
