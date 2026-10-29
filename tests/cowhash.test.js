// Spatial-hash targeting must pick exactly what a scan of every cow picks
// (same cow, same tie-break), or lockstep peers and replays would diverge.

import { test, assert } from './harness.js';
import { LEVELS, levelCollision } from '../src/level.js';
import { Game, defaultGameConfig } from '../src/sim/game.js';
import { COW_TYPE_LIST } from '../src/sim/cows.js';
import { pickTarget, pickBruteForce, TOWER_FORMS } from '../src/sim/towers.js';
import { stateHash } from '../src/sim/commands.js';

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

/** Every tower form on the path from its base type to `formId`. */
function pathTo(formId) {
  const out = [];
  for (let f = TOWER_FORMS[formId]; f; f = f.from ? TOWER_FORMS[f.from] : null) out.unshift(f.id);
  return out;
}

/** A busy match with every area attack: shotgun, zap aura, railgun, mortar splash, flambé. */
function areaMatch(scan) {
  const level = Object.values(LEVELS)[0]();
  const g = new Game(level, levelCollision(level), { ...defaultGameConfig(), firstWave: 0.5, waveGap: 1.5, startMoney: 1e7 });
  if (scan) {
    // The reference: every live cow, in the same order the hash returns them.
    g.cowHash.near = (cows, x, z, reach, descending = true) => {
      const all = Array.from({ length: cows.count }, (_, k) => k);
      return descending ? all.reverse() : all;
    };
  }
  const forms = ['shotgun2', 'zap2', 'rail3', 'mortar3', 'brulee3', 'flak2', 'goo2', 'softserve3'];
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2, r = 7 + (k % 4) * 5;
    const path = pathTo(forms[k % forms.length]);
    const t = g.placeTower(path[0], g.milkX + Math.cos(a) * r, g.milkZ + Math.sin(a) * r);
    if (t.ok === false) continue;
    for (const f of path.slice(1)) g.upgradeTower(t.id, f);
  }
  return g;
}

test('cowhash: area attacks (shotgun, aura, pierce, splash, flambé) play out exactly like full scans', () => {
  const a = areaMatch(false), b = areaMatch(true);
  assert(a.towers.size > 20, `only ${a.towers.size} towers placed`);
  let kills = 0;
  for (let tick = 0; tick < 64 * 60; tick++) {
    a.tick(1 / 64); b.tick(1 / 64);
    const ha = stateHash(a), hb = stateHash(b);
    assert(ha === hb, `diverged at tick ${tick} (wave ${a.wave})`);
    kills = a.kills;
    if (a.lost) break;
  }
  assert(kills > 100, `only ${kills} kills: the attacks weren't exercised`);
});
