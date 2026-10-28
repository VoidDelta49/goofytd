// Tower-defence state for one match: the nav grid, towers, cows, spawners,
// waves, money and the milk. Advanced by tick(dt) at the fixed sim rate,
// next to the player. Pure (no three.js, no DOM) and seeded, so the same
// inputs give the same match: needed for replays and lockstep PvP later.

import { Aabb } from './collision.js';
import { v3 } from './vec3.js';
import { NavGrid } from './navgrid.js';
import { CowPool, COW_TYPES, COW_TYPE_LIST, waveMix, pickFromMix } from './cows.js';
import { SELL_REFUND, TOWER_TYPES, TOWER_FORMS } from './towers.js';
import { mulberry32 } from './rng.js';
import { SURPRISES, surpriseChance, pickSurprise } from './surprises.js';

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
    /** Scripted surprises rolled on top of the wave formula (surprises.js). */
    surprises: true,
    /** Chance of a surprise in wave 2, growing per wave up to surpriseMax. */
    surpriseBase: 0.3,
    surpriseGrowth: 0.05,
    surpriseMax: 0.75,
    /** After this many waves in a row without one, the next wave always gets one. */
    surpriseDrought: 2,
    /** From this wave on, a wave that rolled a surprise may roll a second one. */
    doubleSurpriseWave: 8,
    doubleSurpriseChance: 0.25,
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

/** Why an upgrade didn't happen; the upgrade panel shows these. */
export const UpgradeError = Object.freeze({
  NoTower: 'that tower is gone',
  GameOver: 'the milk is gone',
  NotAnUpgrade: "that isn't an upgrade for this tower",
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
    /** Butter slicks on the ground: { x, z, radius, t, T, dps, slow, tower, color }. */
    this.zones = [];
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
    // Surprises draw from their own stream so rolling one never shifts which cows the wave brings.
    this.surpriseRng = mulberry32((this.cfg.seed ^ 0x5eed5eed) >>> 0);
    /** Running surprise scripts (see updateSurprises). */
    this.runs = [];
    /** Cow id -> { onKill, onEscape } for cows a surprise is watching. */
    this.tracked = new Map();
    this.wavesWithoutSurprise = 0;
    this.lastSurprise = null;
    /** Every surprise rolled this match: { wave, id }. */
    this.surpriseLog = [];
    /** Regular wave spawns pause while spawnHold > 0, and their interval is × spawnRate (a surprise can change both). */
    this.spawnHold = 0;
    this.spawnRate = 1;
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
    this.spawnHold = 0;
    this.spawnRate = 1;
    if (this.cfg.surprises) this.rollSurprises();
    this.events.push({ kind: 'wave', wave: this.wave });
  }

  get spawning() { return this.runs.length > 0 || this.spawners.some((s) => s.queue > 0); }

  // ---- surprises ----------------------------------------------------------

  /**
   * Maybe schedule surprises for the wave that just started. Only schedules:
   * nothing happens (and no event is pushed) until updateSurprises runs them
   * inside tick(), since tick() clears events and startWave can run outside it.
   */
  rollSurprises() {
    const r = this.surpriseRng, cfg = this.cfg;
    const due = this.wave >= 2 && this.wavesWithoutSurprise >= cfg.surpriseDrought;
    let n = due || r() < surpriseChance(cfg, this.wave) ? 1 : 0;
    if (n && this.wave >= cfg.doubleSurpriseWave && r() < cfg.doubleSurpriseChance) n = 2;
    const picked = this.lastSurprise ? [this.lastSurprise] : [];
    let scheduled = 0;
    for (let k = 0; k < n; k++) {
      const def = pickSurprise(this.wave, r(), picked);
      if (!def) break;
      picked.push(def.id);
      const [d0, d1] = def.delay;
      this.queueSurprise(def, d0 + (d1 - d0) * r());
      scheduled++;
    }
    this.wavesWithoutSurprise = scheduled ? 0 : this.wavesWithoutSurprise + 1;
  }

  /**
   * Run surprise `def` (a def or its id) `delay` seconds from now, at the current
   * wave's strength. Also handy from the console: goofytd.game.queueSurprise('bessie').
   */
  queueSurprise(def, delay = 0) {
    if (typeof def === 'string') def = SURPRISES[def];
    if (!def) return false;
    const steps = def.script({ wave: Math.max(1, this.wave), rng: this.surpriseRng, game: this })
      .map((s, order) => ({ ...s, order })).sort((a, b) => a.at - b.at || a.order - b.order);
    this.runs.push({ def, t: -delay, steps, next: 0, streams: [], at: null });
    this.surpriseLog.push({ wave: this.wave, id: def.id });
    this.lastSurprise = def.id;
    return true;
  }

  /** Banner text from a surprise (or anything else in the sim that wants one). Only inside tick(). */
  announce(id, text, x, z) {
    this.events.push({ kind: 'surprise', id, text, x, z });
  }

  /** Where a surprise's cows come from: a spawner, every spawner, or a reachable spot near the field edge. */
  surprisePoints(from, run) {
    const r = this.surpriseRng;
    if (from === 'all') return this.spawners.map((s) => ({ x: s.x, z: s.z }));
    if (from === 'same' && run.at) return [run.at];
    if (from === 'flank') {
      const p = this.flankPoint();
      if (p) return [p];
    }
    const s = this.spawners[Math.floor(r() * this.spawners.length)];
    return [{ x: s.x, z: s.z }];
  }

  /** A walkable cell within 3 cells of the grid edge, far from the milk and the spawners, with a path to the milk. */
  flankPoint() {
    const { grid } = this, r = this.surpriseRng;
    for (let tries = 0; tries < 60; tries++) {
      const side = Math.floor(r() * 4), depth = Math.floor(r() * 3);
      const along = Math.floor(r() * (side < 2 ? grid.w : grid.h));
      const cx = side === 0 ? along : side === 1 ? along : side === 2 ? depth : grid.w - 1 - depth;
      const cz = side === 0 ? depth : side === 1 ? grid.h - 1 - depth : along;
      if (!grid.inBounds(cx, cz)) continue;
      const i = grid.index(cx, cz);
      if (!grid.walkable(i) || grid.goal[i] || !(grid.dist[i] < Infinity)) continue;
      const x = grid.centerX(i), z = grid.centerZ(i);
      if ((x - this.milkX) ** 2 + (z - this.milkZ) ** 2 < 30 * 30) continue;
      if (this.spawners.some((s) => (x - s.x) ** 2 + (z - s.z) ** 2 < 15 * 15)) continue;
      return { x, z };
    }
    return null;
  }

  updateSurprises(dt) {
    const hpScale = 1 + this.cfg.hpPerWave * Math.max(0, this.wave - 1);
    for (let k = this.runs.length - 1; k >= 0; k--) {
      const run = this.runs[k];
      run.t += dt;
      while (run.next < run.steps.length && run.steps[run.next].at <= run.t) {
        const step = run.steps[run.next++];
        if (step.say) this.announce(run.def.id, step.say);
        if (step.call) step.call(this);
        if (step.spawn) {
          const pts = this.surprisePoints(step.from ?? 'random', run);
          run.at = pts[0];
          if (step.announce) this.announce(run.def.id, step.announce, pts[0].x, pts[0].z);
          for (const p of pts) {
            run.streams.push({ step, x: p.x, z: p.z, left: step.count ?? 1, timer: 0 });
          }
        }
      }
      for (let j = run.streams.length - 1; j >= 0; j--) {
        const st = run.streams[j], step = st.step;
        st.timer -= dt;
        while (st.timer <= 0 && st.left > 0) {
          st.timer += step.every ?? 0.15;
          st.left--;
          const mix = step.mix ? waveMix(this.wave) : null;
          const type = mix ? pickFromMix(mix, this.surpriseRng()) : COW_TYPES[step.spawn];
          const i = this.spawnCow(type, st.x, st.z, type.hp * hpScale * (step.hp ?? 1), this.surpriseRng);
          if (i >= 0 && (step.onKill || step.onEscape)) {
            this.tracked.set(this.cows.id[i], { onKill: step.onKill, onEscape: step.onEscape });
          }
        }
        if (st.left <= 0) run.streams.splice(j, 1);
      }
      if (run.next >= run.steps.length && run.streams.length === 0) this.runs.splice(k, 1);
    }
  }

  /** Run kill/escape hooks for watched cows. Called at the end of tick() so it sees every kill this tick. */
  watchTracked() {
    if (this.tracked.size === 0) return;
    const n = this.events.length; // hooks may push events; only look at the ones already there
    for (let e = 0; e < n; e++) {
      const ev = this.events[e];
      if (ev.kind !== 'kill' && ev.kind !== 'drink') continue;
      const w = this.tracked.get(ev.id);
      if (!w) continue;
      this.tracked.delete(ev.id);
      const hook = ev.kind === 'kill' ? w.onKill : w.onEscape;
      if (hook) hook(this, ev.id);
    }
  }

  updateSpawners(dt) {
    if (this.nextWaveIn !== null) {
      this.nextWaveIn -= dt;
      if (this.nextWaveIn <= 0) this.startWave();
    }
    this.updateSurprises(dt);
    if (this.spawnHold > 0) this.spawnHold -= dt;
    const mix = waveMix(this.wave);
    const hpScale = 1 + this.cfg.hpPerWave * Math.max(0, this.wave - 1);
    for (const s of this.spawners) {
      if (s.queue <= 0 || this.spawnHold > 0) continue;
      s.timer -= dt;
      while (s.timer <= 0 && s.queue > 0) {
        s.timer += this.cfg.spawnInterval * this.spawnRate;
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

  /** `rng`: surprises pass their own stream, so their cows don't shift the regular wave's draws. */
  spawnCow(type, x, z, hp = type.hp, rng = this.rng) {
    const spread = this.cfg.spawnSpread;
    let sx = x + (rng() - 0.5) * spread, sz = z + (rng() - 0.5) * spread;
    const cell = this.grid.cellAt(sx, sz);
    if (cell < 0 || !this.grid.walkable(cell)) { sx = x; sz = z; }
    // Herd spread inside a cell, narrower for wide cows so they don't clip the towers beside the path.
    const off = Math.min(0.6 * this.grid.cell, Math.max(0, this.grid.cell - 2 * type.radius));
    const i = this.cows.spawn(type, sx, sz, (rng() - 0.5) * off, (rng() - 0.5) * off);
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
    this.updateZones(dt);
    this.watchTracked();
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
        this.events.push({ kind: 'drink', x, z, id: cows.id[i] });
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
      let speed = type.speed;
      if (cows.slowT[i] > 0) {
        speed *= cows.slowF[i];
        cows.slowT[i] -= dt;
      }
      const wx = len > 1e-9 ? (dx / len) * speed : 0;
      const wz = len > 1e-9 ? (dz / len) * speed : 0;
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
   * blastRadius (no refund; blast-proof ones shrug it off) and taking itself
   * out (no bounty, no milk lost).
   * Only call while iterating cows backwards (or not at all).
   */
  explodeCow(i, type) {
    const x = this.cows.x[i], z = this.cows.z[i];
    const r2 = type.blastRadius * type.blastRadius;
    const wrecked = [];
    for (const t of this.towers.values()) if (!t.def.blastProof && boxDist2(t.aabb, x, z) <= r2) wrecked.push(t);
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
      if (target < 0) {
        t.cooldown = 0;
        if (def.spinDown > 0) t.charge = Math.max(0, t.charge - def.spinDown * dt);
        continue;
      }
      this.aimAt(t, this.cows.x[target], this.cows.z[target]);
      def.attack(this, t, target);
      if (def.minInterval > 0) {
        // Spin-up gun: the gap shrinks from interval to minInterval as it charges.
        t.cooldown += def.interval + (def.minInterval - def.interval) * t.charge;
        t.charge = Math.min(1, t.charge + def.spinUp);
      } else {
        t.cooldown += def.interval;
      }
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
      this.splash(p.x1, p.z1, p.radius, p.damage, this.towers.get(p.tower), p.air);
      this.events.push({ kind: 'splash', x: p.x1, y: p.y1, z: p.z1, radius: p.radius, color: p.color, air: p.air });
      if (p.slick) {
        const s = p.slick;
        this.zones.push({ x: p.x1, z: p.z1, radius: s.radius, t: 0, T: s.time, dps: s.dps, slow: s.slow, tower: p.tower, color: p.color });
      }
      ps[k] = ps[ps.length - 1];
      ps.pop();
    }
  }

  /**
   * Butter slicks: slow and grease every walking cow standing in one.
   * Puddles don't stack: a cow in several takes only the strongest one's
   * damage and slow (otherwise overlapping shells multiplied the damage).
   */
  updateZones(dt) {
    const { zones, cows } = this;
    for (let k = zones.length - 1; k >= 0; k--) {
      zones[k].t += dt;
      if (zones[k].t >= zones[k].T) {
        zones[k] = zones[zones.length - 1];
        zones.pop();
      }
    }
    if (!zones.length) return;
    for (let i = cows.count - 1; i >= 0; i--) {
      const type = COW_TYPE_LIST[cows.type[i]];
      if (type.altitude > 0) continue;
      let best = null;
      for (const zn of zones) {
        const dx = cows.x[i] - zn.x, dz = cows.z[i] - zn.z;
        const r = zn.radius + type.radius;
        if (dx * dx + dz * dz <= r * r && (!best || zn.dps > best.dps)) best = zn;
      }
      if (!best) continue;
      this.slowCow(i, best.slow, 0.2);
      this.damageCow(i, best.dps * dt, this.towers.get(best.tower), false);
    }
  }

  /** Slow cow i to `factor` of its speed for `time` s. A weaker slow never overrides a stronger running one. */
  slowCow(i, factor, time) {
    const { cows } = this;
    if (cows.slowT[i] <= 0 || factor <= cows.slowF[i]) {
      cows.slowF[i] = factor;
      if (time > cows.slowT[i]) cows.slowT[i] = time;
    }
  }

  /** Damage every cow within `radius` of (x, z): flyers for an airburst (`air`), otherwise walkers. */
  splash(x, z, radius, damage, tower, air = false) {
    const { cows } = this;
    for (let i = cows.count - 1; i >= 0; i--) {
      const type = COW_TYPE_LIST[cows.type[i]];
      if ((type.altitude > 0) !== air) continue; // ground shells land under flyers; airbursts go off over walkers
      const dx = cows.x[i] - x, dz = cows.z[i] - z;
      const r = radius + type.radius;
      if (dx * dx + dz * dz <= r * r) this.damageCow(i, damage, tower);
    }
  }

  /**
   * Returns true if the cow died. Only call while iterating cows backwards (or not at all).
   * `flash` false for damage over time (a slick), so cows don't strobe red.
   */
  damageCow(i, damage, tower, flash = true) {
    const { cows } = this;
    cows.hp[i] -= damage;
    if (flash) cows.hitAge[i] = 0;
    if (cows.hp[i] > 0) return false;
    const type = COW_TYPE_LIST[cows.type[i]];
    this.money += type.bounty;
    this.kills++;
    if (tower) tower.kills++;
    this.events.push({ kind: 'kill', x: cows.x[i], z: cows.z[i], id: cows.id[i] });
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
      cooldown: 0, charge: 0, kills: 0, aimX: 0, aimZ: -1, muzzleX: 0, muzzleY: 0, muzzleZ: 0,
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

  /**
   * Turn tower `id` into form `formId` (one of its def.upgrades), paying the
   * upgrade cost. The tower keeps its place, kills and cooldown; selling it
   * later refunds part of everything spent. Returns { ok, reason, tower }.
   */
  upgradeTower(id, formId) {
    const t = this.towers.get(id);
    if (!t) return { ok: false, reason: UpgradeError.NoTower };
    if (this.lost) return { ok: false, reason: UpgradeError.GameOver, tower: t };
    const next = TOWER_FORMS[formId];
    if (!next || !t.def.upgrades.includes(formId)) return { ok: false, reason: UpgradeError.NotAnUpgrade, tower: t };
    if (this.money < next.upgradeCost) return { ok: false, reason: UpgradeError.Money, tower: t };
    this.money -= next.upgradeCost;
    t.spent += next.upgradeCost;
    t.def = next;
    t.charge = 0;
    t.cooldown = Math.min(t.cooldown, next.interval);
    this.aimAt(t, t.x + t.aimX, t.z + t.aimZ); // the muzzle may have moved
    this.events.push({ kind: 'upgraded', tower: id, form: formId });
    return { ok: true, reason: null, tower: t };
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
