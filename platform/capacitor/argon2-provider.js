/**
 * Argon2id provider — implémentation Capacitor (WebView via argon2-browser WASM).
 *
 * Fournit la signature attendue par src/shared/crypto/kdf.js :
 *   async hash(password: string, salt: Uint8Array, opts): Promise<Uint8Array>
 *
 * Contraintes :
 *  - Aucun accès Node (fs, Buffer, etc.) : on tourne en WebView.
 *  - argon2-browser est chargé soit en UMD via <script src="vendor/argon2.js">
 *    soit en ESM via dynamic import. On supporte les deux.
 *  - Les WASM files (argon2.wasm / argon2-simd.wasm) doivent être servis à
 *    côté du bundle JS. Capacitor sert tout depuis la racine du webDir,
 *    donc on les copie dans `vendor/` au build.
 *
 * Usage au boot mobile (dans src/platform/web-bootstrap.js) :
 *   const sharedKDF = require('../shared/crypto/kdf.js');   // UMD → window.PassoryKDF
 *   const argon2Provider = require('../../platform/capacitor/argon2-provider.js');
 *   sharedKDF.setProvider(argon2Provider);
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryArgon2ProviderCapacitor = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // argon2-browser expose des constantes numériques. On s'aligne dessus.
  // Référence : https://github.com/antelle/argon2-browser#argon2typeargon2d
  const TYPE_NUM = { argon2d: 0, argon2i: 1, argon2id: 2 };

  /** Récupère l'objet argon2 disponible. Tente fenêtre globale puis import. */
  async function getArgon2Lib() {
    if (typeof window !== 'undefined' && window.argon2 && typeof window.argon2.hash === 'function') {
      return window.argon2;
    }
    if (typeof self !== 'undefined' && self.argon2 && typeof self.argon2.hash === 'function') {
      return self.argon2;
    }
    // Fallback : dynamic import si on est en ESM-land (bundle Vite/Webpack).
    // En runtime WebView pur sans bundler, cette branche lève — l'appelant
    // doit alors charger argon2-browser via <script> avant setProvider().
    try {
      const mod = await import(/* @vite-ignore */ 'argon2-browser');
      return mod.default || mod;
    } catch (_) {
      throw new Error(
        "argon2-browser indisponible. Inclure <script src=\"vendor/argon2.js\"> avant web-bootstrap.js."
      );
    }
  }

  return {
    /**
     * @param {string} password       texte clair
     * @param {Uint8Array} salt       sel (≥ 8 octets)
     * @param {object} opts           { timeCost, memoryCost, parallelism, hashLength, type }
     * @returns {Promise<Uint8Array>} hash brut
     */
    async hash(password, salt, opts) {
      const argon2 = await getArgon2Lib();
      const typeNum = TYPE_NUM[opts.type] !== undefined ? TYPE_NUM[opts.type] : TYPE_NUM.argon2id;

      // argon2-browser attend :
      //   pass: string | Uint8Array
      //   salt: Uint8Array
      //   time (itérations), mem (Kio), parallelism, hashLen, type
      const result = await argon2.hash({
        pass: password,
        salt: salt,
        time: opts.timeCost,
        mem: opts.memoryCost,
        parallelism: opts.parallelism,
        hashLen: opts.hashLength,
        type: typeNum,
      });

      // result.hash est un Uint8Array dans les builds récents ; on se protège.
      if (result && result.hash instanceof Uint8Array) return result.hash;
      if (result && typeof result.hashHex === 'string') {
        // Conversion hex → Uint8Array (fallback défensif).
        const hex = result.hashHex;
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        return out;
      }
      throw new Error('argon2-browser : format de sortie inattendu.');
    },
  };
});
