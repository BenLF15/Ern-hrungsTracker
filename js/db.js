// Offizielle Lebensmitteldatenbank (BLS 4.0 + Ergänzungen) laden und durchsuchen.
import { getCustomFoods } from "./store.js";
import { portionsFor } from "./portions.js";

let DB = null;
let loading = null;
let index = null; // [{row, tokens:[...], compact, group}]

export async function loadDB() {
  if (DB) return DB;
  if (!loading) {
    loading = fetch("data/foods.json").then((r) => {
      if (!r.ok) throw new Error("Datenbank konnte nicht geladen werden (" + r.status + ")");
      return r.json();
    }).then((d) => {
      DB = d;
      DB.byCode = new Map(d.foods.map((r) => [r[0], r]));
      DB.incomplete = new Set(d.incompleteEnergy);
      buildIndex();
      return DB;
    });
  }
  return loading;
}
export function db() { return DB; }

export function fold(s) {
  return s.toLowerCase()
    .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
    .replace(/[éèê]/g, "e").replace(/[áàâ]/g, "a").replace(/[íì]/g, "i").replace(/[óò]/g, "o").replace(/ç/g, "c").replace(/ñ/g, "n");
}
const tokenize = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
const compactOf = (s) => fold(s).replace(/[^a-z0-9]/g, "");

function buildIndex() {
  index = DB.foods.map((r) => {
    const name = r[1];
    return { row: r, tokens: tokenize(name + " " + r[2]), deTokens: tokenize(name), compact: compactOf(name), group: r[0][0], len: name.length };
  });
}

/** Zeile -> einheitliches Food-Objekt */
export function foodFromRow(r) {
  const [code, de, en, kcal, kj, fat, sat, carb, sugar, polyols, fibre, protein, salt, alcohol, acids, src] = r;
  const sources = src.map(([i, id]) => ({ key: DB.sourceKeys[i], id, ...DB.sources[DB.sourceKeys[i]] }));
  const f = {
    name: de, en, group: code[0], groupLabel: DB.groups[code[0]],
    per100: { kcal, kj, fat, sat, carb, sugar, polyols, fibre, protein, salt, alcohol, acids },
    unit: "g",
    source: {
      type: "bls", ref: code, official: true,
      label: sources.map((s) => s.short).join(" + "),
      sources,
    },
    marks: DB.marks[code] || null,
    incompleteEnergy: DB.incomplete.has(code),
  };
  f.portions = portionsFor(f);
  return f;
}
export function foodByCode(code) { const r = DB?.byCode.get(code); return r ? foodFromRow(r) : null; }

// Synonyme & Alltagsbegriffe -> Begriffe der BLS-Benennung
const SYN = {
  ei: ["huhnerei"], eier: ["huhnerei"], spiegelei: ["huhnerei gebraten"], ruhrei: ["ruhrei"],
  nudeln: ["teigwaren", "nudel"], nudel: ["teigwaren", "nudel"], pasta: ["teigwaren"], spaghetti: ["teigwaren", "spaghetti"],
  penne: ["teigwaren"], makkaroni: ["teigwaren"], fusilli: ["teigwaren"],
  milch: ["milch"], kuhmilch: ["vollmilch", "milch"], quark: ["quark"], magerquark: ["magerquark"],
  hahnchen: ["hahnchen", "huhn"], huhnchen: ["hahnchen", "huhn"], chicken: ["hahnchen"], pute: ["pute", "truthahn"], truthahn: ["pute", "truthahn"],
  hack: ["hackfleisch"], hackfleisch: ["hackfleisch"], rindfleisch: ["rind"], schweinefleisch: ["schwein"],
  cola: ["cola"], nutella: ["nussnougatcreme"], brokkoli: ["broccoli"], broccoli: ["broccoli"],
  mohre: ["mohre", "karotte"], mohren: ["mohre", "karotte"], karotten: ["karotte"], rueblie: ["karotte"],
  kartoffeln: ["kartoffel"], pommes: ["pommes"], fritten: ["pommes"],
  semmel: ["brotchen"], schrippe: ["brotchen"], weckle: ["brotchen"], toast: ["toast"],
  haferflocken: ["haferflocken"], porridge: ["haferflockenbrei", "haferbrei"], musli: ["musli", "muesli"], muesli: ["musli", "muesli"],
  joghurt: ["joghurt"], jogurt: ["joghurt"], yoghurt: ["joghurt"], erdnussbutter: ["erdnussmus"],
  wasser: ["wasser", "mineralwasser"], sprudel: ["mineralwasser"], orangensaft: ["orangensaft", "orange saft"], osaft: ["orangensaft"],
  apfelschorle: ["apfelsaftschorle", "schorle"], schorle: ["schorle"], bier: ["bier"], wein: ["wein"],
  paprika: ["paprika"], gurke: ["gurke"], tomaten: ["tomate"], zwiebeln: ["zwiebel"],
  thunfisch: ["thunfisch"], lachs: ["lachs"], shrimps: ["garnele"], garnelen: ["garnele"], krabben: ["garnele", "krabbe"],
  schinken: ["schinken"], salami: ["salami"], wurst: ["wurst"], kase: ["kase"],
  reis: ["reis"], vollkornreis: ["reis unpoliert"], linsen: ["linse"], bohnen: ["bohne"], kichererbsen: ["kichererbse"],
  olivenol: ["olivenol"], rapsol: ["rapsol"], butter: ["butter"], margarine: ["margarine"],
  zucker: ["zucker"], honig: ["honig"], schokolade: ["schokolade"], schoki: ["schokolade"], chips: ["chips", "kartoffelchips"],
  avocado: ["avocado"], banane: ["banane"], bananen: ["banane"], apfel: ["apfel"], apfeln: ["apfel"], erdbeeren: ["erdbeere"],
  heidelbeeren: ["heidelbeere"], blaubeeren: ["heidelbeere"], himbeeren: ["himbeere"], trauben: ["weintraube"], weintrauben: ["weintraube"],
  kaffee: ["kaffee"], cappuccino: ["cappuccino", "kaffee"], latte: ["milchkaffee", "latte"], tee: ["tee"],
  tofu: ["tofu"], seitan: ["seitan"], tempeh: ["tempeh"], hafermilch: ["haferdrink"], sojamilch: ["sojadrink"], mandelmilch: ["mandeldrink"],
  pizza: ["pizza"], burger: ["hamburger", "burger"], doner: ["doner", "gyros"], kebab: ["doner", "kebab"],
};

function variants(tok) {
  const v = new Set([tok]);
  if (SYN[tok]) SYN[tok].forEach((s) => v.add(compactOf(s)));
  // einfache Pluralformen
  if (tok.length > 4) {
    for (const suf of ["en", "n", "e", "s"]) if (tok.endsWith(suf)) v.add(tok.slice(0, -suf.length));
  }
  // ae/oe/ue -> Umlaut-Faltung
  if (/ae|oe|ue/.test(tok)) v.add(tok.replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u"));
  return [...v].filter((x) => x.length >= 1);
}

const BASIC_GROUPS = new Set(["B", "C", "E", "F", "G", "H", "K", "M", "N", "Q", "T", "U", "V"]);
const PREP_WORDS = ["roh", "frisch"];

function scoreEntry(e, qtoks) {
  let score = 0;
  for (let qi = 0; qi < qtoks.length; qi++) {
    const vars = qtoks[qi];
    let best = 0;
    for (const v of vars) {
      for (let ti = 0; ti < e.tokens.length; ti++) {
        const t = e.tokens[ti];
        const de = ti < e.deTokens.length;
        if (t === v) best = Math.max(best, de ? (ti === 0 ? 120 : 70) : 25);
        else if (t.startsWith(v)) best = Math.max(best, de ? (ti === 0 ? 90 : 50) : 15);
      }
      // Zusammengesetzte Wörter: BLS schreibt oft getrennt ("Hafer Flocken" ≙ "Haferflocken")
      if (v.length >= 3 && e.compact.includes(v)) {
        let c = 30;
        if (e.compact === v) c = 135;
        else if (e.compact.startsWith(v)) {
          // endet der Treffer genau an einer Wortgrenze des Namens?
          let acc = "", boundary = false;
          for (const t of e.deTokens) { acc += t; if (acc === v) { boundary = true; break; } if (acc.length >= v.length) break; }
          c = boundary ? 125 : 60;
        }
        best = Math.max(best, c);
      }
    }
    if (!best) return 0; // jedes Suchwort muss passen
    score += best;
  }
  if (BASIC_GROUPS.has(e.group)) score += 18;
  if (e.deTokens.some((t) => PREP_WORDS.includes(t))) score += 6;
  score -= Math.min(40, e.len * 0.35); // kurze, allgemeine Namen zuerst
  return score;
}

/** Durchsucht offizielle DB + eigene Lebensmittel. Liefert Food-Objekte. */
export function search(query, { limit = 60, group = null } = {}) {
  if (!index) return [];
  const qtoks = tokenize(query).map(variants);
  if (!qtoks.length) return [];
  const out = [];
  for (const f of getCustomFoods()) {
    const e = { tokens: tokenize(f.name + " " + (f.brand || "")), deTokens: tokenize(f.name), compact: compactOf(f.name), group: "*", len: f.name.length };
    const s = scoreEntry(e, qtoks);
    if (s > 0) out.push({ s: s + 40, food: f });
  }
  for (const e of index) {
    if (group && e.group !== group && !(group === "X" && e.group === "Y")) continue;
    const s = scoreEntry(e, qtoks);
    if (s > 0) out.push({ s, row: e.row });
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, limit).map((x) => x.food || foodFromRow(x.row));
}

/** Kandidaten für die KI-Zuordnung (mehrere Suchbegriffe kombiniert, eindeutig). */
export function candidates(terms, limit = 14) {
  const seen = new Set();
  const out = [];
  for (const t of terms) {
    for (const f of search(t, { limit: 10 })) {
      const id = f.source.type + ":" + f.source.ref;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(f);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function groupList() {
  if (!DB) return [];
  const seen = new Map();
  for (const [k, v] of Object.entries(DB.groups)) if (!seen.has(v)) seen.set(v, k);
  return [...seen].map(([label, key]) => ({ key, label }));
}
