// Entry point: wires the pure simulation to three.js rendering and browser input.

import { FixedClock } from './fixed-clock.js';
import { DEFAULT_LEVEL, LEVELS, levelCollision } from './level.js';
import { PlayerController } from './player.js';
import { defaultMoveConfig } from './sim/movement.js';
import { Game, defaultGameConfig } from './sim/game.js';
import { cowDebuts } from './sim/cows.js';
import { Renderer } from './client/render.js';
import { TdRenderer } from './client/td-render.js';
import { BuildController, viewForward } from './client/build.js';
import { Sfx } from './client/audio.js';
import { Input } from './client/input.js';
import { Hud } from './client/hud.js';
import { PauseMenu } from './client/menu.js';

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
let announcedWave = 0;

function startWave() {
  const before = game.wave;
  game.startWave();
  // Waves started by hand push their event outside tick(), which clears it: play the horn here.
  if (game.wave !== before) sfx.play('wave');
}

/** Short message at the top of the screen (the same spot the mouse-capture notices use). */
function say(text, ms = 1500) {
  input.notice = text;
  input.noticeUntil = performance.now() + ms;
}

function placeTower() {
  if (build.selected === null) { say('Tap a tower in the bar first, then BUILD'); return; }
  sfx.play(build.place() ? 'build' : 'deny');
}

function sellTower() {
  if (build.sell()) sfx.play('sell');
  else if (!build.lookTower) { say('Look at a tower to sell it'); sfx.play('deny'); }
}

/** Start over: wipe the run and put the player back at the start. Used by TRY AGAIN and the pause menu. */
function restartGame() {
  game.reset();
  build.cancel();
  player.pending.respawn = true;
  sfx.play('select');
}

// Pause: the simulation and the player stop ticking (the frame loop skips them);
// rendering carries on so the menu sits over a live picture.
let paused = false;

const menu = new PauseMenu(document.getElementById('pause'), {
  resume: (e) => {
    setPaused(false);
    if (e.pointerType === 'touch' || e.pointerType === 'pen') input.touch.enable();
    else input.lock(); // the click is the gesture the browser needs to capture the mouse again
  },
  sound: () => { sfx.toggleMute(); sfx.play('select'); },
  autoHop: () => { cfg.autoHop = !cfg.autoHop; input.touch.syncButtons(); },
  sensDown: () => input.adjustSensitivity(-1),
  sensUp: () => input.adjustSensitivity(1),
  fullscreen: () => input.toggleFullscreen(),
  respawn: () => { player.pending.respawn = true; setPaused(false); },
  restart: () => { restartGame(); setPaused(false); },
}, () => ({ muted: sfx.muted, autoHop: cfg.autoHop, sens: input.sensLabel }));
// iPhone Safari has no element fullscreen: don't offer a button that does nothing.
if (!document.fullscreenEnabled) document.querySelector('[data-menu=fullscreen]').hidden = true;

function setPaused(p) {
  if (p === paused) return;
  paused = p;
  input.paused = p;
  if (p) {
    // Let go of everything held so nothing keeps moving or jumps on resume.
    input.touch.release();
    input.down.clear();
    player.pending.jumpPressed = false;
    player.pending.respawn = false;
    document.exitPointerLock?.(); // the mouse has to be free to click the menu
    menu.show();
  } else {
    menu.hide();
  }
}

input.handlers = {
  selectTower: (n) => { build.select(n); sfx.play('select'); },
  cancelBuild: () => { if (build.selected !== null) sfx.play('select'); build.cancel(); },
  place: placeTower,
  sell: sellTower,
  nextWave: startWave,
  pause: () => setPaused(!paused),
  restart: () => { if (game.lost) restartGame(); },
  mute: () => {
    say(sfx.toggleMute() ? 'Sound off · M to turn it back on' : 'Sound on');
    sfx.play('select');
  },
};

// Mouse and keyboard play with the pointer locked, which can't click these: N and Enter do the same.
function hudButton(name, action) {
  document.querySelector(`[data-hud=${name}]`).addEventListener('click', (e) => {
    action();
    if (e.pointerType === 'touch' || e.pointerType === 'pen') input.touch.enable();
    else input.lock();
  });
}
hudButton('startwave', startWave);
hudButton('restart', restartGame);

// Tap a tower in the bar to pick it (tap it again to stop building); also works with a free mouse.
document.querySelector('[data-hud=buildbar]').addEventListener('pointerdown', (e) => {
  const slot = e.target.closest('.slot');
  if (!slot || paused) return;
  e.preventDefault();
  if (e.pointerType !== 'mouse') input.touch.enable();
  input.handlers.selectTower(Number(slot.dataset.n));
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
  // Paused: no ticks, and the clock isn't fed, so resuming doesn't fast-forward.
  const ticks = paused ? 0 : clock.advance(frameDt);
  for (let i = 0; i < ticks; i++) {
    player.step(world, clock.dt);
    const st = player.state;
    if (st.jumpedThisTick) sfx.play('jump');
    if (st.landedSpeed > 3) sfx.play('land', undefined, undefined, Math.min(st.landedSpeed / 14, 1));
    game.tick(clock.dt);
    td.consume(game.events); // tick() clears its events, so collect them every tick
    sfx.consume(game.events);
    for (const e of game.events) {
      if (e.kind === 'boom' && e.wrecked) say(`KABOOM! A Kaboom Cow blew up ${e.wrecked === 1 ? 'a tower' : `${e.wrecked} towers`}`, 2500);
    }
  }
  // Announce new cow types the first time a wave brings them (auto or by hand).
  if (game.wave !== announcedWave) {
    announcedWave = game.wave;
    const debuts = cowDebuts(game.wave);
    if (debuts.length) say(`New cows this wave: ${debuts.map((t) => t.name).join(', ')}!`, 3500);
  }

  const eye = player.interpolatedEye(clock.alpha);
  build.update(now, eye, player.yaw, player.pitch);
  input.touch.syncGame(game, build);
  td.update(clock.alpha, frameDt, build);
  renderer.render(eye, player.yaw, player.pitch);
  hud.update(now, frameDt, player, cfg, input, game, build);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy from the dev console: tweak movement live, e.g. goofytd.cfg.airAccel = 20,
// or the match: goofytd.game.money = 9999, goofytd.game.startWave()
window.goofytd = { cfg, player, world, renderer, input, level, game, build, td, sfx };
