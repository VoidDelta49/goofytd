// Entry point: wires the pure simulation to three.js rendering and browser input.

import { FixedClock } from './fixed-clock.js';
import { DEFAULT_LEVEL, LEVELS, levelCollision } from './level.js';
import { PlayerController } from './player.js';
import { defaultMoveConfig } from './sim/movement.js';
import { Game, defaultGameConfig } from './sim/game.js';
import { Renderer } from './client/render.js';
import { TdRenderer } from './client/td-render.js';
import { BuildController, viewForward } from './client/build.js';
import { Sfx } from './client/audio.js';
import { Input } from './client/input.js';
import { Hud } from './client/hud.js';

const canvas = document.getElementById('game');
const mapName = new URLSearchParams(location.search).get('map');
const level = LEVELS[Object.hasOwn(LEVELS, mapName) ? mapName : DEFAULT_LEVEL]();
const world = levelCollision(level);
const cfg = defaultMoveConfig();
const gameCfg = defaultGameConfig();
// The first wave always waits for the START WAVE button (or N) so there's time to
// build. Later waves follow the level: automatic on the field, manual in the playground.
gameCfg.firstWave = null;
if (!level.autoWaves) gameCfg.waveGap = null;
const game = new Game(level, world, gameCfg);
const player = new PlayerController(level.spawn, level.spawnYaw, cfg);
const renderer = new Renderer(canvas, level);
const td = new TdRenderer(renderer.scene, game);
const build = new BuildController(game, player, cfg);
const input = new Input(canvas, document.getElementById('touch'), player, cfg);
const hud = new Hud(document.getElementById('hud'));
const sfx = new Sfx();
const clock = new FixedClock();

function startWave() {
  const before = game.wave;
  game.startWave();
  // Waves started by hand push their event outside tick(), which clears it: play the horn here.
  if (game.wave !== before) sfx.play('wave');
}

function placeTower() {
  if (build.selected === null) return;
  sfx.play(build.place() ? 'build' : 'deny');
}

function sellTower() {
  if (build.sell()) sfx.play('sell');
}

input.handlers = {
  selectTower: (n) => { build.select(n); sfx.play('select'); },
  cycleTower: () => { build.cycle(); sfx.play('select'); },
  cancelBuild: () => { if (build.selected !== null) sfx.play('select'); build.cancel(); },
  place: placeTower,
  sell: sellTower,
  placeOrSell: () => (build.selected !== null ? placeTower() : sellTower()),
  nextWave: startWave,
  restart: () => { if (game.lost) { game.reset(); sfx.play('select'); } },
  mute: () => {
    input.notice = sfx.toggleMute() ? 'Sound off · M to turn it back on' : 'Sound on';
    input.noticeUntil = performance.now() + 1500;
    sfx.play('select');
  },
};

// Mouse and keyboard play with the pointer locked, which can't click this: N does the same.
document.querySelector('[data-hud=startwave]').addEventListener('click', (e) => {
  startWave();
  if (e.pointerType === 'touch' || e.pointerType === 'pen') input.touch.enable();
  else input.lock();
});

let last = performance.now();

function frame(now) {
  // Clamp: a backgrounded tab resumes with a huge gap; FixedClock also caps ticks.
  const frameDt = Math.min((now - last) / 1000, 0.25);
  last = now;

  input.sample();
  const pos = player.state.position;
  const fwd = viewForward(player.yaw, 0);
  sfx.setListener(pos.x, pos.z, fwd[0], fwd[2]);
  const ticks = clock.advance(frameDt);
  for (let i = 0; i < ticks; i++) {
    player.step(world, clock.dt);
    const st = player.state;
    if (st.jumpedThisTick) sfx.play('jump');
    if (st.landedSpeed > 3) sfx.play('land', undefined, undefined, Math.min(st.landedSpeed / 14, 1));
    game.tick(clock.dt);
    td.consume(game.events); // tick() clears its events, so collect them every tick
    sfx.consume(game.events);
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
window.goofytd = { cfg, player, world, renderer, input, level, game, build, td, sfx };
