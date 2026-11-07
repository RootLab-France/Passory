(function () {
  'use strict';

  const form = document.getElementById('form');
  const pwd = document.getElementById('password');
  const toggle = document.getElementById('toggle-password');
  const submitBtn = document.getElementById('submit-btn');
  const quickBtn = document.getElementById('quick-btn');
  const errMsg = document.getElementById('error-msg');
  const infoMsg = document.getElementById('info-msg');

  const showError = (m) => { errMsg.textContent = m; errMsg.classList.remove('hidden'); infoMsg.classList.add('hidden'); };
  const showInfo  = (m) => { infoMsg.textContent = m; infoMsg.classList.remove('hidden'); errMsg.classList.add('hidden'); };
  const clearMsgs = () => { errMsg.classList.add('hidden'); infoMsg.classList.add('hidden'); };

  // Raison du verrouillage (passée par main.js ou par le bouton « Verrouiller »)
  const RAISONS = {
    inactivite: 'Le coffre a été verrouillé automatiquement après une période d\'inactivité.',
    veille: 'Le coffre a été verrouillé pendant la mise en veille de l\'ordinateur.',
    reduction: 'Le coffre a été verrouillé quand la fenêtre a été réduite.',
    manuel: 'Coffre verrouillé.',
  };
  let raison = '';
  try { raison = new URLSearchParams(window.location.search).get('raison') || ''; } catch {}
  const showReason = () => { if (RAISONS[raison]) showInfo(RAISONS[raison]); };

  const forgotBtn = document.getElementById('forgot-btn');
  const forgotHelp = document.getElementById('forgot-help');
  if (forgotBtn) forgotBtn.addEventListener('click', () => {
    const open = forgotHelp.classList.toggle('hidden') === false;
    forgotBtn.setAttribute('aria-expanded', String(open));
  });

  // ── « Repartir de zéro » (mot de passe maître oublié) ─────────────
  // Double confirmation : taper EFFACER, puis confirmer. Le process principal
  // revérifie le mot, n'accepte que si le coffre est verrouillé et une seule
  // demande à la fois.
  const resetBtn = document.getElementById('reset-btn');
  let resetting = false;
  if (resetBtn) resetBtn.addEventListener('click', async () => {
    if (resetting) return;
    clearMsgs();
    const first = await window.Passory.confirm({
      title: 'Repartir de zéro ?',
      message: 'Le coffre actuel sera définitivement effacé de cet appareil\u00a0: mots de passe, cartes, IBAN, notes et identités.\n\n'
        + 'Sans le mot de passe maître, aucune de ces données ne peut être récupérée, ni par vous ni par personne d\'autre.\n\n'
        + 'Ensuite, vous choisirez un nouveau mot de passe maître. Si vous avez une sauvegarde, vous pourrez la restaurer '
        + '(Paramètres › Sauvegarde › Restaurer) avec la phrase de passe de cette sauvegarde.',
      requireText: 'EFFACER', inputLabel: 'Pour confirmer, tapez EFFACER', confirmLabel: 'Continuer', danger: true,
    });
    if (!first) return;
    const second = await window.Passory.confirm({
      title: 'Dernière confirmation',
      message: 'Effacer définitivement le coffre de cet appareil ? Cette action ne peut pas être annulée.',
      confirmLabel: 'Effacer et repartir de zéro', cancelLabel: 'Annuler', danger: true,
    });
    if (!second) return;
    resetting = true;
    resetBtn.disabled = true;
    showInfo('Effacement du coffre…');
    try {
      const res = await window.passory.auth.resetForgotten('EFFACER');
      if (res && res.success) {
        window.Passory.setLastBackup(0);
        showInfo('Coffre effacé. Création d\'un nouveau mot de passe maître…');
        // Sur ordinateur, Passory ouvre lui-même l'écran de création ; sur
        // téléphone, c'est la page qui y va.
        setTimeout(() => window.Passory.goto('create-master-password.html?repartir=1'), 400);
        return;
      }
      showError(window.Passory.friendlyError(res, 'L\'effacement a échoué. Redémarrez Passory puis réessayez.'));
    } catch {
      showError('L\'effacement a échoué. Redémarrez Passory puis réessayez.');
    }
    resetting = false;
    resetBtn.disabled = false;
  });

  // Si pas de master → redirection vers création
  (async () => {
    try {
      const has = await window.passory.auth.hasMaster();
      if (!has) { window.Passory.goto('create-master-password.html'); return; }
    } catch {}

    // Si déjà déverrouillé → dashboard
    try {
      const unlocked = await window.passory.auth.isUnlocked();
      if (unlocked) { window.Passory.goto('dashboard.html'); return; }
    } catch {}

    // Téléphone uniquement : déverrouillage biométrique s'il est activé (n'existe pas sur ordinateur)
    try {
      const available = await window.passory.quickUnlock.isAvailable();
      const enabled = await window.passory.quickUnlock.isEnabled();
      if (available && enabled) {
        quickBtn.classList.remove('hidden');
        showInfo('Déverrouillage avec la biométrie…');
        const res = await window.passory.quickUnlock.try();
        if (res && res.success) {
          window.Passory.goto('dashboard.html');
          return;
        }
        // Échec → on laisse l'utilisateur saisir son master password
        clearMsgs();
        showReason();
        pwd.focus();
      } else {
        showReason();
        pwd.focus();
      }
    } catch {
      pwd.focus();
    }
  })();

  toggle.addEventListener('click', () => {
    const show = pwd.type === 'password';
    pwd.type = show ? 'text' : 'password';
    const icon = toggle.querySelector('i');
    icon.classList.toggle('fa-eye', !show);
    icon.classList.toggle('fa-eye-slash', show);
    const l = show ? 'Masquer le mot de passe' : 'Afficher le mot de passe';
    toggle.setAttribute('aria-label', l); toggle.title = l;
    pwd.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMsgs();
    if (!pwd.value) { showError('Saisissez votre mot de passe maître.'); pwd.focus(); return; }

    submitBtn.disabled = true;
    showInfo('Déverrouillage… (quelques secondes)');

    try {
      const res = await window.passory.auth.unlock(pwd.value);
      if (res && res.success) {
        pwd.value = '';
        showInfo('Déverrouillé. Redirection…');
        setTimeout(() => window.Passory.goto('dashboard.html'), 200);
      } else {
        submitBtn.disabled = false;
        const msg = (res && res.error) || '';
        showError(/incorrect/i.test(msg) || !msg
          ? 'Mot de passe maître incorrect. Vérifiez les majuscules (touche Verr. Maj) et réessayez.'
          : window.Passory.friendlyError(msg, 'Le déverrouillage a échoué. Réessayez.'));
        pwd.select();
        pwd.focus();
      }
    } catch (err) {
      submitBtn.disabled = false;
      showError('Le déverrouillage a échoué. Redémarrez Passory puis réessayez.');
    }
  });

  // Avertit quand la touche Verr. Maj est active
  pwd.addEventListener('keyup', (e) => {
    if (typeof e.getModifierState !== 'function') return;
    if (e.getModifierState('CapsLock')) showInfo('Attention : la touche Verr. Maj (majuscules) est activée.');
    else if (infoMsg.textContent.startsWith('Attention : la touche')) clearMsgs();
  });

  quickBtn.addEventListener('click', async () => {
    clearMsgs();
    quickBtn.disabled = true;
    showInfo('Déverrouillage avec la biométrie…');
    try {
      const res = await window.passory.quickUnlock.try();
      if (res && res.success) {
        window.Passory.goto('dashboard.html');
      } else {
        quickBtn.disabled = false;
        showError('Le déverrouillage avec la biométrie n\'a pas fonctionné. Utilisez votre mot de passe maître.');
      }
    } catch (err) {
      quickBtn.disabled = false;
      showError('Le déverrouillage avec la biométrie n\'a pas fonctionné. Utilisez votre mot de passe maître.');
    }
  });
})();
