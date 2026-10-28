// Sound effects: positioning, throttling, and that every synthesised sound
// builds a valid Web Audio graph. The fake context throws on what real browsers
// throw on (non-finite values, exponential ramps to zero or below).

import { test, assert, assertClose } from './harness.js';
import { Sfx, spatial, SOUND_NAMES, HEAR_RANGE } from '../src/client/audio.js';

class FakeParam {
  constructor(ctx, value = 0) { this.ctx = ctx; this.value = value; }
  check(...n) { for (const v of n) if (!Number.isFinite(v)) throw new RangeError(`non-finite audio param ${v}`); }
  setValueAtTime(v, t) { this.check(v, t); return this; }
  exponentialRampToValueAtTime(v, t) {
    this.check(v, t);
    if (v <= 0) throw new RangeError(`exponential ramp to ${v}`);
    return this;
  }
  setTargetAtTime(v, t, c) { this.check(v, t, c); return this; }
}

class FakeNode {
  constructor(ctx, kind, params = []) {
    this.ctx = ctx; this.kind = kind; this.connections = 0;
    for (const p of params) this[p] = new FakeParam(ctx, p === 'gain' ? 1 : 0);
    ctx.nodes.push(this);
  }
  connect(to) { assert(to, 'connected to nothing'); this.connections++; return to; }
  start(t) { this.ctx.check(t); this.started = t; this.ctx.maxStart = Math.max(this.ctx.maxStart, t); }
  stop(t) { this.ctx.check(t); assert(this.started !== undefined, 'stopped before start'); assert(t >= this.started, 'stop before start'); this.stopped = t; this.ctx.maxStop = Math.max(this.ctx.maxStop, t); }
}

class FakeCtx {
  constructor() { this.nodes = []; this.sampleRate = 8000; this.currentTime = 0; this.state = 'running'; this.maxStart = 0; this.maxStop = 0; this.destination = {}; }
  check(t) { if (!Number.isFinite(t) || t < 0) throw new RangeError(`bad time ${t}`); }
  createGain() { return new FakeNode(this, 'gain', ['gain']); }
  createOscillator() { return new FakeNode(this, 'osc', ['frequency']); }
  createBiquadFilter() { return new FakeNode(this, 'filter', ['frequency', 'Q']); }
  createBufferSource() { return new FakeNode(this, 'noise'); }
  createDynamicsCompressor() { return new FakeNode(this, 'comp', ['threshold', 'knee', 'ratio', 'attack', 'release']); }
  createStereoPanner() { return new FakeNode(this, 'pan', ['pan']); }
  createBuffer(ch, len) { const d = new Float32Array(len); return { getChannelData: () => d }; }
}

const fakeStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
const make = () => { const ctx = new FakeCtx(); return { ctx, sfx: new Sfx({ context: ctx, storage: fakeStorage() }) }; };

test('audio: gain falls off with distance and pan follows the view direction', () => {
  const l = { x: 0, z: 0, fx: 0, fz: -1 }; // facing -z: right is +x
  assertClose(spatial(l, 0, 0).gain, 1, 1e-9, 'gain at the listener');
  assert(spatial(l, 0, -HEAR_RANGE).gain === 0 && spatial(l, 500, 0).gain === 0, 'audible out of range');
  assert(spatial(l, 10, 0).gain > spatial(l, 30, 0).gain, 'louder far away');
  assert(spatial(l, 10, 0).pan > 0.5, 'right sound not on the right');
  assert(spatial(l, -10, 0).pan < -0.5, 'left sound not on the left');
  assertClose(spatial(l, 0, -10).pan, 0, 1e-9, 'straight ahead pan');
  // Turn to face +x: the same sound is now ahead, and one at +z is on the right... (right of +x is +z).
  const r = { x: 0, z: 0, fx: 1, fz: 0 };
  assert(spatial(r, 0, 10).pan > 0.5 && Math.abs(spatial(r, 10, 0).pan) < 1e-9, 'pan did not follow yaw');
  // Looking straight up/down has no horizontal direction: centred, no NaN.
  assert(spatial({ x: 0, z: 0, fx: 0, fz: 0 }, 5, 5).pan === 0, 'degenerate view');
});

test('audio: every sound builds a valid graph and ends in a sensible time', () => {
  const { ctx, sfx } = make();
  let t = 1;
  for (const name of SOUND_NAMES) {
    ctx.maxStart = ctx.maxStop = 0;
    assert(sfx.play(name, undefined, undefined, 1, t), `${name} did not play`);
    assert(ctx.maxStop > t, `${name} scheduled nothing`);
    assert(ctx.maxStop - t < 3, `${name} runs ${(ctx.maxStop - t).toFixed(2)} s`);
    t += 10;
  }
  // Positioned and quiet variants too.
  sfx.setListener(0, 0, 0, -1);
  assert(sfx.play('shot', 5, -5, 0.3, t + 10), 'positioned sound dropped');
  assert(sfx.play('land', undefined, undefined, 0.15, t + 20), 'quiet landing dropped');
});

test('audio: sounds are throttled per kind and capped globally', () => {
  const { sfx } = make();
  assert(sfx.play('shot', undefined, undefined, 1, 1.0), 'first shot');
  assert(!sfx.play('shot', undefined, undefined, 1, 1.01), 'shot inside its gap');
  assert(sfx.play('shot', undefined, undefined, 1, 1.05), 'shot after its gap');
  // 'wave' allows one at a time: a second inside its 1.4 s length is refused even past the gap.
  assert(sfx.play('wave', undefined, undefined, 1, 5), 'wave');
  assert(!sfx.play('wave', undefined, undefined, 1, 5.7), 'overlapping wave');
  // A storm of kills never exceeds the per-kind cap.
  let played = 0;
  for (let k = 0; k < 100; k++) if (sfx.play('kill', undefined, undefined, 1, 10 + k * 0.001 * 70)) played++;
  assert(played > 0 && played <= 100 * 0.07 / 0.06 + 3, `kill storm played ${played}`);
  const live = Object.values(sfx.live).reduce((a, v) => a + v.length, 0);
  assert(live <= 28, `${live} voices live`);
});

test('audio: far sounds are skipped, muting silences and is remembered', () => {
  const { ctx, sfx } = make();
  sfx.setListener(0, 0, 0, -1);
  const before = ctx.nodes.length;
  assert(!sfx.play('splash', 0, -200, 1, 1), 'inaudible sound was built');
  assert(ctx.nodes.length === before, 'inaudible sound created nodes');
  assert(sfx.toggleMute() === true && !sfx.play('select', undefined, undefined, 1, 2), 'muted sound played');
  assert(sfx.storage.getItem('goofytd.muted') === '1', 'mute not saved');
  const again = new Sfx({ context: new FakeCtx(), storage: sfx.storage });
  assert(again.muted, 'mute not restored');
  assert(sfx.toggleMute() === false && sfx.play('select', undefined, undefined, 1, 3), 'unmute');
});

test('audio: not playing before the browser unlocks the context, never throws without one', () => {
  const sfx = new Sfx({ context: null, storage: fakeStorage() }); // Node: no window, no context
  assert(!sfx.play('shot') && !sfx.consume([{ kind: 'kill', x: 0, z: 0 }]), 'played without a context');
  sfx.unlock(); // no AudioContext in Node: must be harmless
  const locked = new FakeCtx(); locked.state = 'suspended';
  const s2 = new Sfx({ context: locked, storage: fakeStorage() });
  s2.injected = false; // behave like a real browser context: suspended means silent
  assert(!s2.play('shot', undefined, undefined, 1, 1), 'played while suspended');
});

test('audio: simulation events map to sounds', () => {
  const { sfx } = make();
  const played = [];
  sfx.play = (name) => { played.push(name); return true; };
  sfx.consume([
    { kind: 'shot', x0: 1, z0: 1 }, { kind: 'launch', x: 1, z: 1 }, { kind: 'splash', x: 1, z: 1 },
    { kind: 'kill', x: 1, z: 1 }, { kind: 'drink', x: 1, z: 1 }, { kind: 'wave', wave: 1 }, { kind: 'lost' },
    { kind: 'built' }, { kind: 'sold' }, // UI sounds are played where the click happens
  ]);
  assert(played.join() === 'shot,launch,splash,kill,drink,wave,lost', `got ${played.join()}`);
});
