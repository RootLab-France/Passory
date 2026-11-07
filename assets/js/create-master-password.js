(function () {
  'use strict';

  const p1 = document.getElementById('p1');
  const p2 = document.getElementById('p2');
  const toggle1 = document.getElementById('toggle-p1');
  const form = document.getElementById('form');
  const submitBtn = document.getElementById('submit-btn');
  const errMsg = document.getElementById('error-msg');
  const infoMsg = document.getElementById('info-msg');
  const bar = document.getElementById('strength-bar');
  const label = document.getElementById('strength-label');
  const matchLabel = document.getElementById('match-label');
  const ack = document.getElementById('ack');

  // Arrivée après « Repartir de zéro » (écran de connexion) : on le dit.
  let restarted = false;
  try { restarted = new URLSearchParams(window.location.search).get('repartir') === '1'; } catch {}
  const restartNotice = document.getElementById('restart-notice');
  if (restarted && restartNotice) restartNotice.classList.remove('hidden');

  function showError(msg) {
    errMsg.textContent = msg;
    errMsg.classList.remove('hidden');
    infoMsg.classList.add('hidden');
  }
  function showInfo(msg) {
    infoMsg.textContent = msg;
    infoMsg.classList.remove('hidden');
    errMsg.classList.add('hidden');
  }
  function clearMsgs() {
    errMsg.classList.add('hidden');
    infoMsg.classList.add('hidden');
  }

  // Afficher / masquer les deux champs ensemble
  toggle1.addEventListener('click', () => {
    const show = p1.type === 'password';
    p1.type = show ? 'text' : 'password';
    p2.type = show ? 'text' : 'password';
    const icon = toggle1.querySelector('i');
    icon.classList.toggle('fa-eye', !show);
    icon.classList.toggle('fa-eye-slash', show);
    const l = show ? 'Masquer les mots de passe' : 'Afficher les mots de passe';
    toggle1.setAttribute('aria-label', l); toggle1.title = l;
  });

  function updateMatch() {
    if (!p2.value) { matchLabel.textContent = ''; return; }
    const same = p1.value === p2.value;
    matchLabel.textContent = same ? '✓ Les deux saisies sont identiques.' : 'Les deux saisies sont différentes.';
    matchLabel.style.color = same ? '#6ee7b7' : '#fca5a5';
  }
  p2.addEventListener('input', updateMatch);
  p1.addEventListener('input', updateMatch);

  // Indicateur de force (basique, heuristique)
  function strength(pw) {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 8) score += 1;
    if (pw.length >= 12) score += 1;
    if (pw.length >= 16) score += 1;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
    if (/\d/.test(pw)) score += 1;
    if (/[^A-Za-z0-9]/.test(pw)) score += 1;
    return Math.min(score, 5);
  }
  const STRENGTH_STYLES = [
    { w: '0%',   c: 'bg-red-500',    t: 'Trop court' },
    { w: '20%',  c: 'bg-red-500',    t: 'Très faible' },
    { w: '40%',  c: 'bg-orange-500', t: 'Faible' },
    { w: '60%',  c: 'bg-yellow-500', t: 'Moyen' },
    { w: '80%',  c: 'bg-lime-500',   t: 'Bon' },
    { w: '100%', c: 'bg-green-500',  t: 'Excellent' },
  ];

  p1.addEventListener('input', () => {
    const s = strength(p1.value);
    const cfg = STRENGTH_STYLES[s];
    bar.className = `h-full transition-all ${cfg.c}`;
    bar.style.width = cfg.w;
    label.textContent = p1.value.length < 12
      ? `Au moins 12 caractères (${p1.value.length}/12)`
      : `Solidité : ${cfg.t}`;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMsgs();

    const v1 = p1.value;
    const v2 = p2.value;

    if (v1.length < 12) { showError('Le mot de passe maître doit faire au moins 12 caractères.'); p1.focus(); return; }
    if (v1 !== v2)     { showError('Les deux saisies sont différentes. Retapez le même mot de passe dans les deux champs.'); p2.focus(); return; }
    if (!ack.checked)  { showError('Cochez la case pour confirmer que vous avez compris que ce mot de passe ne peut pas être récupéré.'); ack.focus(); return; }
    if (strength(v1) < 3) {
      const go = await window.Passory.confirm({
        title: 'Mot de passe faible',
        message: 'Ce mot de passe est facile à deviner. Ajoutez des mots, des chiffres ou des symboles pour mieux protéger votre coffre.\n\nL\'utiliser quand même ?',
        confirmLabel: 'Utiliser quand même', cancelLabel: 'Le renforcer',
      });
      if (!go) { p1.focus(); return; }
    }

    submitBtn.disabled = true;
    showInfo('Création du coffre… (quelques secondes)');

    try {
      const res = await window.passory.auth.createMaster(v1);
      if (res && res.success) {
        p1.value = ''; p2.value = '';
        window.Passory.setLastBackup(0); // nouveau coffre : aucune sauvegarde encore
        showInfo('Coffre créé.');
        setTimeout(() => window.Passory.goto('dashboard.html?bienvenue=1' + (restarted ? '&repartir=1' : '')), 300);
      } else {
        submitBtn.disabled = false;
        showError(window.Passory.friendlyError(res, 'La création du coffre a échoué. Réessayez.'));
      }
    } catch (err) {
      submitBtn.disabled = false;
      showError('La création du coffre a échoué. Redémarrez Passory puis réessayez.');
    }
  });
})();
