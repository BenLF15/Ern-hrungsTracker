// Baut eine einzelne, eigenständige HTML-Datei der App (für die Claude-Chat-Ansicht):
// JavaScript gebündelt, CSS und Lebensmitteldatenbank eingebettet.
//
//   npm i -D esbuild   (oder npx esbuild)
//   node tools/build-artifact.mjs [ausgabe.html]
//
// Das Claude-SDK wird nicht eingebunden: im Chat läuft die KI über das Claude-Konto.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] || resolve(root, "dist-chat/naehrwert-chat.html"));
const esbuild = await import(process.env.ESBUILD_PATH || "esbuild");

const res = await esbuild.build({
  entryPoints: [resolve(root, "js/app.js")],
  bundle: true, format: "esm", platform: "browser", minify: true, write: false,
  target: ["es2020"],
  external: ["../vendor/anthropic-sdk.mjs"],
  legalComments: "eof",
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = readFileSync(resolve(root, "css/app.css"), "utf8");
const foods = readFileSync(resolve(root, "data/foods.json"), "utf8").replace(/<\//g, "<\\/");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"))
  .replace(/<script type="module" src="js\/app.js"><\/script>/, "")
  .replace(/<noscript>.*?<\/noscript>/s, "");

const page = `<title>NährWert</title>
<meta name="description" content="Kalorien, Makronährstoffe und Wasser tracken – mit amtlichen Nährwertdaten (BLS 4.0).">
<style>${css}</style>
${body.trim()}
<script type="application/json" id="foods-data">${foods}</script>
<script type="module">${js}</script>
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log(`${out}: ${(page.length / 1024).toFixed(0)} KiB`);
