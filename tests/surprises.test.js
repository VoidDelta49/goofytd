// Surprises: scripted sequences rolled on top of the wave formula (src/sim/surprises.js).
import { test, assert } from './harness.js';
import { openField, movementPlayground, levelCollision } from '../src/level.js';
import { Game, defaultGameConfig } from '../src/sim/game.js';
import { COW_TYPES, COW_TYPE_LIST } from '../src/sim/cows.js';
import { SURPRISE_LIST, SURPRISES, surpriseChance } from '../src/sim/surprises.js';

const DT = 1 / 64;

function fieldGame(over = {}, level = openField()) {
  const cfg = { ...defaultGameConfig(), firstWave: null, waveGap: null, startMoney: 100000, milk: 1e9, ...over };
  return new Game(level, levelCollision(level), cfg);
}

/** Tick for `seconds`; returns every event seen (tick() clears them each tick). */
function run(g, seconds) {
  const seen = [];
  for (let k = 0; k < Math.round(seconds * 64); k++) {
    g.tick(DT);
    seen.push(...g.events);
  }
  return seen;
}

/** Count live cows by type id. */
function census(g) {
  const out = {};
  for (let i = 0; i < g.cows.count; i++) {
    const id = COW_TYPE_LIST[g.cows.type[i]].id;
    out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

/** Play `waves` hand-started waves, each followed by `gap` seconds. */
function playWaves(g, waves, gap = 20) {
  for (let w = 0; w < waves; w++) { g.startWave(); run(g, gap); }
}

test('surprises: every one is defined sensibly and the chance grows to a cap', () => {
  assert(SURPRISE_LIST.length >= 8, `only ${SURPRISE_LIST.length} surprises`);
  for (const s of SURPRISE_LIST) {
    assert(s.firstWave >= 2, `${s.id} can happen in wave 1`);
    assert(s.delay[0] >= 0 && s.delay[1] >= s.delay[0], `${s.id} delay`);
    for (const step of s.script({ wave: 12, rng: () => 0.5, game: null })) {
      if (step.spawn) assert(COW_TYPES[step.spawn], `${s.id} spawns unknown cow ${step.spawn}`);
    }
  }
  const cfg = defaultGameConfig();
  assert(surpriseChance(cfg, 1) === 0, 'wave 1 can roll a surprise');
  assert(surpriseChance(cfg, 2) === cfg.surpriseBase && surpriseChance(cfg, 50) === cfg.surpriseMax, 'chance curve');
});

test('surprises: same seed, same surprises; different seeds, different runs', () => {
  const play = (seed) => {
    const g = fieldGame({ seed });
    playWaves(g, 12, 15);
    return { log: JSON.stringify(g.surpriseLog), cows: g.cows.count, money: g.money, x: g.cows.x.slice(0, g.cows.count).join() };
  };
  const a = play(7), b = play(7);
  assert(a.log === b.log && a.cows === b.cows && a.money === b.money && a.x === b.x, 'same seed diverged');
  const logs = new Set();
  for (let seed = 1; seed <= 20; seed++) logs.add(play(seed).log);
  assert(logs.size >= 18, `only ${logs.size} different surprise schedules in 20 seeds`);
});

test('surprises: rate follows the chance, wave 1 never, never 3 quiet waves in a row', () => {
  let rolled = 0, waves = 0, doubles = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const g = fieldGame({ seed, waveBase: 1, waveGrowth: 0 });
    let quiet = 0;
    for (let w = 1; w <= 20; w++) {
      const before = g.surpriseLog.length;
      g.startWave();
      const n = g.surpriseLog.length - before;
      g.runs.length = 0; // only the schedule matters here
      if (w === 1) { assert(n === 0, 'surprise in wave 1'); continue; }
      // Boss waves have the boss instead of a surprise (bosses.test.js covers them).
      if (g.isBossWave(w)) { assert(n === 0, `surprise on boss wave ${w}`); quiet = 0; continue; }
      quiet = n ? 0 : quiet + 1;
      assert(quiet <= g.cfg.surpriseDrought, `seed ${seed}: ${quiet} quiet waves in a row`);
      const ids = g.surpriseLog.slice(before).map((s) => s.id);
      assert(new Set(ids).size === ids.length, 'same surprise twice in one wave');
      waves++;
      if (n) rolled++;
      if (n === 2) doubles++;
    }
  }
  const rate = rolled / waves;
  // Mean chance over waves 2–20 is ~0.67 before the drought guarantee lifts it a bit.
  assert(rate > 0.6 && rate < 0.85, `surprise rate ${rate.toFixed(3)}`);
  assert(doubles > 0, 'never two surprises in a wave');
  console.log(`      surprise rate ${(rate * 100).toFixed(1)}% of waves 2–20, ${doubles} doubles in ${waves} waves`);
});

test("surprises: rolling them doesn't change the regular wave's cows", () => {
  const regular = (surprises) => {
    const g = fieldGame({ seed: 3, surprises, waveBase: 30 });
    const seen = [];
    const spawn = g.spawnCow.bind(g);
    g.spawnCow = (type, x, z, hp, rng) => {
      if (!rng || rng === g.rng) seen.push(`${type.id}@${x},${z}`);
      return spawn(type, x, z, hp, rng);
    };
    playWaves(g, 9, 25);
    return seen.join(';');
  };
  assert(regular(true) === regular(false), 'surprises shifted the regular spawn sequence');
});

test('surprises: each one plays out, announces itself and finishes', () => {
  for (const def of SURPRISE_LIST) {
    const g = fieldGame({ seed: 5, surprises: false, waveBase: 4 });
    for (let w = 0; w < 9; w++) g.startWave(); // wave 9: strong enough for every script
    const spawned = {};
    const spawn = g.spawnCow.bind(g);
    g.spawnCow = (type, x, z, hp, rng) => {
      if (rng === g.surpriseRng) spawned[type.id] = (spawned[type.id] ?? 0) + 1;
      return spawn(type, x, z, hp, rng);
    };
    g.queueSurprise(def.id, 1);
    assert(g.spawning, `${def.id}: a pending surprise should count as spawning`);
    const money = g.money;
    const events = run(g, 25);
    assert(events.some((e) => e.kind === 'surprise' && e.id === def.id), `${def.id}: no banner`);
    assert(g.runs.length === 0, `${def.id}: still running after 25 s`);
    const want = {};
    for (const step of def.script({ wave: 9, rng: () => 0.5, game: g })) {
      if (!step.spawn) continue;
      const n = (step.count ?? 1) * (step.from === 'all' ? g.spawners.length : 1);
      const key = step.mix ? 'mix' : step.spawn;
      want[key] = (want[key] ?? 0) + n;
    }
    const total = Object.values(spawned).reduce((a, n) => a + n, 0);
    const wantTotal = Object.values(want).reduce((a, n) => a + n, 0);
    assert(total === wantTotal, `${def.id}: spawned ${JSON.stringify(spawned)}, want ${JSON.stringify(want)}`);
    for (const [id, n] of Object.entries(want)) {
      if (id !== 'mix') assert(spawned[id] === n, `${def.id}: ${spawned[id]} ${id}, want ${n}`);
    }
    if (def.id === 'wallet') assert(g.money > money, 'wallet paid nothing');
  }
});

test('surprises: Cash Cow pays out when shot and taunts you when it escapes', () => {
  const g = fieldGame({ seed: 2, surprises: false });
  g.startWave();
  g.cows.clear();
  g.queueSurprise('cashcow');
  run(g, 1);
  const i = [...Array(g.cows.count).keys()].find((k) => g.cows.type[k] === COW_TYPES.golden.index);
  assert(i !== undefined, 'no cash cow');
  const money = g.money;
  g.damageCow(i, 1e9, null);
  g.watchTracked(); // what the end of tick() does
  assert(g.money - money === 40 + 10 * g.wave, `paid ${g.money - money}`);
  assert(g.tracked.size === 0, 'still watching a dead cow');

  const h = fieldGame({ seed: 2, surprises: false });
  h.startWave();
  h.cows.clear();
  h.queueSurprise('cashcow');
  const before = h.money;
  const events = run(h, 40);
  assert(events.some((e) => e.kind === 'surprise' && /got away/.test(e.text)), 'no escape banner');
  assert(h.money === before && h.tracked.size === 0, 'escape changed money or left it tracked');
});

test('surprises: Too Quiet holds the wave, then dumps it fast', () => {
  const g = fieldGame({ seed: 4, surprises: false, waveBase: 400, waveGrowth: 0 });
  g.startWave();
  g.queueSurprise('tooquiet');
  run(g, 0.05);
  const held = g.cows.count;
  run(g, 6.5);
  assert(g.cows.count === held, `spawned ${g.cows.count - held} cows during the hold`);
  run(g, 1);
  const t0 = g.cows.count;
  run(g, 2);
  // 4 spawners at 0.5 s × 0.3 = one cow per spawner every 0.15 s.
  assert(g.cows.count - t0 >= 4 * 12, `rush spawned only ${g.cows.count - t0} cows in 2 s`);
});

test('surprises: an ambush comes from a reachable spot at the field edge, away from the milk and spawners', () => {
  for (const level of [openField(), movementPlayground()]) {
    const g = fieldGame({ seed: 9 }, level);
    for (let k = 0; k < 50; k++) {
      const p = g.flankPoint();
      if (!p) continue;
      const c = g.grid.cellAt(p.x, p.z);
      assert(g.grid.walkable(c) && g.grid.dist[c] < Infinity, 'flank point unreachable');
      assert(Math.hypot(p.x - g.milkX, p.z - g.milkZ) >= 30, 'flank point next to the milk');
      assert(g.spawners.every((s) => Math.hypot(p.x - s.x, p.z - s.z) >= 15), 'flank point on a spawner');
    }
  }
  const g = fieldGame({ seed: 9, surprises: false });
  g.startWave();
  g.cows.clear();
  g.queueSurprise('ambush');
  const events = run(g, 0.1);
  const banner = events.find((e) => e.kind === 'surprise' && e.id === 'ambush');
  assert(banner && Number.isFinite(banner.x), 'ambush banner has no position (for the sound)');
});

test('surprises: a hand-started wave still shows its banners (scheduled, then fired inside tick)', () => {
  const g = fieldGame({ seed: 1 });
  g.startWave(); g.startWave(); // wave 2
  g.runs.length = 0;
  g.queueSurprise(SURPRISES.wallet, 0.5);
  assert(g.events.every((e) => e.kind !== 'surprise'), 'surprise event pushed outside tick (would be lost)');
  assert(run(g, 1).some((e) => e.kind === 'surprise'), 'banner never fired');
});

test('surprises: Big Bessie walks cell centres and is a real boss', () => {
  const b = COW_TYPES.bessie;
  const g = fieldGame({ surprises: false });
  assert(Math.min(0.6 * g.grid.cell, Math.max(0, g.grid.cell - 2 * b.radius)) === 0, 'Bessie gets a herd offset');
  assert(b.weight === 0 && COW_TYPES.golden.weight === 0 && COW_TYPES.calf.weight === 0, 'surprise cows leak into wave mixes');
  assert(b.hp >= 2 * COW_TYPES.big.hp && b.speed < COW_TYPES.big.speed, 'Bessie not tougher and slower than a Big Cow');
});
