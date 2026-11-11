#!/usr/bin/env python3
"""Baut data/foods.json aus dem BLS-4.0-Extrakt des npm-Pakets @thereforejs/foods.

Quelle der Werte
----------------
Das Paket enthält ein Extrakt des Bundeslebensmittelschlüssels (BLS) 4.0 des
Max Rubner-Instituts (CC BY 4.0) sowie einzelne Ergänzungen aus CoFID 2021
(Public Health England, OGL v3), USDA FoodData Central (CC0) und der
Livsmedelsdatabasen (Livsmedelsverket, CC BY 4.0). Jede Zeile nennt ihre Quelle.

Die JavaScript-Datei wird hier NICHT ausgeführt, sondern als Text gelesen:
jedes Lebensmittel steht dort als ``const CODE = { ...JSON... };``.

Berechnungen (exakt mit Decimal, erst am Ende gerundet)
-------------------------------------------------------
* Energie nach Verordnung (EU) Nr. 1169/2011 (LMIV), Anhang XIV:
  Kohlenhydrate ohne mehrwertige Alkohole 17 kJ / 4 kcal je g,
  mehrwertige Alkohole 10 kJ / 2,4 kcal, Eiweiß 17 kJ / 4 kcal,
  Fett 37 kJ / 9 kcal, Alkohol (Ethanol) 29 kJ / 7 kcal,
  organische Säuren 13 kJ / 3 kcal, Ballaststoffe 8 kJ / 2 kcal.
  kJ und kcal werden jeweils mit ihren eigenen Faktoren berechnet.
* Salz = Natrium x 2,5 (LMIV, Anhang I Nr. 11).

Aufruf
------
    npm pack @thereforejs/foods@0.0.3 && tar xzf thereforejs-foods-0.0.3.tgz
    python3 -I tools/build_db.py package/dist/index.mjs data/foods.json
"""
import json
import re
import sys
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

SOURCES = {
    "bls-4.0": {
        "name": "Bundeslebensmittelschlüssel (BLS), Version 4.0",
        "short": "BLS 4.0",
        "publisher": "Max Rubner-Institut",
        "license": "CC BY 4.0",
        "url": "https://www.blsdb.de",
        "citation": "Max Rubner-Institut (2025): Bundeslebensmittelschlüssel (BLS), Version 4.0 - "
                    "Deutsche Nährstoffdatenbank. Karlsruhe. DOI: 10.25826/Data20251217-134202-0",
    },
    "cofid-2021": {
        "name": "McCance and Widdowson's Composition of Foods Integrated Dataset (CoFID) 2021",
        "short": "CoFID 2021",
        "publisher": "Public Health England",
        "license": "OGL UK 3.0",
        "url": "https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid",
        "citation": "Public Health England (2021): McCance and Widdowson's The Composition of Foods "
                    "Integrated Dataset 2021. Contains public sector information licensed under the "
                    "Open Government Licence v3.0.",
    },
    "usda-sr-legacy": {
        "name": "USDA FoodData Central, SR Legacy (2018)",
        "short": "USDA SR Legacy",
        "publisher": "U.S. Department of Agriculture, Agricultural Research Service",
        "license": "CC0 1.0",
        "url": "https://fdc.nal.usda.gov",
        "citation": "U.S. Department of Agriculture, Agricultural Research Service (2019): "
                    "FoodData Central, SR Legacy. fdc.nal.usda.gov.",
    },
    "usda-fndds-2024": {
        "name": "USDA FoodData Central, Survey Foods (FNDDS), release 2024-10-31",
        "short": "USDA FNDDS",
        "publisher": "U.S. Department of Agriculture, Agricultural Research Service",
        "license": "CC0 1.0",
        "url": "https://fdc.nal.usda.gov",
        "citation": "U.S. Department of Agriculture, Agricultural Research Service (2024): "
                    "FoodData Central, Survey Foods (FNDDS). fdc.nal.usda.gov.",
    },
    "usda-branded-2026-10": {
        "name": "USDA FoodData Central, Branded Foods, release 2026-10-29",
        "short": "USDA Branded",
        "publisher": "U.S. Department of Agriculture, Agricultural Research Service",
        "license": "CC0 1.0",
        "url": "https://fdc.nal.usda.gov",
        "citation": "U.S. Department of Agriculture, Agricultural Research Service (2026): "
                    "FoodData Central, Branded Foods. fdc.nal.usda.gov.",
    },
    "livsmedelsverket-2026": {
        "name": "Livsmedelsdatabasen (Swedish Food Composition Database), version 2026-07",
        "short": "Livsmedelsverket",
        "publisher": "Livsmedelsverket (Swedish Food Agency)",
        "license": "CC BY 4.0",
        "url": "https://dataportal.livsmedelsverket.se/livsmedel/swagger/index.html",
        "citation": "Livsmedelsverket (2026): Livsmedelsdatabasen, version 2026-07.",
    },
}

# Hauptgruppen des BLS (erster Buchstabe des Codes)
GROUPS = {
    "B": "Brot & Kleingebäck",
    "C": "Getreide & Getreideprodukte",
    "D": "Backwaren, Kuchen & Snacks",
    "E": "Eier & Teigwaren",
    "F": "Obst & Obstprodukte",
    "G": "Gemüse & Kräuter",
    "H": "Hülsenfrüchte, Nüsse & Samen",
    "K": "Kartoffeln & Pilze",
    "M": "Milch & Milchprodukte",
    "N": "Alkoholfreie Getränke",
    "P": "Alkoholische Getränke",
    "Q": "Fette & Öle",
    "R": "Gewürze, Saucen & Zutaten",
    "S": "Süßwaren, Zucker & Eis",
    "T": "Fisch & Meeresfrüchte",
    "U": "Fleisch",
    "V": "Geflügel, Wild & Innereien",
    "W": "Wurst & Fleischwaren",
    "X": "Gerichte & Speisen",
    "Y": "Gerichte & Speisen",
}

# Reihenfolge der Nährwerte in jeder Zeile (Gramm je 100 g, Energie in kcal/kJ)
FIELDS = ["code", "de", "en", "kcal", "kj", "fat", "sat", "carb", "sugar",
          "polyols", "fibre", "protein", "salt", "alcohol", "acids", "src"]

FACTORS = [  # (Schlüssel, kJ, kcal) nach LMIV Anhang XIV
    ("carb_wo_polyols", Decimal(17), Decimal(4)),
    ("polyols", Decimal(10), Decimal("2.4")),
    ("protein", Decimal(17), Decimal(4)),
    ("fat", Decimal(37), Decimal(9)),
    ("alcohol", Decimal(29), Decimal(7)),
    ("organicAcids", Decimal(13), Decimal(3)),
    ("fibre", Decimal(8), Decimal(2)),
]


def dec(v):
    return None if v is None else Decimal(v)


def rnd(v, places):
    if v is None:
        return None
    q = Decimal(1).scaleb(-places)
    r = v.quantize(q, rounding=ROUND_HALF_UP)
    # kürzeste Schreibweise als Zahl
    f = float(r)
    return int(f) if f == int(f) else f


def energy(p):
    carb = dec(p.get("carbohydrate"))
    pol = dec(p.get("polyols")) or Decimal(0)
    vals = {
        "carb_wo_polyols": None if carb is None else carb - pol,
        "polyols": pol,
        "protein": dec(p.get("protein")),
        "fat": dec(p.get("fat")),
        "alcohol": dec(p.get("alcohol")),
        "organicAcids": dec(p.get("organicAcids")),
        "fibre": dec(p.get("fibre")),
    }
    kj = sum((vals[k] or Decimal(0)) * fkj for k, fkj, _ in FACTORS)
    kcal = sum((vals[k] or Decimal(0)) * fkc for k, _, fkc in FACTORS)
    return kcal, kj


def main(src_path, out_path):
    text = open(src_path, encoding="utf-8").read()
    pat = re.compile(r"^const ([A-Z][A-Z0-9_]*) = (\{.*?\n\});\n", re.S | re.M)
    foods = [json.loads(m.group(2)) for m in pat.finditer(text)]
    if len(foods) != text.count("\nconst "):
        raise SystemExit("Nicht alle Lebensmittel konnten gelesen werden")

    src_keys = list(SOURCES)
    rows, marks, incomplete = [], {}, []
    for f in foods:
        p = f["per100g"]
        kcal, kj = energy(p)
        sodium = dec(p.get("sodium"))
        salt = None if sodium is None else sodium * Decimal("2.5")
        srcs = []
        for s in f["sources"]:
            if s["source"] not in SOURCES:
                raise SystemExit("Unbekannte Quelle " + s["source"])
            srcs.append([src_keys.index(s["source"]), s["id"]])
        row = [
            f["code"], f["name"]["de"].strip(), f["name"]["en"].strip(),
            rnd(kcal, 1), rnd(kj, 0),
            rnd(dec(p.get("fat")), 2), rnd(dec(p.get("saturates")), 2),
            rnd(dec(p.get("carbohydrate")), 2), rnd(dec(p.get("sugars")), 2),
            rnd(dec(p.get("polyols")), 2), rnd(dec(p.get("fibre")), 2),
            rnd(dec(p.get("protein")), 2), rnd(salt, 3),
            rnd(dec(p.get("alcohol")), 2), rnd(dec(p.get("organicAcids")), 2),
            srcs,
        ]
        rows.append(row)
        if f.get("marks"):
            marks[f["code"]] = f["marks"]
        # Energie unvollständig, wenn ein Hauptnährstoff fehlt (ohne Messgrenzen-Markierung)
        missing = [k for k in ("fat", "carbohydrate", "protein")
                   if p.get(k) is None and k not in f.get("marks", {})]
        if missing:
            incomplete.append(f["code"])

    rows.sort(key=lambda r: r[0])
    out = {
        "version": "bls-4.0+thereforejs-foods-0.0.3",
        "generated": date.today().isoformat(),
        "energyMethod": "Verordnung (EU) Nr. 1169/2011, Anhang XIV",
        "saltMethod": "Natrium x 2,5 (Verordnung (EU) Nr. 1169/2011, Anhang I)",
        "fields": FIELDS,
        "sources": SOURCES,
        "sourceKeys": src_keys,
        "groups": GROUPS,
        "marks": marks,
        "incompleteEnergy": incomplete,
        "foods": rows,
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(rows)} Lebensmittel geschrieben, {len(marks)} mit Messgrenzen-Markierung, "
          f"{len(incomplete)} mit unvollständiger Energie")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
