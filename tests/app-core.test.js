'use strict';

/**
 * Tests standalone des algorithmes critiques de app-core.js,
 * sans importer le module lui-même (couplé à Electron/Argon2).
 *
 * Couvre :
 *   - Tableau de délais de rate-limiting (brute-force lockout)
 *   - Logique de détection de replay par Set de nonces
 */

const assert = require('node:assert/strict');

// --- Reproduction exacte du tableau app-core.js:315 et :352 ---
function getRateLimitDelay(failCount) {
  const delays = [0, 0, 1, 2, 5, 10, 30, 60];
  return delays[Math.min(failCount, delays.length - 1)];
}

function testRateLimitDelays() {
  console.log('[1] Délais de rate-limiting...');

  // Deux premières tentatives : pas de délai
  assert.equal(getRateLimitDelay(0), 0,  'échec 0 → 0s');
  assert.equal(getRateLimitDelay(1), 0,  'échec 1 → 0s');

  // Montée progressive
  assert.equal(getRateLimitDelay(2), 1,  'échec 2 → 1s');
  assert.equal(getRateLimitDelay(3), 2,  'échec 3 → 2s');
  assert.equal(getRateLimitDelay(4), 5,  'échec 4 → 5s');
  assert.equal(getRateLimitDelay(5), 10, 'échec 5 → 10s');
  assert.equal(getRateLimitDelay(6), 30, 'échec 6 → 30s');

  // Plafond à 60s dès l'indice 7+
  assert.equal(getRateLimitDelay(7),   60, 'échec 7 → 60s (plafond)');
  assert.equal(getRateLimitDelay(10),  60, 'échec 10 → 60s (clamp)');
  assert.equal(getRateLimitDelay(100), 60, 'échec 100 → 60s (clamp)');

  // Aucun délai négatif possible
  for (let i = 0; i <= 20; i++) {
    assert.ok(getRateLimitDelay(i) >= 0, `délai(${i}) >= 0`);
  }

  // Monotonie : chaque délai ≥ précédent
  let prev = 0;
  for (let i = 0; i <= 10; i++) {
    const d = getRateLimitDelay(i);
    assert.ok(d >= prev, `délai(${i})=${d} >= délai(${i - 1})=${prev}`);
    prev = d;
  }

  console.log('    OK');
}

function testNonceReplayDetection() {
  console.log('[2] Détection replay par Set de nonces...');

  const seen = new Set();

  function processNonce(nonce) {
    const key = nonce.join(',');
    if (seen.has(key)) throw new Error('Replay détecté : nonce déjà vu.');
    seen.add(key);
  }

  const n1 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const n2 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99];

  // Premier usage → OK
  assert.doesNotThrow(() => processNonce(n1), 'premier nonce accepté');
  assert.doesNotThrow(() => processNonce(n2), 'second nonce (distinct) accepté');

  // Replay → throw
  assert.throws(() => processNonce(n1), /Replay/, 'replay n1 détecté');
  assert.throws(() => processNonce(n2), /Replay/, 'replay n2 détecté');

  // Set grandit correctement
  assert.equal(seen.size, 2, 'Set contient exactement 2 nonces uniques');

  // Variante d'un seul octet ≠ replay
  const n3 = [...n1]; n3[0] = 255;
  assert.doesNotThrow(() => processNonce(n3), 'nonce similaire mais distinct → pas de replay');
  assert.equal(seen.size, 3);

  console.log('    OK');
}

function testDelayTableIntegrity() {
  console.log('[3] Intégrité du tableau delays...');
  const delays = [0, 0, 1, 2, 5, 10, 30, 60];

  assert.equal(delays.length, 8, '8 entrées');
  assert.equal(delays[0], 0,  'index 0 = 0');
  assert.equal(delays[delays.length - 1], 60, 'dernier = 60 (max lockout)');

  // Strictement croissant après les deux premiers zéros
  for (let i = 2; i < delays.length; i++) {
    assert.ok(delays[i] > delays[i - 1], `delays[${i}] > delays[${i - 1}]`);
  }

  console.log('    OK');
}

async function run() {
  try {
    testRateLimitDelays();
    testNonceReplayDetection();
    testDelayTableIntegrity();
    console.log('\napp-core (standalone) : tous les tests passés.\n');
  } catch (err) {
    console.error('\napp-core ÉCHEC :', err.message);
    process.exit(1);
  }
}

run();
