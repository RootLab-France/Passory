/**
 * StorageAdapter — interface abstraite pour la persistance locale.
 *
 * Chaque plateforme fournit son implémentation concrète :
 *  - Electron : platform/electron/storage-fs.js  (fs + dialog ; aucun stockage de clé, v1.0)
 *  - Android  : platform/capacitor/storage-cap.js (Filesystem + SecureStorage + Share)
 *  - iOS      : idem Android (Capacitor mutualise)
 *
 * Le code métier (items, settings, backup) ne manipule JAMAIS fs/Filesystem
 * directement. Il passe uniquement par l'adapter.
 *
 * Contrat des méthodes :
 *
 *  --- Fichiers du coffre (chiffrés, écrits dans le "data dir" privé) ---
 *  readFile(name): Promise<string | null>
 *    Lit un fichier par nom court (ex "items.vault"). Retourne null si absent.
 *    Jamais de chemin absolu en entrée : l'adapter gère la résolution.
 *
 *  writeFile(name, content): Promise<void>
 *    Écrit atomiquement (write-then-rename idéalement).
 *
 *  deleteFile(name): Promise<void>
 *    No-op si le fichier n'existe pas.
 *
 *  listFiles(): Promise<string[]>
 *    Liste les fichiers du data dir (filtrer *.vault, *.json).
 *
 *  --- Secrets du déverrouillage biométrique (MOBILE uniquement) ---
 *  Sur le bureau (v1.0), aucune clé n'est écrite sur disque :
 *  isSecureStorageAvailable() = false, secureGet() = null, secureSet() lève ;
 *  secureDelete() sert à supprimer les fichiers d'anciennes versions.
 *  secureGet(key): Promise<string | null>
 *    Récupère une valeur chiffrée par le secure storage OS. Retourne null si
 *    la clé n'existe pas ou si le déchiffrement échoue (OS a invalidé, ex.
 *    changement de mot de passe utilisateur Windows).
 *
 *  secureSet(key, value): Promise<void>
 *  secureDelete(key): Promise<void>
 *
 *  isSecureStorageAvailable(): Promise<boolean>
 *    Vérifie si le secure storage est utilisable (Android Keystore,
 *    Keychain iOS). Toujours false sur le bureau.
 *
 *  --- Interaction utilisateur (pour les backups .pasbak) ---
 *  pickSaveFile(defaultName): Promise<{path: string, write: (content: string) => Promise<void>} | null>
 *    Ouvre un dialog Save-As. Retourne un handle abstrait ou null si annulé.
 *
 *  pickOpenFile(): Promise<{path: string, content: string} | null>
 *    Ouvre un dialog Open. Retourne le contenu lu ou null si annulé.
 *
 *  --- Identité plateforme ---
 *  platform(): "electron" | "android" | "ios" | "web"
 *  deviceClass(): "desktop" | "mobile-high" | "mobile-low"
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryStorageAdapter = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  class StorageAdapter {
    async readFile(name) { throw notImpl('readFile'); }
    async writeFile(name, content) { throw notImpl('writeFile'); }
    async deleteFile(name) { throw notImpl('deleteFile'); }
    async listFiles() { throw notImpl('listFiles'); }

    async secureGet(key) { throw notImpl('secureGet'); }
    async secureSet(key, value) { throw notImpl('secureSet'); }
    async secureDelete(key) { throw notImpl('secureDelete'); }
    async isSecureStorageAvailable() { return false; }

    async pickSaveFile(defaultName) { throw notImpl('pickSaveFile'); }
    async pickOpenFile() { throw notImpl('pickOpenFile'); }

    platform() { return 'unknown'; }
    deviceClass() { return 'desktop'; }
  }

  function notImpl(fn) {
    return new Error(`StorageAdapter.${fn}() non implémenté par cet adapter`);
  }

  return { StorageAdapter };
});
