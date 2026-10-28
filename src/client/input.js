// Keyboard, mouse and touch input. Gathers raw input only: mouse and touch
// look deltas go into a MouseLook accumulator and are applied to the view
// once per frame in sample(); keys and the touch stick become the player's
// pending input. Never touches simulation state directly.
//
// Mouse look has two capture modes:
//  1. Pointer lock (normal): every mouse count turns the view.
//  2. Drag-to-look, only when pointer lock is truly unavailable (no API, or
//     refused twice outside Chrome's post-Esc cooldown, e.g. a sandboxed
//     embed). A refusal during the cooldown just asks for another click: the
//     game never goes live with a free cursor that can click out of the window.

import { LOCK_COOLDOWN_MS, MouseLook, lockRefusalAction } from './look.js';
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
  fullscreen: ['KeyF'],
  sensDown: ['BracketLeft'],
  sensUp: ['BracketRight'],
  sensReset: ['Backslash'],
  // Building. Digit1..Digit9 pick a tower (handled in onKey).
  place: ['KeyE'],
  sell: ['KeyX'],
  cancelBuild: ['KeyQ'],
  nextWave: ['KeyN'],
  restart: ['Enter'],
  mute: ['KeyM'],
  pause: ['KeyP'],
};

/** Actions forwarded to `Input.handlers` (set by main.js) on key down. */
const HANDLED_ACTIONS = ['place', 'sell', 'cancelBuild', 'nextWave', 'restart', 'mute'];

const SETTINGS_KEY = 'goofytd.settings';

/**
 * sensitivity: degrees of turn per mouse count = sensitivity × 0.022, the
 * Quake/Source unit FPS players already know.
 * touchSensitivity: degrees of turn per CSS pixel of finger drag.
 */
export const DEFAULT_SETTINGS = Object.freeze({ sensitivity: 1.5, touchSensitivity: 0.3 });
const SENS_RANGE = [0.1, 10];
const TOUCH_SENS_RANGE = [0.05, 2];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Stored settings, with anything missing, non-numeric or out of range replaced by the default. */
export function loadSettings(storage = globalThis.localStorage) {
  let stored = {};
  try { stored = JSON.parse(storage?.getItem(SETTINGS_KEY) || '{}') || {}; } catch { /* corrupt or blocked */ }
  const num = (v, [lo, hi], d) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
  return {
    sensitivity: num(stored.sensitivity, SENS_RANGE, DEFAULT_SETTINGS.sensitivity),
    touchSensitivity: num(stored.touchSensitivity, TOUCH_SENS_RANGE, DEFAULT_SETTINGS.touchSensitivity),
  };
}

/**
 * Whether any click, tap or key press should also go fullscreen. On by
 * default (fullscreen also confines the cursor, which Firefox needs). `?fs=0`
 * opts out and remembers it; `?fs=1` opts back in.
 */
const FS_KEY = 'goofytd.fullscreenLock'; // '0' = opted out
export function loadFullscreenLock(fs, storage = globalThis.localStorage) {
  try {
    if (fs === '0') { storage?.setItem(FS_KEY, '0'); return false; }
    if (fs === '1') { storage?.removeItem(FS_KEY); return true; }
    return storage?.getItem(FS_KEY) !== '0';
  } catch { return fs !== '0'; }
}

function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
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
    this.look = new MouseLook();
    this.down = new Set();
    this.locked = false;
    /** Drag-to-look mode after pointer lock was refused. */
    this.freeLook = false;
    this.dragging = false;
    /** Why mouse capture failed; shown by the HUD. */
    this.notice = '';
    this.lastPointerType = 'mouse';
    const params = new URLSearchParams(location.search);
    /** Raw (unaccelerated) lock is opt-in with ?raw=1; it misreports on some Linux setups. */
    this.rawMouse = params.get('raw') === '1';
    this.debug = params.has('debug');
    /** Go fullscreen on any click, tap or key (cursor can't leave the window then). */
    this.fullscreenLock = loadFullscreenLock(params.get('fs'));
    this.fsPending = false;
    this.echoHandled = false;
    this.noticeUntil = 0;
    this.lockMode = 'none';
    this.lockPending = false;
    this.refusals = 0;
    this.lastUnlockAt = -Infinity;
    /** Game actions (building, waves, sound) wired up by main.js: { place, sell, cancelBuild, nextWave, restart, mute, pause, selectTower(n) }. */
    this.handlers = {};
    /** Set by main.js while the game is paused: game keys are ignored, P still resumes. */
    this.paused = false;
    this.touch = new TouchControls(target, touchRoot, this);

    if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch-device');

    for (const ev of ['pointerdown', 'pointerup', 'keydown']) {
      window.addEventListener(ev, (e) => this.onGesture(e), { capture: true, passive: true });
    }
    target.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    // Clicks while captured build (left) or cancel building (right).
    // mousedown, not pointerdown: a second button pressed while the first
    // is held fires no pointerdown.
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.handlers.place?.();
      if (e.button === 2) this.handlers.cancelBuild?.();
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener('pointerup', () => { this.dragging = false; });
    target.addEventListener('pointercancel', () => { this.dragging = false; });
    target.addEventListener('click', () => {
      // A tap also fires click; phones have no pointer lock to ask for.
      if (this.lastPointerType === 'mouse') this.lock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === target;
      this.look.reset();
      this.dragging = false;
      if (this.locked) {
        this.freeLook = false;
        this.refusals = 0;
        this.notice = '';
      } else {
        this.lastUnlockAt = performance.now();
        this.down.clear();
      }
    });
    // Every refusal is handled here, once. (Chromium also rejects the
    // request's promise for the same refusal; counting both would double it.)
    document.addEventListener('pointerlockerror', () => this.lockFailed());
    // One listener for both modes. mousemove (not pointermove) because it is
    // the event pointer lock is specified on, and it never duplicates.
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.dragging = false;
      this.freeLook = false;
      this.look.reset();
      this.touch.release();
    });
  }

  /** Whether game input is live (the "click to play" overlay is hidden). */
  get active() {
    return this.locked || this.freeLook || this.touch.enabled;
  }

  async lock() {
    if (this.locked || this.lockPending) return;
    if (typeof this.target.requestPointerLock !== 'function') {
      this.lockFailed(false);
      return;
    }
    this.lockPending = true;
    // Same click as the lock request, because fullscreen needs a user gesture.
    if (this.fullscreenLock) this.enterFullscreen();
    try {
      if (this.rawMouse) {
        this.lockMode = 'raw';
        await this.target.requestPointerLock({ unadjustedMovement: true });
      } else {
        this.lockMode = 'standard';
        await this.target.requestPointerLock();
      }
    } catch (e) {
      // Refusals arrive via 'pointerlockerror'. Only raw-mode support is handled here.
      if (this.rawMouse && e?.name === 'NotSupportedError') {
        this.lockMode = 'standard (raw unsupported)';
        try { await this.target.requestPointerLock(); } catch { /* reported by pointerlockerror */ }
      }
    } finally {
      this.lockPending = false;
    }
  }

  enterFullscreen() {
    if (this.fsPending || !document.fullscreenEnabled || document.fullscreenElement) return;
    this.fsPending = true;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .then(() => {
        // Landscape lock only works in fullscreen, and only on some browsers.
        if (matchMedia('(pointer: coarse)').matches) {
          try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch { /* unsupported */ }
        }
      })
      .catch(() => { /* refused: carry on windowed */ })
      .finally(() => { this.fsPending = false; });
  }

  /**
   * Any interaction re-enters fullscreen (after Esc or F took it away). It has
   * to be requested from the gesture itself, so this listens on the capture
   * phase of window. Browsers count mouse *down* but touch/pen *up* as the
   * activating event.
   */
  onGesture(e) {
    if (!this.fullscreenLock) return;
    if (e.type === 'pointerdown' && e.pointerType !== 'mouse') return;
    if (e.type === 'pointerup' && e.pointerType === 'mouse') return;
    if (e.type === 'keydown' && (e.code === 'Escape' || BINDINGS.fullscreen.includes(e.code))) return;
    // The fullscreen button and F key are the ways out; don't undo them.
    if (e.target?.closest?.('[data-menu=fullscreen]')) return;
    this.enterFullscreen();
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else this.enterFullscreen();
  }

  /**
   * The look filter just saw Firefox's cursor-echo stream, so this browser is
   * not holding the cursor in place. Fullscreen on interaction normally
   * covers that already; only someone who opted out (?fs=0) gets told.
   */
  onEchoDetected() {
    if (this.fullscreenLock || document.fullscreenElement || !document.fullscreenEnabled) return;
    this.notice = 'Your browser lets the cursor roam outside the window. Press F for fullscreen, or use ?fs=1 to go fullscreen on every click.';
    this.noticeUntil = performance.now() + 10000;
  }

  /** The browser refused pointer lock. */
  lockFailed(hasApi = true) {
    if (this.locked) return;
    const msSinceUnlock = performance.now() - this.lastUnlockAt;
    const inCooldown = hasApi && msSinceUnlock < LOCK_COOLDOWN_MS;
    if (!inCooldown) this.refusals++;
    const action = lockRefusalAction({ hasApi, msSinceUnlock, refusals: this.refusals });
    if (action === 'fallback') {
      this.freeLook = true;
      this.notice = 'Mouse capture is not available here. Hold the left button and drag to look · Esc to stop';
    } else if (action === 'cooldown') {
      this.notice = 'The browser blocks mouse capture for a second after Esc. Click again.';
    } else {
      this.notice = 'Mouse capture was refused. Click again.';
    }
  }

  onPointerDown(e) {
    this.lastPointerType = e.pointerType;
    if (e.pointerType !== 'mouse' || this.locked || !this.freeLook || e.button !== 0) return;
    this.dragging = true;
    this.look.reset(0); // no cursor warp without a lock
  }

  onMouseMove(e) {
    if (this.locked || this.dragging) this.look.addMouse(e.movementX, e.movementY, e.timeStamp);
  }

  onWheel(e) {
    if (!this.locked && !this.freeLook) return;
    e.preventDefault();
    // Scroll-wheel jump: the classic bunny-hop bind.
    if (e.deltaY !== 0) this.player.pending.jumpPressed = true;
  }

  /** Look speed up (+1) or down (−1) for whichever input is in use: finger drag on touch, mouse otherwise. */
  adjustSensitivity(dir) {
    if (this.touch.enabled) {
      this.adjustTouchSensitivity(dir * 0.05);
    } else {
      this.settings.sensitivity = Math.round(clamp(this.settings.sensitivity + dir * 0.1, ...SENS_RANGE) * 10) / 10;
      saveSettings(this.settings);
    }
  }

  /** Current look speed as text for the pause menu. */
  get sensLabel() {
    return this.touch.enabled
      ? `${this.settings.touchSensitivity.toFixed(2)}°/px`
      : this.settings.sensitivity.toFixed(1);
  }

  adjustTouchSensitivity(delta) {
    this.settings.touchSensitivity = Math.round(clamp(this.settings.touchSensitivity + delta, ...TOUCH_SENS_RANGE) * 100) / 100;
    saveSettings(this.settings);
  }

  onKey(e, isDown) {
    const is = (action) => BINDINGS[action].includes(e.code);
    if (isDown && e.code === 'Escape' && this.freeLook) {
      this.freeLook = false;
      this.dragging = false;
      this.notice = '';
      this.down.clear();
      return;
    }
    // P pauses while playing and resumes while paused (the mouse is released then, so not `active`).
    if (isDown && !e.repeat && is('pause') && (this.active || this.paused)) {
      e.preventDefault();
      this.handlers.pause?.();
      return;
    }
    if (this.paused && isDown) return; // paused: no building, jumping or respawning behind the menu
    if (!this.active) {
      if (isDown && is('respawn')) this.player.pending.respawn = true;
      if (isDown && is('restart')) this.handlers.restart?.();
      return;
    }
    e.preventDefault();
    if (isDown) {
      if (e.repeat) return;
      this.down.add(e.code);
      if (is('jump')) this.player.pending.jumpPressed = true;
      if (is('respawn')) this.player.pending.respawn = true;
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) this.handlers.selectTower?.(Number(digit[1]));
      for (const a of HANDLED_ACTIONS) if (is(a)) this.handlers[a]?.();
      if (is('fullscreen')) this.toggleFullscreen();
      if (is('autoHop')) {
        this.cfg.autoHop = !this.cfg.autoHop;
        this.touch.syncButtons();
      }
      if (is('sensDown') || is('sensUp')) {
        const s = this.settings.sensitivity + (is('sensUp') ? 0.1 : -0.1);
        this.settings.sensitivity = Math.round(clamp(s, ...SENS_RANGE) * 10) / 10;
        saveSettings(this.settings);
      }
      if (is('sensReset')) {
        Object.assign(this.settings, DEFAULT_SETTINGS);
        saveSettings(this.settings);
      }
    } else {
      this.down.delete(e.code);
    }
  }

  /** Apply this frame's look, then copy keys + touch into the player's pending input. Call once per frame. */
  sample() {
    if (this.look.stats.echo && !this.echoHandled) {
      this.echoHandled = true;
      this.onEchoDetected();
    }
    if (this.noticeUntil && performance.now() > this.noticeUntil) {
      this.noticeUntil = 0;
      this.notice = '';
    }
    const [dYaw, dPitch] = this.look.consume(this.settings.sensitivity);
    if (dYaw !== 0 || dPitch !== 0) this.player.look(dYaw, dPitch);

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
