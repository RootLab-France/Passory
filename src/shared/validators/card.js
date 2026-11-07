/**
 * Détection et validation de carte bancaire — portable.
 * Réseaux détectés : Visa, Mastercard, Amex, Discover, Diners.
 * Validation du numéro via Luhn.
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryCard = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function format(n) {
    const digits = String(n || '').replace(/\D/g, '');
    return digits.replace(/(.{4})/g, '$1 ').trim();
  }

  function mask(n) {
    const digits = String(n || '').replace(/\D/g, '');
    if (digits.length < 4) return '•'.repeat(digits.length);
    const last4 = digits.slice(-4);
    const masked = '•'.repeat(Math.max(0, digits.length - 4));
    return (masked + last4).replace(/(.{4})/g, '$1 ').trim();
  }

  function detectNetwork(n) {
    const d = String(n || '').replace(/\D/g, '');
    if (/^4\d{0,}$/.test(d)) return 'Visa';
    if (/^(5[1-5]|2[2-7])\d{0,}$/.test(d)) return 'Mastercard';
    if (/^3[47]\d{0,}$/.test(d)) return 'Amex';
    if (/^(6011|65|64[4-9]|622)\d{0,}$/.test(d)) return 'Discover';
    if (/^(30[0-5]|36|38)\d{0,}$/.test(d)) return 'Diners';
    return '';
  }

  /** Validation Luhn (checksum pour numéros de cartes bancaires). */
  function validateLuhn(n) {
    const digits = String(n || '').replace(/\D/g, '');
    if (digits.length < 12 || digits.length > 19) return false;
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = Number(digits[i]);
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  return { format, mask, detectNetwork, validateLuhn };
});
