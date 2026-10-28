// Fixed-timestep clock. The simulation always advances in whole ticks of
// 1/hz seconds no matter the display's frame rate; rendering interpolates
// between the last two ticks using `alpha`.

/** 64 Hz: in the range competitive shooters use (Source 64/66, CS2 64). */
export const TICK_HZ = 64;

export class FixedClock {
  /**
   * @param {number} hz ticks per second
   * @param {number} maxTicksPerFrame cap so a long stall (tab in background,
   *   breakpoint) doesn't trigger a burst of catch-up ticks. Time beyond the
   *   cap is dropped, which looks like a brief slow-down instead of a freeze.
   */
  constructor(hz = TICK_HZ, maxTicksPerFrame = 8) {
    this.dt = 1 / hz;
    this.maxTicks = maxTicksPerFrame;
    this.accumulator = 0;
    this.tickCount = 0;
  }

  /** Add `seconds` of real time. Returns how many ticks to run now. */
  advance(seconds) {
    this.accumulator += Math.max(seconds, 0);
    let n = Math.floor(this.accumulator / this.dt);
    if (n > this.maxTicks) {
      n = this.maxTicks;
      this.accumulator = n * this.dt;
    }
    this.accumulator -= n * this.dt;
    this.tickCount += n;
    return n;
  }

  /** Fraction of a tick elapsed since the latest tick, in [0, 1). */
  get alpha() {
    return this.accumulator / this.dt;
  }
}
