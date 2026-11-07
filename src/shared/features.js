/**
 * features.js — interrupteurs des fonctions de Passory (UMD).
 *
 * Point UNIQUE de vérité, lu par :
 *   - main.js (process principal Electron) : enregistrement des canaux IPC,
 *     arguments passés au preload, garde de navigation ;
 *   - les pages (balise <script src="src/shared/features.js">, avant
 *     common.js) : menu latéral et redirection des pages désactivées.
 *
 * transfer — transfert direct entre appareils (protocole PCTP,
 *   src/shared/transfer/). DÉSACTIVÉ en v1.0 : le bureau ne sait se
 *   connecter qu'à 127.0.0.1 et le mobile n'a pas d'équivalent, donc la
 *   fonction ne marche pas pour le public. Le code du protocole et ses tests
 *   unitaires sont conservés pour la v1.1.
 *   Quand il vaut false :
 *     · aucun accès dans l'interface (menu, accueil, aide) ;
 *     · transfer.html renvoie à l'accueil ;
 *     · les canaux IPC pctp:* refusent toute demande (aucun serveur TCP,
 *       aucun module réseau chargé) et le preload n'expose pas
 *       window.passory.transfer.
 *   Pour le réactiver (v1.1) : passer à true, remettre les tests e2e de
 *   l'écran de transfert, rendre la connexion possible hors 127.0.0.1.
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryFeatures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return Object.freeze({
    transfer: false,
  });
});
