// Entry point: wires the pure simulation to three.js rendering and browser input.

import { FixedClock } from './fixed-clock.js';
import { levelCollision, movementPlayground } from './level.js';
import { PlayerController } from './player.js';
import { defaultMoveConfig } from './sim/movement.js';
import { Renderer } from './client/render.js';
import { Input } from './client/input.js';
import { Hud } from './client/hud.js';

const canvas = document.getElementById('game');
const level = movementPlayground();
const world = levelCollision(level);
const cfg = defaultMoveConfig();
const player = new PlayerController(level.spawn, level.spawnYaw, cfg);
const renderer = new Renderer(canvas, level);
const input = new Input(canvas, player, cfg);
const hud = new Hud(document.getElementById('hud'));
const clock = new FixedClock();

let last = performance.now();

function frame(now) {
  // Clamp: a backgrounded tab resumes with a huge gap; FixedClock also caps ticks.
  const frameDt = Math.min((now - last) / 1000, 0.25);
  last = now;

  input.sample();
  const ticks = clock.advance(frameDt);
  for (let i = 0; i < ticks; i++) player.step(world, clock.dt);

  renderer.render(player.interpolatedEye(clock.alpha), player.yaw, player.pitch);
  hud.update(now, frameDt, player, cfg, input);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy from the dev console: tweak movement live, e.g. goofytd.cfg.airAccel = 20
window.goofytd = { cfg, player, world, renderer };
