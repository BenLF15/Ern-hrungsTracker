// Thabs-Kopie: Server (nur Node-Bordmittel, Node >= 18).
//   /              Oberfläche der Thabstracker-Kopie (thabs/public, unverändert vom Original)
//   /api/...       nachgebaute API (api.js)
//   /ernaehrung/   Ernährungstracker (gebaut nach dist/ mit "npm run build") – gleiche Adresse,
//                  damit die Verknüpfung (Kalorien -> Check-in) ohne fremde Server funktioniert.
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import crypto from "node:crypto";
import { db, nextId, save, flush, DATA_DIR } from "./store.js";
import { handleApi, HttpError, hashPassword, initPush, sendNotification, runReminder } from "./api.js";
import { berlinParts } from "./time.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = resolve(here, "../public");
const EXTRA = resolve(here, "../extra");
const NUTRITION = resolve(here, "../../dist");
const port = Number(process.env.PORT) || 3000;
const hasNutrition = existsSync(join(NUTRITION, "index.html"));

// ------------------------------------------------------------------ Erststart
if (!db.users.some((u) => u.role === "coach")) {
  const username = process.env.COACH_USERNAME || "coach";
  const password = process.env.COACH_PASSWORD || crypto.randomBytes(9).toString("base64url");
  db.users.push({ id: nextId("user"), username, displayName: process.env.COACH_NAME || "Coach", role: "coach", createdAt: new Date().toISOString(), pushStatus: "unknown", ...hashPassword(password) });
  console.log(`Coach-Zugang angelegt – Benutzername: ${username}${process.env.COACH_PASSWORD ? " (Passwort aus COACH_PASSWORD)" : `, Passwort: ${password}`}`);
  save();
}
if (!db.foods.length) {
  const seed = JSON.parse(readFileSync(join(here, "foods-seed.json"), "utf8"));
  for (const f of seed) db.foods.push({ id: nextId("food"), name: f.name, kcal: f.kcal, unit: f.unit, category: f.category, custom: false, source: f.source });
  save();
}
initPush();
flush();

// ------------------------------------------------------------------ Zeitsteuerung
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const n of db.notifications) if (n.active && n.nextRunAt && Date.parse(n.nextRunAt) <= now) await sendNotification(n);
    const r = db.reminder;
    const { date, time } = berlinParts();
    if (r.enabled && time >= r.time && r.lastRunDate !== date) await runReminder();
  } catch (e) {
    console.error("Zeitsteuerung:", e);
  } finally {
    ticking = false;
  }
}
setInterval(tick, 30_000).unref();

// ------------------------------------------------------------------ Auslieferung
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
const COMPRESS = new Set([".html", ".css", ".js", ".mjs", ".json", ".webmanifest", ".svg", ".txt"]);
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};
// Wie beim Original; der Ernährungstracker braucht zusätzlich Open Food Facts, die Claude API und blob:-Bilder.
const CSP_THABS = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";
const CSP_NUTRITION = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://images.openfoodfacts.org https://static.openfoodfacts.org; connect-src 'self' https://world.openfoodfacts.org https://api.anthropic.com; media-src 'self' blob:; frame-ancestors 'none'";

// Original-index.html bleibt unverändert; beim Ausliefern wird nur das Verknüpfungs-Skript ergänzt.
const thabsIndex = () => readFileSync(join(PUBLIC, "index.html"), "utf8")
  .replace("</body>", `  <script src="/kopie-extra.js" data-nutrition="${hasNutrition ? "1" : ""}"></script>\n</body>`);

function sendFile(req, res, file, { csp, fresh, body } = {}) {
  const ext = extname(file).toLowerCase();
  const headers = {
    ...BASE_HEADERS,
    "Content-Type": TYPES[ext] || "application/octet-stream",
    "Cache-Control": fresh || ext === ".html" || file.endsWith("sw.js") || ext === ".webmanifest" ? "no-cache" : "public, max-age=3600",
  };
  if (csp) headers["Content-Security-Policy"] = csp;
  if (csp === CSP_NUTRITION) headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()";
  const gzip = COMPRESS.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  if (gzip) { headers["Content-Encoding"] = "gzip"; headers.Vary = "Accept-Encoding"; }
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  if (body !== undefined) {
    if (gzip) { const z = createGzip(); z.pipe(res); z.end(body); } else res.end(body);
    return;
  }
  const s = createReadStream(file);
  (gzip ? s.pipe(createGzip()) : s).pipe(res);
}

function safeJoin(root, path) {
  const f = normalize(join(root, path));
  return f === root || f.startsWith(root + sep) ? f : null;
}
const isFile = (f) => f && existsSync(f) && statSync(f).isFile();

async function handler(req, res) {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); return res.end(); }
  const path = decodeURIComponent(url.pathname);

  if (path.startsWith("/api/")) {
    try {
      const result = await handleApi(req, res, url);
      if (result === undefined) return; // Antwort bereits gesendet (z. B. CSV)
      const json = JSON.stringify(result);
      res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(json);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: status === 500 ? "Serverfehler" : e.message }));
    }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }

  if (path === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }

  // Ernährungstracker
  if (path === "/ernaehrung") { res.writeHead(301, { Location: "/ernaehrung/" }); return res.end(); }
  if (path.startsWith("/ernaehrung/")) {
    if (!hasNutrition) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end('Ernährungstracker nicht gebaut – "npm run build" ausführen.'); }
    let rel = path.slice("/ernaehrung".length);
    if (rel.endsWith("/")) rel += "index.html";
    const f = safeJoin(NUTRITION, rel);
    if (isFile(f)) return sendFile(req, res, f, { csp: CSP_NUTRITION });
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Nicht gefunden");
  }

  // Zusatz-Skript der Kopie
  if (path === "/kopie-extra.js") return sendFile(req, res, join(EXTRA, "kopie-extra.js"), { csp: CSP_THABS, fresh: true });

  // Thabstracker-Oberfläche (unbekannte Pfade -> index.html, wie beim Original)
  const f = path === "/" || path === "/index.html" ? null : safeJoin(PUBLIC, path);
  if (isFile(f)) return sendFile(req, res, f, { csp: CSP_THABS });
  return sendFile(req, res, join(PUBLIC, "index.html"), { csp: CSP_THABS, body: thabsIndex() });
}

createServer((req, res) => {
  handler(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(port, () => {
  console.log(`Thabs-Kopie läuft auf http://localhost:${port} · Daten: ${DATA_DIR} · Ernährungstracker: ${hasNutrition ? "/ernaehrung/" : "nicht gebaut"}`);
});
