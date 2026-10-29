// Procedural sound effects. Every sound is synthesised with Web Audio the
// moment it plays (oscillators, filtered noise, envelopes): no sample files,
// nothing to download, nothing to license. Browser only; the simulation never
// sees this. The sim reports what happened as events, `consume()` maps them to
// sounds, and `play()` positions them relative to the listener.
//
// Browsers keep audio locked until a user gesture, so the AudioContext is
// created on the first pointer/key event. Until then play() is a no-op.

import { mulberry32 } from '../sim/rng.js';

/** Metres at which a sound has faded to silence. Gain falls off as (1 − d/range)². */
export const HEAR_RANGE = 70;
const MAX_VOICES = 28;
const MASTER_VOLUME = 0.9;
const MUTE_KEY = 'goofytd.muted';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Loudness and stereo position of a sound at (x, z) for a listener.
 * @param {{x:number, z:number, fx:number, fz:number}} l listener position and horizontal view direction
 * @returns {{gain:number, pan:number}} gain 0..1, pan -1 (left)..1 (right)
 */
export function spatial(l, x, z) {
  const dx = x - l.x, dz = z - l.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const t = Math.max(0, 1 - d / HEAR_RANGE);
  let pan = 0;
  if (d > 1) {
    // Right-hand vector of the view direction: forward (0,-1) → right (1,0).
    const rx = -l.fz, rz = l.fx;
    const rl = Math.sqrt(rx * rx + rz * rz);
    if (rl > 1e-6) pan = clamp(((dx * rx + dz * rz) / (d * rl)) * 0.85, -1, 1);
  }
  return { gain: t * t, pan };
}

/**
 * Sound definitions. `gap`: minimum seconds between two of this sound (a
 * 40-tower defence would otherwise fire hundreds a second); `max`: how many
 * may overlap; `vol`: loudness before distance. `build(v, p, power)` adds the
 * layers: `p` is a random pitch factor ≈ 0.92–1.08 so repeats don't sound
 * identical, `power` is the strength passed to play().
 */
const SOUNDS = {
  // Milk Squirter: a wet squirt.
  shot: {
    gap: 0.03, max: 6, vol: 1.0,
    build(v, p) {
      v.tone('sine', [1100 * p, 420 * p], 0.11, 0.7);
      v.noise(0.07, 0.45, 'bandpass', [2600, 1400], 2.5);
      v.tone('triangle', [520 * p, 260 * p], 0.09, 0.25, { delay: 0.02 });
    },
  },
  // Zappy Fence: a short electric buzz.
  zap: {
    gap: 0.06, max: 3, vol: 0.7,
    build(v, p) {
      v.tone('sawtooth', [120 * p, 95 * p], 0.12, 0.45, { lowpass: [2400, 1200] });
      v.noise(0.1, 0.4, 'highpass', [3000, 5000], 0.8);
    },
  },
  // Moo-shotgun: a wet boom with a splatter tail.
  blast: {
    gap: 0.08, max: 3, vol: 1.0,
    build(v, p) {
      v.noise(0.22, 0.85, 'lowpass', [3200, 300], 0.8);
      v.tone('sine', [140 * p, 45], 0.2, 0.8);
      v.noise(0.16, 0.35, 'bandpass', [2400, 1300], 2, { delay: 0.05 });
    },
  },
  // Tower upgraded: a rising arpeggio and a sparkle.
  upgrade: {
    gap: 0.1, max: 2, vol: 0.9,
    build(v) {
      [523, 659, 784, 1047].forEach((f, k) => v.tone('triangle', [f, f], 0.16, 0.42, { delay: k * 0.07 }));
      v.tone('square', [2093, 2093], 0.3, 0.08, { delay: 0.28, lowpass: [6000, 6000] });
      v.tone('sine', [130, 260], 0.25, 0.5);
    },
  },
  // Butter Mortar firing: thunk and a bloop.
  launch: {
    gap: 0.06, max: 4, vol: 0.9,
    build(v, p) {
      v.tone('sine', [150, 48], 0.28, 0.9);
      v.noise(0.16, 0.5, 'lowpass', [900, 200], 0.7);
      v.tone('sine', [300 * p, 700 * p], 0.1, 0.35, { delay: 0.03 });
    },
  },
  // Butter shell landing.
  splash: {
    gap: 0.05, max: 4, vol: 1.0,
    build(v) {
      v.noise(0.45, 0.8, 'lowpass', [1800, 250], 0.8, { attack: 0.01 });
      v.tone('sine', [110, 38], 0.38, 0.9);
    },
  },
  // A Kaboom Cow going off: a big low blast with a crackly tail.
  boom: {
    gap: 0.08, max: 3, vol: 1.0,
    build(v) {
      v.tone('sine', [90, 28], 0.7, 1.0);
      v.noise(0.9, 0.9, 'lowpass', [2400, 120], 0.7, { attack: 0.005 });
      v.noise(0.5, 0.25, 'highpass', [3000, 1200], 0.7, { delay: 0.05 });
    },
  },
  // Wind-up telegraph: a Heifer snorts (two nasal noise puffs), a Spitter hawks up cud.
  snort: {
    gap: 0.15, max: 2, vol: 1.0,
    build(v, p) {
      v.noise(0.12, 0.6, 'bandpass', [700 * p, 400 * p], 1.5, { attack: 0.01 });
      v.noise(0.16, 0.7, 'bandpass', [600 * p, 300 * p], 1.5, { attack: 0.01, delay: 0.16 });
    },
  },
  hawk: {
    gap: 0.15, max: 2, vol: 1.0,
    build(v, p) {
      v.noise(0.3, 0.5, 'bandpass', [1200 * p, 2600 * p], 3, { attack: 0.05 });
      v.tone('sawtooth', [90 * p, 140 * p], 0.3, 0.2, { lowpass: [600, 900] });
    },
  },
  // Headbutt landing on a tower: a wooden thunk and a cartoon boing.
  bonk: {
    gap: 0.06, max: 3, vol: 1.0,
    build(v, p) {
      v.tone('sine', [220 * p, 90], 0.14, 0.9);
      v.noise(0.08, 0.6, 'lowpass', [1400, 300], 0.8);
      v.tone('triangle', [330 * p, 660 * p, 440 * p], 0.3, 0.3, { delay: 0.04, vibrato: [14, 25] });
    },
  },
  // Spit hitting a tower: ptoo, splat.
  spit: {
    gap: 0.08, max: 3, vol: 0.9,
    build(v, p) {
      v.noise(0.06, 0.5, 'highpass', [2000, 4000], 0.8);
      v.noise(0.2, 0.6, 'bandpass', [900 * p, 300 * p], 2, { delay: 0.05 });
    },
  },
  // A tower headbutted to bits: crunch and a falling tone.
  wreck: {
    gap: 0.2, max: 2, vol: 1.0,
    build(v) {
      v.noise(0.5, 0.8, 'lowpass', [3000, 200], 0.7, { attack: 0.005 });
      v.tone('square', [400, 80], 0.5, 0.25, { lowpass: [1500, 300] });
    },
  },
  // A cow going down: a short surprised moo.
  kill: {
    gap: 0.06, max: 3, vol: 0.9,
    build(v, p) {
      v.tone('sawtooth', [105 * p, 150 * p, 140 * p, 90 * p], 0.42, 0.55, {
        attack: 0.03, lowpass: [350, 1100, 500, 300], q: 2, vibrato: [5.5, 4],
      });
    },
  },
  // A cow reaching the milk: glug glug.
  drink: {
    gap: 0.12, max: 3, vol: 1.0,
    build(v, p) {
      v.tone('sine', [260 * p, 620 * p], 0.1, 0.8);
      v.tone('sine', [220 * p, 540 * p], 0.12, 0.8, { delay: 0.11 });
      v.noise(0.2, 0.25, 'lowpass', [700, 300], 0.7);
    },
  },
  // Wave start: three cowbell clanks and a horn.
  wave: {
    gap: 0.5, max: 1, vol: 0.9,
    build(v) {
      for (let k = 0; k < 3; k++) {
        const d = k * 0.16;
        v.tone('square', [540, 540], 0.22, 0.3, { delay: d, bandpass: 700, q: 1.2 });
        v.tone('square', [800, 800], 0.22, 0.3, { delay: d, bandpass: 700, q: 1.2 });
      }
      const horn = { attack: 0.07, lowpass: [500, 1400, 900], q: 1 };
      v.tone('sawtooth', [233, 233], 0.38, 0.35, { delay: 0.5, ...horn });
      v.tone('sawtooth', [349, 349], 0.38, 0.3, { delay: 0.5, ...horn });
      v.tone('sawtooth', [294, 294], 0.6, 0.35, { delay: 0.9, ...horn });
      v.tone('sawtooth', [440, 440], 0.6, 0.3, { delay: 0.9, ...horn });
    },
  },
  // The milk is gone: sad trombone.
  lost: {
    gap: 2, max: 1, vol: 0.8,
    build(v) {
      const wah = { attack: 0.04, lowpass: [700, 900, 500], q: 1, vibrato: [5, 5] };
      v.tone('sawtooth', [311, 311], 0.36, 0.5, wah);
      v.tone('sawtooth', [293, 293], 0.36, 0.5, { delay: 0.4, ...wah });
      v.tone('sawtooth', [277, 277], 0.36, 0.5, { delay: 0.8, ...wah });
      v.tone('sawtooth', [261, 196], 1.0, 0.5, { delay: 1.2, ...wah });
    },
  },
  // Tower built: a thunk and a ding.
  build: {
    gap: 0.05, max: 2, vol: 1.0,
    build(v) {
      v.tone('sine', [180, 70], 0.12, 0.9);
      v.noise(0.09, 0.5, 'lowpass', [500, 150], 0.7);
      v.tone('triangle', [880, 880], 0.24, 0.3, { delay: 0.06 });
      v.tone('triangle', [1320, 1320], 0.2, 0.15, { delay: 0.06 });
    },
  },
  // Tower sold: coin.
  sell: {
    gap: 0.05, max: 2, vol: 1.0,
    build(v) {
      v.tone('square', [988, 988], 0.07, 0.2, { lowpass: [5000, 5000] });
      v.tone('square', [1319, 1319], 0.22, 0.2, { delay: 0.07, lowpass: [5000, 5000] });
    },
  },
  // Can't build here: buzzer.
  deny: {
    gap: 0.15, max: 1, vol: 0.9,
    build(v) {
      v.tone('square', [170, 120], 0.14, 0.35, { lowpass: [900, 900] });
      v.tone('square', [170, 120], 0.14, 0.35, { delay: 0.12, lowpass: [900, 900] });
    },
  },
  // UI blip: pick a tower, cancel, mute toggle.
  select: {
    gap: 0.03, max: 2, vol: 1.0,
    build(v) { v.tone('triangle', [600, 900], 0.07, 0.7); },
  },
  jump: {
    gap: 0.1, max: 2, vol: 1.0,
    build(v, p) {
      v.tone('sine', [260 * p, 520 * p], 0.09, 0.35);
      v.noise(0.06, 0.15, 'highpass', [1500, 3000], 0.7);
    },
  },
  // Landing thud; `power` is the fall speed scaled to 0..1.
  land: {
    gap: 0.1, max: 2, vol: 1.0,
    build(v) {
      v.noise(0.1, 0.7, 'lowpass', [500, 120], 0.7);
      v.tone('sine', [110, 45], 0.13, 0.8);
    },
  },
};

export const SOUND_NAMES = Object.keys(SOUNDS);

/**
 * One playing sound: a bundle of oscillators and noise bursts feeding `dest`,
 * all scheduled up front relative to `t0`. Tracks when the last layer ends.
 */
class Voice {
  constructor(ctx, dest, t0, noiseBuffer, rnd) {
    this.ctx = ctx;
    this.dest = dest;
    this.t0 = t0;
    this.noiseBuffer = noiseBuffer;
    this.rnd = rnd;
    this.end = t0;
  }

  /** Exponentially ramp `param` through `values`, spread evenly over [s, s + dur]. */
  curve(param, values, s, dur) {
    param.setValueAtTime(values[0], s);
    for (let k = 1; k < values.length; k++) {
      param.exponentialRampToValueAtTime(values[k], s + (dur * k) / (values.length - 1));
    }
  }

  /** Attack/decay amplitude envelope on a fresh gain node. */
  envelope(s, dur, vol, attack) {
    const g = this.ctx.createGain();
    const a = Math.min(attack, dur * 0.5);
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(vol, s + a);
    g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
    g.connect(this.dest);
    return g;
  }

  /**
   * Oscillator whose pitch glides through `freqs` (Hz, evenly spaced in time).
   * opts: delay, attack, lowpass/bandpass (Hz or [Hz,…] sweep), q, vibrato [rateHz, depthHz].
   */
  tone(type, freqs, dur, vol, opts = {}) {
    const { ctx } = this;
    const s = this.t0 + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = type;
    this.curve(osc.frequency, freqs, s, dur);
    let node = osc;
    const cutoff = opts.lowpass ?? opts.bandpass;
    if (cutoff !== undefined) {
      const f = ctx.createBiquadFilter();
      f.type = opts.lowpass !== undefined ? 'lowpass' : 'bandpass';
      f.Q.value = opts.q ?? 1;
      this.curve(f.frequency, Array.isArray(cutoff) ? cutoff : [cutoff, cutoff], s, dur);
      node.connect(f);
      node = f;
    }
    node.connect(this.envelope(s, dur, vol, opts.attack ?? 0.004));
    const stop = s + dur + 0.03;
    if (opts.vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = opts.vibrato[0];
      depth.gain.value = opts.vibrato[1];
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(s);
      lfo.stop(stop);
    }
    osc.start(s);
    osc.stop(stop);
    this.end = Math.max(this.end, stop);
  }

  /** Burst of white noise through a filter that sweeps over `cutoff` = [from Hz, to Hz]. */
  noise(dur, vol, filterType, cutoff, q, opts = {}) {
    const { ctx } = this;
    const s = this.t0 + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.Q.value = q;
    this.curve(f.frequency, cutoff, s, dur);
    src.connect(f);
    f.connect(this.envelope(s, dur, vol, opts.attack ?? 0.003));
    const stop = s + dur + 0.03;
    src.start(s, this.rnd() * 0.5);
    src.stop(stop);
    this.end = Math.max(this.end, stop);
  }
}

export class Sfx {
  /**
   * @param {object} [opts]
   * @param {BaseAudioContext} [opts.context] use this context instead of creating one on the first gesture (tests, offline rendering)
   * @param {Storage|null} [opts.storage] where the mute flag lives
   */
  constructor({ context = null, storage = globalThis.localStorage } = {}) {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.rnd = mulberry32(0xC0FFEE);
    this.listener = { x: 0, z: 0, fx: 0, fz: -1 };
    this.last = {};  // sound → start time of the latest one
    this.live = {};  // sound → end times of voices still playing
    this.storage = storage;
    this.muted = false;
    try { this.muted = storage?.getItem(MUTE_KEY) === '1'; } catch { /* blocked */ }
    this.injected = !!context;
    if (context) {
      this.attach(context);
    } else if (typeof window !== 'undefined') {
      const unlock = () => this.unlock();
      for (const ev of ['pointerdown', 'pointerup', 'keydown', 'touchend']) {
        window.addEventListener(ev, unlock, { capture: true, passive: true });
      }
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.unlock(); });
    }
  }

  /** Create the context on first call (needs a user gesture), resume it if the browser suspended it. */
  unlock() {
    if (this.injected) return;
    if (!this.ctx) {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AC) return;
      try { this.attach(new AC({ latencyHint: 'interactive' })); } catch { return; }
    }
    if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') this.ctx.resume?.().catch?.(() => {});
  }

  /** Build the shared graph: voices → master gain → compressor → output. */
  attach(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER_VOLUME;
    // Dozens of overlapping sounds sum loud; the compressor keeps that from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    const len = Math.floor(ctx.sampleRate * 1.5);
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    const r = mulberry32(1234);
    for (let i = 0; i < len; i++) data[i] = r() * 2 - 1;
  }

  /** Where the player is and which way they face (horizontal view direction). Call once per frame. */
  setListener(x, z, fx, fz) {
    const l = this.listener;
    l.x = x; l.z = z; l.fx = fx; l.fz = fz;
  }

  toggleMute() {
    this.muted = !this.muted;
    try { this.storage?.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch { /* private mode */ }
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER_VOLUME, this.ctx.currentTime, 0.02);
    return this.muted;
  }

  /**
   * Play a sound. Pass x, z (metres) to position it in the world; leave them
   * undefined for interface sounds. `power` scales loudness (0..1+). `when` is
   * the start time on the context clock (default: now).
   * @returns {boolean} whether it started (false when muted, locked, or throttled)
   */
  play(name, x, z, power = 1, when) {
    const def = SOUNDS[name];
    const ctx = this.ctx;
    if (!def || !ctx || this.muted) return false;
    if (!this.injected && ctx.state !== 'running') return false;
    const t0 = when ?? ctx.currentTime + 0.005;
    if (t0 - (this.last[name] ?? -Infinity) < def.gap) return false;

    let gain = 1, pan = 0;
    if (x !== undefined && x !== null) ({ gain, pan } = spatial(this.listener, x, z));
    if (gain < 0.01) return false;

    // Drop finished voices, then enforce the per-sound and global caps.
    let total = 0;
    for (const k in this.live) {
      const arr = this.live[k];
      let w = 0;
      for (let i = 0; i < arr.length; i++) if (arr[i] > t0) arr[w++] = arr[i];
      arr.length = w;
      total += w;
    }
    const mine = (this.live[name] ??= []);
    if (mine.length >= def.max || total >= MAX_VOICES) return false;

    const out = ctx.createGain();
    out.gain.value = def.vol * gain * power;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      out.connect(panner);
      panner.connect(this.master);
    } else {
      out.connect(this.master);
    }
    const voice = new Voice(ctx, out, t0, this.noiseBuffer, this.rnd);
    def.build(voice, 0.92 + this.rnd() * 0.16, power);
    mine.push(voice.end);
    this.last[name] = t0;
    return true;
  }

  /** Turn one tick's simulation events into sounds. Call after every Game.tick (it clears them). */
  consume(events) {
    for (const e of events) {
      switch (e.kind) {
        // Multi-pellet / multi-zap shots mark all but one tracer quiet: one sound per volley.
        case 'shot': if (!e.quiet) this.play(e.sound ?? 'shot', e.x0, e.z0); break;
        case 'launch': this.play('launch', e.x, e.z); break;
        case 'splash': this.play('splash', e.x, e.z); break;
        case 'kill': this.play('kill', e.x, e.z); break;
        case 'drink': this.play('drink', e.x, e.z); break;
        case 'boom': this.play('boom', e.x, e.z); break;
        case 'windup': this.play(e.ram ? 'snort' : 'hawk', e.x, e.z); break;
        case 'bonk': this.play('bonk', e.x, e.z); break;
        case 'spit': this.play('spit', e.x1, e.z1); break;
        case 'destroyed': if (e.cause === 'bonk') this.play('wreck', e.x, e.z); break;
        case 'wave': this.play('wave'); break;
        // Positioned when the surprise has a place (an ambush), so you can hear which way to look.
        case 'surprise': this.play('wave', e.x, e.z); break;
        case 'lost': this.play('lost'); break;
      }
    }
  }
}
