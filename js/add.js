// Hinzufügen von Lebensmitteln: Suche, Barcode, Foto (KI), eigene Eingabe, Detailansicht.
import { esc, $, $$, openSheet, replaceSheet, closeSheet, toast, loadingHTML } from "./ui.js";
import { loadDB, search, candidates, foodByCode, groupList, db } from "./db.js";
import { NUTRIENTS, scale, validate, fmt, fmtKcal, energyFromMacros } from "./nutrition.js";
import { MEALS, addEntry, updateEntry, removeEntry, getRecent, getFavs, isFav, toggleFav, saveCustomFood, getSettings } from "./store.js";
import { lookupBarcode, searchProducts, validGtin } from "./off.js";
import { hasKey, analyzeImage, matchToDatabase, verifyFood, cachedVerification, aiMissingText, canSendImages } from "./ai.js";
import { IN_CLAUDE } from "./platform.js";
import { startStream, stopStream, scanBarcodes, grabFrame, prepareImage, decodeImageBarcode, cameraSupported } from "./camera.js";

let ctx = { dayKey: null, meal: "breakfast", onChange: () => {} };
export function setContext(c) { ctx = { ...ctx, ...c }; }

export function defaultMeal(d = new Date()) {
  const m = d.getHours() * 60 + d.getMinutes();
  if (m < 10 * 60 + 30) return "breakfast";
  if (m < 14 * 60 + 30) return "lunch";
  if (m < 17 * 60 + 30) return "snacks";
  if (m < 21 * 60 + 30) return "dinner";
  return "snacks";
}
const mealLabel = (id) => MEALS.find((m) => m.id === id)?.label || id;
const unitOf = (f) => f.unit || "g";

// ------------------------------------------------------------------ Badges
export function sourceBadge(f) {
  const s = f.source || {};
  if (s.type === "bls") return `<span class="badge ok" title="Amtliche Nährstoffdatenbank">✓ Amtlich · ${esc(s.label)}</span>`;
  if (s.type === "off") return `<span class="badge src" title="Herstellerangabe aus Open Food Facts">Etikett · Open Food Facts</span>`;
  if (s.type === "label") return `<span class="badge src">Etikett · Foto</span>`;
  if (s.type === "custom") return `<span class="badge src">Eigener Eintrag</span>`;
  if (s.type === "quick") return `<span class="badge src">Schnelleintrag</span>`;
  return "";
}
export function checkBadges(f) {
  const out = [];
  if (f.source?.type !== "quick") {
    const v = validate(f.per100, { declared: !!f.source?.declared, unit: unitOf(f) });
    if (v.level === "bad") out.push(`<span class="badge bad">✕ Regelprüfung</span>`);
    else if (v.level === "warn") out.push(`<span class="badge warn">! Regelprüfung</span>`);
  }
  const ai = cachedVerification(f);
  if (ai) out.push(aiBadge(ai.verdict));
  return out.join("");
}
function aiBadge(verdict) {
  if (verdict === "plausibel") return `<span class="badge ok">✓ KI geprüft</span>`;
  if (verdict === "auffaellig") return `<span class="badge warn">! KI: auffällig</span>`;
  return `<span class="badge bad">✕ KI: unplausibel</span>`;
}

function resultItem(f, i) {
  const u = unitOf(f);
  return `<li data-i="${i}">
    ${f.image ? `<img src="${esc(f.image)}" alt="" loading="lazy">` : ""}
    <div class="r-main">
      <div class="r-name">${esc(f.name)}</div>
      <div class="sub">${f.brand ? esc(f.brand) + " · " : ""}${f.groupLabel ? esc(f.groupLabel) : ""}</div>
      <div class="badges">${sourceBadge(f)}${checkBadges(f)}</div>
    </div>
    <div class="r-kcal num">${fmtKcal(f.per100.kcal)} kcal<div class="muted">/100 ${u}</div></div>
  </li>`;
}
function bindResults(ul, list, onPick) {
  ul.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) onPick(list[+li.dataset.i]);
  });
}

// ------------------------------------------------------------------ Einstieg
export function openAdd(meal, tab = "search") {
  ctx.meal = meal || defaultMeal();
  ctx.lastTab = tab;
  openSheet("Hinzufügen", (b) => renderAdd(b, tab));
}

function renderAdd(b, tab) {
  b.innerHTML = `
    <label class="field" style="margin-top:0">Mahlzeit
      <select id="mealSel">${MEALS.map((m) => `<option value="${m.id}" ${m.id === ctx.meal ? "selected" : ""}>${m.label}</option>`).join("")}</select>
    </label>
    <div class="seg" role="tablist">
      <button data-t="search">Suche</button><button data-t="barcode">Barcode</button>
      <button data-t="photo">Foto (KI)</button><button data-t="custom">Eigenes</button>
    </div>
    <div id="addPane"></div>`;
  $("#mealSel", b).addEventListener("change", (e) => { ctx.meal = e.target.value; });
  let cleanup = null;
  const pane = $("#addPane", b);
  const go = (t) => {
    ctx.lastTab = t;
    if (cleanup) { cleanup(); cleanup = null; }
    $$(".seg button", b).forEach((x) => x.classList.toggle("active", x.dataset.t === t));
    pane.innerHTML = "";
    cleanup = ({ search: paneSearch, barcode: paneBarcode, photo: panePhoto, custom: paneCustom }[t])(pane) || null;
  };
  $$(".seg button", b).forEach((x) => x.addEventListener("click", () => go(x.dataset.t)));
  go(ctx.lastTab || tab);
  return () => { if (cleanup) cleanup(); };
}

// ------------------------------------------------------------------ Suche
function paneSearch(p) {
  p.innerHTML = `
    <div class="search-box">
      <input type="search" id="q" placeholder="z. B. Haferflocken, Banane, Hähnchenbrust …" autocomplete="off" enterkeyhint="search">
      <div class="chips" id="groups" style="margin-top:8px"></div>
    </div>
    <div id="res"></div>`;
  const q = $("#q", p), res = $("#res", p), groups = $("#groups", p);
  let group = null, timer = null;

  loadDB().then(() => {
    groups.innerHTML = `<button class="chip active" data-g="">Alle</button>` + groupList().map((g) => `<button class="chip" data-g="${g.key}">${esc(g.label)}</button>`).join("");
    groups.addEventListener("click", (e) => {
      const c = e.target.closest(".chip"); if (!c) return;
      group = c.dataset.g || null;
      $$(".chip", groups).forEach((x) => x.classList.toggle("active", x === c));
      run();
    });
    run();
  }).catch((e) => { res.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; });

  function showStart() {
    const favs = getFavs(), rec = getRecent();
    if (!favs.length && !rec.length) {
      res.innerHTML = `<div class="empty">Tippe einen Suchbegriff ein. Die Datenbank enthält ${db() ? db().foods.length.toLocaleString("de-DE") : "über 7.000"} Lebensmittel aus dem Bundeslebensmittelschlüssel (BLS 4.0) und weiteren amtlichen Quellen.</div>`;
      return;
    }
    let html = "";
    if (favs.length) html += `<div class="section-label">Favoriten</div><ul class="results" id="favList">${favs.map(resultItem).join("")}</ul>`;
    if (rec.length) html += `<div class="section-label">Zuletzt verwendet</div><ul class="results" id="recList">${rec.slice(0, 20).map(resultItem).join("")}</ul>`;
    res.innerHTML = html;
    if (favs.length) bindResults($("#favList", res), favs, (f) => openDetail(f));
    if (rec.length) bindResults($("#recList", res), rec, (f) => openDetail(f, { grams: f.lastGrams }));
  }

  function run() {
    const term = q.value.trim();
    if (!term && !group) return showStart();
    const list = term ? search(term, { group, limit: 80 }) : db().foods.filter((r) => r[0][0] === group || (group === "X" && r[0][0] === "Y")).slice(0, 200).map((r) => foodByCode(r[0]));
    res.innerHTML = (list.length ? `<ul class="results" id="rl">${list.map(resultItem).join("")}</ul>` : `<div class="empty">Kein Treffer in der amtlichen Datenbank.</div>`) +
      (term && !IN_CLAUDE ? `<button class="btn block" id="offBtn" style="margin-top:12px">🔎 „${esc(term)}“ in Open Food Facts suchen (Markenprodukte)</button><div id="offRes"></div>` : "");
    if (list.length) bindResults($("#rl", res), list, (f) => openDetail(f));
    const ob = $("#offBtn", res);
    if (ob) ob.addEventListener("click", async () => {
      const box = $("#offRes", res);
      ob.disabled = true;
      box.innerHTML = loadingHTML("Suche in Open Food Facts …");
      try {
        const prods = await searchProducts(term);
        box.innerHTML = prods.length
          ? `<div class="section-label">Markenprodukte (Herstellerangaben)</div><ul class="results" id="offl">${prods.map(resultItem).join("")}</ul>`
          : `<div class="empty">Keine Produkte gefunden.</div>`;
        if (prods.length) bindResults($("#offl", box), prods, (f) => openDetail(f));
      } catch (e) { box.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
      ob.disabled = false;
    });
  }
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  setTimeout(() => q.focus(), 50);
}

// ------------------------------------------------------------------ Barcode
function paneBarcode(p) {
  p.innerHTML = `
    <div class="cam" id="cam" ${cameraSupported() ? "" : "hidden"}>
      <video id="vid" playsinline muted></video>
      <div class="scan-frame"></div><div class="scan-line"></div>
      <div class="cam-msg" id="camMsg">Kamera wird gestartet …</div>
    </div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn" id="camToggle">${cameraSupported() ? "Kamera stoppen" : "Kamera nicht verfügbar"}</button>
      <label class="btn">Barcode-Foto wählen<input type="file" accept="image/*" id="bcFile" hidden></label>
    </div>
    <label class="field">Barcode manuell eingeben (EAN/GTIN)
      <div style="display:flex;gap:8px"><input type="text" inputmode="numeric" id="ean" placeholder="z. B. 4000417025005" maxlength="14"><button class="btn primary" id="eanGo">Suchen</button></div>
    </label>
    <div id="bcRes"></div>
    ${IN_CLAUDE ? `<div class="notice warn">In der Chat-Version sind Live-Kamera und die Produktdatenbank (Open Food Facts) technisch gesperrt. Ein Barcode wird zwar aus dem Foto gelesen, die Produktdaten lassen sich hier aber nicht abrufen. Fotografiere stattdessen die <b>Nährwerttabelle</b> (Tab „Foto (KI)“) – die KI liest die Werte ab.</div>` : `<p class="muted">Produktdaten stammen aus Open Food Facts (Herstellerangaben vom Etikett, ODbL). Sie werden automatisch auf Plausibilität geprüft${hasKey() ? " – auch durch die KI" : ""}.</p>`}`;
  const vid = $("#vid", p), msg = $("#camMsg", p), out = $("#bcRes", p);
  let stream = null, stopScan = null, busy = false;

  async function start() {
    if (!cameraSupported()) return;
    try {
      stream = await startStream(vid);
      msg.textContent = "Barcode in den Rahmen halten";
      stopScan = await scanBarcodes(vid, (code) => { lookup(code); });
      $("#camToggle", p).textContent = "Kamera stoppen";
    } catch (e) { msg.textContent = e.message; $("#camToggle", p).textContent = "Kamera starten"; }
  }
  function stop() { if (stopScan) stopScan(); stopScan = null; stopStream(stream); stream = null; }

  async function lookup(code) {
    if (busy) return;
    busy = true;
    stop();
    if (navigator.vibrate) navigator.vibrate(60);
    $("#ean", p).value = code;
    out.innerHTML = loadingHTML(`Suche Produkt ${code} …`);
    try {
      const f = await lookupBarcode(code);
      if (!f) {
        out.innerHTML = `<div class="notice warn"><p><b>Produkt ${esc(code)} nicht gefunden.</b></p><p>Du kannst die Nährwerttabelle fotografieren (Tab „Foto (KI)“) oder die Werte unter „Eigenes“ eingeben.</p></div>
          <div class="btn-row"><button class="btn" id="toPhoto">Nährwerttabelle fotografieren</button><button class="btn" id="toCustom">Selbst eingeben</button></div>`;
        $("#toPhoto", out).onclick = () => $$(".seg button").find((x) => x.dataset.t === "photo").click();
        $("#toCustom", out).onclick = () => $$(".seg button").find((x) => x.dataset.t === "custom").click();
      } else {
        out.innerHTML = "";
        openDetail(f);
      }
    } catch (e) { out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
    busy = false;
    $("#camToggle", p).textContent = "Erneut scannen";
  }

  $("#camToggle", p).addEventListener("click", () => { if (stream) { stop(); $("#camToggle", p).textContent = "Kamera starten"; msg.textContent = "Kamera gestoppt"; } else { out.innerHTML = ""; start(); } });
  $("#eanGo", p).addEventListener("click", () => {
    const c = $("#ean", p).value.replace(/\D/g, "");
    const code = c.length === 12 ? "0" + c : c;
    if (!validGtin(code)) { out.innerHTML = `<div class="notice bad">„${esc(c)}“ ist kein gültiger EAN/GTIN-Code (Prüfziffer falsch oder falsche Länge).</div>`; return; }
    lookup(code);
  });
  $("#ean", p).addEventListener("keydown", (e) => { if (e.key === "Enter") $("#eanGo", p).click(); });
  $("#bcFile", p).addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    out.innerHTML = loadingHTML("Lese Barcode aus Bild …");
    try {
      const { img } = await prepareImage(file, 2000);
      const code = await decodeImageBarcode(img);
      if (code) lookup(code);
      else out.innerHTML = `<div class="notice warn">Kein Barcode erkannt. Bitte näher und scharf fotografieren oder Ziffern manuell eingeben.</div>`;
    } catch (err) { out.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`; }
  });
  start();
  return stop;
}

// ------------------------------------------------------------------ Foto (KI)
function panePhoto(p) {
  if (!hasKey() || !canSendImages()) {
    p.innerHTML = `<div class="notice warn"><p><b>Fotoerkennung ist gerade nicht verfügbar.</b></p>
      <p>${esc(hasKey() ? "In dieser Ansicht können keine Bilder an Claude gesendet werden." : aiMissingText())}</p></div>
      <p class="sub">Suche, Barcode und eigene Eingaben funktionieren weiterhin vollständig.</p>`;
    return;
  }
  p.innerHTML = `
    <p class="sub" style="margin-top:0">Fotografiere deine Mahlzeit oder eine Nährwerttabelle. Die KI erkennt die Lebensmittel und schätzt die Mengen – die Nährwerte kommen anschließend aus der amtlichen Datenbank.</p>
    <div class="cam" id="cam" hidden><video id="vid" playsinline muted></video><div class="cam-msg">Mahlzeit von schräg oben, gut beleuchtet</div></div>
    <div class="btn-row" style="margin-top:10px" id="photoBtns">
      ${cameraSupported() ? `<button class="btn primary" id="liveCam">📷 Foto schießen</button>` : ""}
      <label class="btn">🖼 Foto hochladen<input type="file" accept="image/*" id="upl" hidden></label>
      <label class="btn">📱 Kamera-App<input type="file" accept="image/*" capture="environment" id="cap" hidden></label>
    </div>
    <div class="btn-row" id="shutterRow" hidden style="margin-top:10px">
      <button class="btn primary" id="shutter">Auslösen</button><button class="btn" id="camCancel">Abbrechen</button>
    </div>
    <label class="field">Zusatzinfo (optional)
      <input type="text" id="hint" placeholder="z. B. „in 1 EL Olivenöl gebraten“, „großer Teller“, „halbe Portion gegessen“">
    </label>
    <div id="phRes"></div>`;
  const vid = $("#vid", p), cam = $("#cam", p), out = $("#phRes", p);
  let stream = null;
  const stop = () => { stopStream(stream); stream = null; cam.hidden = true; $("#shutterRow", p).hidden = true; $("#photoBtns", p).hidden = false; };

  const live = $("#liveCam", p);
  if (live) live.addEventListener("click", async () => {
    out.innerHTML = "";
    try {
      cam.hidden = false; $("#photoBtns", p).hidden = true; $("#shutterRow", p).hidden = false;
      stream = await startStream(vid, { width: 2560, height: 1920 });
    } catch (e) { stop(); out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
  });
  $("#shutter", p).addEventListener("click", async () => { const blob = await grabFrame(vid); stop(); handle(blob); });
  $("#camCancel", p).addEventListener("click", stop);
  for (const id of ["upl", "cap"]) $("#" + id, p).addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) handle(f); });

  async function handle(blob) {
    out.innerHTML = loadingHTML("Bild wird vorbereitet …");
    let prep;
    try { prep = await prepareImage(blob); } catch (e) { out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; return; }
    out.innerHTML = `<img class="preview-img" src="${prep.dataUrl}" alt="Aufgenommenes Foto"><div id="phStep">${loadingHTML("KI analysiert das Foto … (kann bis zu einer Minute dauern)")}</div>`;
    const step = $("#phStep", out);
    // Barcode lokal versuchen (schnell, ohne KI)
    const localCode = await decodeImageBarcode(prep.img).catch(() => null);
    let analysis;
    try {
      analysis = await analyzeImage(prep, $("#hint", p).value.trim());
    } catch (e) {
      step.innerHTML = `<div class="notice bad">${esc(e.message)}</div>` + (localCode ? barcodeOffer(localCode) : "");
      bindBarcodeOffer(step);
      return;
    }
    const code = localCode || (analysis.barcode && validGtin(analysis.barcode.replace(/\D/g, "")) ? analysis.barcode.replace(/\D/g, "") : null);
    if (analysis.kind === "naehrwerttabelle" && analysis.label) {
      step.innerHTML = (code ? barcodeOffer(code) : "") + `<div class="notice">${esc(analysis.comment)}</div>`;
      bindBarcodeOffer(step);
      const l = analysis.label;
      const factor = l.basis === "portion" && l.portion_size > 0 ? 100 / l.portion_size : 1;
      const conv = (v) => (v == null ? null : +(v * factor).toFixed(3));
      const draft = {
        name: l.product_name || "Produkt (Etikett)", brand: l.brand || "",
        unit: l.basis === "100ml" ? "ml" : "g",
        per100: { kcal: conv(l.kcal), kj: conv(l.kj), fat: conv(l.fat), sat: conv(l.sat), carb: conv(l.carb), sugar: conv(l.sugar), polyols: null, fibre: conv(l.fibre), protein: conv(l.protein), salt: conv(l.salt), alcohol: null, acids: null },
        portions: l.portion_size ? [{ label: `1 Portion lt. Etikett (${fmt(l.portion_size)} ${l.basis === "100ml" ? "ml" : "g"})`, g: l.portion_size }] : [],
        source: { type: "label", official: false, declared: true, label: "Etikett (Foto, KI-gelesen)" },
      };
      const box = document.createElement("div");
      step.appendChild(box);
      box.innerHTML = `<div class="notice warn">Bitte die gelesenen Werte mit dem Etikett vergleichen${l.basis === "portion" ? " (von Portion auf 100 g umgerechnet)" : ""}.</div>`;
      const formBox = document.createElement("div"); box.appendChild(formBox);
      customForm(formBox, draft);
      return;
    }
    if (analysis.kind === "verpackung" && code) {
      step.innerHTML = barcodeOffer(code) + `<div class="notice">${esc(analysis.comment)}</div>`;
      bindBarcodeOffer(step);
      if (!analysis.items.length) return;
    }
    if (!analysis.items.length) {
      step.innerHTML = (code ? barcodeOffer(code) : "") + `<div class="notice warn">Keine Lebensmittel erkannt. ${esc(analysis.comment)}</div>`;
      bindBarcodeOffer(step);
      return;
    }
    step.innerHTML = loadingHTML("Ordne Lebensmittel der amtlichen Datenbank zu …");
    await loadDB();
    const items = analysis.items.map((it) => {
      const cands = candidates([...it.search_terms, `${it.name} ${it.preparation}`, it.name], 14);
      return { ...it, candidates: cands };
    });
    let matches = [];
    try {
      const m = await matchToDatabase(items.map((it) => ({ name: it.name, preparation: it.preparation, grams: it.grams, candidates: it.candidates.map((c) => ({ code: c.source.ref, name: c.name, kcal: Math.round(c.per100.kcal) })) })));
      matches = Array.isArray(m?.matches) ? m.matches : [];
    } catch (e) {
      step.innerHTML = `<div class="notice warn">Automatische Zuordnung fehlgeschlagen (${esc(e.message)}). Bitte unten manuell wählen.</div>`;
    }
    items.forEach((it, i) => {
      const m = matches.find((x) => x.item === i);
      const ok = m && m.code && it.candidates.some((c) => c.source.ref === m.code);
      it.chosen = ok ? m.code : it.candidates[0]?.source.ref || null;
      it.finalGrams = Math.round(m && m.grams > 0 ? m.grams : it.grams);
      it.reason = m?.reason || "";
      it.include = !!it.chosen;
    });
    renderReview(step, items, analysis.comment, code);
  }
  return stop;
}

function barcodeOffer(code) {
  return `<div class="notice ok"><p>Barcode <b>${esc(code)}</b> erkannt.</p><button class="btn" data-bc="${esc(code)}">Produkt nachschlagen</button></div>`;
}
function bindBarcodeOffer(root) {
  $$("[data-bc]", root).forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = "Suche …";
    try {
      const f = await lookupBarcode(b.dataset.bc);
      if (f) openDetail(f); else { b.textContent = "Nicht in Open Food Facts gefunden"; }
    } catch (e) { b.textContent = e.message; }
  }));
}

function renderReview(step, items, comment, code) {
  const conf = { hoch: "ok", mittel: "warn", niedrig: "bad" };
  step.innerHTML = (code ? barcodeOffer(code) : "") +
    `<div class="notice">${esc(comment)}</div>
    <div id="items">${items.map((it, i) => {
      const f = it.chosen ? it.candidates.find((c) => c.source.ref === it.chosen) : null;
      return `<div class="ai-item ${it.include ? "" : "off"}" data-i="${i}">
        <div class="ai-top"><input type="checkbox" class="inc" ${it.include ? "checked" : ""} ${it.candidates.length ? "" : "disabled"} aria-label="${esc(it.name)} übernehmen">
          <div style="flex:1;min-width:0"><b>${esc(it.name)}</b> <span class="muted">${esc(it.preparation)}</span>
            <div class="badges"><span class="badge ${conf[it.confidence]}">Sicherheit: ${esc(it.confidence)}</span><span class="badge">Spanne ${Math.round(it.grams_min)}–${Math.round(it.grams_max)} g</span></div>
          </div>
          <div class="num" style="font-weight:700" data-kcal>${f ? fmtKcal(f.per100.kcal * it.finalGrams / 100) + " kcal" : "–"}</div>
        </div>
        ${it.candidates.length ? `<label class="field">Datenbankeintrag (amtlich)
          <select class="cand">${it.candidates.map((c) => `<option value="${esc(c.source.ref)}" ${c.source.ref === it.chosen ? "selected" : ""}>${esc(c.name)} – ${fmtKcal(c.per100.kcal)} kcal/100 g</option>`).join("")}</select></label>
        <div class="grid2"><label class="field">Menge (g)<input type="number" class="gr" min="0" step="1" value="${it.finalGrams}" inputmode="decimal"></label>
          <div class="muted" style="align-self:center">${esc(it.basis)}${it.reason ? "<br>Zuordnung: " + esc(it.reason) : ""}</div></div>`
        : `<div class="notice warn">Kein passender Eintrag gefunden – bitte über die Suche hinzufügen.</div>`}
      </div>`;
    }).join("")}</div>
    <div id="sumLine" class="card-head" style="margin-top:8px"></div>
    <button class="btn primary block" id="addAll">Zu ${esc(mealLabel(ctx.meal))} hinzufügen</button>
    <p class="muted">Mengen sind KI-Schätzungen aus dem Foto – bitte prüfen und ggf. anpassen. Nährwerte: amtliche Datenbank (BLS 4.0).</p>`;
  bindBarcodeOffer(step);
  const upd = () => {
    let total = 0;
    $$(".ai-item", step).forEach((el) => {
      const it = items[+el.dataset.i];
      const f = it.chosen ? it.candidates.find((c) => c.source.ref === it.chosen) : null;
      const k = f ? f.per100.kcal * (it.finalGrams || 0) / 100 : 0;
      $("[data-kcal]", el).textContent = f ? fmtKcal(k) + " kcal" : "–";
      el.classList.toggle("off", !it.include);
      if (it.include) total += k;
    });
    $("#sumLine", step).innerHTML = `<span class="sub">Summe ausgewählt</span><b class="num">${fmtKcal(total)} kcal</b>`;
  };
  $$(".ai-item", step).forEach((el) => {
    const it = items[+el.dataset.i];
    $(".inc", el).addEventListener("change", (e) => { it.include = e.target.checked; upd(); });
    const sel = $(".cand", el); if (sel) sel.addEventListener("change", (e) => { it.chosen = e.target.value; upd(); });
    const gr = $(".gr", el); if (gr) gr.addEventListener("input", (e) => { it.finalGrams = Math.max(0, parseFloat(e.target.value.replace(",", ".")) || 0); upd(); });
  });
  upd();
  $("#addAll", step).addEventListener("click", () => {
    let n = 0;
    for (const it of items) {
      if (!it.include || !it.chosen || !(it.finalGrams > 0)) continue;
      const f = it.candidates.find((c) => c.source.ref === it.chosen);
      addEntry(ctx.dayKey, entryFromFood(f, it.finalGrams, { aiPhoto: { estimate: it.grams, min: it.grams_min, max: it.grams_max, confidence: it.confidence } }));
      n++;
    }
    if (!n) return toast("Nichts ausgewählt.");
    toast(`${n} Lebensmittel hinzugefügt`);
    closeSheet();
    ctx.onChange();
  });
}

// ------------------------------------------------------------------ Eigene Eingabe
function paneCustom(p) {
  p.innerHTML = `<div class="seg" style="grid-auto-columns:auto"><button data-m="food" class="active">Lebensmittel (je 100 g)</button><button data-m="quick">Schnelleintrag (kcal)</button></div><div id="cBox"></div>`;
  const box = $("#cBox", p);
  const go = (m) => {
    $$(".seg button", p).forEach((x) => x.classList.toggle("active", x.dataset.m === m));
    if (m === "food") customForm(box, null); else quickForm(box);
  };
  $$(".seg button", p).forEach((x) => x.addEventListener("click", () => go(x.dataset.m)));
  go("food");
}

function numVal(el) { const v = el.value.trim().replace(",", "."); return v === "" ? null : (isNaN(+v) ? NaN : +v); }

/** Formular für ein eigenes Lebensmittel (auch für vom Etikett gelesene Werte). */
export function customForm(box, draft, { onSaved = null } = {}) {
  const d = draft || { name: "", brand: "", unit: "g", per100: {}, portions: [], source: { type: "custom", official: false, declared: true, label: "Eigener Eintrag" } };
  const v = (k) => (d.per100[k] == null ? "" : String(d.per100[k]).replace(".", ","));
  const fields = [["kcal", "Energie (kcal)"], ["fat", "Fett (g)"], ["sat", "davon gesättigt (g)"], ["carb", "Kohlenhydrate (g)"], ["sugar", "davon Zucker (g)"], ["fibre", "Ballaststoffe (g)"], ["protein", "Eiweiß (g)"], ["salt", "Salz (g)"]];
  box.innerHTML = `
    <label class="field">Name<input type="text" id="cName" value="${esc(d.name)}" placeholder="z. B. Proteinriegel Schoko"></label>
    <div class="grid2">
      <label class="field">Marke (optional)<input type="text" id="cBrand" value="${esc(d.brand || "")}"></label>
      <label class="field">Bezug<select id="cUnit"><option value="g" ${d.unit === "g" ? "selected" : ""}>je 100 g</option><option value="ml" ${d.unit === "ml" ? "selected" : ""}>je 100 ml</option></select></label>
    </div>
    <div class="grid2">${fields.map(([k, l]) => `<label class="field">${l}<input type="text" inputmode="decimal" data-k="${k}" value="${v(k)}"></label>`).join("")}</div>
    <label class="field">Portionsgröße (optional, g/ml)<input type="text" inputmode="decimal" id="cPortion" value="${d.portions?.[0]?.g ?? ""}"></label>
    <div id="cCheck"></div>
    <button class="btn primary block" id="cSave">Speichern & Menge wählen</button>
    <p class="muted">Leeres Energiefeld: kcal werden aus den Makros nach LMIV berechnet. Eigene Lebensmittel erscheinen in der Suche.</p>`;
  const read = () => {
    const per100 = { polyols: null, alcohol: null, acids: null };
    for (const [k] of fields) per100[k] = numVal($(`[data-k="${k}"]`, box));
    return per100;
  };
  const check = () => {
    const per100 = read();
    const bad = Object.entries(per100).filter(([, x]) => Number.isNaN(x));
    if (bad.length) { $("#cCheck", box).innerHTML = `<div class="notice bad">Bitte nur Zahlen eingeben.</div>`; return null; }
    const declared = per100.kcal != null;
    const p2 = { ...per100 };
    const c = energyFromMacros(p2);
    if (!declared) { p2.kcal = +c.kcal.toFixed(1); p2.kj = Math.round(c.kj); } else p2.kj = d.per100.kj ?? Math.round(p2.kcal * 4.184);
    const r = validate(p2, { declared, unit: $("#cUnit", box).value });
    $("#cCheck", box).innerHTML = r.issues.length
      ? `<div class="notice ${r.level}"><b>Regelprüfung:</b><ul>${r.issues.map((i) => `<li>${esc(i.text)}</li>`).join("")}</ul></div>`
      : (per100.fat != null || per100.carb != null || per100.protein != null) ? `<div class="notice ok">✓ Werte konsistent (berechnet: ${fmtKcal(c.kcal)} kcal nach LMIV)</div>` : "";
    return { p2, declared };
  };
  $$("input,select", box).forEach((el) => el.addEventListener("input", check));
  check();
  $("#cSave", box).addEventListener("click", () => {
    const name = $("#cName", box).value.trim();
    if (!name) return toast("Bitte einen Namen eingeben.");
    const r = check(); if (!r) return;
    if (r.p2.kcal == null) return toast("Bitte Energie oder Makronährstoffe eingeben.");
    const portion = numVal($("#cPortion", box));
    const unit = $("#cUnit", box).value;
    const f = {
      name, brand: $("#cBrand", box).value.trim(), unit, per100: r.p2,
      portions: portion > 0 ? [{ label: `1 Portion (${fmt(portion)} ${unit})`, g: portion }] : [],
      source: { ...d.source, type: d.source.type === "label" ? "label" : "custom", declared: r.declared, official: false, ref: d.source.ref },
    };
    const saved = saveCustomFood(f);
    if (onSaved) onSaved(saved); else openDetail(saved);
  });
}

function quickForm(box) {
  box.innerHTML = `
    <label class="field">Bezeichnung<input type="text" id="qName" placeholder="z. B. Kantinenessen"></label>
    <div class="grid2">
      <label class="field">Energie (kcal)<input type="text" inputmode="decimal" id="qK"></label>
      <label class="field">Eiweiß (g, optional)<input type="text" inputmode="decimal" id="qP"></label>
      <label class="field">Kohlenhydrate (g, optional)<input type="text" inputmode="decimal" id="qC"></label>
      <label class="field">Fett (g, optional)<input type="text" inputmode="decimal" id="qF"></label>
    </div>
    <button class="btn primary block" id="qAdd">Zu ${esc(mealLabel(ctx.meal))} hinzufügen</button>
    <p class="muted">Schnelleinträge haben keine geprüfte Datenbasis – für genaue Werte lieber Lebensmittel suchen.</p>`;
  $("#qAdd", box).addEventListener("click", () => {
    const k = numVal($("#qK", box));
    if (!(k >= 0) || k === null) return toast("Bitte kcal eingeben.");
    const g = (id) => { const x = numVal($(id, box)); return Number.isFinite(x) ? x : null; };
    const per100 = { kcal: k, kj: Math.round(k * 4.184), protein: g("#qP"), carb: g("#qC"), fat: g("#qF"), sat: null, sugar: null, polyols: null, fibre: null, salt: null, alcohol: null, acids: null };
    addEntry(ctx.dayKey, { meal: ctx.meal, name: $("#qName", box).value.trim() || "Schnelleintrag", grams: 100, unit: "g", per100, source: { type: "quick", label: "Schnelleintrag", official: false }, quick: true });
    toast("Hinzugefügt");
    closeSheet(); ctx.onChange();
  });
}

// ------------------------------------------------------------------ Detailansicht
export function entryFromFood(f, grams, extra = {}) {
  const s = f.source || {};
  return {
    meal: ctx.meal, name: f.name, brand: f.brand || "", grams, unit: unitOf(f), per100: { ...f.per100 },
    portions: f.portions || [], image: f.image || null,
    source: { type: s.type, ref: s.ref, label: s.label, official: !!s.official, declared: !!s.declared, url: s.url || null },
    ...extra,
  };
}

/** Detail mit Mengenwahl. opts.entry => bestehenden Eintrag bearbeiten. */
export function openDetail(food, opts = {}) {
  // Für amtliche Einträge immer die aktuellen Datenbankwerte verwenden
  let f = food;
  if (food.source?.type === "bls" && db() && !opts.entry) f = foodByCode(food.source.ref) || food;
  const title = opts.entry ? "Eintrag bearbeiten" : f.name;
  const render = (b) => renderDetail(b, f, opts);
  openSheet(title, render, { push: true });
}

function renderDetail(b, f, opts) {
  const u = unitOf(f);
  const entry = opts.entry || null;
  let grams = entry ? entry.grams : (opts.grams || f.portions?.[0]?.g || 100);
  const portions = [{ label: `100 ${u}`, g: 100 }, ...(f.portions || [])];
  const local = f.source?.type === "quick" ? { level: "ok", issues: [] } : validate(f.per100, { declared: !!f.source?.declared, unit: u });
  const fav = isFav(f);
  const sources = f.source?.type === "bls" ? (foodByCode(f.source.ref)?.source.sources || []) : [];

  b.innerHTML = `
    <div style="display:flex;gap:12px;align-items:flex-start">
      ${f.image ? `<img src="${esc(f.image)}" alt="" style="width:64px;height:64px;object-fit:contain;border-radius:8px;background:#fff">` : ""}
      <div style="flex:1;min-width:0">
        <div style="font-weight:650;font-size:1.05rem">${esc(f.name)}</div>
        ${f.brand ? `<div class="sub">${esc(f.brand)}</div>` : ""}
        ${f.en ? `<div class="muted">${esc(f.en)}</div>` : ""}
        <div class="badges" style="margin-top:6px">${sourceBadge(f)}<span id="aiBadge">${cachedVerification(f) ? aiBadge(cachedVerification(f).verdict) : ""}</span></div>
      </div>
      ${f.source?.type !== "quick" ? `<button class="icon-btn" id="fav" aria-label="Favorit" title="Favorit">${fav ? "★" : "☆"}</button>` : ""}
    </div>

    <div class="amount-row" style="margin-top:10px">
      <label class="field">Menge (${u})<input type="text" inputmode="decimal" id="grams" value="${String(+grams.toFixed(1)).replace(".", ",")}"></label>
      <label class="field">Portion<select id="portion"><option value="">– wählen –</option>${portions.map((pp, i) => `<option value="${i}">${esc(pp.label)}</option>`).join("")}</select></label>
    </div>
    <div class="kpis" id="kpis"></div>
    ${entry ? `<label class="field">Mahlzeit<select id="eMeal">${MEALS.map((m) => `<option value="${m.id}" ${m.id === entry.meal ? "selected" : ""}>${m.label}</option>`).join("")}</select></label>` : ""}
    <div class="btn-row">
      ${entry ? `<button class="btn primary" id="save">Speichern</button><button class="btn danger" id="del">Löschen</button>`
              : `<button class="btn primary block" id="add">Zu ${esc(mealLabel(ctx.meal))} hinzufügen</button>`}
    </div>

    <h3 style="margin:18px 0 6px;font-size:.95rem">Nährwerte</h3>
    <table class="nt"><thead><tr><th></th><th>je 100 ${u}</th><th id="thAmt">Menge</th></tr></thead><tbody id="ntBody"></tbody></table>
    ${f.incompleteEnergy ? `<div class="notice warn">In der Quelle fehlt ein Hauptnährstoff – die Energie ist daher unvollständig.</div>` : ""}
    ${f.marks ? `<p class="muted">Werte unter der Nachweis-/Bestimmungsgrenze (&lt;LOD/&lt;LOQ) oder in Spuren (TR) sind als „–“ angegeben: ${Object.entries(f.marks).map(([k, m]) => esc(k) + ": " + esc(m)).join(", ")}</p>` : ""}

    <h3 style="margin:18px 0 6px;font-size:.95rem">Prüfung</h3>
    <div id="localCheck">${local.issues.length
      ? `<div class="notice ${local.level}"><b>Regelprüfung:</b><ul>${local.issues.map((i) => `<li>${esc(i.text)}</li>`).join("")}</ul></div>`
      : `<div class="notice ok">✓ Regelprüfung bestanden: Werte in sich konsistent${f.source?.declared ? " (deklarierte Energie passt zu den Makros nach LMIV)" : ""}.</div>`}</div>
    <div id="aiCheck"></div>

    <h3 style="margin:18px 0 6px;font-size:.95rem">Datenquelle</h3>
    <div class="sub" id="srcInfo">${sourceInfo(f, sources)}</div>`;

  const gEl = $("#grams", b), pEl = $("#portion", b);
  const upd = () => {
    const g = parseFloat(gEl.value.replace(",", "."));
    grams = Number.isFinite(g) && g >= 0 ? g : 0;
    const a = scale(f.per100, grams);
    $("#kpis", b).innerHTML = `<div><b class="num">${fmtKcal(a.kcal)}</b><span>kcal</span></div><div><b class="num">${fmt(a.protein)}</b><span>Eiweiß g</span></div><div><b class="num">${fmt(a.carb)}</b><span>KH g</span></div><div><b class="num">${fmt(a.fat)}</b><span>Fett g</span></div>`;
    $("#thAmt", b).textContent = `${fmt(grams)} ${u}`;
    $("#ntBody", b).innerHTML = NUTRIENTS.filter((nn) => !nn.optional || (f.per100[nn.key] != null && f.per100[nn.key] > 0)).map((nn) => {
      const v100 = f.per100[nn.key];
      const extra = nn.key === "kcal" && f.per100.kj != null ? ` / ${fmtKcal(f.per100.kj)} kJ` : "";
      const extraA = nn.key === "kcal" && a.kj != null ? ` / ${fmtKcal(a.kj)} kJ` : "";
      return `<tr class="${nn.indent ? "indent" : ""}"><td>${nn.label}</td><td class="num">${nn.key === "kcal" ? fmtKcal(v100) + " kcal" + extra : fmt(v100, nn.dec) + " " + nn.unit}</td><td class="num">${nn.key === "kcal" ? fmtKcal(a.kcal) + " kcal" + extraA : fmt(a[nn.key], nn.dec) + " " + nn.unit}</td></tr>`;
    }).join("");
  };
  gEl.addEventListener("input", () => { pEl.value = ""; upd(); });
  pEl.addEventListener("change", () => { if (pEl.value !== "") { gEl.value = String(portions[+pEl.value].g).replace(".", ","); upd(); } });
  upd();

  const favBtn = $("#fav", b);
  if (favBtn) favBtn.addEventListener("click", () => { favBtn.textContent = toggleFav(f) ? "★" : "☆"; });

  if (entry) {
    $("#save", b).addEventListener("click", () => {
      if (!(grams > 0)) return toast("Bitte eine Menge > 0 eingeben.");
      updateEntry(ctx.dayKey, entry.id, { grams, meal: $("#eMeal", b).value });
      toast("Gespeichert"); closeSheet(); ctx.onChange();
    });
    $("#del", b).addEventListener("click", () => {
      removeEntry(ctx.dayKey, entry.id);
      toast("Gelöscht"); closeSheet(); ctx.onChange();
    });
  } else {
    $("#add", b).addEventListener("click", () => {
      if (!(grams > 0)) return toast("Bitte eine Menge > 0 eingeben.");
      const ai = cachedVerification(f);
      addEntry(ctx.dayKey, entryFromFood(f, grams, { check: { local: local.level, ai: ai?.verdict || null } }));
      toast(`${f.name} hinzugefügt`); closeSheet(); ctx.onChange();
    });
  }

  // KI-Prüfung
  const aiBox = $("#aiCheck", b);
  const showAI = (r) => {
    const cls = r.verdict === "plausibel" ? "ok" : r.verdict === "auffaellig" ? "warn" : "bad";
    const lbl = r.verdict === "plausibel" ? "✓ KI-Prüfung: plausibel" : r.verdict === "auffaellig" ? "! KI-Prüfung: auffällig" : "✕ KI-Prüfung: unplausibel";
    aiBox.innerHTML = `<div class="notice ${cls}"><b>${lbl}</b><p>${esc(r.summary)}</p>${r.issues.length ? `<ul>${r.issues.map((i) => `<li><b>${esc(i.nutrient)}</b>: ${esc(i.given)} (erwartet ${esc(i.expected)}) – ${esc(i.comment)}</li>`).join("")}</ul>` : ""}
      <p class="muted">Geprüft am ${new Date(r.checkedAt).toLocaleDateString("de-DE")} · ${esc(r.model || "")} · <a href="#" id="reAI">erneut prüfen</a></p></div>`;
    $("#aiBadge", b).innerHTML = aiBadge(r.verdict);
    $("#reAI", aiBox).addEventListener("click", (e) => { e.preventDefault(); runAI(true); });
  };
  const runAI = async (force = false) => {
    aiBox.innerHTML = loadingHTML("KI prüft die Nährwerte gegen Referenzdaten …");
    try { showAI(await verifyFood(f, { force })); }
    catch (e) { aiBox.innerHTML = `<div class="notice bad">KI-Prüfung fehlgeschlagen: ${esc(e.message)} <a href="#" id="retryAI">Erneut</a></div>`; $("#retryAI", aiBox).onclick = (ev) => { ev.preventDefault(); runAI(true); }; }
  };
  if (f.source?.type === "quick") aiBox.innerHTML = "";
  else if (!hasKey()) aiBox.innerHTML = `<p class="muted">KI-Prüfung: ${esc(aiMissingText())}</p>`;
  else {
    const cached = cachedVerification(f);
    const mode = getSettings().ai.verify;
    if (cached) showAI(cached);
    else if (mode === "all" || (mode === "unofficial" && !f.source?.official)) runAI();
    else { aiBox.innerHTML = `<button class="btn block" id="doAI">🤖 Werte von KI prüfen lassen</button>`; $("#doAI", aiBox).onclick = () => runAI(); }
  }
}

function sourceInfo(f, sources) {
  const s = f.source || {};
  if (s.type === "bls") {
    const d = db();
    return sources.map((x) => `<p style="margin:4px 0"><b>${esc(x.name)}</b> (${esc(x.license)})<br>${esc(x.citation)}<br>Eintrag: <code>${esc(x.id)}</code> · <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a></p>`).join("") +
      `<p class="muted">Energie berechnet nach ${esc(d?.energyMethod || "LMIV Anhang XIV")}; Salz = Natrium × 2,5.</p>`;
  }
  if (s.type === "off") return `<p style="margin:4px 0">Herstellerangaben vom Etikett, erfasst in <a href="${esc(s.url)}" target="_blank" rel="noopener">Open Food Facts</a> (ODbL)${s.updated ? `, Stand ${esc(s.updated)}` : ""}. Barcode <code>${esc(s.ref)}</code>.</p>${s.qualityErrors?.length ? `<p class="muted">Open-Food-Facts-Qualitätshinweise: ${s.qualityErrors.map(esc).join(", ")}</p>` : ""}`;
  if (s.type === "label") return `Werte vom Foto des Etiketts, von der KI gelesen und von dir bestätigt.`;
  if (s.type === "custom") return `Von dir eingegebene Werte.`;
  return `Schnelleintrag ohne Datenbasis.`;
}
