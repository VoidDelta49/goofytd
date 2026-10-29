// Render culling maths (src/client/cull.js): frustum planes against clip-space
// truth, never culling anything visible, shadow-enclosing spheres, and the
// hand-written cow matrix against elementary matrix products.

import { test, assert, assertClose } from './harness.js';
import { frustumPlanes, sphereVisible, shadowedSphere, composeYXZ } from '../src/client/cull.js';

/** Column-major 4×4 helpers (same layout as three.js). */
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const trans = (x, y, z) => { const m = ident(); m[12] = x; m[13] = y; m[14] = z; return m; };
const scale = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
const rotX = (a) => [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1];
const rotY = (a) => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
const rotZ = (a) => [Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const apply = (m, x, y, z) => [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);

/** WebGL perspective (three.js PerspectiveCamera) times a view from an eye with yaw/pitch. */
function viewProj(fovDeg, aspect, near, far, eye, yaw, pitch) {
  const t = near * Math.tan((fovDeg * Math.PI) / 360), h = 2 * t, w = aspect * h;
  const p = new Array(16).fill(0);
  p[0] = (2 * near) / w; p[5] = (2 * near) / h;
  p[10] = -(far + near) / (far - near); p[11] = -1; p[14] = (-2 * far * near) / (far - near);
  // Camera world = T(eye)·Ry(yaw)·Rx(pitch); view = inverse.
  const view = mul(mul(rotX(-pitch), rotY(-yaw)), trans(-eye[0], -eye[1], -eye[2]));
  return mul(p, view);
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const insideClip = (m, x, y, z, eps = 0) => {
  const [cx, cy, cz, cw] = apply(m, x, y, z);
  return cw > 0 && Math.abs(cx) <= cw + eps && Math.abs(cy) <= cw + eps && Math.abs(cz) <= cw + eps;
};

test('cull: frustum planes agree with clip space for points', () => {
  const r = rng(1);
  for (let v = 0; v < 6; v++) {
    const m = viewProj(70, 16 / 9, 0.05, 30 + 200 * r(), [r() * 40 - 20, 1.6, r() * 40 - 20], r() * 6.3, r() - 0.5);
    const planes = frustumPlanes(m);
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      const x = r() * 400 - 200, y = r() * 60 - 10, z = r() * 400 - 200;
      const inside = insideClip(m, x, y, z);
      // Skip points sitting on a boundary, where rounding may go either way.
      if (inside !== insideClip(m, x, y, z, 1e-6) || inside !== insideClip(m, x, y, z, -1e-6)) continue;
      assert(sphereVisible(planes, x, y, z, 0) === inside, `view ${v}: point (${x}, ${y}, ${z}) inside=${inside}`);
      checked++;
    }
    assert(checked > 3900, `only ${checked} points checked`);
  }
});

test('cull: a sphere with any point on screen is never culled, and far-off ones are', () => {
  const r = rng(2);
  let culled = 0;
  for (let v = 0; v < 4; v++) {
    const m = viewProj(70, 0.5 + 2 * r(), 0.05, 220, [0, 1.6, 10], r() * 6.3, -0.3 * r());
    const planes = frustumPlanes(m);
    for (let i = 0; i < 1500; i++) {
      const cx = r() * 300 - 150, cy = r() * 10, cz = r() * 300 - 150, rad = 0.2 + r() * 6;
      let anyInside = false;
      for (let k = 0; k < 300 && !anyInside; k++) {
        // Points through the ball, including its surface.
        let dx = r() * 2 - 1, dy = r() * 2 - 1, dz = r() * 2 - 1;
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1, f = (k % 2 ? 1 : r()) * rad / l;
        dx *= f; dy *= f; dz *= f;
        anyInside = insideClip(m, cx + dx, cy + dy, cz + dz);
      }
      const vis = sphereVisible(planes, cx, cy, cz, rad);
      if (anyInside) assert(vis, `visible sphere culled at (${cx}, ${cy}, ${cz}) r ${rad}`);
      if (!vis) culled++;
    }
  }
  assert(culled > 2000, `culled only ${culled} of 6000`); // it does cull most of an all-round field
});

test('cull: shadowedSphere encloses the object and its ground shadow', () => {
  const r = rng(3);
  const sun = { x: 30, y: 60, z: 20 }; // the Renderer's sunOffset
  const len = Math.sqrt(30 * 30 + 60 * 60 + 20 * 20);
  const out = new Float64Array(4);
  for (let i = 0; i < 300; i++) {
    const x = r() * 100 - 50, z = r() * 100 - 50, rad = 0.3 + r() * 4, y = rad * r() + r() * 6;
    shadowedSphere(x, y, z, rad, sun, out);
    for (let k = 0; k < 200; k++) {
      let dx = r() * 2 - 1, dy = r() * 2 - 1, dz = r() * 2 - 1;
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const px = x + (dx / l) * rad, py = Math.max(0, y + (dy / l) * rad), pz = z + (dz / l) * rad;
      // The point and where its shadow lands on y = 0.
      const t = py / sun.y;
      for (const [qx, qy, qz] of [[px, py, pz], [px - t * sun.x, 0, pz - t * sun.z]]) {
        const d = Math.sqrt((qx - out[0]) ** 2 + (qy - out[1]) ** 2 + (qz - out[2]) ** 2);
        assert(d <= out[3] + 1e-9, `point ${d} outside radius ${out[3]}`);
      }
    }
    // Not absurdly loose either: within the proof's bound.
    assert(out[3] <= (y / sun.y) * len / 2 + rad * (1 + len / sun.y) + 1e-9);
  }
});

test('cull: composeYXZ equals T·Ry·Rx·Rz·S (three.js Euler YXZ + compose)', () => {
  const r = rng(4);
  const te = new Float64Array(32);
  for (let i = 0; i < 500; i++) {
    const x = r() * 100 - 50, y = r() * 5, z = r() * 100 - 50, s = 0.3 + r() * 2.5;
    const rx = i % 3 ? r() * 2 - 1 : 0, ry = r() * 12 - 6, rz = i % 4 === 0 ? 0 : i % 5 === 0 ? Math.PI / 2 : r() * 2 - 1;
    composeYXZ(te, 16, x, y, z, rx, ry, rz, s);
    const want = mul(mul(mul(mul(trans(x, y, z), rotY(ry)), rotX(rx)), rotZ(rz)), scale(s));
    for (let k = 0; k < 16; k++) assertClose(te[16 + k], want[k], 1e-12, `element ${k}`);
  }
});
