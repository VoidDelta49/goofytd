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
import { UpgradeMenu } from './client/upgrade-menu.js';

const canvas = document.getElementById('game');
const params = new URLSearchParams(location.search);
const mapName = params.get('map');
// A fresh seed every run (and every restart), so the cow mix and the surprises differ each time.
// ?seed=N pins it, to replay a run. The sim stays deterministic for a given seed (PvP will share one).
const fixedSeed = params.has('seed') ? Number(params.get('seed')) >>> 0 : null;
const newSeed = () => fixedSeed ?? crypto.getRandomValues(new Uint32Array(1))[0];
const level = LEVELS[Object.hasOwn(LEVELS, mapName) ? mapName : DEFAULT_LEVEL]();
const world = levelCollision(level);
const cfg = defaultMoveConfig();
const gameCfg = defaultGameConfig();
gameCfg.seed = newSeed();
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
  if (game.wave !== before && game.lastInterest > 0) { sfx.play('cash'); say(`Cheese Vault interest: +${game.lastInterest} moolah`, 2500); }
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

// Upgrades: look at a tower, U / UPGRADE opens the panel for that tower. The game
// keeps running. With the mouse captured, 1/2 buy the cards and U/Q close it.
const upgrades = new UpgradeMenu(document.getElementById('upgrade'), {
  buy: buyUpgrade,
  sell: () => {
    const t = upgrades.tower;
    if (!t) return;
    const refund = game.sellTower(t.id);
    sfx.play('sell');
    say(`Sold ${t.def.name} for ${refund}`);
    closeUpgrades();
  },
  close: closeUpgrades,
});

function toggleUpgrades() {
  if (upgrades.isOpen) { closeUpgrades(); return; }
  const t = build.lookTower;
  if (!t) { say('Look at a tower to upgrade it'); sfx.play('deny'); return; }
  build.cancel();
  upgrades.open(t, game);
  sfx.play('select');
}

function closeUpgrades() {
  if (!upgrades.isOpen) return;
  upgrades.close();
  sfx.play('select');
}

function buyUpgrade(formId) {
  const t = upgrades.tower;
  if (!t) return;
  const r = game.upgradeTower(t.id, formId);
  if (!r.ok) { sfx.play('deny'); upgrades.refuse(formId, r.reason); return; }
  // upgradeTower() runs outside tick(), whose event list would be cleared: effects go here.
  sfx.play('upgrade');
  td.upgradeBurst(t);
  upgrades.update(game);
}

/** Start over: wipe the run and put the player back at the start. Used by TRY AGAIN and the pause menu. */
function restartGame() {
  game.cfg.seed = newSeed();
  game.reset();
  build.cancel();
  upgrades.close();
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
  // With the upgrade panel open the number keys buy its cards instead of picking towers.
  selectTower: (n) => {
    if (upgrades.isOpen) { upgrades.pick(n); return; }
    build.select(n);
    sfx.play('select');
  },
  cancelBuild: () => {
    if (upgrades.isOpen) { closeUpgrades(); return; }
    if (build.selected !== null) sfx.play('select');
    build.cancel();
  },
  place: () => { if (!upgrades.isOpen) placeTower(); }, // a click with the panel open does nothing
  upgrade: toggleUpgrades,
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
  if (upgrades.isOpen) closeUpgrades(); // picking a tower to build means you're done upgrading
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
      if (e.kind === 'surprise') say(e.text, 3500);
      if (e.kind === 'interest') say(`Cheese Vault interest: +${e.amount} moolah`, 2500);
      if (e.kind === 'boom' && e.wrecked) say(`KABOOM! A Kaboom Cow blew up ${e.wrecked === 1 ? 'a tower' : `${e.wrecked} towers`}`, 2500);
      if (e.kind === 'destroyed' && e.cause === 'bonk') say(`BONK! Your ${e.name} got headbutted to bits (+${e.refund} moolah insurance)`, 2500);
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
  upgrades.update(game);
  input.touch.syncGame(game, build, upgrades.isOpen);
  td.update(clock.alpha, frameDt, build);
  renderer.render(eye, player.yaw, player.pitch);
  hud.update(now, frameDt, player, cfg, input, game, build);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy from the dev console: tweak movement live, e.g. goofytd.cfg.airAccel = 20,
// or the match: goofytd.game.money = 9999, goofytd.game.startWave()
window.goofytd = { cfg, player, world, renderer, input, level, game, build, td, sfx, upgrades };
