// Audio-thread mixer for the sound effects. Loaded with audioWorklet.addModule
// (never imported by the page), so it runs on the browser's audio rendering
// thread: the main thread only posts "play sound k, variant v, at time t, with
// these channel gains", once per frame, and all the per-sample work happens
// here. The sounds themselves are pre-rendered into a bank by audio.js.
//
// `Mixer` is plain JS with no worklet globals so Node tests can import it. The
// processor is registered only when this file is evaluated inside a worklet.

/** Hard ceiling on simultaneous voices; audio.js enforces its own, lower cap. */
export const MIXER_VOICES = 64;

export class Mixer {
  /** @param {number} sampleRate output rate of the context */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.sounds = [];  // sounds[k][v] = Float32Array (mono)
    this.step = 1;     // bank samples per output sample
    // Voices as parallel arrays; swap-remove, so loops run backwards.
    this.n = 0;
    this.data = new Array(MIXER_VOICES).fill(null);
    this.pos = new Float64Array(MIXER_VOICES);
    this.start = new Float64Array(MIXER_VOICES);
    this.gl = new Float32Array(MIXER_VOICES);
    this.gr = new Float32Array(MIXER_VOICES);
  }

  /** @param {Float32Array[][]} sounds bank, indexed [sound][variant] @param {number} rate bank sample rate */
  setBank(sounds, rate) {
    this.sounds = sounds;
    this.step = rate / this.sampleRate;
  }

  /** Queue a voice to start at output frame `startFrame` (late ones start at once). */
  add(k, v, startFrame, gl, gr) {
    const data = this.sounds[k]?.[v];
    if (!data || this.n >= MIXER_VOICES) return false;
    const i = this.n++;
    this.data[i] = data;
    this.pos[i] = 0;
    this.start[i] = startFrame;
    this.gl[i] = gl;
    this.gr[i] = gr;
    return true;
  }

  /** Apply a batch posted by audio.js: [k, v, startTime, gl, gr] repeated. */
  addBatch(list) {
    for (let j = 0; j + 4 < list.length; j += 5) {
      this.add(list[j], list[j + 1], Math.round(list[j + 2] * this.sampleRate), list[j + 3], list[j + 4]);
    }
  }

  /**
   * Mix every live voice into L and R (overwritten) for `frames` samples starting at output frame `frame0`.
   * Bank samples are read at `step` per output sample, linearly interpolated (exact copy when step is 1).
   */
  process(L, R, frame0, frames) {
    L.fill(0, 0, frames);
    R.fill(0, 0, frames);
    const step = this.step;
    for (let i = this.n - 1; i >= 0; i--) {
      const d = this.data[i], len = d.length, gl = this.gl[i], gr = this.gr[i];
      let s = Math.max(0, Math.min(frames, this.start[i] - frame0));
      let p = this.pos[i];
      if (step === 1) {
        let q = p | 0;
        for (; s < frames && q < len; s++, q++) { const x = d[q]; L[s] += x * gl; R[s] += x * gr; }
        p = q;
      } else {
        const last = len - 1;
        for (; s < frames && p < last; s++, p += step) {
          const q = p | 0, f = p - q, x = d[q] + (d[q + 1] - d[q]) * f;
          L[s] += x * gl; R[s] += x * gr;
        }
        if (p >= last) p = len;
      }
      this.pos[i] = p;
      if (p >= len) this.remove(i);
    }
  }

  remove(i) {
    const j = --this.n;
    this.data[i] = this.data[j]; this.pos[i] = this.pos[j]; this.start[i] = this.start[j];
    this.gl[i] = this.gl[j]; this.gr[i] = this.gr[j];
    this.data[j] = null;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('goofytd-sfx', class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.mixer = new Mixer(sampleRate);
      this.port.onmessage = ({ data }) => {
        if (data.bank) this.mixer.setBank(data.bank, data.rate);
        if (data.play) this.mixer.addBatch(data.play);
      };
    }

    process(_inputs, outputs) {
      const out = outputs[0];
      const L = out[0], R = out[1] ?? out[0];
      this.mixer.process(L, R, currentFrame, L.length);
      return true;
    }
  });
}
