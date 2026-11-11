// Ergänzung der Thabs-KOPIE (nicht Teil des Originals, wird beim Ausliefern an index.html angehängt):
// 1. Kennzeichnet die Seite sichtbar als Testkopie.
// 2. Fügt für Klienten einen Menüpunkt zum Ernährungstracker (/ernaehrung/) hinzu.
(function () {
  'use strict';
  const nutrition = document.currentScript && document.currentScript.dataset.nutrition === '1';

  const style = document.createElement('style');
  style.textContent = '.kopie-badge{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;font-size:.7rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:#b45309;color:#fff;vertical-align:middle}';
  document.head.appendChild(style);

  function badge() {
    const brand = document.querySelector('.brand');
    if (brand && !brand.querySelector('.kopie-badge')) {
      const b = document.createElement('span');
      b.className = 'kopie-badge';
      b.textContent = 'Testkopie';
      b.title = 'Getrennte Kopie – Daten hier gehen nicht an den echten Thabstracker';
      brand.appendChild(b);
    }
  }

  function navLink() {
    if (!nutrition) return;
    const nav = document.getElementById('nav');
    const who = document.getElementById('whoami');
    if (!nav || !who || !/Klient$/.test(who.textContent || '')) return;
    if (nav.querySelector('[data-kopie-link]')) return;
    const a = document.createElement('a');
    a.href = '/ernaehrung/';
    a.dataset.kopieLink = '';
    a.textContent = 'Kalorientracker';
    a.title = 'Ernährungstracker – trägt deine Kalorien automatisch hier ein';
    nav.appendChild(a);
  }

  const run = () => { badge(); navLink(); };
  run();
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
})();
