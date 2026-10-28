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

// Real Firefox recording (Linux X11 UA, DPR 1.25): each frame is a real delta
// then an echo carrying the cursor's offset from the lock anchor.
import firefoxEcho from './fixtures/firefox-echo.json' with { type: 'json' };

/** Feed [x, y, frame] rows, consuming once per frame; returns per-frame counts. */
function replayFrames(m, rows) {
  const out = [];
  let frame = rows[0][2];
  rows.forEach(([x, y, f], i) => {
    if (f !== frame) { out.push(m.consume(1).map((r) => -r / ((DEG_PER_COUNT * Math.PI) / 180))); frame = f; }
    m.addMouse(x, y, i * 8);
  });
  out.push(m.consume(1).map((r) => -r / ((DEG_PER_COUNT * Math.PI) / 180)));
  return out;
}

test('look: Firefox echo events are dropped, real motion is kept exactly', () => {
  const rows = firefoxEcho.events;
  // Ground truth: the first event of every frame is the real delta.
  let tx = 0, ty = 0, maxReal = 0, seen = new Set();
  for (const [x, y, f] of rows) {
    if (seen.has(f)) continue;
    seen.add(f); tx += x; ty += y; maxReal = Math.max(maxReal, Math.abs(x), Math.abs(y));
  }
  const m = new MouseLook();
  const frames = replayFrames(m, rows);
  assert(m.stats.echo, 'echo mode not detected');
  const sx = frames.reduce((a, f) => a + f[0], 0), sy = frames.reduce((a, f) => a + f[1], 0);
  assertClose(sx, tx, 1e-6, 'total x vs real motion');
  assertClose(sy, ty, 1e-6, 'total y vs real motion');
  // After detection (3rd frame) and its one correction frame, no frame jumps.
  const worst = Math.max(...frames.slice(4).map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
  assert(worst <= maxReal, `frame jumped ${worst} counts (largest real delta ${maxReal})`);
  assertClose(m.stats.echoes, rows.length - seen.size, 0, 'echo count');
});

test('look: real hand motion never trips the echo filter', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
  const streams = {
    sine: Array.from({ length: 400 }, (_, i) => [Math.round(40 * Math.sin(i / 9)), Math.round(25 * Math.cos(i / 6))]),
    accelFlick: Array.from({ length: 30 }, (_, i) => [Math.round(1.25 ** i), Math.round(1.2 ** i)]),
    noise: Array.from({ length: 2000 }, () => [Math.round(rnd() * 60), Math.round(rnd() * 60)]),
    reversals: Array.from({ length: 300 }, (_, i) => [i % 2 ? 50 : -50, i % 3 ? 20 : -40]),
    slowJitter: Array.from({ length: 2000 }, () => [Math.round(rnd() * 4), Math.round(rnd() * 4)]),
  };
  for (const [name, deltas] of Object.entries(streams)) {
    const m = new MouseLook();
    feed(m, deltas, 0, 8);
    assert(!m.stats.echo && m.stats.echoes === 0, `${name}: echo filter tripped`);
    // All of these ramp gradually, so the spike filter keeps every event.
    const want = deltas.reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
    assert(m.dx === want[0] && m.dy === want[1], `${name}: motion lost`);
  }
});

test('look: echo filter turns itself off when the warp starts working again', () => {
  const m = new MouseLook();
  replayFrames(m, firefoxEcho.events.slice(0, 20));
  assert(m.stats.echo, 'not detected');
  feed(m, Array.from({ length: 12 }, () => [5, 3]), 1000, 8);
  assert(!m.stats.echo, 'still filtering a clean stream');
});

import { loadFullscreenLock } from '../src/client/input.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), has: (k) => m.has(k) };
}

test('fullscreen lock: on by default, ?fs=0 opts out and is remembered, ?fs=1 opts back in', () => {
  assert(loadFullscreenLock(null, fakeStorage()), 'off by default');
  assert(loadFullscreenLock(null, fakeStorage({ 'goofytd.fullscreenLock': '1' })), 'old stored flag turned it off');
  assert(loadFullscreenLock('1', fakeStorage()), '?fs=1 ignored');
  const st = fakeStorage();
  assert(!loadFullscreenLock('0', st), '?fs=0 ignored');
  assert(!loadFullscreenLock(null, st), 'opt-out not remembered');
  assert(loadFullscreenLock('1', st) && loadFullscreenLock(null, st), '?fs=1 did not clear the opt-out');
  assert(loadFullscreenLock(null, { getItem() { throw new Error('blocked'); } }), 'blocked storage turned it off');
  assert(!loadFullscreenLock('0', { setItem() { throw new Error('blocked'); } }), '?fs=0 failed with blocked storage');
});

// ---- touch button labels and the pause menu (no real DOM: tiny fakes) ----

import { touchButtonState } from '../src/client/touch.js';
import { PauseMenu, RESTART_CONFIRM_MS } from '../src/client/menu.js';
import { TOWER_TYPES, TOWER_FORMS, SELL_REFUND } from '../src/sim/towers.js';

test('touch buttons: BUILD / SELL explain themselves and only light up when usable', () => {
  const id = Object.keys(TOWER_TYPES)[0];
  const def = TOWER_TYPES[id];
  const game = { money: 1000, wave: 3, lost: false };
  const idle = touchButtonState(game, { selected: null, lookTower: null, preview: null });
  assert(idle.place.dim && idle.place.sub === 'pick a tower', 'BUILD should ask for a tower first');
  assert(idle.sell.dim && idle.sell.sub === 'look at a tower', 'SELL should ask you to look at a tower');

  const ready = touchButtonState(game, { selected: id, lookTower: null, preview: { ok: true } });
  assert(!ready.place.dim && !ready.place.bad && ready.place.sub === def.name, 'BUILD should name the selected tower');
  const blocked = touchButtonState(game, { selected: id, lookTower: null, preview: { ok: false, reason: 'occupied' } });
  assert(blocked.place.bad, 'BUILD should flag a ghost that cannot be placed');
  const poor = touchButtonState({ ...game, money: def.cost - 1 }, { selected: id, lookTower: null, preview: { ok: true } });
  assert(poor.place.bad && poor.place.sub === 'need more moolah', 'BUILD should say when moolah is short');

  const sell = touchButtonState(game, { selected: null, lookTower: { spent: 100, def }, preview: null });
  assert(!sell.sell.dim && sell.sell.sub === `+${Math.floor(100 * SELL_REFUND)} moolah`, `SELL refund text: ${sell.sell.sub}`);
});

test('touch buttons: UPGRADE names the next level, a path choice, or MAXED', () => {
  const game = { money: 1000, wave: 3, lost: false };
  const at = (formId) => touchButtonState(game, { selected: null, lookTower: { spent: 0, def: TOWER_FORMS[formId] }, preview: null }).upgrade;
  assert(touchButtonState(game, { selected: null, lookTower: null, preview: null }).upgrade.dim, 'nothing to upgrade');
  const next = TOWER_FORMS[TOWER_FORMS.squirter.upgrades[0]];
  assert(at('squirter').sub === `LV 2 · ${next.upgradeCost}` && !at('squirter').dim, `buff text: ${at('squirter').sub}`);
  assert(at('squirter3').sub === 'pick a path!', 'variant choice');
  assert(at('gatling2').sub === 'MAXED' && at('gatling2').dim, 'maxed');
  const open = touchButtonState(game, { selected: null, lookTower: null, preview: null }, true).upgrade;
  assert(open.on && open.sub === 'close', 'open panel: the button closes it');
});

test('touch buttons: NEXT WAVE hides before wave 1 (START button) and after losing (TRY AGAIN)', () => {
  const b = { selected: null, lookTower: null, preview: null };
  assert(touchButtonState({ money: 0, wave: 0, lost: false }, b).wave.hidden, 'hidden at wave 0');
  assert(!touchButtonState({ money: 0, wave: 2, lost: false }, b).wave.hidden, 'shown mid-game');
  assert(touchButtonState({ money: 0, wave: 2, lost: true }, b).wave.hidden, 'hidden when lost');
});

function fakeMenu(state) {
  const els = {};
  for (const n of ['sound', 'autoHop', 'sensLabel', 'restart']) {
    els[n] = { textContent: '', classList: { on: false, toggle(_c, v) { this.on = v; } }, dataset: { menu: n } };
  }
  const root = { hidden: true, addEventListener() {}, querySelector: (sel) => els[/data-menu=(\w+)/.exec(sel)[1]] };
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => () => calls.push(name) });
  const menu = new PauseMenu(root, actions, () => state);
  const tap = (name) => menu.onClick({ target: { closest: () => ({ dataset: { menu: name } }) } });
  return { menu, els, calls, tap, root };
}

test('pause menu: labels show the current values and update when opened', () => {
  const m = fakeMenu({ muted: true, autoHop: false, sens: '1.5' });
  m.menu.show();
  assert(!m.root.hidden, 'show should reveal the overlay');
  assert(m.els.sound.textContent === 'SOUND: OFF', m.els.sound.textContent);
  assert(m.els.autoHop.textContent === 'AUTO-HOP: OFF', m.els.autoHop.textContent);
  assert(m.els.sensLabel.textContent === 'LOOK SPEED 1.5', m.els.sensLabel.textContent);
  m.menu.hide();
  assert(m.root.hidden, 'hide should hide');
});

test('pause menu: RESTART needs a second tap, and the first tap says so', () => {
  const m = fakeMenu({ muted: false, autoHop: true, sens: '0.30°/px' });
  m.menu.show();
  m.tap('restart');
  assert(m.calls.length === 0, 'one tap must not restart');
  assert(m.els.restart.textContent === 'TAP AGAIN TO RESTART', m.els.restart.textContent);
  m.tap('restart');
  assert(m.calls.join() === 'restart', `second tap should restart, got ${m.calls}`);
  m.tap('resume');
  assert(m.calls.join() === 'restart,resume', 'other buttons act at once');
  assert(RESTART_CONFIRM_MS >= 2000, 'confirm window too short for a thumb');
});
