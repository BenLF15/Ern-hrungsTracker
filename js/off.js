// Open Food Facts: Produktdaten per Barcode und Online-Suche (Herstellerangaben vom Etikett).
// Daten: Open Food Facts, Open Database License (ODbL). https://world.openfoodfacts.org
import { cacheGet, cacheSet } from "./store.js";

const FIELDS = [
  "code", "product_name", "product_name_de", "generic_name_de", "brands", "quantity", "product_quantity",
  "product_quantity_unit", "serving_size", "serving_quantity", "nutriments", "nutrition_data_per",
  "image_front_small_url", "categories_tags", "countries_tags", "last_modified_t", "data_quality_errors_tags", "states_tags",
].join(",");

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => {
  if (isNum(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !isNaN(+v.replace(",", "."))) return +v.replace(",", ".");
  return null;
};

/** EAN/UPC-Prüfziffer kontrollieren (EAN-8, UPC-A/12, EAN-13, GTIN-14). */
export function validGtin(code) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

export function productToFood(p) {
  const nu = p.nutriments || {};
  const g = (k) => num(nu[k + "_100g"]);
  let kcal = g("energy-kcal");
  let kj = g("energy-kj");
  if (kcal == null && kj != null) kcal = kj / 4.184;
  if (kj == null && kcal != null) kj = kcal * 4.184;
  let salt = g("salt");
  const sodium = g("sodium");
  if (salt == null && sodium != null) salt = sodium * 2.5;
  const per100 = {
    kcal, kj, fat: g("fat"), sat: g("saturated-fat"), carb: g("carbohydrates"), sugar: g("sugars"),
    polyols: g("polyols"), fibre: g("fiber"), protein: g("proteins"), salt, alcohol: g("alcohol"), acids: null,
  };
  const unitRaw = (p.product_quantity_unit || p.quantity || "").toLowerCase();
  const isLiquid = /\b(ml|cl|l)\b/.test(unitRaw) || /\d\s*(ml|cl|l)\b/.test(unitRaw) ||
    (p.categories_tags || []).some((c) => /beverages|getranke|drinks|milks/.test(c));
  const unit = isLiquid ? "ml" : "g";
  const portions = [];
  const sq = num(p.serving_quantity);
  if (sq && sq > 0) portions.push({ label: `1 Portion lt. Hersteller (${p.serving_size || sq + " " + unit})`, g: sq });
  const pq = num(p.product_quantity);
  if (pq && pq > 0 && pq <= 5000) portions.push({ label: `Ganze Packung (${p.quantity || pq + " " + unit})`, g: pq });
  const name = (p.product_name_de || p.product_name || p.generic_name_de || "").trim() || "Unbenanntes Produkt";
  const missing = ["kcal", "fat", "carb", "protein"].filter((k) => per100[k] == null);
  return {
    name, brand: (p.brands || "").split(",")[0].trim(), per100, unit, portions,
    image: p.image_front_small_url || null,
    source: {
      type: "off", ref: p.code, official: false, declared: true,
      label: "Open Food Facts (Herstellerangabe)",
      url: `https://world.openfoodfacts.org/product/${p.code}`,
      updated: p.last_modified_t ? new Date(p.last_modified_t * 1000).toISOString().slice(0, 10) : null,
      qualityErrors: (p.data_quality_errors_tags || []).map((t) => t.replace(/^en:/, "")),
      perServingOnly: p.nutrition_data_per === "serving",
    },
    missing,
  };
}

async function getJSON(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (r.status === 404) return { status: 0 };
    if (r.status === 429) throw new Error("Open Food Facts: zu viele Anfragen – bitte kurz warten.");
    if (!r.ok) throw new Error("Open Food Facts nicht erreichbar (HTTP " + r.status + ")");
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Zeitüberschreitung bei Open Food Facts.");
    if (e instanceof TypeError) throw new Error("Keine Verbindung zu Open Food Facts (offline?).");
    throw e;
  } finally { clearTimeout(t); }
}

/** Produkt per Barcode. Gibt Food-Objekt oder null (nicht gefunden) zurück. */
export async function lookupBarcode(code) {
  const cached = cacheGet("off", code);
  if (cached && Date.now() - cached.t < 7 * 864e5) return cached.food;
  const d = await getJSON(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}&lc=de`);
  if (!d || d.status !== 1 || !d.product) return null;
  const food = productToFood({ ...d.product, code: d.product.code || code });
  cacheSet("off", code, { t: Date.now(), food });
  return food;
}

/** Online-Produktsuche (begrenzt: OFF erlaubt nur wenige Suchanfragen pro Minute). */
export async function searchProducts(q) {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=24&lc=de&cc=de&sort_by=unique_scans_n&fields=${FIELDS}`;
  const d = await getJSON(url, 15000);
  return (d.products || [])
    .filter((p) => p.nutriments && (p.nutriments["energy-kcal_100g"] != null || p.nutriments["energy-kj_100g"] != null))
    .map(productToFood);
}
