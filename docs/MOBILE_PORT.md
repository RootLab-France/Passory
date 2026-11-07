# Passory — Plan de portage mobile (Android + iOS)

Ce document décrit l'architecture cible, le plan de travail phasé, et les
choix techniques pour porter Passory sur Android et iOS tout en gardant
l'app Windows/Electron fonctionnelle.

## Cibles

| Plateforme | Runtime          | Statut actuel |
|------------|------------------|---------------|
| Windows    | Electron 37      | ✅ v0.2.0-alpha |
| Android    | Capacitor 6 + WebView native (Chromium System) | 🏗 Phase 0 |
| iOS        | Capacitor 6 + WKWebView | 🏗 Phase 0 |
| Linux      | Electron 37      | 🔜 quasi gratuit |
| macOS      | Electron 37      | 🔜 quasi gratuit |

## Choix technique : Capacitor

Retenu parce que :
- Réutilise 100 % du code UI existant (HTML + Tailwind + vanilla JS).
- Un seul codebase UI commun entre desktop (Electron) et mobile (Capacitor).
- Plugins natifs officiels pour biométrie, Keychain/Keystore, filesystem,
  clipboard — pas besoin d'écrire du code Swift/Kotlin sauf pour l'autofill
  et le transfert par câble (fonctions non couvertes par des plugins
  standards).
- Ionic n'est **pas** requis : on utilise juste le wrapper Capacitor.

Alternatives écartées : React Native (réécriture UI complète), Flutter
(réécriture totale Dart), PWA (iOS limite le stockage & les APIs crypto).

## Architecture cible

```
passory/
├── docs/
│   └── MOBILE_PORT.md           (ce document)
├── src/
│   └── shared/                  ← Code réutilisé sur TOUTES les plateformes
│       ├── crypto/
│       │   ├── multilayer.js    Chiffrement multi-couches (Web Crypto pur)
│       │   ├── kdf.js           Wrapper argon2 (native sur Electron, WASM sur mobile)
│       │   ├── random.js        CSPRNG unifié (crypto.randomBytes vs crypto.getRandomValues)
│       │   └── x25519.js        ECDH pour le transfert par câble
│       ├── totp.js              TOTP RFC 6238 (déjà portable — dépend de SubtleCrypto)
│       ├── validators/
│       │   ├── iban.js          Mod-97
│       │   └── card.js          Détection réseau
│       ├── generator.js         Générateur de mot de passe (CSPRNG)
│       ├── storage/
│       │   ├── adapter.js       Interface abstraite StorageAdapter
│       │   └── item-schema.js   Types et validation des items du coffre
│       └── transfer/
│           ├── pctp-protocol.js Passory Cable Transfer Protocol (handshake)
│           └── pctp-frames.js   Framing binaire
│
├── platform/
│   ├── electron/                ← Code Electron-spécifique
│   │   ├── main.js              (ex-racine main.js, refactor)
│   │   ├── preload.js
│   │   ├── storage-fs.js        StorageAdapter via fs
│   │   └── transfer-usb.js      Transport câble via node-usb / TCP
│   └── capacitor/               ← Code Capacitor-spécifique
│       ├── capacitor.config.ts
│       ├── storage-cap.js       StorageAdapter via Capacitor Preferences / Filesystem
│       ├── biometric.js         Wrapper Capacitor BiometricAuth
│       └── transfer-mobile.js   Transport câble (USB OTG, tethering, WebUSB)
│
├── ui/                          ← HTML + Tailwind + JS UI (partagé)
│   ├── dashboard.html
│   ├── passwords.html
│   ├── …
│   └── assets/
│
├── android/                     ← Généré par Capacitor (projet Android Studio)
├── ios/                         ← Généré par Capacitor (projet Xcode)
└── package.json
```

## Couche d'abstraction : StorageAdapter

Un seul contrat ; deux implémentations. Le code métier (`items.js`,
`settings.js`, `backup.js`) dépend uniquement de l'interface.

```js
interface StorageAdapter {
  readFile(name: string): Promise<string | null>;
  writeFile(name: string, content: string): Promise<void>;
  deleteFile(name: string): Promise<void>;
  listFiles(): Promise<string[]>;
  // Pour les secrets du quick-unlock (équivalent safeStorage)
  secureGet(key: string): Promise<string | null>;
  secureSet(key: string, value: string): Promise<void>;
  secureDelete(key: string): Promise<void>;
  // Pour la sélection fichier utilisateur (backup export/import)
  pickSaveFile(defaultName: string): Promise<string | null>;
  pickOpenFile(): Promise<{path: string, content: string} | null>;
}
```

| Plateforme | `readFile` | `secureGet` | `pickSaveFile` |
|------------|------------|-------------|----------------|
| Electron   | `fs.readFileSync`         | `safeStorage` (DPAPI) | `dialog.showSaveDialog` |
| Capacitor  | `Filesystem.readFile`     | `SecureStorage` (Keychain/Keystore) | `Share` + `Filesystem` |

## Couche d'abstraction : crypto

L'actuel `crypto/crypto.js` utilise `require('crypto')` (Node.js) et
`require('argon2')` (natif binding). Pour mobile, on a besoin de :

| Fonction      | Electron (Node)       | Mobile (WebView + WASM)    |
|---------------|-----------------------|----------------------------|
| AES-256-GCM   | `crypto.createCipheriv` | `SubtleCrypto.encrypt AES-GCM` |
| HKDF-SHA256   | `crypto.hkdfSync`     | `SubtleCrypto.deriveBits HKDF` |
| argon2id      | `argon2` native addon | `argon2-browser` (WASM)    |
| X25519 ECDH   | `crypto.diffieHellman` (node 20+) | `@noble/curves/ed25519` (pur JS) |
| CSPRNG        | `crypto.randomBytes`  | `crypto.getRandomValues`   |
| HMAC-SHA256/1 | `crypto.createHmac`   | `SubtleCrypto.sign HMAC`   |

Plan : réécrire `src/shared/crypto/` en **Web Crypto uniquement** (fonctionne
sous Electron renderer ET mobile WebView). L'argon2 WASM est la seule
lib externe — argon2-browser est 400 Ko gzippé, acceptable.

Avantage : `totp.js` est déjà fait comme ça et marche en production.

## Protocole de transfert par câble — PCTP

### Principe

PCTP (Passory Cable Transfer Protocol) permet d'échanger le coffre (ou
un sous-ensemble) entre deux appareils Passory physiquement connectés
par câble, **sans jamais passer par internet, sans cloud, sans compte**.

### Transports supportés

| Côté A    | Côté B    | Câble                          | Canal physique                        |
|-----------|-----------|--------------------------------|---------------------------------------|
| PC        | PC        | USB-C data transfer (J5Create) | TCP sur l'interface réseau virtuelle  |
| PC        | Android   | USB-C                          | `adb reverse` + socket localhost      |
| PC        | iPhone    | Lightning/USB-C                | Personal Hotspot USB + Bonjour        |
| Android   | Android   | USB-C OTG                      | WebUSB (Chromium WebView)             |
| Android   | iPhone    | USB-C vers Lightning           | ⚠️ non supporté (restriction iOS)     |
| iPhone    | iPhone    | Câble Lightning ↔ Lightning    | ⚠️ non possible (Apple MFi obligatoire). Fallback Multipeer Connectivity Bluetooth/WiFi Direct. |

Chaque transport implémente une interface `Transport` minimale :
`send(bytes)`, `recv() -> bytes`, `close()`. PCTP fonctionne au-dessus
indépendamment du choix transport.

### Handshake (5 étapes)

```
Alice (sender)                              Bob (receiver)
────────────────────────────────────────────────────────────

(1) ClientHello
    ephKeyA = X25519.generate()
    nonceA  = randomBytes(16)
    version = 1
    → {version, ephPubA, nonceA}            →

                                            (2) ServerHello
                                            ephKeyB = X25519.generate()
                                            nonceB  = randomBytes(16)
                                            ←       {ephPubB, nonceB}

(3) Both: derive shared key
    shared = X25519(ephPrivA, ephPubB)  (symmetric on each side)
    ikm    = shared
    salt   = nonceA || nonceB
    info   = "passory-pctp-v1"
    sessionKey = HKDF-SHA256(ikm, salt, info, 32)
    sasBytes   = HKDF-SHA256(ikm, salt, "passory-pctp-sas", 4)
    SAS        = to_emoji_pair(sasBytes)    (2 emojis, ou 6 chiffres)

(4) SAS confirmation (bouton utilisateur sur les 2 écrans)
    └── si les 2 SAS ne matchent pas → abort

(5) Data transfer
    Chaque message chiffré AES-256-GCM avec sessionKey,
    nonce = 12 octets : [sender_id (1B)][counter (11B)]
    Le compteur incrémente à chaque message envoyé par un côté.
    Format frame : [type:u8][len:u32][ciphertext:len][tag:16]

    Messages applicatifs :
      MANIFEST  { version, itemCount, settingsIncluded, size }
      ITEM      { id, type, encryptedPayload }     (payload déjà chiffré par le coffre origine)
      SETTINGS  { encryptedBlob }
      DONE
      ERROR     { code, message }
```

### Pourquoi c'est sécurisé

- **Forward secrecy** : les clés ECDH sont éphémères, régénérées à chaque
  transfert. Même si un attaquant enregistre le trafic et compromet
  Passory plus tard, il ne peut pas déchiffrer l'échange.
- **Authentification mutuelle** : la SAS (Short Auth String) visible sur
  les 2 écrans empêche un MITM actif. Si quelqu'un s'intercale, les SAS
  divergent → l'utilisateur voit et refuse.
- **Confidentialité + intégrité** : AES-256-GCM avec clé dérivée du
  secret ECDH. Aucun message n'est lisible par le câble, tout est
  authentifié par le tag GCM.
- **Double chiffrement des données** : les items du coffre transitent
  **déjà chiffrés** (enveloppe AES-GCM multi-couches du coffre source),
  puis sont re-chiffrés par la couche PCTP. Même si la clé de session
  PCTP fuite, le receveur doit encore avoir le mot de passe maître du
  coffre source pour lire les items. (⚠️ Cela implique que les 2 coffres
  partagent le master password ou qu'on exporte via la fonction backup
  avec une passphrase indépendante.)
- **Protection contre la relecture** : le compteur GCM garantit qu'un
  même message ne peut pas être rejoué.
- **Pas d'internet** : attaque réseau impossible par design.

### Modèle de menace

- Câble USB hardware tampered (attaque O.MG cable) : hors scope pour v1,
  PCTP suppose que les 2 appareils parlent bien directement — on compense
  par la SAS utilisateur.
- OS compromis sur un des appareils : hors scope (si l'OS est vérolé,
  aucun password manager ne protège).
- Écoute passive sur le câble : **protégée** par ECDH + AES-GCM.
- MITM actif sur le câble : **protégée** par la SAS (2 emojis différents
  d'un côté vs l'autre → l'utilisateur annule).

## Plan de travail phasé

### Phase 0 — Fondation (EN COURS)

- [x] Plan d'architecture (ce document)
- [x] Création de `src/shared/` et extraction des modules portables
- [x] Spécification PCTP + implémentation crypto (transport-agnostic)
- [x] Interface `StorageAdapter`
- [ ] Config Capacitor skeleton (capacitor.config.ts, scripts npm)

### Phase 1 — Adaptation crypto Web-only

- Réécrire `crypto/crypto.js` en `src/shared/crypto/multilayer.js`
  utilisant uniquement Web Crypto (SubtleCrypto) + `argon2-browser`
  WASM pour la KDF.
- Écrire des tests de round-trip Python qui valident que le nouveau
  code déchiffre bien les anciens vaults et vice-versa.
- Migrer l'Electron à utiliser le module partagé.

### Phase 2 — Storage adapter

- Refactorer `items.js`, `settings.js`, `backup.js` pour qu'ils
  dépendent uniquement de `StorageAdapter`.
- Implémentation Electron : wrap `fs` et `safeStorage`.
- Implémentation Capacitor : wrap `@capacitor/filesystem`,
  `@capacitor-community/secure-storage`.

### Phase 3 — Setup Capacitor

- `npm install @capacitor/core @capacitor/cli`
- `npx cap init Passory fr.rootlab.passory --web-dir=ui`
- `npx cap add ios`, `npx cap add android`
- Plugins : `@capacitor/preferences`, `@capacitor/filesystem`,
  `@capacitor/clipboard`, `@aparajita/capacitor-biometric-auth`,
  `@capacitor-community/secure-storage`.

### Phase 4 — UI mobile

- Adaptations tactiles : boutons min 44x44 pt (Apple HIG),
  padding safe-area (notch iPhone + gesture area).
- Titlebar custom (cacher sur mobile, utiliser la status bar).
- Gestes : swipe-to-delete sur les listes, pull-to-refresh.
- Tests sur émulateur Android + simulateur iOS.

### Phase 5 — Biométrie + Keychain

- Enable biometric unlock via `BiometricAuth.verify()`.
- Stockage de la clé de quick-unlock dans SecureStorage
  (Keychain iOS / Android Keystore) — équivalent mobile de DPAPI.

### Phase 6 — Transfert câble

- Implémentation des 3 transports : PC↔PC (tethered Ethernet),
  PC↔Android (`adb reverse`), Android↔Android (WebUSB).
- UI : page `transfer.html` avec sélection direction (envoyer/recevoir),
  affichage SAS, barre de progression.
- Tests d'intégration avec 2 appareils physiques.

### Phase 7 — Autofill

- Android : AutofillService natif (Kotlin, plugin Capacitor custom).
- iOS : Credential Provider Extension (Swift, plugin custom).
- Le plus gros chantier — estimer 2-3 semaines de dev natif.

### Phase 8 — Builds & signing

- Android : release keystore, upload Play Store.
- iOS : provisioning profile, App Store Connect, TestFlight.

## Dépendances externes à ajouter

```
npm install @capacitor/core @capacitor/cli
npm install @capacitor/ios @capacitor/android
npm install @capacitor/preferences @capacitor/filesystem @capacitor/clipboard
npm install @capacitor/share @capacitor/status-bar
npm install @aparajita/capacitor-biometric-auth
npm install @capacitor-community/secure-storage
npm install argon2-browser
npm install @noble/curves          # X25519 ECDH pur JS
```

Toutes sont actives, maintenues, sans dépendances suspectes. `argon2-browser`
est un port WASM officiel de la spec argon2. `@noble/curves` est la lib
crypto pure JS de référence (Paul Miller, auditée).

## Ce qui reste spécifique à chaque plateforme

Même avec Capacitor, on ne peut pas tout partager :

| Feature                       | Electron       | Android   | iOS             |
|-------------------------------|----------------|-----------|-----------------|
| Quick unlock biométrique      | ❌ (Windows Hello WIP) | `BiometricAuth` | `BiometricAuth` (Face ID) |
| Autofill système              | ❌             | Service natif Kotlin | Credential Provider Swift |
| Transfert USB direct          | `node-usb` / TCP tethered | WebUSB + `adb reverse` | ⚠️ Non — fallback Multipeer BT |
| Notifications                 | Electron Notification | Capacitor Push | Capacitor Push |
| Mise à jour auto              | electron-updater | Play Store | App Store |

## Notes de migration pour les utilisateurs Windows existants

Le portage n'affectera **pas** le format du coffre (`items.vault`,
`settings.json`). Les couches de chiffrement restent identiques.

Un utilisateur Windows pourra transférer son coffre vers son téléphone
de 2 façons :
1. **Backup chiffré** (existant) : export `.pasbak` avec passphrase,
   partage via iCloud/Google Drive/email, import côté mobile.
2. **Câble PCTP** (nouveau, phase 6) : plus fluide, zéro upload cloud.

## Risques & incertitudes

- **iOS sandbox** : Apple interdit la communication USB P2P sans MFi.
  Le "transfert par câble iOS↔iOS" sera en réalité du Multipeer
  Connectivity (Bluetooth/WiFi Direct), pas littéralement USB. À
  communiquer clairement dans l'UI.
- **WebUSB** : la WebView WKWebView d'iOS ne supporte PAS WebUSB.
  Android WebView (Chromium) oui.
- **argon2-browser perf** : sur mobile bas de gamme, le déverrouillage
  peut prendre 2-4 secondes. Ajuster `memoryCost` dynamiquement selon
  l'appareil.
- **Stockage iOS** : le WKWebView a une quota de 50 MB par défaut.
  Pour des coffres > 50 MB il faut utiliser Capacitor Filesystem
  avec `Directory.Data` (pas de limite).
- **Autofill** : coûteux en dev (Swift + Kotlin). Envisager de livrer
  v1 mobile sans autofill et l'ajouter en v1.1.
