// Baut die auslieferbare Web-App nach dist/ (nur Node-Bordmittel, keine Installation nötig).
//
//   npm run build            -> dist/
//   npm run check            -> prüft nur, ob alle Dateien vorhanden und gültig sind
//
// Kopiert die statischen Dateien und setzt im Service Worker eine Versionskennung aus dem
// Inhalts-Hash, damit installierte Apps nach jedem Deploy die neue Version laden.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const checkOnly = process.argv.includes("--check");

// Was ausgeliefert wird
const FILES = ["index.html", "manifest.webmanifest", "sw.js"];
const DIRS = ["css", "js", "data", "icons", "vendor"];

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// --- Prüfungen ---
const missing = [...FILES, ...DIRS].filter((p) => !existsSync(join(root, p)));
if (missing.length) { console.error("Fehlt: " + missing.join(", ")); process.exit(1); }

// Jede im Service Worker gelistete Datei muss existieren
const sw = readFileSync(join(root, "sw.js"), "utf8");
const shell = [...sw.matchAll(/"([^"]+\.(?:html|css|js|mjs|json|svg|png|webmanifest))"/g)].map((m) => m[1]);
const swMissing = shell.filter((p) => !existsSync(join(root, p)));
if (swMissing.length) { console.error("Im Service Worker gelistet, aber nicht vorhanden: " + swMissing.join(", ")); process.exit(1); }

// Datenbank muss gültiges JSON mit Lebensmitteln sein
let foodCount = 0;
try {
  const db = JSON.parse(readFileSync(join(root, "data/foods.json"), "utf8"));
  foodCount = db.foods.length;
  if (!foodCount) throw new Error("keine Lebensmittel");
} catch (e) { console.error("data/foods.json ungültig: " + e.message); process.exit(1); }

// Alle relativen Modul-Importe in js/ müssen auflösbar sein
for (const f of walk(join(root, "js")).filter((p) => p.endsWith(".js"))) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/(?:import\s[^"']*?from\s*|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = resolve(dirname(f), m[1]);
    if (!existsSync(target)) { console.error(`${relative(root, f)}: Import nicht gefunden: ${m[1]}`); process.exit(1); }
  }
}

if (checkOnly) { console.log(`OK – ${foodCount.toLocaleString("de-DE")} Lebensmittel, ${shell.length} Dateien im Offline-Cache.`); process.exit(0); }

// --- Build ---
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of FILES) cpSync(join(root, f), join(out, f));
for (const d of DIRS) cpSync(join(root, d), join(out, d), { recursive: true });

// Inhalts-Hash -> Service-Worker-Version
const hash = createHash("sha256");
for (const f of walk(out).sort()) if (!f.endsWith("sw.js")) hash.update(relative(out, f)).update(readFileSync(f));
const version = "nw-" + hash.digest("hex").slice(0, 12);
writeFileSync(join(out, "sw.js"), sw.replace(/const VERSION = "[^"]*";/, `const VERSION = "${version}";`));

const size = walk(out).reduce((s, f) => s + statSync(f).size, 0);
console.log(`dist/ gebaut: ${walk(out).length} Dateien, ${(size / 1024 / 1024).toFixed(1)} MB, ${foodCount.toLocaleString("de-DE")} Lebensmittel, Cache-Version ${version}`);
