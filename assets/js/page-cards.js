'use strict';
// Extrait de cards.html (CSP : plus de script inline).
    // Live card preview
    document.addEventListener('DOMContentLoaded', () => {
      const number  = document.getElementById('m-number');
      const holder  = document.getElementById('m-holder');
      const expiry  = document.getElementById('m-expiry');
      const preview = document.getElementById('card-preview');
      const pNum    = document.getElementById('preview-number');
      const pHolder = document.getElementById('preview-holder');
      const pExpiry = document.getElementById('preview-expiry');
      const pNet    = document.getElementById('preview-network');

      function updatePreview() {
        if (!preview) return;
        const P = window.Passory;
        const net = P.detectCardNetwork(number.value);
        preview.className = 'credit-card ' + P.cardCssClass(net);
        const digits = (number.value || '').replace(/\D/g,'');
        pNum.textContent   = digits ? P.formatCardNumber(digits) : '•••• •••• •••• ••••';
        pHolder.textContent= (holder.value || 'PRÉNOM NOM').toUpperCase();
        pExpiry.textContent= expiry.value || 'MM/AA';
        pNet.textContent   = net;
        if (document.getElementById('m-network'))
          document.getElementById('m-network').textContent = net;
      }

      if (number)  number.addEventListener('input', updatePreview);
      if (holder)  holder.addEventListener('input', updatePreview);
      if (expiry)  expiry.addEventListener('input', updatePreview);
    });
  
