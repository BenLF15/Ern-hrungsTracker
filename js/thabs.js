// Verknüpfung mit der Thabstracker-Kopie (Variante A: beide Apps unter derselben Adresse).
//
// Läuft der Ernährungstracker unter <thabs-kopie>/ernaehrung/, ist man dort mit demselben Login
// angemeldet. Nach jedem Speichern eines Tages wird im Tageseintrag des Thabstrackers gesetzt:
//   – kcal ≤ Obergrenze des Kalorienplans  → „Kalorien laut Plan eingehalten?“ = Ja
//   – kcal  > Obergrenze                   → Nein, und „Wie viel hast du gegessen?“ = gegessene kcal
// Übertragen werden nur diese beiden Felder; Gewicht, Schritte, Schlaf, Training und Notiz bleiben unberührt.
import { IN_CLAUDE } from "./platform.js";
import { dayEvents, getDay, dayKey } from "./store.js";

const KEY = "nw.v1.cache.thabs";
const events = new EventTarget();
export const thabsEvents = events;

let link = null;      // { user } wenn verbunden
let probing = null;
const timers = new Map();

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function store(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} }
const state = Object.assign({ status: {}, sent: {}, written: [], pending: [] }, load());
const persist = () => store(state);

async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await res.json().catch(() => ({})) : null;
  if (!res.ok || data === null) { const e = new Error(data?.error || `HTTP ${res.status}`); e.status = data === null ? 404 : res.status; throw e; }
  return data;
}

/** Prüft einmal pro Seitenaufruf, ob ein Thabstracker auf derselben Adresse läuft. */
export function detect() {
  if (IN_CLAUDE) return Promise.resolve(null);
  if (!probing) {
    probing = api("GET", "/api/me")
      .then(({ user }) => {
        link = { user, available: true };
        flushPending();
        if (user?.role === "client") schedule(dayKey(new Date())); // heutigen Stand abgleichen
        return link;
      })
      .catch((e) => {
        // 401 = Thabstracker vorhanden, aber nicht angemeldet; sonst gibt es keinen.
        link = e.status === 401 ? { user: null, available: true } : null;
        return link;
      })
      .finally(() => events.dispatchEvent(new Event("change")));
  }
  return probing;
}
export const linkInfo = () => link;
export const statusFor = (date) => state.status[date] || null;

function setStatus(date, s) {
  state.status[date] = { ...s, at: new Date().toISOString() };
  // nur die letzten 60 Tage behalten
  const keys = Object.keys(state.status).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete state.status[k];
  persist();
  events.dispatchEvent(new Event("change"));
}

function dayKcal(date) {
  const day = getDay(date);
  const kcal = day.entries.reduce((s, e) => s + ((e.per100?.kcal || 0) * e.grams) / 100, 0);
  return { kcal: Math.round(kcal), count: day.entries.length };
}

/** Überträgt den Stand eines Tages. */
export async function syncDay(date) {
  if (!link?.available) return;
  if (!link.user) { setStatus(date, { state: "loggedout" }); return; }
  if (link.user.role !== "client") { setStatus(date, { state: "coach" }); return; }
  const { kcal, count } = dayKcal(date);
  try {
    const { goals } = await api("GET", "/api/goals");
    const min = goals.caloriesMin, max = goals.caloriesMax;
    if (min === null || min === undefined) { setStatus(date, { state: "noplan", kcal }); return; }
    if (!count) {
      // Alle Einträge gelöscht: nur zurücksetzen, was die Verknüpfung selbst gesetzt hat
      if (state.written.includes(date)) {
        await api("PUT", `/api/entries/${date}`, { caloriesOk: null, calories: null });
        state.written = state.written.filter((d) => d !== date);
        delete state.sent[date];
      }
      setStatus(date, { state: "empty", min, max });
      return;
    }
    const ok = kcal <= max;
    const signature = `${kcal}|${min}|${max}`;
    if (state.sent[date] !== signature) {
      await api("PUT", `/api/entries/${date}`, { caloriesOk: ok, calories: ok ? null : kcal });
      state.sent[date] = signature;
      if (!state.written.includes(date)) state.written = [...state.written, date].slice(-120);
    }
    state.pending = state.pending.filter((d) => d !== date);
    setStatus(date, { state: ok ? "ok" : "over", kcal, min, max, over: Math.max(0, kcal - max), under: Math.max(0, min - kcal) });
  } catch (e) {
    if (e.status === 401) { link.user = null; setStatus(date, { state: "loggedout" }); return; }
    if (!state.pending.includes(date)) state.pending.push(date);
    setStatus(date, { state: "error", message: e.message });
  }
}

function schedule(date) {
  clearTimeout(timers.get(date));
  timers.set(date, setTimeout(() => { timers.delete(date); syncDay(date); }, 700));
}
function flushPending() {
  for (const d of state.pending.slice()) schedule(d);
}

export function initThabs() {
  if (IN_CLAUDE) return;
  dayEvents.addEventListener("change", (e) => { if (link?.available) schedule(e.detail); else detect().then(() => link?.available && schedule(e.detail)); });
  window.addEventListener("online", flushPending);
  detect();
}
