'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassoryItemSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function normalize(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Retourne un score de correspondance (0 = pas de match, plus haut = meilleur).
  function scoreEntry(entry, terms) {
    const p = entry.payload || {};
    const fields = [
      { value: normalize(p.label    || ''), weight: 3 },
      { value: normalize(p.username || ''), weight: 2 },
      { value: normalize(p.url      || ''), weight: 2 },
      { value: normalize(p.notes   || ''), weight: 1 },
      // Champs génériques pour les autres types (carte, IBAN, identité…)
      { value: normalize(p.name     || ''), weight: 2 },
      { value: normalize(p.holder   || ''), weight: 2 },
      { value: normalize(p.iban     || ''), weight: 1 },
      { value: normalize(entry.type || ''), weight: 1 },
    ];

    let score = 0;
    for (const term of terms) {
      let termMatched = false;
      for (const field of fields) {
        if (!field.value) continue;
        const idx = field.value.indexOf(term);
        if (idx === -1) continue;
        termMatched = true;
        // Bonus si le match est en début de champ ou début de mot
        const bonus = idx === 0 ? 2 : (field.value[idx - 1] === ' ' ? 1.5 : 1);
        score += field.weight * bonus;
      }
      // Si un terme n'est dans aucun champ, l'entrée est exclue
      if (!termMatched) return 0;
    }
    return score;
  }

  /**
   * Recherche full-text dans des entrées déchiffrées.
   * @param {Array}  entries  Tableau d'entrées déchiffrées { id, type, payload, ... }
   * @param {string} query    Requête utilisateur (mots séparés par espaces)
   * @param {object} [opts]
   * @param {string} [opts.type]   Filtre sur le type (password, card, iban…)
   * @param {number} [opts.limit]  Nombre max de résultats (défaut: 50)
   * @returns {Array} Entrées triées par pertinence décroissante
   */
  function search(entries, query, opts = {}) {
    const { type, limit = 50 } = opts;
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      const filtered = type ? entries.filter(e => e.type === type) : entries;
      return filtered.slice(0, limit);
    }

    const results = [];
    for (const entry of entries) {
      if (entry.corrupt || !entry.payload) continue;
      if (type && entry.type !== type) continue;
      const score = scoreEntry(entry, terms);
      if (score > 0) results.push({ ...entry, _score: score });
    }

    results.sort((a, b) => b._score - a._score);
    return results.slice(0, limit).map(({ _score, ...e }) => e);
  }

  return { search, normalize };
});
