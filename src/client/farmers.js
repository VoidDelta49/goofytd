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

const mats = new Map();
function mat(color) {
  if (!mats.has(color)) mats.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
  return mats.get(color);
}

function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function cyl(rTop, rBottom, h, color, x = 0, y = 0, z = 0, seg = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** A pivot group at (x, y, z) so a limb swings from its top. */
function joint(x, y, z, ...children) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.add(...children);
  return g;
}

/** Slightly darker stripes over the shirt colour: the plaid. */
function plaidTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const base = new THREE.Color(color);
  g.fillStyle = `#${base.getHexString()}`;
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = `#${base.clone().multiplyScalar(0.55).getHexString()}`;
  g.globalAlpha = 0.6;
  g.fillRect(0, 10, 32, 5); g.fillRect(10, 0, 5, 32);
  g.globalAlpha = 0.35;
  g.fillRect(0, 24, 32, 2); g.fillRect(24, 0, 2, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
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
  const shirt = new THREE.MeshStandardMaterial({ map: plaidTexture(color), roughness: 0.9 });
  const root = new THREE.Group();
  const body = new THREE.Group(); // squashes when crouching, bobs when walking
  root.add(body);

  const leg = (x) => joint(x, 0.86, 0,
    box(0.2, 0.72, 0.22, DENIM, 0, -0.38, 0),
    box(0.22, 0.14, 0.32, BOOT, 0, -0.79, -0.04));
  const legL = leg(-0.13), legR = leg(0.13);

  const torso = box(0.52, 0.36, 0.3, DENIM, 0, 1.02, 0); // overall trousers' top
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.34, 0.3), shirt);
  chest.position.set(0, 1.37, 0);
  chest.castShadow = true;
  const bib = box(0.34, 0.3, 0.02, DENIM, 0, 1.3, -0.16);
  const strapL = box(0.06, 0.24, 0.02, DENIM, -0.14, 1.5, -0.16);
  const strapR = box(0.06, 0.24, 0.02, DENIM, 0.14, 1.5, -0.16);
  const buttonL = box(0.04, 0.04, 0.02, STRAW, -0.14, 1.42, -0.175);
  const buttonR = box(0.04, 0.04, 0.02, STRAW, 0.14, 1.42, -0.175);

  const arm = (x) => {
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.18), shirt);
    sleeve.position.set(0, -0.24, 0);
    sleeve.castShadow = true;
    return joint(x, 1.52, 0, sleeve, box(0.13, 0.13, 0.13, SKIN, 0, -0.55, 0));
  };
  const armL = arm(-0.35), armR = arm(0.35);
  // Pitchfork in the right hand, held upright.
  const fork = new THREE.Group();
  fork.position.set(0, -0.56, -0.05);
  fork.add(cyl(0.025, 0.025, 1.5, WOOD, 0, 0.2, 0, 6));
  fork.add(box(0.26, 0.04, 0.04, STEEL, 0, 0.95, 0));
  for (const x of [-0.11, 0, 0.11]) fork.add(box(0.03, 0.26, 0.03, STEEL, x, 1.1, 0));
  armR.add(fork);

  const head = joint(0, 1.56, 0,
    box(0.32, 0.32, 0.3, SKIN, 0, 0.17, 0),
    box(0.05, 0.05, 0.02, 0x1a1a1a, -0.08, 0.2, -0.155),
    box(0.05, 0.05, 0.02, 0x1a1a1a, 0.08, 0.2, -0.155),
    box(0.06, 0.07, 0.06, 0xe0a070, 0, 0.13, -0.17), // nose
    box(0.18, 0.03, 0.02, 0x7a3b2e, 0, 0.05, -0.155), // grin
    cyl(0.4, 0.4, 0.035, STRAW, 0, 0.35, 0, 20), // brim
    cyl(0.18, 0.21, 0.2, STRAW, 0, 0.46, 0, 16), // crown
    cyl(0.215, 0.215, 0.05, color, 0, 0.39, 0, 16)); // hat band in their colour

  body.add(legL, legR, torso, chest, bib, strapL, strapR, buttonL, buttonR, armL, armR, head);

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
