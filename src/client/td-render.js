// three.js presentation for the tower-defence layer: instanced cows, tower
// meshes built from each type's `parts`, the build ghost, spawn pads, shot
// tracers, lobbed shells and splash puffs. Reads Game state; never writes it.

import * as THREE from 'three';
import { COW_TYPE_LIST } from '../sim/cows.js';
import { TOWER_TYPES } from '../sim/towers.js';

const TRACER_LIFE = 0.07;
const PUFF_LIFE = 0.35;
const MAX_TRACERS = 512;
const MAX_SHELLS = 256;
const MAX_PUFFS = 96;

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

    // Puffs: kills, splashes, milk being drunk.
    this.puffs = [];
    this.puffGeo = new THREE.SphereGeometry(1, 12, 8);
    this.puffPool = [];
    this.tmp = new THREE.Object3D();
    this.tmpColor = new THREE.Color();
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
        this.puff(e.x, 0.3, e.z, e.radius, e.color);
      } else if (e.kind === 'kill') {
        this.puff(e.x, 0.8, e.z, 0.9, 0xffffff);
      } else if (e.kind === 'drink') {
        this.puff(e.x, 0.8, e.z, 1.2, 0xf0f0ff);
      } else if (e.kind === 'boom') {
        this.puff(e.x, 0.6, e.z, e.radius * 1.3, 0xff7a1a);
        this.puff(e.x, 1.4, e.z, e.radius * 0.8, 0xffe066);
      } else if (e.kind === 'destroyed') {
        this.puff(e.x, 0.8, e.z, 1.6, 0x6b5a46);
      }
    }
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
    this.syncCows(alpha);
    this.syncTowers();
    this.syncGhost(build);
    this.syncTracers(frameDt);
    this.syncShells(alpha);
    this.syncPuffs(frameDt);
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
      } else {
        // Waddle: bob and roll a little, out of phase per cow.
        o.position.set(x, Math.abs(Math.sin(ph)) * 0.08, z);
        // Model faces -Z; rotation.y = θ turns -Z to (-sin θ, -cos θ).
        o.rotation.set(0, Math.atan2(-c.vx[i], -c.vz[i]), Math.sin(ph) * 0.05);
      }
      o.scale.setScalar(type.scale);
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
      if (!view) {
        view = this.buildTowerModel(t.def, false);
        view.position.set(t.x, 0, t.z);
        this.scene.add(view);
        this.towerViews.set(t.id, view);
      }
      view.userData.aim.rotation.y = Math.atan2(-t.aimX, -t.aimZ);
    }
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
        p.y0 + (0.3 - p.y0) * s + 4 * p.arc * s * (1 - s),
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
