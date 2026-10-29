// Spatial hash over live cows, so a tower only looks at cows in the cells
// its range covers instead of every cow on the field. Pure: no three.js.
//
// Built as a counting sort (no per-cow allocation): `start[c]..start[c+1]`
// indexes `slots` for the cows in cell c. Cows outside the bounds go in the
// nearest edge cell, so nothing is ever missed: queries clamp the same way
// and callers still check the exact distance.
//
// Slots move when a cow dies or spawns (CowPool swap-removes), so the hash
// remembers the pool's `version` and rebuilds when it changed. Positions
// only change in Game.updateCows, which calls invalidate().

export class CowHash {
  /**
   * @param {{originX:number, originZ:number, w:number, h:number, cell:number}} grid nav grid (for the field bounds)
   * @param {number} cell hash cell size in metres
   */
  constructor(grid, cell = 8) {
    this.cell = cell;
    this.originX = grid.originX;
    this.originZ = grid.originZ;
    this.w = Math.max(1, Math.ceil((grid.w * grid.cell) / cell));
    this.h = Math.max(1, Math.ceil((grid.h * grid.cell) / cell));
    this.start = new Int32Array(this.w * this.h + 1);
    this.fill = new Int32Array(this.w * this.h);
    this.slots = new Int32Array(0);
    this.cellOf = new Int32Array(0);
    this.version = -1;
  }

  invalidate() { this.version = -1; }

  cx(x) { const c = Math.floor((x - this.originX) / this.cell); return c < 0 ? 0 : c >= this.w ? this.w - 1 : c; }
  cz(z) { const c = Math.floor((z - this.originZ) / this.cell); return c < 0 ? 0 : c >= this.h ? this.h - 1 : c; }

  /** Rebuild if positions or slots changed since the last build. */
  update(cows) {
    if (this.version === cows.version) return;
    this.version = cows.version;
    const n = cows.count;
    if (this.slots.length < cows.capacity) {
      this.slots = new Int32Array(cows.capacity);
      this.cellOf = new Int32Array(cows.capacity);
    }
    const { start, fill, slots, cellOf, w } = this;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const c = this.cz(cows.z[i]) * w + this.cx(cows.x[i]);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < w * this.h; c++) { start[c + 1] += start[c]; fill[c] = start[c]; }
    for (let i = 0; i < n; i++) slots[fill[cellOf[i]]++] = i;
  }

  /**
   * Slots of every cow whose hash cell overlaps the square of half-size
   * `reach` around (x, z): a superset of the cows within `reach`. Callers
   * still test the exact shape. Sorted high-to-low (`descending`, the order
   * the old backwards scans hit cows in) or low-to-high. A fresh array, so
   * a kill that triggers another query mid-loop (a flambé) can't clobber it.
   */
  near(cows, x, z, reach, descending = true) {
    this.update(cows);
    const { start, slots, w } = this;
    const x0 = this.cx(x - reach), x1 = this.cx(x + reach);
    const z0 = this.cz(z - reach), z1 = this.cz(z + reach);
    const out = [];
    for (let cz = z0; cz <= z1; cz++) {
      for (let c = cz * w + x0, end = cz * w + x1; c <= end; c++) {
        for (let k = start[c], e = start[c + 1]; k < e; k++) out.push(slots[k]);
      }
    }
    return out.sort(descending ? (a, b) => b - a : (a, b) => a - b);
  }
}
