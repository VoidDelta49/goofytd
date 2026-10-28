// Minimal immutable 3-vector for the simulation. The sim deliberately does
// not import three.js: it has to run in Node tests and, later, on a server.

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static ZERO = Object.freeze(new Vec3(0, 0, 0));
  static Y = Object.freeze(new Vec3(0, 1, 0));

  add(o) { return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z); }
  sub(o) { return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z); }
  scale(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
  mul(o) { return new Vec3(this.x * o.x, this.y * o.y, this.z * o.z); }
  dot(o) { return this.x * o.x + this.y * o.y + this.z * o.z; }
  cross(o) {
    return new Vec3(
      this.y * o.z - this.z * o.y,
      this.z * o.x - this.x * o.z,
      this.x * o.y - this.y * o.x,
    );
  }
  length() { return Math.sqrt(this.dot(this)); }
  lengthSq() { return this.dot(this); }
  normalizeOrZero() {
    const l = this.length();
    return l > 1e-12 ? this.scale(1 / l) : Vec3.ZERO;
  }
  min(o) { return new Vec3(Math.min(this.x, o.x), Math.min(this.y, o.y), Math.min(this.z, o.z)); }
  max(o) { return new Vec3(Math.max(this.x, o.x), Math.max(this.y, o.y), Math.max(this.z, o.z)); }
  lerp(o, t) { return this.add(o.sub(this).scale(t)); }
  /** Component by axis index 0..2. */
  get(axis) { return axis === 0 ? this.x : axis === 1 ? this.y : this.z; }
  /** Copy with one component replaced. */
  with(axis, v) {
    return new Vec3(axis === 0 ? v : this.x, axis === 1 ? v : this.y, axis === 2 ? v : this.z);
  }
  horizontalLength() { return Math.hypot(this.x, this.z); }
  equals(o) { return this.x === o.x && this.y === o.y && this.z === o.z; }
  toArray() { return [this.x, this.y, this.z]; }
}

export const v3 = (x, y, z) => new Vec3(x, y, z);
