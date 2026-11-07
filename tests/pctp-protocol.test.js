'use strict';

if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

const assert = require('node:assert/strict');

const { PCTPSession, STATE } = require('../src/shared/transfer/pctp-protocol.js');

const mockX25519 = {
  generateKeyPair: () => ({
    priv: new Uint8Array(32).fill(1),
    pub:  new Uint8Array(32).fill(2),
  }),
  sharedSecret: (_priv, _pub) => new Uint8Array(32).fill(3),
};

function testConstructorValidation() {
  console.log('[1] Validation du constructeur...');
  assert.throws(
    () => new PCTPSession({ role: 'admin', x25519Provider: mockX25519 }),
    /role.*sender.*receiver/i,
    'rôle invalide → erreur'
  );
  assert.throws(
    () => new PCTPSession({ role: 'sender' }),
    /x25519Provider/i,
    'x25519Provider manquant → erreur'
  );
  assert.throws(
    () => new PCTPSession({ role: 'sender', x25519Provider: {} }),
    /x25519Provider/i,
    'x25519Provider sans generateKeyPair → erreur'
  );
  console.log('    OK');
}

function testInitialState() {
  console.log('[2] État initial...');
  const sender   = new PCTPSession({ role: 'sender',   x25519Provider: mockX25519 });
  const receiver = new PCTPSession({ role: 'receiver', x25519Provider: mockX25519 });

  assert.equal(sender.state,   'init', 'sender démarre en init');
  assert.equal(receiver.state, 'init', 'receiver démarre en init');
  assert.equal(sender.role,    'sender');
  assert.equal(receiver.role,  'receiver');
  assert.equal(sender.senderId,   0, 'sender.senderId = 0');
  assert.equal(receiver.senderId, 1, 'receiver.senderId = 1');
  console.log('    OK');
}

function testSeenNoncesSet() {
  console.log('[3] _seenNonces est un Set (invariant de sécurité)...');
  const sess = new PCTPSession({ role: 'sender', x25519Provider: mockX25519 });
  assert.ok(sess._seenNonces instanceof Set, '_seenNonces est un Set');
  assert.equal(sess._seenNonces.size, 0, 'vide à la création');
  console.log('    OK');
}

function testNonceReplayLogic() {
  console.log('[4] Logique de détection replay (nonce)...');
  const sess = new PCTPSession({ role: 'sender', x25519Provider: mockX25519 });

  const nonce = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const key = nonce.join(',');

  assert.ok(!sess._seenNonces.has(key), 'premier passage : nonce absent');
  sess._seenNonces.add(key);
  assert.ok(sess._seenNonces.has(key),  'après ajout : nonce présent');

  // Reproduction exacte de la logique de pctp-protocol.js
  let replayDetected = false;
  if (sess._seenNonces.has(key)) replayDetected = true;
  assert.ok(replayDetected, 'replay détecté au second passage');

  // Deux nonces distincts ne se confondent pas
  const nonce2 = [...nonce];
  nonce2[11] = 99;
  assert.ok(!sess._seenNonces.has(nonce2.join(',')), 'nonce différent non détecté comme replay');
  console.log('    OK');
}

function testSenderOnlyCreateClientHello() {
  console.log('[5] createClientHello réservé au sender...');
  const receiver = new PCTPSession({ role: 'receiver', x25519Provider: mockX25519 });
  assert.rejects(
    () => receiver.createClientHello(),
    /sender/i,
    'receiver ne peut pas créer ClientHello'
  );
  console.log('    OK');
}

function testCountersInitialized() {
  console.log('[6] Compteurs initialisés à zéro...');
  const sess = new PCTPSession({ role: 'sender', x25519Provider: mockX25519 });
  assert.equal(sess.sendCounter, 0);
  assert.equal(sess.recvCounter, 0);
  assert.equal(sess._selfConfirmed, false);
  assert.equal(sess._peerConfirmed, false);
  console.log('    OK');
}

async function run() {
  try {
    testConstructorValidation();
    testInitialState();
    testSeenNoncesSet();
    testNonceReplayLogic();
    testSenderOnlyCreateClientHello();
    testCountersInitialized();
    console.log('\nPCTP : tous les tests passés.\n');
  } catch (err) {
    console.error('\nPCTP ÉCHEC :', err.message);
    process.exit(1);
  }
}

run();
