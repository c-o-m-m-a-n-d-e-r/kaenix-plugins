# kaenix Plugins

Plugins erweitern den **Logic Editor** von kaenix um eigene Node-Typen.  
Jedes Plugin ist eine einzelne JavaScript-Datei und wird beim Start automatisch geladen.

---

## Dateistruktur

```
plugins/
└── mein-plugin/
    └── mein-plugin-kaenix.js   ← Dateiname endet auf -kaenix.js
```

Der Ordnername spielt keine Rolle – erkannt werden alle Dateien, die auf `-kaenix.js` enden.

---

## Minimales Plugin

```js
module.exports = {
  type:        'mein-plugin',          // eindeutiger Typ-Bezeichner (kebab-case)
  category:    'Eigene',               // Gruppe im Node-Menü
  label:       'Mein Plugin',          // Anzeigename
  description: 'Was dieses Plugin tut',
  color:       '#6366f1',              // Header-Farbe der Node (Hex)

  inputs:  [{ handle: 'in',  label: 'Eingang' }],
  outputs: [{ handle: 'out', label: 'Ausgang' }],

  config: [],                          // Konfigurationsfelder (siehe unten)

  execute(inputs, data, context) {
    // Logik hier
    return inputs.in;                  // Einzelwert → geht an outputs.out
  },
};
```

---

## Felder im Detail

### `type` _(string, Pflicht)_
Eindeutiger Bezeichner in kebab-case. Darf nur einmal vorkommen.

### `category` _(string)_
Gruppenname im "Node hinzufügen"-Panel, z.B. `'Automatisierung'`, `'Mathematik'`, `'Benachrichtigung'`.

### `label` / `description`
`label` erscheint als Node-Titel im Logic-Editor.  
`description` ist nur in der Detailansicht sichtbar (nicht auf der Node selbst).

### `color` _(CSS Hex-Farbe)_
Header-Farbe der Node, z.B. `'#f59e0b'`.

### `inputs` / `outputs`
Arrays von Handle-Definitionen:

```js
inputs: [
  { handle: 'trigger', label: 'Trigger' },
  { handle: 'wert',    label: 'Wert'    },
],
outputs: [
  { handle: 'out',     label: 'Ergebnis' },
  { handle: 'error',   label: 'Fehler'   },
],
```

`handle` ist der interne Bezeichner (wird in `inputs.*` und `return {}` verwendet).  
`label` ist der Anzeigetext neben dem Verbindungspunkt.

### `config`
Felder, die der Nutzer pro Node-Instanz konfigurieren kann:

```js
config: [
  { key: 'zeitSekunden', label: 'Zeit in Sekunden', type: 'number', default: 60, placeholder: '60' },
  { key: 'modus',        label: 'Modus', type: 'select',
    options: [
      { value: 'auto',    label: 'Automatisch' },
      { value: 'manuell', label: 'Manuell'     },
    ]
  },
  { key: 'text',  label: 'Nachricht', type: 'text'     },
  { key: 'token', label: 'API Token', type: 'password' },
]
```

Verfügbare `type`-Werte: `text`, `number`, `password`, `select`, `checkbox`.

Das optionale Feld `default` setzt den Startwert wenn eine neue Node-Instanz angelegt wird.

### `dynamicOutputs(data)` _(optional)_

Statt eines statischen `outputs`-Arrays kann eine Funktion definiert werden, die die Ausgänge
dynamisch aus den aktuellen Konfigurationswerten berechnet. Die Node im Logic-Editor
aktualisiert ihre Handles in Echtzeit wenn der Nutzer die Konfiguration ändert.

```js
dynamicOutputs(data) {
  const n = Math.max(1, parseInt(data?.count ?? 4, 10));
  return Array.from({ length: n }, (_, i) => ({
    handle: `out${i + 1}`,
    label:  `Ausgang ${i + 1}`,
  }));
},
```

> `dynamicOutputs` ersetzt `outputs`. Wird `dynamicOutputs` definiert, wird `outputs` ignoriert.

### `globalSettings`
Einstellungen, die einmalig pro Plugin-Typ gelten (z.B. API-Keys).  
Syntax identisch zu `config`. Zugriff via `context.globalSetting(key)`.

```js
globalSettings: [
  { key: 'apiToken', label: 'API Token', type: 'password' },
],
```

---

## `execute(inputs, data, context)`

Wird aufgerufen, wenn ein Eingangssignal eintrifft.

| Parameter | Inhalt |
|-----------|--------|
| `inputs`  | Objekt mit den aktuellen Eingangs-Werten, z.B. `inputs.trigger`, `inputs.in` |
| `data`    | Konfigurationswerte der Node (aus `config`), z.B. `data.zeitSekunden` |
| `context` | Helper-Objekt (siehe unten) |

### Rückgabewert

```js
// Einzelwert → geht an outputs.out
return 42;

// Mehrere Ausgänge explizit setzen
return { out: 42, error: null };

// Nichts ausgeben
return {};
```

---

## `context` – Helper-Objekt

### Logging

```js
context.log('Wert empfangen:', inputs.in);   // Eintrag im Script-Log-Panel
context.warn('Achtung:', inputs.in);          // Wie log, aber mit [warn]-Präfix
context.nodeLog('⏱ 42s');                    // Kurztext direkt auf der Node (max. 3 Zeilen)
```

### Asynchrone Ausgabe

Für Ausgaben nach einem Timer oder HTTP-Call (der Rückgabewert von `execute` ist dann `{}`):

```js
context.emitOutput('status', 1);   // handle-Name, Wert
```

### Globale Einstellungen

```js
const token = context.globalSetting('apiToken');
context.setGlobalSetting('letzterWert', 42);
```

### Node-ID

```js
const nodeId = context.nodeId;   // Eindeutige ID der Node-Instanz (string)
```

---

## Async / Timer / HTTP

`execute` kann asynchrone Operationen starten. Wichtig: `return {}` sofort, Ausgaben über `context.emitOutput`.

**Timer-Beispiel:**
```js
execute(inputs, data, context) {
  if (!inputs.trigger) return {};

  setTimeout(() => {
    context.emitOutput('out', 1);
    context.nodeLog('✓ gesendet');
  }, 2000);

  return {};
},
```

**HTTP-Fetch-Beispiel:**
```js
execute(inputs, data, context) {
  fetch('https://api.example.com/data')
    .then((res) => res.json())
    .then((json) => {
      context.emitOutput('out', json.value);
      context.log('Antwort:', json.value);
    })
    .catch((e) => context.warn('Fehler:', e.message));

  return {};
},
```

---

## Pro-Node-State (mehrere Instanzen)

Damit Timers und Zustände pro Node-Instanz getrennt laufen:

```js
const _states = {};

function getState(nodeId) {
  if (!_states[nodeId]) _states[nodeId] = { timer: null };
  return _states[nodeId];
}

module.exports = {
  // ...
  execute(inputs, data, context) {
    const nodeId = context.nodeId || 'default';
    const s = getState(nodeId);

    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      context.emitOutput('out', 1);
    }, 1000);

    return {};
  },
};
```

---

## Vollständiges Beispiel

```js
/**
 * @plugin    Scaler
 * @version   1.0.0
 * @author    Dein Name
 */
module.exports = {
  type:        'scaler',
  category:    'Mathematik',
  label:       'Scaler',
  description: 'Skaliert einen Wert: (in × Faktor) + Offset',
  color:       '#0d9488',

  inputs:  [{ handle: 'in',  label: 'Wert'     }],
  outputs: [{ handle: 'out', label: 'Ergebnis' }],

  config: [
    { key: 'factor', label: 'Faktor',            type: 'number' },
    { key: 'offset', label: 'Offset',            type: 'number' },
    { key: 'digits', label: 'Nachkommastellen',  type: 'number' },
  ],

  execute(inputs, data, context) {
    const val    = parseFloat(inputs.in  ?? 0);
    const factor = parseFloat(data.factor ?? 1);
    const offset = parseFloat(data.offset ?? 0);
    const digits = parseInt(data.digits   ?? 1, 10);

    const result = parseFloat((val * factor + offset).toFixed(digits));
    context.log(`${val} × ${factor} + ${offset} = ${result}`);
    return result;
  },
};
```

---

## Namenskonvention

| Was              | Konvention                        | Beispiel                        |
|------------------|-----------------------------------|---------------------------------|
| Dateiname        | `<name>-kaenix.js`                | `mein-plugin-kaenix.js`         |
| `type`           | kebab-case, eindeutig             | `mein-plugin`                   |
| `handle`-Namen   | lowercase, keine Leerzeichen      | `trigger`, `restzeit`           |
| `config`-Keys    | camelCase                         | `zeitSekunden`, `apiToken`      |

---

## Mitgelieferte Plugins

| Plugin | Typ | Kategorie | Beschreibung |
|--------|-----|-----------|------------------|
| **Scaler** | `scaler` | Mathematik | Skaliert einen Wert: `(in × Faktor) + Offset` |
| **Hysterese** | `hysteresis` | Logik | Zweipunktregelung mit Totband (Unter-/Obergrenze) |
| **Treppenhauslicht** | `treppenhauslicht` | Automatisierung | Schaltet ein Licht für konfigurierbare Zeit nach Trigger |
| **Lauflicht** | `lauflicht` | Automatisierung | Schaltet N Ausgänge nacheinander ein/aus mit einstellbarer Verzögerung |
| **BWM** | `bwm` | Automatisierung | Bewegungsmelder mit Helligkeitsschwelle, Nachlaufzeit und Grundbeleuchtung |
| **Heizstab** | `heizstab` | Energie | Steuert einen PV-Überschuss-Heizstab mit bis zu 3 Phasen, Boost und Temperaturüberwachung |
| **Push** | `push` | Benachrichtigung | Sendet Web-Push-Benachrichtigungen |
| **CallMeBot** | `callmebot` | Benachrichtigung | Sendet WhatsApp-Nachrichten via CallMeBot-API |

### BWM – Konfiguration

| Parameter | Typ | Default | Beschreibung |
|-----------|-----|---------|--------------|
| `schwelleDefault` | number | 100 | Helligkeitsschwelle – nur unter diesem Wert wird eingeschaltet |
| `nachlaufzeitDefault` | number | 1 | Nachlaufzeit in Minuten |
| `freigabeDefault` | number | 1 | Freigabe beim Start (1 = aktiv, 0 = gesperrt) |
| `grundDefault` | number | 0 | Grundbeleuchtung nach Ablauf (1 = ja, 0 = nein) |

**Eingänge:**

| Handle | Beschreibung |
|--------|--------------|
| `trigger` | Bewegungsmelder-Impuls (1 = Bewegung erkannt) |
| `helligkeit` | Aktueller Helligkeitswert |
| `schwelle` | Helligkeitsschwelle (überschreibt Konfiguration) |
| `nachlaufzeit` | Nachlaufzeit in Minuten (überschreibt Konfiguration) |
| `freigabe` | Freigabe (1 = aktiv, 0 = gesperrt) |
| `grundbeleuchtung` | Grundbeleuchtung nach Ablauf aktivieren (1 = ja) |

**Ausgänge:**

| Handle | Beschreibung |
|--------|--------------|
| `an_aus` | Schalt-Telegramm (1 = ein, 0 = aus) |
| `an` | Impuls beim Einschalten |
| `aus` | Impuls beim Ausschalten |
| `grund` | Grundbeleuchtung aktiv (Impuls) |
| `aktiv` | Nachlauf läuft gerade (1 / 0) |
| `restzeit` | Verbleibende Nachlaufzeit in Sekunden |

**Verhalten:** Trigger + Freigabe aktiv + Helligkeit ≤ Schwelle → Licht ein, Nachlauftimer startet.  
Kommt während des Nachlaufs ein erneuter Trigger, wird der Timer zurückgesetzt (verlängert).  
Nach Ablauf: wenn Grundbeleuchtung aktiv und Helligkeit < Schwelle → `grund`-Ausgang, sonst `aus`.

---

### Lauflicht – Konfiguration

| Parameter | Typ | Default | Beschreibung |
|-----------|-----|---------|------------------|
| `outputs` | number | 4 | Anzahl Ausgänge (beliebig viele, dynamisch) |
| `delay` | number | 200 | Verzögerung zwischen Ausgängen in ms |
| `direction` | select | `forward` | Richtung beim Einschalten: `forward` (1→N) oder `backward` (N→1) |
| `reverseOnOff` | select | `0` | Beim Ausschalten Richtung umkehren: `0` = nein, `1` = ja |

Die Ausgänge passen sich in der Node live an wenn die Anzahl geändert wird (`dynamicOutputs`).

### Heizstab – Konfiguration

| Parameter | Typ | Default | Beschreibung |
|-----------|-----|---------|---------------------|
| `minTemp` | number | 0 | Unterhalb dieser Temperatur wird sofort geheizt |
| `maxTemp` | number | 60 | Oberhalb von `maxTemp + 0,2 °C` wird abgeschaltet |
| `phasen` | select | `3` | Anzahl nutzbarer Phasen (1–3) |
| `phasePower` | number | 2000 | Leistung pro Phase in Watt |
| `warten` | select | `0` | Bei fehlendem Überschuss: `0` = alternativ heizen, `1` = warten |
| `batterieLimit` | number | 20 | Ab diesem Batterieladezustand (%) wird Boost aktiviert wenn kein PV-Überschuss |
| `ueberschuss` | number | 0 | Überschussregel: Temp-Abweichung von maxTemp ab der PV-Heizung einsetzt (0 = aus) |
| `beobachtung` | number | 30 | Watchdog-Zeit in Sekunden: nach Ablauf wird abgeschaltet wenn Überschuss < 1 W |
| `aktiv` | select | `1` | Steuerung aktiv (`1`) oder inaktiv (`0`) |

**Eingänge:** 15 KNX-Eingänge (alle optional, überschreiben die Node-Konfiguration).  
**Ausgänge:** `L1`, `L2`, `L3` (Phasen), `Alternativ heizen`, `Leistung (%)`, `Debug`.

