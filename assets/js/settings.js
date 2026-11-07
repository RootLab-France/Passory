(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const P = () => window.Passory;

  // --- Verrouillage ---
  const quToggle      = $('qu-toggle');
  const quBadge       = $('qu-badge');
  const quDesc        = $('qu-desc');
  const autoSelect    = $('autolock-select');
  const lockMinToggle = $('lockmin-toggle');

  // --- Presse-papier ---
  const clipSelect = $('clip-select');

  // --- Générateur ---
  const genLength  = $('gen-length');
  const genSlider  = $('gen-slider');
  const genUpper   = $('gen-upper');
  const genLower   = $('gen-lower');
  const genDigits  = $('gen-digits');
  const genSymbols = $('gen-symbols');
  const genAvoid   = $('gen-avoid');
  const genTest    = $('gen-test');
  const genPreview = $('gen-preview');
  const genCopy    = $('gen-copy');
  const genStatus  = $('gen-status');

  // --- Changer le maître ---
  const changeForm   = $('change-form');
  const oldPw        = $('old-pw');
  const newPw        = $('new-pw');
  const newPw2       = $('new-pw2');
  const changeSubmit = $('change-submit');

  // --- Sauvegarde ---
  const bkPass          = $('bk-pass');
  const bkPass2         = $('bk-pass2');
  const bkMatch         = $('bk-match');
  const bkImportPass    = $('bk-import-pass');
  const bkExport        = $('bk-export');
  const bkImportMerge   = $('bk-import-merge');
  const bkImportReplace = $('bk-import-replace');
  const bkLast          = $('bk-last');

  // --- Danger ---
  const resetBtn = $('reset-settings');
  const wipeBtn  = $('wipe-all');

  /** Demande le mot de passe maître (actions sensibles). Retourne la chaîne ou null. */
  function askMaster(title, message, confirmLabel, danger) {
    return P().confirm({ title, message, password: true, confirmLabel: confirmLabel || 'Confirmer', danger: !!danger });
  }

  /** Une annulation dans la fenêtre de choix de fichier n'est pas une erreur. */
  const isCancel = (res) => res && /^Annulé\.?$/.test(String(res.error || ''));

  // ─── Afficher / masquer un champ ────────────────────────────────────────────
  document.querySelectorAll('[data-eye]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.eye);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      const icon = btn.querySelector('i');
      if (icon) icon.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
      const l = show ? 'Masquer' : 'Afficher';
      btn.title = l; btn.setAttribute('aria-label', l);
      // Le champ de confirmation suit le même affichage
      if (btn.dataset.eye === 'bk-pass') bkPass2.type = input.type;
      if (btn.dataset.eye === 'new-pw') newPw2.type = input.type;
    });
  });

  // ─── Solidité du nouveau mot de passe maître ────────────────────────────────
  const strengthLevels = [
    { label: 'Très faible', color: '#f87171', pct: '15%' },
    { label: 'Faible',      color: '#fb923c', pct: '30%' },
    { label: 'Moyen',       color: '#facc15', pct: '55%' },
    { label: 'Solide',      color: '#4ade80', pct: '78%' },
    { label: 'Très solide', color: '#34d399', pct: '100%' },
  ];
  function passwordScore(pw) {
    let s = 0;
    if (pw.length >= 8)  s++;
    if (pw.length >= 12) s++;
    if (pw.length >= 16) s++;
    if (/[A-Z]/.test(pw))        s++;
    if (/[a-z]/.test(pw))        s++;
    if (/[0-9]/.test(pw))        s++;
    if (/[^A-Za-z0-9]/.test(pw)) s++;
    if (s < 2) return 0;
    if (s < 3) return 1;
    if (s < 5) return 2;
    if (s < 7) return 3;
    return 4;
  }
  function updateStrength() {
    const bar = $('pw-strength-bar'), label = $('pw-strength-label');
    const progressbar = bar && bar.parentElement;
    const pw = newPw.value;
    if (!pw) {
      bar.style.width = '0'; label.textContent = '';
      if (progressbar) progressbar.setAttribute('aria-valuenow', '0');
      checkMatch(); return;
    }
    const lvl = strengthLevels[passwordScore(pw)];
    bar.style.width = lvl.pct;
    bar.style.backgroundColor = lvl.color;
    label.textContent = pw.length < 12 ? `Encore ${12 - pw.length} caractère(s) au minimum` : 'Solidité : ' + lvl.label;
    label.style.color = pw.length < 12 ? '' : lvl.color;
    if (progressbar) progressbar.setAttribute('aria-valuenow', parseInt(lvl.pct, 10));
    checkMatch();
  }
  function matchText(a, b, el) {
    if (!b) { el.textContent = ''; return; }
    const same = a === b;
    el.textContent = same ? '✓ Les deux saisies sont identiques.' : 'Les deux saisies sont différentes.';
    el.style.color = same ? '#6ee7b7' : '#fca5a5';
  }
  function checkMatch() { matchText(newPw.value, newPw2.value, $('pw-match-label')); }
  newPw.addEventListener('input', updateStrength);
  newPw2.addEventListener('input', checkMatch);
  const checkBkMatch = () => matchText(bkPass.value, bkPass2.value, bkMatch);
  bkPass.addEventListener('input', checkBkMatch);
  bkPass2.addEventListener('input', checkBkMatch);

  // ─── Init ────────────────────────────────────────────────────────────────────
  (async () => {
    const ok = await P().requireUnlockedOrRedirect();
    if (!ok) return;
    await refreshAll();
    showLastBackup();
    try {
      const info = window.passory.app && await window.passory.app.info();
      if (info && info.success) $('app-version').textContent = info.version;
    } catch {}
    // Arrivée via un lien « #sec-backup » : on place le curseur dans le bon champ
    if (window.location.hash === '#sec-backup') setTimeout(() => bkPass.focus(), 200);
  })();

  function showLastBackup() {
    const last = P().getLastBackup();
    bkLast.innerHTML = '';
    const i = document.createElement('i');
    i.className = 'fas mr-1 ' + (last ? 'fa-circle-check' : 'fa-triangle-exclamation');
    i.style.color = last ? '#6ee7b7' : '#fbbf24';
    i.setAttribute('aria-hidden', 'true');
    bkLast.append(i, document.createTextNode(last
      ? 'Dernière sauvegarde depuis cet ordinateur : ' + P().formatRelativeDate(last) + '.'
      : 'Aucune sauvegarde n\'a encore été faite depuis cet ordinateur.'));
  }

  function selectValue(select, value) {
    const v = String(value);
    if (![...select.options].some((o) => o.value === v)) {
      // Valeur personnalisée (ancienne version) : on l'affiche telle quelle
      const o = document.createElement('option');
      o.value = v; o.textContent = select === clipSelect ? `Après ${v} secondes` : `Après ${v} minutes`;
      select.insertBefore(o, select.lastElementChild);
    }
    select.value = v;
  }

  async function refreshAll() {
    try {
      const res = await window.passory.settings.get();
      if (!res.success) { P().toast('Impossible de charger les paramètres. Redémarrez Passory.', 'error'); return; }
      const { settings, quickUnlockAvailable, quickUnlockEnabled } = res;

      // Biométrie : téléphone uniquement. Sur ordinateur, la ligne reste cachée
      // (aucune clé n'est écrite sur disque, le mot de passe maître est demandé à chaque ouverture).
      const quRow = $('qu-row');
      if (quRow) quRow.classList.toggle('hidden', !quickUnlockAvailable);
      quToggle.checked = !!quickUnlockEnabled;
      quToggle.disabled = !quickUnlockAvailable;
      quBadge.textContent = quickUnlockEnabled ? '(activé)' : '';
      quBadge.style.color = '#6ee7b7';

      selectValue(autoSelect, settings.autoLockMinutes);
      lockMinToggle.checked = !!settings.lockOnMinimize;
      selectValue(clipSelect, settings.clipboardClearSeconds);

      genLength.value    = settings.generatorLength;
      genSlider.value    = settings.generatorLength;
      genUpper.checked   = !!settings.generatorUseUpper;
      genLower.checked   = !!settings.generatorUseLower;
      genDigits.checked  = !!settings.generatorUseDigits;
      genSymbols.checked = !!settings.generatorUseSymbols;
      genAvoid.checked   = !!settings.generatorAvoidAmbiguous;
      await makePreview();
    } catch (err) {
      P().toast('Impossible de charger les paramètres. Redémarrez Passory.', 'error');
    }
  }

  async function setAndToast(partial, successMsg) {
    const res = await window.passory.settings.set(partial);
    if (res.success) {
      if (successMsg) P().toast(successMsg, 'success');
      return res.settings;
    }
    P().toast(P().friendlyError(res, 'Le réglage n\'a pas pu être enregistré. Réessayez.'), 'error');
    return null;
  }

  // ─── Verrouillage ──────────────────────────────────────────────────────────
  quToggle.addEventListener('change', async () => {
    if (quToggle.checked) {
      const r = await window.passory.quickUnlock.enable();
      if (!r.success) { quToggle.checked = false; P().toast(P().friendlyError(r, 'Impossible d\'activer le déverrouillage avec la biométrie.'), 'error'); }
      else P().toast('Déverrouillage avec la biométrie activé.', 'success');
    } else {
      const r = await window.passory.quickUnlock.disable();
      if (!r.success) { quToggle.checked = true; P().toast('Impossible de désactiver le déverrouillage avec la biométrie. Réessayez.', 'error'); }
      else P().toast('Déverrouillage avec la biométrie désactivé.', 'success');
    }
    await refreshAll();
  });

  autoSelect.addEventListener('change', async () => {
    const v = parseInt(autoSelect.value, 10) || 0;
    await setAndToast({ autoLockMinutes: v },
      v ? `Le coffre se verrouillera après ${v >= 60 ? v / 60 + ' h' : v + ' min'} d'inactivité.` : 'Verrouillage automatique désactivé.');
  });

  lockMinToggle.addEventListener('change', async () => {
    const s = await setAndToast({ lockOnMinimize: lockMinToggle.checked },
      lockMinToggle.checked ? 'Le coffre se verrouillera quand la fenêtre est réduite.' : 'Réglage enregistré.');
    if (!s) lockMinToggle.checked = !lockMinToggle.checked;
  });

  // ─── Presse-papier ───────────────────────────────────────────────────────────
  clipSelect.addEventListener('change', async () => {
    const v = parseInt(clipSelect.value, 10) || 0;
    await setAndToast({ clipboardClearSeconds: v },
      v ? `Les éléments copiés seront effacés après ${v} secondes.` : 'Les éléments copiés ne seront plus effacés automatiquement.');
  });

  // ─── Générateur (enregistrement automatique) ───────────────────────────────
  let genTimer = null;
  function genOptions() {
    return {
      length: Math.max(8, Math.min(128, parseInt(genLength.value, 10) || 20)),
      upper: genUpper.checked, lower: genLower.checked, digits: genDigits.checked,
      symbols: genSymbols.checked, avoidAmbiguous: genAvoid.checked,
    };
  }
  function scheduleGenSave() {
    clearTimeout(genTimer);
    genTimer = setTimeout(async () => {
      const o = genOptions();
      if (!o.upper && !o.lower && !o.digits && !o.symbols) {
        genStatus.textContent = 'Cochez au moins un type de caractères.';
        genStatus.style.color = '#fca5a5';
        return;
      }
      const s = await setAndToast({
        generatorLength: o.length, generatorUseUpper: o.upper, generatorUseLower: o.lower,
        generatorUseDigits: o.digits, generatorUseSymbols: o.symbols, generatorAvoidAmbiguous: o.avoidAmbiguous,
      });
      if (s) { genStatus.textContent = '✓ Réglages du générateur enregistrés.'; genStatus.style.color = '#6ee7b7'; }
      await makePreview();
    }, 350);
  }
  genSlider.addEventListener('input', () => { genLength.value = genSlider.value; scheduleGenSave(); });
  genLength.addEventListener('input', () => { genSlider.value = genLength.value; scheduleGenSave(); });
  [genUpper, genLower, genDigits, genSymbols, genAvoid].forEach((cb) => cb.addEventListener('change', scheduleGenSave));

  async function makePreview() {
    const o = genOptions();
    if (!o.upper && !o.lower && !o.digits && !o.symbols) { genPreview.textContent = '—'; return; }
    const res = await window.passory.generator.make(o);
    if (res && res.success) genPreview.textContent = res.password;
    else genPreview.textContent = '—';
  }
  genTest.addEventListener('click', makePreview);
  genCopy.addEventListener('click', async () => {
    if (!genPreview.textContent || genPreview.textContent === '—') await makePreview();
    const r = await window.passory.items.copy(genPreview.textContent);
    if (r.success) P().copiedToast('Mot de passe', r);
  });

  // ─── Changement du mot de passe maître ──────────────────────────────────────
  changeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = oldPw.value, b = newPw.value, c = newPw2.value;
    if (!a)            { P().toast('Saisissez votre mot de passe maître actuel.', 'warn'); oldPw.focus(); return; }
    if (b.length < 12) { P().toast('Le nouveau mot de passe doit faire au moins 12 caractères.', 'warn'); newPw.focus(); return; }
    if (b !== c)       { P().toast('Les deux saisies du nouveau mot de passe sont différentes.', 'warn'); newPw2.focus(); return; }

    const ok = await P().confirm({
      title: 'Changer le mot de passe maître ?',
      message: 'À partir de maintenant, il faudra utiliser le nouveau mot de passe pour ouvrir Passory. L\'opération prend quelques secondes.\n\nVos sauvegardes existantes ne changent pas : elles s\'ouvrent toujours avec leur propre phrase de passe.',
      confirmLabel: 'Changer',
    });
    if (!ok) return;

    changeSubmit.disabled = true;
    const label = changeSubmit.innerHTML;
    changeSubmit.innerHTML = '<i class="fas fa-spinner spin" aria-hidden="true"></i>Changement en cours…';
    try {
      const res = await window.passory.auth.changeMaster(a, b);
      if (res.success) {
        P().toast('Mot de passe maître changé. Utilisez le nouveau à la prochaine ouverture.', 'success');
        changeForm.reset();
        updateStrength();
      } else {
        const msg = String(res.error || '');
        P().toast(/incorrect/i.test(msg) ? 'Le mot de passe maître actuel est incorrect. Rien n\'a été changé.'
          : P().friendlyError(res, 'Le changement a échoué. Rien n\'a été modifié.'), 'error');
        if (/incorrect/i.test(msg)) { oldPw.select(); oldPw.focus(); }
      }
    } catch {
      P().toast('Le changement a échoué. Rien n\'a été modifié.', 'error');
    } finally {
      changeSubmit.disabled = false;
      changeSubmit.innerHTML = label;
    }
  });

  // ─── Sauvegarde ────────────────────────────────────────────────────────────
  async function busy(btn, text, fn) {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner spin" aria-hidden="true"></i>${text}`;
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
  }

  bkExport.addEventListener('click', async () => {
    const p = bkPass.value;
    if (p.length < 12) { P().toast('La phrase de passe de la sauvegarde doit faire au moins 12 caractères.', 'warn'); bkPass.focus(); return; }
    if (p !== bkPass2.value) { P().toast('Les deux saisies de la phrase de passe sont différentes.', 'warn'); bkPass2.focus(); return; }
    const master = await askMaster('Confirmer la sauvegarde',
      'Pour protéger vos données, saisissez votre mot de passe maître. Vous choisirez ensuite où enregistrer le fichier.', 'Continuer');
    if (!master) return;
    const res = await busy(bkExport, 'Sauvegarde en cours…', () => window.passory.backup.export(p, master));
    if (res.success) {
      bkPass.value = ''; bkPass2.value = ''; checkBkMatch();
      P().setLastBackup(Date.now());
      showLastBackup();
      const where = res.path ? ` dans « ${res.path} »` : '';
      P().toast(`Sauvegarde enregistrée${where} (${res.count} élément${res.count > 1 ? 's' : ''}). Gardez la phrase de passe en lieu sûr.`, 'success');
      if (res.skipped) P().toast(`${res.skipped} élément(s) illisible(s) n'ont pas pu être sauvegardés.`, 'warn');
    } else if (isCancel(res)) {
      P().toast('Sauvegarde annulée.', 'info');
    } else {
      P().toast(/incorrect/i.test(String(res.error)) ? 'Mot de passe maître incorrect. La sauvegarde n\'a pas été créée.'
        : P().friendlyError(res, 'La sauvegarde a échoué. Vérifiez l\'emplacement choisi et réessayez.'), 'error');
    }
  });

  async function doImport(mode) {
    const p = bkImportPass.value;
    if (!p) { P().toast('Saisissez la phrase de passe de la sauvegarde à ouvrir.', 'warn'); bkImportPass.focus(); return; }
    let master;
    if (mode === 'replace') {
      const ok = await P().confirm({
        title: 'Remplacer tout le coffre ?',
        message: 'Tous les éléments actuellement dans votre coffre seront supprimés et remplacés par ceux de la sauvegarde. Cette action ne peut pas être annulée.',
        requireText: 'REMPLACER', inputLabel: 'Pour confirmer, tapez REMPLACER', confirmLabel: 'Continuer', danger: true,
      });
      if (!ok) return;
      master = await askMaster('Remplacer tout le coffre', 'Saisissez votre mot de passe maître, puis choisissez le fichier de sauvegarde.', 'Choisir le fichier', true);
      if (!master) return;
    }
    const btn = mode === 'replace' ? bkImportReplace : bkImportMerge;
    const res = await busy(btn, 'Restauration…', () => window.passory.backup.import(p, mode, master));
    if (res.success) {
      bkImportPass.value = '';
      const n = res.imported;
      P().toast(mode === 'replace'
        ? `Coffre remplacé : ${n} élément${n > 1 ? 's' : ''} restauré${n > 1 ? 's' : ''}.`
        : `${n} élément${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} à votre coffre.`, 'success');
      if (res.ignored) P().toast(`${res.ignored} élément(s) de la sauvegarde étaient illisibles et ont été ignorés.`, 'warn');
    } else if (isCancel(res)) {
      P().toast('Restauration annulée.', 'info');
    } else {
      const msg = String(res.error || '');
      let text;
      if (/incorrect/i.test(msg) && mode === 'replace' && /maître/i.test(msg)) text = 'Mot de passe maître incorrect. Rien n\'a été modifié.';
      else if (/version/i.test(msg)) text = 'Cette sauvegarde a été créée par une version de Passory plus récente. Mettez Passory à jour puis réessayez.';
      else if (/passphrase|phrase de passe|déchiffr|decrypt|incorrect|corrompu|invalid|backup|JSON/i.test(msg)) text = 'Impossible d\'ouvrir ce fichier : la phrase de passe est incorrecte ou le fichier n\'est pas une sauvegarde Passory. Rien n\'a été modifié.';
      else text = P().friendlyError(res, 'La restauration a échoué. Rien n\'a été modifié.');
      P().toast(text, 'error');
    }
  }
  bkImportMerge.addEventListener('click',   () => doImport('merge'));
  bkImportReplace.addEventListener('click', () => doImport('replace'));

  // ─── Zone dangereuse ───────────────────────────────────────────────────────
  resetBtn.addEventListener('click', async () => {
    const ok = await P().confirm({
      title: 'Remettre les réglages par défaut ?',
      message: 'Verrouillage, presse-papier et générateur reviennent à leurs valeurs d\'origine. Vos mots de passe et autres données ne sont pas touchés.',
      confirmLabel: 'Réinitialiser',
    });
    if (!ok) return;
    const res = await window.passory.settings.reset();
    if (res.success) { P().toast('Réglages remis par défaut.', 'success'); await refreshAll(); }
    else P().toast(P().friendlyError(res, 'La réinitialisation a échoué. Réessayez.'), 'error');
  });

  wipeBtn.addEventListener('click', async () => {
    const last = P().getLastBackup();
    const ok = await P().confirm({
      title: 'Effacer tout le coffre ?',
      message: 'Tous vos mots de passe, cartes, IBAN, notes et identités seront supprimés définitivement de cet ordinateur, ainsi que le mot de passe maître.\n\n'
        + (last ? 'Seule une sauvegarde vous permettra de les retrouver.' : 'Vous n\'avez fait aucune sauvegarde : vos données seront perdues pour toujours.'),
      requireText: 'EFFACER', inputLabel: 'Pour confirmer, tapez EFFACER', confirmLabel: 'Continuer', danger: true,
    });
    if (!ok) return;
    const master = await askMaster('Dernière confirmation', 'Saisissez votre mot de passe maître pour tout effacer.', 'Tout effacer', true);
    if (!master) return;
    const res = await window.passory.danger.wipe(master);
    if (res.success) {
      P().setLastBackup(0);
      P().toast('Le coffre a été effacé.', 'success');
      // Ordinateur : Passory ouvre lui-même l'écran de création ; téléphone : la page y va.
      setTimeout(() => P().goto('create-master-password.html'), 600);
    } else {
      P().toast(/incorrect/i.test(String(res.error)) ? 'Mot de passe maître incorrect. Rien n\'a été effacé.'
        : P().friendlyError(res, 'L\'effacement a échoué.'), 'error');
    }
  });

})();
