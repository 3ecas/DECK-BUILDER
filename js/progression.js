// Difficulty / rounds system.
//
// A "run" is a climb: level 1, 2, 3, ... Losing resets you to level 1 (your
// collection and coins persist). Levels are grouped into WORLDs of 10; every
// 10th level is a BOSS.
//
// Difficulty is a FORMULA driven by the level number — which rarities the enemy
// may field, how fast it gains mana, how hard-hitting its units are, how
// aggressively it plays — with optional CSV OVERRIDES for hand-authored bosses
// (see bosses.csv). This is what makes it fair: a level-1 enemy can only field
// cheap normal cards, and the ceiling rises as you climb.
(function (global) {
  const Units = global.RTS.Units;
  const WORLD_SIZE = 10;

  // level -> { name, emoji, deck[], wallHp, manaRate, startMana, statMult }
  const bosses = {};

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /* ---------------- boss CSV (optional overrides) ---------------- */

  // Columns: level, name, emoji, deck, wall_hp, mana_rate, start_mana, stat_mult
  // `deck` is a space-separated list of card ids. Missing numeric cells fall
  // back to the formula, so you only fill in what you want to override.
  function loadBosses(csvText) {
    Object.keys(bosses).forEach((k) => delete bosses[k]);
    const problems = [];
    if (!csvText || !csvText.trim()) return { ok: true, problems };

    const rows = Units.parseCsv(csvText);
    let start = 0;
    if (rows.length && String(rows[0][0]).toLowerCase() === 'level') start = 1;

    for (let i = start; i < rows.length; i++) {
      const cols = rows[i];
      if (cols.length < 4) {
        problems.push(`boss row needs at least level,name,emoji,deck: "${cols.join(',')}"`);
        continue;
      }
      const level = Number(cols[0]);
      if (!Number.isFinite(level)) {
        problems.push(`bad boss level "${cols[0]}"`);
        continue;
      }
      const deckIds = String(cols[3] || '')
        .split(/\s+/)
        .filter(Boolean);
      deckIds.forEach((id) => {
        if (!Units.get(id)) problems.push(`boss level ${level} references unknown card "${id}"`);
      });
      const num = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
      bosses[level] = {
        name: cols[1] || `World ${Math.ceil(level / WORLD_SIZE)} Boss`,
        emoji: cols[2] || '👑',
        deck: deckIds.filter((id) => Units.get(id)),
        wallHp: num(cols[4]),
        manaRate: num(cols[5]),
        startMana: num(cols[6]),
        statMult: num(cols[7]),
      };
    }
    if (problems.length) {
      console.warn(`[bosses] ${problems.length} note(s) from bosses.csv:\n - ${problems.join('\n - ')}`);
    }
    return { ok: true, problems };
  }

  /* ---------------- the formula ---------------- */

  function allowedRarities(level) {
    const r = ['normal'];
    if (level >= 4) r.push('rare');
    if (level >= 9) r.push('special');
    if (level >= 16) r.push('ultimate');
    return r;
  }

  // Weighted so cheaper cards show up more often — a natural mana curve, and it
  // guarantees the AI always has something affordable early in a match.
  function weightedDeck(pool, size) {
    if (!pool.length) return [];
    const bag = [];
    pool.forEach((id) => {
      const mana = Units.get(id).mana || 1;
      const w = clamp(Math.round(7 / mana), 1, 7); // 1-mana ≈7, 7-mana ≈1
      for (let i = 0; i < w; i++) bag.push(id);
    });
    const deck = [];
    for (let i = 0; i < size; i++) deck.push(bag[Math.floor(Math.random() * bag.length)]);
    return deck;
  }

  function formulaDeck(level, size) {
    const rar = allowedRarities(level);
    // secondary cap so early levels can't field the very biggest cards even
    // within an allowed rarity
    const maxMana = Math.min(10, 4 + Math.floor(level / 2));
    let pool = Units.ALL_IDS.filter((id) => {
      const c = Units.get(id);
      return rar.includes(c.rarity) && c.mana <= maxMana;
    });
    if (!pool.length) pool = Units.ALL_IDS.filter((id) => Units.get(id).rarity === 'normal');
    if (!pool.length) pool = Units.ALL_IDS.slice();
    return weightedDeck(pool, size);
  }

  function padDeck(deck, size) {
    if (!deck.length) return [];
    const out = deck.slice();
    let i = 0;
    while (out.length < size) out.push(deck[i++ % deck.length]);
    return out;
  }

  // Cheap lookup for the UI: level -> {world,isBoss,name,emoji}, no deck rolled.
  function meta(level) {
    const world = Math.floor((level - 1) / WORLD_SIZE) + 1;
    const isBoss = level % WORLD_SIZE === 0;
    const b = isBoss ? bosses[level] : null;
    return {
      level,
      world,
      isBoss,
      name: b ? b.name : isBoss ? `World ${world} Boss` : `Level ${level}`,
      emoji: b ? b.emoji : isBoss ? '👑' : '⚔️',
    };
  }

  // Full enemy config for a level. baseWall = the normal wall hp (Arena.STRUCTURE_HP).
  function configFor(level, deckSize, baseWall) {
    const size = deckSize || 10;
    const m = meta(level);
    const manaRate = clamp(0.7 + 0.03 * level, 0.7, 1.6);
    const startBase = (global.RTS_CONFIG && global.RTS_CONFIG.startingMana) || 3;
    const startMana = Math.min(10, startBase + Math.floor(level / 6));
    const statMult = 1 + Math.max(0, level - 10) * 0.03;
    const cadenceMin = Math.max(0.6, 1.7 - level * 0.04);
    const cadenceMax = Math.max(1.2, 3.2 - level * 0.06);

    if (m.isBoss) {
      const b = bosses[level];
      // formula boss deck: top allowed rarities (bosses skew rare+), full mana
      const genDeck = () => {
        const rar = allowedRarities(Math.max(level, 16));
        const pool = Units.ALL_IDS.filter((id) => rar.includes(Units.get(id).rarity));
        return weightedDeck(pool.length ? pool : Units.ALL_IDS.slice(), size);
      };
      return {
        level,
        world: m.world,
        isBoss: true,
        name: m.name,
        emoji: m.emoji,
        deck: b && b.deck.length ? padDeck(b.deck, size) : genDeck(),
        manaRate: b && b.manaRate ? b.manaRate : Math.min(1.7, manaRate + 0.2),
        startMana: b && b.startMana != null ? b.startMana : Math.min(10, startMana + 2),
        statMult: b && b.statMult ? b.statMult : Math.max(statMult, 1 + m.world * 0.05),
        wallHp: b && b.wallHp ? b.wallHp : Math.round(baseWall * (1.4 + m.world * 0.15)),
        cadenceMin,
        cadenceMax,
      };
    }

    return {
      level,
      world: m.world,
      isBoss: false,
      name: m.name,
      emoji: m.emoji,
      deck: formulaDeck(level, size),
      manaRate,
      startMana,
      statMult,
      wallHp: baseWall,
      cadenceMin,
      cadenceMax,
    };
  }

  global.RTS = global.RTS || {};
  global.RTS.Progression = { WORLD_SIZE, loadBosses, configFor, meta, allowedRarities };
})(window);
