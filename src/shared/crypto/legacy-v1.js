/**
 * Lecture SEULE de l'ancien format « multi-couches » (v1).
 *
 * Passory ne chiffre plus jamais dans ce format (audit M1 : empiler N couches
 * AES-GCM dérivées de la même clé maître n'apporte rien). Ce module sert
 * uniquement à :
 *   - vérifier le mot de passe d'un coffre v1 (master.vault → verifier) puis
 *     déchiffrer ses éléments, pour la migration automatique v1 → v2 ;
 *   - déchiffrer les anciennes sauvegardes v1 à l'import.
 *
 * Format v1 : tableau de couches { salt, iv, tag, encryptedData } (hex). La
 * couche i est chiffrée en AES-256-GCM avec une sous-clé HKDF-SHA256
 * (sel = salt, info = "passory-layer-<i>") ; son entrée est le JSON de la
 * couche i-1 (le texte clair pour i = 0). On déchiffre donc de la dernière
 * couche vers la première.
 *
 * Le chiffrement actuel est dans aead.js (format v2, une couche + AAD).
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./random.js'));
  else root.PassoryLegacyV1 = factory(root.PassoryRandom);
})(typeof self !== 'undefined' ? self : this, function (R) {

  const KEY_LENGTH = 32;
  const IV_LENGTH = 12;
  const TAG_LENGTH = 16;
  // Borne de sécurité : les anciennes versions écrivaient 3 à 10 couches.
  // Au-delà, le fichier est forcément forgé (évite un travail démesuré).
  const MAX_READ_LAYERS = 16;
  const VERIFIER_PLAINTEXT = 'passory-check-v1';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function assertMasterKey(k) {
    if (!(k instanceof Uint8Array) || k.length !== KEY_LENGTH) {
      throw new TypeError('masterKey doit être un Uint8Array de 32 octets');
    }
  }

  function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  async function deriveLayerKey(masterKey, layerSalt, layerIndex) {
    const ikm = await crypto.subtle.importKey('raw', masterKey, { name: 'HKDF' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: layerSalt, info: encoder.encode(`passory-layer-${layerIndex}`) },
      ikm, KEY_LENGTH * 8
    );
    return new Uint8Array(bits);
  }

  /** Déchiffre un tableau de couches v1. Lève si la clé ou les données sont invalides. */
  async function decrypt(encryptedLayers, masterKey) {
    assertMasterKey(masterKey);
    if (!Array.isArray(encryptedLayers) || encryptedLayers.length === 0
        || encryptedLayers.length > MAX_READ_LAYERS) {
      throw new Error('données v1 invalides');
    }
    let dataBytes = null;
    for (let i = encryptedLayers.length - 1; i >= 0; i--) {
      const layer = encryptedLayers[i];
      if (!layer || typeof layer !== 'object') throw new Error('couche v1 invalide');
      const iv = R.hexToBytes(layer.iv);
      const tag = R.hexToBytes(layer.tag);
      if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) throw new Error('couche v1 invalide');
      const keyBytes = await deriveLayerKey(masterKey, R.hexToBytes(layer.salt), i);
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
      keyBytes.fill(0);
      dataBytes = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, tagLength: TAG_LENGTH * 8 }, key,
        concatBytes(R.hexToBytes(layer.encryptedData), tag)
      ));
    }
    return decoder.decode(dataBytes);
  }

  function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /** Vérifie le mot de passe d'un coffre v1 (verifier de master.vault). */
  async function checkVerifier(verifier, masterKey) {
    try {
      return timingSafeEqual(await decrypt(verifier, masterKey), VERIFIER_PLAINTEXT);
    } catch {
      return false;
    }
  }

  return { decrypt, checkVerifier, KEY_LENGTH };
});
