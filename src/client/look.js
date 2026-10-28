// First-person look: turns raw mouse/touch deltas into view-angle changes and
// view angles into a camera orientation. Pure maths, no DOM or three.js, so
// the whole camera path is tested in Node.
//
// Flow per frame:
//   mousemove events ─► MouseLook.addMouse()   (filtered, accumulated)
//   touch drags      ─► MouseLook.addRadians() (already in radians)
//   frame start      ─► MouseLook.consume()    → [dYaw, dPitch] → player.look()
//   render           ─► viewQuaternion(yaw, pitch) → camera.quaternion
//
// Angles: yaw 0 looks down -Z, positive yaw turns left; pitch positive looks up.

/**
 * Spike filter. Browsers deliver mousemove once per frame with the whole
 * frame's motion summed, so a real fast flick is 1000+ counts per event and
 * no fixed cap is safe. Real motion ramps up over a few frames; a bogus
 * delta (cursor warp, compositor jump) appears out of nowhere. So an event
 * is a spike only if it is above SPIKE_FLOOR counts AND more than
 * SPIKE_RATIO times the previous event within SPIKE_WINDOW_MS.
 */
export const SPIKE_FLOOR = 400;
export const SPIKE_RATIO = 6;
export const SPIKE_WINDOW_MS = 100;

/**
 * Mouse events after a pointer-lock change to throw away. Chromium and
 * Firefox can deliver the warp-to-centre jump in the first event or two.
 */
export const SETTLE_EVENTS = 2;

/** Degrees per mouse count at sensitivity 1 (Quake/Source m_yaw). */
export const DEG_PER_COUNT = 0.022;

export class MouseLook {
  constructor() {
    this.dx = 0; // accumulated counts since the last consume()
    this.dy = 0;
    this.yawRad = 0; // accumulated radians from touch
    this.pitchRad = 0;
    this.settle = 0;
    this.prevMag = 0;
    this.prevTime = -Infinity;
    this.stats = { accepted: 0, rejected: 0, last: [0, 0], maxAbs: 0 };
  }

  /** Call when pointer lock is gained or lost: drops pending input and the warp events. */
  reset(settleEvents = SETTLE_EVENTS) {
    this.dx = this.dy = this.yawRad = this.pitchRad = 0;
    this.settle = settleEvents;
    this.prevMag = 0;
    this.prevTime = -Infinity;
  }

  /**
   * One mousemove's movementX/Y at event time `t` (ms). Returns whether it
   * was accepted.
   */
  addMouse(mx, my, t) {
    const s = this.stats;
    s.last = [mx, my];
    if (!Number.isFinite(mx) || !Number.isFinite(my)) {
      s.rejected++;
      return false;
    }
    const mag = Math.max(Math.abs(mx), Math.abs(my));
    s.maxAbs = Math.max(s.maxAbs, mag);
    if (this.settle > 0) {
      this.settle--;
      s.rejected++;
      return false;
    }
    const prev = t - this.prevTime <= SPIKE_WINDOW_MS ? this.prevMag : 0;
    this.prevTime = t;
    if (mag > SPIKE_FLOOR && mag > SPIKE_RATIO * prev) {
      // Remember it capped, so a real flick that starts hard loses only its
      // first frame, while a lone huge spike can't vouch for another one.
      this.prevMag = SPIKE_FLOOR;
      s.rejected++;
      return false;
    }
    this.prevMag = mag;
    this.dx += mx;
    this.dy += my;
    s.accepted++;
    return true;
  }

  /** A turn already in radians (touch drag). */
  addRadians(dYaw, dPitch) {
    if (Number.isFinite(dYaw) && Number.isFinite(dPitch)) {
      this.yawRad += dYaw;
      this.pitchRad += dPitch;
    }
  }

  /**
   * Everything gathered since the last call as [dYaw, dPitch] radians, then
   * clears it. Mouse right turns right (negative yaw); mouse down looks down.
   */
  consume(sensitivity) {
    const k = (sensitivity * DEG_PER_COUNT * Math.PI) / 180;
    const out = [-this.dx * k + this.yawRad, -this.dy * k + this.pitchRad];
    this.dx = this.dy = this.yawRad = this.pitchRad = 0;
    return out;
  }
}

/**
 * Chrome refuses a pointer-lock request for about a second after the user
 * leaves the lock with Esc. Refusals inside this window are that cooldown.
 */
export const LOCK_COOLDOWN_MS = 1500;

/**
 * What to do when the browser refuses pointer lock:
 *  'cooldown' — just after an unlock: ask for another click, change nothing else
 *  'retry'    — first unexplained refusal: ask for another click
 *  'fallback' — no API, or refused twice outside the cooldown (sandboxed
 *               embed): switch to hold-and-drag look
 * The game never goes "live" with a free cursor unless it truly has to,
 * because a free cursor clicks out of the window.
 */
export function lockRefusalAction({ hasApi, msSinceUnlock, refusals }) {
  if (!hasApi) return 'fallback';
  if (msSinceUnlock < LOCK_COOLDOWN_MS) return 'cooldown';
  return refusals >= 2 ? 'fallback' : 'retry';
}

/**
 * Camera orientation for (yaw, pitch) as a unit quaternion [x, y, z, w]:
 * yaw about world +Y, then pitch about the camera's own +X. Built directly
 * instead of through Euler angles, so there is no rotation-order state that
 * can be left wrong; roll is zero by construction.
 */
export function viewQuaternion(yaw, pitch) {
  const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2);
  const sp = Math.sin(pitch / 2), cp = Math.cos(pitch / 2);
  // q = qYaw * qPitch
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}

/** Rotate vector v by unit quaternion q = [x, y, z, w]. */
export function rotateByQuaternion(q, v) {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}
