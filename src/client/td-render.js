// three.js presentation for the tower-defence layer: instanced cows, tower
// meshes built from each type's `parts`, the build ghost, spawn pads, shot
// tracers, lobbed shells, butter slicks and splash puffs. Reads Game state; never writes it.

import * as THREE from 'three';
import { COW_TYPE_LIST } from '../sim/cows.js';
import { TOWER_TYPES } from '../sim/towers.js';

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

export class TdRenderer {
  /** @param {THREE.Scene} scene @param {import('../sim/game.js').Game} game */
  constructor(scene, game) {
    this.scene = scene;
    this.game = game;
    this.time = 0;
    this.materials = new Map();

    // Cows: one instanced draw for all of them.
    this.cowMesh = new THREE.InstancedMesh(cowGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), game.cows.capacity);
    this.cowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cowMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.cowMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.cowMesh.castShadow = true;
    this.cowMesh.receiveShadow = true;
    this.cowMesh.frustumCulled = false; // instances span the whole field
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
    this.flash = new THREE.Color(1, 0, 0);
    this.fuse = new THREE.Color(1, 0.95, 0.3);
    this.goo = new THREE.Color(0.85, 0.62, 0.25);
    this.rage = new THREE.Color(1, 0.15, 0.1);
    this.healGlow = new THREE.Color(0.3, 1, 0.45);

    this.towerViews = new Map();
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

    // Butter slicks: flat discs, fading out over their life.
    this.zoneGeo = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
    this.zoneMeshes = [];
    for (let k = 0; k < MAX_ZONES; k++) {
      const m = new THREE.Mesh(this.zoneGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      m.visible = false;
      m.renderOrder = 1;
      scene.add(m);
      this.zoneMeshes.push(m);
    }

    // Puffs: kills, splashes, milk being drunk.
    this.puffs = [];
    this.puffGeo = new THREE.SphereGeometry(1, 12, 8);
    this.puffPool = [];
    this.tmp = new THREE.Object3D();
    // Yaw, then pitch, then roll: so a Heifer's lean back is about its own sideways axis.
    this.tmp.rotation.order = 'YXZ';
    this.tmpColor = new THREE.Color();
    this.spitGlow = new THREE.Color(0.55, 1, 0.3);

    // Tower HP bars: a dark back and a coloured fill, shown only on damaged towers.
    this.barGeo = new THREE.BoxGeometry(1, 0.14, 0.14);
    this.barBack = new THREE.MeshBasicMaterial({ color: 0x222222 });
    // Spit goo on a jammed tower.
    this.gooMat = new THREE.MeshStandardMaterial({ color: 0x8fd14f, roughness: 0.3, emissive: 0x2a5a10 });

    // War Moo-st: remember the clear-weather fog so we can blend back to it.
    this.mistColor = new THREE.Color(MIST_COLOR);
    this.clearFog = scene.fog ? { near: scene.fog.near, far: scene.fog.far, color: scene.fog.color.clone() } : null;
    this.clearSky = scene.background?.isColor ? scene.background.clone() : null;
  }

  material(color, ghost = false) {
    const key = `${color}|${ghost}`;
    let m = this.materials.get(key);
    if (!m) {
      m = ghost
        ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false })
        : new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
      this.materials.set(key, m);
    }
    return m;
  }

  /** A tower type's look: a group of boxes, with the `aim` parts in a child that turns. */
  buildTowerModel(def, ghost) {
    const root = new THREE.Group();
    const aim = new THREE.Group();
    root.add(aim);
    for (const p of def.parts) {
      const size = [0, 1, 2].map((k) => p.max[k] - p.min[k]);
      const geo = new THREE.BoxGeometry(...size);
      geo.translate(...[0, 1, 2].map((k) => (p.min[k] + p.max[k]) / 2));
      const mesh = new THREE.Mesh(geo, this.material(ghost ? 0xffffff : p.color, ghost));
      mesh.castShadow = !ghost;
      mesh.receiveShadow = !ghost;
      (p.aim ? aim : root).add(mesh);
    }
    root.userData.aim = aim;
    return root;
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

  buildSpawnPads() {
    const padMat = new THREE.MeshStandardMaterial({ color: 0xa8432f, roughness: 0.9 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 });
    for (const s of this.game.spawners) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(4, 0.04, 4), padMat);
      pad.position.set(s.x, 0.02, s.z);
      pad.receiveShadow = true;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.4, 0.2), postMat);
      post.position.set(s.x + 2.2, 1.2, s.z + 2.2);
      post.castShadow = true;
      this.scene.add(pad, post);
    }
  }

  /** Feed one tick's events (call after every Game.tick, since tick() clears them). */
  consume(events) {
    for (const e of events) {
      if (e.kind === 'shot') {
        if (this.tracers.length < MAX_TRACERS) this.tracers.push({ ...e, age: 0 });
      } else if (e.kind === 'splash') {
        this.puff(e.x, e.y ?? 0.3, e.z, e.radius, e.color);
      } else if (e.kind === 'split') {
        this.puff(e.x, 0.9, e.z, 1.6, 0xffa8d0);
      } else if (e.kind === 'heal') {
        this.puff(e.x, 0.4, e.z, e.radius * 0.6, 0x7dffa0);
      } else if (e.kind === 'kill') {
        this.puff(e.x, 0.8, e.z, 0.9, 0xffffff);
      } else if (e.kind === 'drink') {
        this.puff(e.x, 0.8, e.z, 1.2, 0xf0f0ff);
      } else if (e.kind === 'boom') {
        this.puff(e.x, 0.6, e.z, e.radius * 1.3, 0xff7a1a);
        this.puff(e.x, 1.4, e.z, e.radius * 0.8, 0xffe066);
      } else if (e.kind === 'destroyed') {
        this.puff(e.x, 0.8, e.z, 1.6, 0x6b5a46);
      } else if (e.kind === 'bonk') {
        const view = this.towerViews.get(e.tower);
        if (view) view.userData.bonk = BONK_TIME;
        this.puff((e.x + e.cx) / 2, 0.7, (e.z + e.cz) / 2, 0.7, 0xfff3c0);
      } else if (e.kind === 'spit') {
        if (this.tracers.length < MAX_TRACERS) this.tracers.push({ x0: e.x0, y0: 1.1, z0: e.z0, x1: e.x1, y1: e.y1, z1: e.z1, color: 0x8fd14f, age: 0 });
        this.puff(e.x1, e.y1, e.z1, 0.8, 0x8fd14f);
      }
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
    const mesh = this.puffPool.pop() ?? new THREE.Mesh(this.puffGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    mesh.material.color.set(color);
    mesh.position.set(x, y, z);
    mesh.visible = true;
    this.scene.add(mesh);
    this.puffs.push({ mesh, radius, age: 0 });
  }

  /**
   * @param {number} alpha sim interpolation factor
   * @param {number} frameDt seconds since last frame
   * @param {import('./build.js').BuildController} build
   */
  update(alpha, frameDt, build) {
    this.time += frameDt;
    this.frameDt = frameDt;
    this.syncCows(alpha);
    this.syncTowers();
    this.syncGhost(build);
    this.syncTracers(frameDt);
    this.syncShells(alpha);
    this.syncZones();
    this.syncPuffs(frameDt);
    this.syncFog();
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

  syncCows(alpha) {
    const c = this.game.cows;
    const m = this.cowMesh;
    const o = this.tmp, col = this.tmpColor;
    let wings = 0;
    for (let i = 0; i < c.count; i++) {
      const x = c.px[i] + (c.x[i] - c.px[i]) * alpha;
      const z = c.pz[i] + (c.z[i] - c.pz[i]) * alpha;
      const type = COW_TYPE_LIST[c.type[i]];
      const ph = this.time * 9 + c.id[i] * 1.7;
      if (type.altitude > 0) {
        // Flyers bob slowly up and down instead of waddling.
        o.position.set(x, type.altitude + Math.sin(ph * 0.4) * 0.3, z);
        o.rotation.set(0, Math.atan2(-c.vx[i], -c.vz[i]), 0);
      } else if (c.slowT[i] > 0 && c.slowF[i] === 0) {
        // Tipped over: lying on its side, legs in the air, until it gets up.
        o.position.set(x, 0.45 * type.scale, z);
        o.rotation.set(0, (c.id[i] * 2.39) % (2 * Math.PI), Math.PI / 2);
      } else if (c.abilS[i] === 1) {
        // Winding up: a Heifer rears back (nose up, shaking); a Spitter puffs its cheeks.
        const k = 1 - Math.max(0, c.abilT[i]) / type.windup;
        const heading = Math.atan2(-c.vx[i], -c.vz[i]);
        if (type.ramDamage > 0) {
          o.position.set(x, 0.1 * k, z);
          o.rotation.set(0.45 * k, heading, Math.sin(ph * 3) * 0.08 * k);
        } else {
          o.position.set(x, 0, z);
          o.rotation.set(-0.15 * k, heading, 0);
        }
      } else {
        // Waddle: bob and roll a little, out of phase per cow. Enraged bulls shake.
        const mad = type.enrageBelow > 0 && c.hp[i] < type.enrageBelow * c.maxHp[i];
        const rock = mad ? 0.18 : 0.05;
        o.position.set(x, Math.abs(Math.sin(mad ? ph * 2 : ph)) * (mad ? 0.16 : 0.08), z);
        // Model faces -Z; rotation.y = θ turns -Z to (-sin θ, -cos θ).
        o.rotation.set(0, Math.atan2(-c.vx[i], -c.vz[i]), Math.sin(mad ? ph * 2.5 : ph) * rock);
      }
      o.scale.setScalar(type.scale * (c.abilS[i] === 1 && type.spitRange > 0 ? 1 + 0.2 * (1 - Math.max(0, c.abilT[i]) / type.windup) : 1));
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      if (type.altitude > 0 && wings + 2 <= this.wingMesh.instanceMatrix.count) {
        const flap = Math.sin(this.time * 14 + c.id[i]) * 0.6;
        for (const side of [1, -1]) {
          this.wingLocal.makeRotationZ(side * flap).premultiply(this.wingTmp.makeTranslation(side * 0.36, 1.1, -0.1));
          this.wingLocal.multiply(this.wingTmp.makeScale(side, 1, 1));
          this.wingMesh.setMatrixAt(wings++, this.wingTmp.multiplyMatrices(o.matrix, this.wingLocal));
        }
      }
      // Type tint; Kaboom Cows flicker like a lit fuse; everything flashes red when hit.
      col.setHex(type.color);
      if (type.blastRadius > 0) col.lerp(this.fuse, 0.5 + 0.5 * Math.sin(this.time * 14 + c.id[i]));
      if (type.enrageBelow > 0 && c.hp[i] < type.enrageBelow * c.maxHp[i]) col.lerp(this.rage, 0.6);
      if (type.healRate > 0) col.lerp(this.healGlow, 0.25 + 0.25 * Math.sin(this.time * 6 + c.id[i]));
      if (type.camo > 0) col.multiplyScalar(0.55 + 0.25 * Math.sin(this.time * 3 + c.id[i])); // shimmer in and out
      if (c.slowT[i] > 0) col.lerp(this.goo, 0.45); // stuck in molasses / butter / glue
      if (c.abilS[i] === 1 && type.spitRange > 0) col.lerp(this.spitGlow, 0.5 + 0.3 * Math.sin(this.time * 20));
      col.lerp(this.flash, 1 - Math.min(1, c.hitAge[i] / 0.12));
      m.setColorAt(i, col);
    }
    m.count = c.count;
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor.needsUpdate = true;
    this.wingMesh.count = wings;
    this.wingMesh.instanceMatrix.needsUpdate = true;
  }

  syncTowers() {
    const { towers } = this.game;
    for (const [id, view] of this.towerViews) {
      if (!towers.has(id)) {
        this.scene.remove(view);
        this.towerViews.delete(id);
      }
    }
    for (const t of towers.values()) {
      let view = this.towerViews.get(t.id);
      // Upgrading swaps the tower's form: swap the model and pop it.
      if (view && view.userData.def !== t.def) {
        this.scene.remove(view);
        view = null;
        this.towerViews.set(t.id, this.newTowerView(t, POP_TIME));
      }
      if (!view) view = this.towerViews.get(t.id) ?? this.newTowerView(t, 0);
      if (view.userData.pop > 0) {
        view.userData.pop = Math.max(0, view.userData.pop - this.frameDt);
        const s = view.userData.pop / POP_TIME;
        // Squash and stretch: shoot up tall and thin, bounce back.
        view.scale.set(1 - 0.18 * Math.sin(s * Math.PI), 1 + 0.35 * Math.sin(s * Math.PI), 1 - 0.18 * Math.sin(s * Math.PI));
      }
      view.userData.aim.rotation.y = Math.atan2(-t.aimX, -t.aimZ);
      // Headbutted: a quick wobble. Jammed with cud: goo on top and the gun droops.
      const b = view.userData.bonk ?? 0;
      if (b > 0) view.userData.bonk = Math.max(0, b - this.frameDt);
      view.rotation.z = b > 0 ? Math.sin(b * 60) * 0.12 * (b / BONK_TIME) : 0;
      const jammed = t.stunT > 0;
      view.userData.goo.visible = jammed;
      view.userData.aim.rotation.x = jammed ? -0.25 + Math.sin(this.time * 4) * 0.05 : 0;
      this.syncHpBar(view, t);
    }
  }

  syncHpBar(view, t) {
    const bar = view.userData.bar;
    const f = t.hp / t.maxHp;
    bar.visible = f < 0.999;
    if (!bar.visible) return;
    const fill = view.userData.barFill;
    fill.scale.x = Math.max(0.001, f);
    fill.position.x = -(1 - f) * 0.5; // unit space; the wrapper stretches it to 1.4 m
    fill.material.color.setRGB(f < 0.5 ? 1 : 2 * (1 - f), f < 0.5 ? 2 * f : 1, 0.15);
    // Undo the bonk wobble so the bar stays level.
    bar.rotation.z = -view.rotation.z;
  }

  newTowerView(t, pop) {
    const view = this.buildTowerModel(t.def, false);
    view.position.set(t.x, 0, t.z);
    view.userData.def = t.def;
    view.userData.pop = pop;
    view.userData.bonk = 0;
    // HP bar floating over the tower (1.4 m wide).
    const bar = new THREE.Group();
    bar.position.y = t.def.height + 0.6;
    const back = new THREE.Mesh(this.barGeo, this.barBack);
    back.scale.set(1.5, 1, 0.9);
    const fill = new THREE.Mesh(this.barGeo, new THREE.MeshBasicMaterial({ color: 0x44ff44 }));
    // The fill box is 1 m wide in a wrapper stretched to 1.4 m; syncHpBar shrinks it from the right.
    const fillWrap = new THREE.Group();
    fillWrap.scale.x = 1.4;
    fill.scale.set(1, 1.2, 1);
    fillWrap.add(fill);
    bar.add(back, fillWrap);
    bar.visible = false;
    view.add(bar);
    view.userData.bar = bar;
    view.userData.barFill = fill;
    // Cud goo blob for a jammed tower.
    const goo = new THREE.Mesh(this.puffGeo, this.gooMat);
    goo.scale.set(0.45 * t.def.footprint, 0.25, 0.45 * t.def.footprint);
    goo.position.y = t.def.height;
    goo.visible = false;
    view.add(goo);
    view.userData.goo = goo;
    this.scene.add(view);
    this.towerViews.set(t.id, view);
    return view;
  }

  syncGhost(build) {
    for (const g of this.ghosts.values()) g.visible = false;
    this.rangeRing.visible = this.minRangeRing.visible = false;
    const p = build.preview;
    if (p && p.type) {
      let ghost = this.ghosts.get(p.type.id);
      if (!ghost) {
        ghost = this.buildTowerModel(p.type, true);
        // Own materials so tinting one ghost doesn't tint the others.
        ghost.traverse((n) => { if (n.isMesh) n.material = n.material.clone(); });
        this.scene.add(ghost);
        this.ghosts.set(p.type.id, ghost);
      }
      ghost.visible = true;
      ghost.position.set(p.x, 0.01, p.z);
      const color = p.ok ? 0x6dff7a : 0xff5a5a;
      ghost.traverse((n) => { if (n.isMesh) n.material.color.setHex(color); });
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
      if (t.age > TRACER_LIFE) { this.tracers[k] = this.tracers[this.tracers.length - 1]; this.tracers.pop(); continue; }
      pos.setXYZ(n * 2, t.x0, t.y0, t.z0);
      pos.setXYZ(n * 2 + 1, t.x1, t.y1, t.z1);
      col.setHex(t.color);
      colAttr.setXYZ(n * 2, col.r, col.g, col.b);
      colAttr.setXYZ(n * 2 + 1, col.r, col.g, col.b);
      n++;
    }
    pos.needsUpdate = colAttr.needsUpdate = true;
    this.tracerLines.geometry.setDrawRange(0, n * 2);
  }

  syncShells(alpha) {
    const ps = this.game.projectiles;
    const m = this.shellMesh;
    const o = this.tmp;
    const n = Math.min(ps.length, MAX_SHELLS);
    for (let k = 0; k < n; k++) {
      const p = ps[k];
      const s = Math.min(1, (p.prevT + (p.t - p.prevT) * alpha) / p.T);
      o.position.set(
        p.x0 + (p.x1 - p.x0) * s,
        p.y0 + ((p.y1 ?? 0.3) - p.y0) * s + 4 * p.arc * s * (1 - s),
        p.z0 + (p.z1 - p.z0) * s,
      );
      o.rotation.set(0, 0, 0);
      o.scale.setScalar(1);
      o.updateMatrix();
      m.setMatrixAt(k, o.matrix);
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  }

  syncZones() {
    const zs = this.game.zones;
    for (let k = 0; k < MAX_ZONES; k++) {
      const m = this.zoneMeshes[k];
      const z = zs[k];
      m.visible = !!z;
      if (!z) continue;
      const s = z.t / z.T;
      // Splat in fast, wobble a little, fade over the last third.
      const grow = Math.min(1, z.t / 0.15);
      m.position.set(z.x, 0.03 + k * 0.0005, z.z);
      m.scale.setScalar(z.radius * grow * (1 + 0.03 * Math.sin(this.time * 5 + k)));
      m.material.color.set(z.color);
      m.material.opacity = 0.55 * Math.min(1, (1 - s) * 3);
    }
  }

  syncPuffs(dt) {
    for (let k = this.puffs.length - 1; k >= 0; k--) {
      const p = this.puffs[k];
      p.age += dt;
      const s = p.age / PUFF_LIFE;
      if (s >= 1) {
        this.scene.remove(p.mesh);
        this.puffPool.push(p.mesh);
        this.puffs[k] = this.puffs[this.puffs.length - 1];
        this.puffs.pop();
        continue;
      }
      p.mesh.scale.setScalar(p.radius * (0.4 + 0.6 * s));
      p.mesh.material.opacity = 0.7 * (1 - s);
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
  for (const x of [-0.25, 0.25]) for (const z of [-0.5, 0.45]) boxes.push([[x - 0.1, 0, z - 0.1], [x + 0.1, 0.55, z + 0.1], W]); // legs
  for (const x of [-0.25, 0.25]) for (const z of [-0.5, 0.45]) boxes.push([[x - 0.11, 0, z - 0.11], [x + 0.11, 0.1, z + 0.11], K]); // hooves

  const pos = [], nrm = [], col = [], idx = [];
  const c = new THREE.Color();
  for (const [min, max, hex] of boxes) {
    const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    c.setHex(hex);
    const base = pos.length / 3;
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    for (const i of g.index.array) idx.push(base + i);
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}
