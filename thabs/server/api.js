// API der Thabs-Kopie. Nachgebaut anhand der Aufrufe der Original-Oberfläche (public/app.js):
// gleiche Pfade, Methoden, Request- und Antwortformen, Fehler als { error: "…" }.
import crypto from "node:crypto";
import { db, nextId, save } from "./store.js";
import { TZ, todayBerlin, addDays, daysBetween, isDate, berlinParts, berlinToUtc, weekStart, isoWeekday } from "./time.js";
import { generateVapid, vapidFromEnv, sendPush } from "./webpush.js";

// ------------------------------------------------------------------ Grundlagen
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

const SESSION_DAYS = 30;
const nowIso = () => new Date().toISOString();

export function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
function checkPassword(user, pw) {
  const { hash } = hashPassword(pw, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}
const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role });

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((p) => p.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function sessionCookie(req, token, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : "";
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function currentUser(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!sid) return null;
  const s = db.sessions[sid];
  if (!s || s.expires < Date.now()) { if (s) { delete db.sessions[sid]; save(); } return null; }
  return db.users.find((u) => u.id === s.userId) || null;
}

function num(v, { min = -Infinity, max = Infinity, int = false, label = "Wert" } = {}) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
  if (!Number.isFinite(n)) throw bad(`${label}: bitte eine Zahl angeben.`);
  if (n < min || n > max) throw bad(`${label} muss zwischen ${min} und ${max} liegen.`);
  return int ? Math.round(n) : Math.round(n * 100) / 100;
}
const bool = (v) => (v === true || v === false ? v : v === null ? null : undefined);
const text = (v, max) => String(v ?? "").trim().slice(0, max);

const clients = () => db.users.filter((u) => u.role === "client");
function clientFor(me, userId) {
  const id = Number(userId);
  const c = db.users.find((u) => u.id === id && u.role === "client");
  if (!c || (me.role === "coach" && c.coachId !== me.id)) throw new HttpError(404, "Klient nicht gefunden");
  return c;
}
/** Klient: sich selbst. Coach: den per ?userId gewählten Klienten. */
function target(me, query) {
  if (me.role === "client") return me;
  if (!query.get("userId")) throw bad("userId fehlt");
  return clientFor(me, query.get("userId"));
}
const coachOf = (client) => db.users.find((u) => u.id === client.coachId) || db.users.find((u) => u.role === "coach");

// ------------------------------------------------------------------ Push
let vapid = null;
export function initPush() {
  vapid = vapidFromEnv() || db.vapid;
  if (!vapid) { vapid = db.vapid = generateVapid(); save(); }
}
const pushSubject = () => process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || "mailto:noreply@thabs-kopie.invalid";
const devicesOf = (userId) => db.pushSubs.filter((s) => s.userId === userId);

/** Sendet an alle Geräte einer Person. true, wenn mindestens eines angekommen ist. */
export async function pushTo(userId, data) {
  const subs = devicesOf(userId);
  if (!subs.length || !vapid) return false;
  let ok = false;
  for (const s of subs) {
    const r = await sendPush(s, data, vapid, pushSubject());
    if (r.ok) ok = true;
    if (r.gone) db.pushSubs = db.pushSubs.filter((x) => x.endpoint !== s.endpoint);
  }
  save();
  return ok;
}
const pushLater = (userId, data) => { pushTo(userId, data).catch(() => {}); };
const pushAllowed = (u) => u.pushStatus === "granted" && devicesOf(u.id).length > 0;

// ------------------------------------------------------------------ Einträge & Ziele
const ENTRY_KEYS = ["weight", "steps", "sleep", "note", "training", "caloriesOk", "calories"];
const entriesOf = (userId) => (db.entries[userId] ||= {});
function entryOut(e) {
  return { date: e.date, weight: e.weight ?? null, steps: e.steps ?? null, sleep: e.sleep ?? null, note: e.note || "", training: e.training ?? null, caloriesOk: e.caloriesOk ?? null, calories: e.calories ?? null };
}
const sortedEntries = (userId) => Object.values(entriesOf(userId)).sort((a, b) => a.date.localeCompare(b.date)).map(entryOut);
const isEmptyEntry = (e) => e.weight == null && e.steps == null && e.sleep == null && !e.note && e.training == null && e.caloriesOk == null && e.calories == null;

/** Teil-Aktualisierung: nur übergebene Felder ändern, Rest bleibt erhalten. */
function upsertEntry(userId, date, body) {
  if (!isDate(date)) throw bad("Ungültiges Datum.");
  if (date > addDays(todayBerlin(), 1)) throw bad("Einträge in der Zukunft sind nicht möglich.");
  const all = entriesOf(userId);
  const e = { ...(all[date] || { date }) };
  if ("weight" in body) e.weight = num(body.weight, { min: 20, max: 400, label: "Gewicht" });
  if ("steps" in body) e.steps = num(body.steps, { min: 0, max: 200000, int: true, label: "Schritte" });
  if ("sleep" in body) e.sleep = num(body.sleep, { min: 0, max: 24, label: "Schlaf" });
  if ("note" in body) e.note = text(body.note, 500);
  if ("training" in body) { const b = bool(body.training); if (b === undefined) throw bad("Training: ja oder nein."); e.training = b; }
  if ("caloriesOk" in body) { const b = bool(body.caloriesOk); if (b === undefined) throw bad("Kalorien: ja oder nein."); e.caloriesOk = b; }
  if ("calories" in body) e.calories = num(body.calories, { min: 0, max: 20000, int: true, label: "Kalorien" });
  if (e.caloriesOk !== false) e.calories = null; // "gegessen" nur bei "nicht eingehalten"
  e.updatedAt = nowIso();
  if (isEmptyEntry(e)) { delete all[date]; save(); return null; }
  all[date] = e;
  save();
  return entryOut(e);
}

const GOAL_KEYS = ["targetWeight", "stepsGoal", "sleepGoal", "caloriesMin", "caloriesMax"];
function goalsOf(userId) {
  const g = db.goals[userId] || {};
  return Object.fromEntries(GOAL_KEYS.map((k) => [k, g[k] ?? null]));
}
function historyOf(userId) {
  return db.goalHistory.filter((h) => h.userId === userId).sort((a, b) => a.changedAt.localeCompare(b.changedAt))
    .map(({ userId: _, ...h }) => h);
}
function setGoals(userId, patch) {
  const g = { ...goalsOf(userId), ...patch };
  if (g.caloriesMin == null && g.caloriesMax != null) g.caloriesMin = g.caloriesMax;
  if (g.caloriesMax == null && g.caloriesMin != null) g.caloriesMax = g.caloriesMin;
  if (g.caloriesMin != null && g.caloriesMin > g.caloriesMax) throw bad("Kalorien: „von“ muss kleiner als „bis“ sein.");
  db.goals[userId] = g;
  db.goalHistory.push({ userId, changedAt: nowIso(), ...g });
  save();
  return g;
}
function readGoalBody(body) {
  return {
    targetWeight: num(body.targetWeight, { min: 20, max: 400, label: "Zielgewicht" }),
    stepsGoal: num(body.stepsGoal, { min: 0, max: 100000, int: true, label: "Schritte" }),
    sleepGoal: num(body.sleepGoal, { min: 0, max: 24, label: "Schlaf" }),
    caloriesMin: num(body.caloriesMin, { min: 0, max: 20000, int: true, label: "Kalorien" }),
    caloriesMax: num(body.caloriesMax, { min: 0, max: 20000, int: true, label: "Kalorien" }),
  };
}

// ------------------------------------------------------------------ Formatierung (wie in der Oberfläche)
const de = (v, d = 0) => Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
function fmtSleep(h) {
  if (h == null) return "–";
  const t = Math.round(h * 60);
  return `${Math.floor(t / 60)} h ${String(t % 60).padStart(2, "0")} min`;
}
const fmtKcal = (min, max) => (min == null ? "–" : min === max ? `${de(min)} kcal` : `${de(min)}–${de(max)} kcal`);
const PLAN_LABELS = { calories: "Kalorien pro Tag", stepsGoal: "Schritte pro Tag", sleepGoal: "Schlaf pro Nacht", targetWeight: "Zielgewicht" };
function fmtPlan(key, v) {
  if (v == null) return "–";
  if (key === "stepsGoal") return `${de(v)} Schritte`;
  if (key === "sleepGoal") return fmtSleep(v);
  return `${de(v, 1)} kg`;
}

// ------------------------------------------------------------------ Check-ins
function checkinOut(c) {
  const before = c.before || {};
  const changeItems = c.changes.map((k) =>
    k === "calories"
      ? { label: PLAN_LABELS.calories, before: fmtKcal(before.caloriesMin, before.caloriesMax), after: fmtKcal(c.proposal.caloriesMin, c.proposal.caloriesMax) }
      : { label: PLAN_LABELS[k], before: fmtPlan(k, before[k]), after: fmtPlan(k, c.proposal[k]) });
  return { id: c.id, createdAt: c.createdAt, message: c.message, changes: c.changes, changeItems, proposal: c.proposal, status: c.status, acceptedAt: c.acceptedAt || null, repliedAt: c.repliedAt || null, seenAt: c.seenAt || null };
}
const checkinsOf = (userId) => db.checkins.filter((c) => c.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

function weekStats(userId, from, to, goals) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(entriesOf(userId)[d] ? entryOut(entriesOf(userId)[d]) : { date: d, weight: null, steps: null, sleep: null, note: "", training: null, caloriesOk: null, calories: null });
  const vals = (k) => days.map((d) => d[k]).filter((v) => v !== null && v !== undefined);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const w = vals("weight"), st = vals("steps"), sl = vals("sleep");
  const kcalAnswered = days.filter((d) => d.caloriesOk !== null).length;
  const reported = days.filter((d) => d.caloriesOk === false && d.calories !== null).map((d) => d.calories);
  return {
    stats: {
      from, to,
      weightAvg: avg(w), weightMin: w.length ? Math.min(...w) : null, weightMax: w.length ? Math.max(...w) : null, weighIns: w.length,
      stepsAvg: avg(st), stepsGoalDays: goals.stepsGoal ? st.filter((s) => s >= goals.stepsGoal).length : null,
      sleepAvg: avg(sl), sleepGoalDays: goals.sleepGoal ? sl.filter((s) => s >= goals.sleepGoal).length : null,
      trainingDays: days.filter((d) => d.training === true).length,
      caloriesAnswered: kcalAnswered, caloriesOkDays: days.filter((d) => d.caloriesOk === true).length,
      caloriesReportedAvg: reported.length ? Math.round(avg(reported)) : null,
      daysLogged: days.filter((d) => !isEmptyEntry(d)).length,
    },
    days,
  };
}
const diff = (a, b) => (a === null || b === null || a === undefined || b === undefined ? null : Math.round((b - a) * 100) / 100);

// ------------------------------------------------------------------ Nachrichten
const threadOf = (clientId) => db.messages.filter((m) => m.clientId === clientId);
function addMessage(clientId, sender, body) {
  const m = { id: nextId("message"), clientId, senderId: sender.id, fromRole: sender.role, body: text(body, 2000), createdAt: nowIso(), readAt: null };
  if (!m.body) throw bad("Bitte eine Nachricht schreiben.");
  db.messages.push(m);
  save();
  const client = db.users.find((u) => u.id === clientId);
  if (sender.role === "client") pushLater(coachOf(client)?.id, { title: `💬 ${client.displayName}`, body: m.body.slice(0, 140), url: `/#/client/${clientId}/chat` });
  else pushLater(clientId, { title: "💬 Nachricht von deinem Coach", body: m.body.slice(0, 140), url: "/#/chat" });
  return m;
}
const unreadFor = (me, clientId) => threadOf(clientId).filter((m) => m.senderId !== me.id && !m.readAt).length;

// ------------------------------------------------------------------ Lebensmittel & Ernährungsplan
const foodOut = (f) => ({ id: f.id, name: f.name, kcal: f.kcal, unit: f.unit, category: f.category || "", custom: !!f.custom });
function readFood(body) {
  const name = text(body.name, 80);
  if (!name) throw bad("Bitte einen Namen angeben.");
  const kcal = num(body.kcal, { min: 0, max: 900, label: "kcal pro 100" });
  if (kcal === null) throw bad("Bitte kcal pro 100 g angeben.");
  return { name, kcal, unit: body.unit === "ml" ? "ml" : "g", category: text(body.category, 40) };
}
const kcalOf = (amount, kcal) => Math.round((amount * kcal) / 100);
const sameKcalAmount = (kcal, per100) => (per100 > 0 ? Math.max(5, Math.round(((kcal / per100) * 100) / 5) * 5) : 100);

function planOf(userId) {
  const meals = db.meals.filter((m) => m.userId === userId).sort((a, b) => a.pos - b.pos).map((m) => {
    const items = db.items.filter((i) => i.mealId === m.id).sort((a, b) => a.id - b.id)
      .map((i) => ({ id: i.id, foodId: i.foodId, name: i.name, amount: i.amount, unit: i.unit, kcal: i.kcal, kcalTotal: kcalOf(i.amount, i.kcal) }));
    return { id: m.id, name: m.name, items, kcalTotal: items.reduce((s, i) => s + i.kcalTotal, 0) };
  });
  const requests = db.requests.filter((r) => r.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => {
    const f = r.wantedFoodId ? db.foods.find((x) => x.id === r.wantedFoodId) : null;
    return { id: r.id, type: r.type, itemId: r.itemId || null, mealId: r.mealId || null, wantedFood: f ? foodOut(f) : r.wantedFoodSnapshot || null, wish: r.wish || "", status: r.status, coachNote: r.coachNote || "", subject: r.subject, createdAt: r.createdAt, resolvedAt: r.resolvedAt || null };
  });
  return { meals, totalKcal: meals.reduce((s, m) => s + m.kcalTotal, 0), requests };
}
function mealFor(me, id) {
  const m = db.meals.find((x) => x.id === Number(id));
  if (!m) throw new HttpError(404, "Mahlzeit nicht gefunden");
  clientFor(me, m.userId);
  return m;
}
function itemFor(me, id) {
  const i = db.items.find((x) => x.id === Number(id));
  if (!i) throw new HttpError(404, "Lebensmittel nicht gefunden");
  return { item: i, meal: mealFor(me, i.mealId) };
}
function foodById(id) {
  const f = db.foods.find((x) => x.id === Number(id));
  if (!f) throw bad("Lebensmittel nicht gefunden.");
  return f;
}

// ------------------------------------------------------------------ Push-Nachrichten (Coach)
const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
function nextRun(n, from = new Date()) {
  if (!n.active) return null;
  if (n.schedule === "once") return n.sendAt || null;
  const today = berlinParts(from).date;
  for (let i = 0; i < 8; i++) {
    const d = addDays(today, i);
    if (n.schedule === "weekly" && !n.weekdays.includes(isoWeekday(d))) continue;
    const t = berlinToUtc(d, n.time);
    if (t > from) return t.toISOString();
  }
  return null;
}
function scheduleText(n) {
  if (n.schedule === "daily") return `Täglich ${n.time}`;
  if (n.schedule === "weekly") return `${n.weekdays.slice().sort().map((d) => WD[d - 1]).join(", ")} · ${n.time}`;
  if (n.sendAt) return `Einmalig · ${new Date(n.sendAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ })}`;
  return "Einmalig";
}
function notificationOut(n) {
  return {
    id: n.id, title: n.title, body: n.body, audience: n.audience, recipientIds: n.recipientIds,
    recipientNames: n.recipientIds.map((id) => db.users.find((u) => u.id === id)?.displayName).filter(Boolean),
    schedule: n.schedule, time: n.time || null, weekdays: n.weekdays || [], sendAt: n.sendAt || null,
    scheduleText: scheduleText(n), active: n.active, nextRunAt: n.nextRunAt || null, lastSentAt: n.lastSentAt || null, lastResult: n.lastResult || null,
  };
}
export async function sendNotification(n) {
  const targets = (n.audience === "all" ? clients() : n.recipientIds.map((id) => db.users.find((u) => u.id === id)).filter(Boolean))
    .filter((u) => u.pushStatus === "granted");
  let delivered = 0;
  for (const u of targets) if (await pushTo(u.id, { title: n.title, body: n.body, url: "/" })) delivered++;
  n.lastSentAt = nowIso();
  n.lastResult = `${delivered} von ${targets.length} zugestellt`;
  if (n.schedule === "once") n.active = false;
  n.nextRunAt = nextRun(n);
  save();
  return n;
}

// ------------------------------------------------------------------ Admin: Aktivität & Erinnerung
function clientActivity(c, cfg = db.reminder) {
  const today = todayBerlin();
  const dates = Object.keys(entriesOf(c.id)).sort();
  const lastEntry = dates.length ? dates[dates.length - 1] : null;
  const missingDays = lastEntry ? daysBetween(lastEntry, today) : daysBetween(c.createdAt.slice(0, 10), today);
  const active = new Set(c.activeDays || []);
  const countActive = (n) => Array.from({ length: n }, (_, i) => addDays(today, -i)).filter((d) => active.has(d)).length;
  const logins = (c.logins || []).filter((t) => Date.now() - Date.parse(t) < 30 * 86400000);
  let reminderState = "ok";
  if (missingDays >= cfg.days) {
    if (!pushAllowed(c)) reminderState = "no-push";
    else if (c.lastReminder === today) reminderState = "sent-today";
    else if (!cfg.repeatDaily && c.lastReminder && (!lastEntry || c.lastReminder > lastEntry)) reminderState = "already-reminded";
    else reminderState = "due";
  }
  return {
    id: c.id, displayName: c.displayName, lastEntry, missingDays,
    entries7: dates.filter((d) => daysBetween(d, today) < 7 && daysBetween(d, today) >= 0).length,
    activeDays7: countActive(7), activeDays30: countActive(30),
    lastSeen: c.lastSeen || null, lastLogin: (c.logins || []).slice(-1)[0] || null, logins30: logins.length,
    reminderState, lastReminder: c.lastReminder || null,
  };
}
function overview() {
  const { lastRunDate, ...reminder } = db.reminder;
  return { clients: clients().map((c) => clientActivity(c)), reminder };
}
export async function runReminder() {
  const cfg = db.reminder;
  const today = todayBerlin();
  const due = clients().filter((c) => clientActivity(c).reminderState === "due");
  let delivered = 0;
  for (const c of due) {
    const days = clientActivity(c).missingDays;
    const fill = (s) => s.replaceAll("{name}", c.displayName).replaceAll("{tage}", String(days));
    if (await pushTo(c.id, { title: fill(cfg.title), body: fill(cfg.body), url: "/" })) { delivered++; c.lastReminder = today; }
  }
  cfg.lastRunAt = nowIso();
  cfg.lastRunDate = today;
  cfg.lastResult = due.length ? `${delivered} von ${due.length} erinnert` : "niemand fällig";
  save();
  return { recipients: due.length, delivered };
}

// ------------------------------------------------------------------ Router
const routes = [];
const on = (method, pattern, opts, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), role: opts.role, auth: opts.auth !== false, fn });

// --- Anmeldung
const loginAttempts = new Map();
on("POST", "/api/login", { auth: false }, ({ req, body, res }) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  const a = loginAttempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 20) throw new HttpError(429, "Zu viele Versuche. Bitte in ein paar Minuten erneut.");
  const user = db.users.find((u) => u.username.toLowerCase() === String(body.username || "").trim().toLowerCase());
  if (!user || !checkPassword(user, String(body.password || ""))) {
    a.n++; loginAttempts.set(ip, a);
    throw new HttpError(401, "Benutzername oder Passwort falsch");
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[token] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 86400000 };
  user.logins = [...(user.logins || []), nowIso()].slice(-200);
  save();
  res.setHeader("Set-Cookie", sessionCookie(req, token, SESSION_DAYS * 86400));
  return { user: publicUser(user) };
});
on("POST", "/api/logout", { auth: false }, ({ req, res }) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) { delete db.sessions[sid]; save(); }
  res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
  return { ok: true };
});
on("GET", "/api/me", {}, ({ me }) => ({ user: publicUser(me) }));
on("POST", "/api/me/password", {}, ({ me, body }) => {
  if (!checkPassword(me, String(body.currentPassword || ""))) throw bad("Das aktuelle Passwort stimmt nicht.");
  const pw = String(body.newPassword || "");
  if (pw.length < 8) throw bad("Das neue Passwort braucht mindestens 8 Zeichen.");
  Object.assign(me, hashPassword(pw));
  save();
  return { ok: true };
});

// --- Einträge
on("GET", "/api/entries", {}, ({ me, query }) => ({ entries: sortedEntries(target(me, query).id) }));
on("PUT", "/api/entries/(\\d{4}-\\d{2}-\\d{2})", { role: "client" }, ({ me, body, params }) => ({ entry: upsertEntry(me.id, params[0], body) }));
on("DELETE", "/api/entries/(\\d{4}-\\d{2}-\\d{2})", { role: "client" }, ({ me, params }) => { delete entriesOf(me.id)[params[0]]; save(); return { ok: true }; });
on("GET", "/api/entries\\.csv", {}, ({ me, query, res }) => {
  const u = target(me, query);
  const q = (v) => (v == null ? "" : `"${String(v).replaceAll('"', '""')}"`);
  const rows = sortedEntries(u.id).map((e) => [e.date, e.weight, e.steps, e.sleep, e.training === null ? "" : e.training ? "ja" : "nein", e.caloriesOk === null ? "" : e.caloriesOk ? "ja" : "nein", e.calories, e.note].map((v, i) => (i === 7 ? q(v) : v ?? "")).join(";"));
  const csv = "﻿Datum;Gewicht (kg);Schritte;Schlaf (h);Training;Kalorien eingehalten;Gegessen (kcal);Notiz\n" + rows.join("\n") + "\n";
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="thabstracker-${u.username}.csv"` });
  res.end(csv);
  return undefined;
});

// --- Plan & Ziele
on("GET", "/api/goals", {}, ({ me, query }) => { const u = target(me, query); return { goals: goalsOf(u.id), history: historyOf(u.id) }; });
on("PUT", "/api/goals", { role: "coach" }, ({ me, query, body }) => ({ goals: setGoals(target(me, query).id, readGoalBody(body)) }));

// --- Check-ins
on("GET", "/api/checkins", { role: "client" }, ({ me }) => {
  const list = checkinsOf(me.id);
  if (list[0] && !list[0].seenAt) { list[0].seenAt = nowIso(); save(); }
  return { checkins: list.map(checkinOut) };
});
on("POST", "/api/checkins", { role: "coach" }, ({ me, query, body }) => {
  const client = target(me, query);
  const message = text(body.message, 4000);
  if (!message) throw bad("Bitte eine Nachricht schreiben.");
  const p = body.proposal || {};
  const proposal = {};
  for (const k of ["stepsGoal", "sleepGoal", "targetWeight"]) if (p[k] !== undefined) proposal[k] = readGoalBody({ [k]: p[k] })[k];
  if (p.caloriesMin !== undefined || p.caloriesMax !== undefined) {
    const g = readGoalBody(p);
    proposal.caloriesMin = g.caloriesMin ?? g.caloriesMax;
    proposal.caloriesMax = g.caloriesMax ?? g.caloriesMin;
    if (proposal.caloriesMin > proposal.caloriesMax) throw bad("Kalorien: „von“ muss kleiner als „bis“ sein.");
  }
  const changes = [...("caloriesMin" in proposal ? ["calories"] : []), ...["stepsGoal", "sleepGoal", "targetWeight"].filter((k) => k in proposal)];
  const c = { id: nextId("checkin"), userId: client.id, coachId: me.id, createdAt: nowIso(), message, proposal, before: goalsOf(client.id), changes, status: "open" };
  db.checkins.push(c);
  save();
  pushLater(client.id, { title: "📋 Neuer Check-in von deinem Coach", body: message.slice(0, 140), url: "/" });
  return { checkin: checkinOut(c) };
});
function ownCheckin(me, id) {
  const c = db.checkins.find((x) => x.id === Number(id) && x.userId === me.id);
  if (!c) throw new HttpError(404, "Check-in nicht gefunden");
  return c;
}
on("POST", "/api/checkins/(\\d+)/accept", { role: "client" }, ({ me, params }) => {
  const c = ownCheckin(me, params[0]);
  if (c.status === "accepted") return { checkin: checkinOut(c) };
  if (!c.changes.length) throw bad("Dieser Check-in enthält keine Anpassungen.");
  setGoals(me.id, c.proposal);
  c.status = "accepted";
  c.acceptedAt = nowIso();
  save();
  pushLater(coachOf(me)?.id, { title: `✓ ${me.displayName} hat die Anpassungen angenommen`, body: "Der Plan ist aktualisiert.", url: `/#/client/${me.id}` });
  return { checkin: checkinOut(c) };
});
on("POST", "/api/checkins/(\\d+)/reply", { role: "client" }, ({ me, params, body }) => {
  const c = ownCheckin(me, params[0]);
  addMessage(me.id, me, body.body);
  c.repliedAt = nowIso();
  save();
  return { checkin: checkinOut(c) };
});
on("GET", "/api/checkins/queue", { role: "coach" }, ({ me }) => {
  const monday = weekStart(todayBerlin());
  return {
    clients: clients().filter((c) => c.coachId === me.id).map((c) => ({
      id: c.id, displayName: c.displayName,
      doneThisWeek: checkinsOf(c.id).some((x) => berlinParts(new Date(x.createdAt)).date >= monday),
    })),
  };
});
on("GET", "/api/checkins/review", { role: "coach" }, ({ me, query }) => {
  const client = target(me, query);
  const goals = goalsOf(client.id);
  const today = todayBerlin();
  const prev = weekStats(client.id, addDays(today, -13), addDays(today, -7), goals);
  const cur = weekStats(client.id, addDays(today, -6), today, goals);
  const list = checkinsOf(client.id);
  const since = list[0]?.createdAt || "";
  return {
    client: { id: client.id, displayName: client.displayName, username: client.username },
    goals,
    checkins: list.map(checkinOut),
    clientMessages: threadOf(client.id).filter((m) => m.senderId === client.id && m.createdAt > since).map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt })),
    comparison: {
      previous: prev.stats, current: cur.stats,
      delta: {
        weightAvg: diff(prev.stats.weightAvg, cur.stats.weightAvg), stepsAvg: diff(prev.stats.stepsAvg, cur.stats.stepsAvg),
        sleepAvg: diff(prev.stats.sleepAvg, cur.stats.sleepAvg), trainingDays: cur.stats.trainingDays - prev.stats.trainingDays,
        caloriesOkDays: cur.stats.caloriesOkDays - prev.stats.caloriesOkDays, daysLogged: cur.stats.daysLogged - prev.stats.daysLogged,
      },
      days: [...prev.days, ...cur.days],
    },
  };
});

// --- Nachrichten
on("GET", "/api/messages/unread", {}, ({ me }) => ({
  unread: me.role === "client" ? unreadFor(me, me.id) : clients().filter((c) => c.coachId === me.id).reduce((s, c) => s + unreadFor(me, c.id), 0),
}));
on("GET", "/api/messages", {}, ({ me, query }) => {
  const client = target(me, query);
  const after = Number(query.get("after")) || 0;
  let changed = false;
  for (const m of threadOf(client.id)) if (m.senderId !== me.id && !m.readAt) { m.readAt = nowIso(); changed = true; }
  if (changed) save();
  return { messages: threadOf(client.id).filter((m) => m.id > after).map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt, mine: m.senderId === me.id })) };
});
on("POST", "/api/messages", {}, ({ me, query, body }) => {
  const client = target(me, query);
  const m = addMessage(client.id, me, body.body);
  return { message: { id: m.id, body: m.body, createdAt: m.createdAt, mine: true } };
});

// --- Klienten (Coach)
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
function clientOut(me, c) {
  const all = sortedEntries(c.id);
  const today = todayBerlin();
  const last7 = all.filter((e) => daysBetween(e.date, today) < 7 && daysBetween(e.date, today) >= 0);
  const weights = all.filter((e) => e.weight !== null);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    id: c.id, username: c.username, displayName: c.displayName, createdAt: c.createdAt,
    lastEntry: all.length ? all[all.length - 1].date : null, entries7d: last7.length,
    lastWeight: weights.length ? weights[weights.length - 1].weight : null, firstWeight: weights.length ? weights[0].weight : null,
    avgSteps7d: avg(last7.filter((e) => e.steps !== null).map((e) => e.steps)), avgSleep7d: avg(last7.filter((e) => e.sleep !== null).map((e) => e.sleep)),
    unreadMessages: unreadFor(me, c.id), openSwaps: db.requests.filter((r) => r.userId === c.id && r.status === "open").length,
    pushStatus: c.pushStatus || "unknown", pushDevices: devicesOf(c.id).length,
    healthLinked: !!c.healthTokenHash, healthLastUsed: c.healthLastUsed || null,
  };
}
on("GET", "/api/clients", { role: "coach" }, ({ me }) => ({ clients: clients().filter((c) => c.coachId === me.id).map((c) => clientOut(me, c)).sort((a, b) => a.displayName.localeCompare(b.displayName, "de")) }));
on("POST", "/api/clients", { role: "coach" }, ({ me, body }) => {
  const displayName = text(body.displayName, 60);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!displayName) throw bad("Bitte einen Namen angeben.");
  if (!USERNAME_RE.test(username)) throw bad("Benutzername: 3–32 Zeichen, nur Buchstaben, Ziffern, . _ -");
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw bad("Dieser Benutzername ist schon vergeben.");
  if (password.length < 8) throw bad("Das Passwort braucht mindestens 8 Zeichen.");
  const c = { id: nextId("user"), username, displayName, role: "client", coachId: me.id, createdAt: nowIso(), pushStatus: "unknown", ...hashPassword(password) };
  db.users.push(c);
  save();
  return { client: clientOut(me, c) };
});
on("PATCH", "/api/clients/(\\d+)", { role: "coach" }, ({ me, params, body }) => {
  const c = clientFor(me, params[0]);
  if (body.displayName !== undefined) { const n = text(body.displayName, 60); if (!n) throw bad("Bitte einen Namen angeben."); c.displayName = n; }
  if (body.password !== undefined) {
    if (String(body.password).length < 8) throw bad("Das Passwort braucht mindestens 8 Zeichen.");
    Object.assign(c, hashPassword(String(body.password)));
    for (const [k, s] of Object.entries(db.sessions)) if (s.userId === c.id) delete db.sessions[k];
  }
  save();
  return { client: clientOut(me, c) };
});
on("DELETE", "/api/clients/(\\d+)", { role: "coach" }, ({ me, params }) => {
  const c = clientFor(me, params[0]);
  const mealIds = new Set(db.meals.filter((m) => m.userId === c.id).map((m) => m.id));
  db.users = db.users.filter((u) => u.id !== c.id);
  delete db.entries[c.id];
  delete db.goals[c.id];
  db.goalHistory = db.goalHistory.filter((h) => h.userId !== c.id);
  db.checkins = db.checkins.filter((x) => x.userId !== c.id);
  db.messages = db.messages.filter((m) => m.clientId !== c.id);
  db.items = db.items.filter((i) => !mealIds.has(i.mealId));
  db.meals = db.meals.filter((m) => m.userId !== c.id);
  db.requests = db.requests.filter((r) => r.userId !== c.id);
  db.pushSubs = db.pushSubs.filter((s) => s.userId !== c.id);
  for (const [k, s] of Object.entries(db.sessions)) if (s.userId === c.id) delete db.sessions[k];
  for (const n of db.notifications) n.recipientIds = n.recipientIds.filter((id) => id !== c.id);
  save();
  return { ok: true };
});

// --- Lebensmittel
on("GET", "/api/foods", {}, () => ({ foods: db.foods.slice().sort((a, b) => a.name.localeCompare(b.name, "de")).map(foodOut) }));
on("POST", "/api/foods", { role: "coach" }, ({ body }) => {
  const f = { id: nextId("food"), ...readFood(body), custom: true };
  db.foods.push(f);
  save();
  return { food: foodOut(f) };
});
on("PATCH", "/api/foods/(\\d+)", { role: "coach" }, ({ params, body }) => {
  const f = foodById(params[0]);
  Object.assign(f, readFood({ ...foodOut(f), ...body }));
  save();
  return { food: foodOut(f) };
});
on("DELETE", "/api/foods/(\\d+)", { role: "coach" }, ({ params }) => {
  const f = foodById(params[0]);
  db.foods = db.foods.filter((x) => x.id !== f.id);
  // Offene Wünsche behalten den Namen
  for (const r of db.requests) if (r.wantedFoodId === f.id) r.wantedFoodSnapshot = foodOut(f);
  save();
  return { ok: true };
});

// --- Ernährungsplan
on("GET", "/api/nutrition", {}, ({ me, query }) => planOf(target(me, query).id));
on("POST", "/api/nutrition/meals", { role: "coach" }, ({ me, query, body }) => {
  const client = target(me, query);
  const name = text(body.name, 60);
  if (!name) throw bad("Bitte einen Namen angeben.");
  const pos = Math.max(0, ...db.meals.filter((m) => m.userId === client.id).map((m) => m.pos + 1));
  db.meals.push({ id: nextId("meal"), userId: client.id, name, pos });
  save();
  return planOf(client.id);
});
on("PATCH", "/api/nutrition/meals/(\\d+)", { role: "coach" }, ({ me, params, body }) => {
  const m = mealFor(me, params[0]);
  if (body.name !== undefined) { const n = text(body.name, 60); if (!n) throw bad("Bitte einen Namen angeben."); m.name = n; }
  if (body.move) {
    const list = db.meals.filter((x) => x.userId === m.userId).sort((a, b) => a.pos - b.pos);
    const i = list.indexOf(m), j = i + Math.sign(body.move);
    if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
    list.forEach((x, k) => (x.pos = k));
  }
  save();
  return planOf(m.userId);
});
on("DELETE", "/api/nutrition/meals/(\\d+)", { role: "coach" }, ({ me, params }) => {
  const m = mealFor(me, params[0]);
  db.items = db.items.filter((i) => i.mealId !== m.id);
  db.meals = db.meals.filter((x) => x.id !== m.id);
  save();
  return planOf(m.userId);
});
on("POST", "/api/nutrition/meals/(\\d+)/items", { role: "coach" }, ({ me, params, body }) => {
  const m = mealFor(me, params[0]);
  const f = foodById(body.foodId);
  const amount = num(body.amount, { min: 0.1, max: 10000, label: "Menge" });
  if (!amount) throw bad("Bitte eine Menge angeben.");
  db.items.push({ id: nextId("item"), mealId: m.id, foodId: f.id, name: f.name, kcal: f.kcal, unit: f.unit, amount });
  save();
  return planOf(m.userId);
});
on("PATCH", "/api/nutrition/items/(\\d+)", { role: "coach" }, ({ me, params, body }) => {
  const { item, meal } = itemFor(me, params[0]);
  if (body.foodId !== undefined) { const f = foodById(body.foodId); Object.assign(item, { foodId: f.id, name: f.name, kcal: f.kcal, unit: f.unit }); }
  if (body.amount !== undefined) { const a = num(body.amount, { min: 0.1, max: 10000, label: "Menge" }); if (!a) throw bad("Bitte eine Menge angeben."); item.amount = a; }
  save();
  return planOf(meal.userId);
});
on("DELETE", "/api/nutrition/items/(\\d+)", { role: "coach" }, ({ me, params }) => {
  const { item, meal } = itemFor(me, params[0]);
  db.items = db.items.filter((i) => i.id !== item.id);
  save();
  return planOf(meal.userId);
});
on("POST", "/api/nutrition/requests", { role: "client" }, ({ me, body }) => {
  const wish = text(body.wish, 500);
  let r;
  if (body.type === "meal") {
    const m = db.meals.find((x) => x.id === Number(body.mealId) && x.userId === me.id);
    if (!m) throw bad("Mahlzeit nicht gefunden.");
    if (!wish) throw bad("Bitte beschreib kurz deinen Wunsch.");
    r = { type: "meal", mealId: m.id, subject: `${m.name} (ganze Mahlzeit)`, wish };
  } else {
    const it = db.items.find((x) => x.id === Number(body.itemId));
    const m = it && db.meals.find((x) => x.id === it.mealId && x.userId === me.id);
    if (!m) throw bad("Lebensmittel nicht gefunden.");
    const wanted = body.wantedFoodId ? foodById(body.wantedFoodId) : null;
    if (!wanted && !wish) throw bad("Bitte ein Lebensmittel wählen oder deinen Wunsch beschreiben.");
    r = { type: "item", itemId: it.id, mealId: m.id, wantedFoodId: wanted ? wanted.id : null, subject: `${it.name} · ${m.name}`, wish };
  }
  db.requests.push({ id: nextId("request"), userId: me.id, status: "open", createdAt: nowIso(), ...r });
  save();
  pushLater(coachOf(me)?.id, { title: `🍽 Tauschwunsch von ${me.displayName}`, body: r.subject.split(" · ")[0], url: `/#/client/${me.id}/nutrition` });
  return planOf(me.id);
});
on("DELETE", "/api/nutrition/requests/(\\d+)", { role: "client" }, ({ me, params }) => {
  const r = db.requests.find((x) => x.id === Number(params[0]) && x.userId === me.id && x.status === "open");
  if (!r) throw new HttpError(404, "Anfrage nicht gefunden");
  db.requests = db.requests.filter((x) => x.id !== r.id);
  save();
  return planOf(me.id);
});
on("POST", "/api/nutrition/requests/(\\d+)/resolve", { role: "coach" }, ({ me, params, body }) => {
  const r = db.requests.find((x) => x.id === Number(params[0]));
  if (!r) throw new HttpError(404, "Anfrage nicht gefunden");
  clientFor(me, r.userId);
  if (!["done", "declined"].includes(body.status)) throw bad("Ungültiger Status.");
  if (body.apply) {
    const it = db.items.find((x) => x.id === r.itemId);
    const f = r.wantedFoodId && db.foods.find((x) => x.id === r.wantedFoodId);
    if (!it || !f) throw bad("Tausch nicht möglich – Lebensmittel fehlt.");
    const amount = sameKcalAmount(kcalOf(it.amount, it.kcal), f.kcal);
    Object.assign(it, { foodId: f.id, name: f.name, kcal: f.kcal, unit: f.unit, amount });
  }
  Object.assign(r, { status: body.status, coachNote: text(body.note, 500), resolvedAt: nowIso() });
  save();
  pushLater(r.userId, {
    title: body.status === "done" ? "🍽 Tauschwunsch umgesetzt ✓" : "🍽 Tauschwunsch abgelehnt",
    body: r.coachNote || r.subject.split(" · ")[0], url: "/#/nutrition",
  });
  return planOf(r.userId);
});

// --- Push
on("GET", "/api/push/config", {}, ({ me }) => ({ publicKey: vapid.publicKey, status: me.pushStatus || "unknown", devices: devicesOf(me.id).length }));
on("POST", "/api/push/consent", {}, ({ me, body }) => {
  if (!["granted", "denied", "unknown"].includes(body.status)) throw bad("Ungültiger Status.");
  me.pushStatus = body.status;
  if (body.status === "denied") db.pushSubs = db.pushSubs.filter((s) => s.userId !== me.id);
  save();
  return { ok: true };
});
on("POST", "/api/push/subscribe", {}, ({ me, body }) => {
  const s = body.subscription;
  if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw bad("Ungültige Push-Anmeldung.");
  db.pushSubs = db.pushSubs.filter((x) => x.endpoint !== s.endpoint);
  db.pushSubs.push({ userId: me.id, endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, createdAt: nowIso() });
  me.pushStatus = "granted";
  save();
  return { ok: true };
});
on("POST", "/api/push/unsubscribe", {}, ({ me, body }) => {
  db.pushSubs = db.pushSubs.filter((x) => !(x.userId === me.id && x.endpoint === body.endpoint));
  save();
  return { ok: true };
});
on("POST", "/api/push/test", {}, async ({ me }) => ({ delivered: await pushTo(me.id, { title: "Thabstracker", body: "Test erfolgreich – Benachrichtigungen funktionieren ✓", url: "/" }) }));

// --- Push-Nachrichten (Coach)
on("GET", "/api/notifications", { role: "coach" }, () => {
  const { enabled, time, days, lastResult } = db.reminder;
  return { notifications: db.notifications.slice().sort((a, b) => b.id - a.id).map(notificationOut), timezone: TZ, automation: { enabled, time, days, lastResult } };
});
on("POST", "/api/notifications", { role: "coach" }, async ({ me, body }) => {
  const title = text(body.title, 60), msg = text(body.body, 240);
  if (!title || !msg) throw bad("Bitte Titel und Text angeben.");
  const schedule = ["once", "daily", "weekly"].includes(body.schedule) ? body.schedule : "once";
  const audience = body.audience === "some" ? "some" : "all";
  const recipientIds = audience === "some" ? (body.recipientIds || []).map(Number).filter((id) => clients().some((c) => c.id === id && c.coachId === me.id)) : [];
  if (audience === "some" && !recipientIds.length) throw bad("Bitte mindestens einen Empfänger wählen.");
  const n = { id: nextId("notification"), title, body: msg, audience, recipientIds, schedule, active: true, createdAt: nowIso() };
  if (schedule !== "once") {
    if (!/^\d{2}:\d{2}$/.test(body.time || "")) throw bad("Bitte eine Uhrzeit wählen.");
    n.time = body.time;
  }
  if (schedule === "weekly") {
    n.weekdays = [...new Set((body.weekdays || []).map(Number).filter((d) => d >= 1 && d <= 7))];
    if (!n.weekdays.length) throw bad("Bitte mindestens einen Wochentag wählen.");
  }
  if (schedule === "once" && body.sendAt) {
    const t = Date.parse(body.sendAt);
    if (!Number.isFinite(t)) throw bad("Ungültiger Zeitpunkt.");
    if (t < Date.now() - 60000) throw bad("Der Zeitpunkt liegt in der Vergangenheit.");
    n.sendAt = new Date(t).toISOString();
  }
  n.nextRunAt = nextRun(n);
  db.notifications.push(n);
  save();
  if (schedule === "once" && !n.sendAt) await sendNotification(n);
  return { notification: notificationOut(n) };
});
const notifById = (id) => {
  const n = db.notifications.find((x) => x.id === Number(id));
  if (!n) throw new HttpError(404, "Push-Nachricht nicht gefunden");
  return n;
};
on("PATCH", "/api/notifications/(\\d+)", { role: "coach" }, ({ params, body }) => {
  const n = notifById(params[0]);
  if (typeof body.active === "boolean") n.active = body.active;
  n.nextRunAt = nextRun(n);
  save();
  return { notification: notificationOut(n) };
});
on("DELETE", "/api/notifications/(\\d+)", { role: "coach" }, ({ params }) => {
  notifById(params[0]);
  db.notifications = db.notifications.filter((x) => x.id !== Number(params[0]));
  save();
  return { ok: true };
});
on("POST", "/api/notifications/(\\d+)/send", { role: "coach" }, async ({ params }) => {
  const n = notifById(params[0]);
  const wasActive = n.active;
  await sendNotification(n);
  if (n.schedule !== "once") n.active = wasActive; // manuelles Senden ändert den Zeitplan nicht
  n.nextRunAt = nextRun(n);
  save();
  return { notification: notificationOut(n) };
});

// --- Admin
on("GET", "/api/admin/overview", { role: "coach" }, () => overview());
on("PUT", "/api/admin/reminder", { role: "coach" }, ({ body }) => {
  const r = db.reminder;
  if (typeof body.enabled === "boolean") r.enabled = body.enabled;
  if (body.days !== undefined) r.days = num(body.days, { min: 1, max: 60, int: true, label: "Tage" });
  if (body.time !== undefined) { if (!/^\d{2}:\d{2}$/.test(body.time)) throw bad("Bitte eine Uhrzeit wählen."); r.time = body.time; }
  if (body.title !== undefined) r.title = text(body.title, 60) || r.title;
  if (body.body !== undefined) r.body = text(body.body, 240) || r.body;
  if (typeof body.repeatDaily === "boolean") r.repeatDaily = body.repeatDaily;
  save();
  return overview();
});
on("POST", "/api/admin/reminder/run", { role: "coach" }, async () => ({ ...overview(), result: await runReminder() }));

// --- Apple Health (Kurzbefehle)
const tokenHash = (t) => crypto.createHash("sha256").update(t).digest("hex");
on("GET", "/api/health/token", { role: "client" }, ({ me }) => ({ linked: !!me.healthTokenHash, lastUsedAt: me.healthLastUsed || null }));
on("POST", "/api/health/token", { role: "client" }, ({ me }) => {
  const token = crypto.randomBytes(24).toString("base64url");
  me.healthTokenHash = tokenHash(token);
  me.healthLastUsed = null;
  save();
  return { token };
});
on("DELETE", "/api/health/token", { role: "client" }, ({ me }) => { me.healthTokenHash = null; me.healthLastUsed = null; save(); return { ok: true }; });
on("POST", "/api/health/import", { auth: false }, ({ req, body }) => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  const user = m && db.users.find((u) => u.healthTokenHash && u.healthTokenHash === tokenHash(m[1].trim()));
  if (!user) throw new HttpError(401, "Ungültiger Schlüssel");
  const sumOf = (v) => (Array.isArray(v) ? v.reduce((s, x) => s + (Number(String(x).replace(",", ".")) || 0), 0) : v);
  const patch = {};
  if (body.steps !== undefined && body.steps !== null && body.steps !== "") patch.steps = Math.round(Number(String(sumOf(body.steps)).replace(",", ".")));
  if (body.weight !== undefined && body.weight !== null && body.weight !== "") patch.weight = Array.isArray(body.weight) ? body.weight[0] : body.weight;
  if (!Object.keys(patch).length) throw bad("Keine Daten (steps oder weight) gefunden.");
  const date = isDate(body.date) ? body.date : todayBerlin();
  const entry = upsertEntry(user.id, date, patch);
  user.healthLastUsed = nowIso();
  save();
  return { ok: true, date, entry };
});

// ------------------------------------------------------------------ Dispatcher
export async function handleApi(req, res, url) {
  const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname))
    || (routes.some((r) => r.re.test(url.pathname)) ? "method" : null);
  if (!route) throw new HttpError(404, "Nicht gefunden");
  if (route === "method") throw new HttpError(405, "Methode nicht erlaubt");
  let me = null;
  if (route.auth) {
    me = currentUser(req);
    if (!me) throw new HttpError(401, "Nicht angemeldet");
    if (route.role && me.role !== route.role) throw new HttpError(403, "Keine Berechtigung");
    // Aktivität für die Admin-Übersicht
    const today = todayBerlin();
    me.lastSeen = nowIso();
    if (!(me.activeDays || []).includes(today)) { me.activeDays = [...(me.activeDays || []), today].slice(-60); }
    save();
  }
  let body = {};
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) body = await readJson(req);
  const params = url.pathname.match(route.re).slice(1);
  return route.fn({ req, res, me, body, params, query: url.searchParams });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new HttpError(413, "Anfrage zu groß")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === "object" ? v : {});
      } catch { reject(bad("Ungültiges JSON.")); }
    });
    req.on("error", reject);
  });
}
