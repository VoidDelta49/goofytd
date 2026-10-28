// Tests for pure input maths (no DOM needed).

import { test, assert, assertClose } from './harness.js';
import { STICK_DEADZONE, STICK_RADIUS, stickVector } from '../src/client/touch.js';

test('stick: dead zone is zero, and output ramps from zero just outside it', () => {
  const r = STICK_RADIUS;
  const inside = stickVector(r * STICK_DEADZONE * 0.99, 0);
  assert(inside.x === 0 && inside.y === 0, 'dead zone leaked');
  const edge = stickVector(r * STICK_DEADZONE * 1.01, 0);
  assert(edge.x > 0 && edge.x < 0.02, `no ramp at dead-zone edge: ${edge.x}`);
});

test('stick: full deflection is length 1 in any direction, like a held key', () => {
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
    for (const k of [1, 3]) {
      const v = stickVector(Math.cos(a) * STICK_RADIUS * k, Math.sin(a) * STICK_RADIUS * k);
      assertClose(Math.hypot(v.x, v.y), 1, 1e-9, `length at ${a.toFixed(2)} rad ×${k}`);
    }
  }
});

test('stick: screen up is forward, right is right, half travel is partial speed', () => {
  const up = stickVector(0, -STICK_RADIUS);
  assertClose(up.y, 1, 1e-9, 'forward');
  assertClose(up.x, 0, 1e-9, 'forward x');
  const right = stickVector(STICK_RADIUS, 0);
  assertClose(right.x, 1, 1e-9, 'right');
  const half = stickVector(0, STICK_RADIUS / 2);
  assert(half.y < -0.3 && half.y > -0.6, `half back ${half.y}`);
});

import { MAX_MOUSE_DELTA, sanitizeMouseDelta } from '../src/client/input.js';

test('mouse: normal deltas pass, spikes and non-finite values are discarded', () => {
  const ok = sanitizeMouseDelta(-12, 7);
  assert(ok && ok[0] === -12 && ok[1] === 7, 'normal delta altered');
  assert(sanitizeMouseDelta(MAX_MOUSE_DELTA, 0) !== null, 'limit itself should pass');
  assert(sanitizeMouseDelta(MAX_MOUSE_DELTA + 1, 0) === null, 'x spike passed');
  assert(sanitizeMouseDelta(0, -5000) === null, 'y spike passed');
  assert(sanitizeMouseDelta(NaN, 0) === null && sanitizeMouseDelta(undefined, 1) === null, 'non-finite passed');
});
