/**
 * Module de gestion des paramètres persistants (settings.json).
 *
 * Lecture tolérante : si le fichier est corrompu ou absent, on retourne les
 * défauts (on ne lève jamais). L'écriture est atomique via l'adapter.
 *
 * Depuis Phase 2, passe par StorageAdapter (pas d'accès fs direct).
 * L'appelant doit appeler setAdapter() au boot. En plus, on maintient un
 * petit cache en mémoire pour que les callers qui lisent très souvent
 * (touchActivity / timers) puissent avoir une vue synchrone via getCached().
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PassorySettings = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

const SETTINGS_FILE = 'settings.json';

const DEFAULTS = Object.freeze({
  version: 2,
  // Sécurité
  // (quickUnlockEnabled retiré en v1.0 : sur mobile, l'état du déverrouillage
  // biométrique se lit dans le stockage sécurisé ; sur bureau il n'existe plus.)
  autoLockMinutes: 15,               // verrou auto après N min d'inactivité (0 = désactivé)
  lockOnMinimize: false,             // verrouille à la minimisation de la fenêtre
  // Affichage
  maskPasswords: true,               // masquer les mots de passe par défaut dans la liste
  maskSensitive: true,               // masquer CVV, PIN, numéros de carte par défaut
  // Presse-papier
  clipboardClearSeconds: 20,         // efface le presse-papier après N secondes (0 = jamais)
  // Générateur de mot de passe
  generatorLength: 20,               // longueur par défaut du générateur (8..128)
  generatorUseSymbols: true,
  generatorUseDigits: true,
  generatorUseUpper: true,
  generatorUseLower: true,
  generatorAvoidAmbiguous: false,    // évite 0/O/1/l/I
  // Smart Autofill
  autofillEnabled: false,            // retiré (audit M6) — toujours false
  autofillSilent:  false,            // notification silencieuse (sans son)
});

let _adapter = null;
/** Cache synchronisé après chaque read/write. */
let _cache = { ...DEFAULTS };

function setAdapter(adapter) {
  if (!adapter || typeof adapter.readFile !== 'function') {
    throw new TypeError('setAdapter : StorageAdapter requis');
  }
  _adapter = adapter;
}

function getAdapter() {
  if (!_adapter) throw new Error('settings: adapter non configuré.');
  return _adapter;
}

async function readSettings() {
  try {
    const a = getAdapter();
    const raw = await a.readFile(SETTINGS_FILE);
    if (raw === null) {
      _cache = { ...DEFAULTS };
      return { ..._cache };
    }
    const parsed = JSON.parse(raw);
    _cache = normalize({ ...DEFAULTS, ...parsed });
    return { ..._cache };
  } catch (err) {
    console.error('[settings] lecture impossible, valeurs par défaut :', err.message);
    _cache = { ...DEFAULTS };
    return { ..._cache };
  }
}

/**
 * Retourne le dernier snapshot chargé. À n'utiliser QU'APRÈS un readSettings()
 * initial au boot. Utile pour touchActivity() qui ne peut pas être async.
 */
function getCached() {
  return { ..._cache };
}

async function writeSettings(partial) {
  const a = getAdapter();
  const current = await readSettings();
  const merged = normalize({ ...current, ...partial });
  await a.writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  _cache = merged;
  return { ..._cache };
}

async function resetSettings() {
  const a = getAdapter();
  const base = { ...DEFAULTS };
  await a.writeFile(SETTINGS_FILE, JSON.stringify(base, null, 2));
  _cache = base;
  return { ..._cache };
}

function clampInt(v, min, max, fallback) {
  const n = Number.isFinite(Number(v)) ? Math.floor(Number(v)) : fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Ne conserve que les clés connues : une clé obsolète d'un ancien
 * settings.json (ex. « layers », nombre de couches de l'ancien chiffrement
 * multi-couches) est ignorée puis disparaît à la prochaine écriture.
 */
function normalize(s) {
  const out = {
    version: 2,
    autoLockMinutes: clampInt(s.autoLockMinutes, 0, 240, 15),
    lockOnMinimize: !!s.lockOnMinimize,
    maskPasswords: s.maskPasswords !== false,
    maskSensitive: s.maskSensitive !== false,
    clipboardClearSeconds: clampInt(s.clipboardClearSeconds, 0, 600, 20),
    generatorLength: clampInt(s.generatorLength, 8, 128, 20),
    generatorUseSymbols: !!s.generatorUseSymbols,
    generatorUseDigits: !!s.generatorUseDigits,
    generatorUseUpper: !!s.generatorUseUpper,
    generatorUseLower: !!s.generatorUseLower,
    generatorAvoidAmbiguous: !!s.generatorAvoidAmbiguous,
    // Smart Autofill
    autofillEnabled: false, // fonction retirée (audit M6)
    autofillSilent:  !!s.autofillSilent,
  };
  // Garantit qu'au moins une classe est activée pour le générateur
  if (!out.generatorUseSymbols && !out.generatorUseDigits
      && !out.generatorUseUpper && !out.generatorUseLower) {
    out.generatorUseLower = true;
  }
  return out;
}

/**
 * Retire de settings.json les clés obsolètes (ex. « quickUnlockEnabled »
 * d'avant la v1.0, « layers » de l'ancien chiffrement). Tolérant : un fichier
 * absent ou illisible n'est pas touché. Retourne true si le fichier a été réécrit.
 */
async function purgeObsolete() {
  const a = getAdapter();
  const raw = await a.readFile(SETTINGS_FILE);
  if (raw === null) return false;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (!parsed || typeof parsed !== 'object') return false;
  const known = Object.keys(normalize({ ...DEFAULTS }));
  if (!Object.keys(parsed).some((k) => !known.includes(k))) return false;
  const clean = normalize({ ...DEFAULTS, ...parsed });
  await a.writeFile(SETTINGS_FILE, JSON.stringify(clean, null, 2));
  _cache = clean;
  return true;
}

return {
  setAdapter,
  purgeObsolete,
  readSettings,
  writeSettings,
  resetSettings,
  getCached,
  DEFAULTS,
};
});
