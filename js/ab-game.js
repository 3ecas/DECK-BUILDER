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
    tierUnlockStage: { 4: 6, 5: 7 }, // hard gates: no T4 before stage 6, no T5 before stage 7
    maxStar: 3,
    maxLevel: 10,
    startGold: 2,
    rerollCost: 2,
    baseIncome: 4,
    interestCap: 3, // max gold earned from interest (1 per 10 banked)
    winStreakBonus: 1,
    aiIncomeRamp: 0.5, // extra AI gold per round per stage past 1 (PvE difficulty ramp)
    playerMaxHp: 500, // each player's life total
    roundLossHp: 8, // life lost by whoever loses a stage-1 round...
    roundLossHpPerStage: 6, // ...growing by this much per stage (stage 10 = 62)
    projectileSpeed: 9, // hexes per second an arrow/bolt travels
    lungeTime: 0.28, // how long the attack lunge animation lasts
    battleTimeout: 150, // safety net: melee units can block each other into a
    // stalemate, and there is no manual "next round" button to escape it.
    // Generous because doubled hp pools make honest fights run long too.
  };

  // Shop odds by player LEVEL (= stage): chance (%) of each tier 1..5.
  // Stages 1-3 are tier-1 only; T2 opens up at 4, T3 at 5, T4 (slightly) at 6,
  // T5 at a token 1% at 7. By level 10 the weight sits on tiers 3/4/5 with
  // 1 and 2 trailing. Rows sum to 100.
  const ODDS = {
    1: [100, 0, 0, 0, 0],
    2: [100, 0, 0, 0, 0],
    3: [100, 0, 0, 0, 0],
    4: [70, 30, 0, 0, 0],
    5: [50, 32, 18, 0, 0],
    6: [38, 30, 22, 10, 0],
    7: [30, 27, 24, 18, 1],
    8: [22, 24, 25, 22, 7],
    9: [15, 20, 26, 26, 13],
    10: [10, 14, 25, 27, 24],
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

  // The match is organised in STAGES, TFT-style (1-1, 1-2, ... 9-5), each
  // ending in a PvE round that gets harder every stage. Winning a PvE wave
  // pays bonus gold; losing any round costs the loser life, but PvE rounds
  // never drain the OTHER player's life — the game isn't a player.
  //   stage 1     : three pre-rounds (2/3/4 gentle minions)
  //   stages 2-5  : 3 rounds, the 3rd a minion wave (harder each stage)
  //   stage 6     : 4 rounds, the 4th a hard BOSS
  //   stages 7-8  : 4 rounds, the 4th hard / harder minions
  //   stage 9     : 5 rounds, the 5th a mega BOSS
  //   stage 10    : endless PvP until someone's life hits 0
  // `waves` maps a stage's round number -> the PvE wave fought that round.
  // Your LEVEL (units you can field) equals the stage number. Stages 1-3 are
  // an all-PvE build-up (every wave pays gold) and stage 4 starts at level 4.
  const STAGES = [
    // the build-up stages stay gentle — you only field 1-3 low-star units here
    { rounds: 1, waves: { 1: { count: 2, hp: 50, dmg: 12, gold: 1 } } }, // stage 1
    { rounds: 1, waves: { 1: { count: 3, hp: 120, dmg: 15, gold: 2 } } }, // stage 2
    // stage 3: minions, then the first minion boss
    {
      rounds: 2,
      waves: {
        1: { count: 5, hp: 240, dmg: 20, gold: 3 },
        2: { boss: true, hp: 1000, dmg: 45, aps: 0.7, gold: 6 },
      },
    },
    { rounds: 3, waves: { 3: { count: 5, hp: 500, dmg: 35, gold: 5 } } },
    { rounds: 3, waves: { 3: { count: 6, hp: 650, dmg: 45, gold: 6 } } },
    { rounds: 4, waves: { 4: { boss: true, hp: 5000, dmg: 100, aps: 0.8, gold: 12 } } },
    { rounds: 4, waves: { 4: { count: 7, hp: 850, dmg: 65, gold: 8 } } },
    { rounds: 4, waves: { 4: { count: 8, hp: 1100, dmg: 85, gold: 10 } } },
    { rounds: 5, waves: { 5: { boss: true, hp: 10000, dmg: 200, aps: 0.9, gold: 20 } } },
  ];

  // Absolute round -> { stage, sub, def }. Past stage 9 it's stage 10 forever.
  function stageInfo(r) {
    const abs = r || state.round;
    let acc = 0;
    for (let i = 0; i < STAGES.length; i++) {
      if (abs <= acc + STAGES[i].rounds) return { stage: i + 1, sub: abs - acc, def: STAGES[i] };
      acc += STAGES[i].rounds;
    }
    return { stage: 10, sub: abs - acc, def: { rounds: Infinity } };
  }

  // What kind of round is this? 'bonus' (minion wave) | 'boss' | 'pvp'
  function roundType(r) {
    const si = stageInfo(r);
    const w = si.def.waves && si.def.waves[si.sub];
    if (w) return w.boss ? 'boss' : 'bonus';
    return 'pvp';
  }

  // The PvE wave definition for this round, or null on PvP rounds.
  function pveWave(r) {
    const si = stageInfo(r);
    return (si.def.waves && si.def.waves[si.sub]) || null;
  }

  // How many PvP rounds have been fought up to (and including) this one —
  // used for tier unlocks so PvE rounds don't advance the clock.
  function enemyRound(r) {
    const abs = r || state.round;
    let n = 0;
    for (let i = 1; i <= abs; i++) if (roundType(i) === 'pvp') n += 1;
    return n;
  }

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
    star3By: {}, // unitId -> 'player'|'enemy': who won the race to ★3 that unit.
    // Only ONE player can ever ★3 each unit — first to make it locks the other out.
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
    hp: 50,
    dmg: 12,
    range: 1,
    atkSpeed: 0.5,
    moveSpeed: 2.5,
    color: 'grey',
    shield: 0,
    ability: null,
    slots: 1,
  };

  const MINION_BOSS = {
    id: 'minion_boss',
    name: 'Minion Boss',
    emoji: '👹',
    tier: 5,
    cost: 0,
    hp: 700,
    dmg: 40,
    range: 1,
    atkSpeed: 0.8,
    moveSpeed: 2.2,
    color: 'red',
    shield: 0,
    ability: null,
    slots: 1,
  };

  function statsOf(id, star) {
    const u = id === MINION.id ? MINION : id === MINION_BOSS.id ? MINION_BOSS : U.get(id);
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
      slots: u.slots || 1,
      traits: u.traits || [],
    };
  }

  /* ---------------- traits (comp bonuses) ---------------- */

  // Registry of comp bonuses. `animal` is the pilot: 2+ distinct animals on
  // the board make every animal attack 25% faster; the full pack of 4 ALSO
  // makes their hits BLEED the victim (a cut of its max hp per second).
  // Every comp bonus lives here. `at` holds the effect magnitude for each
  // breakpoint (index 0 = first breakpoint). Effects are applied in two ways:
  //   - stat traits (frontline hp, marn stats) are baked into a unit's maxHp/
  //     dmg at battle start by applyTraitBuffs()
  //   - live traits (animal, enlighted, darkarts, scavenger) act in tick()
  const TRAITS = {
    animal: {
      name: 'Animals',
      icon: '🐾',
      breakpoints: [2, 4],
      haste: [0.75, 0.75], // attack-interval multiplier (lower = faster)
      bleedFrom: 2, // breakpoint index (1-based) at which bleed turns on
      descs: [
        'The pack stirs: every animal attacks 25% faster.',
        'The full pack hunts: haste, plus animal attacks make foes bleed 1.5% of max hp per second for 3s.',
      ],
    },
    frontline: {
      name: 'Frontline',
      icon: '🛡️',
      breakpoints: [2, 4],
      hpPct: [0.25, 0.6], // +HP to frontline units
      descs: ['Frontline units gain +25% HP.', 'Frontline units gain +60% HP.'],
    },
    enlighted: {
      name: 'Enlighted',
      icon: '✨',
      breakpoints: [2, 3],
      healCount: [1, 3], // how many wounded allies get healed each pulse
      healPct: 0.1, // % of max hp restored per pulse
      healEvery: 3, // seconds between pulses
      descs: [
        'Every 3s, heal the most-wounded ally for 10% of its max HP.',
        'Every 3s, heal the 3 most-wounded allies for 10% of their max HP.',
      ],
    },
    darkarts: {
      name: 'Dark Arts',
      icon: '🔮',
      breakpoints: [2, 4],
      bonus: [0.25, 0.55], // bonus magic damage as a fraction of the attack
      descs: [
        'Dark Arts units deal +25% bonus magic damage on every hit.',
        'Dark Arts units deal +55% bonus magic damage on every hit.',
      ],
    },
    marn: {
      name: 'Marn Elite',
      icon: '⚜️',
      breakpoints: [2, 4, 6],
      statPct: [0.15, 0.35, 0.65], // +HP AND +damage to Marn units
      descs: [
        'Marn Elite units gain +15% HP and damage.',
        'Marn Elite units gain +35% HP and damage.',
        'Marn Elite units gain +65% HP and damage.',
      ],
    },
    scavenger: {
      name: 'Scavengers',
      icon: '🩸',
      breakpoints: [2, 3],
      killHaste: [0.7, 0.55], // attack-interval multiplier after a takedown
      descs: [
        'On a takedown: lunge to the next foe and attack 30% faster for 5s (no stack).',
        'On a takedown: lunge to the next foe and attack 45% faster for 5s (no stack).',
      ],
    },
  };
  const BLEED_RATE = 0.015; // 1.5% of max hp per second
  const BLEED_TIME = 3; // seconds, refreshed on every animal hit (does NOT stack)
  const SCAV_TIME = 5; // seconds a scavenger keeps its post-kill haste

  const hasTrait = (u, t) => (u.traits || []).includes(t);

  // Distinct unit KINDS with the trait on a team's board (copies count once).
  function traitCount(team, trait) {
    const ids = new Set();
    state.units.forEach((u) => {
      if (u.team === team && hasTrait(u, trait)) ids.add(u.id);
    });
    return ids.size;
  }

  // 0 = inactive, otherwise the 1-based breakpoint tier the team has reached.
  function traitLevel(team, trait) {
    const bp = TRAITS[trait].breakpoints;
    const n = traitCount(team, trait);
    let lvl = 0;
    bp.forEach((b, i) => {
      if (n >= b) lvl = i + 1;
    });
    return lvl;
  }

  // Active breakpoint tier of a trait for THIS unit's team, but 0 if the unit
  // doesn't carry the trait. Reads the snapshot locked in at battle start.
  function unitTraitLvl(u, trait) {
    if (!state.traitLvl || !hasTrait(u, trait)) return 0;
    return state.traitLvl[u.team][trait] || 0;
  }

  // Bake stat traits (Frontline HP, Marn Elite stats) into a unit's maxHp/dmg
  // for this battle, starting from its untouched base values. Called once at
  // the bell after the trait snapshot is taken.
  function applyTraitBuffs() {
    state.units.forEach((u) => {
      let hpMult = 1;
      let dmgMult = 1;
      const fl = unitTraitLvl(u, 'frontline');
      if (fl) hpMult += TRAITS.frontline.hpPct[fl - 1];
      const mn = unitTraitLvl(u, 'marn');
      if (mn) {
        hpMult += TRAITS.marn.statPct[mn - 1];
        dmgMult += TRAITS.marn.statPct[mn - 1];
      }
      u.maxHp = Math.round(u.baseMaxHp * hpMult);
      u.dmg = Math.round(u.baseDmg * dmgMult);
      u.hp = u.maxHp;
    });
  }

  // Rounds left in the current stage (a level-up comes with each new stage).
  const roundsToNextLevel = () => {
    const si = stageInfo();
    return si.def.rounds === Infinity ? 0 : si.def.rounds - si.sub + 1;
  };

  // Board usage counts SLOTS, not bodies — a Titan takes 2 of your allowance.
  const boardCount = () =>
    state.units.filter((u) => u.team === 'player').reduce((n, u) => n + (u.slots || 1), 0);
  // LEVEL follows the STAGE: stage 1 = 1 unit, stage 4 = 4 units, cap 10.
  const maxBoardUnits = () => state.level;
  const boardFull = () => boardCount() >= maxBoardUnits();

  /* ---------------- shop ---------------- */

  const poolForTier = (tier) => U.ALL_IDS.filter((id) => U.get(id).tier === tier);

  // Is this tier allowed to show up yet? (hard-gated by STAGE, matching the
  // odds table — a data mistake there can't leak a tier out early)
  function tierUnlocked(tier) {
    const need = CONFIG.tierUnlockStage[tier];
    return !need || stageInfo().stage >= need;
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
          // the ★3 race: if the enemy already made this unit ★3, you can't
          if (star + 1 === CONFIG.maxStar && state.star3By[id] === 'enemy') continue;
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
          if (star + 1 === CONFIG.maxStar && !state.star3By[id]) {
            state.star3By[id] = 'player';
            log(`You won the ★3 race for ${U.get(id).name} — the enemy can never 3-star it!`);
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
      baseMaxHp: s.maxHp, // untouched base — trait buffs recompute from these
      dmg: s.dmg,
      baseDmg: s.dmg,
      shield: s.shield,
      traits: s.traits,
      bleedT: 0, // seconds of bleed left on this unit
      bleedAcc: 0, // bled damage waiting to be shown as one popup
      scavHasteT: 0, // scavenger post-kill haste countdown (never stacks)
      range: s.range,
      atkInterval: 1 / s.atkSpeed, // seconds between this unit's attacks
      moveSpeed: s.moveSpeed,
      slots: s.slots,
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

  /* ================= AI RULEBOOK =================
     The opponent is a PC-controlled player. This block is the single place
     where its understanding of the game lives — WHENEVER A GAME MECHANIC IS
     ADDED OR CHANGED, TEACH IT HERE TOO, or the AI plays as if the mechanic
     doesn't exist. What it currently knows:
       1. ECONOMY  — same income/interest as the player (aiShop); pays real
          gold for units and rerolls; banks toward interest.
       2. VALUE    — every decision runs on power-per-slot (powerOf): hp +
          sustained dps, doubled per star, halved for 2-slot units.
       3. TRAITS   — animal units are worth more when it already owns other
          distinct animals (aiValue), so it completes the haste/bleed comp.
       4. MERGES   — always finishes a triple; only starts collecting a pair
          when the merged unit would clearly upgrade its board; max 2 projects
          at once. Obeys the ★3 race lock: once locked out of a unit's ★3 it
          stops buying copies past its ★2 and sells any surplus ★2s of it.
       5. UPGRADES — swaps its weakest uninvested ★1 for clearly better units.
       6. FIELDING — fields its strongest pieces up to the shared unit cap;
          melee to the front rows, ranged to the back; positions persist.
     ================================================ */

  // Raw board power a unit delivers per slot it occupies: hp plus sustained
  // damage output, doubled per star by statsOf, split across its slots. The
  // dps horizon (8s) tracks the doubled hp pools — if hp changes scale again,
  // rescale it or the AI drifts toward all-tank / all-glass boards.
  const powerOf = (id, star) => {
    const s = statsOf(id, star);
    if (!s) return 0;
    return (s.maxHp + s.dmg * s.atkSpeed * 8) / (s.slots || 1);
  };
  const rosterScore = (r) => powerOf(r.id, r.star);

  // What a unit is worth TO THE AI's comp: raw power, boosted when it's an
  // animal and the roster already holds other distinct animals — each extra
  // pack member is +15%, so it actively completes the haste/bleed comp.
  function aiValue(id, star) {
    let v = powerOf(id, star);
    const s = statsOf(id, 1);
    if (!s) return v;
    // Comp synergy, for EVERY registered trait: each distinct roster-mate
    // sharing a trait adds 15%, so the AI completes whatever comp it's on —
    // animals, marksmen, and anything added to TRAITS later.
    s.traits.forEach((trait) => {
      if (!TRAITS[trait]) return;
      const others = new Set(
        state.enemyRoster.filter((r) => r.id !== id && hasTrait(statsOf(r.id, 1), trait)).map((r) => r.id)
      ).size;
      v *= 1 + 0.15 * others;
    });
    return v;
  }

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
          // the ★3 race cuts both ways — a player ★3 locks the AI out too
          if (star + 1 === CONFIG.maxStar && state.star3By[id] === 'player') continue;
          const three = groups[id].slice(0, 3);
          const keep = three.find((r) => r.col != null) || three[0];
          state.enemyRoster = state.enemyRoster.filter((r) => !three.includes(r));
          state.enemyRoster.push({ id, star: star + 1, col: keep.col, row: keep.row });
          if (star + 1 === CONFIG.maxStar && !state.star3By[id]) {
            state.star3By[id] = 'enemy';
            log(`The enemy won the ★3 race for ${U.get(id).name}!`);
          }
          merged = true;
          break;
        }
      }
    }
  }

  function aiShop() {
    const stage = stageInfo().stage;
    // Same streak bonus the player gets (state.streak mirrors both sides: the
    // AI is on a run whenever the player is on a slide, and vice versa) plus a
    // small PvE ramp — +1 gold per two stages — so the AI stays a threat into
    // the late game instead of falling ever further behind a winning player.
    const streakBonus = Math.abs(state.streak) >= 2 ? CONFIG.winStreakBonus : 0;
    const ramp = Math.floor((stage - 1) * CONFIG.aiIncomeRamp);
    state.enemyGold +=
      CONFIG.baseIncome + streakBonus + ramp + Math.min(CONFIG.interestCap, Math.floor(state.enemyGold / 10));

    // a handful of looks at the shop per round, like a human would get —
    // 12 rolls a round had the AI outgearing the player by the first real
    // fight. It shops harder as the stages climb: 4 looks early, 5 from
    // stage 4, 6 from stage 7.
    const maxRolls = stage >= 7 ? 6 : stage >= 4 ? 5 : 4;
    let rolls = 0;
    while (rolls < maxRolls) {
      rolls += 1;
      // Spend on the BEST units first: the offer is considered in value order,
      // not slot order, so gold always chases the strongest thing available.
      const offer = Array.from({ length: CONFIG.shopSlots }, () => rollUnit(state.level)).sort(
        (a, b) => aiValue(b, 1) - aiValue(a, 1)
      );
      for (const id of offer) {
        const s = statsOf(id, 1);
        if (!s || state.enemyGold < s.cost) continue;
        const roster = state.enemyRoster; // aiMerge/selling replace the array

        // What its board currently looks like: strongest pieces get fielded,
        // so the bar every purchase must clear is the weakest FIELDED piece.
        const sorted = roster.slice().sort((a, b) => rosterScore(b) - rosterScore(a));
        const fielded = sorted.slice(0, maxBoardUnits());
        const weakest = fielded[fielded.length - 1] || null;
        const weakestP = weakest ? rosterScore(weakest) : 0;
        const copies = roster.filter((r) => r.id === id && r.star === 1).length;

        // The ★3 race: if the player owns this unit's ★3, the AI's merge path
        // stops at ★2 — once it HAS that ★2, more copies are dead gold.
        if (
          state.star3By[id] === 'player' &&
          roster.some((r) => r.id === id && r.star >= CONFIG.maxStar - 1)
        ) {
          continue;
        }

        // 1. Completing a triple doubles a whole unit — always worth it.
        if (copies === 2) {
          state.enemyGold -= s.cost;
          roster.push({ id, star: 1, col: null, row: null });
          continue;
        }
        // 2. An open board slot: field anything, power now beats gold idle.
        if (roster.length < state.level) {
          state.enemyGold -= s.cost;
          roster.push({ id, star: 1, col: null, row: null });
          continue;
        }
        // 3. Second copy (starting/continuing a merge project): only if the
        //    MERGED unit would clearly upgrade the board. This is what stops
        //    it from 3-starring cheap tier-1s all game — late on, a ★2 archer
        //    doesn't beat what it already fields, so it stops collecting.
        //    At most 2 projects at a time, so its board stays varied instead
        //    of turning into stacks of the same unit.
        if (copies === 1 && roster.length < state.level + CONFIG.benchSlots) {
          const projects = new Set(
            roster.filter((r) => r.star === 1 && roster.filter((x) => x.id === r.id && x.star === 1).length >= 2).map((r) => r.id)
          );
          if (!projects.has(id) && projects.size >= 2) continue;
          if (aiValue(id, 2) > weakestP * 1.25) {
            state.enemyGold -= s.cost;
            roster.push({ id, star: 1, col: null, row: null });
          }
          continue;
        }
        // 4. Straight upgrade: a fresh unit whose ★1 power beats the weakest
        //    fielded piece — sell that piece and field the better one. This is
        //    the steady tier-1 → tier-5 drift, and it knows late game wants
        //    expensive units: even a merged ★2 gets sold (at its 3x refund)
        //    when a newcomer CLEARLY outclasses it, so the board never stays
        //    glued to stage-2 merges. Only a ★3 is forever. An uninvested ★1
        //    goes cheaply (1.1x bar); ditching a ★2 needs a 1.35x case. Pieces
        //    with roster-mates of the same id are live merge projects — kept.
        if (
          weakest &&
          weakest.star < CONFIG.maxStar &&
          roster.filter((r) => r.id === weakest.id).length === 1 &&
          aiValue(id, 1) > weakestP * (weakest.star === 1 ? 1.1 : 1.35)
        ) {
          state.enemyGold += statsOf(weakest.id, 1).cost * Math.pow(3, weakest.star - 1) - s.cost;
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

    // Housekeeping: a race-locked unit can never reach ★3, so holding more
    // than one ★2 of it is pointless — sell the extras back.
    Object.keys(state.star3By).forEach((id) => {
      if (state.star3By[id] !== 'player') return;
      const twos = state.enemyRoster.filter((r) => r.id === id && r.star === CONFIG.maxStar - 1);
      twos.slice(1).forEach((r) => {
        state.enemyGold += statsOf(id, 1).cost * 3; // rough refund for 3 merged copies
        state.enemyRoster = state.enemyRoster.filter((x) => x !== r);
      });
    });

    // Housekeeping: sell off dead projects. A lone unfielded spare whose
    // merged result would no longer upgrade the board is wasted gold.
    const sorted = state.enemyRoster.slice().sort((a, b) => rosterScore(b) - rosterScore(a));
    const bench = sorted.slice(maxBoardUnits());
    const weakestP = sorted.length ? rosterScore(sorted[Math.min(maxBoardUnits(), sorted.length) - 1]) : 0;
    bench.forEach((r) => {
      if (r.star !== 1) return;
      const siblings = state.enemyRoster.filter((x) => x.id === r.id && x.star === 1).length;
      if (siblings === 1 && powerOf(r.id, 2) <= weakestP * 1.25) {
        state.enemyGold += statsOf(r.id, 1).cost;
        state.enemyRoster = state.enemyRoster.filter((x) => x !== r);
      }
    });
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

    // PvE rounds (the AI player still shops in the background during these).
    const wave = pveWave();
    if (wave) {
      const taken = new Set();
      if (wave.boss) {
        const cell = freeCell(taken, frontRows) || { col: Math.floor(CONFIG.cols / 2), row: 1 };
        const b = makeUnit(MINION_BOSS.id, 'enemy', cell.col, cell.row, 1);
        b.hp = wave.hp; // each boss is its own beast
        b.maxHp = wave.hp;
        b.dmg = wave.dmg;
        b.atkInterval = 1 / (wave.aps || 0.8);
        state.units.push(b);
        return;
      }
      for (let i = 0; i < wave.count; i++) {
        const cell = freeCell(taken, frontRows);
        if (!cell) break;
        taken.add(`${cell.col},${cell.row}`);
        const m = makeUnit(MINION.id, 'enemy', cell.col, cell.row, 1);
        m.hp = wave.hp; // stage waves are beefed-up minions
        m.maxHp = wave.hp;
        m.dmg = wave.dmg;
        state.units.push(m);
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
      u.bleedT = 0;
      u.bleedAcc = 0;
      u.scavHasteT = 0;
      // everyone starts partway through their own swing, so the opening (and
      // every later exchange) isn't one perfectly synchronised volley
      u.atkTimer = u.atkInterval * (0.4 + Math.random() * 0.6);
      u.moveTimer = 0;
      u.targetUid = null;
      u.lungeT = 0;
      u.vx = null;
      u.vy = null;
    });
    // trait bonuses are locked in from the comp on the board at the bell
    state.traitLvl = { player: {}, enemy: {} };
    Object.keys(TRAITS).forEach((t) => {
      state.traitLvl.player[t] = traitLevel('player', t);
      state.traitLvl.enemy[t] = traitLevel('enemy', t);
    });
    // bake the stat comps (Frontline hp, Marn Elite stats) into the fighters
    applyTraitBuffs();
    state.healPulseT = TRAITS.enlighted.healEvery; // enlighted heal cadence
    state.projectiles = [];
    state.result = null;
    state.battleTime = 0;
    state.phase = 'battle';
    log(`Round ${state.round}: fight!`);
    return true;
  }

  const livingOf = (team) => state.units.filter((u) => u.team === team && u.hp > 0);

  // True pathfinding (BFS over free hexes): find the SHORTEST walkable route
  // to any free cell from which the unit could hit ANY living foe, treating
  // every occupied cell — friend or foe — as a wall to go around. Because the
  // search accepts whichever attack cell it reaches first, a unit never takes
  // the long way round to chase one specific enemy when another is closer by
  // path. Returns { col, row, targetUid } — the first step of the route and
  // the foe that cell attacks — or null if nothing is reachable (hold still).
  function pathStepAny(u, foes) {
    const key = (c, r) => `${c},${r}`;
    const occupied = new Set();
    state.units.forEach((x) => {
      if (x.hp > 0 && x !== u) occupied.add(key(x.col, x.row));
    });
    const foeInRange = (col, row) => {
      let best = null;
      let bestD = Infinity;
      foes.forEach((f) => {
        const d = Hex.distance({ col, row }, f);
        if (d <= u.range && d < bestD) {
          bestD = d;
          best = f;
        }
      });
      return best;
    };

    const start = key(u.col, u.row);
    const prev = new Map([[start, null]]);
    const queue = [{ col: u.col, row: u.row }];
    let goal = null;
    let goalFoe = null;
    while (queue.length) {
      const cur = queue.shift();
      if (key(cur.col, cur.row) !== start) {
        const f = foeInRange(cur.col, cur.row);
        if (f) {
          goal = cur;
          goalFoe = f;
          break;
        }
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
    return { col: node.col, row: node.row, targetUid: goalFoe.uid };
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
      // bleeding (animal comp): a cut of max hp per second, shown in ~1s drips
      if (u.bleedT > 0 && u.hp > 0) {
        u.bleedT = Math.max(0, u.bleedT - step);
        const d = u.maxHp * BLEED_RATE * step;
        u.hp = Math.max(0, u.hp - d);
        u.bleedAcc += d;
        if (u.bleedAcc >= u.maxHp * BLEED_RATE || u.bleedT === 0 || u.hp === 0) {
          state.hits.push({
            col: u.col,
            row: u.row,
            amount: Math.max(1, Math.round(u.bleedAcc)),
            targetUid: u.uid,
            fx: 'bleed',
          });
          u.bleedAcc = 0;
        }
      }
      if (u.hp <= 0) return;

      const foes = state.units.filter((f) => f.team !== u.team && f.hp > 0);
      if (!foes.length) return;

      // A unit stays focused on its target only while it can actually reach
      // it (in range). Otherwise it re-checks constantly: whoever is in range
      // right now, nearest first — no marching the long way round the swarm
      // to chase one specific enemy that happens to be behind the line.
      let target = u.targetUid ? foes.find((f) => f.uid === u.targetUid) : null;
      if (!target || Hex.distance(u, target) > u.range) {
        let bestD = Infinity;
        let tied = [];
        foes.forEach((f) => {
          const d = Hex.distance(u, f);
          if (d > u.range) return; // only consider foes it can hit from here
          if (d < bestD) {
            bestD = d;
            tied = [f];
          } else if (d === bestD) {
            tied.push(f);
          }
        });
        target = tied.length ? tied[Math.floor(Math.random() * tied.length)] : null;
        u.targetUid = target ? target.uid : null;
      }
      const bestD = target ? Hex.distance(u, target) : Infinity;

      // The attack cadence runs CONTINUOUSLY, even while walking. If it only
      // ticked once in range, whichever unit took the final closing step spent
      // that tick moving while its opponent — already in range — started its
      // clock first. Players iterate first, so they always closed, and always
      // lost the opening exchange by one hit (mirror matches were 0/25).
      if (u.atkTimer > 0) u.atkTimer = Math.max(0, u.atkTimer - step);

      if (bestD <= u.range) {
        if (u.atkTimer <= 0) {
          // each unit swings at its OWN speed (atk_speed in units.csv), with a
          // little slop so the armies never settle into one coordinated beat.
          // An active pack (2+ animals) swings 25% faster; only the FULL pack
          // of 4 makes the hits bleed.
          const packLvl =
            state.traitLvl && hasTrait(u, 'animal') ? state.traitLvl[u.team].animal : 0;
          u.atkTimer =
            u.atkInterval * (0.85 + Math.random() * 0.3) * (packLvl >= 1 ? PACK_HASTE : 1);
          u.lungeT = CONFIG.lungeTime;
          u.lungeTo = { col: target.col, row: target.row };

          const bleeds = packLvl >= 2;
          // Marksman comp: +10% damage per marksman fielded (traitLevel is
          // count-1, so lvl 1 = 2 marksmen = +20%, lvl 3 = full squad = +40%).
          const markLvl =
            state.traitLvl && hasTrait(u, 'marksman') ? state.traitLvl[u.team].marksman : 0;
          const swingDmg =
            markLvl >= 1 ? Math.round(u.dmg * (1 + MARKSMAN_DMG * (markLvl + 1))) : u.dmg;
          if (u.range > 1) {
            // ranged: loose an arrow — the damage only lands when it arrives
            state.projectiles.push({
              targetUid: target.uid,
              dmg: swingDmg,
              t: bestD / CONFIG.projectileSpeed,
              bleeds,
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
            const blocked = Math.min(target.shield || 0, Math.max(0, swingDmg - 1));
            const dealt = Math.max(1, swingDmg - blocked);
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
            if (bleeds) target.bleedT = BLEED_TIME; // animal claws open the wound
          }
        }
      } else {
        u.moveTimer -= step;
        if (u.moveTimer <= 0) {
          u.moveTimer = 1 / u.moveSpeed;
          // head for the CLOSEST attackable spot against any foe — the path
          // decides the target, so nobody detours around the whole swarm
          const next = pathStepAny(u, foes);
          if (next) {
            u.col = next.col;
            u.row = next.row;
            u.targetUid = next.targetUid;
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
      if (p.bleeds) target.bleedT = BLEED_TIME;
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
    const type = roundType();
    const vsGame = type !== 'pvp'; // PvE: the game is the opponent, not the AI player
    const wave = pveWave();
    const bonusGold = wave ? wave.gold : 0;
    // the price of losing climbs with the stages — early stumbles are cheap,
    // late-game losses hit hard enough to actually end matches
    const lossHp = CONFIG.roundLossHp + (stageInfo().stage - 1) * CONFIG.roundLossHpPerStage;

    if (mine && !theirs) {
      state.result = 'win';
      state.streak = Math.max(0, state.streak) + 1;
      if (vsGame) {
        // beating the game never hurts the enemy player; bonus rounds pay out
        if (bonusGold) {
          state.gold += bonusGold;
          log(`Bonus round won — +${bonusGold} gold!`);
        }
      } else {
        state.enemyHp = Math.max(0, state.enemyHp - lossHp);
      }
      log(`Round ${state.round} won!`);
    } else if (theirs && !mine) {
      state.result = 'lose';
      state.streak = Math.min(0, state.streak) - 1;
      // losing always costs YOU life — even to a minion round
      state.playerHp = Math.max(0, state.playerHp - lossHp);
      log(`Round ${state.round} lost.`);
    } else {
      state.result = 'draw';
      state.playerHp = Math.max(0, state.playerHp - lossHp);
      if (!vsGame) state.enemyHp = Math.max(0, state.enemyHp - lossHp);
      log(`Round ${state.round} drawn.`);
    }

    // the AI player fights its own copy of every bonus round off-screen; it's
    // assumed to clear them, so it banks the same bonus gold
    if (bonusGold) state.enemyGold += bonusGold;

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
      // shed battle-only trait buffs — prep shows base stats again
      u.maxHp = u.baseMaxHp || u.maxHp;
      u.dmg = u.baseDmg || u.dmg;
      u.hp = u.maxHp;
      u.scavHasteT = 0;
      u.atkTimer = 0;
      u.moveTimer = 0;
      u.targetUid = null;
      u.lungeT = 0;
      u.vx = null; // snap, don't glide, back to the home cell
      u.vy = null;
    });

    // LEVEL = STAGE: both players grow a unit slot with every new stage
    const newLevel = Math.min(CONFIG.maxLevel, stageInfo(state.round).stage);
    if (newLevel !== state.level) {
      state.level = newLevel;
      log(`Level ${state.level} — you can field ${state.level} units.`);
    }

    const interest = Math.min(CONFIG.interestCap, Math.floor(state.gold / 10));
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
    state.star3By = {};
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
    roundType,
    stageInfo,
    TRAITS,
    traitCount,
    traitLevel,
    roundsToNextLevel,
    startBattle,
    nextRound,
    tick,
    livingOf,
  };
})(window);
