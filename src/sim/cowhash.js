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
}
