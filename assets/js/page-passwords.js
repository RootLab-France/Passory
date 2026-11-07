'use strict';
// Extrait de passwords.html (CSP : plus de script inline).
    // Password strength live update
    document.addEventListener('DOMContentLoaded', () => {
      const pwdInput = document.getElementById('m-password');
      if (pwdInput) {
        pwdInput.addEventListener('input', () => {
          window.Passory.renderStrengthBar(pwdInput, 'strength-wrap');
        });
      }
      // Sort select
      const sortSel = document.getElementById('sort-select');
      if (sortSel) {
        sortSel.addEventListener('change', () => {
          if (window._reloadPasswords) window._reloadPasswords();
        });
      }
    });
  
