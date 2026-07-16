// Real-time lane battler engine.
//
// The field is two lanes. Each lane is a 0..100 track: 0 is the player's
// structure (bottom of the screen), 100 is the enemy's (top). Player units
// walk up, enemy units walk down. Both sides regenerate mana on the same
// clock and deploy from a 10-card deck that cycles through a 4-card hand.
(function (global) {
  const Units = global.RTS.Units;

  const MANA_MAX = 10;
  const MANA_PER_SECOND = 0.5; // 1 mana every 2 seconds
  const STRUCTURE_HP = 2; // two hits and you're out
  const HAND_SIZE = 4;
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

  // The enemy fields a random legal deck drawn from the whole library, so
  // fights stay varied as the player's collection grows.
  function randomEnemyDeck(size) {
    const pool = Units.ALL_IDS;
    return Array.from({ length: size }, () => pool[Math.floor(Math.random() * pool.length)]);
  }

  function drawUp(side) {
    while (side.hand.length < HAND_SIZE && side.deck.length > 0) {
      side.hand.push(side.deck.shift());
    }
  }

  function newGame() {
    spawnSeq = 0;
    const playerDeck = global.RTS.Collection.getDeck();
    state.player = makeSide('player', playerDeck);
    state.enemy = makeSide('enemy', randomEnemyDeck(playerDeck.length));
    state.lanes = makeLanes();
    state.winner = null;
    state.enemyTimer = 2;
    state.matchTime = MATCH_DURATION;
    state.finalStretch = false;
    state.log = [];
    state.flashes = [];
    drawUp(state.player);
    drawUp(state.enemy);
    state.phase = 'playing';
    log('Battle begins. Break two walls to win.');
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
    const lane = state.lanes[unit.lane];
    const idx = lane.indexOf(unit);
    if (idx >= 0) lane.splice(idx, 1);
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
    const swarmArgs = Units.modArgs(card, 'swarm');
    const copies = swarmArgs ? Math.max(1, Math.floor(Number(swarmArgs[0]) || 1)) : 1;

    for (let i = 0; i < copies; i++) {
      spawnSeq += 1;
      const back = i * MIN_GAP; // spawn swarm copies already spaced out
      state.lanes[laneIndex].push({
        fieldId: spawnSeq,
        inst,
        id: inst.id,
        side: side.key,
        lane: laneIndex,
        // enter just above your own castle line, mirrored per side
        pos: side.key === 'player' ? SPAWN_POS + back : TRACK_END - SPAWN_POS - back,
        hp: card.hp,
        maxHp: card.hp,
        returnsCard: i === 0, // exactly one copy owns the card
        singleUse: state.finalStretch, // snapshot at deploy time
        engaged: false, // locked side by side with an enemy unit
        engagePartner: null, // fieldId of the unit it's clashing with
        engageTimer: 0,
      });
    }
    drawUp(side);
    log(
      `${side.key === 'player' ? 'You' : 'Enemy'} played ${card.name}${copies > 1 ? ` x${copies}` : ''} (lane ${laneIndex + 1}).`
    );
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
    side.mana = Math.min(MANA_MAX, side.mana + MANA_PER_SECOND * dt);
  }

  function moveUnits(dt) {
    state.lanes.forEach((lane) => {
      lane.forEach((u) => {
        if (u.engaged) return; // units locked in a side-by-side clash hold position
        const dir = u.side === 'player' ? 1 : -1;
        u.pos += dir * UNIT_SPEED * dt;
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

  // `bonus_vs <color> N` — the unit fights as if it had N extra hp, but only
  // against that colour. The bonus is spent in the clash, so the winner never
  // ends up above its own maxHp.
  function effectiveHp(unit, foe) {
    const args = Units.modArgs(Units.get(unit.id), 'bonus_vs');
    if (!args) return unit.hp;
    const [color, amount] = args;
    if (Units.get(foe.id).color !== color) return unit.hp;
    return unit.hp + (Number(amount) || 0);
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
          const effA = effectiveHp(a, b);
          const effB = effectiveHp(b, a);
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
  // line. Runs AFTER resolveCombat, which is what makes a last-moment defensive
  // placement work: a blocker that reaches the attacker on the same tick kills
  // it before this ever sees it.
  function hitStructures() {
    state.lanes.forEach((lane) => {
      // copy: destroy() mutates the lane while we iterate
      lane.slice().forEach((u) => {
        if (u.side === 'player' && u.pos >= ENEMY_LINE) {
          state.enemy.structureHp -= 1;
          log(`${Units.get(u.id).name} smashes the enemy wall!`);
          destroy(u);
        } else if (u.side === 'enemy' && u.pos <= PLAYER_LINE) {
          state.player.structureHp -= 1;
          log(`${Units.get(u.id).name} smashes your wall!`);
          destroy(u);
        }
      });
    });
  }

  function enemyThink(dt) {
    state.enemyTimer -= dt;
    if (state.enemyTimer > 0) return;
    state.enemyTimer = 1.2 + Math.random() * 1.8;

    const e = state.enemy;
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
    if (state.enemy.structureHp <= 0) {
      state.phase = 'gameover';
      state.winner = 'player';
      state.coinsWon = (global.RTS_CONFIG && global.RTS_CONFIG.currencyPerWin) || 0;
      global.RTS.Collection.addCurrency(state.coinsWon);
      log('The enemy wall falls. You win!');
    } else if (state.player.structureHp <= 0) {
      state.phase = 'gameover';
      state.winner = 'enemy';
      log('Your wall falls. You lose.');
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
    moveUnits(step);
    enforceSpacing();
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
