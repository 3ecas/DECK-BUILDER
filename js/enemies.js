// Enemy archetypes. Each has its own small "deck" (a pool of cards it draws from
// at random each turn, rather than a fixed telegraphed sequence).
(function (global) {
  const DEFAULT_CARDS_PER_TURN = 2;

  const NORMAL = [
    { key: 'imp', name: 'Imp', emoji: '👹', hp: 5, pattern: ['strike', 'strike', 'guard'] },
    { key: 'cultist', name: 'Cultist', emoji: '🧙', hp: 6, pattern: ['weaken', 'rend', 'strike'] },
    { key: 'brute', name: 'Brute', emoji: '🗿', hp: 7, pattern: ['heavy_slash', 'guard'] },
    { key: 'shade', name: 'Shade', emoji: '👻', hp: 7, pattern: ['expose', 'fireball'] },
    { key: 'warlock', name: 'Warlock', emoji: '🔮', hp: 8, pattern: ['fireball', 'weaken', 'fireball'] },
    { key: 'juggernaut', name: 'Juggernaut', emoji: '🛡️', hp: 10, pattern: ['spikes', 'heavy_slash'] },
  ];

  const BOSSES = [
    { key: 'warden', name: 'The Warden', emoji: '😈', hp: 10, pattern: ['heavy_slash', 'fireball', 'iron_wall'] },
    { key: 'abyssal_knight', name: 'Abyssal Knight', emoji: '💀', hp: 16, pattern: ['rampage', 'heavy_slash', 'guard'] },
  ];

  function generate(floor) {
    const isBoss = floor % 5 === 0;
    const pool = isBoss ? BOSSES : NORMAL;
    // Subtract completed boss floors so every normal archetype still cycles evenly
    // instead of some slots being skipped whenever a boss floor lands on them.
    const idx = isBoss
      ? Math.floor(floor / 5 - 1) % pool.length
      : (floor - 1 - Math.floor(floor / 5)) % pool.length;
    const template = pool[idx];

    const hpMult = 1 + (floor - 1) * (isBoss ? 0.15 : 0.22);
    const powerMult = 1 + (floor - 1) * 0.13;
    const maxHp = Math.round(template.hp * hpMult);

    return {
      name: template.name,
      emoji: template.emoji,
      isBoss,
      hp: maxHp,
      maxHp,
      block: 0,
      strength: 0,
      weak: 0,
      vulnerable: 0,
      thorns: 0,
      poison: 0,
      bleed: 0,
      powerMult,
      pattern: template.pattern,
      // Enemies stay simple (1 card/turn) until the first boss floor, then
      // ramp up to their normal (or archetype-specific) rate.
      cardsPerTurn: floor < 5 ? 1 : (template.cardsPerTurn || DEFAULT_CARDS_PER_TURN),
      cardsRemaining: null,
      turnPlayedTypes: [],
      turnPlayedCardIds: [],
    };
  }

  global.DB = global.DB || {};
  global.DB.Enemies = { generate };
})(window);
