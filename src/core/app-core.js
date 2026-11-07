/**
 * app-core.js — logique métier Passory indépendante de la plateforme.
 *
 * Expose les mêmes handlers que ceux routés par ipcMain dans main.js, mais en
 * tant que fonctions pouvant être appelées directement depuis :
 *   - main.js (Electron)        → ipcMain.handle(channel, (_, a) => core[fn](a))
 *   - web-bootstrap.js (mobile) → window.passory = { auth:..., items:..., ... }
 *
 * Dépendances injectées via createAppCore({...}) :
 *   - adapter  : StorageAdapter (electron ou capacitor)
 *   - modules  : { items, settings, backup, legacyV1, sharedRng, sharedGen, sharedKDF, aead }
 *     (legacyV1 = src/shared/crypto/legacy-v1.js, lecture seule du format v1)
 *   - clipboard: optionnel — { writeText(s), readText(), clear() }
 *   - onAutoLock: optionnel — appelé après un verrouillage automatique
 *   - persistSession: true (mobile) | false (bureau). Sur bureau la clé ne doit
 *     JAMAIS être écrite sur disque (audit M2).
 *   - requireUserPresence: optionnel — async (raison) => boolean. Sur mobile,
 *     demande la biométrie avant tout déverrouillage rapide (audit E3).
 *   - allowQuickUnlock: true (mobile, biométrie) | false (bureau, v1.0). Par
 *     défaut = persistSession. À false, la clé maître n'est JAMAIS confiée au
 *     stockage sécurisé : déverrouillage rapide indisponible, et
 *     purgeQuickUnlock() supprime ce qu'une ancienne version aurait laissé.
 *
 * « Repartir de zéro » (resetForgotten) : pour qui a oublié son mot de passe
 * maître. N'est accepté que coffre VERROUILLÉ, avec le mot EFFACER, une seule
 * demande à la fois ; ne lit ni ne déchiffre rien, efface tout (même logique
 * que l'effacement total des Paramètres, qui lui exige le mot de passe maître).
 *
 * Coffre : format v2 (cf. items.js). Les coffres v1 sont migrés au premier
 * déverrouillage réussi, sans perte (refus si un élément v1 est illisible).
 *
 * Ce module ne touche NI electron NI DOM. Il est UMD.
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryAppCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const MIN_MASTER_LENGTH = 12;

  function createAppCore({ adapter, modules, clipboard, onAutoLock, persistSession = true, requireUserPresence = null,
                           allowQuickUnlock = persistSession }) {
    if (!adapter) throw new Error('adapter requis');
    if (!modules) throw new Error('modules requis');

    const { items, settings, backup, legacyV1, sharedRng, sharedGen, sharedKDF, aead, totp } = modules;
    if (!aead) throw new Error('modules.aead requis (src/shared/crypto/aead.js)');
    if (!legacyV1) throw new Error('modules.legacyV1 requis (src/shared/crypto/legacy-v1.js)');
    const SALT_LENGTH = 16;

    const KEY_LENGTH = aead.KEY_LENGTH;
    const QUICK_UNLOCK_KEY = 'master-key';
    // Clé de session (mobile uniquement) : survit aux navigations entre pages
    // HTML de la WebView, expire suivant autoLockMinutes.
    const SESSION_KEY = 'session-key';
    const SESSION_FORMAT_V = 2;
    // Au-delà de ce délai sans « battement » de l'appli au premier plan, la
    // reprise de session exige la biométrie (appli tuée ou en arrière-plan).
    const SESSION_FRESH_MS = 60_000;

    // --- État session --------------------------------------------------
    let inMemoryMasterKey = null;
    let autoLockTimer = null;
    let _activeOps = 0;
    let _lockPending = false;
    const _perf = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance : { now: () => Date.now() };
    let _unlockAttempts = 0;
    let _unlockLockedUntil = 0;
    let _itemsCache = null; // null | { entries: Array, stamp: number }
    const _ITEMS_CACHE_TTL = 30_000;

    function isUnlocked() {
      return inMemoryMasterKey instanceof Uint8Array && inMemoryMasterKey.length === KEY_LENGTH;
    }
    function wipeBuffer(buf) { if (buf instanceof Uint8Array) buf.fill(0); }
    function _invalidateItemsCache() { _itemsCache = null; }

    function fail(err, fallback) {
      if (err && err.code === 'LOCKED') return { success: false, error: 'LOCKED' };
      if (err && (err.code === 'VAULT_CORRUPT' || err.code === 'NO_VAULT')) {
        return { success: false, error: err.message, code: err.code };
      }
      return { success: false, error: fallback };
    }

    async function lock(fromTimer = false) {
      if (fromTimer && _activeOps > 0) { _lockPending = true; return; }
      _lockPending = false;
      _invalidateItemsCache();
      wipeBuffer(inMemoryMasterKey);
      inMemoryMasterKey = null;
      if (autoLockTimer) { clearTimeout(autoLockTimer); autoLockTimer = null; }
      try { await adapter.secureDelete(SESSION_KEY); } catch {}
    }

    function _opStart() { _activeOps++; }
    async function _opEnd() {
      _activeOps--;
      if (_activeOps === 0 && _lockPending) {
        _lockPending = false;
        await lock();
        if (typeof onAutoLock === 'function') { try { onAutoLock(); } catch {} }
      }
    }

    function touchActivity() {
      if (!isUnlocked()) return;
      const { autoLockMinutes } = settings.getCached();
      if (autoLockTimer) clearTimeout(autoLockTimer);
      if (autoLockMinutes > 0) {
        autoLockTimer = setTimeout(async () => {
          await lock(true);
          if (typeof onAutoLock === 'function') { try { onAutoLock(); } catch {} }
        }, autoLockMinutes * 60 * 1000);
      }
    }

    function bytesToB64(u8) {
      let bin = '';
      for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      return (typeof btoa === 'function') ? btoa(bin) : require('buffer').Buffer.from(u8).toString('base64');
    }
    function b64ToBytes(b64) {
      if (typeof atob === 'function') {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      return new Uint8Array(require('buffer').Buffer.from(b64, 'base64'));
    }

    // --- Rate limiting (en mémoire : simple confort, l'attaque réaliste est hors ligne)
    function _rateLimited() {
      const now = _perf.now();
      if (_unlockLockedUntil > now) {
        return `Trop de tentatives. Réessayez dans ${Math.ceil((_unlockLockedUntil - now) / 1000)}s.`;
      }
      return null;
    }
    function _recordFailure() {
      _unlockAttempts++;
      const delays = [0, 0, 1, 2, 5, 10, 30, 60];
      const delaySec = delays[Math.min(_unlockAttempts - 1, delays.length - 1)];
      if (delaySec > 0) _unlockLockedUntil = _perf.now() + delaySec * 1000;
    }
    function _recordSuccess() { _unlockAttempts = 0; _unlockLockedUntil = 0; }

    // --- KDF ---------------------------------------------------------------
    function newKdfParams(salt) {
      const d = sharedKDF.DEFAULT_OPTS;
      return { alg: 'argon2id', memoryCost: d.memoryCost, timeCost: d.timeCost,
               parallelism: d.parallelism, saltHex: sharedRng.bytesToHex(salt) };
    }
    function deriveWith(password, kdf) {
      return sharedKDF.deriveMasterKey(password, sharedRng.hexToBytes(kdf.saltHex), {
        memoryCost: kdf.memoryCost, timeCost: kdf.timeCost, parallelism: kdf.parallelism,
      });
    }

    // --- Lecture de l'en-tête (v2 ou v1) --------------------------------
    /** { format: 2, vault } | { format: 1, legacy } | null. Lève VAULT_CORRUPT. */
    async function readHeader() {
      const v = await items.readVault();
      if (v) return { format: 2, vault: v };
      let legacy = null;
      try { legacy = await items.readLegacyV1(); }
      catch (err) {
        const e = new Error('Ancien coffre (v1) illisible : ' + err.message + '. Aucune écriture ne sera faite.');
        e.code = 'VAULT_CORRUPT';
        throw e;
      }
      if (legacy) return { format: 1, legacy };
      return null;
    }

    async function hasMaster() {
      return (await items.hasVaultFile()) || (await items.hasLegacyV1());
    }

    /** Vérifie une clé candidate contre le coffre ; migre un coffre v1 si besoin. */
    async function _acceptKey(key, hdr) {
      if (!hdr) return { ok: false, error: 'Aucun mot de passe maître défini.' };
      if (hdr.format === 2) {
        return (await aead.checkVerifier(hdr.vault.verifier, key))
          ? { ok: true } : { ok: false, error: 'Mot de passe incorrect.' };
      }
      // format 1
      const m = hdr.legacy.master;
      if (!m || !Array.isArray(m.verifier) || !(await legacyV1.checkVerifier(m.verifier, key))) {
        return { ok: false, error: 'Mot de passe incorrect.' };
      }
      return _migrateV1(key, hdr.legacy);
    }

    /** Migration v1 → v2, tout ou rien. */
    async function _migrateV1(key, legacy) {
      const clears = [];
      let unreadable = 0;
      for (const e of legacy.items) {
        try {
          clears.push({ e, clear: await legacyV1.decrypt(e.data, key) });
        } catch { unreadable++; }
      }
      // Les éléments illisibles (souvent laissés par l'ancien changement de
      // mot de passe non atomique) ne bloquent pas l'accès au reste : ils
      // restent intacts dans les archives *.v1-bak.
      if (clears.length === 0 && legacy.items.length > 0) {
        return { ok: false, error: `Migration impossible : aucun des ${legacy.items.length} éléments n'est lisible. Vos fichiers n'ont pas été modifiés.` };
      }
      const newItems = [];
      for (const { e, clear } of clears) {
        const id = (typeof e.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(e.id)) ? e.id : items.newId();
        const type = items.ALLOWED_TYPES.includes(e.type) ? e.type : 'password';
        newItems.push({
          id, type,
          createdAt: Number(e.createdAt) || Date.now(),
          updatedAt: Number(e.updatedAt) || Date.now(),
          data: await aead.encrypt(key, clear, aead.aadItem(id, type)),
        });
      }
      const vault = {
        format: items.VAULT_FORMAT,
        // Le v1 utilisait les paramètres par défaut : on les fige dans l'en-tête.
        kdf: { alg: 'argon2id', memoryCost: sharedKDF.DEFAULT_OPTS.memoryCost,
               timeCost: sharedKDF.DEFAULT_OPTS.timeCost, parallelism: sharedKDF.DEFAULT_OPTS.parallelism,
               saltHex: legacy.master.saltHex },
        verifier: await aead.makeVerifier(key),
        items: newItems,
      };
      await items.writeVault(vault);
      await items.archiveLegacyV1();
      return { ok: true, migrated: newItems.length, skipped: unreadable };
    }

    /** Re-vérifie le mot de passe maître (actions sensibles). */
    async function _verifyMaster(password) {
      if (typeof password !== 'string' || !password) return { ok: false, error: 'Mot de passe maître requis.' };
      const limited = _rateLimited();
      if (limited) return { ok: false, error: limited };
      const hdr = await readHeader();
      if (!hdr || hdr.format !== 2) return { ok: false, error: 'Déverrouillez d\'abord le coffre.' };
      const key = await deriveWith(password, hdr.vault.kdf);
      const ok = await aead.checkVerifier(hdr.vault.verifier, key);
      wipeBuffer(key);
      if (!ok) { _recordFailure(); return { ok: false, error: 'Mot de passe maître incorrect.' }; }
      _recordSuccess();
      return { ok: true, hdr };
    }

    // --- Session persistée (mobile) -------------------------------------
    async function sessionPersist() {
      if (!persistSession || !isUnlocked()) return false;
      try {
        if (!(await adapter.isSecureStorageAvailable())) return false;
        const { autoLockMinutes } = settings.getCached();
        const minutes = autoLockMinutes > 0 ? Math.min(autoLockMinutes, 15) : 5;
        const now = Date.now();
        const payload = JSON.stringify({ v: SESSION_FORMAT_V, key: bytesToB64(inMemoryMasterKey), exp: now + minutes * 60 * 1000, last: now });
        await adapter.secureSet(SESSION_KEY, payload);
        return true;
      } catch (err) {
        console.warn('[session] persist :', err.message);
        return false;
      }
    }

    async function sessionTryResume() {
      try {
        if (!persistSession) return false;
        if (isUnlocked()) return true;
        if (!(await adapter.isSecureStorageAvailable())) return false;
        const raw = await adapter.secureGet(SESSION_KEY);
        if (!raw) return false;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        if (!parsed || parsed.v !== SESSION_FORMAT_V || typeof parsed.exp !== 'number'
            || typeof parsed.key !== 'string' || typeof parsed.last !== 'number' || Date.now() > parsed.exp) {
          try { await adapter.secureDelete(SESSION_KEY); } catch {}
          return false;
        }
        // Session « froide » (appli restée en arrière-plan ou relancée) : biométrie.
        if (Date.now() - parsed.last > SESSION_FRESH_MS || parsed.last > Date.now() + 5000) {
          if (!(await userPresent('Reprendre la session Passory'))) {
            try { await adapter.secureDelete(SESSION_KEY); } catch {}
            return false;
          }
        }
        const key = b64ToBytes(parsed.key);
        const hdr = key.length === KEY_LENGTH ? await readHeader() : null;
        const res = hdr && hdr.format === 2 ? await _acceptKey(key, hdr) : { ok: false };
        if (!res.ok) {
          wipeBuffer(key);
          try { await adapter.secureDelete(SESSION_KEY); } catch {}
          return false;
        }
        inMemoryMasterKey = key;
        touchActivity();
        await sessionPersist(); // rafraîchit « last »
        return true;
      } catch (err) {
        console.warn('[session] resume :', err.message);
        return false;
      }
    }

    /** Met à jour la session persistée (battement tant que l'appli est au premier plan). */
    async function sessionRefresh() { if (isUnlocked()) await sessionPersist(); }

    /** Appli en arrière-plan : retire la clé du stockage (elle reste en mémoire). */
    async function sessionSuspend() { try { await adapter.secureDelete(SESSION_KEY); } catch {} }

    /** Supprime toute clé de session laissée sur disque (bureau, au démarrage). */
    async function purgeSession() {
      try { await adapter.secureDelete(SESSION_KEY); } catch {}
    }

    // --- Quick unlock --------------------------------------------------
    async function quickUnlockAvailable() {
      if (!allowQuickUnlock) return false; // bureau : aucune clé sur disque (v1.0)
      return adapter.isSecureStorageAvailable();
    }
    async function quickUnlockEnabled() {
      if (!allowQuickUnlock) return false;
      return (await adapter.secureGet(QUICK_UNLOCK_KEY)) !== null;
    }

    /**
     * Bureau (v1.0) : supprime la clé de déblocage rapide laissée par une
     * version antérieure (quickunlock.vault) et l'ancien réglage
     * « quickUnlockEnabled » de settings.json. Sans effet si rien n'existe.
     */
    async function purgeQuickUnlock() {
      try { await adapter.secureDelete(QUICK_UNLOCK_KEY); } catch (err) { console.warn('[quick-unlock] purge :', err.message); }
      try { if (typeof settings.purgeObsolete === 'function') await settings.purgeObsolete(); }
      catch (err) { console.warn('[settings] purge :', err.message); }
    }

    async function saveQuickUnlock(masterKey) {
      if (!allowQuickUnlock) return false;
      if (!(await quickUnlockAvailable())) return false;
      try {
        await adapter.secureSet(QUICK_UNLOCK_KEY, bytesToB64(masterKey));
        return true;
      } catch (err) {
        console.error('[quick-unlock] save :', err.message);
        return false;
      }
    }

    async function userPresent(reason) {
      if (typeof requireUserPresence !== 'function') return true;
      try { return (await requireUserPresence(reason)) === true; }
      catch { return false; }
    }

    async function tryQuickUnlock() {
      try {
        if (!(await quickUnlockAvailable())) return false;
        const b64 = await adapter.secureGet(QUICK_UNLOCK_KEY);
        if (!b64) return false;
        // Mobile : biométrie obligatoire AVANT de toucher à la clé.
        if (!(await userPresent('Déverrouiller Passory'))) return false;
        const key = b64ToBytes(b64);
        if (key.length !== KEY_LENGTH) return false;
        const res = await _acceptKey(key, await readHeader());
        if (!res.ok) { wipeBuffer(key); return false; }
        inMemoryMasterKey = key;
        touchActivity();
        await sessionPersist();
        return true;
      } catch (err) {
        console.error('[quick-unlock] échec :', err.message);
        return false;
      }
    }

    // --- Effacement total (dangerWipe / resetForgotten) ------------------
    const RESET_CONFIRM_WORD = 'EFFACER';
    let _resetInProgress = false;
    /**
     * Supprime tous les fichiers du coffre : vault.json, .bak, .tmp, anciens
     * fichiers v1 et leurs archives *.v1-bak (items.wipeAll), clé de
     * déblocage rapide, clé de session ; remet les réglages par défaut.
     */
    async function _eraseEverything() {
      await lock();
      _unlockAttempts = 0; _unlockLockedUntil = 0;
      await items.wipeAll();
      await adapter.secureDelete(QUICK_UNLOCK_KEY);
      await adapter.secureDelete(SESSION_KEY);
      await settings.resetSettings();
    }

    // --- Helpers items -------------------------------------------------
    function requireUnlocked() { if (!isUnlocked()) { const e = new Error('LOCKED'); e.code = 'LOCKED'; throw e; } }

    async function decryptEntry(e) {
      _opStart();
      try {
        const payload = JSON.parse(await aead.decrypt(inMemoryMasterKey, e.data, aead.aadItem(e.id, e.type)));
        return { id: e.id, type: e.type, payload, createdAt: e.createdAt, updatedAt: e.updatedAt };
      } catch {
        return { id: e.id, type: e.type, payload: null, corrupt: true, createdAt: e.createdAt, updatedAt: e.updatedAt };
      } finally {
        await _opEnd();
      }
    }

    // --- Expurgation des listes (audit M4) -------------------------------
    // La page ne reçoit plus les secrets en masse : champs sensibles vidés,
    // seuls les derniers caractères servent au masquage. Révélation, copie et
    // TOTP passent par des appels unitaires (get / copyField / totp).
    const SENSITIVE = {
      password: ['password', 'totpSecret', 'notes'],
      card: ['number', 'cvv', 'pin', 'notes'],
      iban: ['iban', 'notes'],
      identity: ['docNumber', 'notes'],
      note: ['content'],
    };
    const HINT = { number: 4, iban: 4, docNumber: 3 };

    function redact(e) {
      if (!e || e.corrupt || !e.payload) return e;
      const fields = SENSITIVE[e.type] || [];
      const p = Object.assign({}, e.payload);
      const has = {}, hint = {};
      for (const f of fields) {
        const v = typeof p[f] === 'string' ? p[f] : String(p[f] || '');
        has[f] = v.length > 0;
        if (HINT[f] && v) hint[f] = v.replace(/\s+/g, '').slice(-HINT[f]);
        p[f] = '';
      }
      p._has = has; p._hint = hint;
      return { id: e.id, type: e.type, payload: p, createdAt: e.createdAt, updatedAt: e.updatedAt, redacted: true };
    }

    // Révélations unitaires : 60 par minute (largement assez pour un humain,
    // ralentit une exfiltration en masse par un script injecté).
    function makeLimiter(max) {
      const log = [];
      return () => {
        const now = Date.now();
        while (log.length && now - log[0] > 60_000) log.shift();
        if (log.length >= max) return false;
        log.push(now);
        return true;
      };
    }
    // get + copyField partagent le même budget ; TOTP a le sien.
    const revealAllowed = makeLimiter(60);
    const totpAllowed = makeLimiter(240);
    const TOO_MANY = { success: false, error: 'Trop de demandes, patientez une minute.' };

    async function findDecrypted(id) {
      const r = await core.itemsList();
      if (!r.success) return { error: r };
      const e = r.entries.find((x) => x.id === id);
      if (!e) return { error: { success: false, error: 'Entrée introuvable.' } };
      if (e.corrupt) return { error: { success: false, error: 'Entrée illisible.' } };
      return { e };
    }

    function encryptPayload(key, id, type, payload) {
      return aead.encrypt(key, JSON.stringify(payload || {}), aead.aadItem(id, type));
    }

    // --- Handlers ------------------------------------------------------
    const core = {
      lock: async () => { await lock(); return { success: true }; },
      isUnlocked: () => isUnlocked(),
      touchActivity,
      hasMaster,
      quickUnlockAvailable,
      quickUnlockEnabled,
      purgeQuickUnlock,
      sessionTryResume: () => sessionTryResume(),
      purgeSession,
      sessionRefresh,
      sessionSuspend,
      MIN_MASTER_LENGTH,

      // auth:*
      async createMaster(password) {
        if (typeof password !== 'string' || password.length < MIN_MASTER_LENGTH) {
          return { success: false, error: `Le mot de passe maître doit faire au moins ${MIN_MASTER_LENGTH} caractères.` };
        }
        if (await hasMaster()) return { success: false, error: 'Un mot de passe maître existe déjà.' };
        if ((await adapter.readFile(items.VAULT_BAK)) !== null) {
          return { success: false, error: 'Une copie de secours du coffre existe (vault.json.bak). Restaurez-la ou supprimez-la avant de créer un nouveau coffre.' };
        }
        try {
          const salt = sharedRng.randomBytes(SALT_LENGTH);
          const kdf = newKdfParams(salt);
          const key = await deriveWith(password, kdf);
          await items.writeVault({ format: items.VAULT_FORMAT, kdf, verifier: await aead.makeVerifier(key), items: [] });
          inMemoryMasterKey = key;
          touchActivity();
          await sessionPersist();
          return { success: true };
        } catch (err) {
          console.error('[auth:create-master]', err.message);
          return { success: false, error: 'Erreur interne lors de la création.' };
        }
      },

      async unlock(password) {
        if (typeof password !== 'string' || password.length === 0) {
          return { success: false, error: 'Mot de passe vide.' };
        }
        const limited = _rateLimited();
        if (limited) return { success: false, error: limited };
        try {
          const hdr = await readHeader();
          if (!hdr) return { success: false, error: 'Aucun mot de passe maître défini.' };
          const kdf = hdr.format === 2 ? hdr.vault.kdf : { ...newKdfParams(new Uint8Array(16)), saltHex: hdr.legacy.master.saltHex };
          if (typeof kdf.saltHex !== 'string') return { success: false, error: 'Ancien coffre (v1) illisible.', code: 'VAULT_CORRUPT' };
          const key = await deriveWith(password, kdf);
          const res = await _acceptKey(key, hdr);
          if (!res.ok) {
            wipeBuffer(key);
            if (res.error === 'Mot de passe incorrect.') _recordFailure();
            return { success: false, error: res.error };
          }
          _recordSuccess();
          inMemoryMasterKey = key;
          touchActivity();
          await sessionPersist();
          return { success: true, migrated: res.migrated, skipped: res.skipped || 0 };
        } catch (err) {
          console.error('[auth:unlock]', err.message);
          return fail(err, 'Erreur interne lors du déverrouillage.');
        }
      },

      async changeMaster({ oldPassword, newPassword } = {}) {
        if (typeof newPassword !== 'string' || newPassword.length < MIN_MASTER_LENGTH) {
          return { success: false, error: `Le nouveau mot de passe doit faire au moins ${MIN_MASTER_LENGTH} caractères.` };
        }
        if (oldPassword === newPassword) {
          return { success: false, error: 'Le nouveau mot de passe doit être différent de l\'ancien.' };
        }
        const limited = _rateLimited();
        if (limited) return { success: false, error: limited };
        let oldKey = null, newKey = null;
        try {
          const hdr = await readHeader();
          if (!hdr || hdr.format !== 2) return { success: false, error: 'Déverrouillez d\'abord le coffre.' };
          oldKey = await deriveWith(String(oldPassword || ''), hdr.vault.kdf);
          if (!(await aead.checkVerifier(hdr.vault.verifier, oldKey))) {
            _recordFailure();
            return { success: false, error: 'Ancien mot de passe incorrect.' };
          }
          _recordSuccess();
          // 1. Tout déchiffrer AVANT d'écrire quoi que ce soit.
          const clears = [];
          let unreadable = 0;
          for (const e of hdr.vault.items) {
            try { clears.push({ e, clear: await aead.decrypt(oldKey, e.data, aead.aadItem(e.id, e.type)) }); }
            catch { unreadable++; }
          }
          if (unreadable > 0) {
            return { success: false, error: `Changement annulé : ${unreadable} élément(s) illisible(s). Rien n'a été modifié.` };
          }
          // 2. Construire le nouveau coffre complet en mémoire.
          const salt = sharedRng.randomBytes(SALT_LENGTH);
          const kdf = newKdfParams(salt);
          newKey = await deriveWith(newPassword, kdf);
          const newItems = [];
          for (const { e, clear } of clears) {
            newItems.push({ ...e, data: await aead.encrypt(newKey, clear, aead.aadItem(e.id, e.type)) });
          }
          const vault = { format: items.VAULT_FORMAT, kdf, verifier: await aead.makeVerifier(newKey), items: newItems };
          // 3. Une seule écriture atomique : soit tout l'ancien, soit tout le nouveau.
          await items.writeVault(vault);
          try { await items.afterRekey(vault); } catch (e) { console.warn('[auth:change-master] nettoyage .bak :', e.message); }
          _invalidateItemsCache();
          wipeBuffer(inMemoryMasterKey);
          inMemoryMasterKey = newKey;
          newKey = null;
          if (await quickUnlockEnabled()) await saveQuickUnlock(inMemoryMasterKey);
          touchActivity();
          await sessionPersist();
          return { success: true };
        } catch (err) {
          console.error('[auth:change-master]', err.message);
          return fail(err, 'Erreur interne lors du changement. Le coffre n\'a pas été modifié.');
        } finally {
          wipeBuffer(oldKey);
          if (newKey) wipeBuffer(newKey);
        }
      },

      // quick-unlock:*
      async quickUnlockEnable() {
        if (!allowQuickUnlock) return { success: false, error: 'Le déverrouillage rapide n\'existe pas sur ordinateur.' };
        if (!isUnlocked()) return { success: false, error: 'Session verrouillée.' };
        if (!(await quickUnlockAvailable())) return { success: false, error: 'Stockage sécurisé indisponible sur cet appareil.' };
        if (!(await userPresent('Activer le déverrouillage rapide'))) return { success: false, error: 'Authentification annulée.' };
        const ok = await saveQuickUnlock(inMemoryMasterKey);
        return { success: ok };
      },

      async quickUnlockDisable() {
        await adapter.secureDelete(QUICK_UNLOCK_KEY);
        return { success: true };
      },

      async quickUnlockTry() {
        if (isUnlocked()) return { success: true };
        if (!allowQuickUnlock) return { success: false };
        return { success: await tryQuickUnlock() };
      },

      // items:*
      async itemsList(type) {
        try {
          requireUnlocked(); touchActivity();
          const now = Date.now();
          if (!_itemsCache || (now - _itemsCache.stamp) >= _ITEMS_CACHE_TTL) {
            const raw = await items.readItems();
            _itemsCache = { entries: await Promise.all(raw.map(decryptEntry)), stamp: now };
          }
          const entries = type ? _itemsCache.entries.filter((e) => e.type === type) : _itemsCache.entries;
          return { success: true, entries };
        } catch (err) {
          console.error('[items:list]', err.message);
          return fail(err, 'Erreur interne.');
        }
      },

      /** Liste pour l'interface : secrets expurgés. */
      async itemsListRedacted(type) {
        const r = await core.itemsList(type);
        if (!r.success) return r;
        return { success: true, entries: r.entries.map(redact) };
      },

      /** Un élément complet (édition / affichage démasqué). Limité en débit. */
      async itemsGet(id) {
        if (typeof id !== 'string') return { success: false, error: 'Identifiant invalide.' };
        if (!isUnlocked()) return { success: false, error: 'LOCKED' };
        if (!revealAllowed()) return TOO_MANY;
        const { e, error } = await findDecrypted(id);
        if (error) return error;
        return { success: true, entry: e };
      },

      /** Copie un champ sans que la page voie sa valeur. */
      async itemsCopyField({ id, field } = {}) {
        if (typeof id !== 'string' || typeof field !== 'string' || field.startsWith('_')) {
          return { success: false, error: 'Paramètres invalides.' };
        }
        if (!isUnlocked()) return { success: false, error: 'LOCKED' };
        if (!revealAllowed()) return TOO_MANY;
        const { e, error } = await findDecrypted(id);
        if (error) return error;
        let v = e.payload[field];
        if (typeof v !== 'string' || !v) return { success: false, error: 'Champ vide.' };
        if (e.type === 'card' && field === 'number') v = v.replace(/\s+/g, '');
        if (e.type === 'iban' && (field === 'iban' || field === 'bic')) v = v.replace(/\s+/g, '').toUpperCase();
        return core.itemsCopy(v);
      },

      /** Code TOTP courant calculé côté cœur (le secret ne sort pas). */
      async itemsTotp(id) {
        if (!totp) return { success: false, error: 'TOTP indisponible.' };
        if (!isUnlocked()) return { success: false, error: 'LOCKED' };
        if (!totpAllowed()) return TOO_MANY;
        const { e, error } = await findDecrypted(id);
        if (error) return error;
        const secret = e.payload.totpSecret;
        if (!secret) return { success: false, error: 'Aucun secret TOTP.' };
        const code = await totp.generate(secret);
        if (!code) return { success: false, error: 'Secret TOTP invalide.' };
        return { success: true, code, remaining: totp.secondsRemaining(30) };
      },

      async itemsAdd({ type, payload } = {}) {
        try {
          requireUnlocked(); touchActivity();
          if (!items.ALLOWED_TYPES.includes(type)) return { success: false, error: 'Type inconnu.' };
          const id = items.newId();
          const data = await encryptPayload(inMemoryMasterKey, id, type, payload);
          await items.addItem(type, data, id);
          _invalidateItemsCache();
          return { success: true, id };
        } catch (err) {
          console.error('[items:add]', err.message);
          return fail(err, 'Erreur chiffrement.');
        }
      },

      async itemsUpdate({ id, payload } = {}) {
        try {
          requireUnlocked(); touchActivity();
          // Garde : un payload issu d'une liste expurgée écraserait les secrets.
          if (payload && (Object.prototype.hasOwnProperty.call(payload, '_has')
              || Object.prototype.hasOwnProperty.call(payload, '_hint'))) {
            return { success: false, error: 'Données incomplètes : rechargez l\'élément avant de l\'enregistrer.' };
          }
          const it = typeof id === 'string' ? await items.findItem(id) : null;
          if (!it) return { success: false, error: 'Entrée introuvable.' };
          const data = await encryptPayload(inMemoryMasterKey, it.id, it.type, payload);
          const ok = await items.updateItem(it.id, data);
          if (!ok) return { success: false, error: 'Entrée introuvable.' };
          _invalidateItemsCache();
          return { success: true };
        } catch (err) {
          console.error('[items:update]', err.message);
          return fail(err, 'Erreur.');
        }
      },

      async itemsDelete(id) {
        try {
          requireUnlocked(); touchActivity();
          const ok = await items.deleteItem(id);
          if (!ok) return { success: false, error: 'Entrée introuvable.' };
          _invalidateItemsCache();
          return { success: true };
        } catch (err) {
          console.error('[items:delete]', err.message);
          return fail(err, 'Erreur.');
        }
      },

      async itemsCounts() {
        try {
          requireUnlocked(); touchActivity();
          const counts = { password: 0, card: 0, iban: 0, note: 0, identity: 0 };
          let total = 0;
          const source = _itemsCache ? _itemsCache.entries : await items.readItems();
          for (const it of source) {
            if (counts[it.type] !== undefined) counts[it.type] += 1;
            total++;
          }
          return { success: true, counts, total };
        } catch (err) {
          return fail(err, 'Erreur.');
        }
      },

      async itemsCopy(text) {
        try {
          requireUnlocked(); touchActivity();
          const s = String(text || '');
          let state = null;
          if (clipboard && typeof clipboard.writeText === 'function') state = await clipboard.writeText(s);
          if (state && state.failed) return { success: false, error: 'La copie a échoué. Réessayez.' };
          const { clipboardClearSeconds } = settings.getCached();
          if (clipboardClearSeconds > 0 && clipboard && typeof clipboard.readText === 'function' && typeof clipboard.clear === 'function') {
            setTimeout(() => {
              Promise.resolve(clipboard.readText()).then((current) => {
                if (current === s) clipboard.clear();
              }).catch(() => {});
            }, clipboardClearSeconds * 1000);
          }
          return { success: true, clearIn: clipboardClearSeconds, protected: !(state && state.protected === false) };
        } catch (err) {
          return fail(err, 'Erreur presse-papier.');
        }
      },

      // passwords:* (alias legacy)
      async passwordsList() {
        const r = await core.itemsList('password');
        if (!r.success) return r;
        const entries = r.entries.map((e) => {
          if (e.corrupt) return { id: e.id, label: '[Erreur déchiffrement]', username: '', password: '', notes: '', corrupt: true };
          const p = e.payload || {};
          return { id: e.id, label: p.label || '', username: p.username || '', password: p.password || '', url: p.url || '', notes: p.notes || '', totpSecret: p.totpSecret || '', createdAt: e.createdAt, updatedAt: e.updatedAt };
        });
        return { success: true, entries };
      },

      async passwordsAdd(entry) {
        if (!entry || !entry.label) return { success: false, error: 'Label requis.' };
        const payload = {
          label: String(entry.label), username: String(entry.username || ''),
          password: String(entry.password || ''), url: String(entry.url || ''),
          notes: String(entry.notes || ''),
        };
        if (entry.totpSecret) payload.totpSecret = String(entry.totpSecret);
        return core.itemsAdd({ type: 'password', payload });
      },

      async passwordsUpdate(entry) {
        if (!entry) return { success: false, error: 'Entrée invalide.' };
        const payload = {
          label: String(entry.label || ''), username: String(entry.username || ''),
          password: String(entry.password || ''), url: String(entry.url || ''),
          notes: String(entry.notes || ''),
        };
        if (entry.totpSecret) payload.totpSecret = String(entry.totpSecret);
        return core.itemsUpdate({ id: entry.id, payload });
      },

      /** passwords:list pour l'interface : sans mot de passe ni secret TOTP. */
      async passwordsListRedacted() {
        const r = await core.passwordsList();
        if (!r.success) return r;
        return { success: true, entries: r.entries.map((e) => Object.assign({}, e, {
          password: '', totpSecret: '', notes: '', hasPassword: !!e.password, hasTotp: !!e.totpSecret,
        })) };
      },

      passwordsDelete: (id) => core.itemsDelete(id),
      passwordsCopy:   (text) => core.itemsCopy(text),

      generatorMake(opts) {
        try {
          const s = settings.getCached();
          const merged = {
            length: Math.max(8, Math.min(128, parseInt((opts && opts.length), 10) || s.generatorLength)),
            upper:   opts && 'upper'   in opts ? !!opts.upper   : s.generatorUseUpper,
            lower:   opts && 'lower'   in opts ? !!opts.lower   : s.generatorUseLower,
            digits:  opts && 'digits'  in opts ? !!opts.digits  : s.generatorUseDigits,
            symbols: opts && 'symbols' in opts ? !!opts.symbols : s.generatorUseSymbols,
            avoidAmbiguous: opts && 'avoidAmbiguous' in opts ? !!opts.avoidAmbiguous : s.generatorAvoidAmbiguous,
          };
          return { success: true, password: sharedGen.make(merged) };
        } catch (err) {
          console.error('[generator:make]', err.message);
          return { success: false, error: 'Erreur génération.' };
        }
      },

      // settings:*
      async settingsGet() {
        return {
          success: true,
          settings: await settings.readSettings(),
          quickUnlockAvailable: await quickUnlockAvailable(),
          quickUnlockEnabled:   await quickUnlockEnabled(),
        };
      },

      async settingsSet(partial) {
        try {
          touchActivity();
          // Le déverrouillage rapide ne se pilote que via quickUnlockEnable/Disable.
          const clean = Object.assign({}, partial || {});
          delete clean.quickUnlockEnabled;
          const updated = await settings.writeSettings(clean);
          return { success: true, settings: updated };
        } catch (err) {
          console.error('[settings:set]', err.message);
          return { success: false, error: 'Erreur sauvegarde paramètres.' };
        }
      },

      async settingsReset() {
        try { return { success: true, settings: await settings.resetSettings() }; }
        catch { return { success: false, error: 'Erreur.' }; }
      },

      // backup:* — export et remplacement exigent le mot de passe maître (audit M4)
      async backupExport({ passphrase, masterPassword } = {}) {
        try {
          requireUnlocked(); touchActivity();
          if (typeof passphrase !== 'string' || passphrase.length < 12) {
            return { success: false, error: 'Phrase de passe d\'export : 12 caractères minimum.' };
          }
          const v = await _verifyMaster(masterPassword);
          if (!v.ok) return { success: false, error: v.error };
          const clearItems = [];
          let skipped = 0;
          for (const e of v.hdr.vault.items) {
            try {
              const payload = JSON.parse(await aead.decrypt(inMemoryMasterKey, e.data, aead.aadItem(e.id, e.type)));
              clearItems.push({ type: e.type, payload, createdAt: e.createdAt, updatedAt: e.updatedAt });
            } catch { skipped++; }
          }
          const handle = await adapter.pickSaveFile(`passory-backup-${new Date().toISOString().slice(0, 10)}.json`);
          if (!handle) return { success: false, error: 'Annulé.' };
          const res = await backup.encodeBackup({ passphrase, clearItems });
          await handle.write(res.content);
          return { success: true, count: res.count, skipped, path: handle.path };
        } catch (err) {
          console.error('[backup:export]', err.message);
          return fail(err, err.message || 'Erreur export.');
        }
      },

      async backupImport({ passphrase, mode, masterPassword } = {}) {
        try {
          requireUnlocked(); touchActivity();
          if (typeof passphrase !== 'string' || passphrase.length === 0) {
            return { success: false, error: 'Phrase de passe requise.' };
          }
          if (mode === 'replace') {
            const v = await _verifyMaster(masterPassword);
            if (!v.ok) return { success: false, error: v.error };
          }
          const current = await items.readItems(); // lève si le coffre est illisible
          const chosen = await adapter.pickOpenFile();
          if (!chosen) return { success: false, error: 'Annulé.' };
          const parsed = await backup.decodeBackup({ passphrase, content: chosen.content });
          if (parsed.items.length === 0) {
            return { success: false, error: `Aucun élément valide dans cette sauvegarde (${parsed.total || 0} ignoré(s)). Rien n'a été modifié.` };
          }
          const target = mode === 'replace' ? [] : current.slice();
          let imported = 0;
          for (const it of parsed.items) {
            const id = items.newId();
            target.push({
              id, type: it.type,
              createdAt: Number(it.createdAt) || Date.now(),
              updatedAt: Date.now(),
              data: await encryptPayload(inMemoryMasterKey, id, it.type, it.payload),
            });
            imported += 1;
          }
          await items.writeItems(target);
          _invalidateItemsCache();
          return { success: true, imported, ignored: Math.max(0, (parsed.total || imported) - imported) };
        } catch (err) {
          console.error('[backup:import]', err.message);
          return fail(err, err.message || 'Erreur import.');
        }
      },

      // danger:wipe — exige le mot de passe maître (audit M4)
      async dangerWipe(masterPassword) {
        try {
          const v = await _verifyMaster(typeof masterPassword === 'object' && masterPassword
            ? masterPassword.masterPassword : masterPassword);
          if (!v.ok) return { success: false, error: v.error };
          await _eraseEverything();
          return { success: true };
        } catch (err) {
          console.error('[danger:wipe]', err.message);
          return fail(err, 'Erreur.');
        }
      },

      /**
       * « Repartir de zéro » depuis l'écran de connexion (mot de passe maître
       * oublié). Garde-fous :
       *   - refusé si le coffre est déverrouillé (l'effacement d'un coffre
       *     ouvert passe par dangerWipe, qui exige le mot de passe maître) ;
       *   - exige { confirm: 'EFFACER' } (mot tapé par l'utilisateur) ;
       *   - une seule demande à la fois ;
       *   - ne lit, ne déchiffre et ne renvoie AUCUNE donnée du coffre : il
       *     efface (y compris un coffre illisible, à la demande explicite de
       *     l'utilisateur).
       */
      async resetForgotten(arg) {
        const word = arg && typeof arg === 'object' ? arg.confirm : arg;
        if (word !== RESET_CONFIRM_WORD) {
          return { success: false, error: `Pour confirmer, tapez ${RESET_CONFIRM_WORD}.` };
        }
        if (isUnlocked()) {
          return { success: false, error: 'Le coffre est ouvert : pour l\'effacer, utilisez Paramètres › Zone dangereuse.' };
        }
        if (_resetInProgress) return { success: false, error: 'Un effacement est déjà en cours.' };
        _resetInProgress = true;
        try {
          await _eraseEverything();
          return { success: true };
        } catch (err) {
          console.error('[auth:reset-forgotten]', err.message);
          return { success: false, error: 'L\'effacement n\'a pas pu se terminer. Redémarrez Passory puis réessayez.' };
        } finally {
          _resetInProgress = false;
        }
      },
    };

    return core;
  }

  return { createAppCore, MIN_MASTER_LENGTH };
});
