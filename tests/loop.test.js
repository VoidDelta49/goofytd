// Tests for the frame loop glue: fixed clock and player controller, driven
// the way main.js drives them, with simulated frame pacing.

import { test, assert, assertClose } from './harness.js';
import { FixedClock, TICK_HZ } from '../src/fixed-clock.js';
import { PlayerController } from '../src/player.js';
import { defaultMoveConfig } from '../src/sim/movement.js';
import { levelCollision, movementPlayground } from '../src/level.js';
import { Vec3 } from '../src/sim/vec3.js';

function simulate(fps, seconds, each) {
  const level = movementPlayground();
  const world = levelCollision(level);
  const player = new PlayerController(level.spawn, level.spawnYaw, defaultMoveConfig());
  const clock = new FixedClock();
  const frames = Math.round(fps * seconds);
  for (let f = 0; f < frames; f++) {
    each?.(player, f);
    const n = clock.advance(1 / fps);
    for (let i = 0; i < n; i++) player.step(world, clock.dt);
  }
  return { player, clock };
}

test('loop: 64 ticks per second at 30, 60, 144 and 240 fps', () => {
  for (const fps of [30, 60, 144, 240]) {
    const { clock } = simulate(fps, 10);
    assert(Math.abs(clock.tickCount - 10 * TICK_HZ) <= 1, `${fps} fps ran ${clock.tickCount} ticks`);
  }
});

test('loop: distance covered does not depend on frame rate', () => {
  const dist = (fps) => {
    const { player } = simulate(fps, 2, (p) => { p.pending.wish = { x: 0, y: 1 }; });
    return -player.state.position.z;
  };
  const d30 = dist(30), d144 = dist(144);
  assertClose(d30, d144, 0.12, `30 fps vs 144 fps distance (${d30} vs ${d144})`);
  assert(d144 > 13.5 && d144 < 15.1, `travelled ${d144} m in 2 s`);
});

test('loop: a long stall is capped instead of bursting hundreds of ticks', () => {
  const clock = new FixedClock(64, 8);
  assert(clock.advance(5) === 8, 'stall not capped');
  assert(clock.alpha >= 0 && clock.alpha < 1);
});

test('loop: alpha stays in [0, 1) and interpolation is continuous', () => {
  const clock = new FixedClock();
  for (let i = 0; i < 1000; i++) {
    clock.advance(0.0071);
    assert(clock.alpha >= 0 && clock.alpha < 1, `alpha ${clock.alpha}`);
  }
  const cfg = defaultMoveConfig();
  const p = new PlayerController(Vec3.ZERO, 0, cfg);
  p.prevPosition = Vec3.ZERO;
  p.state.position = new Vec3(0, 0, -1);
  assertClose(p.interpolatedEye(0.5).z, -0.5, 1e-12, 'midpoint');
  assertClose(p.interpolatedEye(0.5).y, cfg.standEyeHeight, 1e-12, 'eye height');
});

test('player: a jump latched during a frame that runs 4 ticks jumps once', () => {
  const level = movementPlayground();
  const world = levelCollision(level);
  const player = new PlayerController(level.spawn, 0, defaultMoveConfig());
  for (let i = 0; i < 8; i++) player.step(world, 1 / 64);
  player.pending.jumpPressed = true;
  let jumps = 0;
  for (let i = 0; i < 4; i++) {
    player.step(world, 1 / 64);
    jumps += player.state.jumpedThisTick ? 1 : 0;
  }
  assert(jumps === 1, `jumped ${jumps} times`);
  assert(!player.pending.jumpPressed, 'latch not cleared');
});

test('player: respawn and kill plane reset the body', () => {
  const level = movementPlayground();
  const world = levelCollision(level);
  const player = new PlayerController(level.spawn, 0, defaultMoveConfig());
  player.pending.wish = { x: 0, y: 1 };
  for (let i = 0; i < 64; i++) player.step(world, 1 / 64);
  assert(player.state.position.z < -1);
  player.pending.respawn = true;
  player.step(world, 1 / 64);
  assert(player.state.position.equals(level.spawn) && player.topSpeed === 0);
  player.state.position = new Vec3(0, -100, 0);
  player.step(world, 1 / 64);
  assert(player.state.position.equals(level.spawn), 'kill plane did not respawn');
});

test('player: look wraps yaw and clamps pitch', () => {
  const p = new PlayerController(Vec3.ZERO, 0, defaultMoveConfig());
  p.look(-0.5, 10);
  assert(p.yaw > 0 && p.yaw < Math.PI * 2, `yaw ${p.yaw}`);
  assertClose(p.pitch, (89 * Math.PI) / 180, 1e-12, 'pitch clamp');
});
