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

import { MouseLook, SPIKE_FLOOR, SPIKE_RATIO, SETTLE_EVENTS, DEG_PER_COUNT, LOCK_COOLDOWN_MS, lockRefusalAction, viewQuaternion, rotateByQuaternion } from '../src/client/look.js';
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

// Feed events 1 frame (~16.7 ms) apart, as browsers deliver them under pointer lock.
function feed(m, deltas, t0 = 0, dt = 16.7) {
  return deltas.map(([x, y], i) => m.addMouse(x, y, t0 + i * dt));
}

test('look: counts become the exact turn, mouse right turns right, mouse down looks down', () => {
  const m = new MouseLook();
  feed(m, [...Array(100)].map(() => [1, 0]).concat([[0, 10]]));
  const [dYaw, dPitch] = m.consume(2);
  assertClose(dYaw, -100 * 2 * DEG_PER_COUNT * DEG, 1e-12, 'yaw');
  assertClose(dPitch, -10 * 2 * DEG_PER_COUNT * DEG, 1e-12, 'pitch');
  const [a, b] = m.consume(2);
  assert(a === 0 && b === 0, 'consume did not clear');
});

test('look: a fast flick of 1000+ counts per frame is kept in full', () => {
  const m = new MouseLook();
  const flick = [[40, 0], [200, 5], [700, -10], [1500, 0], [2200, 20], [1300, 0], [400, 0], [60, 0]];
  assert(feed(m, flick).every(Boolean), 'part of a real flick was dropped');
  const total = flick.reduce((s, [x]) => s + x, 0);
  assertClose(m.consume(1)[0], -total * DEG_PER_COUNT * DEG, 1e-12, 'flick total');
});

test('look: a flick that starts hard from rest loses only its first frame', () => {
  const m = new MouseLook();
  const r = feed(m, [[900, 0], [1400, 0], [1600, 0], [800, 0]], 1000);
  assert(!r[0] && r[1] && r[2] && r[3], `accepted ${r}`);
});

test('look: a warp spike in the middle of slow motion is dropped', () => {
  const m = new MouseLook();
  const r = feed(m, [[4, 1], [5, 0], [-960, 540], [5, 1], [4, 0]]);
  assert(r[0] && r[1] && !r[2] && r[3] && r[4], `accepted ${r}`);
  assert(SPIKE_FLOOR * SPIKE_RATIO > 960, 'test assumes spike below the post-reject bar');
});

test('look: lock-change warp events and NaN are dropped', () => {
  const m = new MouseLook();
  m.reset();
  for (let i = 0; i < SETTLE_EVENTS; i++) assert(!m.addMouse(900, -900, i), 'warp accepted');
  assert(!m.addMouse(NaN, 0, 10) && !m.addMouse(undefined, 3, 20), 'non-finite accepted');
  assert(m.addMouse(3, -7, 30), 'normal event rejected after settle');
});

test('look: steady mouse motion gives steady turning (no spin)', () => {
  const m = new MouseLook();
  let yaw = 0, prev = 0, t = 0;
  for (let frame = 0; frame < 600; frame++) {
    m.addMouse(24, 0, (t += 8));
    const [d] = m.consume(1.5);
    assert(d < 0 && (frame === 0 || Math.abs(d - prev) < 1e-12), `uneven turn at frame ${frame}`);
    prev = d; yaw += d;
  }
  assertClose(yaw, -600 * 24 * 1.5 * DEG_PER_COUNT * DEG, 1e-9, 'total');
});

test('lock: refusals after Esc ask for a click; only repeated real refusals switch to drag-look', () => {
  assert(lockRefusalAction({ hasApi: true, msSinceUnlock: 300, refusals: 5 }) === 'cooldown', 'cooldown');
  assert(lockRefusalAction({ hasApi: true, msSinceUnlock: LOCK_COOLDOWN_MS + 1, refusals: 1 }) === 'retry', 'first refusal');
  assert(lockRefusalAction({ hasApi: true, msSinceUnlock: Infinity, refusals: 2 }) === 'fallback', 'sandboxed');
  assert(lockRefusalAction({ hasApi: false, msSinceUnlock: 0, refusals: 0 }) === 'fallback', 'no API');
});

import { loadSettings, DEFAULT_SETTINGS } from '../src/client/input.js';

test('settings: corrupt or out-of-range stored values fall back to defaults', () => {
  const store = (v) => ({ getItem: () => v });
  assert(loadSettings(store('{"sensitivity":1e9,"touchSensitivity":"x"}')).sensitivity === DEFAULT_SETTINGS.sensitivity, 'huge sens kept');
  assert(loadSettings(store('not json')).touchSensitivity === DEFAULT_SETTINGS.touchSensitivity, 'corrupt not handled');
  assert(loadSettings(store('{"sensitivity":3.2}')).sensitivity === 3.2, 'valid sens dropped');
});
