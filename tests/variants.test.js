// Later cow variants (Tin, Mama, Raging Bull, Vet, Ninja, Trojan, Mega Mama)
// and the surprise helpers they brought (bounty boost, cow tipping, milkman).

import { test, assert } from './harness.js';
import { levelCollision, openField } from '../src/level.js';
import { Game, defaultGameConfig } from '../src/sim/game.js';
import { COW_TYPES, COW_TYPE_LIST, HEAL_PULSE } from '../src/sim/cows.js';
import { TARGETING } from '../src/sim/towers.js';
import { SURPRISES } from '../src/sim/surprises.js';

const DT = 1 / 64;

function fieldGame(over = {}) {
  const level = openField();
  const cfg = { ...defaultGameConfig(), firstWave: null, waveGap: null, startMoney: 100000, milk: 1e9, surprises: false, ...over };
  return new Game(level, levelCollision(level), cfg);
}

function put(g, id, x, z, hp) {
  const i = g.spawnCow(COW_TYPES[id], x, z, hp ?? COW_TYPES[id].hp);
  g.cows.x[i] = g.cows.prevX[i] = x;
  g.cows.z[i] = g.cows.prevZ[i] = z;
  return i;
}

const slotOf = (g, id) => { for (let i = 0; i < g.cows.count; i++) if (g.cows.id[i] === id) return i; return -1; };
const countType = (g, id) => { let n = 0; for (let i = 0; i < g.cows.count; i++) if (COW_TYPE_LIST[g.cows.type[i]].id === id) n++; return n; };

function run(g, seconds) {
  const events = [];
  for (let k = 0; k < Math.round(seconds * 64); k++) { g.tick(DT); events.push(...g.events); }
  return events;
}

test('variants: Tin Cow armor blunts direct hits (never below 25%), slicks seep through', () => {
  const g = fieldGame();
  const i = put(g, 'tin', 0, -40);
  g.damageCow(i, 6, null); // squirter
  assert(Math.abs(g.cows.hp[i] - 58) < 1e-9, `6-damage squirt left ${g.cows.hp[i]}`);
  g.damageCow(i, 4, null); // floor: 25% of 4
  assert(Math.abs(g.cows.hp[i] - 57) < 1e-9, `armor floor: ${g.cows.hp[i]}`);
  g.damageCow(i, 0.5, null, false); // slick tick
  assert(Math.abs(g.cows.hp[i] - 56.5) < 1e-9, `slick tick: ${g.cows.hp[i]}`);
  const c = put(g, 'cow', 4, -40);
  g.damageCow(c, 6, null);
  assert(g.cows.hp[c] === COW_TYPES.cow.hp - 6, 'plain cows have no armor');
});

test('variants: Mama Cow pops 3 calves at wave HP; Mega Mama nests twice; kills never shift wave draws', () => {
  const g = fieldGame(), g2 = fieldGame();
  for (let w = 0; w < 5; w++) { g.startWave(); g2.startWave(); }
  g.cows.clear(); g2.cows.clear();
  for (const s of [...g.spawners, ...g2.spawners]) s.queue = 0;
  const i = g2.cows.spawn(COW_TYPES.mama, 0, -30, 0, 0); // straight into the pool: no rng draw
  g2.events.length = 0;
  g2.damageCow(i, 1e6, null);
  assert(countType(g2, 'calf') === 3 && countType(g2, 'mama') === 0, `calves ${countType(g2, 'calf')}`);
  const split = g2.events.find((e) => e.kind === 'split');
  assert(split && split.count === 3 && split.type === 'calf', 'no split event');
  for (let k = 0; k < g2.cows.count; k++) {
    assert(Math.abs(g2.cows.hp[k] - COW_TYPES.calf.hp * g2.hpScale) < 1e-9, 'calf HP not wave-scaled');
    assert(Math.hypot(g2.cows.x[k], g2.cows.z[k] + 30) < 1.5, 'calf landed far from mama');
  }
  assert(g.rng() === g2.rng(), 'a split drew from the wave rng');

  const g3 = fieldGame();
  const m = put(g3, 'megamama', 0, -30);
  g3.damageCow(m, 1e6, null);
  assert(countType(g3, 'mama') === 3, 'mega mama should drop 3 mamas');
  for (let k = g3.cows.count - 1; k >= 0; k--) g3.damageCow(k, 1e6, null); // backwards, like every caller
  assert(countType(g3, 'calf') === 9 && g3.cows.count === 9, `then 9 calves, got ${g3.cows.count}`);
});

test('variants: a shotgun blast through a herd of Mamas kills each one once and keeps the calves', () => {
  const g = fieldGame();
  const t = g.placeTower('squirter', 6, -30);
  for (const f of ['squirter2', 'squirter3', 'shotgun']) assert(g.upgradeTower(t.id, f).ok, `upgrade ${f}`);
  const ids = [];
  for (let k = 0; k < 6; k++) ids.push(g.cows.id[put(g, 'mama', 0, -30 + k * 0.3, 1)]);
  g.tick(DT);
  const kills = g.events.filter((e) => e.kind === 'kill').map((e) => e.id);
  assert(kills.length > 0 && new Set(kills).size === kills.length, `kills: ${kills}`);
  const mamasLeft = ids.filter((id) => slotOf(g, id) >= 0).length;
  assert(kills.length === 6 - mamasLeft && countType(g, 'calf') === 3 * kills.length, `kills ${kills.length}, calves ${countType(g, 'calf')}`);
});

test('variants: Raging Bull runs 2.2× faster once under half HP', () => {
  const speed = (hpFrac) => {
    const g = fieldGame();
    const i = put(g, 'bull', 0, -60);
    g.cows.hp[i] = g.cows.maxHp[i] * hpFrac;
    run(g, 0.5); // let the velocity ease in
    const z0 = g.cows.z[slotOf(g, 1)];
    run(g, 1);
    return Math.abs(g.cows.z[slotOf(g, 1)] - z0);
  };
  const calm = speed(1), mad = speed(0.4);
  assert(Math.abs(calm - COW_TYPES.bull.speed) < 0.15, `calm ${calm.toFixed(2)} m/s`);
  assert(Math.abs(mad / calm - 2.2) < 0.1, `enraged ${mad.toFixed(2)} vs ${calm.toFixed(2)} m/s`);
});

test('variants: a Vet Cow heals cows near it back up to their max, not those far away or itself', () => {
  const g = fieldGame();
  const v = g.cows.id[put(g, 'vet', 0, -40)];
  const near = g.cows.id[put(g, 'big', 3, -40)];
  const far = g.cows.id[put(g, 'cow', 20, -40)];
  for (const id of [v, near, far]) g.cows.hp[slotOf(g, id)] = 10;
  const events = run(g, HEAL_PULSE + DT);
  const hp = (id) => g.cows.hp[slotOf(g, id)];
  const want = 10 + COW_TYPES.vet.healRate * HEAL_PULSE * COW_TYPES.big.hp;
  assert(Math.abs(hp(near) - want) < 1e-9, `near cow ${hp(near)}, want ${want}`);
  assert(hp(far) === 10 && hp(v) === 10, 'healed something out of reach (or itself)');
  assert(events.some((e) => e.kind === 'heal'), 'no heal event');
  run(g, 20);
  if (slotOf(g, near) >= 0) assert(hp(near) <= COW_TYPES.big.hp, 'overhealed');
});

test('variants: towers only see a Ninja Cow once it is within 7 m, but splash still hits it', () => {
  const g = fieldGame();
  const t = g.placeTower('squirter', 0, -30);
  const i = put(g, 'ninja', 10, -30);
  assert(TARGETING.first(g, t) === -1, 'spotted a ninja 10 m out');
  g.cows.x[i] = 5;
  assert(TARGETING.first(g, t) === i, 'missed a ninja 5 m out');
  g.cows.x[i] = 10;
  const hp = g.cows.hp[i];
  g.splash(10, -30, 2, 5, null);
  assert(g.cows.hp[i] === hp - 5, 'splash missed the ninja');
});

test('variants: cow tipping stops walkers for its time (not flyers), Happy Hour doubles bounties then ends', () => {
  const g = fieldGame();
  const w = g.cows.id[put(g, 'cow', 0, -40)];
  const f = g.cows.id[put(g, 'flying', 10, -40)];
  assert(g.tipCows(3) === 1, 'tipped a flyer');
  const z = (id) => g.cows.z[slotOf(g, id)];
  const zw = z(w), zf = z(f);
  run(g, 2.9);
  assert(z(w) === zw, 'tipped cow walked');
  assert(z(f) > zf + 5, 'flyer stopped');
  run(g, 1);
  assert(z(w) > zw, 'tipped cow never got up');

  const h = fieldGame();
  h.boostBounty(2, 15);
  const m0 = h.money;
  h.damageCow(put(h, 'cow', 0, -40), 1e6, null);
  assert(h.money - m0 === 2 * COW_TYPES.cow.bounty, `happy-hour bounty ${h.money - m0}`);
  run(h, 15.1);
  const m1 = h.money;
  h.damageCow(put(h, 'cow', 0, -40), 1e6, null);
  assert(h.money - m1 === COW_TYPES.cow.bounty && h.bountyMult === 1, 'happy hour never ended');
});

test('variants: the milkman tops up milk (capped), or pays when the tank is full', () => {
  const g = fieldGame({ milk: 100 });
  for (let w = 0; w < 6; w++) g.startWave();
  g.milk = 90;
  g.queueSurprise('milkman', 0);
  run(g, DT);
  assert(g.milk === 100, `milk ${g.milk}`);
  const m = g.money;
  g.queueSurprise(SURPRISES.milkman, 0);
  run(g, DT);
  assert(g.milk === 100 && g.money === m + 20 + 5 * 6, `full tank paid ${g.money - m}`);
});

test('variants: Trojan Cow and Mega Mama surprises spill their passengers when shot', () => {
  for (const [id, kid, n] of [['trojan', 'fast', 6], ['matryoshka', 'mama', 3]]) {
    const g = fieldGame();
    for (let w = 0; w < 9; w++) g.startWave();
    g.cows.clear();
    for (const s of g.spawners) s.queue = 0;
    g.queueSurprise(id, 0);
    const events = run(g, 2);
    assert(g.cows.count === 1, `${id}: ${g.cows.count} cows`);
    // Shoot it inside a tick, as a tower would: kill hooks only see events from inside tick().
    const towers = g.updateTowers;
    g.updateTowers = function (dt) { this.updateTowers = towers; this.damageCow(0, 1e6, null); towers.call(this, dt); };
    events.push(...run(g, DT));
    assert(countType(g, kid) === n, `${id}: ${countType(g, kid)} ${kid}`);
    assert(events.filter((e) => e.kind === 'surprise' && e.id === id).length === 2, `${id}: no punchline`);
  }
});

/** Waves 1–14 against a few towers of each kind: splits, heals, enrage, armor and camo all in play. */
function playMatch(seed) {
  const g = fieldGame({ seed, surprises: true, waveGap: 10, startMoney: 3000 });
  for (const [type, x, z] of [['squirter', 6, -20], ['squirter', -6, -20], ['mortar', 0, -10], ['squirter', 6, -6], ['haybale', -4, -6]]) g.placeTower(type, x, z);
  g.startWave();
  const kinds = new Set();
  for (let s = 0; s < 64 * 260; s++) {
    g.tick(DT);
    for (const e of g.events) kinds.add(e.kind);
    if (g.wave > 14) break;
  }
  let sum = 0;
  for (let i = 0; i < g.cows.count; i++) sum += g.cows.x[i] * 3 + g.cows.z[i] * 7 + g.cows.hp[i];
  return { key: `${g.wave}|${g.kills}|${g.money}|${g.milk}|${g.cows.count}|${sum}`, kinds, log: g.surpriseLog.map((s) => s.id).join() };
}

test('variants: same seed, same match with every new cow and surprise in play (determinism)', () => {
  const a = playMatch(11), b = playMatch(11);
  assert(a.key === b.key && a.log === b.log, `diverged:\n${a.key}\n${b.key}`);
  assert(a.kinds.has('split') && a.kinds.has('heal'), `never split or healed: ${[...a.kinds]}`);
});

test('variants: performance with 2000 cows including Vets, Mamas and Ninjas', () => {
  const g = fieldGame();
  for (let w = 0; w < 13; w++) g.startWave();
  for (const s of g.spawners) s.queue = 0;
  for (let x = -24; x <= 24; x += 8) for (const z of [-30, -14]) g.placeTower('squirter', x, z);
  const ids = ['cow', 'tin', 'mama', 'bull', 'vet', 'ninja', 'fast', 'big'];
  for (let k = 0; k < 2000; k++) {
    const id = k % 40 === 0 ? 'vet' : ids[k % ids.length];
    const i = put(g, id, -40 + (k % 80), -70 + Math.floor(k / 80) * 0.5);
    g.cows.hp[i] = g.cows.maxHp[i] * 0.9;
  }
  for (let k = 0; k < 64; k++) g.tick(DT);
  const N = 256;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) g.tick(DT);
  const ms = (performance.now() - t0) / N;
  console.log(`      2000 cows (50 vets), 14 towers: ${ms.toFixed(3)} ms/tick`);
  assert(ms < 4, `${ms} ms/tick`);
});
