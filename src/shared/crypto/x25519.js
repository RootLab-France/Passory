/**
 * X25519 ECDH — wrapper portable pour PCTP (transfert par câble).
 *
 * Ce module expose une interface minimale utilisable par pctp-protocol.js :
 *   - generateKeyPair() → { priv: Uint8Array(32), pub: Uint8Array(32) }
 *   - sharedSecret(priv: Uint8Array, pub: Uint8Array) → Uint8Array(32)
 *
 * Implémentation via @noble/curves/ed25519 (qui expose aussi x25519), lib
 * pur JavaScript auditée (Paul Miller). Fonctionne à l'identique sous :
 *   - Node 20+ (Electron main) : import ESM natif
 *   - Chromium (Electron renderer) : bundle ou import dynamique
 *   - Capacitor Android/iOS WebView : idem
 *
 * On n'utilise PAS Web Crypto pour X25519 parce que :
 *   - SubtleCrypto.deriveBits({name:'X25519'}) n'est supporté que depuis
 *     Chromium 123 (mars 2024) et pas encore dans Node nativement.
 *   - `crypto.diffieHellman` existe en Node mais n'est pas portable WebView.
 * → Un lib pur-JS audité est le plus petit dénominateur commun.
 *
 * Usage type :
 *   const { createX25519Provider } = require('./x25519.js');
 *   const provider = await createX25519Provider();   // async : import dynamique
 *   const { priv, pub } = provider.generateKeyPair();
 *   const shared = provider.sharedSecret(priv, peerPub);
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./random.js'));
  else root.PassoryX25519 = factory(root.PassoryRandom);
})(typeof self !== 'undefined' ? self : this, function (R) {

  /**
   * Crée un provider X25519 en important dynamiquement @noble/curves.
   * Async parce que l'import dynamique ESM est async (et la lib est ESM-only
   * dans ses versions récentes).
   *
   * @returns {Promise<{generateKeyPair: Function, sharedSecret: Function}>}
   */
  async function createX25519Provider() {
    // Import dynamique pour supporter à la fois CommonJS (Electron main) et
    // ESM (WebView mobile bundlée). @noble/curves expose x25519 depuis
    // /ed25519 dans ses versions 1.x.
    let x25519;
    try {
      const mod = await import('@noble/curves/ed25519');
      x25519 = mod.x25519;
    } catch (e) {
      throw new Error(
        '@noble/curves non trouvé. Installe-le via : npm install @noble/curves'
      );
    }

    if (!x25519 || typeof x25519.getPublicKey !== 'function' || typeof x25519.getSharedSecret !== 'function') {
      throw new Error('@noble/curves/ed25519 : export x25519 introuvable ou incompatible');
    }

    return {
      /**
       * Génère une paire de clés éphémère.
       * @returns {{priv: Uint8Array, pub: Uint8Array}}
       */
      generateKeyPair() {
        const priv = R.randomBytes(32);
        const pub = x25519.getPublicKey(priv);
        if (!(pub instanceof Uint8Array) || pub.length !== 32) {
          throw new Error('x25519 : clé publique de taille inattendue');
        }
        return { priv, pub };
      },

      /**
       * Calcule le secret partagé X25519.
       * @param {Uint8Array} priv  clé privée (32 octets)
       * @param {Uint8Array} pub   clé publique du pair (32 octets)
       * @returns {Uint8Array}     secret partagé (32 octets)
       */
      sharedSecret(priv, pub) {
        if (!(priv instanceof Uint8Array) || priv.length !== 32) {
          throw new TypeError('priv: Uint8Array 32 requis');
        }
        if (!(pub instanceof Uint8Array) || pub.length !== 32) {
          throw new TypeError('pub: Uint8Array 32 requis');
        }
        const shared = x25519.getSharedSecret(priv, pub);
        if (!(shared instanceof Uint8Array) || shared.length !== 32) {
          throw new Error('x25519 : secret partagé de taille inattendue');
        }
        // Note : @noble/curves détecte et rejette les "small-subgroup points"
        // (clés publiques qui produiraient un secret nul). Pas besoin de
        // check manuel côté appelant.
        return shared;
      },
    };
  }

  return { createX25519Provider };
});
