// Auto-battler renderer. The board is one SVG (hex cells + unit groups) updated
// every frame during battle; the shop/bench/HUD are immediate-mode HTML rebuilt
// whenever the prep state changes.
(function (global) {
  const ABUnits = global.ABUnits;
  const AB = global.AB;
  const CFG = AB.CONFIG;

  const STAGE_W = 1920;
  const STAGE_H = 1080;
  const BOARD_MAX_H = 660;
  const BOARD_MAX_W = 1700;
  const BANNER_MS = 3000; // how long the win/lose banner stays up

  let root;
  let svg;
  let hexSize = 16;
  let grid = { width: 0, height: 0 };
  let rafId = null;
  let lastTs = 0;
  let drag = null; // { kind:'bench'|'board'|'shop', uid, id, shopIndex, ghost }
  let resolving = false; // guards the post-battle banner timer
  let selected = null; // { kind:'board'|'bench'|'shop', uid, id, shopIndex }
  let press = null; // pointer-down position, used to tell a click from a drag
  const CLICK_SLOP = 6; // px of movement still counted as a click
  const unitEls = new Map();

  const SVGNS = 'http://www.w3.org/2000/svg';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- stage ---------------- */

  function fitStage() {
    const w = window.innerWidth || document.documentElement.clientWidth;
    const h = window.innerHeight || document.documentElement.clientHeight;
    // Bail on a zero-sized viewport. Running before first layout would set the
    // scale to 0, and transform:scale(0) makes the whole game invisible with
    // nothing to trigger a recompute.
    if (!w || !h) return;
    document.documentElement.style.setProperty('--stage-scale', Math.min(w / STAGE_W, h / STAGE_H));
  }

  function computeHexSize() {
    const byH = BOARD_MAX_H / (1.5 * (CFG.rows - 1) + 2);
    const byW = BOARD_MAX_W / (Math.sqrt(3) * (CFG.cols + 0.5));
    hexSize = Math.max(6, Math.floor(Math.min(byH, byW)));
    grid = Hex.gridSize(CFG.cols, CFG.rows, hexSize);
  }

  /* ---------------- shell ---------------- */

  function renderShell() {
    return `
      <div class="ab">
        <div class="ab-top">
          <div class="ab-hpcol">
            <div class="ab-hpbox you"><span class="hp-icon">🧍</span><span class="hp-num you-hp"></span></div>
            <div class="ab-hpbox foe"><span class="hp-icon">🤖</span><span class="hp-num foe-hp"></span></div>
          </div>
          <div class="ab-stagebox stage-box"></div>
          <div class="ab-phase phase-v"></div>
        </div>

        <div class="ab-info"></div>

        <div class="ab-mid">
          <div class="ab-traits"></div>
          <div class="ab-boardwrap"></div>
          <div class="ab-banner"></div>
        </div>

        <div class="ab-benchrow">
          <div class="ab-bench player-bench"></div>
        </div>

        <div class="ab-unitsmodal">
          <div class="ab-unitswin">
            <div class="uw-head"><span>ALL UNITS</span><button class="uw-close">✕</button></div>
            <div class="uw-body"></div>
          </div>
        </div>

        <div class="ab-bottom">
          <div class="ab-goldbox"><span class="ab-k">GOLD</span><span class="ab-v gold gold-v"></span></div>
          <div class="ab-shopwrap">
            <button class="ab-unitsbtn units-btn" title="See every unit in the game">UNITS</button>
            <div class="ab-shop"></div>
            <div class="ab-sellover"><span>SELL</span><span class="ab-hint">drop a unit here</span></div>
          </div>
          <div class="ab-ctrlcol">
            <div class="ab-unitsbox"><span class="ab-k">UNITS</span><span class="ab-v units-v"></span></div>
            <div class="ab-controls">
              <button class="ab-btn reroll-btn ctrl-row">
                <span class="lock-btn" title="Lock the shop so it doesn't reroll next round">🔓</span>
                REROLL<span class="ab-cost">${CFG.rerollCost}g</span>
              </button>
              <button class="ab-btn ab-play play-btn ctrl-row">PLAY</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  function buildBoard() {
    const wrap = root.querySelector('.ab-boardwrap');
    wrap.innerHTML = '';
    svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${grid.width} ${grid.height}`);
    svg.setAttribute('width', grid.width);
    svg.setAttribute('height', grid.height);
    svg.classList.add('ab-board');

    const cells = document.createElementNS(SVGNS, 'g');
    cells.setAttribute('class', 'cells');
    for (let row = 0; row < CFG.rows; row++) {
      for (let col = 0; col < CFG.cols; col++) {
        const c = Hex.centre(col, row, hexSize);
        const poly = document.createElementNS(SVGNS, 'polygon');
        poly.setAttribute('points', Hex.corners(c.x, c.y, hexSize * 0.94));
        let cls = 'hex';
        if (AB.isPlayerZone(row)) cls += ' hex-mine';
        else if (AB.isEnemyZone(row)) cls += ' hex-theirs';
        poly.setAttribute('class', cls);
        poly.dataset.col = col;
        poly.dataset.row = row;
        cells.appendChild(poly);
      }
    }
    svg.appendChild(cells);
    ['units', 'fx'].forEach((n) => {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', n);
      svg.appendChild(g);
    });
    wrap.appendChild(svg);
    unitEls.clear();
  }

  /* ---------------- unit rendering ---------------- */

  function makeUnitEl(u) {
    const s = AB.statsOf(u.id, u.star);
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', `unit team-${u.team} tier-${s.tier} star-${s.star} spawn`);
    g.dataset.uid = u.uid;

    const body = document.createElementNS(SVGNS, 'polygon');
    body.setAttribute('points', Hex.corners(0, 0, hexSize * 0.86));
    body.setAttribute('class', 'unit-body');
    g.appendChild(body);

    const em = document.createElementNS(SVGNS, 'text');
    em.setAttribute('class', 'unit-em');
    em.setAttribute('text-anchor', 'middle');
    em.setAttribute('y', hexSize * 0.18);
    em.setAttribute('font-size', hexSize * 0.95);
    em.textContent = s.emoji;
    g.appendChild(em);

    const barW = hexSize * 1.3;
    const barH = Math.max(3, hexSize * 0.16);
    ['hp-bg', 'hp-fill'].forEach((cls) => {
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('class', cls);
      r.setAttribute('x', -barW / 2);
      r.setAttribute('y', -hexSize * 0.95);
      r.setAttribute('width', barW);
      r.setAttribute('height', barH);
      g.appendChild(r);
    });

    if (s.star > 1) {
      const st = document.createElementNS(SVGNS, 'text');
      st.setAttribute('class', 'unit-star');
      st.setAttribute('text-anchor', 'middle');
      st.setAttribute('y', hexSize * 0.82);
      st.setAttribute('font-size', hexSize * 0.4);
      st.textContent = '★'.repeat(s.star);
      g.appendChild(st);
    }

    svg.querySelector('.units').appendChild(g);
    setTimeout(() => g.classList.remove('spawn'), 300);
    return g;
  }

  function killEl(el, uid) {
    if (el.dataset.dying) return;
    el.dataset.dying = '1';
    el.classList.add('dying');
    unitEls.delete(uid);
    setTimeout(() => el.remove(), 320);
  }

  function syncUnits(dt) {
    const battling = AB.state.phase === 'battle';
    const alive = new Set();

    AB.state.units.forEach((u) => {
      if (u.hp <= 0) return; // dead: handled by the sweep below
      alive.add(u.uid);
      let el = unitEls.get(u.uid);
      if (!el) {
        el = makeUnitEl(u);
        unitEls.set(u.uid, el);
      }
      const c = Hex.centre(u.col, u.row, hexSize);

      // Outside battle, snap straight to the cell. (Easing while the rAF loop
      // isn't running was what left units parked between hexes.)
      if (!battling || u.vx == null) {
        u.vx = c.x;
        u.vy = c.y;
      } else {
        const k = Math.min(1, (dt || 0.016) * 10);
        u.vx += (c.x - u.vx) * k;
        u.vy += (c.y - u.vy) * k;
      }

      // attack lunge: a quick jab toward the target and back
      let ox = 0;
      let oy = 0;
      if (u.lungeT > 0 && u.lungeTo) {
        const to = Hex.centre(u.lungeTo.col, u.lungeTo.row, hexSize);
        const dx = to.x - c.x;
        const dy = to.y - c.y;
        const len = Math.hypot(dx, dy) || 1;
        const p = 1 - u.lungeT / CFG.lungeTime; // 0 -> 1
        const amt = Math.sin(p * Math.PI) * hexSize * 0.38;
        ox = (dx / len) * amt;
        oy = (dy / len) * amt;
      }

      el.setAttribute('transform', `translate(${(u.vx + ox).toFixed(2)},${(u.vy + oy).toFixed(2)})`);
      el.querySelector('.hp-fill').setAttribute('width', hexSize * 1.3 * Math.max(0, u.hp / u.maxHp));
      el.classList.toggle('picked', !!selected && selected.kind === 'board' && selected.uid === u.uid);
    });

    unitEls.forEach((el, uid) => {
      if (!alive.has(uid)) killEl(el, uid);
    });
  }

  const svgEl = (name, attrs) => {
    const e = document.createElementNS(SVGNS, name);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    return e;
  };

  // An arrow that flies from the shooter to its target. The wrapper is rotated
  // to face the target, so the arrow just travels along its own +X axis.
  function spawnProjectile(fx, from, to, travel) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (!dist) return;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const g = svgEl('g', { transform: `translate(${from.x},${from.y}) rotate(${angle})` });
    const len = Math.max(8, hexSize * 0.42);
    const arrow = svgEl('polygon', {
      class: 'proj',
      points: `0,0 ${-len},${-len * 0.22} ${-len * 0.72},0 ${-len},${len * 0.22}`,
    });
    arrow.style.setProperty('--dist', `${dist}px`);
    // the animation length mirrors the engine's flight time, so the arrow
    // lands visually at the same moment the damage does
    const ms = Math.max(80, (travel || 0.22) * 1000);
    arrow.style.animationDuration = `${ms}ms`;
    g.appendChild(arrow);
    fx.appendChild(g);
    setTimeout(() => g.remove(), ms + 60);
  }

  // A sword arc swept at the target, angled from the attacker toward it.
  function spawnSlash(fx, from, to) {
    const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    const r = hexSize * 0.72;
    const g = svgEl('g', { transform: `translate(${to.x},${to.y}) rotate(${angle})` });
    const arc = svgEl('path', {
      class: 'slash',
      d: `M ${-r * 0.1},${-r} A ${r},${r} 0 0 1 ${-r * 0.1},${r}`,
    });
    g.appendChild(arc);
    fx.appendChild(g);
    setTimeout(() => g.remove(), 300);
  }

  // A green hex glow under a unit that just got healed.
  function spawnHealHex(fx, at) {
    const g = svgEl('g', { transform: `translate(${at.x},${at.y})` });
    g.appendChild(svgEl('polygon', { class: 'healfx-fill', points: Hex.corners(0, 0, hexSize * 0.92) }));
    g.appendChild(svgEl('polygon', { class: 'healfx', points: Hex.corners(0, 0, hexSize * 0.95) }));
    fx.appendChild(g);
    setTimeout(() => g.remove(), 920);
  }

  // A hex ring that flares on a unit whose shield ate part of the hit.
  function spawnShield(fx, at, blocked) {
    const g = svgEl('g', { transform: `translate(${at.x},${at.y})` });
    g.appendChild(svgEl('polygon', { class: 'shieldfx', points: Hex.corners(0, 0, hexSize * 0.95) }));
    if (blocked > 0) {
      const t = svgEl('text', {
        class: 'blocked',
        y: hexSize * 0.05,
        'text-anchor': 'middle',
        'font-size': Math.max(8, hexSize * 0.34),
      });
      t.textContent = `-${blocked}`;
      g.appendChild(t);
    }
    fx.appendChild(g);
    setTimeout(() => g.remove(), 420);
  }

  function syncHits() {
    const hits = AB.state.hits;
    if (!hits.length) return;
    const fx = svg.querySelector('.fx');
    hits.forEach((h) => {
      const to = Hex.centre(h.col, h.row, hexSize);
      const from =
        h.fromCol === undefined ? to : Hex.centre(h.fromCol, h.fromRow, hexSize);

      // 'shot' is the arrow leaving the bow — no damage yet, so no popup.
      // The engine sends a separate 'impact' event when it lands.
      if (h.fx === 'shot') {
        spawnProjectile(fx, from, to, h.travel);
        return;
      }
      if (h.fx === 'slash') spawnSlash(fx, from, to);
      if (h.blocked > 0) spawnShield(fx, to, h.blocked);

      const heal = h.fx === 'heal';
      const buff = h.fx === 'buff';
      const bleed = h.fx === 'bleed';
      if (heal) spawnHealHex(fx, to);
      if (buff) spawnShield(fx, to, 0); // cyan flare, the text below tells the story
      const t = svgEl('text', {
        class: heal ? 'hit heal' : buff ? 'hit buffed' : bleed ? 'hit bleeding' : 'hit',
        x: to.x,
        y: to.y - hexSize * 0.6,
        'text-anchor': 'middle',
        'font-size': bleed ? Math.max(8, hexSize * 0.4) : Math.max(10, hexSize * 0.55),
      });
      t.textContent = heal ? `+${h.amount}` : buff ? `+${h.amount}🛡` : `-${h.amount}`;
      fx.appendChild(t);
      setTimeout(() => t.remove(), 600);

      if (!heal) {
        const victim = unitEls.get(h.targetUid);
        if (victim) {
          victim.classList.add('struck');
          setTimeout(() => victim.classList.remove('struck'), 180);
        }
      }
    });
    AB.state.hits = [];
  }

  /* ---------------- HUD / shop / bench ---------------- */

  function shopCardHtml(id, i) {
    if (!id) return `<div class="shop-slot empty" data-shop="${i}"></div>`;
    const s = AB.statsOf(id, 1);
    const afford = AB.state.gold >= s.cost;
    const evolves = AB.countCopies(id, 1) >= 2; // buying this one triggers a merge
    const rng = s.range > 1 ? ` · rng${s.range}` : '';
    const shd = s.shield ? ` · 🛡${s.shield}` : '';
    const spd = ` · ${s.atkSpeed}/s`;
    return `
      <div class="shop-slot tier-${s.tier} ${afford ? '' : 'poor'} ${evolves ? 'evolves' : ''}" data-shop="${i}">
        <div class="slot-top"><span class="slot-tier">T${s.tier}</span><span class="slot-cost">${s.cost}g</span></div>
        <div class="slot-em">${s.emoji}</div>
        <div class="slot-name">${esc(s.name)}</div>
        <div class="slot-stats">${s.maxHp}hp · ${s.dmg}atk${spd}${rng}${shd}</div>
      </div>`;
  }

  function benchSlotHtml(b, i) {
    if (!b) return `<div class="bench-slot" data-bench="${i}"></div>`;
    const s = AB.statsOf(b.id, b.star);
    return `
      <div class="bench-slot filled tier-${s.tier} star-${s.star}" data-bench="${i}" data-uid="${b.uid}"
           title="${esc(s.name)} ${'★'.repeat(s.star)} — ${s.maxHp}hp / ${s.dmg}atk">
        <span class="bench-em">${s.emoji}</span>
        ${s.star > 1 ? `<span class="bench-star">${'★'.repeat(s.star)}</span>` : ''}
      </div>`;
  }

  function syncHud() {
    const s = AB.state;
    const q = (sel) => root.querySelector(sel);
    // the stage tracker: one cell per round of the current stage (1-1, 1-2…),
    // with an icon for what each round is — ⚔ pvp, 👾 minions, 👹 boss
    const si = AB.stageInfo();
    let cells = '';
    if (si.def.rounds === Infinity) {
      cells = `<span class="st-cell cur">10-${si.sub} ∞</span>`;
    } else {
      for (let i = 1; i <= si.def.rounds; i++) {
        const w = si.def.waves && si.def.waves[i];
        const icon = w ? (w.boss ? '👹' : '👾') : '⚔';
        const cls = i < si.sub ? 'done' : i === si.sub ? 'cur' : '';
        cells += `<span class="st-cell ${cls}">${si.stage}-${i} ${icon}</span>`;
      }
    }
    q('.stage-box').innerHTML = cells;
    q('.units-v').textContent = `${AB.boardCount()}/${AB.maxBoardUnits()}`;
    q('.units-v').classList.toggle('full', AB.boardFull());
    q('.gold-v').textContent = s.gold;
    q('.you-hp').textContent = s.playerHp;
    q('.foe-hp').textContent = s.enemyHp;
    q('.phase-v').textContent =
      s.phase === 'prep' ? 'PREPARE' : s.phase === 'battle' ? 'BATTLE' : String(s.result || '').toUpperCase();
    q('.phase-v').className = `ab-phase phase-v phase-${s.phase}`;
    // "off", not disabled — a disabled button would also swallow clicks on the
    // padlock that sits inside it
    q('.reroll-btn').classList.toggle(
      'off',
      (s.phase !== 'prep' && s.phase !== 'battle') || s.gold < CFG.rerollCost
    );
    q('.play-btn').disabled = s.phase !== 'prep' || AB.boardCount() === 0;
    const lockBtn = q('.lock-btn');
    lockBtn.textContent = s.shopLocked ? '🔒' : '🔓';
    lockBtn.classList.toggle('locked', !!s.shopLocked);
  }

  // TFT-style trait stack: icon + count per comp. Grey = present but off,
  // silver = first breakpoint live, gold = full comp.
  function syncTraits() {
    const el = root.querySelector('.ab-traits');
    let html = '';
    Object.keys(AB.TRAITS).forEach((key) => {
      const t = AB.TRAITS[key];
      const n = AB.traitCount('player', key);
      if (!n) return;
      const lvl = AB.traitLevel('player', key);
      const rank = lvl >= 2 ? 'gold' : lvl >= 1 ? 'silver' : 'grey';
      const tipRows = t.breakpoints
        .map((bp, i) => {
          const on = n >= bp;
          return `<div class="tip-row ${on ? 'on' : ''}"><b>(${bp})</b> ${t.descs ? t.descs[i] : ''}</div>`;
        })
        .join('');
      // every member of the comp, with the ones on your board lit up
      const fielded = new Set(
        AB.state.units.filter((u) => u.team === 'player').map((u) => u.id)
      );
      const members = ABUnits.ALL_IDS.filter((id) => (ABUnits.get(id).traits || []).includes(key))
        .sort((a, b) => ABUnits.get(a).tier - ABUnits.get(b).tier)
        .map((id) => {
          const m = ABUnits.get(id);
          return `<span class="tip-unit ${fielded.has(id) ? 'on' : ''}" title="${esc(m.name)}">${m.emoji}</span>`;
        })
        .join('');
      html += `
        <div class="trait ${rank}">
          <span class="trait-icon">${t.icon}</span>
          <span class="trait-name">${t.name}</span>
          <span class="trait-count">${n}</span>
          <div class="trait-tip">
            <div class="tip-head">${t.icon} ${t.name.toUpperCase()} — ${n} on board</div>
            <div class="tip-units">${members}</div>
            ${tipRows}
          </div>
        </div>`;
    });
    el.innerHTML = html;
  }

  function syncShop() {
    root.querySelector('.ab-shop').innerHTML = AB.state.shop.map(shopCardHtml).join('');
  }

  function syncBench() {
    root.querySelector('.player-bench').innerHTML = AB.state.bench.map(benchSlotHtml).join('');
  }

  function syncAll() {
    syncHud();
    syncShop();
    syncBench();
    syncTraits();
    syncUnits(0);
    syncInfo();
  }

  /* ---------------- unit inspector ---------------- */

  // Resolve the selection against LIVE state, so hp ticks down in the panel
  // while a battle runs. Returns null once the thing is gone (sold, bought,
  // killed), which clears the panel.
  function resolveSelected() {
    if (!selected) return null;
    if (selected.kind === 'board') {
      const u = AB.state.units.find((x) => x.uid === selected.uid);
      if (!u) return null;
      // overlay the LIVE unit's numbers — PvE waves override hp/dmg/speed on
      // the spawned unit (a stage-3 boss has 400hp, not the 700 base)
      const s = Object.assign({}, AB.statsOf(u.id, u.star), {
        maxHp: u.maxHp,
        dmg: u.dmg,
        shield: u.shield,
        range: u.range,
        atkSpeed: Math.round((1 / u.atkInterval) * 100) / 100,
      });
      return { s, hp: u.hp, team: u.team, col: u.col, row: u.row, onField: true };
    }
    if (selected.kind === 'bench') {
      const b = AB.state.bench.find((x) => x && x.uid === selected.uid);
      if (!b) return null;
      const s = AB.statsOf(b.id, b.star);
      return { s, hp: s.maxHp, team: 'player', onField: false, where: 'BENCH' };
    }
    const id = selected.id;
    if (!ABUnits.get(id)) return null;
    const s = AB.statsOf(id, 1);
    return { s, hp: s.maxHp, team: 'player', onField: false, where: 'SHOP' };
  }

  function row(k, v) {
    return `<div class="info-row"><span class="info-k">${k}</span><span class="info-v">${v}</span></div>`;
  }

  function syncInfo() {
    const el = root.querySelector('.ab-info');
    if (!el) return;
    const d = resolveSelected();
    if (!d) {
      selected = null;
      el.className = 'ab-info';
      el.innerHTML = '';
      return;
    }
    const s = d.s;
    const dps = (s.dmg * s.atkSpeed).toFixed(1);
    el.className = `ab-info show team-${d.team}`;
    el.innerHTML = `
      <div class="info-head">
        <span class="info-em">${s.emoji}</span>
        <span class="info-name">${esc(s.name).toUpperCase()}</span>
        <span class="info-star">${'★'.repeat(s.star)}</span>
      </div>
      <div class="info-sub">TIER ${s.tier} · COST ${s.cost}g · ${
      d.onField ? (d.team === 'player' ? 'YOURS' : 'ENEMY') : d.where
    }</div>
      <div class="info-body">
        ${row('HP', `${Math.max(0, Math.round(d.hp))} / ${s.maxHp}`)}
        ${row('ATTACK', s.dmg)}
        ${row('ATK SPEED', `${s.atkSpeed}/s`)}
        ${row('DPS', dps)}
        ${s.shield ? row('SHIELD', `${s.shield} deflected`) : ''}
        ${row('RANGE', s.range > 1 ? `${s.range} hex` : 'melee')}
        ${row('MOVE', `${s.moveSpeed} hex/s`)}
        ${s.slots > 1 ? row('SLOTS', s.slots) : ''}
        ${s.traits && s.traits.length ? row('TRAIT', s.traits.join(', ')) : ''}
        ${d.onField ? row('CELL', `${d.col}, ${d.row}`) : ''}
      </div>`;
  }

  // What unit-ish thing sits under the pointer? (hover inspector)
  function hoverTarget(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const shopSlot = el.closest('[data-shop]');
    if (shopSlot && !shopSlot.classList.contains('empty')) {
      const i = Number(shopSlot.dataset.shop);
      if (AB.state.shop[i]) return { kind: 'shop', shopIndex: i, id: AB.state.shop[i] };
    }
    const benchSlot = el.closest('.bench-slot.filled');
    if (benchSlot) return { kind: 'bench', uid: Number(benchSlot.dataset.uid) };
    const cell = cellFromPointer(x, y);
    if (cell) {
      const u = AB.unitAt(cell.col, cell.row);
      if (u) return { kind: 'board', uid: u.uid };
    }
    return null;
  }

  const selKey = (s) => (s ? `${s.kind}:${s.uid || ''}:${s.shopIndex ?? ''}:${s.id || ''}` : '');

  // Figure out what sits under the pointer and select it.
  function selectAt(x, y) {
    const shopSlot = document.elementFromPoint(x, y) && document.elementFromPoint(x, y).closest('[data-shop]');
    if (shopSlot && !shopSlot.classList.contains('empty')) {
      const i = Number(shopSlot.dataset.shop);
      const id = AB.state.shop[i];
      if (id) {
        selected = { kind: 'shop', shopIndex: i, id };
        return true;
      }
    }
    const benchSlot = document.elementFromPoint(x, y) && document.elementFromPoint(x, y).closest('.bench-slot.filled');
    if (benchSlot) {
      selected = { kind: 'bench', uid: Number(benchSlot.dataset.uid) };
      return true;
    }
    const cell = cellFromPointer(x, y);
    if (cell) {
      const u = AB.unitAt(cell.col, cell.row);
      if (u) {
        selected = { kind: 'board', uid: u.uid };
        return true;
      }
      selected = null; // clicked bare ground — clear
      return true;
    }
    return false;
  }

  /* ---------------- units list popup ---------------- */

  function openUnitsList() {
    const modal = root.querySelector('.ab-unitsmodal');
    const body = modal.querySelector('.uw-body');
    let html = `
      <table class="uw-table">
        <thead>
          <tr><th>UNIT</th><th>HP</th><th>ATTACK</th><th>SPEED</th><th>TYPE</th><th>NOTES</th></tr>
        </thead>
        <tbody>`;
    for (let tier = 1; tier <= CFG.maxTier; tier++) {
      const ids = ABUnits.ALL_IDS.filter((id) => ABUnits.get(id).tier === tier);
      if (!ids.length) continue;
      html += `<tr class="uw-tierrow tier-${tier}"><td colspan="6"><span class="uw-tiertag">TIER ${tier}</span> · ${tier}g</td></tr>`;
      ids.forEach((id) => {
        const s = AB.statsOf(id, 1);
        const type = s.range > 1 ? `ranged ${s.range}` : 'melee';
        const extras = [];
        if (s.traits && s.traits.length) extras.push(`🐾 ${s.traits.join('/')}`);
        if (s.shield) extras.push(`🛡 blocks ${s.shield}`);
        if (s.slots > 1) extras.push(`takes ${s.slots} slots`);
        html += `
          <tr>
            <td class="uw-unit"><span class="uw-em">${s.emoji}</span>${esc(s.name)}</td>
            <td>${s.maxHp}</td>
            <td>${s.dmg}</td>
            <td>${s.atkSpeed}/s</td>
            <td>${type}</td>
            <td class="uw-ab">${extras.length ? extras.join(' · ') : '—'}</td>
          </tr>`;
      });
    }
    html += '</tbody></table>';
    body.innerHTML = html;
    modal.classList.add('show');
  }

  /* ---------------- banner ---------------- */

  function showBanner(result) {
    const el = root.querySelector('.ab-banner');
    const txt =
      result === 'gamewin' ? 'VICTORY' :
      result === 'gamelose' ? 'DEFEAT' :
      result === 'win' ? 'ROUND WIN' : result === 'lose' ? 'ROUND LOST' : 'DRAW';
    el.textContent = txt;
    el.className = `ab-banner show banner-${result === 'gamewin' ? 'win' : result === 'gamelose' ? 'lose' : result}`;
  }

  function hideBanner() {
    root.querySelector('.ab-banner').className = 'ab-banner';
  }

  /* ---------------- battle loop ---------------- */

  function loop(ts) {
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    AB.tick(dt);
    syncUnits(dt);
    syncHits();
    syncInfo(); // keeps the inspector's hp live during a fight
    if (AB.state.phase === 'battle') {
      rafId = requestAnimationFrame(loop);
    } else {
      rafId = null;
      onBattleEnd();
    }
  }

  function startLoop() {
    if (rafId) return;
    lastTs = 0;
    rafId = requestAnimationFrame(loop);
  }

  // Banner for 3s, then everyone marches home and the next prep phase begins.
  // If a player's life hit 0 the match is over: linger on VICTORY/DEFEAT,
  // then start a fresh game.
  function onBattleEnd() {
    if (resolving) return;
    resolving = true;
    syncAll();
    const over = AB.state.gameOver;
    showBanner(over ? (over === 'win' ? 'gamewin' : 'gamelose') : AB.state.result);
    setTimeout(() => {
      hideBanner();
      if (over) AB.newGame();
      else AB.nextRound();
      syncAll();
      resolving = false;
    }, over ? BANNER_MS * 2 : BANNER_MS);
  }

  /* ---------------- drag & drop ---------------- */

  function cellFromPointer(x, y) {
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    const sx = ((x - r.left) / r.width) * grid.width;
    const sy = ((y - r.top) / r.height) * grid.height;
    return Hex.cellAt(sx, sy, CFG.cols, CFG.rows, hexSize);
  }

  function overElement(x, y, selector) {
    const el = root.querySelector(selector);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function startDrag(opts, x, y) {
    const s = AB.statsOf(opts.id, opts.star || 1);
    const ghost = document.createElement('div');
    ghost.className = 'ab-ghost';
    ghost.textContent = s.emoji;
    root.appendChild(ghost);
    drag = Object.assign({ ghost }, opts);
    svg.classList.add('dragging'); // the hex grid only shows while holding a unit
    // the ghost IS the unit while dragging — no shadow left on its old hex
    if (opts.kind === 'board') {
      const el = unitEls.get(opts.uid);
      if (el) el.style.display = 'none';
    }
    // dragging one of YOUR units turns the whole shop into a sell zone
    if (opts.kind !== 'shop') root.querySelector('.ab-shopwrap').classList.add('selling');
    moveDrag(x, y);
  }

  function moveDrag(x, y) {
    if (!drag) return;
    const r = root.getBoundingClientRect();
    const scale = r.width / STAGE_W || 1;
    drag.ghost.style.left = `${(x - r.left) / scale}px`;
    drag.ghost.style.top = `${(y - r.top) / scale}px`;

    root.querySelectorAll('.hex-hot').forEach((h) => h.classList.remove('hex-hot'));
    const cell = cellFromPointer(x, y);
    if (cell && AB.isPlayerZone(cell.row)) {
      const poly = svg.querySelector(`polygon[data-col="${cell.col}"][data-row="${cell.row}"]`);
      if (poly) poly.classList.add('hex-hot');
    }
    if (drag.kind !== 'shop') {
      root.querySelector('.ab-shopwrap').classList.toggle('sell-hot', overElement(x, y, '.ab-shopwrap'));
    }
  }

  function endDrag(x, y, wasClick) {
    if (!drag) return;
    const d = drag;
    d.ghost.remove();
    svg.classList.remove('dragging');
    if (d.kind === 'board') {
      const el = unitEls.get(d.uid);
      if (el) el.style.display = '';
    }
    root.querySelectorAll('.hex-hot').forEach((h) => h.classList.remove('hex-hot'));
    const wrap = root.querySelector('.ab-shopwrap');
    wrap.classList.remove('selling', 'sell-hot');
    drag = null;

    // A press that never moved is an inspect, not a drop. Shop slots still buy
    // on click (that's how you buy to the bench) and show the card's stats too.
    if (wasClick && d.kind !== 'shop') {
      selectAt(x, y);
      syncAll();
      return;
    }
    if (wasClick && d.kind === 'shop') {
      AB.buy(d.shopIndex);
      selected = { kind: 'shop', shopIndex: d.shopIndex, id: d.id };
      syncAll();
      return;
    }

    const cell = cellFromPointer(x, y);

    if (d.kind === 'shop') {
      // onto the board = buy straight into that cell; onto a bench slot = buy
      // into that exact slot; anywhere else = first free bench slot
      const at = document.elementFromPoint(x, y);
      const benchSlot = at && at.closest('[data-bench]');
      if (cell) AB.buyToBoard(d.shopIndex, cell.col, cell.row) || AB.buy(d.shopIndex);
      else if (benchSlot) AB.buy(d.shopIndex, Number(benchSlot.dataset.bench));
      else AB.buy(d.shopIndex);
    } else if (overElement(x, y, '.ab-shopwrap')) {
      AB.sell(d.uid); // the shop is the sell zone while dragging a unit
    } else if (cell) {
      if (d.kind === 'bench') AB.placeFromBench(d.uid, cell.col, cell.row);
      else AB.moveOnBoard(d.uid, cell.col, cell.row);
    } else {
      // dropped on a specific bench slot? honour it (bench units swap places,
      // board units come off the field into that slot)
      const at = document.elementFromPoint(x, y);
      const benchSlot = at && at.closest('[data-bench]');
      if (benchSlot) {
        const idx = Number(benchSlot.dataset.bench);
        if (d.kind === 'bench') AB.moveBenchSlot(d.uid, idx);
        else if (d.kind === 'board') AB.benchUnit(d.uid, idx);
      } else if (overElement(x, y, '.ab-benchrow') && d.kind === 'board') {
        AB.benchUnit(d.uid);
      }
    }
    syncAll();
  }

  /* ---------------- init ---------------- */

  function init() {
    root = document.getElementById('app');
    computeHexSize();
    root.innerHTML = renderShell();
    buildBoard();
    AB.newGame();
    syncAll();

    root.addEventListener('pointerdown', (e) => {
      press = { x: e.clientX, y: e.clientY };
      if (drag) return;
      const phase = AB.state.phase;
      // buying from the shop works during prep AND mid-battle; rearranging
      // your bench/board only makes sense during prep.
      const shopSlot = e.target.closest('.shop-slot:not(.empty):not(.poor)');
      if (shopSlot && (phase === 'prep' || phase === 'battle')) {
        const i = Number(shopSlot.dataset.shop);
        startDrag({ kind: 'shop', shopIndex: i, id: AB.state.shop[i], star: 1 }, e.clientX, e.clientY);
        e.preventDefault();
        return;
      }

      // the bench stays fully manageable during battle (move / sell / buy);
      // only the board itself is off-limits while the fight plays out
      const benchSlot = e.target.closest('.bench-slot.filled');
      if (benchSlot && (phase === 'prep' || phase === 'battle')) {
        const uid = Number(benchSlot.dataset.uid);
        const b = AB.state.bench.find((x) => x && x.uid === uid);
        if (b) startDrag({ kind: 'bench', uid, id: b.id, star: b.star }, e.clientX, e.clientY);
        e.preventDefault();
        return;
      }

      // outside prep you can still click to inspect, just not drag board units
      if (phase !== 'prep') return;

      const cell = cellFromPointer(e.clientX, e.clientY);
      if (cell) {
        const u = AB.unitAt(cell.col, cell.row);
        if (u && u.team === 'player') {
          startDrag({ kind: 'board', uid: u.uid, id: u.id, star: u.star }, e.clientX, e.clientY);
          e.preventDefault();
        }
      }
    });

    document.addEventListener('pointermove', (e) => {
      if (drag) {
        moveDrag(e.clientX, e.clientY);
        return;
      }
      // hovering any unit (shop, bench, board — either team) opens its card
      const hov = hoverTarget(e.clientX, e.clientY);
      if (selKey(hov) !== selKey(selected)) {
        selected = hov;
        syncInfo();
        syncUnits(0); // update the gold "picked" ring
      }
    });
    document.addEventListener('pointerup', (e) => {
      const moved = press ? Math.hypot(e.clientX - press.x, e.clientY - press.y) : Infinity;
      const wasClick = moved <= CLICK_SLOP;
      press = null;
      if (drag) endDrag(e.clientX, e.clientY, wasClick);
      else if (wasClick) {
        if (selectAt(e.clientX, e.clientY)) syncInfo();
      }
    });
    document.addEventListener('pointercancel', () => {
      press = null;
      if (drag) endDrag(-1, -1, false);
    });

    root.addEventListener('click', (e) => {
      if (e.target.closest('.units-btn')) {
        openUnitsList();
        return;
      }
      if (e.target.closest('.uw-close') || e.target.classList.contains('ab-unitsmodal')) {
        root.querySelector('.ab-unitsmodal').classList.remove('show');
        return;
      }
      // the padlock lives inside the reroll button, so it must win the check
      if (e.target.closest('.lock-btn')) {
        AB.toggleShopLock();
        syncAll();
      } else if (e.target.closest('.reroll-btn')) {
        AB.reroll();
        syncAll();
      } else if (e.target.closest('.play-btn')) {
        if (AB.startBattle()) {
          syncAll();
          startLoop();
        }
      }
    });

    // requestAnimationFrame is paused while the tab is hidden, so a battle can
    // stall mid-round. There's no manual "next round" button to fall back on,
    // so re-kick the loop when the tab comes back if nothing is scheduled.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || rafId || resolving) return;
      const p = AB.state.phase;
      if (p === 'battle' || p === 'result') startLoop();
    });

    window.addEventListener('resize', fitStage);
    window.addEventListener('load', fitStage);
    if (window.ResizeObserver) new ResizeObserver(fitStage).observe(document.documentElement);
    // once now, and again after the first layout pass — boot can run before the
    // viewport has a size, which would otherwise leave the stage at scale 0
    fitStage();
    requestAnimationFrame(fitStage);
  }

  async function boot() {
    root = document.getElementById('app');
    fitStage();
    try {
      const res = await fetch(`units.csv?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching units.csv`);
      const result = ABUnits.load(await res.text());
      if (!result.ok) throw new Error(result.problems.join(' · '));
    } catch (err) {
      root.innerHTML = `<div class="ab-error"><h1>Can't load units</h1><p>${esc(
        err.message || String(err)
      )}</p><p>The game reads units.csv over http — run <b>serve.bat</b> and open http://localhost:8765</p></div>`;
      return;
    }
    init();
  }

  global.ABUI = { init, boot };
  document.addEventListener('DOMContentLoaded', boot);
})(window);
