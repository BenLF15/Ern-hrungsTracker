// Kleine UI-Helfer: Escaping, Sheet (Modal mit Verlauf), Toast.
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const sheet = $("#sheet");
const body = $("#sheetBody");
const title = $("#sheetTitle");
const back = $("#sheetBack");
let stack = []; // [{title, render, cleanup}]
let onCloseCb = null;

function show() {
  const top = stack[stack.length - 1];
  title.textContent = top.title;
  back.hidden = stack.length < 2;
  body.innerHTML = "";
  body.scrollTop = 0;
  top.cleanup = top.render(body) || null;
}
function cleanupTop() {
  const top = stack[stack.length - 1];
  if (top && typeof top.cleanup === "function") { try { top.cleanup(); } catch {} }
  if (top) top.cleanup = null;
}

/** Öffnet ein neues Sheet (oder legt eine Ebene darauf, wenn push=true). render(body) kann eine Aufräumfunktion zurückgeben. */
export function openSheet(t, render, { push = false, onClose = null } = {}) {
  if (!push) { while (stack.length) { cleanupTop(); stack.pop(); } onCloseCb = onClose; }
  else cleanupTop();
  stack.push({ title: t, render });
  sheet.hidden = false;
  document.body.style.overflow = "hidden";
  show();
}
/** Ersetzt den Inhalt der obersten Ebene. */
export function replaceSheet(t, render) {
  cleanupTop();
  stack[stack.length - 1] = { title: t, render };
  show();
}
export function sheetBack() {
  if (stack.length < 2) return closeSheet();
  cleanupTop(); stack.pop(); show();
}
export function closeSheet() {
  while (stack.length) { cleanupTop(); stack.pop(); }
  sheet.hidden = true;
  document.body.style.overflow = "";
  const cb = onCloseCb; onCloseCb = null;
  if (cb) cb();
}
export function sheetOpen() { return !sheet.hidden; }

sheet.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });
back.addEventListener("click", sheetBack);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheetOpen()) sheetBack(); });

let toastT = null;
export function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, ms);
}

export function loadingHTML(text) { return `<div class="loading"><span class="spinner"></span><span>${esc(text)}</span></div>`; }
