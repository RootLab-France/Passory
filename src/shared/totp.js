/**
 * TOTP — RFC 6238 (HMAC-SHA1 par défaut, période 30s, 6 chiffres).
 *
 * Version partagée (shared) sans dépendance DOM : la version UI dans
 * assets/js/totp.js attache les fonctions à `window.Passory.totp` pour
 * compatibilité HTML existant ; ici on exporte proprement pour les modules
 * métier portables (mobile inclus).
 *
 * API identique — pas d'évolution fonctionnelle, juste extraction d'un
 * module réutilisable.
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryTOTP = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function normalizeBase32(s) {
    return String(s || '').replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  }

  function isValidBase32(s) {
    const clean = normalizeBase32(s);
    return clean.length > 0 && /^[A-Z2-7]+$/.test(clean);
  }

  function base32Decode(s) {
    const clean = normalizeBase32(s);
    if (!isValidBase32(clean)) return null;
    let bits = '';
    for (const c of clean) {
      const idx = B32_ALPHABET.indexOf(c);
      if (idx < 0) return null;
      bits += idx.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return new Uint8Array(bytes);
  }

  /**
   * Génère un code TOTP à l'instant courant (ou à un timestamp donné).
   * @param {string} secret         secret base32 (padding optionnel)
   * @param {object} [opts]
   * @param {number} [opts.period=30]   période en secondes
   * @param {number} [opts.digits=6]    nombre de chiffres (6 ou 8)
   * @param {number} [opts.t0=0]        epoch offset (toujours 0 en pratique)
   * @param {string} [opts.algorithm='SHA-1']  SHA-1 | SHA-256 | SHA-512
   * @param {number} [opts.now=Date.now()]     pour tests déterministes (ms)
   * @returns {Promise<string|null>} code zéro-paddé, ou null si secret invalide
   */
  async function generate(secret, opts = {}) {
    const {
      period = 30, digits = 6, t0 = 0, algorithm = 'SHA-1',
      now = Date.now(),
    } = opts;
    if (!Number.isInteger(digits) || (digits !== 6 && digits !== 8)) return null;
    if (!Number.isInteger(period) || period <= 0) return null;
    const key = base32Decode(secret);
    if (!key || key.length === 0) return null;

    const counter = Math.floor((now / 1000 - t0) / period);
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, Math.floor(counter / 0x100000000));
    view.setUint32(4, counter >>> 0);

    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw', key,
      { name: 'HMAC', hash: algorithm },
      false, ['sign']
    );
    const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', cryptoKey, buf));
    const offset = sig[sig.length - 1] & 0x0f;
    const code = ((sig[offset] & 0x7f) << 24)
               | ((sig[offset + 1] & 0xff) << 16)
               | ((sig[offset + 2] & 0xff) << 8)
               | (sig[offset + 3] & 0xff);
    return String(code % (10 ** digits)).padStart(digits, '0');
  }

  function secondsRemaining(period = 30, now = Date.now()) {
    return period - (Math.floor(now / 1000) % period);
  }

  function parseOtpAuthUri(uri) {
    try {
      if (!uri || !uri.startsWith('otpauth://totp/')) return null;
      const u = new URL(uri);
      const secret = u.searchParams.get('secret');
      if (!secret || !isValidBase32(secret)) return null;
      return {
        secret: normalizeBase32(secret),
        period: Number(u.searchParams.get('period')) || 30,
        digits: Number(u.searchParams.get('digits')) || 6,
        algorithm: (u.searchParams.get('algorithm') || 'SHA1').toUpperCase(),
        issuer: u.searchParams.get('issuer') || '',
      };
    } catch { return null; }
  }

  return {
    generate,
    secondsRemaining,
    parseOtpAuthUri,
    isValidBase32,
    normalizeBase32,
  };
});
