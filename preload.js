/**
 * Pont sécurisé entre le renderer (HTML/JS UI) et le process main.
 * Expose une API propre sur window.passory.
 *
 * Règles :
 *  - Aucune donnée sensible (mot de passe maître, clé) ne transite après unlock.
 *  - Tout appel asynchrone renvoie { success, ... } ou lance une exception.
 *  - Les payloads clairs ne voyagent que du renderer vers main (add/update),
 *    et depuis main vers renderer (list). Le chiffrement/déchiffrement a lieu
 *    exclusivement côté main avec la clé en mémoire.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Drapeau transmis par main.js (additionalArguments) depuis src/shared/features.js :
// le preload sandboxé ne peut pas lire ce fichier lui-même.
const FEATURE_TRANSFER = Array.isArray(process.argv) && process.argv.includes('--passory-feature-transfer');

const api = {
  // --- Auth ----------------------------------------------------------
  auth: {
    hasMaster:    () => ipcRenderer.invoke('auth:has-master'),
    isUnlocked:   () => ipcRenderer.invoke('auth:is-unlocked'),
    createMaster: (password) => ipcRenderer.invoke('auth:create-master', password),
    unlock:       (password) => ipcRenderer.invoke('auth:unlock', password),
    lock:         () => ipcRenderer.invoke('auth:lock'),
    changeMaster: (oldPassword, newPassword) =>
                    ipcRenderer.invoke('auth:change-master', { oldPassword, newPassword }),
    // « Repartir de zéro » (mot de passe maître oublié) : coffre verrouillé
    // uniquement, mot de confirmation EFFACER exigé par le process principal.
    resetForgotten: (confirmWord) => ipcRenderer.invoke('auth:reset-forgotten', { confirm: confirmWord }),
  },

  // --- Déverrouillage rapide : n'existe pas sur le bureau (v1.0) -----
  // Aucune clé n'est écrite sur disque : le mot de passe maître est demandé à
  // chaque ouverture. Surface conservée (réponses fixes, sans IPC) pour que
  // les pages partagées avec le mobile n'aient pas de cas particulier.
  quickUnlock: {
    isAvailable: () => Promise.resolve(false),
    isEnabled:   () => Promise.resolve(false),
    enable:      () => Promise.resolve({ success: false, error: 'Le déverrouillage rapide n\'existe pas sur ordinateur.' }),
    disable:     () => Promise.resolve({ success: true }),
    try:         () => Promise.resolve({ success: false }),
  },

  // --- Coffre unifié (tous types d'items) ----------------------------
  items: {
    // Les listes sont expurgées : champs sensibles vides, payload._has / _hint.
    list:   (type)    => ipcRenderer.invoke('items:list', type || null),
    get:    (id)      => ipcRenderer.invoke('items:get', id),
    copyField: (id, field) => ipcRenderer.invoke('items:copy-field', { id, field }),
    totp:   (id)      => ipcRenderer.invoke('items:totp', id),
    add:    (type, payload) => ipcRenderer.invoke('items:add', { type, payload }),
    update: (id, payload)   => ipcRenderer.invoke('items:update', { id, payload }),
    delete: (id)      => ipcRenderer.invoke('items:delete', id),
    counts: ()        => ipcRenderer.invoke('items:counts'),
    copy:   (text)    => ipcRenderer.invoke('items:copy', text),
  },

  // --- Mots de passe (alias legacy — utilise items sous le capot) ----
  passwords: {
    list:   () => ipcRenderer.invoke('passwords:list'),
    add:    (entry) => ipcRenderer.invoke('passwords:add', entry),
    update: (entry) => ipcRenderer.invoke('passwords:update', entry),
    delete: (id) => ipcRenderer.invoke('passwords:delete', id),
    copy:   (text) => ipcRenderer.invoke('passwords:copy', text),
  },

  // --- Générateur de mots de passe (côté main, CSPRNG) ---------------
  generator: {
    make: (opts) => ipcRenderer.invoke('generator:make', opts || {}),
  },

  // --- Paramètres ----------------------------------------------------
  settings: {
    get:   () => ipcRenderer.invoke('settings:get'),
    set:   (partial) => ipcRenderer.invoke('settings:set', partial),
    reset: () => ipcRenderer.invoke('settings:reset'),
  },

  // --- Backup chiffré -----------------------------------------------
  backup: {
    // L'export et l'import en mode « remplacer » exigent le mot de passe maître.
    export: (passphrase, masterPassword) => ipcRenderer.invoke('backup:export', { passphrase, masterPassword }),
    import: (passphrase, mode, masterPassword) => ipcRenderer.invoke('backup:import', { passphrase, mode, masterPassword }),
  },

  // --- Danger zone --------------------------------------------------
  danger: {
    wipe: (masterPassword) => ipcRenderer.invoke('danger:wipe', { masterPassword }),
  },

  // --- Fenêtre (contrôles custom titlebar) ---------------------------
  window: {
    minimize:       () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close:          () => ipcRenderer.send('window:close'),
    onMaximize:     (cb) => { ipcRenderer.on('window:maximized', () => cb()); },
    onUnmaximize:   (cb) => { ipcRenderer.on('window:unmaximized', () => cb()); },
  },

  // --- Informations sur l'application (À propos) --------------------
  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },

  // --- Activity ping (reset du timer d'auto-lock) --------------------
  ping: () => ipcRenderer.send('activity'),
};

// --- Transfert par câble PCTP : exposé seulement si FEATURES.transfer (désactivé en v1.0)
// Flux sender : listen({ ids }) → onEvent(cb) → sasConfirm() ; receiver :
// connect({ host }) → onEvent(cb) → sasConfirm() → saveReceived().
if (FEATURE_TRANSFER) api.transfer = {
    /** Sender — ouvre le serveur TCP et charge les items à envoyer. */
    listen: (opts) => ipcRenderer.invoke('pctp:listen', opts || {}),

    /** Receiver — se connecte au sender (host: string, défaut 127.0.0.1). */
    connect: (opts) => ipcRenderer.invoke('pctp:connect', opts || {}),

    /** L'utilisateur a vérifié visuellement les mots SAS et confirme. */
    sasConfirm: () => ipcRenderer.invoke('pctp:sas-confirm'),

    /** No-op de compatibilité — l'envoi est automatique via listen(). */
    transfer: (opts) => ipcRenderer.invoke('pctp:transfer', opts || {}),

    /** Receiver — confirme l'enregistrement des items reçus (conservés côté main). */
    saveReceived: () => ipcRenderer.invoke('pctp:save-received'),

    /** Annule la session en cours (sender ou receiver). */
    cancel: () => ipcRenderer.invoke('pctp:cancel'),

    /**
     * Abonne un callback aux événements PCTP temps-réel.
     * Retourne une fonction de désabonnement : const off = onEvent(cb); off();
     */
    onEvent: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('pctp:event', handler);
      return () => ipcRenderer.removeListener('pctp:event', handler);
    },
};

contextBridge.exposeInMainWorld('passory', api);
