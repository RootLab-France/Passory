'use strict';
// Extrait de index.html (CSP : plus de script inline).
    // Surface les erreurs critiques du bootstrap à l'écran pour éviter un
    // splash figé silencieux quand on debug en conditions réelles (sans
    // Chrome DevTools branché).
    function showError(label, err) {
      var pre = document.getElementById('splash-err');
      var msg = document.getElementById('splash-msg');
      if (msg) msg.textContent = 'Erreur : ' + label;
      if (pre) {
        pre.classList.remove('hidden');
        pre.textContent = (err && (err.stack || err.message || String(err))) || '(inconnu)';
      }
    }

    // Filet anti-blocage : si rien n'est prêt au bout de 8 s, on affiche un
    // message plutôt que de laisser le "Chargement…" à vie.
    var bootTimeout = setTimeout(function () {
      showError('le démarrage prend trop de temps. Fermez puis rouvrez Passory.', new Error('passory:ready non émis'));
    }, 8000);

    window.addEventListener('error', function (e) { showError('exception JS globale', e.error || e.message); });
    window.addEventListener('unhandledrejection', function (e) { showError('promise rejetée', e.reason); });

    window.addEventListener('passory:ready', async () => {
      clearTimeout(bootTimeout);
      try {
        const hasMaster = await window.passory.auth.hasMaster();
        if (!hasMaster) {
          window.location.href = 'create-master-password.html';
          return;
        }
        // Si la session persistée est toujours valide (sessionTryResume a
        // tourné pendant le boot), on saute le login et on va au dashboard.
        const unlocked = await window.passory.auth.isUnlocked();
        window.location.href = unlocked ? 'dashboard.html' : 'login.html';
      } catch (err) {
        showError('redirection impossible', err);
      }
    });
  
