/**
 * Test de bout en bout Electron (coffre FACTICE).
 * Lancement : E2E_DIR=/tmp/x xvfb-run electron tests/e2e/electron-smoke.js
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const DIR = process.env.E2E_DIR;
app.setPath('userData', DIR);
require('../../main.js');

const results = []; const problems = [];
const ok = (name, cond, extra) => { results.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitWin() { for (let i = 0; i < 100; i++) { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('.html') && !x.webContents.getURL().includes('loader')); if (w) return w; await sleep(100); } throw new Error('pas de fenêtre'); }
async function load(win, page) { await win.loadFile(path.join(__dirname, '../..', page)); await sleep(400); }
const js = (win, code) => win.webContents.executeJavaScript(code, true);

app.whenReady().then(async () => {
  try {
    const win = await waitWin();
    win.webContents.on('console-message', (e) => {
      const lvl = e.level, msg = e.message;
      if (lvl === 'error' || lvl === 3 || /Content Security Policy|Refused/.test(msg)) problems.push(win.webContents.getURL().split('/').pop() + ' : ' + msg.slice(0, 200));
    });
    await sleep(800);
    const MODE = process.env.E2E_MODE || 'fresh';
    if (MODE === 'migrate') {
      ok('page de login affichée pour un coffre v1', win.webContents.getURL().endsWith('login.html'));
      const u = await js(win, `window.passory.auth.unlock('Factice-V1-Maitre')`);
      ok('déverrouillage + migration v1', u.success && u.migrated === 2, JSON.stringify(u));
      const l = await js(win, `window.passory.items.list()`);
      ok('éléments migrés lisibles', l.success && l.entries.length === 2 && l.entries.every((e) => !e.corrupt));
      const files = fs.readdirSync(path.join(DIR, 'vault'));
      ok('vault.json créé et v1 archivé', files.includes('vault.json') && files.includes('master.vault.v1-bak') && !files.includes('master.vault'), files.join(','));
    } else {
      ok('page de création affichée', win.webContents.getURL().endsWith('create-master-password.html'));
      ok('maître de 8 caractères refusé', !(await js(win, `window.passory.auth.createMaster('court-8c')`)).success);
      ok('création du coffre', (await js(win, `window.passory.auth.createMaster('Factice-E2E-Maitre-2026')`)).success);
      ok('ajout d\'un élément', (await js(win, `window.passory.items.add('password', {label:'Factice', username:'u', password:'pw-factice'})`)).success);
      const l = await js(win, `window.passory.items.list('password')`);
      ok('liste expurgée (pas de mot de passe)', l.success && l.entries[0].payload.password === '' && l.entries[0].payload._has.password === true);
      const g = await js(win, `window.passory.items.get(${JSON.stringify('ID')})`.replace('"ID"', JSON.stringify(l.entries[0].id)));
      ok('lecture de l\'élément à la demande', g.success && g.entry.payload.password === 'pw-factice');
      // CSP : script injecté bloqué
      await load(win, 'dashboard.html');
      const csp = await js(win, `new Promise((res) => { let v = false; document.addEventListener('securitypolicyviolation', () => { v = true; });
        const s = document.createElement('script'); s.textContent = 'window.__pwned = 1'; document.body.appendChild(s);
        const img = document.createElement('img'); img.src = 'https://example.com/x.png'; document.body.appendChild(img);
        setTimeout(() => res({ pwned: window.__pwned === 1, violation: v }), 300); })`);
      ok('CSP bloque un script injecté', !csp.pwned && csp.violation, JSON.stringify(csp));
      problems.length = 0; // violations volontaires ci-dessus
      // Navigation externe bloquée, window.open refusé
      await js(win, `window.location.href = 'https://example.com/'`); await sleep(500);
      ok('navigation externe bloquée', win.webContents.getURL().startsWith('file://'), win.webContents.getURL());
      ok('window.open refusé', (await js(win, `window.open('https://example.com') === null`)) === true);
      ok('Node inaccessible dans la page', (await js(win, `typeof require === 'undefined' && typeof process === 'undefined'`)) === true);
      // Toutes les pages se chargent sans erreur ni violation CSP
      for (const p of ['dashboard.html', 'passwords.html', 'cards.html', 'ibans.html', 'identities.html', 'notes.html', 'settings.html']) {
        await load(win, p);
        ok(`page ${p} chargée (déverrouillé)`, win.webContents.getURL().endsWith(p));
      }
      // Transfert PCTP désactivé en v1.0 (src/shared/features.js)
      ok('transfert : drapeau FEATURES.transfer à false', require('../../src/shared/features.js').transfer === false);
      ok('transfert : API absente de la page', (await js(win, `typeof window.passory.transfer`)) === 'undefined');
      await load(win, 'transfer.html'); await sleep(300);
      ok('transfert : transfer.html renvoie à l\'accueil', win.webContents.getURL().endsWith('dashboard.html'), win.webContents.getURL());
      await js(win, `window.location.href = 'transfer.html'`); await sleep(800);
      ok('transfert : navigation vers transfer.html renvoyée à l\'accueil', win.webContents.getURL().endsWith('dashboard.html'), win.webContents.getURL());
      ok('transfert : aucun lien dans le menu', (await js(win, `document.querySelectorAll('a[href*="transfer"]').length`)) === 0);
      const portOpen = await new Promise((res) => { const sock = require('net').connect(47821, '127.0.0.1');
        sock.once('connect', () => { sock.destroy(); res(true); }); sock.once('error', () => res(false)); });
      ok('transfert : aucun serveur PCTP en écoute', portOpen === false);
      await load(win, 'passwords.html');
      const rows = await js(win, `document.querySelectorAll('.item-row').length`);
      ok('la liste des mots de passe s\'affiche', rows === 1, 'lignes : ' + rows);
      // Actions sensibles
      ok('effacement sans mot de passe refusé', !(await js(win, `window.passory.danger.wipe()`)).success);
      ok('export sans mot de passe maître refusé', !(await js(win, `window.passory.backup.export('phrase-export-longue')`)).success);
      ok('API autofill retirée', (await js(win, `typeof window.passory.autofill`)) === 'undefined');
      // Aucune clé sur disque
      const secureDir = path.join(DIR, 'vault', 'secure');
      ok('aucune clé de session sur disque', !fs.existsSync(path.join(secureDir, 'session-key.vault')));
      ok('aucune clé de déblocage rapide sur disque', !fs.existsSync(path.join(DIR, 'vault', 'quickunlock.vault')));
      ok('déblocage rapide indisponible sur le bureau', (await js(win, `window.passory.quickUnlock.isAvailable()`)) === false);
      ok('« Repartir de zéro » refusé coffre ouvert', /ouvert/.test((await js(win, `window.passory.auth.resetForgotten('EFFACER')`)).error || ''));
      // Verrouillage
      ok('verrouillage', (await js(win, `window.passory.auth.lock()`)).success);
      ok('accès refusé une fois verrouillé', (await js(win, `window.passory.items.list()`)).error === 'LOCKED');
      ok('mauvais mot de passe refusé', !(await js(win, `window.passory.auth.unlock('mauvais-mot-de-passe')`)).success);
      await sleep(10);
      ok('bon mot de passe accepté', (await js(win, `window.passory.auth.unlock('Factice-E2E-Maitre-2026')`)).success);
      const vault = JSON.parse(fs.readFileSync(path.join(DIR, 'vault', 'vault.json'), 'utf8'));
      ok('coffre v2 dans userData', vault.format === 2 && vault.items.length === 1);
      ok('aucun secret en clair dans le fichier', !fs.readFileSync(path.join(DIR, 'vault', 'vault.json'), 'utf8').includes('pw-factice'));
    }
    ok('aucune erreur console / violation CSP pendant la navigation', problems.length === 0, problems.slice(0, 5).join(' | '));
  } catch (err) {
    ok('exécution', false, err.stack);
  }
  console.log('\n' + results.join('\n'));
  app.exit(process.exitCode || 0);
});
