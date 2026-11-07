'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryPasswordHistory = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const MAX_HISTORY = 10;
  const HISTORY_KEY = '_pwHistory';

  /**
   * Retourne l'historique des mots de passe d'un payload.
   * @returns {Array<{password: string, savedAt: number}>}
   */
  function getHistory(payload) {
    if (!payload || !Array.isArray(payload[HISTORY_KEY])) return [];
    return payload[HISTORY_KEY];
  }

  /**
   * Ajoute le mot de passe actuel dans l'historique avant qu'il soit remplacé.
   * Limite à MAX_HISTORY entrées (FIFO). Ne modifie pas le payload original.
   * @param {object} payload    Payload déchiffré de l'item
   * @param {string} currentPassword  Mot de passe à archiver (l'ancien, avant modification)
   * @returns {object} Nouveau payload avec historique mis à jour
   */
  function pushToHistory(payload, currentPassword) {
    if (typeof currentPassword !== 'string' || !currentPassword) return payload;
    const history = getHistory(payload).slice();
    // Ne pas dupliquer si le même mot de passe est déjà en tête
    if (history.length > 0 && history[history.length - 1].password === currentPassword) {
      return payload;
    }
    history.push({ password: currentPassword, savedAt: Date.now() });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    return { ...payload, [HISTORY_KEY]: history };
  }

  /**
   * Vérifie si un mot de passe proposé figure déjà dans l'historique.
   * Utile pour alerter l'utilisateur lors d'un changement de mot de passe.
   */
  function isInHistory(payload, password) {
    return getHistory(payload).some(h => h.password === password);
  }

  /**
   * Supprime l'historique du payload (ex. après un wipe ou à la demande).
   */
  function clearHistory(payload) {
    const next = { ...payload };
    delete next[HISTORY_KEY];
    return next;
  }

  return { getHistory, pushToHistory, isInHistory, clearHistory, MAX_HISTORY };
});
