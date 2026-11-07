/**
 * ElectronStorageAdapter — implémentation du contrat `src/shared/storage/adapter.js`
 * pour le process main Electron. Wraps :
 *
 *   - fs            (lecture/écriture dans data/)
 *   - dialog        (pickers Save/Open fournis par Electron)
 *
 * Stockage sécurisé : VOLONTAIREMENT ABSENT sur le bureau (v1.0, audit M2).
 * Aucune clé (ni clé de session, ni clé de déblocage rapide DPAPI/safeStorage)
 * n'est jamais écrite sur disque : isSecureStorageAvailable() vaut false,
 * secureGet() renvoie null et secureSet() refuse. secureDelete() reste actif
 * pour supprimer les fichiers laissés par une version antérieure
 * (quickunlock.vault, secure/session-key.vault).
 *
 * Usage :
 *   const { createElectronAdapter } = require('./platform/electron/storage-fs');
 *   const adapter = createElectronAdapter({
 *     app, dialog,
 *     getMainWindow: () => mainWindow,   // peut retourner null avant ready
 *     dataDir: path.join(__dirname, 'data'),
 *   });
 *   items.setAdapter(adapter); settings.setAdapter(adapter); ...
 *
 * Écriture atomique : write-then-rename via fichier temporaire .tmp pour éviter
 * les coffres corrompus en cas de coupure de courant pendant writeFileSync.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { StorageAdapter } = require('../../src/shared/storage/adapter.js');

// Mapping logique→disque pour le secure storage :
//   - "master-key" : ancien fichier de déblocage rapide data/quickunlock.vault
//     (versions < 1.0), connu uniquement pour pouvoir le SUPPRIMER.
//   - tout le reste : data/secure/<key>.vault
function secureFilePathFor(dataDir, key) {
  if (key === 'master-key') return path.join(dataDir, 'quickunlock.vault');
  // Sanitize : on n'accepte que [a-zA-Z0-9._-]
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
    throw new Error('secure key invalide : ' + key);
  }
  return path.join(dataDir, 'secure', key + '.vault');
}

class ElectronStorageAdapter extends StorageAdapter {
  constructor({ app, dialog, getMainWindow, dataDir }) {
    super();
    this._app = app;
    this._dialog = dialog;
    this._getMainWindow = getMainWindow || (() => null);
    this._dataDir = dataDir;
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _filePath(name) {
    if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name.includes('\\')) {
      throw new Error('nom de fichier invalide : ' + name);
    }
    return path.join(this._dataDir, name);
  }

  // --- Fichiers coffre ---------------------------------------------------

  async readFile(name) {
    const p = this._filePath(name);
    try {
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, 'utf-8');
    } catch (err) {
      // Un fichier illisible doit remonter l'erreur : c'est différent d'absent.
      throw new Error(`readFile(${name}) : ${err.message}`);
    }
  }

  async writeFile(name, content) {
    const p = this._filePath(name);
    this._ensureDir(this._dataDir);
    // Écriture atomique : écrire dans .tmp puis renommer.
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, p);
  }

  async deleteFile(name) {
    const p = this._filePath(name);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      throw new Error(`deleteFile(${name}) : ${err.message}`);
    }
  }

  async listFiles() {
    try {
      if (!fs.existsSync(this._dataDir)) return [];
      return fs.readdirSync(this._dataDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);
    } catch (err) {
      throw new Error(`listFiles : ${err.message}`);
    }
  }

  // --- Stockage sécurisé : aucun sur le bureau (aucune clé sur disque) ----

  async isSecureStorageAvailable() { return false; }

  async secureGet(_key) { return null; }

  async secureSet(key) {
    throw new Error('Refusé : aucune clé n\'est écrite sur disque côté bureau (' + key + ').');
  }

  async secureDelete(key) {
    try {
      const p = secureFilePathFor(this._dataDir, key);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      console.error(`[secureDelete:${key}]`, err.message);
    }
  }

  // --- Pickers utilisateur (backups) ------------------------------------

  async pickSaveFile(defaultName) {
    const win = this._getMainWindow();
    const res = await this._dialog.showSaveDialog(win, {
      title: 'Exporter',
      defaultPath: defaultName || 'passory-export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const filePath = res.filePath;
    return {
      path: filePath,
      write: async (content) => {
        fs.writeFileSync(filePath, content, 'utf-8');
      },
    };
  }

  async pickOpenFile() {
    const win = this._getMainWindow();
    const res = await this._dialog.showOpenDialog(win, {
      title: 'Importer',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const filePath = res.filePaths[0];
    const stat = fs.statSync(filePath);
    if (stat.size > 50 * 1024 * 1024) {
      throw new Error(`Fichier trop volumineux (max 50 Mo).`);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { path: filePath, content };
  }

  // --- Identité ----------------------------------------------------------

  platform() { return 'electron'; }
  deviceClass() { return 'desktop'; }
}

function createElectronAdapter(opts) {
  return new ElectronStorageAdapter(opts);
}

module.exports = { ElectronStorageAdapter, createElectronAdapter };
