/**
 * build-web.js — prépare le dossier `www/` consommé par Capacitor.
 *
 * Capacitor refuse `webDir: "."` (il se copierait récursivement lui-même).
 * On copie donc dans `www/` uniquement les fichiers dont la WebView mobile
 * a besoin : HTML (sauf loader.html, Electron-only), assets, shared crypto,
 * core, platform Capacitor, et les modules métier UMD à la racine.
 *
 * argon2-browser (WASM) est copié depuis node_modules vers www/vendor/ si
 * la lib est installée.
 *
 * Usage :
 *   node scripts/build-web.js
 *   npm run build:web   (alias configuré dans package.json)
 *
 * Le script est idempotent : il nettoie www/ avant de recopier.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW  = path.join(ROOT, 'www');

// --- Utilitaires ---------------------------------------------------------
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  if (fs.rmSync) fs.rmSync(p, { recursive: true, force: true });
  else fs.rmdirSync(p, { recursive: true });
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst, filter) {
  const stat = fs.statSync(src);
  if (stat.isFile()) {
    if (filter && !filter(src)) return;
    copyFile(src, dst);
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    copyDir(path.join(src, entry), path.join(dst, entry), filter);
  }
}

function glob(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => pattern.test(f));
}

// --- Nettoyage ----------------------------------------------------------
console.log('[build-web] Nettoyage de www/...');
rmrf(WWW);
fs.mkdirSync(WWW, { recursive: true });

// --- 1. HTML pages (sauf loader.html, Electron-only) --------------------
const htmlFiles = glob(ROOT, /\.html$/).filter((f) => f !== 'loader.html');
for (const f of htmlFiles) {
  copyFile(path.join(ROOT, f), path.join(WWW, f));
}
console.log(`[build-web] HTML copiés : ${htmlFiles.length}`);

// --- 2. Modules métier UMD à la racine ---------------------------------
for (const f of ['items.js', 'settings.js', 'backup.js']) {
  if (fs.existsSync(path.join(ROOT, f))) {
    copyFile(path.join(ROOT, f), path.join(WWW, f));
  }
}

// --- 3. assets/ (CSS, FA, logo) -----------------------------------------
copyDir(path.join(ROOT, 'assets'), path.join(WWW, 'assets'));
console.log('[build-web] assets/ copié');

// --- 4. src/ — crypto partagé + core + bootstrap mobile ----------------
// On prend tout src/ sauf les tests éventuels. Le code Electron spécifique
// n'est PAS dans src/ donc pas de filtre nécessaire.
copyDir(path.join(ROOT, 'src'), path.join(WWW, 'src'));
console.log('[build-web] src/ copié');

// --- 5. platform/capacitor/ (adapter + argon2 provider) -----------------
// ON N'INCLUT PAS platform/electron/ — ces fichiers dépendent de Node et
// planteraient au chargement dans la WebView.
copyDir(
  path.join(ROOT, 'platform', 'capacitor'),
  path.join(WWW, 'platform', 'capacitor')
);
console.log('[build-web] platform/capacitor/ copié');

// --- 6. vendor/ — argon2-browser WASM si disponible ---------------------
const argonSrc = path.join(ROOT, 'node_modules', 'argon2-browser', 'dist');
const vendorDst = path.join(WWW, 'vendor');
if (fs.existsSync(argonSrc)) {
  fs.mkdirSync(vendorDst, { recursive: true });
  // On copie tout le dist/ pour être sûr d'avoir argon2.js + WASM + worker.
  for (const f of fs.readdirSync(argonSrc)) {
    copyDir(path.join(argonSrc, f), path.join(vendorDst, f));
  }
  console.log('[build-web] vendor/argon2 copié depuis node_modules/argon2-browser');
} else {
  console.warn('[build-web] argon2-browser absent de node_modules — unlock() échouera.');
}

// --- 7. Logo racine (référencé par les HTML) ----------------------------
for (const f of ['logo.png', 'icon.png']) {
  if (fs.existsSync(path.join(ROOT, f))) {
    copyFile(path.join(ROOT, f), path.join(WWW, f));
  }
}

// --- 8. Capacitor runtime injecté automatiquement par cap sync ----------
// (rien à faire ici — cap sync ajoute capacitor.js + cordova.js au www/).

console.log('[build-web] terminé — www/ prêt pour `cap sync`.');
