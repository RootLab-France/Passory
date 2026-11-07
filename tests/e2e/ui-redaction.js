/**
 * Test de bout en bout Electron (coffre FACTICE) : interface sur listes expurgées.
 * Lancement : E2E_DIR=/tmp/x xvfb-run electron tests/e2e/ui-redaction.js
 */
'use strict';
const { app, BrowserWindow, clipboard } = require('electron');
const path = require('path');
const DIR = process.env.E2E_DIR;
app.setPath('userData', DIR);
require('../../main.js');

const results = []; const problems = [];
const ok = (name, cond, extra) => { results.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitWin() { for (let i = 0; i < 100; i++) { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('.html') && !x.webContents.getURL().includes('loader')); if (w) return w; await sleep(100); } throw new Error('pas de fenêtre'); }
async function load(win, page) { await win.loadFile(path.join(__dirname, '../..', page)); await sleep(600); }
const js = (win, code) => win.webContents.executeJavaScript(code, true);
const S = JSON.stringify;

// Secrets factices
const PW = 'Pw-Factice-E2E-9f3k';
const TOTP = 'JBSWY3DPEHPK3PXP';
const CARD = '4111111111111111', CARD_FMT = '4111 1111 1111 1111', CVV = '582', PIN = '4821';
const IBAN = 'FR7630006000011234567890189', IBAN_FMT = 'FR76 3000 6000 0112 3456 7890 189', BIC = 'AGRIFRPP';
const DOC = '24AB12345';
const SECRETS = [PW, TOTP, CARD, CARD_FMT, CVV, PIN, IBAN, IBAN_FMT, DOC];

const bodyText = (win) => js(win, `document.body.innerText`);
const leaks = (text) => SECRETS.filter((s) => text.includes(s));
// Clic sur un bouton d'action de la première ligne de la page
const click = (win, action) => js(win, `(() => { const b = document.querySelector('#list [data-action="${action}"]'); if (!b) return false; b.click(); return true; })()`);
async function clipAfter(win, action) { clipboard.writeText('vide'); await click(win, action); await sleep(400); return clipboard.readText(); }
const search = (win, q) => js(win, `{ const s = document.getElementById('search'); s.value = ${S(q)}; s.dispatchEvent(new Event('input')); }`);
async function editAndSave(win, newLabel) {
  await click(win, 'edit'); await sleep(500);
  const opened = await js(win, `!document.getElementById('modal').classList.contains('hidden')`);
  await js(win, `document.getElementById('m-label').value = ${S(newLabel)}; document.getElementById('modal-form').requestSubmit();`);
  await sleep(900);
  return opened;
}

app.whenReady().then(async () => {
  try {
    const win = await waitWin();
    win.webContents.on('console-message', (e) => {
      const lvl = e.level, msg = e.message;
      if (lvl === 'error' || lvl === 3 || /Content Security Policy|Refused/.test(msg)) problems.push(win.webContents.getURL().split('/').pop() + ' : ' + msg.slice(0, 200));
    });
    await sleep(800);
    ok('création du coffre', (await js(win, `window.passory.auth.createMaster('Factice-E2E-Maitre-2026')`)).success);
    const add = async (type, p) => (await js(win, `window.passory.items.add(${S(type)}, ${S(p)})`));
    const aPw = await add('password', { label: 'Factice', url: 'https://exemple.test', username: 'utilisateur-factice', password: PW, notes: 'note pw', totpSecret: TOTP, extra: 'garde-moi' });
    const aCard = await add('card', { label: 'Carte factice', holder: 'Jean Factice', number: CARD, expiry: '12/30', cvv: CVV, pin: PIN, bank: 'Banque Factice', network: 'Visa', notes: '' });
    const aIban = await add('iban', { label: 'Compte factice', bank: 'Banque Factice', holder: 'Jean Factice', iban: IBAN, bic: BIC, notes: '' });
    const aId = await add('identity', { label: 'CNI factice', docType: 'id_card', country: 'FR', fullName: 'Jean Factice', docNumber: DOC, expiry: '2031-01-01', notes: '' });
    ok('ajout des 4 éléments', aPw.success && aCard.success && aIban.success && aId.success);
    // Réglages « démasqués » : ne doivent provoquer aucune révélation globale
    await js(win, `window.passory.settings.set({ maskPasswords: false, maskSensitive: false })`);

    const all = await js(win, `window.passory.items.list()`);
    ok('items.list sans aucun secret complet', all.success && leaks(S(all.entries.map((e) => e.payload))).length === 0, leaks(S(all.entries.map((e) => e.payload))).join(','));
    ok('items.list fournit _has / _hint', all.entries.every((e) => e.redacted && e.payload._has)
      && all.entries.find((e) => e.type === 'card').payload._hint.number === '1111'
      && all.entries.find((e) => e.type === 'iban').payload._hint.iban === '0189'
      && all.entries.find((e) => e.type === 'identity').payload._hint.docNumber === '345');

    // ---- Mots de passe ----
    await load(win, 'passwords.html'); await sleep(1500);
    let t = await bodyText(win);
    ok('passwords : aucun secret affiché', leaks(t).length === 0, leaks(t).join(','));
    ok('passwords : mot de passe masqué', (await js(win, `document.querySelector('[data-password]').textContent.trim()`)) === '••••••••');
    ok('passwords : badge 2FA', (await js(win, `!!document.querySelector('.badge-2fa')`)) === true);
    const code = await js(win, `document.querySelector('[data-code]').textContent.replace(/\\s/g, '')`);
    ok('passwords : code TOTP à 6 chiffres affiché', /^\d{6}$/.test(code), code);
    await click(win, 'toggle'); await sleep(400);
    ok('passwords : afficher révèle le bon mot de passe', (await js(win, `document.querySelector('[data-password]').textContent`)) === PW);
    await click(win, 'toggle'); await sleep(300);
    ok('passwords : masquer remet le masque', (await js(win, `document.querySelector('[data-password]').textContent`)) === '••••••••');
    await js(win, `document.querySelector('[data-password]').click()`); await sleep(400);
    ok('passwords : clic sur la zone révèle', (await js(win, `document.querySelector('[data-password]').textContent`)) === PW);
    await js(win, `document.querySelector('[data-password]').click()`); await sleep(300);
    ok('passwords : copie du mot de passe (copyField)', (await clipAfter(win, 'copy-pass')) === PW);
    ok('passwords : copie de l\'identifiant', (await clipAfter(win, 'copy-user')) === 'utilisateur-factice');
    const tc = await clipAfter(win, 'copy-totp');
    ok('passwords : copie du code TOTP', /^\d{6}$/.test(tc), tc);
    ok('passwords : édition ouverte', await editAndSave(win, 'Factice modifié'));
    let g = await js(win, `window.passory.items.get(${S(aPw.id)})`);
    ok('passwords : sauvegarde sans perte', g.success && g.entry.payload.label === 'Factice modifié' && g.entry.payload.password === PW
      && g.entry.payload.totpSecret === TOTP && g.entry.payload.username === 'utilisateur-factice' && g.entry.payload.notes === 'note pw'
      && g.entry.payload.extra === 'garde-moi' && !('_has' in g.entry.payload), S(g.entry && g.entry.payload));
    t = await bodyText(win);
    ok('passwords : aucun secret affiché après sauvegarde', leaks(t).length === 0, leaks(t).join(','));

    // ---- Cartes ----
    await load(win, 'cards.html');
    t = await bodyText(win);
    ok('cards : aucun secret affiché', leaks(t).length === 0, leaks(t).join(','));
    ok('cards : numéro masqué via _hint', (await js(win, `document.querySelector('[data-field="number"]').textContent`)) === '•••• •••• •••• 1111');
    ok('cards : réseau depuis payload.network', (await js(win, `document.querySelector('.card-network').textContent`)) === 'Visa');
    ok('cards : boutons CVV / PIN actifs', (await js(win, `!document.querySelector('[data-action="copy-cvv"]').disabled && !document.querySelector('[data-action="copy-pin"]').disabled`)) === true);
    await click(win, 'toggle'); await sleep(400);
    ok('cards : afficher révèle numéro et CVV', (await js(win, `document.querySelector('[data-field="number"]').textContent + '|' + document.querySelector('[data-field="cvv"]').textContent`)) === CARD_FMT + '|' + CVV);
    await click(win, 'toggle'); await sleep(300);
    ok('cards : copie numéro', (await clipAfter(win, 'copy-number')) === CARD);
    ok('cards : copie CVV', (await clipAfter(win, 'copy-cvv')) === CVV);
    ok('cards : copie PIN', (await clipAfter(win, 'copy-pin')) === PIN);
    ok('cards : édition ouverte', await editAndSave(win, 'Carte modifiée'));
    g = await js(win, `window.passory.items.get(${S(aCard.id)})`);
    ok('cards : sauvegarde sans perte', g.success && g.entry.payload.label === 'Carte modifiée' && g.entry.payload.number === CARD
      && g.entry.payload.cvv === CVV && g.entry.payload.pin === PIN && g.entry.payload.network === 'Visa', S(g.entry && g.entry.payload));

    // ---- IBAN ----
    await load(win, 'ibans.html');
    t = await bodyText(win);
    ok('ibans : aucun secret affiché', leaks(t).length === 0, leaks(t).join(','));
    ok('ibans : IBAN masqué via _hint', (await js(win, `document.querySelector('[data-field="iban"]').textContent`)).endsWith('0189'));
    await search(win, '0189');
    ok('ibans : recherche sur l\'indice', (await js(win, `document.querySelectorAll('#list [data-id]').length`)) === 1);
    await search(win, 'FR7630006');
    ok('ibans : pas de recherche dans l\'IBAN complet', (await js(win, `document.querySelectorAll('#list [data-id]').length`)) === 0);
    await search(win, '');
    await click(win, 'toggle'); await sleep(400);
    ok('ibans : afficher révèle l\'IBAN', (await js(win, `document.querySelector('[data-field="iban"]').textContent`)) === IBAN_FMT);
    await click(win, 'toggle'); await sleep(300);
    ok('ibans : copie IBAN', (await clipAfter(win, 'copy-iban')) === IBAN);
    ok('ibans : copie BIC', (await clipAfter(win, 'copy-bic')) === BIC);
    ok('ibans : édition ouverte', await editAndSave(win, 'Compte modifié'));
    g = await js(win, `window.passory.items.get(${S(aIban.id)})`);
    ok('ibans : sauvegarde sans perte', g.success && g.entry.payload.label === 'Compte modifié' && g.entry.payload.iban === IBAN && g.entry.payload.bic === BIC, S(g.entry && g.entry.payload));

    // ---- Identités ----
    await load(win, 'identities.html');
    t = await bodyText(win);
    ok('identities : aucun secret affiché', leaks(t).length === 0, leaks(t).join(','));
    ok('identities : numéro masqué via _hint', (await js(win, `document.querySelector('[data-field="num"]').textContent`)).endsWith('345'));
    await click(win, 'toggle'); await sleep(400);
    ok('identities : afficher révèle le numéro', (await js(win, `document.querySelector('[data-field="num"]').textContent`)) === DOC);
    await click(win, 'toggle'); await sleep(300);
    ok('identities : copie du numéro', (await clipAfter(win, 'copy-num')) === DOC);
    ok('identities : édition ouverte', await editAndSave(win, 'CNI modifiée'));
    g = await js(win, `window.passory.items.get(${S(aId.id)})`);
    ok('identities : sauvegarde sans perte', g.success && g.entry.payload.label === 'CNI modifiée' && g.entry.payload.docNumber === DOC && g.entry.payload.fullName === 'Jean Factice', S(g.entry && g.entry.payload));

    // --- Notes sécurisées : contenu chargé seulement à l'ouverture ---
    const NOTE = 'Code-de-recuperation-FACTICE-77x';
    const nAdd = await js(win, `window.passory.items.add('note', { title: 'Note factice', content: ${JSON.stringify(NOTE)} })`);
    const pwAdd = await js(win, `window.passory.items.add('password', { label: 'AvecNote', password: 'x', notes: 'note-pw-FACTICE-9q' })`);
    const nl = await js(win, `window.passory.items.list()`);
    const nlS = S(nl.entries.map((e) => e.payload));
    ok('liste : contenu des notes et champ notes expurgés', nAdd.success && pwAdd.success && !nlS.includes(NOTE) && !nlS.includes('note-pw-FACTICE-9q'));
    await load(win, 'notes.html');
    ok('page Notes : contenu absent de la liste', !(await bodyText(win)).includes(NOTE));
    await js(win, `document.querySelector('#list button').click()`); await sleep(700);
    ok('ouverture d\'une note : contenu chargé dans l\'éditeur', (await js(win, `document.getElementById('e-content').value`)) === NOTE);
    await js(win, `(() => { const t = document.getElementById('e-content'); t.value += ' modifie'; t.dispatchEvent(new Event('input')); })()`); await sleep(1200);
    const nid = nAdd.id;
    const ng = await js(win, `window.passory.items.get(${JSON.stringify(nid)})`);
    ok('modification d\'une note enregistrée sans perte', ng.success && ng.entry.payload.content === NOTE + ' modifie' && ng.entry.payload.title === 'Note factice');
    const guard = await js(win, `window.passory.items.update(${JSON.stringify(nid)}, { title: 'x', content: '', _has: { content: true } })`);
    ok('garde : un payload expurgé est refusé à l\'écriture', guard.success === false);

    ok('aucune erreur console / violation CSP', problems.length === 0, problems.slice(0, 5).join(' | '));
  } catch (err) {
    ok('exécution', false, err.stack);
  }
  console.log('\n' + results.join('\n'));
  app.exit(process.exitCode || 0);
});
