// Build mode: which tower is selected, where the crosshair puts it, whether
// it may go there, and which built tower you're looking at (to sell).
// Turns view angles into a ground point; all rules live in Game.checkPlacement.

import { Aabb } from '../sim/collision.js';
import { Vec3 } from '../sim/vec3.js';
import { hullHalfExtents } from '../sim/movement.js';
import { TOWER_TYPES } from '../sim/towers.js';
import { rotateByQuaternion, viewQuaternion } from './look.js';

/** How far (horizontally, metres) you can build: look further or upward and the ghost stops here. */
export const BUILD_REACH = 24;
/** How far you can look at a tower to sell it. */
export const SELL_REACH = 12;
/** Re-run the placement check this often even if nothing obvious changed: cows walk into footprints. */
const RECHECK_MS = 120;

/**
 * Where the view ray meets the ground (y = 0), capped at `reach` metres
 * horizontally. Looking level or up puts the point at full reach straight
 * ahead, so you can always aim a build. Pure; tested in Node.
 */
export function groundAim(eye, forward, reach = BUILD_REACH) {
  const [fx, fy, fz] = forward;
  const h = Math.hypot(fx, fz);
  let s = fy < -1e-6 ? eye.y / -fy : Infinity;
  if (h > 1e-6) s = Math.min(s, reach / h);
  if (!Number.isFinite(s)) s = 0; // straight down with no horizontal: under your feet
  return { x: eye.x + fx * s, z: eye.z + fz * s };
}

export function viewForward(yaw, pitch) {
  return rotateByQuaternion(viewQuaternion(yaw, pitch), [0, 0, -1]);
}

export class BuildController {
  constructor(game, player, cfg) {
    this.game = game;
    this.player = player;
    this.cfg = cfg;
    /** Selected tower type id, or null when not building. */
    this.selected = null;
    /** Latest placement check (null when not building). */
    this.preview = null;
    /** Tower under the crosshair within SELL_REACH, or null. */
    this.lookTower = null;
    this.message = '';
    this.messageUntil = 0;
    this.cacheKey = '';
    this.cacheAt = 0;
  }

  get typeIds() { return Object.keys(TOWER_TYPES); }

  /** 1-based hotkey. Pressing the selected tower's key again stops building. */
  select(n) {
    const id = this.typeIds[n - 1];
    if (!id) return;
    this.selected = this.selected === id ? null : id;
    this.cacheKey = '';
  }

  /** Touch BUILD button: off -> first -> ... -> last -> off. */
  cycle() {
    const ids = this.typeIds;
    const k = this.selected === null ? 0 : ids.indexOf(this.selected) + 1;
    this.selected = k < ids.length ? ids[k] : null;
    this.cacheKey = '';
  }

  cancel() { this.selected = null; this.preview = null; }

  playerBox() {
    const s = this.player.state;
    const half = hullHalfExtents(this.cfg, s.crouched);
    return Aabb.fromCenterHalf(s.position.add(new Vec3(0, half.y, 0)), half);
  }

  /** Call once per frame with the camera eye and view angles. */
  update(now, eye, yaw, pitch) {
    const f = viewForward(yaw, pitch);
    const hit = this.game.raycastTower(eye, new Vec3(f[0], f[1], f[2]), SELL_REACH);
    this.lookTower = hit ? hit.tower : null;
    if (this.selected === null) { this.preview = null; return; }
    const aim = groundAim(eye, f);
    // Placement checks walk the grid (≈1.5 ms with 2000 cows): only redo one
    // when the aim moves to another half-metre, the grid changes, or it's stale.
    const key = `${this.selected}|${Math.round(aim.x * 2)}|${Math.round(aim.z * 2)}|${this.game.grid.version}|${this.game.money}`;
    if (key !== this.cacheKey || now - this.cacheAt > RECHECK_MS) {
      this.cacheKey = key;
      this.cacheAt = now;
      this.preview = this.game.checkPlacement(this.selected, aim.x, aim.z, this.playerBox());
      this.aim = aim;
    }
  }

  /** Build the previewed tower. */
  place(now = performance.now()) {
    if (this.selected === null || !this.aim) return false;
    const r = this.game.placeTower(this.selected, this.aim.x, this.aim.z, this.playerBox());
    this.cacheKey = '';
    if (r.reason) { this.say(`Can't build: ${r.reason}`, now); return false; }
    return true;
  }

  sell(now = performance.now()) {
    if (!this.lookTower) return false;
    const name = this.lookTower.def.name;
    const refund = this.game.sellTower(this.lookTower.id);
    this.lookTower = null;
    this.cacheKey = '';
    this.say(`Sold ${name} for ${refund}`, now);
    return true;
  }

  /** Touch PLACE button: build when building, otherwise sell what you look at. */
  placeOrSell(now = performance.now()) {
    return this.selected !== null ? this.place(now) : this.sell(now);
  }

  say(text, now) {
    this.message = text;
    this.messageUntil = now + 2000;
  }
}
