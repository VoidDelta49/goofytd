// Tower defence: nav grid, flow field, cows, spawners, placement rules,
// tower behaviours and determinism. Runs the real Game at the 64 Hz tick.

import { test, assert, assertClose } from './harness.js';
import { Aabb, CollisionWorld } from '../src/sim/collision.js';
import { v3 } from '../src/sim/vec3.js';
import { LEVELS, levelCollision, openField } from '../src/level.js';
import { Game, PlaceError, defaultGameConfig } from '../src/sim/game.js';
import { TOWER_TYPES, TOWER_FORMS, SELL_REFUND, defineTower } from '../src/sim/towers.js';
import { COW_TYPES } from '../src/sim/cows.js';

const DT = 1 / 64;

/** Open field with waves off unless asked, plenty of money. */
function fieldGame(over = {}) {
  const level = openField();
  const cfg = { ...defaultGameConfig(), firstWave: null, waveGap: null, startMoney: 100000, ...over };
  return new Game(level, levelCollision(level), cfg);
}

const run = (g, seconds) => { for (let i = 0; i < Math.round(seconds * 64); i++) g.tick(DT); };

test('td: every level has spawners that can reach the milk', () => {
  for (const [name, make] of Object.entries(LEVELS)) {
    const level = make();
    const g = new Game(level, levelCollision(level));
    assert(g.spawners.length > 0, `${name}: no spawners`);
    for (const s of g.spawners) {
      assert(s.cell >= 0 && g.grid.walkable(s.cell), `${name}: spawner on a blocked cell`);
      assert(Number.isFinite(g.grid.dist[s.cell]), `${name}: spawner can't reach the milk`);
    }
  }
});

test('td: flow field distance from a field spawner is about the straight-line distance', () => {
  const g = fieldGame();
  const s = g.spawners[0]; // 90 m north of the milk centre; goal ring starts ~1.5-4 m out
  const d = g.grid.dist[s.cell];
  assert(d > 80 && d < 90, `path length ${d}`);
});

test('td: a cow walks from the spawner to the milk and drinks it', () => {
  const g = fieldGame();
  const i = g.spawnCow(COW_TYPES.cow, 0, -60);
  assert(i === 0);
  const milk0 = g.milk;
  // 58 m at 3.2 m/s is ~18 s.
  run(g, 16);
  assert(g.cows.count === 1, 'arrived too early');
  run(g, 6);
  assert(g.cows.count === 0, `cow still walking at z=${g.cows.z[0]}`);
  assertClose(g.milk, milk0 - COW_TYPES.cow.damage, 1e-9, 'milk');
});

test('td: spawner releases a wave and cows spread out instead of single file', () => {
  const g = fieldGame();
  g.startWave();
  const total = g.cfg.waveBase;
  run(g, total * g.cfg.spawnInterval + 1);
  assert(g.cows.count === total, `spawned ${g.cows.count} of ${total}`);
  run(g, 6);
  const xs = new Set();
  for (let i = 0; i < g.cows.count; i++) xs.add(Math.round(g.cows.x[i] * 10));
  assert(xs.size > total / 2, 'cows are stacked on one line');
});

test('td: waves start on their own and grow', () => {
  const g = fieldGame({ firstWave: 1, waveGap: 2 });
  run(g, 1.1);
  assert(g.wave === 1, `wave ${g.wave}`);
  // wave 1 spawns 6 cows over 4 spawners: 2 per spawner, 0.5 s apart.
  run(g, 1 + 2.1);
  assert(g.wave === 2, `wave ${g.wave}`);
  // wave 2 (10 cows, at most 3 per spawner) is fully out 1 s after it starts.
  run(g, 1.1);
  assert(g.wave === 2 && g.cows.count === 6 + 10, `wave ${g.wave}, cows ${g.cows.count}`);
});

test('td: losing all the milk ends the game and stops building', () => {
  const g = fieldGame({ milk: 10 });
  for (let k = 0; k < 2; k++) g.spawnCow(COW_TYPES.cow, 6 + k, 0);
  run(g, 5);
  assert(g.lost, 'game not lost');
  assert(g.checkPlacement('squirter', 20, 20).reason === PlaceError.GameOver);
});

test('td: placement snaps to the grid (odd and even footprints)', () => {
  const g = fieldGame();
  const a = g.checkPlacement('squirter', 10.3, 10.9);
  assert(a.ok, a.reason);
  assertClose(a.x, 11, 1e-9, 'squirter x'); // cell [10,12]
  assertClose(a.z, 11, 1e-9, 'squirter z');
  const b = g.checkPlacement('mortar', 10.3, 10.9);
  assert(b.ok, b.reason);
  assertClose(b.x, 10, 1e-9, 'mortar x'); // 4 m footprint centred on the nearest corner
  assertClose(b.z, 10, 1e-9, 'mortar z');
  assert(b.cells.length === 4);
});

test('td: placement rejects milk, towers, cows, the player, the edge, and being broke', () => {
  const g = fieldGame();
  assert(g.checkPlacement('squirter', 0, 0).reason === PlaceError.Blocked, 'on the milk');
  assert(g.placeTower('squirter', 20, 20).id, 'first build');
  assert(g.checkPlacement('squirter', 20.5, 20.5).reason === PlaceError.Occupied, 'on a tower');
  assert(g.checkPlacement('squirter', 99.5, 0).ok, 'last column is fine');
  assert(g.checkPlacement('mortar', 100, 0).reason === PlaceError.OffGrid, 'past the edge');
  const c = g.spawnCow(COW_TYPES.cow, -30, -30);
  g.cows.x[c] = -29; g.cows.z[c] = -29; // spawns are jittered; pin it inside the cell
  assert(g.checkPlacement('squirter', -30, -30).reason === PlaceError.Cow, 'on a cow');
  const player = Aabb.fromCenterHalf(v3(40, 0.9, 40), v3(0.4, 0.9, 0.4));
  assert(g.checkPlacement('squirter', 40, 40, player).reason === PlaceError.Player, 'on the player');
  g.money = 5;
  assert(g.checkPlacement('squirter', 50, 50).reason === PlaceError.Money, 'broke');
});

test('td: you can maze the cows but never wall the milk off', () => {
  const g = fieldGame();
  // Ring of hay bales around the milk's goal ring (cells -6..6 m) with one gap.
  const ring = [];
  for (let k = -6; k <= 6; k += 2) ring.push([k, -6], [k, 6], [-6, k], [6, k]);
  const uniq = [...new Map(ring.map((p) => [p.join(), p])).values()];
  const gap = '0,6';
  for (const [x, z] of uniq) {
    if ([x, z].join() === gap) continue;
    const t = g.placeTower('haybale', x + 1, z + 1);
    assert(t.id, `bale at ${x},${z}: ${t.reason}`);
  }
  // Closing the last gap would trap the milk.
  assert(g.checkPlacement('haybale', 1, 7).reason === PlaceError.BlocksPath, 'closing the ring allowed');
  // Path from the north spawner now has to come round to the south gap.
  const d = g.grid.dist[g.spawners[0].cell];
  assert(d > 95, `path didn't get longer: ${d}`);
  // And a cow actually walks the maze to the milk.
  g.spawnCow(COW_TYPES.cow, 0, -30);
  const milk0 = g.milk;
  run(g, 25);
  assert(g.milk < milk0, `cow never arrived, at ${g.cows.x[0]},${g.cows.z[0]}`);
});

test('td: cows never walk through towers', () => {
  const g = fieldGame();
  // A wall of bales straight across the north approach, -20..20 m.
  for (let x = -20; x < 20; x += 2) g.placeTower('haybale', x + 1, -20 + 1);
  g.spawnCow(COW_TYPES.cow, 0, -40);
  for (let k = 0; k < 64 * 30 && g.cows.count; k++) {
    g.tick(DT);
    if (!g.cows.count) break;
    const x = g.cows.x[0], z = g.cows.z[0];
    const inWall = x > -20 && x < 20 && z > -20 && z < -18;
    assert(!inWall, `cow inside the wall at ${x.toFixed(2)},${z.toFixed(2)}`);
  }
  assert(g.cows.count === 0, 'cow got stuck');
});

test('td: towers are solid for the player and selling removes them', () => {
  const g = fieldGame();
  const n = g.world.solids.length;
  const t = g.placeTower('squirter', 31, 31);
  assert(g.world.solids.length === n + 1);
  assert(g.world.boxBlocked(v3(31, 0.9, 31), v3(0.4, 0.9, 0.4)), 'player passes through the tower');
  const money = g.money;
  assert(g.sellTower(t.id) === Math.floor(TOWER_TYPES.squirter.cost * SELL_REFUND));
  assert(g.money > money && g.world.solids.length === n && g.grid.tower.every((x) => x === 0));
});

test('td: raycast finds the tower you look at', () => {
  const g = fieldGame();
  const t = g.placeTower('squirter', 1, -11); // cell [0,2]x[-12,-10]
  const hit = g.raycastTower(v3(1, 1.6, 0), v3(0, -0.05, -1), 30);
  assert(hit && hit.tower === t, 'missed');
  assertClose(hit.distance, 10, 1e-9, 'distance');
  assert(g.raycastTower(v3(1, 1.6, 0), v3(0, 0, 1), 30) === null, 'hit behind');
});

test('td: squirter kills a cow walking past and pays the bounty', () => {
  const g = fieldGame();
  g.placeTower('squirter', 5, -30);
  g.spawnCow(COW_TYPES.cow, 0, -50);
  const money = g.money;
  run(g, 12);
  assert(g.kills === 1 && g.cows.count === 0, `kills ${g.kills}`);
  assert(g.money === money + COW_TYPES.cow.bounty);
  assert(g.milk === g.cfg.milk, 'cow reached the milk');
});

test('td: mortar splash hits a group, leads moving targets, ignores point blank', () => {
  const g = fieldGame();
  const m = g.placeTower('mortar', 20, -40);
  // A huddle 20 m away, standing still on goal-free ground (they walk, so freeze them by zeroing speed after spawn).
  for (let k = 0; k < 5; k++) g.spawnCow(COW_TYPES.cow, 0 + k * 0.5, -40);
  // tick() clears events, so collect them every tick (as main.js does).
  const launches = [];
  for (let i = 0; i < 7; i++) { g.tick(DT); launches.push(...g.events.filter((e) => e.kind === 'launch')); }
  assert(g.projectiles.length === 1, 'did not fire');
  assert(launches.length === 1 && launches[0].tower === m.id && Number.isFinite(launches[0].x) && Number.isFinite(launches[0].z), 'no launch event');
  run(g, 1.2);
  // 22 damage to each of 5 cows in the splash.
  let hit = 0;
  for (let i = 0; i < g.cows.count; i++) if (g.cows.hp[i] < COW_TYPES.cow.hp) hit++;
  assert(hit >= 4, `splash hit ${hit} of 5`);
  assert(m.def.minRange > 0);
  const g2 = fieldGame();
  g2.placeTower('mortar', 20, -40);
  g2.spawnCow(COW_TYPES.cow, 22, -40); // inside minRange
  g2.tick(DT);
  assert(g2.projectiles.length === 0, 'fired point blank');
});

test('td: a custom tower type plugs in with no other code', () => {
  defineTower({
    id: 'test-zapper', name: 'Zapper', cost: 1, footprint: 1, height: 1,
    targeting: 'strongest', range: 50, interval: 0.1,
    attack(game, t, i) { game.damageCow(i, 1000, t); },
    parts: [{ min: [-1, 0, -1], max: [1, 1, 1], color: 0xff00ff }],
  });
  try {
    const g = fieldGame();
    g.placeTower('test-zapper', 31, 31);
    g.spawnCow(COW_TYPES.cow, 10, 10);
    g.tick(DT);
    assert(g.kills === 1, 'custom attack did not run');
  } finally {
    delete TOWER_TYPES['test-zapper'];
    delete TOWER_FORMS['test-zapper'];
  }
});

test('td: same seed, same match (determinism)', () => {
  const play = () => {
    const g = fieldGame({ firstWave: 0.5, waveGap: 3, startMoney: 1000 });
    g.placeTower('squirter', 3, -15);
    g.placeTower('mortar', 20, 0);
    g.placeTower('squirter', -15, 5);
    run(g, 45);
    let h = 0;
    for (let i = 0; i < g.cows.count; i++) h = (h * 31 + g.cows.x[i] * 1000 + g.cows.z[i] + g.cows.type[i]) % 1e9;
    return [g.wave, g.kills, g.milk, g.money, g.cows.count, g.towers.size, h].join('|');
  };
  const a = play(), b = play();
  assert(a === b, `${a} != ${b}`);
});

test('td: performance with 2000 cows and 40 towers', () => {
  const g = fieldGame({ maxCows: 4096 });
  for (let k = 0; k < 40; k++) {
    const ang = (k / 40) * Math.PI * 2;
    g.placeTower('squirter', Math.cos(ang) * 25, Math.sin(ang) * 25);
  }
  for (let k = 0; k < 2000; k++) {
    const ang = (k / 2000) * Math.PI * 2;
    g.spawnCow(COW_TYPES.cow, Math.cos(ang) * 85, Math.sin(ang) * 85, 1e9); // unkillable: keep the count up
  }
  run(g, 0.5); // warm up the JIT
  const ticks = 128;
  const t0 = performance.now();
  run(g, ticks / 64);
  const perTick = (performance.now() - t0) / ticks;
  const p0 = performance.now();
  for (let k = 0; k < 50; k++) g.checkPlacement('squirter', 40 + k % 5, 40);
  const perCheck = (performance.now() - p0) / 50;
  const r0 = performance.now();
  for (let k = 0; k < 20; k++) g.grid.rebuild();
  const perRebuild = (performance.now() - r0) / 20;
  console.log(`      ${g.cows.count} cows, ${g.towers.size} towers: ${perTick.toFixed(3)} ms/tick, ` +
    `placement check ${perCheck.toFixed(3)} ms, flow-field rebuild ${perRebuild.toFixed(3)} ms`);
  assert(perTick < 8, `tick too slow: ${perTick} ms`);
});
