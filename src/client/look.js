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

/**
 * Firefox pointer-lock "echo" events. Firefox implements pointer lock by
 * warping the OS cursor back to a fixed anchor after every move. Where that
 * warp silently fails (Firefox on X11/XWayland under a Wayland compositor,
 * which ignores XWarpPointer), Firefox still dispatches its own centring
 * event, and that event's movementX/Y is the cursor's whole offset from the
 * anchor, not a delta. The stream then alternates real delta, echo, real
 * delta, echo, ..., and each echo equals the previous echo plus the real
 * motion in between (scaled by 1/devicePixelRatio, hence a tolerance that
 * grows with the motion). Summing echoes as deltas adds the cursor's
 * position to the view every frame: the camera lurches by hundreds of
 * counts, worst vertically, where offsets are largest.
 *
 * Detection needs two consecutive matches (echo ≈ echo + real, twice), a
 * pattern real hand motion cannot make, since it needs each delta to be the
 * sum of the two before it. Then each event is classified against the
 * predicted cursor offset.
 */
export const ECHO_TOL = 3; // counts, absolute part of the match tolerance
export const ECHO_TOL_FRAC = 0.35; // relative part (covers 1/DPR down to ~0.65)
export const ECHO_MIN = 16; // an echo pattern must reach this size to be trusted
export const ECHO_EXIT_REALS = 8; // this many reals in a row with no echo: warp works again

const cheb = (x, y) => Math.max(Math.abs(x), Math.abs(y));
/** v matches pred on both axes, with tolerance growing with `motion`. */
function echoMatch(vx, vy, px, py, mx, my) {
  return Math.abs(vx - px) <= ECHO_TOL + ECHO_TOL_FRAC * Math.abs(mx) &&
         Math.abs(vy - py) <= ECHO_TOL + ECHO_TOL_FRAC * Math.abs(my);
}

export class MouseLook {
  constructor() {
    this.dx = 0; // accumulated counts since the last consume()
    this.dy = 0;
    this.yawRad = 0; // accumulated radians from touch
    this.pitchRad = 0;
    this.stats = { accepted: 0, rejected: 0, echoes: 0, echo: false, last: [0, 0], maxAbs: 0 };
    this.reset(0);
  }

  /** Call when pointer lock is gained or lost: drops pending input and the warp events. */
  reset(settleEvents = SETTLE_EVENTS) {
    this.dx = this.dy = this.yawRad = this.pitchRad = 0;
    this.settle = settleEvents;
    this.prevMag = 0;
    this.prevTime = -Infinity;
    // Echo filter: last 4 raw events as {x, y, acc} (acc = added to dx/dy).
    this.hist = [];
    this.echo = false;
    this.trackX = this.trackY = 0; // last echo = cursor offset from the anchor
    this.sinceX = this.sinceY = 0; // real motion since that echo
    this.lastWasEcho = false;
    this.realRun = 0;
    this.stats.echo = false;
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
    const mag = cheb(mx, my);
    s.maxAbs = Math.max(s.maxAbs, mag);
    if (this.settle > 0) {
      this.settle--;
      s.rejected++;
      return false;
    }
    if (this.isEcho(mx, my)) {
      s.echoes++;
      s.rejected++;
      return false;
    }
    const acc = this.spikeFilter(mx, my, mag, t);
    if (!this.echo) {
      this.hist.push({ x: mx, y: my, acc });
      if (this.hist.length > 4) this.hist.shift();
    }
    if (!acc) {
      s.rejected++;
      return false;
    }
    this.dx += mx;
    this.dy += my;
    s.accepted++;
    return true;
  }

  /** Echo filter (see ECHO_*). True if (vx, vy) is a Firefox echo to drop. */
  isEcho(vx, vy) {
    if (this.echo) {
      const px = this.trackX + this.sinceX, py = this.trackY + this.sinceY;
      // Right after an echo a real delta is due, so only a tight match counts;
      // otherwise "closer to the predicted offset than to zero" is enough,
      // which also re-syncs the track after a misclassification.
      const tight = echoMatch(vx, vy, px, py, this.sinceX, this.sinceY);
      const loose = !this.lastWasEcho && cheb(vx - px, vy - py) < cheb(vx, vy);
      if (tight || loose) {
        this.trackX = vx; this.trackY = vy;
        this.sinceX = this.sinceY = 0;
        this.lastWasEcho = true;
        this.realRun = 0;
        return true;
      }
      this.lastWasEcho = false;
      this.sinceX += vx; this.sinceY += vy;
      if (++this.realRun >= ECHO_EXIT_REALS) {
        this.echo = this.stats.echo = false;
        this.hist = [];
      }
      return false;
    }
    if (this.hist.length < 4) return false;
    const [a, b, c, d] = this.hist;
    const echoSize = Math.max(cheb(a.x, a.y), cheb(c.x, c.y), cheb(vx, vy));
    const realSize = Math.max(cheb(b.x, b.y), cheb(d.x, d.y), ECHO_TOL);
    if (echoSize < ECHO_MIN || echoSize < 2 * realSize) return false;
    if (!echoMatch(c.x, c.y, a.x + b.x, a.y + b.y, b.x, b.y)) return false;
    if (!echoMatch(vx, vy, c.x + d.x, c.y + d.y, d.x, d.y)) return false;
    // Confirmed. Take back the two echoes already added; if they were applied
    // last frame, this turns the view back on the next frame.
    for (const e of [a, c]) {
      if (e.acc) { this.dx -= e.x; this.dy -= e.y; this.stats.accepted--; }
    }
    this.echo = this.stats.echo = true;
    this.stats.echoes += 2;
    this.trackX = vx; this.trackY = vy;
    this.sinceX = this.sinceY = 0;
    this.lastWasEcho = true;
    this.realRun = 0;
    this.prevMag = realSize;
    this.hist = [];
    return true;
  }

  /** Spike filter (see SPIKE_*). True if the event is plausible hand motion. */
  spikeFilter(mx, my, mag, t) {
    const prev = t - this.prevTime <= SPIKE_WINDOW_MS ? this.prevMag : 0;
    this.prevTime = t;
    if (mag > SPIKE_FLOOR && mag > SPIKE_RATIO * prev) {
      // Remember it capped, so a real flick that starts hard loses only its
      // first frame, while a lone huge spike can't vouch for another one.
      this.prevMag = SPIKE_FLOOR;
      return false;
    }
    this.prevMag = mag;
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
