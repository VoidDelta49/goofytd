// three.js presentation for the tower-defence layer: instanced cows, batched
// towers, the build ghost, spawn pads, shot tracers, lobbed shells, butter
// slicks and splash puffs. Reads Game state; never writes it.
//
// Draw calls are kept flat whatever is on the field: cows (one instanced draw,
// plus one for wings), towers (one BatchedMesh multi-draw), HP bars, goo,
// puffs, slicks, shells and tracers are each one draw. Cows and towers are
// culled per instance against the camera (with room for their shadows), and
// the camera's far plane follows the fog, so whatever the fog has swallowed is
// never drawn.

import * as THREE from 'three';
import { COW_TYPE_LIST } from '../sim/cows.js';
import { TOWER_FORMS } from '../sim/towers.js';
import { TowerBatch, EffectPool, boxesGeometry, uploadRange } from './batch.js';
import { frustumPlanes, sphereVisible, shadowedSphere, composeYXZ } from './cull.js';

const TRACER_LIFE = 0.07;
const PUFF_LIFE = 0.35;
const MAX_TRACERS = 512;
const MAX_SHELLS = 256;
const MAX_PUFFS = 96;
const MAX_ZONES = 64;
/** Seconds an upgraded tower takes to settle from its pop. */
const POP_TIME = 0.45;
/** Seconds a headbutted tower wobbles. */
const BONK_TIME = 0.35;
/** War Moo-st: fog near/far (m) and colour at full thickness. */
const MIST_NEAR = 6;
const MIST_FAR = 34;
const MIST_COLOR = 0xc8ced3;
/**
 * Cull sphere for a cow, in units of its scale, around a point 0.7 up from its
 * feet. 2.0 covers every pose about the feet: standing (farthest corner 1.42),
 * tipped on its side (1.97), a puffed-up Spitter (×1.2) and a flyer's wings.
 */
const COW_CULL_UP = 0.7;
const COW_CULL_R = 2.0;

export class TdRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../sim/game.js').Game} game
   * @param {{camera: THREE.PerspectiveCamera, sunOffset: THREE.Vector3, fitFar?: () => void}} [view]
   *   The Renderer. Without it nothing is culled (everything is drawn).
   */
  constructor(scene, game, view = null) {
    this.scene = scene;
    this.game = game;
    this.view = view;
    this.time = 0;
    this.planes = new Float64Array(24);
    this.viewProj = new THREE.Matrix4();
    this.sphere = new Float64Array(4);
    /** Instances drawn last frame, for benchmarks and tests. */
    this.stats = { cows: 0, cowsCulled: 0 };

    // Cows: one instanced draw for all of them. Instance k is the k-th cow that
    // survived culling this frame, not cow slot k.
    this.cowMesh = new THREE.InstancedMesh(cowGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), game.cows.capacity);
    this.cowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cowMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.cowMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.cowMesh.castShadow = true;
    this.cowMesh.receiveShadow = true;
    this.cowMesh.frustumCulled = false; // culled per instance in syncCows
    this.cowMesh.count = 0;
    scene.add(this.cowMesh);
    // Wings for flying cows: two instances per flyer, flapping, in a second instanced draw.
    this.wingMesh = new THREE.InstancedMesh(wingGeometry(), new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.6, side: THREE.DoubleSide }), game.cows.capacity * 2);
    this.wingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wingMesh.castShadow = true;
    this.wingMesh.frustumCulled = false;
    this.wingMesh.count = 0;
    scene.add(this.wingMesh);
    this.wingLocal = new THREE.Matrix4();
    this.wingTmp = new THREE.Matrix4();
    this.cowMatrix = new THREE.Matrix4();
    // Linear-space tint per cow type, converted once rather than per cow per frame.
    this.typeColors = COW_TYPE_LIST.map((t) => new THREE.Color(t.color));
    this.flash = new THREE.Color(1, 0, 0);
    this.fuse = new THREE.Color(1, 0.95, 0.3);
    this.goo = new THREE.Color(0.85, 0.62, 0.25);
    this.rage = new THREE.Color(1, 0.15, 0.1);
    this.healGlow = new THREE.Color(0.3, 1, 0.45);
    this.ice = new THREE.Color(0.6, 0.85, 1);
    this.ember = new THREE.Color(1, 0.45, 0.1);

    // Towers: every box of every tower in one batched draw; HP bars and cud goo one draw each.
    this.puffGeo = new THREE.SphereGeometry(1, 12, 8);
    this.towerBatch = new TowerBatch(scene, Object.values(TOWER_FORMS), {
      barGeo: new THREE.BoxGeometry(1, 0.14, 0.14),
      gooGeo: this.puffGeo,
      gooMat: new THREE.MeshStandardMaterial({ color: 0x8fd14f, roughness: 0.3, emissive: 0x2a5a10 }),
    });
    /** tower id → { def, ids, pop, bonk } */
    this.towerViews = new Map();
    this.rootMatrix = new THREE.Matrix4();
    this.ghosts = new Map();
    this.buildRangeRing();
    this.buildSelection();
    this.buildSpawnPads();

    // Tracers: one LineSegments, rewritten every frame.
    this.tracers = [];
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3).setUsage(THREE.DynamicDrawUsage));
    this.tracerLines = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.tracerLines.frustumCulled = false;
    scene.add(this.tracerLines);

    // Shells in flight.
    this.shellMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffd84d, roughness: 0.4 }), MAX_SHELLS);
    this.shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shellMesh.frustumCulled = false;
    this.shellMesh.castShadow = true;
    this.shellMesh.count = 0;
    scene.add(this.shellMesh);
    this.shellMatrix = new THREE.Matrix4();

    // Butter slicks: flat discs, fading out over their life, one batched draw.
    const zoneMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    this.zones = new EffectPool(scene, new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2), zoneMat, MAX_ZONES);
    this.zones.mesh.renderOrder = 1;
    /** zone index → pool instance id */
    this.zoneIds = [];

    // Puffs: kills, splashes, milk being drunk. One batched draw.
    this.puffs = [];
    this.puffPool = new EffectPool(scene, this.puffGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }), MAX_PUFFS);
    this.tmpColor = new THREE.Color();
    this.spitGlow = new THREE.Color(0.55, 1, 0.3);

    // War Moo-st: remember the clear-weather fog so we can blend back to it.
    this.mistColor = new THREE.Color(MIST_COLOR);
    this.clearFog = scene.fog ? { near: scene.fog.near, far: scene.fog.far, color: scene.fog.color.clone() } : null;
    this.clearSky = scene.background?.isColor ? scene.background.clone() : null;
  }

  buildRangeRing() {
    const pts = [];
    for (let k = 0; k <= 96; k++) {
      const a = (k / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a), 0.06, Math.sin(a)));
    }
    this.rangeRing = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
    this.minRangeRing = this.rangeRing.clone();
    this.minRangeRing.material = new THREE.LineBasicMaterial({ color: 0xff7070, transparent: true, opacity: 0.6 });
    this.rangeRing.visible = this.minRangeRing.visible = false;
    this.scene.add(this.rangeRing, this.minRangeRing);
  }

  buildSelection() {
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    this.selection = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffd84d }));
    this.selection.visible = false;
    this.scene.add(this.selection);
  }

  /** All spawn pads and their posts as one vertex-coloured mesh. */
  buildSpawnPads() {
    const boxes = [];
    for (const s of this.game.spawners) {
      boxes.push([[s.x - 2, 0, s.z - 2], [s.x + 2, 0.04, s.z + 2], 0xa8432f]);
      boxes.push([[s.x + 2.1, 0, s.z + 2.1], [s.x + 2.3, 2.4, s.z + 2.3], 0x6b4a2f]);
    }
    if (!boxes.length) return;
    const pads = new THREE.Mesh(boxesGeometry(boxes), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
    pads.castShadow = true;
    pads.receiveShadow = true;
    this.scene.add(pads);
  }

  /** The build ghost of a tower type: all its parts in one mesh with one see-through material. */
  buildGhost(def) {
    const geo = boxesGeometry(def.parts.map((p) => [p.min, p.max, 0xffffff]));
    const ghost = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }));
    this.scene.add(ghost);
    return ghost;
  }

  /** Feed one tick's events (call after every Game.tick, since tick() clears them). */
  consume(events) {
    for (const e of events) {
      if (e.kind === 'shot') {
        if (this.tracers.length < MAX_TRACERS) this.tracers.push({ ...e, age: 0 });
        if (e.crit) this.puff(e.x1, e.y1, e.z1, 0.7, 0xff3a6a);
        if (e.beam) this.puff(e.x0, e.y0, e.z0, 0.5, e.color);
      } else if (e.kind === 'spray') {
        this.spray(e);
      } else if (e.kind === 'flambe') {
        this.puff(e.x, 0.6, e.z, e.radius * 0.8, 0xff7a1a);
      } else if (e.kind === 'execute') {
        this.puff(e.x, 1.0, e.z, 1.1, 0x9a4dff);
      } else if (e.kind === 'splash') {
        this.puff(e.x, e.y ?? 0.3, e.z, e.radius, e.color);
      } else if (e.kind === 'split') {
        this.puff(e.x, 0.9, e.z, 1.6, 0xffa8d0);
      } else if (e.kind === 'heal') {
        this.puff(e.x, 0.4, e.z, e.radius * 0.6, 0x7dffa0);
      } else if (e.kind === 'kill') {
        this.puff(e.x, 0.8, e.z, 0.9, 0xffffff);
        // Sold at auction: a little gold coin puff above it.
        if (e.mult > 1) this.puff(e.x, 2.0, e.z, 0.35 + 0.15 * e.mult, 0xffc933);
      } else if (e.kind === 'drink') {
        this.puff(e.x, 0.8, e.z, 1.2, 0xf0f0ff);
      } else if (e.kind === 'boom') {
        this.puff(e.x, 0.6, e.z, e.radius * 1.3, 0xff7a1a);
        this.puff(e.x, 1.4, e.z, e.radius * 0.8, 0xffe066);
      } else if (e.kind === 'destroyed') {
        this.puff(e.x, 0.8, e.z, 1.6, 0x6b5a46);
      } else if (e.kind === 'bonk') {
        const view = this.towerViews.get(e.tower);
        if (view) view.bonk = BONK_TIME;
        this.puff((e.x + e.cx) / 2, 0.7, (e.z + e.cz) / 2, 0.7, 0xfff3c0);
      } else if (e.kind === 'upgraded') {
        // Only auto-upgrades get here (they happen inside tick); bought ones are burst by main.js.
        const t = this.game.towers.get(e.tower);
        if (t) this.upgradeBurst(t);
      } else if (e.kind === 'spit') {
        if (this.tracers.length < MAX_TRACERS) this.tracers.push({ x0: e.x0, y0: 1.1, z0: e.z0, x1: e.x1, y1: e.y1, z1: e.z1, color: 0x8fd14f, age: 0 });
        this.puff(e.x1, e.y1, e.z1, 0.8, 0x8fd14f);
      }
    }
  }

  /**
   * A Milk Frother jet: a fan of short streaks across its cone, re-drawn every
   * squirt (10 a second), so it reads as a continuous spray. Cosmetic randomness only.
   */
  spray(e) {
    const half = Math.acos(e.spreadCos);
    const base = Math.atan2(e.dz, e.dx);
    for (let k = 0; k < 6 && this.tracers.length < MAX_TRACERS; k++) {
      const a = base + (Math.random() * 2 - 1) * half;
      const d0 = Math.random() * 0.4 * e.range, d1 = d0 + (0.35 + Math.random() * 0.45) * e.range;
      const y = e.y0 - 0.3 * (d1 / e.range);
      this.tracers.push({
        x0: e.x0 + Math.cos(a) * d0, y0: e.y0, z0: e.z0 + Math.sin(a) * d0,
        x1: e.x0 + Math.cos(a) * d1, y1: y, z1: e.z0 + Math.sin(a) * d1, color: e.color, age: 0, life: 0.12,
      });
    }
  }

  /** Level-up burst on a tower (upgrades happen outside tick(), so main.js calls this). */
  upgradeBurst(t) {
    const r = t.def.footprint;
    this.puff(t.x, 0.4, t.z, r * 1.6, t.def.accent);
    this.puff(t.x, t.def.height + 0.8, t.z, r * 1.1, 0xffffff);
    this.puff(t.x, t.def.height + 1.6, t.z, r * 0.7, 0xffd84d);
  }

  puff(x, y, z, radius, color) {
    if (this.puffs.length >= MAX_PUFFS) return;
    const id = this.puffPool.add();
    if (id < 0) return;
    this.puffs.push({ id, x, y, z, radius, color, age: 0 });
  }

  /**
   * @param {number} alpha sim interpolation factor
   * @param {number} frameDt seconds since last frame
   * @param {import('./build.js').BuildController} build
   * Call after the Renderer's setView (culling reads the camera).
   */
  update(alpha, frameDt, build) {
    this.time += frameDt;
    this.frameDt = frameDt;
    // Fog first: the far plane (and so the cull frustum) follows it.
    this.syncFog();
    this.updateFrustum();
    this.syncCows(alpha);
    this.syncTowers();
    this.syncGhost(build);
    this.syncTracers(frameDt);
    this.syncShells(alpha);
    this.syncZones();
    this.syncPuffs(frameDt);
  }

  /** Blend the scene fog and sky toward the War Moo-st as game.fogLevel rises. */
  syncFog() {
    const fog = this.scene.fog, c = this.clearFog;
    if (!fog || !c) return;
    const k = this.game.fogLevel;
    // Ease in, so the view closes in quickly once it starts.
    const e = 1 - (1 - k) * (1 - k);
    fog.near = c.near + (MIST_NEAR - c.near) * e;
    fog.far = c.far + (MIST_FAR - c.far) * e;
    fog.color.copy(c.color).lerp(this.mistColor, e);
    if (this.clearSky) this.scene.background.copy(this.clearSky).lerp(this.mistColor, e);
  }

  updateFrustum() {
    const v = this.view;
    if (!v?.camera) { this.cull = false; return; }
    v.fitFar?.();
    const cam = v.camera;
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustumPlanes(this.viewProj.elements, this.planes);
    this.cull = true;
  }

  syncCows(alpha) {
    const c = this.game.cows;
    const m = this.cowMesh;
    const mat = m.instanceMatrix.array, colArr = m.instanceColor.array;
    const col = this.tmpColor;
    const planes = this.planes, sph = this.sphere, sun = this.view?.sunOffset;
    const cull = this.cull && !!sun;
    const maxWings = this.wingMesh.instanceMatrix.count;
    let n = 0, wings = 0;
    for (let i = 0; i < c.count; i++) {
      const x = c.px[i] + (c.x[i] - c.px[i]) * alpha;
      const z = c.pz[i] + (c.z[i] - c.pz[i]) * alpha;
      const ti = c.type[i];
      const type = COW_TYPE_LIST[ti];
      const s0 = type.scale;
      if (cull) {
        shadowedSphere(x, type.altitude + COW_CULL_UP * s0, z, COW_CULL_R * s0, sun, sph);
        if (!sphereVisible(planes, sph[0], sph[1], sph[2], sph[3])) continue;
      }
      const ph = this.time * 9 + c.id[i] * 1.7;
      let y, rx, ry, rz;
      if (type.altitude > 0) {
        // Flyers bob slowly up and down instead of waddling.
        y = type.altitude + Math.sin(ph * 0.4) * 0.3;
        rx = 0; ry = Math.atan2(-c.vx[i], -c.vz[i]); rz = 0;
      } else if (c.slowT[i] > 0 && c.slowF[i] === 0) {
        // Tipped over: lying on its side, legs in the air, until it gets up.
        y = 0.45 * s0;
        rx = 0; ry = (c.id[i] * 2.39) % (2 * Math.PI); rz = Math.PI / 2;
      } else if (c.abilS[i] === 1) {
        // Winding up: a Heifer rears back (nose up, shaking); a Spitter puffs its cheeks.
        const k = 1 - Math.max(0, c.abilT[i]) / type.windup;
        ry = Math.atan2(-c.vx[i], -c.vz[i]);
        if (type.ramDamage > 0) {
          y = 0.1 * k;
          rx = 0.45 * k; rz = Math.sin(ph * 3) * 0.08 * k;
        } else {
          y = 0;
          rx = -0.15 * k; rz = 0;
        }
      } else {
        // Waddle: bob and roll a little, out of phase per cow. Enraged bulls shake.
        const mad = type.enrageBelow > 0 && c.hp[i] < type.enrageBelow * c.maxHp[i];
        const rock = mad ? 0.18 : 0.05;
        y = Math.abs(Math.sin(mad ? ph * 2 : ph)) * (mad ? 0.16 : 0.08);
        // Model faces -Z; rotation.y = θ turns -Z to (-sin θ, -cos θ).
        rx = 0; ry = Math.atan2(-c.vx[i], -c.vz[i]); rz = Math.sin(mad ? ph * 2.5 : ph) * rock;
      }
      const s = s0 * (c.abilS[i] === 1 && type.spitRange > 0 ? 1 + 0.2 * (1 - Math.max(0, c.abilT[i]) / type.windup) : 1);
      composeYXZ(mat, n * 16, x, y, z, rx, ry, rz, s);
      if (type.altitude > 0 && wings + 2 <= maxWings) {
        const cm = this.cowMatrix.fromArray(mat, n * 16);
        const flap = Math.sin(this.time * 14 + c.id[i]) * 0.6;
        for (let side = 1; side >= -1; side -= 2) {
          this.wingLocal.makeRotationZ(side * flap).premultiply(this.wingTmp.makeTranslation(side * 0.36, 1.1, -0.1));
          this.wingLocal.multiply(this.wingTmp.makeScale(side, 1, 1));
          this.wingMesh.setMatrixAt(wings++, this.wingTmp.multiplyMatrices(cm, this.wingLocal));
        }
      }
      // Type tint; Kaboom Cows flicker like a lit fuse; everything flashes red when hit.
      col.copy(this.typeColors[ti]);
      if (type.blastRadius > 0) col.lerp(this.fuse, 0.5 + 0.5 * Math.sin(this.time * 14 + c.id[i]));
      if (type.enrageBelow > 0 && c.hp[i] < type.enrageBelow * c.maxHp[i]) col.lerp(this.rage, 0.6);
      if (type.healRate > 0) col.lerp(this.healGlow, 0.25 + 0.25 * Math.sin(this.time * 6 + c.id[i]));
      if (type.camo > 0) col.multiplyScalar(0.55 + 0.25 * Math.sin(this.time * 3 + c.id[i])); // shimmer in and out
      if (c.chillT[i] > 0) col.lerp(this.ice, 0.55); // brain-frozen: icy blue
      else if (c.slowT[i] > 0) col.lerp(this.goo, 0.45); // stuck in molasses / butter / glue
      if (c.burnT[i] > 0) col.lerp(this.ember, 0.35 + 0.25 * Math.sin(this.time * 18 + c.id[i] * 3.1)); // simmering
      if (c.abilS[i] === 1 && type.spitRange > 0) col.lerp(this.spitGlow, 0.5 + 0.3 * Math.sin(this.time * 20));
      col.lerp(this.flash, 1 - Math.min(1, c.hitAge[i] / 0.12));
      colArr[n * 3] = col.r; colArr[n * 3 + 1] = col.g; colArr[n * 3 + 2] = col.b;
      n++;
    }
    this.stats.cows = n;
    this.stats.cowsCulled = c.count - n;
    m.count = n;
    // Upload only the instances in use, not the whole 4096-cow buffer.
    if (n) { uploadRange(m.instanceMatrix, n * 16); uploadRange(m.instanceColor, n * 3); }
    this.wingMesh.count = wings;
    if (wings) uploadRange(this.wingMesh.instanceMatrix, wings * 16);
  }

  syncTowers() {
    const { towers } = this.game;
    const tb = this.towerBatch;
    for (const [id, view] of this.towerViews) {
      if (!towers.has(id)) {
        tb.remove(view.ids);
        this.towerViews.delete(id);
      }
    }
    tb.begin();
    for (const t of towers.values()) {
      let view = this.towerViews.get(t.id);
      // Upgrading swaps the tower's form: swap the model and pop it.
      if (view && view.def !== t.def) {
        tb.remove(view.ids);
        view.ids = tb.add(t.def);
        view.def = t.def;
        view.pop = POP_TIME;
      }
      if (!view) {
        view = { def: t.def, ids: tb.add(t.def), pop: 0, bonk: 0 };
        this.towerViews.set(t.id, view);
      }
      let sx = 1, sy = 1;
      if (view.pop > 0) {
        view.pop = Math.max(0, view.pop - this.frameDt);
        // Squash and stretch: shoot up tall and thin, bounce back.
        const k = Math.sin((view.pop / POP_TIME) * Math.PI);
        sx = 1 - 0.18 * k;
        sy = 1 + 0.35 * k;
      }
      // Headbutted: a quick wobble. Jammed with cud: goo on top and the gun droops.
      const b = view.bonk;
      if (b > 0) view.bonk = Math.max(0, b - this.frameDt);
      const wobble = b > 0 ? Math.sin(b * 60) * 0.12 * (b / BONK_TIME) : 0;
      const jammed = t.stunT > 0;
      const droop = jammed ? -0.25 + Math.sin(this.time * 4) * 0.05 : 0;
      const root = this.rootMatrix.copy(tb.pose(view.ids, t.x, t.z, wobble, sx, sy, sx, Math.atan2(-t.aimX, -t.aimZ), droop));
      const f = t.hp / t.maxHp;
      if (f < 0.999) tb.bar(root, t.def.height + 0.6, wobble, f);
      if (jammed) tb.gooAt(root, t.def.height, t.def.footprint);
    }
    tb.end();
  }

  syncGhost(build) {
    for (const g of this.ghosts.values()) g.visible = false;
    this.rangeRing.visible = this.minRangeRing.visible = false;
    const p = build.preview;
    if (p && p.type) {
      let ghost = this.ghosts.get(p.type.id);
      if (!ghost) {
        ghost = this.buildGhost(p.type);
        this.ghosts.set(p.type.id, ghost);
      }
      ghost.visible = true;
      ghost.position.set(p.x, 0.01, p.z);
      ghost.material.color.setHex(p.ok ? 0x6dff7a : 0xff5a5a);
      if (p.type.range > 0) {
        this.rangeRing.visible = true;
        this.rangeRing.position.set(p.x, 0, p.z);
        this.rangeRing.scale.setScalar(p.type.range);
        if (p.type.minRange > 0) {
          this.minRangeRing.visible = true;
          this.minRangeRing.position.set(p.x, 0, p.z);
          this.minRangeRing.scale.setScalar(p.type.minRange);
        }
      }
    }
    const t = build.lookTower;
    this.selection.visible = !!t && !p;
    if (t) {
      const { min, max } = t.aabb;
      this.selection.position.set((min.x + max.x) / 2, 0, (min.z + max.z) / 2);
      this.selection.scale.set(max.x - min.x + 0.1, max.y + 0.1, max.z - min.z + 0.1);
      if (t.def.range > 0) {
        this.rangeRing.visible = !p;
        this.rangeRing.position.set(t.x, 0, t.z);
        this.rangeRing.scale.setScalar(t.def.range);
      }
    }
  }

  syncTracers(dt) {
    const pos = this.tracerLines.geometry.attributes.position;
    const colAttr = this.tracerLines.geometry.attributes.color;
    let n = 0;
    const col = this.tmpColor;
    for (let k = this.tracers.length - 1; k >= 0; k--) {
      const t = this.tracers[k];
      t.age += dt;
      if (t.age > (t.life ?? TRACER_LIFE)) { this.tracers[k] = this.tracers[this.tracers.length - 1]; this.tracers.pop(); continue; }
      pos.setXYZ(n * 2, t.x0, t.y0, t.z0);
      pos.setXYZ(n * 2 + 1, t.x1, t.y1, t.z1);
      col.setHex(t.color);
      colAttr.setXYZ(n * 2, col.r, col.g, col.b);
      colAttr.setXYZ(n * 2 + 1, col.r, col.g, col.b);
      n++;
    }
    this.tracerLines.visible = n > 0;
    if (n) { uploadRange(pos, n * 6); uploadRange(colAttr, n * 6); }
    this.tracerLines.geometry.setDrawRange(0, n * 2);
  }

  syncShells(alpha) {
    const ps = this.game.projectiles;
    const m = this.shellMesh;
    const o = this.shellMatrix;
    const n = Math.min(ps.length, MAX_SHELLS);
    for (let k = 0; k < n; k++) {
      const p = ps[k];
      const s = Math.min(1, (p.prevT + (p.t - p.prevT) * alpha) / p.T);
      o.makeTranslation(
        p.x0 + (p.x1 - p.x0) * s,
        p.y0 + ((p.y1 ?? 0.3) - p.y0) * s + 4 * p.arc * s * (1 - s),
        p.z0 + (p.z1 - p.z0) * s,
      );
      m.setMatrixAt(k, o);
    }
    m.count = n;
    m.visible = n > 0;
    if (n) uploadRange(m.instanceMatrix, n * 16);
  }

  syncZones() {
    const zs = this.game.zones;
    const n = Math.min(zs.length, MAX_ZONES);
    const pool = this.zones, ids = this.zoneIds;
    while (ids.length > n) pool.remove(ids.pop());
    for (let k = 0; k < n; k++) {
      if (ids[k] === undefined) ids[k] = pool.add();
      const z = zs[k];
      const s = z.t / z.T;
      // Splat in fast, wobble a little, fade over the last third.
      const grow = Math.min(1, z.t / 0.15);
      const r = z.radius * grow * (1 + 0.03 * Math.sin(this.time * 5 + k));
      pool.set(ids[k], z.x, 0.03 + k * 0.0005, z.z, r, r, r, z.color, 0.55 * Math.min(1, (1 - s) * 3));
    }
  }

  syncPuffs(dt) {
    for (let k = this.puffs.length - 1; k >= 0; k--) {
      const p = this.puffs[k];
      p.age += dt;
      const s = p.age / PUFF_LIFE;
      if (s >= 1) {
        this.puffPool.remove(p.id);
        this.puffs[k] = this.puffs[this.puffs.length - 1];
        this.puffs.pop();
        continue;
      }
      const r = p.radius * (0.4 + 0.6 * s);
      this.puffPool.set(p.id, p.x, p.y, p.z, r, r, r, p.color, 0.7 * (1 - s));
    }
  }
}

/** One wing: a flat feathery plank sticking out along +X from the shoulder (mirrored for the left). */
function wingGeometry() {
  const g = new THREE.BoxGeometry(0.9, 0.05, 0.5);
  g.translate(0.45, 0, 0);
  return g;
}

/**
 * A blocky cow facing -Z, about 1.6 m long and 1.4 m tall, as one geometry
 * with vertex colours (white body, black patches, pink snout and udder), so
 * every cow is a single instanced draw.
 */
function cowGeometry() {
  const W = 0xffffff, K = 0x1d1d1d, P = 0xf2a0b0, H = 0xe8dcc0;
  const boxes = [
    // [min, max, colour]
    [[-0.38, 0.55, -0.7], [0.38, 1.15, 0.65], W], // body
    [[0.39, 0.7, -0.3], [0.40, 1.05, 0.15], K], // patch, right flank (thin plates on the surface)
    [[-0.40, 0.75, 0.05], [-0.39, 1.1, 0.5], K], // patch, left flank
    [[-0.2, 1.15, -0.2], [0.25, 1.16, 0.3], K], // patch, back
    [[-0.26, 0.85, -1.15], [0.26, 1.35, -0.7], W], // head
    [[-0.22, 0.85, -1.27], [0.22, 1.07, -1.14], P], // snout
    [[-0.2, 1.14, -1.16], [-0.08, 1.25, -1.14], K], // eye L (a black square, very expressive)
    [[0.08, 1.14, -1.16], [0.2, 1.25, -1.14], K], // eye R
    [[-0.38, 1.3, -0.95], [-0.24, 1.48, -0.85], H], // horn L
    [[0.24, 1.3, -0.95], [0.38, 1.48, -0.85], H], // horn R
    [[-0.45, 1.18, -0.85], [-0.26, 1.26, -0.75], K], // ear L
    [[0.26, 1.18, -0.85], [0.45, 1.26, -0.75], K], // ear R
    [[-0.15, 0.43, 0.15], [0.15, 0.55, 0.45], P], // udder
    [[-0.04, 0.95, 0.65], [0.04, 1.1, 0.95], W], // tail
    [[-0.07, 0.75, 0.9], [0.07, 0.95, 0.98], K], // tail tuft
  ];
  for (const x of [-0.25, 0.25]) for (const z of [-0.5, 0.45]) boxes.push([[x - 0.1, 0.02, z - 0.1], [x + 0.1, 0.55, z + 0.1], W]); // legs (start above the hoof's sole: a shared bottom face z-fought, visibly on tipped cows)
  for (const x of [-0.25, 0.25]) for (const z of [-0.5, 0.45]) boxes.push([[x - 0.11, 0, z - 0.11], [x + 0.11, 0.1, z + 0.11], K]); // hooves
  return boxesGeometry(boxes);
}
