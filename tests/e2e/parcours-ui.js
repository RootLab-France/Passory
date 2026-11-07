/**
 * Parcours utilisateur complet piloté par l'INTERFACE (coffre FACTICE) :
 * création → ajout (générateur, 2FA) → copie / effacement du presse-papier →
 * verrouillage → déverrouillage → sauvegarde → restauration → changement du
 * mot de passe maître → effacement total.
 * Lancement : E2E_DIR=/tmp/x xvfb-run electron tests/e2e/parcours-ui.js
 */
'use strict';
const { app, BrowserWindow, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const DIR = process.env.E2E_DIR;
app.setPath('userData', DIR);
require('../../main.js');

const results = []; const problems = [];
const ok = (name, cond, extra) => { results.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = JSON.stringify;
async function waitWin() { for (let i = 0; i < 100; i++) { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('.html') && !x.webContents.getURL().includes('loader')); if (w) return w; await sleep(100); } throw new Error('pas de fenêtre'); }

const MAITRE = 'Factice-Maitre-2026!';
const MAITRE2 = 'Nouveau-Maitre-Factice-27';
const PHRASE = 'Phrase-Sauvegarde-Factice';

app.whenReady().then(async () => {
  try {
    const win = await waitWin();
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 3 || /Content Security Policy|Refused/.test(e.message)) problems.push(win.webContents.getURL().split('/').pop() + ' : ' + e.message.slice(0, 200));
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const url = () => win.webContents.getURL().split('/').pop();
    const load = async (page) => { await win.loadFile(path.join(__dirname, '../..', page)); await sleep(600); };
    const type = (sel, v) => js(`(() => { const e = document.querySelector(${S(sel)}); e.focus(); e.value = ${S(v)}; e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    const click = (sel) => js(`(() => { const e = document.querySelector(${S(sel)}); if (!e) return false; e.click(); return true; })()`);
    const text = (sel) => js(`(() => { const e = document.querySelector(${S(sel)}); return e ? e.innerText : ''; })()`);
    const visible = (sel) => js(`(() => { const e = document.querySelector(${S(sel)}); if (!e) return false; for (let x = e; x && x.nodeType === 1; x = x.parentElement) if (getComputedStyle(x).display === 'none') return false; return true; })()`);
    const toasts = () => js(`[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')`);
    const rows = () => js(`document.querySelectorAll('#list .item-row').length`);
    const key = async (k) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); win.webContents.sendInputEvent({ type: 'char', keyCode: k }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(250); };
    const waitFor = async (fn, ms = 15000) => { for (let i = 0; i < ms / 100; i++) { if (await fn()) return true; await sleep(100); } return false; };
    const waitUrl = (u, ms) => waitFor(() => url().startsWith(u), ms);
    const confirmWith = async (input) => { if (input != null) await type('#passory-confirm-input', input); await sleep(100); await click('#passory-confirm-ok'); await sleep(300); };

    // Fenêtres de choix de fichier simulées (sauvegarde dans le dossier de test)
    const BK = path.join(DIR, 'sauvegarde-factice.json');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: BK });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BK] });
    await sleep(800);

    // ── Création ─────────────────────────────────────────────────
    ok('premier lancement : écran de création', url() === 'create-master-password.html');
    ok('avertissement « non récupérable »', /Personne ne pourra le récupérer/.test(await text('#recovery-warning')));
    await type('#p1', MAITRE); await type('#p2', MAITRE);
    await click('#submit-btn'); await sleep(200);
    ok('confirmation « j\'ai compris » exigée', /Cochez la case/.test(await text('#error-msg')));
    await click('#ack'); await click('#submit-btn');
    ok('coffre créé → accueil', await waitUrl('dashboard.html'));
    await sleep(800);
    ok('rappel de sauvegarde au premier lancement', await visible('#backup-reminder'));

    // ── Ajout d'un mot de passe ──────────────────────────────────
    await load('passwords.html');
    ok('liste vide : état vide affiché seul', (await visible('#empty')) && (await rows()) === 0);
    await click('#add-btn'); await sleep(300);
    await type('#m-label', 'Messagerie factice'); await type('#m-username', 'jean@exemple.test');
    await click('#m-generate'); await sleep(400);
    const gen = await js(`document.getElementById('m-password').value`);
    ok('générateur', gen.length >= 16);
    await type('#m-totp', 'JBSWY3DPEHPK3PXP'); await sleep(200);
    ok('clé 2FA vérifiée en direct', /Clé valide/.test(await text('#m-totp-hint')));
    await click('#modal-save');
    ok('mot de passe ajouté', await waitFor(async () => (await rows()) === 1));
    ok('état vide masqué quand la liste est remplie', !(await visible('#empty')));

    // ── Copie et effacement automatique ──────────────────────────
    await js(`window.passory.settings.set({ clipboardClearSeconds: 2 })`);
    await clipboard.writeText('vide');
    await click('#list [data-action="copy-pass"]'); await sleep(500);
    ok('copie du mot de passe', (await clipboard.readText()) === gen);
    ok('le message annonce l\'effacement', /effacé du presse-papier dans 2 s/.test(await toasts()));
    await sleep(2600);
    ok('presse-papier vidé automatiquement', (await clipboard.readText()) === '');

    // ── Suppression : confirmation obligatoire ───────────────────
    await click('#list [data-action="delete"]'); await sleep(300);
    ok('confirmation avant suppression', await visible('#passory-confirm'));
    await key('Escape');
    ok('Échap annule la suppression', !(await visible('#passory-confirm')) && (await rows()) === 1);

    // ── Verrouillage / déverrouillage ────────────────────────────
    await click('#logout-btn');
    ok('verrouillage manuel → connexion', await waitUrl('login.html'));
    await sleep(600);
    ok('bouton de déverrouillage biométrique absent sur ordinateur', !(await visible('#quick-btn')));
    await type('#password', 'mauvais-mot-de-passe'); await key('Return');
    ok('mauvais mot de passe : message clair', await waitFor(async () => /incorrect/.test(await text('#error-msg'))));
    await sleep(1200);
    await type('#password', MAITRE); await key('Return');
    ok('Entrée déverrouille', await waitUrl('dashboard.html'));

    // ── Sauvegarde puis restauration ─────────────────────────────
    await load('settings.html');
    ok('aucune mention de « couches »', !/couche/i.test(await js(`document.body.innerText`)));
    ok('À propos : version de package.json', (await text('#app-version')) === require('../../package.json').version);
    await type('#bk-pass', PHRASE); await type('#bk-pass2', PHRASE);
    await click('#bk-export'); await sleep(300);
    ok('export : mot de passe maître demandé', await visible('#passory-confirm'));
    await confirmWith(MAITRE);
    ok('fichier de sauvegarde écrit', await waitFor(() => fs.existsSync(BK)));
    ok('date de dernière sauvegarde affichée', await waitFor(async () => /Dernière sauvegarde/.test(await text('#bk-last'))));
    const id = (await js(`window.passory.items.list('password')`)).entries[0].id;
    await js(`window.passory.items.delete(${S(id)})`);
    await type('#bk-import-pass', PHRASE); await click('#bk-import-replace'); await sleep(300);
    await confirmWith('REMPLACER');
    await confirmWith(MAITRE);
    ok('restauration : élément revenu', await waitFor(async () => (await js(`window.passory.items.counts()`)).total === 1));
    const back = (await js(`window.passory.items.list('password')`)).entries[0];
    ok('restauration : contenu identique', (await js(`window.passory.items.get(${S(back.id)})`)).entry.payload.password === gen);

    // ── Changement du mot de passe maître ────────────────────────
    await type('#old-pw', MAITRE); await type('#new-pw', MAITRE2); await type('#new-pw2', MAITRE2);
    await click('#change-submit'); await sleep(300);
    await click('#passory-confirm-ok');
    ok('changement du maître annoncé', await waitFor(async () => /Mot de passe maître changé/.test(await toasts()), 20000));
    await js(`window.passory.auth.lock()`);
    ok('ancien mot de passe refusé', !(await js(`window.passory.auth.unlock(${S(MAITRE)})`)).success);
    await sleep(1200);
    ok('nouveau mot de passe accepté', (await js(`window.passory.auth.unlock(${S(MAITRE2)})`)).success);

    // ── Transfert direct : retiré de la v1.0 ─────────────────────
    ok('menu : aucune entrée « Transfert »', !/Transfert/.test(await text('[data-sidebar]')) && (await js(`document.querySelectorAll('[href*="transfer"]').length`)) === 0);
    await load('transfer.html');
    ok('transfer.html inaccessible → accueil', await waitUrl('dashboard.html', 5000), url());
    ok('accueil : aucun lien vers le transfert', (await js(`document.querySelectorAll('[href*="transfer"]').length`)) === 0);
    await load('settings.html');
    ok('Paramètres › Sauvegarde explique comment changer d\'appareil', /autre appareil/.test(await text('#bk-other-device')) && /Restaurer une sauvegarde/.test(await text('#bk-other-device')));
    ok('Paramètres : pas de réglage de déverrouillage rapide sur ordinateur', !(await visible('#qu-row')));

    // ── Effacement total ─────────────────────────────────────────
    await load('settings.html');
    await click('#wipe-all'); await sleep(300);
    await confirmWith('EFFACER');
    await confirmWith(MAITRE2);
    ok('effacement total → écran de création', await waitUrl('create-master-password.html', 10000));
    ok('aucun élément restant', !fs.existsSync(path.join(DIR, 'vault', 'vault.json')) || JSON.parse(fs.readFileSync(path.join(DIR, 'vault', 'vault.json'), 'utf8')).items.length === 0);

    // ── « Repartir de zéro » (mot de passe maître oublié) ────────
    // Coffre A avec un élément, sauvegardé ; on « oublie » son mot de passe.
    const MAITRE3 = 'Maitre-Oublie-Factice-28', MAITRE4 = 'Maitre-Neuf-Factice-29';
    const PHRASE2 = 'Phrase-Sauvegarde-Factice-2';
    await sleep(600);
    await type('#p1', MAITRE3); await type('#p2', MAITRE3); await click('#ack'); await click('#submit-btn');
    ok('nouveau coffre créé', await waitUrl('dashboard.html'));
    await js(`window.passory.items.add('note', { title: 'Note à retrouver', content: 'contenu factice' })`);
    await load('settings.html');
    fs.rmSync(BK, { force: true });
    await type('#bk-pass', PHRASE2); await type('#bk-pass2', PHRASE2);
    await click('#bk-export'); await sleep(300); await confirmWith(MAITRE3);
    ok('sauvegarde du coffre à « oublier » écrite', await waitFor(() => fs.existsSync(BK)));
    await click('#logout-btn');
    ok('verrouillé → écran de connexion', await waitUrl('login.html'));
    await sleep(600);
    ok('« Repartir de zéro » caché tant que l\'aide est fermée', !(await visible('#reset-btn')));
    await click('#forgot-btn'); await sleep(200);
    ok('aide « oublié » : explique l\'effacement et la restauration', /repartir de zéro/i.test(await text('#forgot-help')) && /sauvegarde/.test(await text('#forgot-help')));
    ok('bouton « Repartir de zéro » visible', await visible('#reset-btn'));
    // Annulation : rien n'est effacé
    await click('#reset-btn'); await sleep(300);
    const msg1 = await text('#passory-confirm-message');
    ok('1re confirmation : effacement définitif annoncé', /définitivement effacé/.test(msg1) && /aucune de ces données ne peut être récupérée/.test(msg1) && /phrase de passe de cette sauvegarde/.test(msg1));
    await type('#passory-confirm-input', 'effac'); await sleep(100);
    ok('il faut taper EFFACER pour continuer', await js(`document.getElementById('passory-confirm-ok').disabled`));
    await click('#passory-confirm-cancel'); await sleep(300);
    ok('annulation : le coffre est intact', fs.existsSync(path.join(DIR, 'vault', 'vault.json')) && url().startsWith('login.html'));
    // Parcours complet
    await click('#reset-btn'); await sleep(300);
    await confirmWith('EFFACER');
    ok('2e confirmation demandée', await visible('#passory-confirm') && /Dernière confirmation/.test(await text('#passory-confirm-title')));
    await confirmWith(null);
    ok('après effacement → écran de création', await waitUrl('create-master-password.html', 10000));
    ok('coffre effacé sur le disque', !fs.existsSync(path.join(DIR, 'vault', 'vault.json')) && !fs.existsSync(path.join(DIR, 'vault', 'vault.json.bak')));
    await sleep(600);
    ok('écran de création : « ancien coffre effacé » + comment restaurer', await visible('#restart-notice') && /Restaurer une sauvegarde/.test(await text('#restart-notice')));
    await type('#p1', MAITRE4); await type('#p2', MAITRE4); await click('#ack'); await click('#submit-btn');
    ok('nouveau mot de passe maître → accueil', await waitUrl('dashboard.html'));
    await sleep(800);
    ok('accueil : indique comment restaurer une sauvegarde', await visible('#restore-hint') && /Paramètres › Sauvegarde › Restaurer une sauvegarde/.test(await text('#restore-hint')));
    await click('#restore-hint-btn');
    ok('lien vers Paramètres › Sauvegarde', await waitUrl('settings.html'));
    await sleep(600);
    await type('#bk-import-pass', PHRASE2); await click('#bk-import-merge'); await sleep(300);
    ok('sauvegarde restaurée dans le nouveau coffre', await waitFor(async () => (await js(`window.passory.items.counts()`)).total === 1));
    const restored = (await js(`window.passory.items.list('note')`)).entries[0];
    ok('contenu restauré identique', restored && (await js(`window.passory.items.get(${S(restored && restored.id)})`)).entry.payload.content === 'contenu factice');
    await js(`window.passory.auth.lock()`);
    ok('l\'ancien mot de passe n\'ouvre plus rien', !(await js(`window.passory.auth.unlock(${S(MAITRE3)})`)).success);
    await sleep(1200);
    ok('le nouveau mot de passe ouvre le coffre', (await js(`window.passory.auth.unlock(${S(MAITRE4)})`)).success);

    ok('aucune erreur console / violation CSP', problems.length === 0, problems.slice(0, 5).join(' | '));
  } catch (err) {
    ok('exécution', false, err.stack);
  }
  console.log('\n' + results.join('\n'));
  app.exit(process.exitCode || 0);
});
