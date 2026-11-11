// Lokale Datenhaltung (localStorage). Alles bleibt auf dem Gerät.
const P = "nw.v1.";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(P + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(P + key, JSON.stringify(value)); return true; }
  catch (e) { console.error("Speichern fehlgeschlagen", e); return false; }
}

export const MEALS = [
  { id: "breakfast", label: "Frühstück" },
  { id: "lunch", label: "Mittagessen" },
  { id: "dinner", label: "Abendessen" },
  { id: "snacks", label: "Snacks" },
];

export const DEFAULT_SETTINGS = {
  goals: { kcal: 2000, protein: 75, carb: 250, fat: 67, fibre: 30, water: 2000 },
  profile: { sex: "f", age: 30, weight: 65, height: 168, pal: 1.6 },
  ai: { apiKey: "", model: "claude-opus-5-5", verify: "all" },
  theme: "auto",
};

export const GLASS_ML = 250;

export function getSettings() {
  const s = read("settings", {});
  return {
    ...DEFAULT_SETTINGS, ...s,
    goals: { ...DEFAULT_SETTINGS.goals, ...(s.goals || {}) },
    profile: { ...DEFAULT_SETTINGS.profile, ...(s.profile || {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) },
  };
}
export function saveSettings(s) { write("settings", s); }

// ---- Tage ----
export function dayKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export function parseDayKey(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }

export function getDay(key) {
  const d = read("day." + key, null);
  return d ? { entries: d.entries || [], water: d.water || 0 } : { entries: [], water: 0 };
}
export function saveDay(key, day) {
  if (!day.entries.length && !day.water) { try { localStorage.removeItem(P + "day." + key); } catch {} return; }
  write("day." + key, day);
}
export function addEntry(key, entry) {
  const day = getDay(key);
  entry.id = entry.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  entry.time = entry.time || new Date().toISOString();
  day.entries.push(entry);
  saveDay(key, day);
  pushRecent(entry);
  return entry;
}
export function updateEntry(key, id, patch) {
  const day = getDay(key);
  const e = day.entries.find((x) => x.id === id);
  if (e) Object.assign(e, patch);
  saveDay(key, day);
}
export function removeEntry(key, id) {
  const day = getDay(key);
  day.entries = day.entries.filter((x) => x.id !== id);
  saveDay(key, day);
}
export function changeWater(key, deltaMl) {
  const day = getDay(key);
  day.water = Math.max(0, (day.water || 0) + deltaMl);
  saveDay(key, day);
  return day.water;
}
export function allDayKeys() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(P + "day.")) out.push(k.slice((P + "day.").length));
    }
  } catch {}
  return out.sort();
}

// ---- Zuletzt verwendet & Favoriten ----
// Gespeichert wird ein vollständiger "Food"-Snapshot, damit auch Produkte offline verfügbar bleiben.
export function foodSnapshot(entry) {
  const { name, brand, per100, unit, source, portions } = entry;
  return { name, brand, per100, unit, source, portions };
}
function foodId(f) { return f.source?.type + ":" + (f.source?.ref || f.name); }
function pushRecent(entry) {
  const f = foodSnapshot(entry);
  const id = foodId(f);
  const list = read("recent", []).filter((x) => foodId(x) !== id);
  list.unshift({ ...f, lastGrams: entry.grams });
  write("recent", list.slice(0, 40));
}
export function getRecent() { return read("recent", []); }
export function getFavs() { return read("favs", []); }
export function isFav(f) { const id = foodId(f); return getFavs().some((x) => foodId(x) === id); }
export function toggleFav(f) {
  const id = foodId(f);
  let list = getFavs();
  const has = list.some((x) => foodId(x) === id);
  list = has ? list.filter((x) => foodId(x) !== id) : [{ name: f.name, brand: f.brand, per100: f.per100, unit: f.unit, source: f.source, portions: f.portions }, ...list];
  write("favs", list);
  return !has;
}

// ---- Eigene Lebensmittel ----
export function getCustomFoods() { return read("custom", []); }
export function saveCustomFood(f) {
  const list = getCustomFoods();
  f.source = f.source || {};
  f.source.type = "custom";
  f.source.ref = f.source.ref || "c" + Date.now().toString(36);
  const i = list.findIndex((x) => x.source.ref === f.source.ref);
  if (i >= 0) list[i] = f; else list.unshift(f);
  write("custom", list);
  return f;
}
export function deleteCustomFood(ref) { write("custom", getCustomFoods().filter((x) => x.source.ref !== ref)); }

// ---- Caches (Produkte nach Barcode, KI-Prüfungen) ----
export function cacheGet(ns, key) { return read("cache." + ns, {})[key]; }
export function cacheSet(ns, key, value) {
  const c = read("cache." + ns, {});
  c[key] = value;
  const keys = Object.keys(c);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete c[k];
  write("cache." + ns, c);
}

// ---- Export / Import ----
export function exportAll() {
  const data = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(P)) data[k.slice(P.length)] = JSON.parse(localStorage.getItem(k));
    }
  } catch {}
  if (data.settings?.ai) data.settings.ai = { ...data.settings.ai, apiKey: "" }; // Schlüssel nie exportieren
  return { app: "naehrwert", version: 1, exported: new Date().toISOString(), data };
}
export function importAll(obj) {
  if (!obj || obj.app !== "naehrwert" || typeof obj.data !== "object") throw new Error("Keine gültige NährWert-Sicherung.");
  const keep = getSettings().ai.apiKey;
  for (const [k, v] of Object.entries(obj.data)) write(k, v);
  const s = getSettings();
  if (!s.ai.apiKey && keep) { s.ai.apiKey = keep; saveSettings(s); }
}
export function wipeAll() {
  try {
    const ks = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(P)) ks.push(k); }
    ks.forEach((k) => localStorage.removeItem(k));
  } catch {}
}
