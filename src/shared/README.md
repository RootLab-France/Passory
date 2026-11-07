# src/shared — code partagé toutes plateformes

Tout le code de ce dossier est **pur JavaScript Web-Crypto-only**. Il doit
fonctionner à l'identique dans :

- Electron renderer (Chromium récent)
- Electron main (Node.js 20+ qui expose `crypto.webcrypto` comme
  `globalThis.crypto`)
- Capacitor Android (WebView Chromium 90+)
- Capacitor iOS (WKWebView récent)
- PWA / navigateur web

Règles de ce dossier :

1. **Aucun `require('fs')`, `require('crypto')`, `require('electron')` ou
   `import`-statement vers des modules Node-only.** Toute lib externe doit
   être ISO navigateur.
2. **Pas de DOM access direct** (`document`, `window.Passory`, etc.). Ces
   modules sont des librairies, pas du code UI.
3. **CSPRNG exclusivement via `globalThis.crypto.getRandomValues`**.
   Les environnements qui ne l'exposent pas nativement (Node < 19) doivent
   polyfill avant d'importer.
4. **Erreurs explicites** : on lance des `Error` typées, jamais de
   `return null` silencieux pour les échecs crypto.

Structure :

```
shared/
├── crypto/
│   ├── aead.js           Chiffrement du coffre v2 : une couche AES-256-GCM,
│   │                     sous-clé HKDF-SHA256, AAD (élément, vérificateur, sauvegarde)
│   ├── legacy-v1.js      LECTURE SEULE de l'ancien format « multi-couches » v1
│   │                     (migration du coffre, import des sauvegardes v1)
│   ├── kdf.js            argon2id (délégation vers impl native/WASM via DI)
│   ├── random.js         CSPRNG unifié + helpers (randomBytes, randomInt)
│   └── x25519.js         ECDH pour transfert câble (via @noble/curves)
├── totp.js               TOTP RFC 6238 (déjà extrait dans assets/js/totp.js)
├── validators/
│   ├── iban.js           Validation mod-97
│   └── card.js           Détection réseau carte bancaire
├── generator.js          Générateur de mot de passe (CSPRNG)
├── storage/
│   ├── adapter.js        Interface StorageAdapter (doc + contrat)
│   └── item-schema.js    ALLOWED_TYPES + validation de structure ({ iv, ct })
└── transfer/
    ├── pctp-protocol.js  Passory Cable Transfer Protocol (handshake crypto)
    └── pctp-frames.js    Framing binaire des messages PCTP
```

Pour l'Electron actuel, ces modules sont chargés côté renderer via
`<script src="../../src/shared/...">` ou côté main via `require()`
après avoir polyfill `globalThis.crypto` si besoin (Node 19+ l'a déjà).
