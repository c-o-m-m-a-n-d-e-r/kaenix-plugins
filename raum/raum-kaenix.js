/**
 * @plugin    Raum
 * @version   1.0.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 */
module.exports = {
  type:        'raum',
  category:    'Logik',
  label:       'Raum',
  description: 'Beobachtet alle Widgets eines Raums (Visu-Seite). Ausgang = 1, sobald ' +
               'mindestens ein Widget-Status im Raum eingeschaltet ist, sonst 0.',
  color:       '#0ea5e9',

  // Kein fester Eingang – der Node wird bei jedem KNX-Telegramm neu ausgewertet.
  inputs:  [],
  outputs: [{ handle: 'out', label: 'Status (1=Ein)' }],

  // Lässt die Logic Engine diesen Node-Typ bei JEDEM Bus-Telegramm neu auswerten,
  // statt nur bei Änderungen an einer fest verdrahteten Eingangs-GA.
  watchesKnxBus: true,

  config: [
    { key: 'pageId', label: 'Raum', type: 'room-picker' },
  ],

  execute(inputs, data, context) {
    if (!data.pageId) return { out: 0 };
    const on = context.isRoomOn(data.pageId);
    return { out: on ? 1 : 0 };
  },
};
