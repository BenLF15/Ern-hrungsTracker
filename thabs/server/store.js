// Datenhaltung der Thabs-Kopie: eine JSON-Datei, atomar geschrieben (temp + rename).
// Speicherort: Umgebungsvariable DATA_DIR (Standard: thabs/data/).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = resolve(process.env.DATA_DIR || join(here, "..", "data"));
const FILE = join(DATA_DIR, "thabs.json");

function empty() {
  return {
    version: 1,
    seq: {},
    users: [],
    sessions: {},
    entries: {}, // userId -> { date -> entry }
    goals: {}, // userId -> goals
    goalHistory: [], // { userId, changedAt, caloriesMin, caloriesMax, targetWeight, stepsGoal, sleepGoal }
    checkins: [],
    messages: [],
    foods: [],
    meals: [],
    items: [],
    requests: [],
    pushSubs: [], // { userId, endpoint, keys, createdAt }
    notifications: [],
    reminder: {
      enabled: false, days: 2, time: "19:00",
      title: "Kurz eintragen? ✍️",
      body: "Hey {name}, seit {tage} Tagen fehlt dein Eintrag. Trag kurz Gewicht, Schritte und Schlaf ein 💪",
      repeatDaily: false, lastRunAt: null, lastResult: null, lastRunDate: null,
    },
    vapid: null,
  };
}

export const db = (() => {
  if (!existsSync(FILE)) return empty();
  try {
    return { ...empty(), ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch (e) {
    console.error("Datenbank konnte nicht gelesen werden – starte leer:", e.message);
    return empty();
  }
})();

export function nextId(kind) {
  db.seq[kind] = (db.seq[kind] || 0) + 1;
  return db.seq[kind];
}

let timer = null;
/** Speichert verzögert (bündelt viele Änderungen). */
export function save() {
  if (timer) return;
  timer = setTimeout(flush, 200);
}
export function flush() {
  clearTimeout(timer);
  timer = null;
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(db));
  renameSync(tmp, FILE);
}
process.on("SIGTERM", () => { try { flush(); } catch {} process.exit(0); });
process.on("SIGINT", () => { try { flush(); } catch {} process.exit(0); });
