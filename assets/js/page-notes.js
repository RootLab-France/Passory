'use strict';
// Extrait de notes.html (CSP : plus de script inline).
    // Character counter
    document.addEventListener('DOMContentLoaded', () => {
      const content   = document.getElementById('e-content');
      const charCount = document.getElementById('char-count');
      if (content && charCount) {
        content.addEventListener('input', () => {
          const n = content.value.length;
          charCount.textContent = n > 0 ? `${n} caractère${n > 1 ? 's' : ''}` : '';
        });
      }
    });
  
