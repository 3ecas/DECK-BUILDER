// Renders the entire game state to the DOM on every change (immediate-mode style).
(function (global) {
  const Cards = global.DB.Cards;
  const Game = global.DB.Game;

  const TYPE_ICON = { attack: '⚔️', defense: '🛡️', strategy: '✨' };
  const STATUS_ICON = {
    weak: '⬇️', vulnerable: '🎯', strength: '💪',
    thorns: '🔱', poison: '☠️', bleed: '🩸',
  };

  let root;
  let galleryOpen = false;
  let howToOpen = false;
  let knownHandUids = new Set();
  let dragState = null; // { el, handIndex, startX, startY, dx, dy, rot, moved, over }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function statusBadges(actor) {
    return Object.keys(STATUS_ICON)
      .filter((k) => actor[k] > 0)
      .map((k) => `<span class="badge badge-${k}" title="${k}">${STATUS_ICON[k]} ${actor[k]}</span>`)
      .join('');
  }

  function hpBar(actor) {
    const pct = Math.max(0, Math.round((actor.hp / actor.maxHp) * 100));
    return `
      <div class="hpbar">
        <div class="hpfill" style="width:${pct}%"></div>
        <span class="hptext">${Math.max(0, actor.hp)} / ${actor.maxHp}</span>
      </div>`;
  }

  function cardHtml(card, mult, extraClass, dataAttrs) {
    return `
      <div class="card card-${card.type} card-color-${card.color} ${extraClass || ''}" ${dataAttrs || ''}>
        ${card.cost > 0 ? `<div class="card-cost">${card.cost}</div>` : ''}
        <div class="card-type-icon">${TYPE_ICON[card.type]}</div>
        <div class="card-name">${esc(card.name)}</div>
        <div class="card-desc">${esc(card.desc(mult))}</div>
      </div>`;
  }

  function rewardTileHtml(opt, i) {
    if (opt.type === 'card') {
      return cardHtml(Cards.get(opt.cardId), 1, 'reward-card', `data-reward-index="${i}"`);
    }
    if (opt.type === 'heal') {
      return `
        <div class="card card-reward-special reward-card" data-reward-index="${i}">
          <div class="card-type-icon">❤️</div>
          <div class="card-name">Restore HP</div>
          <div class="card-desc">Heal ${opt.amount} HP.</div>
        </div>`;
    }
    return `
      <div class="card card-reward-special reward-card" data-reward-index="${i}">
        <div class="card-type-icon">💰</div>
        <div class="card-name">Gold</div>
        <div class="card-desc">Gain ${opt.amount} gold.</div>
      </div>`;
  }

  function renderIntro() {
    return `
      <div class="main-menu">
        <h1>Hell Tower</h1>
        <p class="tagline">A deck-building descent. Attack, defend, and outwit whatever climbs to meet you.</p>
        <div class="main-menu-actions">
          <button class="btn btn-primary begin-btn">Start</button>
          <button class="btn howto-btn">How to Play</button>
          <button class="btn view-cards-btn">Deck Cards</button>
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
              <h2>⚔️ Attack &amp; 🛡️ Defense</h2>
              <p>Free to play &mdash; no Action cost. <b>✨ Strategy</b> cards cost Actions, your one limited resource each turn.</p>
            </section>
            <section class="howto-section">
              <h2>🃏 Hand &amp; Actions</h2>
              <p>Your hand holds at most 2 cards. Unplayed cards carry over between turns &mdash; you only draw back up to 2. Drag ⚔️ Attack and ✨ Strategy cards onto the enemy to play them; 🛡️ Defense cards can be played right in your hand zone. Some Strategy cards grant extra Actions.</p>
            </section>
            <section class="howto-section">
              <h2>Conditions</h2>
              <ul>
                <li><b>⬇️ Weak</b> &mdash; deals 25% less damage.</li>
                <li><b>🎯 Vulnerable</b> &mdash; takes 25% more damage.</li>
                <li><b>💪 Strength</b> &mdash; adds flat bonus damage to attacks.</li>
                <li><b>🔱 Thorns</b> &mdash; reflects damage back at attackers.</li>
                <li><b>☠️ Poison</b> &amp; <b>🩸 Bleed</b> &mdash; damage over time, ticks down each turn.</li>
              </ul>
            </section>
            <section class="howto-section">
              <h2>Card Colors</h2>
              <ul>
                <li><b style="color:#ff6659">Red</b> &mdash; attack &amp; bleed</li>
                <li><b style="color:#8bc34a">Green</b> &mdash; poison</li>
                <li><b style="color:#6fa8dc">Blue</b> &mdash; defense</li>
                <li><b style="color:#e8d16a">Yellow</b> &mdash; healing</li>
                <li><b style="color:#c9c9c9">Grey</b> &mdash; draw, actions, debuffs</li>
              </ul>
            </section>
            <section class="howto-section">
              <h2>The Climb</h2>
              <p>Win a fight and the next enemy appears immediately, plus a little bonus gold. Every 3rd floor, pick a bigger reward: a new card, HP, or gold. Every 5th enemy is a tougher boss &mdash; beat one for a bigger reward and a shot at one of its own cards. Between fights you might find a tavern (free heal), a chest (free card), or a shop (spend gold on cards). Fall, and the run ends.</p>
            </section>
            <section class="howto-section">
              <h2>Advanced</h2>
              <p>Some cards steal Block or Strength straight from the enemy, cleanse your own bad conditions, or Echo &mdash; repeat an effect you already played this turn.</p>
            </section>
          </div>
          <button class="btn btn-primary close-howto-btn">Got it</button>
        </div>
      </div>`;
  }

  function renderGallery() {
    const allCards = Object.values(Cards.LIBRARY);
    const cardsHtml = allCards.map((card) => cardHtml(card, 1, 'gallery-card')).join('');
    return `
      <div class="overlay">
        <div class="overlay-panel gallery-panel">
          <h1>Card Library</h1>
          <p class="tagline">Hover a card for a closer look. ${allCards.length} cards.</p>
          <div class="gallery-grid">${cardsHtml}</div>
          <button class="btn back-to-menu-btn">Back</button>
        </div>
      </div>`;
  }

  function renderReward() {
    const { rewardOptions, enemy } = Game.state;
    const tiles = rewardOptions.map(rewardTileHtml).join('');
    return `
      <div class="overlay">
        <div class="overlay-panel">
          <h1>${enemy.isBoss ? 'Boss Defeated!' : 'Floor Cleared'}</h1>
          <p class="tagline">Choose one reward.</p>
          <div class="reward-cards">${tiles}</div>
          <button class="btn skip-reward-btn">Skip Reward</button>
        </div>
      </div>`;
  }

  function renderGameOver() {
    const { floor, player } = Game.state;
    return `
      <div class="overlay">
        <div class="overlay-panel">
          <h1>You Fell</h1>
          <p class="tagline">You reached floor ${floor} with a ${player.masterDeck.length}-card deck and ${player.gold} gold.</p>
          <button class="btn btn-primary retry-btn">Try Again</button>
        </div>
      </div>`;
  }

  function revealHtml(reveal) {
    if (!reveal) return '<div class="enemy-reveal-slot"></div>';
    const card = Cards.get(reveal.cardId);
    return `
      <div class="enemy-reveal-slot">
        <div class="enemy-reveal">
          <span class="reveal-icon">${TYPE_ICON[card.type]}</span>
          <span class="reveal-label">${esc(card.name)}</span>
          <span class="reveal-desc">${esc(card.desc(reveal.mult))}</span>
        </div>
      </div>`;
  }

  function renderEchoChoice(candidates) {
    const tiles = candidates
      .map((id) => cardHtml(Cards.get(id), 1, 'echo-choice-card', `data-echo-id="${id}"`))
      .join('');
    return `
      <div class="overlay">
        <div class="overlay-panel">
          <h1>Echo</h1>
          <p class="tagline">Choose a card played this turn to repeat.</p>
          <div class="reward-cards">${tiles}</div>
        </div>
      </div>`;
  }

  function renderBattle() {
    const { player: p, enemy: e, floor, turn, log: logLines, enemyReveal, pendingEcho } = Game.state;

    const seenUids = new Set();
    const handHtml = p.hand
      .map((inst, i) => {
        const card = Cards.get(inst.id);
        const affordable = p.actions >= card.cost ? '' : 'card-disabled';
        const justDrawn = knownHandUids.has(inst.uid) ? '' : 'card-drawn';
        seenUids.add(inst.uid);
        const n = p.hand.length;
        const center = (n - 1) / 2;
        const offset = i - center;
        const rot = offset * 6;
        const lift = Math.abs(offset) * 6;
        return cardHtml(
          card,
          1,
          `hand-card ${affordable} ${justDrawn}`,
          `data-hand-index="${i}" style="--rot:${rot}deg;--lift:${lift}px;z-index:${i}"`
        );
      })
      .join('');
    knownHandUids = seenUids;

    return `
      <div class="game">
        <header class="topbar">
          <div class="left-info">
            <div class="floor-badge">Floor ${floor}${e.isBoss ? ' · BOSS' : ''}</div>
            <div class="gold-badge">💰 ${p.gold}</div>
          </div>
          <div class="turn-indicator ${turn === 'enemy' ? 'enemy-turn' : ''}">${turn === 'player' ? 'Your Turn' : 'Enemy Turn'}</div>
        </header>

        <div class="battlefield battlefield-enemy-only">
          <div class="combatant enemy-combatant">
            <div class="portrait">${e.emoji}</div>
            <div class="name">${esc(e.name)}</div>
            ${hpBar(e)}
            <div class="status-row">
              ${e.block > 0 ? `<span class="badge badge-block">🛡️ ${e.block}</span>` : ''}
              ${statusBadges(e)}
            </div>
            ${revealHtml(enemyReveal)}
          </div>
        </div>

        <div class="log-panel">
          ${logLines.slice(-8).map((l) => `<div class="log-line">${esc(l)}</div>`).join('')}
        </div>

        <div class="hand-area">
          <div class="pile-counts">
            <span title="Draw pile">🂠 ${p.drawPile.length}</span>
            <span title="Discard pile">🗑️ ${p.discardPile.length}</span>
          </div>
          <div class="hand">${handHtml}</div>
        </div>

        <div class="player-status-bar">
          <div class="player-status-row">
            ${p.block > 0 ? `<span class="badge badge-block">🛡️ ${p.block}</span>` : ''}
            ${statusBadges(p)}
            <span class="energy">⚡ ${p.actions} / ${p.actionsMax} Actions</span>
          </div>
          <div class="player-hp-row">
            <div class="player-hp-wrap">
              <span class="player-hp-name">You</span>
              ${hpBar(p)}
            </div>
            <button class="btn end-turn-btn" ${turn !== 'player' || pendingEcho ? 'disabled' : ''}>End Turn</button>
          </div>
        </div>
      </div>`;
  }

  function renderBonus() {
    const { bonusResult, player } = Game.state;
    let icon = '🎁';
    let title = 'Treasure';
    let desc = '';
    if (bonusResult.type === 'tavern') {
      icon = '🍺';
      title = 'Tavern';
      desc = `You rest and heal ${bonusResult.healed} HP.`;
    } else if (bonusResult.type === 'chest') {
      icon = '🎁';
      title = 'Treasure Chest';
      const card = Cards.get(bonusResult.cardId);
      desc = `You find ${card.name} and add it to your deck.`;
    }
    return `
      <div class="overlay">
        <div class="overlay-panel">
          <h1>${icon} ${title}</h1>
          <p class="tagline">${esc(desc)}</p>
          <p class="tagline">💰 ${player.gold} gold &middot; ❤️ ${player.hp}/${player.maxHp} HP</p>
          <button class="btn btn-primary continue-bonus-btn">Continue</button>
        </div>
      </div>`;
  }

  function shopItemHtml(item, i) {
    const card = Cards.get(item.cardId);
    const afford = Game.state.player.gold >= item.price;
    return `
      <div class="shop-slot">
        ${cardHtml(card, 1)}
        ${item.bought
          ? '<div class="shop-bought">Bought</div>'
          : `<button class="btn shop-buy-btn" data-shop-index="${i}" ${afford ? '' : 'disabled'}>Buy 💰${item.price}</button>`}
      </div>`;
  }

  function renderShop() {
    const { shopOffer, player } = Game.state;
    const itemsHtml = shopOffer.map(shopItemHtml).join('');
    return `
      <div class="overlay">
        <div class="overlay-panel">
          <h1>Shop</h1>
          <p class="tagline">💰 ${player.gold} gold</p>
          <div class="reward-cards">${itemsHtml}</div>
          <button class="btn leave-shop-btn">Leave Shop</button>
        </div>
      </div>`;
  }

  function spawnFloaty(container, kind, amount) {
    if (!container) return;
    const span = document.createElement('div');
    const sign = kind === 'damage' ? '-' : '+';
    span.className = `floaty floaty-${kind}`;
    span.textContent = `${sign}${amount}`;
    span.style.left = `${42 + Math.random() * 16}%`;
    container.appendChild(span);
    span.addEventListener('animationend', () => span.remove(), { once: true });
  }

  function shakeElement(el) {
    if (!el) return;
    el.classList.remove('shaking');
    // eslint-disable-next-line no-unused-expressions
    void el.offsetWidth; // force reflow so the animation restarts on repeated hits
    el.classList.add('shaking');
    el.addEventListener('animationend', function handler(ev) {
      if (ev.animationName === 'shake') {
        el.classList.remove('shaking');
        el.removeEventListener('animationend', handler);
      }
    });
  }

  function consumeEvents() {
    const events = Game.state.events;
    if (!events || !events.length) return;
    const enemyEl = root.querySelector('.enemy-combatant');
    const playerEl = root.querySelector('.player-status-bar');
    events.forEach((ev) => {
      const el = ev.target === 'enemy' ? enemyEl : playerEl;
      if (!el) return;
      spawnFloaty(el, ev.kind, ev.amount);
      if (ev.kind === 'damage') shakeElement(el);
    });
    Game.state.events = [];
  }

  function render() {
    const { phase } = Game.state;
    let html = '';
    if (phase === 'intro') {
      html = galleryOpen ? renderGallery() : renderIntro();
      if (howToOpen && !galleryOpen) html += renderHowTo();
    } else if (phase === 'bonus') {
      html = renderBonus();
    } else if (phase === 'shop') {
      html = renderShop();
    } else if (phase === 'playing') {
      html = renderBattle();
      if (Game.state.pendingEcho) html += renderEchoChoice(Game.state.pendingEcho);
    } else if (phase === 'reward') {
      html = renderBattle() + renderReward();
    } else if (phase === 'gameover') {
      html = renderBattle() + renderGameOver();
    }
    root.innerHTML = html;

    const logPanel = root.querySelector('.log-panel');
    if (logPanel) logPanel.scrollTop = logPanel.scrollHeight;

    consumeEvents();
  }

  function runEnemyTurnLoop() {
    const step = () => {
      const done = Game.stepEnemyTurn();
      render();
      if (!done && Game.state.phase === 'playing') {
        setTimeout(step, 700);
      }
    };
    setTimeout(step, 500);
  }

  function endTurnAndAdvance() {
    Game.endPlayerTurn();
    render();
    if (Game.state.turn === 'enemy') runEnemyTurnLoop();
  }

  function commitPlay(handIndex) {
    Game.playCard(handIndex);
    render();
    const s = Game.state;
    if (s.phase === 'playing' && s.turn === 'player' && s.player.hand.length === 0) {
      endTurnAndAdvance();
    }
  }

  // Defense cards protect the player, so they can be played by dropping them
  // right back in their own hand zone; attack & strategy cards need to reach
  // the enemy on the battlefield.
  function zoneSelectorFor(card) {
    return card && card.type === 'defense' ? '.hand-area' : '.battlefield';
  }

  function isOverElement(selector, x, y) {
    const zone = root.querySelector(selector);
    if (!zone) return false;
    const r = zone.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function beginDrag(handCard, handIndex, x, y) {
    const inst = Game.state.player.hand[handIndex];
    const card = inst && Cards.get(inst.id);
    const isDefense = !!card && card.type === 'defense';
    dragState = {
      el: handCard,
      handIndex,
      startX: x,
      startY: y,
      dx: 0,
      dy: 0,
      rot: 0,
      moved: false,
      over: false,
      isDefense,
      zoneSelector: zoneSelectorFor(card),
    };
    handCard.style.transition = ''; // clear any leftover snap-back transition so dragging tracks the pointer 1:1
    handCard.classList.add('dragging');
  }

  function moveDrag(x, y) {
    if (!dragState) return;
    const dx = x - dragState.startX;
    const dy = y - dragState.startY;
    if (Math.hypot(dx, dy) > 6) dragState.moved = true;
    const rot = Math.max(-18, Math.min(18, dx * 0.08));
    dragState.dx = dx;
    dragState.dy = dy;
    dragState.rot = rot;
    dragState.el.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;

    const over = isOverElement(dragState.zoneSelector, x, y);
    dragState.over = over;
    dragState.el.classList.toggle(dragState.isDefense ? 'can-drop-defense' : 'can-drop', over);
    const zone = root.querySelector(dragState.zoneSelector);
    if (zone) zone.classList.toggle('drag-target-active', over);
  }

  function snapBack(el) {
    el.classList.remove('dragging', 'can-drop', 'can-drop-defense');
    el.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)';
    el.style.transform = '';
    let done = false;
    const finish = (ev) => {
      if (done || (ev && ev.propertyName !== 'transform')) return;
      done = true;
      el.style.transition = '';
      el.removeEventListener('transitionend', finish);
    };
    el.addEventListener('transitionend', finish);
    setTimeout(finish, 300); // fallback if transitionend never fires (reduced motion, no-op transform, throttled tab)
  }

  // Defense cards protect the player in place — a quick settle-and-fade.
  function playDefense(el, dx, dy, handIndex) {
    el.classList.remove('dragging', 'can-drop-defense');
    el.style.transition = 'transform 0.16s ease-out, opacity 0.16s ease-out';
    el.style.transform = `translate(${dx}px, ${dy}px) scale(0.82)`;
    el.style.opacity = '0';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      commitPlay(handIndex);
    };
    el.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 220); // fallback for prefers-reduced-motion / throttled tabs
  }

  // Attack & strategy cards wind up (pull back, like drawing a weapon) before
  // swinging forward through the enemy — momentum before the hit.
  function playAttack(el, dx, dy, rot, handIndex) {
    el.classList.remove('dragging', 'can-drop');
    let done = false;
    let swung = false;
    const commit = () => {
      if (done) return;
      done = true;
      commitPlay(handIndex);
    };
    const swing = () => {
      if (swung) return;
      swung = true;
      el.style.transition = 'transform 0.13s cubic-bezier(0.55, 0, 1, 1), opacity 0.13s ease-in';
      el.style.transform = `translate(${dx}px, ${dy - 55}px) rotate(${rot}deg) scale(0.5)`;
      el.style.opacity = '0';
      el.addEventListener('transitionend', commit, { once: true });
      setTimeout(commit, 180);
    };

    const windupDx = dx * 0.5;
    const windupDy = dy * 0.5 + 22;
    const windupRot = rot * -0.8;
    el.style.transition = 'transform 0.11s ease-out';
    el.style.transform = `translate(${windupDx}px, ${windupDy}px) rotate(${windupRot}deg) scale(1.08)`;
    el.addEventListener('transitionend', swing, { once: true });
    setTimeout(swing, 150); // fallback if the windup transitionend never fires
  }

  function endDrag() {
    if (!dragState) return;
    const { el, handIndex, dx, dy, rot, moved, over, isDefense } = dragState;
    const zone = root.querySelector(dragState.zoneSelector);
    if (zone) zone.classList.remove('drag-target-active');
    dragState = null;

    const inst = Game.state.player.hand[handIndex];
    const card = inst && Cards.get(inst.id);
    const canPlay = card
      && Game.state.phase === 'playing'
      && Game.state.turn === 'player'
      && !Game.state.pendingEcho
      && Game.state.player.actions >= card.cost;

    if (moved && over && canPlay) {
      if (isDefense) {
        playDefense(el, dx, dy, handIndex);
      } else {
        playAttack(el, dx, dy, rot, handIndex);
      }
    } else {
      snapBack(el);
    }
  }

  function init() {
    root = document.getElementById('app');
    if (root.dataset.uiInitialized) {
      render();
      return;
    }
    root.dataset.uiInitialized = 'true';

    root.addEventListener('pointerdown', (e) => {
      if (dragState) return;
      const handCard = e.target.closest('.hand-card');
      if (!handCard) return;
      if (Game.state.phase !== 'playing' || Game.state.turn !== 'player' || Game.state.pendingEcho) return;
      beginDrag(handCard, Number(handCard.dataset.handIndex), e.clientX, e.clientY);
      e.preventDefault();
    });

    document.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      moveDrag(e.clientX, e.clientY);
    });

    document.addEventListener('pointerup', () => endDrag());
    document.addEventListener('pointercancel', () => endDrag());

    root.addEventListener('click', (e) => {
      const endTurnBtn = e.target.closest('.end-turn-btn');
      const rewardCard = e.target.closest('.reward-card');
      const skipBtn = e.target.closest('.skip-reward-btn');
      const beginBtn = e.target.closest('.begin-btn');
      const retryBtn = e.target.closest('.retry-btn');
      const viewCardsBtn = e.target.closest('.view-cards-btn');
      const backToMenuBtn = e.target.closest('.back-to-menu-btn');
      const howToBtn = e.target.closest('.howto-btn');
      const closeHowToBtn = e.target.closest('.close-howto-btn');
      const echoCard = e.target.closest('.echo-choice-card');
      const shopBuyBtn = e.target.closest('.shop-buy-btn');
      const leaveShopBtn = e.target.closest('.leave-shop-btn');
      const continueBonusBtn = e.target.closest('.continue-bonus-btn');

      if (continueBonusBtn) {
        Game.continueFromBonus();
        render();
      } else if (shopBuyBtn && !shopBuyBtn.disabled) {
        Game.buyCard(Number(shopBuyBtn.dataset.shopIndex));
        render();
      } else if (leaveShopBtn) {
        Game.leaveShop();
        render();
      } else if (echoCard) {
        Game.resolveEchoChoice(echoCard.dataset.echoId);
        render();
      } else if (endTurnBtn && !endTurnBtn.disabled && !dragState) {
        endTurnAndAdvance();
      } else if (rewardCard) {
        Game.chooseReward(Number(rewardCard.dataset.rewardIndex));
        render();
      } else if (skipBtn) {
        Game.chooseReward(null);
        render();
      } else if (beginBtn) {
        galleryOpen = false;
        howToOpen = false;
        Game.newRun();
        render();
      } else if (retryBtn) {
        galleryOpen = false;
        howToOpen = false;
        Game.newRun();
        render();
      } else if (viewCardsBtn) {
        galleryOpen = true;
        howToOpen = false;
        render();
      } else if (backToMenuBtn) {
        galleryOpen = false;
        render();
      } else if (howToBtn) {
        howToOpen = true;
        render();
      } else if (closeHowToBtn) {
        howToOpen = false;
        render();
      }
    });

    render();
  }

  global.DB = global.DB || {};
  global.DB.UI = { init, render };
})(window);
