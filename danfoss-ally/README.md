# Danfoss Ally · Version 1.0.1

Cloud-Anbindung für den kaenix-Logic-Editor, Kategorie **Geräte**. Pro Thermostat
eine steuernde Node verwenden. Gateway und Thermostate bleiben in der Ally-App;
die lokale Gateway-IP wird für diese Verbindung nicht benötigt.

## Einrichtung

1. Das System in der Danfoss-Ally-App vollständig einrichten.
2. Im [Danfoss-Entwicklerportal](https://developer.danfoss.com/) mit derselben
   E-Mail-Adresse wie in der Ally-App registrieren. Auch die Groß-/Kleinschreibung
   der E-Mail-Adresse beachten.
3. Eine Anwendung anlegen und die **Danfoss Ally API** freischalten. Deren
   **Consumer Key / Client ID** und **Consumer Secret / Client Secret** verwenden.
4. `danfoss-ally-kaenix.js` über die Plugin-Verwaltung installieren oder nach
   `<PLUGINS_DIR>/danfoss-ally/` kopieren und Plugins neu laden.
5. In den globalen Plugin-Einstellungen Client-ID, Client-Secret und optional das
   Statusintervall speichern. Standard: **300 Sekunden**, Minimum: **60 Sekunden**.
   `0` deaktiviert die periodischen Abfragen; die initiale und manuelle Abfrage
   sowie eine Folgeabfrage nach einem Befehl bleiben aktiv.
6. Im Logic-Editor **Danfoss Ally** hinzufügen und im Gerätefeld das Thermostat
   auswählen. Namen bleiben unverändert; manuelle Eingabe einer Geräte-ID ist möglich.

Nach Änderungen globaler Einstellungen die Plugins neu laden. Bereits laufende
Nodes übernehmen die Einstellungen auch beim nächsten Eingangstelegramm.
Zugangsdaten nur in den Plugin-Einstellungen eingeben, nicht in Logiksignalen.
OAuth-Tokens bleiben im Arbeitsspeicher des Backends. Das Plugin braucht keine
zusätzlichen npm-Pakete, Docker-Ports, eingehenden HTTP-Routen oder OAuth-Callbacks.
Es nutzt HTTPS mit Zertifikatsprüfung und Zeitlimit zum festen Host `api.danfoss.com`.

## Eingänge

| Handle        | Bedeutung                                                                                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temperature` | Solltemperatur in °C, 5–35 in Schritten von 0,5; zusätzliche vom Gerät gemeldete Unter-/Obergrenzen gelten ebenfalls. Bei Ally-Heizkörperthermostaten werden `mode=manual` und `manual_mode_fast` gemeinsam gesendet. Das beendet den automatischen Zeitplanbetrieb bis zum nächsten Moduswechsel. |
| `mode`        | Technischer Moduscode: `manual`, `at_home`, `leaving_home`, `pause`, `holiday`. Nur vom Gerät gemeldete Sollwertprofile werden zugelassen. `at_home`/`leaving_home` verwenden zusätzlich Danfoss' `last_click_time` mit der vom Gateway gemeldeten Zeitzone.                                       |
| `refresh`     | `true` oder `1` fragt alle Geräte des Kontos erneut ab.                                                                                                                                                                                                                                            |

Geräte mit ausschließlich `temp_set` (z. B. entsprechende Icon-RT-Modelle) erhalten
bei `temperature` nur diesen Sollwert, keinen Ally-spezifischen Moduswechsel.
Die Modussteuerung solcher Geräte ist nicht Bestandteil dieser Version.
Die Geräteauswahl erkennt Thermostate anhand ihrer Sollwert-Datenpunkte;
Gateways, Repeater und reine Temperatursensoren werden nicht angeboten.

Nur das tatsächlich eingetroffene Eingangstelegramm darf steuern. Beim Start,
Reload und nach Konfigurationsänderungen werden gecachte Befehle nicht wiederholt.
Erneute gleiche Telegramme senden erneut. Sollwert-Rückmeldungen nicht direkt
auf den eigenen Sollwert-Eingang zurückführen.

## Ausgänge

| Handle             | Bedeutung                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temperature`      | Gemeldete Isttemperatur: `temp_current` / 10, alternativ `local_temperature` / 100.                                                                         |
| `target`           | Zum gemeldeten Modus gehörender Sollwert; alternativ `temp_set`, jeweils / 10.                                                                              |
| `battery`          | Batteriestand in Prozent, sofern geliefert.                                                                                                                 |
| `demand`           | Gemeldeter Heizbedarf 0–100 %, sofern geliefert; kein steuerbarer Ventileingang.                                                                            |
| `mode`             | Unveränderter technischer Moduscode.                                                                                                                        |
| `connected`        | Boolean: letzte Statusabfrage bei der Cloud erfolgreich.                                                                                                    |
| `available`        | Boolean: Cloud-Status gültig und gewähltes Gerät darin online.                                                                                              |
| `busy`             | Boolean: diese Node verarbeitet gerade einen Befehl.                                                                                                        |
| `accepted`         | Boolean: vor jedem Steuerauftrag `false`, nach positiver API-Antwort `true`. Bestätigt nur die Annahme durch die Cloud, nicht den physischen Gerätezustand. |
| `status` / `error` | Übersetzbare Status-/Fehlerschlüssel; für Plugin-Diagnose und interne Textsignale.                                                                          |

Fehlende oder ungültige Messwerte sind `null`, niemals künstlich `0`.
Bei Cloud-Ausfall bleiben die letzten Messwerte erhalten; `available=false`
kennzeichnet sie als nicht aktuell bestätigt. Bei offline gemeldeten Geräten
können deren Cloud-Werte ebenfalls älter sein. Für Temperatur-Gruppenadressen
DPT **9.001**, für Heizbedarf/Batterie DPT **5.001** verwenden; `null` nicht als
gültigen Messwert behandeln und Weiterverarbeitung mit `available` freigeben.

## Verhalten bei Verzögerungen und Fehlern

- Alle Nodes desselben Kontos teilen OAuth-Token, Gerätecache und eine periodische
  Sammelabfrage. Gleichzeitige Geräteabfragen werden zusammengefasst.
- Anfragen werden serialisiert und mit mindestens 500 ms Abstand gestartet.
  Tokens werden vor Ablauf erneuert. Nur lesende Anfragen dürfen nach HTTP 401
  einmal mit neuem Token wiederholt werden.
- HTTP 429 pausiert Anfragen mindestens 60 Sekunden und berücksichtigt
  `Retry-After` (Sekunden oder HTTP-Datum). Die periodische Abfrage läuft danach
  weiter. Die Pause gilt auch für manuelle Abfragen und die Geräteauswahl.
- Steueraufträge werden bei Fehlern oder unklarem Ausgang nicht automatisch
  wiederholt. Bei offline gemeldeten Geräten, parallelem Befehl zum selben Gerät
  oder Überlastung werden sie verworfen. Wartende Aufträge verfallen nach 10 Sekunden.
- Nach angenommener Steuerung folgt nach 10 Sekunden eine gemeinsame Statusabfrage;
  weitere Rückmeldungen kommen über das normale Polling. Die Cloud kann weiterhin
  alte Werte liefern. Es werden keine optimistischen Sollwerte ausgegeben.
- Beim Entfernen der letzten Node werden deren Anfragen abgebrochen und Timer
  beendet. Eine gleichzeitig laufende Geräteauswahl darf ihre Anfrage beenden.
- Client-Secret, OAuth-Token und ungefilterte Anbieterfehler werden nicht geloggt.

Die internen Regler der Thermostate übernehmen die Temperaturregelung. Das Plugin
ersetzt keinen Kommunikations-Watchdog und keine Frostschutzfunktion der Anlage.
Externe Raumfühler, Zeitplanverwaltung und Zigbee2MQTT sind in dieser Version
nicht enthalten.

## PWA, Remote-Gateway und Laufzeit

Die Cloud-Verbindung läuft ausschließlich im Homeserver-Backend. Geräteauswahl,
Einstellungen und DE/EN-Metadaten verwenden die bestehenden authentifizierten
Plugin-API-Routen und funktionieren damit auch über den Remote-Gateway. Es sind
keine zusätzlichen Frontend-Dateien oder Gateway-Anpassungen erforderlich.
Voraussetzung ist eine kaenix-Version mit Plugin-Sprachkatalogen und `async-select`.
Die verwendeten Node-APIs sind unter Node 24 und der separaten ARM-Node-22-Laufzeit
verfügbar; ein ARM-Hardwaretest wurde nicht durchgeführt.

## Prüfung und Referenzen

Automatisierte Tests mit simulierten API-Antworten:

```sh
node --test backend/src/logic/DanfossAllyPlugin.test.js
node --test frontend/src/i18n/*.test.js
node --test backend/src/logic/PluginTranslations.test.js backend/src/logic/PluginPublication.test.js
node --test remote-gateway/src/plugins.test.js remote-gateway/src/httpProxy.test.js
```

Ein echter Konten-/Gerätetest steht aus. Dafür nach der Installation erst die
Geräteauswahl und Statuswerte prüfen, dann einen Sollwert senden und die verzögerte
Übernahme an Thermostat und Ally-App vergleichen. Anschließend den gewünschten
Zeitplanmodus wiederherstellen. Derselbe Ablauf ist über den Remote-Gateway zu prüfen.

- [Danfoss: Authentifizierung und Geräteabfrage](https://developer.danfoss.com/get-started)
- [Danfoss OpenAPI-Spezifikation, im API-Client-Projekt archiviert](https://github.com/MTrab/pydanfossally/blob/master/docs/openapi-spec)
- [Datenpunktcodes und Moduszuordnung des API-Clients](https://github.com/MTrab/pydanfossally/blob/master/pydanfossally/const.py)

Eigenständige JavaScript-Implementierung anhand der HTTP-Schnittstelle; keine
Python-Laufzeit oder Übernahme des Python-Clients erforderlich.
