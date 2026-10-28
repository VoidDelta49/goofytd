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

import { MouseLook, MAX_EVENT_COUNTS, SETTLE_EVENTS, DEG_PER_COUNT, viewQuaternion, rotateByQuaternion } from '../src/client/look.js';
import { yawForward, yawRight } from '../src/sim/movement.js';

const DEG = Math.PI / 180;

test('look: forward/right/up of the view match the movement axes at any yaw and pitch', () => {
  for (let yaw = -7; yaw <= 7; yaw += 0.37) {
    for (const pitch of [-88, -45, -10, 0, 10, 45, 88].map((d) => d * DEG)) {
      const q = viewQuaternion(yaw, pitch);
      assertClose(Math.hypot(...q), 1, 1e-12, 'unit quaternion');
      const f = rotateByQuaternion(q, [0, 0, -1]);
      const r = rotateByQuaternion(q, [1, 0, 0]);
      const fw = yawForward(yaw), rt = yawRight(yaw);
      // Forward = flat forward tilted by pitch; right stays level (no roll).
      assertClose(f[0], fw.x * Math.cos(pitch), 1e-9, 'fwd x');
      assertClose(f[1], Math.sin(pitch), 1e-9, 'fwd y');
      assertClose(f[2], fw.z * Math.cos(pitch), 1e-9, 'fwd z');
      assertClose(r[0], rt.x, 1e-9, 'right x');
      assertClose(r[1], 0, 1e-9, 'roll');
      assertClose(r[2], rt.z, 1e-9, 'right z');
    }
  }
});

test('look: counts become the exact turn, mouse right turns right, mouse down looks down', () => {
  const m = new MouseLook();
  for (let i = 0; i < 100; i++) m.addMouse(1, 0);
  m.addMouse(0, 10);
  const [dYaw, dPitch] = m.consume(2);
  assertClose(dYaw, -100 * 2 * DEG_PER_COUNT * DEG, 1e-12, 'yaw');
  assertClose(dPitch, -10 * 2 * DEG_PER_COUNT * DEG, 1e-12, 'pitch');
  const [a, b] = m.consume(2);
  assert(a === 0 && b === 0, 'consume did not clear');
});

test('look: lock-change warp events, spikes and NaN are dropped, nothing else is', () => {
  const m = new MouseLook();
  m.reset();
  for (let i = 0; i < SETTLE_EVENTS; i++) assert(!m.addMouse(900, -900), 'warp accepted');
  assert(!m.addMouse(MAX_EVENT_COUNTS + 1, 0) && !m.addMouse(0, -5000), 'spike accepted');
  assert(!m.addMouse(NaN, 0) && !m.addMouse(undefined, 3), 'non-finite accepted');
  assert(m.addMouse(MAX_EVENT_COUNTS, -7), 'limit rejected');
  const [dYaw] = m.consume(1);
  assertClose(dYaw, -MAX_EVENT_COUNTS * DEG_PER_COUNT * DEG, 1e-12, 'only the good event counts');
});

test('look: steady mouse motion gives steady turning, never sign flips (no spin)', () => {
  const m = new MouseLook();
  let yaw = 0, prev = 0;
  for (let frame = 0; frame < 600; frame++) {
    for (let e = 0; e < 8; e++) m.addMouse(3, 0); // 1000 Hz mouse at ~125 fps
    const [d] = m.consume(1.5);
    assert(d < 0 && (frame === 0 || Math.abs(d - prev) < 1e-12), `uneven turn at frame ${frame}`);
    prev = d; yaw += d;
  }
  assertClose(yaw, -600 * 8 * 3 * 1.5 * DEG_PER_COUNT * DEG, 1e-9, 'total');
});

import { loadSettings, DEFAULT_SETTINGS } from '../src/client/input.js';

test('settings: corrupt or out-of-range stored values fall back to defaults', () => {
  const store = (v) => ({ getItem: () => v });
  assert(loadSettings(store('{"sensitivity":1e9,"touchSensitivity":"x"}')).sensitivity === DEFAULT_SETTINGS.sensitivity, 'huge sens kept');
  assert(loadSettings(store('not json')).touchSensitivity === DEFAULT_SETTINGS.touchSensitivity, 'corrupt not handled');
  assert(loadSettings(store('{"sensitivity":3.2}')).sensitivity === 3.2, 'valid sens dropped');
});
