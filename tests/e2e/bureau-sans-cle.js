/**
 * Bureau v1.0 : AUCUNE clé sur disque (coffre FACTICE), en deux lancements
 * successifs du vrai Electron sur le même dossier (run-e2e.js) :
 *   E2E_MODE=lancement-1 : création, déverrouillage → aucun fichier de clé ;
 *                          puis on dépose les restes d'une version < 1.0
 *                          (quickunlock.vault + réglage quickUnlockEnabled).
 *   E2E_MODE=lancement-2 : au démarrage, ces restes ont été supprimés ; le
 *                          mot de passe maître est redemandé ; après
 *                          déverrouillage, toujours aucun fichier de clé.
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const DIR = process.env.E2E_DIR;
app.setPath('userData', DIR);
require('../../main.js');

const results = [];
const ok = (name, cond, extra) => { results.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitWin() { for (let i = 0; i < 100; i++) { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('.html') && !x.webContents.getURL().includes('loader')); if (w) return w; await sleep(100); } throw new Error('pas de fenêtre'); }

const MAITRE = 'Factice-Bureau-Maitre-2026';
const VAULT = path.join(DIR, 'vault');

/** Tous les fichiers sous userData (récursif), chemins relatifs. */
function allFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? allFiles(p, base) : [path.relative(base, p)];
  });
}
/** Fichiers ressemblant à une clé stockée (déblocage rapide, session, dossier secure/). */
const keyFiles = () => allFiles(VAULT).filter((f) => /quickunlock|session-key|master-key|(^|[\\/])secure[\\/]/i.test(f));

app.whenReady().then(async () => {
  try {
    const win = await waitWin();
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await sleep(800);
    const MODE = process.env.E2E_MODE;

    if (MODE === 'lancement-1') {
      ok('création du coffre', (await js(`window.passory.auth.createMaster(${JSON.stringify(MAITRE)})`)).success);
      ok('aucun fichier de clé après création', keyFiles().length === 0, keyFiles().join(','));
      await js(`window.passory.auth.lock()`);
      ok('déverrouillage', (await js(`window.passory.auth.unlock(${JSON.stringify(MAITRE)})`)).success);
      ok('aucun fichier de clé après déverrouillage', keyFiles().length === 0, keyFiles().join(','));
      ok('déblocage rapide indisponible sur le bureau', (await js(`window.passory.quickUnlock.isAvailable()`)) === false);
      const en = await js(`window.passory.quickUnlock.enable()`);
      ok('activation du déblocage rapide refusée', en.success === false);
      ok('toujours aucun fichier de clé', keyFiles().length === 0, keyFiles().join(','));
      const st = await js(`window.passory.settings.get()`);
      ok('aucun réglage « quickUnlockEnabled »', !('quickUnlockEnabled' in st.settings));
      // Restes d'une version antérieure à la 1.0 (fichier DPAPI factice).
      fs.writeFileSync(path.join(VAULT, 'quickunlock.vault'), Buffer.from('ancienne-cle-dpapi-factice'));
      fs.mkdirSync(path.join(VAULT, 'secure'), { recursive: true });
      fs.writeFileSync(path.join(VAULT, 'secure', 'session-key.vault'), Buffer.from('ancienne-session-factice'));
      const sp = path.join(VAULT, 'settings.json');
      const s = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : {};
      fs.writeFileSync(path.join(VAULT, 'settings.json'), JSON.stringify({ ...s, quickUnlockEnabled: true, autoLockMinutes: 7 }));
      ok('restes d\'une ancienne version déposés pour le redémarrage', keyFiles().length === 2, keyFiles().join(','));
    } else if (MODE === 'lancement-2') {
      ok('au démarrage : ancien quickunlock.vault et clé de session supprimés', keyFiles().length === 0, keyFiles().join(','));
      const st = JSON.parse(fs.readFileSync(path.join(VAULT, 'settings.json'), 'utf8'));
      ok('au démarrage : ancien réglage retiré de settings.json', !('quickUnlockEnabled' in st));
      ok('les autres réglages sont conservés', st.autoLockMinutes === 7);
      ok('après redémarrage : écran de connexion (mot de passe demandé)', win.webContents.getURL().endsWith('login.html'), win.webContents.getURL());
      ok('après redémarrage : coffre verrouillé', (await js(`window.passory.auth.isUnlocked()`)) === false);
      await sleep(600);
      ok('bouton biométrie absent sur le bureau', (await js(`(() => { const b = document.getElementById('quick-btn'); return !b || b.classList.contains('hidden'); })()`)) === true);
      ok('déverrouillage après redémarrage', (await js(`window.passory.auth.unlock(${JSON.stringify(MAITRE)})`)).success);
      ok('aucun fichier de clé après redémarrage et déverrouillage', keyFiles().length === 0, keyFiles().join(','));
      ok('seuls le coffre et les réglages sont sur disque', allFiles(VAULT).every((f) => /^(vault\.json(\.bak)?|settings\.json)$/.test(f)), allFiles(VAULT).join(','));
    } else {
      ok('mode connu', false, String(MODE));
    }
  } catch (err) {
    ok('exécution', false, err.stack);
  }
  console.log('\n' + results.join('\n'));
  app.exit(process.exitCode || 0);
});
