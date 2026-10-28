// Tower types. A tower type is plain data plus two pluggable behaviours:
//   targeting  how it picks a cow (a name from TARGETING, or a function)
//   attack     what firing does   (a name from ATTACKS, a function, or null for a wall)
// Adding a tower is one defineTower() call in this file: the game, the
// placement rules, the build bar and the renderer all read the registry.
// Pure: no three.js, no DOM. Functions get (game, tower, ...) so they can
// use the game's grid, cows, RNG and event list.

import { COW_TYPE_LIST } from './cows.js';

/**
 * Targeting strategies: (game, tower) -> cow slot or -1. Only cows within
 * [minRange, range] of the tower centre (in XZ) count.
 */
export const TARGETING = {
  /** Furthest along the path: the cow with the shortest walk left to the milk. */
  first: (game, t) => pick(game, t, (i) => -game.cowPathDistance(i)),
  nearest: (game, t) => pick(game, t, (i) => -dist2(game.cows, i, t.x, t.z)),
  strongest: (game, t) => pick(game, t, (i) => game.cows.hp[i]),
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
  const r2 = def.range * def.range, m2 = def.minRange * def.minRange;
  let best = -1, bestScore = -Infinity;
  for (let i = 0; i < cows.count; i++) {
    if (!def.hitsAir && COW_TYPE_LIST[cows.type[i]].altitude > 0) continue;
    const d2 = dist2(cows, i, t.x, t.z);
    if (d2 > r2 || d2 < m2) continue;
    const s = score(i);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

/** Attacks: (game, tower, cowSlot) -> void. Called once per shot. */
export const ATTACKS = {
  /** Instant hit on the target. Emits a 'shot' event for the tracer. */
  hitscan(game, t, i) {
    const { cows } = game;
    const x1 = cows.x[i], z1 = cows.z[i];
    const y1 = cowAimY(COW_TYPE_LIST[cows.type[i]]);
    game.events.push({ kind: 'shot', tower: t.id, x0: t.muzzleX, y0: t.muzzleY, z0: t.muzzleZ, x1, y1, z1, color: t.def.shotColor });
    game.damageCow(i, t.def.damage, t);
  },

  /**
   * Lobbed shell: aims where the cow will be after `flightTime`, lands, and
   * splashes every cow within `splashRadius`. Holds a position, never a cow
   * slot, so cows dying mid-flight can't leave a stale reference.
   */
  lob(game, t, i) {
    const { cows } = game;
    const T = t.def.flightTime;
    game.projectiles.push({
      tower: t.id, x0: t.muzzleX, y0: t.muzzleY, z0: t.muzzleZ,
      x1: cows.x[i] + cows.vx[i] * T, z1: cows.z[i] + cows.vz[i] * T,
      arc: t.def.arcHeight, t: 0, prevT: 0, T,
      damage: t.def.damage, radius: t.def.splashRadius, color: t.def.shotColor,
    });
    game.events.push({ kind: 'launch', tower: t.id, x: t.muzzleX, z: t.muzzleZ });
  },
};

/** Tower types by id, in definition order (that order is the build bar and the 1-9 hotkeys). */
export const TOWER_TYPES = {};

const REQUIRED = ['id', 'name', 'cost', 'footprint', 'height', 'parts'];

/**
 * Register a tower type. Fields:
 *   id, name, blurb       identity and build-bar text
 *   cost                  moolah to build; selling refunds SELL_REFUND of it
 *   footprint             size in grid cells (square); towers snap to the grid
 *   height                collision height in metres (the player can stand on low towers)
 *   attack, targeting     see ATTACKS / TARGETING; attack null = no shooting (a wall)
 *   range, minRange       metres, measured in XZ from the tower centre
 *   hitsAir               can target flying cows (default true; lobbed shells can't)
 *   interval              seconds between shots
 *   damage                per hit (per cow in the splash for 'lob')
 *   muzzle                [x, y, z] local point shots leave from; rotates with the aim
 *   parts                 boxes to draw: { min:[x,y,z], max:[x,y,z], color, aim?:true }
 *                         in metres, local to the footprint centre at ground level;
 *                         aim parts turn to face the target (local -Z is forward)
 *   ...plus whatever its attack reads (flightTime, splashRadius, arcHeight, shotColor)
 */
export function defineTower(def) {
  for (const k of REQUIRED) if (def[k] === undefined) throw new Error(`tower ${def.id}: missing ${k}`);
  if (TOWER_TYPES[def.id]) throw new Error(`tower ${def.id} defined twice`);
  const attack = typeof def.attack === 'string' ? ATTACKS[def.attack] : def.attack ?? null;
  const targeting = typeof def.targeting === 'string' ? TARGETING[def.targeting] : def.targeting ?? TARGETING.first;
  if (def.attack && !attack) throw new Error(`tower ${def.id}: unknown attack ${def.attack}`);
  if (!targeting) throw new Error(`tower ${def.id}: unknown targeting ${def.targeting}`);
  const t = Object.freeze({
    blurb: '', range: 0, minRange: 0, hitsAir: true, interval: 1, damage: 0, muzzle: [0, 1, 0], shotColor: 0xffffff,
    ...def, attack, targeting,
  });
  TOWER_TYPES[def.id] = t;
  return t;
}

export const SELL_REFUND = 0.7;

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
  parts: [
    { min: [-0.9, 0, -0.9], max: [0.9, 0.8, 0.9], color: 0x6f9fd8 },
    { min: [-0.6, 0.8, -0.6], max: [0.6, 1.6, 0.6], color: 0xf4f4ff },
    { min: [-0.6, 1.6, -0.6], max: [0.6, 1.75, 0.6], color: 0x3b6fc4 },
    { min: [-0.13, 1.18, -1.1], max: [0.13, 1.42, -0.2], color: 0xd04848, aim: true },
  ],
});

defineTower({
  id: 'mortar',
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
  parts: [
    { min: [-1.8, 0, -1.8], max: [1.8, 1.0, 1.8], color: 0x8a6a4a },
    { min: [-0.9, 1.0, -0.9], max: [0.9, 1.25, 0.9], color: 0x5a4632, aim: true },
    { min: [-0.45, 1.25, -0.9], max: [0.45, 1.95, 0.0], color: 0x3a3a40, aim: true },
    { min: [-0.35, 1.95, -0.8], max: [0.35, 2.05, -0.1], color: 0xffd84d, aim: true },
  ],
});

defineTower({
  id: 'haybale',
  name: 'Hay Bale',
  blurb: 'cheap wall: make the cows take the long way',
  cost: 10,
  footprint: 1,
  height: 1.0,
  attack: null,
  parts: [
    { min: [-0.95, 0, -0.95], max: [0.95, 1.0, 0.95], color: 0xe2c25a },
    { min: [-0.97, 0.3, -0.97], max: [0.97, 0.38, 0.97], color: 0xa8873a },
    { min: [-0.97, 0.62, -0.97], max: [0.97, 0.7, 0.97], color: 0xa8873a },
  ],
});
