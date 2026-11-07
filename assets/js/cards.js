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
  const fId      = document.getElementById('m-id');
  const fLabel   = document.getElementById('m-label');
  const fHolder  = document.getElementById('m-holder');
  const fNumber  = document.getElementById('m-number');
  const fExpiry  = document.getElementById('m-expiry');
  const fCvv     = document.getElementById('m-cvv');
  const fPin     = document.getElementById('m-pin');
  const fBank    = document.getElementById('m-bank');
  const fNotes   = document.getElementById('m-notes');
  const networkTag = document.getElementById('m-network');

  // La liste reçue est expurgée (numéro, CVV, PIN vides ; _has / _hint).
  let entries = [];
  // Cartes révélées à la demande : id -> payload complet obtenu par items.get(id)
  const revealed = new Map();
  const saveBtn = document.getElementById('modal-save');
  let saving = false;
  let editBase = null; // payload complet de l'élément en cours d'édition

  (async () => {
    const ok = await window.Passory.requireUnlockedOrRedirect();
    if (!ok) return;
    window.Passory.applySearchFromUrl(search);
    // Le réglage « masquer les données sensibles » ne déclenche plus de
    // révélation globale : le masque reste, la révélation se fait par carte.
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

  // Numéro masqué à partir des 4 derniers chiffres (helper commun de masquage).
  function maskedFromHint(e) {
    if (!e._has.number) return '';
    const hint = String(e._hint.number || '').replace(/\D/g, '').slice(-4);
    if (!hint) return '•••• •••• •••• ••••';
    return window.Passory.maskCardNumber('0'.repeat(12) + hint); // « •••• •••• •••• 1234 »
  }

  async function reload() {
    try {
      const res = await window.passory.items.list('card');
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
          label: p.label || '', holder: p.holder || '', expiry: p.expiry || '',
          bank: p.bank || '', network: p.network || '', notes: p.notes || '',
          _has: p._has || {}, _hint: p._hint || {},
        };
      });
      window.Passory.setCount(document.getElementById('count-label'), entries.length, 'carte', 'cartes', 'Aucune carte');
      render();
    } catch (err) {
      window.Passory.toast('Impossible d\'afficher la liste. Verrouillez puis rouvrez le coffre.', 'error');
    }
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const filtered = q
      ? entries.filter((e) =>
          [e.label, e.holder, e.bank, e.network].some((v) => (v || '').toLowerCase().includes(q)))
      : entries;

    list.innerHTML = '';
    if (filtered.length === 0) {
      window.Passory.renderEmpty(empty, entries.length === 0
        ? { icon: 'fa-credit-card', title: 'Aucune carte pour l\'instant', sub: 'Cliquez sur « Ajouter » pour enregistrer votre première carte bancaire.' }
        : { query: search.value.trim() });
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    const esc = window.Passory.escapeHtml;
    for (const e of filtered) {
      const full = revealed.get(e.id);
      const isRevealed = !!full;
      const numDisplay = isRevealed
        ? window.Passory.formatCardNumber(full.number || '')
        : maskedFromHint(e);
      const cvvDisplay = isRevealed ? (full.cvv || '') : (e._has.cvv ? '•••' : '');
      // Réseau : champ enregistré, sinon déduit du numéro uniquement s'il est révélé
      const network = e.network || (isRevealed ? window.Passory.detectCardNetwork(full.number || '') : '');

      // Outer wrapper
      const wrap = document.createElement('div');
      wrap.dataset.id = e.id;
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';

      // Credit card element
      const card = document.createElement('div');
      card.className = 'credit-card ' + window.Passory.cardCssClass(network);
      card.innerHTML = `
  <div style="display:flex;align-items:flex-start;justify-content:space-between">
    <div class="card-chip"></div>
    <span class="card-network">${esc(network || '')}</span>
  </div>
  <div class="card-number" data-field="number">${esc(numDisplay)}</div>
  <div class="card-bottom">
    <div>
      <div class="card-expiry-label">Titulaire</div>
      <div class="card-holder">${esc((e.holder || '—').toUpperCase())}</div>
    </div>
    <div>
      <div class="card-expiry-label">Expire</div>
      <div class="card-expiry">${esc(e.expiry || '--/--')}</div>
    </div>
    <div style="text-align:right">
      <div class="card-expiry-label">CVV</div>
      <div class="card-expiry" data-field="cvv">${esc(cvvDisplay)}</div>
    </div>
  </div>
`;
      wrap.appendChild(card);

      // Info + actions row below the card
      const infoRow = document.createElement('div');
      infoRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between';
      infoRow.innerHTML = `
  <div>
    <div style="font-weight:600;font-size:0.875rem">${esc(e.label || '')}</div>
    <div style="font-size:0.75rem;color:var(--text-secondary)">${esc(e.bank || '')}</div>
  </div>
  <div class="item-actions">
    <button data-action="toggle" title="${isRevealed ? 'Masquer' : 'Afficher'}" class="item-action-btn"><i class="fas ${isRevealed ? 'fa-eye-slash' : 'fa-eye'}"></i></button>
    <button data-action="copy-number" title="Copier le numéro de carte" class="item-action-btn" style="color:#93c5fd" ${e._has.number ? '' : 'disabled'}><i class="fas fa-copy" aria-hidden="true"></i></button>
    <button data-action="copy-cvv" title="Copier le cryptogramme (CVV)" class="item-action-btn" ${e._has.cvv ? '' : 'disabled'}><i class="fas fa-shield-halved" aria-hidden="true"></i></button>
    <button data-action="copy-pin" title="Copier le code PIN" class="item-action-btn" ${e._has.pin ? '' : 'disabled'}><i class="fas fa-key" aria-hidden="true"></i></button>
    <button data-action="edit" title="Modifier" class="item-action-btn"><i class="fas fa-pen" aria-hidden="true"></i></button>
    <button data-action="delete" title="Supprimer" class="item-action-btn danger"><i class="fas fa-trash" aria-hidden="true"></i></button>
  </div>
`;
      wrap.appendChild(infoRow);
      list.appendChild(wrap);
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
      revealed.set(id, full.payload || {});
      render();
    } else if (action === 'copy-number' || action === 'copy-cvv' || action === 'copy-pin') {
      const field = { 'copy-number': 'number', 'copy-cvv': 'cvv', 'copy-pin': 'pin' }[action];
      const what = { number: 'Numéro', cvv: 'CVV', pin: 'PIN' }[field];
      const r = await window.passory.items.copyField(id, field);
      if (r.success) window.Passory.copiedToast(what, r);
      else window.Passory.toast(window.Passory.friendlyError(r, 'L\'opération a échoué. Réessayez.'), 'error');
    } else if (action === 'edit') {
      const full = await getFull(id);
      if (full) openModal(full);
    } else if (action === 'delete') {
      if (!(await window.Passory.confirmDelete('cette carte', entry.label))) return;
      const r = await window.passory.items.delete(id);
      if (r.success) { window.Passory.toast(`« ${entry.label} » a été supprimée.`, 'success'); await reload(); }
      else window.Passory.toast(window.Passory.friendlyError(r, 'L\'opération a échoué. Réessayez.'), 'error');
    }
  });

  // --- Formatage live -------------------------------------------
  fNumber.addEventListener('input', () => {
    const digits = fNumber.value.replace(/\D/g, '').slice(0, 19);
    fNumber.value = window.Passory.formatCardNumber(digits);
    networkTag.textContent = window.Passory.detectCardNetwork(digits);
  });
  fExpiry.addEventListener('input', () => {
    let d = fExpiry.value.replace(/\D/g, '').slice(0, 4);
    if (d.length >= 3) d = d.slice(0, 2) + '/' + d.slice(2);
    fExpiry.value = d;
  });
  fCvv.addEventListener('input', () => { fCvv.value = fCvv.value.replace(/\D/g, '').slice(0, 4); });
  fPin.addEventListener('input', () => { fPin.value = fPin.value.replace(/\D/g, '').slice(0, 8); });

  // --- Modal -----------------------------------------------------
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
      modalTitle.textContent = 'Modifier la carte';
      fId.value = full.id;
      fLabel.value = entry.label || '';
      fHolder.value = entry.holder || '';
      fNumber.value = window.Passory.formatCardNumber(entry.number || '');
      fExpiry.value = entry.expiry || '';
      fCvv.value = entry.cvv || '';
      fPin.value = entry.pin || '';
      fBank.value = entry.bank || '';
      fNotes.value = entry.notes || '';
      networkTag.textContent = entry.network || window.Passory.detectCardNetwork(entry.number || '');
    } else {
      modalTitle.textContent = 'Ajouter une carte';
      fId.value = '';
      networkTag.textContent = '';
    }
    modal.classList.remove('hidden'); modal.classList.add('flex');
    setTimeout(() => fLabel.focus(), 50);
  }

  function closeModal() {
    modal.classList.add('hidden'); modal.classList.remove('flex');
    modalForm.reset(); fId.value = ''; networkTag.textContent = '';
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
      label:  fLabel.value.trim(),
      holder: fHolder.value.trim(),
      number: fNumber.value.replace(/\s+/g, ''),
      expiry: fExpiry.value.trim(),
      cvv:    fCvv.value.trim(),
      pin:    fPin.value.trim(),
      bank:   fBank.value.trim(),
      network: window.Passory.detectCardNetwork(fNumber.value),
      notes:  fNotes.value.trim(),
    });
    if (!payload.label) { window.Passory.toast('Donnez un nom à cet élément (champ « Nom »).', 'warn'); fLabel.focus(); return; }

    if (saving) return;
    saving = true; saveBtn.disabled = true;

    modalLoader.classList.remove('hidden');
    try {
      let res;
      if (fId.value) res = await window.passory.items.update(fId.value, payload);
      else           res = await window.passory.items.add('card', payload);

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
