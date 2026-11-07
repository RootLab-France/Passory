/**
 * post-cap-sync.js — remet les overrides locaux après `npx cap sync android`.
 *
 * Raison d'être : Capacitor RÉ-ÉCRIT systématiquement
 *   android/capacitor-cordova-android-plugins/build.gradle
 * à chaque sync, ce qui reset la version d'Android Gradle Plugin (AGP) à
 * celle scaffolée d'origine (8.2.1). Cette version est INCOMPATIBLE avec
 * Java 21 (AGP < 8.5 ne supporte pas JDK 21 en runtime Gradle).
 *
 * Ce script force AGP 8.7.2 dans ce subproject après chaque sync. Il est
 * idempotent : si la valeur est déjà bonne, il ne fait rien.
 *
 * Le `android/build.gradle` principal (racine), `android/gradle/wrapper/
 * gradle-wrapper.properties` ne sont PAS re-écrits par `cap sync` — seul
 * le subproject Cordova l'est.
 *
 * Usage : déclenché automatiquement via `npm run cap:sync` dans package.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// --- Cibles à patcher ---------------------------------------------------
const patches = [
  {
    file: path.join(ROOT, 'android', 'capacitor-cordova-android-plugins', 'build.gradle'),
    find: /classpath 'com\.android\.tools\.build:gradle:[\d.]+'/,
    replace: "classpath 'com.android.tools.build:gradle:8.7.2'",
    label: 'AGP version (cordova plugins subproject)',
  },
];

let patched = 0;
for (const p of patches) {
  if (!fs.existsSync(p.file)) {
    console.warn(`[post-sync] SKIP (absent) : ${path.relative(ROOT, p.file)}`);
    continue;
  }
  const before = fs.readFileSync(p.file, 'utf8');
  const after = before.replace(p.find, p.replace);
  if (before === after) {
    console.log(`[post-sync] OK (déjà patché) : ${p.label}`);
    continue;
  }
  fs.writeFileSync(p.file, after, 'utf8');
  patched += 1;
  console.log(`[post-sync] patched : ${p.label}`);
}

console.log(`[post-sync] terminé — ${patched} override(s) appliqué(s).`);
