/**
 * @plugin    BWM – Bewegungsmelder mit Helligkeits- & Nachlaufsteuerung
 * @version   1.0.0
 * @author    Christian Brauwers
 * @email     christian@brauwers.com
 * @website   https://www.kaenix.net
 *
 * Portierung des Python-Logikbausteins "BWM" (v0.67) für kaenix.
 *
 * Eingänge:
 *   trigger         – Bewegungsmelder-Impuls (1 = Bewegung erkannt)
 *   helligkeit      – Aktueller Helligkeitswert (Lux o.ä.)
 *   schwelle        – Helligkeitsschwelle; nur unter diesem Wert wird eingeschaltet
 *   nachlaufzeit    – Nachlaufzeit in Minuten
 *   freigabe        – Freigabe (1 = aktiv)
 *   grundbeleuchtung – Grundbeleuchtung nach Ablauf aktivieren (1 = ja)
 *
 * Ausgänge:
 *   an_aus          – An / Aus  (1 / 0)
 *   an              – Einschalt-Impuls (1 bei jedem Einschalten)
 *   aus             – Ausschalt-Impuls (1 bei jedem Ausschalten)
 *   grund           – Grundbeleuchtung aktiv (1)
 *   aktiv           – Läuft gerade (1 = Nachlauf läuft)
 *   restzeit        – Verbleibende Nachlaufzeit in Sekunden
 */

const _states = {};

function getState(nodeId) {
  if (!_states[nodeId]) {
    _states[nodeId] = {
      timer:      null,   // setTimeout-Handle für Ablauf
      interval:   null,   // setInterval-Handle für Restzeit
      endsAt:     0,      // Timestamp des Timer-Endes
      isRunning:  false,
      // gespeicherte Eingangswerte für Inputs 2–6
      helligkeit:       0,
      schwelle:         100,
      nachlaufzeit:     1,   // Minuten
      freigabe:         1,
      grundbeleuchtung: 0,
    };
  }
  return _states[nodeId];
}

function clearTimer(s) {
  if (s.timer)    { clearTimeout(s.timer);    s.timer    = null; }
  if (s.interval) { clearInterval(s.interval); s.interval = null; }
  s.endsAt    = 0;
  s.isRunning = false;
}

module.exports = {
  type:        'bwm',
  category:    'Automatisierung',
  label:       'BWM',
  description: 'Bewegungsmelder mit Helligkeitsschwelle, Nachlaufzeit und Grundbeleuchtung',
  color:       '#0ea5e9',

  inputs: [
    { handle: 'trigger',          label: 'Trigger'          },
    { handle: 'helligkeit',       label: 'Helligkeit'       },
    { handle: 'schwelle',         label: 'Schwelle'         },
    { handle: 'nachlaufzeit',     label: 'Nachlaufzeit (Min.)' },
    { handle: 'freigabe',         label: 'Freigabe'         },
    { handle: 'grundbeleuchtung', label: 'Grundbeleuchtung' },
  ],

  outputs: [
    { handle: 'an_aus',  label: 'An / Aus'        },
    { handle: 'an',      label: 'An'              },
    { handle: 'aus',     label: 'Aus'             },
    { handle: 'grund',   label: 'Grund'           },
    { handle: 'aktiv',   label: 'Aktiv'           },
    { handle: 'restzeit',label: 'Restzeit (Sek.)' },
  ],

  config: [
    { key: 'schwelleDefault',    label: 'Helligkeitsschwelle',          type: 'number', placeholder: '100' },
    { key: 'nachlaufzeitDefault',label: 'Nachlaufzeit in Minuten',      type: 'number', placeholder: '1'   },
    { key: 'freigabeDefault',    label: 'Freigabe beim Start (1/0)',    type: 'number', placeholder: '1'   },
    { key: 'grundDefault',       label: 'Grundbeleuchtung beim Start (1/0)', type: 'number', placeholder: '0' },
  ],

  execute(inputs, data, context) {
    const nodeId = context.nodeId || 'default';
    const s      = getState(nodeId);

    // ── Eingangswerte aktualisieren (Inputs 2–6) ─────────────────────────
    if (inputs.helligkeit       != null) s.helligkeit       = parseFloat(inputs.helligkeit);
    if (inputs.schwelle         != null) s.schwelle         = parseFloat(inputs.schwelle);
    if (inputs.nachlaufzeit     != null) s.nachlaufzeit     = parseFloat(inputs.nachlaufzeit);
    if (inputs.freigabe         != null) s.freigabe         = parseFloat(inputs.freigabe);
    if (inputs.grundbeleuchtung != null) s.grundbeleuchtung = parseFloat(inputs.grundbeleuchtung);

    // Fallback auf Config-Werte falls noch keine Input-Werte vorhanden
    const schwelle    = isNaN(s.schwelle)     ? parseFloat(data.schwelleDefault    ?? 100) : s.schwelle;
    const nachlauf    = isNaN(s.nachlaufzeit) ? parseFloat(data.nachlaufzeitDefault ?? 1)   : s.nachlaufzeit;
    const freigabe    = isNaN(s.freigabe)     ? parseFloat(data.freigabeDefault    ?? 1)   : s.freigabe;
    const grundEnable = isNaN(s.grundbeleuchtung) ? parseFloat(data.grundDefault   ?? 0)   : s.grundbeleuchtung;
    const helligkeit  = isNaN(s.helligkeit)   ? 0 : s.helligkeit;

    // ── Kein Trigger → nur Werte aktualisieren, fertig ───────────────────
    if (inputs.trigger == null) return {};

    const triggerVal = parseFloat(inputs.trigger);
    if (triggerVal !== 1) return {};

    // ── Trigger ausgelöst ─────────────────────────────────────────────────
    if (!freigabe) {
      context.nodeLog('⛔ Freigabe inaktiv');
      return {};
    }

    if (helligkeit > schwelle) {
      context.nodeLog(`☀️ Zu hell (${helligkeit} > ${schwelle}) – kein Einschalten`);
      return {};
    }

    // Nachlaufzeit berechnen (Minuten → Sekunden)
    const sekunden = Math.max(1, Math.round(nachlauf * 60));

    if (s.isRunning) {
      // Timer verlängern + erneut Ein-Signal senden
      s.endsAt = Date.now() + sekunden * 1000;
      context.emitOutput('an', 1);
      context.nodeLog(`🔄 Nachläuft – Timer verlängert auf ${sekunden}s`);
      return {};
    }

    // ── Neu starten ───────────────────────────────────────────────────────
    clearTimer(s);
    s.isRunning = true;
    s.endsAt    = Date.now() + sekunden * 1000;

    context.emitOutput('an_aus',  1);
    context.emitOutput('an',      1);
    context.emitOutput('aktiv',   1);
    context.emitOutput('restzeit', sekunden);
    context.nodeLog(`▶ gestartet – ${sekunden}s Nachlaufzeit`);

    // Restzeit sekündlich ausgeben + im Baustein anzeigen
    s.interval = setInterval(() => {
      const rest = Math.max(0, Math.round((s.endsAt - Date.now()) / 1000));
      context.emitOutput('restzeit', rest);
      context.nodeLog(`⏱ ${rest}s`);
    }, 1000);

    // Nach Ablauf: Aus oder Grundbeleuchtung
    s.timer = setTimeout(() => {
      clearTimer(s);

      context.emitOutput('aktiv',   0);
      context.emitOutput('restzeit', 0);

      if (grundEnable && helligkeit < schwelle) {
        // Grundbeleuchtung aktivieren statt vollständig ausschalten
        context.emitOutput('an_aus', 0);
        context.emitOutput('grund',  1);
        context.nodeLog('🌙 Grundbeleuchtung aktiv');
      } else {
        context.emitOutput('an_aus', 0);
        context.emitOutput('aus',    1);
        context.nodeLog('⏹ Aus');
      }
    }, sekunden * 1000);

    return {};
  },
};
