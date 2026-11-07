/**
 * Argon2id provider — implémentation Electron (Node natif).
 *
 * Fournit la signature attendue par src/shared/crypto/kdf.js :
 *   async hash(password: string, salt: Uint8Array, opts): Promise<Uint8Array>
 *
 * Wrap la lib `argon2` (binding natif C) qui produit un Buffer 32 octets
 * quand on lui passe `raw: true`. Le kdf shared attend du Uint8Array, et
 * Buffer hérite de Uint8Array donc c'est compatible tel quel — on normalise
 * quand même pour être explicite.
 *
 * Usage au boot Electron :
 *   const { setProvider } = require('./src/shared/crypto/kdf.js');
 *   const provider = require('./platform/electron/argon2-provider.js');
 *   setProvider(provider);
 */
'use strict';

const argon2 = require('argon2');

const TYPE_MAP = {
  argon2id: argon2.argon2id,
  argon2i:  argon2.argon2i,
  argon2d:  argon2.argon2d,
};

module.exports = {
  /**
   * @param {string} password       texte clair
   * @param {Uint8Array} salt       sel (≥ 8 octets)
   * @param {object} opts           { timeCost, memoryCost, parallelism, hashLength, type }
   * @returns {Promise<Uint8Array>} hash brut
   */
  async hash(password, salt, opts) {
    const nodeSalt = Buffer.from(salt.buffer, salt.byteOffset, salt.byteLength);
    const type = TYPE_MAP[opts.type] !== undefined ? TYPE_MAP[opts.type] : argon2.argon2id;
    const buf = await argon2.hash(password, {
      type,
      timeCost: opts.timeCost,
      memoryCost: opts.memoryCost,
      parallelism: opts.parallelism,
      hashLength: opts.hashLength,
      salt: nodeSalt,
      raw: true,
    });
    // Normalise Buffer → Uint8Array (même sous-jacent, juste le "type" TS/JS).
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  },
};
