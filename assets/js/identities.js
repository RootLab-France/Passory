(function () {
  'use strict';

  const DOC_TYPE_LABELS = {
    '': '—',
    id_card: 'Carte d\'identité',
    passport: 'Passeport',
    driver_license: 'Permis de conduire',
    residence: 'Titre de séjour',
    health_card: 'Carte vitale',
    ssn: 'N° sécurité sociale',
    tax_id: 'N° fiscal',
    other: 'Autre',
  };

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

  const fId         = document.getElementById('m-id');
  const fLabel      = document.getElementById('m-label');
  const fDocType    = document.getElementById('m-docType');
  const fCountry    = document.getElementById('m-country');
  const fFullName   = document.getElementById('m-fullName');
  const fBirthDate  = document.getElementById('m-birthDate');
  const fBirthPlace = document.getElementById('m-birthPlace');
  const fDocNumber  = document.getElementById('m-docNumber');
  const fExpiry     = document.getElementById('m-expiry');
  const fPhone      = document.getElementById('m-phone');
  const fEmail      = document.getElementById('m-email');
  const fAddress    = document.getElementById('m-address');
  const fNotes      = document.getElementById('m-notes');

  // La liste reçue est expurgée (docNumber vide ; _has / _hint).
  let entries = [];
  // Identités révélées à la demande : id -> numéro complet obtenu par items.get(id)
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

  async function reload() {
    try {
      const res = await window.passory.items.list('identity');
      if (!res.success) {
        if (res.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return; }
        window.Passory.toast(window.Passory.friendlyError(res, 'L\'opération a échoué. Réessayez.'), 'error');
        return;
      }
      revealed.clear();
      entries = res.entries.filter((e) => !e.corrupt).map((e) => {
        const p = Object.assign({}, e.payload || {});
        const has = p._has || {}, hint = p._hint || {};
        delete p._has; delete p._hint; delete p.docNumber;
        return Object.assign(p, { id: e.id, _has: has, _hint: hint });
      });
      render();
    } catch (err) {
      window.Passory.toast('L\'opération a échoué. Réessayez ; si le problème persiste, redémarrez Passory.', 'error');
    }
  }

  // Numéro masqué à partir des 3 derniers caractères (_hint.docNumber).
  function maskedFromHint(e) {
    if (!e._has.docNumber) return '';
    return '••••••' + String(e._hint.docNumber || '•••');
  }

  function isExpiringSoon(expiryStr) {
    if (!expiryStr) return false;
    const d = new Date(expiryStr);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    const diffDays = (d - now) / (1000 * 60 * 60 * 24);
    return diffDays >= 0 && diffDays <= 90;
  }

  function frDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
  }

  function isExpired(expiryStr) {
    if (!expiryStr) return false;
    const d = new Date(expiryStr);
    if (isNaN(d.getTime())) return false;
    return d.getTime() < Date.now();
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const filtered = q
      ? entries.filter((e) => [e.label, e.fullName, e._hint.docNumber, DOC_TYPE_LABELS[e.docType] || '']
          .some((v) => (v || '').toLowerCase().includes(q)))
      : entries;

    list.innerHTML = '';
    if (filtered.length === 0) {
      window.Passory.renderEmpty(empty, entries.length === 0
        ? { icon: 'fa-id-card', title: 'Aucune identité pour l\'instant', sub: 'Cliquez sur « Ajouter » pour enregistrer une carte d\'identité, un passeport, un permis…' }
        : { query: search.value.trim() });
      empty.classList.remove('hidden');
      window.Passory.setCount(document.getElementById('count-label'), entries.length, 'identité', 'identités', 'Aucune identité');
      return;
    }
    empty.classList.add('hidden');
    window.Passory.setCount(document.getElementById('count-label'), entries.length, 'identité', 'identités', 'Aucune identité');

    const esc = window.Passory.escapeHtml;
    for (const e of filtered) {
      const isRevealed = revealed.has(e.id);
      const num = !!e._has.docNumber;
      const numDisplay = isRevealed ? esc(revealed.get(e.id)) : esc(maskedFromHint(e));

      let expiryBadge = '';
      if (e.expiry) {
        if (isExpired(e.expiry)) {
          expiryBadge = `<span class="badge badge-red">Expiré le ${esc(frDate(e.expiry))}</span>`;
        } else if (isExpiringSoon(e.expiry)) {
          expiryBadge = `<span class="badge badge-yellow">Expire bientôt : ${esc(frDate(e.expiry))}</span>`;
        } else {
          expiryBadge = `<span class="text-xs" style="color:var(--text-muted);font-weight:400">Valable jusqu'au ${esc(frDate(e.expiry))}</span>`;
        }
      }

      const row = document.createElement('div');
      row.dataset.id = e.id;
      row.className = 'item-row';
      row.innerHTML = `
        ${window.Passory.renderAvatar(e.label, 'fa-id-card')}
        <div class="item-info">
          <div class="item-label" style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
            <span>${esc(e.label || '')}</span>
            <span class="text-xs" style="color:var(--text-secondary);font-weight:400">${esc(DOC_TYPE_LABELS[e.docType] || 'Document')}${e.country ? ' · ' + esc(e.country) : ''}</span>
            ${expiryBadge}
          </div>
          ${e.fullName ? `<div class="item-sub">${esc(e.fullName)}</div>` : ''}
          ${num ? `<div class="item-sub" style="font-family:monospace" data-field="num">${numDisplay}</div>` : ''}
        </div>
        <div class="item-actions">
          <button data-action="toggle" title="${isRevealed ? 'Masquer' : 'Afficher'} le numéro" class="item-action-btn" ${num ? '' : 'disabled'}><i class="fas ${isRevealed ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i></button>
          <button data-action="copy-num" title="Copier le numéro" class="item-action-btn" style="color:#93c5fd" ${num ? '' : 'disabled'}><i class="fas fa-copy" aria-hidden="true"></i></button>
          <button data-action="edit" title="Modifier" class="item-action-btn"><i class="fas fa-pen" aria-hidden="true"></i></button>
          <button data-action="delete" title="Supprimer" class="item-action-btn danger"><i class="fas fa-trash" aria-hidden="true"></i></button>
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
      revealed.set(id, (full.payload && full.payload.docNumber) || '');
      render();
    } else if (action === 'copy-num') {
      const r = await window.passory.items.copyField(id, 'docNumber');
      if (r.success) window.Passory.copiedToast('Numéro', r);
      else window.Passory.toast(window.Passory.friendlyError(r, 'L\'opération a échoué. Réessayez.'), 'error');
    } else if (action === 'edit') {
      const full = await getFull(id);
      if (full) openModal(full);
    } else if (action === 'delete') {
      if (!(await window.Passory.confirmDelete('cette identité', entry.label))) return;
      const r = await window.passory.items.delete(id);
      if (r.success) { window.Passory.toast(`« ${entry.label} » a été supprimée.`, 'success'); await reload(); }
      else window.Passory.toast(window.Passory.friendlyError(r, 'L\'opération a échoué. Réessayez.'), 'error');
    }
  });

  addBtn.addEventListener('click', () => openModal(null));
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  /** full : entrée complète renvoyée par items.get(id) (jamais la version expurgée). */
  function openModal(full) {
    modalForm.reset();
    editBase = null;
    if (full) {
      const entry = full.payload || {};
      editBase = entry;
      modalTitle.textContent = 'Modifier l\'identité';
      fId.value = full.id;
      fLabel.value = entry.label || '';
      fDocType.value = entry.docType || '';
      fCountry.value = entry.country || '';
      fFullName.value = entry.fullName || '';
      fBirthDate.value = entry.birthDate || '';
      fBirthPlace.value = entry.birthPlace || '';
      fDocNumber.value = entry.docNumber || '';
      fExpiry.value = entry.expiry || '';
      fPhone.value = entry.phone || '';
      fEmail.value = entry.email || '';
      fAddress.value = entry.address || '';
      fNotes.value = entry.notes || '';
    } else {
      modalTitle.textContent = 'Ajouter une identité';
      fId.value = '';
    }
    modal.classList.remove('hidden'); modal.classList.add('flex');
    setTimeout(() => fLabel.focus(), 50);
  }

  function closeModal() {
    modal.classList.add('hidden'); modal.classList.remove('flex');
    modalForm.reset(); fId.value = '';
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
    // En édition, le formulaire part du payload complet (get) : aucun champ
    // expurgé (vide) ne peut écraser la vraie valeur.
    if (fId.value && !editBase) { window.Passory.toast('Cet élément n\'a pas pu être chargé. Fermez la fenêtre et rouvrez-le.', 'error'); return; }
    const payload = Object.assign(baseFields(fId.value ? editBase : null), {
      label:      fLabel.value.trim(),
      docType:    fDocType.value,
      country:    fCountry.value.trim(),
      fullName:   fFullName.value.trim(),
      birthDate:  fBirthDate.value,
      birthPlace: fBirthPlace.value.trim(),
      docNumber:  fDocNumber.value.trim(),
      expiry:     fExpiry.value,
      phone:      fPhone.value.trim(),
      email:      fEmail.value.trim(),
      address:    fAddress.value.trim(),
      notes:      fNotes.value.trim(),
    });
    if (!payload.label) { window.Passory.toast('Donnez un nom à cet élément (champ « Nom »).', 'warn'); fLabel.focus(); return; }

    if (saving) return;
    saving = true; saveBtn.disabled = true;

    modalLoader.classList.remove('hidden');
    try {
      let res;
      if (fId.value) res = await window.passory.items.update(fId.value, payload);
      else           res = await window.passory.items.add('identity', payload);
      if (res.success) {
        window.Passory.toast(fId.value ? `« ${payload.label} » a été modifiée.` : `« ${payload.label} » a été ajoutée.`, 'success');
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
