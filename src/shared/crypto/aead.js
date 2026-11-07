/**
 * Chiffrement du coffre — format v2 (remplace le « multi-couches » v1).
 *
 * Une seule couche AES-256-GCM (Web Crypto), clé dérivée de la clé maître par
 * HKDF-SHA256 avec un label de domaine, IV aléatoire de 96 bits par message, et
 * données associées (AAD) qui lient le chiffré à son contexte (id + type de
 * l'élément, vérificateur, sauvegarde). Échanger deux chiffrés entre éléments,
 * ou changer le type d'un élément, fait échouer le déchiffrement (audit M1).
 *
 * Sortie : { iv: hex(12), ct: hex(ciphertext || tag 16) }
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./random.js'));
  else root.PassoryAEAD = factory(root.PassoryRandom);
})(typeof self !== 'undefined' ? self : this, function (R) {

  const KEY_LENGTH = 32;
  const IV_LENGTH = 12;
  const VERIFIER_PLAINTEXT = 'passory-check-v2';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function assertKey(k) {
    if (!(k instanceof Uint8Array) || k.length !== KEY_LENGTH) {
      throw new TypeError('clé : Uint8Array de 32 octets requis');
    }
  }

  async function subkey(masterKey, label, usage) {
    assertKey(masterKey);
    const ikm = await crypto.subtle.importKey('raw', masterKey, { name: 'HKDF' }, false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('passory-v2|' + label) },
      ikm, { name: 'AES-GCM', length: 256 }, false, [usage]
    );
  }

  async function encrypt(masterKey, plaintext, aad, label = 'vault') {
    const key = await subkey(masterKey, label, 'encrypt');
    const iv = R.randomBytes(IV_LENGTH);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(aad), tagLength: 128 },
      key, typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext
    ));
    return { iv: R.bytesToHex(iv), ct: R.bytesToHex(ct) };
  }

  /** Lève si la clé, l'AAD, l'IV ou le chiffré ne correspondent pas. */
  async function decrypt(masterKey, box, aad, label = 'vault') {
    if (!box || typeof box.iv !== 'string' || typeof box.ct !== 'string') throw new Error('chiffré invalide');
    const iv = R.hexToBytes(box.iv);
    if (iv.length !== IV_LENGTH) throw new Error('IV invalide');
    const key = await subkey(masterKey, label, 'decrypt');
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(aad), tagLength: 128 },
      key, R.hexToBytes(box.ct)
    );
    return dec.decode(pt);
  }

  // Contextes AAD normalisés
  const aadItem = (id, type) => `passory|item|v2|${id}|${type}`;
  const AAD_VERIFIER = 'passory|verifier|v2';
  const AAD_BACKUP = 'passory|backup|v2';

  function makeVerifier(masterKey) { return encrypt(masterKey, VERIFIER_PLAINTEXT, AAD_VERIFIER); }

  async function checkVerifier(verifier, masterKey) {
    try { return (await decrypt(masterKey, verifier, AAD_VERIFIER)) === VERIFIER_PLAINTEXT; }
    catch { return false; }
  }

  return { encrypt, decrypt, aadItem, AAD_VERIFIER, AAD_BACKUP, makeVerifier, checkVerifier, KEY_LENGTH };
});
