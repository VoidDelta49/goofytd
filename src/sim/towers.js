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

import { COW_TYPE_LIST, MAX_COW_RADIUS, cowHidden } from './cows.js';

/**
 * Targeting strategies: (game, tower) -> cow slot or -1. Only cows within
 * [minRange, range × game.sight] of the tower centre (in XZ) count (sight < 1
 * in War Moo-st fog), and a camo cow only within its `camo` metres (unless the tower `seesCamo`).
 * A `friendly` cow (the Lost Calf) is never picked, though splash can still hit it.
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

/** Added to a taunting cow's score: it outranks every other cow in range. */
const TAUNT = 1e12;

function dist2(cows, i, x, z) {
  const dx = cows.x[i] - x, dz = cows.z[i] - z;
  return dx * dx + dz * dz;
}

/**
 * Highest score in range wins; ties go to the lower slot (deterministic),
 * exactly as a scan of every cow would pick. Only cows in the spatial-hash
 * cells the range covers are looked at.
 */
function pick(game, t, score) {
  const { cows, cowHash: hash } = game;
  const def = t.def;
  const range = def.range * (game.sight ?? 1);
  const r2 = range * range, m2 = def.minRange * def.minRange;
  hash.update(cows);
  const { start, slots, w } = hash;
  const x0 = hash.cx(t.x - range), x1 = hash.cx(t.x + range);
  const z0 = hash.cz(t.z - range), z1 = hash.cz(t.z + range);
  let best = -1, bestScore = -Infinity;
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      const c = cz * w + cx;
      for (let k = start[c], end = start[c + 1]; k < end; k++) {
        const i = slots[k];
        const type = COW_TYPE_LIST[cows.type[i]];
        if (type.friendly || (!def.hitsAir && type.altitude > 0)) continue;
        const d2 = dist2(cows, i, t.x, t.z);
        if (d2 > r2 || d2 < m2) continue;
        if (type.camo > 0 && !def.seesCamo && d2 > type.camo * type.camo) continue; // Ninja Cow: unseen until it's close (scopes see it)
        if ((type.burrow || type.phase) && cowHidden(type, cows.id[i], game.time)) continue; // Mole underground, Chameleon faded out
        const s = type.taunt ? score(i) + TAUNT : score(i); // Rodeo Clown: HEY, OVER HERE
        if (s > bestScore || (s === bestScore && best >= 0 && i < best)) { bestScore = s; best = i; }
      }
    }
  }
  return best;
}

/** The old full scan, kept as the reference the spatial-hash pick must match (tests). */
export function pickBruteForce(game, t, score) {
  const { cows } = game;
  const def = t.def;
  const range = def.range * (game.sight ?? 1);
  const r2 = range * range, m2 = def.minRange * def.minRange;
  let best = -1, bestScore = -Infinity;
  for (let i = 0; i < cows.count; i++) {
    const type = COW_TYPE_LIST[cows.type[i]];
    if (type.friendly || (!def.hitsAir && type.altitude > 0)) continue;
    const d2 = dist2(cows, i, t.x, t.z);
    if (d2 > r2 || d2 < m2) continue;
    if (type.camo > 0 && !def.seesCamo && d2 > type.camo * type.camo) continue;
    if ((type.burrow || type.phase) && cowHidden(type, cows.id[i], game.time)) continue;
    const s = type.taunt ? score(i) + TAUNT : score(i);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

export { pick as pickTarget };

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

/**
 * Statuses a direct hit (or an aura pulse) puts on cow k, before its damage:
 * `burn` / `chill` (also read by 'spray', which applies its own), `mark`
 * { vuln, time } (× vuln damage taken, no slow), and a stun of `stunTime` s
 * on every stunEvery-th volley (t.stunning). Never removes a cow.
 */
function applyHit(game, t, k) {
  const d = t.def;
  if (d.burn) game.igniteCow(k, d.burn.dps, d.burn.time, d.burn.spread ?? 0, t.id);
  if (d.chill) { game.chillCow(k, d.chill.vuln, d.chill.time); game.slowCow(k, d.chill.slow, d.chill.time); }
  if (d.mark) game.chillCow(k, d.mark.vuln, d.mark.time);
  if (t.stunning) game.stunCow(k, d.stunTime);
}

/**
 * Chain hit (Chocolate Thunder, Lightning Rod): the shot hits the target, then
 * jumps up to `chain.jumps` times to the nearest cow within `chain.range` of
 * the last one it hit that it hasn't hit yet, each jump doing × `falloff` of
 * the one before. Targets are all picked first, then hit highest slot first.
 */
const chainDmg = [];
function chainHit(game, t, i) {
  const { cows } = game;
  const def = t.def, c = def.chain, r2 = c.range * c.range;
  hitScratch.length = 0;
  hitScratch.push(i);
  game.events.push(shotEvent(game, t, i));
  let last = i;
  for (let j = 0; j < c.jumps; j++) {
    const lx = cows.x[last], lz = cows.z[last];
    let best = -1, bestD = Infinity;
    for (const k of game.cowHash.near(cows, lx, lz, c.range, false)) {
      if (hitScratch.includes(k)) continue;
      const type = COW_TYPE_LIST[cows.type[k]];
      if (type.friendly || (!def.hitsAir && type.altitude > 0)) continue;
      if ((type.burrow || type.phase) && cowHidden(type, cows.id[k], game.time)) continue;
      const d2 = dist2(cows, k, lx, lz);
      if (d2 <= r2 && d2 < bestD) { bestD = d2; best = k; } // ascending slots: ties keep the lower one
    }
    if (best < 0) break;
    game.events.push({
      kind: 'shot', tower: t.id, x0: lx, y0: cowAimY(COW_TYPE_LIST[cows.type[last]]), z0: lz,
      x1: cows.x[best], y1: cowAimY(COW_TYPE_LIST[cows.type[best]]), z1: cows.z[best],
      color: def.shotColor, sound: def.shotSound, quiet: true, chain: true,
    });
    hitScratch.push(best);
    last = best;
  }
  chainDmg.length = 0;
  let d = def.damage;
  for (let n = 0; n < hitScratch.length; n++) { chainDmg.push([hitScratch[n], d]); d *= c.falloff; }
  chainDmg.sort((a, b) => b[0] - a[0]);
  for (const [k] of chainDmg) applyHit(game, t, k);
  for (const [k, dmg] of chainDmg) game.damageCow(k, dmg, t);
}

/** Eight fixed directions for cluster bomblets (no trig: lockstep co-op needs bit-identical sims). */
const DIRS8 = [[1, 0], [0.7071067811865476, 0.7071067811865476], [0, 1], [-0.7071067811865476, 0.7071067811865476],
  [-1, 0], [-0.7071067811865476, -0.7071067811865476], [0, -1], [0.7071067811865476, -0.7071067811865476]];

/** Attacks: (game, tower, cowSlot) -> void. Called once per shot. */
export const ATTACKS = {
  /** Instant hit on the target. Emits a 'shot' event for the tracer. */
  hitscan(game, t, i) {
    if (t.def.chain) { chainHit(game, t, i); return; }
    game.events.push(shotEvent(game, t, i));
    applyHit(game, t, i);
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
    const fx = def.burn || def.chill || def.mark || t.stunning
      ? { burn: def.burn, chill: def.chill, mark: def.mark, stun: t.stunning ? def.stunTime : 0 } : null;
    const shell = {
      tower: t.id, x0: t.muzzleX, y0: t.muzzleY, z0: t.muzzleZ,
      x1: cows.x[i] + cows.vx[i] * T, z1: cows.z[i] + cows.vz[i] * T, y1: air ? cowAimY(type) : 0.3, air,
      arc: def.arcHeight, t: 0, prevT: 0, T,
      damage: air ? def.damage : def.damage * def.groundFactor, radius: def.splashRadius, color: def.shotColor, slick: air ? null : def.slick, fx,
    };
    game.projectiles.push(shell);
    // Cluster shells: bomblets ring the landing point, the ring turning a notch each volley.
    const c = def.cluster;
    if (c) {
      for (let n = 0; n < c.count; n++) {
        const [dx, dz] = DIRS8[(Math.floor(n * 8 / c.count) + t.volley) % 8];
        game.projectiles.push({
          ...shell, x1: shell.x1 + dx * c.spread, z1: shell.z1 + dz * c.spread, T: T * (1.08 + 0.06 * (n % 3)),
          damage: shell.damage * c.damage, radius: shell.radius * c.radius, slick: null,
        });
      }
    }
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
    const near = game.cowHash.near(cows, t.x, t.z, def.range);
    for (let n = 0; n < near.length && hitScratch.length < def.maxHits; n++) {
      const k = near[n];
      if (k === i) continue;
      if (!def.hitsAir && COW_TYPE_LIST[cows.type[k]].altitude > 0) continue;
      const dx = cows.x[k] - t.x, dz = cows.z[k] - t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2 || d2 < 1e-9) continue;
      if ((dx * fx + dz * fz) / Math.sqrt(d2) >= def.spreadCos) hitScratch.push(k);
    }
    // One loud bang, a tracer per pellet.
    hitScratch.forEach((k, n) => game.events.push(shotEvent(game, t, k, n ? { quiet: true } : null)));
    for (const k of hitScratch) applyHit(game, t, k);
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
    for (const k of game.cowHash.near(cows, t.x, t.z, def.range + MAX_COW_RADIUS())) {
      const type = COW_TYPE_LIST[cows.type[k]];
      if (!def.hitsAir && type.altitude > 0) continue;
      const r = def.range + type.radius;
      if (dist2(cows, k, t.x, t.z) > r * r) continue;
      if (def.slow < 1) game.slowCow(k, def.slow, def.slowTime);
      applyHit(game, t, k);
      if (def.damage > 0 && hitScratch.length < def.maxHits) hitScratch.push(k);
    }
    if (!hitScratch.length) return;
    hitScratch.forEach((k, n) => game.events.push(shotEvent(game, t, k, n ? { quiet: true } : null)));
    hitAll(game, t, hitScratch, def.damage);
  },

  /**
   * Spray (Milk Frother): a jet of scalding (or freezing) milk. Every cow in
   * the cone toward the target within range, up to `maxHits`, takes `damage`
   * as seeping damage (no red flash, and it soaks through Tin armour), and
   * catches the tower's `burn` { dps, time, spread } or `chill` { time, slow, vuln }.
   * One 'spray' event per squirt for the renderer and the hiss.
   */
  spray(game, t, i) {
    const { cows } = game;
    const def = t.def;
    let fx = cows.x[i] - t.x, fz = cows.z[i] - t.z;
    const len = Math.sqrt(fx * fx + fz * fz) || 1;
    fx /= len; fz /= len;
    const range = def.range * (game.sight ?? 1);
    const r2 = range * range;
    hitScratch.length = 0;
    hitScratch.push(i);
    const near = game.cowHash.near(cows, t.x, t.z, range);
    for (let n = 0; n < near.length && hitScratch.length < def.maxHits; n++) {
      const k = near[n];
      if (k === i) continue;
      if (!def.hitsAir && COW_TYPE_LIST[cows.type[k]].altitude > 0) continue;
      const dx = cows.x[k] - t.x, dz = cows.z[k] - t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2 || d2 < 1e-9) continue;
      if ((dx * fx + dz * fz) / Math.sqrt(d2) >= def.spreadCos) hitScratch.push(k);
    }
    game.events.push({
      kind: 'spray', tower: t.id, x0: t.muzzleX, y0: t.muzzleY, z0: t.muzzleZ, dx: fx, dz: fz,
      range, spreadCos: def.spreadCos, color: def.shotColor, sound: def.shotSound, hits: hitScratch.length,
    });
    // Lava Latte: every slickEvery-th squirt leaves a burning puddle under the target.
    if (def.slick && def.slickEvery > 0 && t.volley % def.slickEvery === 0) {
      const s = def.slick;
      game.zones.push({ x: cows.x[i], z: cows.z[i], radius: s.radius, t: 0, T: s.time, dps: s.dps, slow: s.slow, tower: t.id, color: def.shotColor });
    }
    hitScratch.sort((a, b) => b - a);
    for (const k of hitScratch) {
      // Status first, so the hit that lands already counts the freeze.
      applyHit(game, t, k);
      game.damageCow(k, def.damage, t, false);
    }
  },

  /**
   * Snipe: one big hitscan shot. Every `critEvery`-th shot is a headshot for
   * `critMult` × damage; a non-boss cow left under `execute` of its max HP is finished off.
   */
  snipe(game, t, i) {
    const { cows } = game;
    const def = t.def;
    t.shots = (t.shots ?? 0) + 1;
    const crit = def.critEvery > 0 && t.shots % def.critEvery === 0;
    const type = COW_TYPE_LIST[cows.type[i]];
    game.events.push(shotEvent(game, t, i, crit ? { crit: true } : null));
    applyHit(game, t, i);
    if (game.damageCow(i, def.damage * (crit ? def.critMult : 1), t)) return;
    if (def.execute > 0 && type.hp <= EXECUTE_MAX_HP && cows.hp[i] < def.execute * cows.maxHp[i]) {
      game.events.push({ kind: 'execute', x: cows.x[i], z: cows.z[i] });
      game.damageCow(i, cows.hp[i] + 1e9, t);
    }
  },

  /**
   * Pierce (railgun): an armour-piercing slug through the target and on to
   * the end of its range, hitting every cow within `beamWidth` m of the line
   * (flyers too), up to `maxHits`.
   */
  pierce(game, t, i) {
    const { cows } = game;
    const def = t.def;
    let fx = cows.x[i] - t.x, fz = cows.z[i] - t.z;
    const len = Math.sqrt(fx * fx + fz * fz) || 1;
    fx /= len; fz /= len;
    const range = def.range * (game.sight ?? 1);
    hitScratch.length = 0;
    hitScratch.push(i);
    const near = game.cowHash.near(cows, t.x, t.z, range + def.beamWidth + MAX_COW_RADIUS());
    for (let n = 0; n < near.length && hitScratch.length < def.maxHits; n++) {
      const k = near[n];
      if (k === i) continue;
      const type = COW_TYPE_LIST[cows.type[k]];
      const dx = cows.x[k] - t.x, dz = cows.z[k] - t.z;
      const along = dx * fx + dz * fz;
      if (along <= 0 || along > range) continue;
      const side = dx * -fz + dz * fx, w = def.beamWidth + type.radius;
      if (side * side <= w * w) hitScratch.push(k);
    }
    const ex = t.x + fx * range, ez = t.z + fz * range;
    game.events.push({ ...shotEvent(game, t, i), x1: ex, y1: 1.0, z1: ez, beam: true });
    hitScratch.sort((a, b) => b - a);
    for (const k of hitScratch) applyHit(game, t, k);
    for (const k of hitScratch) game.damageCow(k, def.damage, t, true, true);
  },
};

/** Executions never finish off cows tougher than this (Big Bessie, Mega Mama): bosses go down the hard way. */
export const EXECUTE_MAX_HP = 200;

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
 *   burn, chill           'spray': { dps, time, spread } sets cows on fire (spread m: a dead
 *                         burner lights its neighbours); { time, slow, vuln } freezes them
 *                         (slowed, and × vuln damage from everything)
 *   seesCamo              targets Ninja Cows at any range
 *   critEvery, critMult   'snipe': every n-th shot does critMult × damage
 *   execute               'snipe': finishes a non-boss cow left under this fraction of max HP
 *   beamWidth             'pierce': metres either side of the line the slug hits
 *   bountyMult            no attack: cows killed within `range` pay × this (best barn wins)
 *   interest, interestCap no attack: pays interest × banked moolah (≤ cap) as each wave starts
 *   chain                 'hitscan': { jumps, range, falloff } the shot jumps on to nearby cows
 *   mark                  { vuln, time }: hit cows take × vuln damage from everything (no slow)
 *   burn, chill           also work on any attack's hits (and shells, auras), not just 'spray'
 *   stunEvery, stunTime   every n-th volley stops what it hits dead for stunTime s
 *   cluster               'lob': { count, spread, damage, radius } bomblets ringing the landing point
 *   slickEvery            'spray': every n-th squirt leaves its `slick` under the target
 *   income                no attack: flat moolah paid as each wave starts
 *   boost                 { range, rate }: towers in range fire × (1 + rate) faster (best one counts)
 *   ownBounty             kills by this tower pay × this
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
    burn: null, chill: null, seesCamo: false, critEvery: 0, critMult: 1, execute: 0, beamWidth: 0,
    bountyMult: 1, interest: 0, interestCap: 0,
    chain: null, mark: null, stunEvery: 0, stunTime: 0, cluster: null, slickEvery: 0, income: 0, boost: null, ownBounty: 1,
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
  if (!def.attack && def.bountyMult > 1) {
    add('moolah', 'kills pay', def.bountyMult, `×${def.bountyMult}`);
    add('range', 'reach', def.range, `${fmt(def.range)} m`);
    if (def.interest > 0) {
      add('interest', 'interest/wave', def.interest, `${Math.round(def.interest * 100)}%`);
      add('cap', 'interest cap', def.interestCap);
    }
  } else if (!def.attack) {
    add('role', 'role', 0, 'wall');
  } else if (def.attackName === 'spray') {
    const dps = def.damage * fireRate(def);
    add('dps', 'dps/cow', dps, fmt(dps));
    add('hits', 'cows per jet', def.maxHits);
    add('range', 'range', def.range, `${fmt(def.range)} m`);
    if (def.burn) {
      add('burn', 'burn', def.burn.dps, `${def.burn.dps}/s · ${def.burn.time} s`);
      if (def.burn.spread > 0) add('spread', 'flambé spread', def.burn.spread, `${fmt(def.burn.spread)} m`);
    }
    if (def.chill) {
      add('slow', 'chill slows', 1 - def.chill.slow, `${Math.round((1 - def.chill.slow) * 100)}%`);
      add('vuln', 'frozen cows take', def.chill.vuln, `+${Math.round((def.chill.vuln - 1) * 100)}% dmg`);
    }
  } else if (def.attackName === 'aura') {
    if (def.damage > 0) {
      add('damage', 'zap', def.damage);
      add('rate', 'zaps/s', fireRate(def), fmt(fireRate(def)));
      add('hits', 'cows per zap', def.maxHits);
    }
    if (def.slow < 1) add('slow', 'slows by', 1 - def.slow, `${Math.round((1 - def.slow) * 100)}%`);
    add('range', 'reach', def.range, `${fmt(def.range)} m`);
  } else {
    // Headshots folded into the average.
    const dps = def.damage * fireRate(def) * (def.critEvery > 0 ? 1 + (def.critMult - 1) / def.critEvery : 1);
    add('dps', def.minInterval > 0 ? 'max dps' : def.attackName === 'shotgun' ? 'dps/cow' : 'dps', dps, fmt(dps));
    add('damage', def.attackName === 'shotgun' ? 'pellet' : def.attackName === 'lob' ? 'per cow' : 'damage', def.damage);
    if (def.groundFactor < 1) add('ground', 'vs walkers', def.groundFactor, `${Math.round(def.groundFactor * 100)}%`);
    add('rate', 'shots/s', fireRate(def), fmt(fireRate(def)));
    add('range', 'range', def.range, `${fmt(def.range)} m`);
    if (def.attackName === 'lob') add('splash', 'splash', def.splashRadius, `${fmt(def.splashRadius)} m`);
    if (def.attackName === 'shotgun') add('hits', 'cows per blast', def.maxHits);
    if (def.attackName === 'pierce') { add('hits', 'cows per slug', def.maxHits); add('pierce', 'armour-piercing', 1, 'yes'); }
    if (def.critEvery > 0) add('crit', 'headshot', def.critMult / def.critEvery, `×${def.critMult} every ${def.critEvery === 1 ? 'shot' : `${def.critEvery} shots`}`);
    if (def.execute > 0) add('execute', 'executes under', def.execute, `${Math.round(def.execute * 100)}% hp`);
    if (def.slick) {
      add('slick', 'puddle', def.slick.dps, `${def.slick.dps}/s · ${def.slick.time} s`);
      add('slow', 'puddle slows', 1 - def.slick.slow, `${Math.round((1 - def.slick.slow) * 100)}%`);
    }
  }
  const pct = (x) => `${Math.round(x * 100)}%`;
  if (def.attack && def.bountyMult > 1) { add('moolah', 'kills pay', def.bountyMult, `×${def.bountyMult}`); }
  if (def.chain) add('chain', 'chains to', def.chain.jumps, `${def.chain.jumps} more cows · ${pct(def.chain.falloff)} each`);
  if (def.mark) add('mark', 'marked cows take', def.mark.vuln, `+${pct(def.mark.vuln - 1)} dmg · ${def.mark.time} s`);
  if (def.stunEvery > 0) add('stun', 'stuns', def.stunTime / def.stunEvery, `${def.stunTime} s every ${def.stunEvery === 1 ? 'shot' : `${def.stunEvery} shots`}`);
  if (def.cluster) add('cluster', 'bomblets', def.cluster.count);
  if (def.attackName !== 'spray' && def.burn) {
    add('burn', 'burn', def.burn.dps, `${def.burn.dps}/s · ${def.burn.time} s`);
    if (def.burn.spread > 0) add('spread', 'flambé spread', def.burn.spread, `${fmt(def.burn.spread)} m`);
  }
  if (def.attackName !== 'spray' && def.chill) {
    add('chill', 'chill slows', 1 - def.chill.slow, pct(1 - def.chill.slow));
    add('vuln', 'frozen cows take', def.chill.vuln, `+${pct(def.chill.vuln - 1)} dmg`);
  }
  if (def.slickEvery > 0 && def.slick) add('lava', 'lava puddle', def.slick.dps, `${def.slick.dps}/s every ${def.slickEvery} squirts`);
  if (def.income > 0) add('income', 'income/wave', def.income);
  if (def.boost) add('boost', 'speeds towers', def.boost.rate, `+${pct(def.boost.rate)} in ${fmt(def.boost.range)} m`);
  if (def.ownBounty > 1) add('bounty', 'own kills pay', def.ownBounty, `×${def.ownBounty}`);
  if (def.seesCamo) add('camo', 'spots Ninjas', 1, 'yes');
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

defineUpgrade({
  id: 'haybale3', from: 'haybale2', kind: 'buff', cost: 30,
  name: 'Round Bale', blurb: 'rolled tight and wrapped in plastic: even tougher, still Kaboom-proof',
  hp: 240, accent: 0xdfe4ea,
  parts: [...BALE(0x5a5f6a), { min: [-0.97, 0.45, -0.97], max: [0.97, 0.55, 0.97], color: 0xdfe4ea }],
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
  id: 'zap', from: 'haybale3', kind: 'variant', cost: 70,
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
  id: 'goo', from: 'haybale3', kind: 'variant', cost: 50,
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

// ---- Milk Frother ----------------------------------------------------------
// A flamethrower, but it's a café steam wand: scalding milk in a short cone.
// Hot path: burns that spread when a cow drops. Cold path: soft-serve that
// freezes cows brittle, so every other tower hits them harder.

const JUG = (body, tanks) => [
  { min: [-0.9, 0, -0.9], max: [0.9, 0.5, 0.9], color: 0x6a707c },
  { min: [-0.55, 0.5, -0.55], max: [0.55, 1.45, 0.55], color: body },
  { min: [-0.5, 1.45, -0.5], max: [0.5, 1.56, 0.5], color: 0xfffaf0 },
  { min: [0.55, 0.75, -0.1], max: [0.72, 1.25, 0.1], color: 0x2c2f3a }, // handle
  ...tanks.map(([x, c]) => ({ min: [x - 0.18, 0.5, 0.55], max: [x + 0.18, 1.3, 0.9], color: c })),
];
const WAND = (len, tip, flare = 0) => [
  { min: [-0.22, 1.0, -0.4], max: [0.22, 1.36, 0.1], color: 0x50566a, aim: true },
  { min: [-0.08, 1.1, -len], max: [0.08, 1.26, -0.4], color: 0x8a8f9a, aim: true },
  { min: [-0.13 - flare, 1.06 - flare, -len - 0.12], max: [0.13 + flare, 1.3 + flare, -len], color: tip, aim: true },
];

defineTower({
  id: 'frother',
  name: 'Milk Frother',
  blurb: 'short-range jet of scalding steamed milk: hits a whole herd and sets them simmering',
  cost: 90,
  footprint: 1,
  height: 1.6,
  hp: 70,
  attack: 'spray',
  targeting: 'first',
  hitsAir: false,
  range: 7,
  interval: 0.1,
  damage: 1.6,
  maxHits: 6,
  spreadCos: 0.82,
  burn: { dps: 4, time: 2 },
  muzzle: [0, 1.18, -1.3],
  shotColor: 0xfff4e0,
  shotSound: 'hiss',
  accent: 0xffc48a,
  parts: [...JUG(0xd8dde4, []), ...WAND(1.1, 0x2c2f3a)],
});

defineUpgrade({
  id: 'frother2', from: 'frother', kind: 'buff', cost: 60,
  name: 'Steam Wand', blurb: 'more pressure, more steam, hotter milk',
  damage: 2.2, range: 7.5, burn: { dps: 6, time: 2.5 },
  parts: [...JUG(0xd8dde4, [[0, 0xd04848]]), ...WAND(1.2, 0x2c2f3a)], muzzle: [0, 1.18, -1.4],
});

defineUpgrade({
  id: 'frother3', from: 'frother2', kind: 'buff', cost: 110,
  name: 'Cappuccino Cannon', blurb: 'a twin-boiler espresso rig: wider jet, more cows',
  damage: 3.2, range: 8.5, maxHits: 8, spreadCos: 0.8, burn: { dps: 9, time: 3 },
  parts: [...JUG(0xc9a27a, [[-0.3, 0xd04848], [0.3, 0xd04848]]), ...WAND(1.35, 0x6a4024, 0.04)], muzzle: [0, 1.18, -1.55],
});

defineUpgrade({
  id: 'brulee', from: 'frother3', kind: 'variant', cost: 200,
  name: 'Crème Brûlée Torch', blurb: 'caramelises cows: big burns, and a burning cow that drops sets its neighbours alight (flambé)',
  damage: 4.2, range: 9, hitsAir: true, burn: { dps: 16, time: 4, spread: 2.5 },
  shotColor: 0xff9a3c, accent: 0xff8a3d,
  parts: [...JUG(0xe8b860, [[-0.3, 0xff6a1a], [0.3, 0xff6a1a]]), ...WAND(1.4, 0xff6a1a, 0.06)], muzzle: [0, 1.18, -1.6],
});

defineUpgrade({
  id: 'brulee2', from: 'brulee', kind: 'buff', cost: 260,
  name: 'Flambé Thrower', blurb: 'brandy in the milk: hotter, longer, and the flambé jumps further',
  damage: 5.5, range: 9.5, maxHits: 10, burn: { dps: 24, time: 4.5, spread: 3.2 },
  shotColor: 0xff7a1a, accent: 0xff6a1a,
  parts: [...JUG(0xb06a2a, [[-0.3, 0xff3a1a], [0.3, 0xff3a1a]]), ...WAND(1.5, 0xffd84d, 0.1)], muzzle: [0, 1.18, -1.7],
});

defineUpgrade({
  id: 'brulee3', from: 'brulee2', kind: 'buff', cost: 380,
  name: 'Baked Alaska Inferno', blurb: 'a meringue-crusted furnace. Whole herds go up like birthday candles',
  damage: 7.5, range: 10.5, maxHits: 12, spreadCos: 0.76, burn: { dps: 34, time: 5, spread: 4 },
  shotColor: 0xff5a1a, accent: 0xff4d2d,
  parts: [
    ...JUG(0x3a2a24, [[-0.3, 0xff3a1a], [0.3, 0xff3a1a]]),
    { min: [-0.6, 1.56, -0.6], max: [0.6, 1.8, 0.6], color: 0xfff2d8 }, // meringue
    ...WAND(1.65, 0xffd84d, 0.14),
  ],
  muzzle: [0, 1.18, -1.85],
});

defineUpgrade({
  id: 'softserve', from: 'frother3', kind: 'variant', cost: 180,
  name: 'Soft-Serve Blaster', blurb: 'freezing soft-serve: slows the herd and leaves them brittle, so every tower hits them harder',
  damage: 3.4, range: 9, hitsAir: true, burn: null, chill: { time: 1.5, slow: 0.55, vuln: 1.2 },
  shotColor: 0xd8f4ff, accent: 0x9ae0ff,
  parts: [...JUG(0xf2c8dc, [[-0.3, 0x9ae0ff], [0.3, 0x9ae0ff]]), ...WAND(1.4, 0xffffff, 0.06)], muzzle: [0, 1.18, -1.6],
});

defineUpgrade({
  id: 'softserve2', from: 'softserve', kind: 'buff', cost: 240,
  name: 'Brain Freeze', blurb: 'so cold it hurts: slower cows, and they take even more damage',
  damage: 4.4, range: 10, maxHits: 10, chill: { time: 2, slow: 0.4, vuln: 1.3 },
  shotColor: 0xbfe8ff, accent: 0x6ac8ff,
  parts: [...JUG(0xb8e4ff, [[-0.3, 0x5ab4ff], [0.3, 0x5ab4ff]]), ...WAND(1.5, 0xe0f6ff, 0.1)], muzzle: [0, 1.18, -1.7],
});

defineUpgrade({
  id: 'softserve3', from: 'softserve2', kind: 'buff', cost: 340,
  name: 'Glacier Gelato', blurb: 'an avalanche of gelato: the whole lane crawls, and shatters',
  damage: 5.6, range: 11, maxHits: 14, spreadCos: 0.76, chill: { time: 2.5, slow: 0.3, vuln: 1.4 },
  shotColor: 0xeaffff, accent: 0x5ab4ff,
  parts: [
    ...JUG(0x8fd0ff, [[-0.3, 0x3a8adf], [0.3, 0x3a8adf]]),
    { min: [-0.45, 1.56, -0.45], max: [0.45, 1.95, 0.45], color: 0xffd0e4 }, // a scoop on top
    ...WAND(1.65, 0xffffff, 0.14),
  ],
  muzzle: [0, 1.18, -1.85],
});

// ---- Hayloft Sniper --------------------------------------------------------
// A rifle up in a little hayloft on stilts: slow, huge single shots at the
// toughest cow in a very long range. Rail path: slugs through a whole line,
// through armour. Assassin path: headshots and executions.

const LOFT = (wall, roof) => [
  ...[[-0.75, -0.75], [0.75, -0.75], [-0.75, 0.75], [0.75, 0.75]].map(([x, z]) => ({ min: [x - 0.1, 0, z - 0.1], max: [x + 0.1, 2.0, z + 0.1], color: 0x6b4a2f })),
  { min: [-0.62, 0.9, -0.62], max: [0.62, 0.98, -0.56], color: 0x6b4a2f },
  { min: [-0.62, 0.9, 0.56], max: [0.62, 0.98, 0.62], color: 0x6b4a2f },
  { min: [-0.9, 2.0, -0.9], max: [0.9, 2.15, 0.9], color: 0x8a5a32 },
  { min: [-0.9, 2.15, 0.6], max: [0.9, 2.9, 0.9], color: wall },
  { min: [-0.85, 2.15, 0.1], max: [0.85, 2.45, 0.6], color: 0xe2c25a }, // hay to lie on
  { min: [-1.0, 2.9, -0.2], max: [1.0, 3.0, 1.0], color: roof },
];
const RIFLE = (len, barrel, scope, extra = []) => [
  { min: [-0.12, 2.3, -0.1], max: [0.12, 2.5, 0.45], color: 0x6a4024, aim: true },
  { min: [-0.05, 2.38, -len], max: [0.05, 2.46, -0.1], color: barrel, aim: true },
  ...(scope ? [{ min: [-0.07, 2.5, -0.55], max: [0.07, 2.63, 0.05], color: scope, aim: true }] : []),
  ...extra,
];

defineTower({
  id: 'sniper',
  name: 'Hayloft Sniper',
  blurb: 'very long range, slow, huge single shots at the toughest cow',
  cost: 110,
  footprint: 1,
  height: 3.0,
  hp: 50,
  attack: 'snipe',
  targeting: 'strongest',
  range: 38,
  interval: 2.0,
  damage: 70,
  muzzle: [0, 2.42, -1.5],
  shotColor: 0xfff8d0,
  shotSound: 'crack',
  accent: 0xd8c08a,
  parts: [...LOFT(0xb0302a, 0x5a2a20), ...RIFLE(1.5, 0x2c2f3a, null)],
});

defineUpgrade({
  id: 'sniper2', from: 'sniper', kind: 'buff', cost: 80,
  name: 'Scoped Sniper', blurb: 'a proper scope: hits harder, reaches further and spots Ninja Cows at any range',
  damage: 100, range: 42, seesCamo: true,
  parts: [...LOFT(0xb0302a, 0x5a2a20), ...RIFLE(1.6, 0x2c2f3a, 0x111111)], muzzle: [0, 2.42, -1.6],
});

defineUpgrade({
  id: 'sniper3', from: 'sniper2', kind: 'buff', cost: 150,
  name: 'Long Moo-ser', blurb: 'a longer barrel and a bigger bullet',
  damage: 160, interval: 1.8, range: 46,
  parts: [...LOFT(0x8a2420, 0x2c2f3a), ...RIFLE(1.9, 0x2c2f3a, 0x111111, [{ min: [-0.09, 2.36, -1.95], max: [0.09, 2.48, -1.82], color: 0x50566a, aim: true }])],
  muzzle: [0, 2.42, -1.95],
});

const RAIL = (len, coil) => RIFLE(len, 0x50566a, 0x111111, [
  ...[0.5, 0.9, 1.3, 1.7].filter((z) => z < len).map((z) => ({ min: [-0.11, 2.32, -z - 0.08], max: [0.11, 2.52, -z], color: coil, aim: true })),
  { min: [-0.16, 2.28, 0.0], max: [0.16, 2.56, 0.3], color: 0xffd84d, aim: true }, // cheese battery
]);

defineUpgrade({
  id: 'rail', from: 'sniper3', kind: 'variant', cost: 240,
  name: 'Cheddar Railgun', blurb: 'a magnet-fired cheese slug that punches through every cow in a line, armour and all',
  attack: 'pierce', damage: 130, interval: 2.2, range: 50, maxHits: 8, beamWidth: 0.6,
  shotColor: 0xffd84d, accent: 0xffc933,
  parts: [...LOFT(0x8a2420, 0x2c2f3a), ...RAIL(1.9, 0x8fd8ff)], muzzle: [0, 2.42, -1.95],
});

defineUpgrade({
  id: 'rail2', from: 'rail', kind: 'buff', cost: 330,
  name: 'Gouda Gauss Gun', blurb: 'bigger coils, a fatter slug, a wider hole',
  damage: 180, interval: 2.0, maxHits: 12, beamWidth: 0.8,
  shotColor: 0xffb347, accent: 0xff9a1f,
  parts: [...LOFT(0x2c2f3a, 0x2c2f3a), ...RAIL(2.1, 0x5ab4ff)], muzzle: [0, 2.42, -2.15],
});

defineUpgrade({
  id: 'rail3', from: 'rail2', kind: 'buff', cost: 480,
  name: 'Moo-ss Driver', blurb: 'a whole wheel of parmesan at a fraction of light speed',
  damage: 250, interval: 1.8, range: 55, maxHits: 18, beamWidth: 1.0,
  shotColor: 0xfff2b0, accent: 0xffe14d,
  parts: [...LOFT(0x2c2f3a, 0xffd84d), ...RAIL(2.4, 0xffffff)], muzzle: [0, 2.42, -2.45],
});

defineUpgrade({
  id: 'assassin', from: 'sniper3', kind: 'variant', cost: 230,
  name: 'Udder Assassin', blurb: 'faster, quieter, and every third shot is a headshot for triple damage',
  damage: 190, interval: 1.5, critEvery: 3, critMult: 3,
  shotColor: 0xff5a7a, accent: 0xb06aff,
  parts: [...LOFT(0x2c2f3a, 0x1d1d24), ...RIFLE(1.9, 0x1d1d24, 0xb06aff)], muzzle: [0, 2.42, -1.95],
});

defineUpgrade({
  id: 'assassin2', from: 'assassin', kind: 'buff', cost: 320,
  name: 'Silent Moo-n', blurb: 'headshots every other shot, and wounded cows (not bosses) under 20% get finished off',
  damage: 240, interval: 1.3, critEvery: 2, critMult: 3, execute: 0.2,
  shotColor: 0xd06aff, accent: 0x9a4dff,
  parts: [...LOFT(0x1d1d24, 0x1d1d24), ...RIFLE(2.0, 0x1d1d24, 0xd06aff, [{ min: [-0.1, 2.36, -2.25], max: [0.1, 2.48, -2.0], color: 0x111111, aim: true }])],
  muzzle: [0, 2.42, -2.25],
});

defineUpgrade({
  id: 'assassin3', from: 'assassin2', kind: 'buff', cost: 460,
  name: 'The Moo-fessional', blurb: 'never misses, never moos: bigger headshots, executes under 30%',
  damage: 300, interval: 1.1, critEvery: 2, critMult: 3.5, execute: 0.3,
  shotColor: 0xff3a6a, accent: 0xff3a6a,
  parts: [...LOFT(0x111111, 0xd04848), ...RIFLE(2.1, 0x111111, 0xff3a6a, [{ min: [-0.1, 2.36, -2.35], max: [0.1, 2.48, -2.1], color: 0x111111, aim: true }])],
  muzzle: [0, 2.42, -2.35],
});

// ---- Auction Barn ----------------------------------------------------------
// The moolah multiplier: cows defeated within its reach get auctioned off for
// more (the best barn in reach counts, they don't stack). Bull Market path:
// a bigger multiplier. Cheese Vault path: also pays interest on banked moolah
// at the start of every wave, so saving up pays.

const BARN = (wall, roof, extra = []) => [
  { min: [-1.7, 0, -1.4], max: [1.7, 1.8, 1.4], color: wall },
  { min: [-1.72, 1.7, -1.42], max: [1.72, 1.8, 1.42], color: 0xf4f4ff },
  { min: [-1.85, 1.8, -1.55], max: [1.85, 2.4, 1.55], color: roof },
  { min: [-0.6, 0, -1.43], max: [0.6, 1.3, -1.4], color: 0xf4f4ff }, // doors
  { min: [-0.05, 0, -1.45], max: [0.05, 1.3, -1.42], color: wall },
  { min: [-0.9, 1.85, -1.62], max: [0.9, 2.3, -1.56], color: 0xffd84d }, // AUCTION sign
  ...extra,
];

defineTower({
  id: 'barn',
  name: 'Auction Barn',
  blurb: 'no gun: cows that drop within its reach sell for 25% more moolah',
  cost: 120,
  footprint: 2,
  height: 2.4,
  hp: 120,
  attack: null,
  range: 10,
  bountyMult: 1.25,
  accent: 0xffd84d,
  parts: BARN(0xb0302a, 0x4a4a52),
});

defineUpgrade({
  id: 'barn2', from: 'barn', kind: 'buff', cost: 100,
  name: 'Livestock Exchange', blurb: 'a louder auctioneer: ×1.4 moolah, wider reach',
  bountyMult: 1.4, range: 12,
  parts: BARN(0xb0302a, 0x4a4a52, [{ min: [1.7, 0, -0.6], max: [1.95, 1.2, 0.6], color: 0x6b4a2f }]),
});

defineUpgrade({
  id: 'barn3', from: 'barn2', kind: 'buff', cost: 160,
  name: 'Stock Moo-ket', blurb: 'a trading floor full of yelling cowboys: ×1.55 moolah',
  bountyMult: 1.55, range: 14,
  parts: BARN(0x9a2420, 0x2c2f3a, [
    { min: [1.7, 0, -0.6], max: [1.95, 1.2, 0.6], color: 0x6b4a2f },
    { min: [-1.2, 2.4, -0.2], max: [1.2, 2.7, 0.2], color: 0x3a8adf }, // ticker board
  ]),
});

defineUpgrade({
  id: 'bullmarket', from: 'barn3', kind: 'variant', cost: 300,
  name: 'Bull Market', blurb: 'prices only go up: ×1.9 moolah for every cow in reach',
  bountyMult: 1.9, range: 15, accent: 0x5ad86a,
  parts: BARN(0x2a7a3a, 0x2c2f3a, [
    { min: [-0.25, 2.4, -0.5], max: [0.25, 2.9, 0.5], color: 0xc9a227 }, // golden bull
    { min: [-0.3, 2.9, -0.6], max: [0.3, 3.05, -0.4], color: 0xc9a227 },
  ]),
});

defineUpgrade({
  id: 'bullmarket2', from: 'bullmarket', kind: 'buff', cost: 420,
  name: 'Wall Street Bull', blurb: 'irrational exuberance: ×2.25 moolah, further reach',
  bountyMult: 2.25, range: 16, accent: 0x3ac85a,
  parts: BARN(0x1d5a2a, 0x111111, [
    { min: [-0.35, 2.4, -0.7], max: [0.35, 3.1, 0.7], color: 0xffc933 },
    { min: [-0.45, 3.1, -0.85], max: [0.45, 3.25, -0.6], color: 0xffc933 },
  ]),
});

defineUpgrade({
  id: 'bullmarket3', from: 'bullmarket2', kind: 'buff', cost: 600,
  name: 'Golden Udder Exchange', blurb: 'the cows practically pay to be beaten: ×2.75 moolah',
  bountyMult: 2.75, range: 18, accent: 0xffc933,
  parts: BARN(0xffc933, 0xffffff, [
    { min: [-0.45, 2.4, -0.8], max: [0.45, 3.3, 0.8], color: 0xffd84d },
    { min: [-0.55, 3.3, -1.0], max: [0.55, 3.45, -0.7], color: 0xffd84d },
  ]),
});

const VAULT = (wall, door, wheel) => BARN(wall, 0x2c2f3a, [
  { min: [-0.75, 0.15, -1.48], max: [0.75, 1.45, -1.42], color: door }, // round-ish vault door
  { min: [-0.2, 0.6, -1.52], max: [0.2, 1.0, -1.48], color: wheel },
  { min: [-0.6, 2.4, -0.4], max: [0.6, 2.75, 0.4], color: 0xffd84d }, // a cheese wheel on the roof
]);

defineUpgrade({
  id: 'vault', from: 'barn3', kind: 'variant', cost: 250,
  name: 'Cheese Vault', blurb: 'aged cheese is money in the bank: pays 5% interest on your moolah (up to 40) every wave',
  bountyMult: 1.55, range: 14, interest: 0.05, interestCap: 40, accent: 0xffe14d,
  parts: VAULT(0x8a8f9a, 0x6a707c, 0xffd84d),
});

defineUpgrade({
  id: 'vault2', from: 'vault', kind: 'buff', cost: 350,
  name: 'Aged Cheddar Vault', blurb: 'older cheese, better rates: 8% interest (up to 80) and ×1.6 moolah',
  bountyMult: 1.6, interest: 0.08, interestCap: 80, accent: 0xffc933,
  parts: VAULT(0x6a707c, 0x50566a, 0xffc933),
});

defineUpgrade({
  id: 'vault3', from: 'vault2', kind: 'buff', cost: 500,
  name: 'Big Cheese Reserve', blurb: 'the central bank of cheese: 10% interest (up to 150) and ×1.65 moolah',
  bountyMult: 1.65, range: 15, interest: 0.1, interestCap: 150, accent: 0xffb000,
  parts: VAULT(0x3a3f50, 0xc9a227, 0xffffff),
});

// ---- Late game: Lv6 to Lv10 ----------------------------------------------
// Every variant runs to Lv6, then forks again at Lv7 into two sub-variants,
// each with three more buff levels to Lv10 (TDK-style "pick, pick again").
// Lv8–10 add bronze, silver and gold corner studs; a Lv7 fork flies its flag.

const STUDS = [0xcd7f32, 0xdfe4ea, 0xffd84d];
/** Lv8+ trim: four studs at the footprint corners, one ring further in per level. */
function studs(fp, n) {
  const h = fp - 0.14 - 0.22 * n, top = 0.3 + 0.12 * n;
  return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => ({ min: [sx * h - 0.09, 0, sz * h - 0.09], max: [sx * h + 0.09, top, sz * h + 0.09], color: STUDS[n] }));
}
/** Lv7 fork: a pennant on a pole at the back-left corner. */
function flag(fp, color, h = 2.6) {
  const x = -fp + 0.15, z = fp - 0.15;
  return [
    { min: [x - 0.05, 0, z - 0.05], max: [x + 0.05, h, z + 0.05], color: 0x6b4a2f },
    { min: [x + 0.05, h - 0.5, z - 0.02], max: [x + 0.65, h - 0.1, z + 0.02], color },
  ];
}
/**
 * A line of upgrades from `from`: the first step may be a 'variant' (a fork),
 * the rest are buffs; steps marked `studs` get the next stud ring.
 */
function path(from, steps) {
  let prev = from, n = 0;
  for (const s of steps) {
    const { studs: stud, flag: fl, ...rest } = s;
    const fp = TOWER_FORMS[prev].footprint;
    const add = [...(rest.addParts ?? []), ...(fl ? flag(fp, fl) : []), ...(stud ? studs(fp, n++) : [])];
    defineUpgrade({ kind: 'buff', from: prev, ...rest, ...(add.length ? { addParts: add } : {}) });
    prev = s.id;
  }
}

// Squirter · Moo-chine Gun
path('gatling2', [{ id: 'gatling3', cost: 420, name: 'Bovine Buzzsaw', blurb: 'barrels spin so fast they hum the national anthem', damage: 11, minInterval: 0.028, range: 17, accent: 0xff3a3a }]);
path('gatling3', [
  { id: 'chocogat', kind: 'variant', cost: 600, flag: 0x6a3a1a, name: 'Chocolate Thunder', blurb: 'chocolate milk arcs from cow to cow: each shot jumps to 2 more', damage: 12, chain: { jumps: 2, range: 5, falloff: 0.6 }, shotColor: 0x8a5a32, accent: 0x8a5a32 },
  { id: 'chocogat2', cost: 750, studs: true, name: 'Double Fudge Thunder', blurb: 'thicker fudge, one more jump', damage: 14, chain: { jumps: 3, range: 5, falloff: 0.6 } },
  { id: 'chocogat3', cost: 950, studs: true, name: 'Hot Fudge Hurricane', blurb: 'the fudge jumps further and loses less on the way', damage: 16, chain: { jumps: 3, range: 6, falloff: 0.65 } },
  { id: 'chocogat4', cost: 1300, studs: true, name: 'Death by Chocolate', blurb: 'four jumps of molten cocoa. The herd never stood a chance', damage: 19, minInterval: 0.025, chain: { jumps: 4, range: 6.5, falloff: 0.7 }, accent: 0x5a2a10 },
]);
path('gatling3', [
  { id: 'strawgat', kind: 'variant', cost: 580, flag: 0xff8ab4, name: 'Strawberry Shredder', blurb: 'pink milk marks every cow it hits: marked cows take +15% from everything', damage: 13, mark: { vuln: 1.15, time: 2 }, shotColor: 0xff8ab4, accent: 0xff8ab4 },
  { id: 'strawgat2', cost: 720, studs: true, name: 'Strawberry Swirl Shredder', blurb: 'stickier pink: +20% marks', damage: 15, mark: { vuln: 1.2, time: 2 } },
  { id: 'strawgat3', cost: 920, studs: true, name: 'Berry Blaster 9000', blurb: 'over nine thousand berries per minute', damage: 17, range: 18, mark: { vuln: 1.25, time: 2.5 } },
  { id: 'strawgat4', cost: 1250, studs: true, name: 'Neapolitan Nightmare', blurb: 'three flavours of doom: +30% marks, faster spin', damage: 20, minInterval: 0.025, mark: { vuln: 1.3, time: 2.5 }, accent: 0xff5a9a },
]);

// Squirter · Moo-shotgun
path('shotgun2', [{ id: 'shotgun3', cost: 380, name: 'Cream Cannonade', blurb: 'heavy cream pellets: more of them, harder', damage: 44, interval: 0.46, range: 12.5, maxHits: 14 }]);
path('shotgun3', [
  { id: 'buckshot', kind: 'variant', cost: 520, flag: 0xf4f4e0, name: 'Cottage Cheese Buckshot', blurb: 'lumpy curds: every 3rd blast curdles the herd solid for 0.6 s', damage: 46, stunEvery: 3, stunTime: 0.6, shotColor: 0xf4f4e0, accent: 0xe8e8c8 },
  { id: 'buckshot2', cost: 680, studs: true, name: 'Extra Lumpy Buckshot', blurb: 'lumpier, longer curdles, more cows', damage: 52, stunTime: 0.7, maxHits: 16 },
  { id: 'buckshot3', cost: 880, studs: true, name: 'Curdle Cannon', blurb: 'every other blast curdles', damage: 60, stunEvery: 2, stunTime: 0.7 },
  { id: 'buckshot4', cost: 1200, studs: true, name: 'The Big Curdle', blurb: 'a wall of cottage cheese: 20 cows frozen in their tracks', damage: 70, stunTime: 0.9, maxHits: 20, spreadCos: 0.66 },
]);
path('shotgun3', [
  { id: 'eggnog', kind: 'variant', cost: 540, flag: 0xffe6a0, name: 'Eggnog Blunderbuss', blurb: 'flaming eggnog pellets set the whole cone alight', damage: 42, burn: { dps: 10, time: 3 }, shotColor: 0xffd890, accent: 0xffc860 },
  { id: 'eggnog2', cost: 700, studs: true, name: 'Spiked Eggnog', blurb: 'something extra in the nog: hotter burns', damage: 48, burn: { dps: 14, time: 3.5 } },
  { id: 'eggnog3', cost: 900, studs: true, name: 'Yule Log Launcher', blurb: 'burning cows that drop light up their friends', damage: 54, burn: { dps: 18, time: 4, spread: 2 } },
  { id: 'eggnog4', cost: 1250, studs: true, name: 'Krampus Nog', blurb: 'naughty list only: huge burns that leap between cows', damage: 62, maxHits: 18, burn: { dps: 26, time: 4.5, spread: 3 }, accent: 0xd04848 },
]);

// Butter Mortar · Butter Slick Lobber
path('slick2', [{ id: 'slick3', cost: 400, name: 'Ghee Geyser', blurb: 'clarified butter: hotter, wider, longer slicks', damage: 70, interval: 1.7, range: 34, slick: { radius: 3.8, time: 4.5, dps: 11, slow: 0.45 } }]);
path('slick3', [
  { id: 'cluster', kind: 'variant', cost: 560, flag: 0xfff2a0, name: 'Butter Pat Cluster', blurb: 'each shell bursts into 4 butter pats that splat around it', damage: 72, cluster: { count: 4, spread: 3.2, damage: 0.5, radius: 0.6 }, accent: 0xfff2a0 },
  { id: 'cluster2', cost: 720, studs: true, name: 'Pat-a-Pat Barrage', blurb: 'five pats per shell', damage: 80, cluster: { count: 5, spread: 3.2, damage: 0.5, radius: 0.6 } },
  { id: 'cluster3', cost: 920, studs: true, name: 'Carpet Buttering', blurb: 'six pats, spread wider, fired faster', damage: 90, interval: 1.6, cluster: { count: 6, spread: 3.6, damage: 0.5, radius: 0.6 } },
  { id: 'cluster4', cost: 1300, studs: true, name: 'Butterpocalypse', blurb: 'eight pats. There is no toast big enough', damage: 105, interval: 1.5, cluster: { count: 8, spread: 4, damage: 0.6, radius: 0.6 }, accent: 0xffd84d },
]);
path('slick3', [
  { id: 'yogurt', kind: 'variant', cost: 540, flag: 0xd8f4ff, name: 'Frozen Yogurt Lobber', blurb: 'fro-yo shells: no puddle, but every cow splashed is slowed and brittle (+20% dmg)', damage: 64, splashRadius: 4.6, slick: null, chill: { time: 2, slow: 0.5, vuln: 1.2 }, shotColor: 0xe8f8ff, accent: 0x9ae0ff },
  { id: 'yogurt2', cost: 700, studs: true, name: 'Fro-Yo Flurry', blurb: 'colder and faster', damage: 72, interval: 1.6, chill: { time: 2.5, slow: 0.45, vuln: 1.25 } },
  { id: 'yogurt3', cost: 900, studs: true, name: 'Greek Glacier', blurb: 'thick, tangy and very cold', damage: 82, splashRadius: 5, chill: { time: 3, slow: 0.4, vuln: 1.3 } },
  { id: 'yogurt4', cost: 1250, studs: true, name: 'Absolute Zero Yogurt', blurb: '−273 °C with sprinkles', damage: 95, interval: 1.4, splashRadius: 5.5, chill: { time: 3.5, slow: 0.3, vuln: 1.4 }, accent: 0x5ab4ff },
]);

// Butter Mortar · Popcorn Flak
path('flak2', [{ id: 'flak3', cost: 380, name: 'Caramel Corn Barrage', blurb: 'sticky caramel airbursts, faster', damage: 72, interval: 0.36, splashRadius: 3.6, range: 29 }]);
path('flak3', [
  { id: 'jiffy', kind: 'variant', cost: 540, flag: 0xc0c8d0, name: 'Jiffy Pop Cluster', blurb: 'each burst pops 3 more kernels around it', damage: 76, cluster: { count: 3, spread: 2.5, damage: 0.5, radius: 0.7 }, accent: 0xc0c8d0 },
  { id: 'jiffy2', cost: 700, studs: true, name: 'Family Size Jiffy', blurb: 'four extra kernels', damage: 84, cluster: { count: 4, spread: 2.5, damage: 0.5, radius: 0.7 } },
  { id: 'jiffy3', cost: 900, studs: true, name: 'Popping Frenzy', blurb: 'five kernels, faster', damage: 94, interval: 0.33, cluster: { count: 5, spread: 2.8, damage: 0.5, radius: 0.7 } },
  { id: 'jiffy4', cost: 1250, studs: true, name: 'Kernel Panic', blurb: 'the sky is 40% popcorn now', damage: 108, interval: 0.3, cluster: { count: 6, spread: 3, damage: 0.55, radius: 0.7 } },
]);
path('flak3', [
  { id: 'xbutter', kind: 'variant', cost: 520, flag: 0xffe14d, name: 'Extra Butter Flak', blurb: 'buttery bursts mark cows: +20% damage from everything, and walkers take more', damage: 78, groundFactor: 0.7, mark: { vuln: 1.2, time: 2.5 }, shotColor: 0xffe680, accent: 0xffe14d },
  { id: 'xbutter2', cost: 680, studs: true, name: 'Movie Theatre Butter', blurb: 'the good stuff from the pump', damage: 86, mark: { vuln: 1.25, time: 2.5 } },
  { id: 'xbutter3', cost: 880, studs: true, name: 'IMAX Butter', blurb: 'bigger bursts, longer reach', damage: 96, splashRadius: 4.2, range: 31, mark: { vuln: 1.3, time: 2.5 } },
  { id: 'xbutter4', cost: 1200, studs: true, name: "Director's Cut", blurb: 'three hours of butter, no intermission', damage: 110, interval: 0.32, groundFactor: 0.8, mark: { vuln: 1.35, time: 3 } },
]);

// Hay Bale · Zappy Fence
path('zap2', [{ id: 'zap3', cost: 160, name: 'Tesla Bale', blurb: 'coils in the hay: bigger, faster zaps', damage: 20, range: 4.2, maxHits: 12, interval: 0.36 }]);
path('zap3', [
  { id: 'static', kind: 'variant', cost: 240, flag: 0xfff4a0, name: 'Static Cling Bale', blurb: 'every 4th pulse sticks cows to the fence for 0.5 s', damage: 22, stunEvery: 4, stunTime: 0.5, accent: 0xfff4a0 },
  { id: 'static2', cost: 320, studs: true, name: 'Sock-Drawer Static', blurb: 'longer clings, harder zaps', damage: 26, stunTime: 0.6 },
  { id: 'static3', cost: 420, studs: true, name: 'Wool Sweater Bale', blurb: 'every 3rd pulse clings', damage: 30, range: 4.6, stunEvery: 3 },
  { id: 'static4', cost: 580, studs: true, name: 'Ball Lightning Bale', blurb: 'a crackling sphere of hay and hate', damage: 36, range: 5, maxHits: 16, stunTime: 0.8 },
]);
path('zap3', [
  { id: 'rod', kind: 'variant', cost: 260, flag: 0x8fd8ff, name: 'Lightning Rod', blurb: 'a bolt at the lead cow that forks to 4 more', attack: 'hitscan', targeting: 'first', range: 9, interval: 0.6, damage: 30, chain: { jumps: 4, range: 4.5, falloff: 0.8 }, muzzle: [0, 3.0, 0],
    addParts: [{ min: [-0.06, 1.0, -0.06], max: [0.06, 3.0, 0.06], color: 0xb9c0cc }], accent: 0x8fd8ff },
  { id: 'rod2', cost: 340, studs: true, name: 'Forked Lightning Rod', blurb: 'five forks', damage: 36, chain: { jumps: 5, range: 4.5, falloff: 0.8 } },
  { id: 'rod3', cost: 450, studs: true, name: 'Storm Chaser Bale', blurb: 'six forks, longer reach', damage: 44, range: 10, chain: { jumps: 6, range: 4.5, falloff: 0.8 } },
  { id: 'rod4', cost: 620, studs: true, name: "Zeus's Hay Fork", blurb: 'eight forks from the heavens', damage: 54, range: 11, interval: 0.5, chain: { jumps: 8, range: 5, falloff: 0.85 }, accent: 0xffe14d },
]);

// Hay Bale · Molasses Bale
path('goo2', [{ id: 'goo3', cost: 140, name: 'Maple Mire', blurb: 'Canadian-grade stickiness, wider', range: 5, slow: 0.32 }]);
path('goo3', [
  { id: 'tar', kind: 'variant', cost: 220, flag: 0x2c2f3a, name: 'Hot Tar Bale', blurb: 'bubbling tar: slows less, but burns every cow stuck in it', slow: 0.4, range: 4.6, burn: { dps: 6, time: 1 }, accent: 0x50566a },
  { id: 'tar2', cost: 300, studs: true, name: 'Boiling Tar Bale', blurb: 'hotter tar', burn: { dps: 9, time: 1 } },
  { id: 'tar3', cost: 400, studs: true, name: 'Asphalt Bale', blurb: 'road works, cows lose', range: 5, burn: { dps: 12, time: 1 } },
  { id: 'tar4', cost: 560, studs: true, name: 'La Brea Bale', blurb: 'where mammoths went to die. Cows too', range: 5.4, slow: 0.35, burn: { dps: 16, time: 1.2 } },
]);
path('goo3', [
  { id: 'scarecrow', kind: 'variant', cost: 260, flag: 0xd04848, name: 'Scarecrow Bale', blurb: 'still sticky, and towers within 7 m fire 15% faster (it scares them into working)', slow: 0.5, range: 3.6, boost: { range: 7, rate: 0.15 },
    addParts: [{ min: [-0.08, 1.0, -0.08], max: [0.08, 2.4, 0.08], color: 0x6b4a2f }, { min: [-0.7, 1.9, -0.06], max: [0.7, 2.0, 0.06], color: 0x6b4a2f }, { min: [-0.22, 2.4, -0.22], max: [0.22, 2.8, 0.22], color: 0xe2c25a }, { min: [-0.3, 2.8, -0.3], max: [0.3, 2.9, 0.3], color: 0x8a5a32 }], accent: 0xd04848 },
  { id: 'scarecrow2', cost: 340, studs: true, name: 'Spooky Scarecrow', blurb: '+20% fire rate nearby', boost: { range: 7, rate: 0.2 } },
  { id: 'scarecrow3', cost: 440, studs: true, name: 'Haunted Scarecrow', blurb: '+25% fire rate, wider', boost: { range: 8, rate: 0.25 } },
  { id: 'scarecrow4', cost: 600, studs: true, name: 'Scarecrow Supreme', blurb: 'the crows salute it: +30% fire rate in 9 m', boost: { range: 9, rate: 0.3 } },
]);

// Milk Frother · Crème Brûlée Torch (already at Lv6)
path('brulee3', [
  { id: 'chili', kind: 'variant', cost: 520, flag: 0xff3a1a, name: 'Ghost Pepper Latte', blurb: 'scalding chili milk: enormous burns that leap 4.5 m', damage: 8.5, range: 10, burn: { dps: 50, time: 5, spread: 4.5 }, shotColor: 0xff4a1a, accent: 0xff3a1a },
  { id: 'chili2', cost: 680, studs: true, name: 'Carolina Reaper Roast', blurb: 'hotter. Much hotter', burn: { dps: 62, time: 5, spread: 4.5 } },
  { id: 'chili3', cost: 880, studs: true, name: "Dragon's Breath Mocha", blurb: 'longer reach, wider leaps', range: 11, burn: { dps: 76, time: 5, spread: 5 } },
  { id: 'chili4', cost: 1200, studs: true, name: 'Sun Surface Espresso', blurb: '5,500 °C, extra foam', damage: 11, maxHits: 14, burn: { dps: 95, time: 6, spread: 5.5 } },
]);
path('brulee3', [
  { id: 'volcano', kind: 'variant', cost: 540, flag: 0xff8a1a, name: 'Lava Latte', blurb: 'every 8th squirt leaves a puddle of molten latte under the lead cow', damage: 8, slick: { radius: 3, time: 3, dps: 20, slow: 0.7 }, slickEvery: 8, shotColor: 0xff8a1a, accent: 0xff8a1a },
  { id: 'volcano2', cost: 700, studs: true, name: 'Magma Macchiato', blurb: 'bigger, hotter puddles', slick: { radius: 3.3, time: 3, dps: 26, slow: 0.7 } },
  { id: 'volcano3', cost: 900, studs: true, name: 'Pyroclastic Frappé', blurb: 'a puddle every 6th squirt', slick: { radius: 3.6, time: 3, dps: 32, slow: 0.65 }, slickEvery: 6 },
  { id: 'volcano4', cost: 1250, studs: true, name: 'Mount Vesu-moo-ius', blurb: 'the lane is now the floor is lava', slick: { radius: 4, time: 4, dps: 42, slow: 0.6 }, slickEvery: 5 },
]);

// Milk Frother · Soft-Serve Blaster (already at Lv6)
path('softserve3', [
  { id: 'shake', kind: 'variant', cost: 500, flag: 0xffd0e4, name: 'Thick Shake Cannon', blurb: 'so thick cows get stuck: every 12th squirt freezes them solid for 0.8 s', damage: 6.4, stunEvery: 12, stunTime: 0.8, accent: 0xffb0d0 },
  { id: 'shake2', cost: 660, studs: true, name: 'Double Thick Shake', blurb: 'longer freezes', damage: 7.2, stunTime: 0.9 },
  { id: 'shake3', cost: 860, studs: true, name: 'Concrete Shake', blurb: 'turn it upside down, it stays in: freezes every 10th squirt', damage: 8.2, stunEvery: 10 },
  { id: 'shake4', cost: 1150, studs: true, name: 'Brain Freeze Supreme', blurb: 'the whole herd gets an ice-cream headache', damage: 9.5, stunEvery: 8, stunTime: 1 },
]);
path('softserve3', [
  { id: 'sundae', kind: 'variant', cost: 480, flag: 0xff5a7a, name: 'Sprinkle Sundae Sprayer', blurb: 'sprinkles make cows extra brittle (+55% dmg) but slow them less, over a longer reach', damage: 5, range: 12, maxHits: 16, chill: { time: 3, slow: 0.5, vuln: 1.55 }, accent: 0xff5a7a },
  { id: 'sundae2', cost: 640, studs: true, name: 'Hot Fudge Sundae', blurb: '+60% brittle', chill: { time: 3, slow: 0.5, vuln: 1.6 } },
  { id: 'sundae3', cost: 840, studs: true, name: 'Kitchen Sink Sundae', blurb: 'everything on it, more cows', range: 13, maxHits: 18, chill: { time: 3, slow: 0.5, vuln: 1.65 } },
  { id: 'sundae4', cost: 1100, studs: true, name: 'Banana Split Supreme', blurb: '+75% brittle, 22 cows per jet', maxHits: 22, chill: { time: 3.5, slow: 0.5, vuln: 1.75 } },
]);

// Hayloft Sniper · Cheddar Railgun (already at Lv6)
path('rail3', [
  { id: 'plasma', kind: 'variant', cost: 650, flag: 0xff6a1a, name: 'Plasma Parmesan', blurb: 'white-hot cheese slugs set every cow in the line on fire', damage: 280, burn: { dps: 30, time: 3 }, shotColor: 0xffa040, accent: 0xff6a1a },
  { id: 'plasma2', cost: 820, studs: true, name: 'Molten Mozzarella', blurb: 'stretchier, hotter', damage: 320, burn: { dps: 40, time: 3 } },
  { id: 'plasma3', cost: 1050, studs: true, name: 'Raclette Ray', blurb: 'faster shots, bigger burns', damage: 370, interval: 1.7, burn: { dps: 52, time: 3 } },
  { id: 'plasma4', cost: 1450, studs: true, name: 'Fondue Death Ray', blurb: 'dip the whole herd', damage: 430, beamWidth: 1.2, burn: { dps: 70, time: 4 } },
]);
path('rail3', [
  { id: 'grated', kind: 'variant', cost: 620, flag: 0xfff2b0, name: 'Grated Parmesan Rail', blurb: 'a wide spray of grated cheese: marks the whole line (+20% dmg from everything)', damage: 260, beamWidth: 1.4, mark: { vuln: 1.2, time: 3 }, accent: 0xfff2b0 },
  { id: 'grated2', cost: 800, studs: true, name: 'Finely Grated Rail', blurb: 'wider, stickier', damage: 300, beamWidth: 1.6, mark: { vuln: 1.25, time: 3 } },
  { id: 'grated3', cost: 1000, studs: true, name: 'Microplane Cannon', blurb: '24 cows per slug', damage: 340, maxHits: 24, mark: { vuln: 1.3, time: 3 } },
  { id: 'grated4', cost: 1400, studs: true, name: 'Cheese Grater of the Gods', blurb: 'a 4 m wide blizzard of parmesan', damage: 400, beamWidth: 2, mark: { vuln: 1.35, time: 4 } },
]);

// Hayloft Sniper · Udder Assassin (already at Lv6)
path('assassin3', [
  { id: 'tranq', kind: 'variant', cost: 600, flag: 0x9ae0ff, name: 'Tranquilizer Moo-ser', blurb: 'every dart puts its cow to sleep for 1.2 s (bosses barely notice)', damage: 320, stunEvery: 1, stunTime: 1.2, shotColor: 0x9ae0ff, accent: 0x9ae0ff },
  { id: 'tranq2', cost: 780, studs: true, name: 'Warm Milk Darts', blurb: 'longer naps', damage: 360, stunTime: 1.5 },
  { id: 'tranq3', cost: 1000, studs: true, name: 'Bedtime Story Rifle', blurb: 'faster darts, deeper sleep', damage: 410, interval: 1.0, stunTime: 1.8 },
  { id: 'tranq4', cost: 1400, studs: true, name: 'Lullaby Moo-n', blurb: 'hush little cowbaby', damage: 480, interval: 0.9, stunTime: 2.2 },
]);
path('assassin3', [
  { id: 'bounty', kind: 'variant', cost: 580, flag: 0xc9a227, name: 'Bounty Hunter', blurb: 'every cow it drops pays double', damage: 320, ownBounty: 2, accent: 0xc9a227 },
  { id: 'bounty2', cost: 750, studs: true, name: 'Wanted Poster Sniper', blurb: '×2.3 on its own kills', damage: 360, ownBounty: 2.3 },
  { id: 'bounty3', cost: 960, studs: true, name: 'Sheriff of Moo-ttingham', blurb: '×2.6, executes under 35%', damage: 400, ownBounty: 2.6, execute: 0.35 },
  { id: 'bounty4', cost: 1350, studs: true, name: 'Wanted: Dead or Alive', blurb: '×3 moolah and executes under 40%', damage: 460, ownBounty: 3, execute: 0.4 },
]);

// Auction Barn · Bull Market (already at Lv6)
path('bullmarket3', [
  { id: 'tycoon', kind: 'variant', cost: 750, flag: 0x5ad86a, name: 'Cattle Tycoon', blurb: 'top hat, monocle, ×3.1 moolah', bountyMult: 3.1, range: 19, accent: 0x5ad86a },
  { id: 'tycoon2', cost: 950, studs: true, name: 'Beef Baron', blurb: '×3.4 moolah', bountyMult: 3.4, range: 20 },
  { id: 'tycoon3', cost: 1200, studs: true, name: 'Dairy Oligarch', blurb: '×3.8 moolah', bountyMult: 3.8, range: 21 },
  { id: 'tycoon4', cost: 1600, studs: true, name: 'Moo-nopoly Man', blurb: 'passes Go every cow: ×4.3 moolah', bountyMult: 4.3, range: 23 },
]);
path('bullmarket3', [
  { id: 'rodeo', kind: 'variant', cost: 700, flag: 0xd04848, name: 'Rodeo Auction', blurb: 'the auctioneer talks so fast walking cows in reach slow down to listen (25%), ×2.8 moolah', attack: 'aura', targeting: 'nearest', hitsAir: false, interval: 0.25, slow: 0.75, slowTime: 0.5, bountyMult: 2.8, range: 18, accent: 0xd04848 },
  { id: 'rodeo2', cost: 900, studs: true, name: 'Fast-Talking Auctioneer', blurb: '30% slower cows, ×3 moolah', slow: 0.7, bountyMult: 3 },
  { id: 'rodeo3', cost: 1150, studs: true, name: 'Hyper-Speed Auctioneer', blurb: '35% slower, ×3.2, wider', slow: 0.65, bountyMult: 3.2, range: 19 },
  { id: 'rodeo4', cost: 1500, studs: true, name: 'Yodeling Auctioneer', blurb: 'nobody can walk through that: 40% slower, ×3.5', slow: 0.6, bountyMult: 3.5, range: 20 },
]);

// Auction Barn · Cheese Vault (already at Lv6)
path('vault3', [
  { id: 'fondue', kind: 'variant', cost: 650, flag: 0xffe14d, name: 'Fondue Fund', blurb: 'a melting pot of investments: 12% interest, up to 250', interest: 0.12, interestCap: 250, accent: 0xffe14d },
  { id: 'fondue2', cost: 850, studs: true, name: 'Hedge Fund (Actual Hedge)', blurb: '13% interest, up to 350', interest: 0.13, interestCap: 350 },
  { id: 'fondue3', cost: 1100, studs: true, name: 'Brie-tirement Plan', blurb: '14% interest, up to 500', interest: 0.14, interestCap: 500 },
  { id: 'fondue4', cost: 1450, studs: true, name: 'Gouda Sachs', blurb: '15% interest, up to 750', interest: 0.15, interestCap: 750 },
]);
path('vault3', [
  { id: 'printer', kind: 'variant', cost: 600, flag: 0x5ad86a, name: 'Milk Money Printer', blurb: 'prints 60 moolah every wave, saved up or not', income: 60, accent: 0x5ad86a },
  { id: 'printer2', cost: 800, studs: true, name: 'Two-Ply Printer', blurb: '90 moolah every wave', income: 90 },
  { id: 'printer3', cost: 1050, studs: true, name: 'Quantitative Cheesing', blurb: '130 moolah every wave', income: 130 },
  { id: 'printer4', cost: 1400, studs: true, name: 'Federal Reserve of Cheese', blurb: '200 moolah every wave. Inflation is a cow problem', income: 200 },
]);
