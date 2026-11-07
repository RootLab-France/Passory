/**
 * Schéma des items du coffre — partagé toutes plateformes.
 *
 * Types autorisés, validation de structure, génération d'ID.
 * La validation des PAYLOADS (ex : IBAN valide) reste côté UI.
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryItemSchema = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const ALLOWED_TYPES = Object.freeze(['password', 'card', 'iban', 'note', 'identity']);

  /** Génère un ID unique court (timestamp + random). */
  function newId() {
    const t = Date.now().toString(36);
    // 6 chars aléatoires depuis 36 symboles
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let r = '';
    const buf = new Uint8Array(6);
    globalThis.crypto.getRandomValues(buf);
    for (let i = 0; i < 6; i++) r += chars[buf[i] % 36];
    return `${t}-${r}`;
  }

  function isAllowedType(t) {
    return ALLOWED_TYPES.includes(t);
  }

  function isHex(s) { return typeof s === 'string' && s.length > 0 && s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s); }

  /**
   * Valide la structure d'un item persisté. Ne déchiffre rien.
   * `data` :
   *   - format v2 (actuel) : { iv: hex, ct: hex } — une couche AES-256-GCM (aead.js) ;
   *   - format v1 (ancien coffre, lu seulement pour la migration) : tableau
   *     non vide de couches { salt, iv, tag, encryptedData } — accepté
   *     uniquement si `opts.allowLegacyV1` est vrai.
   */
  function validateItem(it, opts = {}) {
    if (!it || typeof it !== 'object') return { ok: false, error: 'item non-objet' };
    if (typeof it.id !== 'string' || it.id.length === 0) return { ok: false, error: 'id manquant' };
    if (!isAllowedType(it.type)) return { ok: false, error: `type inconnu: ${it.type}` };
    const d = it.data;
    const isV2 = !!d && !Array.isArray(d) && typeof d === 'object' && isHex(d.iv) && isHex(d.ct);
    const isV1 = Array.isArray(d) && d.length > 0;
    if (!isV2 && !(opts.allowLegacyV1 && isV1)) {
      return { ok: false, error: opts.allowLegacyV1
        ? 'data doit être un chiffré { iv, ct } (v2) ou un tableau de couches v1'
        : 'data doit être un chiffré { iv, ct }' };
    }
    if (typeof it.createdAt !== 'number' || typeof it.updatedAt !== 'number') return { ok: false, error: 'timestamps manquants' };
    return { ok: true };
  }

  return { ALLOWED_TYPES, newId, isAllowedType, validateItem };
});
