/**
 * Générateur de mot de passe — portable, CSPRNG.
 *
 * Sur Electron, le générateur vivait dans main.js (crypto.randomBytes côté
 * Node). On le réécrit ici en pur Web Crypto, identique fonctionnellement,
 * réutilisable en WebView mobile.
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./crypto/random.js'));
  else root.PassoryGenerator = factory(root.PassoryRandom);
})(typeof self !== 'undefined' ? self : this, function (R) {

  const UPPER      = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const LOWER      = 'abcdefghijklmnopqrstuvwxyz';
  const DIGITS     = '0123456789';
  const SYMBOLS    = '!@#$%^&*()-_=+[]{};:,.<>?/';
  const AMBIGUOUS  = /[0O1lI]/g;

  function make(opts) {
    const {
      length = 20,
      upper = true, lower = true, digits = true, symbols = true,
      avoidAmbiguous = false,
    } = opts || {};

    if (!Number.isInteger(length) || length < 4 || length > 256) {
      throw new RangeError('length doit être 4..256');
    }
    let classes = [];
    if (upper)   classes.push(UPPER);
    if (lower)   classes.push(LOWER);
    if (digits)  classes.push(DIGITS);
    if (symbols) classes.push(SYMBOLS);
    if (classes.length === 0) classes = [LOWER]; // fallback

    if (avoidAmbiguous) classes = classes.map((c) => c.replace(AMBIGUOUS, ''));

    const pool = classes.join('');
    if (pool.length === 0) throw new Error('pool vide après filtrage ambigu');

    // On construit d'abord en garantissant ≥1 char de chaque classe activée,
    // puis on remplit le reste depuis le pool global, puis on mélange.
    const out = [];
    for (const cls of classes) {
      out.push(cls[R.randomInt(0, cls.length - 1)]);
    }
    while (out.length < length) {
      out.push(pool[R.randomInt(0, pool.length - 1)]);
    }
    R.shuffle(out);
    return out.join('');
  }

  return { make };
});
