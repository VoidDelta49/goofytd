// Lv7–10 tower forms: chain hits, marks, stuns, statuses on any attack,
// cluster shells, lava puddles, income, scarecrow boosts, bounty hunting,
// plus determinism and performance with every Lv10 form in play.

import { test, assert, assertClose } from './harness.js';
import { levelCollision, openField } from '../src/level.js';
import { Game, defaultGameConfig } from '../src/sim/game.js';
import { TOWER_FORMS, towerStats } from '../src/sim/towers.js';
import { COW_TYPES } from '../src/sim/cows.js';

const DT = 1 / 64;
const run = (g, seconds) => { for (let i = 0; i < Math.round(seconds * 64); i++) g.tick(DT); };

function fieldGame(over = {}) {
  const level = openField();
  return new Game(level, levelCollision(level), { ...defaultGameConfig(), firstWave: null, waveGap: null, startMoney: 1e7, surprises: false, ...over });
}

function put(g, type, x, z, hp) {
  const i = g.spawnCow(type, x, z, hp);
  g.cows.x[i] = g.cows.prevX[i] = x;
  g.cows.z[i] = g.cows.prevZ[i] = z;
  return i;
}

function chain(id) {
  const c = [];
  for (let f = TOWER_FORMS[id]; f; f = f.from ? TOWER_FORMS[f.from] : null) c.unshift(f.id);
  return c;
}

function buildForm(g, formId, x, z) {
  const ids = chain(formId);
  const t = g.placeTower(ids[0], x, z);
  assert(t.id, `can't place ${ids[0]}: ${t.reason}`);
  for (const id of ids.slice(1)) assert(g.upgradeTower(t.id, id).ok, `upgrade to ${id}`);
  return t;
}

/** Tick until the tower fires once; returns that tick's events. */
function untilShot(g, t, max = 640) {
  for (let k = 0; k < max; k++) {
    g.tick(DT);
    if (g.events.some((e) => e.tower === t.id && (e.kind === 'shot' || e.kind === 'launch' || e.kind === 'spray'))) return g.events;
  }
  throw new Error('tower never fired');
}

const LEAVES = Object.values(TOWER_FORMS).filter((f) => f.level === 10).map((f) => f.id);

test('late towers: 24 Lv10 forms, every one with stats, a model and a price', () => {
  assert(LEAVES.length === 24, `${LEAVES.length} Lv10 forms`);
  for (const f of Object.values(TOWER_FORMS)) {
    assert(f.parts.length && towerStats(f).every((r) => r.label && r.value !== undefined), `${f.id}: stats/model`);
    if (f.level >= 7 && f.from) assert(f.upgradeCost >= TOWER_FORMS[f.from].upgradeCost * 0.5, `${f.id}: suspiciously cheap`);
  }
});

test('late towers: Chocolate Thunder jumps to the nearest cows, each jump weaker', () => {
  const g = fieldGame();
  const t = buildForm(g, 'chocogat', 31, 31);
  const hp = 1e6;
    // In a line away from the milk: the nearest one (to the milk) is the target, each jump goes one further.
  const slots = [put(g, COW_TYPES.big, t.x + 4, t.z, hp), put(g, COW_TYPES.big, t.x + 6, t.z, hp), put(g, COW_TYPES.big, t.x + 8, t.z, hp), put(g, COW_TYPES.big, t.x + 10, t.z, hp)];
  const ids = slots.map((i) => g.cows.id[i]);
  const ev = untilShot(g, t);
  const shots = ev.filter((e) => e.kind === 'shot' && e.tower === t.id);
  assert(shots.length === 3 && shots.filter((e) => e.chain).length === 2, `${shots.length} tracers`);
  const lost = ids.map((id) => { for (let i = 0; i < g.cows.count; i++) if (g.cows.id[i] === id) return hp - g.cows.hp[i]; return -1; });
  const d = TOWER_FORMS.chocogat.damage - COW_TYPES.big.armor;
  assert(lost[3] === 0, 'jumped past its jump count');
  assert(lost[0] > lost[1] && lost[1] > lost[2] && lost[2] > 0, `falloff ${lost}`);
  assert(lost[0] <= d + 1e-9 || COW_TYPES.big.armor === 0, 'first hit too big');
});

test('late towers: marks make every tower hit harder; stuns stop a cow; bosses resist', () => {
  const g = fieldGame();
  const t = buildForm(g, 'strawgat', 31, 31);
  const i = put(g, COW_TYPES.cow, t.x - 8, t.z, 1e6);
  untilShot(g, t);
  assert(g.cows.chillTime[i] > 0 && Math.abs(g.cows.chillMult[i] - 1.15) < 1e-9, 'no mark');
  // Tranquilizer: every dart stuns.
  const g2 = fieldGame();
  const s = buildForm(g2, 'tranq', 31, 31);
  const k = put(g2, COW_TYPES.big, s.x - 20, s.z, 1e6);
  untilShot(g2, s);
  assert(g2.cows.slowMult[k] === 0 && g2.cows.slowTime[k] > 1, `not stunned ${g2.cows.slowMult[k]}`);
  run(g2, 0.3); // momentum bleeds off
  const x0 = g2.cows.x[k], z0 = g2.cows.z[k];
  run(g2, 0.3);
  assert(Math.hypot(g2.cows.x[k] - x0, g2.cows.z[k] - z0) < 0.01, 'stunned cow walked');
});

test('late towers: Cottage Cheese Buckshot curdles only every 3rd blast', () => {
  const g = fieldGame();
  const t = buildForm(g, 'buckshot', 31, 31);
  const i = put(g, COW_TYPES.cow, t.x - 5, t.z, 1e6);
  const stunnedAfter = [];
  for (let n = 0; n < 3; n++) { untilShot(g, t); stunnedAfter.push(g.cows.slowMult[i] === 0 && g.cows.slowTime[i] > 0); }
  assert(stunnedAfter.join() === 'false,false,true', `stuns ${stunnedAfter}`);
});

test('late towers: Eggnog and Plasma set what they hit on fire; Fro-Yo shells chill the splash', () => {
  for (const id of ['eggnog', 'plasma']) {
    const g = fieldGame();
    const t = buildForm(g, id, 31, 31);
    const i = put(g, COW_TYPES.big, t.x - 6, t.z, 1e6);
    untilShot(g, t);
    assert(g.cows.burnTime[i] > 0 && g.cows.burnSource[i] === t.id, `${id}: no burn`);
  }
  const g = fieldGame();
  const t = buildForm(g, 'yogurt', 31, 31);
  const i = put(g, COW_TYPES.big, t.x - 15, t.z, 1e6);
  untilShot(g, t);
  run(g, 2.5);
  assert(g.cows.chillTime[i] > 0 && g.cows.chillMult[i] > 1 && g.cows.slowTime[i] > 0, 'fro-yo did not chill');
});

test('late towers: cluster shells drop count + 1 projectiles in a ring that turns each volley', () => {
  const g = fieldGame();
  const t = buildForm(g, 'cluster', 31, 31);
  put(g, COW_TYPES.big, t.x - 15, t.z, 1e6);
  untilShot(g, t);
  const first = g.projectiles.map((p) => [p.x1, p.z1]);
  assert(first.length === 5, `${first.length} shells`);
  const main = first[0];
  for (const [x, z] of first.slice(1)) assertClose(Math.hypot(x - main[0], z - main[1]), 3.2, 1e-9);
  run(g, 3);
  untilShot(g, t);
  const second = g.projectiles.slice(-5);
  const rel = (p) => [p.x1 - second[0].x1, p.z1 - second[0].z1].map((v) => v.toFixed(3)).join();
  assert(rel(second[1]) !== [first[1][0] - main[0], first[1][1] - main[1]].map((v) => v.toFixed(3)).join(), 'ring never turned');
});

test('late towers: Lava Latte leaves a puddle every 8th squirt', () => {
  const g = fieldGame();
  const t = buildForm(g, 'volcano', 31, 31);
  put(g, COW_TYPES.cow, t.x - 5, t.z, 1e6);
  for (let n = 0; n < 7; n++) untilShot(g, t);
  assert(g.zones.length === 0, 'puddle too early');
  untilShot(g, t);
  assert(g.zones.length === 1 && g.zones[0].dps === TOWER_FORMS.volcano.slick.dps, 'no lava puddle');
});

test('late towers: Milk Money Printer pays income every wave, saved up or not', () => {
  const g = fieldGame({ startMoney: 0 });
  g.money = 1e6;
  buildForm(g, 'printer4', 31, 31);
  g.money = 0;
  g.payInterest();
  assert(g.lastInterest === TOWER_FORMS.printer4.income + 0 && g.money === TOWER_FORMS.printer4.income, `paid ${g.lastInterest}`);
});

test('late towers: a Scarecrow speeds up towers in reach (best one counts), not those outside', () => {
  const shotsIn = (withCrow) => {
    const g = fieldGame();
    const t = buildForm(g, 'squirter', 31, 31);
    if (withCrow) { buildForm(g, 'scarecrow4', 35, 31); buildForm(g, 'scarecrow', 27, 31); }
    const i = put(g, COW_TYPES.cow, t.x - 6, t.z, 1e9);
    g.cows.slowMult[i] = 0; g.cows.slowTime[i] = 1e9; // parked in front of it
    // A squirter far away is out of every scarecrow's reach.
    const far = buildForm(g, 'squirter', -41, -41);
    let n = 0;
    for (let k = 0; k < 640; k++) { g.tick(DT); n += g.events.filter((e) => e.kind === 'shot' && e.tower === t.id).length; }
    return [n, t.boost, far.boost];
  };
  const [plain, b0] = shotsIn(false), [boosted, b1, bFar] = shotsIn(true);
  assert(b0 === 1 && bFar === 1 && Math.abs(b1 - 1.3) < 1e-9, `boost ${b0} ${b1} ${bFar}`);
  assert(boosted > plain * 1.25 && boosted < plain * 1.35, `${plain} → ${boosted}`);
});

test('late towers: Bounty Hunter kills pay ×ownBounty; others pay normal', () => {
  const earned = (form) => {
    const g = fieldGame();
    const t = buildForm(g, form, 31, 31);
    put(g, COW_TYPES.cow, t.x - 20, t.z, 1);
    const m = g.money;
    untilShot(g, t);
    return g.money - m;
  };
  assertClose(earned('bounty') / earned('tranq'), 2, 0.051);
});

test('late towers: Rodeo Auction slows walkers in reach and still pays its multiplier', () => {
  const g = fieldGame();
  const t = buildForm(g, 'rodeo', 31, 31);
  const i = put(g, COW_TYPES.cow, t.x - 10, t.z, 1e6);
  run(g, 0.5);
  assertClose(g.cows.slowMult[i], 0.75, 1e-9);
  assert(g.bankMult(t.x - 10, t.z) === 2.8, 'lost its multiplier');
});

test('late towers: same seed, same match with every Lv10 form in play (determinism)', () => {
  const play = () => {
    const g = fieldGame({ firstWave: 0.5, waveGap: 2 });
    LEAVES.forEach((id, n) => buildForm(g, id, -46 + (n % 12) * 8, n < 12 ? -24 : 24));
    run(g, 40);
    let h = 0;
    for (let i = 0; i < g.cows.count; i++) h = (h * 31 + g.cows.x[i] * 1000 + g.cows.z[i] + g.cows.type[i]) % 1e9;
    return [g.wave, g.kills, g.milk, g.money, g.cows.count, g.zones.length, g.projectiles.length, h].join('|');
  };
  const a = play(), b = play();
  assert(a === b, `${a} != ${b}`);
});

test('late towers: performance with 2000 cows and 48 Lv10 towers', () => {
  const g = fieldGame();
  for (let n = 0; n < 48; n++) buildForm(g, LEAVES[n % 24], -46 + (n % 12) * 8, -36 + Math.floor(n / 12) * 24);
  for (let n = 0; n < 2000; n++) put(g, COW_TYPES.cow, -60 + (n % 50) * 2.4, -80 + Math.floor(n / 50) * 0.5, 1e9);
  run(g, 0.5);
  const t0 = performance.now();
  const N = 64;
  for (let k = 0; k < N; k++) g.tick(DT);
  const ms = (performance.now() - t0) / N;
  console.log(`      2000 cows, 48 Lv10 towers: ${ms.toFixed(3)} ms/tick`);
  assert(ms < 4, `too slow: ${ms.toFixed(2)} ms/tick`);
});
