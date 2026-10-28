// Behavioural tests for collision and movement. Each runs the real `tick`
// at the game's fixed rate against a small hand-built world.

import { test, assert, assertClose } from './harness.js';
import { Aabb, CollisionWorld } from '../src/sim/collision.js';
import { Vec3, v3 } from '../src/sim/vec3.js';
import {
  createPlayerState, defaultMoveConfig, emptyInput, horizontalSpeed, hullHalfExtents, tick,
} from '../src/sim/movement.js';
import { LEVELS, levelCollision, openField } from '../src/level.js';

const DT = 1 / 64;
const HALF = v3(0.4, 0.9, 0.4);
const box = (min, max) => new Aabb(v3(...min), v3(...max));
const flatWorld = (...extra) => new CollisionWorld([box([-500, -1, -500], [500, 0, 500]), ...extra]);
const input = (o = {}) => ({ ...emptyInput(), ...o, wish: { x: 0, y: 0, ...(o.wish || {}) } });
const FORWARD = { wish: { x: 0, y: 1 } };

function standing(cfg, world, pos) {
  const s = createPlayerState(pos, cfg);
  for (let i = 0; i < 8; i++) tick(s, emptyInput(), cfg, world, DT);
  assert(s.grounded, 'setup: player should be grounded');
  return s;
}

function run(s, inp, cfg, world, ticks) {
  for (let i = 0; i < ticks; i++) tick(s, inp, cfg, world, DT);
}

// ---------------------------------------------------------------- collision

test('collision: falling box hits floor top halfway', () => {
  const hit = flatWorld().sweep(v3(0, 2.9, 0), HALF, v3(0, -4, 0));
  assert(hit, 'expected a hit');
  assertClose(hit.t, 0.5, 1e-9, 't');
  assert(hit.normal.equals(Vec3.Y), 'normal should be +Y');
});

test('collision: resting box slides freely, even sunk by rounding error', () => {
  const w = flatWorld();
  assert(w.sweep(v3(0, 0.9, 0), HALF, v3(5, 0, 0)) === null);
  assert(w.sweep(v3(0, 0.9 - 1e-6, 0), HALF, v3(5, 0, 3)) === null);
});

test('collision: resting box is blocked downward at t = 0', () => {
  const hit = flatWorld().sweep(v3(0, 0.9 - 1e-6, 0), HALF, v3(0, -0.1, 0));
  assert(hit && hit.t === 0 && hit.normal.equals(Vec3.Y));
});

test('collision: moving away from a touching face is free', () => {
  assert(flatWorld().sweep(v3(0, 0.9, 0), HALF, v3(0, 1, 0)) === null);
});

test('collision: fast sweep does not tunnel through a thin wall', () => {
  const w = new CollisionWorld([box([5, -10, -10], [5.01, 10, 10])]);
  const hit = w.sweep(Vec3.ZERO, HALF, v3(1000, 0, 0));
  assert(hit && hit.normal.x === -1);
  assertClose(1000 * hit.t, 4.6, 1e-6, 'stop x');
});

test('collision: starting deeply inside does not block', () => {
  assert(flatWorld().sweep(v3(0, 0, 0), HALF, v3(0, 2, 0)) === null);
});

// ---------------------------------------------------------------- movement

test('idle on the floor does not drift for a minute', () => {
  const cfg = defaultMoveConfig();
  const w = flatWorld();
  const s = standing(cfg, w, Vec3.ZERO);
  run(s, emptyInput(), cfg, w, 64 * 60);
  assert(s.grounded);
  assert(s.position.length() < 1e-6, `drifted to ${s.position.toArray()}`);
  assert(s.velocity.equals(Vec3.ZERO));
});

test('falls and lands on the floor top, reporting landing speed', () => {
  const cfg = defaultMoveConfig();
  const w = flatWorld();
  const s = createPlayerState(v3(0, 10, 0), cfg);
  let landed = 0;
  for (let i = 0; i < 200; i++) {
    tick(s, emptyInput(), cfg, w, DT);
    landed = Math.max(landed, s.landedSpeed);
  }
  assert(s.grounded);
  assertClose(s.position.y, 0, 1e-3, 'feet y');
  assertClose(landed, Math.sqrt(2 * cfg.gravity * 10), 0.5, 'landing speed');
});

test('ground acceleration reaches and holds max speed; diagonal is not faster', () => {
  const cfg = defaultMoveConfig();
  const w = flatWorld();
  const s = standing(cfg, w, Vec3.ZERO);
  run(s, input(FORWARD), cfg, w, 64 * 3);
  assertClose(horizontalSpeed(s), cfg.maxGroundSpeed, 0.05, 'speed');
  assert(s.velocity.z < 0 && Math.abs(s.velocity.x) < 1e-6, 'yaw 0 should move toward -Z');
  run(s, input({ wish: { x: 1, y: 1 } }), cfg, w, 64 * 3);
  assert(horizontalSpeed(s) <= cfg.maxGroundSpeed + 0.05, 'diagonal faster than straight');
});

test('friction stops a full-speed run in under half a second', () => {
  const cfg = defaultMoveConfig();
  const w = flatWorld();
  const s = standing(cfg, w, Vec3.ZERO);
  run(s, input(FORWARD), cfg, w, 128);
  let ticks = 0;
  while (horizontalSpeed(s) > 0) {
    tick(s, emptyInput(), cfg, w, DT);
    assert(++ticks < 64, 'still sliding after a second');
  }
  assert(ticks < 32, `took ${ticks} ticks to stop`);
});

test('walls block, and diagonal input slides along them', () => {
  const cfg = defaultMoveConfig();
  const w = flatWorld(box([-50, 0, -4], [50, 3, -3])); // near face at z = -3
  const s = standing(cfg, w, Vec3.ZERO);
  let maxPen = 0;
  for (let i = 0; i < 64 * 3; i++) {
    tick(s, input({ wish: { x: 1, y: 1 } }), cfg, w, DT);
    maxPen = Math.max(maxPen, -3 - (s.position.z - cfg.hullHalfWidth));
  }
  assert(maxPen <= 1e-3, `penetrated wall by ${maxPen}`);
  assertClose(s.position.z, -3 + cfg.hullHalfWidth, 1e-3, 'z against wall');
  assert(s.velocity.x > 3, `slide speed ${s.velocity.x}`);
  assert(s.grounded);
});

test('jump apex and flight time match ballistics', () => {
  const cfg = defaultMoveConfig();
  const w = flatWorld();
  const s = standing(cfg, w, Vec3.ZERO);
  tick(s, input({ jumpPressed: true }), cfg, w, DT);
  assert(s.jumpedThisTick && !s.grounded);
  let apex = 0, airTicks = 1;
  while (!s.grounded) {
    tick(s, emptyInput(), cfg, w, DT);
    apex = Math.max(apex, s.position.y);
    assert(++airTicks < 200);
  }
  assertClose(apex, cfg.jumpSpeed ** 2 / (2 * cfg.gravity), 0.02, 'apex');
  assertClose(airTicks * DT, (2 * cfg.jumpSpeed) / cfg.gravity, 2 * DT, 'flight time');
});

test('holding jump does not re-hop unless autoHop is on', () => {
  const w = flatWorld();
  for (const autoHop of [false, true]) {
    const cfg = { ...defaultMoveConfig(), autoHop };
    const s = standing(cfg, w, Vec3.ZERO);
    tick(s, input({ jumpPressed: true, jumpHeld: true }), cfg, w, DT);
    let jumps = 1;
    for (let i = 0; i < 64 * 3; i++) {
      tick(s, input({ jumpHeld: true }), cfg, w, DT);
      jumps += s.jumpedThisTick ? 1 : 0;
    }
    if (autoHop) assert(jumps >= 4, `auto hop jumped ${jumps} times`);
    else assert(jumps === 1, `held jump re-hopped ${jumps} times`);
  }
});

test('a jump pressed just before landing is buffered', () => {
  const cfg = defaultMoveConfig();
  const w = flatWorld();
  const s = createPlayerState(v3(0, 1, 0), cfg);
  while (s.position.y > 0.25) tick(s, emptyInput(), cfg, w, DT);
  assert(!s.grounded);
  tick(s, input({ jumpPressed: true }), cfg, w, DT);
  let jumped = s.jumpedThisTick;
  for (let i = 0; i < 16; i++) {
    tick(s, emptyInput(), cfg, w, DT);
    jumped ||= s.jumpedThisTick;
  }
  assert(jumped, 'buffered jump was dropped');
});

test('coyote time allows one late jump after walking off a ledge', () => {
  const cfg = defaultMoveConfig();
  const w = new CollisionWorld([box([-10, -1, -2], [10, 0, 10]), box([-50, -21, -50], [50, -20, 50])]);
  const s = standing(cfg, w, Vec3.ZERO);
  while (s.grounded) tick(s, input(FORWARD), cfg, w, DT);
  run(s, input(FORWARD), cfg, w, 2);
  tick(s, input({ ...FORWARD, jumpPressed: true }), cfg, w, DT);
  assert(s.jumpedThisTick, 'coyote jump refused');
  run(s, input(FORWARD), cfg, w, 10);
  tick(s, input({ ...FORWARD, jumpPressed: true }), cfg, w, DT);
  assert(!s.jumpedThisTick, 'double jumped');
});

test('steps up low ledges (≤ 0.45 m) but not high ones', () => {
  const cfg = defaultMoveConfig();
  let w = flatWorld(box([-5, 0, -20], [5, 0.3, -2]));
  let s = standing(cfg, w, Vec3.ZERO);
  run(s, input(FORWARD), cfg, w, 128);
  assertClose(s.position.y, 0.3, 1e-3, 'climbed height');
  assert(s.grounded && s.position.z < -5, `stuck at z=${s.position.z}`);

  w = flatWorld(box([-5, 0, -20], [5, 0.6, -2]));
  s = standing(cfg, w, Vec3.ZERO);
  run(s, input(FORWARD), cfg, w, 128);
  assertClose(s.position.y, 0, 1e-3, 'should not climb 0.6 m');
  assertClose(s.position.z, -2 + cfg.hullHalfWidth, 1e-3, 'z against step');
});

test('walks down stairs without going airborne', () => {
  const cfg = defaultMoveConfig();
  const solids = [box([-50, -3, -50], [50, -2, 50])];
  for (let i = 0; i < 8; i++) {
    const z0 = -0.5 * i;
    solids.push(box([-5, -3, z0 - 0.5], [5, -0.25 * i, z0]));
  }
  const w = new CollisionWorld(solids);
  const s = standing(cfg, w, v3(0, 0, -0.1));
  let airborne = 0;
  for (let i = 0; i < 64; i++) {
    tick(s, input(FORWARD), cfg, w, DT);
    if (!s.grounded) airborne++;
  }
  assert(airborne === 0, `airborne for ${airborne} ticks going down stairs`);
  assert(s.position.y < -1.5, `only got down to ${s.position.y}`);
});

test('strafe jumping gains speed; straight bunny hopping does not', () => {
  const cfg = defaultMoveConfig();
  const w = flatWorld();

  let s = standing(cfg, w, Vec3.ZERO);
  run(s, input(FORWARD), cfg, w, 64);
  run(s, input({ ...FORWARD, jumpPressed: true }), cfg, w, 64 * 4);
  const straight = horizontalSpeed(s);
  assert(straight <= cfg.maxGroundSpeed + 0.05, `straight hops gained speed: ${straight}`);

  // Each tick aim the wish direction at the angle where air acceleration
  // adds the most speed: what a good player's mouse does. With per-tick accel
  // `a` and cap `c`, |v|² grows by a(2c − a) when the projection is c − a,
  // or by c² − p² when the projection p is larger; the best projection is
  // therefore max(c − a, 0).
  s = standing(cfg, w, Vec3.ZERO);
  run(s, input(FORWARD), cfg, w, 64);
  for (let i = 0; i < 64 * 4; i++) {
    const vx = s.velocity.x, vz = s.velocity.z;
    const speed = Math.hypot(vx, vz);
    const a = cfg.airAccel * cfg.maxGroundSpeed * DT;
    const bestProjection = Math.max(cfg.airSpeedCap - a, 0);
    const angle = Math.acos(Math.min(bestProjection / speed, 1));
    const c = Math.cos(angle), sn = Math.sin(angle);
    const dx = (vx * c - vz * sn) / speed;
    const dz = (vx * sn + vz * c) / speed;
    const yaw = Math.atan2(-dx, -dz);
    tick(s, input({ ...FORWARD, yaw, jumpPressed: true }), cfg, w, DT);
  }
  const strafed = horizontalSpeed(s);
  assert(strafed > 1.5 * cfg.maxGroundSpeed, `strafe jumping only reached ${strafed} m/s`);
});

test('crouch fits under a low ceiling and refuses to stand up into it', () => {
  const cfg = defaultMoveConfig();
  const w = flatWorld(box([-5, 1.5, -10], [5, 3, -2]));
  const s = standing(cfg, w, Vec3.ZERO);
  run(s, input(FORWARD), cfg, w, 64);
  assert(s.position.z > -2 + cfg.hullHalfWidth - 1e-3, 'standing hull entered the tunnel');
  run(s, input({ ...FORWARD, crouchHeld: true }), cfg, w, 128);
  assert(s.position.z < -4, `couldn't crawl in: z=${s.position.z}`);
  assert(horizontalSpeed(s) <= cfg.maxGroundSpeed * cfg.crouchSpeedScale + 0.05, 'crouch too fast');
  run(s, emptyInput(), cfg, w, 32);
  assert(s.crouched, 'stood up into the ceiling');
  const half = hullHalfExtents(cfg, true);
  assert(!w.boxBlocked(s.position.add(v3(0, half.y, 0)), half), 'hull is inside the ceiling');
});

test('crouch jump reaches exactly the tuck height higher than a plain jump', () => {
  const cfg = defaultMoveConfig();
  const w = flatWorld();
  const peak = (crouch) => {
    const s = standing(cfg, w, Vec3.ZERO);
    tick(s, input({ jumpPressed: true }), cfg, w, DT);
    let apex = 0;
    for (let i = 0; i < 40; i++) {
      tick(s, input({ crouchHeld: crouch }), cfg, w, DT);
      apex = Math.max(apex, s.position.y);
    }
    return apex;
  };
  const plain = peak(false), tucked = peak(true);
  assertClose(tucked - plain, cfg.standHeight - cfg.crouchHeight, 0.02, 'crouch-jump gain');
});

test('a 300 m/s fall does not tunnel through a 2 cm floor', () => {
  const cfg = defaultMoveConfig();
  const w = new CollisionWorld([box([-10, -0.02, -10], [10, 0, 10])]);
  const s = createPlayerState(v3(0, 50, 0), cfg);
  s.velocity = v3(0, -300, 0);
  run(s, emptyInput(), cfg, w, 32);
  assert(s.grounded, 'not grounded');
  assertClose(s.position.y, 0, 1e-3, 'feet y');
});

test('simulation is deterministic for the same input script', () => {
  const cfg = defaultMoveConfig();
  const w = flatWorld(box([2, 0, -8], [4, 0.3, -3]));
  const script = (i) => input({
    wish: { x: (Math.floor(i / 50) % 3) - 1, y: 1 },
    yaw: Math.sin(i * 0.013),
    jumpPressed: i % 37 === 0,
    crouchHeld: Math.floor(i / 90) % 2 === 1,
  });
  const play = () => {
    const s = createPlayerState(v3(0, 1, 0), cfg);
    for (let i = 0; i < 2000; i++) tick(s, script(i), cfg, w, DT);
    return s;
  };
  const a = play(), b = play();
  assert(a.position.equals(b.position) && a.velocity.equals(b.velocity), 'runs diverged');
});

// ------------------------------------------------------------------- level

test('level: every spawn is free and standing on the floor', () => {
  for (const [name, make] of Object.entries(LEVELS)) {
    const level = make();
    const w = levelCollision(level);
    const cfg = defaultMoveConfig();
    const half = hullHalfExtents(cfg, false);
    const center = level.spawn.add(v3(0, half.y, 0));
    assert(!w.boxBlocked(center, half), `${name}: spawn inside a solid`);
    const hit = w.sweep(center, half, v3(0, -1, 0));
    assert(hit && hit.t === 0, `${name}: spawn not on the floor`);
  }
});

test('level: open field walls hold a 40 m/s crouch-jumping player at every edge', () => {
  const level = openField();
  const w = levelCollision(level);
  const cfg = { ...defaultMoveConfig(), autoHop: true };
  const lim = level.halfSize;
  // Yaw 0 faces -Z; π/2 faces -X; π faces +Z; 3π/2 faces +X; plus a corner.
  for (const yaw of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, Math.PI / 4]) {
    const s = createPlayerState(level.spawn, cfg);
    s.velocity = v3(-Math.sin(yaw), 0, -Math.cos(yaw)).scale(40);
    for (let i = 0; i < 64 * 10; i++) {
      tick(s, input({ wish: { x: 0, y: 1 }, yaw, jumpPressed: true, jumpHeld: true, crouchHeld: (i >> 4) % 2 === 1 }), cfg, w, DT);
    }
    const p = s.position;
    assert(Math.abs(p.x) < lim && Math.abs(p.z) < lim && p.y >= 0, `escaped at yaw ${yaw.toFixed(2)}: ${p.x}, ${p.y}, ${p.z}`);
  }
});

test('level: the 1.7 m ledge needs a crouch jump, the 1.1 m one does not', () => {
  const cfg = defaultMoveConfig();
  const plainApex = cfg.jumpSpeed ** 2 / (2 * cfg.gravity);
  const tuck = cfg.standHeight - cfg.crouchHeight;
  assert(plainApex > 1.1 && plainApex < 1.7 && plainApex + tuck > 1.7, `apex ${plainApex}`);
});
