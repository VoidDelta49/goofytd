// Touch controls: a floating move stick (left part of the screen), drag-to-look
// (everywhere else), and on-screen buttons. Writes the same player inputs the
// keyboard does, so the simulation can't tell them apart.
//
// Stick and look touches land on the canvas itself; only the buttons catch
// pointers in the overlay, so a mouse on a touch laptop still reaches the
// canvas and pointer lock.

/** CSS px of finger travel for full stick deflection. */
export const STICK_RADIUS = 56;
/** Fraction of the radius ignored around the centre (thumb jitter). */
export const STICK_DEADZONE = 0.12;
/** Touches starting left of this fraction of the screen width drive the stick. */
export const STICK_ZONE = 0.45;

/**
 * Finger offset from the stick origin (CSS px, screen y down) to a wish
 * vector: x right, y forward, length ≤ 1. The dead zone is rescaled so
 * deflection ramps from 0 at its edge instead of jumping to 12 %; full
 * deflection is exactly length 1, the same as a held key.
 */
export function stickVector(dx, dy, radius = STICK_RADIUS, deadzone = STICK_DEADZONE) {
  const len = Math.hypot(dx, dy) / radius;
  if (len <= deadzone) return { x: 0, y: 0 };
  const mag = Math.min((len - deadzone) / (1 - deadzone), 1);
  const s = mag / (len * radius);
  return { x: dx * s, y: -dy * s };
}

export class TouchControls {
  /**
   * @param {HTMLElement} canvas receives stick and look touches
   * @param {HTMLElement} root overlay with the stick visual and buttons
   * @param {import('./input.js').Input} input owner: player, cfg, settings
   */
  constructor(canvas, root, input) {
    this.canvas = canvas;
    this.root = root;
    this.input = input;
    this.enabled = false;
    this.wish = { x: 0, y: 0 };
    this.jumpHeld = false;
    this.crouchOn = false;
    /** pointerId → { role: 'stick' | 'look', ox, oy, x, y } */
    this.touches = new Map();

    this.stickEl = root.querySelector('.stick');
    this.knobEl = root.querySelector('.knob');
    this.stickHintEl = root.querySelector('.stick-hint');
    this.buttons = {};
    for (const btn of root.querySelectorAll('button[data-touch]')) {
      this.buttons[btn.dataset.touch] = btn;
      btn.addEventListener('pointerdown', (e) => this.onButtonDown(e, btn));
      btn.addEventListener('pointermove', (e) => this.onMove(e));
      btn.addEventListener('pointerup', (e) => this.onButtonUp(e, btn));
      btn.addEventListener('pointercancel', (e) => this.onButtonUp(e, btn));
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    if (!document.fullscreenEnabled) this.buttons.fullscreen.hidden = true;

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.root.hidden = false;
    this.syncButtons();
  }

  /** Drop every touch, e.g. when the page loses focus mid-gesture. */
  release() {
    this.touches.clear();
    this.wish = { x: 0, y: 0 };
    this.jumpHeld = false;
    this.stickEl.classList.remove('on');
    for (const b of Object.values(this.buttons)) b.classList.remove('down');
  }

  onDown(e) {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    if (!this.enabled) {
      this.enable();
      return; // The "tap to play" tap only starts the game.
    }
    this.canvas.setPointerCapture(e.pointerId);
    const hasStick = [...this.touches.values()].some((t) => t.role === 'stick');
    const role = !hasStick && e.clientX < window.innerWidth * STICK_ZONE ? 'stick' : 'look';
    this.touches.set(e.pointerId, { role, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY });
    if (role === 'stick') {
      this.stickEl.style.left = `${e.clientX}px`;
      this.stickEl.style.top = `${e.clientY}px`;
      this.knobEl.style.transform = '';
      this.stickEl.classList.add('on');
      this.stickHintEl.classList.add('gone');
    }
  }

  onMove(e) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    if (t.role === 'stick') {
      const dx = e.clientX - t.ox, dy = e.clientY - t.oy;
      this.wish = stickVector(dx, dy);
      const len = Math.hypot(dx, dy);
      const k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
      this.knobEl.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    } else {
      // Client-coordinate deltas, not movementX: touch movementX is 0 in Safari.
      const radPerPx = (this.input.settings.touchSensitivity * Math.PI) / 180;
      this.input.look.addRadians(-(e.clientX - t.x) * radPerPx, -(e.clientY - t.y) * radPerPx);
    }
    t.x = e.clientX;
    t.y = e.clientY;
  }

  onUp(e) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    this.touches.delete(e.pointerId);
    if (t.role === 'stick') {
      this.wish = { x: 0, y: 0 };
      this.stickEl.classList.remove('on');
    }
  }

  onButtonDown(e, btn) {
    e.preventDefault();
    e.stopPropagation();
    this.enable();
    btn.setPointerCapture(e.pointerId);
    btn.classList.add('down');
    const { player, cfg } = this.input;
    switch (btn.dataset.touch) {
      case 'jump':
        this.jumpHeld = true;
        player.pending.jumpPressed = true;
        // The jump thumb keeps steering: dragging from the button looks
        // around, which is what makes air strafing possible with two thumbs.
        this.touches.set(e.pointerId, { role: 'look', ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY });
        break;
      // Toggle, not hold: crouch-jumping needs stick + jump + crouch, and a
      // phone held in two hands has two thumbs.
      case 'crouch': this.crouchOn = !this.crouchOn; break;
      case 'respawn': player.pending.respawn = true; break;
      case 'autoHop': cfg.autoHop = !cfg.autoHop; break;
      case 'sensDown': this.input.adjustTouchSensitivity(-0.05); break;
      case 'sensUp': this.input.adjustTouchSensitivity(0.05); break;
      case 'fullscreen': this.toggleFullscreen(); break;
      // Building: BUILD cycles the tower type (then off), PLACE builds it, or
      // sells the tower you're looking at when not building.
      case 'build': this.input.handlers.cycleTower?.(); break;
      case 'place': this.input.handlers.placeOrSell?.(); break;
      case 'wave': this.input.handlers.nextWave?.(); break;
      case 'mute': this.input.handlers.mute?.(); break;
    }
    this.syncButtons();
  }

  onButtonUp(e, btn) {
    btn.classList.remove('down');
    if (btn.dataset.touch === 'jump') {
      this.jumpHeld = false;
      this.touches.delete(e.pointerId);
    }
  }

  syncButtons() {
    this.buttons.crouch.classList.toggle('on', this.crouchOn);
    this.buttons.autoHop.classList.toggle('on', this.input.cfg.autoHop);
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        // Landscape lock only works in fullscreen, and only on some browsers.
        await screen.orientation?.lock?.('landscape').catch(() => {});
      }
    } catch { /* refused: stay windowed */ }
  }
}
