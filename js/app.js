// NährWert – Hauptansichten und Navigation.
import { esc, $, $$, openSheet, closeSheet, toast, loadingHTML } from "./ui.js";
import { loadDB, search } from "./db.js";
import { scale, sum, fmt, fmtKcal, calcGoals, JOBS, SPORT, GOALS } from "./nutrition.js";
import {
  MEALS, GLASS_ML, getSettings, saveSettings, dayKey, parseDayKey, getDay, changeWater, allDayKeys,
  getCustomFoods, deleteCustomFood, exportAll, importAll, wipeAll, initStore, storageMode, lastSyncError,
} from "./store.js";
import { openAdd, openDetail, setContext, sourceBadge, checkBadges, customForm } from "./add.js";
import { MODELS, hasKey, testKey, reviewDay, initAI, aiMode, aiMissingText } from "./ai.js";
import { IN_CLAUDE, capability } from "./platform.js";

/** Zweistufige Bestätigung im Button selbst (confirm() ist im Chat gesperrt). */
function armConfirm(btn, label, action) {
  let armed = false, t = null;
  const orig = btn.innerHTML;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!armed) { armed = true; btn.textContent = label; btn.classList.add("danger"); t = setTimeout(() => { armed = false; btn.innerHTML = orig; }, 4000); return; }
    clearTimeout(t); action();
  });
}

const state = { date: new Date(), tab: "today", statsRange: 7 };
const view = $("#view");

function key() { return dayKey(state.date); }
function isToday(d) { return dayKey(d) === dayKey(new Date()); }

function applyTheme() {
  const t = getSettings().theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ------------------------------------------------------------------ Datum
function renderDate() {
  const d = state.date;
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  let label = d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
  if (isToday(d)) label = "Heute, " + d.toLocaleDateString("de-DE", { day: "numeric", month: "long" });
  else if (dayKey(d) === dayKey(y)) label = "Gestern, " + d.toLocaleDateString("de-DE", { day: "numeric", month: "long" });
  $("#dateLabel").textContent = label;
  $("#nextDay").disabled = isToday(d);
  $("#nextDay").style.visibility = isToday(d) ? "hidden" : "visible";
  $("#datePicker").value = key();
  $("#datePicker").max = dayKey(today);
  document.querySelector(".topbar").style.display = state.tab === "today" ? "" : "none";
}
$("#prevDay").addEventListener("click", () => { state.date.setDate(state.date.getDate() - 1); render(); });
$("#nextDay").addEventListener("click", () => { if (!isToday(state.date)) { state.date.setDate(state.date.getDate() + 1); render(); } });
$("#dateLabel").addEventListener("click", () => {
  const p = $("#datePicker");
  if (p.showPicker) { try { p.showPicker(); return; } catch {} }
  state.date = new Date(); render();
});
$("#datePicker").addEventListener("change", (e) => { if (e.target.value) { state.date = parseDayKey(e.target.value); render(); } });

// ------------------------------------------------------------------ Navigation
$$(".tabbar button").forEach((b) => b.addEventListener("click", () => {
  const t = b.dataset.tab;
  if (t === "add") { openAdd(null); return; }
  state.tab = t;
  $$(".tabbar button").forEach((x) => x.classList.toggle("active", x.dataset.tab === t));
  render();
  window.scrollTo(0, 0);
}));

function render() {
  setContext({ dayKey: key(), onChange: render });
  renderDate();
  ({ today: renderToday, stats: renderStats, foods: renderFoods, settings: renderSettings }[state.tab])();
}

// ------------------------------------------------------------------ Heute
function entryNutrients(e) { return scale(e.per100, e.grams); }

function renderToday() {
  const s = getSettings();
  const g = s.goals;
  const day = getDay(key());
  const per = day.entries.map((e) => ({ e, n: entryNutrients(e) }));
  const tot = sum(per.map((x) => x.n));
  const remaining = g.kcal - tot.kcal;
  const pct = Math.min(1, g.kcal > 0 ? tot.kcal / g.kcal : 0);
  const R = 56, C = 2 * Math.PI * R;
  const over = tot.kcal > g.kcal;

  const macro = (label, val, goal, color) => {
    const p = goal > 0 ? Math.min(100, (val / goal) * 100) : 0;
    return `<div class="macro"><div class="row"><span>${label}</span><span class="num"><b>${fmt(val, 0)}</b> / ${fmt(goal, 0)} g</span></div>
      <div class="bar ${val > goal * 1.1 ? "over" : ""}" role="progressbar" aria-label="${label}" aria-valuenow="${Math.round(val)}" aria-valuemax="${goal}"><span style="width:${p}%;background:${color}"></span></div></div>`;
  };

  const glassesGoal = Math.ceil(g.water / GLASS_ML);
  const glassesNow = Math.round(day.water / GLASS_ML * 10) / 10;
  const glassCount = Math.max(glassesGoal, Math.ceil(day.water / GLASS_ML));

  view.innerHTML = `
    <section class="card" aria-label="Tagesübersicht">
      <div class="summary">
        <div class="ring">
          <svg viewBox="0 0 132 132" aria-hidden="true">
            <circle cx="66" cy="66" r="${R}" fill="none" stroke="var(--surface-2)" stroke-width="12"/>
            <circle cx="66" cy="66" r="${R}" fill="none" stroke="${over ? "var(--bad)" : "var(--accent)"}" stroke-width="12" stroke-linecap="round"
              stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/>
          </svg>
          <div class="ring-label"><span class="big num">${fmtKcal(Math.abs(remaining))}</span><span class="muted">${remaining >= 0 ? "kcal übrig" : "kcal zu viel"}</span></div>
        </div>
        <div class="macros">
          <div class="eaten"><span>Gegessen</span><b class="num">${fmtKcal(tot.kcal)} / ${fmtKcal(g.kcal)} kcal</b></div>
          ${macro("Eiweiß", tot.protein, g.protein, "var(--protein)")}
          ${macro("Kohlenhydrate", tot.carb, g.carb, "var(--carb)")}
          ${macro("Fett", tot.fat, g.fat, "var(--fat)")}
        </div>
      </div>
      <div class="extra-nutrients">
        <div><b class="num">${fmt(tot.fibre)} g</b><span class="muted">Ballaststoffe${g.fibre ? " / " + g.fibre : ""}</span></div>
        <div><b class="num">${fmt(tot.sugar)} g</b><span class="muted">Zucker</span></div>
        <div><b class="num">${fmt(tot.salt, 1)} g</b><span class="muted">Salz</span></div>
      </div>
    </section>

    <section class="card" aria-label="Wasser">
      <div class="card-head"><h3>💧 Wasser</h3><span class="sub num">Ziel ${fmt(g.water / 1000, 2)} l</span></div>
      <div class="water-wrap">
        <button class="water-btn" id="wMinus" aria-label="Ein Glas (250 ml) entfernen" ${day.water <= 0 ? "disabled" : ""}>−</button>
        <div class="water-mid">
          <div class="water-amount num">${fmt(day.water / 1000, 2)} l</div>
          <div class="muted">${fmt(glassesNow, 1)} von ${glassesGoal} Gläsern à 250 ml</div>
          <div class="glasses" aria-hidden="true">${Array.from({ length: glassCount }, (_, i) => `<span class="glass ${i < Math.floor(day.water / GLASS_ML) ? "full" : ""}"></span>`).join("")}</div>
        </div>
        <button class="water-btn plus" id="wPlus" aria-label="Ein Glas (250 ml) hinzufügen">+</button>
      </div>
    </section>

    ${MEALS.map((m) => {
      const items = per.filter((x) => x.e.meal === m.id);
      const mk = items.reduce((a, x) => a + (x.n.kcal || 0), 0);
      return `<section class="card meal" aria-label="${m.label}">
        <div class="meal-head"><h3>${m.label}</h3><span class="sub num">${fmtKcal(mk)} kcal</span></div>
        ${items.map(({ e, n }) => `<div class="entry" data-id="${e.id}" role="button" tabindex="0">
          <div class="e-main"><div class="e-name">${esc(e.name)}</div>
            <div class="sub num">${fmt(e.grams)} ${esc(e.unit || "g")}${e.brand ? " · " + esc(e.brand) : ""} · E ${fmt(n.protein)} · K ${fmt(n.carb)} · F ${fmt(n.fat)}</div>
            <div class="badges">${sourceBadge(e)}${checkBadges(e)}${e.aiPhoto ? `<span class="badge">📷 Menge KI-geschätzt</span>` : ""}</div></div>
          <div class="e-kcal num">${fmtKcal(n.kcal)} kcal</div></div>`).join("")}
        <button class="add-line" data-meal="${m.id}">+ ${m.label} hinzufügen</button>
      </section>`;
    }).join("")}

    ${day.entries.length ? `<section class="card"><div class="card-head"><h3>Tagesprüfung</h3></div>
      <p class="sub" style="margin-top:0">Die KI prüft deine Einträge auf typische Eingabefehler (unrealistische Mengen, roh/gekocht verwechselt, doppelte Einträge).</p>
      <button class="btn block" id="dayReview" ${hasKey() ? "" : "disabled"}>🤖 Tag von KI prüfen lassen</button>
      ${hasKey() ? "" : `<p class="muted">${esc(aiMissingText())}</p>`}
      <div id="dayReviewRes"></div></section>` : ""}
  `;

  $("#wPlus").addEventListener("click", () => { changeWater(key(), GLASS_ML); if (navigator.vibrate) navigator.vibrate(20); renderToday(); });
  $("#wMinus").addEventListener("click", () => { changeWater(key(), -GLASS_ML); renderToday(); });
  $$(".add-line").forEach((b) => b.addEventListener("click", () => openAdd(b.dataset.meal)));
  $$(".entry").forEach((el) => {
    const open = () => { const e = day.entries.find((x) => x.id === el.dataset.id); if (e) openDetail(e, { entry: e }); };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") open(); });
  });
  const rb = $("#dayReview");
  if (rb) rb.addEventListener("click", async () => {
    const box = $("#dayReviewRes");
    rb.disabled = true;
    box.innerHTML = loadingHTML("KI prüft den Tag …");
    try {
      const r = await reviewDay(per.map(({ e, n }) => ({ ...e, kcal: n.kcal })), tot, g);
      box.innerHTML = `<div class="notice ${r.findings.some((f) => f.severity === "warnung") ? "warn" : "ok"}"><p>${esc(r.summary)}</p>${r.findings.length ? `<ul>${r.findings.map((f) => `<li>${f.entry ? "<b>" + esc(f.entry) + ":</b> " : ""}${esc(f.text)}</li>`).join("")}</ul>` : ""}</div>`;
    } catch (e) { box.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
    rb.disabled = false;
  });
}

// ------------------------------------------------------------------ Verlauf
function renderStats() {
  const s = getSettings();
  const n = state.statsRange;
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
    const day = getDay(dayKey(d));
    const t = sum(day.entries.map(entryNutrients));
    days.push({ d, k: dayKey(d), kcal: t.kcal, protein: t.protein, carb: t.carb, fat: t.fat, water: day.water, logged: day.entries.length > 0 });
  }
  const logged = days.filter((x) => x.logged);
  const avg = (k) => logged.length ? logged.reduce((a, x) => a + x[k], 0) / logged.length : 0;
  const wDays = days.filter((x) => x.water > 0);
  const wAvg = wDays.length ? wDays.reduce((a, x) => a + x.water, 0) / wDays.length : 0;

  view.innerHTML = `
    <h2 style="margin:16px 0 4px">Verlauf</h2>
    <div class="seg" style="max-width:260px"><button data-r="7" class="${n === 7 ? "active" : ""}">7 Tage</button><button data-r="30" class="${n === 30 ? "active" : ""}">30 Tage</button></div>
    <section class="card">
      <div class="card-head"><h3>Energie</h3><span class="sub">Ø ${fmtKcal(avg("kcal"))} kcal an ${logged.length} ${logged.length === 1 ? "Tag" : "Tagen"}</span></div>
      ${barChart(days, "kcal", s.goals.kcal, "bar-k", (x) => `${fmtKcal(x.kcal)} kcal`)}
      <div class="chart-tip" id="tip-kcal">Ziel: ${fmtKcal(s.goals.kcal)} kcal (Linie). Balken antippen für Details.</div>
    </section>
    <section class="card">
      <div class="card-head"><h3>Wasser</h3><span class="sub">Ø ${fmt(wAvg / 1000, 2)} l</span></div>
      ${barChart(days, "water", s.goals.water, "bar-w", (x) => `${fmt(x.water / 1000, 2)} l`)}
      <div class="chart-tip" id="tip-water">Ziel: ${fmt(s.goals.water / 1000, 2)} l (Linie).</div>
    </section>
    <section class="card">
      <h3>Ø Makronährstoffe (Tage mit Einträgen)</h3>
      <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
        <div><b class="num">${fmt(avg("protein"), 0)} g</b><span>Eiweiß (Ziel ${s.goals.protein})</span></div>
        <div><b class="num">${fmt(avg("carb"), 0)} g</b><span>KH (Ziel ${s.goals.carb})</span></div>
        <div><b class="num">${fmt(avg("fat"), 0)} g</b><span>Fett (Ziel ${s.goals.fat})</span></div>
      </div>
      <details><summary>Tabelle anzeigen</summary>
        <table class="nt"><thead><tr><th>Tag</th><th>kcal</th><th>E</th><th>KH</th><th>F</th><th>Wasser</th></tr></thead>
        <tbody>${days.slice().reverse().map((x) => `<tr><td>${x.d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" })}</td><td class="num">${x.logged ? fmtKcal(x.kcal) : "–"}</td><td class="num">${x.logged ? fmt(x.protein, 0) : "–"}</td><td class="num">${x.logged ? fmt(x.carb, 0) : "–"}</td><td class="num">${x.logged ? fmt(x.fat, 0) : "–"}</td><td class="num">${x.water ? fmt(x.water / 1000, 2) + " l" : "–"}</td></tr>`).join("")}</tbody></table>
      </details>
    </section>`;
  $$(".seg button[data-r]").forEach((b) => b.addEventListener("click", () => { state.statsRange = +b.dataset.r; renderStats(); }));
  $$(".chart").forEach((svg) => {
    const metric = svg.dataset.metric;
    const tip = $("#tip-" + metric);
    svg.addEventListener("click", (e) => {
      const r = e.target.closest("[data-i]"); if (!r) return;
      const x = days[+r.dataset.i];
      tip.textContent = `${x.d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}: ${metric === "kcal" ? (x.logged ? fmtKcal(x.kcal) + " kcal" : "keine Einträge") : fmt(x.water / 1000, 2) + " l"}`;
    });
  });
}

function barChart(days, metric, goal, cls, label) {
  const W = 340, H = 150, padL = 34, padB = 20, padT = 8;
  const max = Math.max(goal * 1.15, ...days.map((x) => x[metric])) || 1;
  const step = niceStep(max / 3);
  const top = Math.ceil(max / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const bw = (W - padL) / days.length;
  const barW = Math.min(24, bw * 0.62);
  const ticks = []; for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const fmtTick = (v) => metric === "water" ? fmt(v / 1000, 1) + " l" : (v >= 1000 ? fmt(v / 1000, 1) + "k" : String(v));
  const showLabel = (i) => days.length <= 7 || i % 5 === (days.length - 1) % 5;
  return `<svg class="chart" data-metric="${metric}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${metric === "kcal" ? "Energie" : "Wasser"} pro Tag">
    ${ticks.map((v) => `<line class="gridline" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 4}" y="${y(v) + 3}" text-anchor="end">${fmtTick(v)}</text>`).join("")}
    ${days.map((x, i) => {
      const v = x[metric];
      const h = Math.max(0, y(0) - y(v));
      const cx = padL + bw * i + bw / 2;
      const r = Math.min(4, barW / 2, h);
      const x0 = cx - barW / 2, y0 = y(0) - h;
      const path = h > 0 ? `M${x0},${y(0)} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + barW - r} Q${x0 + barW},${y0} ${x0 + barW},${y0 + r} V${y(0)} Z` : "";
      return `<g data-i="${i}"><title>${x.d.toLocaleDateString("de-DE")}: ${label(x)}</title>
        <rect class="bar-hit" x="${padL + bw * i}" y="${padT}" width="${bw}" height="${H - padT - padB}"/>
        ${path ? `<path class="${cls}" d="${path}"/>` : ""}
        ${showLabel(i) ? `<text x="${cx}" y="${H - 6}" text-anchor="middle">${days.length <= 7 ? x.d.toLocaleDateString("de-DE", { weekday: "short" }) : x.d.getDate() + "."}</text>` : ""}</g>`;
    }).join("")}
    <line class="goal" x1="${padL}" x2="${W}" y1="${y(goal)}" y2="${y(goal)}"/>
  </svg>`;
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

// ------------------------------------------------------------------ Lebensmittel (Datenbank-Browser)
function renderFoods() {
  const custom = getCustomFoods();
  view.innerHTML = `
    <h2 style="margin:16px 0 4px">Lebensmittel</h2>
    <section class="card">
      <input type="search" id="fq" placeholder="Datenbank durchsuchen …" autocomplete="off">
      <div id="fres"></div>
    </section>
    <section class="card">
      <div class="card-head"><h3>Eigene Lebensmittel</h3><button class="btn" id="newCustom">+ Neu</button></div>
      ${custom.length ? `<ul class="results" id="clist">${custom.map((f, i) => `<li data-i="${i}"><div class="r-main"><div class="r-name">${esc(f.name)}</div><div class="sub">${f.brand ? esc(f.brand) + " · " : ""}${fmtKcal(f.per100.kcal)} kcal/100 ${esc(f.unit || "g")}</div><div class="badges">${sourceBadge(f)}${checkBadges(f)}</div></div><button class="btn" data-del="${i}" aria-label="${esc(f.name)} löschen">Löschen</button></li>`).join("")}</ul>` : `<p class="sub">Noch keine eigenen Lebensmittel. Lege Produkte an, die du nicht in der Datenbank findest – oder fotografiere die Nährwerttabelle.</p>`}
    </section>
    <section class="card" id="dbInfo">${loadingHTML("Lade Datenbank …")}</section>`;

  loadDB().then((d) => {
    const counts = {};
    for (const r of d.foods) { const lbl = d.groups[r[0][0]]; counts[lbl] = (counts[lbl] || 0) + 1; }
    const srcCount = {};
    for (const r of d.foods) for (const [i] of r[15]) srcCount[d.sourceKeys[i]] = (srcCount[d.sourceKeys[i]] || 0) + 1;
    $("#dbInfo").innerHTML = `<h3>Datenbasis</h3>
      <p class="sub" style="margin-top:0"><b>${d.foods.length.toLocaleString("de-DE")} Lebensmittel</b> mit amtlich analysierten bzw. berechneten Nährwerten, offline verfügbar. Zusätzlich Millionen Markenprodukte über Open Food Facts (Barcode & Online-Suche).</p>
      <table class="nt"><tbody>${Object.entries(counts).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.toLocaleString("de-DE")}</td></tr>`).join("")}</tbody></table>
      <h3 style="margin-top:16px">Quellen & Lizenzen</h3>
      ${d.sourceKeys.map((k) => { const s = d.sources[k]; return `<p class="small"><b>${esc(s.name)}</b> – ${esc(s.publisher)}, ${esc(s.license)} · ${(srcCount[k] || 0).toLocaleString("de-DE")} Einträge<br><span class="muted">${esc(s.citation)}</span></p>`; }).join("")}
      <p class="small"><b>Open Food Facts</b> – Produktdaten unter Open Database License (ODbL), Bilder CC BY-SA. <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener">openfoodfacts.org</a></p>
      <p class="muted">Energie berechnet nach ${esc(d.energyMethod)}. Salz = Natrium × 2,5. Nicht vom Max Rubner-Institut veröffentlicht; Extrakt des BLS 4.0 über das Paket @thereforejs/foods.</p>`;
  }).catch((e) => { $("#dbInfo").innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; });

  let t = null;
  $("#fq").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(async () => {
      await loadDB();
      const q = e.target.value.trim();
      const box = $("#fres");
      if (!q) { box.innerHTML = ""; return; }
      const list = search(q, { limit: 50 });
      box.innerHTML = list.length ? `<ul class="results" id="fl">${list.map((f, i) => `<li data-i="${i}"><div class="r-main"><div class="r-name">${esc(f.name)}</div><div class="badges">${sourceBadge(f)}</div></div><div class="r-kcal num">${fmtKcal(f.per100.kcal)} kcal<div class="muted">E ${fmt(f.per100.protein)} · K ${fmt(f.per100.carb)} · F ${fmt(f.per100.fat)}</div></div></li>`).join("")}</ul>` : `<div class="empty">Kein Treffer.</div>`;
      const ul = $("#fl", box);
      if (ul) ul.addEventListener("click", (ev) => { const li = ev.target.closest("li"); if (li) openDetail(list[+li.dataset.i]); });
    }, 120);
  });

  $("#newCustom").addEventListener("click", () => openSheet("Eigenes Lebensmittel", (b) => customForm(b, null, { onSaved: () => { closeSheet(); toast("Gespeichert"); renderFoods(); } })));
  const cl = $("#clist");
  if (cl) $$("[data-del]", cl).forEach((btn) => {
    const f = custom[+btn.dataset.del];
    armConfirm(btn, "Wirklich?", () => { deleteCustomFood(f.source.ref); toast("Gelöscht"); renderFoods(); });
  });
  if (cl) cl.addEventListener("click", (e) => {
    if (e.target.closest("[data-del]")) return;
    const li = e.target.closest("li");
    if (li) {
      const f = custom[+li.dataset.i];
      openSheet("Bearbeiten", (b) => customForm(b, f, { onSaved: () => { closeSheet(); toast("Gespeichert"); renderFoods(); } }));
    }
  });
}

// ------------------------------------------------------------------ Einstellungen
function renderSettings() {
  const s = getSettings();
  const g = s.goals, p = s.profile;
  view.innerHTML = `
    <h2 style="margin:16px 0 4px">Einstellungen</h2>
    <section class="card">
      <h3>Tagesziele</h3>
      <div class="grid2">
        <label class="field">Energie (kcal)<input type="number" id="gK" value="${g.kcal}" min="0" step="10"></label>
        <label class="field">Wasser (ml)<input type="number" id="gW" value="${g.water}" min="0" step="250"></label>
        <label class="field">Eiweiß (g)<input type="number" id="gP" value="${g.protein}" min="0"></label>
        <label class="field">Kohlenhydrate (g)<input type="number" id="gC" value="${g.carb}" min="0"></label>
        <label class="field">Fett (g)<input type="number" id="gF" value="${g.fat}" min="0"></label>
        <label class="field">Ballaststoffe (g)<input type="number" id="gFi" value="${g.fibre}" min="0"></label>
      </div>
      <p class="muted" id="macroCheck"></p>
      <button class="btn primary block" id="saveGoals">Ziele speichern</button>
    </section>

    <section class="card">
      <h3>Bedarfsrechner</h3>
      <p class="sub" style="margin-top:0">Grundumsatz nach Mifflin-St Jeor × Aktivitätsfaktor (PAL nach DGE). Richtwert, ersetzt keine Beratung.</p>
      <div class="grid2">
        <label class="field">Geschlecht<select id="pS"><option value="f" ${p.sex === "f" ? "selected" : ""}>weiblich</option><option value="m" ${p.sex === "m" ? "selected" : ""}>männlich</option></select></label>
        <label class="field">Alter (Jahre)<input type="number" id="pA" value="${p.age}" min="1"></label>
        <label class="field">Gewicht (kg)<input type="number" id="pW" value="${p.weight}" min="1" step="0.1"></label>
        <label class="field">Größe (cm)<input type="number" id="pH" value="${p.height}" min="1"></label>
      </div>
      <label class="field">Beruf / Alltag<select id="pJob">
        ${JOBS.map((j) => `<option value="${j.pal}" ${+p.job === j.pal ? "selected" : ""}>${esc(j.label)}</option>`).join("")}
      </select></label>
      <label class="field">Sport<select id="pSport">
        ${SPORT.map((x) => `<option value="${x.add}" ${+p.sport === x.add ? "selected" : ""}>${esc(x.label)}</option>`).join("")}
      </select></label>
      <label class="field">Ziel<select id="pGoal">
        ${GOALS.map((g) => `<option value="${g.id}" ${p.goal === g.id ? "selected" : ""}>${esc(g.label)}</option>`).join("")}
      </select></label>
      <div id="needs" class="notice"></div>
      <button class="btn block" id="applyNeeds">Als Tagesziele übernehmen</button>
    </section>

    <section class="card">
      <h3>KI (Claude)</h3>
      ${IN_CLAUDE ? `<p class="sub" style="margin-top:0">${aiMode() === "claude" ? "✓ Die KI läuft hier über dein Claude-Konto – kein API-Schlüssel nötig. Beim ersten Einsatz fragt Claude einmal um Erlaubnis." : esc(aiMissingText())}</p>
      <input type="hidden" id="aiKey" value="${esc(s.ai.apiKey)}"><input type="hidden" id="aiModel" value="${esc(s.ai.model)}">` : `
      <p class="sub" style="margin-top:0">Für Fotoerkennung und KI-Prüfung der Nährwerte. Der Schlüssel wird nur in diesem Browser gespeichert und direkt an api.anthropic.com gesendet. Einen Schlüssel erhältst du unter <a href="https://platform.claude.com" target="_blank" rel="noopener">platform.claude.com</a>.</p>
      <label class="field">API-Schlüssel<input type="password" id="aiKey" value="${esc(s.ai.apiKey)}" placeholder="sk-ant-…" autocomplete="off"></label>
      <label class="field">Modell<select id="aiModel">${MODELS.map((m) => `<option value="${m.id}" ${m.id === s.ai.model ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select></label>`}
      <label class="field">Automatische KI-Prüfung der Nährwerte
        <select id="aiVerify">
          <option value="all" ${s.ai.verify === "all" ? "selected" : ""}>Für alle Lebensmittel (einmal je Lebensmittel, wird gespeichert)</option>
          <option value="unofficial" ${s.ai.verify === "unofficial" ? "selected" : ""}>Nur für nicht-amtliche Daten (Produkte, Etiketten, eigene)</option>
          <option value="manual" ${s.ai.verify === "manual" ? "selected" : ""}>Nur auf Knopfdruck</option>
        </select></label>
      <div class="btn-row"><button class="btn primary" id="saveAI">Speichern</button><button class="btn" id="testAI">Verbindung testen</button></div>
      <div id="aiRes"></div>
    </section>

    <section class="card">
      <h3>Darstellung</h3>
      <label class="field">Farbschema<select id="theme"><option value="auto" ${s.theme === "auto" ? "selected" : ""}>Wie System</option><option value="light" ${s.theme === "light" ? "selected" : ""}>Hell</option><option value="dark" ${s.theme === "dark" ? "selected" : ""}>Dunkel</option></select></label>
    </section>

    <section class="card">
      <h3>Daten</h3>
      <p class="sub" style="margin-top:0">${storageMode() === "cloud" ? "Deine Einträge werden privat im Speicher dieser Seite gesichert (nur du siehst sie)" : "Alle Einträge liegen ausschließlich lokal in diesem Browser"} – ${allDayKeys().length} ${allDayKeys().length === 1 ? "Tag" : "Tage"} gespeichert.${storageMode() === "cloud" ? "" : " Sichere sie regelmäßig."}</p>
      ${lastSyncError() ? `<div class="notice warn">${esc(lastSyncError())}</div>` : ""}
      <div class="btn-row">
        <button class="btn" id="exp">Exportieren (JSON)</button>
        <label class="btn">Importieren<input type="file" id="imp" accept="application/json,.json" hidden></label>
        <button class="btn danger" id="wipe">Alles löschen</button>
      </div>
    </section>
    <p class="muted" style="text-align:center;margin:20px 0">NährWert · Nährwerte: BLS 4.0 (Max Rubner-Institut, CC BY 4.0) u. a. · Produkte: Open Food Facts (ODbL)</p>`;

  const num = (id) => +$(id).value;
  const macroCheck = () => {
    const k = num("#gP") * 4 + num("#gC") * 4 + num("#gF") * 9;
    $("#macroCheck").textContent = `Makroziele ergeben ${fmtKcal(k)} kcal (Eiweiß/KH × 4, Fett × 9)${Math.abs(k - num("#gK")) > 100 ? " – weicht vom Energieziel ab." : "."}`;
  };
  ["#gK", "#gP", "#gC", "#gF"].forEach((id) => $(id).addEventListener("input", macroCheck));
  macroCheck();
  $("#saveGoals").addEventListener("click", () => {
    const ns = getSettings();
    ns.goals = { kcal: num("#gK"), water: num("#gW"), protein: num("#gP"), carb: num("#gC"), fat: num("#gF"), fibre: num("#gFi") };
    saveSettings(ns); toast("Ziele gespeichert");
  });

  const calc = () => {
    const prof = { sex: $("#pS").value, age: num("#pA"), weight: num("#pW"), height: num("#pH"), job: num("#pJob"), sport: num("#pSport"), goal: $("#pGoal").value };
    const r = calcGoals(prof);
    if (!r) { $("#needs").textContent = "Bitte Alter, Gewicht und Größe eingeben."; return null; }
    const sign = r.delta > 0 ? "+" : r.delta < 0 ? "−" : "±";
    $("#needs").innerHTML = `<b>Rechenweg</b><br>
      Grundumsatz ${fmtKcal(r.bmr)} kcal × PAL ${fmt(r.pal, 2)} = Gesamtumsatz <b>${fmtKcal(r.tdee)} kcal</b><br>
      ${esc(r.goal.label)}: ${sign} ${fmtKcal(Math.abs(r.delta))} kcal → <b>${fmtKcal(r.target)} kcal/Tag</b>
      ${r.notes.length ? `<br><span class="muted">${r.notes.map(esc).join(" ")}</span>` : ""}
      <br>Eiweiß ${r.protein} g · KH ${r.carb} g · Fett ${r.fat} g · Getränke ${fmt(r.water / 1000, 2)} l
      ${r.target > 3000 ? `<br><span class="muted">Über 3.000 kcal ist nur bei körperlich schwerer Arbeit oder sehr viel Sport realistisch – prüfe die Aktivitätsangaben.</span>` : ""}
      <br><span class="muted">Tipp: Nach 2–3 Wochen Gewichtsverlauf prüfen und das Ziel um 100–200 kcal anpassen.</span>`;
    return { prof, goals: { kcal: r.target, protein: r.protein, carb: r.carb, fat: r.fat, water: r.water, fibre: r.fibre } };
  };
  ["#pS", "#pA", "#pW", "#pH", "#pJob", "#pSport", "#pGoal"].forEach((id) => $(id).addEventListener("input", calc));
  calc();
  $("#applyNeeds").addEventListener("click", () => {
    const r = calc(); if (!r) return;
    const ns = getSettings(); ns.profile = r.prof; ns.goals = r.goals; saveSettings(ns);
    toast("Ziele übernommen"); renderSettings();
  });

  const saveAI = () => {
    const ns = getSettings();
    ns.ai = { apiKey: $("#aiKey").value.trim(), model: $("#aiModel").value, verify: $("#aiVerify").value };
    saveSettings(ns);
  };
  $("#saveAI").addEventListener("click", () => { saveAI(); toast("KI-Einstellungen gespeichert"); });
  $("#testAI").addEventListener("click", async () => {
    saveAI();
    const box = $("#aiRes");
    box.innerHTML = loadingHTML("Teste Verbindung …");
    try { await testKey(); box.innerHTML = `<div class="notice ok">✓ Verbindung erfolgreich.</div>`; }
    catch (e) { box.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
  });
  $("#theme").addEventListener("change", (e) => { const ns = getSettings(); ns.theme = e.target.value; saveSettings(ns); applyTheme(); });

  $("#exp").addEventListener("click", async () => {
    const json = JSON.stringify(exportAll(), null, 1);
    const filename = `naehrwert-sicherung-${dayKey(new Date())}.json`;
    if (IN_CLAUDE) {
      const dl = await capability("downloads");
      if (!dl) { toast("Export ist in dieser Ansicht nicht verfügbar."); return; }
      try { await dl.save({ filename, data: json }); toast("Sicherung gespeichert"); }
      catch (e) { if (e?.code !== "declined") toast("Export nicht möglich (" + (e?.code || "Fehler") + ")"); }
      return;
    }
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("#imp").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { importAll(JSON.parse(await f.text())); toast("Import erfolgreich"); applyTheme(); renderSettings(); }
    catch (err) { toast(err.message); }
  });
  armConfirm($("#wipe"), "Wirklich ALLES löschen? Nochmal tippen", () => { wipeAll(); toast("Alle Daten gelöscht"); applyTheme(); renderSettings(); });
}

// ------------------------------------------------------------------ Start
applyTheme();
render();
loadDB().catch((e) => toast(e.message, 5000));
if (IN_CLAUDE) {
  // Im Chat: KI über das Claude-Konto und dauerhafter Speicher – danach neu zeichnen
  const sheetClosed = () => !document.querySelector("#sheet:not([hidden])");
  initAI().then(() => { if (sheetClosed()) render(); });
  initStore().then((ok) => { if (ok) { applyTheme(); if (sheetClosed()) render(); } });
}
if (!IN_CLAUDE && "serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
// Tageswechsel um Mitternacht berücksichtigen, wenn die App offen bleibt
let lastToday = dayKey(new Date());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const now = dayKey(new Date());
  if (now !== lastToday) { if (dayKey(state.date) === lastToday) state.date = new Date(); lastToday = now; render(); }
});
