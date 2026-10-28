// Entry point: wires the pure simulation to three.js rendering and browser input.

import { FixedClock } from './fixed-clock.js';
import { DEFAULT_LEVEL, LEVELS, levelCollision } from './level.js';
import { PlayerController } from './player.js';
import { defaultMoveConfig } from './sim/movement.js';
import { Game, defaultGameConfig } from './sim/game.js';
import { Renderer } from './client/render.js';
import { TdRenderer } from './client/td-render.js';
import { BuildController } from './client/build.js';
import { Input } from './client/input.js';
import { Hud } from './client/hud.js';

const canvas = document.getElementById('game');
const mapName = new URLSearchParams(location.search).get('map');
const level = LEVELS[Object.hasOwn(LEVELS, mapName) ? mapName : DEFAULT_LEVEL]();
const world = levelCollision(level);
const cfg = defaultMoveConfig();
const gameCfg = defaultGameConfig();
if (!level.autoWaves) gameCfg.firstWave = gameCfg.waveGap = null; // N starts waves
const game = new Game(level, world, gameCfg);
const player = new PlayerController(level.spawn, level.spawnYaw, cfg);
const renderer = new Renderer(canvas, level);
const td = new TdRenderer(renderer.scene, game);
const build = new BuildController(game, player, cfg);
const input = new Input(canvas, document.getElementById('touch'), player, cfg);
const hud = new Hud(document.getElementById('hud'));
const clock = new FixedClock();

input.handlers = {
  selectTower: (n) => build.select(n),
  cycleTower: () => build.cycle(),
  cancelBuild: () => build.cancel(),
  place: () => build.place(),
  sell: () => build.sell(),
  placeOrSell: () => build.placeOrSell(),
  nextWave: () => game.startWave(),
  restart: () => { if (game.lost) game.reset(); },
};

let last = performance.now();

function frame(now) {
  // Clamp: a backgrounded tab resumes with a huge gap; FixedClock also caps ticks.
  const frameDt = Math.min((now - last) / 1000, 0.25);
  last = now;

  input.sample();
  const ticks = clock.advance(frameDt);
  for (let i = 0; i < ticks; i++) {
    player.step(world, clock.dt);
    game.tick(clock.dt);
    td.consume(game.events); // tick() clears its events, so collect them every tick
  }

  const eye = player.interpolatedEye(clock.alpha);
  build.update(now, eye, player.yaw, player.pitch);
  td.update(clock.alpha, frameDt, build);
  renderer.render(eye, player.yaw, player.pitch);
  hud.update(now, frameDt, player, cfg, input, game, build);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy from the dev console: tweak movement live, e.g. goofytd.cfg.airAccel = 20,
// or the match: goofytd.game.money = 9999, goofytd.game.startWave()
window.goofytd = { cfg, player, world, renderer, input, level, game, build, td };
