/**
 * TOTP — RFC 6238 (HMAC-SHA1, période 30s, 6 chiffres par défaut).
 * Tout côté renderer, via crypto.subtle. Aucune dépendance externe.
 *
 * Expose window.Passory.totp.{ generate, secondsRemaining, parseOtpAuthUri, isValidBase32 }
 */
(function () {
  'use strict';

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

  async function generate(secret, opts = {}) {
    const { period = 30, digits = 6, t0 = 0, algorithm = 'SHA-1' } = opts;
    const key = base32Decode(secret);
    if (!key || key.length === 0) return null;

    const counter = Math.floor((Date.now() / 1000 - t0) / period);
    // counter sur 8 octets big-endian
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, Math.floor(counter / 0x100000000));
    view.setUint32(4, counter >>> 0);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', key,
      { name: 'HMAC', hash: algorithm },
      false, ['sign']
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, buf));
    const offset = sig[sig.length - 1] & 0x0f;
    const code = ((sig[offset] & 0x7f) << 24)
               | ((sig[offset + 1] & 0xff) << 16)
               | ((sig[offset + 2] & 0xff) << 8)
               | (sig[offset + 3] & 0xff);
    return String(code % (10 ** digits)).padStart(digits, '0');
  }

  function secondsRemaining(period = 30) {
    return period - (Math.floor(Date.now() / 1000) % period);
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

  window.Passory = window.Passory || {};
  window.Passory.totp = { generate, secondsRemaining, parseOtpAuthUri, isValidBase32, normalizeBase32 };
})();
