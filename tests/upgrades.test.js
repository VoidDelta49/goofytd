// Tower upgrades: the registry's shape (buffs, then a two-way variant choice,
// then one more level), buying and refusing upgrades, each variant's mechanic,
// a balance regression (every variant wins its niche, nothing runs away),
// determinism and performance.

import { test, assert, assertClose } from './harness.js';
import { levelCollision, openField } from '../src/level.js';
import { Game, UpgradeError, defaultGameConfig } from '../src/sim/game.js';
import { TOWER_TYPES, TOWER_FORMS, SELL_REFUND, towerStats } from '../src/sim/towers.js';
import { COW_TYPES } from '../src/sim/cows.js';
import { upgradeModel, statDeltas } from '../src/client/upgrade-menu.js';

const DT = 1 / 64;
const run = (g, seconds) => { for (let i = 0; i < Math.round(seconds * 64); i++) g.tick(DT); };

function fieldGame(over = {}) {
  const level = openField();
  return new Game(level, levelCollision(level), { ...defaultGameConfig(), firstWave: null, waveGap: null, startMoney: 100000, ...over });
}

/** Spawn a cow exactly at (x, z): spawnCow jitters by ±spawnSpread/2. Returns the slot. */
function put(g, type, x, z, hp) {
  const i = g.spawnCow(type, x, z, hp);
  g.cows.x[i] = g.cows.prevX[i] = x;
  g.cows.z[i] = g.cows.prevZ[i] = z;
  return i;
}

/** Form ids from the buildable root to `id`. */
function chain(id) {
  const c = [];
  for (let f = TOWER_FORMS[id]; f; f = f.from ? TOWER_FORMS[f.from] : null) c.unshift(f.id);
  return c;
}

/** Build the root of `formId` at (x, z) and upgrade it all the way to `formId`. */
function buildForm(g, formId, x, z) {
  const ids = chain(formId);
  const t = g.placeTower(ids[0], x, z);
  assert(t.id, `can't place ${ids[0]}: ${t.reason}`);
  for (const id of ids.slice(1)) {
    const r = g.upgradeTower(t.id, id);
    assert(r.ok, `upgrade to ${id}: ${r.reason}`);
  }
  return t;
}

test('upgrades: every tower has buffs, then a choice of two variants, each with one or more buff levels', () => {
  for (const root of Object.values(TOWER_TYPES)) {
    let f = root, buffs = 0;
    while (f.upgrades.length === 1) {
      f = TOWER_FORMS[f.upgrades[0]];
      assert(f.kind === 'buff', `${f.id}: a single upgrade should be a buff`);
      buffs++;
    }
    assert(buffs >= 1, `${root.id}: no buff levels`);
    assert(f.upgrades.length === 2, `${root.id}: expected a two-way variant choice after ${f.id}`);
    for (const vid of f.upgrades) {
      const v = TOWER_FORMS[vid];
      assert(v.kind === 'variant' && v.root === root.id, `${vid}: should be a variant of ${root.id}`);
      // A straight line of buffs to the end: no second choice down a path.
      let n = 0;
      for (let f2 = v; f2.upgrades.length; n++) {
        assert(f2.upgrades.length === 1, `${f2.id}: only one choice per tower`);
        f2 = TOWER_FORMS[f2.upgrades[0]];
        assert(f2.kind === 'buff', `${f2.id}: levels after a variant should be buffs`);
      }
      assert(n >= 1, `${vid}: should have at least one more level`);
    }
  }
  for (const f of Object.values(TOWER_FORMS)) {
    const root = TOWER_TYPES[f.root];
    assert(f.footprint === root.footprint && f.height === root.height, `${f.id}: footprint/height changed`);
    assert(f.level === chain(f.id).length, `${f.id}: level ${f.level}`);
    assert(f.parts.length > 0 && Array.isArray(towerStats(f)), `${f.id}: no model or stats`);
    if (f.from) assert(f.upgradeCost > 0, `${f.id}: free upgrade`);
  }
  // Upgrades never show up in the build bar.
  assert(Object.keys(TOWER_TYPES).every((id) => TOWER_FORMS[id].kind === 'base'), 'build bar has an upgrade in it');
});

test('upgrades: buying costs moolah, adds to the sell value and swaps the form in place', () => {
  const g = fieldGame({ startMoney: 1000 });
  const t = g.placeTower('squirter', 21, 21);
  const { x, z, aabb } = t;
  const before = g.money;
  const r = g.upgradeTower(t.id, 'squirter2');
  assert(r.ok && t.def === TOWER_FORMS.squirter2, 'not upgraded');
  assert(g.money === before - TOWER_FORMS.squirter2.upgradeCost, 'wrong price');
  assert(t.spent === TOWER_TYPES.squirter.cost + TOWER_FORMS.squirter2.upgradeCost, 'spent not tracked');
  assert(t.x === x && t.z === z && t.aabb === aabb && g.towers.get(t.id) === t, 'moved or replaced');
  const total = t.spent;
  assert(g.sellTower(t.id) === Math.floor(total * SELL_REFUND), 'sell refund ignores the upgrade');
});

test('upgrades: refuses skipped levels, the other path, being broke, a gone tower and a lost game', () => {
  const g = fieldGame({ startMoney: 100000 });
  const t = g.placeTower('squirter', 21, 21);
  assert(g.upgradeTower(t.id, 'squirter3').reason === UpgradeError.NotAnUpgrade, 'skipped a level');
  assert(g.upgradeTower(t.id, 'nope').reason === UpgradeError.NotAnUpgrade, 'unknown form');
  g.upgradeTower(t.id, 'squirter2');
  g.upgradeTower(t.id, 'squirter3');
  assert(g.upgradeTower(t.id, 'gatling').ok, 'variant refused');
  assert(g.upgradeTower(t.id, 'shotgun').reason === UpgradeError.NotAnUpgrade, 'took both paths');
  g.money = 0;
  const m = g.money;
  assert(g.upgradeTower(t.id, 'gatling2').reason === UpgradeError.Money && g.money === m && t.def.id === 'gatling', 'broke upgrade went through');
  assert(g.upgradeTower(9999, 'squirter2').reason === UpgradeError.NoTower, 'missing tower');
  g.money = 100000;
  g.lost = true;
  assert(g.upgradeTower(t.id, 'gatling2').reason === UpgradeError.GameOver, 'upgraded after losing');
});

test('upgrades: the Moo-chine Gun spins up while firing and spins down when idle', () => {
  const g = fieldGame();
  const t = buildForm(g, 'gatling', 31, 31);
  put(g, COW_TYPES.big, t.x - 6, t.z, 1e9);
  const shots = (secs) => {
    let n = 0;
    for (let i = 0; i < secs * 64; i++) { g.tick(DT); n += g.events.filter((e) => e.kind === 'shot').length; }
    return n;
  };
  const first = shots(0.5);
  run(g, 2);
  const later = shots(0.5);
  assert(t.charge === 1, `not fully spun up: ${t.charge}`);
  assert(later > first * 2, `fire rate didn't climb: ${first} then ${later} shots per 0.5 s`);
  assertClose(later, 0.5 / t.def.minInterval, 2, 'spun-up shots');
  g.cows.clear();
  run(g, 1);
  assertClose(t.charge, 1 - t.def.spinDown, 0.05, 'charge after 1 s idle');
});

test('upgrades: the Moo-shotgun hits every cow in its cone (up to its cap) and nothing behind it', () => {
  const g = fieldGame();
  const t = buildForm(g, 'shotgun', 31, 31);
  const hp = 1000;
  const front = [];
  // In front = toward the milk (at the origin), so `first` targeting aims that way.
  for (let k = 0; k < 4; k++) front.push(g.cows.id[put(g, COW_TYPES.cow, t.x - 5 - k * 0.8, t.z + (k % 2 ? 0.6 : -0.6), hp)]);
  const behind = g.cows.id[put(g, COW_TYPES.cow, t.x + 5, t.z, hp)];
  g.tick(DT);
  const hpOf = (id) => { for (let i = 0; i < g.cows.count; i++) if (g.cows.id[i] === id) return g.cows.hp[i]; return null; };
  for (const id of front) assertClose(hpOf(id), hp - t.def.damage, 1e-9, 'cow in the cone');
  assert(hpOf(behind) === hp, 'hit a cow behind the tower');
  const shots = g.events.filter((e) => e.kind === 'shot');
  assert(shots.length === 4 && shots.filter((e) => !e.quiet).length === 1, 'one loud bang, one tracer per pellet');

  const g2 = fieldGame();
  const t2 = buildForm(g2, 'shotgun', 31, 31);
  for (let k = 0; k < 20; k++) {
    const i = g2.spawnCow(COW_TYPES.cow, 0, 0, hp);
    g2.cows.x[i] = g2.cows.prevX[i] = t2.x - 4 - (k % 5) * 0.5;
    g2.cows.z[i] = g2.cows.prevZ[i] = t2.z - 1 + Math.floor(k / 5) * 0.5;
  }
  g2.tick(DT);
  let hit = 0;
  for (let i = 0; i < g2.cows.count; i++) if (g2.cows.hp[i] < hp) hit++;
  assert(hit === t2.def.maxHits, `hit ${hit}, cap ${t2.def.maxHits}`);
});

test('upgrades: Zappy Fence zaps walkers beside it; only the Bug Zapper reaches flyers', () => {
  for (const [id, hitsFlyer] of [['zap', false], ['zap2', true]]) {
    const g = fieldGame();
    const t = buildForm(g, id, 31, 31);
    put(g, COW_TYPES.cow, t.x + 2, t.z, 1000);
    put(g, COW_TYPES.flying, t.x - 2, t.z, 1000);
    put(g, COW_TYPES.cow, t.x + 8, t.z, 1000);
    g.tick(DT);
    const hpAt = (k) => g.cows.hp[k];
    assertClose(hpAt(0), 1000 - t.def.damage, 1e-9, `${id}: walker beside it`);
    assert((hpAt(1) < 1000) === hitsFlyer, `${id}: flyer ${hitsFlyer ? 'missed' : 'zapped'}`);
    assert(hpAt(2) === 1000, `${id}: zapped a cow 8 m away`);
  }
});

test('upgrades: slows halve a cow\'s speed, and Molasses Bales apply them', () => {
  const g = fieldGame();
  const a = g.spawnCow(COW_TYPES.cow, -10, -60, 1e9);
  const b = g.spawnCow(COW_TYPES.cow, 10, -60, 1e9);
  const xa = g.cows.x[a], za = g.cows.z[a], xb = g.cows.x[b], zb = g.cows.z[b]; // spawns are jittered
  for (let i = 0; i < 128; i++) { g.slowCow(a, 0.5, 0.1); g.tick(DT); }
  const da = Math.hypot(g.cows.x[a] - xa, g.cows.z[a] - za), db = Math.hypot(g.cows.x[b] - xb, g.cows.z[b] - zb);
  assertClose(da / db, 0.5, 0.05, 'slowed / free distance');

  const g2 = fieldGame();
  const t = buildForm(g2, 'goo', 31, 31);
  put(g2, COW_TYPES.cow, t.x + 2.5, t.z, 1000);
  g2.tick(DT);
  assert(g2.cows.slowTime[0] > 0 && g2.cows.slowMult[0] === t.def.slow, 'molasses did not slow');
  assert(g2.cows.hp[0] === 1000, 'molasses should not hurt');
  // A weaker slow never overrides a stronger running one.
  g2.slowCow(0, 0.9, 5);
  assert(g2.cows.slowMult[0] === t.def.slow, 'weaker slow won');
});

test('upgrades: Butter Slick leaves a puddle; overlapping puddles don\'t stack', () => {
  const g = fieldGame();
  const t = buildForm(g, 'slick', 31, 31);
  put(g, COW_TYPES.cow, t.x - 15, t.z, 1e6);
  let landed = false;
  for (let i = 0; i < 64 * 3 && !landed; i++) { g.tick(DT); landed = g.events.some((e) => e.kind === 'splash'); }
  assert(landed && g.zones.length === 1, 'no puddle');
  assert(g.zones[0].dps === t.def.slick.dps && g.zones[0].radius === t.def.slick.radius, 'puddle stats');

  const g2 = fieldGame();
  put(g2, COW_TYPES.cow, 30, 30, 1000);
  g2.cows.slowMult[0] = 1;
  g2.zones.push({ x: 30, z: 30, radius: 50, t: 0, T: 99, dps: 10, slow: 0.6, tower: 0, color: 0 });
  g2.zones.push({ x: 30, z: 30, radius: 50, t: 0, T: 99, dps: 20, slow: 0.6, tower: 0, color: 0 });
  run(g2, 1);
  assertClose(1000 - g2.cows.hp[0], 20, 0.01, 'damage from two overlapping puddles in 1 s');
  assert(g2.cows.slowTime[0] > 0, 'puddle did not slow');
  assert(g2.cows.hitAge[0] > 0.5, 'puddle damage made the cow flash red');
});

test('upgrades: Popcorn Flak bursts at flyers (not the walker under them) and halves its damage on walkers', () => {
  const g = fieldGame();
  const t = buildForm(g, 'flak', 31, 31);
  const fy = put(g, COW_TYPES.flying, t.x - 12, t.z, 1000);
  const wk = put(g, COW_TYPES.cow, t.x - 12, t.z, 1000);
  const ids = [g.cows.id[fy], g.cows.id[wk]];
  let burst = null;
  for (let i = 0; i < 64 * 2 && !burst; i++) { g.tick(DT); burst = g.events.find((e) => e.kind === 'splash'); }
  assert(burst && burst.air && burst.y > 3, 'no airburst');
  const hp = (id) => { for (let i = 0; i < g.cows.count; i++) if (g.cows.id[i] === id) return g.cows.hp[i]; return null; };
  assertClose(hp(ids[0]), 1000 - t.def.damage, 1e-9, 'flyer');
  assert(hp(ids[1]) === 1000, 'airburst hit the walker below');

  const g2 = fieldGame();
  const t2 = buildForm(g2, 'flak', 31, 31);
  put(g2, COW_TYPES.cow, t2.x - 12, t2.z, 1000);
  let hit = false;
  for (let i = 0; i < 64 * 2 && !hit; i++) { g2.tick(DT); hit = g2.events.some((e) => e.kind === 'splash'); }
  assertClose(1000 - g2.cows.hp[0], t2.def.damage * t2.def.groundFactor, 1e-9, 'walker damage');
});

test('upgrades: a Packed Bale shrugs off a Kaboom Cow that wrecks the plain bale beside it', () => {
  const g = fieldGame();
  const packed = buildForm(g, 'haybale2', 31, 31);
  const plain = g.placeTower('haybale', packed.x + 2, packed.z);
  const i = put(g, COW_TYPES.boomer, packed.x + 1, packed.z + 2.2, 1000);
  g.explodeCow(i, COW_TYPES.boomer);
  assert(g.towers.has(packed.id), 'packed bale wrecked');
  assert(!g.towers.has(plain.id), 'plain bale survived');
  // Variants built on it keep the armour.
  assert(TOWER_FORMS.zap.blastProof && TOWER_FORMS.goo2.blastProof, 'variants lost blast-proofing');
});

/**
 * Damage dealt per 100 moolah by one tower of `formId` beside a lane that a
 * stream of tough cows walks down: the same harness used to tune the numbers.
 */
function efficiency(formId, cowType, every, perSpawn, secs = 50) {
  const g = fieldGame();
  const root = TOWER_FORMS[formId].root;
  const t = buildForm(g, formId, root === 'haybale' ? 2.5 : root === 'mortar' ? 8 : 5, -30);
  let dmg = 0, hpTotal = 0, timer = 0;
  const orig = g.damageCow.bind(g);
  g.damageCow = (i, d, tw, f) => { dmg += Math.min(d, Math.max(0, g.cows.hp[i])); return orig(i, d, tw, f); };
  for (let k = 0; k < secs * 64; k++) {
    timer -= DT;
    if (timer <= 0 && k < (secs - 20) * 64) {
      timer += every;
      for (let n = 0; n < perSpawn; n++) { g.spawnCow(cowType, -0.5 + n * 0.3, -60, cowType.hp * 10); hpTotal += cowType.hp * 10; }
    }
    g.tick(DT);
  }
  return (100 * dmg / hpTotal) / t.spent * 100;
}

test('upgrades: balance: each variant beats the plain path in its niche and never runs away', () => {
  const herd = (id) => efficiency(id, COW_TYPES.cow, 1.0, 4);
  const big = (id) => efficiency(id, COW_TYPES.big, 3, 1);
  const fly = (id) => efficiency(id, COW_TYPES.flying, 1, 2);
  const e = {
    herd: { squirter: herd('squirter'), shotgun: herd('shotgun'), mortar3: herd('mortar3'), slick: herd('slick'), flak: herd('flak') },
    big: { squirter: big('squirter'), gatling: big('gatling'), gatling2: big('gatling2'), shotgun: big('shotgun') },
    fly: { squirter: fly('squirter'), flak: fly('flak'), flak2: fly('flak2') },
  };
  console.log(`      dmg per 100 moolah: herd ${JSON.stringify(e.herd, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)}`);
  console.log(`      big ${JSON.stringify(e.big, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)} fly ${JSON.stringify(e.fly, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)}`);
  // Specialists win their niche...
  assert(e.herd.shotgun > 1.3 * e.herd.squirter, 'shotgun should beat the squirter on herds');
  assert(e.herd.slick > 1.3 * e.herd.mortar3, 'butter slick should beat the plain mortar on herds');
  assert(e.big.gatling > e.big.squirter && e.big.gatling2 > e.big.gatling, 'gatling should be the boss killer');
  assert(e.fly.flak > 1.3 * e.fly.squirter, 'flak should be the best moolah spent on flyers');
  // ...lose outside it...
  assert(e.big.shotgun < 0.6 * e.big.squirter, 'shotgun should be poor against Big Cows');
  assert(e.herd.flak < e.herd.slick, 'flak should be worse than the slick on walkers');
  // ...and nothing is more than 3x as moolah-efficient as the plain tower.
  for (const [k, row] of Object.entries(e)) {
    const ref = k === 'herd' ? Math.max(row.squirter, row.mortar3) : row.squirter;
    for (const [id, v] of Object.entries(row)) assert(v < 3 * ref, `${id} runs away on ${k}: ${v.toFixed(2)} vs ${ref.toFixed(2)}`);
  }
});

test('upgrades: panel model lists the next upgrades with what they change', () => {
  const g = fieldGame({ startMoney: 100 });
  const t = g.placeTower('squirter', 21, 21);
  let m = upgradeModel(t, g.money);
  assert(m.level === 1 && m.options.length === 1 && !m.choice && !m.maxed, 'base model');
  assert(m.maxLevel === 5 && m.path.length === 1, `pips ${m.maxLevel}`);
  const o = m.options[0];
  assert(o.id === 'squirter2' && o.kind === 'buff' && o.afford === g.money >= o.cost, 'option');
  const dps = o.deltas.find((d) => d.label === 'dps');
  assert(dps && dps.better && dps.from === '24', `dps delta ${JSON.stringify(dps)}`);
  assert(!upgradeModel(t, 0).options[0].afford, 'affordability');
  g.money = 100000;
  g.upgradeTower(t.id, 'squirter2');
  g.upgradeTower(t.id, 'squirter3');
  m = upgradeModel(t, g.money);
  assert(m.choice && m.options.map((x) => x.id).join() === 'gatling,shotgun', 'path choice');
  // An honest trade-off: the shotgun gives up range.
  const range = statDeltas(TOWER_FORMS.squirter3, TOWER_FORMS.shotgun).find((d) => d.label === 'range');
  assert(range && !range.better, 'shotgun range loss not shown as worse');
  g.upgradeTower(t.id, 'gatling');
  g.upgradeTower(t.id, 'gatling2');
  m = upgradeModel(t, g.money);
  assert(m.maxed && m.level === 5 && m.path.map((p) => p.kind).join() === 'base,buff,buff,variant,buff', 'maxed model');
  assert(m.refund === Math.floor(t.spent * SELL_REFUND), 'refund');
});

test('upgrades: same seed, same match with every variant in play (determinism)', () => {
  const play = () => {
    const g = fieldGame({ firstWave: 0.5, waveGap: 2, startMoney: 100000 });
    buildForm(g, 'gatling2', 3, -15);
    buildForm(g, 'shotgun2', -5, -20);
    buildForm(g, 'slick2', 20, 0);
    buildForm(g, 'flak2', -20, 5);
    buildForm(g, 'zap2', 3, -25);
    buildForm(g, 'goo2', -3, -25);
    run(g, 60);
    let h = 0;
    for (let i = 0; i < g.cows.count; i++) h = (h * 31 + g.cows.x[i] * 1000 + g.cows.z[i] + g.cows.type[i]) % 1e9;
    return [g.wave, g.kills, g.milk, g.money, g.cows.count, g.towers.size, g.zones.length, h].join('|');
  };
  const a = play(), b = play();
  assert(a === b, `${a} != ${b}`);
});

test('upgrades: performance with 2000 cows and 40 fully upgraded towers', () => {
  const g = fieldGame({ maxCows: 4096 });
  const forms = ['gatling2', 'shotgun2', 'slick2', 'flak2', 'zap2', 'goo2', 'squirter3', 'mortar3'];
  for (let k = 0; k < 40; k++) {
    const ang = (k / 40) * Math.PI * 2;
    buildForm(g, forms[k % forms.length], Math.cos(ang) * 28, Math.sin(ang) * 28);
  }
  for (let k = 0; k < 2000; k++) {
    const ang = (k / 2000) * Math.PI * 2;
    g.spawnCow(k % 7 === 0 ? COW_TYPES.flying : COW_TYPES.cow, Math.cos(ang) * 40, Math.sin(ang) * 40, 1e9);
  }
  run(g, 0.5);
  const ticks = 128;
  const t0 = performance.now();
  run(g, ticks / 64);
  const perTick = (performance.now() - t0) / ticks;
  console.log(`      ${g.cows.count} cows, ${g.towers.size} upgraded towers, ${g.zones.length} slicks: ${perTick.toFixed(3)} ms/tick`);
  assert(perTick < 8, `tick too slow: ${perTick} ms`);
});
