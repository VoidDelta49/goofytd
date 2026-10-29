// Batched drawing helpers. Everything that used to be one draw call per mesh
// (every box of every tower, every puff, every butter slick, every HP bar) is
// drawn here as one draw per kind: towers as a BatchedMesh (one multi-draw,
// culled per instance against the camera and again against the sun's shadow
// camera), effects as BatchedMeshes with per-instance RGBA.

import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _rgba = new THREE.Vector4();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * One indexed geometry from axis-aligned boxes `[[min], [max], hex]`, with
 * per-vertex linear colours (so a whole model is one draw with a white
 * vertex-coloured material). Attributes: position, normal, color.
 */
export function boxesGeometry(boxes) {
  const pos = [], nrm = [], col = [], idx = [];
  const c = new THREE.Color();
  for (const [min, max, hex] of boxes) {
    const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    c.setHex(hex ?? 0xffffff); // sRGB hex → linear, as a material colour would be
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
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** A tower form's parts as [base, aim] geometries (aim is null if nothing turns). */
export function towerGeometries(def) {
  const box = (p) => [p.min, p.max, p.color];
  const base = def.parts.filter((p) => !p.aim).map(box);
  const aim = def.parts.filter((p) => p.aim).map(box);
  return [base.length ? boxesGeometry(base) : null, aim.length ? boxesGeometry(aim) : null];
}

/** Vertex and index counts a form's geometries need (24 and 36 per box). */
function formSize(def) {
  return { v: def.parts.length * 24, i: def.parts.length * 36 };
}

/** Grow a BatchedMesh's instance capacity by doubling when it's full. */
function ensureInstances(mesh, extra) {
  const need = mesh.instanceCount + extra;
  if (need > mesh.maxInstanceCount) mesh.setInstanceCount(Math.max(need, mesh.maxInstanceCount * 2));
}

/**
 * Every tower in one BatchedMesh: per form two geometries (static base and the
 * turning `aim` parts), per tower two instances. HP bars and cud goo are one
 * InstancedMesh each, rebuilt (compacted) every frame from the damaged or
 * jammed towers only.
 */
export class TowerBatch {
  /** @param {THREE.Scene} scene @param {Iterable<object>} forms every tower form, to size the buffers up front */
  constructor(scene, forms, { barGeo, gooGeo, gooMat }) {
    let v = 0, i = 0, n = 0;
    for (const f of forms) { const s = formSize(f); v += s.v; i += s.i; n++; }
    this.mesh = new THREE.BatchedMesh(64, Math.max(v, 1024), Math.max(i, 1536), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Its whole-object bounding sphere is computed once and never refreshed, so
    // object-level culling would be wrong; per-instance culling does the work.
    this.mesh.frustumCulled = false;
    this.mesh.perObjectFrustumCulled = true;
    scene.add(this.mesh);
    /** form id → [baseGeometryId, aimGeometryId] (−1 when absent) */
    this.geoIds = new Map();

    const MAX_BARS = 256;
    this.bars = new THREE.InstancedMesh(barGeo, new THREE.MeshBasicMaterial(), MAX_BARS * 2);
    this.bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bars.setColorAt(0, _c.set(1, 1, 1));
    this.bars.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.bars.frustumCulled = false;
    this.bars.count = 0;
    this.barBack = new THREE.Color(0x222222);
    scene.add(this.bars);
    this.goo = new THREE.InstancedMesh(gooGeo, gooMat, MAX_BARS);
    this.goo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.goo.frustumCulled = false;
    this.goo.count = 0;
    scene.add(this.goo);
  }

  geometryFor(def) {
    let ids = this.geoIds.get(def.id);
    if (ids) return ids;
    const geos = towerGeometries(def);
    const m = this.mesh;
    let need = 0, needI = 0;
    for (const g of geos) if (g) { need += g.attributes.position.count; needI += g.index.count; }
    // A form nobody counted at construction (defined later): make room.
    if (need > m.unusedVertexCount || needI > m.unusedIndexCount) {
      const maxV = m.geometry.attributes.position.count, maxI = m.geometry.index.count; // current capacity
      m.setGeometrySize(Math.max(maxV * 2, maxV + need), Math.max(maxI * 2, maxI + needI));
    }
    ids = geos.map((g) => (g ? m.addGeometry(g) : -1));
    for (const g of geos) g?.dispose();
    this.geoIds.set(def.id, ids);
    return ids;
  }

  /** New instances for a tower in form `def`: { base, aim } instance ids (−1 if absent). */
  add(def) {
    const [b, a] = this.geometryFor(def);
    ensureInstances(this.mesh, 2);
    return { base: b >= 0 ? this.mesh.addInstance(b) : -1, aim: a >= 0 ? this.mesh.addInstance(a) : -1 };
  }

  remove(ids) {
    if (ids.base >= 0) this.mesh.deleteInstance(ids.base);
    if (ids.aim >= 0) this.mesh.deleteInstance(ids.aim);
  }

  /**
   * Pose one tower. Same transform chain the old per-tower Group had:
   * root = T(x,0,z)·Rz(wobble)·S(pop); aim = root·R_xyz(droop, yaw, 0).
   * Returns the root matrix (valid until the next call).
   */
  pose(ids, x, z, wobble, sx, sy, sz, yaw, droop) {
    _q.setFromAxisAngle(Z_AXIS, wobble);
    _m.compose(_v.set(x, 0, z), _q, _s.set(sx, sy, sz));
    if (ids.base >= 0) this.mesh.setMatrixAt(ids.base, _m);
    if (ids.aim >= 0) {
      _n.makeRotationFromEuler(_e.set(droop, yaw, 0)).premultiply(_m);
      this.mesh.setMatrixAt(ids.aim, _n);
    }
    return _m;
  }

  /** Start a frame of HP bars and goo blobs. */
  begin() {
    this.nBars = 0;
    this.nGoo = 0;
  }

  /** An HP bar over a tower: `root` from pose(), `f` = hp fraction, bar at height `y`, level against `wobble`. */
  bar(root, y, wobble, f) {
    if (this.nBars + 2 > this.bars.instanceMatrix.count) return;
    // root · T(0,y,0) · Rz(−wobble)
    _q.setFromAxisAngle(Z_AXIS, -wobble);
    _n.compose(_v.set(0, y, 0), _q, _s.set(1, 1, 1)).premultiply(root);
    // Back: a 1.5 × 0.9 slab. Fill: 1.4 m × f wide, shrinking from the right.
    _m.makeScale(1.5, 1, 0.9).premultiply(_n);
    this.bars.setMatrixAt(this.nBars, _m);
    this.bars.setColorAt(this.nBars++, this.barBack);
    _m.makeScale(1.4 * Math.max(0.001, f), 1.2, 1).setPosition(-(1 - f) * 0.7, 0, 0).premultiply(_n);
    this.bars.setMatrixAt(this.nBars, _m);
    this.bars.setColorAt(this.nBars++, _c.setRGB(f < 0.5 ? 1 : 2 * (1 - f), f < 0.5 ? 2 * f : 1, 0.15));
  }

  /** A blob of cud goo on top of a jammed tower. */
  gooAt(root, y, footprint) {
    if (this.nGoo >= this.goo.instanceMatrix.count) return;
    _m.makeScale(0.45 * footprint, 0.25, 0.45 * footprint).setPosition(0, y, 0).premultiply(root);
    this.goo.setMatrixAt(this.nGoo++, _m);
  }

  end() {
    for (const [mesh, n, colors] of [[this.bars, this.nBars, true], [this.goo, this.nGoo, false]]) {
      mesh.count = n;
      mesh.visible = n > 0;
      if (!n) continue;
      uploadRange(mesh.instanceMatrix, n * 16);
      if (colors) uploadRange(mesh.instanceColor, n * 3);
    }
  }
}

/** Mark only the first `n` floats of a dynamic attribute for upload this frame. */
export function uploadRange(attr, n) {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n);
  attr.needsUpdate = true;
}

/**
 * A pool of short-lived see-through effects (puffs, slicks) sharing one
 * geometry: one BatchedMesh draw, each instance with its own matrix and RGBA.
 */
export class EffectPool {
  constructor(scene, geometry, material, max) {
    this.max = max;
    this.mesh = new THREE.BatchedMesh(max, geometry.attributes.position.count, geometry.index?.count ?? 0, material);
    this.mesh.frustumCulled = false; // see TowerBatch
    this.mesh.perObjectFrustumCulled = true;
    this.geo = this.mesh.addGeometry(geometry);
    this.free = [];
    // Initialise the colours texture now (it's created on first use).
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.live = 0;
  }

  /** A new instance id, or −1 when the pool is full. */
  add() {
    let id = this.free.pop();
    if (id === undefined) {
      if (this.mesh.instanceCount >= this.max) return -1;
      id = this.mesh.addInstance(this.geo);
    } else {
      this.mesh.setVisibleAt(id, true);
    }
    this.live++;
    this.mesh.visible = true;
    return id;
  }

  remove(id) {
    this.mesh.setVisibleAt(id, false);
    this.free.push(id);
    if (--this.live === 0) this.mesh.visible = false;
  }

  /** Place instance `id` at (x, y, z), scaled by (sx, sy, sz), coloured hex with alpha a. */
  set(id, x, y, z, sx, sy, sz, hex, a) {
    _m.makeScale(sx, sy, sz).setPosition(x, y, z);
    this.mesh.setMatrixAt(id, _m);
    _c.setHex(hex);
    this.mesh.setColorAt(id, _rgba.set(_c.r, _c.g, _c.b, a));
  }
}
