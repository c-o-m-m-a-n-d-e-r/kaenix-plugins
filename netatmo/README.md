# Netatmo Wetterstation

Version **1.0.1**. Das Plugin liest die Netatmo-Wetterstation über die offizielle
Cloud-API aus. Unterstützt werden Basisstation (`NAMain`), Außenmodul
(`NAModule1`), Windmesser (`NAModule2`), Regenmesser (`NAModule3`) und zusätzliche
Innenmodule (`NAModule4`). Keine zusätzlichen npm-Abhängigkeiten erforderlich.

## Einrichtung

1. Unter [Netatmo Connect](https://dev.netatmo.com/apps/) eine eigene Anwendung
   erstellen und das Wetterstationskonto mit der Berechtigung `read_station`
   autorisieren. Für den Einstieg kann der Token-Generator der Anwendung verwendet
   werden. Benötigt wird das **Refresh-Token**, nicht das kurzlebige Access-Token.
2. `netatmo-kaenix.js` über die Plugin-Verwaltung installieren oder nach
   `<PLUGINS_DIR>/netatmo/` kopieren und Plugins neu laden.
3. In den globalen Plugin-Einstellungen **Client-ID**, **Client-Secret** und
   **Refresh-Token** eintragen. Ein Konto pro Plugin-Installation wird unterstützt.
4. Eine **Netatmo**-Node im Logic Editor hinzufügen und unter **Station / Modul**
   das gewünschte Gerät auswählen. Pro Modul eine Node verwenden. Manuelle IDs
   haben das Format `<Station-ID>/<Modul-ID>`; bei der Basisstation sind beide
   IDs gleich. Namen und IDs werden nicht übersetzt.
5. Ausgänge mit KNX-Ausgangs-Nodes oder weiterer Logik verbinden.

Das Plugin erneuert OAuth-Tokens automatisch und speichert das rotierende
Refresh-Token in den vorhandenen Plugin-Einstellungen. Das Token nicht gleichzeitig
für andere Integrationen verwenden. Bei abgelehnter Anmeldung die Anwendung erneut
mit `read_station` autorisieren und ein frisches Refresh-Token hinterlegen.
Zugangsdaten erscheinen weder an Ausgängen noch in Plugin-Logs.

## Abfragen und Ausgänge

Nach Aktivierung wird einmal abgefragt, danach standardmäßig alle **300 Sekunden**.
Das globale Intervall erlaubt `0` für manuelle Abfragen oder ganze Zahlen von
60 bis 86400 Sekunden. Eingang `refresh = 1` fragt erneut ab. Gleichzeitige
Abfragen mehrerer Nodes und der Geräteauswahl werden zusammengefasst; erfolgreiche
Antworten werden mindestens 60 Sekunden wiederverwendet. Netatmo liefert keine
Echtzeitdaten. Fehler verursachen eine steigende Wartezeit von einer Minute bis
zu einer Stunde; bei HTTP 429 wird zusätzlich `Retry-After` berücksichtigt.

| Ausgang                          | Einheit / Bedeutung                                            |
| -------------------------------- | -------------------------------------------------------------- |
| `temperature`, `humidity`, `co2` | °C, %, ppm                                                     |
| `pressure`, `noise`              | hPa, dB                                                        |
| `rain`                           | Von Netatmo gemeldeter aktueller Regenwert in mm               |
| `rainHour`, `rainDay`            | Regenmenge letzte Stunde / letzte 24 Stunden in mm             |
| `wind`, `gust`                   | km/h                                                           |
| `windAngle`, `gustAngle`         | Grad                                                           |
| `battery`                        | Batterie in %, falls vom Modul geliefert                       |
| `updated`                        | Messzeitpunkt als Unix-Sekunden, unabhängig von der UI-Sprache |
| `connected`                      | Letzte Cloud-Abfrage erfolgreich                               |
| `available`                      | Modul erreichbar und Messwerte höchstens 20 Minuten alt        |
| `error`                          | Übersetzbarer Diagnose-Schlüssel oder leerer String            |

Nur vom gewählten Modul gelieferte Messwerte sind belegt. Nicht unterstützte,
fehlende oder ungültige Werte sind `null`; bei Verbindungsfehlern, nicht erreichbaren
Modulen oder veralteten Messwerten werden Messausgänge ebenfalls auf `null`
gesetzt. Nullwerte wie 0 mm Regen bleiben erhalten. Für Automatisierungen
`available` berücksichtigen. Die Basisstation liefert gewöhnlich keinen Batteriewert.

Die DE/EN-Oberflächentexte werden mit dem Plugin ausgeliefert. Die Cloud-Anfragen
laufen ausschließlich auf dem Homeserver. Modulauswahl und Konfiguration verwenden
die vorhandenen authentifizierten Plugin-Routen auch über das Remote-Gateway;
zusätzliche Frontend-Builds oder Gateway-Routen sind nicht erforderlich.

## API-Referenzen

- [Weather API](https://dev.netatmo.com/apidocumentation/weather)
- [OAuth](https://dev.netatmo.com/apidocumentation/oauth)
- [Offizieller Netatmo-Client](https://github.com/Netatmo/Netatmo-API-PHP)

Eigenständige JavaScript-Implementierung der HTTP-Schnittstelle.
