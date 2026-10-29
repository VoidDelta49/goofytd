// Another farmer's position, smoothed. Their movement isn't part of the shared
// sim (each machine moves its own farmer), so it arrives as snapshots ~20 times
// a second over an unreliable channel and is shown INTERP_DELAY ms in the past,
// blended between the two snapshots around that moment. Pure; Node-tested.

export const INTERP_DELAY = 110;
export const POS_RATE_HZ = 20;
const KEEP = 12;
const TAU = Math.PI * 2;

/** Shortest-way blend between two angles. */
export function lerpAngle(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/** Compact wire form of a farmer's state (3 decimals is mm / mrad). */
export function packPos(seq, s) {
  const r = (v) => Math.round(v * 1000) / 1000;
  return { t: 'p', q: seq, x: r(s.x), y: r(s.y), z: r(s.z), yw: r(s.yaw), pt: r(s.pitch), c: s.crouched ? 1 : 0 };
}

export class Track {
  constructor() {
    /** { at, x, y, z, yaw, pitch, crouched }, oldest first. */
    this.snaps = [];
    this.lastSeq = -1;
  }

  /** A snapshot arrived at `now` (ms). Old or out-of-order ones are dropped. */
  push(now, m) {
    if (!Number.isInteger(m.q) || m.q <= this.lastSeq) return false;
    const ok = [m.x, m.y, m.z, m.yw, m.pt].every(Number.isFinite);
    if (!ok) return false;
    this.lastSeq = m.q;
    this.snaps.push({ at: now, x: m.x, y: m.y, z: m.z, yaw: m.yw, pitch: m.pt, crouched: !!m.c });
    if (this.snaps.length > KEEP) this.snaps.shift();
    return true;
  }

  get ready() { return this.snaps.length > 0; }

  /** State at `now - INTERP_DELAY`, plus its horizontal speed (m/s) for the walk cycle. */
  sample(now) {
    const s = this.snaps;
    if (!s.length) return null;
    const t = now - INTERP_DELAY;
    let k = s.length - 1;
    while (k > 0 && s[k - 1].at > t) k--;
    // k: first snapshot after t (or the oldest). Before the oldest / after the newest: hold.
    if (k === 0 || s[k].at <= t) {
      const e = t <= s[0].at ? s[0] : s[s.length - 1];
      return { ...e, speed: 0 };
    }
    const a = s[k - 1], b = s[k];
    const span = b.at - a.at;
    const f = span > 0 ? (t - a.at) / span : 1;
    const speed = span > 0 ? Math.hypot(b.x - a.x, b.z - a.z) / (span / 1000) : 0;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
      yaw: lerpAngle(a.yaw, b.yaw, f),
      pitch: a.pitch + (b.pitch - a.pitch) * f,
      crouched: f < 0.5 ? a.crouched : b.crouched,
      speed,
    };
  }
}
