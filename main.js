/**
 * Passory — Electron main process (Phase 4 — refactoré sur app-core).
 *
 * Rôle de ce fichier :
 *   - Bootstrap Electron (app/BrowserWindow).
 *   - Instanciation du StorageAdapter Electron et injection dans les modules
 *     métier (items, settings) + construction de `app-core` (logique
 *     plateforme-neutre).
 *   - Routage des canaux ipcMain vers les méthodes de `core`.
 *
 * La logique métier (auth, items, backup, generator…) vit dans
 * `src/core/app-core.js` et est RÉUTILISÉE par le bootstrap mobile
 * (src/platform/web-bootstrap.js). Ce fichier se limite donc au câblage.
 *
 * Sécurité :
 *  - Pas de compte, un unique master password (jamais en clair sur disque).
 *  - Master key en mémoire main uniquement.
 *  - Aucune clé sur disque (v1.0) : pas de déblocage rapide sur le bureau, le
 *    mot de passe maître est demandé à chaque ouverture. Un ancien fichier
 *    quickunlock.vault est supprimé au démarrage.
 *  - Transfert entre appareils (PCTP) désactivé en v1.0 : cf. src/shared/features.js.
 *  - Auto-lock après N minutes d'inactivité, lock on minimize optionnel.
 */

'use strict';

const { app, BrowserWindow, ipcMain, clipboard, dialog, powerMonitor, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

// --- Boot crypto partagé -----------------------------------------------
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

const legacyV1  = require('./src/shared/crypto/legacy-v1.js'); // lecture seule (migration v1)
const sharedKDF = require('./src/shared/crypto/kdf.js');
const sharedRng = require('./src/shared/crypto/random.js');
const sharedGen = require('./src/shared/generator.js');
const sharedAEAD = require('./src/shared/crypto/aead.js');
const sharedTOTP = require('./src/shared/totp.js');

// Provider argon2id natif pour Electron. Sur mobile on enregistre à la place
// un provider argon2-browser WASM (platform/capacitor/argon2-provider.js).
sharedKDF.setProvider(require('./platform/electron/argon2-provider.js'));

// --- StorageAdapter + modules métier + app-core ------------------------
const { createElectronAdapter } = require('./platform/electron/storage-fs.js');
const { createAppCore }         = require('./src/core/app-core.js');

const settings = require('./settings');
const items    = require('./items');
const backup   = require('./backup');

const IS_DEV = !app.isPackaged;

// Interrupteurs de fonctions (v1.0 : transfert PCTP désactivé).
const FEATURES = require('./src/shared/features.js');

// Pages de l'application : seules autorisées à naviguer et à appeler l'IPC.
const APP_ROOT_URL = pathToFileURL(__dirname + path.sep).href;
function isAppUrl(u) {
  return typeof u === 'string' && u.startsWith(APP_ROOT_URL) && !u.includes('..');
}
/** Page d'une fonction désactivée (ex. transfer.html tant que FEATURES.transfer = false). */
function isDisabledPage(u) {
  if (FEATURES.transfer) return false;
  try { return /\/transfer\.html$/.test(new URL(u).pathname); } catch { return false; }
}

const SECURE_WEB_PREFS = { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
  webviewTag: false, navigateOnDragDrop: false, spellcheck: false };

/**
 * Dossier du coffre : userData (audit M3). Avant, le coffre vivait dans
 * __dirname/data, c'est-à-dire dans le dossier de l'application (lecture
 * seule une fois packagé). Au premier lancement on COPIE l'ancien dossier
 * (sans la clé de session) ; l'original n'est pas supprimé.
 */
function resolveDataDir() {
  const dataDir = path.join(app.getPath('userData'), 'vault');
  const legacyDir = path.join(__dirname, 'data');
  try {
    const hasNew = fs.existsSync(dataDir) && fs.readdirSync(dataDir).some((f) => /\.(vault|json)$/.test(f));
    const hasLegacy = fs.existsSync(legacyDir) && fs.readdirSync(legacyDir).some((f) => /\.(vault|json)$/.test(f));
    if (!hasNew && hasLegacy) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.cpSync(legacyDir, dataDir, {
        recursive: true,
        // Ni clé de session ni clé de déblocage rapide : aucune clé sur disque (M2).
        filter: (src) => !/(session-key|quickunlock|master-key)\.vault$/.test(src) && !/\.tmp$/.test(src),
      });
      try {
        fs.writeFileSync(path.join(legacyDir, 'LISEZ-MOI-coffre-deplace.txt'),
          'Le coffre Passory a été copié vers :\n' + dataDir + '\n\nUne fois que vous avez vérifié que tout fonctionne, vous pouvez supprimer ce dossier.\n');
      } catch {}
      console.log('[boot] coffre copié vers', dataDir);
    }
    // Ancienne clé de session (format d'avant correctif) : ne doit plus traîner.
    try { fs.rmSync(path.join(legacyDir, 'secure', 'session-key.vault'), { force: true }); } catch {}
  } catch (err) {
    console.error('[boot] migration du dossier de données :', err.message);
  }
  return dataDir;
}

// --- État runtime ------------------------------------------------------
let mainWindow   = null;
let loaderWindow = null;
let storage      = null;
let core         = null;

// --- Fenêtres ----------------------------------------------------------
function createLoaderWindow() {
  loaderWindow = new BrowserWindow({
    width: 400, height: 300, frame: false, resizable: false, show: false,
    backgroundColor: '#111827',
    webPreferences: { ...SECURE_WEB_PREFS, devTools: IS_DEV },
  });
  loaderWindow.loadFile(path.join(__dirname, 'loader.html'));
  loaderWindow.once('ready-to-show', () => loaderWindow && loaderWindow.show());
}
function closeLoaderWindow() {
  if (loaderWindow && !loaderWindow.isDestroyed()) loaderWindow.close();
  loaderWindow = null;
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 700, minWidth: 900, minHeight: 600,
    frame: false, show: false, backgroundColor: '#111827',
    webPreferences: {
      ...SECURE_WEB_PREFS,
      preload: path.join(__dirname, 'preload.js'),
      devTools: IS_DEV,
      // Le preload (sandboxé) ne peut pas lire features.js : on lui passe le drapeau.
      additionalArguments: FEATURES.transfer ? ['--passory-feature-transfer'] : [],
    },
  });
  mainWindow.removeMenu();

  const hasM = await core.hasMaster();
  if (!hasM) mainWindow.loadFile(path.join(__dirname, 'create-master-password.html'));
  else       mainWindow.loadFile(path.join(__dirname, 'login.html'));

  mainWindow.once('ready-to-show', () => {
    closeLoaderWindow();
    mainWindow.show();
  });

  mainWindow.on('minimize', () => {
    const s = settings.getCached();
    if (s.lockOnMinimize && core.isUnlocked()) {
      core.lock();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(path.join(__dirname, 'login.html'), { query: { raison: 'reduction' } });
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; if (core) core.lock(); });
}

// --- Durcissement global (audit M4) ----------------------------------------
app.on('web-contents-created', (_e, contents) => {
  // Aucune navigation hors des pages de l'application, aucune nouvelle fenêtre.
  contents.on('will-navigate', (ev, url) => {
    if (!isAppUrl(url)) { ev.preventDefault(); return; }
    // Fonction désactivée en v1.0 : retour à l'accueil.
    if (isDisabledPage(url)) { ev.preventDefault(); contents.loadFile(path.join(__dirname, 'dashboard.html')); }
  });
  contents.on('will-redirect', (ev, url) => { if (!isAppUrl(url)) ev.preventDefault(); });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

/**
 * Copie protégée sous Windows (audit M7) : le texte est posé avec les formats
 * ExcludeClipboardContentFromMonitorProcessing, CanIncludeInClipboardHistory=0
 * et CanUploadToCloudClipboard=0 → absent de l'historique Win+V et de la
 * synchronisation cloud. Le secret passe par stdin (base64), jamais en argument.
 * Repli sur la copie Electron classique si PowerShell échoue.
 */
const PS_PROTECTED_COPY = [
  '$ErrorActionPreference = "Stop"',
  '$b = [Console]::In.ReadToEnd().Trim()',
  '$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$d = New-Object System.Windows.Forms.DataObject',
  '$d.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $t)',
  'foreach ($f in @("ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard")) { $d.SetData($f, (New-Object System.IO.MemoryStream(,[byte[]](0,0,0,0)))) }',
  '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)',
].join('\r\n');
// -EncodedCommand : script en UTF-16LE base64, aucun problème d'échappement.
const PS_PROTECTED_COPY_B64 = Buffer.from(PS_PROTECTED_COPY, 'utf16le').toString('base64');

let _clipWarned = false;
function warnClipboardOnce() {
  if (_clipWarned) return;
  _clipWarned = true;
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'warning',
    title: 'Passory — presse-papier',
    message: 'La copie protégée est indisponible sur ce poste.',
    detail: 'Les éléments copiés peuvent apparaître dans l\'historique du presse-papier Windows (Win+V) ou être synchronisés. '
      + 'Ils restent effacés automatiquement après le délai configuré. Vous pouvez désactiver l\'historique dans Paramètres Windows › Système › Presse-papiers.',
  }).catch(() => {});
}

// Electron ≥ 44 : l'API clipboard du process main est asynchrone (Promises).
// Sans « await », readText() renvoyait une promesse toujours différente du
// texte : la copie protégée était systématiquement écrasée par une copie
// classique et l'avertissement s'affichait à la première copie.
function writeClipboardProtected(text) {
  const s = String(text || '');
  if (process.platform !== 'win32' || !s) {
    return Promise.resolve(clipboard.writeText(s)).then(() => ({ protected: true }));
  }
  // Windows ramène les fins de ligne en \r\n : on compare sans en tenir compte.
  const norm = (t) => String(t || '').replace(/\r\n/g, '\n');
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return; done = true;
      try {
        if (norm(await clipboard.readText()) === norm(s)) return resolve({ protected: true });
      } catch (e) { console.warn('[clipboard] lecture impossible :', e && e.message); }
      // Copie protégée indisponible : copie classique, signalée à chaque fois.
      console.warn('[clipboard] copie protégée indisponible, copie classique');
      try { await clipboard.writeText(s); } catch (e) { console.error('[clipboard] copie impossible :', e && e.message); return resolve({ protected: false, failed: true }); }
      warnClipboardOnce();
      resolve({ protected: false });
    };
    // Vide d'abord : un texte identique déjà présent ne doit pas faire croire à une copie protégée réussie.
    try { Promise.resolve(clipboard.clear()).catch(() => {}); } catch {}
    try {
      // Chemin absolu : jamais de powershell.exe pris dans le dossier courant.
      const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const ps = spawn(psExe, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', PS_PROTECTED_COPY_B64],
        { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => { try { ps.kill(); } catch {} finish(); }, 4000);
      ps.on('error', () => { clearTimeout(timer); finish(); });
      ps.on('exit', () => { clearTimeout(timer); finish(); });
      ps.stdin.end(Buffer.from(s, 'utf8').toString('base64'));
    } catch { finish(); }
  });
}

function lockNow() {
  transferOnLock();
  if (core && core.isUnlocked()) {
    core.lock();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(path.join(__dirname, 'login.html'), { query: { raison: 'veille' } });
  }
}

// --- App lifecycle -----------------------------------------------------
app.whenReady().then(async () => {
  // 0. Permissions web : tout refuser (caméra, micro, notifications, etc.)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  // 1. StorageAdapter Electron
  // Pas de safeStorage : sur le bureau, aucune clé n'est écrite sur disque.
  storage = createElectronAdapter({
    app, dialog,
    getMainWindow: () => mainWindow,
    dataDir: resolveDataDir(),
  });

  // 2. Injection dans les modules métier
  items.setAdapter(storage);
  settings.setAdapter(storage);

  // 3. Préchargement du cache settings (touchActivity() l'utilise en sync)
  await settings.readSettings();

  // 4. Construction du core avec horloge auto-lock → retour login.html
  core = createAppCore({
    adapter: storage,
    modules: { items, settings, backup, legacyV1, sharedRng, sharedGen, sharedKDF, aead: sharedAEAD, totp: sharedTOTP },
    // Bureau : la clé ne doit jamais être écrite sur disque (audit M2).
    persistSession: false,
    // Bureau : pas de déblocage rapide (v1.0), le mot de passe maître est
    // demandé à chaque ouverture.
    allowQuickUnlock: false,
    clipboard: {
      writeText: (s) => writeClipboardProtected(s),
      readText:  ()  => clipboard.readText(),
      clear:     ()  => clipboard.clear(),
    },
    onAutoLock: () => {
      transferOnLock();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(path.join(__dirname, 'login.html'), { query: { raison: 'inactivite' } });
    },
  });

  // Supprime une éventuelle clé de session laissée par une ancienne version.
  await core.purgeSession();
  // Supprime le fichier de déblocage rapide (quickunlock.vault) et le réglage
  // correspondant laissés par une version antérieure à la 1.0.
  await core.purgeQuickUnlock();

  // Verrouillage à la mise en veille / au verrouillage de session (audit M8).
  powerMonitor.on('suspend', lockNow);
  powerMonitor.on('lock-screen', lockNow);

  // 5. Fenêtres
  createLoaderWindow();
  await createMainWindow();
}).catch((err) => {
  console.error('[boot]', err);
  app.quit();
});

app.on('will-quit', () => { if (core) core.lock(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createMainWindow();
});

// --- Validation de l'expéditeur IPC (audit M4) ------------------------------
// Seule la fenêtre principale, sur une page de l'application, peut appeler l'IPC.
function validSender(evt) {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || evt.sender !== mainWindow.webContents) return false;
    const url = evt.senderFrame && evt.senderFrame.url;
    return isAppUrl(url);
  } catch { return false; }
}
function secureHandle(channel, fn) {
  ipcMain.handle(channel, (evt, arg) => {
    if (!validSender(evt)) return { success: false, error: 'Origine refusée.' };
    return fn(arg, evt);
  });
}
function secureOn(channel, fn) {
  ipcMain.on(channel, (evt, arg) => { if (validSender(evt)) fn(arg, evt); });
}

// --- IPC : fenêtre (spécifique Electron, pas routé vers core) ----------
secureOn('window:minimize', () => {
  const win = BrowserWindow.getFocusedWindow(); if (win) win.minimize();
});
secureOn('window:toggle-maximize', () => {
  const win = BrowserWindow.getFocusedWindow(); if (!win) return;
  if (win.isMaximized()) { win.unmaximize(); win.webContents.send('window:unmaximized'); }
  else                   { win.maximize();   win.webContents.send('window:maximized'); }
});
secureOn('window:close', () => {
  const win = BrowserWindow.getFocusedWindow(); if (win) win.close();
});

// --- Câblage IPC → core -----------------------------------------------
// Toutes les routes suivantes délèguent à app-core. Le 1er paramètre
// (_evt) est ignoré ; seul l'argument passé par le renderer est forwardé.
function handle(channel, fn) { secureHandle(channel, (arg) => fn(arg)); }

// auth:*
handle('auth:has-master',    () => core.hasMaster());
handle('auth:is-unlocked',   () => core.isUnlocked());
handle('auth:create-master', (pw) => core.createMaster(pw));
handle('auth:unlock',        (pw) => core.unlock(pw));
handle('auth:lock',          () => { transferOnLock(); return core.lock(); });
handle('auth:change-master', (a) => core.changeMaster(a));

// auth:reset-forgotten — « Repartir de zéro » (mot de passe maître oublié).
// Le cœur n'accepte que si le coffre est VERROUILLÉ, avec le mot EFFACER, une
// seule demande à la fois ; il ne lit ni ne déchiffre rien, il efface.
secureHandle('auth:reset-forgotten', async (a) => {
  const res = await core.resetForgotten(a);
  if (res.success && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, 'create-master-password.html'), { query: { repartir: '1' } });
  }
  return res;
});

// Pas de canaux quick-unlock:* sur le bureau (v1.0) : aucune clé sur disque.

// items:*
handle('items:list',   (type) => core.itemsListRedacted(type));
handle('items:get',    (id)   => core.itemsGet(id));
handle('items:copy-field', (a) => core.itemsCopyField(a));
handle('items:totp',   (id)   => core.itemsTotp(id));
handle('items:add',    (a)    => core.itemsAdd(a));
handle('items:update', (a)    => core.itemsUpdate(a));
handle('items:delete', (id)   => core.itemsDelete(id));
handle('items:counts', ()     => core.itemsCounts());
handle('items:copy',   (t)    => core.itemsCopy(t));

// passwords:* (alias legacy)
handle('passwords:list',   ()  => core.passwordsListRedacted());
handle('passwords:add',    (e) => core.passwordsAdd(e));
handle('passwords:update', (e) => core.passwordsUpdate(e));
handle('passwords:delete', (id)=> core.passwordsDelete(id));
handle('passwords:copy',   (t) => core.passwordsCopy(t));

// generator:make
handle('generator:make', (opts) => core.generatorMake(opts));

// settings:*
handle('settings:get',   () => core.settingsGet());
handle('settings:set',   (p) => core.settingsSet(p));
handle('settings:reset', () => core.settingsReset());

// backup:*
handle('backup:export', (a)  => core.backupExport(a));
handle('backup:import', (a)  => core.backupImport(a));

// danger:wipe — après reset, on retourne à l'écran « créer master password »
secureHandle('danger:wipe', async (a) => {
  const res = await core.dangerWipe(a && a.masterPassword);
  if (res.success && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, 'create-master-password.html'));
  }
  return res;
});

// app:info — version et éditeur (écran « À propos »)
const APP_VERSION = (() => { try { return require('./package.json').version; } catch { return app.getVersion(); } })();
handle('app:info', () => ({ success: true, name: 'Passory', version: APP_VERSION }));

// activity tick → reset auto-lock timer (send, pas invoke)
secureOn('activity', () => core.touchActivity());

// ─────────────────────────────────────────────────────────────────────────
// PCTP — Transfert par câble (TCP localhost:47821) — DÉSACTIVÉ en v1.0
// (FEATURES.transfer = false, cf. src/shared/features.js)
// ─────────────────────────────────────────────────────────────────────────
//
// Architecture :
//   • Le sender appelle pctp:listen   → ouvre un serveur TCP, attend le pair.
//   • Le receiver appelle pctp:connect → se connecte au sender.
//   • Le handshake X25519 + SAS s'échange via les frames PCTP binaires.
//   • Après validation SAS des deux côtés, le sender appelle pctp:transfer
//     avec les IDs des items à envoyer.
//   • Les événements de progression sont poussés au renderer via
//     mainWindow.webContents.send('pctp:event', { type, ...payload }).
//
// IPC channels :
//   pctp:listen       (handle) — démarre le serveur TCP
//   pctp:connect      (handle) — connexion au sender
//   pctp:sas-confirm  (handle) — l'utilisateur valide la SAS
//   pctp:transfer     (handle) — envoie les items (sender)
//   pctp:save-received(handle) — persiste les items reçus (receiver)
//   pctp:cancel       (handle) — annule la session
//
// Événements renderer ← main ('pctp:event') :
//   connected | sas-ready | peer-confirmed-sas | ready
//   transfer-started | item-received | items-received | done | error | aborted
// ─────────────────────────────────────────────────────────────────────────

// ── État runtime PCTP ────────────────────────────────────────────────────
let _pctpServer   = null;  // net.Server (sender uniquement)
let _pctpSocket   = null;  // net.Socket actif
let _pctpSession  = null;  // SenderSession | ReceiverSession (item-sharing)
let _pctpRole     = null;  // 'sender' | 'receiver'
// PCTPSession brute nécessaire pour sendEncrypted direct (pctp:transfer)
let _pctpRaw      = null;
// Flag positionné quand le receiver a bien reçu des items via PCTP.
// Survit à _pctpCleanup() pour que pctp:save-received puisse valider l'origine.
let _pctpItemsReceived = false;
// Éléments reçus, conservés côté main : la page ne fait que confirmer (audit F7).
let _pctpReceivedItems = null;

/** Au verrouillage : on oublie les éléments reçus et pas encore enregistrés. */
function transferOnLock() { _pctpReceivedItems = null; }

const TRANSFER_CHANNELS = ['pctp:listen', 'pctp:connect', 'pctp:sas-confirm', 'pctp:transfer', 'pctp:save-received', 'pctp:cancel'];
const TRANSFER_DISABLED_MSG = 'Le transfert direct entre appareils n\'est pas disponible dans cette version. '
  + 'Pour passer sur un autre appareil, utilisez une sauvegarde : Paramètres › Sauvegarde.';

if (FEATURES.transfer) {
  registerTransferIpc();
} else {
  // v1.0 : canaux désactivés. Ils répondent par un refus clair ; aucun
  // serveur TCP n'est ouvert et les modules réseau ne sont pas chargés.
  for (const ch of TRANSFER_CHANNELS) {
    secureHandle(ch, () => ({ success: false, error: TRANSFER_DISABLED_MSG, code: 'FEATURE_DISABLED' }));
  }
}

/** Enregistre les canaux PCTP (uniquement si FEATURES.transfer). */
function registerTransferIpc() {
  const net = require('net');
  const { createSenderSession, createReceiverSession } =
    require('./src/shared/transfer/item-sharing.js');
  const { createX25519Provider } =
    require('./src/shared/crypto/x25519.js');

  const PCTP_PORT = 47821;

  /** Pousse un événement vers le renderer. */
  function _pctpEmit(type, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pctp:event', Object.assign({ type }, payload || {}));
    }
  }

  /** Ferme proprement socket + serveur. */
  function _pctpCleanup() {
    if (_pctpSocket) { try { _pctpSocket.destroy(); } catch {} _pctpSocket = null; }
    if (_pctpServer) { try { _pctpServer.close();   } catch {} _pctpServer = null; }
    _pctpSession = null;
    _pctpRole    = null;
    _pctpRaw     = null;
  }

  /** Envoie des octets (Uint8Array) sur le socket actif. */
  function _pctpSend(bytes) {
    if (_pctpSocket && !_pctpSocket.destroyed && bytes && bytes.length) {
      _pctpSocket.write(Buffer.from(bytes));
    }
  }

  /**
   * Branche la gestion des données/erreurs/fermeture sur un socket établi.
   * Dispatche les événements item-sharing vers le renderer.
   */
  function _pctpWireSocket(socket) {
    _pctpSocket = socket;
    _pctpEmit('connected');

    socket.on('data', async (buf) => {
      if (!_pctpSession) return;
      try {
        const { toSend, events } = await _pctpSession.receive(new Uint8Array(buf));
        if (toSend) _pctpSend(toSend);

        for (const ev of events) {
          switch (ev.type) {
            case 'sas-ready':
              _pctpEmit('sas-ready', { sas: ev.sas });
              break;
            case 'peer-confirmed-sas':
              _pctpEmit('peer-confirmed-sas');
              break;
            case 'ready':
              _pctpEmit('ready');
              break;
            case 'transfer-started':
              _pctpEmit('transfer-started', { count: ev.count });
              break;
            case 'item-received':
              // La page ne reçoit que le libellé, jamais le contenu (relecture #1).
              _pctpEmit('item-received', {
                item: { label: String((ev.item && ev.item.payload && ev.item.payload.label) || 'Élément') },
                received: ev.received, total: ev.total,
              });
              break;
            case 'items-received':
              _pctpItemsReceived = true;
              _pctpReceivedItems = Array.isArray(ev.items) ? ev.items : [];
              _pctpEmit('items-received', { count: _pctpReceivedItems.length });
              break;
            case 'done':
              _pctpEmit('done');
              _pctpCleanup();
              break;
            case 'error':
              _pctpEmit('error', { message: ev.message });
              _pctpCleanup();
              break;
            case 'aborted':
              _pctpEmit('aborted', { reason: ev.reason });
              _pctpCleanup();
              break;
            default:
              break;
          }
        }
      } catch (err) {
        _pctpEmit('error', { message: err.message });
        _pctpCleanup();
      }
    });

    socket.on('error', (err) => {
      _pctpEmit('error', { message: err.message });
      _pctpCleanup();
    });

    socket.on('close', () => {
      // N'émet 'aborted' que si la session était encore active
      if (_pctpSession) {
        _pctpEmit('aborted', { reason: 'connexion fermée par le pair' });
      }
      _pctpCleanup();
    });
  }

  // ── pctp:connect — receiver se connecte au sender ───────────────────────
  const _PCTP_ALLOWED_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
  secureHandle('pctp:connect', async ({ host } = {}) => {
    const safeHost = (typeof host === 'string' && _PCTP_ALLOWED_HOSTS.has(host.trim()))
      ? host.trim()
      : '127.0.0.1';
    try {
      _pctpCleanup();
      _pctpItemsReceived = false;
      _pctpRole = 'receiver';

      const x25519Provider = await createX25519Provider();
      _pctpSession = createReceiverSession({ x25519Provider });

      const socket = new net.Socket();
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.connect(PCTP_PORT, safeHost, resolve);
      });

      _pctpWireSocket(socket);
      // Le receiver attend le ClientHello : pas d'envoi initial côté receiver.

      return { success: true };
    } catch (err) {
      _pctpCleanup();
      return { success: false, error: err.message };
    }
  });

  // ── pctp:sas-confirm — l'utilisateur valide visuellement la SAS ──────────
  secureHandle('pctp:sas-confirm', async () => {
    if (!_pctpSession) return { success: false, error: 'Aucune session active' };
    try {
      const frame = await _pctpSession.confirmSAS();
      if (frame) _pctpSend(frame);
      // Si le pair avait déjà confirmé, les éléments viennent de partir avec la confirmation.
      if (_pctpRole === 'sender' && _pctpSession && _pctpSession.state === 'done') {
        _pctpEmit('transfer-started', { count: _pctpSession.itemCount || 0 });
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── pctp:transfer — sender envoie les items après 'ready' ────────────────
  //
  // item-sharing.createSenderSession() envoie automatiquement manifest +
  // items + done dès que l'événement 'ready' est reçu UNIQUEMENT si les
  // items ont été passés à la construction. Comme on ne les connaît qu'ici,
  // on recréé une SenderSession identique — mais la session PCTP interne
  // est déjà établie et on ne peut plus la ré-utiliser.
  //
  // Solution retenue : construire les frames chiffrées directement depuis
  // la PCTPSession sous-jacente. Pour y accéder, on crée une seconde
  // PCTPSession déjà en état TRANSFERRING en réutilisant le sessionKey
  // dérivé. Ce n'est pas trivial sans accès aux internals.
  //
  // Alternative pragmatique (choisie ici) : recréer une SenderSession
  // complète avec les vrais items dès le pctp:listen, avant que le
  // pair ne soit connecté. L'appelant (renderer) doit donc passer les IDs
  // dès pctp:listen, PAS dans pctp:transfer.
  // pctp:transfer reste exposé pour compatibilité mais délègue à la session
  // créée dans pctp:listen en envoyant les frames manuellement via
  // la PCTPSession interne exposée via _pctpRaw.
  //
  // Pour accéder à PCTPSession depuis item-sharing : on intercepte
  // la SenderSession en créant une sous-classe qui expose _sess. Plutôt que
  // de modifier item-sharing.js (contrainte UMD intacte), on utilise le fait
  // que JavaScript permet d'accéder aux propriétés privées-par-convention
  // si elles sont dans la closure. Elles ne le sont pas ici → la seule
  // solution sans patch est de construire les frames nous-mêmes via un
  // PCTPSession séparé qui partage le même sessionKey.
  //
  // → Implémentation finale : on stocke le PCTPSession brut dans _pctpRaw
  //   en créant la SenderSession ET le PCTPSession brut en parallèle dans
  //   pctp:listen (les deux partagent le même x25519Provider et les mêmes
  //   clés éphémères). Ce n'est pas possible sans modifier la source.
  //
  // → Solution finale adoptée : on modifie le flux de pctp:listen pour
  //   accepter les ids en paramètre et passer directement les items réels
  //   à createSenderSession. pctp:transfer devient une no-op de compatibilité.
  secureHandle('pctp:transfer', async () => {
    // Les items sont envoyés automatiquement via la SenderSession créée
    // dans pctp:listen avec les vrais items. Ce canal n'est conservé que
    // pour la compatibilité avec l'API preload.
    return { success: true };
  });

  // ── Validation des items reçus via PCTP ──────────────────────────────────
  const _PCTP_ALLOWED_TYPES = ['password', 'card', 'iban', 'note', 'identity'];
  function _validateReceivedItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (!_PCTP_ALLOWED_TYPES.includes(item.type)) return false;
    if (!item.payload || typeof item.payload !== 'object') return false;
    for (const val of Object.values(item.payload)) {
      if (typeof val === 'string' && val.length > 10_000) return false;
    }
    return true;
  }

  // ── pctp:save-received — receiver persiste les items dans le coffre ──────
  secureHandle('pctp:save-received', async () => {
    if (!_pctpItemsReceived || !_pctpReceivedItems) {
      return { success: false, error: 'Aucune session PCTP active.' };
    }
    const received = _pctpReceivedItems;
    _pctpItemsReceived = false;
    _pctpReceivedItems = null;
    if (!Array.isArray(received) || received.length === 0) {
      return { success: false, error: 'Aucun item à sauvegarder' };
    }
    try {
      let saved = 0;
      for (const item of received) {
        if (!_validateReceivedItem(item)) continue;
        const res = await core.itemsAdd({
          type: item.type,
          payload: item.payload,
        });
        if (res && res.success) saved++;
      }
      return { success: true, saved };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── pctp:cancel — annule la session en cours ─────────────────────────────
  secureHandle('pctp:cancel', async () => {
    try {
      if (_pctpSession) {
        const frame = _pctpSession.abort('annulé par l\'utilisateur');
        if (frame) _pctpSend(frame);
      }
      _pctpCleanup();
      return { success: true };
    } catch (err) {
      _pctpCleanup();
      return { success: false, error: err.message };
    }
  });

  // ── Surcharge de pctp:listen pour accepter les items dès le départ ───────
  // On retire le premier handler et on le remplace par un qui accepte { ids }.
  // ipcMain.handle ne permet pas de remplacer un handler existant sans
  // appeler ipcMain.removeHandler d'abord.
  secureHandle('pctp:listen', async ({ ids } = {}) => {
    try {
      if (!core.isUnlocked()) return { success: false, error: 'LOCKED' };
      _pctpCleanup();
      _pctpItemsReceived = false;
      _pctpRole = 'sender';

      // Charge les items déchiffrés AVANT de démarrer le serveur
      const idsArr = Array.isArray(ids) ? ids : [];
      let itemsToSend = [];
      if (core.isUnlocked()) {
        const listRes = await core.itemsList('password');
        if (listRes.success) {
          itemsToSend = (listRes.entries || [])
            .filter((e) => idsArr.length === 0 || idsArr.includes(e.id))
            .map((e) => ({ id: e.id, type: 'password', payload: e.payload }));
        }
      }

      const x25519Provider = await createX25519Provider();
      _pctpSession = createSenderSession({ x25519Provider, items: itemsToSend });

      _pctpServer = net.createServer(async (socket) => {
        if (_pctpSocket) { socket.destroy(); return; }
        _pctpServer.close();
        _pctpWireSocket(socket);
        try {
          const hello = await _pctpSession.start();
          _pctpSend(hello);
        } catch (err) {
          _pctpEmit('error', { message: err.message });
          _pctpCleanup();
        }
      });

      _pctpServer.on('error', (err) => {
        _pctpEmit('error', { message: 'Serveur TCP : ' + err.message });
        _pctpCleanup();
      });

      await new Promise((resolve, reject) => {
        _pctpServer.once('error', reject);
        _pctpServer.listen(PCTP_PORT, '127.0.0.1', resolve);
      });

      return { success: true, port: PCTP_PORT };
    } catch (err) {
      _pctpCleanup();
      return { success: false, error: err.message };
    }
  });
}

// Smart Autofill : retiré (audit M6). La détection par titre de fenêtre était
// trompable par une page web et exposait les sites du coffre dans les
// notifications. À refaire dans l'extension navigateur, sur l'origine exacte.
