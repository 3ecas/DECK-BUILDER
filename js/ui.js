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
      <div class="overlay">
        <div class="overlay-panel">
          <h1>Hell Tower</h1>
          <p class="tagline">A deck-building descent. Attack, defend, and outwit whatever climbs to meet you.</p>
          <ul class="rules">
            <li><b>⚔️ Attack</b> and <b>🛡️ Defense</b> cards are free to play. <b>✨ Strategy</b> cards cost Actions &mdash; your one limited resource each turn.</li>
            <li>Your hand holds at most 2 cards, and unplayed cards carry over between turns &mdash; you only draw back up to 2.</li>
            <li>Some cards combo off each other &mdash; read their text. A few Strategy cards grant extra Actions.</li>
            <li>Watch for status effects: 🔱 Thorns reflects damage back at attackers, ☠️ Poison and 🩸 Bleed tick down over time.</li>
            <li>Some cards steal Block or Strength straight from the enemy, cleanse your own bad conditions, or repeat an effect you already played this turn.</li>
            <li>Cards come in five color archetypes &mdash; <b style="color:#ff6659">red</b> (attack &amp; bleed), <b style="color:#8bc34a">green</b> (poison), <b style="color:#6fa8dc">blue</b> (defense), <b style="color:#e8d16a">yellow</b> (healing), and <b style="color:#c9c9c9">grey</b> (draw, actions, debuffs). Rewards rotate through all five, so keep an eye out for synergies.</li>
            <li>Click a card in your hand to play it. Hover to see it up close.</li>
            <li>Defeat an enemy to pick one reward: a new card, HP, or gold (plus a little bonus gold on every kill). Every 5th enemy is a tougher boss &mdash; beat one for a bigger reward and a shot at one of its own cards.</li>
            <li>Between fights you'll choose from 3 paths: a battle, a treasure chest (free card), a tavern (rest and heal), or a shop (spend gold on cards, pricier at greater depth).</li>
            <li>Fall, and the run ends.</li>
          </ul>
          <div class="menu-actions">
            <button class="btn btn-primary begin-btn">Begin Descent</button>
            <button class="btn view-cards-btn">View All Cards</button>
          </div>
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

    const handHtml = p.hand
      .map((inst, i) => {
        const card = Cards.get(inst.id);
        const affordable = p.actions >= card.cost ? '' : 'card-disabled';
        const n = p.hand.length;
        const center = (n - 1) / 2;
        const offset = i - center;
        const rot = offset * 6;
        const lift = Math.abs(offset) * 6;
        return cardHtml(
          card,
          1,
          `hand-card ${affordable}`,
          `data-hand-index="${i}" style="--rot:${rot}deg;--lift:${lift}px;z-index:${i}"`
        );
      })
      .join('');

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

  function pathOptionHtml(opt, i) {
    if (opt.type === 'enemy') {
      const en = opt.enemy;
      return `
        <div class="path-card path-enemy ${en.isBoss ? 'path-boss' : ''}" data-path-index="${i}">
          <div class="path-icon">${en.emoji}</div>
          <div class="path-title">${en.isBoss ? 'Boss: ' : ''}${esc(en.name)}</div>
          <div class="path-desc">${en.hp} HP &middot; ${en.cardsPerTurn} card${en.cardsPerTurn > 1 ? 's' : ''}/turn</div>
        </div>`;
    }
    if (opt.type === 'chest') {
      return `
        <div class="path-card path-chest" data-path-index="${i}">
          <div class="path-icon">🎁</div>
          <div class="path-title">Treasure Chest</div>
          <div class="path-desc">Find a free card.</div>
        </div>`;
    }
    if (opt.type === 'tavern') {
      return `
        <div class="path-card path-tavern" data-path-index="${i}">
          <div class="path-icon">🍺</div>
          <div class="path-title">Tavern</div>
          <div class="path-desc">Rest and recover some HP.</div>
        </div>`;
    }
    return `
      <div class="path-card path-shop" data-path-index="${i}">
        <div class="path-icon">🛒</div>
        <div class="path-title">Shop</div>
        <div class="path-desc">Spend gold on new cards.</div>
      </div>`;
  }

  function renderPath() {
    const { pathOptions, player, floor } = Game.state;
    const cardsHtml = pathOptions.map(pathOptionHtml).join('');
    return `
      <div class="overlay">
        <div class="overlay-panel">
          <h1>Choose Your Path</h1>
          <p class="tagline">Floor ${floor} cleared &middot; 💰 ${player.gold} gold &middot; ❤️ ${player.hp}/${player.maxHp} HP</p>
          <div class="path-options">${cardsHtml}</div>
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
    } else if (phase === 'path') {
      html = renderPath();
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

  function init() {
    root = document.getElementById('app');
    if (root.dataset.uiInitialized) {
      render();
      return;
    }
    root.dataset.uiInitialized = 'true';

    root.addEventListener('click', (e) => {
      const handCard = e.target.closest('.hand-card');
      const endTurnBtn = e.target.closest('.end-turn-btn');
      const rewardCard = e.target.closest('.reward-card');
      const skipBtn = e.target.closest('.skip-reward-btn');
      const beginBtn = e.target.closest('.begin-btn');
      const retryBtn = e.target.closest('.retry-btn');
      const viewCardsBtn = e.target.closest('.view-cards-btn');
      const backToMenuBtn = e.target.closest('.back-to-menu-btn');
      const echoCard = e.target.closest('.echo-choice-card');
      const pathCard = e.target.closest('.path-card');
      const shopBuyBtn = e.target.closest('.shop-buy-btn');
      const leaveShopBtn = e.target.closest('.leave-shop-btn');

      if (pathCard) {
        Game.choosePath(Number(pathCard.dataset.pathIndex));
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
      } else if (handCard) {
        Game.playCard(Number(handCard.dataset.handIndex));
        render();
        const s = Game.state;
        if (s.phase === 'playing' && s.turn === 'player' && s.player.hand.length === 0) {
          endTurnAndAdvance();
        }
      } else if (endTurnBtn && !endTurnBtn.disabled) {
        endTurnAndAdvance();
      } else if (rewardCard) {
        Game.chooseReward(Number(rewardCard.dataset.rewardIndex));
        render();
      } else if (skipBtn) {
        Game.chooseReward(null);
        render();
      } else if (beginBtn) {
        galleryOpen = false;
        Game.newRun();
        render();
      } else if (retryBtn) {
        galleryOpen = false;
        Game.newRun();
        render();
      } else if (viewCardsBtn) {
        galleryOpen = true;
        render();
      } else if (backToMenuBtn) {
        galleryOpen = false;
        render();
      }
    });

    render();
  }

  global.DB = global.DB || {};
  global.DB.UI = { init, render };
})(window);
