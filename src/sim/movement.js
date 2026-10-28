// Kinematic first-person movement, modelled on the Quake 3 / Source player
// movement code ("pmove").
//
// `tick` is a pure function of (state, input, config, world, dt): the same
// tick can later run on a server, be replayed for prediction, or be tested in
// Node. Units are metres and seconds.
//
// The behaviours that make this movement feel right, and that are easy to lose
// when simplifying:
//
// * Accelerate toward a wish SPEED, not a target velocity. Speed is only added
//   along the wish direction until velocity's projection on it reaches the
//   wish speed. Velocity perpendicular to the wish direction is left alone,
//   which is the root of air strafing.
// * Air acceleration caps the PROJECTED speed, not the acceleration. In the
//   air the cap is tiny (`airSpeedCap`) but the acceleration amount still
//   scales with the full wish speed. Turning the mouse while strafing keeps the
//   wish direction nearly perpendicular to velocity, so the projection stays
//   under the cap and speed keeps growing: strafe jumping / bunny hopping.
// * Friction is skipped on the tick you jump, so chained hops keep speed.
// * Step-slide: small ledges are climbed by retrying a blocked move from
//   `stepHeight` higher and keeping whichever attempt went further.

import { Vec3 } from './vec3.js';

/** A ground normal needs at least this much +Y to be standable. */
export const MIN_WALK_NORMAL_Y = 0.7;
/** How far below the feet to probe for ground. */
const GROUND_PROBE = 0.02;
/** Maximum collide-and-slide iterations per move. */
const MAX_CLIP_PLANES = 4;

/**
 * Tunables. Defaults are Quake 3 values converted from units (≈ inches) to
 * metres and nudged toward a slightly floaty, goofy jump.
 */
export function defaultMoveConfig() {
  return {
    gravity: 20.0,            // m/s²
    maxGroundSpeed: 7.5,      // m/s with full input
    crouchSpeedScale: 0.4,
    groundAccel: 10.0,        // Quake pm_accelerate, 1/s
    airAccel: 12.0,           // Quake pm_airaccelerate, 1/s
    airSpeedCap: 0.8,         // m/s; small cap + high airAccel = strong strafing
    friction: 6.0,            // Quake pm_friction, 1/s
    stopSpeed: 2.5,           // friction acts as if at least this fast: crisp stops
    jumpSpeed: 7.0,           // m/s upward on jump
    coyoteTime: 0.1,          // s after leaving ground a jump still works
    jumpBuffer: 0.12,         // s a jump press is remembered in the air
    autoHop: false,           // holding jump re-jumps on landing
    stepHeight: 0.45,         // m climbed without jumping
    hullHalfWidth: 0.4,       // m, X and Z
    standHeight: 1.8,         // m
    crouchHeight: 1.2,        // m
    standEyeHeight: 1.62,     // m above feet
    crouchEyeHeight: 1.0,     // m above feet
    eyeHeightSpeed: 6.0,      // m/s the eye moves toward its target
  };
}

export function hullHalfExtents(cfg, crouched) {
  const h = crouched ? cfg.crouchHeight : cfg.standHeight;
  return new Vec3(cfg.hullHalfWidth, h * 0.5, cfg.hullHalfWidth);
}

/**
 * Input for one tick.
 * wish: {x: right, y: forward} each in [-1, 1].
 * yaw: radians; 0 looks down -Z, positive turns left (three.js convention).
 */
export function emptyInput() {
  return { wish: { x: 0, y: 0 }, yaw: 0, jumpPressed: false, jumpHeld: false, crouchHeld: false };
}

/** Simulation state of one player body. `position` is the feet (hull bottom centre). */
export function createPlayerState(position, cfg) {
  return {
    position,
    velocity: Vec3.ZERO,
    grounded: false,
    crouched: false,
    // Spawning mid-air must not grant a coyote jump.
    airTime: Infinity,
    jumpBufferLeft: 0,
    jumpedSinceGrounded: false,
    eyeHeight: cfg.standEyeHeight,
    // Per-tick events for presentation (sound, view kick).
    jumpedThisTick: false,
    landedSpeed: 0,
  };
}

export function horizontalSpeed(state) {
  return state.velocity.horizontalLength();
}

export function yawForward(yaw) { return new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw)); }
export function yawRight(yaw) { return new Vec3(Math.cos(yaw), 0, -Math.sin(yaw)); }

/** Advance one player by one fixed tick of `dt` seconds. Mutates `state`. */
export function tick(state, input, cfg, world, dt) {
  state.jumpedThisTick = false;
  state.landedSpeed = 0;

  updateCrouch(state, input, cfg, world);

  categorizeGround(state, cfg, world);
  if (state.grounded) {
    state.airTime = 0;
    state.jumpedSinceGrounded = false;
  } else {
    state.airTime += dt;
  }

  // Jump buffering.
  state.jumpBufferLeft = input.jumpPressed ? cfg.jumpBuffer : Math.max(state.jumpBufferLeft - dt, 0);
  const wantsJump = state.jumpBufferLeft > 0 || (cfg.autoHop && input.jumpHeld);
  const canJump = !state.jumpedSinceGrounded && (state.grounded || state.airTime <= cfg.coyoteTime);
  let jumped = false;
  if (wantsJump && canJump) {
    state.velocity = state.velocity.with(1, cfg.jumpSpeed);
    state.grounded = false;
    state.jumpedSinceGrounded = true;
    state.jumpBufferLeft = 0;
    state.jumpedThisTick = true;
    jumped = true;
  }

  // Wish direction and speed on the ground plane.
  let wx = input.wish.x;
  let wy = input.wish.y;
  const wl = Math.hypot(wx, wy);
  if (wl > 1) { wx /= wl; wy /= wl; }
  const wishVel = yawRight(input.yaw).scale(wx).add(yawForward(input.yaw).scale(wy));
  const wishLen = wishVel.length();
  const wishDir = wishLen > 1e-6 ? wishVel.scale(1 / wishLen) : Vec3.ZERO;
  const wishSpeed = wishLen * cfg.maxGroundSpeed * (state.crouched ? cfg.crouchSpeedScale : 1);

  const walking = state.grounded && !jumped;
  if (walking) {
    state.velocity = state.velocity.with(1, 0);
    applyFriction(state, cfg, dt);
    state.velocity = accelerate(state.velocity, wishDir, wishSpeed, wishSpeed, cfg.groundAccel, dt);
    stepSlideMove(state, cfg, world, dt, true);
    snapToGround(state, cfg, world);
    // Detect walking off a ledge (snap found nothing within step height).
    categorizeGround(state, cfg, world);
  } else {
    state.velocity = accelerate(
      state.velocity, wishDir, wishSpeed, Math.min(wishSpeed, cfg.airSpeedCap), cfg.airAccel, dt,
    );
    // Half of gravity before the move and half after (velocity Verlet):
    // jump arcs come out exact regardless of tick rate.
    state.velocity = state.velocity.with(1, state.velocity.y - cfg.gravity * dt * 0.5);
    const fallSpeed = -state.velocity.y;
    stepSlideMove(state, cfg, world, dt, false);
    state.velocity = state.velocity.with(1, state.velocity.y - cfg.gravity * dt * 0.5);

    categorizeGround(state, cfg, world);
    if (state.grounded) {
      state.landedSpeed = Math.max(fallSpeed, 0);
      state.velocity = state.velocity.with(1, 0);
      state.airTime = 0;
      state.jumpedSinceGrounded = false;
    }
  }

  updateEyeHeight(state, cfg, dt);
}

/**
 * Quake PM_Accelerate. `accelSpeed` scales the acceleration amount;
 * `capSpeed` limits the projected speed along `wishDir`. On the ground both
 * are the wish speed; in the air the cap is tiny but the acceleration isn't.
 */
function accelerate(vel, wishDir, accelSpeed, capSpeed, accel, dt) {
  if (wishDir === Vec3.ZERO) return vel;
  const add = capSpeed - vel.dot(wishDir);
  if (add <= 0) return vel;
  const amount = Math.min(accel * accelSpeed * dt, add);
  return vel.add(wishDir.scale(amount));
}

/** Quake PM_Friction, horizontal only. */
function applyFriction(state, cfg, dt) {
  const v = state.velocity;
  const speed = v.horizontalLength();
  if (speed < 1e-4) {
    state.velocity = new Vec3(0, v.y, 0);
    return;
  }
  const control = Math.max(speed, cfg.stopSpeed);
  const scale = Math.max(speed - control * cfg.friction * dt, 0) / speed;
  state.velocity = new Vec3(v.x * scale, v.y, v.z * scale);
}

function hullCenter(position, half) {
  return position.add(new Vec3(0, half.y, 0));
}

function trace(state, cfg, world, position, delta) {
  const half = hullHalfExtents(cfg, state.crouched);
  return world.sweep(hullCenter(position, half), half, delta);
}

function categorizeGround(state, cfg, world) {
  // Moving up fast enough to leave the ground: not grounded. Stops the jump
  // tick from immediately re-landing.
  if (state.velocity.y > 0.1) {
    state.grounded = false;
    return;
  }
  const hit = trace(state, cfg, world, state.position, new Vec3(0, -GROUND_PROBE, 0));
  state.grounded = hit !== null && hit.normal.y >= MIN_WALK_NORMAL_Y;
}

/** Keep the feet glued to the ground walking down small steps. */
function snapToGround(state, cfg, world) {
  const down = new Vec3(0, -(cfg.stepHeight + GROUND_PROBE), 0);
  const hit = trace(state, cfg, world, state.position, down);
  if (hit && hit.normal.y >= MIN_WALK_NORMAL_Y) {
    state.position = state.position.add(down.scale(hit.t));
  }
}

/** Remove the component of `vel` going into the plane with normal `n`. */
function clipVelocity(vel, n) {
  const into = vel.dot(n);
  return into < 0 ? vel.sub(n.scale(into)) : vel;
}

/**
 * Quake 3 PM_SlideMove: move along velocity for `dt`, sliding along what is
 * hit. Returns true if anything was hit.
 */
function slideMove(state, cfg, world, dt) {
  const originalVel = state.velocity;
  const planes = [];
  let timeLeft = dt;
  let blocked = false;

  for (let bump = 0; bump < MAX_CLIP_PLANES; bump++) {
    const delta = state.velocity.scale(timeLeft);
    if (delta.lengthSq() < 1e-12) break;
    const hit = trace(state, cfg, world, state.position, delta);
    if (!hit) {
      state.position = state.position.add(delta);
      break;
    }
    blocked = true;
    state.position = state.position.add(delta.scale(hit.t));
    timeLeft *= 1 - hit.t;

    if (planes.length === MAX_CLIP_PLANES) {
      state.velocity = Vec3.ZERO;
      break;
    }
    planes.push(hit.normal);

    // Find a velocity that doesn't go into any touched plane.
    let v = clipVelocity(state.velocity, hit.normal);
    for (let i = 0; i < planes.length; i++) {
      if (v.dot(planes[i]) >= 0) continue;
      v = clipVelocity(v, planes[i]);
      for (let j = 0; j < planes.length; j++) {
        if (j !== i && v.dot(planes[j]) < 0) {
          // Wedged into a crease between two planes: slide along it.
          const crease = planes[i].cross(planes[j]).normalizeOrZero();
          v = crease.scale(crease.dot(v));
        }
      }
    }
    // Never bounce back against the original direction of travel.
    if (v.dot(originalVel) <= 0 && planes.length > 1) v = Vec3.ZERO;
    state.velocity = v;
  }
  return blocked;
}

/**
 * Quake 3 / Source StepSlideMove: slide; if blocked while on the ground, try
 * again from `stepHeight` up and keep the result that went further.
 */
function stepSlideMove(state, cfg, world, dt, onGround) {
  const startPos = state.position;
  const startVel = state.velocity;

  if (!slideMove(state, cfg, world, dt) || !onGround) return;
  const slidePos = state.position;
  const slideVel = state.velocity;

  // Step up as far as the ceiling allows.
  state.position = startPos;
  state.velocity = startVel;
  const up = new Vec3(0, cfg.stepHeight, 0);
  const upHit = trace(state, cfg, world, startPos, up);
  const raised = up.scale(upHit ? upHit.t : 1);
  state.position = startPos.add(raised);

  slideMove(state, cfg, world, dt);

  // Step back down onto whatever is there.
  const down = new Vec3(0, -raised.y - GROUND_PROBE, 0);
  const downHit = trace(state, cfg, world, state.position, down);
  let landed = false;
  if (downHit) {
    state.position = state.position.add(down.scale(downHit.t));
    landed = downHit.normal.y >= MIN_WALK_NORMAL_Y;
  } else {
    state.position = state.position.add(down);
  }

  const horizDistSq = (p) => (p.x - startPos.x) ** 2 + (p.z - startPos.z) ** 2;
  if (!landed || horizDistSq(state.position) <= horizDistSq(slidePos) + 1e-8) {
    state.position = slidePos;
    state.velocity = slideVel;
  } else {
    // Keep the stepped horizontal velocity; vertical stays from the plain slide.
    state.velocity = state.velocity.with(1, slideVel.y);
  }
}

function updateCrouch(state, input, cfg, world) {
  const deltaH = cfg.standHeight - cfg.crouchHeight;
  const standHalf = hullHalfExtents(cfg, false);
  if (input.crouchHeld && !state.crouched) {
    state.crouched = true;
    if (!state.grounded) {
      // In the air the hull shrinks from the bottom: tucking the legs up is
      // what makes crouch-jumping reach higher ledges. Shift the smoothed eye
      // by the same amount so the view doesn't pop.
      state.position = state.position.add(new Vec3(0, deltaH, 0));
      state.eyeHeight -= deltaH;
    }
  } else if (!input.crouchHeld && state.crouched) {
    if (state.grounded) {
      // Grow upward, only if the head has room.
      if (!world.boxBlocked(hullCenter(state.position, standHalf), standHalf)) state.crouched = false;
    } else {
      // Drop the legs back down if there's room below, else grow upward.
      const lowered = state.position.sub(new Vec3(0, deltaH, 0));
      if (!world.boxBlocked(hullCenter(lowered, standHalf), standHalf)) {
        state.position = lowered;
        state.eyeHeight += deltaH;
        state.crouched = false;
      } else if (!world.boxBlocked(hullCenter(state.position, standHalf), standHalf)) {
        state.crouched = false;
      }
    }
  }
}

function updateEyeHeight(state, cfg, dt) {
  const target = state.crouched ? cfg.crouchEyeHeight : cfg.standEyeHeight;
  const maxStep = cfg.eyeHeightSpeed * dt;
  state.eyeHeight += Math.min(Math.max(target - state.eyeHeight, -maxStep), maxStep);
}
