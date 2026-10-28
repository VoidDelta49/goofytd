// Keyboard, mouse and touch input. Writes view angles and the player's pending
// input; never touches simulation state directly.
//
// Mouse look has two paths:
//  1. Pointer lock (normal): every mouse count turns the view.
//  2. Drag-to-look fallback, used when the browser refuses pointer lock
//     (sandboxed embeds without allow-pointer-lock, Chrome's ~1 s re-lock
//     cooldown after Esc, browsers without the API). Without it a refused
//     lock left the mouse unable to look at all, with no message.

import { TouchControls } from './touch.js';

/** Keys by `KeyboardEvent.code`, so bindings follow physical position on any layout. */
export const BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  // No Ctrl: Ctrl+W closes the browser tab and can't be blocked outside
  // fullscreen keyboard lock, and crouch-walking forward is exactly Ctrl+W.
  crouch: ['KeyC', 'ShiftLeft'],
  respawn: ['KeyR'],
  autoHop: ['KeyH'],
  sensDown: ['BracketLeft'],
  sensUp: ['BracketRight'],
};

const SETTINGS_KEY = 'goofytd.settings';

/**
 * sensitivity: degrees of turn per mouse count = sensitivity × 0.022, the
 * Quake/Source m_yaw unit FPS players already know.
 * touchSensitivity: degrees of turn per CSS pixel of finger drag.
 */
export function loadSettings() {
  const defaults = { sensitivity: 2.0, touchSensitivity: 0.3 };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * One mousemove event never legitimately moves more than this many counts
 * (a fast flick on a 16000 DPI mouse is ~100). Larger values are the pointer
 * warping to the lock centre or a driver spike, not the hand.
 */
export const MAX_MOUSE_DELTA = 300;

/** Returns [dx, dy] if the event is a real movement, or null to discard it. */
export function sanitizeMouseDelta(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.abs(dx) > MAX_MOUSE_DELTA || Math.abs(dy) > MAX_MOUSE_DELTA) return null;
  return [dx, dy];
}

export class Input {
  /**
   * @param {HTMLElement} target the game canvas; receives pointer lock and touches
   * @param {HTMLElement} touchRoot overlay holding the touch buttons
   * @param {import('../player.js').PlayerController} player
   * @param {object} cfg movement config (for the auto-hop toggle)
   */
  constructor(target, touchRoot, player, cfg) {
    this.target = target;
    this.player = player;
    this.cfg = cfg;
    this.settings = loadSettings();
    this.down = new Set();
    this.locked = false;
    /** Drag-to-look mode after pointer lock was refused. */
    this.freeLook = false;
    this.dragging = false;
    /** Why mouse capture failed; shown by the HUD. */
    this.notice = '';
    this.lastPointerType = 'mouse';
    const params = new URLSearchParams(location.search);
    /** Raw (unaccelerated) lock is opt-in with ?raw=1: it is the riskiest path on Linux. */
    this.rawMouse = params.get('raw') === '1';
    this.debug = params.has('debug');
    /** Diagnostics for ?debug: what the browser actually reports. */
    this.stats = { events: 0, discarded: 0, last: [0, 0], maxAbs: 0, perSec: 0, _count: 0, _t: performance.now(), mode: 'none' };
    this.touch = new TouchControls(target, touchRoot, this);

    if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch-device');

    target.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    target.addEventListener('pointermove', (e) => this.onPointerMove(e));
    target.addEventListener('pointerup', () => { this.dragging = false; });
    target.addEventListener('pointercancel', () => { this.dragging = false; });
    target.addEventListener('click', () => {
      // A tap also fires click; phones have no pointer lock to ask for.
      if (this.lastPointerType === 'mouse') this.lock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === target;
      this.skipNextMove = true; // first event after a lock change can be the warp to centre
      if (this.locked) {
        this.freeLook = false;
        this.notice = '';
      } else {
        this.down.clear();
      }
    });
    // Firefox and Safari report refusals only through this event.
    document.addEventListener('pointerlockerror', () => this.lockFailed());
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.dragging = false;
      this.freeLook = false;
      this.touch.release();
    });
  }

  /** Whether game input is live (the "click to play" overlay is hidden). */
  get active() {
    return this.locked || this.freeLook || this.touch.enabled;
  }

  async lock() {
    if (this.locked) return;
    if (typeof this.target.requestPointerLock !== 'function') {
      this.lockFailed('This browser has no mouse capture.');
      return;
    }
    try {
      if (this.rawMouse) {
        this.stats.mode = 'raw';
        await this.target.requestPointerLock({ unadjustedMovement: true });
      } else {
        this.stats.mode = 'standard';
        await this.target.requestPointerLock();
      }
    } catch (e) {
      if (this.rawMouse && e?.name === 'NotSupportedError') {
        this.stats.mode = 'standard (raw unsupported)';
        try { await this.target.requestPointerLock(); } catch { this.lockFailed(); }
      } else {
        this.lockFailed();
      }
    }
  }

  lockFailed(reason = 'Mouse capture was refused.') {
    if (this.locked) return;
    this.freeLook = true;
    this.notice = `${reason} Hold the left button and drag to look · click to retry · Esc to stop`;
  }

  /** Locked mouse: every count turns the view. */
  onMouseMove(e) {
    if (this.locked) this.turnByMouse(e.movementX, e.movementY);
  }

  onPointerDown(e) {
    this.lastPointerType = e.pointerType;
    if (e.pointerType !== 'mouse' || this.locked || !this.freeLook || e.button !== 0) return;
    this.dragging = true;
    this.target.setPointerCapture(e.pointerId);
  }

  /** Unlocked fallback: turn only while the left button is held. */
  onPointerMove(e) {
    if (this.dragging && !this.locked && e.pointerType === 'mouse') this.turnByMouse(e.movementX, e.movementY);
  }

  turnByMouse(dx, dy) {
    const st = this.stats;
    st.events++; st._count++;
    const now = performance.now();
    if (now - st._t >= 1000) { st.perSec = Math.round((st._count * 1000) / (now - st._t)); st._count = 0; st._t = now; }
    st.last = [dx, dy];
    st.maxAbs = Math.max(st.maxAbs, Math.abs(dx) || 0, Math.abs(dy) || 0);
    if (this.skipNextMove) { this.skipNextMove = false; st.discarded++; return; }
    const d = sanitizeMouseDelta(dx, dy);
    if (!d) { st.discarded++; return; }
    [dx, dy] = d;
    const radPerCount = (this.settings.sensitivity * 0.022 * Math.PI) / 180;
    // Mouse right turns right (negative yaw); mouse down looks down.
    this.player.look(-dx * radPerCount, -dy * radPerCount);
  }

  onWheel(e) {
    if (!this.locked && !this.freeLook) return;
    e.preventDefault();
    // Scroll-wheel jump: the classic bunny-hop bind.
    if (e.deltaY !== 0) this.player.pending.jumpPressed = true;
  }

  adjustTouchSensitivity(delta) {
    this.settings.touchSensitivity = Math.round(clamp(this.settings.touchSensitivity + delta, 0.05, 2) * 100) / 100;
    saveSettings(this.settings);
  }

  onKey(e, isDown) {
    const is = (action) => BINDINGS[action].includes(e.code);
    if (isDown && e.code === 'Escape' && this.freeLook) {
      this.freeLook = false;
      this.notice = '';
      this.down.clear();
      return;
    }
    if (!this.active) {
      if (isDown && is('respawn')) this.player.pending.respawn = true;
      return;
    }
    e.preventDefault();
    if (isDown) {
      if (e.repeat) return;
      this.down.add(e.code);
      if (is('jump')) this.player.pending.jumpPressed = true;
      if (is('respawn')) this.player.pending.respawn = true;
      if (is('autoHop')) {
        this.cfg.autoHop = !this.cfg.autoHop;
        this.touch.syncButtons();
      }
      if (is('sensDown') || is('sensUp')) {
        const s = this.settings.sensitivity + (is('sensUp') ? 0.1 : -0.1);
        this.settings.sensitivity = Math.round(clamp(s, 0.1, 10) * 10) / 10;
        saveSettings(this.settings);
      }
    } else {
      this.down.delete(e.code);
    }
  }

  /** Merge keys and touch into the player's pending input. Call once per frame. */
  sample() {
    const held = (action) => BINDINGS[action].some((c) => this.down.has(c));
    const t = this.touch;
    const p = this.player.pending;
    // Keys and stick add; movement.js normalises anything longer than 1.
    p.wish = {
      x: clamp((held('right') ? 1 : 0) - (held('left') ? 1 : 0) + t.wish.x, -1, 1),
      y: clamp((held('forward') ? 1 : 0) - (held('back') ? 1 : 0) + t.wish.y, -1, 1),
    };
    p.jumpHeld = held('jump') || t.jumpHeld;
    p.crouchHeld = held('crouch') || t.crouchOn;
  }
}
