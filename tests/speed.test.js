// Fast-forward: the match clock runs 2x or 3x the ticks for the same real
// time, each tick still exactly 1/64 s, so a fast-forwarded match is the same
// match, only sooner. The farmer keeps moving in real time. It's a `speed`
// command, so co-op machines agree on the pace.

import { test, assert } from './harness.js';
import { FixedClock, TICK_HZ } from '../src/fixed-clock.js';
import { levelCollision, openField } from '../src/level.js';
import { Game, GAME_SPEEDS, defaultGameConfig } from '../src/sim/game.js';
import { applyCommand, sanitizeCommand, stateHash } from '../src/sim/commands.js';
import { Lockstep, MAX_CATCHUP } from '../src/net/lockstep.js';
import { touchButtonState } from '../src/client/touch.js';

function fieldGame(seed = 3) {
  const level = openField();
  return new Game(level, levelCollision(level), { ...defaultGameConfig(), seed, firstWave: null, waveGap: null, surprises: false });
}

const cmd = (g, c) => applyCommand(g, sanitizeCommand(c));

/** Drive a game the way main.js does: a match clock fed `fps` frames of real time at `scale`. */
function playFrames(g, fps, frames, scale, onTick) {
  const clock = new FixedClock();
  for (let f = 0; f < frames; f++) {
    const n = clock.advance(1 / fps, scale);
    for (let i = 0; i < n; i++) { g.tick(clock.dt); onTick?.(); }
  }
  return clock;
}

test('speed: the match clock runs 1x, 2x and 3x the ticks at 30, 60 and 144 fps', () => {
  for (const fps of [30, 60, 144]) {
    for (const scale of GAME_SPEEDS) {
      const clock = new FixedClock();
      for (let f = 0; f < fps * 10; f++) clock.advance(1 / fps, scale);
      const want = 10 * TICK_HZ * scale;
      assert(Math.abs(clock.tickCount - want) <= 1, `${fps} fps ${scale}x ran ${clock.tickCount}, want ${want}`);
    }
  }
});

test('speed: 1x is exactly the old clock, and the stall cap scales with the speed', () => {
  const a = new FixedClock(), b = new FixedClock();
  for (const dt of [0.016, 0.017, 0.033, 0.001, 0.25, 0.0167]) assert(a.advance(dt) === b.advance(dt, 1), 'scale 1 changed the clock');
  const c = new FixedClock();
  assert(c.advance(10, 3) === c.maxTicks * 3, 'cap not scaled');
  assert(c.alpha === 0, 'time beyond the cap should be dropped');
});

test('speed: only 1x, 2x and 3x are accepted; the setting survives a restart and is in the state hash', () => {
  for (const x of [0, 4, 1.5, -2, '2', null, Infinity]) assert(sanitizeCommand({ k: 'speed', x }) === null, `accepted ${x}`);
  const g = fieldGame();
  assert(g.timeScale === 1, 'starts at 1x');
  const h1 = stateHash(g);
  assert(cmd(g, { k: 'speed', x: 3 }).ok && g.timeScale === 3, 'not applied');
  assert(stateHash(g) !== h1, 'hash ignores the speed');
  cmd(g, { k: 'reset', seed: 9 });
  assert(g.timeScale === 3, 'restart reset the speed');
});

test('speed: a 3x match is the same match as 1x, only three times sooner', () => {
  const slow = fieldGame(), fast = fieldGame();
  for (const g of [slow, fast]) {
    g.placeTower('squirter', 5, -30);
    g.placeTower('mortar', -5, -30);
    cmd(g, { k: 'wave' });
  }
  cmd(fast, { k: 'speed', x: 3 });
  // 60 fps: 20 s of real time at 1x vs 20/3 s at 3x.
  let ts = 0, tf = 0;
  playFrames(slow, 60, 1200, 1, () => ts++);
  playFrames(fast, 60, 400, 3, () => tf++);
  assert(Math.abs(ts - tf) <= 1, `ticks differ: ${ts} vs ${tf}`);
  // Line them up to the tick, then compare the whole match.
  while (ts < tf) { slow.tick(1 / TICK_HZ); ts++; }
  while (tf < ts) { fast.tick(1 / TICK_HZ); tf++; }
  slow.timeScale = fast.timeScale;
  assert(stateHash(slow) === stateHash(fast), 'fast-forward changed the outcome');
  assert(fast.kills > 0, 'nothing happened in the test match');
});

test('speed: a co-op client keeps pace with a 3x host and stays bit-identical', () => {
  const games = [fieldGame(5), fieldGame(5)];
  const hostSync = new Lockstep({ role: 'host', me: 0, send: (m) => inbox.push(JSON.parse(JSON.stringify(m))) });
  const clientSync = new Lockstep({ role: 'client', me: 1, send: (m) => hostSync.receiveCommand(1, m.c) });
  const inbox = [];
  const clocks = [new FixedClock(), new FixedClock()];
  const syncs = [hostSync, clientSync];
  clientSync.submit({ k: 'speed', x: 3 }); // a joiner may change it too
  hostSync.submit({ k: 'wave' });
  let maxBehind = 0;
  for (let f = 0; f < 1800; f++) {
    // The client hears the host a frame late.
    const msgs = inbox.splice(0);
    for (let k = 0; k < 2; k++) {
      const g = games[k], s = syncs[k];
      if (f % 97 === 0 && k === 0) s.submit({ k: 'place', type: 'squirter', x: -20 + (f % 40), z: -30 });
      const n = s.ticksToRun(clocks[k].advance(1 / 60, g.timeScale), g.timeScale);
      for (let i = 0; i < n; i++) {
        for (const c of s.beginTick()) applyCommand(g, c);
        g.tick(1 / TICK_HZ);
        s.endTick(g);
      }
      s.flush();
    }
    for (const m of msgs) clientSync.receiveFrames(m);
    maxBehind = Math.max(maxBehind, hostSync.tick - clientSync.tick);
  }
  assert(games[0].timeScale === 3 && games[1].timeScale === 3, 'speed not shared');
  assert(hostSync.tick > 1800 / 60 * TICK_HZ * 2.9, `host ran only ${hostSync.tick} ticks in 30 s`);
  assert(maxBehind < 20, `client fell ${maxBehind} ticks behind`);
  assert(clientSync.desyncAt === null, `desync at ${clientSync.desyncAt}`);
});

test('speed: a client\'s catch-up cap grows with the speed', () => {
  const ls = new Lockstep({ role: 'client', me: 1 });
  ls.receiveFrames({ t: 'f', s: 0, n: 400 });
  assert(ls.ticksToRun(3, 1) === MAX_CATCHUP, 'cap at 1x');
  assert(ls.ticksToRun(9, 3) === MAX_CATCHUP * 3, 'cap at 3x');
});

test('speed: the touch fast-forward button says the speed and lights up above 1x', () => {
  const b = { selected: null, lookTower: null, preview: null };
  const at = (timeScale) => touchButtonState({ money: 0, wave: 1, lost: false, timeScale }, b).ff;
  assert(at(1).label === '▶▶ 1×' && !at(1).on, JSON.stringify(at(1)));
  assert(at(3).label === '▶▶ 3×' && at(3).on, JSON.stringify(at(3)));
  assert(touchButtonState({ money: 0, wave: 1, lost: false }, b).ff.label === '▶▶ 1×', 'missing timeScale');
});
