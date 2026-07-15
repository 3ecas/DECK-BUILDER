// Turns the cards.csv catalogue into the unit library the game uses.
// You shouldn't need to edit this file to add cards — edit cards.csv.
(function (global) {
  const VALID_COLORS = ['red', 'green', 'blue', 'yellow', 'grey'];
  const VALID_RARITIES = ['normal', 'rare', 'special', 'ultimate'];

  // Modifier keywords the engine implements. Anything else in the modifiers
  // column still parses (so the game runs), but gets reported so you know it's
  // written down and not yet wired up.
  const KNOWN_MODIFIERS = {
    swarm: 'Deploys N copies at once.',
    bonus_vs: 'Gains +N hp while clashing against a <color> unit.',
  };

  // Filled in by load(); other modules hold a reference to these objects, so
  // they're mutated in place rather than reassigned.
  const UNITS = {};
  const ALL_IDS = [];
  const STARTER_COLLECTION = [];
  let problems = [];

  /* ---------------- CSV ---------------- */

  // Proper CSV: handles quoted fields, escaped "" quotes, and commas inside
  // quotes — so a card called `Bob, the Destroyer` survives.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const s = text.replace(/^﻿/, ''); // strip BOM Excel adds

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (c !== '\r') {
        field += c;
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows
      .map((r) => r.map((f) => f.trim()))
      .filter((r) => r.length && r.some((f) => f !== '') && !r[0].startsWith('#'));
  }

  // "swarm 3; bonus_vs red 2" -> [{key:'swarm',args:['3']}, ...]
  function parseModifiers(text, id) {
    if (!text) return [];
    return text
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((chunk) => {
        const parts = chunk.split(/\s+/);
        const key = parts[0].toLowerCase();
        if (!KNOWN_MODIFIERS[key]) {
          problems.push(`"${id}" uses modifier "${key}", which isn't implemented yet — it will do nothing.`);
        }
        return { key, args: parts.slice(1), raw: chunk };
      });
  }

  function truthy(v) {
    return /^(y|yes|true|1|x)$/i.test(String(v || '').trim());
  }

  /* ---------------- load ---------------- */

  function load(csvText) {
    problems = [];
    Object.keys(UNITS).forEach((k) => delete UNITS[k]);
    ALL_IDS.length = 0;
    STARTER_COLLECTION.length = 0;

    const rows = parseCsv(csvText);
    if (!rows.length) {
      problems.push('cards.csv has no rows.');
      return { ok: false, problems };
    }
    // drop the header row if present
    if (rows[0][0].toLowerCase() === 'id') rows.shift();

    rows.forEach((cols) => {
      if (cols.length < 7) {
        problems.push(`Row needs at least 7 columns, got ${cols.length}: "${cols.join(',')}"`);
        return;
      }
      const [id, name, emoji, mana, hp, color, rarity] = cols;
      if (!id) return;
      if (UNITS[id]) problems.push(`Duplicate card id "${id}" — the later one wins.`);

      const card = {
        id,
        name,
        emoji,
        mana: Number(mana),
        hp: Number(hp),
        color: String(color || '').toLowerCase(),
        rarity: String(rarity || '').toLowerCase(),
        modifiers: parseModifiers(cols[7] || '', id),
      };
      if (!Number.isFinite(card.mana) || card.mana < 0) problems.push(`"${id}" has a bad mana value: "${mana}"`);
      if (!Number.isFinite(card.hp) || card.hp <= 0) problems.push(`"${id}" has a bad hp value: "${hp}"`);
      if (!VALID_COLORS.includes(card.color)) {
        problems.push(`"${id}" has unknown color "${color}" — using grey.`);
        card.color = 'grey';
      }
      if (!VALID_RARITIES.includes(card.rarity)) {
        problems.push(`"${id}" has unknown rarity "${rarity}" — using normal.`);
        card.rarity = 'normal';
      }
      UNITS[id] = card;
      if (truthy(cols[8])) STARTER_COLLECTION.push(id);
    });

    ALL_IDS.push(...Object.keys(UNITS));

    if (!ALL_IDS.length) problems.push('No usable cards found in cards.csv.');
    if (STARTER_COLLECTION.length < 10) {
      problems.push(
        `Only ${STARTER_COLLECTION.length} cards are marked starter="yes" — you need at least 10 for a legal deck.`
      );
    }
    if (problems.length) {
      console.warn(`[cards] ${problems.length} note(s) from cards.csv:\n - ${problems.join('\n - ')}`);
    }
    return { ok: ALL_IDS.length > 0, problems };
  }

  /* ---------------- helpers ---------------- */

  function idsByRarity(rarity) {
    return ALL_IDS.filter((id) => UNITS[id].rarity === rarity);
  }

  // weakest first — orders the deck strip left-to-right
  function byHp(a, b) {
    return UNITS[a].hp - UNITS[b].hp || UNITS[a].mana - UNITS[b].mana;
  }

  function modArgs(card, key) {
    const m = card.modifiers.find((x) => x.key === key);
    return m ? m.args : null;
  }

  function modifierLabel(card) {
    return card.modifiers.map((m) => m.raw).join(', ');
  }

  let uidSeq = 0;
  function createInstance(id) {
    uidSeq += 1;
    return { uid: uidSeq, id };
  }

  global.RTS = global.RTS || {};
  global.RTS.Units = {
    UNITS,
    ALL_IDS,
    STARTER_COLLECTION,
    KNOWN_MODIFIERS,
    VALID_RARITIES,
    load,
    parseCsv,
    createInstance,
    modArgs,
    modifierLabel,
    idsByRarity,
    byHp,
    get problems() {
      return problems;
    },
    get: (id) => UNITS[id],
  };
})(window);
