/**
 * web-bootstrap.js — Point d'entrée du runtime Passory en WebView Capacitor.
 *
 * Rôle :
 *  1. Charger en séquence tous les modules UMD (crypto partagé, métier, core,
 *     adapter Capacitor, argon2-browser WASM) via insertion dynamique de
 *     balises <script>. L'ordre est important à cause des dépendances UMD.
 *  2. Instancier le StorageAdapter Capacitor + injecter dans items/settings.
 *  3. Construire l'`app-core` avec le provider argon2-browser enregistré.
 *  4. Exposer `window.passory` avec la MÊME surface que celle injectée par
 *     preload.js côté Electron, pour que les pages HTML/JS UI ne changent pas.
 *
 * Usage dans chaque page HTML (avant tout autre script applicatif) :
 *   <script src="src/platform/web-bootstrap.js" defer></script>
 *   <script>
 *     window.addEventListener('passory:ready', () => { initUI(); });
 *   </script>
 *
 * Si `window.passory` existe déjà (context Electron preload), ce bootstrap
 * se désactive — on ne remplace JAMAIS l'API native.
 */
'use strict';

(function () {
  // --- Garde : en Electron, preload.js a déjà posé window.passory ---------
  if (typeof window === 'undefined') return;
  if (window.passory && !window.passory.__pending && !window.__passoryForceMobile) {
    // Rien à faire, on émet quand même ready pour homogénéiser les callers.
    window.addEventListener('DOMContentLoaded', () => {
      try { window.dispatchEvent(new Event('passory:ready')); } catch {}
    }, { once: true });
    return;
  }

  // --- Séquence de chargement (ordre = topologique sur les deps UMD) ------
  // Chemins relatifs depuis la racine du webDir Capacitor (= racine du projet).
  const SCRIPTS = [
    // 1. argon2-browser WASM : lib externe chargée AVANT le provider.
    //    On utilise la version BUNDLED UMD qui pose `window.argon2` ; l'autre
    //    fichier `vendor/argon2.js` est la sortie Emscripten brute qui expose
    //    seulement `Module` (pour un loader ESM) et ne sert à rien ici.
    'vendor/argon2-bundled.min.js',

    // 2. Crypto partagé (random → kdf → legacy-v1 (lecture) → aead → generator).
    'src/shared/crypto/random.js',
    'src/shared/crypto/kdf.js',
    'src/shared/crypto/legacy-v1.js',
    'src/shared/crypto/aead.js',
    'src/shared/generator.js',
    'src/shared/totp.js',

    // 3. StorageAdapter contract + implémentation Capacitor.
    'src/shared/storage/adapter.js',
    'platform/capacitor/storage-cap.js',
    'platform/capacitor/argon2-provider.js',

    // 4. Modules métier (dépendent du crypto partagé).
    'items.js',
    'settings.js',
    'backup.js',

    // 5. Logique métier plateforme-neutre.
    'src/core/app-core.js',
  ];

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;   // préserve l'ordre d'exécution
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('échec chargement : ' + src));
      document.head.appendChild(s);
    });
  }

  async function loadAllInOrder() {
    for (const src of SCRIPTS) {
      try { await loadScript(src); }
      catch (err) {
        // argon2.js est "best-effort" : si le dev n'a pas copié le WASM, on
        // laisse le provider échouer plus tard avec un message clair.
        if (src.includes('argon2.js')) {
          console.warn('[bootstrap] argon2-browser absent — quick unlock / unlock seront en erreur tant que vendor/argon2.js n\'est pas copié.');
          continue;
        }
        console.error('[bootstrap]', err.message);
        throw err;
      }
    }
  }

  // --- Construction du surface window.passory ----------------------------
  function buildPassorySurface(core) {
    return {
      auth: {
        hasMaster:    () => core.hasMaster(),
        isUnlocked:   () => Promise.resolve(core.isUnlocked()),
        createMaster: (password) => core.createMaster(password),
        unlock:       (password) => core.unlock(password),
        lock:         () => Promise.resolve(core.lock()),
        changeMaster: (oldPassword, newPassword) => core.changeMaster({ oldPassword, newPassword }),
        // « Repartir de zéro » : même cœur que le bureau (coffre verrouillé,
        // mot EFFACER, une demande à la fois). La page revient ensuite d'elle-même
        // à l'écran de création du mot de passe maître.
        resetForgotten: (confirmWord) => core.resetForgotten({ confirm: confirmWord }),
      },
      quickUnlock: {
        isAvailable: () => core.quickUnlockAvailable(),
        isEnabled:   () => core.quickUnlockEnabled(),
        enable:      () => core.quickUnlockEnable(),
        disable:     () => core.quickUnlockDisable(),
        try:         () => core.quickUnlockTry(),
      },
      items: {
        list:   (type)           => core.itemsListRedacted(type || null),
        get:    (id)             => core.itemsGet(id),
        copyField: (id, field)   => core.itemsCopyField({ id, field }),
        totp:   (id)             => core.itemsTotp(id),
        add:    (type, payload)  => core.itemsAdd({ type, payload }),
        update: (id, payload)    => core.itemsUpdate({ id, payload }),
        delete: (id)             => core.itemsDelete(id),
        counts: ()               => core.itemsCounts(),
        copy:   (text)           => core.itemsCopy(text),
      },
      passwords: {
        list:   ()      => core.passwordsListRedacted(),
        add:    (entry) => core.passwordsAdd(entry),
        update: (entry) => core.passwordsUpdate(entry),
        delete: (id)    => core.passwordsDelete(id),
        copy:   (text)  => core.passwordsCopy(text),
      },
      generator: {
        make: (opts) => Promise.resolve(core.generatorMake(opts || {})),
      },
      settings: {
        get:   () => core.settingsGet(),
        set:   (partial) => core.settingsSet(partial),
        reset: () => core.settingsReset(),
      },
      backup: {
        export: (passphrase, masterPassword) => core.backupExport({ passphrase, masterPassword }),
        import: (passphrase, mode, masterPassword) => core.backupImport({ passphrase, mode, masterPassword }),
      },
      danger: {
        wipe: (masterPassword) => core.dangerWipe(masterPassword),
      },
      // En mobile, les contrôles titlebar custom n'ont pas de sens : on
      // retourne des no-ops pour que les pages qui appellent
      // window.passory.window.minimize() ne plantent pas.
      window: {
        minimize: () => {},
        toggleMaximize: () => {},
        close: () => {},
        onMaximize: () => {},
        onUnmaximize: () => {},
      },
      ping: () => core.touchActivity(),
    };
  }

  // --- Clipboard Capacitor wrapper --------------------------------------
  function buildClipboard(Capacitor) {
    // Plugin local Android : texte marqué « sensible » (audit M7).
    const Sensitive = Capacitor && Capacitor.Plugins && Capacitor.Plugins.SensitiveClipboard;
    if (Sensitive && typeof Sensitive.write === 'function') {
      // Effacement programmé côté natif (fonctionne en arrière-plan) ; pas de
      // readText : le cœur ne gère alors pas de minuteur JS.
      return {
        writeText: (s) => Sensitive.write({
          string: s,
          clearAfterSeconds: (window.PassorySettings && window.PassorySettings.getCached().clipboardClearSeconds) || 0,
        }),
      };
    }
    const Clipboard = Capacitor && Capacitor.Plugins && Capacitor.Plugins.Clipboard;
    if (!Clipboard) {
      // Fallback navigator.clipboard.
      return {
        writeText: (s) => { try { navigator.clipboard && navigator.clipboard.writeText(s); } catch {} },
        readText: () => { try { return navigator.clipboard ? navigator.clipboard.readText() : ''; } catch { return ''; } },
        clear: () => { try { navigator.clipboard && navigator.clipboard.writeText(''); } catch {} },
      };
    }
    return {
      writeText: (s) => { Clipboard.write({ string: s }).catch(() => {}); },
      // Sur mobile, lecture du presse-papier n'est pas toujours dispo sans
      // geste utilisateur. On fait au mieux.
      readText: async () => {
        try { const r = await Clipboard.read(); return (r && r.value) || ''; }
        catch { return ''; }
      },
      clear: () => { Clipboard.write({ string: '' }).catch(() => {}); },
    };
  }

  // --- Boot complet ------------------------------------------------------
  async function requireBiometry(plugins, reason) {
    const P = plugins && plugins.BiometricAuthNative;
    if (!P || typeof P.internalAuthenticate !== 'function') {
      console.warn('[bootstrap] plugin biométrique absent : déverrouillage rapide refusé.');
      return false;
    }
    try {
      await P.internalAuthenticate({
        reason: reason || 'Déverrouiller Passory',
        cancelTitle: 'Annuler',
        allowDeviceCredential: true,
        iosFallbackTitle: 'Utiliser le code',
        androidTitle: 'Passory',
        androidSubtitle: reason || 'Déverrouiller le coffre',
        androidConfirmationRequired: false,
        androidBiometryStrength: 1, // strong
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  async function boot() {
    // Marque le body tôt pour que mobile.css s'applique avant les premiers
    // paints (on le fait AVANT loadAllInOrder pour que les pages chargées
    // pendant le boot soient déjà stylées mobile).
    try {
      const isNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
      if (isNative && document.body) document.body.classList.add('is-capacitor');
    } catch {}

    await loadAllInOrder();

    // Sécurité : vérifie que les globaux UMD sont bien posés.
    const required = [
      'PassoryRandom', 'PassoryKDF', 'PassoryLegacyV1', 'PassoryAEAD', 'PassoryGenerator',
      'PassoryItems', 'PassorySettings', 'PassoryBackup', 'PassoryAppCore',
      'PassoryCapacitorStorage',
    ];
    for (const name of required) {
      if (!window[name]) throw new Error('[bootstrap] global manquant : ' + name);
    }

    // 1. Branche le provider argon2-browser sur le KDF partagé.
    if (window.PassoryArgon2ProviderCapacitor) {
      window.PassoryKDF.setProvider(window.PassoryArgon2ProviderCapacitor);
    } else {
      console.error('[bootstrap] argon2 provider absent. unlock() échouera.');
    }

    // 2. Construit le StorageAdapter Capacitor via son factory async.
    //    On DOIT passer les modules dans opts.modules pour que le factory ne
    //    tente pas un `import('@capacitor/filesystem')` dynamique — la WebView
    //    n'a pas de résolveur de bare specifier (pas de bundler). Les enums
    //    Directory/Encoding ne sont pas attachés à Capacitor.Plugins.Filesystem
    //    (ce sont des exports séparés du package ESM), on les hardcode avec
    //    les mêmes valeurs que celles utilisées en interne par le plugin natif.
    const Capacitor = window.Capacitor || {};
    const plugins = Capacitor.Plugins || {};
    const Directory = {
      Documents:       'DOCUMENTS',
      Data:            'DATA',
      Library:         'LIBRARY',
      Cache:           'CACHE',
      External:        'EXTERNAL',
      ExternalStorage: 'EXTERNAL_STORAGE',
      ExternalCache:   'EXTERNAL_CACHE',
    };
    const Encoding = {
      UTF8:   'utf8',
      ASCII:  'ascii',
      UTF16:  'utf16',
    };
    const adapter = await window.PassoryCapacitorStorage.createCapacitorAdapter({
      modules: {
        Filesystem:    plugins.Filesystem,
        Directory,
        Encoding,
        SecureStorage: plugins.SecureStorage,
        Share:         plugins.Share || null,
        Capacitor,
      },
    });

    // 3. Injection dans les modules métier.
    window.PassoryItems.setAdapter(adapter);
    window.PassorySettings.setAdapter(adapter);

    // 4. Warm-up du cache settings (touchActivity lit en sync).
    await window.PassorySettings.readSettings();

    // 5. Adapte argon2 en fonction du device class (si l'adapter le connaît).
    //    Méthode sync `deviceClass()` — pas de "get" prefix (cf. storage-cap.js).
    if (typeof adapter.deviceClass === 'function') {
      try {
        const cls = adapter.deviceClass();
        // recommendedOpts() est lu par app-core via sharedKDF.DEFAULT_OPTS ; on
        // overridera au cas par cas plus tard si besoin (à brancher via
        // sharedKDF.setDefaults() à implémenter si la recommendation bouge).
        void cls;
      } catch {}
    }

    // 6. Construction du core.
    const core = window.PassoryAppCore.createAppCore({
      adapter,
      modules: {
        items:     window.PassoryItems,
        settings:  window.PassorySettings,
        backup:    window.PassoryBackup,
        legacyV1:  window.PassoryLegacyV1,
        sharedRng: window.PassoryRandom,
        sharedGen: window.PassoryGenerator,
        sharedKDF: window.PassoryKDF,
        aead:      window.PassoryAEAD,
        totp:      window.PassoryTOTP,
      },
      clipboard: buildClipboard(Capacitor),
      // Mobile : la session survit aux changements de page (TTL court).
      persistSession: true,
      // Mobile : déverrouillage biométrique conservé (clé dans le Keystore via
      // SecureStorage, biométrie exigée avant chaque usage).
      allowQuickUnlock: true,
      // Biométrie OBLIGATOIRE avant toute utilisation de la clé du
      // déverrouillage rapide (audit E3). Échec ou absence du plugin = refus.
      requireUserPresence: (reason) => requireBiometry(plugins, reason),
      onAutoLock: () => {
        // Retour à la page login sur auto-lock (fallback si pas de SPA).
        try { window.location.href = 'login.html'; } catch {}
      },
    });

    // 7. Reprise de session persistée — CRUCIAL en mode multi-page :
    //    chaque page HTML recharge ce bootstrap from scratch, donc
    //    inMemoryMasterKey repart à null. Sans cet appel, l'utilisateur
    //    serait forcé de retaper son master password à chaque navigation
    //    (dashboard → items → settings → …). core.sessionTryResume() lit
    //    SecureStorage['session-key'] (posée par unlock/createMaster/quickUnlock),
    //    valide l'expiration + le verifier, et restaure l'état unlocked.
    //    No-op si rien en session ou session expirée → user atterrit sur login.
    try { await core.sessionTryResume(); }
    catch (err) { console.warn('[bootstrap] sessionTryResume :', err.message); }

    // Cycle de vie (audit relecture #4) : la clé de session n'existe dans le
    // stockage que tant que l'appli est au premier plan. Arrière-plan → on la
    // retire ; retour après plus d'une minute → verrouillage.
    let pausedAt = 0;
    const AppPlugin = plugins.App;
    if (AppPlugin && typeof AppPlugin.addListener === 'function') {
      AppPlugin.addListener('pause', () => { pausedAt = Date.now(); core.sessionSuspend(); });
      AppPlugin.addListener('resume', async () => {
        if (pausedAt && Date.now() - pausedAt > 60_000) {
          await core.lock();
          try { window.location.href = 'login.html'; } catch {}
        } else {
          core.sessionRefresh();
        }
        pausedAt = 0;
      });
    }
    // Battement : prouve que l'appli est au premier plan (cf. SESSION_FRESH_MS).
    setInterval(() => {
      if (document.visibilityState === 'visible' && core.isUnlocked()) core.sessionRefresh();
    }, 20_000);

    // 8. Expose la surface sur window.passory.
    window.passory = buildPassorySurface(core);

    // 9. Activity ping global : touch sur chaque interaction utilisateur.
    ['click', 'keydown', 'touchstart'].forEach((evt) => {
      window.addEventListener(evt, () => { try { core.touchActivity(); } catch {} }, { passive: true });
    });

    // 10. Notifie les pages.
    try { window.dispatchEvent(new Event('passory:ready')); } catch {}
  }

  // On attend Capacitor prêt avant de tenter de charger ses plugins.
  // Le runtime Capacitor expose window.Capacitor dès que le JS injecté par
  // cordova.js / capacitor.js a tourné. Sur WebView Android/iOS c'est
  // disponible synchrone au moment où nos scripts se chargent, mais on
  // ajoute un fallback défensif basé sur DOMContentLoaded.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot().catch((err) => console.error('[bootstrap]', err)); }, { once: true });
  } else {
    boot().catch((err) => console.error('[bootstrap]', err));
  }
})();
