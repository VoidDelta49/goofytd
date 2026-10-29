// LAN co-op sessions: the lobby, who's playing, and the messages between the
// host and each joiner (a star: joiners only talk to the host, which relays).
// Links are injected ({ send, sendFast, close, onmessage, onclose }); in the
// browser they're WebRTC data channels (peer.js), in tests a fake pair.
// Pure: no DOM, no three.js.
//
// Reliable, ordered messages:
//   joiner → host  { t:'hello', name }            first thing after connecting
//   host → joiner  { t:'welcome', you }           your player id
//   host → all     { t:'lobby', players }         lobby changed
//   host → all     { t:'start', seed, map, players }
//   joiner → host  { t:'cmd', c }                 a command (see sim/commands.js)
//   host → all     { t:'f', s, n, c?, h? }        lockstep ticks (lockstep.js)
//   host → all     { t:'left', id }
//   host → joiner  { t:'full', why }              lobby full / game already running
// Unreliable: { t:'p', id?, q, x, y, z, yw, pt, c } farmer positions (track.js).

import { Lockstep } from './lockstep.js';
import { Track, packPos } from './track.js';

export const MAX_FARMERS = 4;
/** A refused joiner's link is closed this long after telling them why (ms). */
const REFUSE_CLOSE_MS = 3000;
/** Shirt colours, one per lobby slot (the host is slot 0). */
/** Red, orange, green, purple: none of them blends into the denim overalls. */
export const FARMER_COLORS = [0xd9433b, 0xe8862a, 0x3fae4b, 0xb05bd9];

/** Names come from other machines: keep them short and printable. */
export function cleanName(name) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f<>&"']/g, '').trim().slice(0, 16);
  return s || 'Farmer';
}

class Session {
  constructor(name, now) {
    this.name = cleanName(name);
    this.now = now;
    /** [{ id, name, color }] in join order; color is a FARMER_COLORS index. */
    this.players = [];
    /** Other farmers: id -> { id, name, color, track }. */
    this.remotes = new Map();
    this.lockstep = null;
    this.started = false;
    this.seq = 0;
    /** Lobby / player list changed. */
    this.onChange = () => {};
    /** { kind: 'left'|'joined'|'hostLost'|'full', name?, why? } */
    this.onEvent = () => {};
    /** Joiner only: the host started the match ({ seed, map, players }). */
    this.onStart = () => {};
  }

  get playing() { return this.started; }

  syncRemotes() {
    for (const p of this.players) {
      if (p.id === this.me) continue;
      const r = this.remotes.get(p.id);
      if (r) { r.name = p.name; r.color = p.color; } else this.remotes.set(p.id, { ...p, track: new Track() });
    }
    for (const id of this.remotes.keys()) if (!this.players.some((p) => p.id === id)) this.remotes.delete(id);
  }

  remotePos(id, m) {
    this.remotes.get(id)?.track.push(this.now(), m);
  }
}

export class HostSession extends Session {
  constructor(name, now = () => performance.now()) {
    super(name, now);
    this.role = 'host';
    this.me = 0;
    this.players = [{ id: 0, name: this.name, color: 0 }];
    /** link -> player id (null until it says hello). */
    this.links = new Map();
    this.nextId = 1;
  }

  get full() { return this.players.length >= MAX_FARMERS; }

  /** A joiner's link just opened. */
  addLink(link) {
    this.links.set(link, null);
    link.onmessage = (m, fast) => this.onMessage(link, m, fast);
    link.onclose = () => this.drop(link);
  }

  onMessage(link, m, fast) {
    if (!m || typeof m !== 'object') return;
    const id = this.links.get(link);
    if (id === undefined) return;
    if (id === null) {
      if (m.t !== 'hello' || fast) return;
      if (this.started || this.full) {
        link.send({ t: 'full', why: this.started ? 'the game already started' : 'the lobby is full' });
        // Closing now could drop that message before it's sent: the joiner hangs up
        // when it reads it, and this is only the fallback.
        this.links.delete(link);
        setTimeout(() => link.close(), REFUSE_CLOSE_MS);
        return;
      }
      const used = new Set(this.players.map((p) => p.color));
      const color = FARMER_COLORS.findIndex((_, k) => !used.has(k));
      const p = { id: this.nextId++, name: cleanName(m.name), color };
      this.players.push(p);
      this.links.set(link, p.id);
      link.send({ t: 'welcome', you: p.id });
      this.syncRemotes();
      this.broadcast({ t: 'lobby', players: this.players });
      this.onEvent({ kind: 'joined', name: p.name });
      this.onChange();
      return;
    }
    if (m.t === 'cmd' && !fast) this.lockstep?.receiveCommand(id, m.c);
    else if (m.t === 'p' && fast) {
      this.remotePos(id, m);
      this.broadcastFast({ ...m, id }, link);
    }
  }

  drop(link) {
    const id = this.links.get(link);
    if (id === undefined) return;
    this.links.delete(link);
    if (id === null) return;
    const p = this.players.find((q) => q.id === id);
    this.players = this.players.filter((q) => q.id !== id);
    this.syncRemotes();
    this.broadcast({ t: 'left', id });
    if (this.started) this.lockstep.submit({ k: 'players', n: this.players.length });
    else this.broadcast({ t: 'lobby', players: this.players });
    this.onEvent({ kind: 'left', name: p?.name ?? 'A farmer' });
    this.onChange();
  }

  /** Start the match for everyone. Returns what the host's own game needs. */
  start(seed, map) {
    this.started = true;
    this.lockstep = new Lockstep({ role: 'host', me: 0, send: (m) => this.broadcast(m) });
    const players = this.players;
    this.broadcast({ t: 'start', seed, map, players });
    this.onChange();
    return { seed, map, players };
  }

  broadcast(m, except = null) {
    for (const [link, id] of this.links) if (id !== null && link !== except) link.send(m);
  }

  broadcastFast(m, except = null) {
    for (const [link, id] of this.links) if (id !== null && link !== except) link.sendFast(m);
  }

  /** Tell everyone where the host's farmer is. */
  sendPos(state) { this.broadcastFast({ ...packPos(this.seq++, state), id: 0 }); }

  close() { for (const link of this.links.keys()) link.close(); this.links.clear(); }
}

export class JoinSession extends Session {
  /** @param link an open link to the host */
  constructor(name, link, now = () => performance.now()) {
    super(name, now);
    this.role = 'client';
    this.me = null;
    this.link = link;
    this.hostLost = false;
    link.onmessage = (m, fast) => this.onMessage(m, fast);
    link.onclose = () => {
      if (this.hostLost) return;
      this.hostLost = true;
      this.onEvent({ kind: 'hostLost' });
      this.onChange();
    };
    link.send({ t: 'hello', name: this.name });
  }

  onMessage(m, fast) {
    if (!m || typeof m !== 'object') return;
    if (fast) {
      if (m.t === 'p' && Number.isInteger(m.id)) this.remotePos(m.id, m);
      return;
    }
    switch (m.t) {
      case 'welcome': this.me = m.you; break;
      case 'lobby': this.setPlayers(m.players); break;
      case 'start':
        if (this.started || this.me === null) return;
        this.setPlayers(m.players);
        this.started = true;
        this.lockstep = new Lockstep({ role: 'client', me: this.me, send: (c) => this.link.send(c) });
        this.onStart({ seed: m.seed >>> 0, map: String(m.map), players: this.players });
        break;
      case 'f': this.lockstep?.receiveFrames(m); return; // every frame: skip onChange
      case 'left': {
        const p = this.players.find((q) => q.id === m.id);
        this.setPlayers(this.players.filter((q) => q.id !== m.id));
        if (p) this.onEvent({ kind: 'left', name: p.name });
        break;
      }
      case 'full':
        this.hostLost = true; // our own hang-up, not the host vanishing
        this.link.close();
        this.onEvent({ kind: 'full', why: String(m.why ?? '').replace(/[<>&"']/g, '').slice(0, 60) });
        break;
      default: return;
    }
    this.onChange();
  }

  setPlayers(list) {
    if (!Array.isArray(list)) return;
    this.players = list.filter((p) => p && Number.isInteger(p.id))
      .map((p) => ({ id: p.id, name: cleanName(p.name), color: (p.color | 0) % FARMER_COLORS.length }));
    this.syncRemotes();
  }

  sendPos(state) { this.link.sendFast(packPos(this.seq++, state)); }

  close() { this.hostLost = true; this.link.close(); }
}
