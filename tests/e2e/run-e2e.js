// Lance les tests de bout en bout dans le vrai Electron (coffres factices).
// Linux sans écran : xvfb-run -a npm run test:e2e
'use strict';
const { spawnSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const electron = require('electron');
let failed = false, okCount = 0, failCount = 0;
// [script, mode, groupe] : les étapes d'un même groupe partagent le même
// dossier de données (redémarrage de l'application sur le même coffre).
const STEPS = [
  ['electron-smoke.js', 'fresh'],
  ['ui-redaction.js', ''],
  ['parcours-ui.js', ''],
  ['bureau-sans-cle.js', 'lancement-1', 'sans-cle'],
  ['bureau-sans-cle.js', 'lancement-2', 'sans-cle'],
  ['mobile-webview.js', ''],
];
const groupDirs = {};
for (let i = 0; i < STEPS.length; i++) {
  const [script, mode, group] = STEPS[i];
  const dir = group ? (groupDirs[group] = groupDirs[group] || fs.mkdtempSync(path.join(os.tmpdir(), 'passory-e2e-')))
                    : fs.mkdtempSync(path.join(os.tmpdir(), 'passory-e2e-'));
  const args = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [];
  const r = spawnSync(electron, [...args, path.join(__dirname, script)], { env: { ...process.env, E2E_DIR: dir, E2E_MODE: mode }, encoding: 'utf8' });
  const lines = (r.stdout || '').split('\n').filter((l) => /^(OK|FAIL)/.test(l));
  console.log(`== ${script}${mode ? ' (' + mode + ')' : ''}\n` + lines.join('\n'));
  okCount += lines.filter((l) => l.startsWith('OK')).length;
  failCount += lines.filter((l) => l.startsWith('FAIL')).length;
  if (r.status !== 0 || lines.some((l) => l.startsWith('FAIL')) || lines.length === 0) failed = true;
  const lastOfGroup = !group || !STEPS.slice(i + 1).some((st) => st[2] === group);
  if (lastOfGroup) fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\nTotal : ${okCount} vérification(s) OK, ${failCount} échec(s).`);
process.exit(failed ? 1 : 0);
