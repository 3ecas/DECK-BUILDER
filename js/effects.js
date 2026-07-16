// ============================================================================
//  EFFECT REGISTRY — the "effects tree"
//
//  ONE implementation per KEYWORD. Never one script per card.
//
//  A card picks keywords (with numbers) in the `modifiers` column of cards.csv:
//
//      flame_trail 1                 burn everything ahead for 1 on deploy
//      aura_ahead 2 20               friendlies up to 20 ahead get +2
//      swarm 3; bonus_vs red 2       stack as many as you like, separated by ;
//
//  So a new card that reuses existing keywords needs NO code — just a new row
//  in the spreadsheet. You only touch this file to invent a genuinely new
//  *kind* of behaviour, and then every card can use it.
//
//  ---- WHY EFFECTS STACK SAFELY ----
//
//  A unit's fighting power is never permanently mutated by a buff. Instead:
//
//      power = hp (current, real damage lives here)
//            + buffs   (recomputed from scratch EVERY tick by auras)
//            + power() hooks (computed fresh at each clash)
//
//  Because auras are wiped and re-applied every tick, any number of buffs and
//  debuffs from any number of sources combine with no ordering bugs and no
//  leftovers when a source dies or walks away.
//
//  ---- HOOKS an effect may implement ----
//
//   copies(args)                 -> number   how many units this card deploys
//   onDeploy(self, args, api)              fires once, when the unit lands
//   onDeath(self, args, api)               fires once, after the unit is removed
//   aura(self, args, api)                  every tick: buff/debuff other units
//   power(self, foe, args, api)  -> number  bonus power. `foe` is null when the
//                                           unit is hitting a wall.
//
//  ---- the `api` handed to every hook ----
//
//   api.alliesAhead(self, dist)   api.enemiesAhead(self, dist)   (dist optional)
//   api.alliesNear(self, dist)    api.enemiesNear(self, dist)    (either direction)
//   api.damage(unit, n)           api.addBuff(unit, n)
//   api.colorOf(unit)             api.log(msg)   api.flash(lane, pos, text)
// ============================================================================
(function (global) {
  const num = (v, fallback) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : fallback;
  };

  const EFFECTS = {
    swarm: {
      doc: 'swarm N — deploy N copies of this unit at once.',
      copies: (args) => Math.max(1, Math.floor(num(args[0], 1))),
    },

    bonus_vs: {
      doc: 'bonus_vs <color> N — +N power while clashing against a <color> unit.',
      power: (self, foe, args, api) => (foe && api.colorOf(foe) === args[0] ? num(args[1], 0) : 0),
    },

    flame_trail: {
      doc: 'flame_trail N [D] — on deploy, burn every enemy ahead in this lane for N (within D, or the whole lane).',
      onDeploy: (self, args, api) => {
        const dmg = num(args[0], 1);
        const dist = args[1] === undefined ? undefined : num(args[1], undefined);
        const hit = api.enemiesAhead(self, dist);
        if (!hit.length) return;
        hit.forEach((foe) => api.damage(foe, dmg));
        api.flash(self.lane, self.pos, `🔥${dmg}`);
      },
    },

    aura_ahead: {
      doc: 'aura_ahead N D — friendly units up to D ahead get +N power while this unit lives.',
      aura: (self, args, api) => {
        const amount = num(args[0], 0);
        const dist = num(args[1], 0);
        api.alliesAhead(self, dist).forEach((ally) => api.addBuff(ally, amount));
      },
    },

    aura_weaken: {
      doc: 'aura_weaken N D — enemy units within D ahead get -N power while this unit lives.',
      aura: (self, args, api) => {
        const amount = num(args[0], 0);
        const dist = num(args[1], 0);
        api.enemiesAhead(self, dist).forEach((foe) => api.addBuff(foe, -amount));
      },
    },

    buff_ahead: {
      doc: 'buff_ahead N [D] — on deploy, PERMANENTLY give the nearest friendly ahead +N hp (within D, or anywhere in the lane). Unlike aura_ahead this is a one-shot gift: it sticks even after this unit dies.',
      onDeploy: (self, args, api) => {
        const amount = num(args[0], 1);
        const dist = args[1] === undefined ? undefined : num(args[1], undefined);
        const target = api.alliesAhead(self, dist)[0]; // nearest ahead = "the one in front"
        if (!target) return;
        api.buffPermanent(target, amount);
        api.flash(target.lane, target.pos, `+${amount}`);
      },
    },

    dash: {
      doc: 'dash M S — on deploy, move at M× the baseline speed for S seconds.',
      onDeploy: (self, args, api) => {
        api.setSpeed(self, num(args[0], 2), num(args[1], 4));
        api.flash(self.lane, self.pos, '💨');
      },
    },

    summon_lanes: {
      doc: 'summon_lanes H — on deploy, summon a copy of this unit into every OTHER lane with H hp. Summons are tokens: they never return a card to the deck and never re-trigger this effect.',
      onDeploy: (self, args, api) => {
        const hp = num(args[0], 1);
        api.otherLanes(self).forEach((lane) => api.summon(self, { lane, hp }));
      },
    },

    death_blast: {
      doc: 'death_blast N D — when this unit dies it explodes, dealing N to every enemy within D.',
      onDeath: (self, args, api) => {
        const dmg = num(args[0], 1);
        const dist = num(args[1], 10);
        const hit = api.enemiesNear(self, dist);
        if (!hit.length) return;
        hit.forEach((foe) => api.damage(foe, dmg));
        api.flash(self.lane, self.pos, `💥${dmg}`);
      },
    },
  };

  const KEYWORDS = Object.keys(EFFECTS);

  // Every hook of a given name that a card declares, with its parsed args.
  // Cards hold `modifiers: [{ key, args }]` (parsed in units.js).
  function hooksFor(card, hookName) {
    if (!card || !card.modifiers) return [];
    const out = [];
    card.modifiers.forEach((m) => {
      const fx = EFFECTS[m.key];
      if (fx && typeof fx[hookName] === 'function') out.push({ fn: fx[hookName], args: m.args });
    });
    return out;
  }

  function has(card, hookName) {
    return hooksFor(card, hookName).length > 0;
  }

  // How many units this card puts on the field (swarm, or 1).
  function deployCount(card) {
    const hooks = hooksFor(card, 'copies');
    return hooks.length ? hooks[0].fn(hooks[0].args) : 1;
  }

  global.RTS = global.RTS || {};
  global.RTS.Effects = { EFFECTS, KEYWORDS, hooksFor, has, deployCount };
})(window);
