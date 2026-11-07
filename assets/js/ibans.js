(function () {
  'use strict';

  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  const search = document.getElementById('search');
  const addBtn = document.getElementById('add-btn');

  const modal = document.getElementById('modal');
  const modalClose = document.getElementById('modal-close');
  const modalCancel = document.getElementById('modal-cancel');
  const modalForm = document.getElementById('modal-form');
  const modalLoader = document.getElementById('modal-loader');
  const modalTitle = document.getElementById('modal-title');
  const fId     = document.getElementById('m-id');
  const fLabel  = document.getElementById('m-label');
  const fBank   = document.getElementById('m-bank');
  const fHolder = document.getElementById('m-holder');
  const fIban   = document.getElementById('m-iban');
  const fBic    = document.getElementById('m-bic');
  const fNotes  = document.getElementById('m-notes');
  const ibanFb  = document.getElementById('iban-feedback');

  // La liste reçue est expurgée (iban vide ; _has / _hint).
  let entries = [];
  // Comptes révélés à la demande : id -> IBAN complet obtenu par items.get(id)
  const revealed = new Map();
  const saveBtn = document.getElementById('modal-save');
  let saving = false;
  let editBase = null; // payload complet de l'élément en cours d'édition

  (async () => {
    const ok = await window.Passory.requireUnlockedOrRedirect();
    if (!ok) return;
    window.Passory.applySearchFromUrl(search);
    // Le réglage « masquer les données sensibles » ne déclenche plus de
    // révélation globale : le masque reste, la révélation se fait par ligne.
    await reload();
  })();

  async function getFull(id) {
    const r = await window.passory.items.get(id);
    if (!r || !r.success) {
      if (r && r.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return null; }
      window.Passory.toast(window.Passory.friendlyError(r, 'Impossible d\'ouvrir cet élément.'), 'error');
      return null;
    }
    return r.entry;
  }

  // IBAN masqué à partir des 4 derniers caractères (_hint.iban).
  function maskedFromHint(e) {
    if (!e._has.iban) return '';
    const hint = String(e._hint.iban || '').replace(/\s+/g, '').toUpperCase();
    return '•••• •••• •••• ' + (hint || '••••');
  }

  async function reload() {
    try {
      const res = await window.passory.items.list('iban');
      if (!res.success) {
        if (res.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return; }
        window.Passory.toast(window.Passory.friendlyError(res, 'Impossible d\'afficher la liste. Verrouillez puis rouvrez le coffre.'), 'error');
        return;
      }
      revealed.clear();
      entries = res.entries.filter((e) => !e.corrupt).map((e) => {
        const p = e.payload || {};
        return {
          id: e.id,
          label: p.label || '', bank: p.bank || '', holder: p.holder || '',
          bic: p.bic || '', notes: p.notes || '',
          _has: p._has || {}, _hint: p._hint || {},
        };
      });
      render();
    } catch (err) {
      window.Passory.toast('L\'opération a échoué. Réessayez ; si le problème persiste, redémarrez Passory.', 'error');
    }
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const filtered = q
      ? entries.filter((e) =>
          [e.label, e.bank, e.holder, e._hint.iban].some((v) => (v || '').toLowerCase().includes(q)))
      : entries;

    list.innerHTML = '';
    if (filtered.length === 0) {
      window.Passory.renderEmpty(empty, entries.length === 0
        ? { icon: 'fa-building-columns', title: 'Aucun compte pour l\'instant', sub: 'Cliquez sur « Ajouter » pour enregistrer un IBAN (RIB).' }
        : { query: search.value.trim() });
      empty.classList.remove('hidden');
      window.Passory.setCount(document.getElementById('count-label'), entries.length, 'compte', 'comptes');
      return;
    }
    empty.classList.add('hidden');
    window.Passory.setCount(document.getElementById('count-label'), entries.length, 'compte', 'comptes');

    const esc = window.Passory.escapeHtml;
    for (const e of filtered) {
      const isRevealed = revealed.has(e.id);
      const ibanDisplay = isRevealed
        ? window.Passory.formatIban(revealed.get(e.id))
        : maskedFromHint(e);
      const row = document.createElement('div');
      row.dataset.id = e.id;
      row.className = 'item-row';
      row.innerHTML = `
        ${window.Passory.renderAvatar(e.label, 'fa-building-columns')}
        <div class="item-info">
          <div class="item-label">${esc(e.label||'')}</div>
          <div class="item-sub">${[e.holder, e.bank].filter(Boolean).map(esc).join(' · ')}</div>
          <div class="item-sub" style="font-family:monospace;letter-spacing:0.05em" data-field="iban">${esc(ibanDisplay)}</div>
          ${e.bic ? `<div class="item-sub">BIC : ${esc(e.bic)}</div>` : ''}
        </div>
        <div class="item-actions">
          <button data-action="toggle" class="item-action-btn" title="${isRevealed?'Masquer':'Afficher'} l'IBAN" ${e._has.iban?'':'disabled'}><i class="fas ${isRevealed?'fa-eye-slash':'fa-eye'}" aria-hidden="true"></i></button>
          <button data-action="copy-iban" class="item-action-btn" style="color:#93c5fd" title="Copier l'IBAN" ${e._has.iban?'':'disabled'}><i class="fas fa-copy" aria-hidden="true"></i></button>
          <button data-action="copy-bic" class="item-action-btn" title="Copier le BIC" ${e.bic?'':'disabled'}><i class="fas fa-hashtag" aria-hidden="true"></i></button>
          <button data-action="edit" class="item-action-btn" title="Modifier"><i class="fas fa-pen" aria-hidden="true"></i></button>
          <button data-action="delete" class="item-action-btn danger" title="Supprimer"><i class="fas fa-trash" aria-hidden="true"></i></button>
        </div>
      `;
      list.appendChild(row);
    }
  }

  search.addEventListener('input', render);

  list.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    const action = btn.dataset.action;

    if (action === 'toggle') {
      if (revealed.has(id)) { revealed.delete(id); render(); return; }
      const full = await getFull(id);
      if (!full) return;
      revealed.set(id, (full.payload && full.payload.iban) || '');
      render();
    } else if (action === 'copy-iban') {
      const r = await window.passory.items.copyField(id, 'iban');
      if (r.success) window.Passory.copiedToast('IBAN', r);
      else window.Passory.toast(window.Passory.friendlyError(r, 'L\'opération a échoué. Réessayez.'), 'error');
    } else if (action === 'copy-bic') {
      const r = await window.passory.items.copyField(id, 'bic');
      if (r.success) window.Passory.copiedToast('BIC', r);
      else window.Passory.toast(window.Passory.friendlyError(r, 'L\'opération a échoué. Réessayez.'), 'error');
    } else if (action === 'edit') {
      const full = await getFull(id);
      if (full) openModal(full);
    } else if (action === 'delete') {
      if (!(await window.Passory.confirmDelete('ce compte', entry.label))) return;
      const r = await window.passory.items.delete(id);
      if (r.success) { window.Passory.toast(`« ${entry.label} » a été supprimé.`, 'success'); await reload(); }
      else window.Passory.toast(window.Passory.friendlyError(r, 'L\'opération a échoué. Réessayez.'), 'error');
    }
  });

  // Formatage live de l'IBAN + validation mod-97
  fIban.addEventListener('input', () => {
    const raw = fIban.value.replace(/\s+/g, '').toUpperCase();
    fIban.value = raw.replace(/(.{4})/g, '$1 ').trim();
    if (!raw) { ibanFb.textContent = ''; ibanFb.className = 'text-xs mt-1 text-gray-400'; return; }
    if (window.Passory.validateIban(raw)) {
      ibanFb.textContent = '✓ IBAN valide';
      ibanFb.className = 'text-xs mt-1 text-emerald-400';
    } else {
      ibanFb.textContent = 'Cet IBAN semble incorrect : vérifiez chaque caractère.';
      ibanFb.className = 'text-xs mt-1 text-yellow-400';
    }
  });
  fBic.addEventListener('input', () => { fBic.value = fBic.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11); });

  addBtn.addEventListener('click', () => openModal(null));
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  /** full : entrée complète renvoyée par items.get(id) (jamais la version expurgée). */
  function openModal(full) {
    modalForm.reset();
    ibanFb.textContent = '';
    editBase = null;
    if (full) {
      const entry = full.payload || {};
      editBase = entry;
      modalTitle.textContent = 'Modifier le compte';
      fId.value = full.id;
      fLabel.value = entry.label || '';
      fBank.value = entry.bank || '';
      fHolder.value = entry.holder || '';
      fIban.value = window.Passory.formatIban(entry.iban || '');
      fBic.value = entry.bic || '';
      fNotes.value = entry.notes || '';
      fIban.dispatchEvent(new Event('input'));
    } else {
      modalTitle.textContent = 'Ajouter un compte';
      fId.value = '';
    }
    modal.classList.remove('hidden'); modal.classList.add('flex');
    setTimeout(() => fLabel.focus(), 50);
  }

  function closeModal() {
    modal.classList.add('hidden'); modal.classList.remove('flex');
    modalForm.reset(); fId.value = ''; ibanFb.textContent = '';
    editBase = null;
    modalLoader.classList.add('hidden');
  }

  // Champs du payload complet hors formulaire : conservés (jamais _has / _hint).
  function baseFields(p) {
    const out = {};
    for (const k of Object.keys(p || {})) if (!k.startsWith('_')) out[k] = p[k];
    return out;
  }

  modalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const iban = fIban.value.replace(/\s+/g, '').toUpperCase();
    if (iban && !window.Passory.validateIban(iban)) {
      const go = await window.Passory.confirm({
        title: 'IBAN peut-être incorrect',
        message: 'L\'IBAN saisi ne passe pas le contrôle de validité : il manque peut-être un caractère ou une lettre a été mal recopiée.\n\nL\'enregistrer quand même ?',
        confirmLabel: 'Enregistrer quand même', cancelLabel: 'Corriger',
      });
      if (!go) { fIban.focus(); return; }
    }
    // En édition, le formulaire part du payload complet (get) : aucun champ
    // expurgé (vide) ne peut écraser la vraie valeur.
    if (fId.value && !editBase) { window.Passory.toast('Cet élément n\'a pas pu être chargé. Fermez la fenêtre et rouvrez-le.', 'error'); return; }
    const payload = Object.assign(baseFields(fId.value ? editBase : null), {
      label:  fLabel.value.trim(),
      bank:   fBank.value.trim(),
      holder: fHolder.value.trim(),
      iban,
      bic:    fBic.value.trim().toUpperCase(),
      notes:  fNotes.value.trim(),
    });
    if (!payload.label) { window.Passory.toast('Donnez un nom à cet élément (champ « Nom »).', 'warn'); fLabel.focus(); return; }

    if (saving) return;
    saving = true; saveBtn.disabled = true;

    modalLoader.classList.remove('hidden');
    try {
      let res;
      if (fId.value) res = await window.passory.items.update(fId.value, payload);
      else           res = await window.passory.items.add('iban', payload);
      if (res.success) {
        window.Passory.toast(fId.value ? `« ${payload.label} » a été modifié.` : `« ${payload.label} » a été ajouté.`, 'success');
        closeModal(); await reload();
      } else {
        if (res.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return; }
        window.Passory.toast(window.Passory.friendlyError(res, 'L\'opération a échoué. Réessayez.'), 'error');
      }
    } catch (err) {
      window.Passory.toast('L\'opération a échoué. Réessayez ; si le problème persiste, redémarrez Passory.', 'error');
    } finally {
      saving = false; saveBtn.disabled = false;
      modalLoader.classList.add('hidden');
    }
  });
})();
