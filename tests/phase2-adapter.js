/**
 * Test d'intégration Phase 2 : vérifie que le StorageAdapter Electron
 * + items.js + settings.js + backup.js fonctionnent bout en bout, avec un
 * dataDir isolé et des stubs pour electron (dialog + safeStorage).
 *
 * But : attraper les régressions du refactor vers l'adapter sans avoir à
 * lancer Electron. Les tests de round-trip crypto (roundtrip-crypto.js) sont
 * orthogonaux et couvrent la compat binaire des vaults.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

const sharedKDF = require('../src/shared/crypto/kdf.js');
sharedKDF.setProvider(require('../platform/electron/argon2-provider.js'));

const { createElectronAdapter } = require('../platform/electron/storage-fs.js');
const items = require('../items.js');
const settings = require('../settings.js');
const backup = require('../backup.js');

// Bureau v1.0 : pas de safeStorage, aucun stockage de clé (audit M2).
// --- Fake dialog : simule pickSaveFile / pickOpenFile avec un fichier
// temporaire connu. On le pousse/pull depuis la variable backupBlob.
let backupBlob = null;
let backupFilePath = null;
const fakeDialog = {
  showSaveDialog: async (_win, { defaultPath }) => {
    backupFilePath = path.join(testDir, 'saves', path.basename(defaultPath));
    fs.mkdirSync(path.dirname(backupFilePath), { recursive: true });
    return { canceled: false, filePath: backupFilePath };
  },
  showOpenDialog: async () => {
    return { canceled: false, filePaths: [backupFilePath] };
  },
};

// --- Setup dataDir isolé
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passory-test-'));
const dataDir = path.join(testDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

function assert(cond, msg) {
  if (!cond) { console.error('✗ FAIL:', msg); process.exit(1); }
}

(async function main() {
  try {
    // Boot adapter
    const adapter = createElectronAdapter({
      app: null, dialog: fakeDialog,
      getMainWindow: () => null, dataDir,
    });
    items.setAdapter(adapter);
    settings.setAdapter(adapter);

    console.log('[1] Settings : read défauts + write + re-read...');
    const s0 = await settings.readSettings();
    assert(s0.autoLockMinutes === 15, 'default autoLockMinutes = 15');
    const s1 = await settings.writeSettings({ autoLockMinutes: 30 });
    assert(s1.autoLockMinutes === 30, 'write mirror');
    const s2 = await settings.readSettings();
    assert(s2.autoLockMinutes === 30, 'persistence');
    // Ancien settings.json avec la clé obsolète « layers » (multi-couches) :
    // lu sans erreur, clé ignorée puis retirée à la prochaine écriture.
    await adapter.writeFile('settings.json', JSON.stringify({ ...s2, layers: 7, clipboardClearSeconds: 45 }));
    const s3 = await settings.readSettings();
    assert(s3.clipboardClearSeconds === 45 && s3.autoLockMinutes === 30 && !('layers' in s3), 'ancien réglage layers toléré');
    await settings.writeSettings({ autoLockMinutes: 30 });
    assert(!('layers' in JSON.parse(await adapter.readFile('settings.json'))), 'clé layers purgée à l\'écriture');
    console.log('    OK');

    console.log('[2] Coffre v2 : création + add + list + update + delete (fichier réel)...');
    const fakeEncrypted = { iv: 'bb'.repeat(12), ct: 'dd'.repeat(20) };
    await items.writeVault({ format: 2, kdf: { alg: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 1, saltHex: 'ab'.repeat(16) },
      verifier: { iv: 'aa'.repeat(12), ct: 'cc'.repeat(20) }, items: [] });
    const id1 = await items.addItem('password', fakeEncrypted);
    const id2 = await items.addItem('card', fakeEncrypted);
    const all1 = await items.readItems();
    assert(all1.length === 2, 'two items after add');
    assert(all1.find(x => x.id === id1).type === 'password', 'id1 type ok');
    const okU = await items.updateItem(id1, { iv: 'ee'.repeat(12), ct: 'ff'.repeat(20) });
    assert(okU === true, 'update success');
    const okD = await items.deleteItem(id2);
    assert(okD === true, 'delete success');
    const all2 = await items.readItems();
    assert(all2.length === 1, 'one item after delete');
    assert(fs.existsSync(path.join(dataDir, 'vault.json.bak')), 'copie .bak créée');
    assert(!fs.readdirSync(dataDir).some(f => f.endsWith('.tmp')), 'aucun .tmp résiduel');
    // Corruption sur disque : erreur, pas d'écrasement
    const good = fs.readFileSync(path.join(dataDir, 'vault.json'), 'utf8');
    fs.writeFileSync(path.join(dataDir, 'vault.json'), good.slice(0, -5));
    let threw = false;
    try { await items.addItem('note', fakeEncrypted); } catch (e) { threw = e.code === 'VAULT_CORRUPT'; }
    assert(threw, 'coffre corrompu → VAULT_CORRUPT');
    assert(fs.readFileSync(path.join(dataDir, 'vault.json'), 'utf8') === good.slice(0, -5), 'fichier corrompu non écrasé');
    fs.writeFileSync(path.join(dataDir, 'vault.json'), good);
    console.log('    OK');

    console.log('[3] Bureau : aucun stockage de clé sur disque (refus) + purge des anciens fichiers...');
    assert((await adapter.isSecureStorageAvailable()) === false, 'stockage sécurisé indisponible sur bureau');
    let refused = false;
    try { await adapter.secureSet('master-key', 'hello-secret'); } catch { refused = true; }
    assert(refused, 'secureSet refusé');
    refused = false;
    try { await adapter.secureSet('session-key', 'x'); } catch { refused = true; }
    assert(refused, 'secureSet(session-key) refusé');
    assert(!fs.existsSync(path.join(dataDir, 'quickunlock.vault')) && !fs.existsSync(path.join(dataDir, 'secure')), 'aucun fichier de clé écrit');
    // Ancien fichier laissé par une version < 1.0 : jamais relu, supprimable.
    fs.writeFileSync(path.join(dataDir, 'quickunlock.vault'), Buffer.from('ancienne-cle-dpapi-factice'));
    assert((await adapter.secureGet('master-key')) === null, 'ancien fichier jamais relu');
    await adapter.secureDelete('master-key');
    assert(!fs.existsSync(path.join(dataDir, 'quickunlock.vault')), 'ancien quickunlock.vault supprimé');
    // Ancien réglage quickUnlockEnabled : toléré puis retiré par purgeObsolete().
    await adapter.writeFile('settings.json', JSON.stringify({ ...(await settings.readSettings()), quickUnlockEnabled: true }));
    assert(!('quickUnlockEnabled' in (await settings.readSettings())), 'ancien réglage ignoré à la lecture');
    assert((await settings.purgeObsolete()) === true, 'purge effectuée');
    assert(!('quickUnlockEnabled' in JSON.parse(await adapter.readFile('settings.json'))), 'réglage retiré du fichier');
    assert((await settings.purgeObsolete()) === false, 'purge idempotente');
    console.log('    OK');

    console.log('[4] Backup encode/decode + pickers...');
    const testItems = [
      { id: 'a1', type: 'password', createdAt: 1, updatedAt: 2,
        payload: { label: 'Gmail', username: 'u', password: 'p' } },
      { id: 'a2', type: 'note',     createdAt: 3, updatedAt: 4,
        payload: { title: 'Note', content: 'hello' } },
    ];
    const enc = await backup.encodeBackup({
      passphrase: 'test-passphrase-12', clearItems: testItems,
    });
    assert(typeof enc.content === 'string' && enc.count === 2, 'encodeBackup shape');
    // Écrit via pickSaveFile
    const save = await adapter.pickSaveFile('test-backup.json');
    await save.write(enc.content);
    assert(fs.existsSync(backupFilePath), 'file written via picker');

    const open = await adapter.pickOpenFile();
    const dec = await backup.decodeBackup({ passphrase: 'test-passphrase-12', content: open.content });
    assert(dec.items.length === 2 && dec.items[0].payload.label === 'Gmail', 'decode ok');
    console.log('    OK');

    console.log('[5] Backup : mauvaise passphrase → erreur attendue...');
    try {
      await backup.decodeBackup({ passphrase: 'wrong-passphrase', content: open.content });
      assert(false, 'should have thrown');
    } catch (e) {
      assert(/passphrase|corrompu/i.test(e.message), 'error message coherent: ' + e.message);
    }
    console.log('    OK');

    console.log('[6] Lecture v1 (migration) depuis passwords.vault...');
    const legacy = [
      { id: 'L1', data: [{ salt: 'aa', iv: 'bb', tag: 'cc', encryptedData: 'dd' }], createdAt: 100, updatedAt: 200 },
      { id: 'L2', data: [{ salt: 'aa', iv: 'bb', tag: 'cc', encryptedData: 'dd' }], createdAt: 300, updatedAt: 400 },
    ];
    await adapter.writeFile('master.vault', JSON.stringify({ version: 1, saltHex: 'ab'.repeat(16), verifier: [] }));
    await adapter.writeFile('passwords.vault', JSON.stringify(legacy));
    const lv1 = await items.readLegacyV1();
    assert(lv1.items.length === 2 && lv1.items.every(x => x.type === 'password'), 'v1 lu avec type=password');
    await items.archiveLegacyV1();
    const files = await adapter.listFiles();
    assert(files.includes('passwords.vault.v1-bak') && !files.includes('passwords.vault') && !files.includes('master.vault'), 'v1 archivé');
    console.log('    OK');

    console.log('[7] Wipe all...');
    await items.wipeAll();
    await adapter.secureDelete('master-key');
    await settings.resetSettings();
    const afterWipe = await items.readItems();
    assert(afterWipe.length === 0, 'items vide après wipe');
    console.log('    OK');

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log('\n✓ Tous les tests Phase 2 OK — adapter + modules métier coopèrent.');
    process.exit(0);
  } catch (err) {
    console.error('✗ ERREUR INATTENDUE :', err);
    process.exit(1);
  }
})();
