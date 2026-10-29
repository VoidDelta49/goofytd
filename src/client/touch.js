// Touch controls: a floating move stick (left part of the screen), drag-to-look
// (everywhere else), and on-screen buttons. Writes the same player inputs the
// keyboard does, so the simulation can't tell them apart.
//
// Stick and look touches land on the canvas itself; only the buttons catch
// pointers in the overlay, so a mouse on a touch laptop still reaches the
// canvas and pointer lock.

import { SELL_REFUND, TOWER_TYPES, TOWER_FORMS } from '../sim/towers.js';

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

/**
 * What the build / sell / next-wave buttons should say right now. Pure (no DOM)
 * so it can be tested: `sub` is the small second line, `dim` means "nothing to
 * do yet" (still tappable, it explains itself), `bad` means the ghost can't go there.
 */
export function touchButtonState(game, build, upgradeOpen = false) {
  const sel = build.selected !== null ? TOWER_TYPES[build.selected] : null;
  const look = build.lookTower;
  let place;
  if (!sel) place = { sub: 'pick a tower', dim: true, bad: false };
  else if (game.money < sel.cost) place = { sub: 'need more moolah', dim: false, bad: true };
  else place = { sub: sel.name, dim: false, bad: !!build.preview && !build.preview.ok };
  const sell = look
    ? { sub: `+${Math.floor(look.spent * SELL_REFUND)} moolah`, dim: false }
    : { sub: 'look at a tower', dim: true };
  let upgrade;
  if (upgradeOpen) upgrade = { sub: 'close', dim: false, on: true };
  else if (!look) upgrade = { sub: 'look at a tower', dim: true };
  else if (!look.def.upgrades.length) upgrade = { sub: 'MAXED', dim: true };
  else if (look.def.upgrades.length > 1) upgrade = { sub: 'pick a path!', dim: false };
  else upgrade = { sub: `LV ${look.def.level + 1} · ${TOWER_FORMS[look.def.upgrades[0]].upgradeCost}`, dim: false };
  // Wave 1 has its own big START button; a lost game has TRY AGAIN.
  const wave = { hidden: game.wave === 0 || game.lost };
  // Fast-forward: always there, says the current speed, lit while above 1x.
  const scale = game.timeScale ?? 1;
  const ff = { label: `▶▶ ${scale}×`, on: scale > 1 };
  return { place, sell, upgrade, wave, ff };
}

/**
 * Keep receiving a finger's moves after it leaves the element. Only a nicety
 * for drags: the browser throws InvalidStateError for a pointer that is
 * already gone (a very quick tap), and that must never stop the button's action.
 */
function capture(el, pointerId) {
  try { el.setPointerCapture(pointerId); } catch { /* pointer already released */ }
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
    /** Last text/flags written per button, so the DOM is only touched on change. */
    this.shown = {};

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
    capture(this.canvas, e.pointerId);
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
    capture(btn, e.pointerId);
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
      // Building: tap a tower in the bar to pick it, BUILD places the ghost, SELL
      // removes the tower you're looking at. Everything else lives in the pause menu.
      case 'place': this.input.handlers.place?.(); break;
      case 'sell': this.input.handlers.sell?.(); break;
      case 'upgrade': this.input.handlers.upgrade?.(); break;
      case 'wave': this.input.handlers.nextWave?.(); break;
      case 'ff': this.input.handlers.fastForward?.(); break;
      case 'pause': this.input.handlers.pause?.(); break;
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
    this.setSub('crouch', this.crouchOn ? 'ON' : 'tap on/off');
  }

  /** Per-frame: relabel BUILD / SELL and show or hide NEXT WAVE from the game state. */
  syncGame(game, build, upgradeOpen = false) {
    const st = touchButtonState(game, build, upgradeOpen);
    for (const name of ['place', 'sell', 'upgrade']) {
      const b = this.buttons[name], v = st[name];
      this.setSub(name, v.sub);
      this.setFlag(b, 'dim', v.dim);
      this.setFlag(b, 'bad', !!v.bad);
      this.setFlag(b, 'on', !!v.on);
    }
    this.setFlag(this.buttons.wave, 'hidden', st.wave.hidden);
    if (this.buttons.ff) {
      this.setFlag(this.buttons.ff, 'on', st.ff.on);
      if (this.shown['ff.label'] !== st.ff.label) {
        this.shown['ff.label'] = st.ff.label;
        const b = this.buttons.ff.querySelector('b');
        if (b) b.textContent = st.ff.label;
      }
    }
  }

  setSub(name, text) {
    const key = `${name}.sub`;
    if (this.shown[key] === text) return;
    this.shown[key] = text;
    const el = this.buttons[name].querySelector('small');
    if (el) el.textContent = text;
  }

  setFlag(btn, flag, on) {
    const key = `${btn.dataset.touch}.${flag}`;
    if (this.shown[key] === on) return;
    this.shown[key] = on;
    if (flag === 'hidden') btn.hidden = on;
    else btn.classList.toggle(flag, on);
  }
}
