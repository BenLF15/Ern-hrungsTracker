// Nährwert-Berechnungen und regelbasierte Plausibilitätsprüfung.
// Alle Werte sind auf 100 g (bzw. 100 ml) bezogen, Energie in kcal und kJ.

/** Nährstoffe, die in der App geführt werden (Reihenfolge = Anzeige). */
export const NUTRIENTS = [
  { key: "kcal", label: "Energie", unit: "kcal", dec: 0 },
  { key: "fat", label: "Fett", unit: "g", dec: 1 },
  { key: "sat", label: "davon gesättigte Fettsäuren", unit: "g", dec: 1, indent: true },
  { key: "carb", label: "Kohlenhydrate", unit: "g", dec: 1 },
  { key: "sugar", label: "davon Zucker", unit: "g", dec: 1, indent: true },
  { key: "polyols", label: "davon mehrwertige Alkohole", unit: "g", dec: 1, indent: true, optional: true },
  { key: "fibre", label: "Ballaststoffe", unit: "g", dec: 1 },
  { key: "protein", label: "Eiweiß", unit: "g", dec: 1 },
  { key: "salt", label: "Salz", unit: "g", dec: 2 },
  { key: "alcohol", label: "Alkohol", unit: "g", dec: 1, optional: true },
];
export const KEYS = ["kcal", "kj", "fat", "sat", "carb", "sugar", "polyols", "fibre", "protein", "salt", "alcohol", "acids"];

/** Energiefaktoren nach Verordnung (EU) Nr. 1169/2011, Anhang XIV. */
export const LMIV = {
  carb: { kcal: 4, kj: 17 },
  polyols: { kcal: 2.4, kj: 10 },
  protein: { kcal: 4, kj: 17 },
  fat: { kcal: 9, kj: 37 },
  alcohol: { kcal: 7, kj: 29 },
  acids: { kcal: 3, kj: 13 },
  fibre: { kcal: 2, kj: 8 },
};

const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Energie aus Makronährstoffen nach LMIV (Kohlenhydrate inkl. Polyole, diese mit eigenem Faktor). */
export function energyFromMacros(p) {
  const carbWoPol = Math.max(0, n(p.carb) - n(p.polyols));
  const parts = [
    [carbWoPol, LMIV.carb], [n(p.polyols), LMIV.polyols], [n(p.protein), LMIV.protein],
    [n(p.fat), LMIV.fat], [n(p.alcohol), LMIV.alcohol], [n(p.acids), LMIV.acids], [n(p.fibre), LMIV.fibre],
  ];
  return {
    kcal: parts.reduce((s, [g, f]) => s + g * f.kcal, 0),
    kj: parts.reduce((s, [g, f]) => s + g * f.kj, 0),
  };
}

/** Nährwerte für eine Menge (g bzw. ml) aus den 100-g-Werten. Unbekannte Werte bleiben null. */
export function scale(per100, amount) {
  const out = {};
  for (const k of KEYS) out[k] = isNum(per100[k]) ? (per100[k] * amount) / 100 : null;
  return out;
}

/** Summe mehrerer Nährwert-Objekte (null zählt als 0, wird aber vermerkt). */
export function sum(list) {
  const out = {};
  for (const k of KEYS) out[k] = 0;
  for (const v of list) for (const k of KEYS) out[k] += n(v[k]);
  return out;
}

export function fmt(v, dec = 1) {
  if (!isNum(v)) return "–";
  const f = v.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: dec });
  return f === "-0" ? "0" : f;
}
export function fmtKcal(v) { return isNum(v) ? Math.round(v).toLocaleString("de-DE") : "–"; }

/**
 * Regelbasierte Prüfung von Nährwerten je 100 g.
 * Gibt {level: "ok"|"warn"|"bad", issues: [{level, text}], computed} zurück.
 * `declared` = true, wenn kcal deklariert (z. B. Etikett) statt berechnet wurde.
 */
export function validate(p, { declared = false, unit = "g" } = {}) {
  const issues = [];
  const add = (level, text) => issues.push({ level, text });
  const comp = energyFromMacros(p);

  for (const k of ["fat", "sat", "carb", "sugar", "fibre", "protein", "salt", "alcohol", "polyols"]) {
    if (isNum(p[k]) && p[k] < 0) add("bad", `Negativer Wert bei ${label(k)}.`);
    if (isNum(p[k]) && p[k] > 100.5) add("bad", `${label(k)} über 100 g je 100 ${unit} ist unmöglich.`);
  }
  for (const k of ["fat", "carb", "protein"]) {
    if (!isNum(p[k])) add("warn", `${label(k)} fehlt – Energie und Makros sind unvollständig.`);
  }
  const mass = n(p.fat) + n(p.carb) + n(p.protein) + n(p.fibre) + n(p.salt) + n(p.alcohol);
  if (mass > 102) add("bad", `Summe aus Fett, Kohlenhydraten, Eiweiß, Ballaststoffen, Salz und Alkohol beträgt ${fmt(mass)} g je 100 ${unit} (max. 100 g).`);
  if (isNum(p.sugar) && isNum(p.carb) && p.sugar > p.carb + 0.5) add("bad", `Zucker (${fmt(p.sugar)} g) ist größer als Kohlenhydrate (${fmt(p.carb)} g).`);
  if (isNum(p.sat) && isNum(p.fat) && p.sat > p.fat + 0.5) add("bad", `Gesättigte Fettsäuren (${fmt(p.sat)} g) sind größer als Fett (${fmt(p.fat)} g).`);
  if (isNum(p.polyols) && isNum(p.carb) && p.polyols > p.carb + 0.5) add("warn", "Mehrwertige Alkohole sind größer als die Kohlenhydrate.");
  if (isNum(p.kcal) && p.kcal > 902) add("bad", `${fmtKcal(p.kcal)} kcal je 100 ${unit} – reines Fett hat max. ca. 900 kcal.`);

  if (declared && isNum(p.kcal)) {
    const diff = p.kcal - comp.kcal;
    const tol = Math.max(15, 0.15 * Math.max(p.kcal, comp.kcal));
    if (Math.abs(diff) > tol) {
      const lvl = Math.abs(diff) > Math.max(40, 0.3 * Math.max(p.kcal, comp.kcal)) ? "bad" : "warn";
      add(lvl, `Angegebene Energie (${fmtKcal(p.kcal)} kcal) weicht von der aus den Makros berechneten (${fmtKcal(comp.kcal)} kcal nach LMIV) um ${fmtKcal(Math.abs(diff))} kcal ab.`);
    }
    if (isNum(p.kj) && p.kcal > 5) {
      const r = p.kj / p.kcal;
      if (r < 3.9 || r > 4.35) add("warn", `Verhältnis kJ/kcal = ${fmt(r, 2)} (erwartet ≈ 4,18). kJ- oder kcal-Angabe vermutlich falsch.`);
    }
  }
  const level = issues.some((i) => i.level === "bad") ? "bad" : issues.length ? "warn" : "ok";
  return { level, issues, computed: comp };
}

const LABELS = { fat: "Fett", sat: "Gesättigte Fettsäuren", carb: "Kohlenhydrate", sugar: "Zucker", fibre: "Ballaststoffe", protein: "Eiweiß", salt: "Salz", alcohol: "Alkohol", polyols: "Mehrwertige Alkohole", kcal: "Energie" };
export function label(k) { return LABELS[k] || k; }

/** Grundumsatz nach Mifflin-St Jeor (1990), Gesamtumsatz = Grundumsatz x PAL. */
export function estimateNeeds({ sex, age, weight, height, pal }) {
  if (![age, weight, height, pal].every((v) => isNum(v) && v > 0)) return null;
  const bmr = 10 * weight + 6.25 * height - 5 * age + (sex === "m" ? 5 : -161);
  return { bmr, tdee: bmr * pal };
}
