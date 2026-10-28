// Levels. One list of blocks per level is the single source of truth for both
// collision and rendering, so they can never disagree.

import { Aabb, CollisionWorld } from './sim/collision.js';
import { Vec3, v3 } from './sim/vec3.js';

/** What a block is for. Picks its colour in the renderer. */
export const Surface = Object.freeze({
  Floor: 'floor',
  Wall: 'wall',
  Platform: 'platform',
  Step: 'step',
  Tunnel: 'tunnel',
  Pillar: 'pillar',
  Milk: 'milk',
});

const block = (surface, min, max) => ({ surface, aabb: new Aabb(v3(...min), v3(...max)) });

export function levelCollision(level) {
  return new CollisionWorld(level.blocks.map((b) => b.aabb));
}

/**
 * Grey-box playground for tuning movement. The player spawns at the origin
 * facing -Z. Metres; floor top is y = 0.
 */
export function movementPlayground() {
  const S = Surface;
  const b = [
    // 160 m square floor with a 6 m perimeter wall.
    block(S.Floor, [-80, -1, -80], [80, 0, 80]),
    block(S.Wall, [-81, 0, -81], [81, 6, -80]),
    block(S.Wall, [-81, 0, 80], [81, 6, 81]),
    block(S.Wall, [-81, 0, -80], [-80, 6, 80]),
    block(S.Wall, [80, 0, -80], [81, 6, 80]),
    // The milk. Defend it. (Placeholder carton-shaped block behind spawn.)
    block(S.Milk, [-1.5, 0, 6], [1.5, 4.5, 9]),
  ];

  // Step-height row, left of spawn: 0.15 .. 0.6 m. Up to 0.45 is walked onto;
  // 0.6 needs a jump.
  [0.15, 0.3, 0.45, 0.6].forEach((h, i) => {
    const x = -12 - 3 * i;
    b.push(block(S.Step, [x - 1, 0, -6], [x + 1, h, -2]));
  });

  // Staircase up to a 3 m platform, right of spawn: 0.25 m risers, 0.4 m treads.
  const rise = 0.25, run = 0.4, steps = 12;
  for (let i = 0; i < steps; i++) {
    const z0 = -2 - run * i;
    b.push(block(S.Step, [8, 0, z0 - run], [11, rise * (i + 1), z0]));
  }
  const stairEnd = -2 - run * steps;
  b.push(block(S.Platform, [8, 0, stairEnd - 8], [16, 3, stairEnd]));

  // Ledges: 1.1 m clears with a plain jump (feet apex ≈ 1.22 m); 1.7 m only
  // with a crouch jump (legs tuck 0.6 m higher).
  b.push(block(S.Platform, [-6, 0, -16], [-2, 1.1, -12]));
  b.push(block(S.Platform, [2, 0, -16], [6, 1.7, -12]));

  // Crawl tunnel: 1.4 m ceiling; the standing hull is 1.8 m.
  b.push(block(S.Tunnel, [-16, 0, -20], [-15, 1.4, -10]));
  b.push(block(S.Tunnel, [-13, 0, -20], [-12, 1.4, -10]));
  b.push(block(S.Tunnel, [-16, 1.4, -20], [-12, 2.4, -10]));

  // Bunny-hop runway: pillars every 8 m along -Z give a sense of speed.
  for (let i = 0; i < 7; i++) {
    const z = -28 - 8 * i;
    for (const x of [-24, 24]) b.push(block(S.Pillar, [x - 0.5, 0, z - 0.5], [x + 0.5, 5, z + 0.5]));
  }

  return { blocks: b, spawn: Vec3.ZERO, spawnYaw: 0 };
}

/**
 * Open field for building and testing tower defence: 200 m of flat floor,
 * the milk at the centre, and a 3 m boundary wall (a crouch jump peaks
 * near 1.8 m, so nothing gets out). The player spawns 10 m south of the
 * milk, facing it.
 */
export function openField() {
  const S = Surface;
  const half = 100, wallH = 3;
  const b = [
    block(S.Floor, [-half, -1, -half], [half, 0, half]),
    block(S.Wall, [-half - 1, 0, -half - 1], [half + 1, wallH, -half]),
    block(S.Wall, [-half - 1, 0, half], [half + 1, wallH, half + 1]),
    block(S.Wall, [-half - 1, 0, -half], [-half, wallH, half]),
    block(S.Wall, [half, 0, -half], [half + 1, wallH, half]),
    block(S.Milk, [-1.5, 0, -1.5], [1.5, 4.5, 1.5]),
  ];
  return { blocks: b, spawn: v3(0, 0, 10), spawnYaw: 0, halfSize: half };
}

/** Levels by URL name: `?map=playground` opens the movement playground. */
export const LEVELS = Object.freeze({ field: openField, playground: movementPlayground });
export const DEFAULT_LEVEL = 'field';
