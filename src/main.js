// Entry point: the main menu picks a mode, then startGame() wires the pure
// simulation to three.js rendering, browser input and (in co-op) the network.
//
// Every change to the match (build, sell, upgrade, start a wave, restart) is
// a command (sim/commands.js) run at the start of a tick through a Lockstep
// (net/lockstep.js): locally in solo, host-relayed in LAN co-op, so all
// farmers' games stay identical. Each farmer's own movement stays local.

import { FixedClock } from './fixed-clock.js';
import { DEFAULT_LEVEL, LEVELS, levelCollision } from './level.js';
import { PlayerController } from './player.js';
import { defaultMoveConfig } from './sim/movement.js';
import { Game, GAME_SPEEDS, UpgradeError, defaultGameConfig } from './sim/game.js';
import { cowDebuts } from './sim/cows.js';
import { TOWER_FORMS } from './sim/towers.js';
import { applyCommand } from './sim/commands.js';
import { Vec3 } from './sim/vec3.js';
import { Lockstep } from './net/lockstep.js';
import { POS_RATE_HZ } from './net/track.js';
import { Renderer } from './client/render.js';
import { TdRenderer } from './client/td-render.js';
import { FarmerRenderer } from './client/farmers.js';
import { BuildController, viewForward } from './client/build.js';
import { Sfx } from './client/audio.js';
import { Input } from './client/input.js';
import { Hud } from './client/hud.js';
import { PauseMenu } from './client/menu.js';
import { UpgradeMenu } from './client/upgrade-menu.js';
import { MainMenu } from './client/main-menu.js';

const params = new URLSearchParams(location.search);
// A fresh seed every run (and every restart), so the cow mix and the surprises differ each time.
// ?seed=N pins it, to replay a run. In co-op the host picks it and everyone shares it.
const fixedSeed = params.has('seed') ? Number(params.get('seed')) >>> 0 : null;
const newSeed = () => fixedSeed ?? crypto.getRandomValues(new Uint32Array(1))[0];

const mainMenu = new MainMenu(document.getElementById('mainmenu'), { play: startGame, newSeed });
// ?map=… or ?play skip the menu (straight into solo), as before the menu existed.
if (params.has('map') || params.has('play')) startGame({ map: params.get('map') ?? DEFAULT_LEVEL });
else mainMenu.show();

/** Back to the title screen: a clean reload, which also hangs up any co-op links. */
function toMainMenu() {
  const q = new URLSearchParams(location.search);
  q.delete('map'); q.delete('play'); q.delete('seed');
  const s = q.toString();
  location.href = location.pathname + (s ? `?${s}` : '');
}

/**
 * @param {{ map: string, seed?: number, session?: import('./net/session.js').HostSession | import('./net/session.js').JoinSession }} opts
 */
function startGame({ map, seed = newSeed(), session = null }) {
  const canvas = document.getElementById('game');
  const level = LEVELS[Object.hasOwn(LEVELS, map) ? map : DEFAULT_LEVEL]();
  const world = levelCollision(level);
  const cfg = defaultMoveConfig();
  const gameCfg = defaultGameConfig();
  gameCfg.seed = seed;
  // Co-op: everyone builds the same Game from the same config, or they'd drift apart.
  gameCfg.players = session ? session.players.length : 1;
  // The first wave always waits for the START WAVE button (or N) so there's time to
  // build. Later waves follow the level: automatic on the field, manual in the playground.
  gameCfg.firstWave = null;
  if (!level.autoWaves) gameCfg.waveGap = null;
  const game = new Game(level, world, gameCfg);
  const coop = !!session;
  const sync = session ? session.lockstep : new Lockstep({ role: 'local' });
  const isHost = sync.role !== 'client';
  const player = new PlayerController(level.spawn, level.spawnYaw, cfg);
  const renderer = new Renderer(canvas, level);
  const td = new TdRenderer(renderer.scene, game, renderer);
  const farmers = new FarmerRenderer(renderer.scene);
  const build = new BuildController(game, player, cfg);
  build.others = () => farmers.boxes();
  const input = new Input(canvas, document.getElementById('touch'), player, cfg);
  const hud = new Hud(document.getElementById('hud'));
  const sfx = new Sfx();
  // Two clocks: the farmer always moves in real time; the match (cows, towers)
  // runs on its own clock so fast-forward speeds up the cows, not your legs.
  const clock = new FixedClock();
  const simClock = new FixedClock();
  let announcedWave = 0;

  const nameOf = (p) => session?.players.find((q) => q.id === p)?.name ?? 'Someone';

  /** Short message at the top of the screen (the same spot the mouse-capture notices use). */
  function say(text, ms = 1500) {
    input.notice = text;
    input.noticeUntil = performance.now() + ms;
  }

  /** Ask for something to happen to the match. It happens at the next tick, on every machine. */
  function submit(c) {
    if (!sync.submit(c)) sfx.play('deny');
  }

  function startWave() { submit({ k: 'wave' }); }

  function placeTower() {
    if (build.selected === null) { say('Tap a tower in the bar first, then BUILD'); return; }
    const c = build.place();
    if (c) submit(c); else sfx.play('deny');
  }

  function sellTower() {
    const c = build.sell();
    if (c) submit(c);
    else { say('Look at a tower to sell it'); sfx.play('deny'); }
  }

  // Upgrades: look at a tower, U / UPGRADE opens the panel for that tower. The game
  // keeps running. With the mouse captured, 1/2 buy the cards and U/Q close it.
  const upgrades = new UpgradeMenu(document.getElementById('upgrade'), {
    buy: buyUpgrade,
    sell: () => {
      const t = upgrades.tower;
      if (!t) return;
      submit({ k: 'sell', id: t.id });
      closeUpgrades();
    },
    close: closeUpgrades,
    toggleAuto,
    autoPath: (formId) => {
      const t = upgrades.tower;
      if (t) submit({ k: 'autopath', form: t.def.id, pick: formId });
    },
  });

  // Auto-upgrade: towers buy their own next level (cheapest first, along each
  // tower's remembered path). A shared match setting, so it goes through a command;
  // your choice is remembered and turned back on when you next host or play solo.
  const AUTO_KEY = 'goofytd.autoUpgrade';
  // What this farmer last asked for, until the command runs (solo pause stops ticks,
  // so a toggle in the pause menu only applies on resume; the label shows the ask).
  let autoAsked = null;
  const autoState = () => autoAsked ?? game.autoUpgrade;
  function toggleAuto() {
    autoAsked = !autoState();
    submit({ k: 'auto', on: autoAsked });
  }

  // Fast-forward: 1x -> 2x -> 3x -> 1x. A shared match setting (co-op machines
  // must run ticks at the same pace), so it's a command like auto-upgrade.
  let speedAsked = null;
  const speedState = () => speedAsked ?? game.timeScale;
  function cycleSpeed() {
    const i = GAME_SPEEDS.indexOf(speedState());
    speedAsked = GAME_SPEEDS[(i + 1) % GAME_SPEEDS.length];
    submit({ k: 'speed', x: speedAsked });
    if (menu.open) menu.refresh();
  }

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
    const next = TOWER_FORMS[formId];
    if (!t || !next) return;
    // Refuse what's plainly unaffordable now; the command re-checks when it runs
    // (a co-op partner may spend the moolah first).
    if (game.money < next.upgradeCost) { sfx.play('deny'); upgrades.refuse(formId, UpgradeError.Money); return; }
    submit({ k: 'upgrade', id: t.id, form: formId });
  }

  /** Start over with a fresh seed. In co-op only the host can, for everyone. */
  function restartGame() {
    if (!isHost) { say('Only the host can restart the game', 2500); sfx.play('deny'); return; }
    submit({ k: 'reset', seed: newSeed() });
  }

  /** A tower went up where this farmer stands: pop them onto its roof rather than inside it. */
  function unstick(t) {
    if (!build.playerBox().overlaps(t.aabb)) return;
    const p = player.state.position;
    player.state.position = new Vec3(p.x, t.aabb.max.y + 0.01, p.z);
    player.prevPosition = player.state.position;
  }

  /**
   * A command ran (inside the tick loop, before game.tick, so its events
   * would be cleared: its sounds and effects go here). `mine`: this farmer sent it.
   */
  function onResult(c, r) {
    const mine = c.p === sync.me;
    const at = (t) => (mine ? [undefined, undefined] : [t.x, t.z]);
    switch (c.k) {
      case 'place':
        if (r.ok) { sfx.play('build', ...at(r.tower)); unstick(r.tower); }
        else if (mine) { build.say(`Can't build: ${r.reason}`, performance.now()); sfx.play('deny'); }
        break;
      case 'sell':
        if (r.ok) {
          sfx.play('sell', ...at(r.tower));
          if (mine) build.say(`Sold ${r.tower.def.name} for ${r.refund}`, performance.now());
        }
        break;
      case 'upgrade':
        if (r.ok) {
          sfx.play('upgrade', ...at(r.tower));
          td.upgradeBurst(r.tower);
          if (upgrades.tower === r.tower) upgrades.update(game);
          if (!mine && coop) say(`${nameOf(c.p)} upgraded a tower to ${r.tower.def.name}`, 2000);
        } else if (mine) {
          sfx.play('deny');
          if (r.tower && upgrades.tower === r.tower) upgrades.refuse(c.form, r.reason);
        }
        break;
      case 'wave':
        if (!r.ok) break;
        sfx.play('wave');
        if (!mine && coop) say(`${nameOf(c.p)} started wave ${r.wave}!`, 2000);
        if (r.interest > 0) { sfx.play('cash'); say(`Cheese Vault interest: +${r.interest} moolah`, 2500); }
        break;
      case 'auto':
        if (mine) {
          if (autoAsked === c.on) autoAsked = null;
          try { localStorage.setItem(AUTO_KEY, c.on ? '1' : '0'); } catch {}
        }
        sfx.play('select');
        say(c.on
          ? `${!mine && coop ? `${nameOf(c.p)} turned auto-upgrade ON` : 'Auto-upgrade ON'}: towers buy their next level when you can afford it · T to stop`
          : `${!mine && coop ? `${nameOf(c.p)} turned auto-upgrade OFF` : 'Auto-upgrade OFF'}`, 3000);
        if (menu.open) menu.refresh();
        break;
      case 'speed':
        if (mine && speedAsked === c.x) speedAsked = null;
        sfx.play('select');
        say(`${!mine && coop ? `${nameOf(c.p)} set the game speed to` : 'Game speed'} ${c.x}×${c.x > 1 ? ' ▶▶' : ''} · G to change`, 2000);
        if (menu.open) menu.refresh();
        break;
      case 'autopath':
        if (mine) sfx.play('select');
        if (upgrades.isOpen && mine) upgrades.flash(`Auto-upgrade will pick ${TOWER_FORMS[c.pick].name}`);
        break;
      case 'reset':
        build.cancel();
        upgrades.close();
        player.pending.respawn = true;
        sfx.play('select');
        if (coop && !mine) say('The host restarted the game', 2500);
        break;
    }
  }

  // Pause: solo stops the simulation and the player (the frame loop skips them);
  // rendering carries on so the menu sits over a live picture. Co-op can't stop
  // the shared match, so there it only parks your farmer.
  let paused = false;

  const menu = new PauseMenu(document.getElementById('pause'), {
    resume: (e) => {
      setPaused(false);
      if (e.pointerType === 'touch' || e.pointerType === 'pen') input.touch.enable();
      else input.lock(); // the click is the gesture the browser needs to capture the mouse again
    },
    sound: () => { sfx.toggleMute(); sfx.play('select'); },
    autoHop: () => { cfg.autoHop = !cfg.autoHop; input.touch.syncButtons(); },
    autoUpgrade: toggleAuto,
    speed: cycleSpeed,
    sensDown: () => input.adjustSensitivity(-1),
    sensUp: () => input.adjustSensitivity(1),
    fullscreen: () => input.toggleFullscreen(),
    respawn: () => { player.pending.respawn = true; setPaused(false); },
    restart: () => { restartGame(); setPaused(false); },
    mainMenu: () => { session?.close(); toMainMenu(); },
  }, () => ({ muted: sfx.muted, autoHop: cfg.autoHop, autoUpgrade: autoState(), speed: speedState(), sens: input.sensLabel }));
  // iPhone Safari has no element fullscreen: don't offer a button that does nothing.
  if (!document.fullscreenEnabled) document.querySelector('[data-menu=fullscreen]').hidden = true;
  document.querySelector('[data-menu=coopNote]').hidden = !coop;
  document.querySelector('[data-menu=restart]').hidden = !isHost;
  if (!isHost) document.querySelector('[data-hud=restart]').textContent = 'WAITING FOR THE HOST…';

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
    autoUpgrade: toggleAuto,
    sell: sellTower,
    nextWave: startWave,
    fastForward: cycleSpeed,
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

  // Bring back the farmer's auto-upgrade choice (the host's decides for a co-op match).
  try { if (isHost && localStorage.getItem(AUTO_KEY) === '1') submit({ k: 'auto', on: true }); } catch {}

  if (session) {
    session.onEvent = (e) => {
      if (e.kind === 'left') say(`${e.name} went home to feed the chickens. Income is now ×${game.incomeMult}`, 3500);
      if (e.kind === 'hostLost') say('The host left, so the farm is closed. Pause → MAIN MENU', 600000);
    };
    if (coop && game.players > 1) say(`${game.players} farmers, one wallet: income ×${game.incomeMult}!`, 3500);
  }

  // Big Mama's Hoof Stomp shakes the camera, and launches a farmer standing on the ground nearby.
  let shake = 0;
  function stompHit(e) {
    const p = player.state.position;
    const dx = p.x - e.x, dz = p.z - e.z, d = Math.hypot(dx, dz);
    shake = Math.max(shake, Math.max(0.15, 1 - d / 60));
    const reach = e.radius + 2;
    if (d >= reach || !player.state.grounded) return;
    // Up, and away from her: harder the closer you were. Air-strafe it into a long hop.
    const k = 1 - d / reach, out = 4 + 6 * k;
    const ux = d > 1e-6 ? dx / d : 0, uz = d > 1e-6 ? dz / d : 1;
    player.knock(player.state.velocity.x + ux * out, 6 + 4 * k, player.state.velocity.z + uz * out);
    say('BOING! Big Mama stomped you into orbit!', 2000);
  }

  let last = performance.now();
  let lastPosSent = 0;
  let desyncShown = false;

  function frame(now) {
    // Clamp: a backgrounded tab resumes with a huge gap; FixedClock also caps ticks.
    const frameDt = Math.min((now - last) / 1000, 0.25);
    last = now;

    input.sample();
    const pos = player.state.position;
    const fwd = viewForward(player.yaw, 0);
    sfx.setListener(pos.x, pos.z, fwd[0], fwd[2]);
    // Solo paused: no ticks, and the clock isn't fed, so resuming doesn't fast-forward.
    // Co-op keeps time (the match goes on) but your farmer stands still.
    const ticks = paused && !coop ? 0 : clock.advance(frameDt);
    if (!paused) {
      for (let i = 0; i < ticks; i++) {
        player.step(world, clock.dt);
        const st = player.state;
        if (st.jumpedThisTick) sfx.play('jump');
        if (st.landedSpeed > 3) sfx.play('land', undefined, undefined, Math.min(st.landedSpeed / 14, 1));
      }
    }
    // The match clock is fed the same real time, `timeScale` times over: 2x runs
    // two 1/64 s ticks where 1x runs one, so the result is identical, just sooner.
    const scale = game.timeScale;
    const simClockTicks = paused && !coop ? 0 : simClock.advance(frameDt, scale);
    const simTicks = sync.ticksToRun(simClockTicks, scale);
    for (let i = 0; i < simTicks; i++) {
      for (const c of sync.beginTick()) onResult(c, applyCommand(game, c));
      game.tick(simClock.dt);
      sync.endTick(game);
      td.consume(game.events); // tick() clears its events, so collect them every tick
      sfx.consume(game.events);
      for (const e of game.events) {
        if (e.kind === 'surprise') say(e.text, 3500);
        if (e.kind === 'interest') say(`Cheese Vault interest: +${e.amount} moolah`, 2500);
        if (e.kind === 'boom' && e.wrecked) say(`KABOOM! A Kaboom Cow blew up ${e.wrecked === 1 ? 'a tower' : `${e.wrecked} towers`}`, 2500);
        if (e.kind === 'stomp') stompHit(e);
        if (e.kind === 'destroyed' && e.cause === 'bonk') say(`BONK! Your ${e.name} got headbutted to bits (+${e.refund} moolah insurance)`, 2500);
      }
    }
    sync.flush();
    if (session) {
      if (now - lastPosSent >= 1000 / POS_RATE_HZ) {
        lastPosSent = now;
        const s = player.state;
        session.sendPos({ x: s.position.x, y: s.position.y, z: s.position.z, yaw: player.yaw, pitch: player.pitch, crouched: s.crouched });
      }
      farmers.update(session.remotes, now, frameDt);
      if (sync.desyncAt !== null && !desyncShown) {
        desyncShown = true;
        console.warn(`goofytd: out of sync with the host from tick ${sync.desyncAt}`);
        say('Out of sync with the host! Your farm may look different from theirs. Rejoin to fix it.', 8000);
      }
    }
    // Announce new cow types the first time a wave brings them (auto or by hand).
    if (game.wave !== announcedWave) {
      announcedWave = game.wave;
      const debuts = cowDebuts(game.wave);
      if (debuts.length) say(`New cows this wave: ${debuts.map((t) => t.name).join(', ')}!`, 3500);
    }

    const eye = player.interpolatedEye(clock.alpha);
    // The shake moves only the camera, never your aim for building.
    let view = eye;
    if (shake > 0) {
      shake = Math.max(0, shake - frameDt * 1.8);
      const a = shake * shake * 0.35;
      view = eye.add(new Vec3((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a));
    }
    build.update(now, eye, player.yaw, player.pitch);
    upgrades.update(game);
    input.touch.syncGame(game, build, upgrades.isOpen);
    renderer.setView(view, player.yaw, player.pitch);
    td.update(simClock.alpha, frameDt, build); // culls against the view just set
    renderer.render();
    hud.update(now, frameDt, player, cfg, input, game, build);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Handy from the dev console: tweak movement live, e.g. goofytd.cfg.airAccel = 20,
  // or the match: goofytd.game.money = 9999 (solo only: co-op would desync), goofytd.submit({ k: 'wave' })
  window.goofytd = { cfg, player, world, renderer, input, level, game, build, td, sfx, upgrades, session, sync, farmers, submit };
}
