// Static collision world and swept-box queries for the kinematic player.
//
// The player is an axis-aligned box (a "hull", as in Quake/Source). Level
// geometry is a set of static axis-aligned boxes. Sweeping box A against box
// B is done by expanding B by A's half-extents (the Minkowski sum) and casting
// A's centre as a ray against the expanded box with the slab method.

import { Vec3 } from './vec3.js';

/**
 * Contacts closer than this (metres) count as touching. Rounding in the move
 * code can leave the hull a hair inside a surface; anything within this
 * tolerance is "on the surface", not "inside".
 */
export const CONTACT_EPSILON = 1e-3;

export class Aabb {
  /** @param {Vec3} min @param {Vec3} max */
  constructor(min, max) {
    if (min.x > max.x || min.y > max.y || min.z > max.z) {
      throw new Error('Aabb min must be <= max');
    }
    this.min = min;
    this.max = max;
  }

  static fromCenterHalf(center, half) {
    return new Aabb(center.sub(half), center.add(half));
  }

  center() { return this.min.add(this.max).scale(0.5); }
  halfExtents() { return this.max.sub(this.min).scale(0.5); }
  size() { return this.max.sub(this.min); }
  expand(by) { return new Aabb(this.min.sub(by), this.max.add(by)); }
  union(o) { return new Aabb(this.min.min(o.min), this.max.max(o.max)); }

  /** Strict overlap with CONTACT_EPSILON of slack: touching is not overlapping. */
  overlaps(o) {
    const e = CONTACT_EPSILON;
    return this.min.x + e < o.max.x && o.min.x + e < this.max.x
      && this.min.y + e < o.max.y && o.min.y + e < this.max.y
      && this.min.z + e < o.max.z && o.min.z + e < this.max.z;
  }

  /** Inclusive touch test, used for broad-phase rejection. */
  touches(o) {
    return this.min.x <= o.max.x && o.min.x <= this.max.x
      && this.min.y <= o.max.y && o.min.y <= this.max.y
      && this.min.z <= o.max.z && o.min.z <= this.max.z;
  }
}

/**
 * Static level collision. Queries are brute force over all boxes after a
 * bounds rejection: fine for a hand-built level of tens of boxes. A uniform
 * grid goes in front of it once levels get big.
 */
export class CollisionWorld {
  /** @param {Aabb[]} solids */
  constructor(solids = []) {
    this.solids = solids;
  }

  /**
   * Sweep a box with half-extents `half`, centred at `center`, by `delta`.
   * Returns the earliest blocking hit `{ t, normal }` or null.
   *
   * Solids the box already overlaps by more than CONTACT_EPSILON are ignored,
   * so a stuck hull can always move out instead of freezing.
   */
  sweep(center, half, delta) {
    const swept = Aabb.fromCenterHalf(center, half)
      .union(Aabb.fromCenterHalf(center.add(delta), half))
      .expand(new Vec3(CONTACT_EPSILON, CONTACT_EPSILON, CONTACT_EPSILON));

    let best = null;
    for (const solid of this.solids) {
      if (!swept.touches(solid)) continue;
      const hit = sweepPointVsBox(center, delta, solid.expand(half));
      if (hit && (best === null || hit.t < best.t)) best = hit;
    }
    return best;
  }

  /** True if a box at `center` with `half` extents overlaps any solid. */
  boxBlocked(center, half) {
    const probe = Aabb.fromCenterHalf(center, half);
    return this.solids.some((s) => probe.overlaps(s));
  }
}

/**
 * Cast point `origin` along `delta` against box `b` (already expanded by the
 * moving box's half-extents). Slab method, with the entry penetration tracked
 * as a distance so the contact tolerance is a length, not a time.
 */
function sweepPointVsBox(origin, delta, b) {
  let tEnter = -Infinity;
  let tExit = Infinity;
  let enterAxis = -1;
  let enterDepth = 0;

  for (let axis = 0; axis < 3; axis++) {
    const o = origin.get(axis);
    const d = delta.get(axis);
    const lo = b.min.get(axis);
    const hi = b.max.get(axis);

    if (d === 0) {
      // Not moving on this axis: must already be strictly inside the slab.
      // On (or within epsilon of) a face counts as outside, which is what
      // lets the hull slide along a floor or wall it is touching.
      if (o <= lo + CONTACT_EPSILON || o >= hi - CONTACT_EPSILON) return null;
      continue;
    }

    const nearPlane = d > 0 ? lo : hi;
    const farPlane = d > 0 ? hi : lo;
    const tNear = (nearPlane - o) / d;
    const tFar = (farPlane - o) / d;
    if (tNear > tEnter) {
      tEnter = tNear;
      enterAxis = axis;
      // How far past the near plane the origin already is (positive = inside).
      enterDepth = d > 0 ? o - nearPlane : nearPlane - o;
    }
    tExit = Math.min(tExit, tFar);
  }

  if (enterAxis < 0) return null;
  if (tEnter > tExit || tEnter > 1 || tExit < 0) return null;
  // Started genuinely inside: don't block, so a stuck hull can escape.
  if (tEnter < 0 && enterDepth > CONTACT_EPSILON) return null;

  const normal = Vec3.ZERO.with(enterAxis, -Math.sign(delta.get(enterAxis)));
  return { t: Math.max(tEnter, 0), normal };
}
