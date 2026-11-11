(function () {
  'use strict';

  const app = document.getElementById('app');
  const topbar = document.getElementById('topbar');
  const dialog = document.getElementById('dialog');
  const nav = document.getElementById('nav');
  let me = null;
  let cleanups = [];
  let unreadTimer = null;
  const onCleanup = (fn) => cleanups.push(fn);

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const pad2 = (n) => String(n).padStart(2, '0');
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const addDays = (s, n) => Charts.dayStr(Charts.dayNum(s) + n);
  const daysBetween = (a, b) => Charts.dayNum(b) - Charts.dayNum(a);

  const num = (v, d = 0) =>
    v === null || v === undefined || Number.isNaN(v)
      ? '–'
      : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

  const signed = (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '±') + num(Math.abs(v), d);

  function fmtSleep(h) {
    if (h === null || h === undefined) return '–';
    const total = Math.round(h * 60);
    return `${Math.floor(total / 60)}:${pad2(total % 60)} h`;
  }

  function fmtDate(s, opts) {
    return new Date(`${s}T12:00:00`).toLocaleDateString('de-DE', opts || { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function relDay(s) {
    if (!s) return 'noch nie';
    const d = daysBetween(s, todayStr());
    if (d <= 0) return 'heute';
    if (d === 1) return 'gestern';
    return `vor ${d} Tagen`;
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  function parseNum(v) {
    const t = String(v ?? '').trim().replace(',', '.');
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  }

  function randomPassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = new Uint32Array(12);
    crypto.getRandomValues(buf);
    return Array.from(buf, (x) => chars[x % chars.length]).join('');
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Fehler ${res.status}`);
      err.status = res.status;
      if (res.status === 401 && me && url !== '/api/login') {
        me = null;
        route();
      }
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = isError ? 'toast error-toast' : 'toast';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  /** Opens a modal form. `onSubmit(form)` may throw to show an error; return false to keep it open. */
  function openDialog(html, onSubmit) {
    dialog.innerHTML = `<form method="dialog" novalidate>${html}<p class="error" hidden></p></form>`;
    const form = dialog.querySelector('form');
    const errEl = form.querySelector('.error');
    form.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      const btn = form.querySelector('[type=submit]');
      if (btn) btn.disabled = true;
      try {
        const keep = await onSubmit(form);
        if (keep !== false) dialog.close();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    dialog.showModal();
    const first = form.querySelector('input, textarea');
    if (first) first.focus();
  }

  /**
   * Left column on wide screens: scrolls with the page until its bottom (e.g. the save button) is visible,
   * then stays there. Short columns simply stay at the top.
   */
  function stickyColumn(el) {
    if (!el) return;
    const update = () => {
      const gap = 16;
      const header = topbar.offsetHeight || 60;
      el.style.top = `${Math.min(header + gap, window.innerHeight - el.offsetHeight - gap)}px`;
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    });
  }

  /** Small brass line above page titles, e.g. "Mittwoch, 11. November". */
  const todayLong = () => new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  const eyebrow = (text) => `<p class="eyebrow">${esc(text)}</p>`;

  // ---------- routing ----------
  async function boot() {
    try {
      me = (await api('GET', '/api/me')).user;
    } catch {
      me = null;
    }
    route();
  }

  function setView(html) {
    cleanups.forEach((fn) => fn());
    cleanups = [];
    app.innerHTML = html;
    window.scrollTo(0, 0);
  }

  function route() {
    if (!me) {
      topbar.hidden = true;
      clearInterval(unreadTimer);
      unreadTimer = null;
      return renderLogin();
    }
    topbar.hidden = false;
    document.getElementById('whoami').textContent = `${me.displayName} · ${me.role === 'coach' ? 'Coach' : 'Klient'}`;
    renderNav();
    if (!unreadTimer) unreadTimer = setInterval(refreshUnread, 30000);
    refreshUnread();
    const m = location.hash.match(/^#\/client\/(\d+)(?:\/(chat|nutrition))?/);
    if (me.role === 'coach') {
      if (m) return renderCoachClient(Number(m[1]), m[2] || 'overview');
      if (location.hash === '#/admin') return renderAdmin();
      if (location.hash === '#/checkin/done') return renderCheckinDone();
      const ci = location.hash.match(/^#\/checkin(?:\/(\d+))?/);
      if (ci) return renderCheckin(ci[1] ? Number(ci[1]) : null);
      return renderCoachHome();
    }
    if (location.hash === '#/chat') return renderClientChat();
    if (location.hash === '#/settings') return renderClientSettings();
    if (location.hash === '#/nutrition') return renderClientNutrition();
    return renderClientHome();
  }

  function renderNav() {
    const links =
      me.role === 'coach'
        ? [['#/', 'Klienten', true], ['#/checkin', 'Check-in', false], ['#/admin', 'Admin', false]]
        : [['#/', 'Tracker', false], ['#/nutrition', 'Ernährung', false], ['#/chat', 'Nachrichten', true], ['#/settings', 'Einstellungen', false]];
    const current =
      me.role === 'coach'
        ? location.hash.startsWith('#/checkin') ? '#/checkin' : location.hash === '#/admin' ? '#/admin' : '#/'
        : ['#/chat', '#/settings', '#/nutrition'].includes(location.hash) ? location.hash : '#/';
    nav.innerHTML = links
      .map(
        ([href, label, badge]) =>
          `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}${badge ? '<span class="count" data-unread hidden></span>' : ''}</a>`
      )
      .join('');
  }

  async function refreshUnread() {
    if (!me) return;
    try {
      const { unread } = await api('GET', '/api/messages/unread');
      nav.querySelectorAll('[data-unread]').forEach((b) => {
        b.textContent = unread > 99 ? '99+' : unread;
        b.hidden = !unread;
      });
    } catch {
      /* ignore – shown again on next poll */
    }
  }

  window.addEventListener('hashchange', route);

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await push.forgetDevice().catch(() => {});
    await api('POST', '/api/logout').catch(() => {});
    me = null;
    location.hash = '';
    route();
  });

  document.getElementById('btn-password').addEventListener('click', () => {
    openDialog(
      `<h2>Passwort ändern</h2>
       <div class="field"><label for="pw-cur">Aktuelles Passwort</label>
         <input id="pw-cur" name="cur" type="password" autocomplete="current-password" required></div>
       <div class="field"><label for="pw-new">Neues Passwort</label>
         <input id="pw-new" name="next" type="password" autocomplete="new-password" minlength="8" required>
         <div class="hint">Mindestens 8 Zeichen</div></div>
       <div class="dialog-actions">
         <button type="button" class="btn-secondary" data-close>Abbrechen</button>
         <button type="submit" class="btn-primary">Speichern</button>
       </div>`,
      async (f) => {
        await api('POST', '/api/me/password', { currentPassword: f.cur.value, newPassword: f.next.value });
        toast('Passwort geändert');
      }
    );
  });

  // ---------- login ----------
  function renderLogin() {
    setView(`
      <div class="login-wrap">
        <div class="login-intro">
          ${eyebrow('Thabstracker · Coaching')}
          <h1>Fortschritt,<br>präzise <em>festgehalten.</em></h1>
          <p>Gewicht, Schritte, Schlaf und Ernährung an einem Ort. Dein Coach sieht mit – du bleibst dran.</p>
          <div class="login-facts"><span>Täglich tracken</span><span>Wöchentlicher Check-in</span><span>Persönlicher Plan</span></div>
        </div>
        <form class="card login-card" id="login-form">
          <img class="login-logo" src="/logo.jpg" alt="Thabstracker" width="900" height="600">
          <div class="field"><label for="u">Benutzername</label>
            <input id="u" name="username" autocomplete="username" autocapitalize="none" required></div>
          <div class="field"><label for="p">Passwort</label>
            <input id="p" name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn-primary btn-block" type="submit">Anmelden</button>
          <p class="error" hidden></p>
        </form>
      </div>`);
    const form = document.getElementById('login-form');
    form.username.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = form.querySelector('.error');
      errEl.hidden = true;
      try {
        me = (await api('POST', '/api/login', { username: form.username.value, password: form.password.value })).user;
        route();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });
  }

  // ---------- client: daily entry ----------
  async function renderClientHome() {
    setView('<p class="muted">Lade…</p>');
    const [{ entries }, { goals, history }] = await Promise.all([api('GET', '/api/entries'), api('GET', '/api/goals')]);
    const state = { entries, goals, history };

    setView(`
      <div class="page-head">
        <div>${eyebrow(todayLong())}<h1>Hallo ${esc(me.displayName)}</h1><p class="muted" id="streak"></p></div>
      </div>
      <div id="push-prompt"></div>
      <div id="checkin-card"></div>
      <div class="grid-2">
        <form class="card" id="entry-form" novalidate>
          <div class="row-between" style="margin-bottom:12px">
            <h2>Tageseintrag</h2>
            <span class="badge" id="entry-status"></span>
          </div>
          <div class="field"><label for="f-date">Datum</label>
            <input id="f-date" name="date" type="date" required></div>
          <div class="field"><label for="f-weight">Gewicht</label>
            <div class="input-unit"><input id="f-weight" name="weight" inputmode="decimal" placeholder="z. B. 82,4"><span>kg</span></div></div>
          <div class="field"><label for="f-steps">Schritte</label>
            <div class="input-unit"><input id="f-steps" name="steps" inputmode="numeric" placeholder="z. B. 8500"><span>Schritte</span></div></div>
          <div class="field"><label for="f-sleep-h">Schlaf (letzte Nacht)</label>
            <div class="field-row">
              <div class="input-unit"><input id="f-sleep-h" name="sleepH" inputmode="numeric" placeholder="7"><span>Std.</span></div>
              <div class="input-unit"><input id="f-sleep-m" name="sleepM" inputmode="numeric" placeholder="30" aria-label="Schlaf Minuten"><span>Min.</span></div>
            </div></div>
          <fieldset class="field"><legend>Trainingstag?</legend>
            <div class="choice">
              <label><input type="radio" name="training" value="true"><span>🏋️ Ja</span></label>
              <label><input type="radio" name="training" value="false"><span class="no">Nein</span></label>
            </div></fieldset>
          <fieldset class="field" data-kcal-block hidden><legend>Kalorien laut Plan eingehalten? <span class="plan-hint" data-kcal-plan></span></legend>
            <div class="choice">
              <label><input type="radio" name="caloriesOk" value="true"><span>✓ Ja</span></label>
              <label><input type="radio" name="caloriesOk" value="false"><span class="no">✗ Nein</span></label>
            </div>
            <div data-kcal-eaten hidden style="margin-top:10px">
              <label for="f-kcal">Wie viel hast du gegessen? <span class="muted">(optional)</span></label>
              <div class="input-unit"><input id="f-kcal" name="calories" inputmode="numeric" placeholder="z. B. 2650"><span>kcal</span></div>
            </div></fieldset>
          <div class="field"><label for="f-note">Notiz <span class="muted">(optional)</span></label>
            <textarea id="f-note" name="note" maxlength="500" placeholder="Wie lief der Tag? Training, Ernährung, Befinden…"></textarea></div>
          <button class="btn-primary btn-block" type="submit">Speichern</button>
          <p class="error" hidden></p>
          <p class="hint">Du kannst jeden Wert auch später am Tag ergänzen – bereits gespeicherte Werte bleiben erhalten.</p>
        </form>
        <div id="dashboard" class="stack"></div>
      </div>`);

    const form = document.getElementById('entry-form');
    stickyColumn(form);
    const today = todayStr();
    form.date.max = today;
    form.date.value = today;

    function fillForm() {
      const e = state.entries.find((x) => x.date === form.date.value);
      form.weight.value = e && e.weight !== null ? String(e.weight).replace('.', ',') : '';
      form.steps.value = e && e.steps !== null ? e.steps : '';
      if (e && e.sleep !== null) {
        const total = Math.round(e.sleep * 60);
        form.sleepH.value = Math.floor(total / 60);
        form.sleepM.value = total % 60 || '';
      } else {
        form.sleepH.value = '';
        form.sleepM.value = '';
      }
      form.note.value = (e && e.note) || '';
      const setChoice = (name, v) =>
        form.querySelectorAll(`[name=${name}]`).forEach((r) => {
          r.checked = v !== null && v !== undefined && r.value === String(v);
          r.dataset.was = String(r.checked);
        });
      setChoice('training', e ? e.training : null);
      setChoice('caloriesOk', e ? e.caloriesOk : null);
      form.calories.value = e && e.calories !== null && e.calories !== undefined ? e.calories : '';
      syncKcal();
      const status = document.getElementById('entry-status');
      status.textContent = e ? 'gespeichert' : 'noch offen';
      status.className = e ? 'badge good' : 'badge';
    }

    function updateStreak() {
      const dates = new Set(state.entries.map((e) => e.date));
      let streak = 0;
      let d = dates.has(today) ? today : addDays(today, -1);
      while (dates.has(d)) {
        streak++;
        d = addDays(d, -1);
      }
      document.getElementById('streak').textContent = streak
        ? `🔥 ${streak} ${streak === 1 ? 'Tag' : 'Tage'} in Folge eingetragen`
        : 'Trag heute deine Werte ein.';
    }

    function syncKcal() {
      const block = form.querySelector('[data-kcal-block]');
      block.hidden = !hasKcal(state.goals);
      form.querySelector('[data-kcal-plan]').textContent = hasKcal(state.goals) ? `(Plan: ${fmtKcal(state.goals.caloriesMin, state.goals.caloriesMax)})` : '';
      const no = form.querySelector('[name=caloriesOk][value=false]').checked;
      form.querySelector('[data-kcal-eaten]').hidden = !no;
    }
    form.addEventListener('change', (e) => {
      if (e.target.name === 'caloriesOk') syncKcal();
    });
    // Tapping a selected choice again clears it.
    form.querySelectorAll('.choice input').forEach((r) =>
      r.addEventListener('click', () => {
        if (r.dataset.was === 'true') {
          r.checked = false;
          syncKcal();
        }
        form.querySelectorAll(`[name=${r.name}]`).forEach((x) => (x.dataset.was = String(x.checked)));
      })
    );
    form.date.addEventListener('change', fillForm);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errEl = form.querySelector('.error');
      errEl.hidden = true;
      try {
        const weight = parseNum(form.weight.value);
        const steps = parseNum(form.steps.value);
        const sh = parseNum(form.sleepH.value);
        const sm = parseNum(form.sleepM.value);
        if ([weight, steps, sh, sm].some(Number.isNaN)) throw new Error('Bitte nur Zahlen eingeben.');
        if (sm !== null && (sm < 0 || sm >= 60)) throw new Error('Minuten müssen zwischen 0 und 59 liegen.');
        const sleep = sh === null && sm === null ? null : Math.round(((sh || 0) + (sm || 0) / 60) * 100) / 100;
        if (!form.date.value) throw new Error('Bitte ein Datum wählen.');
        const choice = (name) => {
          const r = form.querySelector(`[name=${name}]:checked`);
          return r ? r.value === 'true' : null;
        };
        const caloriesOk = hasKcal(state.goals) ? choice('caloriesOk') : undefined;
        const calories = caloriesOk === false ? parseNum(form.calories.value) : caloriesOk === undefined ? undefined : null;
        if (Number.isNaN(calories)) throw new Error('Bitte bei den Kalorien nur Zahlen eingeben.');
        const { entry } = await api('PUT', `/api/entries/${form.date.value}`, {
          weight, steps, sleep, note: form.note.value, training: choice('training'), caloriesOk, calories,
        });
        state.entries = state.entries.filter((x) => x.date !== form.date.value);
        if (entry) state.entries.push(entry);
        state.entries.sort((a, b) => a.date.localeCompare(b.date));
        toast(entry ? 'Eintrag gespeichert ✓' : 'Eintrag entfernt');
        fillForm();
        updateStreak();
        dash.update(state.entries);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });

    const dash = mountDashboard(document.getElementById('dashboard'), {
      entries: state.entries,
      goals: state.goals,
      history: state.history,
      onEdit(date) {
        form.date.value = date;
        fillForm();
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
      async onDelete(date) {
        if (!confirm(`Eintrag vom ${fmtDate(date)} löschen?`)) return;
        await api('DELETE', `/api/entries/${date}`);
        state.entries = state.entries.filter((x) => x.date !== date);
        toast('Eintrag gelöscht');
        fillForm();
        updateStreak();
        dash.update(state.entries);
      },
    });
    fillForm();
    updateStreak();
    maybeShowPushPrompt(document.getElementById('push-prompt'));
    mountClientCheckin(document.getElementById('checkin-card'), async () => {
      const g = await api('GET', '/api/goals');
      state.goals = g.goals;
      state.history = g.history;
      dash.setGoals(g.goals, g.history);
      syncKcal();
    });
  }

  // ---------- client: latest check-in ----------
  async function mountClientCheckin(root, onAccepted) {
    let checkins;
    try {
      ({ checkins } = await api('GET', '/api/checkins'));
    } catch {
      return;
    }
    const ci = checkins[0];
    const recent = ci && Date.now() - Date.parse(ci.createdAt) < 8 * 86400000;
    // Once the client has accepted the changes, the check-in is done and the card disappears.
    if (!ci || ci.status === 'accepted' || !(recent || (ci.status === 'open' && ci.changes.length))) {
      root.innerHTML = '';
      return;
    }
    const date = new Date(ci.createdAt).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });
    const hasChanges = ci.changes.length > 0;
    const changesHtml = hasChanges
      ? `<div class="proposal"><div class="small muted" style="margin-bottom:6px">Vorgeschlagene Anpassungen für deinen Plan</div>
          <ul class="change-list">${ci.changeItems
            .map((i) => `<li><span>${esc(i.label)}</span><span><s class="muted">${esc(i.before)}</s> → <strong>${esc(i.after)}</strong></span></li>`)
            .join('')}</ul></div>`
      : '';
    const state =
      ci.status === 'accepted'
        ? `<p class="good small" style="margin:10px 0 0"><strong>✓ Angenommen</strong> am ${esc(new Date(ci.acceptedAt).toLocaleDateString('de-DE'))} – dein Plan ist aktualisiert.</p>`
        : '';
    root.innerHTML = `
      <section class="card checkin-card">
        <div class="row-between"><h2>📋 Check-in von deinem Coach</h2><span class="badge">${esc(date)}</span></div>
        <p class="checkin-msg">${esc(ci.message)}</p>
        ${changesHtml}
        ${state}
        <div class="row" style="margin-top:12px">
          ${hasChanges && ci.status === 'open' ? '<button type="button" class="btn-primary" data-accept>✓ Anpassungen annehmen</button>' : ''}
          <button type="button" class="btn-secondary" data-reply>${ci.repliedAt ? 'Nochmal antworten' : 'Antworten'}</button>
        </div>
        <form class="reply-form" hidden>
          <textarea name="body" maxlength="2000" placeholder="Deine Antwort an den Coach…"></textarea>
          <div class="row" style="margin-top:8px"><button type="submit" class="btn-primary">Antwort senden</button>
            <button type="button" class="btn-ghost" data-cancel>Abbrechen</button></div>
        </form>
        ${ci.repliedAt ? '<p class="small muted" style="margin:8px 0 0">Deine Antwort ist im Chat unter „Nachrichten“.</p>' : ''}
      </section>`;

    const form = root.querySelector('.reply-form');
    root.querySelector('[data-reply]').addEventListener('click', () => {
      form.hidden = false;
      form.body.focus();
    });
    root.querySelector('[data-cancel]').addEventListener('click', () => (form.hidden = true));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.body.value.trim()) return;
      try {
        await api('POST', `/api/checkins/${ci.id}/reply`, { body: form.body.value });
        toast('Antwort gesendet');
        mountClientCheckin(root, onAccepted);
      } catch (err) {
        toast(err.message, true);
      }
    });
    const accept = root.querySelector('[data-accept]');
    if (accept) {
      accept.addEventListener('click', async () => {
        accept.disabled = true;
        try {
          await api('POST', `/api/checkins/${ci.id}/accept`);
          toast('Anpassungen angenommen – dein Plan ist aktualisiert ✓');
          await onAccepted();
          mountClientCheckin(root, onAccepted);
        } catch (err) {
          accept.disabled = false;
          toast(err.message, true);
        }
      });
    }
  }

  // ---------- plan (goals) helpers ----------
  const PLAN_LABELS = {
    calories: 'Kalorien pro Tag',
    stepsGoal: 'Schritte pro Tag',
    sleepGoal: 'Schlaf pro Nacht',
    targetWeight: 'Zielgewicht',
  };
  function fmtPlan(key, v) {
    if (v === null || v === undefined) return '–';
    if (key === 'stepsGoal') return `${num(v)} Schritte`;
    if (key === 'sleepGoal') return fmtSleep(v);
    return `${num(v, 1)} kg`;
  }
  const hasKcal = (g) => g && g.caloriesMin !== null && g.caloriesMin !== undefined;
  function fmtKcal(min, max) {
    if (min === null || min === undefined) return '–';
    return min === max ? `${num(min)} kcal` : `${num(min)}–${num(max)} kcal`;
  }
  const kcalMid = (g) => (hasKcal(g) ? Math.round((g.caloriesMin + g.caloriesMax) / 2) : null);

  /** Calorie range for every day between from and to, from the history of plan changes. */
  function kcalTargets(history, from, to) {
    const changes = (history || []).map((h) => {
      const d = new Date(h.changedAt);
      return { date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, min: h.caloriesMin, max: h.caloriesMax };
    });
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      let cur = null;
      for (const c of changes) if (c.date <= d) cur = c;
      if (cur && cur.min !== null && cur.min !== undefined) out.push({ date: d, min: cur.min, max: cur.max });
    }
    return out;
  }

  function kcalCell(e) {
    if (e.caloriesOk === true) return '<span class="good">✓ eingehalten</span>';
    if (e.caloriesOk === false) return `<span class="bad">✗ ${e.calories !== null && e.calories !== undefined ? `${num(e.calories)} kcal` : 'nicht eingehalten'}</span>`;
    return '–';
  }

  // ---------- shared dashboard ----------
  const RANGES = [
    ['30', '30 T'],
    ['90', '90 T'],
    ['365', '1 J'],
    ['all', 'Alle'],
  ];

  function mountDashboard(root, { entries, goals, history, onEdit, onDelete }) {
    let rangeKey = '30';
    let all = entries;

    root.innerHTML = `
      <div class="row-between">
        <h2>Verlauf</h2>
        <div class="segmented" role="group" aria-label="Zeitraum">
          ${RANGES.map(([k, l]) => `<button type="button" data-range="${k}" aria-pressed="${k === rangeKey}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="stats" data-stats></div>
      <div class="card chart-card">
        <div class="row-between"><h3>Gewicht</h3>
          <div class="legend"><span><i class="faint"></i>Tageswert</span><span><i></i>Ø 7 Tage</span></div></div>
        <div class="chart-weight" data-chart="weight"></div>
      </div>
      <div class="card chart-card">
        <div class="row-between"><h3>Kalorien</h3><span class="kcal-now" data-kcal-now></span></div>
        <div class="legend" style="margin:4px 0 6px;flex-wrap:wrap">
          <span><i class="lg-band"></i>Vorgabe (Range)</span><span><i></i>Mittelwert</span>
          <span><i class="lg-dot" style="background:var(--good)"></i>eingehalten</span>
          <span><i class="lg-dot" style="background:var(--bad)"></i>nicht eingehalten</span>
        </div>
        <div class="chart-kcal" data-chart="kcal"></div>
      </div>
      <div class="card chart-card"><h3>Schritte</h3><div class="chart-steps" data-chart="steps"></div></div>
      <div class="card chart-card"><h3>Schlaf</h3><div class="chart-sleep" data-chart="sleep"></div></div>
      <div class="card">
        <h3 style="margin-bottom:8px">Einträge</h3>
        <div class="table-wrap" data-table></div>
      </div>`;

    root.querySelectorAll('[data-range]').forEach((b) =>
      b.addEventListener('click', () => {
        rangeKey = b.dataset.range;
        root.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        draw();
      })
    );

    function rangeBounds() {
      const to = todayStr();
      if (rangeKey === 'all') return { from: all.length ? all[0].date : addDays(to, -29), to };
      return { from: addDays(to, -(Number(rangeKey) - 1)), to };
    }

    function drawStats() {
      const today = todayStr();
      const last7 = all.filter((e) => daysBetween(e.date, today) < 7 && daysBetween(e.date, today) >= 0);
      const weights = all.filter((e) => e.weight !== null);
      const cur = weights.length ? weights[weights.length - 1] : null;
      const start = weights.length ? weights[0] : null;
      // Compare against the latest weigh-in at least 7 days older than the current one.
      let ref7 = null;
      if (cur) for (const w of weights) if (daysBetween(w.date, cur.date) >= 7) ref7 = w;

      const goodDir = goals.targetWeight !== null && cur && goals.targetWeight > cur.weight ? 1 : -1;
      const deltaCls = (d) => (d === 0 ? '' : Math.sign(d) === goodDir ? 'down' : 'up');

      let weightSub = 'Noch kein Gewicht eingetragen';
      if (cur) {
        const parts = [];
        if (ref7) {
          const d = cur.weight - ref7.weight;
          parts.push(`<span class="${deltaCls(d)}">${signed(d)} kg</span> in 7 T`);
        }
        if (start && start.date !== cur.date) {
          const d = cur.weight - start.weight;
          parts.push(`<span class="${deltaCls(d)}">${signed(d)} kg</span> gesamt`);
        }
        weightSub = parts.join(' · ') || `am ${fmtDate(cur.date, { day: '2-digit', month: '2-digit' })}`;
      }

      const steps7 = avg(last7.filter((e) => e.steps !== null).map((e) => e.steps));
      const sleep7 = avg(last7.filter((e) => e.sleep !== null).map((e) => e.sleep));
      const stepsHit = goals.stepsGoal ? last7.filter((e) => e.steps !== null && e.steps >= goals.stepsGoal).length : null;
      const sleepHit = goals.sleepGoal ? last7.filter((e) => e.sleep !== null && e.sleep >= goals.sleepGoal).length : null;

      let targetSub = 'Kein Zielgewicht festgelegt';
      if (goals.targetWeight !== null) {
        targetSub = cur
          ? Math.abs(cur.weight - goals.targetWeight) < 0.05
            ? '<span class="good">Ziel erreicht 🎉</span>'
            : `noch ${num(Math.abs(cur.weight - goals.targetWeight), 1)} kg`
          : '';
        targetSub = `Ziel ${num(goals.targetWeight, 1)} kg · ${targetSub}`;
      }

      const daysLogged = new Set(last7.map((e) => e.date)).size;
      const consistencyCls = daysLogged >= 6 ? 'good' : daysLogged >= 4 ? 'warn' : 'bad';
      const kcalAnswered = last7.filter((e) => e.caloriesOk !== null && e.caloriesOk !== undefined).length;
      const kcalKept = last7.filter((e) => e.caloriesOk === true).length;
      const trainingDays = last7.filter((e) => e.training === true).length;

      root.querySelector('[data-stats]').innerHTML = `
        <div class="card stat">
          <div class="stat-label"><span class="dot-key" style="background:var(--weight)"></span>Gewicht</div>
          <div class="stat-value">${cur ? num(cur.weight, 1) : '–'} <small>kg</small></div>
          <div class="stat-sub">${weightSub}</div>
          <div class="stat-sub">${targetSub}</div>
        </div>
        <div class="card stat">
          <div class="stat-label"><span class="dot-key" style="background:var(--steps)"></span>Schritte Ø 7 T</div>
          <div class="stat-value">${num(steps7)}</div>
          <div class="stat-sub">${goals.stepsGoal ? `Ziel ${num(goals.stepsGoal)} · ${stepsHit}/7 Tage erreicht` : 'Kein Schrittziel'}</div>
        </div>
        <div class="card stat">
          <div class="stat-label"><span class="dot-key" style="background:var(--sleep)"></span>Schlaf Ø 7 T</div>
          <div class="stat-value">${fmtSleep(sleep7)}</div>
          <div class="stat-sub">${goals.sleepGoal ? `Ziel ${fmtSleep(goals.sleepGoal)} · ${sleepHit}/7 Nächte erreicht` : 'Kein Schlafziel'}</div>
        </div>
        <div class="card stat">
          <div class="stat-label"><span class="dot-key" style="background:var(--accent)"></span>Kalorien / Tag</div>
          <div class="stat-value">${hasKcal(goals) ? num(kcalMid(goals)) : '–'} <small>kcal</small></div>
          <div class="stat-sub">${hasKcal(goals) ? (goals.caloriesMin !== goals.caloriesMax ? `Range ${esc(fmtKcal(goals.caloriesMin, goals.caloriesMax))}` : 'Vorgabe deines Coaches') : 'Noch keine Vorgabe'}</div>
          <div class="stat-sub">${kcalAnswered ? `${kcalKept}/${kcalAnswered} Tage eingehalten (7 T)` : ''}</div>
        </div>
        <div class="card stat">
          <div class="stat-label">🏋️ Training</div>
          <div class="stat-value">${trainingDays}<small>×</small></div>
          <div class="stat-sub">Trainingstage in den letzten 7 Tagen</div>
        </div>
        <div class="card stat">
          <div class="stat-label">Konsequenz</div>
          <div class="stat-value ${consistencyCls}">${daysLogged}<small>/7</small></div>
          <div class="stat-sub">Tage eingetragen (letzte Woche)</div>
          <div class="stat-sub">Letzter Eintrag: ${relDay(all.length ? all[all.length - 1].date : null)}</div>
        </div>`;
    }

    function drawCharts() {
      const { from, to } = rangeBounds();
      const inRange = all.filter((e) => e.date >= from && e.date <= to);
      const series = (k) => inRange.map((e) => ({ date: e.date, value: e[k] }));
      Charts.render(root.querySelector('[data-chart=weight]'), {
        data: series('weight'), from, to, type: 'line', trend: true,
        goal: goals.targetWeight, unit: 'kg', decimals: 1, label: 'Gewichtsverlauf',
      });
      Charts.render(root.querySelector('[data-chart=steps]'), {
        data: series('steps'), from, to, type: 'bar',
        goal: goals.stepsGoal, unit: 'Schritte', label: 'Schritte pro Tag',
      });
      Charts.render(root.querySelector('[data-chart=sleep]'), {
        data: series('sleep'), from, to, type: 'bar', decimals: 1,
        goal: goals.sleepGoal, label: 'Schlafdauer', formatValue: fmtSleep,
      });
      root.querySelector('[data-kcal-now]').innerHTML = hasKcal(goals)
        ? `<strong>${esc(fmtKcal(goals.caloriesMin, goals.caloriesMax))}</strong>${goals.caloriesMin !== goals.caloriesMax ? ` <span class="muted small">Ø ${num(kcalMid(goals))}</span>` : ''}`
        : '<span class="muted small">Noch keine Vorgabe</span>';
      Charts.renderCalories(root.querySelector('[data-chart=kcal]'), {
        from, to, height: 190,
        targets: kcalTargets(history, from, to),
        days: inRange.map((e) => ({ date: e.date, ok: e.caloriesOk, kcal: e.calories })),
      });
    }

    function drawTable() {
      const { from, to } = rangeBounds();
      const rows = all.filter((e) => e.date >= from && e.date <= to).slice().reverse();
      const wrap = root.querySelector('[data-table]');
      if (!rows.length) {
        wrap.innerHTML = '<div class="empty-state">Keine Einträge in diesem Zeitraum.</div>';
        return;
      }
      const editable = Boolean(onEdit);
      wrap.innerHTML = `<table>
        <thead><tr><th>Datum</th><th class="num">Gewicht</th><th class="num">Schritte</th><th class="num">Schlaf</th><th>Training</th><th>Kalorien</th><th>Notiz</th>${editable ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows
          .map(
            (e) => `<tr>
              <td>${esc(fmtDate(e.date))}</td>
              <td class="num">${e.weight !== null ? `${num(e.weight, 1)} kg` : '–'}</td>
              <td class="num">${num(e.steps)}</td>
              <td class="num">${fmtSleep(e.sleep)}</td>
              <td>${e.training === true ? '🏋️ Ja' : e.training === false ? '<span class="muted">Nein</span>' : '–'}</td>
              <td>${kcalCell(e)}</td>
              <td class="note">${esc(e.note || '')}</td>
              ${editable ? `<td class="actions"><button type="button" class="btn-ghost btn-sm" data-edit="${e.date}">Bearbeiten</button><button type="button" class="btn-ghost btn-sm" data-del="${e.date}" aria-label="Löschen">✕</button></td>` : ''}
            </tr>`
          )
          .join('')}</tbody></table>`;
      if (editable) {
        wrap.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => onEdit(b.dataset.edit)));
        wrap.querySelectorAll('[data-del]').forEach((b) =>
          b.addEventListener('click', () => onDelete(b.dataset.del).catch((err) => toast(err.message, true)))
        );
      }
    }

    function draw() {
      drawStats();
      drawCharts();
      drawTable();
    }

    let resizeTimer;
    const resizeHandler = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(drawCharts, 150);
    };
    window.addEventListener('resize', resizeHandler);
    onCleanup(() => window.removeEventListener('resize', resizeHandler));

    draw();
    return {
      update(newEntries) {
        all = newEntries;
        draw();
      },
      setGoals(g, h) {
        goals = g;
        if (h) history = h;
        draw();
      },
    };
  }

  // ---------- push notifications ----------
  const push = {
    supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    isIos: () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    standalone: () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,

    /** Why push can't work in this browser, or null if it can. */
    blocker() {
      if (push.isIos() && !push.standalone()) return 'ios-home-screen';
      if (!push.supported()) return 'unsupported';
      return null;
    },

    async registration() {
      if (!('serviceWorker' in navigator)) return null;
      return navigator.serviceWorker.register('/sw.js');
    },

    async localSubscription() {
      if (!push.supported()) return null;
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? reg.pushManager.getSubscription() : null;
    },

    async enable() {
      const { publicKey } = await api('GET', '/api/push/config');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        if (permission === 'denied') {
          await api('POST', '/api/push/consent', { status: 'denied' });
          throw new Error('Mitteilungen sind im Browser blockiert. Du kannst sie in den Einstellungen deines Geräts für diese Seite wieder erlauben.');
        }
        throw new Error('Mitteilungen wurden nicht erlaubt.');
      }
      const reg = await push.registration();
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (publicKey.length % 4)) % 4));
        try {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
          });
        } catch (err) {
          throw new Error(`Dieser Browser konnte sich nicht für Push-Nachrichten anmelden. Bitte einen anderen Browser oder das Handy verwenden. (${err.message})`);
        }
      }
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
    },

    async disable() {
      await push.forgetDevice();
      await api('POST', '/api/push/consent', { status: 'denied' });
    },

    /** Stops pushes to this browser only (e.g. on logout), without changing consent. */
    async forgetDevice() {
      const sub = await push.localSubscription();
      if (!sub) return;
      await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    },
  };

  const IOS_HINT =
    'Auf dem iPhone funktionieren Push-Nachrichten nur, wenn Thabstracker auf dem Home-Bildschirm liegt: ' +
    'In Safari unten auf das Teilen-Symbol tippen → „Zum Home-Bildschirm“ → danach Thabstracker über das neue App-Symbol öffnen und hier aktivieren.';

  /** Card with push status + buttons. Used on the client settings page and for the coach. */
  async function mountPushCard(root, { title, intro }) {
    const [cfg, local] = await Promise.all([api('GET', '/api/push/config'), push.localSubscription().catch(() => null)]);
    const blocker = push.blocker();
    let statusHtml;
    let buttons = '';
    if (cfg.status === 'granted' && local) {
      statusHtml = '<span class="badge good">Aktiv auf diesem Gerät</span>';
      buttons = `<button type="button" class="btn-secondary" data-push="test">Test senden</button>
                 <button type="button" class="btn-ghost" data-push="off">Deaktivieren</button>`;
    } else if (blocker === 'ios-home-screen') {
      statusHtml = '<span class="badge warn">Erst zum Home-Bildschirm hinzufügen</span>';
    } else if (blocker === 'unsupported') {
      statusHtml = '<span class="badge">Von diesem Browser nicht unterstützt</span>';
    } else {
      statusHtml =
        cfg.status === 'denied'
          ? '<span class="badge bad">Ausgeschaltet</span>'
          : cfg.status === 'granted'
            ? `<span class="badge warn">Aktiv auf ${cfg.devices} anderen Gerät${cfg.devices === 1 ? '' : 'en'}</span>`
            : '<span class="badge">Noch nicht eingerichtet</span>';
      buttons = '<button type="button" class="btn-primary" data-push="on">Benachrichtigungen aktivieren</button>';
    }
    root.innerHTML = `
      <div class="row-between" style="margin-bottom:8px"><h2>${esc(title)}</h2>${statusHtml}</div>
      <p class="muted small">${esc(intro)}</p>
      ${blocker === 'ios-home-screen' ? `<p class="hint-box">${esc(IOS_HINT)}</p>` : ''}
      <div class="row">${buttons}</div>`;
    const run = (fn, msg) => async (e) => {
      e.target.disabled = true;
      try {
        await fn();
        if (msg) toast(msg);
      } catch (err) {
        toast(err.message, true);
      }
      mountPushCard(root, { title, intro });
    };
    const on = root.querySelector('[data-push=on]');
    if (on) on.addEventListener('click', run(push.enable, 'Benachrichtigungen aktiviert ✓'));
    const off = root.querySelector('[data-push=off]');
    if (off) off.addEventListener('click', run(push.disable, 'Benachrichtigungen ausgeschaltet'));
    const test = root.querySelector('[data-push=test]');
    if (test) {
      test.addEventListener('click', run(async () => {
        const r = await api('POST', '/api/push/test');
        if (!r.delivered) throw new Error('Test konnte nicht zugestellt werden.');
      }, 'Test gesendet – kommt gleich an'));
    }
  }

  /** One-time question on the tracker page for clients who haven't decided yet. */
  async function maybeShowPushPrompt(root) {
    try {
      const cfg = await api('GET', '/api/push/config');
      if (cfg.status !== 'unknown' || push.blocker() === 'unsupported') return;
      const ios = push.blocker() === 'ios-home-screen';
      try {
        if (ios && localStorage.getItem('pushPromptLater') === todayStr()) return;
      } catch {
        /* storage unavailable */
      }
      root.innerHTML = `
        <div class="card banner">
          <div><strong>🔔 Erinnerungen &amp; Nachrichten von deinem Coach aufs Handy?</strong>
            <p class="small muted">${ios ? esc(IOS_HINT) : 'Du kannst das jederzeit unter „Einstellungen“ wieder ändern.'}</p></div>
          <div class="row">
            ${ios ? '<button type="button" class="btn-secondary" data-later>Später</button>' : `
              <button type="button" class="btn-primary" data-yes>Ja, aktivieren</button>
              <button type="button" class="btn-ghost" data-no>Nein danke</button>`}
          </div>
        </div>`;
      const yes = root.querySelector('[data-yes]');
      if (yes) {
        yes.addEventListener('click', async () => {
          try {
            await push.enable();
            toast('Benachrichtigungen aktiviert ✓');
            root.innerHTML = '';
          } catch (err) {
            toast(err.message, true);
          }
        });
      }
      const no = root.querySelector('[data-no]');
      if (no) {
        no.addEventListener('click', async () => {
          await api('POST', '/api/push/consent', { status: 'denied' }).catch(() => {});
          root.innerHTML = '';
        });
      }
      const later = root.querySelector('[data-later]');
      if (later) {
        later.addEventListener('click', () => {
          try {
            localStorage.setItem('pushPromptLater', todayStr());
          } catch {
            /* ignore */
          }
          root.innerHTML = '';
        });
      }
    } catch {
      /* not critical */
    }
  }

  // ---------- client: settings (push + Apple Health) ----------
  async function renderClientSettings() {
    setView(`
      <div class="page-head"><div>${eyebrow('Konto')}<h1>Einstellungen</h1></div></div>
      <div class="settings-grid">
        <section class="card" id="push-card"><p class="muted">Lade…</p></section>
        <section class="card" id="health-card"><p class="muted">Lade…</p></section>
      </div>`);
    mountPushCard(document.getElementById('push-card'), {
      title: 'Push-Benachrichtigungen',
      intro: 'Erinnerungen deines Coaches und neue Chat-Nachrichten direkt aufs Handy.',
    }).catch((err) => toast(err.message, true));
    mountHealthCard(document.getElementById('health-card'));
  }

  async function mountHealthCard(root, freshToken) {
    const status = await api('GET', '/api/health/token');
    const importUrl = `${location.origin}/api/health/import`;
    const fmtTs = (iso) => new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    let statusHtml = '<span class="badge">Nicht verbunden</span>';
    if (status.linked) {
      statusHtml = status.lastUsedAt
        ? `<span class="badge good">Zuletzt übertragen: ${esc(fmtTs(status.lastUsedAt))}</span>`
        : '<span class="badge warn">Eingerichtet, noch keine Übertragung</span>';
    }

    const keyBlock = freshToken
      ? `<div class="field"><label>Dein persönlicher Schlüssel <span class="muted">(wird nur jetzt angezeigt!)</span></label>
           <div class="copy-field"><code>${esc(freshToken)}</code><button type="button" class="btn-secondary btn-sm" data-copy="${esc(freshToken)}">Kopieren</button></div></div>`
      : status.linked
        ? '<p class="small muted">Dein Schlüssel ist eingerichtet. Hast du ihn verloren oder ein neues Handy? Dann erzeuge einen neuen – der alte wird damit ungültig.</p>'
        : '';

    root.innerHTML = `
      <div class="row-between" style="margin-bottom:8px"><h2>Apple Health (iPhone)</h2>${statusHtml}</div>
      <p class="muted small">Webseiten haben keinen direkten Zugriff auf Apple Health. Über die Apple-App <strong>„Kurzbefehle“</strong>
        überträgt dein iPhone deine Schritte (und auf Wunsch dein Gewicht) aber automatisch jeden Tag hierher.</p>
      ${keyBlock}
      <div class="field"><label>Adresse für den Kurzbefehl</label>
        <div class="copy-field"><code>${esc(importUrl)}</code><button type="button" class="btn-secondary btn-sm" data-copy="${esc(importUrl)}">Kopieren</button></div></div>
      <div class="row" style="margin-bottom:12px">
        <button type="button" class="${status.linked ? 'btn-secondary' : 'btn-primary'}" data-health="new">${status.linked ? 'Neuen Schlüssel erzeugen' : 'Verbindung einrichten'}</button>
        ${status.linked ? '<button type="button" class="btn-ghost" data-health="off">Verbindung trennen</button>' : ''}
      </div>
      <details class="howto"${freshToken ? ' open' : ''}>
        <summary>Anleitung: Kurzbefehl einrichten (ca. 5 Minuten, einmalig)</summary>
        <ol>
          <li>Oben auf <strong>„Verbindung einrichten“</strong> tippen und den Schlüssel kopieren.</li>
          <li>App <strong>Kurzbefehle</strong> öffnen → unten <strong>„Automation“</strong> → <strong>„+“</strong> → <strong>„Tageszeit“</strong>.
            Uhrzeit z. B. <strong>21:30</strong>, <strong>Täglich</strong>, und <strong>„Sofort ausführen“</strong> wählen → <strong>Weiter</strong> → <strong>„Neuer leerer Kurzbefehl“</strong>.</li>
          <li>Aktion <strong>„Health-Stichproben suchen“</strong> <span class="muted">(engl. „Find Health Samples“)</span> hinzufügen:
            Typ <strong>Schritte</strong>, Filter <strong>„Startdatum ist heute“</strong>, <strong>„Gruppieren nach: Tag“</strong>.</li>
          <li>Aktion <strong>„Inhalte von URL abrufen“</strong> <span class="muted">(„Get Contents of URL“)</span> hinzufügen und die
            <strong>Adresse</strong> von oben einfügen. Auf den Pfeil tippen:
            <ul>
              <li>Methode: <strong>POST</strong></li>
              <li>Header hinzufügen: Schlüssel <code>Authorization</code>, Wert <code>Bearer </code> + dein Schlüssel
                <span class="muted">(Bearer, Leerzeichen, Schlüssel)</span></li>
              <li>Anforderungstext: <strong>JSON</strong> → Feld hinzufügen → Typ <strong>Zahl</strong>, Schlüssel <code>steps</code>,
                Wert: Variable <strong>„Health-Stichproben“</strong></li>
            </ul></li>
          <li>Fertig. Zum Testen den Kurzbefehl einmal von Hand starten – hier oben erscheint dann „Zuletzt übertragen“.</li>
        </ol>
        <p class="small muted"><strong>Gewicht mit übertragen (optional, z. B. von einer smarten Waage):</strong> eine zweite
          „Health-Stichproben suchen“-Aktion mit Typ <strong>Gewicht</strong>, sortiert nach <strong>Startdatum, Neueste zuerst</strong>,
          <strong>Limit 1</strong>, und im JSON ein zweites Zahl-Feld <code>weight</code> mit diesem Ergebnis.</p>
        <p class="small muted">Die Übertragung ergänzt nur Schritte bzw. Gewicht des Tages – deine Notizen und übrigen Werte bleiben erhalten.
          Läuft die Automation mehrmals am Tag, gilt der letzte Wert.</p>
        <p class="small muted"><strong>Android:</strong> Eine direkte Anbindung an Google Health Connect ist über eine Webseite ebenfalls nicht möglich.</p>
      </details>`;

    root.querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
          toast('Kopiert');
        } catch {
          toast('Kopieren nicht möglich – bitte manuell markieren', true);
        }
      })
    );
    root.querySelector('[data-health=new]').addEventListener('click', async () => {
      if (status.linked && !confirm('Neuen Schlüssel erzeugen? Der bisherige Kurzbefehl funktioniert dann erst wieder mit dem neuen Schlüssel.')) return;
      try {
        const { token } = await api('POST', '/api/health/token');
        mountHealthCard(root, token);
      } catch (err) {
        toast(err.message, true);
      }
    });
    const off = root.querySelector('[data-health=off]');
    if (off) {
      off.addEventListener('click', async () => {
        if (!confirm('Verbindung trennen? Der Kurzbefehl kann danach keine Daten mehr übertragen.')) return;
        await api('DELETE', '/api/health/token');
        toast('Verbindung getrennt');
        mountHealthCard(root);
      });
    }
  }

  // ---------- chat ----------
  function renderClientChat() {
    setView(`<div class="page-head"><div>${eyebrow('Chat mit deinem Coach')}<h1>Nachrichten</h1></div></div><div id="chat"></div>`);
    mountChat(document.getElementById('chat'), {
      query: '',
      title: 'Dein Draht zum Coach',
      subtitle: 'Wünsche, Fragen und Vorschläge – nur dein Coach liest mit.',
      empty: 'Noch keine Nachrichten. Schreib deinem Coach, was dir auf dem Herzen liegt – z. B. Wünsche zum Training, Fragen zur Ernährung oder Vorschläge.',
    });
  }

  function mountChat(root, { query, title, subtitle, empty }) {
    root.innerHTML = `
      <section class="card chat">
        <div class="chat-head"><h2>${esc(title)}</h2><p class="muted small">${esc(subtitle)}</p></div>
        <div class="chat-log" aria-live="polite"><p class="chat-empty">Lade…</p></div>
        <form class="chat-form">
          <textarea name="body" rows="1" maxlength="2000" placeholder="Nachricht schreiben…" aria-label="Nachricht"></textarea>
          <button class="btn-primary" type="submit">Senden</button>
        </form>
      </section>`;
    const log = root.querySelector('.chat-log');
    const form = root.querySelector('.chat-form');
    const input = form.body;
    let messages = [];
    let lastId = 0;
    let stopped = false;
    let scrolledOnce = false;

    const timeOf = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const dayOf = (iso) => {
      const d = new Date(iso);
      const local = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const diff = daysBetween(local, todayStr());
      return diff === 0 ? 'Heute' : diff === 1 ? 'Gestern' : fmtDate(local);
    };

    function draw() {
      if (!messages.length) {
        log.innerHTML = `<p class="chat-empty">${esc(empty)}</p>`;
        return;
      }
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      let day = '';
      log.innerHTML = messages
        .map((m) => {
          const d = dayOf(m.createdAt);
          const sep = d !== day ? `<div class="chat-day">${esc(d)}</div>` : '';
          day = d;
          return `${sep}<div class="msg ${m.mine ? 'mine' : 'theirs'}">${esc(m.body)}<time>${timeOf(m.createdAt)}</time></div>`;
        })
        .join('');
      if (nearBottom || !scrolledOnce) log.scrollTop = log.scrollHeight;
      scrolledOnce = true;
    }

    async function load() {
      try {
        const { messages: fresh } = await api('GET', `/api/messages${query}${query ? '&' : '?'}after=${lastId}`);
        if (stopped) return;
        if (fresh.length || !lastId) {
          messages = messages.concat(fresh);
          if (fresh.length) lastId = fresh[fresh.length - 1].id;
          draw();
          refreshUnread();
        }
      } catch {
        /* retry on next poll */
      }
    }

    function autosize() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`;
    }
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        await api('POST', `/api/messages${query}`, { body });
        input.value = '';
        autosize();
        await load();
        log.scrollTop = log.scrollHeight;
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        input.focus();
      }
    });

    load();
    const timer = setInterval(load, 8000);
    onCleanup(() => {
      stopped = true;
      clearInterval(timer);
    });
  }

  // ---------- coach: overview ----------
  async function renderCoachHome() {
    setView('<p class="muted">Lade…</p>');
    const { clients } = await api('GET', '/api/clients');

    const cards = clients
      .map((c) => {
        const days = c.lastEntry ? daysBetween(c.lastEntry, todayStr()) : null;
        const cls = days === null ? 'bad' : days <= 1 ? 'good' : days <= 3 ? 'warn' : 'bad';
        const delta = c.lastWeight !== null && c.firstWeight !== null ? c.lastWeight - c.firstWeight : null;
        return `<a class="card client-card" href="#/client/${c.id}${c.unreadMessages ? '/chat' : ''}">
          <div class="row-between">
            <h3>${esc(c.displayName)}</h3>
            <div class="row" style="gap:6px">
              ${c.unreadMessages ? `<span class="unread-badge">💬 ${c.unreadMessages} neu</span>` : ''}
              ${c.openSwaps ? `<span class="unread-badge">🍽 ${c.openSwaps}</span>` : ''}
              <span class="badge ${cls}">${relDay(c.lastEntry)}</span>
            </div>
          </div>
          <div class="muted small">@${esc(c.username)} · ${c.entries7d}/7 Tage eingetragen</div>
          <div class="metrics">
            <div><div class="metric-v">${c.lastWeight !== null ? `${num(c.lastWeight, 1)} kg` : '–'}</div>
              <div class="metric-l">${delta !== null ? `${signed(delta)} kg gesamt` : 'Gewicht'}</div></div>
            <div><div class="metric-v">${num(c.avgSteps7d)}</div><div class="metric-l">Schritte Ø 7 T</div></div>
            <div><div class="metric-v">${fmtSleep(c.avgSleep7d)}</div><div class="metric-l">Schlaf Ø 7 T</div></div>
          </div>
        </a>`;
      })
      .join('');

    setView(`
      <div class="page-head">
        <div>${eyebrow(todayLong())}<h1>Meine Klienten</h1><p class="muted">${clients.length} ${clients.length === 1 ? 'Klient' : 'Klienten'}</p></div>
        <button class="btn-primary" id="btn-new-client" type="button">+ Neuer Klient</button>
      </div>
      ${clients.length ? `<div class="client-list">${cards}</div>` : `<div class="card empty-state">
        <p>Noch keine Klienten angelegt.</p>
        <p>Lege einen Zugang an und gib die Zugangsdaten an deinen Klienten weiter.</p></div>`}
      <div class="page-head section-head">
        <div><h2>Push-Benachrichtigungen</h2>
          <p class="muted small">Einmalige und wiederkehrende Nachrichten an Klienten, die zugestimmt haben.</p></div>
        <button class="btn-primary" id="btn-new-push" type="button">+ Neue Push-Nachricht</button>
      </div>
      <div class="push-grid">
        <section class="card">
          <h3 style="margin-bottom:10px">Zustimmung deiner Klienten</h3>
          <div id="consent-list"></div>
        </section>
        <section class="card">
          <h3 style="margin-bottom:10px">Geplant &amp; gesendet</h3>
          <div id="notif-list"><p class="muted small">Lade…</p></div>
        </section>
        <section class="card" id="coach-push-card"></section>
      </div>`);

    renderConsentList(document.getElementById('consent-list'), clients);
    const notifRoot = document.getElementById('notif-list');
    const reloadNotifications = () => loadNotifications(notifRoot).catch((err) => toast(err.message, true));
    reloadNotifications();
    document.getElementById('btn-new-push').addEventListener('click', () => openPushDialog(clients, reloadNotifications));
    mountPushCard(document.getElementById('coach-push-card'), {
      title: 'Für dich',
      intro: 'Lass dich auf diesem Gerät benachrichtigen, wenn ein Klient dir schreibt.',
    }).catch(() => {});

    document.getElementById('btn-new-client').addEventListener('click', () => {
      const pw = randomPassword();
      openDialog(
        `<h2>Neuen Klienten anlegen</h2>
         <div class="field"><label for="c-name">Name</label><input id="c-name" name="displayName" required placeholder="Max Mustermann"></div>
         <div class="field"><label for="c-user">Benutzername</label><input id="c-user" name="username" autocapitalize="none" required placeholder="max">
           <div class="hint">3–32 Zeichen: Buchstaben, Ziffern, . _ -</div></div>
         <div class="field"><label for="c-pw">Startpasswort</label><input id="c-pw" name="password" value="${pw}" required>
           <div class="hint">Der Klient kann es nach dem ersten Login selbst ändern.</div></div>
         <div class="dialog-actions">
           <button type="button" class="btn-secondary" data-close>Abbrechen</button>
           <button type="submit" class="btn-primary">Anlegen</button>
         </div>`,
        async (f) => {
          const { client } = await api('POST', '/api/clients', {
            displayName: f.displayName.value, username: f.username.value.trim(), password: f.password.value,
          });
          showCredentials(client.displayName, client.username, f.password.value, () => {
            location.hash = `#/client/${client.id}`;
          });
          return false;
        }
      );
    });
  }

  // ---------- coach: weekly check-in ----------
  async function renderCheckin(selectedId) {
    setView('<p class="muted">Lade…</p>');
    const { clients } = await api('GET', '/api/checkins/queue');
    if (!clients.length) {
      setView('<div class="page-head"><h1>Check-in</h1></div><div class="card empty-state">Noch keine Klienten angelegt.</div>');
      return;
    }
    const done = clients.filter((c) => c.doneThisWeek).length;
    const selected = clients.find((c) => c.id === selectedId) || clients.find((c) => !c.doneThisWeek) || clients[0];
    const idx = clients.indexOf(selected);

    setView(`
      <div class="page-head">
        <div>${eyebrow('Coaching')}<h1>Wöchentlicher Check-in</h1>
          <p class="muted">${done} von ${clients.length} diese Woche erledigt</p></div>
        <div class="progress" aria-hidden="true"><span style="width:${Math.round((done / clients.length) * 100)}%"></span></div>
      </div>
      <nav class="queue" aria-label="Klienten">
        ${clients
          .map(
            (c, i) => `<a href="#/checkin/${c.id}" class="queue-item ${c.doneThisWeek ? 'done' : ''}"${c.id === selected.id ? ' aria-current="page"' : ''}>
              <span class="queue-num">${c.doneThisWeek ? '✓' : i + 1}</span><span>${esc(c.displayName)}</span></a>`
          )
          .join('')}
      </nav>
      <div id="checkin-body"><p class="muted">Lade…</p></div>`);
    const current = document.querySelector('.queue [aria-current]');
    if (current) current.scrollIntoView({ block: 'nearest', inline: 'center' });

    const rv = await api('GET', `/api/checkins/review?userId=${selected.id}`);
    const { comparison: cmp, goals } = rv;
    const cur = cmp.current;
    const prev = cmp.previous;
    const shortD = (d) => fmtDate(d, { weekday: 'short', day: '2-digit', month: '2-digit' });

    const deltaCell = (d, fmt, goodDir) => {
      if (d === null || d === undefined) return '<td class="num muted">–</td>';
      const cls = d === 0 ? '' : Math.sign(d) === goodDir ? 'good' : 'bad';
      return `<td class="num ${cls}">${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d))}</td>`;
    };
    const weightDir = goals.targetWeight !== null && cur.weightAvg !== null && goals.targetWeight > cur.weightAvg ? 1 : -1;
    const hit = (n, total) => (n === null ? '–' : `${n}/${total}`);
    const rows = [
      ['Gewicht Ø', `${num(prev.weightAvg, 1)} kg`, `${num(cur.weightAvg, 1)} kg`, deltaCell(cmp.delta.weightAvg, (v) => `${num(v, 1)} kg`, weightDir)],
      ['Gewicht min – max', prev.weighIns ? `${num(prev.weightMin, 1)} – ${num(prev.weightMax, 1)}` : '–', cur.weighIns ? `${num(cur.weightMin, 1)} – ${num(cur.weightMax, 1)}` : '–', '<td></td>'],
      ['Wiegungen', prev.weighIns, cur.weighIns, deltaCell(cur.weighIns - prev.weighIns, (v) => num(v), 1)],
      ['Schritte Ø', num(prev.stepsAvg), num(cur.stepsAvg), deltaCell(cmp.delta.stepsAvg, (v) => num(v), 1)],
      ['Schrittziel erreicht', hit(prev.stepsGoalDays, 7), hit(cur.stepsGoalDays, 7), '<td></td>'],
      ['Schlaf Ø', fmtSleep(prev.sleepAvg), fmtSleep(cur.sleepAvg), deltaCell(cmp.delta.sleepAvg, (v) => fmtSleep(v), 1)],
      ['Schlafziel erreicht', hit(prev.sleepGoalDays, 7), hit(cur.sleepGoalDays, 7), '<td></td>'],
      ['🏋️ Trainingstage', `${prev.trainingDays}×`, `${cur.trainingDays}×`, deltaCell(cmp.delta.trainingDays, (v) => `${num(v)}×`, 1)],
      ['Kalorienplan eingehalten', prev.caloriesAnswered ? `${prev.caloriesOkDays}/${prev.caloriesAnswered}` : '–', cur.caloriesAnswered ? `${cur.caloriesOkDays}/${cur.caloriesAnswered}` : '–', deltaCell(cmp.delta.caloriesOkDays, (v) => num(v), 1)],
      ['Ø gegessen, wenn nicht eingehalten', prev.caloriesReportedAvg ? `${num(prev.caloriesReportedAvg)} kcal` : '–', cur.caloriesReportedAvg ? `${num(cur.caloriesReportedAvg)} kcal` : '–', '<td></td>'],
      ['Tage eingetragen', `${prev.daysLogged}/7`, `${cur.daysLogged}/7`, deltaCell(cmp.delta.daysLogged, (v) => num(v), 1)],
    ];

    const dayTable = (days) => `<table class="day-table">
      <thead><tr><th>Tag</th><th class="num">Gewicht</th><th class="num">Schritte</th><th class="num">Schlaf</th><th>Training</th><th>Kalorien</th><th>Notiz</th></tr></thead>
      <tbody>${days
        .map((d) => `<tr class="${d.weight === null && d.steps === null && d.sleep === null && !d.note && d.training === null && d.caloriesOk === null ? 'empty-day' : ''}">
          <td>${esc(shortD(d.date))}</td>
          <td class="num">${d.weight !== null ? num(d.weight, 1) : '–'}</td>
          <td class="num ${goals.stepsGoal && d.steps !== null ? (d.steps >= goals.stepsGoal ? 'good' : '') : ''}">${num(d.steps)}</td>
          <td class="num">${fmtSleep(d.sleep)}</td>
          <td>${d.training === true ? '🏋️ Ja' : d.training === false ? '<span class="muted">Nein</span>' : '–'}</td>
          <td>${kcalCell(d)}</td>
          <td class="note">${esc(d.note || '')}</td></tr>`)
        .join('')}</tbody></table>`;

    const last = rv.checkins[0];
    const lastHtml = last
      ? `<div class="small muted">Letzter Check-in: ${esc(new Date(last.createdAt).toLocaleDateString('de-DE'))} ·
          ${last.status === 'accepted' ? '<span class="good">Anpassungen angenommen</span>' : last.changes.length ? '<span class="warn">Anpassungen noch offen</span>' : 'ohne Anpassungen'}
          ${last.seenAt ? ' · gelesen' : ' · noch nicht gelesen'}</div>`
      : '<div class="small muted">Erster Check-in für diesen Klienten.</div>';
    const msgsHtml = rv.clientMessages.length
      ? `<div class="client-msgs"><div class="small muted" style="margin-bottom:6px">Nachrichten von ${esc(rv.client.displayName)} seit dem letzten Check-in</div>
          ${rv.clientMessages.map((m) => `<div class="msg theirs">${esc(m.body)}<time>${esc(new Date(m.createdAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</time></div>`).join('')}
          <a class="small" href="#/client/${selected.id}/chat">Zum Chat →</a></div>`
      : '';

    const nextOpen = clients.slice(idx + 1).find((c) => !c.doneThisWeek) || clients.find((c, i) => i !== idx && !c.doneThisWeek);
    const kcalRow = `
      <div class="field plan-field" data-plan="calories"><label for="p-kmin">Zielkalorien pro Tag <span class="muted small">aktuell: ${esc(fmtKcal(goals.caloriesMin, goals.caloriesMax))}</span></label>
        <div class="kcal-range">
          <div class="input-unit"><input id="p-kmin" name="caloriesMin" inputmode="numeric" placeholder="von" value="${goals.caloriesMin ?? ''}"><span>kcal</span></div>
          <span>–</span>
          <div class="input-unit"><input id="p-kmax" name="caloriesMax" inputmode="numeric" placeholder="bis" aria-label="Kalorien bis" value="${goals.caloriesMax !== null && goals.caloriesMax !== goals.caloriesMin ? goals.caloriesMax : ''}"><span>kcal</span></div>
        </div></div>`;
    const fieldRow = (key, label, unit, mode, placeholder) => `
      <div class="field plan-field"><label for="p-${key}">${label} <span class="muted small">aktuell: ${esc(fmtPlan(key, goals[key]))}</span></label>
        <div class="input-unit"><input id="p-${key}" name="${key}" inputmode="${mode}" placeholder="${placeholder}"
          value="${goals[key] === null || goals[key] === undefined ? '' : String(goals[key]).replace('.', ',')}"><span>${unit}</span></div></div>`;

    document.getElementById('checkin-body').innerHTML = `
      <div class="checkin-grid">
        <div class="stack">
          <section class="card">
            <div class="row-between" style="margin-bottom:8px">
              <h2>${esc(rv.client.displayName)} – Wochenvergleich</h2>
              <a class="small" href="#/client/${selected.id}">Alle Daten →</a>
            </div>
            <p class="small muted" style="margin:0 0 10px">Diese Woche: ${esc(shortD(cur.from))} – ${esc(shortD(cur.to))} · Vorwoche: ${esc(shortD(prev.from))} – ${esc(shortD(prev.to))}</p>
            <div class="table-wrap"><table class="compare">
              <thead><tr><th></th><th class="num">Vorwoche</th><th class="num">Diese Woche</th><th class="num">Veränderung</th></tr></thead>
              <tbody>${rows.map(([l, a, b, d]) => `<tr><td>${l}</td><td class="num">${a}</td><td class="num"><strong>${b}</strong></td>${d}</tr>`).join('')}</tbody>
            </table></div>
          </section>
          <section class="card chart-card"><h3>Gewicht – 14 Tage</h3><div class="chart-weight" data-chart="ci-weight"></div></section>
          <section class="card chart-card"><h3>Schritte – 14 Tage</h3><div class="chart-steps" data-chart="ci-steps"></div></section>
          <section class="card">
            <h3 style="margin-bottom:8px">Diese Woche im Detail</h3>
            <div class="table-wrap">${dayTable(cmp.days.slice(7).reverse())}</div>
          </section>
          <details class="card">
            <summary><strong>Vorwoche im Detail</strong></summary>
            <div class="table-wrap" style="margin-top:8px">${dayTable(cmp.days.slice(0, 7).reverse())}</div>
          </details>
        </div>
        <form class="card checkin-form" id="checkin-form" novalidate>
          <h2>Check-in schreiben</h2>
          ${lastHtml}
          ${msgsHtml}
          <div class="field" style="margin-top:12px"><label for="ci-msg">Nachricht an ${esc(rv.client.displayName)}</label>
            <textarea id="ci-msg" name="message" maxlength="4000" rows="6" placeholder="Wie lief die Woche? Was war gut, was nehmen wir uns vor?"></textarea></div>
          <h3 style="margin:4px 0 8px">Plan anpassen <span class="muted small">(optional)</span></h3>
          ${kcalRow}
          ${fieldRow('stepsGoal', 'Schritte pro Tag', 'Schritte', 'numeric', 'z. B. 10000')}
          ${fieldRow('sleepGoal', 'Schlaf pro Nacht', 'Std.', 'decimal', 'z. B. 7,5')}
          ${fieldRow('targetWeight', 'Zielgewicht', 'kg', 'decimal', 'z. B. 80')}
          <p class="hint" data-changes>Keine Änderungen am Plan – nur Feedback.</p>
          <button class="btn-primary btn-block" type="submit">Check-in senden${nextOpen ? ' & weiter →' : ''}</button>
          ${nextOpen ? `<a class="btn btn-ghost btn-block" href="#/checkin/${nextOpen.id}">Überspringen → ${esc(nextOpen.displayName)}</a>` : ''}
          <p class="error" hidden></p>
          <p class="hint">Der Check-in erscheint oben in der Übersicht des Klienten (nicht im Chat). Er kann die Anpassungen mit einem Klick annehmen – nur seine Antwort landet im Chat.</p>
        </form>
      </div>`;

    const from = cmp.days[0].date;
    const to = cmp.days[13].date;
    const drawCiCharts = () => {
      Charts.render(document.querySelector('[data-chart=ci-weight]'), {
        data: cmp.days.map((d) => ({ date: d.date, value: d.weight })), from, to, type: 'line',
        goal: goals.targetWeight, unit: 'kg', decimals: 1, height: 170,
      });
      Charts.render(document.querySelector('[data-chart=ci-steps]'), {
        data: cmp.days.map((d) => ({ date: d.date, value: d.steps })), from, to, type: 'bar',
        goal: goals.stepsGoal, unit: 'Schritte', height: 170,
      });
    };
    drawCiCharts();
    window.addEventListener('resize', drawCiCharts);
    onCleanup(() => window.removeEventListener('resize', drawCiCharts));

    const form = document.getElementById('checkin-form');
    const keys = ['stepsGoal', 'sleepGoal', 'targetWeight'];
    const readProposal = () => {
      const p = {};
      for (const k of keys) {
        const v = parseNum(form[k].value);
        if (Number.isNaN(v)) throw new Error('Bitte nur Zahlen eingeben.');
        if (v !== null && v !== goals[k]) p[k] = v;
      }
      let lo = parseNum(form.caloriesMin.value);
      let hi = parseNum(form.caloriesMax.value);
      if (Number.isNaN(lo) || Number.isNaN(hi)) throw new Error('Bitte nur Zahlen eingeben.');
      if (lo !== null || hi !== null) {
        lo = lo ?? hi;
        hi = hi ?? lo;
        if (lo > hi) throw new Error('Kalorien: „von“ muss kleiner als „bis“ sein.');
        if (lo !== goals.caloriesMin || hi !== goals.caloriesMax) {
          p.caloriesMin = lo;
          p.caloriesMax = hi;
        }
      }
      return p;
    };
    const showChanges = () => {
      const hint = form.querySelector('[data-changes]');
      let p = {};
      try {
        p = readProposal();
      } catch {
        /* shown on submit */
      }
      for (const k of keys) form[k].closest('.plan-field').classList.toggle('changed', k in p);
      form.querySelector('[data-plan=calories]').classList.toggle('changed', 'caloriesMin' in p);
      const list = keys.filter((k) => k in p).map((k) => `${PLAN_LABELS[k]}: ${fmtPlan(k, goals[k])} → ${fmtPlan(k, p[k])}`);
      if ('caloriesMin' in p) {
        list.unshift(`${PLAN_LABELS.calories}: ${fmtKcal(goals.caloriesMin, goals.caloriesMax)} → ${fmtKcal(p.caloriesMin, p.caloriesMax)}`);
      }
      hint.innerHTML = list.length
        ? `<strong>Vorschlag an den Klienten:</strong><br>${list.map(esc).join('<br>')}`
        : 'Keine Änderungen am Plan – nur Feedback.';
    };
    form.addEventListener('input', showChanges);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = form.querySelector('.error');
      errEl.hidden = true;
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        if (!form.message.value.trim()) throw new Error('Bitte eine Nachricht schreiben.');
        await api('POST', `/api/checkins?userId=${selected.id}`, { message: form.message.value, proposal: readProposal() });
        toast(`Check-in an ${rv.client.displayName} gesendet ✓`);
        location.hash = nextOpen ? `#/checkin/${nextOpen.id}` : '#/checkin/done';
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
        btn.disabled = false;
      }
    });
  }

  async function renderCheckinDone() {
    const { clients } = await api('GET', '/api/checkins/queue');
    if (clients.some((c) => !c.doneThisWeek)) return renderCheckin(null);
    setView(`<div class="page-head"><h1>Wöchentlicher Check-in</h1></div>
      <div class="card empty-state"><p style="font-size:2rem;margin:0">🎉</p>
        <h2>Alle ${clients.length} Check-ins für diese Woche erledigt!</h2>
        <p>Die Antworten deiner Klienten findest du im Chat.</p>
        <a class="btn btn-secondary" href="#/">Zur Übersicht</a></div>`);
  }

  // ---------- food picker (search in the food database) ----------
  let foodCache = null;
  async function loadFoods(force) {
    if (!foodCache || force) foodCache = (await api('GET', '/api/foods')).foods;
    return foodCache;
  }
  const fmtAmount = (amount, unit) => `${num(amount, amount % 1 ? 1 : 0)} ${unit}`;
  const itemKcal = (amount, kcal) => Math.round((amount * kcal) / 100);
  const sameKcalAmount = (kcal, per100) => (per100 > 0 ? Math.max(5, Math.round(((kcal / per100) * 100) / 5) * 5) : 100);

  /**
   * Text field with live search in the food database.
   * onPick(food) is called with the chosen food (or null when the text is changed again).
   * With allowCreate, a "neu anlegen" entry lets the coach add a missing food on the spot.
   */
  function foodPicker(root, { onPick, allowCreate, placeholder }) {
    root.classList.add('food-picker');
    root.innerHTML = `<input type="search" autocomplete="off" placeholder="${esc(placeholder || 'Lebensmittel suchen…')}" aria-label="Lebensmittel suchen">
      <ul class="food-results" role="listbox" hidden></ul>`;
    const input = root.querySelector('input');
    const list = root.querySelector('ul');
    let chosen = null;
    const close = () => (list.hidden = true);

    async function update() {
      const foods = await loadFoods();
      const term = input.value.trim().toLowerCase();
      const hits = (term ? foods.filter((f) => f.name.toLowerCase().includes(term)) : foods)
        .sort((a, b) => (term ? Number(!a.name.toLowerCase().startsWith(term)) - Number(!b.name.toLowerCase().startsWith(term)) : 0))
        .slice(0, 40);
      list.innerHTML =
        hits.map((f) => `<li role="option" data-id="${f.id}"><span>${esc(f.name)}</span><span class="muted small">${num(f.kcal)} kcal/100 ${f.unit}</span></li>`).join('') +
        (allowCreate && term ? `<li data-create class="create">+ „${esc(input.value.trim())}“ neu anlegen</li>` : '') +
        (!hits.length && !allowCreate ? '<li class="muted small" data-none>Nicht in der Liste – schreib deinen Wunsch einfach unten rein.</li>' : '');
      list.hidden = false;
    }
    input.addEventListener('focus', update);
    input.addEventListener('input', () => {
      if (chosen) {
        chosen = null;
        onPick(null);
      }
      update();
    });
    list.addEventListener('pointerdown', (e) => e.preventDefault());
    list.addEventListener('click', async (e) => {
      const li = e.target.closest('li');
      if (!li || li.dataset.none !== undefined) return;
      if (li.dataset.create !== undefined) {
        close();
        const food = await createFoodDialog(input.value.trim());
        if (food) pick(food);
        return;
      }
      pick(foodCache.find((f) => f.id === Number(li.dataset.id)));
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    function pick(f) {
      chosen = f;
      input.value = f.name;
      close();
      onPick(f);
    }
    return { get value() { return chosen; }, input, clear() { chosen = null; input.value = ''; } };
  }

  /** Small form to add a food to the database. Resolves with the new food, or null. */
  function createFoodDialog(name, existing) {
    return new Promise((resolve) => {
      const sub = document.createElement('dialog');
      sub.className = 'sub-dialog';
      document.body.appendChild(sub);
      sub.innerHTML = `<form method="dialog" novalidate>
        <h2>${existing ? 'Lebensmittel bearbeiten' : 'Lebensmittel anlegen'}</h2>
        <div class="field"><label for="nf-name">Name</label><input id="nf-name" name="name" maxlength="80" value="${esc(existing ? existing.name : name || '')}" required></div>
        <div class="field-row">
          <div class="field"><label for="nf-kcal">kcal pro 100</label><input id="nf-kcal" name="kcal" inputmode="decimal" value="${existing ? String(existing.kcal).replace('.', ',') : ''}" required></div>
          <div class="field"><label for="nf-unit">Einheit</label><select id="nf-unit" name="unit">
            <option value="g"${existing && existing.unit === 'ml' ? '' : ' selected'}>g</option><option value="ml"${existing && existing.unit === 'ml' ? ' selected' : ''}>ml</option></select></div>
        </div>
        <div class="field"><label for="nf-cat">Kategorie</label><input id="nf-cat" name="category" maxlength="40" value="${esc(existing ? existing.category || '' : 'Eigene')}"></div>
        <p class="error" hidden></p>
        <div class="dialog-actions"><button type="button" class="btn-secondary" data-cancel>Abbrechen</button><button type="submit" class="btn-primary">Speichern</button></div>
      </form>`;
      const f = sub.querySelector('form');
      const done = (v) => {
        sub.close();
        sub.remove();
        resolve(v);
      };
      f.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      sub.addEventListener('cancel', () => done(null));
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = f.querySelector('.error');
        try {
          const kcal = parseNum(f.kcal.value);
          if (kcal === null || Number.isNaN(kcal)) throw new Error('Bitte kcal pro 100 g angeben.');
          const body = { name: f.name.value, kcal, unit: f.unit.value, category: f.category.value };
          const { food } = existing ? await api('PATCH', `/api/foods/${existing.id}`, body) : await api('POST', '/api/foods', body);
          await loadFoods(true);
          toast(existing ? 'Lebensmittel gespeichert' : `„${food.name}“ angelegt`);
          done(food);
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        }
      });
      sub.showModal();
      f.name.focus();
    });
  }

  // ---------- nutrition plan: shared rendering ----------
  function planSummary(plan, goals) {
    const target = hasKcal(goals) ? fmtKcal(goals.caloriesMin, goals.caloriesMax) : null;
    let cls = '';
    if (hasKcal(goals) && plan.totalKcal) {
      cls = plan.totalKcal < goals.caloriesMin - 50 || plan.totalKcal > goals.caloriesMax + 50 ? 'warn' : 'good';
    }
    return `<div class="card plan-summary">
      <div><div class="stat-label">Tagesplan</div><div class="stat-value ${cls}">${num(plan.totalKcal)} <small>kcal</small></div></div>
      <div class="muted small">${target ? `Zielkalorien: <strong>${esc(target)}</strong>` : 'Noch keine Zielkalorien festgelegt'}</div>
    </div>`;
  }

  const SWAP_STATUS = { open: ['Offen', ''], done: ['Umgesetzt ✓', 'good'], declined: ['Abgelehnt', 'bad'] };
  function requestLine(r) {
    const [label, cls] = SWAP_STATUS[r.status];
    const wish = [r.wantedFood ? r.wantedFood.name : null, r.wish].filter(Boolean).join(' – ');
    return `<div class="swap-req">
      <div class="row-between"><strong>${esc(r.subject.split(' · ')[0])}</strong><span class="badge ${cls}">${label}</span></div>
      <div class="small">→ ${esc(wish)}</div>
      ${r.coachNote ? `<div class="small muted">Coach: ${esc(r.coachNote)}</div>` : ''}
      <div class="small muted">${esc(new Date(r.createdAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }))}${r.subject.includes(' · ') ? ` · ${esc(r.subject.split(' · ')[1])}` : ''}</div>
    </div>`;
  }

  // ---------- client: nutrition plan ----------
  async function renderClientNutrition() {
    setView('<p class="muted">Lade…</p>');
    const [plan, { goals }] = await Promise.all([api('GET', '/api/nutrition'), api('GET', '/api/goals')]);
    drawClientNutrition(plan, goals);
  }

  function drawClientNutrition(plan, goals) {
    const openFor = (pred) => plan.requests.find((r) => r.status === 'open' && pred(r));
    const meals = plan.meals
      .map((m) => {
        const mealReq = openFor((r) => r.type === 'meal' && r.mealId === m.id);
        return `<section class="card meal">
          <div class="row-between meal-head"><h2>${esc(m.name)}</h2><span class="muted small">${num(m.kcalTotal)} kcal</span></div>
          <ul class="meal-items">${m.items
            .map((i) => {
              const req = openFor((r) => r.itemId === i.id);
              return `<li>
                <div class="item-main"><span class="item-name">${esc(i.name)}</span>
                  <span class="muted small">${esc(fmtAmount(i.amount, i.unit))} · ${num(i.kcalTotal)} kcal</span></div>
                ${req ? '<span class="badge warn">Tausch angefragt</span>' : `<button type="button" class="btn-ghost btn-sm" data-swap-item="${i.id}">⇄ Tauschen</button>`}
              </li>`;
            })
            .join('') || '<li class="muted small">Noch keine Lebensmittel.</li>'}</ul>
          ${mealReq
            ? '<p class="small"><span class="badge warn">Tausch der ganzen Mahlzeit angefragt</span></p>'
            : `<button type="button" class="btn-secondary btn-sm" data-swap-meal="${m.id}">Ganze Mahlzeit tauschen anfragen</button>`}
        </section>`;
      })
      .join('');
    const open = plan.requests.filter((r) => r.status === 'open');
    const doneReqs = plan.requests.filter((r) => r.status !== 'open').slice(0, 10);

    setView(`
      <div class="page-head"><div>${eyebrow('Von deinem Coach')}<h1>Ernährungsplan</h1>
        <p class="muted">Du kannst einzelne Lebensmittel oder ganze Mahlzeiten zum Tausch anfragen – dein Coach entscheidet.</p></div></div>
      ${plan.meals.length ? `
      <div class="nutrition-grid">
        <div class="stack">${planSummary(plan, goals)}${meals}</div>
        <aside class="stack">
          <section class="card"><h3 style="margin-bottom:8px">Meine Tauschwünsche</h3>
            ${open.length || doneReqs.length ? '' : '<p class="muted small">Noch keine. Tipp auf „⇄ Tauschen“ bei einem Lebensmittel.</p>'}
            ${open.map((r) => `${requestLine(r)}<button type="button" class="btn-ghost btn-sm" data-cancel-req="${r.id}">Zurückziehen</button>`).join('')}
            ${doneReqs.map(requestLine).join('')}
          </section>
        </aside>
      </div>` : '<div class="card empty-state"><p style="font-size:2rem;margin:0">🍽</p><p>Dein Coach erstellt gerade deinen Ernährungsplan.</p></div>'}`);

    const refresh = (p) => drawClientNutrition(p, goals);
    app.querySelectorAll('[data-swap-item]').forEach((b) =>
      b.addEventListener('click', () => {
        const item = plan.meals.flatMap((m) => m.items.map((i) => ({ ...i, meal: m.name }))).find((i) => i.id === Number(b.dataset.swapItem));
        openItemSwapDialog(item, refresh);
      })
    );
    app.querySelectorAll('[data-swap-meal]').forEach((b) =>
      b.addEventListener('click', () => {
        const meal = plan.meals.find((m) => m.id === Number(b.dataset.swapMeal));
        openDialog(
          `<h2>${esc(meal.name)} tauschen</h2>
           <p class="muted small">Dein Coach entscheidet und passt den Plan an.</p>
           <div class="field"><label for="mw">Was möchtest du stattdessen essen?</label>
             <textarea id="mw" name="wish" maxlength="500" required placeholder="z. B. Lieber Rührei mit Vollkornbrot statt Haferflocken"></textarea></div>
           <div class="dialog-actions"><button type="button" class="btn-secondary" data-close>Abbrechen</button>
             <button type="submit" class="btn-primary">Anfrage senden</button></div>`,
          async (f) => {
            if (!f.wish.value.trim()) throw new Error('Bitte beschreib kurz deinen Wunsch.');
            const p = await api('POST', '/api/nutrition/requests', { type: 'meal', mealId: meal.id, wish: f.wish.value });
            toast('Anfrage an deinen Coach gesendet ✓');
            refresh(p);
          }
        );
      })
    );
    app.querySelectorAll('[data-cancel-req]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          refresh(await api('DELETE', `/api/nutrition/requests/${b.dataset.cancelReq}`));
          toast('Anfrage zurückgezogen');
        } catch (err) {
          toast(err.message, true);
        }
      })
    );
  }

  function openItemSwapDialog(item, refresh) {
    let wanted = null;
    openDialog(
      `<h2>${esc(item.name)} tauschen</h2>
       <p class="muted small">${esc(fmtAmount(item.amount, item.unit))} · ${num(item.kcalTotal)} kcal · ${esc(item.meal)}</p>
       <div class="field"><label>Wogegen möchtest du tauschen?</label><div data-picker></div>
         <div class="hint" data-equiv></div></div>
       <div class="field"><label for="iw">Anmerkung <span class="muted">(optional)</span></label>
         <textarea id="iw" name="wish" maxlength="500" placeholder="z. B. Reis vertrage ich abends nicht so gut"></textarea></div>
       <div class="dialog-actions"><button type="button" class="btn-secondary" data-close>Abbrechen</button>
         <button type="submit" class="btn-primary">Anfrage senden</button></div>`,
      async (f) => {
        if (!wanted && !f.wish.value.trim()) throw new Error('Bitte ein Lebensmittel wählen oder deinen Wunsch beschreiben.');
        const p = await api('POST', '/api/nutrition/requests', { type: 'item', itemId: item.id, wantedFoodId: wanted ? wanted.id : undefined, wish: f.wish.value });
        toast('Tauschwunsch an deinen Coach gesendet ✓');
        refresh(p);
      }
    );
    const equiv = dialog.querySelector('[data-equiv]');
    foodPicker(dialog.querySelector('[data-picker]'), {
      placeholder: 'z. B. Kartoffeln',
      onPick(f) {
        wanted = f;
        equiv.textContent = f
          ? `Gleich viele Kalorien wären ca. ${fmtAmount(sameKcalAmount(item.kcalTotal, f.kcal), f.unit)} ${f.name}. Dein Coach legt die Menge fest.`
          : '';
      },
    });
  }

  // ---------- coach: nutrition plan editor ----------
  async function mountCoachNutrition(root, client, goals) {
    const [plan] = await Promise.all([api('GET', `/api/nutrition?userId=${client.id}`), loadFoods()]);
    drawCoachNutrition(root, client, goals, plan);
  }

  function drawCoachNutrition(root, client, goals, plan) {
    const redraw = (p) => drawCoachNutrition(root, client, goals, p);
    const call = async (method, url, body, msg) => {
      try {
        const p = await api(method, url, body);
        if (msg) toast(msg);
        redraw(p);
      } catch (err) {
        toast(err.message, true);
      }
    };
    const open = plan.requests.filter((r) => r.status === 'open');
    const history = plan.requests.filter((r) => r.status !== 'open');
    const itemById = new Map(plan.meals.flatMap((m) => m.items.map((i) => [i.id, { ...i, meal: m }])));

    const requestsHtml = open.length
      ? `<section class="card requests-card"><h2 style="margin-bottom:8px">🍽 Offene Tauschwünsche (${open.length})</h2>
          ${open
            .map((r) => {
              const it = r.itemId ? itemById.get(r.itemId) : null;
              const canApply = it && r.wantedFood;
              const amount = canApply ? sameKcalAmount(it.kcalTotal, r.wantedFood.kcal) : null;
              return `<div class="swap-req">
                ${requestLine(r)}
                <div class="row" style="gap:6px;margin-top:6px">
                  ${canApply ? `<button type="button" class="btn-primary btn-sm" data-apply="${r.id}">Tausch übernehmen: ${esc(fmtAmount(amount, r.wantedFood.unit))} ${esc(r.wantedFood.name)} (≈ ${num(itemKcal(amount, r.wantedFood.kcal))} kcal)</button>` : ''}
                  <button type="button" class="btn-secondary btn-sm" data-resolve="${r.id}" data-status="done">Erledigt – Plan selbst angepasst</button>
                  <button type="button" class="btn-ghost btn-sm danger-text" data-resolve="${r.id}" data-status="declined">Ablehnen</button>
                </div></div>`;
            })
            .join('')}
        </section>`
      : '';

    const mealsHtml = plan.meals
      .map((m, mi) => {
        const reqItemIds = new Set(open.filter((r) => r.mealId === m.id).map((r) => r.itemId));
        const mealReq = open.some((r) => r.type === 'meal' && r.mealId === m.id);
        return `<section class="card meal ${mealReq ? 'has-request' : ''}">
          <div class="row-between meal-head">
            <h2>${esc(m.name)} ${mealReq ? '<span class="badge warn">Tauschwunsch</span>' : ''}</h2>
            <div class="row" style="gap:2px">
              <span class="muted small" style="margin-right:8px">${num(m.kcalTotal)} kcal</span>
              <button type="button" class="btn-ghost btn-sm" data-move="${m.id}" data-dir="-1" ${mi === 0 ? 'disabled' : ''} aria-label="Nach oben">↑</button>
              <button type="button" class="btn-ghost btn-sm" data-move="${m.id}" data-dir="1" ${mi === plan.meals.length - 1 ? 'disabled' : ''} aria-label="Nach unten">↓</button>
              <button type="button" class="btn-ghost btn-sm" data-rename="${m.id}">Umbenennen</button>
              <button type="button" class="btn-ghost btn-sm danger-text" data-del-meal="${m.id}" aria-label="Mahlzeit löschen">✕</button>
            </div>
          </div>
          <div class="table-wrap"><table class="plan-table">
            <thead><tr><th>Lebensmittel</th><th class="num">Menge</th><th class="num">kcal/100</th><th class="num">kcal</th><th></th></tr></thead>
            <tbody>${m.items
              .map((i) => `<tr class="${reqItemIds.has(i.id) ? 'has-request' : ''}">
                <td>${esc(i.name)} ${reqItemIds.has(i.id) ? '<span class="badge warn">Tauschwunsch</span>' : ''}</td>
                <td class="num"><input class="amount-input" data-amount="${i.id}" inputmode="decimal" value="${String(i.amount).replace('.', ',')}" aria-label="Menge"> ${esc(i.unit)}</td>
                <td class="num muted">${num(i.kcal)}</td>
                <td class="num"><strong>${num(i.kcalTotal)}</strong></td>
                <td class="actions"><button type="button" class="btn-ghost btn-sm" data-replace="${i.id}">Ersetzen</button><button type="button" class="btn-ghost btn-sm danger-text" data-del-item="${i.id}" aria-label="Entfernen">✕</button></td>
              </tr>`)
              .join('') || '<tr><td colspan="5" class="muted small">Noch keine Lebensmittel.</td></tr>'}</tbody>
          </table></div>
          <form class="add-item" data-add="${m.id}">
            <div data-picker></div>
            <div class="input-unit amount-field"><input name="amount" inputmode="decimal" placeholder="Menge"><span data-unit>g</span></div>
            <button type="submit" class="btn-secondary">+ Hinzufügen</button>
          </form>
        </section>`;
      })
      .join('');

    root.innerHTML = `
      <div class="nutrition-grid">
        <div class="stack">
          ${requestsHtml}
          ${planSummary(plan, goals)}
          ${mealsHtml || '<div class="card empty-state">Noch kein Ernährungsplan. Leg unten die erste Mahlzeit an.</div>'}
          <form class="card add-meal" id="add-meal">
            <h3>Mahlzeit hinzufügen</h3>
            <div class="row" style="gap:6px">${['Frühstück', 'Mittagessen', 'Abendessen', 'Snack', 'Pre-Workout', 'Post-Workout']
              .map((n) => `<button type="button" class="btn-ghost btn-sm chip" data-quick="${n}">${n}</button>`)
              .join('')}</div>
            <div class="row" style="gap:8px;flex-wrap:nowrap"><input name="name" maxlength="60" placeholder="Eigener Name, z. B. Mahlzeit 1"><button type="submit" class="btn-primary">Anlegen</button></div>
          </form>
        </div>
        <aside class="stack">
          <section class="card"><h3 style="margin-bottom:8px">So funktioniert's</h3>
            <p class="small muted">Du legst Mahlzeiten und Mengen fest. ${esc(client.displayName)} sieht den Plan unter „Ernährung“ und kann einzelne Lebensmittel oder ganze Mahlzeiten zum Tausch anfragen – du bekommst dann eine Push-Nachricht. Ändern kannst nur du.</p>
            <p class="small muted">Lebensmittel fehlt? Einfach den Namen eintippen und „neu anlegen“ – oder im <a href="#/admin">Admin-Tool</a> pflegen.</p>
          </section>
          ${history.length ? `<section class="card"><h3 style="margin-bottom:8px">Erledigte Tauschwünsche</h3>${history.slice(0, 10).map(requestLine).join('')}</section>` : ''}
        </aside>
      </div>`;

    // Add items
    root.querySelectorAll('[data-add]').forEach((form) => {
      let food = null;
      const picker = foodPicker(form.querySelector('[data-picker]'), {
        allowCreate: true,
        onPick(f) {
          food = f;
          form.querySelector('[data-unit]').textContent = f ? f.unit : 'g';
          if (f) form.amount.focus();
        },
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const amount = parseNum(form.amount.value);
        if (!food) return toast('Bitte ein Lebensmittel aus der Liste wählen oder neu anlegen.', true);
        if (!amount || Number.isNaN(amount)) return toast('Bitte eine Menge angeben.', true);
        picker.clear();
        call('POST', `/api/nutrition/meals/${form.dataset.add}/items`, { foodId: food.id, amount });
      });
    });
    root.querySelectorAll('[data-amount]').forEach((inp) =>
      inp.addEventListener('change', () => {
        const amount = parseNum(inp.value);
        if (!amount || Number.isNaN(amount)) return toast('Bitte eine gültige Menge angeben.', true);
        call('PATCH', `/api/nutrition/items/${inp.dataset.amount}`, { amount });
      })
    );
    root.querySelectorAll('[data-del-item]').forEach((b) => b.addEventListener('click', () => call('DELETE', `/api/nutrition/items/${b.dataset.delItem}`)));
    root.querySelectorAll('[data-replace]').forEach((b) =>
      b.addEventListener('click', () => {
        const it = itemById.get(Number(b.dataset.replace));
        let food = null;
        openDialog(
          `<h2>${esc(it.name)} ersetzen</h2>
           <p class="muted small">Aktuell: ${esc(fmtAmount(it.amount, it.unit))} · ${num(it.kcalTotal)} kcal</p>
           <div class="field"><label>Neues Lebensmittel</label><div data-picker></div></div>
           <div class="field"><label for="ra">Menge</label><div class="input-unit"><input id="ra" name="amount" inputmode="decimal"><span data-unit>g</span></div>
             <div class="hint" data-equiv>Die Menge wird automatisch kcal-gleich vorgeschlagen.</div></div>
           <div class="dialog-actions"><button type="button" class="btn-secondary" data-close>Abbrechen</button><button type="submit" class="btn-primary">Ersetzen</button></div>`,
          async (f) => {
            if (!food) throw new Error('Bitte ein Lebensmittel wählen.');
            const amount = parseNum(f.amount.value);
            if (!amount || Number.isNaN(amount)) throw new Error('Bitte eine Menge angeben.');
            redraw(await api('PATCH', `/api/nutrition/items/${it.id}`, { foodId: food.id, amount }));
            toast('Ersetzt ✓');
          }
        );
        const f = dialog.querySelector('form');
        foodPicker(dialog.querySelector('[data-picker]'), {
          allowCreate: true,
          onPick(x) {
            food = x;
            if (!x) return;
            const amount = sameKcalAmount(it.kcalTotal, x.kcal);
            f.amount.value = amount;
            f.querySelector('[data-unit]').textContent = x.unit;
            f.querySelector('[data-equiv]').textContent = `${fmtAmount(amount, x.unit)} ${x.name} ≈ ${num(itemKcal(amount, x.kcal))} kcal (vorher ${num(it.kcalTotal)} kcal)`;
          },
        });
      })
    );
    root.querySelectorAll('[data-move]').forEach((b) =>
      b.addEventListener('click', () => call('PATCH', `/api/nutrition/meals/${b.dataset.move}`, { move: Number(b.dataset.dir) }))
    );
    root.querySelectorAll('[data-del-meal]').forEach((b) =>
      b.addEventListener('click', () => {
        const m = plan.meals.find((x) => x.id === Number(b.dataset.delMeal));
        if (confirm(`Mahlzeit „${m.name}“ mit allen Lebensmitteln löschen?`)) call('DELETE', `/api/nutrition/meals/${m.id}`, null, 'Mahlzeit gelöscht');
      })
    );
    root.querySelectorAll('[data-rename]').forEach((b) =>
      b.addEventListener('click', () => {
        const m = plan.meals.find((x) => x.id === Number(b.dataset.rename));
        openDialog(
          `<h2>Mahlzeit umbenennen</h2><div class="field"><label for="mn">Name</label><input id="mn" name="name" maxlength="60" value="${esc(m.name)}"></div>
           <div class="dialog-actions"><button type="button" class="btn-secondary" data-close>Abbrechen</button><button type="submit" class="btn-primary">Speichern</button></div>`,
          async (f) => redraw(await api('PATCH', `/api/nutrition/meals/${m.id}`, { name: f.name.value }))
        );
      })
    );
    const addMeal = root.querySelector('#add-meal');
    const createMeal = (name) => call('POST', `/api/nutrition/meals?userId=${client.id}`, { name }, `„${name}“ angelegt`);
    addMeal.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => createMeal(b.dataset.quick)));
    addMeal.addEventListener('submit', (e) => {
      e.preventDefault();
      if (addMeal.name.value.trim()) createMeal(addMeal.name.value.trim());
    });

    // Swap requests
    root.querySelectorAll('[data-apply]').forEach((b) =>
      b.addEventListener('click', () => call('POST', `/api/nutrition/requests/${b.dataset.apply}/resolve`, { status: 'done', apply: true }, 'Getauscht ✓ – Klient wird benachrichtigt'))
    );
    root.querySelectorAll('[data-resolve]').forEach((b) =>
      b.addEventListener('click', () => {
        const declined = b.dataset.status === 'declined';
        openDialog(
          `<h2>${declined ? 'Tauschwunsch ablehnen' : 'Als erledigt markieren'}</h2>
           <div class="field"><label for="rn">Kurze Nachricht an ${esc(client.displayName)} <span class="muted">(optional)</span></label>
             <textarea id="rn" name="note" maxlength="500" placeholder="${declined ? 'z. B. Reis bleibt diese Woche, wir schauen beim Check-in nochmal.' : 'z. B. Hab dir Kartoffeln eingeplant.'}"></textarea></div>
           <div class="dialog-actions"><button type="button" class="btn-secondary" data-close>Abbrechen</button>
             <button type="submit" class="${declined ? 'btn-danger' : 'btn-primary'}">${declined ? 'Ablehnen' : 'Erledigt'}</button></div>`,
          async (f) => {
            redraw(await api('POST', `/api/nutrition/requests/${b.dataset.resolve}/resolve`, { status: b.dataset.status, note: f.note.value }));
            toast(declined ? 'Abgelehnt – Klient wird benachrichtigt' : 'Erledigt – Klient wird benachrichtigt');
          }
        );
      })
    );
  }

  // ---------- coach: admin tool ----------
  async function renderAdmin() {
    setView('<p class="muted">Lade…</p>');
    const [ov] = await Promise.all([api('GET', '/api/admin/overview'), loadFoods(true)]);
    setView(`
      <div class="page-head"><div>${eyebrow('Werkzeuge')}<h1>Admin</h1><p class="muted">Aktivität deiner Klienten, automatische Erinnerungen und Lebensmittel-Datenbank.</p></div></div>
      <div class="stack">
        <section class="card" id="activity"></section>
        <section class="card" id="reminder"></section>
        <section class="card" id="foods"></section>
      </div>`);
    drawActivity(ov);
    drawReminder(ov);
    drawFoods();
  }

  const fmtTs = (iso) =>
    iso ? new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';

  function drawActivity(ov) {
    const root = document.getElementById('activity');
    const rows = ov.clients.slice().sort((a, b) => b.missingDays - a.missingDays);
    const missingBadge = (c) => {
      const d = c.missingDays;
      const cls = d <= 1 ? 'good' : d === 2 ? 'warn' : 'bad';
      if (!c.lastEntry) return `<span class="badge ${d >= 2 ? 'bad' : ''}">noch nie eingetragen</span>`;
      return `<span class="badge ${cls}">${d === 0 ? 'heute eingetragen' : d === 1 ? 'seit gestern' : `${d} Tage`}</span>`;
    };
    const reminderText = {
      ok: '–',
      due: '<span class="warn">fällig</span>',
      'sent-today': 'heute erinnert',
      'already-reminded': 'schon erinnert',
      'no-push': '<span class="muted">kein Push</span>',
    };
    root.innerHTML = `
      <div class="row-between" style="margin-bottom:8px"><h2>Aktivität &amp; Logins</h2><span class="muted small">${rows.length} Klienten</span></div>
      <p class="small muted" style="margin:0 0 10px">„App genutzt“ zählt die Tage, an denen der Klient den Tracker geöffnet hat. Logins sind seltener, weil man 30 Tage angemeldet bleibt.</p>
      <div class="table-wrap"><table class="activity-table">
        <thead><tr><th>Klient</th><th>Ohne Eintrag</th><th class="num">Einträge 7 T</th><th class="num">App genutzt 7 T / 30 T</th><th>Zuletzt aktiv</th><th>Letzter Login</th><th class="num">Logins 30 T</th><th>Erinnerung</th></tr></thead>
        <tbody>${rows
          .map((c) => `<tr>
            <td><a href="#/client/${c.id}"><strong>${esc(c.displayName)}</strong></a></td>
            <td>${missingBadge(c)}</td>
            <td class="num">${c.entries7}/7</td>
            <td class="num">${c.activeDays7} / ${c.activeDays30}</td>
            <td>${esc(fmtTs(c.lastSeen))}</td>
            <td>${esc(fmtTs(c.lastLogin))}</td>
            <td class="num">${c.logins30}</td>
            <td class="small">${reminderText[c.reminderState] || '–'}${c.lastReminder ? `<div class="muted">zuletzt ${esc(fmtDate(c.lastReminder, { day: '2-digit', month: '2-digit' }))}</div>` : ''}</td>
          </tr>`)
          .join('') || '<tr><td colspan="8" class="muted">Noch keine Klienten.</td></tr>'}</tbody>
      </table></div>`;
  }

  function drawReminder(ov) {
    const root = document.getElementById('reminder');
    const cfg = ov.reminder;
    const due = ov.clients.filter((c) => c.reminderState === 'due');
    const noPush = ov.clients.filter((c) => c.reminderState === 'no-push');
    root.innerHTML = `
      <form id="reminder-form" novalidate>
        <div class="row-between" style="margin-bottom:8px">
          <h2>🤖 Automatische Erinnerung</h2>
          <label class="switch"><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''}><span></span><b>${cfg.enabled ? 'Aktiv' : 'Aus'}</b></label>
        </div>
        <p class="small muted" style="margin:0 0 12px">Einmal am Tag prüft der Tracker, wer zu lange nichts eingetragen hat, und schickt eine Push-Nachricht – nur an Klienten, die Push zugestimmt haben. Erscheint auch in deiner <a href="#/">Push-Übersicht</a>.</p>
        <div class="reminder-grid">
          <div class="field"><label for="r-days">Erinnern nach</label>
            <div class="input-unit"><input id="r-days" name="days" inputmode="numeric" value="${cfg.days}"><span>Tagen ohne Eintrag</span></div></div>
          <div class="field"><label for="r-time">Täglich prüfen um <span class="muted">(deutsche Zeit)</span></label>
            <input id="r-time" type="time" name="time" value="${esc(cfg.time)}"></div>
        </div>
        <div class="field"><label for="r-title">Titel</label><input id="r-title" name="title" maxlength="60" value="${esc(cfg.title)}"></div>
        <div class="field"><label for="r-body">Text</label><textarea id="r-body" name="body" maxlength="240">${esc(cfg.body)}</textarea>
          <div class="hint">Platzhalter: <code>{name}</code> = Name des Klienten, <code>{tage}</code> = Tage ohne Eintrag</div></div>
        <label class="check"><input type="checkbox" name="repeatDaily" ${cfg.repeatDaily ? 'checked' : ''}> Täglich wiederholen, solange nichts eingetragen wird <span class="muted small">(sonst einmal pro Lücke)</span></label>
        <div class="row" style="margin-top:12px">
          <button type="submit" class="btn-primary">Speichern</button>
          <button type="button" class="btn-secondary" data-run>Jetzt prüfen &amp; senden</button>
        </div>
        <p class="error" hidden></p>
        <div class="hint-box small" style="margin-top:12px">
          <div><strong>Heute fällig:</strong> ${due.length ? due.map((c) => `${esc(c.displayName)} (${c.missingDays} Tage)`).join(', ') : 'niemand'}</div>
          ${noPush.length ? `<div class="muted">Ohne Push-Zustimmung (bekommen nichts): ${noPush.map((c) => esc(c.displayName)).join(', ')}</div>` : ''}
          <div class="muted">Letzter Lauf: ${cfg.lastRunAt ? `${esc(fmtTs(cfg.lastRunAt))} – ${esc(cfg.lastResult || '')}` : 'noch nie'}</div>
        </div>
      </form>`;
    const f = root.querySelector('form');
    const body = () => {
      const days = parseNum(f.days.value);
      if (!days || Number.isNaN(days)) throw new Error('Bitte eine Anzahl Tage angeben.');
      return { enabled: f.enabled.checked, days, time: f.time.value, title: f.title.value, body: f.body.value, repeatDaily: f.repeatDaily.checked };
    };
    const showErr = (err) => {
      const e = f.querySelector('.error');
      e.textContent = err.message;
      e.hidden = false;
    };
    f.enabled.addEventListener('change', async () => {
      try {
        const next = await api('PUT', '/api/admin/reminder', { enabled: f.enabled.checked });
        toast(f.enabled.checked ? 'Automatische Erinnerung aktiv ✓' : 'Automatische Erinnerung aus');
        drawReminder(next);
        drawActivity(next);
      } catch (err) {
        showErr(err);
      }
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const next = await api('PUT', '/api/admin/reminder', body());
        toast('Gespeichert ✓');
        drawReminder(next);
        drawActivity(next);
      } catch (err) {
        showErr(err);
      }
    });
    f.querySelector('[data-run]').addEventListener('click', async () => {
      try {
        await api('PUT', '/api/admin/reminder', body());
        const next = await api('POST', '/api/admin/reminder/run');
        toast(next.result.recipients ? `${next.result.delivered} von ${next.result.recipients} erinnert` : 'Niemand fällig');
        drawReminder(next);
        drawActivity(next);
      } catch (err) {
        showErr(err);
      }
    });
  }

  function drawFoods(term = '') {
    const root = document.getElementById('foods');
    const t = term.trim().toLowerCase();
    const list = foodCache.filter((f) => !t || f.name.toLowerCase().includes(t) || (f.category || '').toLowerCase().includes(t));
    root.innerHTML = `
      <div class="row-between" style="margin-bottom:8px"><h2>Lebensmittel-Datenbank</h2>
        <button type="button" class="btn-primary btn-sm" data-new-food>+ Lebensmittel anlegen</button></div>
      <p class="small muted" style="margin:0 0 10px">${foodCache.length} Lebensmittel, kcal pro 100 g bzw. 100 ml. Die mitgelieferten Werte sind Richtwerte – du kannst alles anpassen.</p>
      <input type="search" data-food-search placeholder="Suchen, z. B. Reis oder Obst" value="${esc(term)}" style="margin-bottom:10px">
      <div class="table-wrap food-table-wrap"><table>
        <thead><tr><th>Lebensmittel</th><th class="num">kcal / 100</th><th>Kategorie</th><th></th></tr></thead>
        <tbody>${list
          .map((f) => `<tr><td>${esc(f.name)} ${f.custom ? '<span class="badge">eigenes</span>' : ''}</td>
            <td class="num">${num(f.kcal)} <span class="muted small">/ 100 ${f.unit}</span></td>
            <td class="muted small">${esc(f.category || '')}</td>
            <td class="actions"><button type="button" class="btn-ghost btn-sm" data-edit-food="${f.id}">Bearbeiten</button><button type="button" class="btn-ghost btn-sm danger-text" data-del-food="${f.id}" aria-label="Löschen">✕</button></td></tr>`)
          .join('') || '<tr><td colspan="4" class="muted">Nichts gefunden.</td></tr>'}</tbody>
      </table></div>`;
    const search = root.querySelector('[data-food-search]');
    search.addEventListener('input', () => {
      const pos = search.selectionStart;
      drawFoods(search.value);
      const s2 = document.querySelector('[data-food-search]');
      s2.focus();
      s2.setSelectionRange(pos, pos);
    });
    root.querySelector('[data-new-food]').addEventListener('click', async () => {
      if (await createFoodDialog(search.value)) drawFoods(search.value);
    });
    root.querySelectorAll('[data-edit-food]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (await createFoodDialog('', foodCache.find((f) => f.id === Number(b.dataset.editFood)))) drawFoods(search.value);
      })
    );
    root.querySelectorAll('[data-del-food]').forEach((b) =>
      b.addEventListener('click', async () => {
        const f = foodCache.find((x) => x.id === Number(b.dataset.delFood));
        if (!confirm(`„${f.name}“ aus der Datenbank löschen? Bestehende Ernährungspläne bleiben unverändert.`)) return;
        await api('DELETE', `/api/foods/${f.id}`);
        await loadFoods(true);
        toast('Gelöscht');
        drawFoods(search.value);
      })
    );
  }

  // ---------- coach: push notifications ----------
  function consentBadge(c) {
    if (c.pushStatus === 'granted') {
      return c.pushDevices
        ? `<span class="badge good">✓ Zugestimmt · ${c.pushDevices} Gerät${c.pushDevices === 1 ? '' : 'e'}</span>`
        : '<span class="badge warn">Zugestimmt, kein aktives Gerät</span>';
    }
    if (c.pushStatus === 'denied') return '<span class="badge bad">✗ Abgelehnt</span>';
    return '<span class="badge">Noch nicht gefragt</span>';
  }

  function renderConsentList(root, clients) {
    if (!clients.length) {
      root.innerHTML = '<p class="muted small">Noch keine Klienten.</p>';
      return;
    }
    const count = (st) => clients.filter((c) => c.pushStatus === st).length;
    root.innerHTML = `
      <p class="small muted" style="margin:0 0 8px">${count('granted')} zugestimmt · ${count('denied')} abgelehnt · ${count('unknown')} offen</p>
      <ul class="plain-list">${clients
        .map((c) => `<li><a href="#/client/${c.id}">${esc(c.displayName)}</a>${consentBadge(c)}</li>`)
        .join('')}</ul>`;
  }

  async function loadNotifications(root) {
    const { notifications, timezone, automation: auto } = await api('GET', '/api/notifications');
    const autoHtml = `
      <div class="notif automation">
        <div class="row-between"><strong>🤖 Automatisch: Erinnerung bei fehlendem Eintrag</strong>
          <span class="badge ${auto.enabled ? 'good' : ''}">${auto.enabled ? `Täglich ${esc(auto.time)} Uhr` : 'Aus'}</span></div>
        <div class="small muted">${auto.enabled
          ? `Geht an Klienten, die ${auto.days} ${auto.days === 1 ? 'Tag' : 'Tage'} nichts eingetragen haben.${auto.lastResult ? ` Zuletzt: ${esc(auto.lastResult)}` : ''}`
          : 'Schickt automatisch eine Push-Nachricht an Klienten, die eine Weile nichts eingetragen haben.'}</div>
        <a class="small" href="#/admin">Im Admin-Tool einstellen →</a>
      </div>`;
    if (!notifications.length) {
      root.innerHTML = `${autoHtml}<p class="muted small">Noch keine eigenen Push-Nachrichten. Leg oben deine erste an.</p>`;
      return;
    }
    const fmt = (iso) =>
      new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: timezone });
    root.innerHTML = `${autoHtml}<ul class="notif-list">${notifications
      .map((n) => {
        const state = n.active
          ? n.nextRunAt
            ? `Nächste: ${esc(fmt(n.nextRunAt))}`
            : 'Aktiv'
          : n.schedule === 'once'
            ? n.lastSentAt ? 'Gesendet' : 'Abgebrochen'
            : 'Pausiert';
        const who = n.audience === 'all' ? 'Alle mit Zustimmung' : esc(n.recipientNames.join(', '));
        return `<li class="notif ${n.active ? '' : 'inactive'}">
          <div class="row-between"><strong>${esc(n.title)}</strong>
            <span class="badge ${n.active ? 'good' : ''}">${esc(n.scheduleText)}</span></div>
          <div class="small">${esc(n.body)}</div>
          <div class="small muted">An: ${who} · ${state}${n.lastSentAt ? ` · Zuletzt ${esc(fmt(n.lastSentAt))}: ${esc(n.lastResult || '')}` : ''}</div>
          <div class="row notif-actions">
            <button type="button" class="btn-ghost btn-sm" data-send="${n.id}">Jetzt senden</button>
            ${n.schedule !== 'once' ? `<button type="button" class="btn-ghost btn-sm" data-toggle="${n.id}" data-active="${n.active}">${n.active ? 'Pausieren' : 'Fortsetzen'}</button>` : ''}
            ${n.schedule === 'once' && n.active ? `<button type="button" class="btn-ghost btn-sm" data-toggle="${n.id}" data-active="true">Abbrechen</button>` : ''}
            <button type="button" class="btn-ghost btn-sm danger-text" data-del="${n.id}">Löschen</button>
          </div>
        </li>`;
      })
      .join('')}</ul>`;

    const reload = () => loadNotifications(root).catch((err) => toast(err.message, true));
    root.querySelectorAll('[data-send]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Diese Nachricht jetzt an alle Empfänger senden?')) return;
        try {
          const { notification } = await api('POST', `/api/notifications/${b.dataset.send}/send`);
          toast(notification.lastResult || 'Gesendet');
        } catch (err) {
          toast(err.message, true);
        }
        reload();
      })
    );
    root.querySelectorAll('[data-toggle]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await api('PATCH', `/api/notifications/${b.dataset.toggle}`, { active: b.dataset.active !== 'true' });
        } catch (err) {
          toast(err.message, true);
        }
        reload();
      })
    );
    root.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Push-Nachricht löschen?')) return;
        await api('DELETE', `/api/notifications/${b.dataset.del}`).catch((err) => toast(err.message, true));
        reload();
      })
    );
  }

  function openPushDialog(clients, onSaved) {
    const days = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    const granted = clients.filter((c) => c.pushStatus === 'granted').length;
    openDialog(
      `<h2>Neue Push-Nachricht</h2>
       <div class="field"><label for="n-title">Titel</label><input id="n-title" name="title" maxlength="60" required placeholder="z. B. Zeit zum Eintragen ⏰"></div>
       <div class="field"><label for="n-body">Text</label><textarea id="n-body" name="body" maxlength="240" required placeholder="z. B. Trag noch schnell Gewicht, Schritte und Schlaf ein 💪"></textarea></div>

       <fieldset class="field"><legend>Empfänger</legend>
         <label class="check"><input type="radio" name="audience" value="all" checked> Alle Klienten mit Zustimmung (${granted})</label>
         <label class="check"><input type="radio" name="audience" value="some"> Bestimmte Klienten</label>
         <div class="choice-list" data-recipients hidden>${clients
           .map((c) => `<label class="check"><input type="checkbox" name="recipient" value="${c.id}"${c.pushStatus === 'granted' ? '' : ' disabled'}>
             ${esc(c.displayName)} ${c.pushStatus === 'granted' ? '' : '<span class="muted small">(keine Zustimmung)</span>'}</label>`)
           .join('')}</div>
       </fieldset>

       <fieldset class="field"><legend>Wann?</legend>
         <div class="segmented seg-wide" role="radiogroup">
           <label><input type="radio" name="schedule" value="once" checked><span>Einmalig</span></label>
           <label><input type="radio" name="schedule" value="daily"><span>Täglich</span></label>
           <label><input type="radio" name="schedule" value="weekly"><span>Wöchentlich</span></label>
         </div>
         <div data-once>
           <label class="check"><input type="radio" name="when" value="now" checked> Sofort senden</label>
           <label class="check"><input type="radio" name="when" value="later"> Zu einem Zeitpunkt:</label>
           <input type="datetime-local" name="sendAt" disabled>
         </div>
         <div data-weekdays hidden>
           <div class="weekday-picker">${days
             .map((d, i) => `<label><input type="checkbox" name="weekday" value="${i + 1}"${i === 0 ? ' checked' : ''}><span>${d}</span></label>`)
             .join('')}</div>
         </div>
         <div data-time hidden>
           <label for="n-time">Uhrzeit <span class="muted">(deutsche Zeit)</span></label>
           <input id="n-time" type="time" name="time" value="08:00">
         </div>
       </fieldset>
       <div class="dialog-actions">
         <button type="button" class="btn-secondary" data-close>Abbrechen</button>
         <button type="submit" class="btn-primary">Speichern</button>
       </div>`,
      async (f) => {
        const schedule = f.schedule.value;
        const body = {
          title: f.title.value,
          body: f.body.value,
          audience: f.audience.value,
          recipientIds: [...f.querySelectorAll('[name=recipient]:checked')].map((x) => Number(x.value)),
          schedule,
        };
        if (schedule === 'once' && f.when.value === 'later') {
          if (!f.sendAt.value) throw new Error('Bitte Datum und Uhrzeit wählen.');
          body.sendAt = new Date(f.sendAt.value).toISOString();
        }
        if (schedule !== 'once') body.time = f.time.value;
        if (schedule === 'weekly') body.weekdays = [...f.querySelectorAll('[name=weekday]:checked')].map((x) => Number(x.value));
        const { notification } = await api('POST', '/api/notifications', body);
        toast(schedule === 'once' && !body.sendAt ? notification.lastResult || 'Gesendet' : 'Push-Nachricht geplant ✓');
        onSaved();
      }
    );
    const f = dialog.querySelector('form');
    const sync = () => {
      const sch = f.schedule.value;
      f.querySelector('[data-once]').hidden = sch !== 'once';
      f.querySelector('[data-weekdays]').hidden = sch !== 'weekly';
      f.querySelector('[data-time]').hidden = sch === 'once';
      f.querySelector('[data-recipients]').hidden = f.audience.value !== 'some';
      f.sendAt.disabled = f.when.value !== 'later';
      f.querySelector('[type=submit]').textContent = sch === 'once' && f.when.value === 'now' ? 'Jetzt senden' : 'Speichern';
    };
    f.addEventListener('change', sync);
    sync();
  }

  function showCredentials(name, username, password, after) {
    const text = `Dein Zugang zum Thabstracker\nAdresse: ${location.origin}\nBenutzername: ${username}\nPasswort: ${password}`;
    dialog.innerHTML = `<form method="dialog">
      <h2>Zugang für ${esc(name)}</h2>
      <p class="muted small">Schick diese Daten an deinen Klienten. Das Passwort wird danach nicht mehr angezeigt.</p>
      <div class="credentials">${esc(text)}</div>
      <div class="dialog-actions">
        <button type="button" class="btn-secondary" data-copy>Kopieren</button>
        <button type="submit" class="btn-primary">Fertig</button>
      </div></form>`;
    dialog.querySelector('[data-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('In die Zwischenablage kopiert');
      } catch {
        toast('Kopieren nicht möglich – bitte manuell markieren', true);
      }
    });
    dialog.addEventListener('close', () => after && after(), { once: true });
    if (!dialog.open) dialog.showModal();
  }

  // ---------- coach: client detail ----------
  async function renderCoachClient(id, tab) {
    setView('<p class="muted">Lade…</p>');
    let clients, entries, goals;
    let goalHistory = [];
    try {
      [{ clients }, { entries }, { goals }] = await Promise.all([
        api('GET', '/api/clients'),
        tab !== 'overview' ? { entries: [] } : api('GET', `/api/entries?userId=${id}`),
        tab === 'chat' ? { goals: {} } : api('GET', `/api/goals?userId=${id}`).then((g) => {
          goalHistory = g.history;
          return g;
        }),
      ]);
      if (!clients.some((c) => c.id === id)) throw new Error('Klient nicht gefunden');
    } catch (err) {
      setView(`<a class="back" href="#/">← Alle Klienten</a><div class="card empty-state">${esc(err.message)}</div>`);
      return;
    }
    const client = clients.find((c) => c.id === id);

    const head = `
      <a class="back" href="#/">← Alle Klienten</a>
      <div class="page-head">
        <div>${eyebrow('Klient')}<h1>${esc(client.displayName)}</h1><p class="muted">@${esc(client.username)} · Klient seit ${esc(fmtDate(client.createdAt.slice(0, 10), { month: 'long', year: 'numeric' }))}</p>
          <div class="row" style="gap:6px;margin-top:6px">${consentBadge(client)}
            ${client.healthLinked ? `<span class="badge good">❤️ Apple Health${client.healthLastUsed ? ` · ${esc(relDay(client.healthLastUsed.slice(0, 10)))}` : ' · noch keine Daten'}</span>` : ''}</div></div>
        <div class="row">
          <a class="btn btn-secondary" href="/api/entries.csv?userId=${id}">CSV exportieren</a>
        </div>
      </div>
      <nav class="tabs" aria-label="Bereiche">
        <a href="#/client/${id}"${tab === 'overview' ? ' aria-current="page"' : ''}>Übersicht</a>
        <a href="#/client/${id}/nutrition"${tab === 'nutrition' ? ' aria-current="page"' : ''}>Ernährungsplan${
          client.openSwaps ? ` <span class="count">${client.openSwaps}</span>` : ''
        }</a>
        <a href="#/client/${id}/chat"${tab === 'chat' ? ' aria-current="page"' : ''}>Nachrichten${
          client.unreadMessages && tab !== 'chat' ? ` <span class="count">${client.unreadMessages}</span>` : ''
        }</a>
      </nav>`;

    if (tab === 'nutrition') {
      setView(`${head}<div id="nutrition"><p class="muted">Lade…</p></div>`);
      mountCoachNutrition(document.getElementById('nutrition'), client, goals);
      return;
    }

    if (tab === 'chat') {
      setView(`${head}<div id="chat"></div>`);
      mountChat(document.getElementById('chat'), {
        query: `?userId=${id}`,
        title: `Nachrichten mit ${client.displayName}`,
        subtitle: 'Wünsche, Fragen und Vorschläge deines Klienten',
        empty: `${client.displayName} hat dir noch nicht geschrieben. Du kannst das Gespräch auch selbst beginnen.`,
      });
      return;
    }

    setView(`
      ${head}
      <div class="grid-2">
        <div class="stack">
          <form class="card" id="goals-form" novalidate>
            <h2 style="margin-bottom:12px">Plan &amp; Ziele</h2>
            <div class="field"><label for="g-kmin">Zielkalorien pro Tag <span class="muted small">(Range, z. B. 2200 – 2300)</span></label>
              <div class="kcal-range">
                <div class="input-unit"><input id="g-kmin" name="caloriesMin" inputmode="numeric" placeholder="von"><span>kcal</span></div>
                <span>–</span>
                <div class="input-unit"><input id="g-kmax" name="caloriesMax" inputmode="numeric" placeholder="bis" aria-label="Kalorien bis"><span>kcal</span></div>
              </div>
              <div class="hint">Für einen festen Wert nur „von“ ausfüllen. Im Diagramm erscheint der Mittelwert.</div></div>
            <div class="field"><label for="g-w">Zielgewicht</label>
              <div class="input-unit"><input id="g-w" name="targetWeight" inputmode="decimal"><span>kg</span></div></div>
            <div class="field"><label for="g-s">Schritte pro Tag</label>
              <div class="input-unit"><input id="g-s" name="stepsGoal" inputmode="numeric"><span>Schritte</span></div></div>
            <div class="field"><label for="g-sl">Schlaf pro Nacht</label>
              <div class="input-unit"><input id="g-sl" name="sleepGoal" inputmode="decimal" placeholder="z. B. 7,5"><span>Std.</span></div></div>
            <button class="btn-primary btn-block" type="submit">Plan speichern</button>
            <p class="error" hidden></p>
            <p class="hint">Den Plan sieht dein Klient in seiner Übersicht. Änderungen mit Erklärung schickst du am besten über den <a href="#/checkin/${id}">Check-in</a>.</p>
          </form>
          <div class="card">
            <h2 style="margin-bottom:12px">Zugang verwalten</h2>
            <div class="stack">
              <button class="btn-secondary btn-block" type="button" id="btn-rename">Namen ändern</button>
              <button class="btn-secondary btn-block" type="button" id="btn-reset">Neues Passwort vergeben</button>
              <button class="btn-danger btn-block" type="button" id="btn-delete">Klient löschen</button>
            </div>
          </div>
        </div>
        <div id="dashboard" class="stack"></div>
      </div>`);

    stickyColumn(document.querySelector('.grid-2 > .stack'));
    const dash = mountDashboard(document.getElementById('dashboard'), { entries, goals, history: goalHistory });

    const gf = document.getElementById('goals-form');
    const show = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
    gf.targetWeight.value = show(goals.targetWeight);
    gf.stepsGoal.value = show(goals.stepsGoal);
    gf.sleepGoal.value = show(goals.sleepGoal);
    gf.caloriesMin.value = show(goals.caloriesMin);
    gf.caloriesMax.value = show(goals.caloriesMax === goals.caloriesMin ? null : goals.caloriesMax);
    gf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = gf.querySelector('.error');
      errEl.hidden = true;
      try {
        const body = {
          targetWeight: parseNum(gf.targetWeight.value),
          stepsGoal: parseNum(gf.stepsGoal.value),
          sleepGoal: parseNum(gf.sleepGoal.value),
          caloriesMin: parseNum(gf.caloriesMin.value),
          caloriesMax: parseNum(gf.caloriesMax.value),
        };
        if (Object.values(body).some(Number.isNaN)) throw new Error('Bitte nur Zahlen eingeben.');
        await api('PUT', `/api/goals?userId=${id}`, body);
        const fresh = await api('GET', `/api/goals?userId=${id}`);
        dash.setGoals(fresh.goals, fresh.history);
        toast('Plan gespeichert');
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });

    document.getElementById('btn-rename').addEventListener('click', () => {
      openDialog(
        `<h2>Namen ändern</h2>
         <div class="field"><label for="r-name">Name</label><input id="r-name" name="displayName" value="${esc(client.displayName)}" required></div>
         <div class="dialog-actions"><button type="button" class="btn-secondary" data-close>Abbrechen</button>
           <button type="submit" class="btn-primary">Speichern</button></div>`,
        async (f) => {
          await api('PATCH', `/api/clients/${id}`, { displayName: f.displayName.value });
          toast('Name geändert');
          renderCoachClient(id);
        }
      );
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
      openDialog(
        `<h2>Neues Passwort</h2>
         <p class="muted small">Der Klient wird auf allen Geräten abgemeldet und muss sich mit dem neuen Passwort anmelden.</p>
         <div class="field"><label for="n-pw">Neues Passwort</label><input id="n-pw" name="password" value="${randomPassword()}" required></div>
         <div class="dialog-actions"><button type="button" class="btn-secondary" data-close>Abbrechen</button>
           <button type="submit" class="btn-primary">Passwort setzen</button></div>`,
        async (f) => {
          await api('PATCH', `/api/clients/${id}`, { password: f.password.value });
          showCredentials(client.displayName, client.username, f.password.value);
          return false;
        }
      );
    });

    document.getElementById('btn-delete').addEventListener('click', async () => {
      if (!confirm(`${client.displayName} und alle Einträge endgültig löschen?`)) return;
      try {
        await api('DELETE', `/api/clients/${id}`);
        toast('Klient gelöscht');
        location.hash = '#/';
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  boot();
})();
