/**
 * CapacitorStorageAdapter — implémentation du contrat `src/shared/storage/adapter.js`
 * pour une WebView Capacitor (Android / iOS). Wraps :
 *
 *   - @capacitor/filesystem               → readFile / writeFile / listFiles
 *   - @aparajita/capacitor-secure-storage → Keychain iOS / EncryptedSharedPrefs Android
 *   - @capacitor/share                    → pickSaveFile (share sheet)
 *   - <input type="file">                 → pickOpenFile (fallback HTML simple)
 *
 * Design notes :
 *  - Les imports sont DYNAMIQUES (top-level async import) pour que ce module
 *    puisse aussi être chargé côté bundler desktop sans faire exploser la
 *    résolution des packages natifs. L'appelant fait `await createCapacitorAdapter()`.
 *  - Le "data dir" est virtuel : `Directory.Data` (privé à l'app, pas accessible
 *    aux autres apps Android, sandbox iOS).
 *  - Pour le pickOpenFile, l'API native idéale serait `@capawesome/capacitor-file-picker`.
 *    En attendant, on retombe sur un <input type="file"> DOM qui fonctionne dans
 *    la WebView — suffisant pour un import de JSON en phase initiale.
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../../src/shared/storage/adapter.js'));
  } else {
    root.PassoryCapacitorStorage = factory(root.PassoryStorageAdapter);
  }
})(typeof self !== 'undefined' ? self : this, function (adapterModule) {

  const { StorageAdapter } = adapterModule;

  // Détection légère de l'environnement (plateforme côté Capacitor.getPlatform()).
  function detectPlatform(Capacitor) {
    try {
      const p = Capacitor && typeof Capacitor.getPlatform === 'function'
        ? Capacitor.getPlatform() : 'web';
      return p === 'ios' || p === 'android' ? p : 'web';
    } catch { return 'web'; }
  }

  // Détection "mobile-low" vs "mobile-high" pour ajuster l'argon2.
  // Heuristique : on considère que tout ce qui dit avoir < 2 GB RAM est "low".
  // navigator.deviceMemory n'est pas 100% fiable mais donne un hint raisonnable.
  function detectDeviceClass(platform) {
    if (platform === 'web') return 'desktop';
    try {
      const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0;
      return mem > 0 && mem <= 2 ? 'mobile-low' : 'mobile-high';
    } catch { return 'mobile-high'; }
  }

  class CapacitorStorageAdapter extends StorageAdapter {
    /**
     * @param {object} modules  Modules déjà importés (DI pour tests + lazy loading)
     * @param {object} modules.Filesystem     de @capacitor/filesystem
     * @param {object} modules.Directory      enum Directory de @capacitor/filesystem
     * @param {object} modules.Encoding       enum Encoding de @capacitor/filesystem
     * @param {object} modules.SecureStorage  de @aparajita/capacitor-secure-storage
     * @param {object} [modules.Share]        de @capacitor/share (optionnel)
     * @param {object} [modules.Capacitor]    l'objet Capacitor racine (pour getPlatform)
     * @param {string} [dataDirName]          sous-dossier dans Directory.Data (default 'passory')
     */
    constructor(modules, dataDirName = 'passory') {
      super();
      this._fs = modules.Filesystem;
      this._Directory = modules.Directory;
      this._Encoding = modules.Encoding;
      this._secure = modules.SecureStorage;
      this._share = modules.Share || null;
      this._dataDirName = dataDirName;
      this._platform = detectPlatform(modules.Capacitor);
      this._deviceClass = detectDeviceClass(this._platform);
      this._ensuredDir = false;
    }

    async _ensureDataDir() {
      if (this._ensuredDir) return;
      try {
        await this._fs.mkdir({
          path: this._dataDirName,
          directory: this._Directory.Data,
          recursive: true,
        });
      } catch (err) {
        // Ignore "already exists"
        if (!String(err.message || '').toLowerCase().includes('exist')) {
          throw err;
        }
      }
      this._ensuredDir = true;
    }

    _pathFor(name) {
      if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name.includes('\\')) {
        throw new Error('nom de fichier invalide : ' + name);
      }
      return `${this._dataDirName}/${name}`;
    }

    // --- Fichiers ---------------------------------------------------------

    async readFile(name) {
      try {
        const res = await this._fs.readFile({
          path: this._pathFor(name),
          directory: this._Directory.Data,
          encoding: this._Encoding.UTF8,
        });
        return res.data || '';
      } catch (err) {
        // Filesystem plugin lève avec un message contenant "does not exist"
        if (String(err.message || '').toLowerCase().includes('not exist')
            || String(err.message || '').toLowerCase().includes('no such file')) {
          return null;
        }
        throw err;
      }
    }

    async writeFile(name, content) {
      await this._ensureDataDir();
      // Écriture atomique (audit E2) : fichier temporaire puis renommage. Une
      // interruption laisse soit l'ancien fichier, soit le nouveau, jamais un
      // fichier tronqué.
      const finalPath = this._pathFor(name);
      const tmpPath = finalPath + '.tmp';
      await this._fs.writeFile({
        path: tmpPath, data: content,
        directory: this._Directory.Data, encoding: this._Encoding.UTF8, recursive: true,
      });
      try {
        await this._fs.rename({
          from: tmpPath, to: finalPath,
          directory: this._Directory.Data, toDirectory: this._Directory.Data,
        });
      } catch (err) {
        // Certains Android refusent rename sur une cible existante : on supprime
        // puis on renomme (fenêtre minuscule, la copie .bak du coffre couvre ce cas).
        try { await this._fs.deleteFile({ path: finalPath, directory: this._Directory.Data }); } catch {}
        await this._fs.rename({
          from: tmpPath, to: finalPath,
          directory: this._Directory.Data, toDirectory: this._Directory.Data,
        });
      }
    }

    async deleteFile(name) {
      try {
        await this._fs.deleteFile({
          path: this._pathFor(name),
          directory: this._Directory.Data,
        });
      } catch (err) {
        // ok si déjà absent
        if (String(err.message || '').toLowerCase().includes('not exist')) return;
        // Certains impls renvoient autre chose, on tolère.
      }
    }

    async listFiles() {
      try {
        const res = await this._fs.readdir({
          path: this._dataDirName,
          directory: this._Directory.Data,
        });
        // readdir peut retourner string[] (ancien) ou {files: [{name,...}]}
        if (Array.isArray(res.files)) {
          return res.files.map((f) => (typeof f === 'string' ? f : f.name));
        }
        return [];
      } catch (err) {
        if (String(err.message || '').toLowerCase().includes('not exist')) return [];
        throw err;
      }
    }

    // --- Secure storage (Keychain / Keystore) ----------------------------
    //
    // Compatible avec deux formes de `this._secure` :
    //  - Wrapper ESM `SecureStorage` (`@aparajita/capacitor-secure-storage`),
    //    qui expose `.get()` / `.set()` / `.remove()` (utilisé en mode bundler).
    //  - Pont natif brut `Capacitor.Plugins.SecureStorage` (utilisé en WebView
    //    sans bundler), qui n'expose QUE `.internalGetItem` / `.internalSetItem`
    //    / `.internalRemoveItem`. Dans ce cas il faut préfixer la clé
    //    (`'capacitor-storage_' + key`) et encoder la valeur en JSON pour
    //    rester interopérable avec un éventuel accès ultérieur via le wrapper.

    _secureHasWrapperApi() {
      return this._secure
        && typeof this._secure.get === 'function'
        && typeof this._secure.set === 'function'
        && typeof this._secure.remove === 'function';
    }

    // Préfixe par défaut utilisé par SecureStorageBase (cf. node_modules/
    // @aparajita/capacitor-secure-storage/dist/esm/base.js → this.prefix).
    _securePrefixedKey(key) {
      return 'capacitor-storage_' + key;
    }

    async isSecureStorageAvailable() {
      // SecureStorage est toujours dispo côté Capacitor natif (pas sur web fallback).
      return this._platform !== 'web';
    }

    async secureGet(key) {
      try {
        if (this._secureHasWrapperApi()) {
          const v = await this._secure.get(key);
          return v == null ? null : String(v);
        }
        // Mode natif brut : appel direct à internalGetItem.
        const res = await this._secure.internalGetItem({
          prefixedKey: this._securePrefixedKey(key),
          sync: false,
        });
        const data = res && res.data;
        if (data == null) return null;
        // Le wrapper officiel JSON.stringify les valeurs stockées ; on tente
        // donc un JSON.parse, avec fallback sur la string brute si ce n'en est
        // pas (p. ex. valeur écrite par une version antérieure du code).
        try {
          const parsed = JSON.parse(data);
          return parsed == null ? null : String(parsed);
        } catch {
          return String(data);
        }
      } catch (err) {
        // NotFound n'est pas une erreur, renvoie null
        const msg = String(err.message || '').toLowerCase();
        if (msg.includes('not found') || msg.includes('missing')) return null;
        console.error(`[secureGet:${key}]`, err.message);
        return null;
      }
    }

    async secureSet(key, value) {
      if (typeof value !== 'string') throw new TypeError('secureSet : value doit être string');
      if (this._secureHasWrapperApi()) {
        await this._secure.set(key, value);
        return;
      }
      // Mode natif brut. access: 0 == KeychainAccess.whenUnlocked (enum numérique,
      // cf. definitions.js). Ignoré côté Android, requis côté iOS.
      await this._secure.internalSetItem({
        prefixedKey: this._securePrefixedKey(key),
        data: JSON.stringify(value),
        sync: false,
        access: 0,
      });
    }

    async secureDelete(key) {
      try {
        if (this._secureHasWrapperApi()) {
          await this._secure.remove(key);
          return;
        }
        await this._secure.internalRemoveItem({
          prefixedKey: this._securePrefixedKey(key),
          sync: false,
        });
      } catch {
        // no-op si absent
      }
    }

    // --- Pickers utilisateur ---------------------------------------------

    /**
     * Sur mobile on ne peut pas "choisir un chemin" arbitraire. On écrit le
     * contenu dans Directory.Cache puis on propose Share (l'utilisateur envoie
     * à Drive, Mail, Fichiers…). C'est le pattern idiomatic Capacitor.
     */
    async pickSaveFile(defaultName) {
      const fileName = defaultName || `passory-export-${Date.now()}.json`;
      const Directory = this._Directory;
      const Encoding = this._Encoding;
      const fs = this._fs;
      const share = this._share;
      return {
        path: fileName,
        write: async (content) => {
          await fs.writeFile({
            path: fileName,
            data: content,
            directory: Directory.Cache,
            encoding: Encoding.UTF8,
          });
          if (share && typeof share.share === 'function') {
            const uri = await fs.getUri({
              path: fileName,
              directory: Directory.Cache,
            });
            await share.share({
              title: 'Export Passory',
              url: uri.uri,
              dialogTitle: 'Enregistrer ou envoyer le backup',
            });
          }
        },
      };
    }

    /**
     * Fallback DOM : déclenche un <input type="file"> invisible. Si une lib de
     * picker native est branchée plus tard, on remplacera cette implémentation.
     */
    async pickOpenFile() {
      if (typeof document === 'undefined') return null;
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        document.body.appendChild(input);
        let settled = false;
        const done = (v) => {
          if (settled) return;
          settled = true;
          try { document.body.removeChild(input); } catch {}
          resolve(v);
        };
        input.addEventListener('change', async () => {
          const f = input.files && input.files[0];
          if (!f) return done(null);
          try {
            const content = await f.text();
            done({ path: f.name, content });
          } catch { done(null); }
        });
        // Si l'utilisateur ferme la boîte sans choisir, il n'y a pas
        // d'event fiable en cross-browser. On laisse sur "cancel" via focus :
        window.addEventListener('focus', () => {
          // laisse le temps au change event de se déclencher avant de tuer
          setTimeout(() => done(null), 500);
        }, { once: true });
        input.click();
      });
    }

    // --- Identité --------------------------------------------------------

    platform() { return this._platform; }
    deviceClass() { return this._deviceClass; }
  }

  /**
   * Factory qui importe dynamiquement les deps Capacitor. À appeler dans le
   * renderer/WebView après bootstrap Capacitor. Les imports sont async pour
   * rester compatibles avec un projet sans bundler qui ne supporte pas le top-
   * level await (Passory est en JS vanilla, sans build step).
   *
   * En cas de déchargement (web/dev), on peut passer `modules` manuellement.
   */
  async function createCapacitorAdapter(opts = {}) {
    let modules = opts.modules || null;
    if (!modules) {
      // Import dynamique ESM. Les devs qui utilisent ce module doivent avoir
      // un environnement qui supporte import() — c'est le cas de toutes les
      // WebView Capacitor modernes.
      const [fsMod, secMod, shareMod, capMod] = await Promise.all([
        import('@capacitor/filesystem'),
        import('@aparajita/capacitor-secure-storage'),
        import('@capacitor/share').catch(() => null),
        import('@capacitor/core').catch(() => null),
      ]);
      modules = {
        Filesystem: fsMod.Filesystem,
        Directory: fsMod.Directory,
        Encoding: fsMod.Encoding,
        SecureStorage: secMod.SecureStorage,
        Share: shareMod ? shareMod.Share : null,
        Capacitor: capMod ? capMod.Capacitor : null,
      };
    }
    return new CapacitorStorageAdapter(modules, opts.dataDirName);
  }

  return { CapacitorStorageAdapter, createCapacitorAdapter };
});
