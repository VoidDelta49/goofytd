// three.js presentation: scene, level meshes, lighting and the camera.
// Reads simulation state; never writes it.

import * as THREE from 'three';
import { Surface } from '../level.js';
import { grassTexture, planksTexture } from './farm.js';
import { viewQuaternion } from './look.js';

const SKY = 0x9ec7f2;
/** The camera's far plane never goes past this (m), whatever the fog does. */
const MAX_FAR = 500;

const SURFACE_STYLE = {
  [Surface.Floor]: { color: 0x8c9e80, roughness: 0.95 },
  [Surface.Wall]: { color: 0x99948c, roughness: 0.9 },
  [Surface.Platform]: { color: 0xd99959, roughness: 0.8 },
  [Surface.Step]: { color: 0x7399d9, roughness: 0.8 },
  [Surface.Tunnel]: { color: 0xbf738c, roughness: 0.8 },
  [Surface.Pillar]: { color: 0xf2d959, roughness: 0.7 },
  [Surface.Milk]: { color: 0xfafaff, roughness: 0.35 },
};

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, level) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap was removed in recent three.js; PCF is the soft option now.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 60, 220);

    // Vertical FOV 70° is ~102° horizontal at 16:9.
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, MAX_FAR);

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x6b5f4f, 1.2));
    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    this.sunOffset = new THREE.Vector3(30, 60, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 200;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.shadowTexel = (sc.right - sc.left) / this.sun.shadow.mapSize.x;

    this.buildLevel(level);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * One mesh per surface type: every block of a surface merged into a single
   * geometry (they share a material), so the level costs one draw per surface
   * instead of one per block.
   */
  buildLevel(level) {
    const grid = gridTexture(this.renderer.capabilities.getMaxAnisotropy());
    const bySurface = new Map();
    for (const { aabb, surface } of level.blocks) {
      if (!bySurface.has(surface)) bySurface.set(surface, []);
      bySurface.get(surface).push(aabb);
    }
    // A farm draws its floor as grass, its walls as a plank fence, and its milk as a carton (farm.js).
    const farmLook = level.farm ? {
      [Surface.Floor]: { color: 0xffffff, roughness: 1, map: grassTexture() },
      [Surface.Wall]: { color: 0xffffff, roughness: 0.9, map: planksTexture() },
    } : {};
    for (const [surface, boxes] of bySurface) {
      if (level.farm && surface === Surface.Milk) continue;
      const style = farmLook[surface] ?? { ...SURFACE_STYLE[surface], map: grid };
      const mesh = new THREE.Mesh(boxesGeometry(boxes), new THREE.MeshStandardMaterial(style));
      mesh.castShadow = surface !== Surface.Floor;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
    }
  }

  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Pose the camera (and the shadow frustum) for this frame. Call before
   * TdRenderer.update, which culls against it.
   * @param {{x:number,y:number,z:number}} eye @param {number} yaw @param {number} pitch
   */
  setView(eye, yaw, pitch) {
    this.camera.position.set(eye.x, eye.y, eye.z);
    // Orientation straight from the view angles as a quaternion: no Euler
    // order to get wrong and no roll.
    this.camera.quaternion.set(...viewQuaternion(yaw, pitch));
    this.camera.updateMatrixWorld();

    // Keep the shadow frustum centred on the player, snapped to a texel-sized
    // world grid to reduce shadow-edge crawl while moving. (Not exact: the
    // light is angled, so world XZ isn't light space. Good enough for now.)
    const snap = (v) => Math.round(v / this.shadowTexel) * this.shadowTexel;
    const cx = snap(eye.x), cz = snap(eye.z);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + this.sunOffset.x, this.sunOffset.y, cz + this.sunOffset.z);
  }

  /**
   * Pull the far plane in to where the fog is total. Fog and far plane both
   * use view depth, and past fog.far a pixel is exactly the fog colour (which
   * is the sky colour), so clipping there changes no pixel and culls
   * everything the fog has swallowed: most of the field in the War Moo-st.
   */
  fitFar() {
    const far = this.scene.fog ? Math.min(MAX_FAR, this.scene.fog.far + 1) : MAX_FAR;
    if (far !== this.camera.far) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  render() {
    this.fitFar();
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * Box geometry whose UVs are world-space coordinates in metres, so the grid
 * texture tiles at a constant 1 m scale on every face of every block. Many
 * boxes go into one geometry.
 */
function boxesGeometry(aabbs) {
  // [normal, u axis, v axis] per face; u × v = normal for CCW winding.
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const pos = [], nrm = [], uv = [], idx = [];
  for (const { min, max } of aabbs) {
    const c = [(min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2];
    const h = [(max.x - min.x) / 2, (max.y - min.y) / 2, (max.z - min.z) / 2];
    for (const [n, u, v] of faces) {
      const base = pos.length / 3;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = [0, 1, 2].map((i) => c[i] + (n[i] + u[i] * su + v[i] * sv) * h[i]);
        pos.push(...p);
        nrm.push(...n);
        uv.push(p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Light "prototype grid" texture covering 1×1 m: dark border plus a fainter
 * half-metre line. Mipmapped and anisotropic so the far floor doesn't shimmer.
 * Tinted per surface by the material colour.
 */
function gridTexture(anisotropy) {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const edge = (c) => c < 2 || c >= size - 2;
  const half = (c) => Math.abs(c - size / 2) < 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const shade = edge(x) || edge(y) ? 200 : half(x) || half(y) ? 224 : 242;
      data.set([shade, shade, shade, 255], (y * size + x) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}
