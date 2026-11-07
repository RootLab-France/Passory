/**
 * KDF (Key Derivation Function) — argon2id.
 *
 * Cette couche abstraite délègue l'implémentation effective à un "provider"
 * injecté au démarrage, parce qu'argon2id n'est PAS dans Web Crypto :
 *  - Sur Electron (Node.js) : provider = wrapper de `require('argon2')` natif.
 *  - Sur Capacitor (WebView) : provider = wrapper de `argon2-browser` (WASM).
 *
 * L'appelant n'a pas à savoir lequel est utilisé.
 *
 * Usage :
 *   import { setProvider, deriveMasterKey } from 'src/shared/crypto/kdf.js';
 *   setProvider(electronArgon2Provider);   // au démarrage
 *   const key = await deriveMasterKey(password, salt, { memoryCost: 65536 });
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryKDF = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const DEFAULT_OPTS = Object.freeze({
    timeCost: 3,
    memoryCost: 65536,     // 64 MB — ajustable sur mobile bas de gamme
    parallelism: 1,
    hashLength: 32,
    type: 'argon2id',
  });

  let _provider = null;

  /**
   * Enregistre l'implémentation concrète d'argon2id.
   * Le provider doit avoir la signature :
   *   async hash(password: string, salt: Uint8Array, opts): Promise<Uint8Array>
   */
  function setProvider(provider) {
    if (!provider || typeof provider.hash !== 'function') {
      throw new TypeError('provider invalide : .hash(password, salt, opts) requis');
    }
    _provider = provider;
  }

  function hasProvider() { return _provider !== null; }

  /**
   * Dérive la clé maître 32 octets.
   * @param {string} password
   * @param {Uint8Array} salt (au moins 8 octets, idéalement 16)
   * @param {object} [opts] surcharges de DEFAULT_OPTS
   * @returns {Promise<Uint8Array>} clé 32 octets
   */
  async function deriveMasterKey(password, salt, opts = {}) {
    if (!_provider) {
      throw new Error('KDF provider non configuré. Appelle setProvider() au boot.');
    }
    if (typeof password !== 'string' || password.length === 0) {
      throw new TypeError('password: chaîne non vide requise');
    }
    if (!(salt instanceof Uint8Array) || salt.length < 8) {
      throw new TypeError('salt: Uint8Array ≥ 8 octets requis');
    }
    const merged = Object.assign({}, DEFAULT_OPTS, opts);
    const result = await _provider.hash(password, salt, merged);
    if (!(result instanceof Uint8Array) || result.length !== merged.hashLength) {
      throw new Error('provider a retourné un format inattendu');
    }
    return result;
  }

  /**
   * Retourne les paramètres argon2 recommandés selon l'environnement.
   * Sur mobile bas de gamme on réduit le memoryCost, sinon le déverrouillage
   * dure plusieurs secondes.
   */
  function recommendedOpts(deviceClass) {
    // deviceClass ∈ "desktop" | "mobile-high" | "mobile-low"
    switch (deviceClass) {
      case 'mobile-low':  return { memoryCost: 16384, timeCost: 2 }; // 16 MB, t=2
      case 'mobile-high': return { memoryCost: 32768, timeCost: 3 }; // 32 MB, t=3
      case 'desktop':
      default:            return { memoryCost: 65536, timeCost: 3 }; // 64 MB, t=3
    }
  }

  return {
    setProvider,
    hasProvider,
    deriveMasterKey,
    recommendedOpts,
    DEFAULT_OPTS,
  };
});
