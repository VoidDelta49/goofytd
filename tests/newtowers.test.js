// Milk Frother (spray, burns, flambé, brain freeze), Hayloft Sniper (camo
// spotting, headshots, executions, railgun) and Auction Barn (bounty
// multiplier, vault interest): mechanics, balance, determinism, performance.

import { test, assert, assertClose } from './harness.js';
import { levelCollision, openField } from '../src/level.js';
import { Game, defaultGameConfig } from '../src/sim/game.js';
import { TOWER_FORMS, EXECUTE_MAX_HP } from '../src/sim/towers.js';
import { COW_TYPES } from '../src/sim/cows.js';

const DT = 1 / 64;
const run = (g, seconds) => { for (let i = 0; i < Math.round(seconds * 64); i++) g.tick(DT); };

function fieldGame(over = {}) {
  const level = openField();
  return new Game(level, levelCollision(level), { ...defaultGameConfig(), firstWave: null, waveGap: null, startMoney: 100000, surprises: false, ...over });
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

const hpOf = (g, id) => { for (let i = 0; i < g.cows.count; i++) if (g.cows.id[i] === id) return g.cows.hp[i]; return null; };
const slotOf = (g, id) => { for (let i = 0; i < g.cows.count; i++) if (g.cows.id[i] === id) return i; return -1; };

test('frother: one jet soaks every walker in its cone (through Tin armour, no red flash) and sets them simmering', () => {
  const g = fieldGame();
  const t = buildForm(g, 'frother', 31, 31);
  const hp = 1000;
  // In front = toward the milk at the origin, so `first` aims that way.
  const front = [0, 1, 2].map((k) => g.cows.id[put(g, COW_TYPES.cow, t.x - 3 - k, t.z + (k - 1) * 0.4, hp)]);
  const tin = g.cows.id[put(g, COW_TYPES.tin, t.x - 4.5, t.z, hp)];
  const behind = g.cows.id[put(g, COW_TYPES.cow, t.x + 4, t.z, hp)];
  const flyer = g.cows.id[put(g, COW_TYPES.flying, t.x - 3, t.z, hp)];
  g.tick(DT);
  for (const id of [...front, tin]) {
    // The jet, then the first sliver of burn the same tick.
    assertClose(hpOf(g, id), hp - t.def.damage - t.def.burn.dps * DT, 1e-9, 'cow in the jet');
    const i = slotOf(g, id);
    assert(g.cows.burnTime[i] > 0 && g.cows.burnDps[i] === t.def.burn.dps, 'not burning');
    assert(g.cows.hitAge[i] > 1, 'spray made a cow flash red');
  }
  assert(hpOf(g, behind) === hp, 'hit a cow behind it');
  assert(hpOf(g, flyer) === hp, 'the base frother hit a flyer');
  const sprays = g.events.filter((e) => e.kind === 'spray');
  assert(sprays.length === 1 && sprays[0].hits === 4, `one jet event: ${JSON.stringify(sprays.map((e) => e.hits))}`);

  // Brûlée reaches flyers.
  const g2 = fieldGame();
  const t2 = buildForm(g2, 'brulee', 31, 31);
  const f2 = g2.cows.id[put(g2, COW_TYPES.flying, t2.x - 4, t2.z, hp)];
  g2.tick(DT);
  assert(hpOf(g2, f2) < hp, 'brûlée missed the flyer');
});

test('frother: burns deal dps × time, credit the tower, and a weaker burn never cools a hotter one', () => {
  const g = fieldGame();
  const t = g.placeTower('haybale', 31, 31); // stand-in tower to credit
  const i = put(g, COW_TYPES.cow, -30, -60, 1000);
  g.igniteCow(i, 10, 2, 0, t.id);
  g.igniteCow(i, 4, 5, 0, t.id); // weaker: ignored
  run(g, 3);
  assertClose(1000 - g.cows.hp[0], 20, 1e-6, 'burn total');
  assert(g.cows.burnTime[0] <= 0, 'still burning');
  // Burn kills count for the tower that lit it.
  const k = put(g, COW_TYPES.cow, -30, -60, 1);
  g.igniteCow(k, 10, 1, 0, t.id);
  run(g, 0.5);
  assert(t.kills === 1, `kills ${t.kills}`);
});

test('frother: flambé — a burning cow that drops lights the cows around it (once, no endless chain)', () => {
  const g = fieldGame();
  const t = g.placeTower('haybale', 31, 31);
  const dying = put(g, COW_TYPES.cow, -30, -60, 0.1);
  const near = g.cows.id[put(g, COW_TYPES.cow, -31, -60, 1000)];
  const far = g.cows.id[put(g, COW_TYPES.cow, -40, -60, 1000)];
  g.igniteCow(dying, 20, 4, 2.5, t.id);
  g.tick(DT);
  const n = slotOf(g, near), f = slotOf(g, far);
  assert(g.cows.burnTime[n] > 0 && g.cows.burnDps[n] === 20, 'neighbour did not catch fire');
  assert(g.cows.burnSpread[n] === 0, 'second-hand burns should not spread further');
  assertClose(g.cows.burnTime[n], (4 - DT) * 0.75, 1e-9, 'second-hand burn lasts 75% of what the burner had left');
  assert(g.cows.burnTime[f] === 0, 'a cow 10 m away caught fire');
  assert(g.events.some((e) => e.kind === 'flambe' && e.count === 1), 'no flambé event');
});

test('frother: soft-serve brain freeze slows cows and makes every hit land harder, then thaws', () => {
  const g = fieldGame();
  const t = buildForm(g, 'softserve', 31, 31);
  const id = g.cows.id[put(g, COW_TYPES.cow, t.x - 4, t.z, 1000)];
  g.tick(DT);
  const i = slotOf(g, id);
  const { chill } = t.def;
  assert(g.cows.chillTime[i] > 0 && g.cows.chillMult[i] === chill.vuln, 'not frozen');
  assert(g.cows.slowMult[i] === chill.slow, 'not slowed');
  // The jet's own hit already counts the freeze.
  assertClose(1000 - g.cows.hp[i], t.def.damage * chill.vuln, 1e-9, 'first jet');
  // Any other tower's hit is multiplied too.
  const before = g.cows.hp[i];
  g.damageCow(i, 10, null);
  assertClose(before - g.cows.hp[i], 10 * chill.vuln, 1e-9, 'brittle hit');
  g.sellTower(t.id);
  run(g, chill.time + 0.1);
  assert(g.cows.chillTime[i] <= 0 && g.cows.chillMult[i] === 1, 'never thawed');
});

test('sniper: targets the toughest cow far away; only a scope spots a distant Ninja', () => {
  for (const [id, sees] of [['sniper', false], ['sniper2', true]]) {
    const g = fieldGame();
    const t = buildForm(g, id, 31, 31);
    const ninja = g.cows.id[put(g, COW_TYPES.ninja, t.x - 25, t.z, 5000)];
    const cow = g.cows.id[put(g, COW_TYPES.cow, t.x - 30, t.z, 50)];
    g.tick(DT);
    assert((hpOf(g, ninja) < 5000) === sees, `${id}: ninja ${sees ? 'missed' : 'spotted'}`);
    assert((hpOf(g, cow) === 50) === sees, `${id}: should shoot ${sees ? 'the tougher ninja' : 'the visible cow'}`);
  }
});

test('sniper: Udder Assassin headshots every third shot; Silent Moo-n executes the wounded but not bosses', () => {
  const g = fieldGame();
  const t = buildForm(g, 'assassin', 31, 31);
  const i = put(g, COW_TYPES.big, t.x - 20, t.z, 1e9);
  const dmg = [];
  for (let k = 0; k < 64 * 10 && dmg.length < 6; k++) {
    const before = g.cows.hp[i];
    g.tick(DT);
    if (g.events.some((e) => e.kind === 'shot')) dmg.push(before - g.cows.hp[i]);
  }
  const d = t.def.damage, c = d * t.def.critMult;
  assert(dmg.join() === [d, d, c, d, d, c].join(), `shots ${dmg.join()}`);

  const g2 = fieldGame();
  const t2 = buildForm(g2, 'assassin2', 31, 31);
  const hp = 10 * t2.def.damage;
  const a = g2.cows.id[put(g2, COW_TYPES.cow, t2.x - 20, t2.z, hp)];
  g2.cows.hp[slotOf(g2, a)] = 0.2 * hp + t2.def.damage - 1; // its first (plain) shot leaves it just under 20%
  g2.tick(DT);
  assert(hpOf(g2, a) === null && g2.events.some((e) => e.kind === 'execute'), 'not executed');
  assert(COW_TYPES.bessie.hp > EXECUTE_MAX_HP, 'Bessie should count as a boss');
  const b = g2.cows.id[put(g2, COW_TYPES.bessie, t2.x - 20, t2.z, 1e6)];
  g2.cows.hp[slotOf(g2, b)] = 0.1 * 1e6;
  run(g2, 3);
  assert(hpOf(g2, b) > 0, 'executed Big Bessie');
});

test('sniper: the Cheddar Railgun skewers every cow on the line (armour and all), nothing beside it', () => {
  const g = fieldGame();
  const t = buildForm(g, 'rail', 31, 31);
  const hp = 1e6;
  // Strongest is the target; the rest line up behind and in front of it.
  const target = g.cows.id[put(g, COW_TYPES.big, t.x - 20, t.z, hp * 2)];
  const onLine = [t.x - 8, t.x - 30, t.x - 45].map((x) => g.cows.id[put(g, COW_TYPES.cow, x, t.z + 0.3, hp)]);
  const tin = g.cows.id[put(g, COW_TYPES.tin, t.x - 12, t.z, hp)];
  const off = g.cows.id[put(g, COW_TYPES.cow, t.x - 20, t.z + 4, hp)];
  const backwards = g.cows.id[put(g, COW_TYPES.cow, t.x + 10, t.z, hp)];
  g.tick(DT);
  assertClose(hpOf(g, target), hp * 2 - t.def.damage, 1e-9, 'target');
  for (const id of onLine) assertClose(hpOf(g, id), hp - t.def.damage, 1e-9, 'cow on the line');
  assertClose(hpOf(g, tin), hp - t.def.damage, 1e-9, 'Tin armour should not blunt the slug');
  assert(hpOf(g, off) === hp && hpOf(g, backwards) === hp, 'hit a cow off the line');
});

test('barn: kills in reach pay the best barn\'s multiplier (barns don\'t stack); outside pays normal', () => {
  const g = fieldGame({ startMoney: 1000 });
  const a = buildForm(g, 'barn', 31, 31);
  buildForm(g, 'barn2', 31, 39); // overlapping, better
  const bounty = COW_TYPES.big.bounty;
  const kill = (x, z) => {
    const i = put(g, COW_TYPES.big, x, z, 1);
    const m = g.money;
    g.damageCow(i, 10, null);
    return g.money - m;
  };
  assert(kill(a.x, a.z - 3) === Math.round(bounty * 1.4), 'best barn in reach');
  assert(kill(a.x, a.z + 18) === Math.round(bounty * 1.4), 'only barn2 reaches (12 m)');
  assert(kill(a.x - 30, a.z) === bounty, 'outside every barn');
  g.boostBounty(2, 10);
  assert(kill(a.x, a.z - 3) === Math.round(bounty * 2 * 1.4), 'happy hour times the barn');
  const kills = g.events.filter((e) => e.kind === 'kill').map((e) => e.mult);
  assert(kills.join() === '1.4,1.4,1,1.4', `kill mults ${kills.join()}`);
});

test('barn: Cheese Vaults pay capped interest on banked moolah as each wave starts', () => {
  const g = fieldGame({ startMoney: 100000 });
  const v1 = buildForm(g, 'vault', 31, 31);
  buildForm(g, 'vault2', -31, 31);
  g.money = 500;
  g.startWave();
  // Interest is on the balance after the wave bonus lands.
  const bank = 500 + g.cfg.waveBonus;
  const paid = Math.min(40, Math.floor(bank * 0.05)) + Math.min(80, Math.floor(bank * 0.08));
  assert(g.lastInterest === paid, `interest ${g.lastInterest} vs ${paid}`);
  assert(g.money === 500 + g.cfg.waveBonus + paid, 'paid out');
  g.money = 100000;
  g.startWave();
  assert(g.lastInterest === 40 + 80, 'caps');
  g.sellTower(v1.id);
  g.money = 0;
  g.startWave();
  assert(g.lastInterest === Math.floor(g.cfg.waveBonus * 0.08), 'interest on the wave bonus only');
});

/** Damage per 100 moolah, same harness as upgrades.test.js, cows × `hpx` (40: tough enough that nothing kills everything). */
function efficiency(formId, cowType, every, perSpawn, hpx = 40, secs = 50) {
  const g = fieldGame();
  const t = buildForm(g, formId, 5, -30);
  let dmg = 0, hpTotal = 0, timer = 0;
  const orig = g.damageCow.bind(g);
  g.damageCow = (i, d, tw, f, p) => {
    const real = g.cows.chillTime[i] > 0 ? d * g.cows.chillMult[i] : d;
    dmg += Math.min(real, Math.max(0, g.cows.hp[i]));
    return orig(i, d, tw, f, p);
  };
  for (let k = 0; k < secs * 64; k++) {
    timer -= DT;
    if (timer <= 0 && k < (secs - 20) * 64) {
      timer += every;
      for (let n = 0; n < perSpawn; n++) { g.spawnCow(cowType, -0.5 + n * 0.3, -60, cowType.hp * hpx); hpTotal += cowType.hp * hpx; }
    }
    g.tick(DT);
  }
  return (100 * dmg / hpTotal) / t.spent * 100;
}

test('new towers: balance: frother on herds, assassin on bosses, railgun through armour; nothing runs away', () => {
  const herd = (id) => efficiency(id, COW_TYPES.cow, 1.0, 4);
  const big = (id) => efficiency(id, COW_TYPES.big, 3, 1);
  const tin = (id) => efficiency(id, COW_TYPES.tin, 1.0, 2);
  const e = {
    herd: { squirter: herd('squirter'), frother: herd('frother'), brulee3: herd('brulee3'), softserve3: herd('softserve3'), rail3: herd('rail3'), sniper: herd('sniper') },
    big: { squirter: big('squirter'), sniper: big('sniper'), assassin3: big('assassin3'), frother: big('frother') },
    tin: { squirter: tin('squirter'), frother: tin('frother'), rail: tin('rail') },
  };
  const fmt = (o) => JSON.stringify(o, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v);
  console.log(`      dmg per 100 moolah (cows ×40 hp): herd ${fmt(e.herd)}`);
  console.log(`      big ${fmt(e.big)} tin ${fmt(e.tin)}`);
  assert(e.herd.frother > 1.5 * e.herd.squirter, 'frother should beat the squirter on herds');
  assert(e.big.frother < e.big.squirter, 'frother should be poor against Big Cows');
  assert(e.big.assassin3 > e.big.squirter, 'assassin should be a boss killer');
  assert(e.herd.sniper < e.herd.squirter, 'a plain sniper should be poor against herds');
  assert(e.tin.rail > 1.3 * e.tin.squirter && e.tin.frother > e.tin.squirter, 'railgun and frother should shrug off Tin armour');
  for (const [k, row] of Object.entries(e)) {
    for (const [id, v] of Object.entries(row)) assert(v < 3.2 * row.squirter, `${id} runs away on ${k}: ${v.toFixed(2)} vs ${row.squirter.toFixed(2)}`);
  }
});

test('new towers: same seed, same match with every new form in play (determinism)', () => {
  const play = () => {
    const g = fieldGame({ firstWave: 0.5, waveGap: 2, surprises: true });
    buildForm(g, 'brulee3', 3, -15);
    buildForm(g, 'softserve3', -5, -20);
    buildForm(g, 'rail3', 20, 0);
    buildForm(g, 'assassin3', -20, 5);
    buildForm(g, 'bullmarket3', 9, -25);
    buildForm(g, 'vault3', -9, -29);
    run(g, 60);
    let h = 0;
    for (let i = 0; i < g.cows.count; i++) h = (h * 31 + g.cows.x[i] * 1000 + g.cows.z[i] + g.cows.hp[i]) % 1e9;
    return [g.wave, g.kills, g.milk, g.money, g.cows.count, g.towers.size, h].join('|');
  };
  const a = play(), b = play();
  assert(a === b, `${a} != ${b}`);
});

test('new towers: performance with 2000 cows and 40 of them fully upgraded', () => {
  const g = fieldGame({ maxCows: 4096 });
  const forms = ['brulee3', 'softserve3', 'rail3', 'assassin3', 'bullmarket3', 'vault3', 'frother3', 'sniper3'];
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
  console.log(`      ${g.cows.count} cows, ${g.towers.size} new towers: ${perTick.toFixed(3)} ms/tick`);
  assert(perTick < 8, `tick too slow: ${perTick} ms`);
});
