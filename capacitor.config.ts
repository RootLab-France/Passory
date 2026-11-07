import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Config Capacitor — Passory mobile.
 *
 * webDir = "./www" : Capacitor refuse "." (il se copierait lui-même). On
 * utilise donc un sous-dossier `www/` peuplé par `scripts/build-web.js` qui
 * recopie uniquement les artéfacts nécessaires à la WebView :
 *   - *.html (sauf loader.html, Electron-only)
 *   - assets/ (css + fa + images)
 *   - src/ (crypto partagé + core + platform/web-bootstrap)
 *   - platform/capacitor/ (adapter + argon2 provider)
 *   - items.js, settings.js, backup.js (UMD wrappers côté root)
 *   - vendor/argon2.js + argon2.wasm (copié depuis node_modules/argon2-browser)
 *
 * L'Electron continue d'utiliser la racine (pas de changement pour
 * `npm start`). Seul le build mobile passe par `npm run build:web && cap sync`.
 */
const config: CapacitorConfig = {
  appId: 'fr.rootlab.passory',
  appName: 'Passory',
  webDir: './www',

  server: {
    androidScheme: 'https',
  },

  // Plugins natifs utilisés — configuration par défaut pour le moment.
  plugins: {
    Preferences: {
      group: 'fr.rootlab.passory',
    },
    CapacitorHttp: {
      enabled: false,
    },
    // Biométrie : Face ID / Touch ID / Android BiometricPrompt.
    BiometricAuth: {
      allowDeviceCredential: true,
      androidBiometryStrength: 'strong',
      iosFallbackTitle: 'Utiliser le code de déverrouillage',
    },
  },

  ios: {
    scheme: 'Passory',
    contentInset: 'automatic',
    // Le WKWebView doit avoir accès au Filesystem Capacitor pour les coffres
    // > 50 MB (quota WebView par défaut). Filesystem utilise Documents dir.
    limitsNavigationsToAppBoundDomains: true,
  },

  android: {
    // Nécessaire pour WebUSB (transfert par câble) et pour les plugins natifs
    // d'autofill à venir.
    allowMixedContent: false,
    captureInput: true,
    // Débogage de la WebView (chrome://inspect) : JAMAIS en release (audit E4).
    // Pour un build de debug : PASSORY_DEBUG=1 npm run cap:sync
    webContentsDebuggingEnabled: process.env.PASSORY_DEBUG === '1',
  },
};

export default config;
