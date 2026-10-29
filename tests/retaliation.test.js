// Cows that hit back (Headbutt Heifer, Cud Spitter), tower HP and repair, and
// the War Moo-st fog.

import { test, assert, assertClose } from './harness.js';
import { levelCollision, openField } from '../src/level.js';
import { Game, defaultGameConfig, FOG_IN, FOG_SIGHT_CUT } from '../src/sim/game.js';
import { COW_TYPES } from '../src/sim/cows.js';
import { TARGETING, REPAIR_DELAY, WRECK_REFUND, towerMaxHp, TOWER_FORMS } from '../src/sim/towers.js';

const DT = 1 / 64;

function fieldGame(over = {}) {
  const level = openField();
  const cfg = { ...defaultGameConfig(), firstWave: null, waveGap: null, startMoney: 100000, milk: 1e9, surprises: false, ...over };
  return new Game(level, levelCollision(level), cfg);
}

function put(g, id, x, z) {
  const i = g.spawnCow(COW_TYPES[id], x, z, COW_TYPES[id].hp);
  g.cows.x[i] = g.cows.px[i] = x;
  g.cows.z[i] = g.cows.pz[i] = z;
  return i;
}

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

/** Bales lining both sides of the lane a cow walks from (0,-40) to the milk. */
function balesLane(g) {
  for (let z = -36; z <= -24; z += 2) for (const x of [-3, 3]) g.placeTower('haybale', x, z);
}

test('retaliation: a Headbutt Heifer stops, winds up, bonks the tower beside it, then cools down', () => {
  const g = fieldGame();
  balesLane(g);
  const i = put(g, 'ram', 0, -40);
  const id = g.cows.id[i];
  const wind = until(g, 10, (ev) => ev.some((e) => e.kind === 'windup'));
  const w = wind.find((e) => e.kind === 'windup');
  assert(w.ram && w.id === id, 'windup event');
  const x0 = g.cows.x[0], z0 = g.cows.z[0];
  const seen = until(g, 2, (ev) => ev.some((e) => e.kind === 'bonk'));
  assert(g.cows.x[0] === x0 && g.cows.z[0] === z0, 'it walked during the wind-up');
  const bonk = seen.find((e) => e.kind === 'bonk');
  const t = g.towers.get(bonk.tower);
  assert(t === g.towers.get(w.tower), 'bonked a different tower than it wound up on');
  assert(t.hp === t.maxHp - COW_TYPES.ram.ramDamage, `bale hp ${t.hp}/${t.maxHp}`);
  // No second bonk inside the cooldown.
  let again = Infinity;
  for (let k = 0; k < 64 * 3; k++) { g.tick(DT); if (g.events.some((e) => e.kind === 'windup')) { again = (k + 1) * DT; break; } }
  assert(again >= COW_TYPES.ram.abilityCooldown - DT, `wound up again after ${again} s`);
});

test('retaliation: dents repair after a quiet spell; a tower bonked to 0 is wrecked for a partial refund', () => {
  const g = fieldGame();
  g.placeTower('haybale', 3, -30);
  const t = [...g.towers.values()][0];
  g.time = 10;
  g.damageTower(t, 50);
  for (let k = 0; k < Math.round((REPAIR_DELAY - 0.5) * 64); k++) g.tick(DT);
  assert(t.hp === t.maxHp - 50, `repaired too early: ${t.hp}`);
  for (let k = 0; k < 64 * 6; k++) g.tick(DT);
  assert(t.hp === t.maxHp, `not repaired: ${t.hp}`);

  const money = g.money, solids = g.world.solids.length;
  g.events.length = 0;
  assert(g.damageTower(t, 1e6), 'not wrecked');
  const d = g.events.find((e) => e.kind === 'destroyed');
  assert(d && d.cause === 'bonk' && d.refund === Math.floor(t.spent * WRECK_REFUND), 'destroyed event');
  assert(g.money === money + d.refund && !g.towers.has(t.id), 'refund or tower still there');
  assert(g.world.solids.length === solids - 1 && t.cells.every((c) => g.grid.tower[c] === 0), 'still on the grid');
});

test('retaliation: a tipped Heifer does nothing, and tipping it mid wind-up cancels the bonk', () => {
  const g = fieldGame();
  balesLane(g);
  put(g, 'ram', 0, -40);
  until(g, 10, (ev) => ev.some((e) => e.kind === 'windup'));
  g.tipCows(3);
  for (let k = 0; k < 64 * 2.9; k++) {
    g.tick(DT);
    assert(!g.events.some((e) => e.kind === 'bonk' || e.kind === 'windup'), 'acted while tipped');
  }
  for (const t of g.towers.values()) assert(t.hp === t.maxHp, 'a tower took a bonk');
});

test('retaliation: upgrades toughen and fully repair a tower', () => {
  const g = fieldGame();
  const t = g.placeTower('squirter', 3, -30);
  assert(t.maxHp === 60 && t.hp === 60, `squirter ${t.hp}/${t.maxHp}`);
  g.damageTower(t, 40);
  assert(g.upgradeTower(t.id, 'squirter2').ok);
  assert(t.maxHp === towerMaxHp(TOWER_FORMS.squirter2) && t.maxHp === 75 && t.hp === 75, `squirter2 ${t.hp}/${t.maxHp}`);
  assert(towerMaxHp(TOWER_FORMS.haybale2) === 250 && towerMaxHp(TOWER_FORMS.haybale) === 160, 'bale toughness');
});

test('retaliation: a Cud Spitter jams the nearest shooting tower (never a wall), and it stops firing', () => {
  const g = fieldGame();
  g.placeTower('haybale', 1, -46); // closer, but walls don't shoot: not worth spitting at
  const sq = g.placeTower('squirter', 9, -40);
  sq.stunT = 1e9; // keep it from killing the spitter before it spits
  const i = put(g, 'spitter', 0, -50);
  g.cows.hp[i] = g.cows.maxHp[i] = 1e6;
  sq.stunT = 0;
  const seen = until(g, 8, (ev) => ev.some((e) => e.kind === 'spit'));
  const spit = seen.find((e) => e.kind === 'spit');
  assert(spit.tower === sq.id, `spat at tower ${spit.tower}`);
  assertClose(sq.stunT, COW_TYPES.spitter.spitStun - DT, 1e-9, 'stun (towers tick after cows)');
  assert(sq.hp === sq.maxHp - COW_TYPES.spitter.spitDamage, 'spit damage');
  for (let k = 0; k < Math.floor((COW_TYPES.spitter.spitStun - 0.1) * 64); k++) {
    g.tick(DT);
    assert(!g.events.some((e) => e.kind === 'shot' && e.tower === sq.id), 'fired while jammed');
  }
});

test('retaliation: War Moo-st rolls in, cuts tower sight, and clears', () => {
  const g = fieldGame();
  const t = g.placeTower('squirter', 0, -30);
  const i = put(g, 'cow', 0, -30 - 12); // 12 m away: in range (14) when clear
  g.cows.vx[i] = 0;
  g.tick(DT);
  assert(g.sight === 1 && TARGETING.first(g, t) >= 0, 'sees it when clear');
  g.startFog(10);
  for (let k = 0; k < Math.round(FOG_IN * 64) + 2; k++) g.tick(DT);
  assertClose(g.fogLevel, 1, 1e-9, 'fog level');
  assertClose(g.sight, 1 - FOG_SIGHT_CUT, 1e-9, 'sight');
  g.cows.clear();
  put(g, 'cow', 0, -30 - 12);
  assert(TARGETING.first(g, t) < 0, 'saw 12 m through the fog');
  g.cows.clear();
  put(g, 'cow', 0, -30 - 8);
  assert(TARGETING.first(g, t) === 0, "couldn't see 8 m away in fog");
  for (let k = 0; k < 64 * 8; k++) g.tick(DT);
  assert(g.fogLevel === 0 && g.sight === 1 && g.fogDur === 0, 'fog never cleared');
});

test('retaliation: the War Moo-st surprise warns first, fogs, pays more and hides an ambush', () => {
  const g = fieldGame();
  for (let w = 0; w < 8; w++) g.startWave();
  for (const s of g.spawners) s.queue = 0;
  g.queueSurprise('warmoost', 0);
  const seen = [];
  let fogAtWarning = -1, maxFog = 0;
  for (let k = 0; k < 64 * 40; k++) {
    g.tick(DT);
    for (const e of g.events) if (e.kind === 'surprise' && fogAtWarning < 0) fogAtWarning = g.fogLevel;
    seen.push(...g.events);
    maxFog = Math.max(maxFog, g.fogLevel);
    if (g.fogLevel === 1) assert(g.bountyMult === 1.5, 'no bounty bonus in the fog');
  }
  assert(fogAtWarning === 0, 'fog before the warning');
  assert(maxFog === 1 && g.fogLevel === 0, 'fog never came or never cleared');
  const amb = seen.filter((e) => e.kind === 'surprise' && e.x !== undefined);
  assert(amb.length === 1, 'the hidden group has no positioned announcement (no way to hear where it is)');
});
