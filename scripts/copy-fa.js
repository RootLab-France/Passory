/**
 * Copie Font Awesome (CSS + webfonts) depuis node_modules vers assets/fa/
 * afin que l'app fonctionne sans accès internet.
 *
 * Exécuté automatiquement par `npm install` (hook postinstall).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', '@fortawesome', 'fontawesome-free');
const DST = path.join(ROOT, 'assets', 'fa');

if (!fs.existsSync(SRC)) {
  console.warn('[copy-fa] @fortawesome/fontawesome-free non installé — skip');
  process.exit(0);
}

// On ne copie que ce qui est réellement utilisé dans les HTML
const items = [
  { src: path.join(SRC, 'css', 'all.min.css'), dst: path.join(DST, 'css', 'all.min.css') },
  { src: path.join(SRC, 'webfonts'),           dst: path.join(DST, 'webfonts') },
  // Obligatoire : les polices sont sous SIL OFL 1.1 et les icônes en CC BY 4.0,
  // la licence doit accompagner les fichiers redistribués.
  { src: path.join(SRC, 'LICENSE.txt'),        dst: path.join(DST, 'LICENSE.txt') }
];

function copyRec(s, d) {
  const stat = fs.statSync(s);
  if (stat.isDirectory()) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    for (const f of fs.readdirSync(s)) copyRec(path.join(s, f), path.join(d, f));
  } else {
    if (!fs.existsSync(path.dirname(d))) fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
  }
}

for (const it of items) {
  if (!fs.existsSync(it.src)) {
    console.warn(`[copy-fa] introuvable : ${it.src}`);
    continue;
  }
  copyRec(it.src, it.dst);
}

console.log('[copy-fa] Font Awesome copié dans assets/fa/');
