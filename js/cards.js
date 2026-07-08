// Card library: every card in the game (player starter cards + reward pool + enemy cards
// all share the same definitions, so enemies genuinely "play from a deck" too).
//
// Rule: Attack and Defense cards are free (cost 0) and are limited only by hand size.
// Strategy cards cost Actions - the one resource that's scarce each turn.
//
// `color` is a separate archetype tag (independent of `type`) used for the reward
// rotation and card art: red = attack/bleed, green = poison, blue = defense,
// yellow = healing, grey = generic strategy (draw/actions/debuffs).
(function (global) {
  const TYPE = { ATTACK: 'attack', DEFENSE: 'defense', STRATEGY: 'strategy' };
  const COLOR = { RED: 'red', GREEN: 'green', BLUE: 'blue', YELLOW: 'yellow', GREY: 'grey' };

  const r = (n, mult) => Math.round(n * mult);

  const LIBRARY = {
    // ---------------- RED (attack + bleed) ----------------
    strike: {
      id: 'strike', name: 'Strike', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'starter',
      desc: (m = 1) => `Deal ${r(1, m)} damage.`,
      play(ctx) { ctx.attack(1); },
    },
    quick_jab: {
      id: 'quick_jab', name: 'Quick Jab', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'starter',
      desc: (m = 1) => `Deal ${r(1, m)} damage.`,
      play(ctx) { ctx.attack(1); },
    },
    heavy_slash: {
      id: 'heavy_slash', name: 'Heavy Slash', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'common',
      desc: (m = 1) => `Deal ${r(2, m)} damage.`,
      play(ctx) { ctx.attack(2); },
    },
    double_strike: {
      id: 'double_strike', name: 'Double Strike', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'common',
      desc: (m = 1) => `Deal ${r(1, m)} damage twice.`,
      play(ctx) { ctx.attack(1); ctx.attack(1); },
    },
    fireball: {
      id: 'fireball', name: 'Fireball', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'common',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Apply 1 Vulnerable.`,
      play(ctx) { ctx.attack(1); ctx.status('enemy', 'vulnerable', 1); },
    },
    backstab: {
      id: 'backstab', name: 'Backstab', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'uncommon',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Deal ${r(2, m)} instead if enemy is Vulnerable.`,
      play(ctx) { ctx.attack(ctx.targetHasStatus('vulnerable') ? 2 : 1); },
    },
    combo_strike: {
      id: 'combo_strike', name: 'Combo Strike', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'uncommon',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Deal ${r(2, m)} instead if you already played an Attack card this turn.`,
      play(ctx) { ctx.attack(ctx.hasPlayedType(TYPE.ATTACK) ? 2 : 1); },
    },
    execute: {
      id: 'execute', name: 'Execute', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'uncommon',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Deal ${r(4, m)} instead if enemy is below 30% HP.`,
      play(ctx) { ctx.attack(ctx.targetHpPercent() <= 0.3 ? 4 : 1); },
    },
    rampage: {
      id: 'rampage', name: 'Rampage', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'rare',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Gain 1 Strength for the rest of combat.`,
      play(ctx) { ctx.attack(1); ctx.status('self', 'strength', 1); },
    },
    rend: {
      id: 'rend', name: 'Rend', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'common',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Apply 2 Bleed.`,
      play(ctx) { ctx.attack(1); ctx.status('enemy', 'bleed', 2); },
    },
    onslaught: {
      id: 'onslaught', name: 'Onslaught', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'rare',
      desc: () => `Deal 1 damage for each Attack card played this turn (including this one).`,
      play(ctx) { ctx.attack(ctx.countPlayedType(TYPE.ATTACK) + 1); },
    },
    hemorrhage: {
      id: 'hemorrhage', name: 'Hemorrhage', type: TYPE.STRATEGY, color: COLOR.RED, cost: 1, rarity: 'uncommon',
      desc: () => `Apply 4 Bleed to enemy.`,
      play(ctx) { ctx.status('enemy', 'bleed', 4); },
    },
    plunder: {
      id: 'plunder', name: 'Plunder', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'common',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Steal up to 2 Block from enemy.`,
      play(ctx) { ctx.attack(1); ctx.steal('block', 2); },
    },
    frenzy: {
      id: 'frenzy', name: 'Frenzy', type: TYPE.ATTACK, color: COLOR.RED, cost: 0, rarity: 'rare',
      desc: () => `Deal 1 damage for each card played this turn (including this one).`,
      play(ctx) { ctx.attack(ctx.playedCountThisTurn() + 1); },
    },

    // ---------------- GREEN (poison) ----------------
    venom_strike: {
      id: 'venom_strike', name: 'Venom Strike', type: TYPE.ATTACK, color: COLOR.GREEN, cost: 0, rarity: 'common',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Apply 2 Poison.`,
      play(ctx) { ctx.attack(1); ctx.status('enemy', 'poison', 2); },
    },
    plague: {
      id: 'plague', name: 'Plague', type: TYPE.ATTACK, color: COLOR.GREEN, cost: 0, rarity: 'rare',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Apply 3 Poison.`,
      play(ctx) { ctx.attack(1); ctx.status('enemy', 'poison', 3); },
    },
    toxic_cloud: {
      id: 'toxic_cloud', name: 'Toxic Cloud', type: TYPE.STRATEGY, color: COLOR.GREEN, cost: 1, rarity: 'uncommon',
      desc: () => `Apply 3 Poison to enemy.`,
      play(ctx) { ctx.status('enemy', 'poison', 3); },
    },
    infect: {
      id: 'infect', name: 'Infect', type: TYPE.STRATEGY, color: COLOR.GREEN, cost: 1, rarity: 'uncommon',
      desc: () => `Apply 2 Poison to enemy. Draw 1 card.`,
      play(ctx) { ctx.status('enemy', 'poison', 2); ctx.drawSelf(1); },
    },
    corrosion: {
      id: 'corrosion', name: 'Corrosion', type: TYPE.STRATEGY, color: COLOR.GREEN, cost: 1, rarity: 'rare',
      desc: () => `Apply 2 Poison and 1 Vulnerable to enemy.`,
      play(ctx) { ctx.status('enemy', 'poison', 2); ctx.status('enemy', 'vulnerable', 1); },
    },

    // ---------------- BLUE (defense) ----------------
    guard: {
      id: 'guard', name: 'Guard', type: TYPE.DEFENSE, color: COLOR.BLUE, cost: 0, rarity: 'starter',
      desc: (m = 1) => `Gain ${r(1, m)} Block.`,
      play(ctx) { ctx.block(1); },
    },
    iron_wall: {
      id: 'iron_wall', name: 'Iron Wall', type: TYPE.DEFENSE, color: COLOR.BLUE, cost: 0, rarity: 'common',
      desc: (m = 1) => `Gain ${r(3, m)} Block.`,
      play(ctx) { ctx.block(3); },
    },
    parry: {
      id: 'parry', name: 'Parry', type: TYPE.DEFENSE, color: COLOR.BLUE, cost: 0, rarity: 'common',
      desc: (m = 1) => `Gain ${r(1, m)} Block. Deal ${r(1, m)} damage.`,
      play(ctx) { ctx.block(1); ctx.attack(1); },
    },
    fortify: {
      id: 'fortify', name: 'Fortify', type: TYPE.DEFENSE, color: COLOR.BLUE, cost: 0, rarity: 'uncommon',
      desc: (m = 1) => `Gain ${r(1, m)} Block. Gain ${r(2, m)} instead if you already played a Defense card this turn.`,
      play(ctx) { ctx.block(ctx.hasPlayedType(TYPE.DEFENSE) ? 2 : 1); },
    },
    second_wind: {
      id: 'second_wind', name: 'Second Wind', type: TYPE.DEFENSE, color: COLOR.BLUE, cost: 0, rarity: 'uncommon',
      desc: (m = 1) => `Gain ${r(1, m)} Block. Draw 1 card.`,
      play(ctx) { ctx.block(1); ctx.drawSelf(1); },
    },
    spike_shield: {
      id: 'spike_shield', name: 'Spike Shield', type: TYPE.DEFENSE, color: COLOR.BLUE, cost: 0, rarity: 'uncommon',
      desc: (m = 1) => `Gain ${r(1, m)} Block. Apply 1 Weak to enemy.`,
      play(ctx) { ctx.block(1); ctx.status('enemy', 'weak', 1); },
    },
    meditate: {
      id: 'meditate', name: 'Meditate', type: TYPE.DEFENSE, color: COLOR.BLUE, cost: 0, rarity: 'rare',
      desc: (m = 1) => `Gain ${r(1, m)} Block. Gain 1 extra Action next turn.`,
      play(ctx) { ctx.block(1); ctx.bonusActionsNextTurn(1); },
    },
    spikes: {
      id: 'spikes', name: 'Spikes', type: TYPE.DEFENSE, color: COLOR.BLUE, cost: 0, rarity: 'uncommon',
      desc: (m = 1) => `Gain ${r(1, m)} Block. Gain 2 Thorns for the rest of combat (reflect damage when attacked).`,
      play(ctx) { ctx.block(1); ctx.status('self', 'thorns', 2); },
    },
    bulwark: {
      id: 'bulwark', name: 'Bulwark', type: TYPE.DEFENSE, color: COLOR.BLUE, cost: 0, rarity: 'common',
      desc: (m = 1) => `Gain ${r(2, m)} Block.`,
      play(ctx) { ctx.block(2); },
    },
    aegis: {
      id: 'aegis', name: 'Aegis', type: TYPE.DEFENSE, color: COLOR.BLUE, cost: 0, rarity: 'rare',
      desc: (m = 1) => `Gain ${r(1, m)} Block. Gain 2 Thorns for the rest of combat.`,
      play(ctx) { ctx.block(1); ctx.status('self', 'thorns', 2); },
    },

    // ---------------- YELLOW (healing / strategic healing) ----------------
    regroup: {
      id: 'regroup', name: 'Regroup', type: TYPE.STRATEGY, color: COLOR.YELLOW, cost: 1, rarity: 'rare',
      desc: () => `Heal 2 HP.`,
      play(ctx) { ctx.heal(2); },
    },
    vampiric_strike: {
      id: 'vampiric_strike', name: 'Vampiric Strike', type: TYPE.ATTACK, color: COLOR.YELLOW, cost: 0, rarity: 'uncommon',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Heal 1 HP.`,
      play(ctx) { ctx.attack(1); ctx.heal(1); },
    },
    renew: {
      id: 'renew', name: 'Renew', type: TYPE.STRATEGY, color: COLOR.YELLOW, cost: 1, rarity: 'uncommon',
      desc: () => `Heal 3 HP. Draw 1 card.`,
      play(ctx) { ctx.heal(3); ctx.drawSelf(1); },
    },
    mend: {
      id: 'mend', name: 'Mend', type: TYPE.DEFENSE, color: COLOR.YELLOW, cost: 0, rarity: 'common',
      desc: (m = 1) => `Gain ${r(1, m)} Block. Heal 1 HP.`,
      play(ctx) { ctx.block(1); ctx.heal(1); },
    },
    cleanse: {
      id: 'cleanse', name: 'Cleanse', type: TYPE.STRATEGY, color: COLOR.YELLOW, cost: 1, rarity: 'uncommon',
      desc: () => `Remove all Weak, Vulnerable, Poison, and Bleed from yourself.`,
      play(ctx) { ctx.cleanse(); },
    },
    purify: {
      id: 'purify', name: 'Purify', type: TYPE.DEFENSE, color: COLOR.YELLOW, cost: 0, rarity: 'rare',
      desc: (m = 1) => `Gain ${r(1, m)} Block. Remove all Weak, Vulnerable, Poison, and Bleed from yourself.`,
      play(ctx) { ctx.block(1); ctx.cleanse(); },
    },
    recovery: {
      id: 'recovery', name: 'Recovery', type: TYPE.STRATEGY, color: COLOR.YELLOW, cost: 1, rarity: 'uncommon',
      desc: () => `Heal 1 HP for each card played this turn (including this one).`,
      play(ctx) { ctx.heal(ctx.playedCountThisTurn() + 1); },
    },
    sustain: {
      id: 'sustain', name: 'Sustain', type: TYPE.DEFENSE, color: COLOR.YELLOW, cost: 0, rarity: 'common',
      desc: (m = 1) => `Gain ${r(1, m)} Block. Heal 1 HP if you already played a Defense card this turn.`,
      play(ctx) { ctx.block(1); if (ctx.hasPlayedType(TYPE.DEFENSE)) ctx.heal(1); },
    },

    // ---------------- GREY (strategy: draw / actions / debuffs) ----------------
    focus: {
      id: 'focus', name: 'Focus', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 1, rarity: 'starter',
      desc: () => `Draw 2 cards.`,
      play(ctx) { ctx.drawSelf(2); },
    },
    adrenaline: {
      id: 'adrenaline', name: 'Adrenaline', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 0, rarity: 'common',
      desc: () => `Gain 1 Action. Draw 1 card.`,
      play(ctx) { ctx.gainActions(1); ctx.drawSelf(1); },
    },
    weaken: {
      id: 'weaken', name: 'Weaken', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 1, rarity: 'common',
      desc: () => `Apply 2 Weak to enemy (reduces their damage).`,
      play(ctx) { ctx.status('enemy', 'weak', 2); },
    },
    expose: {
      id: 'expose', name: 'Expose', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 1, rarity: 'common',
      desc: () => `Apply 2 Vulnerable to enemy (increases damage they take).`,
      play(ctx) { ctx.status('enemy', 'vulnerable', 2); },
    },
    preparation: {
      id: 'preparation', name: 'Preparation', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 0, rarity: 'uncommon',
      desc: () => `Draw 1 card. Gain 1 Action.`,
      play(ctx) { ctx.drawSelf(1); ctx.gainActions(1); },
    },
    overload: {
      id: 'overload', name: 'Overload', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 0, rarity: 'uncommon',
      desc: () => `Gain 1 Action.`,
      play(ctx) { ctx.gainActions(1); },
    },
    overdrive: {
      id: 'overdrive', name: 'Overdrive', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 0, rarity: 'rare',
      desc: () => `Gain 2 Actions.`,
      play(ctx) { ctx.gainActions(2); },
    },
    battle_trance: {
      id: 'battle_trance', name: 'Battle Trance', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 2, rarity: 'rare',
      desc: () => `Draw 3 cards.`,
      play(ctx) { ctx.drawSelf(3); },
    },
    finisher: {
      id: 'finisher', name: 'Finisher', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 1, rarity: 'rare',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Deal ${r(3, m)} instead if you've played 2+ cards this turn.`,
      play(ctx) { ctx.attack(ctx.playedCountThisTurn() >= 2 ? 3 : 1); },
    },
    reckoning: {
      id: 'reckoning', name: 'Reckoning', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 1, rarity: 'uncommon',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Deal ${r(4, m)} instead if you've played 3+ cards this turn.`,
      play(ctx) { ctx.attack(ctx.playedCountThisTurn() >= 3 ? 4 : 1); },
    },
    usurp: {
      id: 'usurp', name: 'Usurp', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 1, rarity: 'rare',
      desc: () => `Steal up to 2 Strength from enemy.`,
      play(ctx) { ctx.steal('strength', 2); },
    },
    mimic: {
      id: 'mimic', name: 'Mimic', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 1, rarity: 'uncommon',
      desc: () => `Repeat the effect of the last card you played this turn.`,
      play(ctx) {
        const id = ctx.lastPlayedCardId();
        if (id) LIBRARY[id].play(ctx);
      },
    },
    echo: {
      id: 'echo', name: 'Echo', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 1, rarity: 'rare',
      desc: () => `Choose and repeat the effect of a card you've played this turn.`,
      play(ctx) {
        const id = ctx.lastPlayedCardId();
        if (id) LIBRARY[id].play(ctx);
      },
    },
    loot: {
      id: 'loot', name: 'Loot', type: TYPE.STRATEGY, color: COLOR.GREY, cost: 0, rarity: 'common',
      desc: () => `Gain 2 Gold.`,
      play(ctx) { ctx.gainGold(2); },
    },
    greedy_strike: {
      id: 'greedy_strike', name: 'Greedy Strike', type: TYPE.ATTACK, color: COLOR.GREY, cost: 0, rarity: 'uncommon',
      desc: (m = 1) => `Deal ${r(1, m)} damage. Gain 1 Gold.`,
      play(ctx) { ctx.attack(1); ctx.gainGold(1); },
    },
  };

  function createInstance(id) {
    createInstance._uid = (createInstance._uid || 0) + 1;
    return { uid: createInstance._uid, id };
  }

  const STARTER_DECK = [
    'strike', 'strike', 'strike', 'strike',
    'guard', 'guard', 'guard', 'guard',
    'quick_jab', 'focus',
  ];

  global.DB = global.DB || {};
  global.DB.Cards = { TYPE, COLOR, LIBRARY, STARTER_DECK, createInstance, get: (id) => LIBRARY[id] };
})(window);
