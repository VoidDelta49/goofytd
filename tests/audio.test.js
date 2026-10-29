// Sound effects: positioning, throttling, and that every synthesised sound
// builds a valid Web Audio graph. The fake context throws on what real browsers
// throw on (non-finite values, exponential ramps to zero or below).

import { test, assert, assertClose } from './harness.js';
import { Sfx, spatial, SOUND_NAMES, HEAR_RANGE, panGains, soundLength, variantCount, variantPitch, buildBank, BANK_RATE } from '../src/client/audio.js';
import { Mixer, MIXER_VOICES } from '../src/client/sfx-worklet.js';

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
  createBuffer(ch, len) { const d = new Float32Array(len); return { length: len, getChannelData: () => d, copyToChannel: (src) => d.set(src) }; }
}

/** OfflineAudioContext stand-in: builds on the checking FakeCtx and "renders" a constant. */
class FakeOffline extends FakeCtx {
  constructor(ch, len, rate) { super(); this.length = len; this.sampleRate = rate; FakeOffline.made++; }
  startRendering() { const d = new Float32Array(this.length).fill(0.5); return Promise.resolve({ getChannelData: () => d }); }
}
FakeOffline.made = 0;
const offline = (ch, len, rate) => new FakeOffline(ch, len, rate);

const fakeStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
const make = () => { const ctx = new FakeCtx(); return { ctx, sfx: new Sfx({ context: ctx, storage: fakeStorage(), engine: 'graph' }) }; };

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

test('audio: equal-power pan matches StereoPannerNode', () => {
  const [l0, r0] = panGains(0);
  assertClose(l0, Math.SQRT1_2, 1e-9, 'centre left'); assertClose(r0, Math.SQRT1_2, 1e-9, 'centre right');
  const [l1, r1] = panGains(1), [l2, r2] = panGains(-1);
  assert(Math.abs(l1) < 1e-9 && Math.abs(r1 - 1) < 1e-9 && Math.abs(l2 - 1) < 1e-9 && Math.abs(r2) < 1e-9, 'hard pans');
  for (let p = -1; p <= 1; p += 0.25) { const [l, r] = panGains(p); assertClose(l * l + r * r, 1, 1e-9, `power at ${p}`); }
});

test('audio: the bank renders every variant of every sound at its full length', async () => {
  FakeOffline.made = 0;
  const bank = await buildBank(offline, BANK_RATE, 3);
  const total = SOUND_NAMES.reduce((a, n) => a + variantCount(n), 0);
  assert(FakeOffline.made === total, `${FakeOffline.made} renders for ${total} variants`);
  SOUND_NAMES.forEach((n, i) => {
    assert(bank.data[i].length === variantCount(n), `${n} variants`);
    for (let k = 0; k < variantCount(n); k++) {
      const p = variantPitch(n, k);
      assert(p >= 0.92 && p <= 1.08, `${n} pitch ${p}`);
      assertClose(bank.seconds[i][k], soundLength(n, p), 2 / BANK_RATE, `${n}#${k} length`);
    }
  });
  assert(variantCount('shot') > variantCount('upgrade'), 'pitched sounds get more variants');
});

test('audio: the dry-run length matches what the graph schedules', () => {
  const { ctx, sfx } = make();
  sfx.rnd = () => 0.5;
  for (const n of SOUND_NAMES) {
    ctx.maxStop = 0;
    sfx.live = {};
    sfx.play(n, undefined, undefined, 1, 100);
    assertClose(ctx.maxStop - 100, soundLength(n, 1), 1e-9, `${n} length`);
  }
});

test('audio: engines step up graph → buffer → worklet as they become available', async () => {
  const ctx = new FakeCtx();
  const sfx = new Sfx({ context: ctx, storage: fakeStorage(), offline });
  assert(sfx.engine === 'graph', 'before the bank');
  await sfx.ready; // FakeCtx has no audioWorklet: stays on buffers
  assert(sfx.engine === 'buffer', `got ${sfx.engine}`);
  const before = ctx.nodes.length;
  assert(sfx.play('shot', 3, -3, 1, 1), 'buffer play');
  assert(ctx.nodes.length - before === 3, `buffer voice made ${ctx.nodes.length - before} nodes`);
  // Bank lengths drive the overlap caps: a second wave inside the first one's length is refused.
  assert(sfx.play('wave', undefined, undefined, 1, 5) && !sfx.play('wave', undefined, undefined, 1, 5.7), 'wave overlap');
  const graphOnly = new Sfx({ context: new FakeCtx(), storage: fakeStorage(), offline, engine: 'graph' });
  await graphOnly.ready;
  assert(graphOnly.engine === 'graph' && FakeOffline.made > 0, 'engine cap ignored');
});

test('audio: worklet engine builds no nodes and posts one batch per task', async () => {
  const posts = [];
  class FakeWorkletNode { constructor(ctx, name, o) { this.name = name; this.o = o; this.port = { postMessage: (m) => posts.push(m) }; } connect(to) { assert(to, 'unconnected'); } }
  const prev = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = FakeWorkletNode;
  try {
    const ctx = new FakeCtx();
    ctx.audioWorklet = { addModule: async (url) => { assert(/sfx-worklet\.js/.test(url), url); } };
    const sfx = new Sfx({ context: ctx, storage: fakeStorage(), offline });
    await sfx.ready;
    assert(sfx.engine === 'worklet', `got ${sfx.engine}`);
    assert(posts[0].bank.length === SOUND_NAMES.length && posts[0].rate === BANK_RATE, 'bank not sent');
    sfx.setListener(0, 0, 0, -1);
    const before = ctx.nodes.length;
    assert(sfx.play('shot', 10, 0, 1, 1) && sfx.play('kill', 0, -10, 1, 1) && sfx.play('select'), 'plays refused');
    assert(ctx.nodes.length === before, 'worklet play built nodes');
    assert(posts.length === 1, 'posted before the task ended');
    await Promise.resolve();
    assert(posts.length === 2, `${posts.length - 1} batches`);
    const b = posts[1].play;
    assert(b.length === 15 && b[0] === SOUND_NAMES.indexOf('shot') && b[5] === SOUND_NAMES.indexOf('kill'), 'batch layout');
    const { gain, pan } = spatial(sfx.listener, 10, 0), [l, r] = panGains(pan);
    assertClose(b[3], gain * l, 1e-6, 'left gain'); assertClose(b[4], gain * r, 1e-6, 'right gain');
    assert(b[4] > b[3], 'a sound on the right is louder on the right');
  } finally {
    globalThis.AudioWorkletNode = prev;
  }
});

test('audio: worklet mixer starts on the right sample, mixes, resamples and frees voices', () => {
  const m = new Mixer(48000);
  const a = new Float32Array(300).fill(1), b = new Float32Array(100).fill(0.5);
  m.setBank([[a], [b]], 48000);
  const L = new Float32Array(128), R = new Float32Array(128);
  m.add(0, 0, 10, 0.25, 0.75);   // starts 10 samples into the first block
  m.add(1, 0, -50, 1, 1);        // late: starts at once
  m.process(L, R, 0, 128);
  assert(L[9] === 0.5 && L[10] === 0.75 && R[10] === 1.25, `mix ${L[9]} ${L[10]} ${R[10]}`);
  assert(L[100] === 0.25, 'short voice did not end');
  assert(m.n === 1, `${m.n} voices after the short one ended`);
  for (let f = 128; m.n; f += 128) m.process(L, R, f, 128);
  let played = 0; // 300 samples from frame 10 → ends inside block 3 (frames 256..383) at frame 310
  m.add(0, 0, 0, 1, 1);
  for (let f = 0; m.n; f += 128) { m.process(L, R, f, 128); for (let i = 0; i < 128; i++) played += L[i]; }
  assert(played === 300, `played ${played} samples`);
  // A 48 kHz bank on a 44.1 kHz device lasts the same time, not longer.
  const s = new Mixer(44100);
  s.setBank([[new Float32Array(48000).fill(1)]], 48000);
  s.add(0, 0, 0, 1, 1);
  let n = 0;
  for (let f = 0; s.n; f += 128) { s.process(L, R, f, 128); for (let i = 0; i < 128; i++) if (L[i] > 0) n++; }
  assertClose(n, 44100, 2, 'resampled length');
  const full = new Mixer(48000);
  full.setBank([[a]], 48000);
  for (let k = 0; k < MIXER_VOICES + 5; k++) full.add(0, 0, 0, 1, 1);
  assert(full.n === MIXER_VOICES && !full.add(9, 0, 0, 1, 1), 'voice ceiling or unknown sound');
});
