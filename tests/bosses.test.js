// Boss waves and BIG MAMA BESSIE: her stomp, purse wallop, summon phases,
// resistances, the boss bar's state and determinism.

import { test, assert, assertClose } from './harness.js';
import { levelCollision, openField } from '../src/level.js';
import { Game, defaultGameConfig, BOSS_COW } from '../src/sim/game.js';
import { COW_TYPES, COW_TYPE_LIST } from '../src/sim/cows.js';
import { stateHash } from '../src/sim/commands.js';

const DT = 1 / 64;
const MAMA = COW_TYPES[BOSS_COW];
const B = MAMA.boss;

function fieldGame(over = {}) {
  const level = openField();
  const cfg = { ...defaultGameConfig(), firstWave: null, waveGap: null, startMoney: 100000, milk: 1e9, surprises: false, ...over };
  return new Game(level, levelCollision(level), cfg);
}

/** Spawn the boss and stand her at (x, z). Returns her cow id. */
function bossAt(g, x, z) {
  const i = g.spawnBoss();
  g.cows.x[i] = g.cows.px[i] = x;
  g.cows.z[i] = g.cows.pz[i] = z;
  return g.cows.id[i];
}

const slotOf = (g, id) => { for (let i = 0; i < g.cows.count; i++) if (g.cows.id[i] === id) return i; return -1; };

/** Tick until done(events) is true; returns the events seen, or throws after `seconds`. */
function until(g, seconds, done) {
  const seen = [];
  for (let k = 0; k < Math.round(seconds * 64); k++) {
    g.tick(DT);
    seen.push(...g.events);
    if (done(g.events)) return seen;
  }
  throw new Error(`nothing happened in ${seconds} s`);
}

const census = (g, id) => { let n = 0; for (let i = 0; i < g.cows.count; i++) if (COW_TYPE_LIST[g.cows.type[i]].id === id) n++; return n; };

test('bosses: Big Mama is a boss, upright, the only upright cow, and never in a wave mix', () => {
  assert(MAMA && MAMA.boss && MAMA.upright && MAMA.weight === 0, 'boss def');
  assert(COW_TYPE_LIST.filter((t) => t.upright).length === 1, 'another cow stands upright');
  assert(MAMA.radius > 1, 'radius must exceed half a cell so she walks cell centres');
  assert(COW_TYPES[B.summon.type], 'summons a real cow');
});

test('bosses: every 10th wave brings half the herd, no surprises, and Big Mama after the delay', () => {
  const g = fieldGame({ surprises: true });
  for (let w = 1; w < 10; w++) { g.startWave(); g.runs.length = 0; for (const s of g.spawners) s.queue = 0; g.cows.clear(); }
  assert(!g.isBossWave(9) && g.isBossWave(10) && g.isBossWave(20), 'boss wave numbers');
  const logged = g.surpriseLog.length;
  g.startWave();
  const queued = g.spawners.reduce((a, s) => a + s.queue, 0);
  assert(queued === Math.ceil((g.cfg.waveBase + g.cfg.waveGrowth * 9) / 2), `herd ${queued}`);
  assert(g.surpriseLog.length === logged && g.runs.length === 0, 'a surprise rolled on a boss wave');
  assert(g.spawning, 'wave counted as done before the boss came');
  let spawnAt = null, warned = false, t = 0;
  for (; t < 10; t += DT) {
    g.tick(DT);
    if (g.events.some((e) => e.kind === 'surprise' && e.id === 'boss')) warned = true;
    if (g.events.some((e) => e.kind === 'bossspawn')) { spawnAt = t; break; }
  }
  assert(warned, 'no warning banner');
  assertClose(spawnAt, g.cfg.bossDelay, 2 * DT, 'boss spawn time');
  const st = g.bossStatus();
  assert(st && st.name === MAMA.name && st.phase === 0 && st.count === 1, 'boss bar state');
  assertClose(st.maxHp, MAMA.hp * g.hpScale, 1e-6, 'first boss hp');
  // The next one is tougher on top of the wave scaling.
  g.spawnBoss();
  const hps = [];
  for (let i = 0; i < g.cows.count; i++) if (COW_TYPE_LIST[g.cows.type[i]].boss) hps.push(g.cows.maxHp[i]);
  assertClose(hps[1] / hps[0], 1 + g.cfg.bossHpGrowth, 1e-9, 'second boss hp');
  assert(g.bossStatus().count === 2, 'bar counts bosses');
});

test('bosses: bossEvery 0 turns boss waves off', () => {
  const g = fieldGame({ bossEvery: 0 });
  for (let w = 0; w < 10; w++) g.startWave();
  assert(g.bossQueue.length === 0 && !g.isBossWave(10), 'boss queued anyway');
});

test('bosses: Hoof Stomp winds up standing still, then dents and stuns every tower in reach, not beyond', () => {
  const g = fieldGame();
  const near = g.placeTower('squirter', 4, -40);
  const wall = g.placeTower('haybale', -4, -40);
  const far = g.placeTower('squirter', 0, -40 + B.stomp.radius + 6);
  const id = bossAt(g, 0, -50);
  const wind = until(g, B.stomp.first + 20, (ev) => ev.some((e) => e.kind === 'bosswindup' && e.act === 'stomp'));
  assert(!wind.some((e) => e.kind === 'stomp'), 'stomped with no wind-up');
  const i = slotOf(g, id), x0 = g.cows.x[i], z0 = g.cows.z[i];
  const seen = until(g, B.stomp.windup + 0.1, (ev) => ev.some((e) => e.kind === 'stomp'));
  const j = slotOf(g, id);
  assert(g.cows.x[j] === x0 && g.cows.z[j] === z0, 'walked during the wind-up');
  const stomp = seen.find((e) => e.kind === 'stomp');
  assert(stomp.hit === 2, `hit ${stomp.hit} towers`);
  assert(near.hp === near.maxHp - B.stomp.damage && wall.hp === wall.maxHp - B.stomp.damage, 'stomp damage');
  assert(far.hp === far.maxHp && far.stunT === 0, 'tower out of reach got hit');
  assertClose(near.stunT, B.stomp.stun - DT, DT, 'stun'); // the tower update already ran this tick
  // And it cools down before the next one.
  let again = Infinity;
  for (let k = 0; k < 64 * (B.stomp.cooldown + 1); k++) {
    g.tick(DT);
    if (g.events.some((e) => e.kind === 'bosswindup' && e.act === 'stomp')) { again = (k + 1) * DT; break; }
  }
  assert(again >= B.stomp.cooldown - DT, `stomped again after ${again} s`);
});

test('bosses: Purse Wallop hits the tower right beside her', () => {
  const g = fieldGame();
  const t = g.placeTower('haybale', 3, -40);
  const id = bossAt(g, 0.5, -40);
  g.bosses.get(id).stompCd = 1e9; // wallop only
  const wind = until(g, 2, (ev) => ev.some((e) => e.kind === 'bosswindup' && e.act === 'wallop'));
  assert(wind.find((e) => e.act === 'wallop').tower === t.id, 'wound up on another tower');
  const seen = until(g, B.wallop.windup + 0.1, (ev) => ev.some((e) => e.kind === 'wallop'));
  assert(seen.find((e) => e.kind === 'wallop').tower === t.id, 'walloped another tower');
  assert(t.hp === t.maxHp - B.wallop.damage, `bale hp ${t.hp}/${t.maxHp}`);
});

test("bosses: under 2/3 and 1/3 HP she bellows and calls Mamas; the last phase is angry and faster", () => {
  const g = fieldGame();
  g.wave = 10;
  const id = bossAt(g, 0, -60);
  g.bosses.get(id).stompCd = 1e9;
  g.tick(DT);
  const i = slotOf(g, id);
  g.cows.hp[i] = g.cows.maxHp[i] * 0.6;
  const seen = until(g, B.summon.bellow + 0.2, (ev) => ev.some((e) => e.kind === 'bellow'));
  assert(seen.some((e) => e.kind === 'surprise' && e.id === 'boss'), 'no phase banner');
  assert(census(g, B.summon.type) === B.summon.count, `${census(g, B.summon.type)} summoned`);
  const st = g.bossStatus();
  assert(st.phase === 1 && !st.angry, 'phase 2 state');
  for (let k = 0; k < g.cows.count; k++) {
    if (COW_TYPE_LIST[g.cows.type[k]].id === B.summon.type) assertClose(g.cows.maxHp[k], COW_TYPES[B.summon.type].hp * g.hpScale, 1e-9, 'summon hp');
  }
  // Walking speed before and after she gets angry.
  const pace = () => {
    const j = slotOf(g, id), z0 = g.cows.z[j];
    for (let k = 0; k < 64; k++) g.tick(DT);
    return Math.abs(g.cows.z[slotOf(g, id)] - z0);
  };
  for (let k = 0; k < 64; k++) g.tick(DT);
  const calm = pace();
  g.cows.hp[slotOf(g, id)] = g.cows.maxHp[slotOf(g, id)] * 0.3;
  until(g, B.summon.bellow + 0.2, (ev) => ev.some((e) => e.kind === 'bellow'));
  for (let k = 0; k < 64; k++) g.tick(DT);
  const angry = pace();
  assert(g.bossStatus().phase === 2 && g.bossStatus().angry, 'angry state');
  assert(angry > calm * 1.3, `angry pace ${angry} vs ${calm}`);
});

test("bosses: you can't tip Mama, slows only half-work on her, and she leaves the bar when she dies", () => {
  const g = fieldGame();
  const id = bossAt(g, 0, -60);
  g.tipCows(3);
  const i = slotOf(g, id);
  assert(!(g.cows.slowT[i] > 0 && g.cows.slowF[i] === 0), 'tipped');
  g.slowCow(i, 0.4, 1);
  assertClose(g.cows.slowF[i], 0.4 + 0.6 * MAMA.slowResist, 1e-12, 'slow resist');
  g.tick(DT);
  const j = slotOf(g, id);
  g.events.length = 0;
  assert(g.damageCow(j, 1e9, null, false), 'not dead');
  g.forgetBosses(); // what tick() does with this tick's kills
  assert(g.bossStatus() === null && g.bosses.size === 0, 'still on the bar');
});

test('bosses: a boss kill inside a tick pays the bounty and clears the bar', () => {
  const g = fieldGame();
  g.placeTower('sniper', 0, -20);
  const id = bossAt(g, 0, -40);
  g.cows.hp[slotOf(g, id)] = 1;
  const money = g.money;
  const seen = until(g, 5, (ev) => ev.some((e) => e.kind === 'kill' && e.id === id));
  assert(g.money >= money + MAMA.bounty, 'no bounty');
  assert(g.bossStatus() === null, 'still on the bar');
  assert(seen.some((e) => e.kind === 'surprise' && e.id === 'boss'), 'no defeat banner');
});

test('bosses: a boss wave plays out the same from the same seed', () => {
  const play = () => {
    const g = fieldGame({ seed: 11, milk: 100 });
    for (let k = -2; k <= 2; k++) g.placeTower('squirter', k * 4, -12);
    g.placeTower('mortar', 0, 14);
    g.wave = 9;
    g.startWave();
    const hashes = [];
    for (let k = 0; k < 64 * 90; k++) { g.tick(DT); if (k % 64 === 0) hashes.push(stateHash(g)); }
    return hashes.join();
  };
  assert(play() === play(), 'diverged');
});
