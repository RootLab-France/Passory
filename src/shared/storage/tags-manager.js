'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryTagsManager = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const TAGS_KEY = '_tags';

  function normTag(tag) {
    return String(tag || '').trim().toLowerCase().slice(0, 32);
  }

  /** Retourne les tags d'un payload (tableau de strings). */
  function getTags(payload) {
    if (!payload || !Array.isArray(payload[TAGS_KEY])) return [];
    return payload[TAGS_KEY];
  }

  /** Ajoute un tag au payload. Ne duplique pas. */
  function addTag(payload, tag) {
    const t = normTag(tag);
    if (!t) return payload;
    const current = getTags(payload);
    if (current.includes(t)) return payload;
    return { ...payload, [TAGS_KEY]: [...current, t] };
  }

  /** Supprime un tag du payload. */
  function removeTag(payload, tag) {
    const t = normTag(tag);
    const current = getTags(payload);
    return { ...payload, [TAGS_KEY]: current.filter(x => x !== t) };
  }

  /** Remplace tous les tags d'un payload. */
  function setTags(payload, tags) {
    const normalized = [...new Set((tags || []).map(normTag).filter(Boolean))];
    return { ...payload, [TAGS_KEY]: normalized };
  }

  /**
   * Extrait tous les tags uniques utilisés dans un ensemble d'entrées déchiffrées.
   * @param {Array} entries  Entrées avec payload déchiffré
   * @returns {string[]} Tags triés alphabétiquement
   */
  function getAllTags(entries) {
    const set = new Set();
    for (const e of entries) {
      for (const t of getTags(e.payload)) set.add(t);
    }
    return [...set].sort();
  }

  /**
   * Filtre les entrées dont le payload contient le tag donné.
   */
  function filterByTag(entries, tag) {
    const t = normTag(tag);
    return entries.filter(e => getTags(e.payload).includes(t));
  }

  return { getTags, addTag, removeTag, setTags, getAllTags, filterByTag };
});
