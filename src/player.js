// One player body plus the bookkeeping around the pure sim: input latching
// between ticks, interpolation history, respawning. No DOM, no three.js.

import { Vec3 } from './sim/vec3.js';
import { createPlayerState, horizontalSpeed, tick } from './sim/movement.js';

/** Falling below this height respawns the player. */
export const KILL_PLANE_Y = -50;
export const MAX_PITCH = (89 * Math.PI) / 180;

export class PlayerController {
  constructor(spawn, spawnYaw, cfg) {
    this.spawn = spawn;
    this.spawnYaw = spawnYaw;
    this.cfg = cfg;
    /** View angles; yaw 0 looks down -Z, pitch positive looks up. */
    this.yaw = spawnYaw;
    this.pitch = 0;
    /**
     * Input gathered between ticks. Held state is overwritten every frame;
     * `jumpPressed` and `respawn` are latched until a tick consumes them, so a
     * press shorter than a tick is never lost and a frame that runs several
     * ticks applies it only once.
     */
    this.pending = { wish: { x: 0, y: 0 }, jumpHeld: false, crouchHeld: false, jumpPressed: false, respawn: false };
    this.reset();
  }

  reset() {
    this.state = createPlayerState(this.spawn, this.cfg);
    this.prevPosition = this.state.position;
    this.prevEyeHeight = this.state.eyeHeight;
    this.topSpeed = 0;
  }

  /** Mouse look, applied immediately (never waits for a tick). */
  look(dYaw, dPitch) {
    const tau = Math.PI * 2;
    this.yaw = (((this.yaw + dYaw) % tau) + tau) % tau;
    this.pitch = Math.min(Math.max(this.pitch + dPitch, -MAX_PITCH), MAX_PITCH);
  }

  /** Run one fixed tick. */
  step(world, dt) {
    const p = this.pending;
    if (p.respawn || this.state.position.y < KILL_PLANE_Y) {
      p.respawn = false;
      p.jumpPressed = false;
      this.reset();
      this.yaw = this.spawnYaw;
      this.pitch = 0;
      return;
    }
    const input = {
      wish: { x: p.wish.x, y: p.wish.y },
      yaw: this.yaw,
      jumpPressed: p.jumpPressed,
      jumpHeld: p.jumpHeld,
      crouchHeld: p.crouchHeld,
    };
    p.jumpPressed = false;

    this.prevPosition = this.state.position;
    this.prevEyeHeight = this.state.eyeHeight;
    tick(this.state, input, this.cfg, world, dt);
    this.topSpeed = Math.max(this.topSpeed, horizontalSpeed(this.state));
  }

  /**
   * Thrown by something (Big Mama's Hoof Stomp): velocity becomes (vx, vy, vz)
   * and the body leaves the ground. Local only, like the rest of the farmer.
   */
  knock(vx, vy, vz) {
    const st = this.state;
    st.velocity = new Vec3(vx, vy, vz);
    st.grounded = false;
    st.jumpedSinceGrounded = true;
  }

  /** Eye position blended between the last two ticks; `alpha` in [0, 1]. */
  interpolatedEye(alpha) {
    const feet = this.prevPosition.lerp(this.state.position, alpha);
    const eye = this.prevEyeHeight + (this.state.eyeHeight - this.prevEyeHeight) * alpha;
    return feet.add(new Vec3(0, eye, 0));
  }
}
