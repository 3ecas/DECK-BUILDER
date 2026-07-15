// Arena renderer. The arena shell is a persistent DOM updated every frame
// (rebuilding it would kill performance and any in-progress drag); tabs,
// popups and the deck editor are immediate-mode on top of it.
(function (global) {
  const Units = global.RTS.Units;
  const Arena = global.RTS.Arena;
  const Collection = global.RTS.Collection;
  const CFG = global.RTS_CONFIG;

  let root;
  let shellUp = false; // is the arena shell mounted?
  let rafId = null;
  let lastTs = 0;
  const unitEls = new Map(); // fieldId -> element
  let handSig = '';
  let drag = null;

  let pendingPack = null;
  let packState = null; // null | 'closed' | 'open'
  let editingDeck = null; // deck object being edited
  let lastSpin = null; // result of the most recent roulette spin

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- arena shell ---------------- */

  function renderShell() {
    // lines drawn from the engine's own constants so what you see is exactly
    // what the damage check uses
    const lines =
      `<div class="castle-line enemy-line" style="bottom:${Arena.ENEMY_LINE}%"></div>` +
      `<div class="castle-line player-line" style="bottom:${Arena.PLAYER_LINE}%"></div>`;
    const lanes = Array.from(
      { length: Arena.LANE_COUNT },
      (_, i) => `<div class="lane" data-lane="${i}">${lines}</div>`
    ).join('');
    return `
      <div class="arena">
        <nav class="side-tabs">
          <button class="tab-btn" data-tab="decks"><span class="tab-ico">🃏</span><span class="tab-lbl">Decks</span></button>
          <button class="tab-btn" data-tab="shop"><span class="tab-ico">🛒</span><span class="tab-lbl">Shop</span></button>
          <button class="tab-btn" data-tab="collection"><span class="tab-ico">📖</span><span class="tab-lbl">Cards</span></button>
          <div class="coin-tab"><span class="tab-ico">🪙</span><span class="coin-val"></span></div>
        </nav>

        <div class="arena-main">
          <div class="wall enemy-wall">
            <span class="wall-icon">🏰</span>
            <span class="wall-hp"></span>
          </div>

          <div class="field">
            ${lanes}
            <button class="engage-btn">Engage</button>
          </div>

          <div class="wall player-wall">
            <span class="wall-icon">🏰</span>
            <span class="wall-hp"></span>
          </div>

          <div class="mana-row">
            <div class="mana-bar"><div class="mana-fill"></div></div>
            <span class="mana-text"></span>
          </div>

          <div class="arena-hand"></div>
        </div>
      </div>`;
  }

  function handCardHtml(inst, i) {
    const c = Units.get(inst.id);
    return `
      <div class="unit-card card-color-${c.color}" data-hand-index="${i}">
        <div class="mana-orb">${c.mana}</div>
        <div class="unit-emoji">${c.emoji}</div>
        <div class="unit-name">${esc(c.name)}</div>
        <div class="unit-hp">❤️ ${c.hp}</div>
      </div>`;
  }

  /* ---------------- per-frame sync ---------------- */

  function hearts(n, max) {
    let s = '';
    for (let i = 0; i < max; i++) s += i < n ? '❤️' : '🖤';
    return s;
  }

  function syncHand() {
    const playing = Arena.state.phase === 'playing';
    const hand = playing ? Arena.state.player.hand : [];
    const sig = playing ? hand.map((h) => h.uid).join(',') : 'idle';
    if (sig !== handSig && !drag) {
      handSig = sig;
      const el = root.querySelector('.arena-hand');
      if (el) el.innerHTML = hand.map(handCardHtml).join('');
    }
    if (!playing) return;
    root.querySelectorAll('.unit-card[data-hand-index]').forEach((el) => {
      el.classList.toggle('unaffordable', !Arena.canAfford(Number(el.dataset.handIndex)));
    });
  }

  function syncUnits() {
    const alive = new Set();
    Arena.state.lanes.forEach((lane, laneIndex) => {
      const laneEl = root.querySelector(`.lane[data-lane="${laneIndex}"]`);
      if (!laneEl) return;
      lane.forEach((u) => {
        alive.add(u.fieldId);
        let el = unitEls.get(u.fieldId);
        if (!el) {
          const c = Units.get(u.id);
          el = document.createElement('div');
          el.className = `unit-token side-${u.side} card-color-${c.color}`;
          el.innerHTML = `<span class="tok-emoji">${c.emoji}</span><span class="tok-hp"></span>`;
          laneEl.appendChild(el);
          unitEls.set(u.fieldId, el);
        }
        el.style.bottom = `${u.pos}%`;
        const hpEl = el.querySelector('.tok-hp');
        if (hpEl.textContent !== String(u.hp)) hpEl.textContent = u.hp;
      });
    });
    unitEls.forEach((el, id) => {
      if (!alive.has(id)) {
        el.remove();
        unitEls.delete(id);
      }
    });
  }

  function syncFlashes() {
    const flashes = Arena.state.flashes;
    if (!flashes || !flashes.length) return;
    flashes.forEach((f) => {
      const laneEl = root.querySelector(`.lane[data-lane="${f.lane}"]`);
      if (!laneEl) return;
      const el = document.createElement('div');
      el.className = 'clash-flash';
      el.textContent = f.text;
      el.style.bottom = `${f.pos}%`;
      laneEl.appendChild(el);
      setTimeout(() => el.remove(), 700);
    });
    Arena.state.flashes = [];
  }

  function syncArena() {
    const s = Arena.state;
    const playing = s.phase !== 'idle';

    const fill = root.querySelector('.mana-fill');
    const text = root.querySelector('.mana-text');
    if (fill) fill.style.width = playing ? `${(s.player.mana / Arena.MANA_MAX) * 100}%` : '0%';
    if (text) text.textContent = playing ? `⚡ ${Math.floor(s.player.mana)} / ${Arena.MANA_MAX}` : `⚡ 0 / ${Arena.MANA_MAX}`;

    const ew = root.querySelector('.enemy-wall .wall-hp');
    const pw = root.querySelector('.player-wall .wall-hp');
    if (ew) ew.textContent = hearts(playing ? s.enemy.structureHp : Arena.STRUCTURE_HP, Arena.STRUCTURE_HP);
    if (pw) pw.textContent = hearts(playing ? s.player.structureHp : Arena.STRUCTURE_HP, Arena.STRUCTURE_HP);

    const coin = root.querySelector('.coin-val');
    if (coin) coin.textContent = Collection.data.currency;

    const engage = root.querySelector('.engage-btn');
    if (engage) engage.classList.toggle('hidden', s.phase === 'playing');

    syncUnits();
    syncFlashes();
    syncHand();
  }

  /* ---------------- loop ---------------- */

  function loop(ts) {
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    Arena.tick(dt);
    syncArena();
    if (Arena.state.phase === 'playing') {
      rafId = requestAnimationFrame(loop);
    } else {
      rafId = null;
      render();
    }
  }

  function startLoop() {
    if (rafId) return;
    lastTs = 0;
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* ---------------- popups ---------------- */

  function closePopup() {
    const ov = root.querySelector('.overlay');
    if (ov) ov.remove();
  }

  function showPopup(html) {
    closePopup();
    root.insertAdjacentHTML('beforeend', html);
  }

  // Small left-to-right strip of a deck's cards, weakest first.
  function deckStrip(deck) {
    if (!deck.cards.length) return '<span class="deck-empty">empty</span>';
    return Collection.deckSorted(deck)
      .map((id) => {
        const c = Units.get(id);
        return `<span class="mini-card card-color-${c.color}" title="${esc(c.name)} · ${c.hp} hp">${c.emoji}</span>`;
      })
      .join('');
  }

  function renderDecksPopup() {
    const rows = Collection.data.decks
      .map((d, i) => {
        const active = i === Collection.data.activeDeck;
        const legal = Collection.deckIsLegal(d);
        return `
          <div class="deck-row ${active ? 'deck-active' : ''}" data-deck-index="${i}">
            <div class="deck-row-head">
              <span class="deck-name">${esc(d.name)}</span>
              <span class="deck-size ${legal ? 'deck-ok' : 'deck-bad'}">${d.cards.length}/${Collection.DECK_SIZE}</span>
            </div>
            <div class="deck-strip">${deckStrip(d)}</div>
          </div>`;
      })
      .join('');
    return `
      <div class="overlay">
        <div class="overlay-panel">
          <h1>Decks</h1>
          <p class="tagline">Pick the deck you'll fight with.</p>
          <div class="deck-list">${rows}</div>
          <div class="menu-actions">
            <button class="btn newdeck-btn">New Deck</button>
            <button class="btn editdeck-btn">Edit Deck</button>
            <button class="btn btn-primary exitdecks-btn">Exit</button>
          </div>
        </div>
      </div>`;
  }

  function renderDeckEditor() {
    const deck = editingDeck;
    const slots = Array.from({ length: Collection.DECK_SIZE }, (_, i) => {
      const id = Collection.deckSorted(deck)[i];
      if (!id) return '<div class="slot slot-empty"></div>';
      const c = Units.get(id);
      return `<div class="slot card-color-${c.color}" data-slot-id="${id}"><span>${c.emoji}</span></div>`;
    }).join('');

    const pool = Collection.ownedIds()
      .sort(Units.byHp)
      .map((id) => {
        const c = Units.get(id);
        const inDeck = Collection.deckCount(deck, id);
        const owned = Collection.ownedCount(id);
        const spent = inDeck >= owned;
        return `
          <div class="coll-slot">
            <div class="unit-card card-color-${c.color} ${inDeck ? 'in-deck' : ''} ${spent ? 'all-used' : ''}" data-pool-id="${id}">
              <div class="mana-orb">${c.mana}</div>
              ${inDeck ? `<div class="deck-badge">${inDeck}</div>` : ''}
              <div class="unit-emoji">${c.emoji}</div>
              <div class="unit-name">${esc(c.name)}</div>
              <div class="unit-hp">❤️ ${c.hp}</div>
            </div>
            <div class="coll-meta">${inDeck}/${owned}</div>
          </div>`;
      })
      .join('');

    const legal = Collection.deckIsLegal(deck);
    return `
      <div class="overlay">
        <div class="overlay-panel gallery-panel">
          <h1>Edit ${esc(deck.name)}</h1>
          <div class="deck-slots">${slots}</div>
          <p class="tagline">
            <b class="${legal ? 'deck-ok' : 'deck-bad'}">${deck.cards.length}/${Collection.DECK_SIZE}</b>
            &mdash; tap a slot to remove, tap a card below to add.
          </p>
          <div class="gallery-grid">${pool}</div>
          <div class="menu-actions">
            <button class="btn autofill-btn">Auto-fill</button>
            <button class="btn cleardeck-btn">Clear</button>
            <button class="btn btn-primary deckok-btn">OK</button>
          </div>
        </div>
      </div>`;
  }

  function renderShop() {
    const canSpin = Collection.canSpin();
    const oddsRows = ['normal', 'rare', 'special', 'ultimate']
      .map((r) => `<tr><td class="stat-name rar-${r}">${r}</td><td class="stat-val">${CFG.odds[r] || 0}%</td></tr>`)
      .join('');
    const result = lastSpin
      ? (() => {
          const c = Units.get(lastSpin.id);
          return `
            <div class="spin-result">
              <div class="unit-card card-color-${c.color} pack-card" style="--i:0">
                <div class="mana-orb">${c.mana}</div>
                ${lastSpin.isNew ? '<div class="new-badge">NEW</div>' : ''}
                <div class="unit-emoji">${c.emoji}</div>
                <div class="unit-name">${esc(c.name)}</div>
                <div class="unit-hp">❤️ ${c.hp}</div>
              </div>
              <div class="rar-tag rar-${lastSpin.rarity}">${lastSpin.rarity}</div>
            </div>`;
        })()
      : '<div class="spin-idle">🎰</div>';

    return `
      <div class="overlay">
        <div class="overlay-panel">
          <h1>Shop</h1>
          <p class="tagline">🪙 ${Collection.data.currency} coins &middot; ${CFG.spinCost} per spin &middot; +${CFG.currencyPerWin} per win</p>
          ${result}
          <table class="stats-table odds-table"><caption>Odds</caption><tbody>${oddsRows}</tbody></table>
          <div class="menu-actions">
            <button class="btn btn-primary spin-btn" ${canSpin ? '' : 'disabled'}>Spin 🪙${CFG.spinCost}</button>
            <button class="btn closepop-btn">Exit</button>
          </div>
        </div>
      </div>`;
  }

  function renderCollection() {
    // Every card in the game — undiscovered ones stay blacked out.
    const tiles = Units.ALL_IDS.slice()
      .sort(Units.byHp)
      .map((id) => {
        const c = Units.get(id);
        if (!Collection.hasSeen(id)) {
          return `
            <div class="coll-slot">
              <div class="unit-card undiscovered"><div class="unit-emoji">❓</div></div>
              <div class="coll-meta">—</div>
            </div>`;
        }
        return `
          <div class="coll-slot">
            <div class="unit-card card-color-${c.color}">
              <div class="mana-orb">${c.mana}</div>
              <div class="unit-emoji">${c.emoji}</div>
              <div class="unit-name">${esc(c.name)}</div>
              <div class="unit-hp">❤️ ${c.hp}</div>
              <div class="unit-mod rar-${c.rarity}">${c.rarity}</div>
            </div>
            <div class="coll-meta">x${Collection.ownedCount(id)}</div>
          </div>`;
      })
      .join('');
    const seen = Units.ALL_IDS.filter((id) => Collection.hasSeen(id)).length;
    return `
      <div class="overlay">
        <div class="overlay-panel gallery-panel">
          <h1>Collection</h1>
          <p class="tagline">${seen} / ${Units.ALL_IDS.length} discovered</p>
          <div class="gallery-grid">${tiles}</div>
          <button class="btn btn-primary closepop-btn">Exit</button>
        </div>
      </div>`;
  }

  function renderPackClosed() {
    return `
      <div class="overlay">
        <div class="overlay-panel">
          <h1>Wall Broken!</h1>
          <p class="tagline">+🪙 ${Arena.state.coinsWon || 0} coins &middot; tap the pack to open.</p>
          <div class="pack-closed-wrap">
            <button class="pack-closed open-pack-btn" aria-label="Open pack">🎁</button>
          </div>
        </div>
      </div>`;
  }

  function renderPackOpen() {
    const tiles = pendingPack
      .map(({ id, isNew, rarity }, i) => {
        const c = Units.get(id);
        return `
          <div class="unit-card card-color-${c.color} pack-card" style="--i:${i}">
            <div class="mana-orb">${c.mana}</div>
            ${isNew ? '<div class="new-badge">NEW</div>' : ''}
            <div class="unit-emoji">${c.emoji}</div>
            <div class="unit-name">${esc(c.name)}</div>
            <div class="unit-hp">❤️ ${c.hp}</div>
            <div class="unit-mod rar-${rarity}">${rarity}</div>
          </div>`;
      })
      .join('');
    return `
      <div class="overlay">
        <div class="overlay-panel">
          <h1>🎁 Pack Opened</h1>
          <p class="tagline">${pendingPack.length} cards added to your collection.</p>
          <div class="reward-cards pack-cards">${tiles}</div>
          <div class="menu-actions">
            <button class="btn packdeck-btn">Deck</button>
            <button class="btn btn-primary packok-btn">Continue</button>
          </div>
        </div>
      </div>`;
  }

  function renderResult() {
    const won = Arena.state.winner === 'player';
    return `
      <div class="overlay">
        <div class="overlay-panel">
          <h1>${won ? 'Wall Broken!' : 'You Fell'}</h1>
          <p class="tagline">${won ? `+🪙 ${Arena.state.coinsWon || 0} coins.` : 'The enemy tore your wall down.'}</p>
          <div class="menu-actions">
            <button class="btn btn-primary againbtn">Engage Again</button>
            <button class="btn closepop-btn">Close</button>
          </div>
        </div>
      </div>`;
  }

  function renderHowTo() {
    return `
      <div class="overlay">
        <div class="overlay-panel howto-panel">
          <h1>How to Play</h1>
          <div class="howto-body">
            <section class="howto-section">
              <h2>⚡ Mana</h2>
              <p>You gain 1 mana every 2 seconds, up to 10. Every card costs the mana shown in its orb.</p>
            </section>
            <section class="howto-section">
              <h2>⚔️ Combat</h2>
              <p>Drag a card into a lane. Units march at a fixed speed toward the enemy wall and queue up single file. When two enemies meet, the one with <b>less HP dies</b> and the winner keeps the difference.</p>
            </section>
            <section class="howto-section">
              <h2>🏰 Winning</h2>
              <p>A unit reaching the enemy wall deals 1 damage and is destroyed. Two hits wins the round and earns coins plus a pack.</p>
            </section>
          </div>
          <button class="btn btn-primary closepop-btn">Got it</button>
        </div>
      </div>`;
  }

  /* ---------------- drag to deploy ---------------- */

  function laneAt(x, y) {
    const lanes = root.querySelectorAll('.lane');
    for (let i = 0; i < lanes.length; i++) {
      const r = lanes[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return { index: Number(lanes[i].dataset.lane), el: lanes[i] };
      }
    }
    return null;
  }

  // Pointer coords are viewport pixels, but the ghost lives inside the scaled
  // stage and is positioned in the stage's own 1920x1080 space — convert.
  function toStageCoords(x, y) {
    const r = root.getBoundingClientRect();
    const scale = r.width / STAGE_W || 1;
    return { x: (x - r.left) / scale, y: (y - r.top) / scale };
  }

  function beginDrag(cardEl, x, y) {
    const handIndex = Number(cardEl.dataset.handIndex);
    const ghost = cardEl.cloneNode(true);
    ghost.classList.add('drag-ghost');
    // must live inside #app so it inherits the stage scale — on document.body
    // it would render at full 1920-design size over a scaled-down board
    root.appendChild(ghost);
    cardEl.classList.add('card-source');
    drag = { handIndex, ghost, cardEl };
    moveDrag(x, y);
  }

  function moveDrag(x, y) {
    if (!drag) return;
    const p = toStageCoords(x, y);
    drag.ghost.style.left = `${p.x}px`;
    drag.ghost.style.top = `${p.y}px`;
    const hit = laneAt(x, y); // hit-test stays in viewport space (both sides are)
    root.querySelectorAll('.lane').forEach((l) => l.classList.remove('lane-hot'));
    if (hit && Arena.canAfford(drag.handIndex)) hit.el.classList.add('lane-hot');
  }

  function endDrag(x, y) {
    if (!drag) return;
    const { handIndex, ghost, cardEl } = drag;
    const hit = laneAt(x, y);
    ghost.remove();
    cardEl.classList.remove('card-source');
    root.querySelectorAll('.lane').forEach((l) => l.classList.remove('lane-hot'));
    drag = null;
    if (hit && Arena.playCard(handIndex, hit.index)) {
      handSig = '';
      syncHand();
    }
  }

  /* ---------------- render ---------------- */

  function render() {
    if (!shellUp) {
      root.innerHTML = renderShell();
      shellUp = true;
      unitEls.clear();
      handSig = '';
    }
    const phase = Arena.state.phase;
    // toggle here rather than only in syncArena, so the button reacts on the
    // click itself instead of waiting for the first animation frame
    const engageBtn = root.querySelector('.engage-btn');
    if (engageBtn) engageBtn.classList.toggle('hidden', phase === 'playing');

    if (phase === 'playing') {
      if (!root.querySelector('.overlay')) startLoop();
      return;
    }
    stopLoop();
    syncArena();
    if (phase === 'gameover' && !root.querySelector('.overlay')) {
      if (Arena.state.winner === 'player' && !Arena.state.packAwarded) {
        Arena.state.packAwarded = true;
        packState = 'closed';
      }
      if (packState === 'closed') showPopup(renderPackClosed());
      else if (packState === 'open') showPopup(renderPackOpen());
      else showPopup(renderResult());
    }
  }

  function engage() {
    pendingPack = null;
    packState = null;
    closePopup();
    Arena.newGame();
    Arena.state.packAwarded = false;
    unitEls.forEach((el) => el.remove());
    unitEls.clear();
    handSig = '';
    render();
  }

  /* ---------------- init ---------------- */

  function init() {
    root = document.getElementById('app');

    root.addEventListener('pointerdown', (e) => {
      const cardEl = e.target.closest('.unit-card[data-hand-index]');
      if (!cardEl || drag) return;
      if (Arena.state.phase !== 'playing') return;
      beginDrag(cardEl, e.clientX, e.clientY);
      e.preventDefault();
    });

    document.addEventListener('pointermove', (e) => {
      if (drag) moveDrag(e.clientX, e.clientY);
    });
    document.addEventListener('pointerup', (e) => {
      if (drag) endDrag(e.clientX, e.clientY);
    });
    document.addEventListener('pointercancel', () => {
      if (drag) endDrag(-1, -1);
    });

    root.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab-btn');
      const deckRow = e.target.closest('[data-deck-index]');
      const slot = e.target.closest('[data-slot-id]');
      const poolCard = e.target.closest('[data-pool-id]');

      if (e.target.closest('.engage-btn') || e.target.closest('.againbtn')) {
        engage();
      } else if (tab) {
        const which = tab.dataset.tab;
        if (which === 'decks') showPopup(renderDecksPopup());
        else if (which === 'shop') {
          lastSpin = null;
          showPopup(renderShop());
        } else if (which === 'collection') showPopup(renderCollection());
      } else if (e.target.closest('.closepop-btn')) {
        closePopup();
        if (Arena.state.phase === 'gameover') {
          Arena.returnToIdle();
          unitEls.forEach((el) => el.remove());
          unitEls.clear();
          render();
        }
      } else if (e.target.closest('.open-pack-btn')) {
        pendingPack = Collection.openPack();
        packState = 'open';
        showPopup(renderPackOpen());
      } else if (e.target.closest('.packok-btn')) {
        pendingPack = null;
        packState = null;
        showPopup(renderResult());
      } else if (e.target.closest('.packdeck-btn')) {
        pendingPack = null;
        packState = null;
        showPopup(renderDecksPopup());
      } else if (e.target.closest('.newdeck-btn')) {
        Collection.newDeck();
        showPopup(renderDecksPopup());
      } else if (e.target.closest('.editdeck-btn')) {
        editingDeck = Collection.activeDeck();
        showPopup(renderDeckEditor());
      } else if (e.target.closest('.exitdecks-btn')) {
        closePopup();
      } else if (e.target.closest('.deckok-btn')) {
        editingDeck = null;
        showPopup(renderDecksPopup());
      } else if (e.target.closest('.autofill-btn')) {
        Collection.autoFillDeck(editingDeck);
        showPopup(renderDeckEditor());
      } else if (e.target.closest('.cleardeck-btn')) {
        Collection.clearDeck(editingDeck);
        showPopup(renderDeckEditor());
      } else if (e.target.closest('.spin-btn')) {
        const res = Collection.spin();
        if (res) {
          lastSpin = res;
          showPopup(renderShop());
        }
      } else if (slot) {
        Collection.removeFromDeck(editingDeck, slot.dataset.slotId);
        showPopup(renderDeckEditor());
      } else if (poolCard) {
        const id = poolCard.dataset.poolId;
        if (Collection.canAddToDeck(editingDeck, id)) {
          Collection.addToDeck(editingDeck, id);
          showPopup(renderDeckEditor());
        }
      } else if (deckRow) {
        Collection.selectDeck(Number(deckRow.dataset.deckIndex));
        showPopup(renderDecksPopup());
      } else if (e.target.closest('.howto-btn')) {
        showPopup(renderHowTo());
      }
    });

    render();
  }

  /* ---------------- stage scaling ---------------- */

  // The game is laid out at exactly STAGE_W x STAGE_H and scaled to fit the
  // window, so 1080p / 1440p / 4K all render the identical layout at different
  // sizes. Uses the smaller axis ratio so nothing is ever cut off; leftover
  // space on non-16:9 displays becomes letterbox bars.
  const STAGE_W = 1920;
  const STAGE_H = 1080;

  function fitStage() {
    const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
    document.documentElement.style.setProperty('--stage-scale', scale);
  }

  function watchStageSize() {
    fitStage();
    window.addEventListener('resize', fitStage);
    // Belt and braces: the viewport can change without firing `resize`
    // (fullscreen toggles, some DPI/zoom changes), which would leave the stage
    // scaled for the old size. Observing the root element catches those.
    if (window.ResizeObserver) {
      new ResizeObserver(fitStage).observe(document.documentElement);
    }
  }

  /* ---------------- boot ---------------- */

  function renderLoadError(msg) {
    return `
      <div class="overlay">
        <div class="overlay-panel howto-panel">
          <h1>Can't load cards</h1>
          <div class="howto-body">
            <section class="howto-section">
              <h2>What went wrong</h2>
              <p>${esc(msg)}</p>
            </section>
            <section class="howto-section">
              <h2>Most likely cause</h2>
              <p>The game reads every card from <b>cards.csv</b>. A browser can only fetch that over <b>http</b> — opening index.html straight off the disk (a <b>file://</b> address) is blocked for security.</p>
              <p>Double-click <b>serve.bat</b> in the game folder, then open <b>http://localhost:8765</b>.</p>
            </section>
          </div>
        </div>
      </div>`;
  }

  async function boot() {
    root = document.getElementById('app');
    watchStageSize();
    const url = CFG.cardsUrl || 'cards.csv';
    let text;
    try {
      // no-store + cache-bust so editing the spreadsheet shows up on reload
      const res = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${url}`);
      text = await res.text();
    } catch (e) {
      root.innerHTML = renderLoadError(e && e.message ? e.message : String(e));
      return;
    }
    const result = Units.load(text);
    if (!result.ok) {
      root.innerHTML = renderLoadError(result.problems.join(' · '));
      return;
    }
    Collection.init();
    init();
  }

  global.RTS = global.RTS || {};
  global.RTS.UI = { init, render, boot };

  document.addEventListener('DOMContentLoaded', boot);
})(window);
