// Spatial-hash targeting must pick exactly what a scan of every cow picks
// (same cow, same tie-break), or lockstep peers and replays would diverge.

import { test, assert } from './harness.js';
import { LEVELS, levelCollision } from '../src/level.js';
import { Game, defaultGameConfig } from '../src/sim/game.js';
import { COW_TYPE_LIST } from '../src/sim/cows.js';
import { pickTarget, pickBruteForce } from '../src/sim/towers.js';

test('cowhash: tower targeting matches a full scan through real waves on every level', () => {
  let checks = 0, hits = 0;
  for (const make of Object.values(LEVELS)) {
    const level = make();
    const g = new Game(level, levelCollision(level), { ...defaultGameConfig(), firstWave: 0.5, waveGap: 2, startMoney: 1e6 });
    // Range and ties: nearest-cell towers on a ring, plus long and short ranges.
    const kinds = ['squirter', 'mortar', 'sniper', 'frother', 'flak'];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      g.placeTower(kinds[k % kinds.length], g.milkX + Math.cos(a) * (8 + (k % 3) * 6), g.milkZ + Math.sin(a) * (8 + (k % 3) * 6));
    }
    const scores = [
      (i) => -g.cowPathDistance(i),
      (i) => -((g.cows.x[i] - 0) ** 2),
      (i) => g.cows.hp[i],
      (i) => Math.round(g.cows.hp[i] / 10), // lots of ties
      (i) => (COW_TYPE_LIST[g.cows.type[i]].altitude > 0 ? 1e6 : 0),
    ];
    for (let tick = 0; tick < 64 * 40 && !g.lost; tick++) {
      g.tick(1 / 64);
      if (tick % 16) continue;
      for (const t of g.towers.values()) {
        if (!t.def.attack) continue;
        for (const s of scores) {
          const a = pickTarget(g, t, s), b = pickBruteForce(g, t, s);
          assert(a === b, `tick ${tick} tower ${t.def.id}: hash picked ${a}, scan picked ${b}`);
          checks++; if (a >= 0) hits++;
        }
      }
    }
  }
  assert(hits > 1000, `only ${hits} of ${checks} checks had a target; the test isn't exercising anything`);
});

test('cowhash: rebuilt after kills and spawns move slots mid-tick', () => {
  const level = Object.values(LEVELS)[0]();
  const g = new Game(level, levelCollision(level), { ...defaultGameConfig(), firstWave: null, waveGap: null });
  const t = { x: g.milkX, z: g.milkZ, def: { range: 1000, minRange: 0, hitsAir: true, seesCamo: true } };
  for (let k = 0; k < 30; k++) g.spawnCow(COW_TYPE_LIST[k % 3], g.milkX + k, g.milkZ + 40);
  const s = (i) => -g.cows.id[i];
  assert(pickTarget(g, t, s) === pickBruteForce(g, t, s), 'initial');
  g.cows.remove(0);
  assert(pickTarget(g, t, s) === pickBruteForce(g, t, s), 'after a remove');
  g.spawnCow(COW_TYPE_LIST[0], g.milkX - 50, g.milkZ - 50);
  assert(pickTarget(g, t, s) === pickBruteForce(g, t, s), 'after a spawn');
});
