// Tower-defence state for one match: the nav grid, towers, cows, spawners,
// waves, money and the milk. Advanced by tick(dt) at the fixed sim rate,
// next to the player. Pure (no three.js, no DOM) and seeded, so the same
// inputs give the same match: needed for replays and lockstep PvP later.

import { Aabb } from './collision.js';
import { v3 } from './vec3.js';
import { NavGrid } from './navgrid.js';
import { CowPool, COW_TYPE_LIST, waveMix, pickFromMix } from './cows.js';
import { SELL_REFUND, TOWER_TYPES } from './towers.js';
import { mulberry32 } from './rng.js';

export const CELL = 2;

export function defaultGameConfig() {
  return {
    seed: 1,
    startMoney: 250,
    milk: 100,
    /** Seconds before the first wave; null = waves only start when asked (startWave()). */
    firstWave: 20,
    /** Seconds between the last cow of one wave spawning and the next wave. null = manual. */
    waveGap: 25,
    waveBase: 6,
    waveGrowth: 4,
    /** Each wave's cows have this much more HP than the last (compounding is too steep for now: linear). */
    hpPerWave: 0.15,
    spawnInterval: 0.5,
    spawnSpread: 4,
    waveBonus: 25,
    maxCows: 4096,
  };
}

/** Why a tower can't go somewhere; the HUD shows these. */
export const PlaceError = Object.freeze({
  UnknownType: 'unknown tower',
  GameOver: 'the milk is gone',
  OffGrid: 'outside the field',
  Blocked: 'something is in the way',
  Occupied: 'a tower is already there',
  Cow: 'a cow is standing there',
  Player: "you're standing there",
  BlocksPath: 'that would block every path to the milk',
  Money: 'not enough moolah',
});

/**
 * A Kaboom Cow goes off when it gets this close (metres, cow edge to tower
 * edge) to a tower: far enough that any cow walking in a cell next to a tower
 * (centre within 1 m + its herd offset of the tower's edge) sets it off.
 */
export const BLAST_TRIGGER = 1.0;

export class Game {
  /**
   * @param {{blocks:{surface:string,aabb:Aabb}[], spawners?:{x:number,z:number}[]}} level
   * @param {import('./collision.js').CollisionWorld} world towers are added to it as solids
   */
  constructor(level, world, cfg = defaultGameConfig()) {
    this.level = level;
    this.world = world;
    this.cfg = cfg;
    this.grid = buildGrid(level);
    this.milkBlocks = level.blocks.filter((b) => b.surface === 'milk').map((b) => b.aabb);
    const m = this.milkBlocks[0];
    this.milkX = m ? (m.min.x + m.max.x) / 2 : 0;
    this.milkZ = m ? (m.min.z + m.max.z) / 2 : 0;
    this.spawners = (level.spawners ?? []).map((s) => ({ x: s.x, z: s.z, cell: this.grid.cellAt(s.x, s.z), queue: 0, timer: 0 }));
    this.cows = new CowPool(cfg.maxCows);
    this.reset();
  }

  reset() {
    for (const t of this.towers?.values() ?? []) this.removeSolid(t.aabb);
    this.grid.tower.fill(0);
    this.grid.rebuild();
    this.rng = mulberry32(this.cfg.seed);
    this.towers = new Map();
    this.nextTowerId = 1;
    this.cows.clear();
    this.projectiles = [];
    /** Things that happened this tick, for effects and sounds. The client drains it. */
    this.events = [];
    this.money = this.cfg.startMoney;
    this.milk = this.cfg.milk;
    this.lost = false;
    this.wave = 0;
    this.kills = 0;
    this.time = 0;
    this.nextWaveIn = this.cfg.firstWave;
    for (const s of this.spawners) { s.queue = 0; s.timer = 0; }
  }

  // ---- waves and spawning -------------------------------------------------

  /** Start the next wave now (also how manual-wave levels advance). */
  startWave() {
    if (this.lost || this.spawners.length === 0) return;
    this.wave++;
    const total = this.cfg.waveBase + this.cfg.waveGrowth * (this.wave - 1);
    this.spawners.forEach((s, k) => {
      s.queue += Math.floor(total / this.spawners.length) + (k < total % this.spawners.length ? 1 : 0);
    });
    this.money += this.cfg.waveBonus;
    this.nextWaveIn = null;
    this.events.push({ kind: 'wave', wave: this.wave });
  }

  get spawning() { return this.spawners.some((s) => s.queue > 0); }

  updateSpawners(dt) {
    if (this.nextWaveIn !== null) {
      this.nextWaveIn -= dt;
      if (this.nextWaveIn <= 0) this.startWave();
    }
    const mix = waveMix(this.wave);
    const hpScale = 1 + this.cfg.hpPerWave * Math.max(0, this.wave - 1);
    for (const s of this.spawners) {
      if (s.queue <= 0) continue;
      s.timer -= dt;
      while (s.timer <= 0 && s.queue > 0) {
        s.timer += this.cfg.spawnInterval;
        s.queue--;
        // A one-type mix draws no random number, so early waves match the old sequence.
        const type = mix.length === 1 ? mix[0].type : pickFromMix(mix, this.rng());
        this.spawnCow(type, s.x, s.z, type.hp * hpScale);
      }
      if (s.queue === 0) s.timer = 0;
    }
    if (this.wave > 0 && this.nextWaveIn === null && !this.spawning && this.cfg.waveGap !== null) {
      this.nextWaveIn = this.cfg.waveGap;
    }
  }

  spawnCow(type, x, z, hp = type.hp) {
    const spread = this.cfg.spawnSpread;
    let sx = x + (this.rng() - 0.5) * spread, sz = z + (this.rng() - 0.5) * spread;
    const cell = this.grid.cellAt(sx, sz);
    if (cell < 0 || !this.grid.walkable(cell)) { sx = x; sz = z; }
    // Herd spread inside a cell, narrower for wide cows so they don't clip the towers beside the path.
    const off = Math.min(0.6 * this.grid.cell, Math.max(0, this.grid.cell - 2 * type.radius));
    const i = this.cows.spawn(type, sx, sz, (this.rng() - 0.5) * off, (this.rng() - 0.5) * off);
    if (i >= 0) this.cows.hp[i] = hp;
    return i;
  }

  // ---- simulation ---------------------------------------------------------

  tick(dt) {
    this.events.length = 0;
    if (this.lost) return;
    this.time += dt;
    this.updateSpawners(dt);
    this.updateCows(dt);
    this.updateTowers(dt);
    this.updateProjectiles(dt);
  }

  updateCows(dt) {
    const { cows, grid } = this;
    const turn = Math.min(1, dt * 8);
    // Backwards, so remove() (which moves the last cow into slot i) never skips one.
    for (let i = cows.count - 1; i >= 0; i--) {
      const type = COW_TYPE_LIST[cows.type[i]];
      const x = cows.x[i], z = cows.z[i];
      cows.px[i] = x;
      cows.pz[i] = z;
      cows.hitAge[i] += dt;
      const cell = grid.cellAt(x, z);
      if (cell >= 0 && grid.goal[cell]) {
        this.milk -= type.damage;
        this.events.push({ kind: 'drink', x, z });
        cows.remove(i);
        continue;
      }
      // Walkers follow the flow field; flyers go straight for the milk over everything.
      let tx = this.milkX + cows.ox[i], tz = this.milkZ + cows.oz[i];
      const n = cell >= 0 && type.altitude <= 0 ? grid.next[cell] : -1;
      if (n >= 0) {
        tx = grid.centerX(n) + cows.ox[i];
        tz = grid.centerZ(n) + cows.oz[i];
      }
      const dx = tx - x, dz = tz - z;
      const len = Math.sqrt(dx * dx + dz * dz);
      const wx = len > 1e-9 ? (dx / len) * type.speed : 0;
      const wz = len > 1e-9 ? (dz / len) * type.speed : 0;
      // Ease velocity toward the wish so turns at cell corners look like turning.
      cows.vx[i] += (wx - cows.vx[i]) * turn;
      cows.vz[i] += (wz - cows.vz[i]) * turn;
      cows.x[i] = x + cows.vx[i] * dt;
      cows.z[i] = z + cows.vz[i] * dt;
      if (type.blastRadius > 0 && this.towerNear(cows.x[i], cows.z[i], type.radius + BLAST_TRIGGER)) {
        this.explodeCow(i, type);
      }
    }
    if (this.milk <= 0) {
      this.milk = 0;
      this.lost = true;
      this.events.push({ kind: 'lost' });
    }
  }

  /**
   * True if some tower's footprint is within `reach` metres of (x, z) in XZ.
   * Looks only at the towers in the 5x5 cells around the point (reach must stay under 2 cells).
   */
  towerNear(x, z, reach) {
    const { grid } = this;
    const cx = grid.cellX(x), cz = grid.cellZ(z);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!grid.inBounds(cx + dx, cz + dz)) continue;
        const id = grid.tower[grid.index(cx + dx, cz + dz)];
        if (id && boxDist2(this.towers.get(id).aabb, x, z) <= reach * reach) return true;
      }
    }
    return false;
  }

  /**
   * Kaboom: the cow at slot i blows up, wrecking every tower within its
   * blastRadius (no refund) and taking itself out (no bounty, no milk lost).
   * Only call while iterating cows backwards (or not at all).
   */
  explodeCow(i, type) {
    const x = this.cows.x[i], z = this.cows.z[i];
    const r2 = type.blastRadius * type.blastRadius;
    const wrecked = [];
    for (const t of this.towers.values()) if (boxDist2(t.aabb, x, z) <= r2) wrecked.push(t);
    for (const t of wrecked) this.removeTower(t);
    if (wrecked.length) this.grid.rebuild();
    this.events.push({ kind: 'boom', x, z, radius: type.blastRadius, wrecked: wrecked.length });
    for (const t of wrecked) this.events.push({ kind: 'destroyed', tower: t.id, name: t.def.name, x: t.x, z: t.z });
    this.cows.remove(i);
  }

  updateTowers(dt) {
    for (const t of this.towers.values()) {
      const def = t.def;
      if (!def.attack) continue;
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      const target = def.targeting(this, t);
      if (target < 0) { t.cooldown = 0; continue; }
      this.aimAt(t, this.cows.x[target], this.cows.z[target]);
      def.attack(this, t, target);
      t.cooldown += def.interval;
    }
  }

  /** Point the tower at (x, z) and update its muzzle position. */
  aimAt(t, x, z) {
    let fx = x - t.x, fz = z - t.z;
    const len = Math.sqrt(fx * fx + fz * fz);
    if (len < 1e-9) return;
    fx /= len; fz /= len;
    t.aimX = fx; t.aimZ = fz;
    // Local -Z is forward, local +X is right = (-fz, fx).
    const [mx, my, mz] = t.def.muzzle;
    t.muzzleX = t.x + mx * -fz - mz * fx;
    t.muzzleY = my;
    t.muzzleZ = t.z + mx * fx - mz * fz;
  }

  updateProjectiles(dt) {
    const ps = this.projectiles;
    for (let k = ps.length - 1; k >= 0; k--) {
      const p = ps[k];
      p.prevT = p.t;
      p.t += dt;
      if (p.t < p.T) continue;
      this.splash(p.x1, p.z1, p.radius, p.damage, this.towers.get(p.tower));
      this.events.push({ kind: 'splash', x: p.x1, z: p.z1, radius: p.radius, color: p.color });
      ps[k] = ps[ps.length - 1];
      ps.pop();
    }
  }

  /** Damage every cow within `radius` of (x, z). */
  splash(x, z, radius, damage, tower) {
    const { cows } = this;
    for (let i = cows.count - 1; i >= 0; i--) {
      const type = COW_TYPE_LIST[cows.type[i]];
      if (type.altitude > 0) continue; // shells land on the ground, under flyers
      const dx = cows.x[i] - x, dz = cows.z[i] - z;
      const r = radius + type.radius;
      if (dx * dx + dz * dz <= r * r) this.damageCow(i, damage, tower);
    }
  }

  /** Returns true if the cow died. Only call while iterating cows backwards (or not at all). */
  damageCow(i, damage, tower) {
    const { cows } = this;
    cows.hp[i] -= damage;
    cows.hitAge[i] = 0;
    if (cows.hp[i] > 0) return false;
    const type = COW_TYPE_LIST[cows.type[i]];
    this.money += type.bounty;
    this.kills++;
    if (tower) tower.kills++;
    this.events.push({ kind: 'kill', x: cows.x[i], z: cows.z[i] });
    cows.remove(i);
    return true;
  }

  /** Metres of path left from cow i to the milk (Infinity if a walker is lost off the grid; flyers go straight). */
  cowPathDistance(i) {
    if (COW_TYPE_LIST[this.cows.type[i]].altitude > 0) {
      const dx = this.cows.x[i] - this.milkX, dz = this.cows.z[i] - this.milkZ;
      return Math.sqrt(dx * dx + dz * dz);
    }
    const c = this.grid.cellAt(this.cows.x[i], this.cows.z[i]);
    return c >= 0 ? this.grid.dist[c] : Infinity;
  }

  // ---- building -----------------------------------------------------------

  /**
   * Where a tower of `typeId` aimed at world point (x, z) would go, and
   * whether it may. `playerBox` (an Aabb) stops building on top of yourself.
   * Returns { ok, reason, type, cx, cz, x, z, cells, aabb }.
   */
  checkPlacement(typeId, x, z, playerBox = null) {
    const type = TOWER_TYPES[typeId];
    if (!type) return { ok: false, reason: PlaceError.UnknownType };
    const { grid } = this;
    const n = type.footprint;
    // Snap the footprint's centre to the aim point: odd sizes centre on a
    // cell, even sizes on a grid corner.
    const cx = Math.round((x - grid.originX) / grid.cell - n / 2);
    const cz = Math.round((z - grid.originZ) / grid.cell - n / 2);
    const minX = grid.originX + cx * grid.cell, minZ = grid.originZ + cz * grid.cell;
    const size = n * grid.cell;
    const res = {
      ok: false, reason: null, type, cx, cz,
      x: minX + size / 2, z: minZ + size / 2, cells: [],
      aabb: new Aabb(v3(minX, 0, minZ), v3(minX + size, type.height, minZ + size)),
    };
    const fail = (reason) => { res.reason = reason; return res; };
    if (this.lost) return fail(PlaceError.GameOver);
    if (!grid.inBounds(cx, cz) || !grid.inBounds(cx + n - 1, cz + n - 1)) return fail(PlaceError.OffGrid);
    for (let dz = 0; dz < n; dz++) {
      for (let dx = 0; dx < n; dx++) {
        const i = grid.index(cx + dx, cz + dz);
        if (grid.solid[i]) return fail(PlaceError.Blocked);
        if (grid.tower[i]) return fail(PlaceError.Occupied);
        res.cells.push(i);
      }
    }
    const { cows } = this;
    for (let i = 0; i < cows.count; i++) {
      const ct = COW_TYPE_LIST[cows.type[i]];
      if (ct.altitude > 0) continue; // flyers pass overhead
      const r = ct.radius;
      if (cows.x[i] > minX - r && cows.x[i] < minX + size + r && cows.z[i] > minZ - r && cows.z[i] < minZ + size + r) {
        return fail(PlaceError.Cow);
      }
    }
    if (playerBox && playerBox.overlaps(res.aabb)) return fail(PlaceError.Player);
    // Every spawner and every cow must still have a way to the milk: no
    // walling it off completely. (Mazing is fine and encouraged.)
    const mustReach = this.spawners.filter((s) => s.cell >= 0).map((s) => s.cell);
    for (let i = 0; i < cows.count; i++) {
      if (COW_TYPE_LIST[cows.type[i]].altitude > 0) continue; // flyers don't need a path
      const c = grid.cellAt(cows.x[i], cows.z[i]);
      if (c >= 0 && Number.isFinite(grid.dist[c])) mustReach.push(c);
    }
    if (!grid.reachableWith(res.cells, mustReach)) return fail(PlaceError.BlocksPath);
    if (this.money < type.cost) return fail(PlaceError.Money);
    res.ok = true;
    return res;
  }

  /** Build if allowed. Returns the tower, or the failed placement check. */
  placeTower(typeId, x, z, playerBox = null) {
    const p = this.checkPlacement(typeId, x, z, playerBox);
    if (!p.ok) return p;
    const id = this.nextTowerId++;
    const t = {
      id, def: p.type, x: p.x, z: p.z, cx: p.cx, cz: p.cz, cells: p.cells, aabb: p.aabb,
      cooldown: 0, kills: 0, aimX: 0, aimZ: -1, muzzleX: 0, muzzleY: 0, muzzleZ: 0,
      spent: p.type.cost,
    };
    this.aimAt(t, t.x, t.z - 1);
    for (const i of p.cells) this.grid.tower[i] = id;
    this.grid.rebuild();
    this.world.solids.push(t.aabb);
    this.towers.set(id, t);
    this.money -= p.type.cost;
    this.events.push({ kind: 'built', tower: id });
    return t;
  }

  /** Sell for SELL_REFUND of the price. Returns the refund, or 0 if there was no such tower. */
  sellTower(id) {
    const t = this.towers.get(id);
    if (!t) return 0;
    this.removeTower(t);
    this.grid.rebuild();
    const refund = Math.floor(t.spent * SELL_REFUND);
    this.money += refund;
    this.events.push({ kind: 'sold', tower: id });
    return refund;
  }

  /** Take a tower off the grid and out of the world. The caller rebuilds the flow field. */
  removeTower(t) {
    for (const i of t.cells) this.grid.tower[i] = 0;
    this.removeSolid(t.aabb);
    this.towers.delete(t.id);
  }

  removeSolid(aabb) {
    const k = this.world.solids.indexOf(aabb);
    if (k >= 0) this.world.solids.splice(k, 1);
  }

  /**
   * First tower hit by the ray origin + s * dir, 0 <= s <= maxDist (dir need not be unit).
   * Returns { tower, distance } or null.
   */
  raycastTower(origin, dir, maxDist) {
    let best = null;
    for (const t of this.towers.values()) {
      const s = rayBox(origin, dir, t.aabb);
      if (s !== null && s <= maxDist && (best === null || s < best.distance)) best = { tower: t, distance: s };
    }
    return best;
  }
}

/** Squared XZ distance from (x, z) to the nearest point of box b (0 inside). */
export function boxDist2(b, x, z) {
  const dx = x < b.min.x ? b.min.x - x : x > b.max.x ? x - b.max.x : 0;
  const dz = z < b.min.z ? b.min.z - z : z > b.max.z ? z - b.max.z : 0;
  return dx * dx + dz * dz;
}

/** Ray vs box, slab method. Returns the entry distance (0 if starting inside) or null. */
export function rayBox(o, d, b) {
  let t0 = 0, t1 = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const lo = b.min[axis], hi = b.max[axis];
    if (d[axis] === 0) {
      if (o[axis] < lo || o[axis] > hi) return null;
      continue;
    }
    let a = (lo - o[axis]) / d[axis], c = (hi - o[axis]) / d[axis];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  return t0;
}

/**
 * Nav grid over the level's floor: every non-floor block a cow would bump
 * into is solid, and the cells around the milk are the goal.
 */
export function buildGrid(level, cell = CELL) {
  const floors = level.blocks.filter((b) => b.surface === 'floor').map((b) => b.aabb);
  if (floors.length === 0) throw new Error('level has no floor');
  const bounds = {
    minX: Math.min(...floors.map((f) => f.min.x)), maxX: Math.max(...floors.map((f) => f.max.x)),
    minZ: Math.min(...floors.map((f) => f.min.z)), maxZ: Math.max(...floors.map((f) => f.max.z)),
  };
  const grid = new NavGrid(bounds, cell);
  for (const b of level.blocks) if (b.surface !== 'floor') grid.markSolid(b.aabb);
  for (const b of level.blocks) if (b.surface === 'milk') grid.markGoalAround(b.aabb);
  grid.rebuild();
  return grid;
}
