// Cow enemies. Types are plain data in a registry; live cows sit in flat
// typed arrays (structure of arrays) so thousands of them stay cheap and
// allocation-free in the hot loop. Pure: no three.js, no DOM.

/**
 * Cow types by id. To add one, call defineCow() with these fields:
 *   id, name, hp, speed (m/s), bounty (moolah on kill), damage (milk taken
 *   on arrival), radius (m, for hits and spacing), scale (visual size), color.
 */
export const COW_TYPES = {};
/** Index -> type, so a cow stores its type as a small integer. */
export const COW_TYPE_LIST = [];

export function defineCow(def) {
  for (const k of ['id', 'hp', 'speed', 'bounty', 'damage', 'radius']) {
    if (def[k] === undefined) throw new Error(`cow type ${def.id}: missing ${k}`);
  }
  if (COW_TYPES[def.id]) throw new Error(`cow type ${def.id} defined twice`);
  const t = Object.freeze({ scale: 1, color: 0xffffff, ...def, index: COW_TYPE_LIST.length });
  COW_TYPES[def.id] = t;
  COW_TYPE_LIST.push(t);
  return t;
}

defineCow({
  id: 'cow', name: 'Cow', hp: 30, speed: 3.2, bounty: 4, damage: 5, radius: 0.55, scale: 1, color: 0xffffff,
});

/**
 * Live cows, densely packed in slots 0..count-1. Removing a cow moves the
 * last cow into its slot, so iteration never skips holes. Nothing outside
 * holds a slot index across ticks (tower shots resolve the same tick).
 */
export class CowPool {
  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.count = 0;
    this.x = new Float64Array(capacity);
    this.z = new Float64Array(capacity);
    /** Position at the previous tick, for render interpolation. */
    this.px = new Float64Array(capacity);
    this.pz = new Float64Array(capacity);
    this.vx = new Float64Array(capacity);
    this.vz = new Float64Array(capacity);
    /** Fixed per-cow aim offset inside each cell, so a herd spreads out instead of walking in single file. */
    this.ox = new Float64Array(capacity);
    this.oz = new Float64Array(capacity);
    this.hp = new Float64Array(capacity);
    this.type = new Uint8Array(capacity);
    /** Seconds since the cow was last hit, for a damage flash. */
    this.hitAge = new Float64Array(capacity);
    /** Stable id, so the renderer or a replay can tell cows apart. */
    this.id = new Uint32Array(capacity);
    this.nextId = 1;
    this.fields = [this.x, this.z, this.px, this.pz, this.vx, this.vz, this.ox, this.oz, this.hp, this.type, this.hitAge, this.id];
  }

  /** Returns the slot, or -1 when full. */
  spawn(type, x, z, ox, oz) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.x[i] = this.px[i] = x;
    this.z[i] = this.pz[i] = z;
    this.vx[i] = this.vz[i] = 0;
    this.ox[i] = ox;
    this.oz[i] = oz;
    this.hp[i] = type.hp;
    this.type[i] = type.index;
    this.hitAge[i] = Infinity;
    this.id[i] = this.nextId++;
    return i;
  }

  remove(i) {
    const last = --this.count;
    if (i === last) return;
    for (const a of this.fields) a[i] = a[last];
  }

  clear() { this.count = 0; }
}
