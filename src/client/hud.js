// DOM overlay: speed readout, movement state, FPS and controls hint.

import { horizontalSpeed } from '../sim/movement.js';

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
    this.frameTimes = [];
    this.lastText = 0;
  }

  /** @param {number} now ms timestamp @param {number} frameDt seconds */
  update(now, frameDt, player, cfg, input) {
    this.frameTimes.push(frameDt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    this.hintEl.hidden = input.active;
    if (this.noticeEl.textContent !== input.notice) this.noticeEl.textContent = input.notice;

    // Text 15× per second is plenty and avoids per-frame layout work.
    if (now - this.lastText < 66) return;
    this.lastText = now;

    if (this.debugEl) {
      const st = input.look.stats;
      this.debugEl.textContent =
        `mouse debug (?debug)\nlock ${input.locked} · mode ${input.lockMode} · dpr ${devicePixelRatio}\n` +
        `last dx,dy ${st.last.join(', ')} · max |delta| ${st.maxAbs}\n` +
        `accepted ${st.accepted} · rejected ${st.rejected} · sens ${input.settings.sensitivity}\n` +
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
      (input.touch.enabled
        ? ` · look ${input.settings.touchSensitivity.toFixed(2)}°/px`
        : ` · sens ${input.settings.sensitivity.toFixed(1)}`) +
      ` · ${avg > 0 ? Math.round(1 / avg) : 0} fps`;
  }
}
