/**
 * TESTS UNIQUEMENT — fabrique des données au format v1 « multi-couches ».
 *
 * Passory n'écrit plus jamais ce format (audit M1). Ce fichier est l'ancien
 * module Node natif (ex-crypto/crypto.js, node:crypto) réduit au strict
 * nécessaire pour forger des coffres et sauvegardes v1 factices, afin de
 * vérifier que src/shared/crypto/legacy-v1.js (Web Crypto, lecture seule)
 * sait toujours les relire. Implémentation indépendante : un écart de format
 * entre les deux ferait échouer les tests.
 *
 * Ne pas importer depuis le code de l'application.
 */
'use strict';
const crypto = require('node:crypto');

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const VERIFIER_PLAINTEXT = 'passory-check-v1';

function toBuffer(k) {
  const b = Buffer.isBuffer(k) ? k : Buffer.from(k.buffer, k.byteOffset, k.byteLength);
  if (b.length !== KEY_LENGTH) throw new Error('clé de 32 octets requise');
  return b;
}

function deriveLayerKey(masterKey, layerSalt, layerIndex) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, layerSalt,
    Buffer.from(`passory-layer-${layerIndex}`), KEY_LENGTH));
}

/** Chiffre en `layers` couches (format v1). Accepte Buffer ou Uint8Array. */
function encryptMultiLayer(plaintext, masterKey, layers = 5) {
  const mk = toBuffer(masterKey);
  let data = plaintext;
  const out = [];
  for (let i = 0; i < layers; i++) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveLayerKey(mk, salt, i), iv);
    let enc = cipher.update(data, 'utf8', 'hex');
    enc += cipher.final('hex');
    const layer = { salt: salt.toString('hex'), iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), encryptedData: enc };
    out.push(layer);
    data = JSON.stringify(layer); // la sortie d'une couche est l'entrée de la suivante
  }
  return out;
}

function makeVerifier(masterKey, layers = 5) {
  return encryptMultiLayer(VERIFIER_PLAINTEXT, masterKey, layers);
}

function generateSalt() {
  return new Uint8Array(crypto.randomBytes(SALT_LENGTH));
}

module.exports = { encryptMultiLayer, makeVerifier, generateSalt, VERIFIER_PLAINTEXT };
