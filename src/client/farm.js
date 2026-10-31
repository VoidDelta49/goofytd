// The farm dressing for the open field: grass, dirt lanes, a milking yard,
// tilled crop rows, a wooden ranch fence, and a barn, silo, farmhouse,
// windmill, hay stacks and trees out past the fence. Plus the milk itself:
// a giant gable-top carton that dents, leans and leaks as the cows drink.
// Render-only: nothing here touches the sim or collision (the fence is drawn
// over the level's walls, the carton over its milk block).

import * as THREE from 'three';

// ---- procedural textures -----------------------------------------------------

/** A tiny seeded RNG so the farm looks the same every load (it never touches the sim). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTex(size, draw, repeat = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  return tex;
}

/** Grass: mottled greens with blade flecks. Tiles every 4 m (UVs are in metres). */
export function grassTexture() {
  return canvasTex(256, (g, n) => {
    const r = rng(7);
    g.fillStyle = '#6f9e48';
    g.fillRect(0, 0, n, n);
    for (let k = 0; k < 90; k++) {
      const x = r() * n, y = r() * n, rad = 10 + r() * 40;
      g.fillStyle = `hsla(${88 + r() * 22}, ${40 + r() * 20}%, ${32 + r() * 14}%, 0.25)`;
      for (const [ox, oy] of [[0, 0], [n, 0], [-n, 0], [0, n], [0, -n]]) { g.beginPath(); g.arc(x + ox, y + oy, rad, 0, Math.PI * 2); g.fill(); }
    }
    for (let k = 0; k < 2600; k++) {
      const x = r() * n, y = r() * n;
      g.fillStyle = `hsl(${80 + r() * 35}, ${45 + r() * 25}%, ${r() < 0.5 ? 26 + r() * 10 : 46 + r() * 14}%)`;
      g.fillRect(x, y, 1, 2 + r() * 3);
    }
  }, 0.25);
}

/** Packed dirt with pebbles and hoof prints. Tiles every 3 m. */
function dirtTexture() {
  return canvasTex(256, (g, n) => {
    const r = rng(11);
    g.fillStyle = '#9a7650';
    g.fillRect(0, 0, n, n);
    for (let k = 0; k < 60; k++) {
      g.fillStyle = `hsla(${26 + r() * 10}, ${30 + r() * 15}%, ${30 + r() * 20}%, 0.25)`;
      g.beginPath(); g.arc(r() * n, r() * n, 8 + r() * 30, 0, Math.PI * 2); g.fill();
    }
    for (let k = 0; k < 900; k++) {
      g.fillStyle = `hsl(${25 + r() * 15}, ${15 + r() * 20}%, ${r() < 0.5 ? 35 : 62}%)`;
      g.fillRect(r() * n, r() * n, 1 + r() * 2, 1 + r() * 2);
    }
    // Hoof prints: little paired ovals.
    g.fillStyle = 'rgba(60, 40, 25, 0.35)';
    for (let k = 0; k < 14; k++) {
      const x = r() * n, y = r() * n;
      for (const dx of [-3, 3]) { g.beginPath(); g.ellipse(x + dx, y, 2.2, 3.5, 0, 0, Math.PI * 2); g.fill(); }
    }
  }, 1 / 3);
}

/** Vertical fence planks with a white top rail and dark gaps. Tiles every 2 m sideways, 3 m up. */
export function planksTexture() {
  const tex = canvasTex(256, (g, n) => {
    const r = rng(23);
    const w = n / 8;
    for (let k = 0; k < 8; k++) {
      g.fillStyle = `hsl(${24 + r() * 8}, ${38 + r() * 12}%, ${30 + r() * 10}%)`;
      g.fillRect(k * w, 0, w, n);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      for (let j = 0; j < 6; j++) g.fillRect(k * w + 4 + r() * (w - 8), r() * n, 1, 20 + r() * 50); // grain
      g.fillStyle = 'rgba(30,18,10,0.9)';
      g.fillRect(k * w, 0, 2, n); // gap
    }
    g.fillStyle = '#f2ece0';
    g.fillRect(0, 0, n, n * 0.07); // top rail (texture v runs up, so this is the top)
    g.fillRect(0, n * 0.5, n, n * 0.05); // middle rail
  });
  tex.repeat.set(0.5, 1 / 3);
  return tex;
}

// ---- geometry ------------------------------------------------------------------

/**
 * Collects coloured triangles into one geometry: boxes, gable roofs (prisms),
 * cylinders and cones. One builder = one draw.
 */
class Builder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.c = new THREE.Color(); }

  tri(a, b, c, hex) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.c.setHex(hex);
    for (const p of [a, b, c]) { this.pos.push(...p); this.nrm.push(nx, ny, nz); this.col.push(this.c.r, this.c.g, this.c.b); }
  }

  quad(a, b, c, d, hex) { this.tri(a, b, c, hex); this.tri(a, c, d, hex); }

  box(min, max, hex) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const p = (x, y, z) => [x, y, z];
    this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), hex); // +z
    this.quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), hex); // -z
    this.quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), hex); // +x
    this.quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), hex); // -x
    this.quad(p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0), hex); // +y
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), hex); // -y
  }

  /** A gable roof over [x0,x1]×[z0,z1] from height y0 to ridge y1, ridge along X (or Z with alongZ). */
  gable(x0, x1, z0, z1, y0, y1, hex, gableHex = hex, alongZ = false) {
    if (!alongZ) {
      const zm = (z0 + z1) / 2;
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, zm], [x0, y1, zm], hex);
      this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, zm], [x1, y1, zm], hex);
      this.tri([x1, y0, z1], [x1, y0, z0], [x1, y1, zm], gableHex);
      this.tri([x0, y0, z0], [x0, y0, z1], [x0, y1, zm], gableHex);
    } else {
      const xm = (x0 + x1) / 2;
      this.quad([x1, y0, z1], [x1, y0, z0], [xm, y1, z0], [xm, y1, z1], hex);
      this.quad([x0, y0, z0], [x0, y0, z1], [xm, y1, z1], [xm, y1, z0], hex);
      this.tri([x0, y0, z1], [x1, y0, z1], [xm, y1, z1], gableHex);
      this.tri([x1, y0, z0], [x0, y0, z0], [xm, y1, z0], gableHex);
    }
  }

  /** Cylinder (or cone/frustum when r1 differs) on the Y axis. */
  cyl(cx, cz, y0, y1, r0, r1, hex, seg = 12, cap = true) {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const p = (a, r, y) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      this.quad(p(a0, r0, y0), p(a0, r1, y1), p(a1, r1, y1), p(a1, r0, y0), hex);
      if (cap && r1 > 0) this.tri([cx, y1, cz], p(a1, r1, y1), p(a0, r1, y1), hex);
    }
  }

  /** A dome (half sphere) on a cylinder top. */
  dome(cx, cz, y, r, hex, seg = 12, rings = 4) {
    for (let j = 0; j < rings; j++) {
      const b0 = (j / rings) * Math.PI / 2, b1 = ((j + 1) / rings) * Math.PI / 2;
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
        const p = (a, b) => [cx + Math.cos(a) * Math.cos(b) * r, y + Math.sin(b) * r, cz + Math.sin(a) * Math.cos(b) * r];
        this.quad(p(a0, b0), p(a0, b1), p(a1, b1), p(a1, b0), hex);
      }
    }
  }

  mesh(material, { cast = true, receive = true } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material ?? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    m.castShadow = cast;
    m.receiveShadow = receive;
    return m;
  }
}

/** Flat ground decals (dirt) as one mesh with world-metre UVs and a textured material. */
function decalMesh(rects, y, material) {
  const pos = [], uv = [], nrm = [], idx = [];
  for (const [x0, z0, x1, z1] of rects) {
    const b = pos.length / 3;
    pos.push(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0);
    uv.push(x0, z1, x1, z1, x1, z0, x0, z0);
    nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, material);
  m.receiveShadow = true;
  m.renderOrder = -1;
  return m;
}

// ---- the farm ------------------------------------------------------------------

const RED = 0xa8322a, WHITE = 0xf2ece0, ROOF = 0x4a4a52, WOOD = 0x7a5232, HAY = 0xe2c25a;

function barn(b, cx, cz, w, d, h, facing) {
  // Faces +X (facing 1) or -X (facing -1): doors on the side toward the field.
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  b.box([x0, 0, z0], [x1, h, z1], RED);
  b.gable(x0 - 0.6, x1 + 0.6, z0 - 0.6, z1 + 0.6, h, h + d * 0.45, ROOF, RED, true);
  const fx = facing > 0 ? x1 : x0, out = facing * 0.06;
  // Big doors with the white X, a trim frame and a hayloft door.
  const dz = d * 0.22;
  b.box([Math.min(fx, fx + out), 0, cz - dz], [Math.max(fx, fx + out), h * 0.7, cz + dz], 0x8a2820);
  for (const [za, zb] of [[cz - dz, cz - dz + 0.4], [cz + dz - 0.4, cz + dz], [cz - 0.2, cz + 0.2]]) {
    b.box([Math.min(fx, fx + out * 2), 0, za], [Math.max(fx, fx + out * 2), h * 0.7, zb], WHITE);
  }
  b.box([Math.min(fx, fx + out * 2), h * 0.7 - 0.4, cz - dz], [Math.max(fx, fx + out * 2), h * 0.7, cz + dz], WHITE);
  // The X: stacked little boxes along both diagonals.
  for (let k = 0; k < 12; k++) {
    const t = k / 11, y = 0.3 + t * (h * 0.7 - 0.9);
    for (const s of [-1, 1]) {
      const z = cz + s * (-dz + 0.4 + t * (2 * dz - 0.8));
      b.box([Math.min(fx, fx + out * 2), y, z - 0.25], [Math.max(fx, fx + out * 2), y + 0.4, z + 0.25], WHITE);
    }
  }
  b.box([Math.min(fx, fx + out), h * 0.82, cz - 1], [Math.max(fx, fx + out), h + d * 0.18, cz + 1], 0x3a2418);
  b.box([Math.min(fx, fx + out * 2), h * 0.82, cz - 1.15], [Math.max(fx, fx + out * 2), h * 0.82 + 0.25, cz + 1.15], WHITE);
  // Corner trim.
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) b.box([x - 0.2, 0, z - 0.2], [x + 0.2, h, z + 0.2], WHITE);
}

function silo(b, cx, cz, r, h) {
  b.cyl(cx, cz, 0, h, r, r, 0xc8ccd2, 16, false);
  for (let y = 2; y < h; y += 2.5) b.cyl(cx, cz, y, y + 0.25, r + 0.06, r + 0.06, 0x8a9098, 16, false); // bands
  b.dome(cx, cz, h, r, 0x6a8ab0, 16, 5);
  b.box([cx - r - 0.5, 0, cz - 0.3], [cx - r - 0.3, h, cz + 0.3], 0x50566a); // ladder
}

function farmhouse(b, cx, cz) {
  b.box([cx - 6, 0, cz - 5], [cx + 6, 6, cz + 5], 0xf0e6c8);
  b.gable(cx - 6.6, cx + 6.6, cz - 5.6, cz + 5.6, 6, 9.5, 0x6a2a24, 0xf0e6c8);
  b.box([cx + 2.5, 7, cz - 1], [cx + 3.7, 11, cz + 0.2], 0x8a4a3a); // chimney
  // Porch facing the field (-Z) with posts, door and windows.
  b.box([cx - 6, 0, cz - 7.5], [cx + 6, 0.4, cz - 5], 0x9a7a5a);
  b.box([cx - 6.2, 3.2, cz - 7.8], [cx + 6.2, 3.45, cz - 5], 0x6a2a24);
  for (const x of [-5.6, -2, 2, 5.6]) b.box([cx + x - 0.15, 0.4, cz - 7.5], [cx + x + 0.15, 3.2, cz - 7.2], WHITE);
  b.box([cx - 0.8, 0.4, cz - 5.06], [cx + 0.8, 3, cz - 5], 0x6a3a24);
  for (const x of [-4, 3]) {
    b.box([cx + x - 0.9, 1.4, cz - 5.08], [cx + x + 0.9, 2.8, cz - 5], 0x9ad0ff);
    b.box([cx + x - 1.2, 1.3, cz - 5.1], [cx + x - 0.9, 2.9, cz - 5], 0x2a5a8a);
    b.box([cx + x + 0.9, 1.3, cz - 5.1], [cx + x + 1.2, 2.9, cz - 5], 0x2a5a8a);
  }
}

function tree(b, x, z, s, r) {
  const trunk = 0x6b4a2f;
  b.box([x - 0.35 * s, 0, z - 0.35 * s], [x + 0.35 * s, 3 * s, z + 0.35 * s], trunk);
  if (r() < 0.35) {
    // A pine: stacked cones.
    for (let k = 0; k < 3; k++) b.cyl(x, z, (2 + k * 2) * s, (5 + k * 2) * s, (2.6 - k * 0.7) * s, 0, 0x2f6a3a + Math.floor(r() * 3) * 0x020200, 7);
  } else {
    // A leafy blob: a few overlapping boxes.
    const green = [0x4a8a3a, 0x5a9a42, 0x3f7a34][Math.floor(r() * 3)];
    b.box([x - 2.2 * s, 2.6 * s, z - 2.2 * s], [x + 2.2 * s, 5.4 * s, z + 2.2 * s], green);
    b.box([x - 1.5 * s, 5.4 * s, z - 1.5 * s], [x + 1.5 * s, 6.6 * s, z + 1.5 * s], green);
    b.box([x - 2.7 * s, 3.2 * s, z - 1.2 * s], [x + 2.7 * s, 4.8 * s, z + 1.2 * s], green);
  }
}

function hayStack(b, x, z) {
  for (const [dx, dz, y] of [[-1, 0, 0], [1, 0, 0], [0, 0, 1]]) {
    b.box([x + dx - 0.95, y, z + dz - 0.95], [x + dx + 0.95, y + 1, z + dz + 0.95], HAY);
    b.box([x + dx - 0.97, y + 0.3, z + dz - 0.97], [x + dx + 0.97, y + 0.38, z + dz + 0.97], 0xa8873a);
  }
}

function tractor(b, x, z) {
  b.box([x - 1.6, 0.9, z - 1], [x + 1.4, 2, z + 1], 0xd04848);
  b.box([x - 0.2, 2, z - 0.9], [x + 1.2, 3.4, z + 0.9], 0xd04848);
  b.box([x - 0.1, 2.2, z - 0.92], [x + 1.1, 3.2, z + 0.92], 0x9ad0ff);
  b.box([x - 1.4, 2, z - 0.15], [x - 1.1, 3, z + 0.15], 0x2c2f3a); // exhaust
  for (const [wx, r] of [[0.8, 1.1], [-1.1, 0.7]]) for (const s of [-1, 1]) {
    b.box([x + wx - r, 0, z + s * 1.0], [x + wx + r, 2 * r, z + s * 1.0 + s * 0.5], 0x1d1d1d);
    b.box([x + wx - r * 0.4, r * 0.6, z + s * 1.5 - (s > 0 ? 0 : 0.02)], [x + wx + r * 0.4, r * 1.4, z + s * 1.52], 0xffd84d);
  }
}

/**
 * Build the farm around an open field of half-size `half` with `spawners` and
 * the milk at (mx, mz). Returns { windmill } for the per-frame update.
 */
export function buildFarm(scene, { half, spawners, milkX = 0, milkZ = 0 }) {
  const r = rng(42);
  // Grass past the fence, out to where the fog takes over.
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2).translate(0, -0.02, 0),
    new THREE.MeshStandardMaterial({ color: 0x7aa850, roughness: 1 }));
  outer.receiveShadow = true;
  scene.add(outer);

  // Dirt: a lane from every spawner to a milking yard round the carton, plus the spawn pens.
  const lanes = [];
  const yard = 9, lw = 2.6;
  lanes.push([milkX - yard, milkZ - yard, milkX + yard, milkZ + yard]);
  for (const s of spawners) {
    if (Math.abs(s.x - milkX) > Math.abs(s.z - milkZ)) {
      const a = Math.min(s.x, milkX), c = Math.max(s.x, milkX);
      lanes.push([a, s.z - lw, c, s.z + lw]);
    } else {
      const a = Math.min(s.z, milkZ), c = Math.max(s.z, milkZ);
      lanes.push([s.x - lw, a, s.x + lw, c]);
    }
    lanes.push([s.x - 4, s.z - 4, s.x + 4, s.z + 4]);
  }
  const dirtMat = new THREE.MeshStandardMaterial({ map: dirtTexture(), roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  scene.add(decalMesh(lanes, 0.005, dirtMat));

  const ground = new Builder();
  // Tilled crop patches in the four quadrants: low furrows with sprouts and the odd pumpkin.
  const furrow = 0x6a4a30, sprout = [0x5aa83a, 0x7ac84a, 0x4a9a32];
  for (const [qx, qz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const cx = qx * half * 0.58, cz = qz * half * 0.58, w = half * 0.3;
    for (let k = 0; k < 9; k++) {
      const z = cz - w / 2 + (k + 0.5) * (w / 9);
      ground.box([cx - w / 2, 0, z - 0.45], [cx + w / 2, 0.12, z + 0.45], furrow);
      for (let x = cx - w / 2 + 0.8; x < cx + w / 2; x += 1.6 + r() * 0.8) {
        if (r() < 0.06) { ground.box([x - 0.4, 0.12, z - 0.4], [x + 0.4, 0.75, z + 0.4], 0xe8822a); ground.box([x - 0.06, 0.75, z - 0.06], [x + 0.06, 0.95, z + 0.06], 0x4a7a2a); continue; }
        const hgt = 0.2 + r() * 0.25;
        ground.box([x - 0.12, 0.12, z - 0.12], [x + 0.12, 0.12 + hgt, z + 0.12], sprout[Math.floor(r() * 3)]);
      }
    }
  }
  // Wildflowers and grass tufts scattered over the open field (flat to the ground, ankle high).
  const petals = [0xffffff, 0xffe14d, 0xff8ab4, 0xb08aff];
  for (let k = 0; k < 900; k++) {
    const x = (r() * 2 - 1) * (half - 4), z = (r() * 2 - 1) * (half - 4);
    if (lanes.some(([a, b, c, d]) => x > a - 1 && x < c + 1 && z > b - 1 && z < d + 1)) continue;
    if (r() < 0.6) ground.box([x - 0.08, 0, z - 0.08], [x + 0.08, 0.25 + r() * 0.2, z + 0.08], 0x5a8a34);
    else ground.box([x - 0.1, 0.12, z - 0.1], [x + 0.1, 0.22, z + 0.1], petals[Math.floor(r() * 4)]);
  }
  // Fence posts and a top rail along the inside of the boundary wall.
  for (let t = -half; t <= half; t += 6) {
    for (const [x, z] of [[t, -half], [t, half], [-half, t], [half, t]]) {
      ground.box([x - 0.22, 0, z - 0.22], [x + 0.22, 3.25, z + 0.22], 0x5a3a22);
      ground.box([x - 0.26, 3.25, z - 0.26], [x + 0.26, 3.4, z + 0.26], WHITE);
    }
  }
  // Milking yard: a water trough and a few milk churns by the carton.
  ground.box([milkX + 4.5, 0, milkZ - 6], [milkX + 7.5, 0.8, milkZ - 5], 0xa8b0bc);
  ground.box([milkX + 4.6, 0.7, milkZ - 5.9], [milkX + 7.4, 0.75, milkZ - 5.1], 0x5ab4ff);
  for (const [dx, dz] of [[-6, -4], [-6.8, -5], [-5.3, -5.4]]) {
    ground.cyl(milkX + dx, milkZ + dz, 0, 1.0, 0.38, 0.38, 0xc8ccd2, 10);
    ground.cyl(milkX + dx, milkZ + dz, 1.0, 1.25, 0.38, 0.2, 0xc8ccd2, 10);
    ground.cyl(milkX + dx, milkZ + dz, 1.25, 1.4, 0.24, 0.24, 0x8a9098, 10);
  }
  const gm = ground.mesh(null, { cast: false });
  gm.matrixAutoUpdate = false;
  scene.add(gm);

  // Out past the fence: the farmstead, hay, a tractor, then woods and hills.
  const far = new Builder();
  const o = half + 14;
  barn(far, -o - 6, -30, 16, 22, 9, 1);
  silo(far, -o - 4, 2, 3.5, 17);
  silo(far, -o - 4, 10, 2.8, 13);
  farmhouse(far, 40, o + 8);
  for (const [x, z] of [[-o, 22], [-o + 1, 28], [o, -40], [o + 2, -34], [20, -o], [26, -o - 1]]) hayStack(far, x, z);
  tractor(far, -o + 1, -6);
  // A little red shed and a duck pond by the farmhouse.
  far.box([o + 2, 0, 30], [o + 8, 4, 36], RED);
  far.gable(o + 1.6, o + 8.4, 29.6, 36.4, 4, 6, ROOF, RED);
  for (let k = 0; k < 160; k++) {
    const a = r() * Math.PI * 2, d = half + 22 + r() * 70;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (Math.hypot(x - (-o - 6), z + 30) < 18 || Math.hypot(x - 40, z - (o + 8)) < 14 || Math.hypot(x + o + 4, z - 6) < 10) continue;
    tree(far, x, z, 0.9 + r() * 0.9, r);
  }
  // Rolling hills on the horizon.
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2 + r() * 0.2, d = 240 + r() * 60;
    far.dome(Math.cos(a) * d, Math.sin(a) * d, -6, 40 + r() * 35, [0x6a9a48, 0x7aa850, 0x5a8a40][k % 3], 14, 5);
  }
  const fm = far.mesh();
  fm.matrixAutoUpdate = false;
  scene.add(fm);

  // A windmill whose blades turn (the only thing here that moves).
  const wx = half + 18, wz = 70;
  const tower = new Builder();
  tower.cyl(wx, wz, 0, 16, 3, 1.4, 0xe8e0d0, 8);
  tower.gable(wx - 1.8, wx + 1.8, wz - 1.8, wz + 1.8, 16, 18, 0x6a2a24, 0x6a2a24);
  scene.add(tower.mesh());
  const bladeB = new Builder();
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    // A blade along (ca, sa) in the blade plane (local XY), as a skinny quad pair.
    const p = (u, v) => [ca * u - sa * v, sa * u + ca * v, 0];
    bladeB.quad(p(0.8, -0.9), p(9, -0.9), p(9, 0.9), p(0.8, 0.9), WHITE);
    bladeB.quad(p(0.8, 0.9), p(9, 0.9), p(9, -0.9), p(0.8, -0.9), WHITE);
    bladeB.quad(p(0, -0.15), p(9, -0.15), p(9, 0.15), p(0, 0.15), WOOD);
  }
  bladeB.box([-0.5, -0.5, -0.3], [0.5, 0.5, 0.3], 0x3a2418);
  const blades = bladeB.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
  blades.position.set(wx - 2.2, 16.5, wz);
  blades.rotation.y = Math.PI / 2; // blade plane faces the field
  scene.add(blades);

  return {
    update(dt) { blades.rotateZ(dt * 0.6); },
  };
}

// ---- the milk carton -----------------------------------------------------------

/**
 * Side panel art: blue top band, a cow-spot band, a big goofy MILK, a cow
 * face, and (for the damaged versions) dents, cracks and bite marks.
 */
function cartonPanel(damage, side) {
  return canvasTex(512, (g, n) => {
    const r = rng(100 + side);
    g.fillStyle = '#fbfbff';
    g.fillRect(0, 0, n, n);
    // Cow spots band.
    g.fillStyle = '#1d1d24';
    for (let k = 0; k < 9; k++) {
      g.beginPath();
      g.ellipse(r() * n, n * 0.78 + r() * n * 0.16, 24 + r() * 34, 16 + r() * 22, r() * 3, 0, Math.PI * 2);
      g.fill();
    }
    // Blue band and stripe.
    g.fillStyle = '#2f6fd0';
    g.fillRect(0, 0, n, n * 0.14);
    g.fillStyle = '#ffd84d';
    g.fillRect(0, n * 0.14, n, n * 0.025);
    g.fillStyle = '#ffffff';
    g.font = `bold ${n * 0.07}px Arial Rounded MT Bold, Arial, sans-serif`;
    g.textAlign = 'center';
    g.fillText(['FARM FRESH', 'GRADE MOO', 'WHOLE MILK', '100% UDDERLY'][side], n / 2, n * 0.1);
    // MILK in fat wobbly letters.
    g.save();
    g.translate(n / 2, n * 0.42);
    g.rotate(-0.06);
    g.font = `900 ${n * 0.25}px Impact, Arial Black, sans-serif`;
    g.lineWidth = n * 0.03;
    g.strokeStyle = '#1d3f8a';
    g.strokeText('MILK', 0, 0);
    g.fillStyle = '#3b8af0';
    g.fillText('MILK', 0, 0);
    g.restore();
    // A happy (then worried) cartoon cow face.
    const fx = n * 0.5, fy = n * 0.6;
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#1d1d24';
    g.lineWidth = 5;
    g.beginPath(); g.ellipse(fx, fy, n * 0.13, n * 0.1, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#ffb8c8';
    g.beginPath(); g.ellipse(fx, fy + n * 0.05, n * 0.09, n * 0.045, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#1d1d24';
    for (const s of [-1, 1]) {
      g.beginPath(); g.arc(fx + s * n * 0.05, fy - n * 0.02, n * 0.014, 0, Math.PI * 2); g.fill(); // eyes
      g.beginPath(); g.ellipse(fx + s * n * 0.03, fy + n * 0.05, n * 0.008, n * 0.012, 0, 0, Math.PI * 2); g.fill(); // nostrils
    }
    if (damage >= 2) {
      // Worried eyebrows.
      g.lineWidth = 6;
      for (const s of [-1, 1]) { g.beginPath(); g.moveTo(fx + s * n * 0.075, fy - n * 0.07); g.lineTo(fx + s * n * 0.025, fy - n * 0.05); g.stroke(); }
    }
    if (damage >= 1) {
      // Dents: soft grey shading blobs and crumple lines.
      for (let k = 0; k < 4 + damage * 4; k++) {
        const x = r() * n, y = n * 0.2 + r() * n * 0.7, rad = 20 + r() * 40;
        const grd = g.createRadialGradient(x, y, 2, x, y, rad);
        grd.addColorStop(0, 'rgba(90,90,110,0.35)');
        grd.addColorStop(1, 'rgba(90,90,110,0)');
        g.fillStyle = grd;
        g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
      g.strokeStyle = 'rgba(60,60,80,0.55)';
      g.lineWidth = 3;
      for (let k = 0; k < damage * 5; k++) {
        let x = r() * n, y = n * 0.2 + r() * n * 0.7;
        g.beginPath(); g.moveTo(x, y);
        for (let j = 0; j < 4; j++) { x += (r() - 0.5) * 60; y += (r() - 0.5) * 60; g.lineTo(x, y); }
        g.stroke();
      }
    }
    if (damage >= 2) {
      // Bite marks along an edge, with milk dribbling out.
      g.fillStyle = '#e8ecf4';
      const bx = side % 2 ? n * 0.85 : n * 0.12, by = n * 0.3 + r() * n * 0.3;
      for (let k = 0; k < 5; k++) { g.beginPath(); g.arc(bx, by + k * 22, 14, 0, Math.PI * 2); g.fill(); }
      g.strokeStyle = '#9aa0b0'; g.lineWidth = 3;
      for (let k = 0; k < 5; k++) { g.beginPath(); g.arc(bx, by + k * 22, 14, 0, Math.PI * 2); g.stroke(); }
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.fillRect(bx - 5, by + 100, 10, n - by - 100);
    }
  });
}

/**
 * The milk: a giant gable-top carton on a 3×3 m footprint (the milk block's
 * size), about 4.5 m to the top of its seal. `update(frac)` with the milk left
 * (0..1) squashes, leans and dents it, grows a puddle, and pokes in a straw
 * when it's nearly gone.
 */
export function buildCarton(scene, x = 0, z = 0) {
  const W = 1.5, BODY = 3.2, TOP = 4.25;
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  scene.add(group);
  const pivot = new THREE.Group(); // leans from the base
  group.add(pivot);

  // Four printed side panels, three damage levels each.
  const panels = [0, 1, 2].map((d) => [0, 1, 2, 3].map((s) => cartonPanel(d, s)));
  const sideMats = [0, 1, 2, 3].map((s) => new THREE.MeshStandardMaterial({ map: panels[0][s], roughness: 0.45 }));
  const plain = new THREE.MeshStandardMaterial({ color: 0xfbfbff, roughness: 0.45 });
  // BoxGeometry material order: +x, -x, +y, -y, +z, -z.
  const body = new THREE.Mesh(new THREE.BoxGeometry(2 * W, BODY, 2 * W).translate(0, BODY / 2, 0), [sideMats[1], sideMats[3], plain, plain, sideMats[0], sideMats[2]]);
  body.castShadow = body.receiveShadow = true;
  pivot.add(body);

  // The gable top: two blue roof panels sloping up to a seal fin, white triangle ends.
  const top = new Builder();
  top.gable(-W, W, -W, W, BODY, TOP, 0x2f6fd0, 0xf4f4fa);
  top.box([-W, TOP - 0.02, -0.07], [W, TOP + 0.35, 0.07], 0xf4f4fa); // the fin
  top.box([-W, TOP + 0.12, -0.08], [W, TOP + 0.2, 0.08], 0x2f6fd0);
  // Yellow sunburst sticker on the slope.
  top.box([0.3, BODY + 0.35, W * 0.55], [1.1, BODY + 0.65, W * 0.58], 0xffd84d);
  const topMesh = top.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, side: THREE.DoubleSide }));
  pivot.add(topMesh);

  // A bendy straw (shows up when the milk is nearly gone: the cows are drinking it!).
  const straw = new Builder();
  for (let k = 0; k < 6; k++) straw.cyl(0.6, 0, TOP - 0.5 + k * 0.45, TOP - 0.05 + k * 0.45, 0.13, 0.13, k % 2 ? 0xff5a7a : 0xffffff, 8, false);
  for (let k = 0; k < 3; k++) straw.cyl(0.6 + (k + 1) * 0.3, 0, TOP + 2.2 + k * 0.12, TOP + 2.55 + k * 0.12, 0.13, 0.13, k % 2 ? 0xffffff : 0xff5a7a, 8, false);
  const strawMesh = straw.mesh();
  strawMesh.visible = false;
  pivot.add(strawMesh);

  // A milk puddle at its foot.
  const puddle = new THREE.Mesh(new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  puddle.position.set(W * 0.6, 0.012, W * 0.9);
  puddle.receiveShadow = true;
  group.add(puddle);

  let level = -1, shown = 1, wobble = 0;
  return {
    group,
    /** Bump it (a cow drank): it wobbles a moment. */
    hit() { wobble = 1; },
    update(frac, dt, time) {
      frac = Math.max(0, Math.min(1, frac));
      shown += (frac - shown) * Math.min(1, dt * 4);
      const d = shown > 0.66 ? 0 : shown > 0.33 ? 1 : 2;
      if (d !== level) {
        level = d;
        for (let s = 0; s < 4; s++) { sideMats[s].map = panels[d][s]; sideMats[s].needsUpdate = true; }
        strawMesh.visible = d === 2;
      }
      const lost = 1 - shown;
      wobble = Math.max(0, wobble - dt * 2.5);
      // Squashed down a little and bulging, leaning more as it empties, wobbling when hit.
      pivot.scale.set(1 + lost * 0.06, 1 - lost * 0.12, 1 + lost * 0.04);
      pivot.rotation.z = lost * 0.09 + Math.sin(time * 18) * 0.04 * wobble;
      pivot.rotation.x = -lost * 0.04 + Math.sin(time * 15 + 1) * 0.03 * wobble;
      const p = 0.2 + lost * 3.2;
      puddle.scale.set(p, 1, p * 0.8);
      puddle.visible = lost > 0.02;
    },
  };
}
