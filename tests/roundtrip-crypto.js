/**
 * Compatibilité du format v1 « multi-couches » (lecture seule).
 *
 * Passory n'écrit plus ce format (audit M1) mais doit toujours relire les
 * anciens coffres (migration v1 → v2) et les anciennes sauvegardes v1.
 * src/shared/crypto/legacy-v1.js (Web Crypto) est confronté à :
 *   - tests/helpers/legacy-v1-encrypt.js : ancien module Node natif
 *     (ex-crypto/crypto.js), implémentation indépendante ;
 *   - tests/fixtures/vault-v1-multicouche.json : coffre v1 figé, produit par
 *     l'ancien code Web Crypto avant sa suppression.
 *
 * Exécution :  npm test   (ou)  node tests/roundtrip-crypto.js
 */
'use strict';

if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

const assert = require('node:assert/strict');

const forge = require('./helpers/legacy-v1-encrypt.js');      // TESTS : écrit du v1
const legacyV1 = require('../src/shared/crypto/legacy-v1.js'); // appli : lit le v1
const sharedRand = require('../src/shared/crypto/random.js');
const sharedKDF = require('../src/shared/crypto/kdf.js');
const sharedIban = require('../src/shared/validators/iban.js');
const sharedCard = require('../src/shared/validators/card.js');
const sharedGen  = require('../src/shared/generator.js');
sharedKDF.setProvider(require('../platform/electron/argon2-provider.js'));

async function testReadsNativeV1() {
  console.log('[1] legacy-v1 déchiffre un v1 produit par l\'ancien module natif (3, 5 et 10 couches)...');
  for (const n of [3, 5, 10]) {
    const key = sharedRand.randomBytes(32);
    const plaintext = 'payload-v1 ~ accents éàü ' + n;
    const layers = forge.encryptMultiLayer(plaintext, key, n);
    assert.equal(layers.length, n);
    assert.equal(await legacyV1.decrypt(layers, key), plaintext);
  }
  console.log('    OK');
}

async function testVerifier() {
  console.log('[2] verifier v1 : bonne clé acceptée, mauvaise refusée...');
  const key = sharedRand.randomBytes(32);
  const v = forge.makeVerifier(key, 5);
  assert.equal(await legacyV1.checkVerifier(v, key), true);
  assert.equal(await legacyV1.checkVerifier(v, sharedRand.randomBytes(32)), false);
  assert.equal(await legacyV1.checkVerifier(forge.encryptMultiLayer('autre', key, 3), key), false);
  console.log('    OK');
}

async function testRejects() {
  console.log('[3] mauvaise clé, couche altérée, structure invalide → échec...');
  const k1 = sharedRand.randomBytes(32);
  const layers = forge.encryptMultiLayer('secret', k1, 3);
  await assert.rejects(legacyV1.decrypt(layers, sharedRand.randomBytes(32)));
  const tampered = JSON.parse(JSON.stringify(layers)); tampered[1].tag = '00'.repeat(16);
  await assert.rejects(legacyV1.decrypt(tampered, k1));
  const swapped = [layers[1], layers[0], layers[2]];
  await assert.rejects(legacyV1.decrypt(swapped, k1));
  await assert.rejects(legacyV1.decrypt([], k1));
  await assert.rejects(legacyV1.decrypt(new Array(17).fill(layers[0]), k1), /invalides/);
  await assert.rejects(legacyV1.decrypt(layers, new Uint8Array(16)));
  console.log('    OK');
}

async function testGoldenVault() {
  console.log('[4] coffre v1 figé (ancien code Web Crypto) toujours lisible...');
  const fx = require('./fixtures/vault-v1-multicouche.json');
  const m = fx['master.vault'];
  const key = await sharedKDF.deriveMasterKey(fx.password, sharedRand.hexToBytes(m.saltHex));
  assert.equal(await legacyV1.checkVerifier(m.verifier, key), true);
  const titles = [];
  for (const e of fx['items.vault']) titles.push(JSON.parse(await legacyV1.decrypt(e.data, key)).title);
  assert.deepEqual(titles, ['T1', 'T2']);
  console.log('    OK');
}

function testNoEncryption() {
  console.log('[5] le module de l\'appli ne sait plus chiffrer en multi-couches...');
  assert.deepEqual(Object.keys(legacyV1).sort(), ['KEY_LENGTH', 'checkVerifier', 'decrypt']);
  console.log('    OK');
}

function testValidators() {
  console.log('[6] validators iban/card/generator...');
  // IBAN français exemple officiel doc
  assert.equal(sharedIban.validate('FR14 2004 1010 0505 0001 3M02 606'), true);
  assert.equal(sharedIban.validate('FR14 2004 1010 0505 0001 3M02 607'), false);
  // Luhn
  assert.equal(sharedCard.validateLuhn('4539 1488 0343 6467'), true);  // Visa test
  assert.equal(sharedCard.validateLuhn('1234 5678 9012 3456'), false);
  assert.equal(sharedCard.detectNetwork('4111111111111111'), 'Visa');
  assert.equal(sharedCard.detectNetwork('5105105105105100'), 'Mastercard');
  assert.equal(sharedCard.detectNetwork('378282246310005'),  'Amex');
  // Générateur
  const pwd = sharedGen.make({ length: 20, upper: true, lower: true, digits: true, symbols: true });
  assert.equal(pwd.length, 20, 'longueur demandée');
  assert.ok(/[A-Z]/.test(pwd), 'au moins 1 upper');
  assert.ok(/[a-z]/.test(pwd), 'au moins 1 lower');
  assert.ok(/[0-9]/.test(pwd), 'au moins 1 digit');
  assert.ok(/[^A-Za-z0-9]/.test(pwd), 'au moins 1 symbol');
  console.log('    OK');
}

(async function main() {
  try {
    await testReadsNativeV1();
    await testVerifier();
    await testRejects();
    await testGoldenVault();
    testNoEncryption();
    testValidators();
    console.log('\n✓ Format v1 (lecture seule) : tous les tests OK.');
    process.exit(0);
  } catch (err) {
    console.error('\n✗ Échec :', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
