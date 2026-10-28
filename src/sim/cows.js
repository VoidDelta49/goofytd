// Cow enemies. Types are plain data in a registry; live cows sit in flat
// typed arrays (structure of arrays) so thousands of them stay cheap and
// allocation-free in the hot loop. Pure: no three.js, no DOM.

/**
 * Cow types by id. To add one, call defineCow() with these fields:
 *   id, name, hp, speed (m/s), bounty (moolah on kill), damage (milk taken
 *   on arrival), radius (m, for hits and spacing), scale (visual size), color
 *   (tint multiplied over the cow's own colours).
 * Optional behaviour:
 *   altitude     metres above the ground; > 0 means it flies: straight at the
 *                milk over walls and towers, ignored by placement, and only
 *                towers with hitsAir can shoot it (splash lands under it)
 *   blastRadius  > 0 means it explodes when it walks up to a tower, wrecking
 *                every tower within this many metres (no refund)
 *   firstWave, weight   when it starts showing up in waves, and how often
 *                relative to the others (see waveMix)
 */
export const COW_TYPES = {};
/** Index -> type, so a cow stores its type as a small integer. */
export const COW_TYPE_LIST = [];

export function defineCow(def) {
  for (const k of ['id', 'hp', 'speed', 'bounty', 'damage', 'radius']) {
    if (def[k] === undefined) throw new Error(`cow type ${def.id}: missing ${k}`);
  }
  if (COW_TYPES[def.id]) throw new Error(`cow type ${def.id} defined twice`);
  if (COW_TYPE_LIST.length >= 256) throw new Error('too many cow types (stored as a byte)');
  const t = Object.freeze({
    name: def.id, scale: 1, color: 0xffffff, altitude: 0, blastRadius: 0, firstWave: 1, weight: 1,
    ...def, index: COW_TYPE_LIST.length,
  });
  COW_TYPES[def.id] = t;
  COW_TYPE_LIST.push(t);
  return t;
}

/** Cow types that can appear in wave `wave`, with their weights: [{ type, weight }]. */
export function waveMix(wave) {
  return COW_TYPE_LIST.filter((t) => t.weight > 0 && t.firstWave <= wave).map((t) => ({ type: t, weight: t.weight }));
}

/** Pick from a waveMix with r in [0, 1). Deterministic for a given r. */
export function pickFromMix(mix, r) {
  let total = 0;
  for (const m of mix) total += m.weight;
  let x = r * total;
  for (const m of mix) {
    if (x < m.weight) return m.type;
    x -= m.weight;
  }
  return mix[mix.length - 1].type;
}

/** Cow types that show up for the first time in wave `wave` (for the HUD). */
export function cowDebuts(wave) {
  return COW_TYPE_LIST.filter((t) => t.weight > 0 && t.firstWave === wave && wave > 1);
}

defineCow({
  id: 'cow', name: 'Cow', hp: 30, speed: 3.2, bounty: 4, damage: 5, radius: 0.55, scale: 1, color: 0xffffff,
  weight: 10,
});

defineCow({
  id: 'fast', name: 'Zoomies Cow', hp: 16, speed: 7, bounty: 3, damage: 3, radius: 0.45, scale: 0.75, color: 0xfff09a,
  firstWave: 3, weight: 4,
});

defineCow({
  id: 'big', name: 'Big Cow', hp: 170, speed: 2.1, bounty: 16, damage: 15, radius: 0.9, scale: 1.7, color: 0xf0dcc0,
  firstWave: 4, weight: 2,
});

defineCow({
  id: 'flying', name: 'Flying Cow', hp: 24, speed: 3.8, bounty: 6, damage: 5, radius: 0.5, scale: 0.9, color: 0xbfe0ff,
  altitude: 4, firstWave: 5, weight: 3,
});

defineCow({
  id: 'boomer', name: 'Kaboom Cow', hp: 45, speed: 3.4, bounty: 8, damage: 10, radius: 0.55, scale: 1.05, color: 0xff5a4a,
  blastRadius: 2.6, firstWave: 6, weight: 2,
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
    /** Slowed (molasses, butter slick, glue): speed × slowF for slowT more seconds. */
    this.slowT = new Float64Array(capacity);
    this.slowF = new Float64Array(capacity);
    this.nextId = 1;
    this.fields = [this.x, this.z, this.px, this.pz, this.vx, this.vz, this.ox, this.oz, this.hp, this.type, this.hitAge, this.id, this.slowT, this.slowF];
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
    this.slowT[i] = 0;
    this.slowF[i] = 1;
    return i;
  }

  remove(i) {
    const last = --this.count;
    if (i === last) return;
    for (const a of this.fields) a[i] = a[last];
  }

  clear() { this.count = 0; }
}
