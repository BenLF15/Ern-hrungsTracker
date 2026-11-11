# Thabstracker – Testkopie mit Kalorien-Verknüpfung

Eine **getrennte Kopie** von [thabstracker.onrender.com](https://thabstracker.onrender.com), damit die
Verknüpfung mit dem Ernährungstracker ausprobiert werden kann, ohne am echten Thabstracker etwas zu ändern.

| Pfad | Inhalt |
|---|---|
| `public/` | Oberfläche des Originals, **unverändert** heruntergeladen (HTML, JS, CSS, Bilder) |
| `server/` | Nachgebauter Server (Node, ohne Abhängigkeiten) – der Original-Server ist nicht öffentlich und wurde anhand der API-Aufrufe der Oberfläche rekonstruiert |
| `extra/kopie-extra.js` | Einziger Zusatz in der Oberfläche: Hinweis „Testkopie“ und Menüpunkt „Kalorientracker“ für Klienten (wird beim Ausliefern angehängt, `public/` bleibt unverändert) |

## Verknüpfung (Variante A)

Der Server liefert beide Apps unter **einer Adresse** aus: Thabstracker-Kopie unter `/`, Ernährungstracker
unter `/ernaehrung/`. Dadurch ist man im Ernährungstracker mit demselben Login angemeldet.

Nach jedem Speichern im Ernährungstracker (Eintrag hinzufügen, ändern, löschen) wird für diesen Tag im
Tageseintrag des Thabstrackers gesetzt:

* gegessene kcal **≤ Obergrenze** des Kalorienplans → *„Kalorien laut Plan eingehalten?“* = **Ja**
* gegessene kcal **> Obergrenze** → **Nein**, und *„Wie viel hast du gegessen?“* = gegessene kcal
  (der Ernährungstracker zeigt zusätzlich, um wie viel der Plan überschritten ist)

Nur diese beiden Felder werden übertragen; Gewicht, Schritte, Schlaf, Training und Notiz bleiben unverändert.
Werden alle Einträge eines Tages gelöscht, wird das automatisch gesetzte Häkchen wieder entfernt.
Ohne Kalorienplan des Coaches wird nichts angekreuzt. Fehlgeschlagene Übertragungen werden wiederholt.

## Starten

```sh
npm run dev:thabs        # baut den Ernährungstracker und startet http://localhost:3000
```

Beim ersten Start wird der Coach-Zugang angelegt: Benutzername `coach` (oder `COACH_USERNAME`), Passwort
aus `COACH_PASSWORD` – ohne diese Variable wird ein zufälliges Passwort erzeugt und im Log ausgegeben.
Klienten legt der Coach in der App an.

| Variable | Bedeutung |
|---|---|
| `PORT` | Port (Render setzt ihn automatisch) |
| `COACH_USERNAME`, `COACH_NAME`, `COACH_PASSWORD` | Erster Coach-Zugang |
| `DATA_DIR` | Speicherort der Daten (Standard `thabs/data/`) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional: feste Schlüssel für Push-Nachrichten (sonst automatisch erzeugt und gespeichert) |

## Auf Render

`render.yaml` enthält den Dienst **thabs-kopie** (Web Service, Node): Build `npm run build`,
Start `npm run start:thabs`. Das Coach-Passwort erzeugt Render (Dashboard → Environment → `COACH_PASSWORD`).

**Wichtig:** Im kostenlosen Plan hat Render keine dauerhafte Festplatte – die Daten der Kopie gehen bei
jedem Neustart oder Deploy verloren (kostenlose Dienste schlafen außerdem nach 15 Minuten ohne Aufruf ein).
Zum Testen reicht das; für dauerhafte Daten eine Persistent Disk (kostenpflichtig) einrichten, siehe
Kommentar in `render.yaml`.

## Was nachgebaut wurde – und was nicht 1:1 sein kann

Nachgebaut sind alle Funktionen, die die Oberfläche nutzt: Login/Passwort, Coach- und Klienten-Rollen,
Tageseinträge, Plan & Ziele mit Verlauf, wöchentlicher Check-in mit Vergleich und Plan-Vorschlägen,
Chat, Ernährungsplan mit Tauschwünschen, Lebensmittel-Datenbank (Startliste mit 60 Lebensmitteln,
kcal aus dem BLS 4.0), Push-Nachrichten (einmalig/täglich/wöchentlich, Web Push mit VAPID),
automatische Erinnerung, Admin-Übersicht, CSV-Export und der Apple-Health-Import per Kurzbefehl.

Weil der Original-Server nicht einsehbar ist, können Details abweichen (z. B. genaue Fehlermeldungen,
Berechnung der Wochenstatistik, Inhalt der Lebensmittel-Datenbank). Daten und Zugänge des Originals
sind **nicht** enthalten – die Kopie startet leer.
