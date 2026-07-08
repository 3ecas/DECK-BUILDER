// Core game state machine: piles, turns, combat resolution, floor progression.
(function (global) {
  const Cards = global.DB.Cards;
  const Enemies = global.DB.Enemies;

  const HAND_LIMIT = 2; // baseline hand size refilled at the start of each turn
  const MAX_HAND = 10; // safety ceiling so "draw" effects can genuinely add cards mid-turn
  const PLAYER_MAX_HP = 20;
  const PLAYER_ACTIONS = 3;

  const state = {
    floor: 0,
    turn: 'player', // 'player' | 'enemy'
    phase: 'intro', // 'intro' | 'shop' | 'bonus' | 'playing' | 'reward' | 'gameover'
    log: [],
    events: [], // transient combat-text/shake events consumed by the UI after each render
    enemyReveal: null, // the card the enemy just played this step, shown with a reveal animation
    pendingEcho: null, // candidate card ids waiting on a player choice for the Echo card
    rewardOptions: [],
    bonusResult: null, // { type: 'tavern'|'chest', ... } shown on the "bonus" screen
    shopOffer: [], // { cardId, price, bought } while phase === 'shop'
    player: null,
    enemy: null,
  };

  function log(msg) {
    state.log.push(msg);
    if (state.log.length > 40) state.log.shift();
  }

  function pushEvent(actor, kind, amount) {
    if (!amount) return;
    state.events.push({ target: actor === state.player ? 'player' : 'enemy', kind, amount });
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function clampHp(actor) {
    actor.hp = Math.max(0, Math.min(actor.maxHp, actor.hp));
  }

  function conj(actor, base) {
    return actor === state.player ? base : `${base}s`;
  }

  // ---- ctx helpers shared by player & enemy card plays ----
  function makeCtx(actor, target, multiplier) {
    return {
      attack(base) {
        let dmg = Math.round(base * multiplier) + (actor.strength || 0);
        if (actor.weak > 0) dmg = Math.floor(dmg * 0.75);
        if (target.vulnerable > 0) dmg = Math.floor(dmg * 1.25);
        dmg = Math.max(0, dmg);
        const blocked = Math.min(target.block, dmg);
        target.block -= blocked;
        const toHp = dmg - blocked;
        target.hp -= toHp;
        clampHp(target);
        log(`${actor.name} ${conj(actor, 'deal')} ${dmg} damage to ${target.name}${blocked ? ` (${blocked} blocked)` : ''}.`);
        pushEvent(target, 'damage', toHp);

        if (dmg > 0 && target.thorns > 0) {
          const reflected = target.thorns;
          actor.hp -= reflected;
          clampHp(actor);
          log(`${target.name}'s Thorns ${conj(target, 'deal')} ${reflected} damage back to ${actor.name}.`);
          pushEvent(actor, 'damage', reflected);
        }
        return dmg;
      },
      block(amount) {
        const amt = Math.round(amount * multiplier);
        actor.block += amt;
        log(`${actor.name} ${conj(actor, 'gain')} ${amt} Block.`);
        pushEvent(actor, 'block', amt);
      },
      heal(amount) {
        const before = actor.hp;
        actor.hp = Math.min(actor.maxHp, actor.hp + amount);
        const healed = actor.hp - before;
        log(`${actor.name} ${conj(actor, 'heal')} ${healed} HP.`);
        pushEvent(actor, 'heal', healed);
      },
      status(who, key, amount) {
        const ref = who === 'self' ? actor : target;
        ref[key] = (ref[key] || 0) + amount;
        log(`${ref.name} ${conj(ref, 'gain')} ${amount} ${key}.`);
      },
      drawSelf(n) {
        if (actor === state.player) drawCards(n);
      },
      gainActions(n) {
        if (actor === state.player) state.player.actions += n;
      },
      gainGold(n) {
        if (actor === state.player) {
          actor.gold += n;
          log(`${actor.name} ${conj(actor, 'gain')} ${n} Gold.`);
        }
      },
      bonusActionsNextTurn(n) {
        if (actor === state.player) state.player.bonusActionsNext = (state.player.bonusActionsNext || 0) + n;
      },
      hasPlayedType(type) {
        return (actor.turnPlayedTypes || []).includes(type);
      },
      countPlayedType(type) {
        return (actor.turnPlayedTypes || []).filter((t) => t === type).length;
      },
      playedCountThisTurn() {
        return (actor.turnPlayedTypes || []).length;
      },
      lastPlayedCardId() {
        const ids = (actor.turnPlayedCardIds || []).filter((id) => id !== 'mimic' && id !== 'echo');
        return ids.length ? ids[ids.length - 1] : null;
      },
      targetHasStatus(key) {
        return (target[key] || 0) > 0;
      },
      targetHpPercent() {
        return target.hp / target.maxHp;
      },
      steal(key, amount) {
        const available = target[key] || 0;
        const stolen = Math.min(available, amount);
        if (stolen <= 0) return 0;
        target[key] -= stolen;
        actor[key] = (actor[key] || 0) + stolen;
        log(`${actor.name} ${conj(actor, 'steal')} ${stolen} ${key} from ${target.name}.`);
        return stolen;
      },
      cleanse() {
        actor.weak = 0;
        actor.vulnerable = 0;
        actor.poison = 0;
        actor.bleed = 0;
        log(`${actor.name} ${conj(actor, 'cleanse')} all bad conditions.`);
      },
    };
  }

  function tickDot(actor, key, label) {
    if (actor[key] > 0) {
      const dmg = actor[key];
      actor.hp -= dmg;
      clampHp(actor);
      log(`${actor.name} ${conj(actor, 'take')} ${dmg} damage from ${label}.`);
      pushEvent(actor, 'damage', dmg);
      actor[key] -= 1;
    }
  }

  function newRun() {
    state.floor = 0;
    state.log = [];
    state.events = [];
    state.enemyReveal = null;
    state.pendingEcho = null;
    state.player = {
      name: 'You',
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      block: 0,
      strength: 0,
      weak: 0,
      vulnerable: 0,
      thorns: 0,
      poison: 0,
      bleed: 0,
      actions: PLAYER_ACTIONS,
      actionsMax: PLAYER_ACTIONS,
      bonusActionsNext: 0,
      gold: 0,
      masterDeck: Cards.STARTER_DECK.slice(),
      drawPile: [],
      hand: [],
      discardPile: [],
      turnPlayedTypes: [],
      turnPlayedCardIds: [],
    };
    log('A new run begins. Descend into the tower.');
    advanceFloor();
  }

  // Starts an actual fight against a freshly-generated enemy for the next floor.
  function advanceFloor() {
    state.floor += 1;
    const p = state.player;
    p.block = 0;
    p.strength = 0;
    p.weak = 0;
    p.vulnerable = 0;
    p.thorns = 0;
    p.poison = 0;
    p.bleed = 0;
    p.turnPlayedTypes = [];
    p.turnPlayedCardIds = [];
    p.drawPile = shuffle(p.masterDeck.map(Cards.createInstance));
    p.hand = [];
    p.discardPile = [];

    const enemy = Enemies.generate(state.floor);
    state.enemy = enemy;
    state.enemyReveal = null;
    state.pendingEcho = null;

    state.phase = 'playing';
    log(`Floor ${state.floor}: ${enemy.name} appears!${enemy.isBoss ? ' (BOSS)' : ''}`);
    startPlayerTurn();
  }

  const REWARD_INTERVAL = 3; // every 3rd non-boss floor guarantees a reward pick
  const BONUS_ENCOUNTER_CHANCE = 0.25; // otherwise, a rare chance at a tavern/shop/chest

  // Decides what happens after a normal (non-boss) kill that didn't land on a
  // guaranteed reward floor: most of the time nothing, just straight into the
  // next fight; occasionally a standalone tavern/shop/chest interrupts the climb.
  function triggerPostKillEvent() {
    if (Math.random() >= BONUS_ENCOUNTER_CHANCE) {
      advanceFloor();
      return;
    }
    const types = ['tavern', 'chest', 'shop'];
    const type = types[Math.floor(Math.random() * types.length)];
    const p = state.player;

    if (type === 'tavern') {
      const healAmount = Math.round(p.maxHp * 0.4);
      const before = p.hp;
      p.hp = Math.min(p.maxHp, p.hp + healAmount);
      const healed = p.hp - before;
      log(`You find a tavern and rest, healing ${healed} HP.`);
      state.bonusResult = { type: 'tavern', healed };
      state.phase = 'bonus';
    } else if (type === 'chest') {
      const cardId = pickRewardCardId();
      p.masterDeck.push(cardId);
      log(`You stumble on a chest containing ${Cards.get(cardId).name}!`);
      state.bonusResult = { type: 'chest', cardId };
      state.phase = 'bonus';
    } else {
      enterShop();
    }
  }

  function continueFromBonus() {
    if (state.phase !== 'bonus') return;
    state.bonusResult = null;
    advanceFloor();
  }

  const SHOP_BASE_PRICE = { common: 8, uncommon: 14, rare: 22 };

  function enterShop() {
    const priceMult = 1 + state.floor * 0.15;
    const usedIds = new Set();
    const offer = [];
    let attempts = 0;
    while (offer.length < 3 && attempts < 50) {
      attempts += 1;
      const id = pickRewardCardId();
      if (usedIds.has(id)) continue;
      usedIds.add(id);
      const rarity = Cards.get(id).rarity;
      const price = Math.round((SHOP_BASE_PRICE[rarity] || 10) * priceMult);
      offer.push({ cardId: id, price, bought: false });
    }
    state.shopOffer = offer;
    state.phase = 'shop';
  }

  function buyCard(index) {
    if (state.phase !== 'shop') return;
    const item = state.shopOffer[index];
    if (!item || item.bought) return;
    const p = state.player;
    if (p.gold < item.price) {
      log('Not enough gold.');
      return;
    }
    p.gold -= item.price;
    p.masterDeck.push(item.cardId);
    item.bought = true;
    log(`Bought ${Cards.get(item.cardId).name} for ${item.price} gold.`);
  }

  function leaveShop() {
    if (state.phase !== 'shop') return;
    state.shopOffer = [];
    advanceFloor();
  }

  function drawCards(n) {
    const p = state.player;
    for (let i = 0; i < n; i++) {
      if (p.hand.length >= MAX_HAND) break;
      if (p.drawPile.length === 0) {
        if (p.discardPile.length === 0) break;
        p.drawPile = shuffle(p.discardPile);
        p.discardPile = [];
        log('Shuffling discard pile into draw pile.');
      }
      p.hand.push(p.drawPile.pop());
    }
  }

  function startPlayerTurn() {
    const p = state.player;
    state.turn = 'player';
    state.enemyReveal = null;
    if (p.weak > 0) p.weak -= 1;
    if (p.vulnerable > 0) p.vulnerable -= 1;
    tickDot(p, 'poison', 'Poison');
    if (checkPlayerDeath()) return;
    p.actions = p.actionsMax + (p.bonusActionsNext || 0);
    p.bonusActionsNext = 0;
    p.turnPlayedTypes = [];
    p.turnPlayedCardIds = [];
    drawCards(Math.max(0, HAND_LIMIT - p.hand.length));
    log('Your turn.');
  }

  function playCard(handIndex) {
    if (state.phase !== 'playing' || state.turn !== 'player' || state.pendingEcho) return;
    const p = state.player;
    const inst = p.hand[handIndex];
    if (!inst) return;
    const card = Cards.get(inst.id);
    if (p.actions < card.cost) {
      log(`Not enough actions for ${card.name}.`);
      return;
    }
    p.actions -= card.cost;
    p.hand.splice(handIndex, 1);
    p.discardPile.push(inst);

    if (card.id === 'echo') {
      resolveEchoPlay(p);
    } else {
      const ctx = makeCtx(p, state.enemy, 1);
      card.play(ctx);
    }
    p.turnPlayedTypes.push(card.type);
    p.turnPlayedCardIds.push(card.id);

    if (checkEnemyDeath()) return;
    checkPlayerDeath(); // covers thorns reflecting lethal damage back onto the player
  }

  // Echo either resolves immediately (0 or 1 candidates) or opens a choice
  // for the player to pick which card played this turn to repeat.
  function resolveEchoPlay(p) {
    const candidates = Array.from(new Set(p.turnPlayedCardIds.filter((id) => id !== 'echo' && id !== 'mimic')));
    if (candidates.length === 0) {
      log('No card to echo yet.');
    } else if (candidates.length === 1) {
      const ctx = makeCtx(p, state.enemy, 1);
      Cards.get(candidates[0]).play(ctx);
    } else {
      state.pendingEcho = candidates;
    }
  }

  function resolveEchoChoice(cardId) {
    if (!state.pendingEcho || !state.pendingEcho.includes(cardId)) return;
    state.pendingEcho = null;
    const p = state.player;
    const ctx = makeCtx(p, state.enemy, 1);
    Cards.get(cardId).play(ctx);
    if (checkEnemyDeath()) return;
    checkPlayerDeath();
  }

  function endPlayerTurn() {
    if (state.phase !== 'playing' || state.turn !== 'player' || state.pendingEcho) return;
    const p = state.player;
    tickDot(p, 'bleed', 'Bleed');
    if (checkPlayerDeath()) return;
    state.turn = 'enemy';
    log(`${state.enemy.name} takes their turn.`);
  }

  // Steps the enemy's turn forward by one "beat" per call: first beat is
  // start-of-turn upkeep, then one beat per card the enemy plays (chosen
  // randomly from its move pool, revealed one at a time), then a final beat
  // for end-of-turn upkeep that hands control back to the player. The UI
  // calls this repeatedly with a delay between calls to animate each step.
  // Returns true once the enemy's turn (and any transition) is fully done.
  function stepEnemyTurn() {
    if (state.phase !== 'playing' || state.turn !== 'enemy') return true;
    const e = state.enemy;
    const p = state.player;

    if (e.cardsRemaining == null) {
      if (e.weak > 0) e.weak -= 1;
      if (e.vulnerable > 0) e.vulnerable -= 1;
      e.turnPlayedTypes = [];
      e.turnPlayedCardIds = [];
      tickDot(e, 'poison', 'Poison');
      if (checkEnemyDeath()) {
        e.cardsRemaining = null;
        return true;
      }
      e.cardsRemaining = e.cardsPerTurn;
      return false;
    }

    if (e.cardsRemaining > 0) {
      const cardId = e.pattern[Math.floor(Math.random() * e.pattern.length)];
      const card = Cards.get(cardId);
      state.enemyReveal = { cardId, mult: e.powerMult };
      const ctx = makeCtx(e, p, e.powerMult);
      card.play(ctx);
      e.turnPlayedTypes.push(card.type);
      e.turnPlayedCardIds.push(cardId);
      e.cardsRemaining -= 1;

      if (checkPlayerDeath()) {
        e.cardsRemaining = null;
        return true;
      }
      if (checkEnemyDeath()) {
        e.cardsRemaining = null;
        return true;
      }
      return false;
    }

    state.enemyReveal = null;
    tickDot(e, 'bleed', 'Bleed');
    e.cardsRemaining = null;
    if (checkEnemyDeath()) return true;

    startPlayerTurn();
    return true;
  }

  function checkEnemyDeath() {
    if (state.enemy.hp <= 0) {
      const enemy = state.enemy;
      const bonusGold = randInt(enemy.isBoss ? 8 : 3, enemy.isBoss ? 15 : 6);
      state.player.gold += bonusGold;
      log(`${enemy.name} is defeated! You find ${bonusGold} gold.`);

      if (enemy.isBoss || state.floor % REWARD_INTERVAL === 0) {
        state.phase = 'reward';
        state.rewardOptions = rollRewards(enemy);
      } else {
        triggerPostKillEvent();
      }
      return true;
    }
    return false;
  }

  function checkPlayerDeath() {
    if (state.player.hp <= 0) {
      log('You have fallen. Run over.');
      state.phase = 'gameover';
      return true;
    }
    return false;
  }

  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  const RARITY_BASE_WEIGHT = { common: 10, uncommon: 6, rare: 3 };

  function pickRewardCardId() {
    const colors = Object.values(Cards.COLOR);
    const color = colors[Math.floor(Math.random() * colors.length)];
    const pool = Object.keys(Cards.LIBRARY).filter((id) => {
      const c = Cards.get(id);
      return c.rarity !== 'starter' && c.color === color;
    });
    const weighted = [];
    pool.forEach((id) => {
      const c = Cards.get(id);
      const rareBonus = c.rarity === 'rare' ? state.floor * 0.4 : 0;
      const weight = Math.max(1, Math.round((RARITY_BASE_WEIGHT[c.rarity] || 5) + rareBonus));
      for (let i = 0; i < weight; i++) weighted.push(id);
    });
    return weighted[Math.floor(Math.random() * weighted.length)];
  }

  function rollRewards(enemy) {
    let cardId;
    if (enemy.isBoss) {
      const bossPool = Array.from(new Set(enemy.pattern));
      cardId = bossPool[Math.floor(Math.random() * bossPool.length)];
    } else {
      cardId = pickRewardCardId();
    }
    const goldAmount = enemy.isBoss ? randInt(40, 60) : randInt(10, 20);
    const healAmount = enemy.isBoss
      ? Math.round(state.player.maxHp * 0.5)
      : Math.round(state.player.maxHp * 0.2);

    return [
      { type: 'card', cardId },
      { type: 'heal', amount: healAmount },
      { type: 'gold', amount: goldAmount },
    ];
  }

  function chooseReward(index) {
    if (state.phase !== 'reward') return;
    const p = state.player;
    const opt = index === null || index === undefined ? null : state.rewardOptions[index];
    if (opt) {
      if (opt.type === 'card') {
        p.masterDeck.push(opt.cardId);
        log(`Added ${Cards.get(opt.cardId).name} to your deck.`);
      } else if (opt.type === 'heal') {
        p.hp = Math.min(p.maxHp, p.hp + opt.amount);
        log(`Restored ${opt.amount} HP.`);
      } else if (opt.type === 'gold') {
        p.gold += opt.amount;
        log(`Found ${opt.amount} gold.`);
      }
    }
    advanceFloor();
  }

  global.DB = global.DB || {};
  global.DB.Game = {
    state,
    newRun,
    playCard,
    resolveEchoChoice,
    endPlayerTurn,
    stepEnemyTurn,
    chooseReward,
    continueFromBonus,
    buyCard,
    leaveShop,
  };
})(window);
