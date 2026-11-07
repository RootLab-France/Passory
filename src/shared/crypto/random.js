/**
 * CSPRNG unifié — portable Electron (renderer + main Node 19+) et WebView mobile.
 *
 * Tous les appels passent par `globalThis.crypto.getRandomValues` qui est
 * fourni par :
 *  - Chromium (Electron renderer, Android WebView)
 *  - WKWebView (iOS)
 *  - Node.js ≥ 19 via crypto.webcrypto (l'alias globalThis.crypto est ajouté
 *    automatiquement depuis Node 19).
 *
 * Pour Node < 19 il faut polyfill avant d'importer ce module :
 *   globalThis.crypto = require('node:crypto').webcrypto;
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryRandom = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function assertCrypto() {
    if (typeof globalThis === 'undefined' || !globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
      throw new Error('CSPRNG indisponible : globalThis.crypto.getRandomValues requis');
    }
  }

  /** Retourne un Uint8Array de `n` octets cryptographiquement aléatoires. */
  function randomBytes(n) {
    assertCrypto();
    if (!Number.isInteger(n) || n < 1 || n > 65536) {
      throw new RangeError('randomBytes: n doit être un entier 1..65536');
    }
    const buf = new Uint8Array(n);
    globalThis.crypto.getRandomValues(buf);
    return buf;
  }

  /**
   * Entier uniforme dans [min, max] (bornes incluses). Utilise la méthode
   * "rejection sampling" pour éviter le biais modulaire.
   */
  function randomInt(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max)) throw new TypeError('bornes entières');
    if (min > max) throw new RangeError('min > max');
    const range = max - min + 1;
    if (range <= 0 || range > 0xffffffff) throw new RangeError('range trop grand');
    const maxUnbiased = Math.floor(0x100000000 / range) * range;
    // On tire un uint32 jusqu'à tomber dans la plage non biaisée
    const buf = new Uint8Array(4);
    // Limite de sécurité : 1000 tirages (probabilité de rejet très faible)
    for (let i = 0; i < 1000; i++) {
      globalThis.crypto.getRandomValues(buf);
      // Important : le OR bitwise en JS retourne un int32 signé ; si le bit
      // de poids fort est à 1, le résultat est négatif. Le `>>> 0` final
      // force la valeur à un uint32 positif, sinon v % range peut devenir
      // négatif et indexer un tableau hors plage.
      const v = (((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0);
      if (v < maxUnbiased) return min + (v % range);
    }
    throw new Error('randomInt: échec de rejection sampling');
  }

  /** Mélange Fisher-Yates d'un tableau (in-place) avec CSPRNG. */
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randomInt(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Encode un Uint8Array en hex minuscule. */
  function bytesToHex(bytes) {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  /** Décode une chaîne hex (pair de chars) en Uint8Array. */
  function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0) {
      throw new TypeError('hexToBytes: chaîne hex de longueur paire requise');
    }
    const n = hex.length / 2;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const byte = parseInt(hex.substr(i * 2, 2), 16);
      if (Number.isNaN(byte)) throw new TypeError('hexToBytes: caractère non-hex');
      out[i] = byte;
    }
    return out;
  }

  return { randomBytes, randomInt, shuffle, bytesToHex, hexToBytes };
});
