/**
 * Tests de non-régression issus de l'audit de sécurité du 27/10/2026.
 * Coffres FACTICES uniquement, adaptateur en mémoire avec injection de pannes.
 */
'use strict';
const assert = require('node:assert/strict');
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('node:crypto').webcrypto;

const ML  = require('./helpers/legacy-v1-encrypt.js'); // TESTS : fabrique des données v1
const LegacyV1 = require('../src/shared/crypto/legacy-v1.js');
const KDF = require('../src/shared/crypto/kdf.js');
const Rng = require('../src/shared/crypto/random.js');
const Gen = require('../src/shared/generator.js');
const AEAD = require('../src/shared/crypto/aead.js');
KDF.setProvider(require('../platform/electron/argon2-provider.js'));
const { createAppCore } = require('../src/core/app-core.js');

function memAdapter() {
  const files = {}, secure = {};
  return {
    files, secure, failWrite: null,
    async readFile(n) { return n in files ? files[n] : null; },
    async writeFile(n, c) { if (this.failWrite && this.failWrite(n)) throw new Error('PANNE SIMULEE ' + n); files[n] = c; },
    async deleteFile(n) { delete files[n]; },
    async isSecureStorageAvailable() { return true; },
    async secureGet(k) { return k in secure ? secure[k] : null; },
    async secureSet(k, v) { secure[k] = v; },
    async secureDelete(k) { delete secure[k]; },
    async pickSaveFile() { const self = this; return { path: 'export.json', write: async (c) => { self.exported = c; } }; },
    async pickOpenFile() { return { path: 'export.json', content: this.exported }; },
  };
}
function fresh(adapter, opts = {}) {
  for (const m of ['../items.js', '../settings.js', '../backup.js']) delete require.cache[require.resolve(m)];
  const items = require('../items.js'), settings = require('../settings.js'), backup = require('../backup.js');
  items.setAdapter(adapter); settings.setAdapter(adapter);
  return createAppCore(Object.assign({
    adapter, modules: { items, settings, backup, legacyV1: LegacyV1, sharedRng: Rng, sharedGen: Gen, sharedKDF: KDF, aead: AEAD },
  }, opts));
}
const PW = 'Factice-Maitre-2026', PW2 = 'Nouveau-Factice-2027';
let n = 0;
async function t(name, fn) { n++; process.stdout.write(`[${n}] ${name}... `); await fn(); console.log('OK'); }

(async () => {
  await t('Mot de passe maître < 12 caractères refusé', async () => {
    const core = fresh(memAdapter());
    assert.equal((await core.createMaster('court-8car')).success, false);
  });

  await t('E1 — panne pendant changeMaster : ancien mot de passe toujours valide, rien de perdu', async () => {
    const a = memAdapter(); let core = fresh(a);
    assert.ok((await core.createMaster(PW)).success);
    for (let i = 0; i < 3; i++) await core.itemsAdd({ type: 'password', payload: { label: 'F' + i, password: 'p' + i } });
    a.failWrite = (name) => name === 'vault.json';
    const r = await core.changeMaster({ oldPassword: PW, newPassword: PW2 });
    a.failWrite = null;
    assert.equal(r.success, false);
    await core.lock(); core = fresh(a);
    assert.ok((await core.unlock(PW)).success, 'ancien mot de passe doit rester valide');
    const l = await core.itemsList();
    assert.equal(l.entries.filter((e) => !e.corrupt).length, 3);
    // et le changement fonctionne ensuite normalement
    assert.ok((await core.changeMaster({ oldPassword: PW, newPassword: PW2 })).success);
    await core.lock(); core = fresh(a);
    assert.equal((await core.unlock(PW)).success, false);
    assert.ok((await core.unlock(PW2)).success);
    assert.equal((await core.itemsList()).entries.filter((e) => !e.corrupt).length, 3);
  });

  await t('E1 — changeMaster refusé si un élément est illisible (rien modifié)', async () => {
    const a = memAdapter(); const core = fresh(a);
    await core.createMaster(PW);
    await core.itemsAdd({ type: 'note', payload: { title: 'x' } });
    const v = JSON.parse(a.files['vault.json']); v.items[0].data.ct = 'ff' + v.items[0].data.ct.slice(2);
    a.files['vault.json'] = JSON.stringify(v);
    const before = a.files['vault.json'];
    const r = await core.changeMaster({ oldPassword: PW, newPassword: PW2 });
    assert.equal(r.success, false); assert.match(r.error, /illisible/);
    assert.equal(a.files['vault.json'], before);
  });

  await t('E2 — coffre tronqué : erreur explicite, aucune écriture, copie .bak intacte', async () => {
    const a = memAdapter(); let core = fresh(a);
    await core.createMaster(PW);
    for (let i = 0; i < 5; i++) await core.itemsAdd({ type: 'note', payload: { title: 'n' + i } });
    const bak = a.files['vault.json.bak'];
    assert.ok(bak, 'une copie .bak doit exister');
    a.files['vault.json'] = a.files['vault.json'].slice(0, -10);
    const broken = a.files['vault.json'];
    const add = await core.itemsAdd({ type: 'note', payload: { title: 'après' } });
    assert.equal(add.success, false); assert.equal(add.code, 'VAULT_CORRUPT');
    assert.equal(a.files['vault.json'], broken, 'le fichier corrompu ne doit pas être écrasé');
    assert.equal(a.files['vault.json.bak'], bak, 'la copie de secours ne doit pas être écrasée');
    await core.lock(); core = fresh(a);
    const u = await core.unlock(PW);
    assert.equal(u.success, false); assert.equal(u.code, 'VAULT_CORRUPT');
    assert.equal(await core.hasMaster(), true, 'ne doit pas proposer de recréer un coffre');
    assert.equal((await core.createMaster(PW)).success, false);
    // restauration de la copie : 4 éléments (la dernière écriture n'y est pas)
    a.files['vault.json'] = bak; core = fresh(a);
    assert.ok((await core.unlock(PW)).success);
    assert.equal((await core.itemsList()).entries.length, 4);
  });

  await t('M1 — un chiffré déplacé vers un autre élément ou un autre type est rejeté', async () => {
    const a = memAdapter(); const core = fresh(a);
    await core.createMaster(PW);
    await core.itemsAdd({ type: 'password', payload: { label: 'A', password: 'secretA' } });
    await core.itemsAdd({ type: 'password', payload: { label: 'B', password: 'secretB' } });
    const v = JSON.parse(a.files['vault.json']);
    [v.items[0].data, v.items[1].data] = [v.items[1].data, v.items[0].data];
    a.files['vault.json'] = JSON.stringify(v);
    let l = (await fresh(a)); await l.unlock(PW);
    assert.ok((await l.itemsList()).entries.every((e) => e.corrupt), 'échange de chiffrés doit être détecté');
    const v2 = JSON.parse(a.files['vault.json']);
    [v2.items[0].data, v2.items[1].data] = [v2.items[1].data, v2.items[0].data];
    v2.items[0].type = 'note';
    a.files['vault.json'] = JSON.stringify(v2);
    l = fresh(a); await l.unlock(PW);
    const e = (await l.itemsList()).entries;
    assert.equal(e[0].corrupt, true); assert.ok(!e[1].corrupt);
  });

  await t('Format v2 : paramètres KDF stockés, une seule couche, pas de métadonnée de couches', async () => {
    const a = memAdapter(); const core = fresh(a);
    await core.createMaster(PW);
    await core.itemsAdd({ type: 'note', payload: { title: 'x'.repeat(54) } });
    const v = JSON.parse(a.files['vault.json']);
    assert.equal(v.format, 2); assert.equal(v.kdf.alg, 'argon2id'); assert.equal(v.kdf.memoryCost, 65536);
    assert.ok(a.files['vault.json'].length < 2000, 'pas d\'explosion de taille');
  });

  await t('Migration v1 → v2 sans perte, fichiers v1 archivés', async () => {
    const a = memAdapter(); fresh(a);
    const salt = ML.generateSalt();
    const key = await KDF.deriveMasterKey(PW, salt);
    a.files['master.vault'] = JSON.stringify({ version: 1, saltHex: Rng.bytesToHex(salt), verifier: await ML.makeVerifier(key, 5) });
    const v1 = [];
    for (let i = 0; i < 3; i++) v1.push({ id: 'lx' + i + '-abc', type: i ? 'note' : 'password', createdAt: 1, updatedAt: 2, data: await ML.encryptMultiLayer(JSON.stringify({ label: 'L' + i, title: 'T' + i }), key, 5) });
    a.files['items.vault'] = JSON.stringify(v1);
    let core = fresh(a);
    assert.equal(await core.hasMaster(), true);
    assert.equal((await core.unlock('mauvais-mot-de-passe')).success, false);
    assert.ok(!a.files['vault.json'], 'pas de migration sur mauvais mot de passe');
    const u = await core.unlock(PW);
    assert.ok(u.success); assert.equal(u.migrated, 3);
    assert.ok(a.files['vault.json'] && !a.files['master.vault'] && a.files['master.vault.v1-bak'] && a.files['items.vault.v1-bak']);
    const l = await core.itemsList();
    assert.equal(l.entries.length, 3); assert.ok(l.entries.every((e) => !e.corrupt));
    assert.equal(l.entries.find((e) => e.id === 'lx0-abc').payload.label, 'L0');
    await core.lock(); core = fresh(a);
    assert.ok((await core.unlock(PW)).success);
  });

  await t('Migration v1 partielle : les éléments illisibles restent archivés, le reste est accessible', async () => {
    const a = memAdapter(); fresh(a);
    const salt = ML.generateSalt(); const key = await KDF.deriveMasterKey(PW, salt);
    a.files['master.vault'] = JSON.stringify({ version: 1, saltHex: Rng.bytesToHex(salt), verifier: await ML.makeVerifier(key, 3) });
    const bad = await ML.encryptMultiLayer('{}', key, 3); bad[0].tag = '00'.repeat(16);
    const good = await ML.encryptMultiLayer(JSON.stringify({ title: 'ok' }), key, 3);
    a.files['items.vault'] = JSON.stringify([{ id: 'a', type: 'note', data: bad }, { id: 'b', type: 'note', data: good }]);
    const core = fresh(a);
    const u = await core.unlock(PW);
    assert.ok(u.success); assert.equal(u.migrated, 1); assert.equal(u.skipped, 1);
    assert.equal((await core.itemsList()).entries.length, 1);
    assert.ok(JSON.parse(a.files['items.vault.v1-bak']).length === 2, 'élément illisible conservé dans l\'archive');
  });

  await t('Migration v1 refusée si AUCUN élément n\'est lisible (fichiers intacts)', async () => {
    const a = memAdapter(); fresh(a);
    const salt = ML.generateSalt(); const key = await KDF.deriveMasterKey(PW, salt);
    a.files['master.vault'] = JSON.stringify({ version: 1, saltHex: Rng.bytesToHex(salt), verifier: await ML.makeVerifier(key, 3) });
    const d = await ML.encryptMultiLayer('{}', key, 3); d[0].tag = '00'.repeat(16);
    a.files['items.vault'] = JSON.stringify([{ id: 'a', type: 'note', data: d }]);
    const before = JSON.stringify(a.files);
    const u = await fresh(a).unlock(PW);
    assert.equal(u.success, false); assert.match(u.error, /Migration/);
    assert.equal(JSON.stringify(a.files), before);
  });

  await t('Relecture #2/#3 — après changeMaster, ni .bak ni archives v1 ne s\'ouvrent avec l\'ancien mot de passe ; wipe supprime tout', async () => {
    const a = memAdapter(); fresh(a);
    const salt = ML.generateSalt(); const key = await KDF.deriveMasterKey(PW, salt);
    a.files['master.vault'] = JSON.stringify({ version: 1, saltHex: Rng.bytesToHex(salt), verifier: await ML.makeVerifier(key, 3) });
    a.files['items.vault'] = JSON.stringify([{ id: 'b', type: 'note', data: await ML.encryptMultiLayer('{"title":"s"}', key, 3) }]);
    let core = fresh(a);
    assert.ok((await core.unlock(PW)).success);
    await core.itemsAdd({ type: 'note', payload: { title: 'x' } });
    assert.ok((await core.changeMaster({ oldPassword: PW, newPassword: PW2 })).success);
    assert.ok(!a.files['master.vault.v1-bak'] && !a.files['items.vault.v1-bak'], 'archives v1 supprimées');
    const bak = JSON.parse(a.files['vault.json.bak']);
    const oldKey = await KDF.deriveMasterKey(PW, Rng.hexToBytes(bak.kdf.saltHex), bak.kdf);
    assert.equal(await AEAD.checkVerifier(bak.verifier, oldKey), false, '.bak ne doit plus s\'ouvrir avec l\'ancien');
    a.files['items.vault.v1-bak'] = 'x'; a.files['vault.json.tmp'] = 'x';
    await new Promise((r) => setTimeout(r, 10));
    assert.ok((await core.dangerWipe(PW2)).success);
    assert.deepEqual(Object.keys(a.files).filter((f) => f !== 'settings.json'), []);
  });

  await t('Relecture #5 — remplacement par une sauvegarde sans élément valide refusé', async () => {
    const a = memAdapter(); const core = fresh(a);
    await core.createMaster(PW);
    await core.itemsAdd({ type: 'note', payload: { title: 'garde' } });
    const backup = require('../backup.js');
    a.exported = (await backup.encodeBackup({ passphrase: 'phrase-export-longue', clearItems: [{ type: 'bogus', payload: {} }] })).content;
    const r = await core.backupImport({ passphrase: 'phrase-export-longue', mode: 'replace', masterPassword: PW });
    assert.equal(r.success, false);
    assert.equal((await core.itemsList()).entries.length, 1);
  });

  await t('Relecture #6 — vault.json disparu : restauration depuis .tmp puis .bak', async () => {
    const a = memAdapter(); let core = fresh(a);
    await core.createMaster(PW);
    await core.itemsAdd({ type: 'note', payload: { title: '1' } });
    await core.itemsAdd({ type: 'note', payload: { title: '2' } });
    a.files['vault.json.tmp'] = a.files['vault.json']; delete a.files['vault.json'];
    core = fresh(a);
    assert.equal(await core.hasMaster(), true);
    assert.ok((await core.unlock(PW)).success);
    assert.equal((await core.itemsList()).entries.length, 2, 'restauré depuis .tmp');
    delete a.files['vault.json']; delete a.files['vault.json.tmp'];
    core = fresh(a);
    assert.ok((await core.unlock(PW)).success);
    assert.equal((await core.itemsList()).entries.length, 1, 'restauré depuis .bak (version précédente)');
  });

  await t('Relecture #4 — reprise de session « froide » : biométrie exigée', async () => {
    const a = memAdapter(); let present = true;
    let core = fresh(a, { requireUserPresence: async () => present });
    await core.createMaster(PW);
    // session fraîche : reprise sans biométrie (navigation entre pages)
    present = false; core = fresh(a, { requireUserPresence: async () => present });
    assert.ok(await core.sessionTryResume(), 'reprise fraîche');
    // session vieillie (appli tuée / arrière-plan > 60 s)
    const s = JSON.parse(a.secure['session-key']); s.last -= 120000; a.secure['session-key'] = JSON.stringify(s);
    core = fresh(a, { requireUserPresence: async () => present });
    assert.equal(await core.sessionTryResume(), false, 'biométrie refusée → pas de reprise');
    assert.ok(!a.secure['session-key'], 'clé de session effacée');
    // arrière-plan : la clé quitte le stockage
    present = true; core = fresh(a, { requireUserPresence: async () => present });
    await core.unlock(PW); await core.sessionSuspend();
    assert.ok(!a.secure['session-key']);
  });

  await t('M4 — effacement total et export exigent le mot de passe maître', async () => {
    const a = memAdapter(); const core = fresh(a);
    await core.createMaster(PW);
    await core.itemsAdd({ type: 'note', payload: { title: 'garde-moi' } });
    assert.equal((await core.dangerWipe()).success, false);
    assert.equal((await core.dangerWipe('mauvais')).success, false);
    assert.ok(a.files['vault.json']);
    assert.equal((await core.backupExport({ passphrase: 'phrase-export-longue', masterPassword: 'mauvais' })).success, false);
    const ex = await core.backupExport({ passphrase: 'phrase-export-longue', masterPassword: PW });
    assert.ok(ex.success); assert.equal(JSON.parse(a.exported).version, 3);
    const im = await core.backupImport({ passphrase: 'phrase-export-longue', mode: 'merge' });
    assert.ok(im.success); assert.equal(im.imported, 1);
    assert.equal((await core.backupImport({ passphrase: 'phrase-export-longue', mode: 'replace', masterPassword: 'x' })).success, false);
    // attendre la fin du délai anti-bruteforce
    await new Promise((r) => setTimeout(r, 1100));
    assert.ok((await core.dangerWipe(PW)).success);
    assert.equal(await core.hasMaster(), false);
  });

  await t('M2 — bureau : aucune clé écrite dans le stockage sécurisé au déverrouillage', async () => {
    const a = memAdapter(); const core = fresh(a, { persistSession: false });
    await core.createMaster(PW); await core.lock();
    assert.ok((await core.unlock(PW)).success);
    assert.deepEqual(Object.keys(a.secure), []);
  });

  await t('E3 — déverrouillage rapide refusé si la biométrie échoue', async () => {
    const a = memAdapter(); let present = true;
    let core = fresh(a, { requireUserPresence: async () => present });
    await core.createMaster(PW);
    assert.ok((await core.quickUnlockEnable()).success);
    await core.lock();
    present = false; core = fresh(a, { requireUserPresence: async () => present });
    assert.equal((await core.quickUnlockTry()).success, false);
    assert.equal(core.isUnlocked(), false);
    present = true;
    assert.ok((await core.quickUnlockTry()).success);
  });

  await t('Repartir de zéro — refusé si le coffre est déverrouillé ou sans le mot EFFACER', async () => {
    const a = memAdapter(); const core = fresh(a);
    await core.createMaster(PW);
    await core.itemsAdd({ type: 'note', payload: { title: 'garde-moi' } });
    const before = a.files['vault.json'];
    const r1 = await core.resetForgotten({ confirm: 'EFFACER' });
    assert.equal(r1.success, false); assert.match(r1.error, /ouvert/);
    assert.equal(a.files['vault.json'], before, 'rien effacé tant que le coffre est ouvert');
    await core.lock();
    for (const bad of [undefined, null, '', 'effacer', 'OUI', { confirm: 'effacer ' }, { confirm: true }]) {
      assert.equal((await core.resetForgotten(bad)).success, false, 'mot de confirmation exigé : ' + JSON.stringify(bad));
    }
    assert.equal(a.files['vault.json'], before);
    assert.equal(await core.hasMaster(), true);
  });

  await t('Repartir de zéro — efface tout (coffre, .bak, .tmp, v1, archives, clés, réglages) sans rien lire ni déchiffrer', async () => {
    const a = memAdapter(); let core = fresh(a);
    await core.createMaster(PW);
    await core.itemsAdd({ type: 'password', payload: { label: 'F', password: 'secret-factice' } });
    await core.itemsAdd({ type: 'note', payload: { title: 'n' } }); // crée vault.json.bak
    await core.settingsSet({ autoLockMinutes: 5 });
    await core.lock();
    // Restes possibles d'anciennes versions / d'écritures interrompues.
    Object.assign(a.files, { 'vault.json.tmp': 'x', 'master.vault': 'x', 'items.vault': 'x', 'passwords.vault': 'x',
      'master.vault.v1-bak': 'x', 'items.vault.v1-bak': 'x', 'passwords.vault.v1-bak': 'x' });
    a.secure['master-key'] = 'ancienne-cle-factice'; a.secure['session-key'] = 'ancienne-session-factice';
    // Coffre rendu illisible : l'effacement doit marcher quand même (aucune lecture).
    a.files['vault.json'] = a.files['vault.json'].slice(0, -7);
    assert.ok(a.files['vault.json.bak']);
    core = fresh(a);
    const reads = [], secureReads = [];
    const rf = a.readFile.bind(a), sg = a.secureGet.bind(a);
    a.readFile = async (n) => { reads.push(n); return rf(n); };
    a.secureGet = async (k) => { secureReads.push(k); return sg(k); };
    const r = await core.resetForgotten({ confirm: 'EFFACER' });
    a.readFile = rf; a.secureGet = sg;
    assert.ok(r.success, JSON.stringify(r));
    assert.deepEqual(Object.keys(r).sort(), ['success'], 'aucune donnée renvoyée');
    assert.deepEqual(reads.filter((n) => n !== 'settings.json'), [], 'aucun fichier du coffre lu : ' + reads.join(','));
    assert.deepEqual(secureReads, [], 'aucune clé lue');
    assert.deepEqual(Object.keys(a.files), ['settings.json'], 'il ne reste que les réglages par défaut : ' + Object.keys(a.files).join(','));
    assert.equal(JSON.parse(a.files['settings.json']).autoLockMinutes, 15, 'réglages remis par défaut');
    assert.deepEqual(Object.keys(a.secure), [], 'clés de déblocage rapide et de session supprimées');
    assert.equal(await core.hasMaster(), false);
    assert.equal(core.isUnlocked(), false);
  });

  await t('Repartir de zéro — un nouveau coffre se crée, puis une ancienne sauvegarde s\'y restaure', async () => {
    const a = memAdapter(); let core = fresh(a);
    await core.createMaster(PW);
    await core.itemsAdd({ type: 'password', payload: { label: 'Messagerie', password: 'pw-sauvegarde-factice' } });
    await core.itemsAdd({ type: 'note', payload: { title: 'Note', content: 'contenu' } });
    assert.ok((await core.backupExport({ passphrase: 'phrase-sauvegarde-factice', masterPassword: PW })).success);
    const backupFile = a.exported;
    await core.lock();
    // « Oubli » du mot de passe maître : redémarrage puis effacement.
    core = fresh(a);
    assert.equal((await core.unlock('je-ne-sais-plus-du-tout')).success, false);
    assert.ok((await core.resetForgotten('EFFACER')).success);
    assert.equal(await core.hasMaster(), false);
    core = fresh(a);
    assert.ok((await core.createMaster(PW2)).success, 'nouveau coffre créé');
    assert.equal((await core.itemsCounts()).total, 0, 'nouveau coffre vide');
    a.exported = backupFile;
    const im = await core.backupImport({ passphrase: 'phrase-sauvegarde-factice', mode: 'replace', masterPassword: PW2 });
    assert.ok(im.success, JSON.stringify(im)); assert.equal(im.imported, 2);
    const l = await core.itemsList('password');
    assert.equal(l.entries[0].payload.password, 'pw-sauvegarde-factice');
    await core.lock(); core = fresh(a);
    assert.equal((await core.unlock(PW)).success, false, 'l\'ancien mot de passe n\'ouvre plus rien');
    assert.ok((await core.unlock(PW2)).success);
    assert.equal((await core.itemsCounts()).total, 2);
  });

  await t('Repartir de zéro — une seule demande à la fois', async () => {
    const a = memAdapter(); const core = fresh(a);
    await core.createMaster(PW); await core.lock();
    const del = a.deleteFile.bind(a);
    a.deleteFile = async (n) => { await new Promise((r) => setTimeout(r, 2)); return del(n); };
    const [r1, r2] = await Promise.all([core.resetForgotten('EFFACER'), core.resetForgotten('EFFACER')]);
    a.deleteFile = del;
    assert.equal([r1, r2].filter((r) => r.success).length, 1, JSON.stringify([r1, r2]));
    assert.match((r1.success ? r2 : r1).error, /déjà en cours/);
    assert.ok((await core.resetForgotten('EFFACER')).success, 'possible à nouveau une fois la première terminée');
  });

  await t('Bureau v1.0 — pas de déblocage rapide : aucune clé confiée au stockage, ancienne clé et ancien réglage purgés', async () => {
    const a = memAdapter();
    let core = fresh(a, { persistSession: false, allowQuickUnlock: false });
    await core.createMaster(PW);
    assert.equal(await core.quickUnlockAvailable(), false);
    const en = await core.quickUnlockEnable();
    assert.equal(en.success, false); assert.match(en.error, /ordinateur/);
    assert.ok((await core.changeMaster({ oldPassword: PW, newPassword: PW2 })).success);
    await core.lock();
    assert.ok((await core.unlock(PW2)).success);
    assert.deepEqual(Object.keys(a.secure), [], 'rien dans le stockage sécurisé');
    // Restes d'une version < 1.0 : clé DPAPI + réglage activé.
    a.secure['master-key'] = 'ancienne-cle-factice';
    a.files['settings.json'] = JSON.stringify({ ...JSON.parse(a.files['settings.json'] || '{}'), quickUnlockEnabled: true, autoLockMinutes: 7 });
    await core.lock();
    core = fresh(a, { persistSession: false, allowQuickUnlock: false });
    assert.equal(await core.quickUnlockEnabled(), false, 'ancienne clé jamais utilisée');
    assert.equal((await core.quickUnlockTry()).success, false);
    assert.equal(core.isUnlocked(), false);
    await core.purgeQuickUnlock();
    assert.deepEqual(Object.keys(a.secure), [], 'ancienne clé supprimée');
    const st = JSON.parse(a.files['settings.json']);
    assert.ok(!('quickUnlockEnabled' in st), 'ancien réglage retiré');
    assert.equal(st.autoLockMinutes, 7, 'les autres réglages sont conservés');
    assert.ok(!('quickUnlockEnabled' in (await core.settingsGet()).settings));
  });

  await t('Backup v1 (ancien format) toujours importable', async () => {
    const backup = require('../backup.js');
    const salt = ML.generateSalt(); const key = await KDF.deriveMasterKey('phrase-v1-ok', salt);
    const content = JSON.stringify({ app: 'passory', version: 1, saltHex: Rng.bytesToHex(salt), layers: 3,
      payload: await ML.encryptMultiLayer(JSON.stringify({ items: [{ type: 'note', payload: { title: 'v1' } }, { type: 'bogus', payload: {} }] }), key, 3) });
    const r = await backup.decodeBackup({ passphrase: 'phrase-v1-ok', content });
    assert.equal(r.items.length, 1, 'types inconnus filtrés');
  });

  await t('Backup v1 multi-couches figé (fixture produite par l\'ancien code) toujours importable', async () => {
    const backup = require('../backup.js');
    const content = require('fs').readFileSync(__dirname + '/fixtures/backup-v1-multicouche.json', 'utf8');
    const r = await backup.decodeBackup({ passphrase: 'phrase-fixture-v1', content });
    assert.equal(r.version, 1); assert.equal(r.total, 3); assert.equal(r.items.length, 2);
    assert.equal(r.items[0].payload.password, 'Pa55-factice!');
    await assert.rejects(backup.decodeBackup({ passphrase: 'mauvaise-phrase', content }), /incorrecte/);
  });

  await t('Backup v2 (format une couche d\'avant v3) figé toujours importable', async () => {
    const backup = require('../backup.js');
    const content = require('fs').readFileSync(__dirname + '/fixtures/backup-v2.json', 'utf8');
    const r = await backup.decodeBackup({ passphrase: 'phrase-fixture-v2', content });
    assert.equal(r.version, 2); assert.equal(r.items.length, 2);
    assert.equal(r.items[1].payload.content, 'contenu éàü');
    await assert.rejects(backup.decodeBackup({ passphrase: 'mauvaise-phrase', content }), /incorrecte/);
  });

  await t('Backup v3 : une couche AES-256-GCM, KDF stocké, en-tête authentifié (AAD)', async () => {
    const backup = require('../backup.js');
    assert.equal(backup.BACKUP_VERSION, 3);
    const clearItems = [{ type: 'note', payload: { title: 'v3' }, createdAt: 1, updatedAt: 2 }];
    const { content } = await backup.encodeBackup({ passphrase: 'phrase-v3-factice', clearItems });
    const o = JSON.parse(content);
    assert.equal(o.version, 3); assert.equal(o.cipher, 'AES-256-GCM');
    assert.equal(o.kdf.alg, 'argon2id'); assert.equal(o.kdf.memoryCost, 65536); assert.equal(o.kdf.saltHex.length, 32);
    assert.equal(o.payload.iv.length, 24); assert.ok(!Array.isArray(o.payload) && !('layers' in o) && !('saltHex' in o));
    const r = await backup.decodeBackup({ passphrase: 'phrase-v3-factice', content });
    assert.equal(r.version, 3); assert.equal(r.items[0].payload.title, 'v3');
    // Toute modification de l'en-tête casse l'authentification.
    for (const mutate of [(x) => { x.createdAt += 1; }, (x) => { x.kdf.timeCost = 4; },
                          (x) => { x.version = 2; delete x.cipher; }]) {
      const x = JSON.parse(content); mutate(x);
      await assert.rejects(backup.decodeBackup({ passphrase: 'phrase-v3-factice', content: JSON.stringify(x) }));
    }
    // KDF hors limites refusé avant toute dérivation.
    const big = JSON.parse(content); big.kdf.memoryCost = 4194304;
    await assert.rejects(backup.decodeBackup({ passphrase: 'phrase-v3-factice', content: JSON.stringify(big) }), /hors limites/);
    // Un chiffré v3 ne s'ouvre pas comme un v2 (domaines HKDF + AAD distincts).
    const asV2 = JSON.parse(content); asV2.version = 2;
    await assert.rejects(backup.decodeBackup({ passphrase: 'phrase-v3-factice', content: JSON.stringify(asV2) }), /incorrecte/);
  });

  await t('Coffre v1 multi-couches figé (fixture) migré en v2 sans perte', async () => {
    const fx = require('./fixtures/vault-v1-multicouche.json');
    const a = memAdapter();
    a.files['master.vault'] = JSON.stringify(fx['master.vault']);
    a.files['items.vault'] = JSON.stringify(fx['items.vault']);
    const core = fresh(a);
    const u = await core.unlock(fx.password);
    assert.ok(u.success); assert.equal(u.migrated, 2);
    const v = JSON.parse(a.files['vault.json']);
    assert.equal(v.format, 2); assert.ok(v.items.every((it) => typeof it.data.iv === 'string' && !Array.isArray(it.data)));
    const l = await core.itemsList();
    assert.deepEqual(l.entries.map((e) => e.payload.title).sort(), ['T1', 'T2']);
  });

  console.log('\nSécurité du coffre : tous les tests passés.');
  process.exit(0);
})().catch((e) => { console.error('\nÉCHEC :', e && e.stack || e); process.exit(1); });
