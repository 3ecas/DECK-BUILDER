// Auto-battler state + logic.
//
// Loop: PREP (buy units, drag them onto your side of the hex board) -> BATTLE
// (units seek the nearest enemy, walk the hexes and fight automatically) ->
// RESULT (win/lose banner) -> back to PREP.
//
// Key rules:
//   * Your LEVEL is the number of units you may have on the board (lvl 1 = 1).
//     Levelling is purely by rounds survived: 1 round to reach lvl 2, then 2
//     more for lvl 3, 3 more for lvl 4, and so on. There is no XP to buy.
//   * 3 copies of the same unit at the same star merge into one a star higher,
//     with double hp and damage.
//   * Units only move during a battle. Where you place them in PREP is their
//     HOME, and every unit (even the dead) returns there when the round ends.
(function (global) {
  const U = global.ABUnits;

  const CONFIG = {
    cols: 9,
    rows: 8, // 4 rows per side, fewer/bigger hexes
    deployRows: 4,
    benchSlots: 9,
    shopSlots: 5,
    maxTier: 5,
    tierUnlockRound: { 5: 7 }, // tier 5 can't appear before enemy-round 7
    minionRounds: 3, // warm-up rounds vs weak minions (2, then 3, then 4 of them)
    maxStar: 3,
    maxLevel: 10,
    startGold: 2,
    rerollCost: 2,
    baseIncome: 5,
    winStreakBonus: 1,
    playerMaxHp: 500, // each player's life total
    roundLossHp: 8, // life lost by whoever loses a round
    projectileSpeed: 9, // hexes per second an arrow/bolt travels
    lungeTime: 0.28, // how long the attack lunge animation lasts
    battleTimeout: 60, // safety net: melee units can block each other into a
    // stalemate, and there is no manual "next round" button to escape it
  };

  // Shop odds by player LEVEL: chance (%) of each tier 1..5. Rows sum to 100.
  // Level 1 only ever rolls tier 1; the spread stays roughly even through the
  // mid levels, and from level 9 on the high tiers outweigh the low ones.
  // Tier 5 also can't appear before enemy-round 7 (see CONFIG.tierUnlockRound).
  const ODDS = {
    1: [100, 0, 0, 0, 0],
    2: [75, 25, 0, 0, 0],
    3: [55, 30, 15, 0, 0],
    4: [45, 30, 20, 5, 0],
    5: [35, 30, 22, 10, 3],
    6: [25, 28, 25, 15, 7],
    7: [18, 24, 26, 20, 12],
    8: [12, 18, 25, 25, 20],
    9: [8, 13, 22, 28, 29],
  };

  // The odds row in force for a given player level.
  function oddsForLevel(level) {
    const keys = Object.keys(ODDS)
      .map(Number)
      .sort((a, b) => a - b);
    let row = ODDS[keys[0]];
    keys.forEach((k) => {
      if (level >= k) row = ODDS[k];
    });
    return row;
  }

  // Rounds 1..minionRounds are the warm-up; enemyRound() is the "real" round
  // number shown to the player and used for tier unlocks (0 while warming up).
  const enemyRound = () => Math.max(0, state.round - CONFIG.minionRounds);

  let uidSeq = 0;

  const state = {
    phase: 'prep', // 'prep' | 'battle' | 'result'
    round: 1,
    gold: CONFIG.startGold,
    level: 1,
    roundsAtLevel: 0, // rounds completed since the last level-up
    streak: 0,
    shopLocked: false, // when true, the shop keeps its contents into next round
    shop: [],
    enemyGold: 0, // the AI opponent runs its own economy...
    enemyRoster: [], // ...and keeps its picks round to round: [{id, star, col, row}]
    playerHp: 100,
    enemyHp: 100,
    gameOver: null, // 'win' | 'lose' once someone's life hits 0
    bench: [],
    units: [], // board units, both teams. Dead PLAYER units stay (hp 0) so they
    // can be revived at their home cell next round; dead enemies are removed.
    result: null,
    log: [],
    hits: [], // transient {col,row,amount,targetUid} popups drained by the UI
    projectiles: [], // arrows in flight: {targetUid, dmg, t} — damage on arrival
  };

  function log(msg) {
    state.log.push(msg);
    if (state.log.length > 40) state.log.shift();
  }

  /* ---------------- stats ---------------- */

  // Warm-up round cannon fodder — not in units.csv so it can never show up in
  // the shop, get bought, or merge.
  const MINION = {
    id: 'minion',
    name: 'Minion',
    emoji: '👾',
    tier: 1,
    cost: 0,
    hp: 15,
    dmg: 10,
    range: 1,
    atkSpeed: 0.5,
    moveSpeed: 2.5,
    color: 'grey',
    shield: 0,
    ability: null,
    slots: 1,
  };

  function statsOf(id, star) {
    const u = id === MINION.id ? MINION : U.get(id);
    if (!u) return null;
    const s = Math.max(1, Math.min(CONFIG.maxStar, star || 1));
    const mult = Math.pow(2, s - 1); // ★2 doubles, ★3 doubles again
    return {
      id,
      name: u.name,
      emoji: u.emoji,
      color: u.color,
      tier: u.tier,
      cost: u.cost,
      star: s,
      maxHp: Math.round(u.hp * mult),
      dmg: Math.round(u.dmg * mult),
      // shield stays flat across stars — scaling it would let a 3-star tank
      // shrug off almost everything and stall fights out
      shield: u.shield || 0,
      range: u.range,
      atkSpeed: u.atkSpeed || 0.5, // attacks per second
      moveSpeed: u.moveSpeed,
      ability: u.ability || null,
      slots: u.slots || 1,
    };
  }

  // How many rounds are still needed before the next level-up.
  const roundsToNextLevel = () =>
    state.level >= CONFIG.maxLevel ? 0 : state.level - state.roundsAtLevel;

  // Board usage counts SLOTS, not bodies — a Titan takes 2 of your allowance.
  const boardCount = () =>
    state.units.filter((u) => u.team === 'player').reduce((n, u) => n + (u.slots || 1), 0);
  // During the warm-up rounds you may field one unit per round (M1=1, M2=2,
  // M3=3) even though levels haven't caught up yet; after that it's level.
  const maxBoardUnits = () =>
    state.round <= CONFIG.minionRounds ? Math.max(state.level, state.round) : state.level;
  const boardFull = () => boardCount() >= maxBoardUnits();

  /* ---------------- shop ---------------- */

  const poolForTier = (tier) => U.ALL_IDS.filter((id) => U.get(id).tier === tier);

  // Is this tier allowed to show up yet? (tier 5 is locked until enemy-round 7)
  function tierUnlocked(tier) {
    const need = CONFIG.tierUnlockRound[tier];
    return !need || enemyRound() >= need;
  }

  function rollTier(level) {
    const row = oddsForLevel(level);
    let r = Math.random() * 100;
    for (let i = 0; i < row.length; i++) {
      r -= row[i];
      if (r <= 0) return i + 1;
    }
    return 1;
  }

  // Roll a tier, then a unit of it. A tier that is locked, or simply has no
  // units defined, steps down instead of yielding an empty shop slot.
  function rollUnit(level) {
    let tier = rollTier(level || state.level);
    while (tier >= 1) {
      if (tierUnlocked(tier)) {
        const pool = poolForTier(tier);
        if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
      }
      tier -= 1;
    }
    return U.ALL_IDS[Math.floor(Math.random() * U.ALL_IDS.length)];
  }

  function rollShop() {
    state.shop = Array.from({ length: CONFIG.shopSlots }, () => rollUnit(state.level));
  }

  function reroll() {
    if (state.phase !== 'prep' && state.phase !== 'battle') return false;
    if (state.gold < CONFIG.rerollCost) return false;
    state.gold -= CONFIG.rerollCost;
    rollShop();
    return true;
  }

  function toggleShopLock() {
    state.shopLocked = !state.shopLocked;
    return state.shopLocked;
  }

  function firstFreeBench() {
    for (let i = 0; i < CONFIG.benchSlots; i++) if (!state.bench[i]) return i;
    return -1;
  }

  // Buy a shop unit onto the bench — into the slot it was dropped on if given
  // and free, otherwise the first free one. Allowed during prep AND battle —
  // you can shop while a fight plays out, the unit just waits on the bench
  // until the next prep phase since board positions are locked mid-fight.
  // Copies of a unit the player owns at a given star (bench + board).
  function countCopies(id, star) {
    let n = 0;
    state.bench.forEach((b) => {
      if (b && b.id === id && b.star === star) n += 1;
    });
    state.units.forEach((u) => {
      if (u.team === 'player' && u.id === id && u.star === star) n += 1;
    });
    return n;
  }

  function buy(shopIndex, slot) {
    if (state.phase !== 'prep' && state.phase !== 'battle') return false;
    const id = state.shop[shopIndex];
    if (!id) return false;
    const s = statsOf(id, 1);
    if (!s || state.gold < s.cost) return false;
    const target = slot != null && slot >= 0 && slot < CONFIG.benchSlots && !state.bench[slot]
      ? slot
      : firstFreeBench();
    if (target < 0) {
      // Bench is full — the buy is still allowed when this copy completes a
      // 3-of-a-kind: it goes into a temporary overflow spot that the merge
      // consumes immediately, evolving the copies on bench/board.
      if (state.phase !== 'prep' || countCopies(id, 1) < 2) return false;
      state.gold -= s.cost;
      uidSeq += 1;
      state.bench.push({ uid: uidSeq, id, star: 1 });
      state.shop[shopIndex] = null;
      checkMerges();
      state.bench.length = CONFIG.benchSlots; // drop the (now empty) overflow
      return true;
    }
    state.gold -= s.cost;
    uidSeq += 1;
    state.bench[target] = { uid: uidSeq, id, star: 1 };
    state.shop[shopIndex] = null;
    checkMerges();
    return true;
  }

  // Buy straight from the shop onto a board cell (drag & drop).
  function buyToBoard(shopIndex, col, row) {
    if (state.phase !== 'prep') return false;
    const id = state.shop[shopIndex];
    if (!id) return false;
    if (!inBounds(col, row) || !isPlayerZone(row) || unitAt(col, row)) return false;
    const s = statsOf(id, 1);
    if (!s || state.gold < s.cost) return false;
    if (boardCount() + s.slots > maxBoardUnits()) return false;
    state.gold -= s.cost;
    state.units.push(makeUnit(id, 'player', col, row, 1));
    state.shop[shopIndex] = null;
    checkMerges();
    return true;
  }

  function sell(uid) {
    if (state.phase !== 'prep' && state.phase !== 'battle') return false;
    const bi = state.bench.findIndex((b) => b && b.uid === uid);
    if (bi >= 0) {
      const b = state.bench[bi];
      state.gold += statsOf(b.id, 1).cost * Math.pow(3, b.star - 1);
      state.bench[bi] = null;
      return true;
    }
    // units on the board can only be sold during prep — they're fighting
    if (state.phase !== 'prep') return false;
    const u = state.units.find((x) => x.uid === uid && x.team === 'player');
    if (u) {
      state.gold += statsOf(u.id, 1).cost * Math.pow(3, u.star - 1);
      state.units = state.units.filter((x) => x !== u);
      return true;
    }
    return false;
  }

  /* ---------------- merging (3 of a kind -> next star) ---------------- */

  function checkMerges() {
    // Evolutions never happen mid-battle. A third copy bought while fighting
    // waits on the bench; nextRound() re-runs this the moment prep begins.
    if (state.phase !== 'prep') return;
    let merged = true;
    while (merged) {
      merged = false;
      for (let star = 1; star < CONFIG.maxStar && !merged; star++) {
        const groups = {};
        state.bench.forEach((b, i) => {
          if (b && b.star === star) (groups[b.id] = groups[b.id] || []).push({ where: 'bench', i, uid: b.uid });
        });
        state.units.forEach((u) => {
          if (u.team === 'player' && u.star === star) {
            (groups[u.id] = groups[u.id] || []).push({ where: 'board', uid: u.uid, col: u.col, row: u.row });
          }
        });
        for (const id of Object.keys(groups)) {
          const list = groups[id];
          if (list.length < 3) continue;
          const three = list.slice(0, 3);
          // the upgrade inherits a board cell if any of the three was deployed,
          // so merging never silently pulls a unit out of your formation
          const onBoard = three.find((x) => x.where === 'board');
          three.forEach((x) => {
            if (x.where === 'bench') state.bench[x.i] = null;
            else state.units = state.units.filter((u) => u.uid !== x.uid);
          });
          if (onBoard) {
            state.units.push(makeUnit(id, 'player', onBoard.col, onBoard.row, star + 1));
          } else {
            const slot = firstFreeBench();
            uidSeq += 1;
            if (slot >= 0) state.bench[slot] = { uid: uidSeq, id, star: star + 1 };
          }
          log(`${U.get(id).name} evolved to ${'★'.repeat(star + 1)}!`);
          merged = true;
          break;
        }
      }
    }
  }

  /* ---------------- board ---------------- */

  const inBounds = (col, row) => col >= 0 && col < CONFIG.cols && row >= 0 && row < CONFIG.rows;
  const isPlayerZone = (row) => row >= CONFIG.rows - CONFIG.deployRows;
  const isEnemyZone = (row) => row < CONFIG.deployRows;

  function unitAt(col, row) {
    return state.units.find((u) => u.col === col && u.row === row && u.hp > 0) || null;
  }

  // Board rule: a team may field only ONE copy of a unit per star level —
  // a ★1 and a ★2 Soldier can coexist, two ★2 Soldiers cannot.
  function boardHasStar(team, id, star, exceptUid) {
    return state.units.some(
      (u) => u.team === team && u.id === id && u.star === star && u.uid !== exceptUid
    );
  }

  function makeUnit(id, team, col, row, star) {
    const s = statsOf(id, star || 1);
    uidSeq += 1;
    return {
      uid: uidSeq,
      id,
      team,
      star: s.star,
      col,
      row,
      homeCol: col, // where it returns to when the round ends
      homeRow: row,
      hp: s.maxHp,
      maxHp: s.maxHp,
      dmg: s.dmg,
      shield: s.shield,
      range: s.range,
      atkInterval: 1 / s.atkSpeed, // seconds between this unit's attacks
      moveSpeed: s.moveSpeed,
      ability: s.ability,
      slots: s.slots,
      attackCount: 0, // swings this battle — drives every-N-attacks abilities
      lastEngagedUid: null, // Warlord: which foe it last opened up on
      atkTimer: 0,
      moveTimer: 0,
      targetUid: null, // locked-on foe; only cleared when the target dies
      lungeT: 0, // attack-lunge animation countdown
      lungeTo: null,
      vx: null, // drawn position; eased during battle, snapped in prep
      vy: null,
    };
  }

  function placeFromBench(uid, col, row) {
    if (state.phase !== 'prep' || !inBounds(col, row) || !isPlayerZone(row)) return false;
    const bi = state.bench.findIndex((b) => b && b.uid === uid);
    if (bi < 0) return false;
    const b = state.bench[bi];
    const bSlots = statsOf(b.id, 1).slots;
    const other = unitAt(col, row);
    if (other) {
      // dropped onto one of your own units: they switch places — the board
      // unit takes the dragged unit's bench slot
      if (other.team !== 'player') return false;
      if (boardCount() - (other.slots || 1) + bSlots > maxBoardUnits()) return false;
      state.bench[bi] = { uid: other.uid, id: other.id, star: other.star };
      state.units = state.units.filter((x) => x !== other);
      state.units.push(makeUnit(b.id, 'player', col, row, b.star));
      return true;
    }
    if (boardCount() + bSlots > maxBoardUnits()) return false;
    state.units.push(makeUnit(b.id, 'player', col, row, b.star));
    state.bench[bi] = null;
    return true;
  }

  function moveOnBoard(uid, col, row) {
    if (state.phase !== 'prep' || !inBounds(col, row) || !isPlayerZone(row)) return false;
    const u = state.units.find((x) => x.uid === uid && x.team === 'player');
    if (!u) return false;
    const other = unitAt(col, row);
    if (other === u) return true;
    if (other) {
      if (other.team !== 'player') return false;
      other.col = other.homeCol = u.col;
      other.row = other.homeRow = u.row;
    }
    u.col = u.homeCol = col;
    u.row = u.homeRow = row;
    return true;
  }

  // Pull a board unit back to the bench — into the slot it was dropped on.
  // Dropping onto an occupied slot switches the two: the benched unit takes
  // the board cell the dragged unit came from.
  function benchUnit(uid, slot) {
    if (state.phase !== 'prep') return false;
    const u = state.units.find((x) => x.uid === uid && x.team === 'player');
    if (!u) return false;
    if (slot != null && slot >= 0 && slot < CONFIG.benchSlots && state.bench[slot]) {
      const b = state.bench[slot];
      state.bench[slot] = { uid: u.uid, id: u.id, star: u.star };
      state.units = state.units.filter((x) => x !== u);
      state.units.push(makeUnit(b.id, 'player', u.col, u.row, b.star));
      return true;
    }
    const target = slot != null && slot >= 0 && slot < CONFIG.benchSlots && !state.bench[slot]
      ? slot
      : firstFreeBench();
    if (target < 0) return false;
    state.bench[target] = { uid: u.uid, id: u.id, star: u.star };
    state.units = state.units.filter((x) => x !== u);
    return true;
  }

  // Rearrange the bench freely: drop a benched unit on any slot (swaps if the
  // slot is taken).
  function moveBenchSlot(uid, toSlot) {
    if (state.phase !== 'prep' && state.phase !== 'battle') return false;
    if (toSlot == null || toSlot < 0 || toSlot >= CONFIG.benchSlots) return false;
    const from = state.bench.findIndex((b) => b && b.uid === uid);
    if (from < 0 || from === toSlot) return false;
    const tmp = state.bench[toSlot] || null;
    state.bench[toSlot] = state.bench[from];
    state.bench[from] = tmp;
    return true;
  }

  /* ---------------- enemy ---------------- */

  /* ---------------- enemy AI player ---------------- */
  // The opponent is a PC-controlled player: it earns gold, rolls the same
  // shop odds, chases 3-of-a-kind merges, and sells its weakest unit to make
  // room for a better one — its comp persists and grows across rounds.

  const rosterScore = (r) => statsOf(r.id, 1).tier + (r.star - 1) * 2.5;

  function aiMerge() {
    let merged = true;
    while (merged) {
      merged = false;
      for (let star = 1; star < CONFIG.maxStar && !merged; star++) {
        const groups = {};
        state.enemyRoster.forEach((r) => {
          if (r.star === star) (groups[r.id] = groups[r.id] || []).push(r);
        });
        for (const id of Object.keys(groups)) {
          if (groups[id].length < 3) continue;
          const three = groups[id].slice(0, 3);
          const keep = three.find((r) => r.col != null) || three[0];
          state.enemyRoster = state.enemyRoster.filter((r) => !three.includes(r));
          state.enemyRoster.push({ id, star: star + 1, col: keep.col, row: keep.row });
          merged = true;
          break;
        }
      }
    }
  }

  function aiShop() {
    state.enemyGold += CONFIG.baseIncome + Math.min(5, Math.floor(state.enemyGold / 10));

    // a handful of looks at the shop per round, like a human would get —
    // 12 rolls a round had the AI outgearing the player by the first real fight
    let rolls = 0;
    while (rolls < 4) {
      rolls += 1;
      const offer = Array.from({ length: CONFIG.shopSlots }, () => rollUnit(state.level));
      for (const id of offer) {
        const s = statsOf(id, 1);
        if (!s || state.enemyGold < s.cost) continue;
        const roster = state.enemyRoster; // aiMerge/selling replace the array

        // Priority 1: ALWAYS buy copies of units already in the comp — the AI
        // commits to its picks and develops them toward ★3.
        const chasesMerge = roster.some((r) => r.id === id && r.star < CONFIG.maxStar);
        if (chasesMerge && roster.length < state.level + CONFIG.benchSlots) {
          state.enemyGold -= s.cost;
          roster.push({ id, star: 1, col: null, row: null });
          continue;
        }
        if (chasesMerge) continue;
        // Priority 2: fill an empty comp slot with something new.
        if (roster.length < state.level) {
          state.enemyGold -= s.cost;
          roster.push({ id, star: 1, col: null, row: null });
          continue;
        }
        // Priority 3 (rare): replace a piece — but only a lone, uninvested ★1
        // with no duplicates being collected, and only for a unit at least two
        // tiers better. The comp is a project, not a fresh board every round.
        const weakest = roster.reduce((a, b) => (rosterScore(b) < rosterScore(a) ? b : a));
        const weakestCopies = roster.filter((r) => r.id === weakest.id).length;
        if (
          weakest.star === 1 &&
          weakestCopies === 1 &&
          s.tier - statsOf(weakest.id, 1).tier >= 2
        ) {
          state.enemyGold += statsOf(weakest.id, 1).cost - s.cost;
          state.enemyRoster = roster.filter((r) => r !== weakest);
          state.enemyRoster.push({ id, star: 1, col: null, row: null });
        }
      }
      aiMerge();
      // keep rerolling while there's spare gold and something left to want
      const wants = state.enemyRoster.length < state.level || state.enemyGold > 8;
      if (!wants || state.enemyGold < CONFIG.rerollCost) break;
      state.enemyGold -= CONFIG.rerollCost;
    }
  }

  // Find a free cell, trying the preferred rows first (random column order).
  function freeCell(taken, preferRows) {
    const rows = preferRows.concat(
      Array.from({ length: CONFIG.deployRows }, (_, r) => r).filter((r) => !preferRows.includes(r))
    );
    for (const row of rows) {
      const cols = Array.from({ length: CONFIG.cols }, (_, c) => c);
      for (let i = cols.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cols[i], cols[j]] = [cols[j], cols[i]];
      }
      for (const col of cols) if (!taken.has(`${col},${row}`)) return { col, row };
    }
    return null;
  }

  function buildEnemy() {
    state.units = state.units.filter((u) => u.team === 'player');

    // The enemy knows its lines: melee (range 1) wants the rows nearest the
    // player, shooters hide in the back rows behind them.
    const frontRows = [CONFIG.deployRows - 1, CONFIG.deployRows - 2];
    const backRows = [0, 1];

    // Warm-up: rounds 1..minionRounds throw 2, then 3, then 4 weak minions
    // (the AI player still shops in the background during these rounds).
    if (state.round <= CONFIG.minionRounds) {
      const taken = new Set();
      for (let i = 0; i < state.round + 1; i++) {
        const cell = freeCell(taken, frontRows);
        if (!cell) break;
        taken.add(`${cell.col},${cell.row}`);
        state.units.push(makeUnit(MINION.id, 'enemy', cell.col, cell.row, 1));
      }
      return;
    }

    // Real rounds: field the AI's persistent comp — its strongest pieces, up
    // to the same unit count the player is allowed. Spare copies it's still
    // collecting wait on its (invisible) bench. Pieces keep the cell they
    // were first placed in; only new buys get assigned a spot.
    const fielded = [];
    let slotsUsed = 0;
    state.enemyRoster
      .slice()
      .sort((a, b) => rosterScore(b) - rosterScore(a))
      .forEach((r) => {
        const need = statsOf(r.id, 1).slots;
        if (slotsUsed + need > maxBoardUnits()) return;
        slotsUsed += need;
        fielded.push(r);
      });
    const taken = new Set();
    fielded.forEach((r) => {
      if (r.col != null) taken.add(`${r.col},${r.row}`);
    });
    fielded.forEach((r) => {
      if (r.col == null) {
        const s = statsOf(r.id, 1);
        const cell = freeCell(taken, s && s.range > 1 ? backRows : frontRows);
        if (!cell) return;
        r.col = cell.col;
        r.row = cell.row;
        taken.add(`${cell.col},${cell.row}`);
      }
      // homeCol/homeRow (set in makeUnit) let the enemy squad snap back to its
      // starting formation at the end of every round, same as the player.
      state.units.push(makeUnit(r.id, 'enemy', r.col, r.row, r.star));
    });
  }

  /* ---------------- battle ---------------- */

  function startBattle() {
    if (state.phase !== 'prep') return false;
    if (!state.units.some((u) => u.team === 'player')) return false;
    // the enemy squad is already on the board (built in newGame/nextRound so
    // it's visible during prep) — just send everyone home, healed, to fight.
    state.units.forEach((u) => {
      if (u.team === 'player') {
        u.homeCol = u.col;
        u.homeRow = u.row;
      }
      u.col = u.homeCol;
      u.row = u.homeRow;
      u.hp = u.maxHp;
      // everyone starts partway through their own swing, so the opening (and
      // every later exchange) isn't one perfectly synchronised volley
      u.atkTimer = u.atkInterval * (0.4 + Math.random() * 0.6);
      u.moveTimer = 0;
      u.targetUid = null;
      u.attackCount = 0;
      u.lastEngagedUid = null;
      u.lungeT = 0;
      u.vx = null;
      u.vy = null;
    });
    state.projectiles = [];
    state.result = null;
    state.battleTime = 0;
    state.phase = 'battle';
    log(`Round ${state.round}: fight!`);
    return true;
  }

  const livingOf = (team) => state.units.filter((u) => u.team === team && u.hp > 0);

  // Shove `target` one hex away from `from` — straight back if that cell is
  // free, otherwise to a side; if it's completely boxed in, no push happens.
  function pushAway(target, from) {
    const options = Hex.neighbors(target.col, target.row).filter(
      (n) => inBounds(n.col, n.row) && !unitAt(n.col, n.row)
    );
    if (!options.length) return;
    const curD = Hex.distance(target, from);
    let best = options.filter((n) => Hex.distance(n, from) > curD); // straight back
    if (!best.length) best = options.filter((n) => Hex.distance(n, from) === curD); // sides
    if (!best.length) return;
    const cell = best[Math.floor(Math.random() * best.length)];
    target.col = cell.col;
    target.row = cell.row;
  }

  // True pathfinding (BFS over free hexes): find the SHORTEST walkable route
  // to any free cell from which the unit could hit its target, treating every
  // occupied cell — friend or foe — as a wall to go around. Returns the first
  // step of that route, or null if no attacking cell is reachable at all
  // (in which case the unit holds position and waits for an opening).
  function pathStep(u, target) {
    const key = (c, r) => `${c},${r}`;
    const occupied = new Set();
    state.units.forEach((x) => {
      if (x.hp > 0 && x !== u) occupied.add(key(x.col, x.row));
    });
    const inRange = (col, row) => Hex.distance({ col, row }, target) <= u.range;

    const start = key(u.col, u.row);
    const prev = new Map([[start, null]]);
    const queue = [{ col: u.col, row: u.row }];
    let goal = null;
    while (queue.length) {
      const cur = queue.shift();
      if (key(cur.col, cur.row) !== start && inRange(cur.col, cur.row)) {
        goal = cur;
        break;
      }
      for (const n of Hex.neighbors(cur.col, cur.row)) {
        if (!inBounds(n.col, n.row)) continue;
        const k = key(n.col, n.row);
        if (prev.has(k) || occupied.has(k)) continue;
        prev.set(k, cur);
        queue.push(n);
      }
    }
    if (!goal) return null;

    // walk the chain back until the node whose parent is the start cell —
    // that node is the unit's next step
    let node = goal;
    for (;;) {
      const p = prev.get(key(node.col, node.row));
      if (!p || key(p.col, p.row) === start) break;
      node = p;
    }
    return node;
  }

  function tick(dt) {
    if (state.phase !== 'battle') return;
    const step = Math.min(dt, 0.1);
    state.battleTime = (state.battleTime || 0) + step;

    // Act in a random order every tick. Iterating in array order meant players
    // always moved first, so the enemy got to path toward their finished
    // positions and converge on one target while the player moved blind —
    // a mirror match lost 100% of the time.
    const order = state.units.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    order.forEach((u) => {
      if (u.lungeT > 0) u.lungeT = Math.max(0, u.lungeT - step);
      if (u.hp <= 0) return;

      const foes = state.units.filter((f) => f.team !== u.team && f.hp > 0);
      if (!foes.length) return;

      // Once a unit picks a target it stays locked on until the target dies —
      // no switching to whoever wanders closer mid-fight.
      let target = u.targetUid ? foes.find((f) => f.uid === u.targetUid) : null;
      if (!target) {
        // Nearest enemy wins. Ties are broken at random — picking the first in
        // array order made every enemy pile onto the same (lowest-index) unit.
        let bestD = Infinity;
        let tied = [];
        foes.forEach((f) => {
          const d = Hex.distance(u, f);
          if (d < bestD) {
            bestD = d;
            tied = [f];
          } else if (d === bestD) {
            tied.push(f);
          }
        });
        target = tied[Math.floor(Math.random() * tied.length)];
        u.targetUid = target.uid;
      }
      const bestD = Hex.distance(u, target);

      // The attack cadence runs CONTINUOUSLY, even while walking. If it only
      // ticked once in range, whichever unit took the final closing step spent
      // that tick moving while its opponent — already in range — started its
      // clock first. Players iterate first, so they always closed, and always
      // lost the opening exchange by one hit (mirror matches were 0/25).
      if (u.atkTimer > 0) u.atkTimer = Math.max(0, u.atkTimer - step);

      if (bestD <= u.range) {
        if (u.atkTimer <= 0) {
          // each unit swings at its OWN speed (atk_speed in units.csv), with a
          // little slop so the armies never settle into one coordinated beat
          u.atkTimer = u.atkInterval * (0.85 + Math.random() * 0.3);
          u.lungeT = CONFIG.lungeTime;
          u.lungeTo = { col: target.col, row: target.row };
          u.attackCount += 1;

          // Warlord: opening up on a fresh victim shoves it a hex and rips
          // away a chunk of its current health
          if (u.ability && u.ability.key === 'engage_push' && target.uid !== u.lastEngagedUid) {
            u.lastEngagedUid = target.uid;
            const pct = (u.ability.args[0] || 25) / 100;
            const extra = Math.max(1, Math.round(target.hp * pct));
            target.hp = Math.max(0, target.hp - extra);
            state.hits.push({
              col: target.col,
              row: target.row,
              amount: extra,
              blocked: 0,
              targetUid: target.uid,
              fx: 'impact',
            });
            pushAway(target, u);
          }

          if (u.range > 1) {
            // ranged: loose an arrow — the damage only lands when it arrives
            state.projectiles.push({
              targetUid: target.uid,
              dmg: u.dmg,
              t: bestD / CONFIG.projectileSpeed,
            });
            state.hits.push({
              fromCol: u.col,
              fromRow: u.row,
              col: target.col,
              row: target.row,
              targetUid: target.uid,
              travel: bestD / CONFIG.projectileSpeed,
              fx: 'shot', // visual only — no damage popup yet
            });
          } else {
            // melee: already at the target's hex, damage is immediate.
            // The shield eats a flat chunk, but a hit always lands for at
            // least 1 so nothing can become unkillable.
            const blocked = Math.min(target.shield || 0, Math.max(0, u.dmg - 1));
            const dealt = Math.max(1, u.dmg - blocked);
            target.hp = Math.max(0, target.hp - dealt);
            state.hits.push({
              fromCol: u.col,
              fromRow: u.row,
              col: target.col,
              row: target.row,
              amount: dealt,
              blocked,
              targetUid: target.uid,
              fx: 'slash',
            });
          }

          // Healers work in a loop: attack N times, then a heal goes off,
          // then N more attacks, and so on for the whole battle.
          if (u.ability && (u.ability.key === 'heal_wounded' || u.ability.key === 'heal_team')) {
            const every = u.ability.args[0] || 3;
            const amount = u.ability.args[1] || 20;
            if (u.attackCount % every === 0) {
              const allies = state.units.filter((a) => a.team === u.team && a.hp > 0);
              const healed =
                u.ability.key === 'heal_team'
                  ? allies
                  : [allies.reduce((a, b) => (b.maxHp - b.hp > a.maxHp - a.hp ? b : a))];
              healed.forEach((a) => {
                const gain = Math.min(amount, a.maxHp - a.hp);
                if (gain <= 0) return;
                a.hp += gain;
                state.hits.push({ col: a.col, row: a.row, amount: gain, targetUid: a.uid, fx: 'heal' });
              });
            }
          }
        }
      } else {
        u.moveTimer -= step;
        if (u.moveTimer <= 0) {
          u.moveTimer = 1 / u.moveSpeed;
          const next = pathStep(u, target);
          if (next) {
            u.col = next.col;
            u.row = next.row;
          }
          // no route to any attacking cell — hold position until one opens
        }
      }
    });

    // arrows in flight land when their travel time runs out; one that outlives
    // its target just vanishes
    state.projectiles = state.projectiles.filter((p) => {
      p.t -= step;
      if (p.t > 0) return true;
      const target = state.units.find((x) => x.uid === p.targetUid && x.hp > 0);
      if (!target) return false;
      const blocked = Math.min(target.shield || 0, Math.max(0, p.dmg - 1));
      const dealt = Math.max(1, p.dmg - blocked);
      target.hp = Math.max(0, target.hp - dealt);
      state.hits.push({
        col: target.col,
        row: target.row,
        amount: dealt,
        blocked,
        targetUid: target.uid,
        fx: 'impact', // popup + shield flare, no new projectile visual
      });
      return false;
    });

    // dead enemies leave the field; dead friends stay so they can be revived
    state.units = state.units.filter((u) => u.hp > 0 || u.team === 'player');

    const mine = livingOf('player').length;
    const theirs = livingOf('enemy').length;
    if (!mine || !theirs) {
      endBattle(mine, theirs);
    } else if (state.battleTime >= CONFIG.battleTimeout) {
      // ran out of time — whoever has more health left on the field takes it
      const hpOf = (team) => livingOf(team).reduce((n, u) => n + u.hp, 0);
      const myHp = hpOf('player');
      const theirHp = hpOf('enemy');
      log('Time!');
      endBattle(myHp > theirHp ? 1 : 0, theirHp > myHp ? 1 : 0);
    }
  }

  function endBattle(mine, theirs) {
    state.phase = 'result';
    if (mine && !theirs) {
      state.result = 'win';
      state.streak = Math.max(0, state.streak) + 1;
      state.enemyHp = Math.max(0, state.enemyHp - CONFIG.roundLossHp);
      log(`Round ${state.round} won!`);
    } else if (theirs && !mine) {
      state.result = 'lose';
      state.streak = Math.min(0, state.streak) - 1;
      state.playerHp = Math.max(0, state.playerHp - CONFIG.roundLossHp);
      log(`Round ${state.round} lost.`);
    } else {
      state.result = 'draw';
      state.playerHp = Math.max(0, state.playerHp - CONFIG.roundLossHp);
      state.enemyHp = Math.max(0, state.enemyHp - CONFIG.roundLossHp);
      log(`Round ${state.round} drawn.`);
    }
    if (state.playerHp <= 0) state.gameOver = 'lose';
    else if (state.enemyHp <= 0) state.gameOver = 'win';
  }

  // Called once the win/lose banner has been shown. Clears the field, sends
  // every unit home at full health, pays income and levels you up on schedule.
  function nextRound() {
    if (state.phase !== 'result' || state.gameOver) return false;
    state.round += 1;
    state.projectiles = [];
    state.units = state.units.filter((u) => u.team === 'player');
    state.units.forEach((u) => {
      u.col = u.homeCol;
      u.row = u.homeRow;
      u.hp = u.maxHp;
      u.atkTimer = 0;
      u.moveTimer = 0;
      u.targetUid = null;
      u.lungeT = 0;
      u.vx = null; // snap, don't glide, back to the home cell
      u.vy = null;
    });

    // levelling is purely time-served: lvl 1->2 takes 1 round, 2->3 takes 2, ...
    if (state.level < CONFIG.maxLevel) {
      state.roundsAtLevel += 1;
      if (state.roundsAtLevel >= state.level) {
        state.roundsAtLevel = 0;
        state.level += 1;
        log(`Level ${state.level} — you can field ${state.level} units.`);
      }
    }

    const interest = Math.min(5, Math.floor(state.gold / 10));
    const streakBonus = Math.abs(state.streak) >= 2 ? CONFIG.winStreakBonus : 0;
    state.gold += CONFIG.baseIncome + interest + streakBonus;
    if (!state.shopLocked) rollShop(); // locked shop keeps its unsold units
    // the AI opponent takes its own shopping turn, then fields its comp so
    // it's visible on the board through the whole prep phase
    aiShop();
    buildEnemy();
    state.result = null;
    state.phase = 'prep';
    // any 3-of-a-kind completed by mid-battle shopping evolves now
    checkMerges();
    return true;
  }

  function newGame() {
    uidSeq = 0;
    state.phase = 'prep';
    state.round = 1;
    state.gold = CONFIG.startGold;
    state.level = 1;
    state.roundsAtLevel = 0;
    state.streak = 0;
    state.shopLocked = false;
    state.bench = Array.from({ length: CONFIG.benchSlots }, () => null);
    state.units = [];
    state.result = null;
    state.log = [];
    state.hits = [];
    state.projectiles = [];
    state.enemyGold = CONFIG.startGold;
    state.enemyRoster = [];
    state.playerHp = CONFIG.playerMaxHp;
    state.enemyHp = CONFIG.playerMaxHp;
    state.gameOver = null;
    rollShop();
    aiShop(); // the AI opponent starts building its comp from round 1
    buildEnemy(); // round 1 always has a visible enemy on the board

    // you start with a free random tier-1 unit already on the field
    const t1 = poolForTier(1);
    if (t1.length) {
      const id = t1[Math.floor(Math.random() * t1.length)];
      const col = Math.floor(CONFIG.cols / 2);
      const row = CONFIG.rows - CONFIG.deployRows; // front row of your zone
      state.units.push(makeUnit(id, 'player', col, row, 1));
    }
  }

  global.AB = {
    CONFIG,
    ODDS,
    state,
    statsOf,
    newGame,
    rollShop,
    reroll,
    toggleShopLock,
    countCopies,
    buy,
    buyToBoard,
    sell,
    checkMerges,
    placeFromBench,
    moveOnBoard,
    benchUnit,
    moveBenchSlot,
    unitAt,
    isPlayerZone,
    isEnemyZone,
    boardCount,
    boardFull,
    maxBoardUnits,
    enemyRound,
    roundsToNextLevel,
    startBattle,
    nextRound,
    tick,
    livingOf,
  };
})(window);
