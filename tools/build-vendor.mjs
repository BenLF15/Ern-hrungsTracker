// Erzeugt die gebündelten Bibliotheken in vendor/ neu (nur nötig für Updates).
//   npm install && npm run build:vendor
import { copyFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "nw-vendor-"));
const entries = {
  "anthropic-sdk.mjs": 'export { default as Anthropic } from "@anthropic-ai/sdk";\n',
  "zxing.mjs": 'export { BrowserMultiFormatReader } from "@zxing/browser";\nexport { BarcodeFormat, DecodeHintType, NotFoundException } from "@zxing/library";\n',
};
try {
  for (const [name, src] of Object.entries(entries)) {
    const entry = join(tmp, name.replace(".mjs", ".js"));
    writeFileSync(entry, src);
    await esbuild.build({
      entryPoints: [entry], bundle: true, format: "esm", platform: "browser", minify: true,
      legalComments: "eof", outfile: join(root, "vendor", name), nodePaths: [join(root, "node_modules")],
    });
    console.log("vendor/" + name);
  }
  copyFileSync(join(root, "node_modules/@anthropic-ai/sdk/LICENSE"), join(root, "vendor/LICENSE-anthropic-sdk.txt"));
  copyFileSync(join(root, "node_modules/@zxing/library/LICENSE"), join(root, "vendor/LICENSE-zxing.txt"));
} finally { rmSync(tmp, { recursive: true, force: true }); }
