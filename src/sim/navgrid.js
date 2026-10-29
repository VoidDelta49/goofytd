// Ground navigation grid for cows: which cells are walkable, where towers
// stand, and a flow field (distance to the milk) that every cow shares.
//
// One flow field for all cows is what keeps thousands of cows cheap: pathing
// costs one Dijkstra over the grid when a tower is placed or sold, and then
// each cow per tick is one array lookup. Pure: no three.js, no DOM.
//
// `rebuild` and `reachableWith` also exist in Rust (sim-rs/src/navgrid.rs).
// When sim.wasm is built, NavGrid is the WASM-backed grid: the same arrays,
// but living in WASM memory. Both versions must give bit-identical results.

import { wasm } from './wasm/sim-wasm.js';

const SQRT2 = Math.SQRT2;
// 8 neighbours: dx, dz, step cost. Orthogonals first.
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

/** Tall enough to stop a cow: blocks below this height are stepped over. */
const BLOCK_MIN_HEIGHT = 0.05;
/** Cows are about this tall: geometry whose bottom is above it (a high bridge) doesn't block them. */
const COW_HEIGHT = 2;

export class JsNavGrid {
  /**
   * @param {{minX:number,minZ:number,maxX:number,maxZ:number}} bounds walkable floor area
   * @param {number} cell cell size in metres
   */
  constructor(bounds, cell) {
    this.cell = cell;
    this.originX = bounds.minX;
    this.originZ = bounds.minZ;
    this.w = Math.floor((bounds.maxX - bounds.minX) / cell);
    this.h = Math.floor((bounds.maxZ - bounds.minZ) / cell);
    /** Bumped whenever walkability changes; lets callers cache placement checks. */
    this.version = 0;
    this.alloc(this.w * this.h);
  }

  alloc(n) {
    /** 1 = static level geometry (milk included). */
    this.solid = new Uint8Array(n);
    /** Tower id occupying the cell, or 0. */
    this.tower = new Int32Array(n);
    /** 1 = cows standing here are at the milk. */
    this.goal = new Uint8Array(n);
    /** Path distance to the nearest goal cell in metres; Infinity = unreachable or blocked. */
    this.dist = new Float64Array(n).fill(Infinity);
    /** Neighbour to walk to next, or -1 (goal, blocked or unreachable). */
    this.next = new Int32Array(n).fill(-1);
    this.heap = new MinHeap(n);
    this.queue = new Int32Array(n);
    this.seen = new Uint8Array(n);
    /** Scratch mask of extra blocked cells; all zero outside reachableWith(). */
    this.extra = new Uint8Array(n);
  }

  index(cx, cz) { return cz * this.w + cx; }
  inBounds(cx, cz) { return cx >= 0 && cz >= 0 && cx < this.w && cz < this.h; }
  cellX(x) { return Math.floor((x - this.originX) / this.cell); }
  cellZ(z) { return Math.floor((z - this.originZ) / this.cell); }
  /** Cell index under a world point, or -1 off the grid. */
  cellAt(x, z) {
    const cx = this.cellX(x), cz = this.cellZ(z);
    return this.inBounds(cx, cz) ? this.index(cx, cz) : -1;
  }
  centerX(i) { return this.originX + ((i % this.w) + 0.5) * this.cell; }
  centerZ(i) { return this.originZ + (Math.floor(i / this.w) + 0.5) * this.cell; }
  walkable(i) { return this.solid[i] === 0 && this.tower[i] === 0; }

  /** Mark every cell overlapped (in XZ, strictly) by a box that stands in a cow's way. */
  markSolid(aabb) {
    if (aabb.max.y <= BLOCK_MIN_HEIGHT || aabb.min.y >= COW_HEIGHT) return;
    this.forCellsOverlapping(aabb, (i) => { this.solid[i] = 1; });
  }

  /** Cells next to `aabb` (8-neighbourhood) that cows can stand on become goal cells. */
  markGoalAround(aabb) {
    const inside = [];
    this.forCellsOverlapping(aabb, (i) => inside.push(i));
    for (const i of inside) {
      const cx = i % this.w, cz = Math.floor(i / this.w);
      for (const [dx, dz] of NEIGHBOURS) {
        const nx = cx + dx, nz = cz + dz;
        if (!this.inBounds(nx, nz)) continue;
        const j = this.index(nx, nz);
        if (this.solid[j] === 0) this.goal[j] = 1;
      }
    }
  }

  forCellsOverlapping(aabb, fn) {
    const e = 1e-6;
    const x0 = Math.max(0, this.cellX(aabb.min.x + e)), x1 = Math.min(this.w - 1, this.cellX(aabb.max.x - e));
    const z0 = Math.max(0, this.cellZ(aabb.min.z + e)), z1 = Math.min(this.h - 1, this.cellZ(aabb.max.z - e));
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) fn(this.index(cx, cz));
  }

  /**
   * Can a cow step from cell (cx,cz) to (cx+dx,cz+dz)? Diagonals need both
   * orthogonal cells open, so cows never clip a tower's corner. Cells marked
   * in `this.extra` count as blocked too (placement previews). Hot path:
   * called 8x per cell per rebuild, so no closures or allocation.
   */
  canStep(cx, cz, dx, dz) {
    const nx = cx + dx, nz = cz + dz;
    if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) return false;
    const w = this.w;
    if (!this.open(nz * w + nx)) return false;
    if (dx !== 0 && dz !== 0) return this.open(cz * w + nx) && this.open(nz * w + cx);
    return true;
  }

  open(i) { return this.solid[i] === 0 && this.tower[i] === 0 && this.extra[i] === 0; }

  /** Rebuild the flow field: Dijkstra outward from every goal cell. */
  rebuild() {
    const { dist, next, heap, w } = this;
    dist.fill(Infinity);
    next.fill(-1);
    heap.clear();
    for (let i = 0; i < dist.length; i++) {
      if (this.goal[i] && this.walkable(i)) { dist[i] = 0; heap.push(i, 0); }
    }
    while (heap.size > 0) {
      const d = heap.topKey();
      const i = heap.pop();
      if (d > dist[i]) continue; // stale entry
      const cx = i % w, cz = (i - cx) / w;
      for (let k = 0; k < 8; k++) {
        const dx = NEIGHBOURS[k][0], dz = NEIGHBOURS[k][1], cost = NEIGHBOURS[k][2];
        // Moving i -> j along the field means walking j -> i, the same step reversed.
        if (!this.canStep(cx, cz, dx, dz)) continue;
        const j = i + dz * w + dx;
        const nd = d + cost * this.cell;
        if (nd < dist[j]) {
          dist[j] = nd;
          next[j] = i;
          heap.push(j, nd);
        }
      }
    }
    this.version++;
  }

  /**
   * True if every cell in `mustReach` can still walk to a goal with the cells
   * in `blocked` (an array of indices) closed. Breadth-first, no distances:
   * this runs every frame for the placement preview, so it only answers yes/no.
   */
  reachableWith(blocked, mustReach) {
    const { queue, seen, extra, w } = this;
    for (const i of blocked) extra[i] = 1;
    seen.fill(0);
    let head = 0, tail = 0;
    for (let i = 0; i < seen.length; i++) {
      if (this.goal[i] && this.open(i)) { seen[i] = 1; queue[tail++] = i; }
    }
    while (head < tail) {
      const i = queue[head++];
      const cx = i % w, cz = (i - cx) / w;
      for (let k = 0; k < 8; k++) {
        const dx = NEIGHBOURS[k][0], dz = NEIGHBOURS[k][1];
        if (!this.canStep(cx, cz, dx, dz)) continue;
        const j = i + dz * w + dx;
        if (!seen[j]) { seen[j] = 1; queue[tail++] = j; }
      }
    }
    for (const i of blocked) extra[i] = 0;
    for (const i of mustReach) if (!seen[i]) return false;
    return true;
  }
}

/**
 * Same grid, arrays in WASM memory, rebuild/flood in Rust. The arrays are
 * plain properties (typed-array views), as fast to read as the JS grid's.
 * WASM memory only grows when a grid is allocated, and growing detaches
 * every old view, so each allocation re-points all live grids' views.
 */
class WasmNavGrid extends JsNavGrid {
  alloc() {
    this.ptr = wasm.nav_new(this.w, this.h, this.cell);
    freeGrid.register(this, this.ptr);
    liveGrids.add(new WeakRef(this));
    if (wasm.memory.buffer !== viewBuffer) {
      viewBuffer = wasm.memory.buffer;
      for (const ref of liveGrids) {
        const g = ref.deref();
        if (g) g.makeViews(viewBuffer); else liveGrids.delete(ref);
      }
    } else {
      this.makeViews(viewBuffer);
    }
  }

  makeViews(buf) {
    const n = this.w * this.h, p = (k) => wasm.nav_ptr(this.ptr, k);
    this.solid = new Uint8Array(buf, p(0), n);
    this.tower = new Int32Array(buf, p(1), n);
    this.goal = new Uint8Array(buf, p(2), n);
    this.dist = new Float64Array(buf, p(3), n);
    this.next = new Int32Array(buf, p(4), n);
    this.extra = new Uint8Array(buf, p(5), n);
    this.seen = new Uint8Array(buf, p(6), n);
  }

  rebuild() {
    wasm.nav_rebuild(this.ptr);
    this.version++;
  }

  reachableWith(blocked, mustReach) {
    const { extra, seen } = this;
    for (const i of blocked) extra[i] = 1;
    wasm.nav_flood(this.ptr);
    for (const i of blocked) extra[i] = 0;
    for (const i of mustReach) if (!seen[i]) return false;
    return true;
  }
}

/** Grids whose views must follow WASM memory when it grows. */
const liveGrids = new Set();
let viewBuffer = null;
const freeGrid = wasm ? new FinalizationRegistry((ptr) => wasm.nav_free(ptr)) : null;

/** The grid the sim uses: Rust-backed when sim.wasm loaded, JS otherwise. */
export const NavGrid = wasm ? WasmNavGrid : JsNavGrid;
export const navBackend = wasm ? 'wasm' : 'js';

/** Binary min-heap of cell indices keyed by distance. Allocation-free after construction. */
class MinHeap {
  constructor(capacity) {
    // Lazy deletion can push a cell several times; 8 neighbours bound it.
    this.items = new Int32Array(capacity * 8 + 8);
    this.keys = new Float64Array(capacity * 8 + 8);
    this.size = 0;
  }
  clear() { this.size = 0; }
  topKey() { return this.keys[0]; }
  push(item, key) {
    let i = this.size++;
    const { items, keys } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p]; keys[i] = keys[p]; i = p;
    }
    items[i] = item; keys[i] = key;
  }
  pop() {
    const { items, keys } = this;
    const top = items[0];
    const last = --this.size;
    const item = items[last], key = keys[last];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= last) break;
      if (c + 1 < last && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= key) break;
      items[i] = items[c]; keys[i] = keys[c]; i = c;
    }
    items[i] = item; keys[i] = key;
    return top;
  }
}
