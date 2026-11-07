/**
 * Validation IBAN (mod-97) — portable.
 * Pure fonction, aucune dépendance.
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryIBAN = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /** Formate un IBAN en groupes de 4 (affichage). */
  function format(s) {
    return String(s || '').replace(/\s+/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim();
  }

  /** Masque un IBAN (4 premiers + 4 derniers visibles). */
  function mask(s) {
    const clean = String(s || '').replace(/\s+/g, '').toUpperCase();
    if (clean.length <= 8) return clean;
    const head = clean.slice(0, 4);
    const tail = clean.slice(-4);
    const mid = '•'.repeat(Math.max(0, clean.length - 8));
    return (head + mid + tail).replace(/(.{4})/g, '$1 ').trim();
  }

  /**
   * Valide un IBAN par l'algorithme mod-97 (ISO 13616).
   * Retourne true si l'IBAN est valide, false sinon.
   */
  function validate(s) {
    const iban = String(s || '').replace(/\s+/g, '').toUpperCase();
    if (iban.length < 15 || iban.length > 34) return false;
    if (!/^[A-Z0-9]+$/.test(iban)) return false;

    // Déplace les 4 premiers caractères à la fin
    const rearranged = iban.slice(4) + iban.slice(0, 4);
    // Remplace chaque lettre par son index en base 10 (A=10, B=11, … Z=35)
    let expanded = '';
    for (const c of rearranged) {
      if (c >= '0' && c <= '9') expanded += c;
      else expanded += (c.charCodeAt(0) - 55).toString();
    }
    // Calcul mod 97 itératif (évite BigInt)
    let rem = 0;
    for (let i = 0; i < expanded.length; i++) {
      rem = (rem * 10 + Number(expanded[i])) % 97;
    }
    return rem === 1;
  }

  return { format, mask, validate };
});
