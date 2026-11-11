// KI-Funktionen. Zwei Wege:
// 1. Im Claude-Chat (Artifact): über das Claude-Konto der Person (capability "sample"),
//    kein API-Schlüssel nötig.
// 2. Als normale Website: Claude API mit eigenem Schlüssel (nur lokal gespeichert,
//    Anfragen gehen direkt vom Browser an api.anthropic.com).
import { getSettings, cacheGet, cacheSet } from "./store.js";
import { energyFromMacros } from "./nutrition.js";
import { capability, IN_CLAUDE } from "./platform.js";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (genaueste Ergebnisse, Standard)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (schneller, günstiger)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (am schnellsten, am günstigsten)" },
];

let sampleFn = null;
let sampleImages = false;
let sampleDenied = false;
/** Im Chat: Claude-Zugang über das Konto ermitteln. */
export async function initAI() {
  sampleFn = await capability("sample");
  if (sampleFn) {
    try { sampleImages = !!(await sampleFn.limits())?.images; } catch { sampleImages = false; }
  }
  return !!sampleFn;
}
/** "claude" (Konto im Chat), "api" (eigener Schlüssel) oder null. */
export function aiMode() {
  if (sampleFn && !sampleDenied) return "claude";
  return getSettings().ai.apiKey ? "api" : null;
}
export function hasKey() { return !!aiMode(); }
export function canSendImages() { return aiMode() === "claude" ? sampleImages : aiMode() === "api"; }
export function aiMissingText() {
  if (IN_CLAUDE) return sampleDenied ? "Die KI wurde für diese Seite nicht erlaubt. Lade die Seite neu, um erneut gefragt zu werden." : "KI ist in dieser Ansicht nicht verfügbar.";
  return "Für KI-Funktionen wird ein Claude-API-Schlüssel benötigt (Einstellungen → KI).";
}

let sdk = null;
async function loadSDK() { return (sdk ||= (await import("../vendor/anthropic-sdk.mjs")).Anthropic); }

let client = null, clientKey = null;
async function getClient() {
  const key = getSettings().ai.apiKey;
  if (!key) throw new Error(aiMissingText());
  const Anthropic = await loadSDK();
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 180000 });
    clientKey = key;
  }
  return client;
}

function friendlyError(e) {
  const A = sdk;
  if (A) {
    if (e instanceof A.AuthenticationError) return new Error("Der Claude-API-Schlüssel ist ungültig.");
    if (e instanceof A.PermissionDeniedError) return new Error("Der API-Schlüssel hat keine Berechtigung für dieses Modell.");
    if (e instanceof A.RateLimitError) return new Error("Claude API: Ratenlimit erreicht – bitte gleich noch einmal versuchen.");
    if (e instanceof A.BadRequestError) return new Error("Claude API hat die Anfrage abgelehnt: " + (e.error?.error?.message || e.message));
    if (e instanceof A.InternalServerError) return new Error("Claude API ist gerade überlastet – bitte erneut versuchen.");
    if (e instanceof A.APIConnectionTimeoutError) return new Error("Zeitüberschreitung bei der Claude API.");
    if (e instanceof A.APIConnectionError) return new Error("Keine Verbindung zur Claude API (offline?).");
  }
  return e instanceof Error ? e : new Error(String(e));
}

const SAMPLE_ERRORS = {
  not_granted: "Die KI wurde für diese Seite nicht erlaubt.",
  sampling_disabled: "Claude ist für dieses Konto nicht verfügbar.",
  rate_limited: "Zu viele KI-Anfragen oder Nutzungslimit erreicht – bitte später erneut versuchen.",
  session_expired: "Bitte erneut bei Claude anmelden.",
  image_rejected: "Das Bild konnte nicht verarbeitet werden. Bitte ein anderes Foto (JPEG/PNG) wählen.",
  images_unavailable: "In dieser Ansicht können keine Bilder an Claude gesendet werden.",
  refused: "Claude hat diese Anfrage abgelehnt.",
  invalid_json: "Die KI-Antwort war unvollständig. Bitte erneut versuchen.",
  empty_completion: "Die KI hat keine Antwort geliefert. Bitte erneut versuchen.",
  prompt_too_large: "Die Anfrage ist zu groß.",
  upstream_error: "Claude ist gerade nicht erreichbar. Bitte erneut versuchen.",
};

const nullable = (t) => ({ anyOf: [{ type: t }, { type: "null" }] });

/** Prüft, ob die Antwort die nötigen Felder hat (Antworten über das Konto sind nicht schemagebunden). */
function need(obj, keys) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || keys.some((k) => !(k in obj))) {
    throw new Error("Die KI-Antwort hatte ein unerwartetes Format. Bitte erneut versuchen.");
  }
  return obj;
}

/**
 * Eine Anfrage mit JSON-Ergebnis.
 * text: Aufgabe + Daten; image: {base64, mediaType, blob} optional.
 * tier: "default" | "complex" (nur im Chat relevant), effort: für die API.
 */
async function structured({ system, text, image = null, schema, effort = "medium", tier = "default" }) {
  const mode = aiMode();
  if (!mode) throw new Error(aiMissingText());

  if (mode === "claude") {
    const prompt = `${system}\n\n${text}\n\nAntworte ausschließlich mit EINEM JSON-Objekt, das genau diesem JSON-Schema entspricht (alle Pflichtfelder, keine zusätzlichen Felder, Zahlen als Zahlen, fehlende Werte als null):\n${JSON.stringify(schema)}`;
    const opts = { modelTier: tier };
    if (image) opts.images = [image.blob];
    try {
      return need(await sampleFn.json(prompt, opts), schema.required || []);
    } catch (e) {
      if (e && typeof e === "object" && "code" in e) {
        if (e.code === "not_granted" || e.code === "sampling_disabled") sampleDenied = true;
        throw new Error(SAMPLE_ERRORS[e.code] || SAMPLE_ERRORS.upstream_error);
      }
      throw e;
    }
  }

  const c = await getClient();
  const model = getSettings().ai.model || "claude-opus-5-5";
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } });
  content.push({ type: "text", text });
  const base = {
    model, max_tokens: 16000, system,
    messages: [{ role: "user", content }],
    output_config: { effort, format: { type: "json_schema", schema } },
  };
  let res;
  try {
    if (model.startsWith("claude-haiku")) {
      res = await c.messages.create(base);
    } else {
      try {
        res = await c.beta.messages.create({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
      } catch (e) {
        // Falls das Konto/Modell die Fallback-Beta nicht unterstützt: ohne erneut versuchen.
        if (e instanceof sdk.BadRequestError && /fallback/i.test(e.message)) res = await c.messages.create(base);
        else throw e;
      }
    }
  } catch (e) { throw friendlyError(e); }

  if (res.stop_reason === "refusal") throw new Error("Die KI hat diese Anfrage abgelehnt." + (res.stop_details?.explanation ? " " + res.stop_details.explanation : ""));
  if (res.stop_reason === "max_tokens") throw new Error("Die KI-Antwort war zu lang und wurde abgeschnitten. Bitte erneut versuchen.");
  const out = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(out); }
  catch { throw new Error("Die KI-Antwort konnte nicht gelesen werden."); }
}

// ------------------------------------------------------------------ Foto-Analyse
const NUTR_LABEL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["product_name", "brand", "basis", "portion_size", "kcal", "kj", "fat", "sat", "carb", "sugar", "fibre", "protein", "salt"],
  properties: {
    product_name: nullable("string"), brand: nullable("string"),
    basis: { type: "string", enum: ["100g", "100ml", "portion", "unbekannt"] },
    portion_size: nullable("number"),
    kcal: nullable("number"), kj: nullable("number"), fat: nullable("number"), sat: nullable("number"),
    carb: nullable("number"), sugar: nullable("number"), fibre: nullable("number"), protein: nullable("number"), salt: nullable("number"),
  },
};

const IMAGE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["kind", "items", "label", "barcode", "comment"],
  properties: {
    kind: { type: "string", enum: ["mahlzeit", "naehrwerttabelle", "verpackung", "kein_essen"] },
    items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "search_terms", "preparation", "grams", "grams_min", "grams_max", "confidence", "basis"],
        properties: {
          name: { type: "string", description: "Deutscher Name des Lebensmittels/der Komponente" },
          search_terms: { type: "array", items: { type: "string" }, description: "2–4 deutsche Suchbegriffe im Stil des Bundeslebensmittelschlüssels, vom genauesten zum allgemeinsten" },
          preparation: { type: "string", description: "z. B. roh, gekocht, gebraten, frittiert, gebacken" },
          grams: { type: "number", description: "Beste Schätzung der verzehrten Menge in Gramm (essbarer Anteil)" },
          grams_min: { type: "number" }, grams_max: { type: "number" },
          confidence: { type: "string", enum: ["hoch", "mittel", "niedrig"] },
          basis: { type: "string", description: "Woran die Mengenschätzung festgemacht wurde (Referenzobjekte, Tellergröße …)" },
        },
      },
    },
    label: { anyOf: [NUTR_LABEL_SCHEMA, { type: "null" }] },
    barcode: nullable("string"),
    comment: { type: "string" },
  },
};

const IMAGE_SYSTEM = `Du bist ein sorgfältiger Ernährungswissenschaftler und analysierst Fotos für einen Kalorientracker.
Regeln:
- Erkenne jede einzelne essbare Komponente getrennt (z. B. Reis, Hähnchen, Sauce, Öl/Butter, Getränk). Versteckte Fette (Bratfett, Dressing) als eigene Komponente aufführen, wenn sichtbar oder sehr wahrscheinlich, mit niedriger Konfidenz.
- Schätze die Menge in Gramm des essbaren Anteils so genau wie möglich. Nutze Referenzen im Bild (Teller ≈ 26–28 cm, Gabel ≈ 19 cm, Hand, Verpackungsangaben). Gib eine realistische Spanne an.
- Suchbegriffe auf Deutsch im Stil des Bundeslebensmittelschlüssels: Grundlebensmittel mit Zubereitung, z. B. "Hähnchen Brustfilet gebraten", "Reis poliert gekocht", "Kartoffel gekocht", "Teigwaren gekocht", "Olivenöl". Ganze Gerichte zusätzlich als Gericht (z. B. "Pizza Margherita"), wenn es eine typische Speise ist.
- Ist eine Nährwerttabelle lesbar, übertrage die Werte exakt (Zahlen wie gedruckt, Komma als Dezimaltrennzeichen beachten) in "label" und setze kind="naehrwerttabelle". Bezugsgröße (100 g / 100 ml / Portion) genau angeben. Nichts erfinden: nicht lesbare Werte = null.
- Ist ein Barcode mit lesbaren Ziffern sichtbar, gib die Ziffern in "barcode" an, sonst null.
- Keine Nährwerte für Mahlzeiten schätzen – die kommen aus der offiziellen Datenbank. Nur erkennen und Mengen schätzen.
- "comment": 1–2 Sätze auf Deutsch zu Unsicherheiten.`;

/** Analysiert ein Foto. image = {base64, mediaType, blob} aus prepareImage(). */
export async function analyzeImage(image, hint = "") {
  const r = await structured({
    system: IMAGE_SYSTEM,
    effort: "high",
    tier: "complex",
    schema: IMAGE_SCHEMA,
    image,
    text: "Analysiere das beigefügte Foto." + (hint ? ` Zusatzinfo vom Nutzer: ${hint}` : ""),
  });
  if (!Array.isArray(r.items)) r.items = [];
  r.items = r.items.filter((it) => it && typeof it.name === "string").map((it) => ({
    ...it,
    search_terms: Array.isArray(it.search_terms) ? it.search_terms.map(String) : [it.name],
    preparation: it.preparation || "",
    grams: Number(it.grams) || 100,
    grams_min: Number(it.grams_min) || Number(it.grams) || 0,
    grams_max: Number(it.grams_max) || Number(it.grams) || 0,
    confidence: ["hoch", "mittel", "niedrig"].includes(it.confidence) ? it.confidence : "mittel",
    basis: it.basis || "",
  }));
  r.comment = r.comment || "";
  return r;
}

// ------------------------------------------------------------------ Zuordnung zur Datenbank
const MATCH_SCHEMA = {
  type: "object", additionalProperties: false, required: ["matches"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["item", "code", "grams", "reason"],
        properties: {
          item: { type: "integer" },
          code: nullable("string"),
          grams: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
  },
};

/**
 * Lässt die KI für jede erkannte Komponente den passendsten offiziellen Datenbankeintrag wählen.
 * items: [{name, preparation, grams, candidates:[{code, name, kcal}]}]
 */
export async function matchToDatabase(items) {
  const lines = items.map((it, i) => {
    const cands = it.candidates.map((c) => `   - ${c.code} | ${c.name} | ${c.kcal} kcal/100 g`).join("\n");
    return `#${i} ${it.name} (${it.preparation}), geschätzt ${it.grams} g\n${cands || "   (keine Kandidaten gefunden)"}`;
  }).join("\n\n");
  return structured({
    system: `Du ordnest erkannte Lebensmittel Einträgen des Bundeslebensmittelschlüssels (BLS 4.0) zu.
Wähle je Komponente genau den Kandidaten, der Lebensmittel UND Zubereitungsart am besten trifft (roh vs. gekocht ist für die Nährwerte entscheidend). Wähle nur Codes aus der jeweiligen Kandidatenliste. Passt keiner hinreichend, setze code = null.
Passe "grams" nur an, wenn der gewählte Eintrag einen anderen Zustand beschreibt als geschätzt (z. B. Trockengewicht vs. gekocht), sonst übernimm die Schätzung. "reason": kurz auf Deutsch.`,
    effort: "medium",
    schema: MATCH_SCHEMA,
    text: lines,
  });
}

// ------------------------------------------------------------------ Prüfung von Nährwerten
const VERIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["verdict", "summary", "issues"],
  properties: {
    verdict: { type: "string", enum: ["plausibel", "auffaellig", "unplausibel"] },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["nutrient", "given", "expected", "comment"],
        properties: { nutrient: { type: "string" }, given: { type: "string" }, expected: { type: "string" }, comment: { type: "string" } },
      },
    },
  },
};

function verifyId(food) { return (food.source?.type || "x") + ":" + (food.source?.ref || food.name) + ":" + JSON.stringify(food.per100); }
export function cachedVerification(food) { return cacheGet("verify", verifyId(food)) || null; }

/** KI-Gegenprüfung der Nährwerte je 100 g gegen Referenzwerte aus amtlichen Nährwerttabellen. */
export async function verifyFood(food, { force = false } = {}) {
  const id = verifyId(food);
  if (!force) { const c = cacheGet("verify", id); if (c) return c; }
  const p = food.per100;
  const calc = energyFromMacros(p);
  const u = food.unit === "ml" ? "100 ml" : "100 g";
  const v = (x) => (x == null ? "k. A." : String(x));
  const text = `Lebensmittel: ${food.name}${food.brand ? " (Marke: " + food.brand + ")" : ""}
Quelle der Werte: ${food.source?.label || "unbekannt"}${food.source?.official ? " (amtliche Nährstoffdatenbank)" : ""}
Werte je ${u}:
- Energie: ${v(p.kcal)} kcal / ${v(p.kj)} kJ (aus Makros nach LMIV berechnet: ${calc.kcal.toFixed(1)} kcal)
- Fett: ${v(p.fat)} g, davon gesättigt: ${v(p.sat)} g
- Kohlenhydrate (verwertbar): ${v(p.carb)} g, davon Zucker: ${v(p.sugar)} g, mehrwertige Alkohole: ${v(p.polyols)} g
- Ballaststoffe: ${v(p.fibre)} g
- Eiweiß: ${v(p.protein)} g
- Salz: ${v(p.salt)} g
- Alkohol: ${v(p.alcohol)} g`;
  const result = await structured({
    system: `Du prüfst Nährwertangaben auf Plausibilität. Vergleiche mit Referenzwerten amtlicher Nährwerttabellen (Bundeslebensmittelschlüssel, USDA FoodData Central, CoFID) bzw. mit typischen Werten vergleichbarer Produkte.
- "plausibel": alle Werte im üblichen Bereich für dieses Lebensmittel.
- "auffaellig": einzelne Werte ungewöhnlich, aber möglich (z. B. Rezepturunterschiede, Zubereitung).
- "unplausibel": Werte sind sehr wahrscheinlich falsch (Tippfehler, falsche Bezugsgröße, Einheiten vertauscht, falsches Produkt).
Berücksichtige: EU-Angaben nennen verwertbare Kohlenhydrate ohne Ballaststoffe; US-Angaben enthalten Ballaststoffe in den Kohlenhydraten. Werte amtlicher Datenbanken sind Analysen bzw. Mittelwerte und können von Einzelprodukten abweichen.
Nenne in "issues" nur echte Abweichungen mit erwartetem Bereich. "summary": 1–2 Sätze auf Deutsch.`,
    effort: "medium",
    schema: VERIFY_SCHEMA,
    text,
  });
  if (!["plausibel", "auffaellig", "unplausibel"].includes(result.verdict)) throw new Error("Die KI-Antwort hatte ein unerwartetes Format. Bitte erneut versuchen.");
  if (!Array.isArray(result.issues)) result.issues = [];
  result.checkedAt = new Date().toISOString();
  result.model = aiMode() === "claude" ? "Claude (Konto)" : getSettings().ai.model;
  cacheSet("verify", id, result);
  return result;
}

// ------------------------------------------------------------------ Tagesprüfung
const DAY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["entry", "severity", "text"],
        properties: { entry: nullable("string"), severity: { type: "string", enum: ["info", "warnung"] }, text: { type: "string" } },
      },
    },
  },
};

export async function reviewDay(entries, totals, goals) {
  const list = entries.map((e) => `- ${e.name}${e.brand ? " (" + e.brand + ")" : ""}: ${e.grams} ${e.unit || "g"}, ${Math.round(e.kcal)} kcal [Quelle: ${e.source?.label || "?"}]`).join("\n");
  return structured({
    system: `Du prüfst ein Ernährungstagebuch auf Eingabefehler (unrealistische Mengen, vertauschte Einheiten, doppelte Einträge, falsche Lebensmittelzuordnung, z. B. roh statt gekocht). Gib keine Ernährungsberatung und keine medizinischen Ratschläge, nur Hinweise zur Datenqualität. Antworte knapp auf Deutsch.`,
    effort: "medium",
    schema: DAY_SCHEMA,
    text: `Einträge:\n${list || "(keine)"}\n\nSumme: ${Math.round(totals.kcal)} kcal, Eiweiß ${totals.protein.toFixed(1)} g, KH ${totals.carb.toFixed(1)} g, Fett ${totals.fat.toFixed(1)} g. Ziel: ${goals.kcal} kcal.`,
  }).then((r) => ({ summary: String(r.summary || ""), findings: Array.isArray(r.findings) ? r.findings : [] }));
}

/** Testet den Schlüssel mit einer minimalen Anfrage. */
export async function testKey() {
  if (aiMode() === "claude") { await structured({ system: "Verbindungstest.", text: "Gib {\"ok\": true} zurück.", schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, tier: "quick" }); return true; }
  const c = await getClient();
  try {
    const r = await c.messages.create({ model: getSettings().ai.model, max_tokens: 64, output_config: { effort: "low" }, messages: [{ role: "user", content: "Antworte nur mit: OK" }] });
    return r.content.some((b) => b.type === "text");
  } catch (e) { throw friendlyError(e); }
}
