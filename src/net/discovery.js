// Finding a co-op game without pasting codes. Hosts and joiners meet on relay
// "rooms" (relay.js topics):
//   - the network room: everyone behind the same router shares one public IP
//     (peer.js publicNetworkId), so its hash is a room only that network's
//     farmers land in. Farms there show up on the join screen by themselves.
//   - the code room: a 4-character room code the host shows (e.g. K7QM), for
//     when the network room can't be worked out or two networks share an IP.
// Budget: the public relay allows ~250 messages a day per public IP, shared
// by the whole network, so nothing here repeats on a timer. A joiner seeks
// once when its subscription opens; a host announces when it starts and
// answers seeks. A join is then 3 messages (join, offer, answer).
// Messages ({ v: 1, t, from, to?, ... }):
//   joiner: seek                     who's hosting?          (once per subscription)
//   host:   host {name, players, max} here I am             (on seek, and when it starts)
//   joiner: join {to, name}          let me in
//   host:   offer {to, code}         invite (signal.js code; a fresh WebRTC offer per joiner)
//   joiner: answer {to, code}        reply code
//   host:   nope {to, why}           full / already started
//   host:   bye                      stopped hosting
// Pure: the relay and the WebRTC calls are injected, so Node tests run it.

export const PROTOCOL = 1;
/** A joiner gives up waiting for the host's invite after this long. */
export const OFFER_TIMEOUT_MS = 15000;
/** A host answers seeks in one room at most this often (ms). */
const REPLY_GAP_MS = 2000;
/** Invites a host keeps open at once (a spammy room can't make it build hundreds). */
export const MAX_PENDING = 3;
const PENDING_TTL_MS = 45000;

/** Why the relay refused to carry a message, in farmer words. */
export function relayTrouble(relay) {
  return relay?.error === 'limit'
    ? 'The free matchmaking server has hit its daily limit for your network (it resets within a day). Use an invite link instead.'
    : 'Can\'t reach matchmaking. Check your connection, or use an invite link.';
}
/** Room code alphabet: no 0/O, 1/I/L, so it reads out loud and types cleanly. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export function randomId(n = 8) {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

export function newRoomCode() {
  const a = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(a, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** What someone typed → a room code, or null. Forgives case, spaces and dashes. */
export function normalizeCode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== CODE_LENGTH) return null;
  for (const ch of clean) if (!CODE_ALPHABET.includes(ch)) return null;
  return clean;
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Relay topic for a room: 'net' + public network id, or 'code' + room code. Not reversible. */
export async function roomTopic(kind, key) {
  return `goofytd-${kind[0]}${(await sha256Hex(`goofytd/v${PROTOCOL}/${kind}/${key}`)).slice(0, 24)}`;
}

const valid = (m) => m && m.v === PROTOCOL && typeof m.t === 'string' && typeof m.from === 'string' && m.from.length <= 16;

/**
 * Host side: answers seekers, and turns join requests into WebRTC links.
 * opts: relay, topics, info() -> { name, players, max, open, why? },
 *       createInvite() -> { code, accept(reply) -> Promise<link>, cancel() },
 *       onLink(link), onState(state), onError(err)
 */
export class HostBeacon {
  constructor(opts) {
    this.o = opts;
    this.id = opts.id ?? randomId();
    this.pending = new Map(); // joiner id -> { inv, timer }
    this.sub = null;
    this.lastReply = new Map(); // topic -> ms
  }

  start() {
    const { relay, topics } = this.o;
    this.sub = relay.listen(topics, (topic, m) => this.onMessage(topic, m), (s) => {
      this.o.onState?.(s);
      if (s === 'open') for (const t of topics) this.announce(t);
    });
  }

  async announce(topic) {
    const i = this.o.info();
    if (!i.open) return;
    this.lastReply.set(topic, Date.now());
    const ok = await this.o.relay.send(topic, { v: PROTOCOL, t: 'host', from: this.id, name: i.name, players: i.players, max: i.max });
    if (!ok) this.o.onError?.(new Error(relayTrouble(this.o.relay)));
  }

  async onMessage(topic, m) {
    if (!valid(m) || m.from === this.id) return;
    if (m.t === 'seek') {
      // Several joiners seeking at once get one reply between them.
      if (Date.now() - (this.lastReply.get(topic) ?? 0) > REPLY_GAP_MS) this.announce(topic);
      return;
    }
    if (m.to !== this.id) return;
    if (m.t === 'join') {
      const i = this.o.info();
      if (!i.open || this.pending.size >= MAX_PENDING) {
        this.o.relay.send(topic, { v: PROTOCOL, t: 'nope', from: this.id, to: m.from, why: i.open ? 'the host is busy, try again' : (i.why ?? 'the farm is closed') });
        return;
      }
      if (this.pending.has(m.from)) return;
      const slot = { inv: null, timer: 0 };
      this.pending.set(m.from, slot);
      try {
        slot.inv = await this.o.createInvite();
      } catch (e) {
        this.pending.delete(m.from);
        this.o.onError?.(e);
        return;
      }
      if (this.pending.get(m.from) !== slot) { slot.inv.cancel(); return; } // stopped meanwhile
      slot.timer = setTimeout(() => this.drop(m.from), PENDING_TTL_MS);
      if (!await this.o.relay.send(topic, { v: PROTOCOL, t: 'offer', from: this.id, to: m.from, code: slot.inv.code })) {
        if (this.pending.get(m.from) === slot) this.drop(m.from);
        this.o.onError?.(new Error(relayTrouble(this.o.relay)));
      }
    } else if (m.t === 'answer' && typeof m.code === 'string') {
      const slot = this.pending.get(m.from);
      if (!slot?.inv) return;
      clearTimeout(slot.timer);
      this.pending.delete(m.from);
      try {
        this.o.onLink(await slot.inv.accept(m.code));
      } catch (e) {
        this.o.onError?.(e);
      }
    }
  }

  drop(id) {
    const slot = this.pending.get(id);
    if (!slot) return;
    clearTimeout(slot.timer);
    slot.inv?.cancel();
    this.pending.delete(id);
  }

  /** Stop hosting: tell anyone looking, and close unanswered invites. */
  stop() {
    if (!this.sub) return;
    for (const t of this.o.topics) this.o.relay.send(t, { v: PROTOCOL, t: 'bye', from: this.id });
    for (const id of [...this.pending.keys()]) this.drop(id);
    this.sub.close();
    this.sub = null;
  }
}

/**
 * Joiner side: lists farms in its rooms and connects to one.
 * opts: relay, topics, name, acceptInvite(code) -> { code, link }, onChange(), onState(state),
 *       onTrouble(text) (the relay refused a seek), offerTimeoutMs?
 */
export class Finder {
  constructor(opts) {
    this.o = opts;
    this.id = opts.id ?? randomId();
    /** host id -> { id, name, players, max, topic, seen } */
    this.hosts = new Map();
    this.waiting = null; // { host, resolve, reject, timer }
    this.sub = null;
  }

  start() {
    const { relay, topics } = this.o;
    this.sub = relay.listen(topics, (topic, m) => this.onMessage(topic, m), (s) => {
      this.o.onState?.(s);
      if (s === 'open') this.seek();
    });
  }

  /** Ask who's hosting. Once per (re)opened subscription: hosts that start later announce themselves. */
  async seek() {
    let ok = true;
    for (const t of this.o.topics) ok = await this.o.relay.send(t, { v: PROTOCOL, t: 'seek', from: this.id }) && ok;
    if (!ok) this.o.onTrouble?.(relayTrouble(this.o.relay));
  }

  /** Forget a farm (it didn't answer: closed without saying bye). */
  forget(id) {
    if (this.hosts.delete(id)) this.o.onChange?.();
  }

  onMessage(topic, m) {
    if (!valid(m) || m.from === this.id) return;
    if (m.t === 'host') {
      const players = Number.isInteger(m.players) ? m.players : 1;
      const max = Number.isInteger(m.max) ? m.max : 4;
      this.hosts.set(m.from, { id: m.from, name: String(m.name ?? 'Farmer').replace(/[<>&"']/g, '').slice(0, 16), players, max, topic, seen: Date.now() });
      this.o.onChange?.();
    } else if (m.t === 'bye') {
      if (this.hosts.delete(m.from)) this.o.onChange?.();
    } else if (m.to === this.id && this.waiting?.host === m.from) {
      const w = this.waiting;
      if (m.t === 'offer' && typeof m.code === 'string') { clearTimeout(w.timer); this.waiting = null; w.resolve(m.code); }
      if (m.t === 'nope') { clearTimeout(w.timer); this.waiting = null; w.reject(new Error(`Can't join: ${String(m.why ?? 'refused').slice(0, 60)}.`)); }
    }
  }

  /** Resolves with the first farm seen (for room codes), or rejects after `ms`. */
  firstHost(ms) {
    const first = () => this.hosts.values().next().value;
    if (first()) return Promise.resolve(first());
    return new Promise((resolve, reject) => {
      const prev = this.o.onChange;
      const t = setTimeout(() => { this.o.onChange = prev; reject(new Error('No farm with that code. Check it, and that the host is still in the lobby.')); }, ms);
      this.o.onChange = () => { prev?.(); const h = first(); if (h) { clearTimeout(t); this.o.onChange = prev; resolve(h); } };
    });
  }

  /** Ask farm `hostId` to let us in. Resolves with a link (await link.opened for the connection). */
  async connect(hostId) {
    const h = this.hosts.get(hostId);
    if (!h) throw new Error('That farm is gone.');
    if (this.waiting) throw new Error('Already joining a farm.');
    const offer = new Promise((resolve, reject) => {
      this.waiting = {
        host: hostId, resolve, reject,
        timer: setTimeout(() => {
          this.waiting = null;
          this.forget(hostId);
          reject(new Error('That farm didn\'t answer. It may have closed: ask the host to open it again.'));
        }, this.o.offerTimeoutMs ?? OFFER_TIMEOUT_MS),
      };
    });
    if (!await this.o.relay.send(h.topic, { v: PROTOCOL, t: 'join', from: this.id, to: hostId, name: this.o.name })) {
      if (this.waiting?.host === hostId) { clearTimeout(this.waiting.timer); this.waiting = null; }
      throw new Error(relayTrouble(this.o.relay));
    }
    const r = await this.o.acceptInvite(await offer);
    if (!await this.o.relay.send(h.topic, { v: PROTOCOL, t: 'answer', from: this.id, to: hostId, code: r.code })) {
      r.link.close?.();
      throw new Error(relayTrouble(this.o.relay));
    }
    return r.link;
  }

  stop() {
    if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting = null; }
    this.sub?.close();
    this.sub = null;
  }
}
