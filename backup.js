/**
 * Module de sauvegarde chiffrée Passory — pure logique crypto + sérialisation.
 *
 * Une sauvegarde est un JSON autonome, chiffré par une phrase de passe choisie
 * au moment de l'export (indépendante du mot de passe maître courant).
 *
 * Format v3 (écrit) :
 * {
 *   "app": "passory", "version": 3, "createdAt": <ms>,
 *   "cipher": "AES-256-GCM",
 *   "kdf": { "alg": "argon2id", "memoryCost", "timeCost", "parallelism", "saltHex" },
 *   "payload": { "iv", "ct" }
 * }
 * - clé : argon2id(phrase de passe, sel aléatoire de 16 octets, paramètres
 *   stockés dans "kdf"), puis sous-clé HKDF de domaine « backup » (aead.js) ;
 * - une seule couche AES-256-GCM, IV aléatoire de 96 bits ;
 * - AAD = backupAad(en-tête) : lie l'application, la version, le chiffrement,
 *   les paramètres KDF, le sel et la date. Toute modification de l'en-tête
 *   fait échouer le déchiffrement.
 *
 * Formats encore LUS à l'import (jamais écrits) :
 * - v2 : même chose sans "cipher", AAD fixe "passory|backup|v2", sous-clé « vault » ;
 * - v1 : ancien « multi-couches » (saltHex, layers, payload = tableau de
 *   couches), lu par src/shared/crypto/legacy-v1.js.
 *
 * Le payload contient UNIQUEMENT les éléments déchiffrés puis ré-chiffrés
 * sous la phrase de passe de la sauvegarde : aucune dépendance au mot de passe
 * maître courant.
 *
 * Ce module NE touche PAS fs / Filesystem : il renvoie des chaînes et
 * l'appelant écrit via le StorageAdapter (pickSaveFile / pickOpenFile).
 */

'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Polyfill WebCrypto global pour Node (aligné avec main.js)
    if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
      globalThis.crypto = require('node:crypto').webcrypto;
    }
    module.exports = factory(
      require('./src/shared/crypto/legacy-v1.js'),
      require('./src/shared/crypto/kdf.js'),
      require('./src/shared/crypto/random.js'),
      require('./src/shared/crypto/aead.js')
    );
  } else {
    root.PassoryBackup = factory(root.PassoryLegacyV1, root.PassoryKDF, root.PassoryRandom, root.PassoryAEAD);
  }
})(typeof self !== 'undefined' ? self : this, function (LegacyV1, sharedKDF, sharedRng, AEAD) {

const BACKUP_VERSION = 3;
const BACKUP_APP = 'passory';
const BACKUP_CIPHER = 'AES-256-GCM';
const BACKUP_KEY_LABEL = 'backup'; // domaine HKDF de la sous-clé (aead.js)
const SALT_LENGTH = 16;
const ALLOWED_TYPES = ['password', 'card', 'iban', 'note', 'identity'];

// Bornes KDF à l'import : un fichier piégé ne doit pas pouvoir imposer un KDF
// trop faible (la clé ne correspondrait pas de toute façon) ni démesuré (DoS).
// Bornes à l'import : l'export écrit toujours 64 Mio, t=3, p=1. Des bornes larges
// permettraient à un fichier piégé de bloquer l'appli (argon2 à 1 Gio, t=20).
const KDF_BOUNDS = {
  memoryCost: [19456, 262144],
  timeCost: [2, 10],
  parallelism: [1, 4],
};

function isHex(s) { return typeof s === 'string' && s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s); }
function inBounds(v, [min, max]) { return Number.isInteger(v) && v >= min && v <= max; }

/**
 * AAD du format v3 : chaîne canonique de l'en-tête (ordre fixe, pas de JSON
 * pour ne pas dépendre de l'ordre des clés).
 */
function backupAad(h) {
  return ['passory', 'backup', 'v' + h.version, h.cipher, h.kdf.alg,
    'm=' + h.kdf.memoryCost, 't=' + h.kdf.timeCost, 'p=' + h.kdf.parallelism,
    's=' + h.kdf.saltHex.toLowerCase(), 'c=' + h.createdAt].join('|');
}

/**
 * Encode une sauvegarde (format v3) en JSON chiffré.
 * @param {object} p
 * @param {string} p.passphrase     12 caractères minimum
 * @param {Array}  p.clearItems     [{ type, createdAt, updatedAt, payload }]
 * @returns {Promise<{content: string, count: number}>}
 */
async function encodeBackup({ passphrase, clearItems }) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) {
    throw new Error('Phrase de passe d\'export trop courte (12 caractères minimum).');
  }
  if (!Array.isArray(clearItems)) throw new TypeError('clearItems doit être un tableau');
  const salt = sharedRng.randomBytes(SALT_LENGTH);
  const d = sharedKDF.DEFAULT_OPTS;
  const header = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    cipher: BACKUP_CIPHER,
    kdf: { alg: 'argon2id', memoryCost: d.memoryCost, timeCost: d.timeCost,
           parallelism: d.parallelism, saltHex: sharedRng.bytesToHex(salt) },
  };
  const key = await sharedKDF.deriveMasterKey(passphrase, salt, {
    memoryCost: d.memoryCost, timeCost: d.timeCost, parallelism: d.parallelism,
  });
  try {
    const body = JSON.stringify({ items: clearItems });
    const payload = await AEAD.encrypt(key, body, backupAad(header), BACKUP_KEY_LABEL);
    return { content: JSON.stringify({ ...header, payload }, null, 2), count: clearItems.length };
  } finally {
    key.fill(0);
  }
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) throw new Error('Backup mal formé.');
  return items.filter((it) => it && ALLOWED_TYPES.includes(it.type)
    && it.payload && typeof it.payload === 'object' && !Array.isArray(it.payload));
}

/** Paramètres KDF d'un en-tête v2/v3, validés (lève « Backup corrompu. »). */
function kdfOptsFrom(k, strict) {
  if (!k || k.alg !== 'argon2id' || !isHex(k.saltHex) || k.saltHex.length < 32) throw new Error('Backup corrompu.');
  if (strict) {
    if (!inBounds(k.memoryCost, KDF_BOUNDS.memoryCost) || !inBounds(k.timeCost, KDF_BOUNDS.timeCost)
        || !inBounds(k.parallelism, KDF_BOUNDS.parallelism)) {
      throw new Error('Paramètres de dérivation de la sauvegarde hors limites.');
    }
    return { memoryCost: k.memoryCost, timeCost: k.timeCost, parallelism: k.parallelism };
  }
  // v2 : comportement historique (valeurs ramenées dans les bornes).
  const clamp = (v, [min, max]) => Math.min(Math.max(v | 0, min), max);
  return {
    memoryCost: clamp(k.memoryCost, KDF_BOUNDS.memoryCost),
    timeCost: clamp(k.timeCost, KDF_BOUNDS.timeCost),
    parallelism: clamp(k.parallelism, KDF_BOUNDS.parallelism),
  };
}

/**
 * Déchiffre une sauvegarde (v3, v2 ou v1) et retourne les éléments en clair.
 * @param {object} p
 * @param {string} p.passphrase
 * @param {string} p.content   contenu brut du fichier
 * @returns {Promise<{items: Array, total: number, version: number, createdAt: number}>}
 */
async function decodeBackup({ passphrase, content }) {
  let obj;
  try { obj = JSON.parse(content); }
  catch { throw new Error('Fichier de backup invalide (JSON).'); }
  if (!obj || obj.app !== BACKUP_APP) throw new Error('Fichier de backup invalide.');
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('Phrase de passe requise.');

  let clear, key;
  try {
    if (obj.version === 3) {
      if (obj.cipher !== BACKUP_CIPHER || !Number.isSafeInteger(obj.createdAt) || !obj.payload) {
        throw new Error('Backup corrompu.');
      }
      const opts = kdfOptsFrom(obj.kdf, true);
      key = await sharedKDF.deriveMasterKey(passphrase, sharedRng.hexToBytes(obj.kdf.saltHex), opts);
      try { clear = await AEAD.decrypt(key, obj.payload, backupAad(obj), BACKUP_KEY_LABEL); }
      catch { throw new Error('Phrase de passe incorrecte ou fichier corrompu.'); }
    } else if (obj.version === 2) {
      if (!obj.payload) throw new Error('Backup corrompu.');
      const opts = kdfOptsFrom(obj.kdf, false);
      key = await sharedKDF.deriveMasterKey(passphrase, sharedRng.hexToBytes(obj.kdf.saltHex), opts);
      try { clear = await AEAD.decrypt(key, obj.payload, AEAD.AAD_BACKUP); }
      catch { throw new Error('Phrase de passe incorrecte ou fichier corrompu.'); }
    } else if (obj.version === 1) {
      if (!isHex(obj.saltHex) || !Array.isArray(obj.payload)) throw new Error('Backup corrompu.');
      // v1 : paramètres argon2id par défaut de l'époque (identiques à DEFAULT_OPTS).
      key = await sharedKDF.deriveMasterKey(passphrase, sharedRng.hexToBytes(obj.saltHex));
      try { clear = await LegacyV1.decrypt(obj.payload, key); }
      catch { throw new Error('Phrase de passe incorrecte ou fichier corrompu.'); }
    } else {
      throw new Error('Version de backup non supportée.');
    }
  } finally {
    if (key && typeof key.fill === 'function') key.fill(0);
  }
  let parsed;
  try { parsed = JSON.parse(clear); } catch { throw new Error('Backup mal formé.'); }
  const all = parsed && Array.isArray(parsed.items) ? parsed.items : null;
  return { items: sanitizeItems(all), total: all ? all.length : 0, version: obj.version, createdAt: obj.createdAt };
}

return {
  encodeBackup,
  decodeBackup,
  backupAad,
  BACKUP_VERSION,
};
});
