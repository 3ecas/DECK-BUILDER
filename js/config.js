// ============================================================================
//  GAME CONFIG — tuning knobs. The CARDS themselves live in cards.csv, which
//  the game fetches at startup. To add or change a card, just edit that
//  spreadsheet and reload the page. You never touch this file for card stats.
// ============================================================================
//
//  cards.csv columns:
//
//     id, name, emoji, mana, hp, color, rarity, modifiers, starter
//
//  id        unique, lowercase_with_underscores. Never reuse or rename an id
//            that players already own — their saved decks reference it.
//  name      what's printed on the card.
//  emoji     the character on the card and on the field token.
//  mana      deploy cost 1-10. Shown in the orb on the card's top-left.
//  hp        health AND fighting power. Two units meet -> lower hp dies, the
//            winner keeps the difference. Equal hp = both die. No attack stat.
//  color     red | green | blue | yellow | grey. Card tint; only matters for
//            bonus_vs modifiers.
//  rarity    normal | rare | special | ultimate. Drives the shop roulette odds.
//  modifiers optional, blank for a plain card. See below.
//  starter   put "yes" to give the player this card before any packs. You need
//            at least 10 starters or a legal deck can't be built.
//
//  There is no speed column — every unit moves at unitSpeed below.
//
//  ---- MODIFIERS ----
//  `keyword arg arg`, separated by `;` for as many as you like. They stack:
//
//     swarm 3                     deploy 3 copies at once
//     bonus_vs red 3              +3 power while clashing against a red unit
//     flame_trail 1 [D]           on deploy, burn every enemy ahead in the lane
//                                 for 1 (within D, or the whole lane)
//     aura_ahead 2 20             friendlies up to 20 ahead get +2 power
//     aura_weaken 1 15            enemies up to 15 ahead get -1 power
//
//     flame_trail 2; aura_ahead 1 15      <- combine freely
//
//  Every keyword is implemented ONCE in js/effects.js and reused by any number
//  of cards, so a new card that uses existing keywords needs no code at all.
//  Distances are in track units (the lane is 100 long).
//
//  You can invent any other keyword and write it in the column now — the game
//  still loads and prints a console note naming any it doesn't know yet, so
//  nothing fails silently. Tell me the keyword and what it should do and I'll
//  add it to js/effects.js.
// ============================================================================

window.RTS_CONFIG = {
  // Where the card catalogue lives. Can be a relative path or any URL that
  // allows cross-origin reads (e.g. a published Google Sheet CSV link).
  cardsUrl: 'cards.csv',

  unitSpeed: 3.2, // track units/sec. This is the 100% baseline speed; modifiers scale off it.
  startingMana: 3, // mana both sides begin each round with
  currencyPerWin: 50, // coins earned per round won
  spinCost: 100, // coins per roulette spin

  // Roulette odds in percent — should total 100. A tier with no cards defined
  // falls back to the next tier down, so empty tiers are safe.
  odds: {
    normal: 70,
    rare: 20,
    special: 8,
    ultimate: 2,
  },
};
