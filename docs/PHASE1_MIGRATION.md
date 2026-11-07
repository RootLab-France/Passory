# Phase 1 — Migration Electron vers src/shared/crypto

Ce document décrit les changements concrets à appliquer dans `main.js`
pour que l'Electron utilise les modules partagés (Web Crypto) au lieu
du module Node-natif `crypto/crypto.js`. La Phase 0 est terminée : les
modules `src/shared/crypto/*` existent, sont testés round-trip avec le
format disque existant (`tests/roundtrip-crypto.js` → `npm test`), et
le provider argon2 Electron est prêt (`platform/electron/argon2-provider.js`).

## Pourquoi cette migration est non triviale

L'API du module legacy est **synchrone** :

```js
const layers = encryptMultiLayer(plaintext, keyBuf, 5);
const plain = decryptMultiLayer(layers, keyBuf);
```

L'API du module shared (Web Crypto) est **asynchrone** — SubtleCrypto
ne propose pas de variante sync :

```js
const layers = await encryptMultiLayer(plaintext, keyU8, 5);
const plain  = await decryptMultiLayer(layers, keyU8);
```

Il faut donc propager l'`await` à travers les 20+ callsites de `main.js`.
Heureusement, toutes les fonctions concernées vivent dans des handlers
`ipcMain.handle(...)` qui sont **déjà async** → ajouter `await` est
l'évolution naturelle, sans casser le contrat IPC.

## Changements précis à appliquer

### 1. Imports en tête de `main.js`

**Avant :**

```js
const {
  deriveMasterKey,
  encryptMultiLayer,
  decryptMultiLayer,
  makeVerifier,
  checkVerifier,
  generateSalt,
  KEY_LENGTH,
} = require('./crypto/crypto');
```

**Après :**

```js
// Polyfill globalThis.crypto pour Node < 19 (sécurité ; Node 20+ l'a déjà).
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

// Module partagé, portable WebView mobile
const sharedML  = require('./src/shared/crypto/multilayer.js');
const sharedKDF = require('./src/shared/crypto/kdf.js');
const sharedRng = require('./src/shared/crypto/random.js');

// Enregistre le provider argon2 natif pour le KDF partagé (une fois au boot)
sharedKDF.setProvider(require('./platform/electron/argon2-provider.js'));

// Helpers pour raccourcir la suite
const encryptMultiLayer = sharedML.encryptMultiLayer;  // async
const decryptMultiLayer = sharedML.decryptMultiLayer;  // async
const makeVerifier      = sharedML.makeVerifier;       // async
const checkVerifier     = sharedML.checkVerifier;      // async
const generateSalt      = sharedML.generateSalt;       // sync (randomBytes)
const KEY_LENGTH        = sharedML.KEY_LENGTH;         // 32

// deriveMasterKey passe de signature (password, saltBuf) → (password, saltU8, opts?)
async function deriveMasterKey(password, salt) {
  const saltU8 = salt instanceof Uint8Array
    ? salt
    : new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength);
  return sharedKDF.deriveMasterKey(password, saltU8);  // Uint8Array 32
}
```

### 2. Type interne de `inMemoryMasterKey`

**Avant :** `Buffer` partout (`Buffer.isBuffer(...)`, `Buffer.from(...)`).

**Après :** `Uint8Array`. Comme `Buffer extends Uint8Array` en Node, le
changement est minimal mais il faut :

- Remplacer `Buffer.isBuffer(inMemoryMasterKey)` par
  `inMemoryMasterKey instanceof Uint8Array` (Uint8Array de longueur 32).
- `wipeBuffer` : `Uint8Array.prototype.fill(0)` marche pareil.
- `toString('base64')` n'existe PAS sur Uint8Array natif. Utiliser
  `Buffer.from(u8).toString('base64')` explicitement pour le safeStorage
  quick unlock.
- Dans `tryQuickUnlock`, à l'inverse, `Buffer.from(b64, 'base64')` reste
  un `Buffer`, donc OK côté lecture (Buffer IS-A Uint8Array).

### 3. Handlers IPC — propager `await`

Les 6 handlers suivants utilisent le crypto et doivent être adaptés.
Chacun est **déjà** `async` → il suffit d'ajouter `await` sur les appels.

#### `auth:create-master`
```js
const salt = generateSalt();
const key = await deriveMasterKey(password, salt);
const { layers } = readSettings();
const verifier = await makeVerifier(key, layers);       // + await
writeMasterFile({
  version: 1,
  saltHex: sharedRng.bytesToHex(salt),                  // au lieu de salt.toString('hex')
  verifier,
});
```

#### `auth:unlock`
```js
const salt = sharedRng.hexToBytes(master.saltHex);      // Uint8Array au lieu de Buffer.from(..,'hex')
const key = await deriveMasterKey(password, salt);
if (!(await checkVerifier(master.verifier, key))) {     // + await
  wipeBuffer(key);
  return { success: false, error: 'Mot de passe incorrect.' };
}
```

#### `auth:change-master`
```js
const oldSalt = sharedRng.hexToBytes(master.saltHex);
const oldKey = await deriveMasterKey(oldPassword, oldSalt);
if (!(await checkVerifier(master.verifier, oldKey))) { ... }

const all = items.readItems();
// La map → Promise.all pour gérer les decrypt async
const clears = await Promise.all(all.map(async (e) => {
  try { return { ...e, _clear: await decryptMultiLayer(e.data, oldKey) }; }
  catch { return { ...e, _clear: null }; }
}));

const newSalt = generateSalt();
const newKey = await deriveMasterKey(newPassword, newSalt);
const { layers } = readSettings();

const updated = await Promise.all(clears.map(async (e) => {
  if (e._clear === null) { /* garde tel quel */ return { ... }; }
  const data = await encryptMultiLayer(e._clear, newKey, layers);
  return { id: e.id, type: e.type, createdAt: e.createdAt, updatedAt: Date.now(), data };
}));

const newVerifier = await makeVerifier(newKey, layers);
writeMasterFile({ version: 1, saltHex: sharedRng.bytesToHex(newSalt), verifier: newVerifier });
items.writeItems(updated);
```

#### `items:list` / `items:add` / `items:update`

```js
// list
const entries = await Promise.all(filtered.map(async (e) => {
  try {
    const payload = JSON.parse(await decryptMultiLayer(e.data, inMemoryMasterKey));
    return { id: e.id, type: e.type, payload, createdAt: e.createdAt, updatedAt: e.updatedAt };
  } catch {
    return { id: e.id, type: e.type, payload: null, corrupt: true,
             createdAt: e.createdAt, updatedAt: e.updatedAt };
  }
}));
return { success: true, entries };

// add / update : même logique, juste `await encryptMultiLayer(...)`.
```

De même pour les alias legacy `passwords:list` / `passwords:add` /
`passwords:update` et pour `backup:export` / `backup:import`.

### 4. Quick unlock (safeStorage)

`safeStorage.encryptString()` attend une string ; on continue de faire
`b64 = Buffer.from(u8).toString('base64')` pour sérialiser la master key.
Côté `tryQuickUnlock`, la comparaison de longueur devient
`key.length !== KEY_LENGTH` (Buffer OK).

`checkVerifier` devient async → `if (!(await checkVerifier(master.verifier, keyBuf)))`.

### 5. Générateur de mot de passe (handler `generator:make`)

Le handler actuel duplique la logique du générateur avec `crypto.randomBytes`.
Optionnellement, on peut désormais déléguer au module partagé :

```js
const sharedGen = require('./src/shared/generator.js');
// ...
ipcMain.handle('generator:make', (_evt, opts) => {
  try {
    const s = readSettings();
    const merged = {
      length: Math.max(8, Math.min(128, parseInt((opts && opts.length), 10) || s.generatorLength)),
      upper:   opts && 'upper' in opts ? !!opts.upper : s.generatorUseUpper,
      lower:   opts && 'lower' in opts ? !!opts.lower : s.generatorUseLower,
      digits:  opts && 'digits' in opts ? !!opts.digits : s.generatorUseDigits,
      symbols: opts && 'symbols' in opts ? !!opts.symbols : s.generatorUseSymbols,
      avoidAmbiguous: opts && 'avoidAmbiguous' in opts ? !!opts.avoidAmbiguous : s.generatorAvoidAmbiguous,
    };
    return { success: true, password: sharedGen.make(merged) };
  } catch (err) {
    console.error('[generator:make]', err);
    return { success: false, error: 'Erreur génération.' };
  }
});
```

Gain : code deux fois plus court, même comportement, même CSPRNG, et testé
par `tests/roundtrip-crypto.js` section `testValidators`.

### 6. `backup.js` — refactor similaire

`backup.js` utilise `encryptMultiLayer` / `decryptMultiLayer` en sync.
Convertir en async. Pas inspecté dans ce doc ; principe identique.

## Ce qu'il faut conserver

- `crypto/crypto.js` : **garder** pendant la période de transition pour
  les tests round-trip (`tests/roundtrip-crypto.js` l'importe). À
  supprimer quand tous les chemins Electron sont basculés.
- Le format disque (`master.vault`, `items.vault`) reste strictement
  identique — aucune migration de données requise. Prouvé par les tests.
- `items.js`, `settings.js` : aucun changement (ils ne font que du file
  IO, pas de crypto).

## Checklist de validation post-migration

Avant de merger la migration :

- [ ] `npm test` passe (round-trip crypto).
- [ ] `npm start` : login avec un mot de passe maître existant fonctionne.
- [ ] Création d'un nouveau master password + ré-ouverture fonctionnent.
- [ ] Lecture, ajout, modification, suppression d'un password item.
- [ ] Lecture, ajout, modification, suppression d'un card item.
- [ ] Lecture, ajout, modification, suppression d'un iban item.
- [ ] Lecture, ajout, modification, suppression d'un note item.
- [ ] Lecture, ajout, modification, suppression d'un identity item.
- [ ] Changement du master password : tous les items restent lisibles après.
- [ ] Quick unlock (activer, redémarrer app, unlock sans password).
- [ ] Backup export → import : tous les items retrouvés.
- [ ] Danger wipe : coffre réinitialisé, retour sur create-master-password.
- [ ] Fenêtre auto-lock après N minutes.
- [ ] Lock on minimize si activé dans settings.

## Pourquoi ce doc et pas la migration directe

La migration touche 6+ handlers IPC critiques. La casser signifie
"impossible d'ouvrir son coffre" pour les utilisateurs existants. Plutôt
que de la faire en aveugle dans une session agent sans runtime Electron
pour tester, on :

1. Valide le format disque via `npm test` (fait, OK).
2. Documente le diff précis (ce fichier).
3. Laisse la main à un dev pour l'appliquer et tester avec un coffre réel
   avant merge.

Une fois merge, l'Electron consomme exactement le même code que la
Capacitor WebView mobile consommera — le partage du moteur crypto entre
plateformes est effectif.
