// Host-relayed lockstep. The match itself (cows, towers, money, milk) is the
// deterministic sim in src/sim/, so machines never send world state: they run
// the same commands at the same ticks and arrive at the same game.
//
//  - local:  solo play. Commands queue and apply at the start of the next tick.
//  - host:   owns the clock. Each tick it takes every command that arrived
//            (its own and the clients'), runs it, and sends "tick N had these
//            commands" to everyone, batched once per animation frame.
//  - client: never ticks ahead of the host. It runs the host's ticks in order,
//            as fast as its own fixed clock allows, catching up when a backlog
//            builds. On a LAN that's a few ms behind the host.
//
// Every HASH_EVERY ticks the host includes stateHash(game); a client that
// computes something else has desynced (it says so; resync isn't implemented).
// Pure: no DOM, no three.js, no WebRTC (links are injected), so it runs in Node tests.

import { HOST_ONLY, sanitizeCommand, stateHash } from '../sim/commands.js';

export const HASH_EVERY = 64;
/** A client keeps this many host ticks in hand to ride out network jitter. */
export const CLIENT_BUFFER = 3;
/** Never run more than this many sim ticks in one frame (the clock caps itself at 8). */
export const MAX_CATCHUP = 16;

export class Lockstep {
  /**
   * @param {{ role: 'local'|'host'|'client', me?: number, send?: (msg: object) => void }} opts
   *   send: client → host (commands), host → all clients (frames).
   */
  constructor({ role, me = 0, send = () => {} }) {
    this.role = role;
    this.me = me;
    this.send = send;
    /** Index of the next tick to run. */
    this.tick = 0;
    /** host/local: commands waiting for the next tick. */
    this.pending = [];
    /** client: host ticks received but not run yet: { cmds, hash }. */
    this.queue = [];
    /** host: ticks run since the last flush, as one outgoing message. */
    this.out = null;
    /** Tick at which this client first disagreed with the host (null = in sync). */
    this.desyncAt = null;
  }

  /** Ask for a command to happen (from this machine's player). Returns false if it's malformed. */
  submit(cmd) {
    const c = sanitizeCommand(cmd);
    if (!c) return false;
    if (this.role === 'client') {
      if (HOST_ONLY.has(c.k)) return false;
      this.send({ t: 'cmd', c });
      return true;
    }
    c.p = this.me;
    this.pending.push(c);
    return true;
  }

  /** Host: a command from client `p`. The host decides who sent it, not the message. */
  receiveCommand(p, raw) {
    if (this.role !== 'host') return;
    const c = sanitizeCommand(raw);
    if (!c || HOST_ONLY.has(c.k)) return;
    c.p = p;
    this.pending.push(c);
  }

  /** Client: a batch of ticks from the host: { t: 'f', s, n, c: [[offset, cmds]], h: [[offset, hash]] }. */
  receiveFrames(m) {
    if (this.role !== 'client') return;
    const s = m.s, n = m.n;
    if (!Number.isInteger(s) || !Number.isInteger(n) || n < 0 || n > 4096) return;
    // A reliable ordered channel never skips; if it did, nothing after this can be trusted.
    if (s !== this.tick + this.queue.length) { this.desyncAt ??= s; return; }
    const base = this.queue.length;
    for (let k = 0; k < n; k++) this.queue.push({ cmds: [], hash: null });
    for (const [off, cmds] of m.c ?? []) {
      const f = this.queue[base + off];
      if (!f || !Array.isArray(cmds)) continue;
      for (const raw of cmds) {
        const c = sanitizeCommand(raw);
        if (!c) continue;
        c.p = Number.isInteger(raw.p) ? raw.p : -1;
        f.cmds.push(c);
      }
    }
    for (const [off, hash] of m.h ?? []) {
      const f = this.queue[base + off];
      if (f) f.hash = hash;
    }
  }

  /** Ticks received and waiting (client). */
  get backlog() { return this.queue.length; }

  /**
   * How many sim ticks to run this frame, given how many the fixed clock
   * allows. Host and local follow the clock. A client can only run ticks it
   * has; it runs a few extra when it's falling behind and holds a couple back
   * so a late packet doesn't stall it. `scale` is the match's fast-forward
   * setting: the clock already gives `scale`x the ticks, and the catch-up cap
   * grows with it so a fast-forwarding client can keep up with its host.
   */
  ticksToRun(clockTicks, scale = 1) {
    if (this.role !== 'client') return clockTicks;
    const have = this.queue.length;
    let n = clockTicks;
    const surplus = have - n - CLIENT_BUFFER;
    if (surplus > 0) n += Math.ceil(surplus / 2);
    return Math.max(0, Math.min(n, have, MAX_CATCHUP * scale));
  }

  /** The commands for the next tick (removing them from the queue). Call ticksToRun() first. */
  beginTick() {
    if (this.role === 'client') {
      this.current = this.queue.shift() ?? { cmds: [], hash: null };
      return this.current.cmds;
    }
    const cmds = this.pending;
    this.pending = [];
    if (this.role === 'host') {
      this.out ??= { t: 'f', s: this.tick, n: 0, c: [], h: [] };
      if (cmds.length) this.out.c.push([this.out.n, cmds]);
    }
    return cmds;
  }

  /** After game.tick(): record (host) or check (client) the state fingerprint. */
  endTick(game) {
    const tick = this.tick++;
    if (this.role === 'host') {
      if (tick % HASH_EVERY === 0) this.out.h.push([this.out.n, stateHash(game)]);
      this.out.n++;
    } else if (this.role === 'client') {
      const want = this.current?.hash;
      if (want != null && this.desyncAt === null && stateHash(game) !== want) this.desyncAt = tick;
      this.current = null;
    }
  }

  /** Host: send the ticks run since the last flush. Call once per frame. */
  flush() {
    if (this.role !== 'host' || !this.out) return;
    const m = this.out;
    this.out = null;
    if (!m.c.length) delete m.c;
    if (!m.h.length) delete m.h;
    this.send(m);
  }
}
