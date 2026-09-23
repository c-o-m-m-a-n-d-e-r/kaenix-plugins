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
Header-Farbe der Node, z.B. `'#f59e0b'`. Plugins der Kategorie `Geräte` verwenden einheitlich Orange (`#f97316`).

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
| **Mischer** | `mischer` | Energie | Regelt ein 3-Wege-Mischventil zyklisch mit gedämpften Stellschritten und Pumpenabschaltung |
| **Push** | `push` | Benachrichtigung | Sendet Web-Push-Benachrichtigungen |
| **CallMeBot** | `callmebot` | Benachrichtigung | Sendet WhatsApp-Nachrichten via CallMeBot-API |
| **Shelly** | `shelly` | Geräte | Steuert Shelly-Geräte Gen 1–4 (Relay, Dimmer, RGBW, Jalousie, Sensoren) |
| **Philips Hue** | `philips-hue` | Geräte | Steuert Philips Hue Lampen und Gruppen über die Hue Bridge (API v1) |

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

---

### Mischer – Konfiguration

[mischer/mischer-kaenix.js](mischer/mischer-kaenix.js), Version **1.0.0**,
Kategorie **Energie**. Regelt ein 3-Wege-Mischventil über einen Prozent-Sollwert.
Größere Ventilöffnung muss die Mischtemperatur erhöhen; 0 % schließt die warme
Beimischung.

**Eingänge in Reihenfolge:** Temperatur Ist (°C), Temperatur Soll (°C),
Ventil Ist (%), Hysterese (K), Zyklus (s), Pumpenstatus (0/1 bzw. Boolean).

**Ausgang:** Ventil Soll (%), begrenzt auf 0–100 %.

| Einstellung | Standard | Bedeutung |
|-------------|----------|-----------|
| Temperatur Soll | Kein Vorgabewert | Solltemperatur in °C |
| Hysterese | 1 K | Regelbeginn außerhalb Soll ± Hysterese; Halten ab Soll ± halber Hysterese |
| Zyklus | 30 s | Berechnungsintervall, zulässig 1–86400 Sekunden |

Eingänge überschreiben die entsprechenden Node-Einstellungen. Temperatur Ist
und Ventil Ist benötigen gültige Messwerte; die Hysterese muss positiv sein.

- Pumpen-Aus setzt sofort 0 % und stoppt den Timer. Währenddessen erfolgen keine
  weiteren Berechnungen. Fehlender oder ungültiger Pumpenstatus gilt als Aus.
- Nach Pumpen-Ein startet die Berechnung nach einem vollständigen Zyklus.
  Eingangstelegramme aktualisieren die Werte ohne zusätzliche Regelschritte.
- Stellschritte von 0,2 bis maximal 3 Prozentpunkten pro Zyklus, eine Trendbremse
  und die Bestätigung von Richtungswechseln über zwei Zyklen reduzieren Pendeln.
- Weicht Ventil Ist um mehr als einen Prozentpunkt vom letzten Stellauftrag ab,
  wartet die Regelung auf die tatsächliche Ventilposition.
- Ungültige Messwerte pausieren die Regelung bei unverändertem Stellauftrag;
  Pumpen-Aus hat Vorrang. Unveränderte Ausgangswerte werden nicht erneut gesendet.

Den Zyklus an Ventillaufzeit und thermische Reaktionszeit der Anlage anpassen.
Eine für jede Anlage ideale Position oder Schwingungsfreiheit ist nicht garantiert.
Details und Hinweise zu Rückmeldungen: [Mischer-Dokumentation](mischer/README.md).

---

### Shelly – Konfiguration

Unterstützt Shelly-Geräte **Gen 1** (REST-API) und **Gen 2 / 3 / 4** (RPC-API mit Digest-Auth SHA-256).  
Die Gerätegeneraion wird beim ersten Verbindungsaufbau automatisch per `GET /shelly` erkannt.

| Parameter | Typ | Default | Beschreibung |
|-----------|-----|---------|--------------|
| `ip` | text | – | IP-Adresse des Shelly |
| `port` | number | `80` | HTTP-Port |
| `channel` | number | `0` | Kanal (0-basiert, z.B. 0 oder 1 beim Shelly 2.5) |
| `type` | select | `relay` | Gerätetyp: `relay`, `light`, `color`, `white`, `roller`, `sensor` |
| `rgbwRange` | select | `percent` | Wertebereich für RGBW-Ein-/Ausgänge: `0–100 %` oder `0–255` |
| `interval` | number | `0` | Status-Abfrage-Intervall in Sekunden (0 = deaktiviert) |
| `dimmOn` | select | `0` | Bei Dim > 0 automatisch einschalten |
| `dimmOff` | select | `0` | Bei Dim = 0 automatisch ausschalten |
| `autoFwUpdate` | select | `0` | Firmware automatisch aktualisieren wenn ein Update verfügbar ist |
| `username` | text | – | Benutzername (nur wenn Auth aktiviert) |
| `password` | password | – | Passwort – Gen 1: Basic Auth · Gen 2+: Digest Auth (SHA-256) |

**Eingänge:**

| Handle | Beschreibung |
|--------|--------------|
| `onOff` | Ein/Aus (1 = ein, 0 = aus) |
| `brightness` | Helligkeit 0–100 % (Dimmer/Light) |
| `triggerStatus` | Trigger: Status sofort abfragen |
| `fwUpdate` | Trigger: Firmware-Update starten |
| `reboot` | Trigger: Gerät neu starten |
| `openClose` | Jalousie: 1 = Auf, 0 = Zu |
| `stop` | Jalousie: Stop-Trigger |
| `position` | Jalousie: Zielposition 0–100 % |
| `red` | Rot (Bereich je nach `rgbwRange`) |
| `green` | Grün (Bereich je nach `rgbwRange`) |
| `blue` | Blau (Bereich je nach `rgbwRange`) |
| `white` | Weiß (Bereich je nach `rgbwRange`) |
| `gain` | Gain 0–100 % |

**Ausgänge:**

| Handle | Beschreibung |
|--------|--------------|
| `connected` | Verbindungsstatus (1 = verbunden, 0 = getrennt) |
| `onOff` | Status Ein/Aus (1/0) |
| `brightness` | Helligkeit 0–100 % |
| `power` | Aktuelle Leistung in W |
| `energy` | Gesamtenergie in kWh |
| `overpower` | Überlast (1 = Überlast, 0 = OK) |
| `temp` | Gerätetemperatur in °C |
| `overtemp` | Übertemperatur-Alarm (1/0) |
| `fwAvailable` | Firmware-Update verfügbar (1/0) |
| `red` | Rot (Bereich je nach `rgbwRange`) |
| `green` | Grün (Bereich je nach `rgbwRange`) |
| `blue` | Blau (Bereich je nach `rgbwRange`) |
| `white` | Weiß (Bereich je nach `rgbwRange`) |
| `gain` | Gain 0–100 % |
| `extTemp1` | Externer Temperaturfühler 1 (°C, Shelly AddOn) |
| `extTemp2` | Externer Temperaturfühler 2 (°C, Shelly AddOn) |
| `extTemp3` | Externer Temperaturfühler 3 (°C, Shelly AddOn) |
| `positionOut` | Aktuelle Jalousieposition 0–100 % |
| `inputState` | Eingang-Status (0/1) |
| `inputEvent` | Eingang-Event (z.B. `S`, `L`) |
| `humidity` | Relative Luftfeuchte in % |
| `battery` | Batterieladezustand in % |
| `flood` | Leckage erkannt (1/0) |
| `motion` | Bewegung erkannt (1/0) |
| `tamper` | Tamper / Alarm (1/0) |

**API-Unterschiede je Generation:**

| | Gen 1 | Gen 2 / 3 / 4 |
|---|---|---|
| Steuern | `GET /relay/0?turn=on` | `POST /rpc` → `Switch.Set` |
| Dimmen | `GET /light/0?brightness=80` | `POST /rpc` → `Light.Set` |
| RGBW | `GET /color/0?red=…` | `POST /rpc` → `RGBW.Set` |
| Jalousie | `GET /roller/0?go=open` | `POST /rpc` → `Cover.Open/Close/GoToPosition` |
| Status | `GET /status` | `POST /rpc` → `Shelly.GetStatus` |
| Auth | HTTP Basic Auth | Digest Auth (SHA-256, im JSON-Body) |

---

### Philips Hue – Konfiguration

Version **1.0.11**.

Steuert Philips Hue Lampen und Gruppen über die **Hue Bridge API v1** (HTTP, kein HTTPS erforderlich).  
Der Status-Punkt im Node-Titel zeigt grün (verbunden) / rot (getrennt) basierend auf dem letzten Status-Abruf.

**Globale Einstellungen** (gelten für alle Hue-Nodes):

| Parameter | Beschreibung |
|-----------|--------------|
| `ip` | IP-Adresse der Hue Bridge |
| `port` | HTTP-Port (Standard: 80) |
| `apiKey` | API Key / Bridge Username (aus der Bridge-Einrichtung) |

**Node-Konfiguration:**

| Parameter | Typ | Default | Beschreibung |
|-----------|-----|---------|--------------|
| `ip` | text | – | Überschreibt globale IP (optional) |
| `port` | number | – | Überschreibt globalen Port (optional) |
| `apiKey` | text | – | Überschreibt globalen API Key (optional) |
| `lightId` | number | `0` | Lampen-ID (0 = deaktiviert) |
| `groupId` | number | `0` | Gruppen-ID (0 = deaktiviert, hat Vorrang wenn lightId = 0) |
| `gamut` | select | `B` | Farbgamut: `A` (LivingColors, Bloom), `B` (Hue A19, Standard), `C` (Hue Go, LightStrips+) |
| `intelliStart` | select | `0` | Intelli Start: Szene beim Einschalten setzen (1 = ja) |
| `scene` | text | – | Szenen-ID die beim Einschalten gesetzt wird (nur bei Intelli Start) |
| `startBri` | number | `0` | Starthelligkeit in % beim Einschalten (0 = deaktiviert) |
| `interval` | number | `0` | Pause nach abgeschlossener Statusabfrage in Sekunden (0 = deaktiviert, sofern schnelles Polling aus ist) |
| `longPoll` | select | `0` | Schnelles Status-Polling: mindestens 5 Sekunden Pause; ein größeres Status-Intervall hat Vorrang |

**Statusabfragen ab 1.0.11:** Das bisher „Long-Polling“ genannte Verfahren
ist regelmäßiges HTTP-Polling, kein Push-Kanal. Beide Polling-Einstellungen
verwenden jetzt einen gemeinsamen Timer. Pro Node läuft höchstens eine
Statusabfrage gleichzeitig, auch bei zusätzlichen Triggern oder Schaltbefehlen.
Intervalländerungen werden übernommen; Entfernen, Deaktivieren oder Neuladen
beendet Timer und laufende Statusanfragen.

Bei Statusfehlern wachsen die Abfragepausen von 10 über 20, 40, 80 und 160 auf
maximal 300 Sekunden. Ein größeres konfiguriertes Intervall bleibt maßgeblich.
Auch Status-Trigger und Abfragen nach Schaltbefehlen beachten die Fehlerpause;
Schaltbefehle selbst bleiben möglich. Bei deaktiviertem Polling erfolgt keine
automatische Wiederholung. Identische Statusfehler werden höchstens alle fünf
Minuten protokolliert. Eine erfolgreiche Abfrage setzt die Fehlerpause zurück
und meldet die Verbindung wieder als hergestellt.

**Eingänge:**

| Handle | Beschreibung |
|--------|--------------|
| `onOff` | Ein/Aus (1 = ein, 0 = aus) |
| `brightness` | Helligkeit 0–100 % |
| `saturation` | Sättigung 0–100 % |
| `colorTemp` | Farbtemperatur 0 (kalt/6500 K) bis 100 (warm/2000 K) |
| `red` | Rot 0–100 |
| `green` | Grün 0–100 |
| `blue` | Blau 0–100 |
| `hsv` | Farbe als gepackter Dezimalwert (RRGGBB hex → integer, z.B. `0xFF8800`) |
| `scene` | Szene aktivieren (ID-String) |
| `dim` | KNX 4-Bit Relativdimmer (DPT 3.007) |
| `triggerStatus` | Trigger: Status sofort abfragen |

**Ausgänge:**

| Handle | Beschreibung |
|--------|--------------|
| `connected` | Verbindungsstatus (1 = verbunden, 0 = getrennt) |
| `onOff` | Status Ein/Aus (1/0) |
| `brightness` | Helligkeit 0–100 % |
| `saturation` | Sättigung 0–100 % |
| `colorTemp` | Farbtemperatur 0–100 |
| `red` | Rot 0–100 |
| `green` | Grün 0–100 |
| `blue` | Blau 0–100 |
| `hsv` | Farbe als gepackter Dezimalwert (RRGGBB) |

**Farbmodi im Vergleich:**

| Modus | Eingang | Hue-API intern |
|-------|---------|----------------|
| Farbtemperatur | `colorTemp` 0–100 % | `ct` 153–500 Mired |
| RGB | `red` / `green` / `blue` 0–100 | xy (CIE 1931, Gamut-korrigiert) |
| HSV / Hex | `hsv` (Dezimalwert) | `hue` 0–65535 + `sat` + `bri` |
| Szene | `scene` (ID-String) | `scene` direkt |

**KNX 4-Bit Dimmer (DPT 3.007):**  
Bit 3 = Richtung (1 = heller, 0 = dunkler), Bits 0–2 = Schrittweite 1–7.  
Byte `0x00` = Stopp-Telegramm (wird ignoriert).


### Somfy Tahoma – lokale Steuerung

`somfy-tahoma/somfy-tahoma-kaenix.js`, Version **1.0.1**. Benötigt eine
TaHoma-Box mit aktiviertem [Developer Mode und lokalem Token](https://github.com/Somfy-Developer/Somfy-TaHoma-Developer-Mode).
Die Kommunikation erfolgt ausschließlich über die lokale HTTPS-API auf Port 8443.

Unter **Plugins → Somfy Tahoma → Einstellungen** IP-Adresse und Token speichern.
Eingang 1 und 2 überschreiben diese Werte für die jeweilige Node. Pro Node den
Gerätenamen oder die vollständige Geräte-ID (`deviceURL`, beispielsweise
`io://1234-5678-9012/123456#1`) konfigurieren oder über Eingang 3/4 zuführen.
Die Geräte-ID hat Vorrang; Namen müssen innerhalb der Box eindeutig sein.

| Eingang | Funktion |
|---|---|
| 1 / 2 | IP-Adresse / Token; leer = globale Einstellung |
| 3 / 4 | Gerätename / vollständige Geräte-ID |
| 5 | Schalten: 0 = aus, 1 = ein |
| 6 | Toggle: jedes 0- oder 1-Telegramm schaltet um |
| 7 | Dimmwert 0–100 % |
| 8 / 9 | Öffnen / Schliessen, jeweils bei jedem 0- oder 1-Telegramm |
| 10 | Auf/Ab: 0 = auf, 1 = ab |
| 11 | Stop, bei jedem 0- oder 1-Telegramm |
| 12 | Position: 0 % = offen, 100 % = geschlossen |
| 13 | Lamellenwinkel 0–100 % gemäß TaHoma-Geräteskala |
| 14 | Status Trigger: Abfrage bei jedem 0- oder 1-Telegramm |
| 15 | Statusintervall in Sekunden; Standard 10, 0 deaktiviert Polling; Minimum 1 |

Die fünf Ausgänge liefern **Status**, **Helligkeit**, **Position**,
**Lamellenwinkel** und **Fährt**. Nur vorhandene, gültige Gerätestatuswerte werden
bei Änderungen ausgegeben. Insbesondere wird „Fährt“ aus `core:MovingState`
abgeleitet, nicht aus einer angenommenen Laufzeit. Geräte ohne Rückkanal
(z. B. manche RTS-Antriebe) liefern entsprechend keine verlässlichen Rückmeldungen.
Befehle werden vor dem Senden gegen die vom Gerät angebotenen Fähigkeiten geprüft.
Nicht jedes Gerät unterstützt Dimmen, absolute Position oder Lamellensteuerung.
Der Status-Trigger liest den zuletzt in der Box bekannten Zustand; er erzwingt
keine Funkabfrage des Antriebs.

Beim Serverstart erfolgt sofort eine Statusabfrage und anschließend das konfigurierte
Polling. Gespeicherte Schalt- und Fahrbefehle werden nicht erneut ausgeführt.

Das öffentliche Overkiz-CA-Zertifikat ist im Plugin enthalten; die TLS-Zertifikatskette
wird geprüft. Bei Verbindung über eine IP entfällt die Hostnamenprüfung, weil das
Box-Zertifikat einen Gateway-Namen enthält. Optional kann global die Gateway-PIN
hinterlegt werden, um zusätzlich `gateway-<PIN>.local` als Zertifikatsnamen zu prüfen.
Bei Nutzung eines DNS-Namens bleibt die normale Hostnamenprüfung aktiv.

### PowerView – Hunter Douglas / Luxaflex

`powerview/powerview-kaenix.js`, Version **1.0.3**. Lokale HTTP-Steuerung für
PowerView Gen 1, Gen 2 und Gen 3. Die API wird beim Start erkannt; in der Node kann
sie auch ausdrücklich ausgewählt werden. Bei Gen 3 die IP des primären Gateways
verwenden. IP und Port unter **Plugins → PowerView → Einstellungen** speichern
(Standardport 80); die entsprechenden Node-Eingänge überschreiben diese Vorgaben.

Ein Gerät wird anhand seiner numerischen ID oder seines eindeutigen Namens
gewählt, wahlweise in der Node-Konfiguration oder über die Eingänge. Die ID hat
Vorrang. Szenen funktionieren auch ohne zugeordnetes Gerät.

| Eingang | Funktion |
|---|---|
| 1 / 2 | IP-Adresse / Port (Standard 80) |
| 3 / 4 | Gerätename / Geräte-ID |
| 5 | Auf/Ab: 0 = auf, 1 = ab |
| 6 / 7 / 8 | Öffnen / Schliessen / Stop: nur Telegramme mit Wert 1 |
| 9 | Position: 0 % = offen, 100 % = geschlossen |
| 10 | Lamellenwinkel 0–100 % des unterstützten Verstellbereichs |
| 11 | Szene aktivieren: ID oder eindeutiger Name, ID hat Vorrang |
| 12 | Status Trigger: bei 1 Gerät über `refresh=true` abfragen |
| 13 | Statusintervall in Sekunden: Standard 10, 0 = Polling aus, Minimum 1 |

Die Ausgänge sind in dieser Reihenfolge **Verbindungsstatus**, **Position**,
**Lamellenwinkel**, **Batterie**, **Batteriewarnung**, **Fährt**. Unveränderte Werte
werden nicht erneut ausgegeben. Polling startet automatisch nach Serverstart;
gespeicherte Fahrbefehle und Szenen werden dabei nicht wiederholt.

Die Umsetzung orientiert sich an der [PowerView-Referenzimplementierung aiopvapi](https://github.com/sander76/aio-powerview-api).
Gen 1/2 nutzen `/api`, Gen 3 `/home` mit eigener Befehlsstruktur. Die jeweiligen
Positionswerte werden in Prozent umgerechnet. Gen 1 unterstützt keinen Stop-Befehl.
Lamellenbefehle werden anhand des Gerätetyps geprüft; bei Typen, die nur im
abgesenkten Zustand kippen können, muss der Behang zuvor geschlossen sein.
Bei mehrteiligen Behängen steuert der Positionseingang nur die primäre Schiene.
Öffnen/Schließen und Auf/Ab verwenden dagegen die typspezifischen Endlagen:
Top-Down/Bottom-Up setzt auch die zweite Schiene, Duolite schließt über die
sekundäre Schiene. Für andere kombinierte Positionen eine PowerView-Szene verwenden.

**Batterie:** Gen 1/2 liefern einen Spannungswert, der als Prozent-Näherung
umgerechnet wird. Gen 3 liefert nur Stufen, ausgegeben als 0/20/50/100 %.
Die Batteriewarnung folgt der niedrigsten/leeren Batteriestufe, ersatzweise
≤20 %. Bei bekannter Netzversorgung werden keine Batterieprozente erfunden.

**Fährt:** Die Standard-API liefert nicht überall eine verlässliche Rückmeldung.
Ohne expliziten Fahrstatus bleibt dieser Ausgang daher unbelegt. Optional kann
pro Node eine Laufzeitschätzung in Sekunden aktiviert werden (Standard 0 = aus).
Dann bedeutet 1: eigener Fahrbefehl angenommen; nach Ablauf oder Stop folgt 0.
Das ist eine Schätzung, kein gemessener Motorstatus. Fahrten über Fernbedienungen,
Apps und Szenen werden dadurch nicht erkannt. Für eine echte Rückmeldung wird
nur ein explizites `isMoving`-Feld verwendet, falls die Firmware es bereitstellt;
`velocity` oder gespeicherte Fahrbefehle werden nicht als Motorstatus interpretiert.

Der Status-Trigger fragt aktiv ab, normales Polling liest den Hub-Zwischenspeicher.
Batteriemessungen mit möglicher Jog-Bewegung werden nicht automatisch ausgelöst.

### WLED – LED-Steuerung

`wled/wled-kaenix.js`, Version **1.0.2**. Nutzt die lokale
[WLED-JSON-API](https://kno.wled.ge/interfaces/json-api/) über HTTP, ohne zusätzliche
Bibliotheken. IP und Port (Standard 80) sind global speicherbar und pro Node oder
Eingang überschreibbar. Segment-ID standardmäßig 0.

**Eingänge in Reihenfolge:** IP, Port, Segment-ID, Schalten, Toggle, Helligkeit,
Segment Ein/Aus, RGB, Rot, Grün, Blau, Weiß, Farbtemperatur, Effekt,
Effektgeschwindigkeit, Effektintensität, Farbpalette, Preset, Status Trigger,
Status Intervall.

**Ausgänge in Reihenfolge:** Verbindung, Status Ein/Aus, Helligkeit,
Segment Ein/Aus, RGB, Rot, Grün, Blau, Weiß, Farbtemperatur, Effekt-ID,
Effektgeschwindigkeit, Effektintensität, Farbpalette-ID, Preset-ID.

- Schalten und Toggle akzeptieren 0/1. Jedes Toggle-Telegramm schaltet um.
- Schalten und Helligkeit wirken auf das gesamte Gerät. Helligkeit 0 schaltet
  aus, Werte über 0 schalten ein. Bei ausgeschaltetem Gerät ist die Rückmeldung 0 %.
- Farben, Segment Ein/Aus, Farbtemperatur und Effekte betreffen ausschließlich
  das konfigurierte, bereits vorhandene Segment. Die Node erstellt keine Segmente.
- RGB nimmt ein DPT232.600-Objekt `{red, green, blue}` (je 0–255), einen
  gepackten RGB-Zahlenwert oder `#RRGGBB` entgegen. Der RGB-Ausgang liefert
  das DPT232.600-Objekt direkt für KNX; unveränderte Farben werden nicht erneut gesendet.
  Einzelkanäle, Helligkeit, Geschwindigkeit und Intensität verwenden 0–100 %.
  Änderungen einzelner Farbkanäle erhalten die anderen Kanäle der Primärfarbe.
- Weiß und Farbtemperatur benötigen geeignete LEDs und WLED-Konfiguration.
  Farbtemperatur 0–100 % entspricht dem WLED-CCT-Regler (warm bis kalt).
  Farbänderungen wechseln den laufenden Effekt nicht automatisch auf Solid.
- Effekte und Paletten sind per ID oder eindeutigem Namen auswählbar; Presets
  per ID 1–250 oder gespeichertem Namen. Ein Preset kann den gesamten
  Gerätezustand einschließlich weiterer Segmente ändern. Presets werden nur
  aufgerufen, nicht angelegt oder überschrieben. Preset-Rückmeldung -1 bedeutet
  kein aktives Preset.
- Status Trigger fragt nur bei 1 ab. Polling startet automatisch, standardmäßig
  alle 10 Sekunden; Intervall 0 deaktiviert es. Beim Serverstart erfolgt eine
  initiale Abfrage, ohne gespeicherte Befehle erneut auszuführen.
- Outputs melden nur Änderungen zurück. Verbindungsabbrüche werden angezeigt;
  bei aktivem Polling wird die Verbindung erneut geprüft.

### Fronius – Solar API und Überschuss-Schaltungen

`fronius/fronius-kaenix.js`, Version **1.0.0**. Überträgt die Funktionen der
Python-Vorlage Fronius 14166 / 0.481 auf die lokale Fronius Solar API V1.
Das Plugin gehört zur orangefarbenen Kategorie Geräte und benötigt keine
zusätzlichen Bibliotheken. Die Solar API muss am Wechselrichter verfügbar und
aktiviert sein. IP und HTTP-Port (Standard 80) können global gespeichert und
pro Node überschrieben werden. Eingänge haben Vorrang vor Node-Einstellungen.
Die Wechselrichter-ID ist pro Node einstellbar (Standard 1).

**Eingänge in Reihenfolge:** Fronius IP, Intervall (Sekunden), Überschuss 1 Start,
Überschuss 1 Ende, Überschuss 2 Start, Überschuss 2 Ende, Überschuss 3 Start,
Überschuss 3 Ende, Auszeit.

**Ausgänge in Reihenfolge:** PV Last, Haus Last, Netz Last, Batterie Last,
Batterie Ladezustand, Überschuss 1, Überschuss 2, Überschuss 3, Einspeisen?,
Energie Tag, Energie Jahr, Energie Total, Strom L1, Strom L2, Strom L3,
Spannung L1, Spannung L2, Spannung L3.

- Leistungen in W: Hausverbrauch positiv, Netzleistung positiv bei Einspeisung
  und negativ bei Bezug, Batterieleistung positiv beim Laden und negativ beim
  Entladen. Ladezustand in %, Energie in Wh, Phasenströme in A, Spannungen in V.
  Leistung und Energie werden wie in der Vorlage auf ganze Zahlen gerundet.
- Leistungswerte beziehen sich auf die gesamte Anlage (`Site`), Ladezustand,
  Energie und Phasenwerte auf die konfigurierte Wechselrichter-ID.
- Jeder Überschusskanal schaltet bei Netzleistung **über Start** ein und nach
  der konfigurierten Anzahl aufeinanderfolgender Messungen **unter Ende** aus.
  Dazwischen bleibt der Zustand erhalten. Ende muss unter Start liegen;
  negative Ende-Werte sind erlaubt. Start 0 deaktiviert den Kanal.
- Auszeit bedeutet **Abfragen, nicht Sekunden**, Standard 3; 0 schaltet bei der
  ersten Unterschreitung aus. Die fehlerhaften Zähler der Vorlage wurden
  korrigiert: Bei Erholung wird der jeweilige Zähler zurückgesetzt.
- Eine initiale Abfrage startet automatisch, auch nach einem Serverneustart.
  Das Intervall (Standard 10 Sekunden, 0 = keine Wiederholung) beginnt nach
  Abschluss der Abfragen. Abfragen überlappen sich nicht.
- Fehlende oder nicht unterstützte Messwerte bleiben unbelegt bzw. behalten
  den letzten Wert; es werden keine Nullwerte erfunden. Insbesondere Tages- und
  Jahresenergie sowie Phasenwerte sind modellabhängig. Ausgänge senden Änderungen.
- Fehlende Netzleistung oder ein Ausfall der Leistungsabfrage schaltet alle
  Überschuss-Ausgänge auf 0. Bei Verbindungsfehlern wird der Node-Status rot;
  mit aktivem Intervall wird automatisch erneut abgefragt. Einzelne Fehler
  der Energie-/Phasenabfrage blockieren die Leistungsabfrage nicht.
- Konfigurationsänderungen setzen Überschusskanäle zurück und starten eine neue
  Abfrage. Beim Entfernen/Deaktivieren der Node werden Timer und Anfragen beendet.

Referenz: [Fronius Solar API V1](https://www.fronius.com/~/downloads/Solar%20Energy/Operating%20Instructions/42%2C0410%2C2012.pdf).
Lizenz entsprechend der Vorlage: GPL-3.0-or-later, ursprünglicher Copyright-Hinweis
knx-user-forum e.V.; siehe Plugin-Kopf.

### Gardena – smart system API v2

`gardena/gardena-kaenix.js`, Version **1.0.3**, Kategorie Geräte (orange).
Basiert funktional auf `gardena.py` / Logik 12980 v1.9995; verwendet ausschließlich
OAuth2 und die öffentliche Gardena smart system API v2, keine privaten App-Endpunkte.
Benötigt Internet, ein eingerichtetes Gardena smart system und die im kaenix-Server
bereits vorhandene Bibliothek `ws`.

**Einrichtung:** Im [Husqvarna Developer Portal](https://developer.husqvarnagroup.cloud/)
mit dem Gardena-Konto eine Anwendung erstellen und Authentication API sowie
GARDENA smart system API verbinden. Application Key und Application Secret global
im Plugin hinterlegen; optional pro Node überschreiben. Es wird kein Gardena-
Loginpasswort benötigt. Bei mehreren Gärten zusätzlich die Standort-ID eintragen.
Pro Gerät eine Node mit Geräte-ID anlegen. Bei leerer/unbekannter Geräte-ID nennt
Ausgang „Diagnose / Geräte-IDs“ die verfügbaren Geräte des gewählten Standorts.

**22 Eingänge in Reihenfolge:** Application Key, Application Secret, Geräte-ID,
Mähen/Parken, Status Trigger, Garagentor benutzen, Torzustand, Sicherheitsschaltung,
Tor-Öffnungsposition, Regen, Mähdauer (Stunden), Ventil öffnen/schließen,
Wasserdauer (Minuten), SIC Ventil 1–6, Standort-ID, Torposition beim Mähen,
Token erneuern.

Die beiden ersten Eingänge ersetzen Login/Passwort. **Eingang 20 ersetzt den alten
Webserver-Port durch die Standort-ID.** Es wird kein zusätzlicher Webserver geöffnet.
Die 34 Ausgänge behalten die Reihenfolge der tatsächlichen Ausgangsdefinition der
Vorlage bei (deren Einleitung nennt nur 28).

- Start, Token-Erneuerung und Wiederverbindung erfolgen automatisch. Nodes mit
  gleichen Zugangsdaten und gleicher Standort-Konfiguration teilen Token, Cache
  und WebSocket. Statusänderungen kommen per WebSocket; Status Trigger = 1 lädt
  den Standort erneut, höchstens einmal pro Stunde (ansonsten aus dem WebSocket-Cache). Der Trigger
  erzwingt keine neue physische Sensormessung.
- Mähen = 1 startet für die Mähdauer (Standard 24 h, maximal 24 h); 0 parkt bis
  zur nächsten geplanten Aufgabe. Ventil = 1 öffnet für die Wasserdauer
  (Standard 30 min, maximal 60 min), 0 stoppt bis zur nächsten Aufgabe.
  SIC 1–6 werden anhand ihrer Service-ID `Geräte-ID:1` bis `:6` zugeordnet.
  Der einzelne Ventileingang setzt genau einen VALVE-Dienst am Gerät voraus.
- Regen = 1 parkt bis auf Weiteres und sperrt Mähstarts. Regen = 0 setzt den
  Zeitplan nur fort, wenn diese Node zuvor die Regenpause ausgelöst hat.
  Nach einem Neustart werden weder gespeicherte Befehle noch eine Regenfreigabe
  automatisch ausgeführt; gegebenenfalls einen neuen Mähbefehl senden.
- Torsteuerung ist optional: 0 % = offen, 100 % = geschlossen. Beim Mähstart
  wird gegebenenfalls geöffnet und auf die **Rückmeldung 0** gewartet, maximal
  120 Sekunden. Öffnungsposition -1 bedeutet 0 %. Eine andere Öffnungsposition
  ersetzt die erforderliche Offen-Rückmeldung nicht. Parken, Regen und
  Verbindungsabbruch löschen eine ausstehende Startfreigabe.
- Rückmeldungen „sucht“/„verlässt Station“ öffnen das Tor; „mäht“ setzt die
  konfigurierte Torposition beim Mähen (Standard 0 %). Park-/Ladezustände schließen
  es auf 100 %, nur bei bestehender Cloud-Verbindung und Geräte-Funkstatus ONLINE.
  Mit Sicherheitsschaltung = 1 (Standard) wird bei Cloud-Verbindungsverlust die
  Öffnungsposition ausgegeben. Die Logik ersetzt keine lokale Torabsicherung.
- Geräteausgänge stammen aus Rückmeldungen, nicht aus der Annahme eines Befehls.
  Mäher aktiv = 1 bedeutet Mähen/Suchen/Verlassen der Station. Status Text enthält
  den API-Aktivitätscode; Betriebsstunden werden in h ausgegeben. Temperatur ist
  die Umgebungstemperatur, ersatzweise Bodentemperatur, falls nur diese vorliegt.
  Gerätefehler und API-/Verbindungsdiagnose sind getrennte Ausgänge.
- Die öffentliche API bietet nicht alle Werte der Vorlage: nächster Start
  (Datum/Zeit/Rest), reine Mähzeit, Ladezyklen, Kollisionen, manueller Modus,
  manuelle Minuten und Ventil-Restzeiten bleiben **unbelegt**, nicht künstlich 0.
  Das vorzeitige Toröffnen vor einem geplanten Start entfällt daher. Vor Nutzung
  autonomer Mähzeitpläne muss die lokale Torfreigabe anderweitig gewährleistet sein.
- Verbindungsfehler führen zu Wiederholungen mit zunehmendem Abstand; HTTP 429
  berücksichtigt Retry-After in Sekunden oder als HTTP-Datum. Befehle werden bei fehlender Verbindung
  verworfen und nach einer Wiederverbindung nicht nachgeholt. Entfernen/Deaktivieren
  beendet die Node; nach Entfernen der letzten Node werden Verbindung und Timer beendet.

API-Referenzen: [Developer Portal](https://developer.husqvarnagroup.cloud/apis/GARDENA+smart+system+API),
[py-smart-gardena](https://github.com/py-smart-gardena/py-smart-gardena).
Lizenz entsprechend der Vorlage: GPL-3.0-or-later; ursprünglicher Copyright-Hinweis
knx-user-forum e.V., siehe Plugin-Kopf.

Gardena ab 1.0.1: HTTP-Fehler nennen den betroffenen API-Schritt und die
Fehlermeldung aus der JSON-Antwort. Zugangsdaten und Tokens werden ausgeblendet.

Gardena ab 1.0.2: Die Standort-ID wird gegen die Gärten des Kontos geprüft.
Leere Werte und 0 am Standort-Eingang verwenden die Node-/globale Einstellung
bzw. wählen bei genau einem Garten automatisch dessen ID. Ungültige IDs oder
mehrere Gärten ohne Auswahl melden die verfügbaren Standort-IDs in der Diagnose.
Geräte-ID und Standort-ID sind unterschiedliche Werte.

## Plugin-Dateien auf GitHub Pages veröffentlichen

In `kaenix-plugins` unter **Settings → Pages → Build and deployment → Source**
**GitHub Actions** auswählen. Die Custom Domain bleibt `plugins.kaenix.net`.
Der Workflow `.github/workflows/pages.yml` veröffentlicht nach einem Push auf
`main` die Plugin-Dateien mit unveränderten Pfaden. Er lässt sich außerdem unter
**Actions → Publish plugin files to GitHub Pages → Run workflow** manuell starten.

Der Deploy-Job vergibt `pages: write` und `id-token: write` explizit. Ein persönlicher
Token oder das Secret `KAENIX_RELEASES_TOKEN` wird dafür nicht benötigt. Nach der
Umstellung einen neuen Lauf dieses Workflows starten; ein Re-run des alten
„pages build and deployment“-Laufs übernimmt die neue Workflow-Datei nicht.

Gardena ab 1.0.3 – Quota-Schutz:

- Kein zyklisches REST-Polling. Manuelle Statusabfragen und Wiederverbindungs-
  Snapshots teilen eine einstündige Sperre pro Verbindung, auch bei Fehlern.
- Gültige Tokens werden wiederverwendet; Erneuerung ohne WebSocket-Neustart.
  Standortlisten werden bei Wiederverbindungen maximal einmal täglich geladen.
- Maximal acht HTTP-Anfragen in zehn Sekunden pro Application Key innerhalb
  dieser Plugin-Instanz, einschließlich Token-Abfragen und aller Standorte.
  Überzählige Befehle werden mit Diagnose abgelehnt, nicht später nachgeholt.
- Identische erfolgreiche Befehle an denselben Dienst werden zehn Sekunden
  unterdrückt. Ein entgegengesetzter Befehl bleibt möglich, solange keine
  Anfrage-/Quota-Sperre aktiv ist. Die Warteschlange ist auf 32 Aktionen begrenzt.
- Wiederverbindungen: 30, 60, 120, 240, 300 Sekunden, danach stündlich.
  Erst eine mindestens fünf Minuten stabile WebSocket-Verbindung setzt den
  Fehlerzähler zurück. HTTP 400/403 und ungültige Standort-Konfigurationen
  stoppen automatische Wiederholungen bis zur Korrektur oder manuellem Versuch.
- HTTP 429: Application-Key-weite Pause von zunächst einer Stunde, bei weiteren
  429 bis zu 24 Stunden. Längere Retry-After-Vorgaben haben Vorrang. Manuelle
  Token-Erneuerung ist auf einen Versuch je 15 Minuten begrenzt und umgeht
  weder Quota-Pause noch eine bereits geplante Wiederverbindung.
- Die lokalen Quota-Zähler/Sperren gelten bis zum Plugin-Neuladen oder
  Serverneustart. Andere Programme mit demselben Application Key werden nicht
  mitgezählt. Deshalb sind diese Schutzmaßnahmen keine Garantie für die
  Einhaltung eines kontoweiten Wochen-/Monatsbudgets. Häufige Neustarts vermeiden.

PowerView ab 1.0.2: Fahrbefehle für mehrteilige Behänge korrigiert; Tilt-Anywhere-
Behänge erhalten bei Öffnen/Schließen die erforderliche Lamellenposition.
Duolite-Lamellensteuerung setzt zusätzlich einen geöffneten hinteren Behang voraus.
Auf/Ab bleibt 0=Auf, 1=Ab; Öffnen/Schließen/Stop reagieren jeweils auf 1.

PowerView ab 1.0.3: Batterie- und Warnungsausgabe überarbeitet: Unterstützung für
verschachtelte `battery`-Objekte, alternative Feldnamen (`batteryPercentage`,
`batteryLevel`), `batteryStrength` in allen Generationen sowie Behebung der
fälschlichen Unterdrückung bei `batteryStatus: 4`.
