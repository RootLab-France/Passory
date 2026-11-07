# Composants tiers

Passory est distribué sous licence GNU GPL version 3. Il incorpore ou redistribue les
composants ci-dessous, sous leurs licences respectives. Toutes sont compatibles avec une
distribution sous GPLv3.

## Embarqués dans l'application

| Composant | Version | Licence | Titulaire |
|---|---|---|---|
| Electron | 44.9.3 | MIT | OpenJS Foundation |
| — Chromium (inclus dans Electron) | — | BSD-3-Clause et licences associées | The Chromium Authors |
| — FFmpeg (inclus dans Electron) | — | LGPL-2.1-or-later | FFmpeg project |
| argon2 (module natif) | 0.43.0 | MIT | Ranieri Althoff |
| — phc-winner-argon2 (implémentation de référence) | — | CC0-1.0 **ou** Apache-2.0, au choix | Argon2 authors |
| argon2-browser (WebAssembly, version mobile) | 1.18.0 | MIT | Anton Antonov |
| @noble/curves | — | MIT | Paul Miller |
| @noble/hashes | — | MIT | Paul Miller |
| Capacitor | — | MIT | Ionic |
| Font Awesome Free | 6.7.2 | Icônes : CC BY 4.0 · Polices : SIL OFL 1.1 · Code : MIT | Fonticons, Inc. |
| Tailwind CSS | — | MIT | Tailwind Labs |

Le texte de la licence Font Awesome est copié dans `assets/fa/LICENSE.txt` à l'installation
et accompagne les fichiers de police redistribués, comme l'exige la SIL Open Font License.
Les licences d'Electron et de Chromium sont embarquées par electron-builder dans l'installeur.

## Attribution Font Awesome

Les icônes de l'interface proviennent de Font Awesome Free 6.7.2
(<https://fontawesome.com>), publiées par Fonticons, Inc. sous licence
Creative Commons Attribution 4.0 International pour les icônes et SIL OFL 1.1 pour les
fichiers de police.

## Dépendances de développement

Les 354 paquets installés par `npm install` déclarent tous une licence : MIT, ISC,
Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, Unlicense, 0BSD, Python-2.0 et WTFPL.
Aucune licence propriétaire, aucune clause non commerciale.

Pour régénérer cet inventaire :

```bash
npx license-checker --summary
```
