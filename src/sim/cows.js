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
 *   armor        flat damage taken off every direct hit (never below 25% of
 *                the hit); damage over time (slicks) ignores it
 *   splitInto, splitCount   on death, this many cows of type splitInto pop
 *                out where it fell (at the current wave's HP)
 *   enrageBelow, enrageSpeed   under this fraction of its max HP it runs at
 *                speed × enrageSpeed
 *   healRate, healRadius   every HEAL_PULSE s, other cows within healRadius m
 *                get healRate × HEAL_PULSE of their max HP back
 *   camo         towers can't pick it as a target until it's within this many
 *                metres (splash, spray and auras still hit it)
 *   ramDamage    > 0: a Headbutt Heifer. When a tower is within RAM_REACH of
 *                its edge it stops, winds up for `windup` s (a 'windup' event:
 *                snort, lean back) and headbutts it for ramDamage tower HP.
 *                Then it can't again for `abilityCooldown` s
 *   spitRange, spitStun, spitDamage   a Cud Spitter: stops, winds up, and spits
 *                at the nearest shooting tower within spitRange m that isn't
 *                already stunned: it can't fire for spitStun s (never stacks)
 *   windup, abilityCooldown   for both of the above. A tipped cow can't act,
 *                and tipping it mid wind-up cancels the attack
 *   firstWave, weight   when it starts showing up in waves, and how often
 *                relative to the others (see waveMix)
 *   boss         a boss: spawned by boss waves (Game.bossEvery), gets the boss
 *                health bar, can't be tipped, and runs its own attack script
 *                (see `bossAttacks` and Game.bossAct). Bosses keep their extra
 *                state in Game.bosses, keyed by cow id
 *   upright      drawn standing on its hind legs (its own model)
 *   slowResist   0..1: this much of every slow is shrugged off (0.5 halves it)
 */
export const COW_TYPES = {};
/** Index -> type, so a cow stores its type as a small integer. */
export const COW_TYPE_LIST = [];

/** Seconds between a Vet Cow's heals. */
export const HEAL_PULSE = 0.5;

export function defineCow(def) {
  for (const k of ['id', 'hp', 'speed', 'bounty', 'damage', 'radius']) {
    if (def[k] === undefined) throw new Error(`cow type ${def.id}: missing ${k}`);
  }
  if (def.splitInto && !(def.splitCount > 0)) throw new Error(`cow type ${def.id}: splitInto needs splitCount`);
  if ((def.ramDamage > 0 || def.spitRange > 0) && !(def.windup > 0 && def.abilityCooldown > 0)) {
    throw new Error(`cow type ${def.id}: an attack needs windup and abilityCooldown`);
  }
  if (COW_TYPES[def.id]) throw new Error(`cow type ${def.id} defined twice`);
  if (COW_TYPE_LIST.length >= 256) throw new Error('too many cow types (stored as a byte)');
  const t = Object.freeze({
    name: def.id, scale: 1, color: 0xffffff, altitude: 0, blastRadius: 0, firstWave: 1, weight: 1,
    armor: 0, splitInto: null, splitCount: 0, enrageBelow: 0, enrageSpeed: 1, healRate: 0, healRadius: 0, camo: 0,
    ramDamage: 0, spitRange: 0, spitStun: 0, spitDamage: 0, windup: 0, abilityCooldown: 0,
    boss: null, upright: false, slowResist: 0,
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

defineCow({
  id: 'tin', name: 'Tin Cow', hp: 60, speed: 2.6, bounty: 9, damage: 8, radius: 0.6, scale: 1.1, color: 0xb8c4cc,
  armor: 4, firstWave: 7, weight: 2,
});

defineCow({
  id: 'mama', name: 'Mama Cow', hp: 70, speed: 2.8, bounty: 6, damage: 8, radius: 0.65, scale: 1.25, color: 0xffc8dc,
  splitInto: 'calf', splitCount: 3, firstWave: 8, weight: 2,
});

defineCow({
  id: 'bull', name: 'Raging Bull', hp: 80, speed: 3.0, bounty: 10, damage: 10, radius: 0.65, scale: 1.2, color: 0x9a5434,
  enrageBelow: 0.5, enrageSpeed: 2.2, firstWave: 9, weight: 2,
});

defineCow({
  id: 'vet', name: 'Vet Cow', hp: 50, speed: 3.0, bounty: 12, damage: 5, radius: 0.55, scale: 1, color: 0xa8ffb8,
  healRate: 0.06, healRadius: 4.5, firstWave: 10, weight: 1,
});

defineCow({
  id: 'ninja', name: 'Ninja Cow', hp: 35, speed: 4.2, bounty: 9, damage: 6, radius: 0.5, scale: 0.9, color: 0x3a3a4a,
  camo: 7, firstWave: 11, weight: 1,
});

// Cows that hit back. Both stand still while they wind up, so they're free shots,
// and both are easy to read: a snort and a lean back, or a puffed-up green spitter.

defineCow({
  id: 'ram', name: 'Headbutt Heifer', hp: 80, speed: 2.8, bounty: 11, damage: 8, radius: 0.6, scale: 1.15, color: 0x8a6a5a,
  ramDamage: 20, windup: 0.9, abilityCooldown: 2.2, firstWave: 12, weight: 2,
});

defineCow({
  id: 'spitter', name: 'Cud Spitter', hp: 40, speed: 3.0, bounty: 9, damage: 5, radius: 0.55, scale: 1, color: 0x9ad36a,
  spitRange: 9, spitStun: 2.5, spitDamage: 5, windup: 0.7, abilityCooldown: 5, firstWave: 13, weight: 1,
});

// Surprise-only cows (weight 0: never in a wave mix; surprises.js spawns them).

defineCow({
  id: 'golden', name: 'Cash Cow', hp: 40, speed: 5.2, bounty: 0, damage: 2, radius: 0.5, scale: 0.95, color: 0xffc933,
  weight: 0,
});

defineCow({
  // radius > cell/2 gives no herd offset, so she walks cell centres and never clips towers.
  id: 'bessie', name: 'Big Bessie', hp: 400, speed: 1.6, bounty: 60, damage: 40, radius: 1.1, scale: 2.5, color: 0xd9a066,
  weight: 0,
});

// The boss. Spawned by boss waves (every Game cfg.bossEvery waves), never by a mix.
// Every attack is telegraphed and she stands still for it, so each one is also a window of free shots.

defineCow({
  id: 'bigmama', name: 'BIG MAMA BESSIE', hp: 2000, speed: 1.5, bounty: 300, damage: 60, radius: 1.1, scale: 2.1, color: 0xffffff,
  // Mild armour: a swarm of chip damage is weak against her, real guns aren't.
  armor: 3, slowResist: 0.5, upright: true, weight: 0,
  // Last phase: MAMA IS ANGRY. Faster and stomps more often (reuses the Raging Bull enrage).
  enrageBelow: 1 / 3, enrageSpeed: 1.4,
  boss: Object.freeze({
    /** Hoof Stomp: rears up and slams the ground. Every tower within `radius` m (to its edge) takes `damage` and is stunned. */
    stomp: Object.freeze({ radius: 7, damage: 15, stun: 1.5, windup: 1.4, cooldown: 9, angryCooldown: 6, first: 4 }),
    /** Purse Wallop: a tower right next to her gets her handbag. */
    wallop: Object.freeze({ damage: 45, windup: 0.9, cooldown: 4 }),
    /** "MAMA'S BABIES!": under each fraction of max HP she stops, bellows, and calls cows of `type` to her side. */
    summon: Object.freeze({ at: Object.freeze([2 / 3, 1 / 3]), type: 'mama', count: 2, bellow: 1.5 }),
  }),
});

defineCow({
  id: 'calf', name: 'Calf', hp: 6, speed: 4.5, bounty: 1, damage: 1, radius: 0.35, scale: 0.5, color: 0xffffff,
  weight: 0,
});

defineCow({
  id: 'trojan', name: 'Trojan Cow', hp: 120, speed: 2.4, bounty: 10, damage: 12, radius: 0.85, scale: 1.6, color: 0x9a7a50,
  splitInto: 'fast', splitCount: 6, weight: 0,
});

defineCow({
  id: 'megamama', name: 'Mega Mama', hp: 220, speed: 2.0, bounty: 20, damage: 20, radius: 0.95, scale: 2.0, color: 0xff9ec0,
  splitInto: 'mama', splitCount: 3, weight: 0,
});

for (const t of COW_TYPE_LIST) {
  if (t.boss && !COW_TYPES[t.boss.summon.type]) throw new Error(`cow type ${t.id}: summons unknown ${t.boss.summon.type}`);
  if (t.splitInto && !COW_TYPES[t.splitInto]) throw new Error(`cow type ${t.id}: splits into unknown ${t.splitInto}`);
}

// ---- live cow state ----------------------------------------------------------
//
// Every per-cow value is one typed array, declared once in the table below.
// To give cows new state, add a defineCowField() line next to the feature
// that uses it: the pool allocates, spawns, removes and clears it for you.
// Read and write it as `cows.<name>[slot]`.

/** Cow ability phases, in `cows.abilityState`. */
export const ABILITY_COOLDOWN = 0;
export const ABILITY_WINDUP = 1;

/** Declared fields, in declaration order: { name, array, spawn, doc }. */
export const COW_FIELDS = [];
let poolsMade = false;

/**
 * Declare a per-cow array.
 * @param {string} name   property name on the pool (`cows.name[slot]`)
 * @param {Function} array typed array constructor (Float64Array, Uint8Array, ...)
 * @param {number | ((type: object, at: {x:number,z:number,offsetX:number,offsetZ:number,id:number}) => number)} spawn
 *   value a freshly spawned cow gets: a constant, or computed from its type and spawn point
 * @param {string} doc    what it means (shows up in COW_FIELDS for tooling)
 */
export function defineCowField(name, array, spawn = 0, doc = '') {
  if (poolsMade) throw new Error(`cow field ${name}: define fields before the first CowPool`);
  if (COW_FIELDS.some((f) => f.name === name)) throw new Error(`cow field ${name} defined twice`);
  if (['count', 'capacity', 'nextId', 'spawn', 'remove', 'clear'].includes(name)) throw new Error(`cow field ${name}: reserved name`);
  COW_FIELDS.push(Object.freeze({ name, array, spawn, doc }));
}

// Identity and health
defineCowField('id', Uint32Array, (t, at) => at.id, 'stable id, so renderers, replays and bosses can tell cows apart (slots move)');
defineCowField('type', Uint8Array, (t) => t.index, 'index into COW_TYPE_LIST');
defineCowField('hp', Float64Array, (t) => t.hp, 'current HP (Game.spawnCow scales it per wave)');
defineCowField('maxHp', Float64Array, (t) => t.hp, 'HP at spawn after wave scaling, for heals, enrage and boss phases');
defineCowField('hitAge', Float64Array, Infinity, 'seconds since last hit, for the damage flash');

// Movement
defineCowField('x', Float64Array, (t, at) => at.x, 'position (m)');
defineCowField('z', Float64Array, (t, at) => at.z);
defineCowField('prevX', Float64Array, (t, at) => at.x, 'position at the previous tick, for render interpolation');
defineCowField('prevZ', Float64Array, (t, at) => at.z);
defineCowField('vx', Float64Array, 0, 'velocity (m/s)');
defineCowField('vz', Float64Array, 0);
defineCowField('offsetX', Float64Array, (t, at) => at.offsetX, 'fixed aim offset inside each cell, so a herd spreads out instead of walking single file');
defineCowField('offsetZ', Float64Array, (t, at) => at.offsetZ);

// Slows (molasses, butter slick, glue, boss resist applied by the tower)
defineCowField('slowTime', Float64Array, 0, 'seconds of slow left');
defineCowField('slowMult', Float64Array, 1, 'speed multiplier while slowed (0 = stuck)');

// Headbutt Heifer / Cud Spitter attacks
defineCowField('abilityState', Uint8Array, ABILITY_COOLDOWN, 'ABILITY_COOLDOWN or ABILITY_WINDUP');
// Spitters wait a moment after spawning, so they don't all fire the second they walk in.
defineCowField('abilityTime', Float64Array, (t) => (t.spitRange > 0 ? t.abilityCooldown * 0.4 : 0), 'seconds left of the wind-up or cooldown');
defineCowField('abilityTarget', Uint32Array, 0, 'tower id being wound up at (an id, never a slot: towers can be sold or wrecked mid wind-up)');

// On fire (Milk Frother family)
defineCowField('burnTime', Float64Array, 0, 'seconds of burning left');
defineCowField('burnDps', Float64Array, 0, 'burn damage per second');
defineCowField('burnSpread', Float64Array, 0, 'a burning cow that dies lights cows within this many metres');
defineCowField('burnSource', Uint32Array, 0, 'tower id credited with burn kills');

// Brain freeze (Soft-Serve family)
defineCowField('chillTime', Float64Array, 0, 'seconds of brain freeze left');
defineCowField('chillMult', Float64Array, 1, 'damage taken from everything is multiplied by this while frozen');

/**
 * Live cows, densely packed in slots 0..count-1, one typed array per field
 * in COW_FIELDS. Removing a cow moves the last cow into its slot, so
 * iteration never skips holes. Nothing outside holds a slot index across
 * ticks (tower shots resolve the same tick); hold `id`s instead.
 */
export class CowPool {
  constructor(capacity = 4096) {
    poolsMade = true;
    this.capacity = capacity;
    this.count = 0;
    this.nextId = 1;
    /** Bumped whenever slots or positions change (spawn, remove, clear, a movement step), for caches like CowHash. */
    this.version = 0;
    /** [array, spawn] per field, for spawn/remove. */
    this.columns = COW_FIELDS.map((f) => {
      const a = new f.array(capacity);
      this[f.name] = a;
      return [a, f.spawn];
    });
    this.at = { x: 0, z: 0, offsetX: 0, offsetZ: 0, id: 0 };
  }

  /** Spawn a cow of `type` at (x, z) with a herd offset. Returns the slot, or -1 when full. */
  spawn(type, x, z, offsetX, offsetZ) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.version++;
    const at = this.at;
    at.x = x; at.z = z; at.offsetX = offsetX; at.offsetZ = offsetZ; at.id = this.nextId++;
    for (const [a, spawn] of this.columns) a[i] = typeof spawn === 'function' ? spawn(type, at) : spawn;
    return i;
  }

  remove(i) {
    this.version++;
    const last = --this.count;
    if (i === last) return;
    for (const [a] of this.columns) a[i] = a[last];
  }

  clear() { this.count = 0; this.version++; }
}
