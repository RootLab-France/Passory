(function () {
  'use strict';

  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  const search = document.getElementById('search');
  const addBtn = document.getElementById('add-btn');

  const editorEmpty = document.getElementById('editor-empty');
  const editor = document.getElementById('editor');
  const eTitle = document.getElementById('e-title');
  const eContent = document.getElementById('e-content');
  const eMeta = document.getElementById('e-meta');
  const eSaveStatus = document.getElementById('e-save-status');
  const eSaving = document.getElementById('e-saving');
  const eCopy = document.getElementById('e-copy');
  const eDelete = document.getElementById('e-delete');

  let entries = [];
  let currentId = null;
  let saveTimer = null;
  let dirty = false;

  (async () => {
    const ok = await window.Passory.requireUnlockedOrRedirect();
    if (!ok) return;
    window.Passory.applySearchFromUrl(search);
    await reload();
    // Arrivée depuis la recherche globale : ouvre directement la note trouvée
    const q = search.value.trim().toLowerCase();
    if (q) {
      const hits = entries.filter((e) => (e.title || '(Sans titre)').toLowerCase().includes(q));
      if (hits.length === 1) await selectNote(hits[0].id);
    }
  })();

  async function reload(preserveSelection = false) {
    try {
      const res = await window.passory.items.list('note');
      if (!res.success) {
        if (res.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return; }
        window.Passory.toast(window.Passory.friendlyError(res, 'Impossible d\'afficher vos notes. Verrouillez puis rouvrez le coffre.'), 'error');
        return;
      }
      entries = res.entries
        .filter((e) => !e.corrupt)
        .map((e) => ({ id: e.id, updatedAt: e.updatedAt, createdAt: e.createdAt, ...(e.payload || {}) }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (!preserveSelection) currentId = null;
      renderList();
      if (!currentId) showEmptyEditor();
      else renderCurrent();
    } catch (err) {
      window.Passory.toast('Erreur : ' + err.message, 'error');
    }
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    const filtered = q
      ? entries.filter((e) => (e.title || '').toLowerCase().includes(q))
      : entries;

    list.innerHTML = '';
    if (filtered.length === 0) {
      empty.classList.remove('hidden');
      empty.textContent = entries.length === 0
        ? 'Aucune note pour l\'instant. Cliquez sur « + » pour en créer une.'
        : 'Aucune note ne correspond à « ' + search.value.trim() + ' ».';
      return;
    }
    empty.classList.add('hidden');

    const esc = window.Passory.escapeHtml;
    for (const e of filtered) {
      const active = e.id === currentId;
      // Le contenu n'est chargé qu'à l'ouverture de la note (liste expurgée).
      const preview = e._has && e._has.content ? 'Contenu masqué — cliquez pour ouvrir' : '';
      const row = document.createElement('button');
      row.type = 'button';
      row.dataset.id = e.id;
      row.className = 'notes-list-item w-full text-left' + (active ? ' active' : '');
      if (active) row.setAttribute('aria-current', 'true');
      row.innerHTML = `
        <p class="notes-list-title">${esc(e.title || '(Sans titre)')}</p>
        <p class="notes-list-preview mt-1">${esc(preview) || '<span class="italic">Note vide</span>'}</p>
        <p class="notes-list-date">Modifiée ${esc(window.Passory.formatRelativeDate(e.updatedAt || e.createdAt))}</p>
      `;
      row.addEventListener('click', () => selectNote(e.id));
      list.appendChild(row);
    }
  }

  search.addEventListener('input', renderList);

  addBtn.addEventListener('click', async () => {
    await flushSaveIfDirty();
    const res = await window.passory.items.add('note', { title: '', content: '' });
    if (!res.success) { window.Passory.toast(window.Passory.friendlyError(res, 'Impossible de créer la note. Réessayez.'), 'error'); return; }
    currentId = res.id;
    await reload(true);
    eTitle.focus();
  });

  function showEmptyEditor() {
    editorEmpty.classList.remove('hidden');
    editor.classList.add('hidden');
  }

  async function renderCurrent() {
    const e = entries.find((x) => x.id === currentId);
    if (!e) { showEmptyEditor(); return; }
    if (!e._loaded) {
      // Charge le contenu complet de CETTE note uniquement.
      const r = await window.passory.items.get(e.id);
      if (!r || !r.success) {
        if (r && r.error === 'LOCKED') { window.Passory.lockAndGoLogin(); return; }
        window.Passory.toast(window.Passory.friendlyError(r, 'Impossible d\'ouvrir la note.'), 'error');
        showEmptyEditor();
        return;
      }
      e.title = r.entry.payload.title || '';
      e.content = r.entry.payload.content || '';
      e._loaded = true;
    }
    if (currentId !== e.id) return;
    editorEmpty.classList.add('hidden');
    editor.classList.remove('hidden');
    eTitle.value = e.title || '';
    eContent.value = e.content || '';
    const created = window.Passory.formatRelativeDate(e.createdAt);
    const updated = window.Passory.formatRelativeDate(e.updatedAt);
    eMeta.textContent = `Modifiée ${updated}`;
    eMeta.title = `Créée ${created}`;
    eSaveStatus.classList.add('hidden');
    dirty = false;
  }

  async function selectNote(id) {
    await flushSaveIfDirty();
    currentId = id;
    renderList();
    await renderCurrent();
  }

  function scheduleSave() {
    dirty = true;
    eSaveStatus.classList.add('hidden');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { save(); }, 500);
  }

  async function save() {
    if (!currentId) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty) return;
    const cur = entries.find((x) => x.id === currentId);
    if (!cur || !cur._loaded) return; // jamais d'écriture sans le contenu complet
    eSaving.classList.remove('hidden');
    try {
      const payload = { title: eTitle.value, content: eContent.value };
      const res = await window.passory.items.update(currentId, payload);
      if (res.success) {
        dirty = false;
        eSaveStatus.classList.remove('hidden');
        // mise à jour locale pour le tri + preview
        const e = entries.find((x) => x.id === currentId);
        if (e) { e.title = payload.title; e.content = payload.content; e.updatedAt = Date.now(); e._has = Object.assign({}, e._has, { content: !!payload.content }); }
        renderList();
      } else if (res.error === 'LOCKED') {
        window.Passory.lockAndGoLogin(); return;
      } else {
        window.Passory.toast(window.Passory.friendlyError(res, 'La note n\'a pas pu être enregistrée. Copiez son contenu par sécurité et réessayez.'), 'error');
      }
    } catch (err) {
      window.Passory.toast('La note n\'a pas pu être enregistrée. Copiez son contenu par sécurité et réessayez.', 'error');
    } finally {
      eSaving.classList.add('hidden');
    }
  }

  async function flushSaveIfDirty() { if (dirty) await save(); }

  eTitle.addEventListener('input', scheduleSave);
  eContent.addEventListener('input', scheduleSave);

  // Cmd/Ctrl-S force la sauvegarde
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });

  // Avant de quitter la page, on pousse la dernière modif
  window.addEventListener('beforeunload', () => {
    if (dirty && currentId) {
      // Appel synchrone impossible ; on envoie et on laisse Electron finir.
      window.passory.items.update(currentId, { title: eTitle.value, content: eContent.value });
    }
  });

  eCopy.addEventListener('click', async () => {
    if (!eContent.value) { window.Passory.toast('La note est vide : rien à copier.', 'info'); return; }
    const r = await window.passory.items.copy(eContent.value);
    if (r.success) window.Passory.copiedToast('Contenu', r);
    else window.Passory.toast(window.Passory.friendlyError(r, 'La copie a échoué.'), 'error');
  });

  eDelete.addEventListener('click', async () => {
    if (!currentId) return;
    const e = entries.find((x) => x.id === currentId);
    const name = (e && e.title) || '(Sans titre)';
    if (!(await window.Passory.confirmDelete('cette note', name))) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    dirty = false;
    const res = await window.passory.items.delete(currentId);
    if (res.success) {
      currentId = null;
      await reload();
      window.Passory.toast(`« ${name} » a été supprimée.`, 'success');
    } else {
      window.Passory.toast(window.Passory.friendlyError(res, 'La suppression a échoué. Réessayez.'), 'error');
    }
  });
})();
