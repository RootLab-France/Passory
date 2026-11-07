(function () {
  'use strict';

  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  const search = document.getElementById('search');
  const addBtn = document.getElementById('add-btn');

  // Modal
  const modal = document.getElementById('modal');
  const modalClose = document.getElementById('modal-close');
  const modalCancel = document.getElementById('modal-cancel');
  const modalForm = document.getElementById('modal-form');
  const modalLoader = document.getElementById('modal-loader');
  const modalTitle = document.getElementById('modal-title');
  const fId = document.getElementById('m-id');
  const fLabel = document.getElementById('m-label');
  const fUrl = document.getElementById('m-url');
  const fUsername = document.getElementById('m-username');
  const fPassword = document.getElementById('m-password');
  const fNotes = document.getElementById('m-notes');
  const fTotp = document.getElementById('m-totp');
  const fTotpHint = document.getElementById('m-totp-hint');
  const fToggle = document.getElementById('m-toggle');
  const fGenerate = document.getElementById('m-generate');
  const saveBtn = document.getElementById('modal-save');
  let saving = false;

  const MASK = '••••••••';
  const TOTP_PERIOD = 30;

  // La liste reçue est expurgée : aucun mot de passe ni secret TOTP en mémoire
  // de page. Révélation à la demande, ligne par ligne, via items.get(id).
  let entries = [];
  const revealed = new Map();   // id -> mot de passe révélé (effacé au masquage / rechargement)
  const totpCache = new Map();  // id -> { key, code } (un appel items.totp par période)
  const totpPending = new Set();
  let totpTimer = null;
  let editBase = null;          // payload complet obtenu par get() pour l'édition

  (async () => {
    const ok = await window.Passory.requireUnlockedOrRedirect();
    if (!ok) return;
    // Le réglage « masquer les mots de passe » n'entraîne plus de révélation
    // globale : le masque est toujours affiché, la révélation se fait par ligne.
    window.Passory.applySearchFromUrl(search);
    await reload();
  })();

  async function reload() {
    try {
      const res = await window.passory.items.list('password');
      if (!res.success) {
        if (res.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return; }
        window.Passory.toast(window.Passory.friendlyError(res, 'Impossible d\'afficher vos mots de passe. Verrouillez puis rouvrez le coffre.'), 'error');
        return;
      }
      revealed.clear();
      totpCache.clear();
      entries = res.entries.map((e) => {
        const p = e.payload || {};
        const has = p._has || {};
        return {
          id: e.id,
          label: e.payload ? p.label || '' : '[Erreur déchiffrement]',
          username: p.username || '',
          url: p.url || '',
          notes: p.notes || '',
          hasPassword: !!has.password,
          hasTotp: !!has.totpSecret,
          corrupt: !!e.corrupt,
        };
      });
      render();
      scheduleTotpRefresh();
    } catch (err) {
      window.Passory.toast('Impossible d\'afficher vos mots de passe. Verrouillez puis rouvrez le coffre.', 'error');
    }
  }

  window._reloadPasswords = reload;

  function render() {
    const q = search.value.trim().toLowerCase();
    const sortSelect = document.getElementById('sort-select');
    const sortValue = sortSelect ? sortSelect.value : '';

    let filtered = q
      ? entries.filter((e) =>
          (e.label || '').toLowerCase().includes(q) ||
          (e.username || '').toLowerCase().includes(q) ||
          (e.url || '').toLowerCase().includes(q))
      : entries.slice();

    if (sortValue === 'alpha') {
      filtered = filtered.slice().sort((a, b) =>
        (a.label || '').localeCompare(b.label || ''));
    }

    const countLabel = document.getElementById('count-label');
    if (countLabel) countLabel.textContent = entries.length + ' mot' + (entries.length > 1 ? 's de passe' : ' de passe');

    list.innerHTML = '';
    if (filtered.length === 0) {
      const t = document.getElementById('empty-title'), sub = document.getElementById('empty-sub');
      if (entries.length === 0) {
        t.textContent = 'Aucun mot de passe pour l\'instant';
        sub.textContent = 'Cliquez sur « Ajouter » (ou Ctrl+N) pour enregistrer votre premier mot de passe.';
      } else {
        t.textContent = 'Aucun résultat';
        sub.textContent = 'Aucun mot de passe ne correspond à « ' + search.value.trim() + ' ». Vérifiez l\'orthographe ou effacez la recherche.';
      }
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    const esc = window.Passory.escapeHtml;
    for (const e of filtered) {
      const row = document.createElement('div');
      row.className = 'item-row';
      row.dataset.id = e.id;
      const isRevealed = revealed.has(e.id);
      const pwDisplay = isRevealed ? esc(revealed.get(e.id)) : (e.hasPassword ? MASK : '');
      const hostname = e.url ? hostFromUrl(e.url) : '';
      const hasTotp = e.hasTotp;
      row.innerHTML = `
        ${window.Passory.renderAvatar(e.label)}
        <div class="item-info">
          <div class="item-label">
            ${esc(e.label)}
            ${hasTotp ? '<span class="badge badge-purple badge-2fa ml-1" title="Double authentification configurée"><i class="fas fa-shield-halved mr-1" aria-hidden="true"></i>2FA</span>' : ''}
          </div>
          <div class="item-sub">${e.username ? esc(e.username) : ''}${e.username && hostname ? ' &middot; ' : ''}${hostname ? esc(hostname) : ''}</div>
          ${e.hasPassword ? `<div class="item-sub" style="font-family:monospace;cursor:pointer" data-password title="Cliquer pour afficher ou masquer">${pwDisplay}</div>` : '<div class="item-sub" style="font-style:italic">Aucun mot de passe enregistré</div>'}
          ${hasTotp ? `
            <div class="flex items-center gap-2 mt-1" data-totp>
              <span class="text-purple-400 font-mono text-base tracking-widest" data-code>••• •••</span>
              <div class="w-16 h-1 bg-gray-700 rounded overflow-hidden"><div class="h-full bg-purple-500 transition-all" data-bar style="width:100%"></div></div>
              <span class="text-xs" style="color:var(--text-muted)" data-countdown title="Secondes avant le prochain code">30s</span>
            </div>
          ` : ''}
        </div>
        <div class="item-actions">
          <button data-action="toggle" title="${isRevealed ? 'Masquer' : 'Afficher'} le mot de passe" class="item-action-btn" ${e.hasPassword ? '' : 'disabled'}><i class="fas ${isRevealed ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i></button>
          <button data-action="copy-user" title="Copier l'identifiant" class="item-action-btn" ${e.username ? '' : 'disabled'}><i class="fas fa-user" aria-hidden="true"></i></button>
          <button data-action="copy-pass" title="Copier le mot de passe" class="item-action-btn" style="color:#93c5fd" ${e.hasPassword ? '' : 'disabled'}><i class="fas fa-copy" aria-hidden="true"></i></button>
          ${hasTotp ? '<button data-action="copy-totp" title="Copier le code de double authentification" class="item-action-btn" style="color:#d8b4fe"><i class="fas fa-shield-halved" aria-hidden="true"></i></button>' : ''}
          <button data-action="edit" title="Modifier" class="item-action-btn"><i class="fas fa-pen" aria-hidden="true"></i></button>
          <button data-action="delete" title="Supprimer" class="item-action-btn danger"><i class="fas fa-trash" aria-hidden="true"></i></button>
        </div>
      `;
      list.appendChild(row);
    }
    refreshVisibleTotps();
  }

  function hostFromUrl(u) {
    try {
      const s = u.startsWith('http') ? u : 'https://' + u;
      return new URL(s).hostname;
    } catch { return ''; }
  }

  // --- Codes TOTP ------------------------------------------------
  // Le secret reste côté cœur : items.totp(id) renvoie le code courant.
  // Un seul appel par élément visible et par période de 30 s ; le compte à
  // rebours est calculé localement chaque seconde.
  function currentKey() { return Math.floor(Date.now() / 1000 / TOTP_PERIOD); }
  function localRemaining() { return TOTP_PERIOD - (Math.floor(Date.now() / 1000) % TOTP_PERIOD); }

  async function fetchTotp(id) {
    const key = currentKey();
    const cached = totpCache.get(id);
    if (cached && cached.key === key) return cached;
    if (totpPending.has(id)) return null;
    totpPending.add(id);
    try {
      const r = await window.passory.items.totp(id);
      let entry;
      if (r && r.success) {
        // Période déduite de la réponse (robuste à la latence au changement de période)
        const k = Math.round((Date.now() / 1000 + Number(r.remaining || 0) - TOTP_PERIOD) / TOTP_PERIOD);
        entry = { key: k, code: String(r.code || '') };
      } else {
        if (r && r.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return null; }
        entry = { key, code: '', error: (r && r.error) || 'Erreur TOTP' };
      }
      totpCache.set(id, entry);
      return entry;
    } catch (err) {
      const entry = { key, code: '', error: err.message };
      totpCache.set(id, entry);
      return entry;
    } finally {
      totpPending.delete(id);
    }
  }

  function paintTotp(block, entry) {
    const codeEl = block.querySelector('[data-code]');
    const cdEl   = block.querySelector('[data-countdown]');
    const barEl  = block.querySelector('[data-bar]');
    const remaining = localRemaining();
    const valid = entry && entry.key === currentKey() && entry.code;
    if (codeEl) {
      codeEl.textContent = valid ? entry.code.replace(/(.{3})/, '$1 ') : (entry && entry.error ? '??? ???' : '••• •••');
      codeEl.classList.toggle('text-red-400', remaining <= 5);
      codeEl.classList.toggle('text-purple-400', remaining > 5);
    }
    if (cdEl) cdEl.textContent = remaining + 's';
    if (barEl) barEl.style.width = Math.round((remaining / TOTP_PERIOD) * 100) + '%';
  }

  function refreshVisibleTotps() {
    const key = currentKey();
    const blocks = list.querySelectorAll('[data-totp]');
    for (const block of blocks) {
      const rowEl = block.closest('[data-id]');
      if (!rowEl) continue;
      const id = rowEl.dataset.id;
      const cached = totpCache.get(id);
      paintTotp(block, cached);
      if (!cached || cached.key !== key) {
        fetchTotp(id).then((entry) => {
          if (!entry) return;
          const b = list.querySelector(`[data-id="${CSS.escape(id)}"] [data-totp]`);
          if (b) paintTotp(b, entry);
        });
      }
    }
  }
  function scheduleTotpRefresh() {
    if (totpTimer) return;
    totpTimer = setInterval(refreshVisibleTotps, 1000);
    refreshVisibleTotps();
  }

  // --- Révélation ligne par ligne ----------------------------------
  async function toggleReveal(id) {
    if (revealed.has(id)) {
      revealed.delete(id);
      render();
      return;
    }
    const r = await window.passory.items.get(id);
    if (!r || !r.success) {
      if (r && r.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return; }
      window.Passory.toast(window.Passory.friendlyError(r, 'Impossible d\'afficher ce mot de passe.'), 'error');
      return;
    }
    revealed.set(id, (r.entry && r.entry.payload && r.entry.payload.password) || '');
    render();
  }

  search.addEventListener('input', render);

  list.addEventListener('click', async (ev) => {
    const pwZone = ev.target.closest('[data-password]');
    const btn = ev.target.closest('button[data-action]');
    const rowEl = ev.target.closest('.item-row');
    if (!btn && !pwZone && !rowEl) return;
    const row = (btn || pwZone || rowEl).closest('[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    // Clic sur la ligne (hors boutons) : ouvre la fiche en modification
    const action = btn ? btn.dataset.action : (pwZone ? 'toggle' : 'edit');
    if (btn && btn.disabled) return;

    if (action === 'toggle') {
      if (!entry.hasPassword) return;
      await toggleReveal(id);
    } else if (action === 'copy-user') {
      const res = await window.passory.items.copy(entry.username || '');
      if (res.success) window.Passory.copiedToast('Identifiant', res);
      else window.Passory.toast(window.Passory.friendlyError(res, 'La copie a échoué. Réessayez.'), 'error');
    } else if (action === 'copy-pass') {
      const res = await window.passory.items.copyField(id, 'password');
      if (res.success) window.Passory.copiedToast('Mot de passe', res);
      else window.Passory.toast(window.Passory.friendlyError(res, 'La copie a échoué. Réessayez.'), 'error');
    } else if (action === 'copy-totp') {
      if (!entry.hasTotp) { window.Passory.toast('Aucune double authentification configurée pour cet élément.', 'warn'); return; }
      try {
        let t = totpCache.get(id);
        if (!t || t.key !== currentKey() || !t.code) {
          totpCache.delete(id);
          t = await fetchTotp(id);
        }
        if (!t || !t.code) { window.Passory.toast('Impossible de calculer le code : la clé de double authentification semble incorrecte. Modifiez l\'élément pour la corriger.', 'error'); return; }
        const res = await window.passory.items.copy(t.code);
        if (res.success) window.Passory.copiedToast('Code ' + t.code, res);
      } catch (err) {
        window.Passory.toast('Impossible de calculer le code de double authentification. Réessayez.', 'error');
      }
    } else if (action === 'edit') {
      const r = await window.passory.items.get(id);
      if (!r || !r.success) {
        if (r && r.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return; }
        window.Passory.toast(window.Passory.friendlyError(r, 'Impossible d\'ouvrir cet élément.'), 'error');
        return;
      }
      openModal(r.entry);
    } else if (action === 'delete') {
      const go = await window.Passory.confirm({
        title: 'Supprimer ce mot de passe ?',
        message: `« ${entry.label} » sera supprimé définitivement de votre coffre. Cette action ne peut pas être annulée.`,
        confirmLabel: 'Supprimer', danger: true,
      });
      if (!go) return;
      const res = await window.passory.items.delete(id);
      if (res.success) { window.Passory.toast(`« ${entry.label} » a été supprimé.`, 'success'); await reload(); }
      else { window.Passory.toast(window.Passory.friendlyError(res, 'La suppression a échoué. Réessayez.'), 'error'); await reload(); }
    }
  });

  addBtn.addEventListener('click', () => openModal(null));
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  function setPwVisible(show) {
    fPassword.type = show ? 'text' : 'password';
    const icon = fToggle.querySelector('i');
    icon.classList.toggle('fa-eye', !show);
    icon.classList.toggle('fa-eye-slash', show);
    const l = show ? 'Masquer le mot de passe' : 'Afficher le mot de passe';
    fToggle.title = l; fToggle.setAttribute('aria-label', l);
  }
  fToggle.addEventListener('click', () => setPwVisible(fPassword.type === 'password'));

  fGenerate.addEventListener('click', async () => {
    const res = await window.passory.generator.make();
    if (res && res.success) {
      fPassword.value = res.password;
      setPwVisible(true);
      fPassword.dispatchEvent(new Event('input'));
      window.Passory.toast('Mot de passe solide généré. Réglages du générateur : Paramètres.', 'success');
    } else {
      window.Passory.toast('La génération a échoué. Vérifiez les réglages du générateur dans Paramètres.', 'error');
    }
  });

  /** full : entrée complète renvoyée par items.get(id) (jamais la version expurgée). */
  function openModal(full) {
    modalForm.reset();
    editBase = null;
    if (full) {
      const p = full.payload || {};
      editBase = p;
      modalTitle.textContent = 'Modifier le mot de passe';
      fId.value = full.id;
      fLabel.value = p.label || '';
      fUrl.value = p.url || '';
      fUsername.value = p.username || '';
      fPassword.value = p.password || '';
      fNotes.value = p.notes || '';
      fTotp.value = p.totpSecret || '';
    } else {
      modalTitle.textContent = 'Ajouter un mot de passe';
      fId.value = '';
      fTotp.value = '';
    }
    updateTotpHint();
    setPwVisible(false);
    window.Passory.renderStrengthBar(fPassword, 'strength-wrap');
    modal.classList.remove('hidden'); modal.classList.add('flex');
    setTimeout(() => fLabel.focus(), 50);
  }

  // Feedback live sur la validité de la clé TOTP saisie
  function updateTotpHint() {
    if (!fTotp || !fTotpHint) return;
    const v = fTotp.value.trim();
    if (!v) {
      fTotpHint.textContent = 'Si le site propose la « validation en deux étapes », collez ici la clé qu\'il affiche (ou le lien otpauth://). Passory affichera alors le code à 6 chiffres.';
      fTotpHint.className = 'form-hint';
      return;
    }
    const t = window.Passory && window.Passory.totp;
    if (!t) return;
    let secret = v;
    let issuer = '';
    if (v.startsWith('otpauth://')) {
      const parsed = t.parseOtpAuthUri(v);
      if (!parsed) {
        fTotpHint.textContent = 'Ce lien otpauth:// est incomplet : copiez-le à nouveau depuis le site.';
        fTotpHint.className = 'form-hint text-red-300';
        return;
      }
      secret = parsed.secret;
      issuer = parsed.issuer;
    }
    if (!t.isValidBase32(secret)) {
      fTotpHint.textContent = 'Cette clé ne semble pas valide : elle ne contient normalement que des lettres (A à Z) et des chiffres de 2 à 7.';
      fTotpHint.className = 'form-hint text-red-300';
      return;
    }
    t.generate(secret).then((code) => {
      if (code) {
        fTotpHint.textContent = `Clé valide. Code actuel : ${code}${issuer ? ' (' + issuer + ')' : ''}`;
        fTotpHint.className = 'form-hint text-emerald-400';
      }
    }).catch(() => {});
  }
  if (fTotp) fTotp.addEventListener('input', updateTotpHint);

  function closeModal() {
    modal.classList.add('hidden'); modal.classList.remove('flex');
    modalForm.reset(); fId.value = '';
    editBase = null;
    modalLoader.classList.add('hidden');
  }

  // Champs du payload complet hors formulaire : conservés tels quels
  // (les clés internes _has / _hint ne sont jamais renvoyées).
  function baseFields(p) {
    const out = {};
    for (const k of Object.keys(p || {})) if (!k.startsWith('_')) out[k] = p[k];
    return out;
  }

  modalForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Normalise la clé TOTP : accepte Base32 brut ou URI otpauth://
    let totpSecret = '';
    const totpRaw = fTotp.value.trim();
    if (totpRaw) {
      const t = window.Passory && window.Passory.totp;
      if (totpRaw.startsWith('otpauth://')) {
        const parsed = t && t.parseOtpAuthUri(totpRaw);
        if (!parsed) { window.Passory.toast('Le lien de double authentification est incomplet : copiez-le à nouveau depuis le site.', 'warn'); fTotp.focus(); return; }
        totpSecret = parsed.secret;
      } else if (t && t.isValidBase32(totpRaw)) {
        totpSecret = t.normalizeBase32(totpRaw);
      } else {
        window.Passory.toast('La clé de double authentification n\'est pas valide. Vérifiez-la ou laissez le champ vide.', 'warn');
        fTotp.focus();
        return;
      }
    }

    // En édition, fId n'est rempli qu'après un get() réussi : le formulaire part
    // donc du payload complet et ne renvoie jamais un champ expurgé (vide).
    if (fId.value && !editBase) { window.Passory.toast('Cet élément n\'a pas pu être chargé. Fermez la fenêtre et rouvrez-le.', 'error'); return; }
    const payload = Object.assign(baseFields(fId.value ? editBase : null), {
      label: fLabel.value.trim(),
      url: fUrl.value.trim(),
      username: fUsername.value.trim(),
      password: fPassword.value,
      notes: fNotes.value.trim(),
      totpSecret,
    });
    if (!payload.label) { window.Passory.toast('Donnez un nom à ce mot de passe (par exemple le nom du site).', 'warn'); fLabel.focus(); return; }

    if (saving) return;
    saving = true;
    saveBtn.disabled = true;
    modalLoader.classList.remove('hidden');
    try {
      let res;
      if (fId.value) res = await window.passory.items.update(fId.value, payload);
      else           res = await window.passory.items.add('password', payload);

      if (res.success) {
        window.Passory.toast(fId.value ? `« ${payload.label} » a été modifié.` : `« ${payload.label} » a été ajouté.`, 'success');
        closeModal();
        await reload();
      } else {
        if (res.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return; }
        window.Passory.toast(window.Passory.friendlyError(res, 'L\'enregistrement a échoué.'), 'error');
      }
    } catch (err) {
      window.Passory.toast('L\'enregistrement a échoué. Réessayez.', 'error');
    } finally {
      saving = false;
      saveBtn.disabled = false;
      modalLoader.classList.add('hidden');
    }
  });
})();
