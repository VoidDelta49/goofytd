// Cow variants: wave mix, Zoomies (fast), Big, Flying and Kaboom (exploding) cows.

import { test, assert } from './harness.js';
import { levelCollision, openField } from '../src/level.js';
import { Game, defaultGameConfig } from '../src/sim/game.js';
import { COW_TYPES, COW_TYPE_LIST, waveMix, pickFromMix, cowDebuts } from '../src/sim/cows.js';

const DT = 1 / 64;

function fieldGame(over = {}) {
  const level = openField();
  const cfg = { ...defaultGameConfig(), firstWave: null, waveGap: null, startMoney: 100000, ...over };
  return new Game(level, levelCollision(level), cfg);
}

/** Tick until done() or the time runs out; returns seconds taken (Infinity if never). */
function until(g, seconds, done) {
  for (let k = 0; k < Math.round(seconds * 64); k++) {
    g.tick(DT);
    if (done()) return (k + 1) * DT;
  }
  return Infinity;
}

const run = (g, seconds) => until(g, seconds, () => false);

test('cows: wave mix starts plain and adds a new type every few waves', () => {
  assert(waveMix(1).length === 1 && waveMix(2).length === 1 && waveMix(1)[0].type === COW_TYPES.cow, 'early waves not plain');
  // Weight-0 types (Cash Cow, Big Bessie, Calf) are surprise-only and never in a mix.
  const waveTypes = COW_TYPE_LIST.filter((t) => t.weight > 0).length;
  assert(waveTypes === 5 && waveMix(6).length === waveTypes, 'wave 6 should have every wave type');
  assert(cowDebuts(1).length === 0, 'wave 1 announces the plain cow');
  const debuted = [3, 4, 5, 6].flatMap((w) => cowDebuts(w).map((t) => t.id)).sort().join();
  assert(debuted === 'big,boomer,fast,flying', `debuts: ${debuted}`);
  const mix = waveMix(6);
  const counts = new Map();
  for (let k = 0; k < 1000; k++) {
    const t = pickFromMix(mix, k / 1000);
    counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
  }
  const total = mix.reduce((a, m) => a + m.weight, 0);
  for (const m of mix) {
    const want = (1000 * m.weight) / total, got = counts.get(m.type.id);
    assert(Math.abs(got - want) <= 1, `${m.type.id}: ${got} picks, want ${want}`);
  }
});

test('cows: spawners use the mix (wave 1 plain, wave 7 everything) with per-wave HP', () => {
  // Surprises off: this checks the wave formula alone (surprises.test.js covers them).
  const g = fieldGame({ waveBase: 40, waveGrowth: 0, milk: 1e9, surprises: false });
  const seen = [];
  const spawn = g.spawnCow.bind(g);
  g.spawnCow = (type, x, z, hp) => { seen.push({ wave: g.wave, id: type.id, hp }); return spawn(type, x, z, hp); };
  for (let w = 1; w <= 7; w++) { g.startWave(); run(g, 6); }
  const w1 = seen.filter((s) => s.wave === 1);
  assert(w1.length === 40 && w1.every((s) => s.id === 'cow' && s.hp === COW_TYPES.cow.hp), 'wave 1 not 40 plain cows');
  const w7 = new Set(seen.filter((s) => s.wave === 7).map((s) => s.id));
  assert(w7.size === COW_TYPE_LIST.filter((t) => t.weight > 0).length, `wave 7 types: ${[...w7]}`);
  const big7 = seen.find((s) => s.wave === 7 && s.id === 'big');
  assert(Math.abs(big7.hp - COW_TYPES.big.hp * (1 + 0.15 * 6)) < 1e-9, `big cow hp ${big7.hp}`);
});

test('cows: Zoomies beat a plain cow to the milk, Big Cows are slow, tanky and stay off the towers', () => {
  const time = (id) => {
    const g = fieldGame();
    g.spawnCow(COW_TYPES[id], 0, -60);
    return until(g, 60, () => g.cows.count === 0);
  };
  const plain = time('cow'), fast = time('fast'), big = time('big');
  assert(fast < plain * 0.6 && big > plain * 1.3, `plain ${plain.toFixed(1)} s, fast ${fast.toFixed(1)} s, big ${big.toFixed(1)} s`);
  // Big cows walk near the cell centre, so they don't clip the towers beside their lane.
  const g = fieldGame();
  for (let k = 0; k < 20; k++) {
    const i = g.spawnCow(COW_TYPES.big, 0, -60);
    assert(Math.abs(g.cows.ox[i]) <= 0.1 + 1e-9 && Math.abs(g.cows.oz[i]) <= 0.1 + 1e-9, 'big cow offset too wide');
  }
});

test('cows: Flying Cows fly straight over a maze, ignore walls, and only hitsAir towers shoot them', () => {
  // A ring of bales around the milk with one gap on the far (south) side.
  const g = fieldGame({ milk: 1e9 });
  for (let k = -6; k <= 6; k += 2) {
    for (const [x, z] of [[k, -6], [k, 6], [-6, k], [6, k]]) {
      if (x === 0 && z === 6) continue;
      g.placeTower('haybale', x + 1, z + 1);
    }
  }
  g.spawnCow(COW_TYPES.cow, 0, -60);
  g.spawnCow(COW_TYPES.flying, 0, -60);
  const flyer = () => [...Array(g.cows.count).keys()].find((i) => g.cows.type[i] === COW_TYPES.flying.index);
  let maxDx = 0;
  const flew = until(g, 60, () => {
    const i = flyer();
    if (i === undefined) return true;
    maxDx = Math.max(maxDx, Math.abs(g.cows.x[i]));
    return false;
  });
  const straight = (60 - 8) / COW_TYPES.flying.speed;
  assert(flew < straight + 2, `flyer took ${flew.toFixed(1)} s, straight line is ${straight.toFixed(1)} s`);
  assert(maxDx < 3, `flyer wandered ${maxDx.toFixed(1)} m sideways`);
  assert(g.cows.count === 1, 'the walker should still be going round the maze');

  // Building under a flyer is fine.
  const g2 = fieldGame();
  const f = g2.spawnCow(COW_TYPES.flying, -30, -30);
  g2.cows.x[f] = -29; g2.cows.z[f] = -29;
  assert(g2.checkPlacement('squirter', -30, -30).ok, `can't build under a flyer: ${g2.checkPlacement('squirter', -30, -30).reason}`);

  // The mortar ignores it; the squirter shoots it, aiming up at it.
  const g3 = fieldGame({ milk: 1e9 });
  g3.placeTower('mortar', 12, -30);
  g3.spawnCow(COW_TYPES.flying, 0, -60);
  run(g3, 12);
  assert(g3.projectiles.length === 0 && g3.kills === 0, 'mortar fired at a flyer');
  const g4 = fieldGame({ milk: 1e9 });
  g4.placeTower('squirter', 5, -30);
  g4.spawnCow(COW_TYPES.flying, 0, -60);
  let y1 = 0;
  until(g4, 20, () => {
    for (const e of g4.events) if (e.kind === 'shot') y1 = e.y1;
    return g4.kills === 1;
  });
  assert(g4.kills === 1, 'squirter never killed the flyer');
  assert(y1 > COW_TYPES.flying.altitude, `tracer aimed at ${y1} m, flyer is at ${COW_TYPES.flying.altitude} m`);
});

/** A wall of bales across the field at z = -20 with one 2 m gap at x 0..2. */
function walledGame(over) {
  const g = fieldGame(over);
  for (let x = -20; x < 20; x += 2) if (x !== 0) assert(g.placeTower('haybale', x + 1, -19).id, `bale at ${x}`);
  return g;
}

test('cows: a Kaboom Cow blows up the towers it walks up to, for no refund and no bounty', () => {
  const g = walledGame();
  const bales = g.towers.size, solids = g.world.solids.length, money = g.money, milk = g.milk;
  const distBefore = g.grid.dist[g.spawners[0].cell];
  g.spawnCow(COW_TYPES.boomer, 1, -40);
  const booms = [];
  const destroyed = [];
  until(g, 20, () => {
    for (const e of g.events) if (e.kind === 'boom') booms.push(e); else if (e.kind === 'destroyed') destroyed.push(e);
    return booms.length > 0;
  });
  assert(booms.length === 1, 'no explosion');
  const b = booms[0];
  assert(Math.abs(b.z - -19) < 3, `exploded at z=${b.z.toFixed(1)}, not at the wall`);
  const gone = bales - g.towers.size;
  assert(gone >= 2 && gone <= 4 && gone === b.wrecked && destroyed.length === gone, `wrecked ${gone} bales (event says ${b.wrecked})`);
  for (const e of destroyed) {
    const dx = Math.max(Math.abs(e.x - b.x) - 1, 0), dz = Math.max(Math.abs(e.z - b.z) - 1, 0);
    assert(dx * dx + dz * dz <= COW_TYPES.boomer.blastRadius ** 2 + 1e-9, `bale at ${e.x} outside the blast`);
  }
  assert(g.world.solids.length === solids - gone, 'wrecked towers still solid for the player');
  let towerCells = 0;
  for (const v of g.grid.tower) if (v) towerCells++;
  assert(towerCells === g.towers.size, `grid still has ${towerCells} tower cells for ${g.towers.size} towers`);
  assert(g.cows.count === 0 && g.kills === 0, 'cow survived or counted as a kill');
  assert(g.money === money && g.milk === milk, 'money or milk changed');
  assert(g.grid.dist[g.spawners[0].cell] <= distBefore, 'flow field not rebuilt');
});

test('cows: a Kaboom Cow walking round the end of a wall always goes off, whatever its herd offset', () => {
  // A short wall across the lane: the cow has to walk round an end, one cell away from it.
  for (let seed = 1; seed <= 24; seed++) {
    const g = fieldGame({ seed });
    for (let x = -6; x < 6; x += 2) g.placeTower('haybale', x + 1, -29);
    g.spawnCow(COW_TYPES.boomer, 0, -50);
    let boom = false;
    until(g, 20, () => (boom = g.events.some((e) => e.kind === 'boom')));
    assert(boom && g.milk === g.cfg.milk, `seed ${seed}: walked past the wall without exploding`);
  }
});

test('cows: a Kaboom Cow shot down early wrecks nothing; one with no towers just drinks', () => {
  const g = walledGame();
  g.placeTower('squirter', 5, -45);
  const towers = g.towers.size;
  g.spawnCow(COW_TYPES.boomer, 1, -60);
  run(g, 25);
  assert(g.kills === 1 && g.towers.size === towers, `kills ${g.kills}, towers ${g.towers.size}/${towers}`);

  const g2 = fieldGame();
  g2.spawnCow(COW_TYPES.boomer, 0, -60);
  run(g2, 30);
  assert(g2.cows.count === 0 && g2.milk === g2.cfg.milk - COW_TYPES.boomer.damage, `milk ${g2.milk}`);
});

test('cows: mixed waves with explosions stay deterministic', () => {
  const play = () => {
    const g = walledGame({ waveBase: 20, waveGrowth: 0, milk: 1e9 });
    g.placeTower('squirter', 9, -25);
    g.placeTower('mortar', -10, -26);
    for (let w = 1; w <= 8; w++) { g.startWave(); run(g, 5); }
    let h = 0;
    for (let i = 0; i < g.cows.count; i++) h = (h * 31 + g.cows.x[i] * 1000 + g.cows.z[i] + g.cows.type[i]) % 1e9;
    return [g.kills, g.money, g.towers.size, g.cows.count, h].join('|');
  };
  const a = play(), b = play();
  assert(a === b, `${a} != ${b}`);
});
