# Passory

Gestionnaire de mots de passe local, Electron, **sans compte**. Un seul
mot de passe maître, dérivation argon2id et chiffrement AES-256-GCM
authentifié (une couche, données associées par élément). Toutes les données
restent sur l'ordinateur : l'application n'ouvre aucune connexion réseau — ni
compte, ni serveur, ni télémétrie, ni vérification de mise à jour.

> L'application Android déclare la permission `INTERNET`, valeur par défaut du
> modèle Capacitor, qu'aucun code de Passory n'utilise.

## Lancement (première fois)

```bash
npm install
```

Le hook `postinstall` compile la feuille Tailwind et copie Font Awesome
dans `assets/fa/`. Si ça échoue, relance manuellement :

```bash
npm run build:css
npm run copy:fa
```

Puis :

```bash
npm start
```

## Développement

- `npm run watch:css` — recompile Tailwind à chaque modification des HTML/JS.
- `npm run dev` — rebuild CSS + lance Electron (DevTools dispo tant que
  l'app n'est pas packagée).

## Modèle de sécurité

1. Au premier lancement, l'utilisateur crée un **mot de passe maître**
   (12 caractères minimum).
2. Une **clé 32 octets** est dérivée via **argon2id** (sel aléatoire de
   16 octets, 64 Mo, t = 3, p = 1). Les paramètres argon2id et le sel sont
   stockés dans l'en-tête du coffre. La clé vit **uniquement en mémoire du
   process main** tant que le coffre est déverrouillé : jamais envoyée au
   renderer, **jamais écrite sur disque côté bureau** (ni clé de session, ni
   clé de déblocage rapide : cf. point 6).
3. **Coffre v2** : un seul fichier `vault.json`
   `{ format: 2, kdf, verifier, items: [ { id, type, createdAt, updatedAt, data: { iv, ct } } ] }`,
   écrit d'un bloc (fichier temporaire + renommage) avec une copie
   `vault.json.bak` de la version précédente. Le `verifier` (texte connu
   chiffré) permet de valider le mot de passe sans stocker de hash.
4. Chaque élément est chiffré **en une seule couche AES-256-GCM** (IV
   aléatoire de 96 bits, tag de 128 bits) avec une sous-clé dérivée de la
   clé maître par HKDF-SHA256. Les **données associées (AAD)** lient le
   chiffré à l'identifiant et au type de l'élément : déplacer un chiffré
   vers un autre élément ou changer son type fait échouer le déchiffrement.
   Le type, les dates et le nombre d'éléments restent visibles (non
   chiffrés, mais authentifiés).
5. **Ancien format v1 (« multi-couches »)** : il n'est plus jamais écrit.
   Un coffre v1 (`master.vault` + `items.vault` / `passwords.vault`) est
   converti en v2 au premier déverrouillage réussi ; les anciens fichiers
   sont conservés en `*.v1-bak`. Le code correspondant
   (`src/shared/crypto/legacy-v1.js`) ne sait que déchiffrer.
6. **Pas de déblocage rapide sur le bureau (v1.0)** : le mot de passe
   maître est demandé à chaque ouverture. L'ancien déblocage rapide
   (clé maître chiffrée par DPAPI/`safeStorage` dans `quickunlock.vault`) est
   retiré : l'adaptateur de stockage bureau refuse toute écriture de clé, le
   cœur est construit avec `allowQuickUnlock: false`, et **au démarrage**
   `quickunlock.vault`, une éventuelle `secure/session-key.vault` et l'ancien
   réglage `quickUnlockEnabled` de `settings.json` sont supprimés.
   Sur **mobile (Android)**, le déverrouillage biométrique reste disponible :
   la clé est confiée au stockage sécurisé du système et la biométrie est
   exigée avant chaque usage.
7. **Verrouillage automatique** après N minutes d'inactivité (paramétrable,
   0 = désactivé), à la mise en veille et au verrouillage de session
   Windows (Win+L), et optionnellement à la minimisation.
8. **Presse-papier** : sous Windows, les copies sont **exclues de
   l'historique (Win+V) et de la synchronisation cloud** du presse-papier
   (si Windows refuse, copie classique et avertissement à l'utilisateur).
   Le presse-papier est effacé automatiquement après 20 s (paramétrable) si
   son contenu n'a pas changé.
9. **Sauvegardes chiffrées** (export / import, voir plus bas) : l'export
   et le remplacement du coffre par une sauvegarde exigent de ressaisir le
   mot de passe maître. C'est aussi **le moyen de passer sur un autre
   appareil** en v1.0 (exporter, copier le fichier, restaurer).
10. **« Repartir de zéro »** (écran de connexion › « Mot de passe maître
   oublié ? ») : pour qui a perdu son mot de passe maître. Efface le coffre
   (voir « Version 1.0 » plus bas) ; aucune donnée n'est récupérable sans le
   mot de passe, seule une sauvegarde (et sa phrase de passe) permet de
   retrouver ses éléments.

## Structure

```
.
├── main.js                 Process principal Electron (IPC, crypto, fenêtres)
├── preload.js              Pont contextBridge → window.passory.*
├── settings.js             Module lecture/écriture settings.json
├── items.js                Lecture/écriture du coffre v2 (vault.json)
├── backup.js               Sauvegardes chiffrées (export v3, import v1/v2/v3)
├── src/shared/crypto/      argon2id (kdf.js), AES-256-GCM + AAD (aead.js),
│                           lecture seule de l'ancien format v1 (legacy-v1.js)
├── src/shared/features.js  Interrupteurs de fonctions (FEATURES.transfer)
├── src/shared/transfer/    Protocole PCTP (désactivé en v1.0, conservé pour la 1.1)
├── assets/
│   ├── css/
│   │   ├── tailwind.src.css  (source : @tailwind directives)
│   │   └── tailwind.css      (généré — ne pas éditer)
│   ├── fa/                 Font Awesome (copié par postinstall, ne pas commit)
│   └── js/
│       ├── common.js       Helpers UI (titlebar, activité, toast, nav)
│       ├── login.js
│       ├── create-master-password.js
│       ├── dashboard.js
│       ├── passwords.js
│       └── settings.js
├── scripts/
│   └── copy-fa.js          Copie Font Awesome depuis node_modules
├── tailwind.config.js
├── loader.html             Splash de démarrage
├── login.html              Saisie du master password, « Repartir de zéro »
│                           (+ biométrie sur mobile uniquement)
├── create-master-password.html
├── dashboard.html
├── passwords.html
└── settings.html
```

Données à l'exécution (hors du dossier de l'application) : dossier
`vault` de `userData`, soit `%APPDATA%\Passory\vault\` sous Windows :

```
vault/
├── vault.json              coffre v2 (cf. Modèle de sécurité)
├── vault.json.bak          version précédente du coffre
├── settings.json           paramètres (non sensibles)
└── *.v1-bak                anciens fichiers v1 après migration
```

## Paramètres disponibles

- **Déverrouillage par biométrie** — mobile uniquement (absent sur le bureau).
- **Verrouillage automatique** — minutes d'inactivité avant lock (0–240).
- **Masquage par défaut** — affiche les mots de passe sous forme de points
  dans la liste.
- **Changer le mot de passe maître** — ré-chiffre automatiquement toutes les
  entrées existantes avec la nouvelle clé.

## Sauvegarde

**Export chiffré** (Paramètres → Sauvegarde) : produit un fichier JSON
autonome, chiffré par une **phrase de passe d'export** (12 caractères
minimum) indépendante du mot de passe maître. Format **v3** :

```
{ app: "passory", version: 3, createdAt, cipher: "AES-256-GCM",
  kdf: { alg: "argon2id", memoryCost, timeCost, parallelism, saltHex },
  payload: { iv, ct } }
```

La clé est dérivée de la phrase de passe par argon2id (sel aléatoire,
paramètres stockés dans le fichier) ; le contenu est chiffré en une seule
couche AES-256-GCM dont les données associées lient tout l'en-tête
(application, version, chiffrement, paramètres KDF, sel, date). L'import
lit aussi les anciennes sauvegardes **v2** (une couche, AAD fixe) et **v1**
(multi-couches).

Copier le dossier `vault` (voir plus haut) hors de l'ordinateur est aussi
possible : `vault.json` est chiffré et le mot de passe maître reste
nécessaire pour l'ouvrir.

## Version 1.0 : décisions

**1. Transfert entre appareils (PCTP) retiré de la v1.0.** Il ne
fonctionnait pas pour le public (le bureau ne se connecte qu'à `127.0.0.1`,
absent sur Android). Un drapeau unique, `FEATURES.transfer = false` dans
`src/shared/features.js`, pilote tout : plus d'entrée « Transfert » dans le
menu, `transfer.html` renvoie à l'accueil (page et garde de navigation du
process principal), le preload n'expose plus `window.passory.transfer` et les
canaux IPC `pctp:*` répondent par un refus clair sans ouvrir de serveur TCP ni
charger de module réseau. Le code du protocole (`src/shared/transfer/`) et ses
tests unitaires sont conservés pour la 1.1. Pour changer d'appareil :
**sauvegarde chiffrée** (Paramètres › Sauvegarde : créer, copier le fichier,
puis « Restaurer une sauvegarde » sur l'autre appareil).

**2. « Repartir de zéro » sur l'écran de connexion.** Lien « Mot de passe
maître oublié ? » › bouton « Repartir de zéro… ». Protections :
double confirmation dans l'interface (taper `EFFACER`, puis confirmer) ; côté
cœur (`core.resetForgotten`, canal IPC `auth:reset-forgotten` avec la même
vérification d'expéditeur que les autres), la demande n'est acceptée que si le
coffre est **verrouillé**, avec le mot `EFFACER`, et **une seule à la fois** ;
la fonction ne lit, ne déchiffre et ne renvoie rien. Elle efface `vault.json`,
`vault.json.bak`, `vault.json.tmp`, les anciens fichiers v1 et leurs archives
`*.v1-bak`, la clé de déblocage rapide et la clé de session, et remet les
réglages par défaut (même logique que « Tout effacer » des Paramètres, qui,
coffre ouvert, exige toujours le mot de passe maître). L'application revient
ensuite à la création du mot de passe maître, puis l'accueil explique comment
restaurer une sauvegarde. Même fonctionnement sur mobile (`web-bootstrap.js`).

**3. Plus de déblocage rapide sur le bureau.** Voir le point 6 du modèle de
sécurité : aucune clé n'est écrite sur disque, le mot de passe maître est
demandé à chaque ouverture, les restes d'une ancienne version sont supprimés
au démarrage. Le déverrouillage biométrique mobile est inchangé.


## Site officiel

La seule adresse officielle de Passory est **<https://passory.rootlab.fr>**, et les installeurs
officiels sont publiés dans les *Releases* de ce dépôt, avec leur empreinte SHA-256. Tout
installeur obtenu ailleurs doit être considéré comme non fiable.

## Licence

Passory — Copyright (C) 2026 RootLab, association loi 1901.

Ce programme est un logiciel libre : vous pouvez le redistribuer et le modifier
selon les termes de la GNU General Public License version 3, telle que publiée
par la Free Software Foundation.

Il est distribué dans l'espoir qu'il sera utile, mais **SANS AUCUNE GARANTIE**,
sans même la garantie implicite de COMMERCIALISATION ou d'ADÉQUATION À UN USAGE
PARTICULIER. Voir le fichier [LICENSE](LICENSE) ou
<https://www.gnu.org/licenses/gpl-3.0.html>.

Les composants tiers et leurs licences sont listés dans [THIRD-PARTY.md](THIRD-PARTY.md).
