/**
 * Helpers partagés — renderer.
 * Expose window.Passory.*
 */
(function () {
  'use strict';

  // ── Fonctions désactivées (src/shared/features.js) ──────────
  // v1.0 : le transfert direct entre appareils est désactivé. Si la page
  // transfer.html est ouverte quand même, retour immédiat à l'accueil.
  const FEATURES = window.PassoryFeatures || { transfer: false };
  if (!FEATURES.transfer && /\/transfer\.html$/.test(window.location.pathname)) {
    window.location.replace('dashboard.html');
    return;
  }

  // ── API en attente (mobile) ─────────────────────────────────
  // Sur Electron, window.passory est posé par le preload avant tout script.
  // Sur mobile, web-bootstrap.js est asynchrone : les scripts de page tournent
  // AVANT que l'API existe. On installe un relais qui met les appels en
  // attente jusqu'à l'événement « passory:ready », puis les exécute sur la
  // vraie API (qui remplace ce relais).
  if (!window.passory) {
    let markReady;
    const ready = new Promise((r) => { markReady = r; });
    window.addEventListener('passory:ready', () => markReady(), { once: true });
    const call = (ns, fn, args) => ready.then(() => {
      const real = window.passory;
      if (!real || real.__pending) throw new Error('API Passory indisponible');
      return ns ? real[ns][fn](...args) : real[fn](...args);
    });
    const namespace = (ns) => new Proxy({}, { get: (_t, fn) => (...args) => call(ns, fn, args) });
    window.passory = new Proxy({}, {
      get: (_t, k) => {
        if (k === '__pending') return true;
        if (k === 'ping') return (...args) => call(null, 'ping', args);
        return namespace(k);
      },
    });
  }

  // ── Navigation ──────────────────────────────────────────────
  const NAV_ITEMS = [
    { key: 'dashboard',  label: 'Accueil',       icon: 'fa-home',             color: 'icon-blue',    href: 'dashboard.html' },
    { key: 'passwords',  label: 'Mots de passe', icon: 'fa-key',              color: 'icon-blue',    href: 'passwords.html' },
    { key: 'cards',      label: 'Cartes',         icon: 'fa-credit-card',      color: 'icon-indigo',  href: 'cards.html' },
    { key: 'ibans',      label: 'IBAN',           icon: 'fa-building-columns', color: 'icon-teal',    href: 'ibans.html' },
    { key: 'notes',      label: 'Notes',          icon: 'fa-sticky-note',      color: 'icon-amber',   href: 'notes.html' },
    { key: 'identities', label: 'Identités',      icon: 'fa-id-card',          color: 'icon-fuchsia', href: 'identities.html' },
    // Transfert direct : uniquement si la fonction est active (désactivée en v1.0).
    { key: 'transfer',   label: 'Transfert',      icon: 'fa-plug',             color: 'icon-teal',    href: 'transfer.html', feature: 'transfer' },
  ].filter((it) => !it.feature || FEATURES[it.feature]);

  function renderSidebar(activeKey) {
    const host = document.querySelector('[data-sidebar]');
    if (!host) return;
    host.className = 'sidebar';

    const navItems = NAV_ITEMS.map(it => {
      const isActive = it.key === activeKey;
      return `<a href="${it.href}" class="nav-item${isActive ? ' active' : ''}"${isActive ? ' aria-current="page"' : ''}>
        <span class="nav-icon ${isActive ? '' : it.color}" aria-hidden="true"><i class="fas ${it.icon}"></i></span>
        <span>${it.label}</span>
      </a>`;
    }).join('');

    const isSettingsActive = activeKey === 'settings';
    host.innerHTML = `
      <div class="sidebar-section">${navItems}</div>
      <div class="sidebar-footer">
        <a href="settings.html" class="nav-item${isSettingsActive ? ' active' : ''}"${isSettingsActive ? ' aria-current="page"' : ''}>
          <span class="nav-icon ${isSettingsActive ? '' : 'icon-gray'}" aria-hidden="true"><i class="fas fa-sliders"></i></span>
          <span>Paramètres</span>
        </a>
        <button id="logout-btn" type="button" class="nav-item lock" title="Verrouiller le coffre maintenant">
          <span class="nav-icon" aria-hidden="true"><i class="fas fa-lock"></i></span>
          <span>Verrouiller</span>
        </button>
      </div>
    `;
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => lockAndGoLogin('manuel'));
  }

  // ── Titlebar ─────────────────────────────────────────────────
  function wireTitlebar() {
    const win = window.passory && window.passory.window;
    if (!win) return;
    const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    // Libellés accessibles des boutons de fenêtre (icônes seules).
    const labels = { 'btn-minimize': 'Réduire la fenêtre', 'btn-maximize': 'Agrandir la fenêtre', 'btn-close': 'Fermer Passory' };
    for (const [id, label] of Object.entries(labels)) {
      const el = document.getElementById(id);
      if (el) { if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', label); if (!el.title) el.title = label; el.tabIndex = -1; }
    }
    bind('btn-minimize', () => win.minimize());
    bind('btn-maximize', () => win.toggleMaximize());
    bind('btn-close',    () => win.close());
    win.onMaximize(() => {
      const icon = document.querySelector('#btn-maximize i');
      if (icon) { icon.className = 'fas fa-compress'; }
    });
    win.onUnmaximize(() => {
      const icon = document.querySelector('#btn-maximize i');
      if (icon) { icon.className = 'far fa-square'; }
    });
  }

  // ── Activity ping ────────────────────────────────────────────
  function wireActivityPing() {
    if (!window.passory || typeof window.passory.ping !== 'function') return;
    let last = 0;
    const ping = () => { const now = Date.now(); if (now - last > 5000) { last = now; window.passory.ping(); } };
    ['mousemove', 'keydown', 'click', 'input'].forEach(ev => document.addEventListener(ev, ping, { passive: true }));
  }

  // ── Global keyboard shortcuts ────────────────────────────────
  function wireGlobalShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+F → focus search input
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        const search = document.getElementById('search') || document.getElementById('global-search');
        if (search) { e.preventDefault(); search.focus(); search.select(); }
      }
      // Ctrl+N → click add button
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        const addBtn = document.getElementById('add-btn');
        if (addBtn) { e.preventDefault(); addBtn.click(); }
      }
      // Escape → ferme la modale visible (la confirmation gère sa propre touche)
      if (e.key === 'Escape') {
        if (document.querySelector('#passory-confirm:not(.hidden)')) return;
        const modal = document.querySelector('.modal-backdrop:not(.hidden)');
        if (modal) {
          const cancelBtn = modal.querySelector('#modal-cancel') || modal.querySelector('#modal-close');
          if (cancelBtn) cancelBtn.click();
        }
      }
    });
  }

  // ── Toast (amélioré) ─────────────────────────────────────────
  function ensureToastContainer() {
    let c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      c.className = 'toast-container';
      document.body.appendChild(c);
    }
    return c;
  }

  const TOAST_ICONS = {
    info:    'fa-circle-info',
    success: 'fa-circle-check',
    error:   'fa-circle-xmark',
    warn:    'fa-triangle-exclamation',
  };

  function toast(message, kind = 'info') {
    const container = ensureToastContainer();
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.innerHTML = `<i class="fas ${TOAST_ICONS[kind] || TOAST_ICONS.info} toast-icon" aria-hidden="true"></i><span>${escapeHtml(message)}</span>`;
    el.title = 'Cliquer pour fermer';
    container.appendChild(el);
    const dismiss = () => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 220);
    };
    el.addEventListener('click', dismiss);
    // Les erreurs restent plus longtemps : il faut le temps de lire quoi faire.
    setTimeout(dismiss, kind === 'error' ? 7000 : kind === 'warn' ? 5000 : 3500);
  }

  /**
   * Traduit une erreur technique en message compréhensible.
   * `fallback` : ce qu'on dit si l'erreur est vide ou trop technique.
   */
  function friendlyError(err, fallback) {
    const raw = String((err && (err.error || err.message)) || err || '').trim();
    if (!raw || raw === 'Erreur.' || raw === 'Erreur') return fallback || 'Une erreur est survenue. Réessayez.';
    if (raw === 'LOCKED' || raw === 'Session verrouillée.') return 'Le coffre est verrouillé. Déverrouillez-le puis réessayez.';
    if (/^Trop de demandes/.test(raw)) return 'Trop d\'actions en peu de temps. Patientez une minute puis réessayez.';
    if (raw === 'Entrée introuvable.') return 'Cet élément n\'existe plus. La liste va être rechargée.';
    if (raw === 'Champ vide.') return 'Ce champ est vide : rien à copier.';
    if (/^Erreur (chiffrement|interne|sauvegarde paramètres)/.test(raw)) return (fallback || 'L\'enregistrement a échoué.') + ' Réessayez ; si le problème persiste, redémarrez Passory.';
    if (/[A-Za-z]+Error|ENOENT|EACCES|EPERM|undefined|null|\bat\b .*:\d+/.test(raw)) return fallback || 'Une erreur est survenue. Réessayez.';
    return raw;
  }

  /** Message de copie : rappelle quand le presse-papier sera vidé. */
  function copiedToast(what, res) {
    const s = res && typeof res.clearIn === 'number' ? res.clearIn : null;
    const base = s && s > 0 ? `${what} copié. Il sera effacé du presse-papier dans ${s} s.` : `${what} copié.`;
    if (res && res.protected === false) {
      toast(base + ' Attention : il peut apparaître dans l\'historique Windows (Win+V).', 'warn');
    } else {
      toast(base, 'success');
    }
  }

  // ── Confirmation (remplace confirm() natif) ─────────────────
  // Passory.confirm({ title, message, confirmLabel, cancelLabel, danger,
  //                   requireText, password, inputLabel }) → Promise
  //   - simple : true / false
  //   - password : la chaîne saisie, ou null si annulé
  let _cf = null;
  function ensureConfirm() {
    if (_cf) return _cf;
    const wrap = document.createElement('div');
    wrap.id = 'passory-confirm';
    wrap.className = 'modal-backdrop hidden';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'passory-confirm-title');
    wrap.setAttribute('aria-describedby', 'passory-confirm-message');
    wrap.innerHTML = `
      <div class="modal-dialog" style="max-width:440px">
        <div class="modal-header"><h2 id="passory-confirm-title" class="modal-title"></h2></div>
        <div class="modal-body">
          <p id="passory-confirm-message" class="confirm-message"></p>
          <div id="passory-confirm-input-wrap" class="form-group mt-4 hidden">
            <label id="passory-confirm-input-label" class="form-label" for="passory-confirm-input"></label>
            <input id="passory-confirm-input" class="form-input" autocomplete="off" spellcheck="false" />
            <p id="passory-confirm-input-hint" class="form-hint hidden"></p>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" id="passory-confirm-cancel" class="btn btn-ghost">Annuler</button>
          <button type="button" id="passory-confirm-ok" class="btn btn-primary">Confirmer</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const $ = (id) => document.getElementById(id);
    _cf = { wrap, title: $('passory-confirm-title'), message: $('passory-confirm-message'),
      inputWrap: $('passory-confirm-input-wrap'), inputLabel: $('passory-confirm-input-label'),
      input: $('passory-confirm-input'), hint: $('passory-confirm-input-hint'),
      cancel: $('passory-confirm-cancel'), ok: $('passory-confirm-ok'), resolve: null, mode: 'simple', lastFocus: null };
    const close = (accepted) => {
      const c = _cf; if (!c.resolve) return;
      const r = c.resolve; c.resolve = null;
      const val = c.input.value;
      c.input.value = '';
      wrap.classList.add('hidden');
      if (c.lastFocus && typeof c.lastFocus.focus === 'function') { try { c.lastFocus.focus(); } catch {} }
      if (c.mode === 'password') r(accepted && val ? val : null);
      else r(!!accepted);
    };
    _cf.close = close;
    _cf.cancel.addEventListener('click', () => close(false));
    _cf.ok.addEventListener('click', () => { if (!_cf.ok.disabled) close(true); });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(false); });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === 'Enter' && e.target !== _cf.cancel) { e.preventDefault(); if (!_cf.ok.disabled) close(true); }
      else if (e.key === 'Tab') {
        // Garde le focus dans la boîte de dialogue
        const f = [..._cf.wrap.querySelectorAll('input:not(.hidden), button')].filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    return _cf;
  }

  function confirmDialog(opts = {}) {
    const c = ensureConfirm();
    if (c.resolve) c.close(false);
    return new Promise((resolve) => {
      c.resolve = resolve;
      c.lastFocus = document.activeElement;
      c.mode = opts.password ? 'password' : 'simple';
      c.title.textContent = opts.title || 'Confirmer';
      c.message.textContent = opts.message || '';
      c.cancel.textContent = opts.cancelLabel || 'Annuler';
      c.ok.textContent = opts.confirmLabel || 'Confirmer';
      c.ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
      c.input.value = '';
      c.hint.classList.add('hidden');
      c.input.oninput = null;
      if (opts.password || opts.requireText) {
        c.inputWrap.classList.remove('hidden');
        c.input.type = opts.password ? 'password' : 'text';
        c.inputLabel.textContent = opts.inputLabel
          || (opts.password ? 'Mot de passe maître' : `Pour confirmer, tapez ${opts.requireText}`);
        if (opts.inputHint) { c.hint.textContent = opts.inputHint; c.hint.classList.remove('hidden'); }
        const check = () => {
          c.ok.disabled = opts.password ? !c.input.value : c.input.value.trim().toUpperCase() !== String(opts.requireText).toUpperCase();
        };
        c.input.oninput = check; check();
      } else {
        c.inputWrap.classList.add('hidden');
        c.ok.disabled = false;
      }
      c.wrap.classList.remove('hidden');
      setTimeout(() => ((opts.password || opts.requireText) ? c.input : (opts.danger ? c.cancel : c.ok)).focus(), 30);
    });
  }

  // ── Recherche pré-remplie (lien depuis la recherche globale) ──
  function applySearchFromUrl(input, onChange) {
    try {
      const q = new URLSearchParams(window.location.search).get('q');
      if (q && input) { input.value = q; if (onChange) onChange(); }
    } catch {}
  }

  // ── État vide (liste vide ou recherche sans résultat) ─────────
  // opts : { icon, title, sub, query } — query non vide → « Aucun résultat ».
  function renderEmpty(el, opts) {
    if (!el) return;
    const o = opts || {};
    el.className = 'empty-state';
    el.innerHTML = '';
    const icon = document.createElement('div');
    icon.className = 'empty-state-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = `<i class="fas ${o.query ? 'fa-magnifying-glass' : (o.icon || 'fa-box-open')}"></i>`;
    const t = document.createElement('div');
    t.className = 'empty-state-title';
    t.textContent = o.query ? 'Aucun résultat' : (o.title || 'Rien pour l\'instant');
    const sub = document.createElement('div');
    sub.className = 'empty-state-sub';
    sub.textContent = o.query
      ? `Rien ne correspond à « ${o.query} ». Vérifiez l'orthographe ou effacez la recherche.`
      : (o.sub || '');
    el.append(icon, t, sub);
  }

  /** « 3 cartes » / « 1 carte » / « Aucune carte ». */
  function setCount(el, n, one, many, none) {
    if (!el) return;
    el.textContent = n === 0 ? (none || ('Aucun ' + one)) : n + ' ' + (n > 1 ? many : one);
  }

  /** Confirmation standard avant suppression d'un élément. */
  function confirmDelete(what, name) {
    return confirmDialog({
      title: `Supprimer ${what} ?`,
      message: `« ${name || 'Sans nom'} » sera supprimé définitivement de votre coffre. Cette action ne peut pas être annulée.`,
      confirmLabel: 'Supprimer', danger: true,
    });
  }

  // ── Libellés accessibles : un bouton-icône hérite de son title ──
  function labelIconButtons(root) {
    (root || document).querySelectorAll('button[title]:not([aria-label])').forEach((b) => {
      if (!b.textContent.trim()) b.setAttribute('aria-label', b.title);
    });
  }

  // ── Navigation helpers ───────────────────────────────────────
  function goto(page) { window.location.href = page; }

  async function requireUnlockedOrRedirect() {
    try {
      const unlocked = await window.passory.auth.isUnlocked();
      if (!unlocked) { goto('login.html'); return false; }
      return true;
    } catch { goto('login.html'); return false; }
  }

  async function lockAndGoLogin(reason) {
    try { await window.passory.auth.lock(); } catch {}
    goto(reason ? 'login.html?raison=' + encodeURIComponent(reason) : 'login.html');
  }

  // ── String helpers ───────────────────────────────────────────
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Password strength ────────────────────────────────────────
  function passwordStrength(password) {
    if (!password) return { score: 0, label: '', color: '' };
    let score = 0;
    if (password.length >= 8)  score++;
    if (password.length >= 14) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;
    // Clamp to 4
    score = Math.min(4, Math.floor(score * 0.9));
    if (password.length < 8) score = 1;
    if (password.length === 0) score = 0;
    const LABELS = ['', 'Très faible', 'Faible', 'Bon', 'Excellent'];
    const COLORS = ['', '#ef4444', '#f59e0b', '#22c55e', '#10b981'];
    return { score, label: LABELS[score] || '', color: COLORS[score] || '' };
  }

  function renderStrengthBar(inputEl, wrapId) {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    const { score, label, color } = passwordStrength(inputEl.value);
    const bars = [1,2,3,4].map(n => {
      const active = n <= score;
      return `<div class="strength-bar" style="background:${active ? color : ''}"></div>`;
    }).join('');
    wrap.innerHTML = `
      <div class="strength-bars">${bars}</div>
      ${score > 0 ? `<span class="strength-label" style="color:${color}">${label}</span>` : ''}
    `;
  }

  // ── Card helpers ─────────────────────────────────────────────
  function formatCardNumber(n) {
    return String(n || '').replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
  }
  function maskCardNumber(n) {
    const digits = String(n || '').replace(/\D/g, '');
    if (digits.length < 4) return '•'.repeat(digits.length);
    return ('•'.repeat(Math.max(0, digits.length - 4)) + digits.slice(-4)).replace(/(.{4})/g, '$1 ').trim();
  }
  function detectCardNetwork(n) {
    const d = String(n || '').replace(/\D/g, '');
    if (/^4/.test(d)) return 'Visa';
    if (/^(5[1-5]|2[2-7])/.test(d)) return 'Mastercard';
    if (/^3[47]/.test(d)) return 'Amex';
    if (/^(6011|65|64[4-9]|622)/.test(d)) return 'Discover';
    if (/^(30[0-5]|36|38)/.test(d)) return 'Diners';
    return '';
  }
  function cardCssClass(network) {
    const map = { 'Visa': 'card-visa', 'Mastercard': 'card-mastercard', 'Amex': 'card-amex', 'Discover': 'card-discover', 'Diners': 'card-diners' };
    return map[network] || 'card-default';
  }

  // ── IBAN helpers ─────────────────────────────────────────────
  function formatIban(s) {
    return String(s || '').replace(/\s+/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim();
  }
  function maskIban(s) {
    const clean = String(s || '').replace(/\s+/g, '').toUpperCase();
    if (clean.length <= 8) return clean;
    const head = clean.slice(0, 4), tail = clean.slice(-4);
    return (head + '•'.repeat(Math.max(0, clean.length - 8)) + tail).replace(/(.{4})/g, '$1 ').trim();
  }
  function validateIban(s) {
    const iban = String(s || '').replace(/\s+/g, '').toUpperCase();
    if (iban.length < 15 || iban.length > 34) return false;
    if (!/^[A-Z0-9]+$/.test(iban)) return false;
    const rearranged = iban.slice(4) + iban.slice(0, 4);
    let expanded = '';
    for (const c of rearranged) expanded += c >= '0' && c <= '9' ? c : (c.charCodeAt(0) - 55).toString();
    let rem = 0;
    for (let i = 0; i < expanded.length; i++) rem = (rem * 10 + Number(expanded[i])) % 97;
    return rem === 1;
  }

  // ── Date helper ──────────────────────────────────────────────
  function formatRelativeDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString())
      return `aujourd'hui ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    return d.toLocaleDateString('fr-FR');
  }

  // ── Avatar initials ──────────────────────────────────────────
  const AVATAR_COLORS = [
    ['#1e3a5f','#3b82f6'], ['#1a3320','#10b981'], ['#3b1a4e','#a855f7'],
    ['#3b2a00','#f59e0b'], ['#2d1a3b','#ec4899'], ['#0f2d3b','#06b6d4'],
    ['#3b1a1a','#ef4444'], ['#1a2d3b','#6366f1'],
  ];
  function avatarFor(label) {
    const letter = String(label || '?')[0].toUpperCase();
    const idx = (letter.charCodeAt(0) || 0) % AVATAR_COLORS.length;
    const [bg, color] = AVATAR_COLORS[idx];
    return { letter, bg, color };
  }
  function renderAvatar(label, icon) {
    const { letter, bg, color } = avatarFor(label);
    if (icon) return `<div class="item-avatar" style="background:${bg};color:${color}"><i class="fas ${icon}"></i></div>`;
    return `<div class="item-avatar" style="background:${bg};color:${color}">${letter}</div>`;
  }

  // ── Clipboard ────────────────────────────────────────────────
  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i>';
        btn.style.color = '#10b981';
        setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 1200);
      }
      return true;
    } catch { return false; }
  }

  // ── Init ─────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    wireTitlebar();
    wireActivityPing();
    wireGlobalShortcuts();
    const host = document.querySelector('[data-sidebar]');
    if (host) renderSidebar(host.dataset.active || '');
    labelIconButtons(document);
    try {
      new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) labelIconButtons(n); })
        .observe(document.body, { childList: true, subtree: true });
    } catch {}
  });

  // ── Sauvegarde : date de la dernière sauvegarde (non sensible) ──
  const BACKUP_KEY = 'passory.lastBackupAt';
  function getLastBackup() { try { return Number(localStorage.getItem(BACKUP_KEY)) || 0; } catch { return 0; } }
  function setLastBackup(ts) { try { if (ts) localStorage.setItem(BACKUP_KEY, String(ts)); else localStorage.removeItem(BACKUP_KEY); } catch {} }

  window.Passory = {
    goto, requireUnlockedOrRedirect, lockAndGoLogin,
    toast, escapeHtml, renderSidebar,
    formatCardNumber, maskCardNumber, detectCardNetwork, cardCssClass,
    formatIban, maskIban, validateIban,
    formatRelativeDate,
    passwordStrength, renderStrengthBar,
    avatarFor, renderAvatar, copyToClipboard,
    confirm: confirmDialog, friendlyError, copiedToast, applySearchFromUrl,
    renderEmpty, setCount, confirmDelete,
    getLastBackup, setLastBackup,
  };
})();
