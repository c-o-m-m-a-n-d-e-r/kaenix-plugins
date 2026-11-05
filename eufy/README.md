# Eufy-Kameras für kaenix

Version **1.0.1**. Eigenständiges Kamera-Plugin für die P2P-Anbindung von
Eufy-Kameras. Es benötigt kein Logikdatenblatt, keinen zusätzlichen
`eufy-security-ws`-Container und kein Home Assistant. Die HomeBase-Zuordnung
bleibt erhalten; das Plugin aktiviert weder NAS/RTSP noch ändert es
Kamera-Aufnahme- oder Qualitäts-Einstellungen.

## Einrichtung

1. Homeserver mit Kamera-Provider-Schnittstelle und FFmpeg aktualisieren.
2. Plugin einschließlich seiner npm-Abhängigkeiten installieren. Im lokalen
   Checkout im Ordner `plugins/eufy` einmal `npm ci --ignore-scripts` ausführen.
   Im Plugin-Store erledigt die Installation diesen Schritt automatisch.
3. Unter **Plugins → Eufy** ein separates Eufy-Konto und dessen Kontoregion
   hinterlegen. Die Kamera/HomeBase vorher in der offiziellen App an dieses
   Konto freigeben und die Freigabe dort prüfen. Das Konto muss den Livestream
   öffnen dürfen. Das Hauptkonto bleibt für die Eufy-App erhalten.
4. **Bei Eufy anmelden** auswählen. Falls angefordert, den Bestätigungscode
   oder den angezeigten Bildcode eingeben und bestätigen.
5. **Kameras suchen**, gewünschte Geräte markieren und **Ausgewählte Kameras
   übernehmen** wählen. Danach stehen sie unter **Kameras** und für
   Kamera-Widgets zur Verfügung.

Kennwörter, Codes und Sitzungsdateien nicht in Git oder im Chat hinterlegen.
Das Passwort wird nicht über die Plugin-API zurückgegeben; Bestätigungscodes
werden nicht gespeichert. Sitzungsdaten liegen im privaten Laufzeitverzeichnis
unter `DATA_DIR/plugin-runtime/eufy`. **Abmelden** beendet die Medienverbindungen
und entfernt die gespeicherte Sitzung und das Passwort. Die HomeBase bleibt
verbunden.

## Medien

Das Plugin empfängt den P2P-Videostream direkt mit `eufy-security-client`, führt
H.264 ohne Transcoding durch FFmpeg und wandelt H.265 bei Bedarf in H.264 um.
MPEG-TS wird an das vorhandene go2rtc geliefert. Streamprozesse starten beim
Öffnen der Quelle und enden, wenn go2rtc sie freigibt. Starts ohne Videodaten,
Abbrüche und verspätete Stream-Ereignisse werden aufgeräumt.

Diese erste Version liefert **Video ohne Ton**. 4K, gleichzeitige Ausgabe beider
Objektive und eine bestimmte Auflösung sind nicht zugesichert. H.265-Transcoding
kann auf einer ARMv7-NAS die verfügbare CPU-Leistung übersteigen. Die tatsächliche
Streamqualität und Stabilität hängen von Modell und Firmware ab.

Die Bibliothek ist auf **3.8.0** festgelegt (Node >=20, damit auch mit dem
Node-22-ARMv7-Image kompatibel). Sie ist inzwischen abgekündigt. Diese Version
verwendet bewusst die Schnittstelle hinter dem zuvor untersuchten
`eufy-security-ws`; ein späterer Wechsel zum Nachfolger kann innerhalb des Plugins
erfolgen. Die S350/HomeBase-S380-Kombination ist noch nicht am echten Gerät
geprüft. Der lokale Test bestätigt den Medienweg mit synthetischen P2P-Daten,
nicht die Anmeldung oder Hardwarekompatibilität.

Die allgemeinen Plugin- und Kamera-Tests sowie die bestehenden Gateway-Tests
liegen im Homeserver-Repository. Weitere Details beschreibt dort
`docs/camera-plugins.md`.

Bibliothek und Lizenz: [bropat/eufy-security-client (MIT)](https://github.com/bropat/eufy-security-client).

## Anmeldefehler prüfen

Seit 1.0.1 wird die Bibliothek mit der veröffentlichten 2FA-Anmeldekorrektur
verwendet. Initialisierungsfehler, fehlende/veraltete Abhängigkeiten, Netzwerkfehler,
Anmeldebegrenzungen und zurückgewiesene Anmeldungen werden getrennt gemeldet.
Unter **Technische Verbindungsdetails** stehen ausschließlich Phase,
SDK-/Node-Version, bekannte Fehlerklasse und gegebenenfalls numerischer Eufy-Code,
HTTP-Status oder ein bekannter Netzwerkfehlercode. Dieselben sicheren Felder
erscheinen im Plugin-Log. Provider-Meldungen, URLs, Request-/Antwortdaten,
Kennwörter, Codes und Tokens werden nicht ausgegeben.

Bei einem Update von 1.0.0 muss auch `package-lock.json` übernommen und `npm ci
--ignore-scripts` im Plugin-Ordner ausgeführt werden; nur die JavaScript-Datei
zu ersetzen aktualisiert die Bibliothek nicht. Der neue Installer erledigt dies
beim vollständigen Plugin-Update. Für übersetzte Fehlermeldungen und die
Detailansicht ist das passende Frontend auf Homeserver und Gateway erforderlich.

Ein korrekter App-Login beweist noch keinen erfolgreichen Login am alten
Security-API-Endpunkt der Bibliothek. Eine Umstellung des Eufy-Kontos auf den
neuen v6-Anmeldeweg kann zusätzliche Anpassungen erfordern. Die Bibliotheksserie
4.x unterstützt diesen Übergang, benötigt aber Node >=24; sie wird deshalb nicht
ungeprüft auf dem Node-22-ARMv7-Homeserver installiert. Ein generischer Fehlertext
allein erlaubt keine sichere Zuordnung zu diesem Fall.

### Korrigierte Plugin-Veröffentlichung

Die ursprüngliche Veröffentlichung enthielt wegen der Repository-Ignore-Regeln
und des Pages-Workflows ausschließlich `eufy-kaenix.js`. Die Manifest- und
Lockdatei wurden nicht veröffentlicht. Ein vollständiges Plugin-Update muss nach
der Korrektur beide Dateien vom Plugin-Server herunterladen können; liefern sie
404, darf der Test noch nicht als funktionierende Eufy-Anmeldung bewertet werden.
Abhängigkeiten werden weiterhin mit `npm ci --ignore-scripts` installiert.
