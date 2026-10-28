// DOM overlay: speed readout, movement state, FPS and controls hint.

import { horizontalSpeed } from '../sim/movement.js';
import { SELL_REFUND, TOWER_TYPES } from '../sim/towers.js';

export class Hud {
  constructor(root) {
    this.root = root;
    this.speedEl = root.querySelector('[data-hud=speed]');
    this.infoEl = root.querySelector('[data-hud=info]');
    this.hintEl = root.querySelector('[data-hud=hint]');
    this.noticeEl = root.querySelector('[data-hud=notice]');
    this.debugEl = null;
    if (new URLSearchParams(location.search).has('debug')) {
      this.debugEl = document.createElement('pre');
      this.debugEl.style.cssText = 'position:absolute;left:14px;bottom:10px;margin:0;font:12px/1.3 monospace;background:#000a;padding:6px 8px;border-radius:6px';
      root.appendChild(this.debugEl);
    }
    this.tdEl = root.querySelector('[data-hud=td]');
    this.milkBar = root.querySelector('[data-hud=milkbar]');
    this.buildBar = root.querySelector('[data-hud=buildbar]');
    this.placeEl = root.querySelector('[data-hud=place]');
    this.bannerEl = root.querySelector('[data-hud=banner]');
    /** "Start wave 1" button, shown until the first wave begins (and again after a restart). */
    this.startEl = root.querySelector('[data-hud=startwave]');
    /** "Try again" button, shown once the milk is gone (Enter only works with a keyboard). */
    this.restartEl = root.querySelector('[data-hud=restart]');
    this.buildSlots = [];
    /** Touch layout: hints name the on-screen buttons instead of keys. */
    this.touchUi = document.body.classList.contains('touch-device');
    this.frameTimes = [];
    this.lastText = 0;
  }

  /** @param {number} now ms timestamp @param {number} frameDt seconds */
  update(now, frameDt, player, cfg, input, game, build) {
    this.updateTd(now, game, build);
    this.frameTimes.push(frameDt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    this.hintEl.hidden = input.active || input.paused;
    if (this.noticeEl.textContent !== input.notice) this.noticeEl.textContent = input.notice;

    // Text 15× per second is plenty and avoids per-frame layout work.
    if (now - this.lastText < 66) return;
    this.lastText = now;

    if (this.debugEl) {
      const st = input.look.stats;
      this.debugEl.textContent =
        `mouse debug (?debug)\nlock ${input.locked} · mode ${input.lockMode} · dpr ${devicePixelRatio}\n` +
        `last dx,dy ${st.last.join(', ')} · max |delta| ${st.maxAbs}\n` +
        `accepted ${st.accepted} · rejected ${st.rejected} · echoes ${st.echoes}${st.echo ? ' (FIREFOX ECHO FILTER ON)' : ''} · sens ${input.settings.sensitivity}\n` +
        `yaw ${(player.yaw * 180 / Math.PI).toFixed(1)}° pitch ${(player.pitch * 180 / Math.PI).toFixed(1)}°\n${navigator.userAgent.slice(0, 90)}`;
    }
    const s = player.state;
    const speed = horizontalSpeed(s);
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const where = s.grounded ? 'ground' : 'air';
    this.speedEl.textContent = `${speed.toFixed(2)} m/s`;
    // Gold once air strafing pushes past running speed.
    this.speedEl.classList.toggle('fast', speed > cfg.maxGroundSpeed + 0.1);
    this.infoEl.textContent =
      `top ${player.topSpeed.toFixed(2)} · ${where}${s.crouched ? ', crouched' : ''}` +
      ` · auto-hop ${cfg.autoHop ? 'on' : 'off'}` +
      // On touch, look speed lives in the pause menu; keep this line short so it clears NEXT WAVE.
      (input.touch.enabled ? '' : ` · sens ${input.settings.sensitivity.toFixed(1)}`) +
      ` · ${avg > 0 ? Math.round(1 / avg) : 0} fps`;
  }

  /** Milk, money, wave, build bar and placement feedback. Cheap: only touches the DOM when text changes. */
  updateTd(now, game, build) {
    const ids = Object.keys(TOWER_TYPES);
    if (this.buildSlots.length !== ids.length) {
      this.buildBar.replaceChildren();
      this.buildSlots = ids.map((id, k) => {
        const el = document.createElement('div');
        el.className = 'slot';
        el.dataset.n = String(k + 1);
        const t = TOWER_TYPES[id];
        el.innerHTML = `<kbd>${k + 1}</kbd> ${t.name} <span class="cost">${t.cost}</span>`;
        el.title = t.blurb;
        this.buildBar.appendChild(el);
        return { id, el, cost: t.cost };
      });
    }
    for (const s of this.buildSlots) {
      s.el.classList.toggle('on', build.selected === s.id);
      s.el.classList.toggle('poor', game.money < s.cost);
    }

    const pct = Math.max(0, game.milk / game.cfg.milk) * 100;
    this.milkBar.style.width = `${pct}%`;
    const waitingForFirst = game.wave === 0 && !game.lost;
    if (this.startEl.hidden === waitingForFirst) this.startEl.hidden = !waitingForFirst;
    if (this.restartEl.hidden === game.lost) this.restartEl.hidden = !game.lost;
    const next = game.nextWaveIn !== null
      ? `next in ${Math.ceil(game.nextWaveIn)} s`
      : game.wave === 0 ? 'N: start' : game.spawning ? 'incoming' : game.cows.count ? 'mooing' : 'N: next wave';
    setText(this.tdEl,
      `milk ${Math.ceil(game.milk)} · moolah ${game.money}\n` +
      `wave ${game.wave} (${next}) · cows ${game.cows.count} · kills ${game.kills}`);

    let place = '';
    if (build.message && now < build.messageUntil) place = build.message;
    else if (build.preview) {
      const p = build.preview;
      place = p.ok
        ? `${p.type.name}: ${p.type.cost} · ${this.touchUi ? 'tap BUILD' : 'click/E to build · Q cancels'}`
        : `${p.type.name}: ${p.reason}`;
    } else if (build.lookTower) {
      const t = build.lookTower;
      place = `${t.def.name} · ${t.kills} kills · ${this.touchUi ? 'tap SELL' : 'X'} sells for ${Math.floor(t.spent * SELL_REFUND)}`;
    }
    setText(this.placeEl, place);
    this.placeEl.classList.toggle('bad', !!build.preview && !build.preview.ok);
    setText(this.bannerEl, game.lost ? `THE COWS DRANK ALL THE MILK\nwave ${game.wave} · ${game.kills} kills` : '');
  }
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
