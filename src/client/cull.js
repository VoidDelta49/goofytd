// View-frustum culling and instance-matrix maths, pure (no three.js), so Node can test it.
// Planes come from a WebGL view-projection matrix (column-major, clip z in
// [-w, w]) by the Gribb–Hartmann method, normalised so the plane equation
// gives a distance in metres.

/** @param {ArrayLike<number>} m column-major 4×4 view-projection @param {Float64Array} [out] 24 floats: 6 × (nx, ny, nz, d) */
export function frustumPlanes(m, out = new Float64Array(24)) {
  // Row i of the matrix is (m[i], m[4 + i], m[8 + i], m[12 + i]).
  for (let p = 0; p < 6; p++) {
    const row = p >> 1, sign = p & 1 ? -1 : 1; // left/right, bottom/top, near/far
    const a = m[3] + sign * m[row];
    const b = m[7] + sign * m[4 + row];
    const c = m[11] + sign * m[8 + row];
    const d = m[15] + sign * m[12 + row];
    const len = Math.sqrt(a * a + b * b + c * c) || 1;
    out[p * 4] = a / len;
    out[p * 4 + 1] = b / len;
    out[p * 4 + 2] = c / len;
    out[p * 4 + 3] = d / len;
  }
  return out;
}

/** True unless the sphere is wholly outside one of the planes (conservative: never culls a visible sphere). */
export function sphereVisible(planes, x, y, z, r) {
  for (let p = 0; p < 24; p += 4) {
    if (planes[p] * x + planes[p + 1] * y + planes[p + 2] * z + planes[p + 3] < -r) return false;
  }
  return true;
}

/**
 * A sphere enclosing an object's bounding sphere (centre x, y, z, radius r,
 * y ≥ 0) and its shadow on the ground plane y = 0, for a sun in direction
 * `sun` (from the ground toward the light, any length, sun.y > 0).
 * An object off screen whose shadow falls on screen must still be drawn: the
 * shadow pass reuses the same instance list.
 * Proof sketch: projecting along the sun maps the centre to O' = O − (y/sun.y)·sun
 * and stretches distances by at most k = 1 + |sun|/sun.y, so the shadow lies in
 * the sphere (O', r·k); the result encloses that and the object.
 * Writes [cx, cy, cz, radius] into `out`.
 */
export function shadowedSphere(x, y, z, r, sun, out) {
  const t = y / sun.y;
  const len = Math.sqrt(sun.x * sun.x + sun.y * sun.y + sun.z * sun.z);
  out[0] = x - t * sun.x / 2;
  out[1] = y / 2;
  out[2] = z - t * sun.z / 2;
  out[3] = (t * len) / 2 + r * (1 + len / sun.y);
  return out;
}

/**
 * Write T(x,y,z)·R(rx,ry,rz in 'YXZ' order)·S(s) column-major into `te` at
 * `o`: what Object3D.updateMatrix() produced for the cows, without the Euler →
 * quaternion → matrix round trip or the copy into the instance buffer.
 */
export function composeYXZ(te, o, x, y, z, rx, ry, rz, s) {
  const a = Math.cos(rx), b = Math.sin(rx);
  const c = Math.cos(ry), d = Math.sin(ry);
  const e = rz === 0 ? 1 : Math.cos(rz), f = rz === 0 ? 0 : Math.sin(rz);
  const ce = c * e, cf = c * f, de = d * e, df = d * f;
  te[o] = (ce + df * b) * s; te[o + 1] = a * f * s; te[o + 2] = (cf * b - de) * s; te[o + 3] = 0;
  te[o + 4] = (de * b - cf) * s; te[o + 5] = a * e * s; te[o + 6] = (df + ce * b) * s; te[o + 7] = 0;
  te[o + 8] = a * d * s; te[o + 9] = -b * s; te[o + 10] = a * c * s; te[o + 11] = 0;
  te[o + 12] = x; te[o + 13] = y; te[o + 14] = z; te[o + 15] = 1;
}
