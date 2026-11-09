'use strict';

if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

// Stub window pour le IIFE navigateur
if (typeof global.window === 'undefined') global.window = {};
global.window.Passory = global.window.Passory || {};

const assert = require('node:assert/strict');

require('../assets/js/totp.js');
const totp = global.window.Passory.totp;

async function testIsValidBase32() {
  console.log('[1] isValidBase32...');
  assert.ok(totp.isValidBase32('JBSWY3DPEHPK3PXP'), 'majuscules valides');
  assert.ok(totp.isValidBase32('jbswy3dpehpk3pxp'), 'minuscules normalisées');
  assert.ok(totp.isValidBase32('JBSW Y3DP'), 'espaces ignorés');
  assert.ok(totp.isValidBase32('JBSWY3DP==='), 'padding ignoré');
  assert.ok(!totp.isValidBase32(''), 'vide → false');
  assert.ok(!totp.isValidBase32('JBSWY3DP!'), 'caractère interdit → false');
  assert.ok(!totp.isValidBase32('0OI1'), '0/O/I/1 absents de l\'alphabet Base32');
  console.log('    OK');
}

async function testNormalizeBase32() {
  console.log('[2] normalizeBase32...');
  assert.equal(totp.normalizeBase32('jbswy3dp'), 'JBSWY3DP', 'majuscule');
  assert.equal(totp.normalizeBase32(' JB SW Y3 DP '), 'JBSWY3DP', 'espaces retirés');
  assert.equal(totp.normalizeBase32('JBSWY3DP==='), 'JBSWY3DP', 'padding retiré');
  assert.equal(totp.normalizeBase32(''), '', 'vide reste vide');
  console.log('    OK');
}

async function testParseOtpAuthUri() {
  console.log('[3] parseOtpAuthUri...');
  const full = 'otpauth://totp/Alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&period=30&digits=6&algorithm=SHA1';
  const p = totp.parseOtpAuthUri(full);
  assert.ok(p !== null, 'URI complète parsée');
  assert.equal(p.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(p.period, 30);
  assert.equal(p.digits, 6);
  assert.equal(p.algorithm, 'SHA1');
  assert.equal(p.issuer, 'Example');

  const minimal = totp.parseOtpAuthUri('otpauth://totp/test?secret=JBSWY3DP');
  assert.ok(minimal !== null, 'URI minimale parsée');
  assert.equal(minimal.period, 30, 'period par défaut');
  assert.equal(minimal.digits, 6, 'digits par défaut');
  assert.equal(minimal.issuer, '', 'issuer vide par défaut');

  assert.equal(totp.parseOtpAuthUri(null), null, 'null → null');
  assert.equal(totp.parseOtpAuthUri('https://example.com'), null, 'mauvais schéma');
  assert.equal(totp.parseOtpAuthUri('otpauth://totp/test?secret=INVALID!!!'), null, 'secret Base32 invalide');
  assert.equal(totp.parseOtpAuthUri('otpauth://totp/test'), null, 'secret absent');
  console.log('    OK');
}

async function testGenerate() {
  console.log('[4] generate...');
  const secret = 'JBSWY3DPEHPK3PXP';

  const code = await totp.generate(secret);
  assert.ok(code !== null, 'secret valide → non null');
  assert.match(code, /^\d{6}$/, '6 chiffres');

  const code8 = await totp.generate(secret, { digits: 8 });
  assert.match(code8, /^\d{8}$/, '8 chiffres si demandé');

  assert.equal(await totp.generate('NOT_VALID!!!'), null, 'Base32 invalide → null');
  assert.equal(await totp.generate(''), null, 'vide → null');

  // Même compteur → même code
  const t0 = Date.now() / 1000 - 1;
  const c1 = await totp.generate(secret, { t0 });
  const c2 = await totp.generate(secret, { t0 });
  assert.equal(c1, c2, 'même compteur → même code');

  // Compteurs adjacents → codes différents (quasi-certain)
  const cA = await totp.generate(secret, { t0: Date.now() / 1000 - 1 });
  const cB = await totp.generate(secret, { t0: Date.now() / 1000 - 31 });
  assert.notEqual(cA, cB, 'compteurs différents → codes différents');

  console.log('    OK');
}

async function testSecondsRemaining() {
  console.log('[5] secondsRemaining...');
  const r30 = totp.secondsRemaining(30);
  assert.ok(r30 >= 1 && r30 <= 30, `période 30 → [1,30] (obtenu ${r30})`);
  const r60 = totp.secondsRemaining(60);
  assert.ok(r60 >= 1 && r60 <= 60, `période 60 → [1,60] (obtenu ${r60})`);
  console.log('    OK');
}

async function run() {
  try {
    await testIsValidBase32();
    await testNormalizeBase32();
    await testParseOtpAuthUri();
    await testGenerate();
    await testSecondsRemaining();
    console.log('\nTOTP : tous les tests passés.\n');
  } catch (err) {
    console.error('\nTOTP ÉCHEC :', err.message);
    process.exit(1);
  }
}

run();
