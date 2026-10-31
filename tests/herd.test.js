// The big herd (50+ cows from wave 3): shields, dodges, regen, burrowing,
// phasing, taunts, umbrellas, immunities, contrarians, jams, thieves,
// bodyguards, yawns, cheers, revives, mitosis, last words, blinks, eggs and
// swaps; plus targeting parity, determinism and performance with all of them.

import { test, assert, assertClose } from './harness.js';
import { levelCollision, openField } from '../src/level.js';
import { Game, defaultGameConfig } from '../src/sim/game.js';
import { TOWER_FORMS, pickTarget, pickBruteForce } from '../src/sim/towers.js';
import { COW_TYPES, COW_TYPE_LIST, cowHidden } from '../src/sim/cows.js';

const DT = 1 / 64;
const run = (g, seconds) => { for (let i = 0; i < Math.round(seconds * 64); i++) g.tick(DT); };

function fieldGame(over = {}) {
  const level = openField();
  return new Game(level, levelCollision(level), { ...defaultGameConfig(), firstWave: null, waveGap: null, startMoney: 1e7, surprises: false, ...over });
}

function put(g, id, x, z, hp = COW_TYPES[id].hp) {
  const i = g.spawnCow(COW_TYPES[id], x, z, hp);
  g.cows.x[i] = g.cows.prevX[i] = x;
  g.cows.z[i] = g.cows.prevZ[i] = z;
  return i;
}

const slotOf = (g, id) => { for (let i = 0; i < g.cows.count; i++) if (g.cows.id[i] === id) return i; return -1; };

function buildForm(g, formId, x, z) {
  const ids = [];
  for (let f = TOWER_FORMS[formId]; f; f = f.from ? TOWER_FORMS[f.from] : null) ids.unshift(f.id);
  const t = g.placeTower(ids[0], x, z);
  assert(t.id, `can't place ${ids[0]}: ${t.reason}`);
  for (const id of ids.slice(1)) assert(g.upgradeTower(t.id, id).ok, `upgrade to ${id}`);
  return t;
}

const HERD = COW_TYPE_LIST.slice(COW_TYPE_LIST.findIndex((t) => t.id === 'tiny'));

test('herd: 54 new wave cows (plus 2 hatchlings), each with a name, a blurb and a debut wave', () => {
  const wave = HERD.filter((t) => t.weight > 0);
  assert(wave.length === 54 && HERD.length === 56, `${wave.length} wave cows, ${HERD.length} total`);
  for (const t of wave) assert(t.name !== t.id && t.blurb.length > 10 && t.firstWave >= 3 && t.firstWave <= 30, `${t.id}: incomplete`);
  assert(new Set(HERD.map((t) => t.color)).size > 40, 'too many lookalikes');
});

test('herd: Bubble Wrap shield soaks damage first and pops; Matrix dodges every 3rd hit', () => {
  const g = fieldGame();
  const i = put(g, 'bubble', 0, -60);
  g.damageCow(i, 20, null);
  assert(g.cows.hp[i] === COW_TYPES.bubble.hp && g.cows.shieldHp[i] === 10, 'shield did not soak');
  g.damageCow(i, 15, null);
  assert(g.cows.shieldHp[i] === 0 && g.cows.hp[i] === COW_TYPES.bubble.hp - 5 && g.events.some((e) => e.kind === 'pop'), 'shield did not pop');
  const k = put(g, 'matrix', 0, -60);
  for (let n = 0; n < 3; n++) g.damageCow(k, 5, null);
  assert(g.cows.hp[k] === COW_TYPES.matrix.hp - 10, `matrix hp ${g.cows.hp[k]}`);
  // Damage over time never counts as a hit to dodge.
  g.damageCow(k, 5, null, false); g.damageCow(k, 5, null, false); g.damageCow(k, 5, null, false);
  assert(g.cows.hp[k] === COW_TYPES.matrix.hp - 25, 'dodged a burn');
});

test('herd: Yoga regen, Vampire burns double, Lava Lamp and Polar shrug off fire and frost', () => {
  const g = fieldGame();
  const i = put(g, 'yoga', 0, -60);
  g.cows.hp[i] = 10;
  run(g, 1);
  assertClose(g.cows.hp[i], 10 + 0.04 * COW_TYPES.yoga.hp, 0.05);
  const v = put(g, 'vampire', 10, -60, 1000), c = put(g, 'cow', 20, -60, 1000);
  g.cows.hp[v] = g.cows.hp[c] = 500;
  g.igniteCow(v, 10, 1, 0, 0); g.igniteCow(c, 10, 1, 0, 0);
  run(g, 1);
  const lostV = 500 - g.cows.hp[slotOf(g, g.cows.id[v])], lostC = 500 - g.cows.hp[c];
  assertClose(lostV + COW_TYPES.vampire.regen * 1000, 2 * lostC, 0.5, "vampire burn (net of her regen)");
  const f = put(g, 'fireproof', 0, -50), p = put(g, 'polar', 5, -50);
  g.igniteCow(f, 10, 5, 0, 0); g.chillCow(p, 1.5, 5);
  assert(g.cows.burnTime[f] === 0 && g.cows.chillTime[p] === 0, 'immunity failed');
});

test('herd: Mole Cow underground takes no damage and is never targeted; Chameleon is untargetable but splashable', () => {
  const g = fieldGame();
  const t = buildForm(g, 'squirter', 31, 31);
  const i = put(g, 'mole', t.x - 6, t.z, 1e6);
  while (!cowHidden(COW_TYPES.mole, g.cows.id[i], g.time, true)) g.time += DT;
  assert(!g.damageCow(i, 100, null) && g.cows.hp[i] === 1e6, 'hurt underground');
  assert(pickTarget(g, t, (k) => -g.cowPathDistance(k)) === -1, 'targeted underground');
  while (cowHidden(COW_TYPES.mole, g.cows.id[i], g.time, true)) g.time += DT;
  assert(pickTarget(g, t, (k) => -g.cowPathDistance(k)) === i, 'not targeted above ground');
  const k = put(g, 'chameleon', t.x - 6, t.z + 1, 1e6);
  while (!cowHidden(COW_TYPES.chameleon, g.cows.id[k], g.time) || cowHidden(COW_TYPES.mole, g.cows.id[i], g.time, true) === false) g.time += DT;
  assert(pickTarget(g, t, (n) => (n === k ? 1 : 0)) !== k, 'targeted a faded chameleon');
  g.splash(g.cows.x[k], g.cows.z[k], 1, 10, null);
  assert(g.cows.hp[k] < 1e6, 'splash missed the chameleon');
});

test('herd: Rodeo Clown taunts every tower that sees it; Umbrella Cow ignores shells', () => {
  const g = fieldGame();
  const t = buildForm(g, 'squirter', 31, 31);
  put(g, 'cow', t.x - 6, t.z - 6, 1e6); // nearer the milk
  const c = put(g, 'clown', t.x + 6, t.z + 6, 1e6);
  assert(pickTarget(g, t, (k) => -g.cowPathDistance(k)) === c && pickBruteForce(g, t, (k) => -g.cowPathDistance(k)) === c, 'clown ignored');
  const u = put(g, 'umbrella', 0, -60, 100), n = put(g, 'cow', 1, -60, 100);
  g.splash(0.5, -60, 3, 20, null);
  assert(g.cows.hp[u] === 100 && g.cows.hp[n] === 80, 'umbrella got splashed');
});

test('herd: Contrarian speeds up when slowed; Disco jams the shooter every 4th hit', () => {
  const g = fieldGame();
  const i = put(g, 'contrarian', 0, -60);
  g.slowCow(i, 0.5, 2);
  assert(g.cows.slowTime[i] === 0 && g.cows.hasteMult[i] === 2 && g.cows.hasteT[i] === 2, 'contrarian slowed');
  const t = buildForm(g, 'squirter', 31, 31);
  const d = put(g, 'disco', 0, -50, 1e6);
  for (let n = 0; n < 3; n++) g.damageCow(d, 1, t);
  assert(t.stunT === 0, 'jammed early');
  g.damageCow(d, 1, t);
  assert(t.stunT === COW_TYPES.disco.jamEvery.time, 'not jammed');
});

test('herd: Tax Collector takes moolah at the milk (never below 0)', () => {
  const g = fieldGame({ startMoney: 10 });
  put(g, 'taxman', 0, 3);
  run(g, 3);
  assert(g.money === 0 && g.cows.count === 0, `money ${g.money}`);
});

test('herd: Bodyguard halves damage near him; Sleepy yawns slow towers; Cheerleader hastes the herd', () => {
  const g = fieldGame();
  const t = buildForm(g, 'squirter', 31, 31);
  put(g, 'bodyguard', 0, -60, 1e6);
  const c = put(g, 'cow', 1, -60, 1000), far = put(g, 'cow', 0, -40, 1000);
  put(g, 'sleepy', t.x + 2, t.z + 2, 1e6);
  const h = put(g, 'cheer', -20, -60, 1e6), fan = put(g, 'cow', -21, -60, 1000);
  g.tick(DT);
  g.damageCow(c, 10, null); g.damageCow(far, 10, null);
  assert(g.cows.hp[c] === 995 && g.cows.hp[far] === 990, `guard ${g.cows.hp[c]} ${g.cows.hp[far]}`);
  assertClose(t.boost, 0.65, 1e-9);
  run(g, 0.6);
  assert(g.cows.hasteMult[fan] === 1.35 && g.cows.hasteMult[h] === 1, 'cheer');
});

test('herd: Phoenix gets back up once; Mitosis splits once past half health', () => {
  const g = fieldGame();
  const i = put(g, 'phoenix', 0, -60, 100);
  const id = g.cows.id[i];
  assert(!g.damageCow(i, 500, null) && g.cows.hp[i] === 50 && g.kills === 0, 'no revive');
  assert(g.damageCow(i, 500, null) && slotOf(g, id) < 0 && g.kills === 1, 'revived twice');
  const m = put(g, 'mitosis', 0, -50, 100);
  const n0 = g.cows.count;
  g.damageCow(m, 30, null);
  assert(g.cows.count === n0, 'split too soon');
  g.damageCow(m, 30, null);
  assert(g.cows.count === n0 + 1 && g.cows.hp[g.cows.count - 1] === 40, 'no split');
  g.damageCow(m, 30, null);
  assert(g.cows.count === n0 + 1, 'split twice');
});

test('herd: last words: Magnet jams, Cactus spikes, Paramedic heals, Drama hastes', () => {
  const g = fieldGame();
  const t = buildForm(g, 'squirter', 31, 31);
  const hp0 = t.hp;
  g.damageCow(put(g, 'magnet', t.x + 2, t.z, 1), 10, null);
  assert(t.stunT === 2, 'no EMP');
  g.damageCow(put(g, 'cactus', t.x + 2, t.z, 1), 10, null);
  assert(t.hp === hp0 - 35, `spikes ${t.hp}`);
  const c = put(g, 'cow', 0, -60, 100);
  g.cows.hp[c] = 10;
  g.damageCow(put(g, 'medic', 1, -60, 1), 10, null);
  assert(g.cows.hp[slotOf(g, g.cows.id[c])] === 50, 'no heal');
  const d = put(g, 'cow', 0, -40, 100);
  g.damageCow(put(g, 'drama', 1, -40, 1), 10, null);
  assert(g.cows.hasteMult[d] === 1.6, 'no grief stampede');
});

test('herd: Quantum blinks along its path, Chicken lays, Prankster swaps with the leader', () => {
  const g = fieldGame();
  const q = put(g, 'quantum', 0, -60);
  const qid = g.cows.id[q];
  const d0 = g.cowPathDistance(q);
  let blinked = false;
  for (let k = 0; k < 64 * 2; k++) { g.tick(DT); blinked ||= g.events.some((e) => e.kind === 'blink' && e.id === qid); }
  assert(blinked && d0 - g.cowPathDistance(slotOf(g, qid)) > 3 * g.grid.cell, 'no blink');
  put(g, 'chicken', 40, -60);
  run(g, 1.3);
  assert([...Array(g.cows.count).keys()].some((k) => COW_TYPE_LIST[g.cows.type[k]].id === 'chick'), 'no chick');
  const g2 = fieldGame();
  const p = put(g2, 'prankster', 0, -80), lead = put(g2, 'cow', 0, -20);
  const pid = g2.cows.id[p], lid = g2.cows.id[lead];
  run(g2, 3.1);
  const zp = g2.cows.z[slotOf(g2, pid)], zl = g2.cows.z[slotOf(g2, lid)];
  assert(zp > -30 && zl < -60, `no swap ${zp} ${zl}`);
});

test('herd: Dizzy weaves but stays on the field; Parkour walks straight through a maze', () => {
  const g = fieldGame();
  const i = put(g, 'dizzy', 0, -60);
  const id = g.cows.id[i];
  let side = 0;
  for (let k = 0; k < 64 * 4; k++) {
    g.tick(DT);
    const s = slotOf(g, id);
    side = Math.max(side, Math.abs(g.cows.x[s]));
    assert(g.grid.walkable(g.grid.cellAt(g.cows.x[s], g.cows.z[s])), 'wandered off');
  }
  assert(side > 0.3, `no weave ${side}`);
  const g2 = fieldGame();
  for (let x = -20; x <= 20; x += 2) g2.placeTower('haybale', x, -30);
  const p = put(g2, 'parkour', 0, -60), c = put(g2, 'cow', 1, -60);
  const pid = g2.cows.id[p], cid = g2.cows.id[c];
  run(g2, 8);
  const sp = slotOf(g2, pid), sc = slotOf(g2, cid);
  assert(sp < 0 || Math.abs(g2.cows.x[sp]) < 2, 'parkour detoured');
  assert(sc >= 0 && Math.abs(g2.cows.x[sc]) > 5, 'the plain cow should have gone round');
});

/** A late-game match with every herd cow in play, towers of every kind and surprises on. */
function herdMatch(seed, checkParity = false) {
  const g = fieldGame({ firstWave: 0.5, waveGap: 3, surprises: true, seed });
  ['chocogat4', 'buckshot4', 'cluster4', 'xbutter4', 'rod4', 'scarecrow4', 'chili4', 'sundae4', 'plasma4', 'bounty4', 'rodeo4', 'printer4']
    .forEach((id, n) => buildForm(g, id, -44 + n * 8, n % 2 ? -20 : 20));
  g.wave = 29;
  let bad = 0;
  for (let k = 0; k < 64 * 30; k++) {
    g.tick(DT);
    if (checkParity && k % 4 === 0) {
      for (const t of g.towers.values()) {
        if (!t.def.attack) continue;
        const score = (i) => -g.cowPathDistance(i);
        if (pickTarget(g, t, score) !== pickBruteForce(g, t, score)) bad++;
      }
    }
  }
  let h = 0;
  for (let i = 0; i < g.cows.count; i++) h = (h * 31 + g.cows.x[i] * 1000 + g.cows.z[i] + g.cows.type[i]) % 1e9;
  return { key: [g.wave, g.kills, g.milk, g.money, g.cows.count, g.towers.size, h].join('|'), bad, g };
}

test('herd: spatial-hash targeting matches a full scan with burrows, phases and taunts about', () => {
  const { bad, g } = herdMatch(7, true);
  assert(bad === 0, `${bad} mismatched picks`);
  assert(g.kills > 50, `only ${g.kills} kills: did the herd show up?`);
});

test('herd: same seed, same match with the whole herd in play (determinism)', () => {
  const a = herdMatch(11).key, b = herdMatch(11).key;
  assert(a === b, `${a} != ${b}`);
});

test('herd: performance with 2000 herd cows of every kind', () => {
  const g = fieldGame();
  for (let n = 0; n < 24; n++) buildForm(g, ['chocogat4', 'cluster4', 'rod4', 'chili4', 'plasma4', 'scarecrow4'][n % 6], -46 + (n % 12) * 8, n < 12 ? -24 : 24);
  const wave = HERD.filter((t) => t.weight > 0);
  for (let n = 0; n < 2000; n++) put(g, wave[n % wave.length].id, -60 + (n % 50) * 2.4, -80 + Math.floor(n / 50) * 0.5, 1e9);
  run(g, 0.5);
  const t0 = performance.now();
  for (let k = 0; k < 64; k++) g.tick(DT);
  const ms = (performance.now() - t0) / 64;
  console.log(`      2000 herd cows, 24 Lv10 towers: ${ms.toFixed(3)} ms/tick`);
  assert(ms < 5, `too slow: ${ms.toFixed(2)} ms/tick`);
});
