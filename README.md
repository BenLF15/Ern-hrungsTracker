# NährWert – Ernährungs- & Kalorientracker

Websitebasierter Tracker für Mahlzeiten, Kalorien, Makronährstoffe und Wasser. Läuft komplett im
Browser (auch offline als installierbare Web-App), alle Einträge bleiben lokal auf dem Gerät.

## Funktionen

| Bereich | Was es kann |
|---|---|
| **Manuelle Eingabe** | Suche in **7.152 Lebensmitteln** mit amtlichen Nährwerten (offline). Toleriert Umlaute (`huehnerei`), Plural (`kartoffeln`), Zusammenschreibung (`haferflocken` → „Hafer Flocken“) und Alltagsbegriffe (`nudeln` → Teigwaren, `nutella` → Nuss-Nougat-Creme). Mengen in g/ml oder typische Portionen (Ei Gr. M, Scheibe Brot, EL Öl …). Favoriten und „Zuletzt verwendet“. |
| **Barcode-Scan** | Live über die Kamera (natives `BarcodeDetector`, sonst ZXing), aus einem Foto oder per Ziffern-Eingabe. EAN/UPC-Prüfziffer wird kontrolliert, ein Code muss zweimal gleich gelesen werden. Produktdaten aus Open Food Facts. |
| **Foto hochladen / Foto schießen** | Die KI (Claude) erkennt jede Komponente einer Mahlzeit, schätzt die Menge in Gramm (mit Spanne und Sicherheit) und ordnet sie dem passenden **amtlichen Datenbankeintrag** zu (inkl. Zubereitung roh/gekocht). Die Nährwerte kommen immer aus der Datenbank, nie aus einer KI-Schätzung. Fotos von Nährwerttabellen werden abgelesen (Portion → 100 g wird umgerechnet), ein sichtbarer Barcode wird erkannt. Alles wird vor dem Speichern zur Prüfung angezeigt. |
| **Eigene Lebensmittel / Schnelleintrag** | Werte je 100 g/ml eintragen, mit Live-Regelprüfung. |
| **Wasser** | `+` / `−` je ein Glas à 250 ml, Tagesziel, Gläser-Anzeige. |
| **Prüfung der Nährwerte** | 1. **Regelprüfung** (immer, ohne KI): Makros ≤ 100 g, Zucker ≤ Kohlenhydrate, gesättigte ≤ Gesamtfett, deklarierte Energie vs. berechnete Energie nach LMIV, kJ/kcal-Verhältnis. 2. **KI-Prüfung**: Claude vergleicht die Werte mit Referenzwerten amtlicher Tabellen (BLS, USDA, CoFID) und bewertet sie als plausibel / auffällig / unplausibel – automatisch für alle Lebensmittel (Standard), nur für nicht-amtliche Daten oder auf Knopfdruck. Ergebnisse werden gespeichert. 3. **Tagesprüfung**: KI sucht im Tagebuch nach Eingabefehlern. |
| **Verlauf** | Energie und Wasser der letzten 7/30 Tage mit Ziellinie, Durchschnittswerte, Tabelle. |
| **Ziele** | Frei einstellbar oder per Bedarfsrechner (Mifflin-St Jeor × PAL). |
| **Daten** | Export/Import als JSON (API-Schlüssel wird nie exportiert). |

## Datenbasis

* **Bundeslebensmittelschlüssel (BLS) 4.0**, Max Rubner-Institut (2025), CC BY 4.0,
  DOI [10.25826/Data20251217-134202-0](https://doi.org/10.25826/Data20251217-134202-0) – 7.108 Einträge.
* Ergänzungen, wo der BLS keine Angabe hat (z. B. getrocknete Gewürze/Kräuter, Basmatireis, Tempeh):
  USDA FoodData Central (CC0), McCance & Widdowson's CoFID 2021 (OGL v3), Livsmedelsverket (CC BY 4.0).
  Jede Zeile nennt ihre Quelle und die Original-ID.
* Bezogen über das npm-Paket [`@thereforejs/foods`](https://www.npmjs.com/package/@thereforejs/foods) 0.0.3
  (Extrakt des BLS 4.0; nicht vom Max Rubner-Institut veröffentlicht). Werte unter der
  Nachweis-/Bestimmungsgrenze sind als „–“ gekennzeichnet, nicht als 0.
* **Energie** wird exakt nach **Verordnung (EU) Nr. 1169/2011 (LMIV), Anhang XIV** berechnet
  (KH ohne Polyole 4 kcal, Polyole 2,4, Eiweiß 4, Fett 9, Alkohol 7, org. Säuren 3, Ballaststoffe 2 kcal/g;
  kJ mit eigenen Faktoren). **Salz** = Natrium × 2,5.
* **Markenprodukte**: [Open Food Facts](https://world.openfoodfacts.org) (ODbL) – Herstellerangaben vom
  Etikett, deshalb als „Etikett“ statt „Amtlich“ gekennzeichnet und automatisch geprüft.

Die Datenbank neu erzeugen:

```sh
npm pack @thereforejs/foods@0.0.3 && tar xzf thereforejs-foods-0.0.3.tgz
python3 -I tools/build_db.py package/dist/index.mjs data/foods.json
```

Das Skript liest die Paketdatei nur als Text/JSON (führt keinen Fremdcode aus) und rechnet mit `Decimal`.

## KI (Claude API)

Für Fotoerkennung und KI-Prüfung wird ein eigener API-Schlüssel von
[platform.claude.com](https://platform.claude.com) benötigt (Einstellungen → KI). Der Schlüssel liegt nur
im `localStorage` des Browsers; Anfragen gehen direkt an `api.anthropic.com`. Standardmodell ist
Claude Opus 5.5 (wählbar: Sonnet 5.5, Haiku 5.5). Antworten sind per Structured Outputs an ein
JSON-Schema gebunden; bei Opus/Sonnet ist der serverseitige Refusal-Fallback aktiv.
Ohne Schlüssel funktionieren Suche, Barcode, eigene Eingaben und Regelprüfung vollständig.

Hinweis: Wer die Seite öffentlich hostet, sollte wissen, dass jeder Nutzer seinen eigenen Schlüssel
einträgt – im Code ist kein Schlüssel enthalten.

## Starten

Statische Web-App. Kamera und Service Worker brauchen HTTPS oder `localhost`.
Für Build und Server werden nur Node-Bordmittel benötigt (Node ≥ 18, kein `npm install`).

| Befehl | Zweck |
|---|---|
| `npm run dev` | Repository direkt lokal ausliefern: http://localhost:8000 |
| `npm run check` | Prüft Dateien, Datenbank und Modul-Importe |
| `npm run build` | Baut die auslieferbare App nach `dist/` (Service-Worker-Version = Inhalts-Hash) |
| `npm start` | Liefert `dist/` aus (Port aus `PORT`, Standard 8000) |
| `npm run build:chat` | Einzeldatei-Version für den Claude-Chat (benötigt `npm install`) |
| `npm run build:vendor` | Bibliotheken in `vendor/` neu bündeln (benötigt `npm install`) |

### Auf Render veröffentlichen

**Variante A – Static Site (empfohlen, kostenlos):**
Dashboard → **New → Blueprint** → dieses Repository wählen. `render.yaml` richtet alles ein.
Oder manuell **New → Static Site** mit:

* Branch: der Branch mit dem Code
* Build Command: `npm run build`
* Publish Directory: `dist`

**Variante B – Web Service (Node):**
**New → Web Service**, Runtime *Node*, Build Command `npm run build`, Start Command `npm start`.

Render stellt HTTPS bereit – damit funktionieren Kamera, Barcode-Scan und die Installation als App
(„Zum Startbildschirm hinzufügen“). Nach jedem Push baut Render neu; installierte Apps laden die neue
Version beim nächsten Öffnen.

## Thabstracker-Testkopie mit Kalorien-Verknüpfung

Im Ordner [`thabs/`](thabs/README.md) liegt eine getrennte Kopie des Thabstrackers mit nachgebautem Server.
Beide Apps laufen dort unter einer Adresse (Kopie unter `/`, Ernährungstracker unter `/ernaehrung/`);
nach jedem Speichern im Ernährungstracker wird im Check-in automatisch „Kalorien laut Plan eingehalten?“
angekreuzt (Ja/Nein, bei Nein mit den gegessenen kcal). Lokal: `npm run dev:thabs`; auf Render: Dienst
`thabs-kopie` aus `render.yaml`.

## Version im Claude-Chat

`tools/build-artifact.mjs` baut eine einzelne HTML-Datei (Code, Styles und Datenbank eingebettet), die als
Artifact im Claude-Chat läuft. Dort gilt:

* **KI über das Claude-Konto** (kein API-Schlüssel nötig), inkl. Fotoanalyse; beim ersten Einsatz fragt Claude um Erlaubnis.
* **Einträge dauerhaft und privat** im Speicher des Artifacts (nur für die angemeldete Person sichtbar).
* **Gesperrt** sind dort Live-Kamera und externe Server: Barcode-Produktabfrage (Open Food Facts) funktioniert
  nur in der Web-App. Ersatz: Foto hochladen bzw. Kamera-App, Nährwerttabelle fotografieren.

```sh
npm install && npm run build:chat   # -> dist-chat/naehrwert-chat.html
```

## Aufbau

```
index.html, css/app.css      Oberfläche (mobil zuerst, hell/dunkel)
js/app.js                    Ansichten: Heute, Verlauf, Lebensmittel, Einstellungen
js/add.js                    Hinzufügen: Suche, Barcode, Foto-KI, Eigenes, Detailansicht
js/db.js                     Laden & Durchsuchen der Datenbank
js/nutrition.js              Berechnung (LMIV), Regelprüfung, Bedarfsrechner
js/ai.js                     Claude: Fotoanalyse, DB-Zuordnung, Nährwert- und Tagesprüfung
js/off.js                    Open Food Facts (Barcode, Online-Suche, GTIN-Prüfziffer)
js/camera.js                 Kamera, Barcode-Scanner, Bildverkleinerung
js/portions.js               Typische Portionsgrößen (Richtwerte)
js/store.js                  Speicherung (localStorage bzw. Artifact-Speicher), Export/Import
js/platform.js               Erkennung Web-App vs. Claude-Chat
js/thabs.js                  Verknüpfung mit der Thabstracker-Kopie (gleiche Adresse)
data/foods.json              Generierte Lebensmitteldatenbank
vendor/                      Gebündelt: Anthropic TypeScript SDK (MIT), ZXing (Apache 2.0)
tools/build_db.py            Erzeugt data/foods.json
tools/build-artifact.mjs     Erzeugt die Einzeldatei-Version für den Chat
tools/build.mjs              Build nach dist/ (npm run build)
tools/serve.mjs              Statischer Server (npm start / npm run dev)
tools/build-vendor.mjs       Bündelt vendor/ neu
package.json, render.yaml    Build-Skripte und Render-Konfiguration
thabs/                       Thabstracker-Testkopie (Oberfläche + nachgebauter Server)
```

## Lizenzen

Code: siehe Repository. Daten: BLS 4.0 © Max Rubner-Institut, CC BY 4.0 (mit den im Paket
`@thereforejs/foods` dokumentierten Änderungen: nur die 13 Nährstoffe der Nährwertdeklaration, Natrium in g,
fehlende Werte als `null`); weitere Quellen wie oben. Open-Food-Facts-Daten: ODbL.
Die Angaben ersetzen keine Ernährungs- oder medizinische Beratung.
