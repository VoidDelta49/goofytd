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
 * A single mousemove never legitimately carries more than this many counts:
 * a hard flick on a 16000 DPI mouse at 1000 Hz is ~100. Bigger values are the
 * cursor warping to the lock centre, a compositor (Wayland/XWayland) jump, or
 * an absolute-position device misreported as relative.
 */
export const MAX_EVENT_COUNTS = 250;

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
    this.stats = { accepted: 0, rejected: 0, last: [0, 0], maxAbs: 0 };
  }

  /** Call when pointer lock is gained or lost: drops pending input and the warp events. */
  reset() {
    this.dx = this.dy = this.yawRad = this.pitchRad = 0;
    this.settle = SETTLE_EVENTS;
  }

  /** One mousemove's movementX/Y. Returns whether it was accepted. */
  addMouse(mx, my) {
    const s = this.stats;
    s.last = [mx, my];
    if (Number.isFinite(mx) && Number.isFinite(my)) s.maxAbs = Math.max(s.maxAbs, Math.abs(mx), Math.abs(my));
    if (this.settle > 0) {
      this.settle--;
      s.rejected++;
      return false;
    }
    if (!Number.isFinite(mx) || !Number.isFinite(my) ||
        Math.abs(mx) > MAX_EVENT_COUNTS || Math.abs(my) > MAX_EVENT_COUNTS) {
      s.rejected++;
      return false;
    }
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
