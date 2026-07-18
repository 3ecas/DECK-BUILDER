// Real-time lane battler engine.
//
// The field is two lanes. Each lane is a 0..100 track: 0 is the player's
// structure (bottom of the screen), 100 is the enemy's (top). Player units
// walk up, enemy units walk down. Both sides regenerate mana on the same
// clock and deploy from a 10-card deck that cycles through a 4-card hand.
(function (global) {
  const Units = global.RTS.Units;
  const Effects = global.RTS.Effects;

  const MANA_MAX = 10;
  const MANA_PER_SECOND = 0.5; // 1 mana every 2 seconds
  const STRUCTURE_HP = 10; // a unit that reaches a wall deals its own hp as damage
  const HAND_SIZE = 5;
  const LANE_COUNT = 3;
  const MATCH_DURATION = 120; // 2:00 total. Last 60s, played cards stop recycling.
  const FINAL_STRETCH = 60;
  const TRACK_END = 100;
  // A lane is 100 track units tall and renders 772px on the 1920x1080 stage, so
  // the 52px token spans 52/772*100 ≈ 6.7 units. Everything below derives from
  // that, so the maths matches the circles actually drawn on screen. If the lane
  // or token size changes in CSS, re-measure and update this one number.
  const UNIT_DIAMETER = 6.7;
  const UNIT_RADIUS = UNIT_DIAMETER / 2;

  // Each castle has a line a little in front of it. A unit damages that castle
  // the moment its CENTRE crosses the line.
  const CASTLE_LINE = 8; // distance from a castle to its own line
  const PLAYER_LINE = CASTLE_LINE; // bottom of the track
  const ENEMY_LINE = TRACK_END - CASTLE_LINE; // top of the track

  // Units spawn right at the very edge of the lane (0 / 100) and are revealed as
  // they walk in — the lane's overflow:hidden acts as a reveal mask.
  const SPAWN_POS = 0;

  // Opposing units walk straight at each other and lock together a little before
  // their circles fully overlap, then slide side by side (Naruto-card style).
  const ENGAGE_DIST = 5;
  const ENGAGE_TIME = 0.35; // seconds locked side by side before the clash resolves
  // Every unit moves at this speed — there is no per-card speed. This is the
  // 100% baseline; future modifiers scale off it.
  const UNIT_SPEED = (global.RTS_CONFIG && global.RTS_CONFIG.unitSpeed) || 3.2;
  const START_MANA = (global.RTS_CONFIG && global.RTS_CONFIG.startingMana) || 0;
  // Minimum spacing between two friendly units in a lane, so they queue up
  // single file instead of stacking on the same spot. One diameter + a hair,
  // so the tokens sit shoulder to shoulder without ever overlapping.
  const MIN_GAP = UNIT_DIAMETER + 1;

  let spawnSeq = 0;

  function makeLanes() {
    return Array.from({ length: LANE_COUNT }, () => []);
  }

  const state = {
    phase: 'idle', // 'idle' (arena shown, waiting on Engage) | 'playing' | 'gameover'
    player: null,
    enemy: null,
    lanes: makeLanes(),
    winner: null,
    enemyTimer: 0,
    matchTime: MATCH_DURATION, // counts down; UI shows this as mm:ss
    finalStretch: false, // true once matchTime <= FINAL_STRETCH
    log: [],
    flashes: [], // { lane, pos, text } consumed by the UI each frame
  };

  function log(msg) {
    state.log.push(msg);
    if (state.log.length > 40) state.log.shift();
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function makeSide(key, cardIds) {
    return {
      key,
      mana: Math.min(START_MANA, MANA_MAX),
      structureHp: STRUCTURE_HP,
      deck: shuffle(cardIds.map(Units.createInstance)),
      hand: [],
    };
  }

  function drawUp(side) {
    while (side.hand.length < HAND_SIZE && side.deck.length > 0) {
      side.hand.push(side.deck.shift());
    }
  }

  function newGame() {
    spawnSeq = 0;
    const level = global.RTS.Collection.getLevel();
    const playerDeck = global.RTS.Collection.getDeck();
    const cfg = global.RTS.Progression.configFor(level, playerDeck.length, STRUCTURE_HP);

    state.player = makeSide('player', playerDeck);
    state.player.manaRate = 1;
    state.player.statMult = 1;

    state.enemy = makeSide('enemy', cfg.deck);
    state.enemy.manaRate = cfg.manaRate;
    state.enemy.statMult = cfg.statMult;
    state.enemy.cadenceMin = cfg.cadenceMin;
    state.enemy.cadenceMax = cfg.cadenceMax;
    state.enemy.structureHp = cfg.wallHp;
    state.enemy.maxStructureHp = cfg.wallHp;
    state.enemy.mana = Math.min(MANA_MAX, cfg.startMana);

    state.level = level;
    state.world = cfg.world;
    state.isBoss = cfg.isBoss;
    state.bossName = cfg.name;
    state.bossEmoji = cfg.emoji;
    state.awardPack = false;

    state.lanes = makeLanes();
    state.winner = null;
    state.enemyTimer = 1.5;
    state.matchTime = MATCH_DURATION;
    state.finalStretch = false;
    state.log = [];
    state.flashes = [];
    drawUp(state.player);
    drawUp(state.enemy);
    state.phase = 'playing';
    log(
      cfg.isBoss
        ? `BOSS — ${cfg.name}! Break its wall (${cfg.wallHp} hp) to clear World ${cfg.world}.`
        : `Level ${level}: break the enemy wall (${cfg.wallHp} hp) to advance.`
    );
  }

  function sideOf(unit) {
    return unit.side === 'player' ? state.player : state.enemy;
  }

  // Destroyed units send their card back to the OWNER'S DECK (never the hand),
  // so it re-enters the cycle and can be drawn again later. A `swarm` card
  // spawns several units from ONE card, so only the copy flagged returnsCard
  // puts it back — otherwise the deck would breed extra copies. A unit played
  // during the final stretch is singleUse: it's gone for good once destroyed.
  function destroy(unit) {
    if (unit.dying) return; // a death effect killed something that killed us back
    unit.dying = true;
    const lane = state.lanes[unit.lane];
    const idx = lane.indexOf(unit);
    if (idx >= 0) lane.splice(idx, 1);
    // Fire onDeath AFTER removal, so a death effect can never hit the corpse.
    Effects.hooksFor(Units.get(unit.id), 'onDeath').forEach(({ fn, args }) => fn(unit, args, effectApi));
    const side = sideOf(unit);
    if (unit.returnsCard && !unit.singleUse) {
      side.deck.push(unit.inst);
      drawUp(side);
    }
  }

  function deploy(side, handIndex, laneIndex) {
    if (state.phase !== 'playing') return false;
    if (laneIndex < 0 || laneIndex >= LANE_COUNT) return false;
    const inst = side.hand[handIndex];
    if (!inst) return false;
    const card = Units.get(inst.id);
    if (side.mana < card.mana) return false;

    side.mana -= card.mana;
    side.hand.splice(handIndex, 1);

    // `swarm N` deploys N copies, staggered a little along the lane so they
    // arrive (and clash) one after another instead of as a single blob.
    const copies = Effects.deployCount(card);

    // The enemy's units are buffed by the level's stat multiplier (player = 1).
    const unitHp = Math.max(1, Math.round(card.hp * (side.statMult || 1)));

    const spawned = [];
    for (let i = 0; i < copies; i++) {
      spawnSeq += 1;
      const back = i * MIN_GAP; // spawn swarm copies already spaced out
      const unit = {
        fieldId: spawnSeq,
        inst,
        id: inst.id,
        side: side.key,
        lane: laneIndex,
        // enter just above your own castle line, mirrored per side
        pos: side.key === 'player' ? SPAWN_POS + back : TRACK_END - SPAWN_POS - back,
        hp: unitHp,
        maxHp: unitHp,
        buff: 0, // aura buffs/debuffs, recomputed every tick
        speedMult: 1, // 1 = the 100% baseline speed
        speedTimer: 0, // seconds left on a temporary speed change
        returnsCard: i === 0, // exactly one copy owns the card
        singleUse: state.finalStretch, // snapshot at deploy time
        engaged: false, // locked side by side with an enemy unit
        engagePartner: null, // fieldId of the unit it's clashing with
        engageTimer: 0,
      };
      state.lanes[laneIndex].push(unit);
      spawned.push(unit);
    }
    drawUp(side);
    log(
      `${side.key === 'player' ? 'You' : 'Enemy'} played ${card.name}${copies > 1 ? ` x${copies}` : ''} (lane ${laneIndex + 1}).`
    );

    // Fire on-deploy effects once every copy is on the field, so an effect can
    // see its own swarm-mates.
    spawned.forEach((unit) => {
      Effects.hooksFor(card, 'onDeploy').forEach(({ fn, args }) => fn(unit, args, effectApi));
    });
    return true;
  }

  // Player-facing deploy.
  function playCard(handIndex, laneIndex) {
    return deploy(state.player, handIndex, laneIndex);
  }

  function canAfford(handIndex) {
    const inst = state.player.hand[handIndex];
    if (!inst) return false;
    return state.player.mana >= Units.get(inst.id).mana;
  }

  function regen(side, dt) {
    side.mana = Math.min(MANA_MAX, side.mana + MANA_PER_SECOND * (side.manaRate || 1) * dt);
  }

  // Temporary per-unit states that just count down (speed boosts, etc).
  function tickTimers(dt) {
    state.lanes.forEach((lane) =>
      lane.forEach((u) => {
        if (u.speedTimer > 0) {
          u.speedTimer -= dt;
          if (u.speedTimer <= 0) {
            u.speedTimer = 0;
            u.speedMult = 1; // back to the 100% baseline
          }
        }
      })
    );
  }

  function moveUnits(dt) {
    state.lanes.forEach((lane) => {
      lane.forEach((u) => {
        if (u.engaged) return; // units locked in a side-by-side clash hold position
        const dir = u.side === 'player' ? 1 : -1;
        u.pos += dir * UNIT_SPEED * (u.speedMult || 1) * dt;
        u.pos = Math.max(0, Math.min(TRACK_END, u.pos));
      });
    });
  }

  // Keep friendly units in a lane single file: if one has caught up to the one
  // ahead, hold it back at MIN_GAP. That guarantees a clear front unit, so
  // there's never any ambiguity about who takes (and lands) the hit first.
  function enforceSpacing() {
    state.lanes.forEach((lane) => {
      ['player', 'enemy'].forEach((side) => {
        const dirUp = side === 'player';
        const units = lane
          .filter((u) => u.side === side)
          // front of the queue first
          .sort((a, b) => (dirUp ? b.pos - a.pos : a.pos - b.pos));
        for (let i = 1; i < units.length; i++) {
          const ahead = units[i - 1];
          if (dirUp) {
            const cap = ahead.pos - MIN_GAP;
            if (units[i].pos > cap) units[i].pos = Math.max(0, cap);
          } else {
            const cap = ahead.pos + MIN_GAP;
            if (units[i].pos < cap) units[i].pos = Math.min(TRACK_END, cap);
          }
        }
      });
    });
  }

  function flash(lane, pos, text) {
    state.flashes.push({ lane, pos, text });
  }

  /* ---------------- effects ---------------- */

  // Units ahead of `self` in its own lane, nearest first. "Ahead" is up the
  // track for the player and down it for the enemy, so effects are written once
  // and work for both sides.
  function unitsAhead(self, side, dist) {
    const dirUp = self.side === 'player';
    return state.lanes[self.lane]
      .filter((u) => {
        if (u === self || u.side !== side) return false;
        const gap = dirUp ? u.pos - self.pos : self.pos - u.pos;
        if (gap <= 0) return false;
        return dist === undefined || gap <= dist;
      })
      .sort((a, b) => (dirUp ? a.pos - b.pos : b.pos - a.pos));
  }

  // Units of `side` within `dist` of self in EITHER direction (blasts, not beams).
  function unitsNear(self, side, dist) {
    return state.lanes[self.lane].filter(
      (u) => u !== self && u.side === side && Math.abs(u.pos - self.pos) <= dist
    );
  }

  const foeOf = (self) => (self.side === 'player' ? 'enemy' : 'player');

  // Handed to every effect hook. This is the whole surface an effect can touch,
  // which keeps effects declarative and impossible to break the engine with.
  const effectApi = {
    alliesAhead: (self, dist) => unitsAhead(self, self.side, dist),
    enemiesAhead: (self, dist) => unitsAhead(self, foeOf(self), dist),
    alliesNear: (self, dist) => unitsNear(self, self.side, dist),
    enemiesNear: (self, dist) => unitsNear(self, foeOf(self), dist),
    otherLanes: (self) =>
      Array.from({ length: LANE_COUNT }, (_, i) => i).filter((i) => i !== self.lane),
    colorOf: (unit) => Units.get(unit.id).color,

    // TEMPORARY buff — recomputed every tick by applyAuras(), so it disappears
    // the moment its source stops applying it.
    addBuff: (unit, amount) => {
      unit.buff += amount;
    },

    // PERMANENT buff — raises maxHp too, otherwise the clash clamp
    // (min(maxHp, ...)) would quietly erase it on the unit's next fight.
    // Survives the death of whatever granted it.
    buffPermanent: (unit, amount) => {
      unit.maxHp += amount;
      unit.hp += amount;
    },

    damage: (unit, amount) => {
      unit.hp -= amount;
      if (unit.hp <= 0) destroy(unit);
    },

    // Temporary speed change. mult is a multiple of the 100% baseline speed.
    setSpeed: (unit, mult, seconds) => {
      unit.speedMult = mult;
      unit.speedTimer = seconds;
    },

    // Put an extra unit on the field. Summons are TOKENS: returnsCard is false
    // so they never breed copies of the card back into the deck, and their
    // onDeploy is deliberately NOT fired — otherwise a summoning card would
    // summon forever.
    summon: (self, opts) => {
      const laneIndex = opts.lane;
      if (laneIndex < 0 || laneIndex >= LANE_COUNT) return null;
      const card = Units.get(self.id);
      const smul = sideOf(self).statMult || 1;
      const hp = Math.max(1, Math.round((opts.hp || card.hp) * smul));
      spawnSeq += 1;
      const unit = {
        fieldId: spawnSeq,
        inst: self.inst,
        id: self.id,
        side: self.side,
        lane: laneIndex,
        pos: self.side === 'player' ? SPAWN_POS : TRACK_END - SPAWN_POS,
        hp,
        maxHp: hp,
        buff: 0,
        speedMult: 1,
        speedTimer: 0,
        returnsCard: false,
        singleUse: self.singleUse,
        engaged: false,
        engagePartner: null,
        engageTimer: 0,
      };
      state.lanes[laneIndex].push(unit);
      return unit;
    },

    log,
    flash: (lane, pos, text) => flash(lane, pos, text),
  };

  // Auras are wiped and rebuilt from scratch every tick. That's what makes any
  // number of buffs/debuffs from any number of sources stack cleanly — nothing
  // is ever permanently baked into a unit, so a source dying or walking out of
  // range just stops contributing on the next tick.
  function applyAuras() {
    state.lanes.forEach((lane) => lane.forEach((u) => { u.buff = 0; }));
    state.lanes.forEach((lane) =>
      lane.slice().forEach((u) => {
        Effects.hooksFor(Units.get(u.id), 'aura').forEach(({ fn, args }) => fn(u, args, effectApi));
      })
    );
  }

  // A unit's fighting power: its real hp, plus aura buffs, plus any situational
  // power() hooks (e.g. bonus_vs). `foe` is null when hitting a wall.
  function power(unit, foe) {
    let total = unit.hp + (unit.buff || 0);
    Effects.hooksFor(Units.get(unit.id), 'power').forEach(({ fn, args }) => {
      total += fn(unit, foe, args, effectApi) || 0;
    });
    return Math.max(0, total);
  }

  function disengage(u) {
    u.engaged = false;
    u.engagePartner = null;
    u.engageTimer = 0;
  }

  // Two front-most opposing units walk straight at each other. When they reach
  // the same point they lock side by side (the player unit slides left, the
  // enemy right — handled by the renderer) and clash after ENGAGE_TIME: the
  // lower-hp unit dies and the winner keeps the difference. Equal hp = both die.
  function resolveCombat(dt) {
    state.lanes.forEach((lane, laneIndex) => {
      let guard = 0;
      // loop so a survivor can immediately meet the next unit behind
      while (guard < 8) {
        guard += 1;
        const mine = lane.filter((u) => u.side === 'player').sort((a, b) => b.pos - a.pos);
        const theirs = lane.filter((u) => u.side === 'enemy').sort((a, b) => a.pos - b.pos);
        if (!mine.length || !theirs.length) return;
        const a = mine[0];
        const b = theirs[0];

        // Clear any stale engagement left over from a partner that has died.
        if (a.engaged && a.engagePartner !== b.fieldId) disengage(a);
        if (b.engaged && b.engagePartner !== a.fieldId) disengage(b);

        if (a.engaged && b.engaged) {
          // locked side by side — count down, then resolve the clash
          a.engageTimer -= dt;
          b.engageTimer -= dt;
          if (a.engageTimer > 0) return; // still trading blows this frame
          const meetPos = a.pos;
          const effA = power(a, b);
          const effB = power(b, a);
          if (effA > effB) {
            a.hp = Math.min(a.maxHp, effA - effB);
            disengage(a);
            destroy(b);
            flash(laneIndex, meetPos, `-${Units.get(b.id).name}`);
          } else if (effB > effA) {
            b.hp = Math.min(b.maxHp, effB - effA);
            disengage(b);
            destroy(a);
            flash(laneIndex, meetPos, `-${Units.get(a.id).name}`);
          } else {
            destroy(a);
            destroy(b);
            flash(laneIndex, meetPos, 'Trade!');
          }
          continue; // survivor may meet the next unit
        }

        if (a.pos < b.pos - ENGAGE_DIST) return; // haven't reached each other yet

        // they've met: snap both to the meeting point and lock them together
        const meetPos = (a.pos + b.pos) / 2;
        a.pos = meetPos;
        b.pos = meetPos;
        a.engaged = true;
        b.engaged = true;
        a.engagePartner = b.fieldId;
        b.engagePartner = a.fieldId;
        a.engageTimer = ENGAGE_TIME;
        b.engageTimer = ENGAGE_TIME;
        return; // engaged this frame; resolves on a later tick
      }
    });
  }

  // A castle is hit when the CENTRE of a unit's circle crosses that castle's
  // line. The unit deals its CURRENT hp as damage — so a unit chewed up in a
  // clash on the way in hits for less than a fresh one. Runs AFTER
  // resolveCombat, which is what makes a last-moment defensive placement work:
  // a blocker that reaches the attacker on the same tick kills it before this
  // ever sees it.
  function hitStructures() {
    state.lanes.forEach((lane, laneIndex) => {
      // copy: destroy() mutates the lane while we iterate
      lane.slice().forEach((u) => {
        const target = u.side === 'player' ? state.enemy : state.player;
        const crossed = u.side === 'player' ? u.pos >= ENEMY_LINE : u.pos <= PLAYER_LINE;
        if (!crossed) return;
        const dmg = power(u, null); // buffs count, so an aura also pushes damage
        target.structureHp = Math.max(0, target.structureHp - dmg);
        log(
          `${Units.get(u.id).name} smashes ${u.side === 'player' ? 'the enemy' : 'your'} wall for ${dmg}!`
        );
        flash(laneIndex, u.pos, `-${dmg}`);
        destroy(u);
      });
    });
  }

  function enemyThink(dt) {
    state.enemyTimer -= dt;
    if (state.enemyTimer > 0) return;
    const e = state.enemy;
    const cMin = e.cadenceMin || 1.2;
    const cMax = e.cadenceMax || 3.0;
    state.enemyTimer = cMin + Math.random() * Math.max(0, cMax - cMin);

    const options = e.hand
      .map((inst, i) => ({ i, card: Units.get(inst.id) }))
      .filter((o) => o.card.mana <= e.mana);
    if (!options.length) return;

    // lean toward the most expensive affordable unit, but not always
    options.sort((x, y) => y.card.mana - x.card.mana);
    const pick = Math.random() < 0.65 ? options[0] : options[Math.floor(Math.random() * options.length)];
    deploy(e, pick.i, Math.floor(Math.random() * LANE_COUNT));
  }

  function checkWin() {
    const Collection = global.RTS.Collection;
    if (state.enemy.structureHp <= 0) {
      state.phase = 'gameover';
      state.winner = 'player';
      const wasBoss = state.isBoss;
      const base = (global.RTS_CONFIG && global.RTS_CONFIG.currencyPerWin) || 0;
      // bosses pay big and drop a pack; normal levels just pay coins
      state.coinsWon = base + (wasBoss ? base * 3 : 0);
      state.awardPack = wasBoss;
      Collection.addCurrency(state.coinsWon);
      Collection.advanceLevel(); // next Engage is the harder level
      log(
        wasBoss
          ? `${state.bossName} falls! World ${state.world} cleared — +${state.coinsWon} coins and a pack.`
          : `Level ${state.level} cleared! +${state.coinsWon} coins. On to level ${state.level + 1}.`
      );
    } else if (state.player.structureHp <= 0) {
      state.phase = 'gameover';
      state.winner = 'enemy';
      state.awardPack = false;
      Collection.resetRun(); // roguelike: the climb restarts at level 1
      log(`Your wall falls at level ${state.level}. The climb resets to Level 1.`);
    }
  }

  function tick(dt) {
    if (state.phase !== 'playing') return;
    // guard against huge dt after a tab is backgrounded
    const step = Math.min(dt, 0.1);
    state.matchTime = Math.max(0, state.matchTime - step);
    if (!state.finalStretch && state.matchTime <= FINAL_STRETCH) {
      state.finalStretch = true;
      log('Final minute! Cards played from now on are single-use.');
    }
    regen(state.player, step);
    regen(state.enemy, step);
    tickTimers(step);
    moveUnits(step);
    enforceSpacing();
    applyAuras(); // rebuild every buff/debuff before anything reads power()
    resolveCombat(step);
    hitStructures();
    enemyThink(step);
    checkWin();
  }

  // Back to the idle arena (no menu — the arena is the game).
  function returnToIdle() {
    state.phase = 'idle';
    state.lanes = makeLanes();
    state.winner = null;
  }

  global.RTS = global.RTS || {};
  global.RTS.Arena = {
    state,
    newGame,
    playCard,
    canAfford,
    power,
    tick,
    returnToIdle,
    MANA_MAX,
    LANE_COUNT,
    HAND_SIZE,
    STRUCTURE_HP,
    MATCH_DURATION,
    FINAL_STRETCH,
    TRACK_END,
    UNIT_SPEED,
    MIN_GAP,
    ENGAGE_DIST,
    UNIT_RADIUS,
    PLAYER_LINE,
    ENEMY_LINE,
    SPAWN_POS,
  };
})(window);
