/**
 * Coffre unifié Passory — format v2 (vault.json).
 *
 * Un SEUL fichier contient l'en-tête (paramètres KDF, sel, vérificateur) ET les
 * éléments chiffrés. Toute écriture remplace le fichier en une fois (écriture
 * atomique côté adapter), après avoir copié la version précédente dans
 * vault.json.bak. Conséquences :
 *   - un changement de mot de passe maître est atomique (audit E1) ;
 *   - un fichier illisible n'est JAMAIS pris pour un coffre vide : on lève
 *     VAULT_CORRUPT et toute écriture est refusée (audit E2).
 *
 * Structure :
 *   {
 *     format: 2,
 *     kdf: { alg: 'argon2id', memoryCost, timeCost, parallelism, saltHex },
 *     verifier: { iv, ct },
 *     items: [ { id, type, createdAt, updatedAt, data: { iv, ct } } ]
 *   }
 *
 * Les fichiers du format v1 (master.vault, items.vault, passwords.vault) ne
 * sont plus lus que pour la migration (cf. app-core.js → _migrateV1).
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryItems = factory();
})(typeof self !== 'undefined' ? self : this, function () {

const VAULT_FILE = 'vault.json';
const VAULT_BAK = 'vault.json.bak';
const VAULT_TMP = 'vault.json.tmp';
const VAULT_FORMAT = 2;
// Format v1 (lecture seule, pour migration)
const LEGACY_MASTER = 'master.vault';
const ITEMS_FILE = 'items.vault';
const LEGACY_FILE = 'passwords.vault';

const ALLOWED_TYPES = Object.freeze(['password', 'card', 'iban', 'note', 'identity']);

let _adapter = null;

function setAdapter(adapter) {
  if (!adapter || typeof adapter.readFile !== 'function') {
    throw new TypeError('setAdapter : StorageAdapter requis');
  }
  _adapter = adapter;
}

function getAdapter() {
  if (!_adapter) throw new Error('items: adapter non configuré. Appelle items.setAdapter() au boot.');
  return _adapter;
}

function corrupt(msg) {
  const e = new Error('Coffre illisible : ' + msg + '. Aucune écriture ne sera faite ; une copie de secours existe dans ' + VAULT_BAK + '.');
  e.code = 'VAULT_CORRUPT';
  return e;
}

/** Identifiant aléatoire (CSPRNG), 16 octets en hex. */
function newId() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function isHex(s) { return typeof s === 'string' && s.length % 2 === 0 && /^[0-9a-f]*$/i.test(s); }

function validateVault(v) {
  if (!v || typeof v !== 'object') throw corrupt('structure invalide');
  if (v.format !== VAULT_FORMAT) throw corrupt('format inconnu (' + v.format + ')');
  const k = v.kdf;
  if (!k || k.alg !== 'argon2id' || !isHex(k.saltHex) || k.saltHex.length < 32
      || !Number.isInteger(k.memoryCost) || !Number.isInteger(k.timeCost) || !Number.isInteger(k.parallelism)) {
    throw corrupt('paramètres KDF invalides');
  }
  if (!v.verifier || !isHex(v.verifier.iv) || !isHex(v.verifier.ct)) throw corrupt('vérificateur invalide');
  if (!Array.isArray(v.items)) throw corrupt('liste des éléments invalide');
  for (const it of v.items) {
    if (!it || typeof it.id !== 'string' || !ALLOWED_TYPES.includes(it.type)
        || !it.data || !isHex(it.data.iv) || !isHex(it.data.ct)) {
      throw corrupt('élément invalide');
    }
  }
  return v;
}

function parseValid(raw) {
  if (raw === null) return null;
  try { return validateVault(JSON.parse(raw)); } catch { return null; }
}

/**
 * vault.json absent alors qu'une écriture a été interrompue : on restaure la
 * dernière version complète (le .tmp est écrit en entier avant le renommage,
 * sinon la copie .bak). Ne s'applique PAS à un vault.json présent mais corrompu.
 */
async function recoverMissingVault() {
  const a = getAdapter();
  for (const f of [VAULT_TMP, VAULT_BAK]) {
    const raw = await a.readFile(f);
    if (parseValid(raw)) {
      await a.writeFile(VAULT_FILE, raw);
      console.warn('[items] vault.json absent : restauré depuis ' + f);
      return raw;
    }
  }
  return null;
}

/** Lit le coffre v2. null s'il n'existe pas ; lève VAULT_CORRUPT s'il est illisible. */
async function readVault() {
  let raw = await getAdapter().readFile(VAULT_FILE);
  if (raw === null) raw = await recoverMissingVault();
  if (raw === null) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw corrupt('JSON invalide'); }
  return validateVault(parsed);
}

/** Écrit le coffre complet en une fois, après sauvegarde de la version précédente. */
async function writeVault(vault) {
  validateVault(vault);
  const a = getAdapter();
  const previous = await a.readFile(VAULT_FILE);
  if (previous !== null) {
    // On ne sauvegarde que si la version précédente est saine : ne jamais
    // écraser une bonne copie de secours par un fichier corrompu.
    let ok = false;
    try { validateVault(JSON.parse(previous)); ok = true; } catch {}
    if (ok) await a.writeFile(VAULT_BAK, previous);
  }
  await a.writeFile(VAULT_FILE, JSON.stringify(vault));
}

async function hasVaultFile() {
  const a = getAdapter();
  if ((await a.readFile(VAULT_FILE)) !== null) return true;
  return (await recoverMissingVault()) !== null;
}

/**
 * Après un changement de mot de passe maître : la copie .bak et les archives
 * v1 sont encore ouvrables avec l'ANCIEN mot de passe. On les neutralise.
 */
async function afterRekey(vault) {
  const a = getAdapter();
  await a.writeFile(VAULT_BAK, JSON.stringify(vault));
  for (const f of [LEGACY_MASTER, ITEMS_FILE, LEGACY_FILE]) await a.deleteFile(f + '.v1-bak');
}

async function requireVault() {
  const v = await readVault();
  if (!v) { const e = new Error('Aucun coffre.'); e.code = 'NO_VAULT'; throw e; }
  return v;
}

/** Éléments chiffrés du coffre ([] si aucun coffre). Lève VAULT_CORRUPT. */
async function readItems() {
  const v = await readVault();
  return v ? v.items : [];
}

async function writeItems(newItems) {
  const v = await requireVault();
  v.items = newItems;
  await writeVault(v);
}

async function listByType(type) {
  if (!ALLOWED_TYPES.includes(type)) return [];
  return (await readItems()).filter((it) => it.type === type);
}

async function findItem(id) {
  return (await readItems()).find((it) => it.id === id) || null;
}

async function addItem(type, encryptedData, id) {
  if (!ALLOWED_TYPES.includes(type)) throw new Error('Type inconnu : ' + type);
  const v = await requireVault();
  const now = Date.now();
  const newIdv = id || newId();
  v.items.push({ id: newIdv, type, createdAt: now, updatedAt: now, data: encryptedData });
  await writeVault(v);
  return newIdv;
}

async function updateItem(id, encryptedData) {
  const v = await requireVault();
  const it = v.items.find((x) => x.id === id);
  if (!it) return false;
  it.data = encryptedData;
  it.updatedAt = Date.now();
  await writeVault(v);
  return true;
}

async function deleteItem(id) {
  const v = await requireVault();
  const before = v.items.length;
  v.items = v.items.filter((it) => it.id !== id);
  if (v.items.length === before) return false;
  await writeVault(v);
  return true;
}

// --- Format v1 (migration) -------------------------------------------------

/** Lit les fichiers v1 bruts. null si aucun master.vault v1. Lève si illisible. */
async function readLegacyV1() {
  const a = getAdapter();
  const rawMaster = await a.readFile(LEGACY_MASTER);
  if (rawMaster === null) return null;
  const master = JSON.parse(rawMaster);
  let rawItems = await a.readFile(ITEMS_FILE);
  let fromPasswords = false;
  if (rawItems === null) { rawItems = await a.readFile(LEGACY_FILE); fromPasswords = rawItems !== null; }
  const arr = rawItems === null ? [] : JSON.parse(rawItems);
  if (!Array.isArray(arr)) throw new Error('items v1 : structure invalide');
  const legacyItems = arr.map((e) => ({
    id: e.id, type: fromPasswords ? 'password' : e.type,
    createdAt: e.createdAt, updatedAt: e.updatedAt, data: e.data,
  }));
  return { master, items: legacyItems };
}

/** Archive les fichiers v1 (copie *.v1-bak) puis les supprime. */
async function archiveLegacyV1() {
  const a = getAdapter();
  for (const f of [LEGACY_MASTER, ITEMS_FILE, LEGACY_FILE]) {
    const raw = await a.readFile(f);
    if (raw === null) continue;
    await a.writeFile(f + '.v1-bak', raw);
    await a.deleteFile(f);
  }
}

async function hasLegacyV1() {
  return (await getAdapter().readFile(LEGACY_MASTER)) !== null;
}

async function wipeAll() {
  const a = getAdapter();
  for (const f of [VAULT_FILE, VAULT_BAK, VAULT_TMP, LEGACY_MASTER, ITEMS_FILE, LEGACY_FILE,
                   LEGACY_MASTER + '.v1-bak', ITEMS_FILE + '.v1-bak', LEGACY_FILE + '.v1-bak']) {
    await a.deleteFile(f);
  }
}

return {
  ALLOWED_TYPES,
  VAULT_FILE, VAULT_BAK, VAULT_FORMAT,
  ITEMS_FILE, LEGACY_FILE, LEGACY_MASTER,
  setAdapter,
  readVault, writeVault, hasVaultFile, validateVault, afterRekey,
  readItems, writeItems, listByType, findItem,
  addItem, updateItem, deleteItem,
  readLegacyV1, archiveLegacyV1, hasLegacyV1,
  wipeAll, newId,
};
});
