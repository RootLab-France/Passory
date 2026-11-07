(function () {
  'use strict';

  const TYPES = {
    password: { label: 'Mot de passe', page: 'passwords.html', icon: 'fa-key' },
    card:     { label: 'Carte',        page: 'cards.html',     icon: 'fa-credit-card' },
    iban:     { label: 'IBAN',         page: 'ibans.html',     icon: 'fa-building-columns' },
    note:     { label: 'Note',         page: 'notes.html',     icon: 'fa-sticky-note' },
    identity: { label: 'Identité',     page: 'identities.html', icon: 'fa-id-card' },
  };

  let total = 0;

  (async () => {
    const ok = await window.Passory.requireUnlockedOrRedirect();
    if (!ok) return;

    // ── Compteurs de catégories ─────────────────────────────────────
    try {
      const res = await window.passory.items.counts();
      if (res && res.success) {
        total = res.total || 0;
        Object.keys(TYPES).forEach(function (type) {
          const el = document.querySelector('[data-count="' + type + '"]');
          if (el) el.textContent = typeof res.counts[type] === 'number' ? res.counts[type] : '—';
        });
      } else {
        document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = '?'; });
      }
    } catch (err) {
      document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = '?'; });
    }

    // ── Résumé sécurité + rappel de sauvegarde ──────────────────────
    const secEl = document.getElementById('security-score');
    const last = window.Passory.getLastBackup();
    try {
      const res2 = await window.passory.settings.get();
      const s = res2.settings;
      const autoLock = s.autoLockMinutes > 0 ? 'après ' + s.autoLockMinutes + ' min' : 'désactivé';
      const bk = last ? 'dernière sauvegarde ' + window.Passory.formatRelativeDate(last) : 'aucune sauvegarde';
      if (secEl) secEl.textContent = 'Verrouillage auto ' + autoLock + ' · ' + bk;
    } catch (err) {
      if (secEl) secEl.textContent = '';
    }
    const reminder = document.getElementById('backup-reminder');
    const welcome = /bienvenue=1/.test(window.location.search);
    // Nouveau coffre (premier lancement ou après « Repartir de zéro ») :
    // indiquer comment restaurer une sauvegarde existante.
    const restoreHint = document.getElementById('restore-hint');
    if (welcome && restoreHint && total === 0) {
      if (/repartir=1/.test(window.location.search)) {
        document.getElementById('restore-hint-title').textContent = 'Nouveau coffre créé. Pour retrouver vos données, restaurez une sauvegarde';
      }
      restoreHint.classList.remove('hidden');
    }
    const old = last && (Date.now() - last) > 30 * 24 * 3600 * 1000;
    if (reminder && (!last || old)) {
      if (welcome) {
        document.getElementById('backup-reminder-title').textContent = 'Votre coffre est prêt. Prochaine étape : une sauvegarde';
      } else if (old) {
        document.getElementById('backup-reminder-title').textContent = 'Votre dernière sauvegarde date de plus d\'un mois';
        document.getElementById('backup-reminder-text').textContent = 'Les éléments ajoutés depuis ne sont pas protégés en cas de panne. Refaites une sauvegarde.';
      }
      reminder.classList.remove('hidden');
    }
  })();

  // ── Recherche globale ─────────────────────────────────────────────
  // La liste est expurgée : on ne cherche que dans les champs non secrets.
  const input = document.getElementById('global-search');
  const results = document.getElementById('results');
  let all = null;
  let timer = null;

  async function loadAll() {
    if (all) return all;
    const r = await window.passory.items.list();
    if (!r || !r.success) {
      if (r && r.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return []; }
      return [];
    }
    all = r.entries.filter((e) => !e.corrupt && TYPES[e.type]).map((e) => {
      const p = e.payload || {};
      const name = p.label || p.title || '(Sans titre)';
      const sub = [p.username, p.url, p.bank, p.holder, p.fullName].filter(Boolean).join(' · ');
      const hay = [name, p.username, p.url, p.bank, p.holder, p.fullName]
        .filter(Boolean).join(' ').toLowerCase();
      return { id: e.id, type: e.type, name, sub, hay };
    });
    return all;
  }

  async function runSearch() {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.classList.add('hidden'); results.innerHTML = ''; return; }
    const list = await loadAll();
    const found = list.filter((x) => x.hay.includes(q)).slice(0, 30);
    const esc = window.Passory.escapeHtml;
    results.classList.remove('hidden');
    if (!found.length) {
      results.innerHTML = '<div class="p-4 text-sm" style="color:var(--text-secondary)">Aucun élément ne correspond à « ' + esc(input.value.trim()) + ' ».</div>';
      return;
    }
    results.innerHTML = found.map((x) => {
      const t = TYPES[x.type];
      const href = t.page + '?q=' + encodeURIComponent(x.type === 'note' ? x.name : input.value.trim());
      return '<a class="search-result" href="' + esc(href) + '">' +
        window.Passory.renderAvatar(x.name, t.icon) +
        '<div class="item-info"><div class="item-label">' + esc(x.name) + '</div>' +
        (x.sub ? '<div class="item-sub">' + esc(x.sub) + '</div>' : '') + '</div>' +
        '<span class="search-result-type">' + esc(t.label) + '</span></a>';
    }).join('');
  }

  if (input && results) {
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 120); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const first = results.querySelector('a'); if (first) { e.preventDefault(); first.click(); } }
      if (e.key === 'ArrowDown') { const first = results.querySelector('a'); if (first) { e.preventDefault(); first.focus(); } }
      if (e.key === 'Escape') { input.value = ''; runSearch(); }
    });
    results.addEventListener('keydown', (e) => {
      const links = [...results.querySelectorAll('a')];
      const i = links.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && i >= 0 && i < links.length - 1) { e.preventDefault(); links[i + 1].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) links[i - 1].focus(); else input.focus(); }
    });
  }
})();
