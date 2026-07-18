// Persistent meta: cards owned, the decks you've built, and your coins.
// Saved to localStorage so it survives across sessions.
(function (global) {
  const Units = global.RTS.Units;
  const CFG = global.RTS_CONFIG;

  const SAVE_KEY = 'hell-tower-save-v2';
  const DECK_SIZE = 10;
  const PACK_SIZE = 5;

  // Populated by init(), which must run AFTER the card catalogue has loaded —
  // the save is validated against the card list, so it can't be read earlier.
  let data = { owned: {}, decks: [{ name: 'Deck 1', cards: [] }], activeDeck: 0, currency: 0, seen: [] };

  function init() {
    data = load();
    global.RTS.Collection.data = data;
    return data;
  }

  function starterOwned() {
    const owned = {};
    Units.STARTER_COLLECTION.forEach((id) => {
      owned[id] = (owned[id] || 0) + 1;
    });
    return owned;
  }

  function load() {
    let parsed = null;
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      parsed = raw ? JSON.parse(raw) : null;
    } catch (e) {
      parsed = null; // corrupt or storage disabled — start fresh
    }

    const owned = (parsed && parsed.owned) || starterOwned();
    // Drop ids that no longer exist in the card table (they get renamed while
    // the game is in flux) so a stale save can't break a deck.
    Object.keys(owned).forEach((id) => {
      if (!Units.get(id)) delete owned[id];
    });

    let decks = (parsed && parsed.decks) || null;
    if (!Array.isArray(decks) || !decks.length) {
      decks = [{ name: 'Deck 1', cards: [] }];
    }
    decks.forEach((d) => {
      d.cards = (d.cards || []).filter((id) => Units.get(id));
    });

    return {
      owned,
      decks,
      activeDeck: Math.min((parsed && parsed.activeDeck) || 0, decks.length - 1),
      currency: (parsed && typeof parsed.currency === 'number') ? parsed.currency : 0,
      seen: (parsed && parsed.seen) || Object.keys(owned), // ids ever discovered
      runLevel: (parsed && parsed.runLevel > 0) ? parsed.runLevel : 1, // current climb level
    };
  }

  /* ---------------- run / climb ---------------- */

  function getLevel() {
    return data.runLevel || 1;
  }

  function advanceLevel() {
    data.runLevel = (data.runLevel || 1) + 1;
    save();
    return data.runLevel;
  }

  function resetRun() {
    data.runLevel = 1;
    save();
  }

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (e) {
      // storage unavailable (private mode) — just won't persist
    }
  }

  /* ---------------- collection ---------------- */

  function ownedCount(id) {
    return data.owned[id] || 0;
  }

  function ownedIds() {
    return Object.keys(data.owned).filter((id) => data.owned[id] > 0);
  }

  function collectionSize() {
    return ownedIds().reduce((n, id) => n + data.owned[id], 0);
  }

  function hasSeen(id) {
    return data.seen.indexOf(id) >= 0;
  }

  function grant(id) {
    data.owned[id] = ownedCount(id) + 1;
    if (!hasSeen(id)) data.seen.push(id);
  }

  /* ---------------- decks ---------------- */

  function activeDeck() {
    return data.decks[data.activeDeck] || data.decks[0];
  }

  function deckCount(deck, id) {
    return deck.cards.filter((x) => x === id).length;
  }

  function deckIsLegal(deck) {
    return deck.cards.length === DECK_SIZE;
  }

  // You can only run as many copies of a card as you actually own.
  function canAddToDeck(deck, id) {
    return deck.cards.length < DECK_SIZE && deckCount(deck, id) < ownedCount(id);
  }

  function addToDeck(deck, id) {
    if (!canAddToDeck(deck, id)) return false;
    deck.cards.push(id);
    save();
    return true;
  }

  function removeFromDeck(deck, id) {
    const i = deck.cards.lastIndexOf(id);
    if (i < 0) return false;
    deck.cards.splice(i, 1);
    save();
    return true;
  }

  function clearDeck(deck) {
    deck.cards = [];
    save();
  }

  function autoFillDeck(deck) {
    ownedIds().forEach((id) => {
      while (canAddToDeck(deck, id)) deck.cards.push(id);
    });
    save();
    return deck.cards.slice();
  }

  function newDeck() {
    data.decks.push({ name: `Deck ${data.decks.length + 1}`, cards: [] });
    data.activeDeck = data.decks.length - 1;
    save();
    return activeDeck();
  }

  function deleteDeck(index) {
    if (data.decks.length <= 1) return false; // always keep one
    data.decks.splice(index, 1);
    data.activeDeck = Math.min(data.activeDeck, data.decks.length - 1);
    save();
    return true;
  }

  function selectDeck(index) {
    if (index < 0 || index >= data.decks.length) return;
    data.activeDeck = index;
    save();
  }

  // The deck the arena actually deals. Auto-fills if it isn't legal so the
  // player can always Engage.
  function getDeck() {
    const d = activeDeck();
    if (!deckIsLegal(d)) autoFillDeck(d);
    return d.cards.slice();
  }

  // Deck strip ordering: weakest (lowest hp) on the left.
  function deckSorted(deck) {
    return deck.cards.slice().sort(Units.byHp);
  }

  /* ---------------- currency & roulette ---------------- */

  function addCurrency(n) {
    data.currency += n;
    save();
  }

  function canSpin() {
    return data.currency >= CFG.spinCost;
  }

  // Pick a rarity by the configured odds, then a random card of that rarity.
  // Falls back to the next rarity down if a tier has no cards defined yet.
  function rollRarity() {
    const odds = CFG.odds;
    const total = Object.values(odds).reduce((a, b) => a + b, 0) || 1;
    let r = Math.random() * total;
    const order = ['ultimate', 'special', 'rare', 'normal'];
    for (const tier of order) {
      r -= odds[tier] || 0;
      if (r <= 0) return tier;
    }
    return 'normal';
  }

  function pickCardOfRarity(rarity) {
    const order = ['ultimate', 'special', 'rare', 'normal'];
    let i = order.indexOf(rarity);
    while (i < order.length) {
      const pool = Units.idsByRarity(order[i]);
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
      i += 1; // that tier is empty — drop to the next one down
    }
    return Units.ALL_IDS[0];
  }

  function spin() {
    if (!canSpin()) return null;
    data.currency -= CFG.spinCost;
    const rarity = rollRarity();
    const id = pickCardOfRarity(rarity);
    const isNew = ownedCount(id) === 0;
    grant(id);
    save();
    return { id, rarity, isNew };
  }

  function openPack() {
    const got = [];
    for (let i = 0; i < PACK_SIZE; i++) {
      const id = pickCardOfRarity(rollRarity());
      got.push({ id, isNew: ownedCount(id) === 0, rarity: Units.get(id).rarity });
      grant(id);
    }
    save();
    return got;
  }

  function resetAll() {
    data.owned = starterOwned();
    data.decks = [{ name: 'Deck 1', cards: [] }];
    data.activeDeck = 0;
    data.currency = 0;
    data.seen = Object.keys(data.owned);
    data.runLevel = 1;
    save();
  }

  global.RTS = global.RTS || {};
  global.RTS.Collection = {
    data,
    init,
    DECK_SIZE,
    PACK_SIZE,
    ownedCount,
    ownedIds,
    collectionSize,
    hasSeen,
    activeDeck,
    deckCount,
    deckIsLegal,
    canAddToDeck,
    addToDeck,
    removeFromDeck,
    clearDeck,
    autoFillDeck,
    newDeck,
    deleteDeck,
    selectDeck,
    getDeck,
    deckSorted,
    getLevel,
    advanceLevel,
    resetRun,
    addCurrency,
    canSpin,
    spin,
    openPack,
    resetAll,
    save,
  };
})(window);
