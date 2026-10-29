// Rust/JS parity for the nav grid. With sim.wasm built, `NavGrid` is the
// Rust-backed grid and must match `JsNavGrid` bit for bit: lockstep co-op
// replays the same ticks on every peer. Without sim.wasm both sides are JS
// and this only checks the harness.

import { test, assert } from './harness.js';
import { LEVELS } from '../src/level.js';
import { buildGrid } from '../src/sim/game.js';
import { JsNavGrid, navBackend } from '../src/sim/navgrid.js';
import { mulberry32 } from '../src/sim/rng.js';

function jsTwin(grid) {
  const js = new JsNavGrid({ minX: grid.originX, minZ: grid.originZ,
    maxX: grid.originX + grid.w * grid.cell, maxZ: grid.originZ + grid.h * grid.cell }, grid.cell);
  js.solid.set(grid.solid);
  js.goal.set(grid.goal);
  return js;
}

function sameArrays(a, b, what) {
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return `${what}[${i}]: ${a[i]} vs ${b[i]}`;
  }
  return null;
}

test(`navgrid: ${navBackend} flow field matches the JS one on every level, with random towers`, () => {
  for (const [name, make] of Object.entries(LEVELS)) {
    const grid = buildGrid(make());
    const js = jsTwin(grid);
    const rng = mulberry32(7);
    const n = grid.w * grid.h;
    for (let round = 0; round < 6; round++) {
      for (let k = 0; k < 12; k++) {
        const i = Math.floor(rng() * n);
        if (grid.solid[i] || grid.goal[i]) continue;
        const id = grid.tower[i] ? 0 : 1 + k;
        grid.tower[i] = id;
        js.tower[i] = id;
      }
      grid.rebuild();
      js.rebuild();
      const diff = sameArrays(grid.dist, js.dist, 'dist') || sameArrays(grid.next, js.next, 'next');
      assert(!diff, `${name} round ${round}: ${diff}`);
    }
  }
});

test(`navgrid: ${navBackend} placement check (reachableWith) matches the JS one`, () => {
  for (const make of Object.values(LEVELS)) {
    const grid = buildGrid(make());
    const js = jsTwin(grid);
    js.rebuild();
    const rng = mulberry32(99);
    const n = grid.w * grid.h;
    const mustReach = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(js.dist[i]) && rng() < 0.05) mustReach.push(i);
    for (let t = 0; t < 40; t++) {
      const blocked = Array.from({ length: 1 + Math.floor(rng() * 30) }, () => Math.floor(rng() * n));
      assert(grid.reachableWith(blocked, mustReach) === js.reachableWith(blocked, mustReach), `trial ${t} differs`);
    }
    assert(grid.extra.every((v) => v === 0), 'reachableWith left cells blocked');
  }
});

test(`navgrid: ${navBackend} grids stay readable after many more grids are made (WASM memory growth)`, () => {
  const first = buildGrid(Object.values(LEVELS)[0]());
  const before = Array.from(first.dist);
  for (let k = 0; k < 40; k++) buildGrid(Object.values(LEVELS)[k % Object.keys(LEVELS).length]());
  assert(first.dist.length === before.length && before.every((v, i) => Object.is(v, first.dist[i])), 'old grid lost its arrays');
  first.rebuild();
  assert(before.every((v, i) => Object.is(v, first.dist[i])), 'old grid rebuilt differently');
});
