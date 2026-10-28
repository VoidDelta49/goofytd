// Keyboard + mouse input with pointer lock. Writes view angles and the
// player's pending input; never touches simulation state directly.

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
 * Mouse sensitivity in units FPS players already know: degrees of turn per
 * mouse count = sensitivity × 0.022 (Quake/Source m_yaw).
 */
export function loadSettings() {
  const defaults = { sensitivity: 2.0 };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

export class Input {
  /**
   * @param {HTMLElement} target element that receives pointer lock
   * @param {import('../player.js').PlayerController} player
   * @param {object} cfg movement config (for the auto-hop toggle)
   */
  constructor(target, player, cfg) {
    this.target = target;
    this.player = player;
    this.cfg = cfg;
    this.settings = loadSettings();
    this.down = new Set();
    this.locked = false;

    target.addEventListener('click', () => this.lock());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === target;
      if (!this.locked) this.down.clear();
    });
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.down.clear());
  }

  async lock() {
    if (this.locked) return;
    try {
      // Raw, unaccelerated mouse input where supported (Chromium).
      await this.target.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try { await this.target.requestPointerLock(); } catch { /* user gesture expired */ }
    }
  }

  onMouseMove(e) {
    if (!this.locked) return;
    const radPerCount = (this.settings.sensitivity * 0.022 * Math.PI) / 180;
    // Mouse right turns right (negative yaw); mouse down looks down.
    this.player.look(-e.movementX * radPerCount, -e.movementY * radPerCount);
  }

  onWheel(e) {
    if (!this.locked) return;
    e.preventDefault();
    // Scroll-wheel jump: the classic bunny-hop bind.
    if (e.deltaY !== 0) this.player.pending.jumpPressed = true;
  }

  onKey(e, isDown) {
    const is = (action) => BINDINGS[action].includes(e.code);
    if (!this.locked) {
      if (isDown && is('respawn')) this.player.pending.respawn = true;
      return;
    }
    e.preventDefault();
    if (isDown) {
      if (e.repeat) return;
      this.down.add(e.code);
      if (is('jump')) this.player.pending.jumpPressed = true;
      if (is('respawn')) this.player.pending.respawn = true;
      if (is('autoHop')) this.cfg.autoHop = !this.cfg.autoHop;
      if (is('sensDown') || is('sensUp')) {
        const s = this.settings.sensitivity + (is('sensUp') ? 0.1 : -0.1);
        this.settings.sensitivity = Math.round(Math.min(Math.max(s, 0.1), 10) * 10) / 10;
        saveSettings(this.settings);
      }
    } else {
      this.down.delete(e.code);
    }
  }

  /** Copy held keys into the player's pending input. Call once per frame. */
  sample() {
    const held = (action) => BINDINGS[action].some((c) => this.down.has(c));
    const p = this.player.pending;
    p.wish = {
      x: (held('right') ? 1 : 0) - (held('left') ? 1 : 0),
      y: (held('forward') ? 1 : 0) - (held('back') ? 1 : 0),
    };
    p.jumpHeld = held('jump');
    p.crouchHeld = held('crouch');
  }
}
