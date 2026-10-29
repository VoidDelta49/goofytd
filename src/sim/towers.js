// Tower types and their upgrades. A tower form is plain data plus two pluggable behaviours:
//   targeting  how it picks a cow (a name from TARGETING, or a function)
//   attack     what firing does   (a name from ATTACKS, a function, or null for a wall)
// defineTower() registers a buildable type (the build bar); defineUpgrade()
// registers a form a built tower can turn into. Upgrades go like Tower Defense
// King: the first levels are straight buffs, then the tower picks one of two
// variants that play differently, and each variant has one more level.
// A built tower just swaps its `def` to the upgraded form, so the game, the
// renderer and the HUD treat every form exactly like a type.
// Pure: no three.js, no DOM. Functions get (game, tower, ...) so they can
// use the game's grid, cows, RNG and event list.

import { COW_TYPE_LIST } from './cows.js';

/**
 * Targeting strategies: (game, tower) -> cow slot or -1. Only cows within
 * [minRange, range × game.sight] of the tower centre (in XZ) count (sight < 1
 * in War Moo-st fog), and a camo cow only within its `camo` metres.
 */
export const TARGETING = {
  /** Furthest along the path: the cow with the shortest walk left to the milk. */
  first: (game, t) => pick(game, t, (i) => -game.cowPathDistance(i)),
  nearest: (game, t) => pick(game, t, (i) => -dist2(game.cows, i, t.x, t.z)),
  strongest: (game, t) => pick(game, t, (i) => game.cows.hp[i]),
  /** Flying cows first (furthest along), then walkers: for flak. */
  airFirst: (game, t) => pick(game, t, (i) => (COW_TYPE_LIST[game.cows.type[i]].altitude > 0 ? 1e6 : 0) - game.cowPathDistance(i)),
};

/** Height (m) of a cow's middle, for tracers. */
export function cowAimY(type) { return type.altitude + 0.9 * type.scale; }

function dist2(cows, i, x, z) {
  const dx = cows.x[i] - x, dz = cows.z[i] - z;
  return dx * dx + dz * dz;
}

/** Highest score in range wins; ties go to the lower slot (deterministic). */
function pick(game, t, score) {
  const { cows } = game;
  const def = t.def;
  const range = def.range * (game.sight ?? 1);
  const r2 = range * range, m2 = def.minRange * def.minRange;
  let best = -1, bestScore = -Infinity;
  for (let i = 0; i < cows.count; i++) {
    const type = COW_TYPE_LIST[cows.type[i]];
    if (!def.hitsAir && type.altitude > 0) continue;
    const d2 = dist2(cows, i, t.x, t.z);
    if (d2 > r2 || d2 < m2) continue;
    if (type.camo > 0 && d2 > type.camo * type.camo) continue; // Ninja Cow: unseen until it's close
    const s = score(i);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

function shotEvent(game, t, i, extra) {
  const { cows } = game;
  return {
    kind: 'shot', tower: t.id, x0: t.muzzleX, y0: t.muzzleY, z0: t.muzzleZ,
    x1: cows.x[i], y1: cowAimY(COW_TYPE_LIST[cows.type[i]]), z1: cows.z[i], color: t.def.shotColor,
    sound: t.def.shotSound, ...extra,
  };
}

/** Scratch list for multi-hit attacks (hits resolve the same tick, so sharing is safe). */
const hitScratch = [];

/** Damage the listed slots highest-first, so swap-removing a dead cow never moves one still to be hit. */
function hitAll(game, t, slots, damage) {
  slots.sort((a, b) => b - a);
  for (const k of slots) game.damageCow(k, damage, t);
}

/** Attacks: (game, tower, cowSlot) -> void. Called once per shot. */
export const ATTACKS = {
  /** Instant hit on the target. Emits a 'shot' event for the tracer. */
  hitscan(game, t, i) {
    game.events.push(shotEvent(game, t, i));
    game.damageCow(i, t.def.damage, t);
  },

  /**
   * Lobbed shell: aims where the cow will be after `flightTime`, lands, and
   * splashes every cow within `splashRadius`. Holds a position, never a cow
   * slot, so cows dying mid-flight can't leave a stale reference. A shell
   * fired at a flying cow (only towers with hitsAir do that) bursts at its
   * height and hits only flyers; any other shell hits only walkers.
   * Carries the tower's slick (if any): a puddle left where it lands.
   */
  lob(game, t, i) {
    const { cows } = game;
    const def = t.def;
    const T = def.flightTime;
    const type = COW_TYPE_LIST[cows.type[i]];
    const air = type.altitude > 0;
    game.projectiles.push({
      tower: t.id, x0: t.muzzleX, y0: t.muzzleY, z0: t.muzzleZ,
      x1: cows.x[i] + cows.vx[i] * T, z1: cows.z[i] + cows.vz[i] * T, y1: air ? cowAimY(type) : 0.3, air,
      arc: def.arcHeight, t: 0, prevT: 0, T,
      damage: air ? def.damage : def.damage * def.groundFactor, radius: def.splashRadius, color: def.shotColor, slick: air ? null : def.slick,
    });
    game.events.push({ kind: 'launch', tower: t.id, x: t.muzzleX, z: t.muzzleZ });
  },

  /**
   * Shotgun: every cow in a cone (half-angle acos(spreadCos)) toward the
   * target within range takes `damage`, up to `maxHits` cows, target first.
   */
  shotgun(game, t, i) {
    const { cows } = game;
    const def = t.def;
    let fx = cows.x[i] - t.x, fz = cows.z[i] - t.z;
    const len = Math.sqrt(fx * fx + fz * fz) || 1;
    fx /= len; fz /= len;
    const r2 = def.range * def.range;
    hitScratch.length = 0;
    hitScratch.push(i);
    for (let k = cows.count - 1; k >= 0 && hitScratch.length < def.maxHits; k--) {
      if (k === i) continue;
      if (!def.hitsAir && COW_TYPE_LIST[cows.type[k]].altitude > 0) continue;
      const dx = cows.x[k] - t.x, dz = cows.z[k] - t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2 || d2 < 1e-9) continue;
      if ((dx * fx + dz * fz) / Math.sqrt(d2) >= def.spreadCos) hitScratch.push(k);
    }
    // One loud bang, a tracer per pellet.
    hitScratch.forEach((k, n) => game.events.push(shotEvent(game, t, k, n ? { quiet: true } : null)));
    hitAll(game, t, hitScratch, def.damage);
  },

  /**
   * Aura: everything within `range` of the tower (cow edge counts) is hit at
   * once. `slow` (speed factor) slows them for `slowTime`; `damage` > 0 zaps
   * up to `maxHits` of them with a tracer each.
   */
  aura(game, t) {
    const { cows } = game;
    const def = t.def;
    hitScratch.length = 0;
    for (let k = cows.count - 1; k >= 0; k--) {
      const type = COW_TYPE_LIST[cows.type[k]];
      if (!def.hitsAir && type.altitude > 0) continue;
      const r = def.range + type.radius;
      if (dist2(cows, k, t.x, t.z) > r * r) continue;
      if (def.slow < 1) game.slowCow(k, def.slow, def.slowTime);
      if (def.damage > 0 && hitScratch.length < def.maxHits) hitScratch.push(k);
    }
    if (!hitScratch.length) return;
    hitScratch.forEach((k, n) => game.events.push(shotEvent(game, t, k, n ? { quiet: true } : null)));
    hitAll(game, t, hitScratch, def.damage);
  },
};

/** Buildable tower types by id, in definition order (that order is the build bar and the 1-9 hotkeys). */
export const TOWER_TYPES = {};
/** Every form by id: the buildable types plus every upgrade. */
export const TOWER_FORMS = {};

const REQUIRED = ['id', 'name', 'cost', 'footprint', 'height', 'parts'];

function resolve(def) {
  const attack = typeof def.attack === 'string' ? ATTACKS[def.attack] : def.attack ?? null;
  const targeting = typeof def.targeting === 'string' ? TARGETING[def.targeting] : def.targeting ?? TARGETING.first;
  if (def.attack && !attack) throw new Error(`tower ${def.id}: unknown attack ${def.attack}`);
  if (!targeting) throw new Error(`tower ${def.id}: unknown targeting ${def.targeting}`);
  if (TOWER_FORMS[def.id]) throw new Error(`tower ${def.id} defined twice`);
  return { attack, targeting, attackName: typeof def.attack === 'string' ? def.attack : null };
}

/**
 * Register a tower type. Fields:
 *   id, name, blurb       identity and build-bar text
 *   cost                  moolah to build; selling refunds SELL_REFUND of everything spent on it
 *   footprint             size in grid cells (square); towers snap to the grid
 *   height                collision height in metres (the player can stand on low towers)
 *   attack, targeting     see ATTACKS / TARGETING; attack null = no shooting (a wall)
 *   range, minRange       metres, measured in XZ from the tower centre
 *   hitsAir               can target flying cows (default true; lobbed shells can't)
 *   interval              seconds between shots
 *   minInterval, spinUp, spinDown   spin-up guns: each shot adds spinUp (0..1) of
 *                         charge, the gap shrinks from interval to minInterval with
 *                         charge, and charge drains spinDown per second with no target
 *   damage                per hit (per cow in the splash for 'lob')
 *   maxHits, spreadCos    'shotgun' / 'aura': cows per shot, cone width
 *   slow, slowTime        'aura': speed factor and how long it lasts
 *   slick                 'lob': { radius, time, dps, slow } puddle where the shell lands
 *   blastProof            Kaboom Cows can't wreck it
 *   hp                    toughness against Headbutt Heifers (and spit); each upgrade
 *                         level adds 25% (towerMaxHp). Default 60
 *   groundFactor          'lob': damage multiplier on walkers (flak is made for flyers)
 *   muzzle                [x, y, z] local point shots leave from; rotates with the aim
 *   parts                 boxes to draw: { min:[x,y,z], max:[x,y,z], color, aim?:true }
 *                         in metres, local to the footprint centre at ground level;
 *                         aim parts turn to face the target (local -Z is forward)
 *   accent                UI colour for its upgrade card
 *   ...plus whatever its attack reads (flightTime, splashRadius, arcHeight, shotColor)
 */
export function defineTower(def) {
  for (const k of REQUIRED) if (def[k] === undefined) throw new Error(`tower ${def.id}: missing ${k}`);
  const fns = resolve(def);
  const t = Object.freeze({
    blurb: '', range: 0, minRange: 0, hitsAir: true, interval: 1, damage: 0, muzzle: [0, 1, 0], shotColor: 0xffffff,
    minInterval: 0, spinUp: 0, spinDown: 0, maxHits: 1, spreadCos: 1, slow: 1, slowTime: 0, slick: null,
    blastProof: false, groundFactor: 1, accent: 0xffd84d, shotSound: 'shot', hp: 60,
    ...def, ...fns,
    level: 1, root: def.id, from: null, kind: 'base', upgradeCost: 0, upgrades: [],
  });
  TOWER_TYPES[def.id] = t;
  TOWER_FORMS[def.id] = t;
  return t;
}

/**
 * Register an upgrade: a new form of an existing one. Fields:
 *   id, from              the new form's id and the form it upgrades
 *   cost                  moolah to upgrade (added to what the tower is worth when sold)
 *   kind                  'buff' (a straight improvement) or 'variant' (a new way to play)
 *   addParts              boxes added to the inherited model; `parts` replaces it instead
 *   ...any tower field to override (stats, attack, targeting, name, blurb, accent)
 * Footprint and height can't change: the tower already sits on the grid.
 */
export function defineUpgrade(def) {
  const base = TOWER_FORMS[def.from];
  if (!base) throw new Error(`upgrade ${def.id}: unknown base ${def.from}`);
  if (!(def.cost > 0)) throw new Error(`upgrade ${def.id}: needs a cost`);
  if (def.kind !== 'buff' && def.kind !== 'variant') throw new Error(`upgrade ${def.id}: kind must be buff or variant`);
  for (const k of ['footprint', 'height']) if (def[k] !== undefined && def[k] !== base[k]) throw new Error(`upgrade ${def.id}: can't change ${k}`);
  const { from, cost, kind, addParts, ...over } = def;
  const merged = { ...base, ...over };
  if (over.attack === undefined) merged.attack = base.attackName ?? base.attack;
  if (over.targeting === undefined) merged.targeting = base.targeting;
  const fns = resolve(merged);
  const t = Object.freeze({
    ...merged, ...fns,
    parts: over.parts ?? (addParts ? [...base.parts, ...addParts] : base.parts),
    level: base.level + 1, root: base.root, from: base.id, kind, upgradeCost: cost, upgrades: [],
  });
  base.upgrades.push(t.id);
  TOWER_FORMS[t.id] = t;
  return t;
}

export const SELL_REFUND = 0.7;
/** A tower headbutted to pieces pays back this much of what was spent on it (insurance; Kaboom pays nothing). */
export const WRECK_REFUND = 0.35;
/** Damaged towers start patching themselves up this many seconds after the last hit... */
export const REPAIR_DELAY = 4;
/** ...at this fraction of their max HP per second. */
export const REPAIR_RATE = 0.1;

/** Max HP of a tower form: its `hp`, +25% per upgrade level, so investing in a tower also toughens it. */
export function towerMaxHp(def) { return Math.round(def.hp * (1 + 0.25 * (def.level - 1))); }

/** Deepest level any form of this root type reaches (for the HUD's level pips). */
export function maxLevel(rootId) {
  let m = 1;
  for (const f of Object.values(TOWER_FORMS)) if (f.root === rootId) m = Math.max(m, f.level);
  return m;
}

/** Shots per second at full spin (spin-up guns) or always. */
function fireRate(def) { return 1 / (def.minInterval > 0 ? def.minInterval : def.interval); }

/**
 * What a form does, as rows for the upgrade panel: { key, label, value, num }.
 * `num` (higher is better) lets the panel show what an upgrade changes.
 * Pure, so it's tested in Node.
 */
export function towerStats(def) {
  const rows = [];
  const add = (key, label, num, value = String(num)) => rows.push({ key, label, value, num });
  const fmt = (x) => (Math.round(x * 10) / 10).toString();
  if (!def.attack) {
    add('role', 'role', 0, 'wall');
  } else if (def.attackName === 'aura') {
    if (def.damage > 0) {
      add('damage', 'zap', def.damage);
      add('rate', 'zaps/s', fireRate(def), fmt(fireRate(def)));
      add('hits', 'cows per zap', def.maxHits);
    }
    if (def.slow < 1) add('slow', 'slows by', 1 - def.slow, `${Math.round((1 - def.slow) * 100)}%`);
    add('range', 'reach', def.range, `${fmt(def.range)} m`);
  } else {
    const dps = def.damage * fireRate(def);
    add('dps', def.minInterval > 0 ? 'max dps' : def.attackName === 'shotgun' ? 'dps/cow' : 'dps', dps, fmt(dps));
    add('damage', def.attackName === 'shotgun' ? 'pellet' : def.attackName === 'lob' ? 'per cow' : 'damage', def.damage);
    if (def.groundFactor < 1) add('ground', 'vs walkers', def.groundFactor, `${Math.round(def.groundFactor * 100)}%`);
    add('rate', 'shots/s', fireRate(def), fmt(fireRate(def)));
    add('range', 'range', def.range, `${fmt(def.range)} m`);
    if (def.attackName === 'lob') add('splash', 'splash', def.splashRadius, `${fmt(def.splashRadius)} m`);
    if (def.attackName === 'shotgun') add('hits', 'cows per blast', def.maxHits);
    if (def.slick) {
      add('slick', 'puddle', def.slick.dps, `${def.slick.dps}/s · ${def.slick.time} s`);
      add('slow', 'puddle slows', 1 - def.slick.slow, `${Math.round((1 - def.slick.slow) * 100)}%`);
    }
  }
  if (def.attack) add('air', 'hits flyers', def.hitsAir ? 1 : 0, def.hitsAir ? 'yes' : 'no');
  if (def.blastProof) add('blast', 'Kaboom-proof', 1, 'yes');
  add('hp', 'toughness', towerMaxHp(def));
  return rows;
}

// ---- Milk Squirter ---------------------------------------------------------

const SQ_BASE = [
  { min: [-0.9, 0, -0.9], max: [0.9, 0.8, 0.9], color: 0x6f9fd8 },
  { min: [-0.6, 0.8, -0.6], max: [0.6, 1.6, 0.6], color: 0xf4f4ff },
  { min: [-0.6, 1.6, -0.6], max: [0.6, 1.75, 0.6], color: 0x3b6fc4 },
];

defineTower({
  id: 'squirter',
  name: 'Milk Squirter',
  blurb: 'fast single-target squirts',
  cost: 50,
  footprint: 1,
  height: 1.6,
  attack: 'hitscan',
  targeting: 'first',
  range: 14,
  interval: 0.25,
  damage: 6,
  muzzle: [0, 1.3, -1.1],
  shotColor: 0xffffff,
  accent: 0x8fc4ff,
  parts: [...SQ_BASE, { min: [-0.13, 1.18, -1.1], max: [0.13, 1.42, -0.2], color: 0xd04848, aim: true }],
});

defineUpgrade({
  id: 'squirter2', from: 'squirter', kind: 'buff', cost: 40,
  name: 'Pressure Squirter', blurb: 'pumped-up pressure: harder, faster squirts',
  damage: 9, interval: 0.21, range: 15,
  addParts: [{ min: [-0.63, 1.12, -0.63], max: [0.63, 1.24, 0.63], color: 0xffd84d }],
});

defineUpgrade({
  id: 'squirter3', from: 'squirter2', kind: 'buff', cost: 80,
  name: 'Double-Pump Squirter', blurb: 'two pumps, one goal: soak every cow',
  damage: 13, interval: 0.17, range: 16,
  addParts: [
    { min: [-0.98, 0.8, -0.35], max: [-0.62, 1.45, 0.35], color: 0xf4f4ff },
    { min: [0.62, 0.8, -0.35], max: [0.98, 1.45, 0.35], color: 0xf4f4ff },
    { min: [-0.63, 0.92, -0.63], max: [0.63, 1.0, 0.63], color: 0xffd84d },
  ],
});

const GATLING = (n, len, color) => {
  const parts = [];
  for (const [x, y] of [[-0.14, 1.16], [0.14, 1.16], [-0.14, 1.44], [0.14, 1.44]].slice(0, n)) {
    parts.push({ min: [x - 0.07, y - 0.07, -len], max: [x + 0.07, y + 0.07, -0.3], color, aim: true });
  }
  return parts;
};

defineUpgrade({
  id: 'gatling', from: 'squirter3', kind: 'variant', cost: 180,
  name: 'Moo-chine Gun', blurb: 'spins up the longer it fires, then hoses everything. Melts Big Cows',
  damage: 7, interval: 0.2, minInterval: 0.04, spinUp: 0.05, spinDown: 0.5, range: 15,
  muzzle: [0, 1.3, -1.45], accent: 0xff7a5c,
  parts: [
    ...SQ_BASE,
    { min: [-0.3, 1.0, -0.45], max: [0.3, 1.6, 0.2], color: 0xd04848, aim: true },
    ...GATLING(4, 1.45, 0x50566a),
    { min: [-0.26, 1.06, -1.5], max: [0.26, 1.54, -1.38], color: 0x2c2f3a, aim: true },
  ],
});

defineUpgrade({
  id: 'gatling2', from: 'gatling', kind: 'buff', cost: 300,
  name: 'Udder Annihilator', blurb: 'spins up twice as fast and never really stops',
  damage: 9, interval: 0.15, minInterval: 0.03, spinUp: 0.1, spinDown: 0.3, range: 16,
  muzzle: [0, 1.3, -1.7], accent: 0xff4d4d,
  parts: [
    ...SQ_BASE,
    { min: [-0.3, 1.0, -0.45], max: [0.3, 1.6, 0.2], color: 0xffd84d, aim: true },
    ...GATLING(4, 1.7, 0x3a3f50),
    { min: [-0.26, 1.06, -1.75], max: [0.26, 1.54, -1.62], color: 0xffd84d, aim: true },
    // Ammo drum: a milk churn painted like a cow.
    { min: [0.3, 0.95, -0.4], max: [0.75, 1.55, 0.2], color: 0xffffff, aim: true },
    { min: [0.76, 1.1, -0.3], max: [0.77, 1.35, -0.05], color: 0x1d1d1d, aim: true },
  ],
});

const SHOTGUN = (len, flare, wood, tip) => [
  { min: [-0.36, 1.05, -0.2], max: [0.36, 1.35, 0.35], color: wood, aim: true },
  { min: [-0.3, 1.2, -len], max: [-0.04, 1.44, -0.2], color: 0x50566a, aim: true },
  { min: [0.04, 1.2, -len], max: [0.3, 1.44, -0.2], color: 0x50566a, aim: true },
  { min: [-0.3 - flare, 1.16 - flare, -len - 0.12], max: [0.3 + flare, 1.48 + flare, -len], color: tip, aim: true },
];

defineUpgrade({
  id: 'shotgun', from: 'squirter3', kind: 'variant', cost: 170,
  name: 'Moo-shotgun', blurb: 'short range cone blast that soaks a whole herd at once. Shreds Zoomies',
  attack: 'shotgun', damage: 30, interval: 0.55, range: 10, maxHits: 8, spreadCos: 0.8,
  muzzle: [0, 1.32, -1.3], shotColor: 0xfff4c8, shotSound: 'blast', accent: 0xffb347,
  parts: [...SQ_BASE, ...SHOTGUN(1.2, 0, 0x8a5a32, 0x2c2f3a)],
});

defineUpgrade({
  id: 'shotgun2', from: 'shotgun', kind: 'buff', cost: 260,
  name: 'Dairy Blunderbuss', blurb: 'a bell-mouthed cannon of cream: wider, longer, more pellets',
  damage: 36, interval: 0.5, range: 12, maxHits: 12, spreadCos: 0.72,
  muzzle: [0, 1.32, -1.6], accent: 0xff9a1f,
  parts: [...SQ_BASE, ...SHOTGUN(1.45, 0.14, 0x6a4024, 0xffd84d)],
});

// ---- Butter Mortar ---------------------------------------------------------

const MORTAR_BASE = [{ min: [-1.8, 0, -1.8], max: [1.8, 1.0, 1.8], color: 0x8a6a4a }];

defineTower({
  id: 'mortar',
  hp: 100,
  name: 'Butter Mortar',
  blurb: 'slow lobbed splash, can\'t hit up close or flying cows',
  cost: 120,
  footprint: 2,
  height: 1.0,
  attack: 'lob',
  targeting: 'first',
  hitsAir: false,
  range: 30,
  minRange: 5,
  interval: 2.2,
  damage: 22,
  flightTime: 1.1,
  splashRadius: 3.5,
  arcHeight: 7,
  muzzle: [0, 1.8, -0.6],
  shotColor: 0xffd84d,
  accent: 0xffd84d,
  parts: [
    ...MORTAR_BASE,
    { min: [-0.9, 1.0, -0.9], max: [0.9, 1.25, 0.9], color: 0x5a4632, aim: true },
    { min: [-0.45, 1.25, -0.9], max: [0.45, 1.95, 0.0], color: 0x3a3a40, aim: true },
    { min: [-0.35, 1.95, -0.8], max: [0.35, 2.05, -0.1], color: 0xffd84d, aim: true },
  ],
});

const SALT = [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]].map(([x, z]) => ({ min: [x - 0.2, 1.0, z - 0.2], max: [x + 0.2, 1.35, z + 0.2], color: 0xf8f8f8 }));

defineUpgrade({
  id: 'mortar2', from: 'mortar', kind: 'buff', cost: 90,
  name: 'Salted Butter Mortar', blurb: 'salted shells: more damage, bigger splat',
  damage: 34, splashRadius: 3.8, interval: 2.1,
  addParts: SALT,
});

defineUpgrade({
  id: 'mortar3', from: 'mortar2', kind: 'buff', cost: 140,
  name: 'Big Tub Mortar', blurb: 'a whole tub per shot, fired further and faster',
  damage: 48, splashRadius: 4.2, interval: 1.9, range: 33, muzzle: [0, 2.1, -0.65],
  parts: [
    ...MORTAR_BASE, ...SALT,
    { min: [-0.9, 1.0, -0.9], max: [0.9, 1.25, 0.9], color: 0x5a4632, aim: true },
    { min: [-0.6, 1.25, -1.05], max: [0.6, 2.1, 0.1], color: 0x3a3a40, aim: true },
    { min: [-0.5, 2.1, -0.95], max: [0.5, 2.22, 0.0], color: 0xffd84d, aim: true },
  ],
});

const TUB = (top, flames) => [
  ...MORTAR_BASE, ...SALT,
  { min: [-0.9, 1.0, -0.9], max: [0.9, 1.25, 0.9], color: 0x5a4632, aim: true },
  { min: [-0.75, 1.25, -1.1], max: [0.75, 2.0, 0.3], color: 0xf7e27a, aim: true },
  { min: [-0.8, 2.0, -1.15], max: [0.8, 2.12, 0.35], color: top, aim: true },
  ...(flames ? [[-0.95, -0.4], [0.95, -0.4], [0, -1.25]].map(([x, z]) => ({ min: [x - 0.15, 1.25, z - 0.15], max: [x + 0.15, 1.75, z + 0.15], color: 0xff6a1a, aim: true })) : []),
];

defineUpgrade({
  id: 'slick', from: 'mortar3', kind: 'variant', cost: 200,
  name: 'Butter Slick Lobber', blurb: 'shells leave a slippery puddle that slows and greases every cow that walks in',
  damage: 40, interval: 2.0, muzzle: [0, 2.1, -0.6], accent: 0xf7e27a,
  slick: { radius: 3.0, time: 3, dps: 5, slow: 0.6 },
  parts: TUB(0x3b6fc4, false),
});

defineUpgrade({
  id: 'slick2', from: 'slick', kind: 'buff', cost: 280,
  name: 'Hot Butter Slick', blurb: 'melted, sizzling butter: bigger, longer, nastier puddles',
  damage: 55, interval: 1.8, accent: 0xff8a3d, shotColor: 0xffb347,
  slick: { radius: 3.5, time: 4, dps: 8, slow: 0.5 },
  parts: TUB(0xd04848, true),
});

const FLAK = (barrels, kettle) => [
  ...MORTAR_BASE,
  { min: [-1.0, 1.0, -1.0], max: [1.0, 1.7, 1.0], color: kettle, aim: true },
  { min: [-1.02, 1.15, -1.02], max: [1.02, 1.3, 1.02], color: 0xffffff, aim: true },
  ...barrels.map((x) => ({ min: [x - 0.16, 1.7, -0.5], max: [x + 0.16, 3.1, -0.18], color: 0x3a3a40, aim: true })),
  { min: [-0.5, 1.7, 0.1], max: [0.5, 2.1, 0.7], color: 0xfff2b0, aim: true }, // popcorn hopper
];

defineUpgrade({
  id: 'flak', from: 'mortar3', kind: 'variant', cost: 180,
  name: 'Popcorn Flak', blurb: 'rapid popcorn airbursts that swat Flying Cows out of the sky (walkers only take half)',
  targeting: 'airFirst', hitsAir: true, groundFactor: 0.5, damage: 50, interval: 0.55, flightTime: 0.45, arcHeight: 2.5,
  splashRadius: 3.0, range: 26, minRange: 3, muzzle: [0, 3.1, -0.34], shotColor: 0xfff2b0, accent: 0xff5a7a,
  parts: FLAK([-0.3, 0.3], 0xd04848),
});

defineUpgrade({
  id: 'flak2', from: 'flak', kind: 'buff', cost: 260,
  name: 'Kettle-Corn Battery', blurb: 'four barrels of sweet-and-salty flak',
  damage: 60, interval: 0.4, splashRadius: 3.4, range: 28, accent: 0xe8457a,
  parts: FLAK([-0.66, -0.22, 0.22, 0.66], 0x2c2f3a),
});

// ---- Hay Bale ------------------------------------------------------------

const BALE = (straps) => [
  { min: [-0.95, 0, -0.95], max: [0.95, 1.0, 0.95], color: 0xe2c25a },
  { min: [-0.97, 0.3, -0.97], max: [0.97, 0.38, 0.97], color: straps },
  { min: [-0.97, 0.62, -0.97], max: [0.97, 0.7, 0.97], color: straps },
];

defineTower({
  id: 'haybale',
  name: 'Hay Bale',
  blurb: 'cheap wall: make the cows take the long way',
  cost: 10,
  footprint: 1,
  height: 1.0,
  attack: null,
  // Walls soak headbutts: cheap bales beside the lane keep Heifers off the guns.
  hp: 160,
  accent: 0xe2c25a,
  parts: BALE(0xa8873a),
});

defineUpgrade({
  id: 'haybale2', from: 'haybale', kind: 'buff', cost: 20,
  name: 'Packed Bale', blurb: 'iron-strapped: Kaboom Cows blow up on it and it just shrugs',
  blastProof: true, hp: 200, accent: 0xb9c0cc,
  parts: BALE(0x5a5f6a),
});

const POSTS = (wire, top) => [
  ...BALE(0x5a5f6a),
  { min: [-0.9, 1.0, -0.9], max: [-0.75, 1.75, -0.75], color: 0x6b4a2f },
  { min: [0.75, 1.0, 0.75], max: [0.9, 1.75, 0.9], color: 0x6b4a2f },
  { min: [-0.9, 1.0, 0.75], max: [-0.75, 1.75, 0.9], color: 0x6b4a2f },
  { min: [0.75, 1.0, -0.9], max: [0.9, 1.75, -0.75], color: 0x6b4a2f },
  { min: [-0.83, 1.32, -0.86], max: [0.83, 1.36, -0.8], color: wire },
  { min: [-0.83, 1.32, 0.8], max: [0.83, 1.36, 0.86], color: wire },
  { min: [-0.86, 1.32, -0.83], max: [-0.8, 1.36, 0.83], color: wire },
  { min: [0.8, 1.32, -0.83], max: [0.86, 1.36, 0.83], color: wire },
  ...(top ? [{ min: [-0.4, 1.0, -0.4], max: [0.4, 1.7, 0.4], color: top }] : []),
];

defineUpgrade({
  id: 'zap', from: 'haybale2', kind: 'variant', cost: 70,
  name: 'Zappy Fence', blurb: 'electric fence: zaps every walking cow that brushes past. Line your maze with it',
  attack: 'aura', targeting: 'nearest', hitsAir: false, range: 3.2, interval: 0.5, damage: 10, maxHits: 6,
  muzzle: [0, 1.4, 0], shotColor: 0x8fd8ff, shotSound: 'zap', accent: 0x8fd8ff,
  parts: POSTS(0xffe14d, null),
});

defineUpgrade({
  id: 'zap2', from: 'zap', kind: 'buff', cost: 110,
  name: 'Bug Zapper Bale', blurb: 'a glowing blue cage that fries flyers too',
  hitsAir: true, range: 3.8, interval: 0.4, damage: 15, maxHits: 10, muzzle: [0, 1.7, 0], accent: 0x5ab4ff,
  parts: POSTS(0x8fd8ff, 0x5ab4ff),
});

const GOO = (soak, drip) => [
  { min: [-0.95, 0, -0.95], max: [0.95, 1.0, 0.95], color: soak },
  { min: [-0.97, 0.3, -0.97], max: [0.97, 0.38, 0.97], color: 0x5a5f6a },
  { min: [-0.97, 0.62, -0.97], max: [0.97, 0.7, 0.97], color: 0x5a5f6a },
  { min: [-0.9, 1.0, -0.9], max: [0.9, 1.12, 0.9], color: drip },
  ...[[-0.97, -0.5], [0.97, 0.3], [-0.2, 0.97], [0.5, -0.97]].map(([x, z]) => ({ min: [x - 0.12, 0.35, z - 0.12], max: [x + 0.12, 1.1, z + 0.12], color: drip })),
];

defineUpgrade({
  id: 'goo', from: 'haybale2', kind: 'variant', cost: 50,
  name: 'Molasses Bale', blurb: 'sticky sweet trap: every walking cow nearby moves at half speed',
  attack: 'aura', targeting: 'nearest', hitsAir: false, range: 3.6, interval: 0.25, slow: 0.5, slowTime: 0.5,
  muzzle: [0, 1.1, 0], accent: 0xc8742a,
  parts: GOO(0xa86a2a, 0x5a2f0e),
});

defineUpgrade({
  id: 'goo2', from: 'goo', kind: 'buff', cost: 90,
  name: 'Super-Glue Bale', blurb: 'glue fumes so strong even Flying Cows crawl',
  hitsAir: true, range: 4.6, slow: 0.35, accent: 0xf0f0e0,
  parts: GOO(0xd8d0b8, 0xf6f6ee),
});
