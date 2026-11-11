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

// ------------------------------------------------------------------ Bedarfsrechner
// Grundumsatz nach Mifflin-St Jeor (1990). Gesamtumsatz = Grundumsatz × PAL.
// PAL-Werte nach DGE: Alltag/Beruf als Grundwert, Sport als Zuschlag. Die DGE nennt für
// 4–5 × 30–60 min intensive Aktivität pro Woche einen Zuschlag von bis zu +0,3; hier wird
// bewusst vorsichtig gerechnet, weil Aktivität erfahrungsgemäß überschätzt wird.
// Die meisten Menschen mit Bürotätigkeit liegen bei 1,4–1,5.

export const JOBS = [
  { pal: 1.4, label: "Überwiegend sitzend (Büro, Studium, Homeoffice)" },
  { pal: 1.5, label: "Sitzend mit etwas Bewegung (z. B. Wege zu Fuß, Haushalt)" },
  { pal: 1.6, label: "Teils sitzend, teils stehend/gehend (z. B. Lehrkraft, Labor)" },
  { pal: 1.8, label: "Überwiegend stehend/gehend (z. B. Verkauf, Pflege, Kellner)" },
  { pal: 2.0, label: "Körperlich schwere Arbeit (z. B. Bau, Landwirtschaft)" },
];
export const SPORT = [
  { add: 0, label: "Kein regelmäßiger Sport" },
  { add: 0.05, label: "1–2 × pro Woche (30–60 min)" },
  { add: 0.1, label: "3 × pro Woche (30–60 min)" },
  { add: 0.2, label: "4–5 × pro Woche (30–60 min)" },
  { add: 0.3, label: "Täglich intensiv / Leistungssport" },
];
// Ziel: absoluter Zuschlag, gedeckelt auf einen Anteil des Gesamtumsatzes
export const GOALS = [
  { id: "keep", label: "Gewicht halten", kcal: 0, pct: 0, proteinPerKg: 1.0 },
  { id: "lose_slow", label: "Langsam abnehmen (ca. −0,25 kg/Woche)", kcal: -250, pct: 0.15, proteinPerKg: 1.2 },
  { id: "lose", label: "Abnehmen (ca. −0,5 kg/Woche)", kcal: -500, pct: 0.25, proteinPerKg: 1.2 },
  { id: "gain_slow", label: "Langsam zunehmen (ca. +0,2 kg/Woche)", kcal: 200, pct: 0.10, proteinPerKg: 1.4 },
  { id: "gain", label: "Zunehmen (ca. +0,3 kg/Woche)", kcal: 350, pct: 0.12, proteinPerKg: 1.4 },
];
export const PAL_MAX = 2.2;

/** Grundumsatz nach Mifflin-St Jeor (kcal/Tag). */
export function bmrMifflin({ sex, age, weight, height }) {
  if (![age, weight, height].every((v) => isNum(v) && v > 0)) return null;
  return 10 * weight + 6.25 * height - 5 * age + (sex === "m" ? 5 : -161);
}

/**
 * Vollständiger Zielvorschlag. profile: {sex, age, weight, height, job, sport, goal}.
 * Gibt null bei unvollständigen Angaben zurück.
 */
export function calcGoals(profile) {
  const bmr = bmrMifflin(profile);
  if (bmr == null || bmr <= 0) return null;
  const job = isNum(+profile.job) && +profile.job > 0 ? +profile.job : 1.4;
  const sport = isNum(+profile.sport) && +profile.sport >= 0 ? +profile.sport : 0;
  const pal = Math.min(PAL_MAX, Math.round((job + sport) * 100) / 100);
  const tdee = bmr * pal;
  const goal = GOALS.find((g) => g.id === profile.goal) || GOALS[0];
  const cap = tdee * goal.pct;
  let delta = Math.sign(goal.kcal) * Math.min(Math.abs(goal.kcal), cap);
  let target = tdee + delta;
  const notes = [];
  // Beim Abnehmen nicht unter den Grundumsatz bzw. eine Mindestzufuhr
  const floor = Math.max(bmr, profile.sex === "m" ? 1500 : 1200);
  if (delta < 0 && target < floor) { target = floor; delta = target - tdee; notes.push("Nicht unter Grundumsatz/Mindestzufuhr gesenkt."); }
  target = Math.round(target / 10) * 10;

  // Eiweiß: g/kg je nach Ziel (DGE-Referenz 0,8 g/kg); bei BMI > 25 auf Gewicht bei BMI 25 bezogen
  const h = profile.height / 100;
  const refWeight = Math.min(profile.weight, 25 * h * h);
  const protein = Math.round(refWeight * goal.proteinPerKg);
  const fat = Math.round((target * 0.30) / 9); // 30 % der Energie (DGE-Richtwert)
  const carb = Math.max(0, Math.round((target - protein * 4 - fat * 9) / 4));
  // Getränke: DGE ca. 1,5 l/Tag, bei viel Bewegung mehr
  const water = 1500 + Math.round(Math.max(0, pal - 1.5) / 0.2) * 250;
  return { bmr, pal, tdee, delta, target, protein, fat, carb, water, fibre: 30, goal, notes };
}

/** Kompatibilität: Grundumsatz und Gesamtumsatz bei gegebenem PAL. */
export function estimateNeeds({ sex, age, weight, height, pal }) {
  const bmr = bmrMifflin({ sex, age, weight, height });
  if (bmr == null || !(pal > 0)) return null;
  return { bmr, tdee: bmr * pal };
}
