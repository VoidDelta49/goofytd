// Upgrade panel: look at a tower and press U (or tap UPGRADE) to open it.
// Shows the tower's level, what it does now, and a card per upgrade it can
// take next: one card for a straight buff, two for a "pick your path" variant
// choice. Cards cascade in; buying one plays a burst and cascades the next set.
// Owns no game state: main.js passes actions in. The model is built by the
// pure upgradeModel() (tested in Node); this class only draws it.

import { TOWER_FORMS, SELL_REFUND, maxLevel, towerStats } from '../sim/towers.js';

/** Changed or new stat rows between two forms, for a card: { label, from, to, better, fresh }. */
export function statDeltas(fromDef, toDef) {
  const before = new Map(towerStats(fromDef).map((r) => [r.key, r]));
  const out = [];
  for (const r of towerStats(toDef)) {
    const b = before.get(r.key);
    if (b && b.value === r.value) continue;
    out.push({ label: r.label, from: b ? b.value : null, to: r.value, better: !b || r.num >= b.num, fresh: !b });
  }
  return out;
}

/**
 * Everything the panel shows for tower `t` with `money`. Pure.
 * options: one per next form, in definition order (that order is the 1/2 hotkeys).
 */
export function upgradeModel(t, money) {
  const def = t.def;
  const options = def.upgrades.map((id, k) => {
    const f = TOWER_FORMS[id];
    return {
      id, n: k + 1, name: f.name, blurb: f.blurb, kind: f.kind, cost: f.upgradeCost,
      afford: money >= f.upgradeCost, accent: f.accent, level: f.level, deltas: statDeltas(def, f),
    };
  });
  // The path so far, base first: for the level pips.
  const path = [];
  for (let f = def; f; f = f.from ? TOWER_FORMS[f.from] : null) path.unshift(f);
  return {
    id: t.id, form: def.id, name: def.name, blurb: def.blurb, accent: def.accent,
    level: def.level, maxLevel: maxLevel(def.root), path: path.map((f) => ({ name: f.name, kind: f.kind })),
    stats: towerStats(def), kills: t.kills, refund: Math.floor(t.spent * SELL_REFUND),
    choice: options.length > 1, maxed: options.length === 0, options,
  };
}

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class UpgradeMenu {
  /**
   * @param {HTMLElement} root the #upgrade overlay
   * @param {{buy:(formId:string)=>void, sell:()=>void, close:()=>void}} actions
   */
  constructor(root, actions) {
    this.root = root;
    this.actions = actions;
    this.sheet = root.querySelector('.up-sheet');
    this.tower = null;
    this.model = null;
    this.money = -1;
    this.closeTimer = 0;
    this.touchUi = document.body.classList.contains('touch-device');
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    // Taps on the panel must not reach the canvas (look / build) underneath.
    for (const ev of ['pointerdown', 'mousedown', 'touchstart']) {
      this.sheet.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
  }

  get isOpen() { return this.tower !== null; }

  open(tower, game) {
    clearTimeout(this.closeTimer);
    this.tower = tower;
    this.root.hidden = false;
    document.body.classList.add('upgrading');
    this.root.classList.remove('closing');
    this.render(game, 'open');
  }

  close() {
    if (!this.tower) return;
    this.tower = null;
    document.body.classList.remove('upgrading');
    this.root.classList.add('closing');
    // Let the slide-out play, then hide (immediately for reduced motion).
    const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 170;
    this.closeTimer = setTimeout(() => { this.root.hidden = true; this.root.classList.remove('closing'); }, ms);
  }

  /** The n-th card (1-based hotkey). */
  pick(n) {
    const o = this.model?.options[n - 1];
    if (o) this.actions.buy(o.id);
  }

  onClick(e) {
    const el = e.target.closest?.('[data-up]');
    if (!el) {
      if (e.target === this.root) this.actions.close(); // tap outside the sheet
      return;
    }
    const what = el.dataset.up;
    if (what === 'close') this.actions.close();
    else if (what === 'sell') this.actions.sell();
    else if (what === 'buy') this.actions.buy(el.dataset.form);
  }

  /** Per frame: close if the tower is gone, keep affordability current, rebuild after an upgrade. */
  update(game) {
    if (!this.tower) return;
    if (game.lost || game.towers.get(this.tower.id) !== this.tower) { this.actions.close(); return; }
    if (this.model.form !== this.tower.def.id) { this.render(game, 'bought'); return; }
    if (game.money !== this.money) {
      this.money = game.money;
      this.model = upgradeModel(this.tower, game.money);
      for (const o of this.model.options) {
        this.sheet.querySelector(`.card[data-form="${o.id}"]`)?.classList.toggle('poor', !o.afford);
      }
    }
    const kills = `${this.tower.kills} kill${this.tower.kills === 1 ? '' : 's'}`;
    if (this.killsEl.textContent !== kills) this.killsEl.textContent = kills;
  }

  /** Shake the card and say why (not enough moolah, …). */
  refuse(formId, reason) {
    const card = this.sheet.querySelector(`.card[data-form="${formId}"]`);
    if (card) {
      card.classList.remove('shake');
      void card.offsetWidth; // restart the animation
      card.classList.add('shake');
    }
    this.flash(reason, true);
  }

  flash(text, bad = false) {
    const el = this.sheet.querySelector('.up-msg');
    el.textContent = text;
    el.classList.toggle('bad', bad);
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  /** Full redraw; `how` is 'open' or 'bought' (adds the level-up burst). Re-running the markup restarts every cascade. */
  render(game, how) {
    const m = (this.model = upgradeModel(this.tower, game.money));
    this.money = game.money;
    const keys = !this.touchUi;
    const pips = [];
    for (let k = 1; k <= m.maxLevel; k++) {
      const step = m.path[k - 1];
      const cls = k <= m.level ? (step.kind === 'variant' ? 'pip on star' : 'pip on') : 'pip';
      pips.push(`<i class="${cls}${k === m.level && how === 'bought' ? ' pop' : ''}" title="${step ? esc(step.name) : `level ${k}`}"></i>`);
    }
    const stats = m.stats.map((r, k) => `<div class="stat" style="--i:${k}"><span>${esc(r.label)}</span><b>${esc(r.value)}</b></div>`).join('');
    let cards;
    if (m.maxed) {
      cards = `<div class="card maxed" style="--i:0;--accent:${hex(m.accent)}"><div class="badge">MAXED OUT</div>
        <div class="cname">${esc(m.name)}</div><p>Fully upgraded. This cow-stopper is as good as it gets.</p></div>`;
    } else {
      cards = m.options.map((o, k) => {
        const rows = o.deltas.slice(0, 5).map((d, j) =>
          `<li style="--j:${j}" class="${d.better ? 'up' : 'down'}"><span>${esc(d.label)}</span>` +
          (d.fresh ? `<b class="new">${esc(d.to)}</b>` : `<s>${esc(d.from)}</s><b>${esc(d.to)}</b>`) + '</li>').join('');
        return `<div class="card ${o.kind}${o.afford ? '' : ' poor'}" data-form="${o.id}" style="--i:${k};--accent:${hex(o.accent)}">
          <div class="badge">${o.kind === 'variant' ? '★ NEW VARIANT' : `▲ LEVEL ${o.level}`}</div>
          <div class="cname">${esc(o.name)}</div>
          <p>${esc(o.blurb)}</p>
          <ul>${rows}</ul>
          <button data-up="buy" data-form="${o.id}">${keys ? `<kbd>${o.n}</kbd>` : ''}UPGRADE <span class="price">${o.cost}</span></button>
        </div>`;
      }).join('');
    }
    this.sheet.style.setProperty('--accent', hex(m.accent));
    this.sheet.classList.toggle('bought', how === 'bought');
    this.sheet.innerHTML = `
      <header>
        <div class="title">
          <div class="tname">${esc(m.name)}</div>
          <div class="pips">${pips.join('')}<span class="lv">LV ${m.level}${m.maxed ? ' · MAX' : ''}</span></div>
        </div>
        <button class="x" data-up="close" aria-label="Close upgrades">✕</button>
      </header>
      <div class="stats">${stats}</div>
      ${m.choice ? '<div class="choose">CHOOSE YOUR PATH <small>(you can only pick one)</small></div>' : ''}
      <div class="cards">${cards}</div>
      <footer>
        <span class="kills"></span>
        <span class="up-msg"></span>
        <button class="sell" data-up="sell">SELL <span class="price">+${m.refund}</span></button>
      </footer>
      ${keys ? `<div class="keys">${m.maxed ? '' : m.options.map((o) => `<kbd>${o.n}</kbd>`).join(' ') + ' upgrade · '}<kbd>U</kbd>/<kbd>Q</kbd> close · <kbd>X</kbd> sell</div>` : ''}`;
    this.killsEl = this.sheet.querySelector('.kills');
    this.killsEl.textContent = '';
    if (how === 'bought') this.flash(`${m.name}!`);
    this.update(game);
  }
}
