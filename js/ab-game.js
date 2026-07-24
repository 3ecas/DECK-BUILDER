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
    cols: 10,
    rows: 8, // 4 rows per side
    deployRows: 4,
    benchSlots: 12,
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

  // The Dark Arts summon: one persistent minion per team, re-forged stronger
  // at each darkarts breakpoint (index = traitLevel-1). Not in units.csv, so
  // it can never show up in the shop, get bought, benched, or sold — it's
  // purely a battle entity conjured by syncDarkArtsSummons().
  const DARK_SUMMON = [
    {
      id: 'dark_beast_1', name: 'Dark Beast', emoji: '🐺', tier: 2, cost: 0,
      hp: 650, dmg: 35, range: 1, atkSpeed: 0.6, moveSpeed: 2.4, color: 'grey', shield: 0,
    },
    {
      id: 'dark_beast_2', name: 'Dark Beast', emoji: '🐺', tier: 3, cost: 0,
      hp: 1100, dmg: 65, range: 1, atkSpeed: 0.65, moveSpeed: 2.5, color: 'grey', shield: 6,
    },
    {
      id: 'dark_beast_3', name: 'Greater Dark Beast', emoji: '🐉', tier: 4, cost: 0,
      hp: 1700, dmg: 100, range: 1, atkSpeed: 0.7, moveSpeed: 2.6, color: 'grey', shield: 14,
    },
    {
      id: 'dark_lady', name: 'The Dark Lady', emoji: '🧛‍♀️', tier: 5, cost: 0,
      hp: 2400, dmg: 160, range: 3, atkSpeed: 0.6, moveSpeed: 2.2, color: 'grey', shield: 20,
    },
  ];
  const DARK_SUMMON_BY_ID = {};
  DARK_SUMMON.forEach((d) => (DARK_SUMMON_BY_ID[d.id] = d));

  // Stars used to double hp+dmg per level (★3 = 4x ★1) — a freshly-merged
  // ★3 tier-1 unit could rival units many tiers above it, which made an
  // early ★3 feel unbeatable. This is a gentle climb instead: each star is
  // "a little bit better", not a different unit entirely.
  const STAR_MULT = [1, 1.35, 1.8];

  function statsOf(id, star) {
    const u =
      id === MINION.id ? MINION
      : id === MINION_BOSS.id ? MINION_BOSS
      : DARK_SUMMON_BY_ID[id] || U.get(id);
    if (!u) return null;
    const s = Math.max(1, Math.min(CONFIG.maxStar, star || 1));
    const mult = STAR_MULT[s - 1];
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

  // Registry of every comp bonus in the game. Each entry's array fields hold
  // the effect magnitude per breakpoint (index 0 = first breakpoint reached).
  // Effects are applied in a few ways:
  //   - STAT traits (frontline hp%, marn hp%+dmg%) are baked into a unit's
  //     maxHp/dmg once at battle start by applyTraitBuffs()
  //   - The ANIMAL kit is special: each specific animal UNIT present grants
  //     its own team-wide bonus (see applyAnimalKit/animalPackInfo), scaled
  //     by how many distinct animal units (1-5) the team has fielded.
  //   - LIVE traits act every tick: marksman/arcanist (bonus dmg folded into
  //     swings), enlighted (periodic team heal pulse), vampiric (lifesteal),
  //     colossus (periodic AoE pulse). See unitTraitLvl() for reading a
  //     unit's active breakpoint.
  const TRAITS = {
    animal: {
      name: 'Animals',
      icon: '🐾',
      breakpoints: [1, 2, 3, 4, 5], // pack size = distinct animal units fielded
      // Each specific animal grants ITS OWN team-wide bonus while fielded;
      // magnitude scales with total pack size (index = packSize-1). See
      // animalPackInfo()/applyAnimalKit() for how these are actually applied.
      atkSpeedPct: [0.06, 0.12, 0.18, 0.24, 0.3], // Snake: team attack speed
      shieldAdd: [12, 24, 40, 60, 85], // Bear: team flat shield
      dmgPct: [0.06, 0.12, 0.18, 0.24, 0.3], // Eagle: team attack damage
      hpPct: [0.06, 0.12, 0.18, 0.24, 0.3], // Lion: team HP
      lifePct: [0.04, 0.08, 0.12, 0.16, 0.2], // Beast Master: team lifesteal
      descs: [
        'Each animal on your team grants its own team-wide bonus — Snake: attack speed, Bear: shield, Eagle: damage, Lion: HP, Beast Master: lifesteal.',
        'Pack size 2: every active animal bonus grows stronger.',
        'Pack size 3: every active animal bonus grows stronger still.',
        'Pack size 4: every active animal bonus grows stronger yet.',
        'Pack size 5 (the full pack): every active animal bonus is maxed out.',
      ],
    },
    marksman: {
      name: 'Marksman',
      icon: '🎯',
      breakpoints: [1, 2, 3, 4, 5, 6],
      rangeAdd: [1, 2, 3, 4, 5, 6], // +1 hex range per Marksman fielded — baked in like a stat trait
      dmgPerHex: 0.08, // intrinsic, not breakpoint-gated: +8% bonus dmg per hex of distance fired
      descs: [
        'Marksmen gain +1 hex of range. Every Marksman deals +8% bonus damage per hex of distance to its target when it fires.',
        'Marksmen gain +2 hex of range.',
        'Marksmen gain +3 hex of range.',
        'Marksmen gain +4 hex of range.',
        'Marksmen gain +5 hex of range.',
        'Marksmen gain +6 hex of range.',
      ],
    },
    frontline: {
      name: 'Frontline',
      icon: '🛡️',
      breakpoints: [2, 4, 6],
      hpPct: [0.2, 0.45, 0.8], // +HP to frontline units
      // Near-death rescue: the FIRST time a frontline unit drops to/below the
      // threshold, it's instantly healed back up to the target — once only
      // per battle. Damage after that is never rescued again.
      rescueThreshold: [0.3, 0.35, 0.4],
      rescueTarget: [0.6, 0.7, 0.8],
      descs: [
        'Frontline units gain +20% HP. The first time one drops to 30% HP, it is healed back to 60% (once per battle).',
        'Frontline units gain +45% HP. The first time one drops to 35% HP, it is healed back to 70% (once per battle).',
        'Frontline units gain +80% HP. The first time one drops to 40% HP, it is healed back to 80% (once per battle).',
      ],
    },
    enlighted: {
      name: 'Enlighted',
      icon: '✨',
      breakpoints: [2, 5],
      healCount: [1, 3], // how many wounded allies get healed each pulse
      healPct: [0.3, 0.6], // % of max hp restored per pulse
      healEvery: 3, // seconds between pulses
      descs: [
        'Every 3s, heal the most-wounded ally for 30% of its max HP.',
        'Every 3s, heal the 3 most-wounded allies for 60% of their max HP.',
      ],
    },
    darkarts: {
      name: 'Dark Arts',
      icon: '🔮',
      breakpoints: [2, 4, 6, 8],
      // Doesn't buff its own units at all — instead it summons ONE persistent
      // minion that fights alongside the team, re-forged stronger at each
      // breakpoint. See DARK_SUMMON below; the summon never counts against
      // the team's board unit cap.
      descs: [
        'Summons a Dark Beast to fight alongside you.',
        'The Dark Beast grows stronger.',
        'The Dark Beast grows stronger still.',
        'The Dark Beast transforms into the Dark Lady.',
      ],
    },
    marn: {
      name: 'Marn Elite',
      icon: '⚜️',
      breakpoints: [2, 4, 6, 8, 10],
      statPct: [0.08, 0.16, 0.24, 0.32, 0.4], // a little +HP AND +damage to Marn units
      descs: [
        'Marn Elite units gain +8% HP and damage.',
        'Marn Elite units gain +16% HP and damage.',
        'Marn Elite units gain +24% HP and damage.',
        'Marn Elite units gain +32% HP and damage.',
        'Marn Elite units gain +40% HP and damage.',
      ],
    },
    berserker: {
      name: 'Berserkers',
      icon: '💢',
      breakpoints: [2, 4, 6],
      // bonus dmg % scales continuously across the WHOLE hp range: 0 bonus
      // at full hp, the full maxBonus at 0 hp — the less hp, the more attack.
      maxBonus: [0.25, 0.4, 0.55],
      descs: [
        'Berserkers deal up to +25% bonus damage — the lower their HP, the more they deal.',
        'Berserkers deal up to +40% bonus damage — the lower their HP, the more they deal.',
        'Berserkers deal up to +55% bonus damage — the lower their HP, the more they deal.',
      ],
    },
    vampiric: {
      name: 'Vampiric',
      icon: '🧛',
      breakpoints: [2, 3],
      lifePct: [0.12, 0.25], // % of damage dealt returned as healing
      descs: [
        'Vampiric units heal for 12% of the damage they deal.',
        'Vampiric units heal for 25% of the damage they deal.',
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
    arcanist: {
      name: 'Arcanists',
      icon: '🌀',
      breakpoints: [2, 4, 6, 8],
      dmgPct: [0.15, 0.3, 0.45, 0.6], // bonus attack damage, rising with the comp
      descs: [
        'Arcanists deal +15% bonus damage on every hit.',
        'Arcanists deal +30% bonus damage on every hit.',
        'Arcanists deal +45% bonus damage on every hit.',
        'Arcanists deal +60% bonus damage on every hit.',
      ],
    },
    // A close-knit family of 6 small beasts. No combat stat bonus — the
    // payoff is entirely economic: a guaranteed shop slot once you're
    // committed, and their mightiest fighter once you've mastered the set.
    // See NISMY_IDS / nismyGuaranteed() / nismyPool() for the shop logic.
    nismy: {
      name: 'Nismys',
      icon: '🧸',
      breakpoints: [3, 6],
      descs: [
        'Once you have 3 Nismys, one shop slot every round is guaranteed to offer a Nismy.',
        'The full family is assembled. Once all 6 Nismys have reached ★3, their mightiest fighter can appear in the shop for 5 gold.',
      ],
    },
    defender: {
      name: 'Defenders',
      icon: '🪖',
      breakpoints: [1, 2, 3],
      // TEAM-WIDE damage reduction — applies to every hit landed on the
      // team, not just Defender-trait units. See resolveDamage().
      reducePct: [0.06, 0.09, 0.12],
      descs: [
        'The whole team blocks 6% of every hit.',
        'The whole team blocks 9% of every hit.',
        'The whole team blocks 12% of every hit.',
      ],
    },
    horseman: {
      name: 'Horsemen',
      icon: '🐴',
      breakpoints: [2, 3],
      // Baked into moveSpeed like a stat trait — Horsemen close the
      // distance and reach the front line before anyone else on the field.
      moveSpeedMult: [2, 2.5],
      descs: [
        'Horsemen move at 2x speed, charging in first.',
        'Horsemen move at 2.5x speed, charging in first.',
      ],
    },
    // Titan's own signature passive — a singleton trait, not a comp (there's
    // only ever one Titan). Deliberately breaks the "every unit has 2-3
    // traits" rule: Colossus alone is Titan's entire kit.
    colossus: {
      name: 'Colossus',
      icon: '🌋',
      breakpoints: [1],
      pulseEvery: 3, // seconds between pulses
      dmgPct: [0.08], // magic damage per pulse, as a % of the Colossus's own max HP
      descs: ['Every 3s, deals magic damage equal to 8% of its own max HP to every enemy within 1 hex.'],
    },
  };
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

  // Bake stat traits (Frontline HP, Marn Elite stats, Duelist baseline attack
  // speed) into a unit's maxHp/dmg/atkInterval for this battle, starting from
  // its untouched base values. Called once at the bell after the trait
  // snapshot is taken — applyAnimalKit() runs right after and stacks its own
  // bonuses multiplicatively on top of whatever this bakes in.
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
      u.shield = u.baseShield || 0;
      u.atkInterval = u.baseAtkInterval;
      const mk = unitTraitLvl(u, 'marksman');
      u.range = mk ? u.baseRange + TRAITS.marksman.rangeAdd[mk - 1] : u.baseRange;
      const hs = unitTraitLvl(u, 'horseman');
      u.moveSpeed = hs ? u.baseMoveSpeed * TRAITS.horseman.moveSpeedMult[hs - 1] : u.baseMoveSpeed;
      u.hp = u.maxHp;
    });
  }

  // Rounds left in the current stage (a level-up comes with each new stage).
  const roundsToNextLevel = () => {
    const si = stageInfo();
    return si.def.rounds === Infinity ? 0 : si.def.rounds - si.sub + 1;
  };

  // Board usage counts SLOTS, not bodies — a Titan takes 2 of your allowance.
  // Dark Arts summons are exempt: they fight but never occupy a board slot.
  const boardCount = () =>
    state.units
      .filter((u) => u.team === 'player' && !u.summon)
      .reduce((n, u) => n + (u.slots || 1), 0);
  // LEVEL follows the STAGE: stage 1 = 1 unit, stage 4 = 4 units, cap 10.
  const maxBoardUnits = () => state.level;
  const boardFull = () => boardCount() >= maxBoardUnits();

  /* ---------------- shop ---------------- */

  // The Nismy family: 6 collectible base units, plus one capstone "Nismy
  // Alpha" excluded from normal shop rolls (see poolForTier below) — it only
  // enters the pool once all 6 base Nismys have been raised to ★3. See
  // nismyPool()/nismyGuaranteed(), called from rollShop()/aiShop().
  const NISMY_IDS = ['nismy_scout', 'nismy_guard', 'nismy_zapper', 'nismy_healer', 'nismy_hunter', 'nismy_trickster'];
  const NISMY_ULTIMATE_ID = 'nismy_alpha';

  const poolForTier = (tier) => U.ALL_IDS.filter((id) => U.get(id).tier === tier && id !== NISMY_ULTIMATE_ID);

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

  // True once every base Nismy id is owned (bench OR board for the player;
  // roster for the AI) at ★3 — the gate for Nismy Alpha entering the pool.
  function nismyAllMaxed(team) {
    const ownsAtStar3 = (id) => {
      if (team === 'player') {
        return (
          state.bench.some((b) => b && b.id === id && b.star >= CONFIG.maxStar) ||
          state.units.some((u) => u.team === 'player' && u.id === id && u.star >= CONFIG.maxStar)
        );
      }
      return state.enemyRoster.some((r) => r.id === id && r.star >= CONFIG.maxStar);
    };
    return NISMY_IDS.every(ownsAtStar3);
  }

  // 3+ distinct Nismys fielded on the board unlocks the shop guarantee.
  const nismyGuaranteed = (team) => traitCount(team, 'nismy') >= TRAITS.nismy.breakpoints[0];

  // What the guaranteed slot can roll: the 6 base Nismys, plus Nismy Alpha
  // once the whole family has reached ★3 (and tier 5 is otherwise unlocked).
  function nismyPool(team) {
    const pool = NISMY_IDS.slice();
    if (nismyAllMaxed(team) && tierUnlocked(5)) pool.push(NISMY_ULTIMATE_ID);
    return pool;
  }

  function rollShop() {
    state.shop = Array.from({ length: CONFIG.shopSlots }, () => rollUnit(state.level));
    if (nismyGuaranteed('player')) {
      const pool = nismyPool('player');
      state.shop[Math.floor(Math.random() * CONFIG.shopSlots)] = pool[Math.floor(Math.random() * pool.length)];
    }
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
    const u = state.units.find((x) => x.uid === uid && x.team === 'player' && !x.summon);
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
      baseShield: s.shield,
      traits: s.traits,
      scavHasteT: 0, // scavenger post-kill haste countdown (legacy field, unused)
      range: s.range,
      baseRange: s.range, // untouched base — Marksman range bonus recomputes from this
      atkInterval: 1 / s.atkSpeed, // seconds between this unit's attacks
      baseAtkInterval: 1 / s.atkSpeed, // untouched base — Animal speed bonuses recompute from this
      frontlineRescued: false, // Frontline's once-per-battle near-death heal, already used?
      colossusPulseT: null, // seconds until this Colossus's next AoE pulse
      moveSpeed: s.moveSpeed,
      baseMoveSpeed: s.moveSpeed, // untouched base — Horseman speed bonus recomputes from this
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

  /* ---------------- animal kit ---------------- */

  // Which specific animal units a team has fielded, and how big the pack is.
  // Each present animal grants its own team-wide bonus (applyAnimalKit /
  // applyAnimalLifesteal below), scaled by pack size (1-5).
  function animalPackInfo(team) {
    const ids = new Set();
    state.units.forEach((u) => {
      if (u.team === team && hasTrait(u, 'animal')) ids.add(u.id);
    });
    return {
      size: ids.size,
      hasSnake: ids.has('snake'),
      hasBear: ids.has('bear'),
      hasEagle: ids.has('eagle'),
      hasLion: ids.has('lion'),
      hasBeastMaster: ids.has('beastmaster'),
    };
  }

  // Applies the Lion/Eagle/Bear/Snake bonuses team-wide, stacked multiplicatively
  // on top of whatever applyTraitBuffs() already baked in. Beast Master's
  // lifesteal is LIVE (see applyAnimalLifesteal, called from tick()) since it
  // only matters at the moment damage is dealt.
  function applyAnimalKit() {
    ['player', 'enemy'].forEach((team) => {
      const kit = state.animalKit && state.animalKit[team];
      if (!kit || kit.size < 1) return;
      const idx = kit.size - 1;
      state.units.forEach((u) => {
        if (u.team !== team) return;
        if (kit.hasLion) u.maxHp = Math.round(u.maxHp * (1 + TRAITS.animal.hpPct[idx]));
        if (kit.hasEagle) u.dmg = Math.round(u.dmg * (1 + TRAITS.animal.dmgPct[idx]));
        if (kit.hasBear) u.shield = (u.shield || 0) + TRAITS.animal.shieldAdd[idx];
        if (kit.hasSnake) u.atkInterval = u.baseAtkInterval * (1 - TRAITS.animal.atkSpeedPct[idx]);
        u.hp = u.maxHp;
      });
    });
  }

  // Beast Master: every hit any team member lands heals the attacker for a %
  // of the damage dealt, scaling with pack size — same shape as Vampiric but
  // team-wide and gated on Beast Master being fielded rather than the trait.
  function applyAnimalLifesteal(attacker, dealt) {
    const kit = state.animalKit && state.animalKit[attacker.team];
    if (!kit || !kit.hasBeastMaster || attacker.hp <= 0) return;
    const gain = Math.min(Math.round(dealt * TRAITS.animal.lifePct[kit.size - 1]), attacker.maxHp - attacker.hp);
    if (gain <= 0) return;
    attacker.hp += gain;
    state.hits.push({ col: attacker.col, row: attacker.row, amount: gain, targetUid: attacker.uid, fx: 'heal' });
  }

  /* ---------------- Dark Arts summon ---------------- */

  function makeSummonUnit(defId, team, col, row) {
    const u = makeUnit(defId, team, col, row, 1);
    u.summon = true;
    return u;
  }

  // Rows belonging to a team's zone, back-most first (row 0 for the enemy,
  // the far edge row for the player) — where a fresh summon prefers to land.
  function zoneRows(team) {
    return team === 'enemy'
      ? Array.from({ length: CONFIG.deployRows }, (_, r) => r)
      : Array.from({ length: CONFIG.deployRows }, (_, r) => CONFIG.rows - 1 - r);
  }

  function summonCell(team) {
    const taken = new Set(state.units.filter((u) => u.hp > 0).map((u) => `${u.col},${u.row}`));
    for (const row of zoneRows(team)) {
      const cols = Array.from({ length: CONFIG.cols }, (_, c) => c);
      for (let i = cols.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cols[i], cols[j]] = [cols[j], cols[i]];
      }
      for (const col of cols) if (!taken.has(`${col},${row}`)) return { col, row };
    }
    return null;
  }

  // Re-forge each team's Dark Arts summon to match its CURRENT darkarts
  // breakpoint (2/4/6/8 -> Dark Beast I/II/III/Dark Lady). An already-summoned
  // beast is upgraded IN PLACE — same cell, new stats — so the player can drag
  // it around the board during prep (moveOnBoard allows it) and it stays put
  // across rounds instead of jumping to a random cell every re-sync. A comp
  // that drops back below 2 loses its beast entirely; one that had none yet
  // gets a fresh cell picked for it. Never counts toward the team's board cap
  // (see boardCount) — it's a bonus body, not a purchased one.
  function syncDarkArtsSummons() {
    ['player', 'enemy'].forEach((team) => {
      const lvl = traitLevel(team, 'darkarts');
      const existing = state.units.find((u) => u.team === team && u.summon);
      if (!lvl) {
        if (existing) state.units = state.units.filter((u) => u !== existing);
        return;
      }
      const def = DARK_SUMMON[lvl - 1];
      if (existing) {
        if (existing.id !== def.id) {
          const s = statsOf(def.id, 1);
          existing.id = def.id;
          existing.maxHp = s.maxHp;
          existing.baseMaxHp = s.maxHp;
          existing.hp = s.maxHp;
          existing.dmg = s.dmg;
          existing.baseDmg = s.dmg;
          existing.shield = s.shield;
          existing.baseShield = s.shield;
          existing.range = s.range;
          existing.atkInterval = 1 / s.atkSpeed;
          existing.moveSpeed = s.moveSpeed;
        }
        return; // same cell either way — it's already on the board
      }
      const cell = summonCell(team);
      if (!cell) return; // board is completely full — the beast waits offstage
      state.units.push(makeSummonUnit(def.id, team, cell.col, cell.row));
    });
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
      if (other.team !== 'player' || other.summon) return false;
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

  // The Dark Arts summon CAN be dragged around during prep like any other
  // unit (it's a real board occupant) — it just can't swap places with a
  // real unit, since it has no bench slot to send that unit's old position
  // to. It can only move onto an empty cell.
  function moveOnBoard(uid, col, row) {
    if (state.phase !== 'prep' || !inBounds(col, row) || !isPlayerZone(row)) return false;
    const u = state.units.find((x) => x.uid === uid && x.team === 'player');
    if (!u) return false;
    const other = unitAt(col, row);
    if (other === u) return true;
    if (other) {
      if (other.team !== 'player' || other.summon || u.summon) return false;
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
    const u = state.units.find((x) => x.uid === uid && x.team === 'player' && !x.summon);
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
       3. TRAITS   — aiValue boosts ANY unit for every roster-mate sharing a
          trait with it (generic over the whole TRAITS registry — animal,
          marksman, frontline, enlighted, darkarts, marn, berserker,
          vampiric, arcanist, scavenger, nismy, defender, horseman, colossus —
          so a new
          comp added to TRAITS is understood automatically, no AI code
          change needed unless the comp's VALUE should weigh differently).
          DARKARTS is an 8-unit comp
          that summons a free Dark Beast (see syncDarkArtsSummons) which
          doesn't cost a board slot — the AI doesn't need special-case code
          for this: stacking darkarts units already scores higher via the
          generic trait-synergy multiplier, and the summon is pure upside.
          ANIMAL is exactly 5 units (Snake/Bear/Eagle/Lion/Beast Master),
          each granting a different team-wide bonus (see applyAnimalKit) —
          the AI doesn't need to know WHICH bonus each grants either: the
          generic synergy boost already pushes it to collect distinct
          animals, which is exactly the right call for this comp. NISMY does
          need explicit AI code (aiShop's offer generation calls
          nismyGuaranteed('enemy')/nismyPool('enemy')) since its payoff is a
          shop-roll guarantee, not a stat the generic system can see.
       3b. COMPOSITION — aiValue also boosts a unit that fills a role the
          FIELDED board is short on: melee frontline, ranged backline, a
          tanky damage-soaker (shield or frontline), and especially any
          healing at all (biggest boost — zero sustain is the worst gap).
          This is what stops the board from ending up all-melee, all-glass,
          or with no support.
       4. MERGES   — DIVERSITY FIRST: at most one roster entry per unit id,
          ever. It'll merge a first triple into a ★2 (only starting that
          pair when the merged result would clearly upgrade its board, max
          2 such pair-projects at once) — but the instant a unit hits ★2 it
          is "settled" and never bought again, full stop. This deliberately
          caps most units at ★2: the AI is trading away deliberate ★3 pushes
          for a board that's always a real team of distinct units instead of
          stacks of the same piece. (A natural ★3 is still possible if 3 ★2
          copies of one id ever coexist, and still obeys the ★3 race lock.)
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

  // The units it would actually field right now, strongest first — used to
  // find "the weakest fielded piece" (the upgrade bar), to read what ROLES
  // the board already covers (composition balance below), and by buildEnemy
  // to place the real battlefield units. DEDUPED BY ID: while a unit is
  // still mid-merge it can briefly have 2 copies sitting in the roster (not
  // yet 3, so aiMerge hasn't combined them) — only the stronger one is ever
  // fielded, so the AI can never show two of the same unit on the board.
  function fieldedRoster() {
    const bestPerId = new Map();
    state.enemyRoster.forEach((r) => {
      const cur = bestPerId.get(r.id);
      if (!cur || rosterScore(r) > rosterScore(cur)) bestPerId.set(r.id, r);
    });
    return Array.from(bestPerId.values())
      .sort((a, b) => rosterScore(b) - rosterScore(a))
      .slice(0, maxBoardUnits());
  }

  // What a unit is worth TO THE AI's comp: raw power, adjusted for two
  // things a real player weighs too —
  //   (a) TRAIT SYNERGY: boosted when the roster already holds other
  //       distinct units sharing a trait, so it completes whatever comp
  //       it's building (animals, marksmen, anything in TRAITS).
  //   (b) COMPOSITION BALANCE: boosted when it fills a role the fielded
  //       board is currently short on — melee frontline, ranged backline,
  //       a tanky damage-soaker, or (most of all) any healing/sustain at
  //       all, since a comp with zero of one role loses fights a "same
  //       total power but balanced" comp would win.
  function aiValue(id, star) {
    let v = powerOf(id, star);
    const s = statsOf(id, 1);
    if (!s) return v;
    s.traits.forEach((trait) => {
      if (!TRAITS[trait]) return;
      const others = new Set(
        state.enemyRoster.filter((r) => r.id !== id && hasTrait(statsOf(r.id, 1), trait)).map((r) => r.id)
      ).size;
      v *= 1 + 0.15 * others;
    });

    const fielded = fieldedRoster();
    const n = fielded.length || 1;
    const roleOf = (r) => statsOf(r.id, 1);
    const meleeCount = fielded.filter((r) => roleOf(r).range === 1).length;
    const rangedCount = n - meleeCount;
    const tankyCount = fielded.filter((r) => {
      const rs = roleOf(r);
      return rs.shield > 0 || hasTrait(rs, 'frontline');
    }).length;
    const hasHealer = fielded.some((r) => hasTrait(roleOf(r), 'enlighted'));

    if (s.range === 1 && meleeCount < Math.ceil(n * 0.5)) v *= 1.15; // needs more frontline
    if (s.range > 1 && rangedCount < Math.ceil(n * 0.3)) v *= 1.15; // needs backline damage
    if ((s.shield > 0 || hasTrait(s, 'frontline')) && tankyCount < Math.ceil(n * 0.3)) {
      v *= 1.15; // needs more defense/tanks, not just raw damage
    }
    if (!hasHealer && hasTrait(s, 'enlighted')) v *= 1.35; // zero sustain is the biggest gap to close
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
      const offer = Array.from({ length: CONFIG.shopSlots }, () => rollUnit(state.level));
      // same Nismy shop guarantee the player gets, taught to the AI too
      if (nismyGuaranteed('enemy')) {
        const pool = nismyPool('enemy');
        offer.push(pool[Math.floor(Math.random() * pool.length)]);
      }
      offer.sort((a, b) => aiValue(b, 1) - aiValue(a, 1));

      for (const id of offer) {
        const s = statsOf(id, 1);
        if (!s || state.enemyGold < s.cost) continue;
        const roster = state.enemyRoster; // aiMerge/selling replace the array

        // DIVERSITY: at most one roster entry per unit id. The moment a unit
        // reaches ★2 it's "settled" — no more copies of it are ever bought,
        // full stop. This caps every unit's ceiling at ★2 (a deliberate
        // trade: it means the AI rarely reaches ★3, but it keeps its board a
        // real team instead of two or three stacks of the same piece).
        const owned = roster.filter((r) => r.id === id);
        if (owned.some((r) => r.star > 1)) continue;
        const copies = owned.length; // all ★1 here — settled ids were filtered above

        // What its board currently looks like: strongest pieces get fielded,
        // so the bar every purchase must clear is the weakest FIELDED piece.
        const fielded = fieldedRoster();
        const weakest = fielded[fielded.length - 1] || null;
        const weakestP = weakest ? rosterScore(weakest) : 0;

        // 1. Completing a triple — its ONE and only merge — always worth it.
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
        // 3. Second copy of a brand-new id: only if the merged ★2 would
        //    clearly upgrade the board. At most 2 such pair-projects run
        //    at once, so the board keeps filling with variety rather than
        //    committing everything to one or two units at a time.
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
        // 4. Straight upgrade: a fresh, never-before-owned unit whose ★1
        //    power beats the weakest fielded piece — sell that piece and
        //    field the better one. The steady tier-1 → tier-5 drift; even a
        //    merged ★2 gets sold (at its 3x refund) when a newcomer clearly
        //    outclasses it. Only a ★3 is forever. An uninvested ★1 goes
        //    cheaply (1.1x bar); ditching a ★2 needs a 1.35x case.
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

    // Housekeeping safety net: the buy loop above now refuses a second copy
    // of any id once it's ★2+, so this shouldn't fire in practice — kept in
    // case a stray duplicate ever slips through (e.g. old save state).
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
    // DEDUPED BY ID first: a unit mid-merge can briefly hold 2 copies (not
    // yet 3, so they haven't combined into one), but only the stronger copy
    // is ever a fielding candidate — the board can never show two of the
    // same unit even while the AI is still finishing that merge behind it.
    const bestPerId = new Map();
    state.enemyRoster.forEach((r) => {
      const cur = bestPerId.get(r.id);
      if (!cur || rosterScore(r) > rosterScore(cur)) bestPerId.set(r.id, r);
    });
    const fielded = [];
    let slotsUsed = 0;
    Array.from(bestPerId.values())
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
      u.scavHasteT = 0;
      u.frontlineRescued = false;
      u.colossusPulseT = null;
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
    state.animalKit = { player: animalPackInfo('player'), enemy: animalPackInfo('enemy') };
    // re-forge the Dark Arts summon(s) to match the locked-in comp, in case
    // shopping since the last sync changed either team's darkarts count
    syncDarkArtsSummons();
    // bake the stat comps (Frontline hp, Marn Elite stats, Duelist speed)
    // into the fighters, then stack the Animal kit's bonuses on top
    applyTraitBuffs();
    applyAnimalKit();
    // everyone starts partway through their own swing, so the opening (and
    // every later exchange) isn't one perfectly synchronised volley — done
    // AFTER the buffs above so it uses each unit's final atkInterval
    state.units.forEach((u) => {
      u.atkTimer = u.atkInterval * (0.4 + Math.random() * 0.6);
    });
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

  // Shared by melee and landed-projectile damage: the shield blocks a flat
  // amount, then Defenders shave a further % off for the WHOLE team (not
  // just Defender-trait units), but a hit always lands for at least 1 so
  // nothing can become unkillable.
  function resolveDamage(target, rawDmg) {
    const blocked = Math.min(target.shield || 0, Math.max(0, rawDmg - 1));
    let afterShield = rawDmg - blocked;
    const defLvl = state.traitLvl ? state.traitLvl[target.team].defender : 0;
    if (defLvl) afterShield = Math.round(afterShield * (1 - TRAITS.defender.reducePct[defLvl - 1]));
    const dealt = Math.max(1, afterShield);
    target.hp = Math.max(0, target.hp - dealt);
    maybeFrontlineRescue(target);
    return { dealt, blocked };
  }

  // Frontline's near-death rescue: the FIRST time a frontline unit's hp
  // drops to/below its breakpoint's threshold, it's instantly healed back up
  // to the breakpoint's target — once only per battle (a killing blow that
  // skips straight past the threshold to 0 is never rescued).
  function maybeFrontlineRescue(u) {
    const lvl = unitTraitLvl(u, 'frontline');
    if (!lvl || u.frontlineRescued || u.hp <= 0) return;
    if (u.hp > u.maxHp * TRAITS.frontline.rescueThreshold[lvl - 1]) return;
    u.frontlineRescued = true;
    const targetHp = Math.round(u.maxHp * TRAITS.frontline.rescueTarget[lvl - 1]);
    const gain = targetHp - u.hp;
    if (gain <= 0) return;
    u.hp = targetHp;
    state.hits.push({ col: u.col, row: u.row, amount: gain, targetUid: u.uid, fx: 'heal' });
  }

  // Vampiric: the attacker heals for a % of the damage it just dealt.
  function applyVampiric(attacker, dealt) {
    const lvl = unitTraitLvl(attacker, 'vampiric');
    if (!lvl || attacker.hp <= 0) return;
    const gain = Math.min(Math.round(dealt * TRAITS.vampiric.lifePct[lvl - 1]), attacker.maxHp - attacker.hp);
    if (gain <= 0) return;
    attacker.hp += gain;
    state.hits.push({ col: attacker.col, row: attacker.row, amount: gain, targetUid: attacker.uid, fx: 'heal' });
  }

  // Scavengers: on a takedown, the killer's post-kill haste REFRESHES (never
  // stacks), and a melee killer instantly advances into the corpse's cell —
  // "the next hex" — so it's already in position to swing at whoever's next.
  function triggerScavenger(killerUid, deadCol, deadRow, teleport) {
    const killer = state.units.find((x) => x.uid === killerUid && x.hp > 0);
    if (!killer || !unitTraitLvl(killer, 'scavenger')) return;
    killer.scavHasteT = 5;
    if (teleport) {
      killer.col = deadCol;
      killer.row = deadRow;
    }
    killer.targetUid = null; // free to pick the next nearest foe immediately
  }

  function tick(dt) {
    if (state.phase !== 'battle') return;
    const step = Math.min(dt, 0.1);
    state.battleTime = (state.battleTime || 0) + step;

    // Enlighted: a slow team-wide heal pulse for any side with 2+ Enlighted
    // units on the field — 1 target at the first breakpoint, up to 3 at full.
    state.healPulseT = (state.healPulseT == null ? TRAITS.enlighted.healEvery : state.healPulseT) - step;
    if (state.healPulseT <= 0) {
      state.healPulseT += TRAITS.enlighted.healEvery;
      ['player', 'enemy'].forEach((team) => {
        const lvl = state.traitLvl ? state.traitLvl[team].enlighted : 0;
        if (!lvl) return;
        const count = TRAITS.enlighted.healCount[lvl - 1];
        const wounded = state.units
          .filter((u) => u.team === team && u.hp > 0 && u.hp < u.maxHp)
          .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)
          .slice(0, count);
        wounded.forEach((u) => {
          const gain = Math.min(Math.round(u.maxHp * TRAITS.enlighted.healPct[lvl - 1]), u.maxHp - u.hp);
          if (gain <= 0) return;
          u.hp += gain;
          state.hits.push({ col: u.col, row: u.row, amount: gain, targetUid: u.uid, fx: 'heal' });
        });
      });
    }

    // Colossus: a per-unit periodic AoE pulse (Titan's own passive, not a
    // team comp — its damage is a % of ITS OWN max HP, not team-scaled).
    state.units.forEach((u) => {
      if (u.hp <= 0 || !hasTrait(u, 'colossus')) return;
      u.colossusPulseT = (u.colossusPulseT == null ? TRAITS.colossus.pulseEvery : u.colossusPulseT) - step;
      if (u.colossusPulseT > 0) return;
      u.colossusPulseT += TRAITS.colossus.pulseEvery;
      const dmg = Math.round(u.maxHp * TRAITS.colossus.dmgPct[0]);
      state.units.forEach((f) => {
        if (f.team === u.team || f.hp <= 0 || Hex.distance(u, f) > 1) return;
        const { dealt, blocked } = resolveDamage(f, dmg);
        state.hits.push({ col: f.col, row: f.row, amount: dealt, blocked, targetUid: f.uid, fx: 'impact' });
      });
    });

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
      if (u.scavHasteT > 0) u.scavHasteT = Math.max(0, u.scavHasteT - step);
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
          let speedMult = 1;
          const scavLvl = unitTraitLvl(u, 'scavenger');
          if (scavLvl && u.scavHasteT > 0) speedMult *= TRAITS.scavenger.killHaste[scavLvl - 1];
          u.atkTimer = u.atkInterval * (0.85 + Math.random() * 0.3) * speedMult;
          u.lungeT = CONFIG.lungeTime;
          u.lungeTo = { col: target.col, row: target.row };

          // Marksman/Arcanist: flat bonus % damage. Berserker: bonus % that
          // ramps up as the attacker's own HP drops below half. All fold
          // straight into the swing.
          let swingDmg = u.dmg;
          // Marksman: not breakpoint-gated (range IS the breakpoint reward,
          // baked in by applyTraitBuffs) — every Marksman deals +dmgPerHex
          // bonus damage for every hex of distance this specific shot travels.
          if (hasTrait(u, 'marksman')) swingDmg += Math.round(u.dmg * bestD * TRAITS.marksman.dmgPerHex);
          const arcLvl = unitTraitLvl(u, 'arcanist');
          if (arcLvl) swingDmg += Math.round(u.dmg * TRAITS.arcanist.dmgPct[arcLvl - 1]);
          const berLvl = unitTraitLvl(u, 'berserker');
          if (berLvl) {
            // continuous across the WHOLE hp range: full hp = no bonus,
            // 0 hp = the full maxBonus — the less hp, the more attack.
            const hpFrac = Math.max(0, Math.min(1, u.hp / u.maxHp));
            const rage = TRAITS.berserker.maxBonus[berLvl - 1] * (1 - hpFrac);
            if (rage > 0) swingDmg += Math.round(u.dmg * rage);
          }

          if (u.range > 1) {
            // ranged: loose an arrow — the damage only lands when it arrives
            state.projectiles.push({
              fromUid: u.uid,
              targetUid: target.uid,
              dmg: swingDmg,
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
            const { dealt, blocked } = resolveDamage(target, swingDmg);
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
            applyVampiric(u, dealt);
            applyAnimalLifesteal(u, dealt);
            if (target.hp === 0) triggerScavenger(u.uid, target.col, target.row, true);
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
      const { dealt, blocked } = resolveDamage(target, p.dmg);
      const shooter = state.units.find((x) => x.uid === p.fromUid && x.hp > 0);
      if (shooter) {
        applyVampiric(shooter, dealt);
        applyAnimalLifesteal(shooter, dealt);
      }
      state.hits.push({
        col: target.col,
        row: target.row,
        amount: dealt,
        blocked,
        targetUid: target.uid,
        fx: 'impact', // popup + shield flare, no new projectile visual
      });
      // ranged scavengers (Hunter) get the post-kill haste too, just no lunge
      if (target.hp === 0) triggerScavenger(p.fromUid, target.col, target.row, false);
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
      u.shield = u.baseShield != null ? u.baseShield : u.shield;
      u.atkInterval = u.baseAtkInterval || u.atkInterval;
      u.range = u.baseRange || u.range;
      u.moveSpeed = u.baseMoveSpeed || u.moveSpeed;
      u.hp = u.maxHp;
      u.scavHasteT = 0;
      u.frontlineRescued = false;
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
    // keep each team's Dark Arts summon in sync with its comp for prep too,
    // so it's visible on the field before the fight even starts
    syncDarkArtsSummons();
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
    syncDarkArtsSummons();
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
