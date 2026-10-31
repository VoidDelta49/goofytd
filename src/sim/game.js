// Tower-defence state for one match: the nav grid, towers, cows, spawners,
// waves, money and the milk. Advanced by tick(dt) at the fixed sim rate,
// next to the player. Pure (no three.js, no DOM) and seeded, so the same
// inputs give the same match: needed for replays and lockstep PvP later.

import { Aabb } from './collision.js';
import { v3 } from './vec3.js';
import { NavGrid } from './navgrid.js';
import { CowHash } from './cowhash.js';
import { ABILITY_COOLDOWN, ABILITY_WINDUP, CowPool, COW_TYPES, COW_TYPE_LIST, HEAL_PULSE, MAX_COW_RADIUS, waveMix, pickFromMix, cowHidden, tri } from './cows.js';
import { SELL_REFUND, WRECK_REFUND, REPAIR_DELAY, REPAIR_RATE, TOWER_TYPES, TOWER_FORMS, towerMaxHp } from './towers.js';
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
    /**
     * Every this many waves is a boss wave (0 or null: never): half the usual
     * herd, no surprises, and BIG MAMA BESSIE walks in bossDelay s after it starts.
     * Each boss after the first has bossHpGrowth × more HP on top of the wave scaling.
     */
    bossEvery: 10,
    bossDelay: 6,
    bossHpGrowth: 0.5,
    maxCows: 4096,
    /** Farmers sharing this match (LAN co-op). Everyone spends from one shared wallet. */
    players: 1,
    /** Each extra farmer adds this much to every bounty, wave bonus and cash surprise (and the starting moolah). */
    coopIncome: 0.5,
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

/** A Headbutt Heifer goes for a tower this close (cow edge to tower edge): the same reach, for the same reason. */
export const RAM_REACH = BLAST_TRIGGER;

/** War Moo-st: seconds to roll in and to clear, and how much of their range towers lose at full fog. */
export const FOG_IN = 3;
export const FOG_OUT = 4;
export const FOG_SIGHT_CUT = 0.35;

/** The cow type boss waves bring. */
export const BOSS_COW = 'bigmama';

/** Auto-upgrade: seconds between automatic buys, so each one gets its own pop and sound. */
export const AUTO_EVERY = 0.4;

/** Fast-forward settings (sim ticks per real tick). The `speed` command cycles through them. */
export const GAME_SPEEDS = Object.freeze([1, 2, 3]);

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
    /** Cows bucketed by position, so tower targeting only scans nearby cells. */
    this.cowHash = new CowHash(this.grid);
    // Auto-upgrade is a farm setting, not part of a run: restarting keeps it.
    /** When on, tick() buys towers' next upgrades by itself (see updateAutoUpgrade). */
    this.autoUpgrade = false;
    /** Form id -> the variant auto-upgrade takes at that path choice (set by buying one, or the `autopath` command). */
    this.autoPick = Object.create(null);
    /**
     * Fast-forward: how many sim ticks the client runs per real tick (one of
     * GAME_SPEEDS). The sim itself never reads it (every tick is still 1/64 s,
     * so the match plays out identically, only sooner); it lives here so co-op
     * machines agree on the pace through the `speed` command. Survives restarts.
     */
    this.timeScale = 1;
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
    this.players = Math.max(1, this.cfg.players | 0);
    this.money = Math.round(this.cfg.startMoney * this.incomeMult);
    this.milk = this.cfg.milk;
    this.lost = false;
    this.wave = 0;
    this.kills = 0;
    this.time = 0;
    this.nextWaveIn = this.cfg.firstWave;
    this.autoT = 0;
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
    // Cows popping out of a dead Mama draw from their own stream too, so kills never shift wave or surprise draws.
    this.splitRng = mulberry32((this.cfg.seed ^ 0xca1fca1f) >>> 0);
    /** Vet Cow heal clock (s until the next pulse). */
    this.healTimer = HEAL_PULSE;
    /** Bounties × bountyMult while bountyTime > 0 (Happy Hour). */
    this.bountyMult = 1;
    this.bountyTime = 0;
    /** Moolah the Cheese Vaults paid at the start of the last wave. */
    this.lastInterest = 0;
    /** War Moo-st: fogT s into a fog lasting fogDur s (0 = clear). Towers see sight × their range. */
    this.fogT = 0;
    this.fogDur = 0;
    this.sight = 1;
    // Bosses draw from their own stream too, so a boss wave never shifts the regular or surprise draws.
    this.bossRng = mulberry32((this.cfg.seed ^ 0xb055b055) >>> 0);
    /** Bosses on their way: { t (s until she walks in), announced }. */
    this.bossQueue = [];
    /** Bosses spawned this match (the next one is tougher). */
    this.bossCount = 0;
    /** Cow id -> live boss state (see bossAct). Insertion-ordered, so it iterates the same on every machine. */
    this.bosses = new Map();
    /** Overclock: towers reload fireRate × as fast for fireRateTime s. */
    this.fireRate = 1;
    this.fireRateTime = 0;
    /** Super Moon: towers see sightBoost × as far for sightBoostTime s (on top of any fog). */
    this.sightBoost = 1;
    this.sightBoostTime = 0;
    /** Moonwalk: walking cows back away from the milk while moonwalkT > 0. */
    this.moonwalkT = 0;
    /** GPS Outage: walkers go sideways (round in circles) while gpsT > 0. */
    this.gpsT = 0;
    /** Ice Rink: walkers are faster but can barely steer while iceT > 0. */
    this.iceT = 0;
    /** Opposite Day: cows reaching the milk fill it up instead while milkGiftT > 0. */
    this.milkGiftT = 0;
  }

  /** Co-op: income × this (1 alone, 1.5 with two farmers, 2 with three, 2.5 with four). */
  get incomeMult() { return 1 + this.cfg.coopIncome * (this.players - 1); }

  /** Pay out income (bounties, wave bonus, cash surprises), scaled by the co-op multiplier. Refunds don't go through here. */
  earn(amount) {
    const paid = Math.round(amount * this.incomeMult);
    this.money += paid;
    return paid;
  }

  /** HP multiplier for cows spawned this wave. */
  get hpScale() { return 1 + this.cfg.hpPerWave * Math.max(0, this.wave - 1); }

  // ---- waves and spawning -------------------------------------------------

  /** Start the next wave now (also how manual-wave levels advance). */
  startWave() {
    if (this.lost || this.spawners.length === 0) return;
    this.wave++;
    const boss = this.isBossWave(this.wave);
    let total = this.cfg.waveBase + this.cfg.waveGrowth * (this.wave - 1);
    // A boss wave brings half the herd: she's the main course.
    if (boss) total = Math.ceil(total / 2);
    this.spawners.forEach((s, k) => {
      s.queue += Math.floor(total / this.spawners.length) + (k < total % this.spawners.length ? 1 : 0);
    });
    this.earn(this.cfg.waveBonus);
    this.payInterest();
    this.nextWaveIn = null;
    this.spawnHold = 0;
    this.spawnRate = 1;
    if (boss) {
      // The boss is this wave's surprise: no others, and it counts toward the drought guarantee.
      this.queueBoss();
      this.wavesWithoutSurprise = 0;
    } else if (this.cfg.surprises) this.rollSurprises();
    this.events.push({ kind: 'wave', wave: this.wave, boss });
  }

  isBossWave(wave) {
    const n = this.cfg.bossEvery;
    return n > 0 && wave > 0 && wave % n === 0;
  }

  /**
   * Cheese Vaults: each pays `interest` of the moolah banked as the wave starts
   * (all worked out from the same balance, so build order doesn't matter), up to its `interestCap`.
   * Saves the total in lastInterest (a hand-started wave's event never reaches the client).
   */
  payInterest() {
    const base = this.money;
    let paid = 0;
    for (const t of this.towers.values()) {
      const d = t.def;
      if (d.interest > 0) paid += Math.min(d.interestCap, Math.floor(base * d.interest));
      if (d.income > 0) paid += d.income; // Milk Money Printer: a flat payout, saved up or not
    }
    this.money += paid;
    this.lastInterest = paid;
    if (paid) this.events.push({ kind: 'interest', amount: paid });
  }

  get spawning() { return this.runs.some(holdsWave) || this.bossQueue.length > 0 || this.spawners.some((s) => s.queue > 0); }

  // ---- bosses -------------------------------------------------------------

  /**
   * BIG MAMA BESSIE walks in `delay` s from now (announced on the next tick).
   * Boss waves call this; also handy from the console: goofytd.game.queueBoss(0).
   */
  queueBoss(delay = this.cfg.bossDelay) {
    if (this.spawners.length === 0) return false;
    this.bossQueue.push({ t: delay, announced: false });
    return true;
  }

  updateBossQueue(dt) {
    const q = this.bossQueue;
    for (let k = q.length - 1; k >= 0; k--) {
      const b = q[k];
      if (!b.announced) {
        b.announced = true;
        this.announce('boss', 'BOSS WAVE! The ground is shaking... BIG MAMA BESSIE wants her milk back!');
      }
      b.t -= dt;
      if (b.t > 0) continue;
      q.splice(k, 1);
      this.spawnBoss();
    }
  }

  /** Spawn a boss at a spawner now. Returns its slot (or -1). */
  spawnBoss(type = COW_TYPES[BOSS_COW]) {
    const s = this.spawners[Math.floor(this.bossRng() * this.spawners.length)];
    const hp = type.hp * this.hpScale * (1 + this.cfg.bossHpGrowth * this.bossCount);
    const i = this.spawnCow(type, s.x, s.z, hp, this.bossRng, 0);
    if (i < 0) return i;
    this.bossCount++;
    const B = type.boss;
    this.bosses.set(this.cows.id[i], {
      type, no: this.bossCount, phase: 0,
      stompCd: B.stomp.first, wallopCd: 0,
      /** What she's doing ('stomp', 'wallop', 'bellow' or null), for actT more s of actLen. */
      act: null, actT: 0, actLen: 0, target: 0,
    });
    this.events.push({ kind: 'bossspawn', id: this.cows.id[i], x: s.x, z: s.z, name: type.name });
    this.tracked.set(this.cows.id[i], {
      onKill: (game) => game.announce('boss', `${type.name} IS DOWN! The milk is safe... for now.`),
      onEscape: (game) => game.announce('boss', `${type.name} chugged ${type.damage} milk and waddled off. Rude.`),
    });
    return i;
  }

  /**
   * The boss at slot i: stomps, wallops and bellows. Returns true while she
   * stands still (an attack winding up, or the tick it lands). Like cowAbility,
   * holds tower ids (never slots) and never removes a cow; summoned cows are
   * appended above i, so updateCows' backwards loop is safe.
   */
  bossAct(i, type, dt) {
    const { cows } = this;
    const b = this.bosses.get(cows.id[i]);
    if (!b) return false;
    const B = type.boss, x = cows.x[i], z = cows.z[i];
    // Crossing a phase line interrupts whatever she was doing.
    if (b.act !== 'bellow' && b.phase < B.summon.at.length && cows.hp[i] < B.summon.at[b.phase] * cows.maxHp[i]) {
      b.phase++;
      this.startBossAct(i, b, 'bellow', B.summon.bellow, 0);
      this.announce('boss', b.phase === B.summon.at.length
        ? 'MAMA IS ANGRY! She called for backup and she is NOT slowing down!'
        : "MAMA'S BABIES! Big Mama Bessie is calling the herd!", x, z);
      return true;
    }
    if (b.act) {
      b.actT -= dt;
      if (b.actT > 0) return true;
      const act = b.act;
      b.act = null;
      if (act === 'bellow') this.bossSummon(b, x, z);
      else if (act === 'stomp') {
        this.bossStomp(b, x, z);
        b.stompCd = this.bossAngry(i, type) ? B.stomp.angryCooldown : B.stomp.cooldown;
      } else if (act === 'wallop') {
        b.wallopCd = B.wallop.cooldown;
        const t = this.towers.get(b.target);
        if (t) { // sold or wrecked mid wind-up: a whiff
          this.events.push({ kind: 'wallop', tower: t.id, x: t.x, z: t.z, cx: x, cz: z });
          this.damageTower(t, B.wallop.damage);
        }
      }
      return true;
    }
    b.stompCd -= dt;
    b.wallopCd -= dt;
    if (b.stompCd <= 0 && this.towerWithin(x, z, B.stomp.radius)) {
      this.startBossAct(i, b, 'stomp', B.stomp.windup, 0);
      return true;
    }
    if (b.wallopCd <= 0) {
      const t = this.towerAt(x, z, type.radius + RAM_REACH);
      if (t) {
        this.startBossAct(i, b, 'wallop', B.wallop.windup, t.id);
        const dx = t.x - x, dz = t.z - z, len = Math.sqrt(dx * dx + dz * dz) || 1;
        cows.vx[i] = (dx / len) * 1e-3; // face the tower without moving
        cows.vz[i] = (dz / len) * 1e-3;
        return true;
      }
    }
    return false;
  }

  startBossAct(i, b, act, time, target) {
    b.act = act;
    b.actT = b.actLen = time;
    b.target = target;
    const { cows } = this;
    this.events.push({ kind: 'bosswindup', act, id: cows.id[i], x: cows.x[i], z: cows.z[i], tower: target });
  }

  bossAngry(i, type) { return this.cows.hp[i] < type.enrageBelow * this.cows.maxHp[i]; }

  /** True if any tower's footprint is within `reach` m of (x, z). Any distance (loops over every tower). */
  towerWithin(x, z, reach) {
    const r2 = reach * reach;
    for (const t of this.towers.values()) if (boxDist2(t.aabb, x, z) <= r2) return true;
    return false;
  }

  /** Hoof Stomp lands: every tower in reach is dented and stunned (stuns never stack, the longest wins). */
  bossStomp(b, x, z) {
    const S = b.type.boss.stomp, r2 = S.radius * S.radius;
    const hit = [];
    for (const t of this.towers.values()) if (boxDist2(t.aabb, x, z) <= r2) hit.push(t);
    for (const t of hit) {
      if (t.def.attack) t.stunT = Math.max(t.stunT, S.stun);
      this.damageTower(t, S.damage);
    }
    this.events.push({ kind: 'stomp', x, z, radius: S.radius, hit: hit.length });
  }

  /** "MAMA'S BABIES!": cows of the summon type pop out around her at this wave's HP (one more per later boss). */
  bossSummon(b, x, z) {
    const sm = b.type.boss.summon, child = COW_TYPES[sm.type];
    const hp = child.hp * this.hpScale;
    let n = 0;
    for (let k = 0; k < sm.count + (b.no - 1); k++) if (this.spawnCow(child, x, z, hp, this.bossRng, 3) >= 0) n++;
    this.events.push({ kind: 'bellow', x, z, count: n, phase: b.phase });
  }

  /**
   * The boss health bar: the first boss on the field, or null.
   * { name, hp, maxHp, phase (0, 1, 2…), phases, angry, act, count (bosses alive) }.
   */
  bossStatus() {
    if (this.bosses.size === 0) return null;
    const { cows } = this;
    let out = null;
    for (const [id, b] of this.bosses) {
      // Slots move (swap-remove), so look the cow up by id. Bosses are few.
      let i = -1;
      for (let k = 0; k < cows.count; k++) if (cows.id[k] === id) { i = k; break; }
      if (i < 0) continue;
      if (!out) {
        out = {
          name: b.type.name, hp: Math.max(0, cows.hp[i]), maxHp: cows.maxHp[i], phase: b.phase,
          phases: b.type.boss.summon.at, angry: this.bossAngry(i, b.type), act: b.act, count: 0,
        };
      }
      out.count++;
    }
    return out;
  }

  /** Forget bosses that died or reached the milk this tick. */
  forgetBosses() {
    if (this.bosses.size === 0) return;
    for (const ev of this.events) if ((ev.kind === 'kill' || ev.kind === 'drink') && this.bosses.has(ev.id)) this.bosses.delete(ev.id);
  }

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
    let lastSpawn = -1;
    steps.forEach((s, k) => { if (s.spawn) lastSpawn = k; });
    this.runs.push({ def, t: -delay, steps, next: 0, streams: [], at: null, lastSpawn });
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
    if (from === 'flank' || from === 'drop') {
      const p = from === 'flank' ? this.flankPoint() : this.dropPoint();
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

  /** A walkable cell anywhere on the field with a path to the milk, at least 25 m from it (cows dropped from the sky). */
  dropPoint() {
    const { grid } = this, r = this.surpriseRng;
    for (let tries = 0; tries < 60; tries++) {
      const i = Math.floor(r() * grid.w * grid.h);
      if (!grid.walkable(i) || grid.goal[i] || !(grid.dist[i] < Infinity)) continue;
      const x = grid.centerX(i), z = grid.centerZ(i);
      if ((x - this.milkX) ** 2 + (z - this.milkZ) ** 2 < 25 * 25) continue;
      return { x, z };
    }
    return null;
  }

  updateSurprises(dt) {
    const hpScale = this.hpScale;
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
    this.updateBossQueue(dt);
    if (this.spawnHold > 0) this.spawnHold -= dt;
    const mix = waveMix(this.wave);
    const hpScale = this.hpScale;
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
  spawnCow(type, x, z, hp = type.hp, rng = this.rng, spread = this.cfg.spawnSpread) {
    let sx = x + (rng() - 0.5) * spread, sz = z + (rng() - 0.5) * spread;
    const cell = this.grid.cellAt(sx, sz);
    if (cell < 0 || !this.grid.walkable(cell)) { sx = x; sz = z; }
    // Herd spread inside a cell, narrower for wide cows so they don't clip the towers beside the path.
    const off = Math.min(0.6 * this.grid.cell, Math.max(0, this.grid.cell - 2 * type.radius));
    const i = this.cows.spawn(type, sx, sz, (rng() - 0.5) * off, (rng() - 0.5) * off);
    if (i >= 0) {
      this.cows.hp[i] = this.cows.maxHp[i] = hp;
      if (type.shield > 0) this.cows.shieldHp[i] = type.shield * (hp / type.hp);
    }
    return i;
  }

  // ---- simulation ---------------------------------------------------------

  tick(dt) {
    this.events.length = 0;
    if (this.lost) return;
    this.time += dt;
    this.updateAutoUpgrade(dt);
    this.updateSpawners(dt);
    if (this.bountyTime > 0 && (this.bountyTime -= dt) <= 0) this.bountyMult = 1;
    if (this.fireRateTime > 0 && (this.fireRateTime -= dt) <= 0) this.fireRate = 1;
    if (this.sightBoostTime > 0 && (this.sightBoostTime -= dt) <= 0) this.sightBoost = 1;
    if (this.moonwalkT > 0) this.moonwalkT -= dt;
    if (this.gpsT > 0) this.gpsT -= dt;
    if (this.iceT > 0) this.iceT -= dt;
    if (this.milkGiftT > 0) this.milkGiftT -= dt;
    this.updateFog(dt);
    this.updateCows(dt);
    this.updateHeals(dt);
    this.updateTowers(dt);
    this.updateProjectiles(dt);
    this.updateZones(dt);
    this.updateBurns(dt);
    this.forgetBosses();
    this.watchTracked();
  }

  updateCows(dt) {
    const { cows, grid } = this;
    // Aura cows by position (never slots: kills move slots before towers and damage read these).
    const guards = (this.guards ??= []), yawns = (this.yawns ??= []);
    guards.length = yawns.length = 0;
    const turn = Math.min(1, dt * 8);
    // Ice Rink: hardly any grip, so cows overshoot every corner.
    const iceTurn = Math.min(1, dt * 0.7);
    // Backwards, so remove() (which moves the last cow into slot i) never skips one.
    for (let i = cows.count - 1; i >= 0; i--) {
      const type = COW_TYPE_LIST[cows.type[i]];
      const x = cows.x[i], z = cows.z[i];
      cows.prevX[i] = x;
      cows.prevZ[i] = z;
      cows.hitAge[i] += dt;
      if (type.regen > 0 && cows.hp[i] < cows.maxHp[i]) cows.hp[i] = Math.min(cows.maxHp[i], cows.hp[i] + type.regen * cows.maxHp[i] * dt);
      if (type.guard) guards.push(x, z, type.guard.radius, type.guard.mult);
      if (type.yawn) yawns.push(x, z, type.yawn.radius, type.yawn.mult);
      if (cows.hasteT[i] > 0 && (cows.hasteT[i] -= dt) <= 0) cows.hasteMult[i] = 1;
      const cell = grid.cellAt(x, z);
      if (cell >= 0 && grid.goal[cell]) {
        if (type.steal > 0 && this.milkGiftT <= 0) {
          const took = Math.min(this.money, type.steal);
          this.money -= took;
          this.events.push({ kind: 'steal', x, z, amount: took });
        }
        // Opposite Day: it brings milk instead of drinking it (never over a full tank).
        const gift = this.milkGiftT > 0;
        if (gift) this.milk = Math.min(this.cfg.milk, this.milk + type.damage);
        else this.milk -= type.damage;
        this.events.push({ kind: 'drink', x, z, id: cows.id[i], gift });
        cows.remove(i);
        continue;
      }
      // Headbutt Heifers, Cud Spitters and bosses stand still while they wind up and hit.
      if ((type.boss ? this.bossAct(i, type, dt) : type.windup > 0 && this.cowAbility(i, type, dt))) {
        cows.prevX[i] = cows.x[i];
        cows.prevZ[i] = cows.z[i];
        if (cows.slowTime[i] > 0) cows.slowTime[i] -= dt;
        continue;
      }
      // Blink, lay, swap: one timer, paused while stunned or tipped.
      if (cows.periodT[i] > 0 && !(cows.slowTime[i] > 0 && cows.slowMult[i] === 0) && (cows.periodT[i] -= dt) <= 0) {
        this.cowTrick(i, type);
        if (cows.x[i] !== x || cows.z[i] !== z) continue; // moved: walk on from there next tick
      }
      // Walkers follow the flow field; flyers (and Parkour Cows) go straight for the milk over everything.
      let tx = this.milkX + cows.offsetX[i], tz = this.milkZ + cows.offsetZ[i];
      const n = cell >= 0 && type.altitude <= 0 && !type.straight ? grid.next[cell] : -1;
      if (n >= 0) {
        tx = grid.centerX(n) + cows.offsetX[i];
        tz = grid.centerZ(n) + cows.offsetZ[i];
      }
      const dx = tx - x, dz = tz - z;
      const len = Math.sqrt(dx * dx + dz * dz);
      let speed = type.speed;
      if (type.enrageBelow > 0 && cows.hp[i] < type.enrageBelow * cows.maxHp[i]) speed *= type.enrageSpeed;
      if (type.sprint && (this.time + (cows.id[i] % 13) * 0.31) % type.sprint.period < type.sprint.time) speed *= type.sprint.mult;
      if (type.panic > 0) speed *= 1 + type.panic * Math.max(0, 1 - cows.hp[i] / cows.maxHp[i]);
      if (type.lastDash && this.cowPathDistance(i) < type.lastDash.within) speed *= type.lastDash.mult;
      if (cows.hasteT[i] > 0) speed *= cows.hasteMult[i];
      if (cows.slowTime[i] > 0) {
        speed *= cows.slowMult[i];
        cows.slowTime[i] -= dt;
      }
      let wx = len > 1e-9 ? (dx / len) * speed : 0;
      let wz = len > 1e-9 ? (dz / len) * speed : 0;
      // Moonwalk: walkers back away from the milk at half speed (never off the walkable cells).
      const walker = type.altitude <= 0 && !type.boss;
      const moon = walker && this.moonwalkT > 0;
      const gps = walker && this.gpsT > 0;
      const ice = walker && this.iceT > 0;
      if (moon) { wx *= -0.5; wz *= -0.5; }
      if (gps) {
        // Turn the wish 90° (left or right by cow id): the herd walks in circles.
        const sgn = cows.id[i] & 1 ? 1 : -1, ox = wx;
        wx = -wz * sgn; wz = ox * sgn;
      }
      if (ice) { wx *= 1.3; wz *= 1.3; }
      // Dizzy: weave across the way it's going (a triangle wave, by id so a herd doesn't sync).
      const zig = type.zigzag && len > 1e-9 && speed > 0;
      if (zig) {
        const w = tri(this.time * type.zigzag.freq + cows.id[i] * 0.37) * type.zigzag.amp;
        const ox = wx;
        wx += -wz * w; wz += ox * w;
      }
      const k = ice ? iceTurn : turn;
      // Ease velocity toward the wish so turns at cell corners look like turning.
      cows.vx[i] += (wx - cows.vx[i]) * k;
      cows.vz[i] += (wz - cows.vz[i]) * k;
      cows.x[i] = x + cows.vx[i] * dt;
      cows.z[i] = z + cows.vz[i] * dt;
      if (moon || gps || ice || zig) {
        const c = grid.cellAt(cows.x[i], cows.z[i]);
        if (c < 0 || !grid.walkable(c)) { cows.x[i] = x; cows.z[i] = z; cows.vx[i] = cows.vz[i] = 0; }
      }
      if (type.blastRadius > 0 && this.towerNear(cows.x[i], cows.z[i], type.radius + BLAST_TRIGGER)) {
        this.explodeCow(i, type);
      }
    }
    cows.version++; // positions moved: spatial caches rebuild
    if (this.milk <= 0) {
      this.milk = 0;
      this.lost = true;
      this.events.push({ kind: 'lost' });
    }
  }

  /** Haste cow i to × mult for `time` s (the stronger running haste wins). */
  hasteCow(i, mult, time) {
    const { cows } = this;
    if (cows.hasteT[i] > 0 && mult < cows.hasteMult[i]) return;
    cows.hasteMult[i] = mult;
    if (time > cows.hasteT[i]) cows.hasteT[i] = time;
  }

  /**
   * A cow's timed trick (its periodT ran out): Quantum blink along its path,
   * Chicken lays, Prankster swaps with the cow nearest the milk. Only appends
   * cows (laying), so it's safe in updateCows' backwards loop.
   */
  cowTrick(i, type) {
    const { cows, grid } = this;
    if (type.blink) {
      cows.periodT[i] += type.blink.every;
      let c = grid.cellAt(cows.x[i], cows.z[i]);
      for (let k = 0; k < type.blink.cells && c >= 0 && grid.next[c] >= 0 && !grid.goal[c]; k++) c = grid.next[c];
      if (c < 0) return;
      const x0 = cows.x[i], z0 = cows.z[i];
      this.teleportCow(i, grid.centerX(c) + cows.offsetX[i], grid.centerZ(c) + cows.offsetZ[i]);
      this.events.push({ kind: 'blink', id: cows.id[i], x0, z0, x: cows.x[i], z: cows.z[i] });
    } else if (type.lay) {
      cows.periodT[i] += type.lay.every;
      const child = COW_TYPES[type.lay.type];
      // Laid eggs come out of the splitter's stream, never the wave's.
      if (this.spawnCow(child, cows.x[i], cows.z[i], child.hp * this.hpScale, this.splitRng, 1) >= 0) {
        this.events.push({ kind: 'lay', x: cows.x[i], z: cows.z[i] });
      }
    } else if (type.swapEvery > 0) {
      cows.periodT[i] += type.swapEvery;
      let best = -1, bestD = this.cowPathDistance(i);
      for (let k = 0; k < cows.count; k++) {
        if (k === i) continue;
        const kt = COW_TYPE_LIST[cows.type[k]];
        if (kt.boss || kt.altitude > 0 || kt.friendly) continue;
        const d = this.cowPathDistance(k);
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best < 0) return;
      const x = cows.x[i], z = cows.z[i];
      this.teleportCow(i, cows.x[best], cows.z[best]);
      this.teleportCow(best, x, z);
      this.events.push({ kind: 'swap', x0: x, z0: z, x: cows.x[i], z: cows.z[i] });
    }
  }

  /**
   * Vet Cows: every HEAL_PULSE s each one gives every other cow within its
   * healRadius healRate × HEAL_PULSE of that cow's max HP back (never above max).
   * O(vets × cows) per pulse; vets are rare.
   */
  updateHeals(dt) {
    this.healTimer -= dt;
    if (this.healTimer > 0) return;
    this.healTimer += HEAL_PULSE;
    const { cows } = this;
    for (let v = 0; v < cows.count; v++) {
      const vt = COW_TYPE_LIST[cows.type[v]];
      if (!(vt.healRate > 0)) continue;
      const vx = cows.x[v], vz = cows.z[v], frac = vt.healRate * HEAL_PULSE;
      let healed = 0;
      for (let i = 0; i < cows.count; i++) {
        if (i === v || cows.hp[i] >= cows.maxHp[i]) continue;
        const r = vt.healRadius + COW_TYPE_LIST[cows.type[i]].radius;
        const dx = cows.x[i] - vx, dz = cows.z[i] - vz;
        if (dx * dx + dz * dz > r * r) continue;
        cows.hp[i] = Math.min(cows.maxHp[i], cows.hp[i] + frac * cows.maxHp[i]);
        healed++;
      }
      if (healed) this.events.push({ kind: 'heal', x: vx, z: vz, radius: vt.healRadius, healed });
    }
    // Cheerleaders: the same pulse fires up every other cow near them.
    for (let v = 0; v < cows.count; v++) {
      const ch = COW_TYPE_LIST[cows.type[v]].cheer;
      if (!ch) continue;
      for (const i of this.cowHash.near(cows, cows.x[v], cows.z[v], ch.radius + MAX_COW_RADIUS(), false)) {
        if (i === v) continue;
        const r = ch.radius + COW_TYPE_LIST[cows.type[i]].radius, dx = cows.x[i] - cows.x[v], dz = cows.z[i] - cows.z[v];
        if (dx * dx + dz * dz <= r * r) this.hasteCow(i, ch.mult, HEAL_PULSE + 0.05);
      }
    }
  }

  /**
   * Headbutt / spit for the cow at slot i. Returns true while it stands still
   * (winding up, or on the tick it lets go). Holds tower ids, never cow slots,
   * and never removes a cow, so it's safe in updateCows' backwards loop.
   */
  cowAbility(i, type, dt) {
    const { cows } = this;
    if (cows.slowTime[i] > 0 && cows.slowMult[i] === 0) {
      // Tipped over: it can't do anything, and a wind-up is lost.
      if (cows.abilityState[i] === ABILITY_WINDUP) { cows.abilityState[i] = ABILITY_COOLDOWN; cows.abilityTime[i] = type.abilityCooldown * 0.5; }
      return false;
    }
    if (cows.abilityState[i] === ABILITY_WINDUP) {
      cows.abilityTime[i] -= dt;
      if (cows.abilityTime[i] > 0) return true;
      cows.abilityState[i] = ABILITY_COOLDOWN;
      cows.abilityTime[i] = type.abilityCooldown;
      const t = this.towers.get(cows.abilityTarget[i]);
      if (!t) return true; // sold or wrecked mid wind-up: a whiff
      const x = cows.x[i], z = cows.z[i];
      if (type.ramDamage > 0) {
        this.events.push({ kind: 'bonk', tower: t.id, x: t.x, z: t.z, cx: x, cz: z });
        this.damageTower(t, type.ramDamage);
      } else {
        this.events.push({ kind: 'spit', tower: t.id, x0: x, z0: z, x1: t.x, y1: t.def.height * 0.8, z1: t.z });
        t.stunT = Math.max(t.stunT, type.spitStun);
        this.damageTower(t, type.spitDamage);
      }
      return true;
    }
    if (cows.abilityTime[i] > 0) { cows.abilityTime[i] -= dt; return false; }
    const x = cows.x[i], z = cows.z[i];
    const t = type.ramDamage > 0 ? this.towerAt(x, z, type.radius + RAM_REACH) : this.spitTarget(x, z, type.spitRange);
    if (!t) return false;
    cows.abilityState[i] = ABILITY_WINDUP;
    cows.abilityTime[i] = type.windup;
    cows.abilityTarget[i] = t.id;
    // Face the tower (the renderer turns cows to their velocity) without moving.
    const dx = t.x - x, dz = t.z - z, len = Math.sqrt(dx * dx + dz * dz) || 1;
    cows.vx[i] = (dx / len) * 1e-3;
    cows.vz[i] = (dz / len) * 1e-3;
    this.events.push({ kind: 'windup', x, z, id: cows.id[i], tower: t.id, ram: type.ramDamage > 0 });
    return true;
  }

  /** Nearest tower that shoots, isn't stunned, within `range` m of (x, z) (to its edge); ties go to the older tower. */
  spitTarget(x, z, range) {
    let best = null, bestD = range * range;
    for (const t of this.towers.values()) {
      if (!t.def.attack || t.stunT > 0) continue;
      const d = boxDist2(t.aabb, x, z);
      if (d <= bestD && (best === null || d < bestD)) { best = t; bestD = d; }
    }
    return best;
  }

  /** Knock `amount` HP off tower t; at 0 it's wrecked (WRECK_REFUND paid back). Returns true if it went. */
  damageTower(t, amount) {
    t.hp -= amount;
    t.lastHit = this.time;
    if (t.hp > 0) return false;
    this.wreckTower(t);
    return true;
  }

  wreckTower(t) {
    this.removeTower(t);
    this.grid.rebuild();
    const refund = Math.floor(t.spent * WRECK_REFUND);
    this.money += refund;
    this.events.push({ kind: 'destroyed', tower: t.id, name: t.def.name, x: t.x, z: t.z, cause: 'bonk', refund });
  }

  /**
   * War Moo-st: fog rolls in over FOG_IN s, sits, and clears over the last
   * FOG_OUT s of `time`. Starting it again while it's up just makes it last
   * longer from where it is now.
   */
  startFog(time) {
    const level = this.fogLevel;
    this.fogT = level * FOG_IN;
    this.fogDur = this.fogT + Math.max(time, FOG_IN + FOG_OUT);
  }

  /** 0 (clear) .. 1 (thick). */
  get fogLevel() {
    if (this.fogDur <= 0) return 0;
    const t = this.fogT, left = this.fogDur - t;
    return Math.max(0, Math.min(1, t / FOG_IN, left / FOG_OUT));
  }

  updateFog(dt) {
    if (this.fogDur > 0) {
      this.fogT += dt;
      if (this.fogT >= this.fogDur) this.fogT = this.fogDur = 0;
    }
    this.sight = (1 - FOG_SIGHT_CUT * this.fogLevel) * this.sightBoost;
  }

  /** Bounties are worth `mult` × for `time` s (a stronger running boost isn't cut short). */
  boostBounty(mult, time) {
    if (this.bountyTime > 0 && this.bountyMult > mult) return;
    this.bountyMult = mult;
    this.bountyTime = Math.max(this.bountyTime, time);
  }

  /** Towers reload `mult` × as fast for `time` s (a stronger running overclock isn't cut short). */
  overclock(mult, time) {
    if (this.fireRateTime > 0 && this.fireRate > mult) return;
    this.fireRate = mult;
    this.fireRateTime = Math.max(this.fireRateTime, time);
  }

  /** Towers see `mult` × as far for `time` s. */
  boostSight(mult, time) {
    if (this.sightBoostTime > 0 && this.sightBoost > mult) return;
    this.sightBoost = mult;
    this.sightBoostTime = Math.max(this.sightBoostTime, time);
  }

  /** Walking cows back away from the milk for `time` s. */
  startMoonwalk(time) { this.moonwalkT = Math.max(this.moonwalkT, time); }

  /** Move cow i to (x, z) instantly (no interpolation streak) and stop it. */
  teleportCow(i, x, z) {
    const { cows } = this;
    cows.x[i] = cows.prevX[i] = x;
    cows.z[i] = cows.prevZ[i] = z;
    cows.vx[i] = cows.vz[i] = 0;
    cows.version++;
  }

  /**
   * Take cow i off the field: no bounty, no milk lost, no hooks. Bosses can't
   * be taken. Only call while iterating cows backwards (or not at all).
   */
  abductCow(i) {
    const { cows } = this;
    if (COW_TYPE_LIST[cows.type[i]].boss) return false;
    const id = cows.id[i], x = cows.x[i], z = cows.z[i];
    this.tracked.delete(id);
    this.events.push({ kind: 'abduct', id, x, z });
    this.events.push({ kind: 'splash', x, y: 2, z, radius: 1.4, color: 0x7affd0 });
    cows.remove(i);
    return true;
  }

  /** GPS Outage: walkers wander sideways for `time` s. */
  startGpsOutage(time) { this.gpsT = Math.max(this.gpsT, time); }

  /** Ice Rink: walkers slide around for `time` s. */
  startIce(time) { this.iceT = Math.max(this.iceT, time); }

  /** Opposite Day: cows that reach the milk top it up for `time` s. */
  startMilkGift(time) { this.milkGiftT = Math.max(this.milkGiftT, time); }

  /**
   * Pop cow i open on the spot (no bounty): what's inside (its splitInto)
   * comes out. Only call while iterating cows backwards (or not at all).
   */
  burstCow(i) {
    const { cows } = this;
    const type = COW_TYPE_LIST[cows.type[i]];
    const x = cows.x[i], z = cows.z[i];
    this.tracked.delete(cows.id[i]);
    cows.remove(i);
    if (type.splitInto) this.splitCow(type, x, z);
  }

  /** Turn cow i into a `type` cow where it stands, keeping its share of health (Costume Party). Not for bosses. */
  setCowType(i, type) {
    const { cows } = this;
    const frac = cows.maxHp[i] > 0 ? cows.hp[i] / cows.maxHp[i] : 1;
    cows.type[i] = type.index;
    cows.maxHp[i] = type.hp * this.hpScale;
    cows.hp[i] = frac * cows.maxHp[i];
    cows.abilityState[i] = ABILITY_COOLDOWN;
    cows.abilityTime[i] = type.abilityCooldown * 0.5;
    cows.version++;
  }

  /** Knock every walking cow over for `time` s (cow tipping): speed 0, overriding any slow. */
  tipCows(time) {
    const { cows } = this;
    let n = 0;
    for (let i = 0; i < cows.count; i++) {
      const type = COW_TYPE_LIST[cows.type[i]];
      if (type.altitude > 0 || type.boss) continue; // you can't tip MAMA
      cows.slowMult[i] = 0;
      cows.slowTime[i] = Math.max(cows.slowTime[i], time);
      n++;
    }
    return n;
  }

  /**
   * True if some tower's footprint is within `reach` metres of (x, z) in XZ.
   * Looks only at the towers in the 5x5 cells around the point (reach must stay under 2 cells).
   */
  towerNear(x, z, reach) {
    return this.towerAt(x, z, reach) !== null;
  }

  /** The nearest tower whose footprint is within `reach` m of (x, z), or null. Same 5x5-cell limit as towerNear. */
  towerAt(x, z, reach) {
    const { grid } = this;
    const cx = grid.cellX(x), cz = grid.cellZ(z);
    let best = null, bestD = reach * reach;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!grid.inBounds(cx + dx, cz + dz)) continue;
        const id = grid.tower[grid.index(cx + dx, cz + dz)];
        if (!id) continue;
        const t = this.towers.get(id), d = boxDist2(t.aabb, x, z);
        if (d <= bestD && (best === null || d < bestD || (d === bestD && id < best.id))) { best = t; bestD = d; }
      }
    }
    return best;
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
    // Scarecrows: towers in a booster's reach fire faster (the best booster counts, they don't stack).
    let boosters = null;
    for (const t of this.towers.values()) if (t.def.boost) (boosters ??= []).push(t);
    for (const t of this.towers.values()) {
      const def = t.def;
      // Dents patch themselves up once the headbutting stops.
      if (t.hp < t.maxHp && this.time - t.lastHit >= REPAIR_DELAY) t.hp = Math.min(t.maxHp, t.hp + REPAIR_RATE * t.maxHp * dt);
      if (!def.attack) continue;
      if (t.stunT > 0) {
        // Gummed up with cud: no shots, the barrels spin down, and the cooldown doesn't bank shots.
        t.stunT -= dt;
        t.cooldown = Math.max(0, t.cooldown - dt);
        if (def.spinDown > 0) t.charge = Math.max(0, t.charge - def.spinDown * dt);
        continue;
      }
      let boost = 1;
      if (boosters) {
        for (const b of boosters) {
          if (b === t) continue;
          const dx = b.x - t.x, dz = b.z - t.z, r = b.def.boost.range;
          if (dx * dx + dz * dz <= r * r) boost = Math.max(boost, 1 + b.def.boost.rate);
        }
      }
      // Sleepy cows: towers near a yawn reload slower (the sleepiest one counts).
      const yw = this.yawns;
      if (yw && yw.length) {
        let m = 1;
        for (let k = 0; k < yw.length; k += 4) {
          const dx = yw[k] - t.x, dz = yw[k + 1] - t.z, r = yw[k + 2];
          if (dx * dx + dz * dz <= r * r && yw[k + 3] < m) m = yw[k + 3];
        }
        boost *= m;
      }
      t.boost = boost;
      t.cooldown -= dt * this.fireRate * boost;
      if (t.cooldown > 0) continue;
      const target = def.targeting(this, t);
      if (target < 0) {
        t.cooldown = 0;
        if (def.spinDown > 0) t.charge = Math.max(0, t.charge - def.spinDown * dt);
        continue;
      }
      this.aimAt(t, this.cows.x[target], this.cows.z[target]);
      // Every stunEvery-th volley curdles what it hits (attacks read t.stunning).
      t.volley++;
      t.stunning = def.stunEvery > 0 && t.volley % def.stunEvery === 0;
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
      // Statuses first (they never remove a cow), then the damage.
      if (p.fx) this.splashStatus(p.x1, p.z1, p.radius, p.fx, p.tower, p.air);
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
    const ct = COW_TYPE_LIST[cows.type[i]];
    // Contrarian: slow her and she speeds up (a stun is the biggest insult: double speed).
    if (ct.slowInvert) { if (factor < 1) this.hasteCow(i, Math.min(2, 1 / Math.max(factor, 0.5)), time); return; }
    const resist = ct.slowResist;
    if (resist > 0) factor += (1 - factor) * resist;
    if (cows.slowTime[i] <= 0 || factor <= cows.slowMult[i]) {
      cows.slowMult[i] = factor;
      if (time > cows.slowTime[i]) cows.slowTime[i] = time;
    }
  }

  /** Stun cow i (stopped dead) for `time` s; slow resistance (bosses) still applies. */
  stunCow(i, time) { this.slowCow(i, 0, time); }

  /**
   * A shell's statuses on every cow it splashes: fx { burn, chill, mark, stun }
   * (stun: seconds, or 0). Never removes a cow, so it runs before the damage.
   */
  splashStatus(x, z, radius, fx, towerId, air) {
    const { cows } = this;
    for (const i of this.cowHash.near(cows, x, z, radius + MAX_COW_RADIUS())) {
      const type = COW_TYPE_LIST[cows.type[i]];
      if ((type.altitude > 0) !== air || type.shellproof) continue;
      const dx = cows.x[i] - x, dz = cows.z[i] - z, r = radius + type.radius;
      if (dx * dx + dz * dz > r * r) continue;
      if (fx.burn) this.igniteCow(i, fx.burn.dps, fx.burn.time, fx.burn.spread ?? 0, towerId);
      if (fx.chill) { this.chillCow(i, fx.chill.vuln, fx.chill.time); this.slowCow(i, fx.chill.slow, fx.chill.time); }
      if (fx.mark) this.chillCow(i, fx.mark.vuln, fx.mark.time);
      if (fx.stun > 0) this.stunCow(i, fx.stun);
    }
  }

  /** Damage every cow within `radius` of (x, z): flyers for an airburst (`air`), otherwise walkers. */
  splash(x, z, radius, damage, tower, air = false) {
    const { cows } = this;
    // High-to-low like a backwards scan: a kill moves the last cow (already handled) into its slot.
    for (const i of this.cowHash.near(cows, x, z, radius + MAX_COW_RADIUS())) {
      const type = COW_TYPE_LIST[cows.type[i]];
      if ((type.altitude > 0) !== air) continue; // ground shells land under flyers; airbursts go off over walkers
      if (type.shellproof) continue; // Umbrella Cow
      const dx = cows.x[i] - x, dz = cows.z[i] - z;
      const r = radius + type.radius;
      if (dx * dx + dz * dz <= r * r) this.damageCow(i, damage, tower);
    }
  }

  /**
   * Returns true if the cow died. Only call while iterating cows backwards (or not at all).
   * `flash` false for damage over time (a slick, a burn), so cows don't strobe red.
   * `pierce` true for armour-piercing hits (the Cheddar Railgun).
   */
  damageCow(i, damage, tower, flash = true, pierce = false) {
    const { cows } = this;
    const type = COW_TYPE_LIST[cows.type[i]];
    // Mole Cow underground: nothing reaches her.
    if (type.burrow && cowHidden(type, cows.id[i], this.time, true)) return false;
    if (flash && (type.dodgeEvery > 0 || type.jamEvery)) {
      const n = ++cows.hitCount[i];
      if (type.dodgeEvery > 0 && n % type.dodgeEvery === 0) { this.events.push({ kind: 'dodge', id: cows.id[i], x: cows.x[i], z: cows.z[i] }); return false; }
      if (type.jamEvery && tower && n % type.jamEvery.n === 0 && tower.def.attack) {
        tower.stunT = Math.max(tower.stunT, type.jamEvery.time);
        this.events.push({ kind: 'jam', tower: tower.id, x: tower.x, z: tower.z });
      }
    }
    // Brain freeze makes a cow brittle: everything hurts more while it lasts.
    if (cows.chillTime[i] > 0) damage *= cows.chillMult[i];
    // Armor blunts direct hits (flash) only, never below a quarter of the hit; slicks, burns and railgun slugs go through.
    if (flash && !pierce && type.armor > 0) damage = Math.max(0.25 * damage, damage - type.armor);
    // Bodyguards: cows near one take less (the best guard counts).
    const gs = this.guards;
    if (gs && gs.length) {
      let m = 1;
      for (let k = 0; k < gs.length; k += 4) {
        const dx = cows.x[i] - gs[k], dz = cows.z[i] - gs[k + 1], r = gs[k + 2];
        if (dx * dx + dz * dz <= r * r && gs[k + 3] < m) m = gs[k + 3];
      }
      damage *= m;
    }
    // Bubble shields soak it first.
    if (cows.shieldHp[i] > 0) {
      const soak = Math.min(cows.shieldHp[i], damage);
      cows.shieldHp[i] -= soak;
      damage -= soak;
      if (cows.shieldHp[i] <= 0) this.events.push({ kind: 'pop', id: cows.id[i], x: cows.x[i], z: cows.z[i] });
    }
    cows.hp[i] -= damage;
    if (flash) cows.hitAge[i] = 0;
    if (cows.hp[i] > 0) {
      // Mitosis: past half health she splits (once; the copy can't split again).
      if (type.mitosis && !(cows.flags[i] & 2) && cows.hp[i] < 0.5 * cows.maxHp[i]) {
        cows.flags[i] |= 2;
        const x = cows.x[i], z = cows.z[i], hp = cows.hp[i], max = cows.maxHp[i];
        const k = this.spawnCow(type, x, z, max, this.splitRng, 1);
        if (k >= 0) { cows.hp[k] = hp; cows.flags[k] = 2; cows.shieldHp[k] = 0; this.events.push({ kind: 'mitosis', x, z }); }
      }
      return false;
    }
    // Phoenix: back up once.
    if (type.revive > 0 && !(cows.flags[i] & 1)) {
      cows.flags[i] |= 1;
      cows.hp[i] = type.revive * cows.maxHp[i];
      cows.burnTime[i] = 0;
      this.events.push({ kind: 'revive', id: cows.id[i], x: cows.x[i], z: cows.z[i] });
      return false;
    }
    const x = cows.x[i], z = cows.z[i];
    // An Auction Barn nearby sells the cow for more (the best barn in reach; whole moolah only).
    const mult = this.bankMult(x, z);
    // Bounty Hunters cash in their own kills (burns they lit count too).
    this.earn(type.bounty * this.bountyMult * mult * (tower?.def?.ownBounty ?? 1));
    this.kills++;
    if (tower) tower.kills++;
    this.events.push({ kind: 'kill', x, z, id: cows.id[i], mult });
    const burnS = cows.burnTime[i] > 0 ? cows.burnSpread[i] : 0;
    const burnD = cows.burnDps[i], burnT = cows.burnTime[i], burnTower = cows.burnSource[i];
    cows.remove(i);
    // Flambé: a burning cow that drops lights up the herd around it. Only sets burns, never removes a cow.
    if (burnS > 0) this.spreadBurn(x, z, burnS, burnD, burnT, burnTower);
    if (type.deathHaste || type.deathEmp || type.deathSpikes || type.deathHeal) this.cowLastWords(type, x, z);
    // Remove first, then append: the new cows land in slots above every slot a caller still holds.
    if (type.splitInto) this.splitCow(type, x, z);
    return true;
  }

  /**
   * What a cow does as it drops: Drama hastes the herd, Magnet jams towers,
   * Cactus spikes them, Paramedic heals the herd. Never removes a cow (towers may go).
   */
  cowLastWords(type, x, z) {
    const { cows } = this;
    const nearCows = (radius, fn) => {
      for (const k of this.cowHash.near(cows, x, z, radius + MAX_COW_RADIUS(), false)) {
        const r = radius + COW_TYPE_LIST[cows.type[k]].radius, dx = cows.x[k] - x, dz = cows.z[k] - z;
        if (dx * dx + dz * dz <= r * r) fn(k);
      }
    };
    if (type.deathHaste) { const h = type.deathHaste; nearCows(h.radius, (k) => this.hasteCow(k, h.mult, h.time)); }
    if (type.deathHeal) { const h = type.deathHeal; nearCows(h.radius, (k) => { cows.hp[k] = Math.min(cows.maxHp[k], cows.hp[k] + h.frac * cows.maxHp[k]); }); }
    if (type.deathEmp || type.deathSpikes) {
      const hit = [];
      const R = Math.max(type.deathEmp?.radius ?? 0, type.deathSpikes?.radius ?? 0);
      for (const t of this.towers.values()) if (boxDist2(t.aabb, x, z) <= R * R) hit.push(t);
      for (const t of hit) {
        const d2 = boxDist2(t.aabb, x, z);
        if (type.deathEmp && d2 <= type.deathEmp.radius ** 2 && t.def.attack) t.stunT = Math.max(t.stunT, type.deathEmp.stun);
        if (type.deathSpikes && d2 <= type.deathSpikes.radius ** 2) this.damageTower(t, type.deathSpikes.damage);
      }
      this.events.push({ kind: type.deathEmp ? 'emp' : 'spikes', x, z, radius: R, towers: hit.length });
    }
  }

  /** Light cow i: `dps` for `time` s (a weaker burn never replaces a hotter running one), spreading `spread` m on death. */
  igniteCow(i, dps, time, spread, towerId) {
    const { cows } = this;
    if (COW_TYPE_LIST[cows.type[i]].burnImmune) return;
    if (cows.burnTime[i] > 0 && dps < cows.burnDps[i]) return;
    cows.burnDps[i] = dps;
    cows.burnSpread[i] = spread;
    cows.burnSource[i] = towerId;
    if (time > cows.burnTime[i]) cows.burnTime[i] = time;
  }

  /** Brain-freeze cow i: × `vuln` damage taken for `time` s (the strongest running freeze wins). */
  chillCow(i, vuln, time) {
    const { cows } = this;
    if (COW_TYPE_LIST[cows.type[i]].chillImmune) return;
    if (cows.chillTime[i] > 0 && vuln < cows.chillMult[i]) return;
    cows.chillMult[i] = vuln;
    if (time > cows.chillTime[i]) cows.chillTime[i] = time;
  }

  spreadBurn(x, z, radius, dps, time, towerId) {
    const { cows } = this;
    let n = 0;
    for (const k of this.cowHash.near(cows, x, z, radius + MAX_COW_RADIUS(), false)) {
      const type = COW_TYPE_LIST[cows.type[k]];
      if (type.altitude > 0) continue;
      const r = radius + type.radius, dx = cows.x[k] - x, dz = cows.z[k] - z;
      if (dx * dx + dz * dz > r * r) continue;
      // Caught fire second-hand: it doesn't spread any further (no endless chain through a herd).
      if (cows.burnTime[k] <= 0 || dps >= cows.burnDps[k]) { this.igniteCow(k, dps, time * 0.75, 0, towerId); n++; }
    }
    if (n) this.events.push({ kind: 'flambe', x, z, radius, count: n });
  }

  /** Burns tick down and hurt (credited to the tower that lit them); freezes thaw. */
  updateBurns(dt) {
    const { cows } = this;
    for (let i = cows.count - 1; i >= 0; i--) {
      if (cows.chillTime[i] > 0 && (cows.chillTime[i] -= dt) <= 0) cows.chillMult[i] = 1;
      if (cows.burnTime[i] <= 0) continue;
      const d = cows.burnDps[i] * Math.min(dt, cows.burnTime[i]) * COW_TYPE_LIST[cows.type[i]].burnVuln;
      cows.burnTime[i] -= dt;
      this.damageCow(i, d, this.towers.get(cows.burnSource[i]), false);
    }
  }

  /** Bounty multiplier from the best Auction Barn whose reach covers (x, z) (1 if none). */
  bankMult(x, z) {
    let best = 1;
    for (const t of this.towers.values()) {
      const m = t.def.bountyMult;
      if (!(m > best)) continue;
      const dx = x - t.x, dz = z - t.z, r = t.def.range;
      if (dx * dx + dz * dz <= r * r) best = m;
    }
    return best;
  }

  /** A dead cow of `type` bursts into splitCount × splitInto at (x, z). */
  splitCow(type, x, z) {
    const child = COW_TYPES[type.splitInto];
    const hp = child.hp * this.hpScale;
    let n = 0;
    for (let k = 0; k < type.splitCount; k++) if (this.spawnCow(child, x, z, hp, this.splitRng, 1.5) >= 0) n++;
    if (n) this.events.push({ kind: 'split', x, z, count: n, type: child.id });
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
      cooldown: 0, charge: 0, kills: 0, shots: 0, volley: 0, stunning: false, boost: 1, aimX: 0, aimZ: -1, muzzleX: 0, muzzleY: 0, muzzleZ: 0,
      spent: p.type.cost,
      hp: towerMaxHp(p.type), maxHp: towerMaxHp(p.type), lastHit: -Infinity, stunT: 0,
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

  /** The form auto-upgrade takes next from `def`: its only upgrade, the remembered path, or the first path. Null when maxed. */
  autoNext(def) {
    const u = def.upgrades;
    if (u.length === 0) return null;
    if (u.length === 1) return u[0];
    const pick = this.autoPick[def.id];
    return pick && u.includes(pick) ? pick : u[0];
  }

  /**
   * Auto-upgrade: at most one buy every AUTO_EVERY seconds, the cheapest
   * affordable next level across all towers (ties: the oldest tower), so money
   * spreads over the whole defence instead of maxing one tower first.
   * Runs inside tick(), so its `upgraded` events (auto: true) reach the renderer and sound.
   */
  updateAutoUpgrade(dt) {
    if (!this.autoUpgrade) return;
    if (this.autoT > 0) { this.autoT -= dt; return; }
    let best = null, bestForm = null, bestCost = Infinity;
    for (const t of this.towers.values()) {
      const f = this.autoNext(t.def);
      if (f === null) continue;
      const cost = TOWER_FORMS[f].upgradeCost;
      if (cost <= this.money && cost < bestCost) { best = t; bestForm = f; bestCost = cost; }
    }
    if (!best) return;
    this.upgradeTower(best.id, bestForm);
    this.events[this.events.length - 1].auto = true;
    this.autoT = AUTO_EVERY;
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
    // Picking a path teaches auto-upgrade which way to take every tower like this one.
    if (t.def.upgrades.length > 1) this.autoPick[t.def.id] = formId;
    this.money -= next.upgradeCost;
    t.spent += next.upgradeCost;
    t.def = next;
    // A fresh coat of paint: upgrading also fully repairs it.
    t.hp = t.maxHp = towerMaxHp(next);
    t.charge = 0;
    t.cooldown = Math.min(t.cooldown, next.interval);
    this.aimAt(t, t.x + t.aimX, t.z + t.aimZ); // the muzzle may have moved
    this.events.push({ kind: 'upgraded', tower: id, form: formId, x: t.x, z: t.z });
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
/**
 * A surprise holds back the next wave until it has started and every cow it
 * brings has spawned. After that its banners and effects play on into the gap.
 */
function holdsWave(run) {
  return run.t < 0 || run.streams.length > 0 || run.next <= run.lastSpawn;
}

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
