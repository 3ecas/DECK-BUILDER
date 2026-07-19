// Loads units.csv — the auto-battler's unit catalogue.
//
// Columns: id, name, emoji, tier, cost, hp, dmg, range, atk_speed, move_speed,
//          color, shield, ability, slots
//   tier        1-7. Drives the shop odds (see ab-game.js ODDS).
//   cost        gold to buy. Defaults to tier if blank.
//   hp / dmg    base ★1 stats. ★2 doubles both, ★3 doubles again.
//   range       in hexes. 1 = melee (must be adjacent), 2+ = shoots from afar.
//   atk_speed   attacks per SECOND — 1 = one hit/s, 0.5 = one hit every 2s.
//   move_speed  hexes per second.
//   ability     special behaviour: "key arg1 arg2" (implemented in ab-game.js)
//   slots       board slots the unit occupies (Titan takes 2). Default 1.
//
// Edit units.csv and reload — no code changes needed to add or retune a unit.
(function (global) {
  const UNITS = {};
  const ALL_IDS = [];
  let problems = [];

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const s = String(text || '').replace(/^﻿/, ''); // strip Excel's BOM

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') {
            field += '"';
            i++;
          } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (c !== '\r') field += c;
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows
      .map((r) => r.map((f) => f.trim()))
      .filter((r) => r.length && r.some((f) => f !== '') && !r[0].startsWith('#'));
  }

  function load(text) {
    problems = [];
    Object.keys(UNITS).forEach((k) => delete UNITS[k]);
    ALL_IDS.length = 0;

    const rows = parseCsv(text);
    if (!rows.length) {
      problems.push('units.csv has no rows.');
      return { ok: false, problems };
    }
    if (String(rows[0][0]).toLowerCase() === 'id') rows.shift();

    const num = (v, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) && v !== '' ? n : dflt;
    };

    rows.forEach((c) => {
      const id = c[0];
      if (!id) return;
      if (UNITS[id]) problems.push(`Duplicate unit id "${id}" — the later one wins.`);
      const tier = Math.max(1, Math.min(7, num(c[3], 1)));
      // "heal_wounded 3 20" -> { key: 'heal_wounded', args: [3, 20] }
      const abilityText = (c[12] || '').trim();
      let ability = null;
      if (abilityText) {
        const parts = abilityText.split(/\s+/);
        ability = { key: parts[0].toLowerCase(), args: parts.slice(1).map(Number) };
      }
      const u = {
        id,
        name: c[1] || id,
        emoji: c[2] || '❓',
        tier,
        cost: num(c[4], tier),
        hp: Math.max(1, num(c[5], 1)),
        dmg: Math.max(0, num(c[6], 1)),
        range: Math.max(1, num(c[7], 1)),
        atkSpeed: Math.min(5, Math.max(0.1, num(c[8], 0.5))), // attacks/second
        moveSpeed: Math.max(0.1, num(c[9], 2.5)),
        color: (c[10] || 'grey').toLowerCase(),
        shield: Math.max(0, num(c[11], 0)), // flat damage deflected per hit
        ability,
        slots: Math.max(1, num(c[13], 1)), // board slots occupied
      };
      UNITS[id] = u;
    });

    ALL_IDS.push(...Object.keys(UNITS));
    if (!ALL_IDS.length) problems.push('No usable units found in units.csv.');
    if (problems.length) {
      console.warn(`[units] ${problems.length} note(s) from units.csv:\n - ${problems.join('\n - ')}`);
    }
    return { ok: ALL_IDS.length > 0, problems };
  }

  global.ABUnits = {
    UNITS,
    ALL_IDS,
    load,
    parseCsv,
    get: (id) => UNITS[id],
    get problems() {
      return problems;
    },
  };
})(window);
