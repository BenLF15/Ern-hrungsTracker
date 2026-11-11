// Minimaler statischer Webserver (nur Node-Bordmittel) – für Render "Web Service" oder lokal.
//
//   npm start                 -> liefert dist/ aus (vorher: npm run build)
//   npm run dev               -> liefert das Repository direkt aus (ohne Build)
//
// Port über die Umgebungsvariable PORT (Render setzt sie automatisch), Standard 8000.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootArg = process.argv.indexOf("--root");
const root = resolve(repo, rootArg > -1 ? process.argv[rootArg + 1] : "dist");
const port = Number(process.env.PORT) || 8000;

if (!existsSync(join(root, "index.html"))) {
  console.error(`${root}/index.html nicht gefunden. Erst "npm run build" ausführen.`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
const COMPRESS = new Set([".html", ".css", ".js", ".mjs", ".json", ".webmanifest", ".svg", ".txt"]);

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Kamera für Barcode/Foto erlauben, alles andere aus
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
};

createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
  let path;
  try { path = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400); return res.end(); }
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(root, path));
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY });
    return res.end("Nicht gefunden");
  }
  const ext = extname(file).toLowerCase();
  // HTML, Manifest und Service Worker immer frisch prüfen; Rest kurz cachen (der SW versioniert selbst)
  const fresh = ext === ".html" || ext === ".webmanifest" || path.endsWith("/sw.js");
  const headers = {
    "Content-Type": TYPES[ext] || "application/octet-stream",
    "Cache-Control": fresh ? "no-cache" : "public, max-age=3600",
    ...SECURITY,
  };
  if (path.endsWith("/sw.js")) headers["Service-Worker-Allowed"] = "/";
  const gzip = COMPRESS.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  if (gzip) { headers["Content-Encoding"] = "gzip"; headers["Vary"] = "Accept-Encoding"; }
  else headers["Content-Length"] = statSync(file).size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file);
  (gzip ? stream.pipe(createGzip()) : stream).pipe(res);
}).listen(port, () => console.log(`NährWert läuft auf http://localhost:${port} (Verzeichnis: ${root})`));
