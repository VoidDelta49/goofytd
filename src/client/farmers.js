// The other farmers in a co-op match: straw hat, plaid-ish shirt in their
// lobby colour, denim overalls, boots and a pitchfork, with a name tag. Built
// from boxes and cylinders (no model files). Walks when moving, squashes when
// crouching, looks up and down with its head. Reads session tracks; never
// touches the sim.

import * as THREE from 'three';
import { FARMER_COLORS } from '../net/session.js';

const SKIN = 0xf0c08a;
const DENIM = 0x3c5f9c;
const BOOT = 0x5a3a22;
const STRAW = 0xe6c15a;
const WOOD = 0x8a5a2b;
const STEEL = 0xb8bec6;

/**
 * One rigid piece (a leg, an arm, the head, the body) is one mesh: its boxes
 * and cylinders merged into a single geometry with vertex colours, all
 * sharing one material per farmer. The shirt's plaid lives in the left of a
 * small atlas and everything else samples its white strip, so plain and
 * plaid parts can share that material. A farmer is 6 draws plus its name tag,
 * instead of 28.
 */
const ATLAS_PLAID = 64; // two 32 px plaid tiles across and down, like repeat(2, 2) used to
const ATLAS_W = 72; // plus an 8 px white strip
const WHITE_U = (ATLAS_PLAID + 4) / ATLAS_W;
const SHIRT = -1; // colour marker: textured with the plaid

function box(w, h, d, color, x = 0, y = 0, z = 0) {
  return { geo: new THREE.BoxGeometry(w, h, d), color, x, y, z };
}

function cyl(rTop, rBottom, h, color, x = 0, y = 0, z = 0, seg = 16) {
  return { geo: new THREE.CylinderGeometry(rTop, rBottom, h, seg), color, x, y, z };
}

/** Merge parts ({geo, color, x, y, z}) into one geometry: position, normal, uv (into the atlas), colour. */
function mergeParts(parts) {
  const pos = [], nrm = [], uv = [], col = [], idx = [];
  const c = new THREE.Color();
  for (const { geo, color, x, y, z } of parts) {
    const p = geo.attributes.position, n = geo.attributes.normal, t = geo.attributes.uv;
    const base = pos.length / 3;
    if (color === SHIRT) c.setRGB(1, 1, 1); else c.setHex(color);
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i) + x, p.getY(i) + y, p.getZ(i) + z);
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      if (color === SHIRT) uv.push(t.getX(i) * ATLAS_PLAID / ATLAS_W, t.getY(i));
      else uv.push(WHITE_U, 0.5);
      col.push(c.r, c.g, c.b);
    }
    for (const i of geo.index.array) idx.push(base + i);
    geo.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** A pivot group at (x, y, z) holding one merged mesh, so a limb swings from its top. */
function joint(material, x, y, z, ...parts) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const m = new THREE.Mesh(mergeParts(parts), material);
  m.castShadow = true;
  g.add(m);
  return g;
}

/** The plaid (slightly darker stripes over the shirt colour), tiled 2×2, beside a white strip. */
function atlasTexture(color) {
  const c = document.createElement('canvas');
  c.width = ATLAS_W;
  c.height = ATLAS_PLAID;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, ATLAS_W, ATLAS_PLAID);
  const base = new THREE.Color(color);
  for (const ox of [0, 32]) for (const oy of [0, 32]) {
    g.globalAlpha = 1;
    g.fillStyle = `#${base.getHexString()}`;
    g.fillRect(ox, oy, 32, 32);
    g.fillStyle = `#${base.clone().multiplyScalar(0.55).getHexString()}`;
    g.globalAlpha = 0.6;
    g.fillRect(ox, oy + 10, 32, 5); g.fillRect(ox + 10, oy, 5, 32);
    g.globalAlpha = 0.35;
    g.fillRect(ox, oy + 24, 32, 2); g.fillRect(ox + 24, oy, 2, 32);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  // No mipmaps: they would bleed the white strip into the plaid's edge.
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

function nameTag(name, color) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = '700 40px ui-monospace, Menlo, Consolas, monospace';
  g.font = font;
  const w = Math.ceil(g.measureText(name).width) + 36;
  c.width = w; c.height = 60;
  g.font = font;
  g.fillStyle = '#000a';
  g.beginPath(); g.roundRect(0, 0, w, 60, 14); g.fill();
  g.fillStyle = `#${new THREE.Color(color).getHexString()}`;
  g.fillRect(10, 18, 8, 24);
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(name, 26, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  s.scale.set(0.3 * w / 60, 0.3, 1);
  s.renderOrder = 10;
  return s;
}

/** Build one farmer. Origin at the feet, facing -Z (yaw 0), 1.8 m tall like the player hull. */
export function buildFarmer(name, colorIndex) {
  const color = FARMER_COLORS[colorIndex] ?? FARMER_COLORS[0];
  const mat = new THREE.MeshStandardMaterial({ map: atlasTexture(color), vertexColors: true, roughness: 0.85 });
  const root = new THREE.Group();
  const body = new THREE.Group(); // squashes when crouching, bobs when walking
  root.add(body);

  const leg = (x) => joint(mat, x, 0.86, 0,
    box(0.2, 0.72, 0.22, DENIM, 0, -0.38, 0),
    box(0.22, 0.14, 0.32, BOOT, 0, -0.79, -0.04));
  const legL = leg(-0.13), legR = leg(0.13);

  const trunk = joint(mat, 0, 0, 0,
    box(0.52, 0.36, 0.3, DENIM, 0, 1.02, 0), // overall trousers' top
    box(0.52, 0.34, 0.3, SHIRT, 0, 1.37, 0), // chest
    box(0.34, 0.3, 0.02, DENIM, 0, 1.3, -0.16), // bib
    box(0.06, 0.24, 0.02, DENIM, -0.14, 1.5, -0.16), // straps
    box(0.06, 0.24, 0.02, DENIM, 0.14, 1.5, -0.16),
    box(0.04, 0.04, 0.02, STRAW, -0.14, 1.42, -0.175), // buttons
    box(0.04, 0.04, 0.02, STRAW, 0.14, 1.42, -0.175));

  const arm = (x, ...extra) => joint(mat, x, 1.52, 0,
    box(0.16, 0.5, 0.18, SHIRT, 0, -0.24, 0), // sleeve
    box(0.13, 0.13, 0.13, SKIN, 0, -0.55, 0), // hand
    ...extra);
  const armL = arm(-0.35);
  // Pitchfork in the right hand, held upright (its origin at (0, -0.56, -0.05) in the arm).
  const fx = 0, fy = -0.56, fz = -0.05;
  const armR = arm(0.35,
    cyl(0.025, 0.025, 1.5, WOOD, fx, fy + 0.2, fz, 6),
    box(0.26, 0.04, 0.04, STEEL, fx, fy + 0.95, fz),
    ...[-0.11, 0, 0.11].map((x) => box(0.03, 0.26, 0.03, STEEL, fx + x, fy + 1.1, fz)));

  const head = joint(mat, 0, 1.56, 0,
    box(0.32, 0.32, 0.3, SKIN, 0, 0.17, 0),
    box(0.05, 0.05, 0.02, 0x1a1a1a, -0.08, 0.2, -0.155),
    box(0.05, 0.05, 0.02, 0x1a1a1a, 0.08, 0.2, -0.155),
    box(0.06, 0.07, 0.06, 0xe0a070, 0, 0.13, -0.17), // nose
    box(0.18, 0.03, 0.02, 0x7a3b2e, 0, 0.05, -0.155), // grin
    cyl(0.4, 0.4, 0.035, STRAW, 0, 0.35, 0, 20), // brim
    cyl(0.18, 0.21, 0.2, STRAW, 0, 0.46, 0, 16), // crown
    cyl(0.215, 0.215, 0.05, color, 0, 0.39, 0, 16)); // hat band in their colour

  body.add(legL, legR, trunk, armL, armR, head);

  const tag = nameTag(name, color);
  tag.position.y = 2.35;
  root.add(tag);
  return { root, body, legL, legR, armL, armR, head, tag, phase: 0 };
}

export class FarmerRenderer {
  constructor(scene) {
    this.scene = scene;
    /** id -> farmer model + the name/colour it was built with. */
    this.models = new Map();
  }

  /**
   * @param {Map<number, {name: string, color: number, track: import('../net/track.js').Track}>} remotes
   * @param {number} now ms @param {number} dt s
   */
  update(remotes, now, dt) {
    for (const [id, m] of this.models) {
      const r = remotes.get(id);
      if (!r || r.name !== m.name || r.color !== m.color) { this.scene.remove(m.f.root); this.models.delete(id); }
    }
    for (const [id, r] of remotes) {
      const s = r.track.sample(now);
      let m = this.models.get(id);
      if (!m) {
        m = { name: r.name, color: r.color, f: buildFarmer(r.name, r.color) };
        this.models.set(id, m);
        this.scene.add(m.f.root);
      }
      const f = m.f;
      f.root.visible = !!s;
      if (!s) continue;
      f.root.position.set(s.x, s.y, s.z);
      f.root.rotation.y = s.yaw;
      // Walk cycle from how fast they're actually going; an unhurried farmer just stands.
      const walk = Math.min(s.speed / 7.5, 1.4);
      f.phase += dt * (4 + 6 * walk) * (walk > 0.05 ? 1 : 0);
      const swing = Math.sin(f.phase) * 0.7 * Math.min(walk, 1);
      f.legL.rotation.x = swing;
      f.legR.rotation.x = -swing;
      f.armL.rotation.x = -swing * 0.8;
      f.armR.rotation.x = swing * 0.4 - 0.25; // fork arm stays forward-ish
      f.body.position.y = Math.abs(Math.sin(f.phase)) * 0.06 * Math.min(walk, 1);
      // Crouching: squash to the 1.2 m crouch hull (goofy, but readable).
      const sy = s.crouched ? 1.2 / 1.8 : 1;
      f.body.scale.y += (sy - f.body.scale.y) * Math.min(1, dt * 18);
      f.tag.position.y = 2.35 * f.body.scale.y + 0.1;
      f.head.rotation.x = Math.max(-0.7, Math.min(0.7, s.pitch));
    }
  }

  /** The other farmers as boxes, so you can't build a tower on someone's head. */
  boxes() {
    const out = [];
    for (const { f } of this.models.values()) {
      if (!f.root.visible) continue;
      const p = f.root.position, h = 1.8 * f.body.scale.y;
      out.push({ min: { x: p.x - 0.4, y: p.y, z: p.z - 0.4 }, max: { x: p.x + 0.4, y: p.y + h, z: p.z + 0.4 } });
    }
    return out;
  }
}
