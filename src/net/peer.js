// WebRTC links for LAN co-op. Browser only (RTCPeerConnection); the rest of
// src/net is pure and tested in Node with fake links.
//
// No ICE servers (no STUN, no TURN): browsers only offer their local-network
// addresses (Chrome as mDNS ".local" names), so two farmers connect when
// they're on the same network and not otherwise. No signalling server either:
// the host's invite code and the joiner's reply code carry the session
// descriptions, swapped by hand (signal.js).
//
// Two data channels, negotiated up front on fixed ids so neither side waits
// for the other to open them: 0 reliable + ordered (commands, lockstep ticks,
// lobby) and 1 unordered with no retransmits (farmer positions: a late one is useless).

import { decodeSignal, encodeSignal, hasCandidates } from './signal.js';

const RTC_CONFIG = { iceServers: [] };
/** Wait at most this long for local address gathering (it's usually ~100 ms with no servers). */
const GATHER_MS = 3000;
/** Give up on a connection that hasn't opened by then. */
export const CONNECT_MS = 20000;
/** Skip a position update rather than queue one behind a backlog. */
const FAST_BUFFER_MAX = 16384;

export class LinkError extends Error {}

function makeLink(pc) {
  const rel = pc.createDataChannel('sim', { negotiated: true, id: 0, ordered: true });
  const fast = pc.createDataChannel('pos', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
  let closed = false;
  // Messages that arrive before anyone listens (the joiner's hello can beat the
  // host wiring the link into its session) wait here instead of being dropped.
  let handler = null;
  const early = [];
  const link = {
    pc,
    get onmessage() { return handler; },
    set onmessage(fn) {
      handler = fn;
      for (const [m, f] of early.splice(0)) fn(m, f);
    },
    onclose: () => {},
    send(m) { if (rel.readyState === 'open') rel.send(JSON.stringify(m)); },
    sendFast(m) { if (fast.readyState === 'open' && fast.bufferedAmount < FAST_BUFFER_MAX) fast.send(JSON.stringify(m)); },
    close() { shut(); pc.close(); },
  };
  const shut = () => {
    if (closed) return;
    closed = true;
    link.onclose();
  };
  const parse = (data, isFast) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (handler) handler(m, isFast);
    else if (early.length < 256) early.push([m, isFast]);
  };
  rel.onmessage = (e) => parse(e.data, false);
  fast.onmessage = (e) => parse(e.data, true);
  rel.onclose = shut;
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') shut();
  });
  link.opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LinkError("Couldn't connect. Are you both on the same Wi-Fi?")), CONNECT_MS);
    rel.addEventListener('open', () => { clearTimeout(timer); resolve(link); }, { once: true });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') { clearTimeout(timer); reject(new LinkError('Connection failed. Are you both on the same Wi-Fi?')); }
    });
  });
  link.opened.catch(() => {}); // callers that never await it shouldn't log an unhandled rejection
  return link;
}

function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function localCode(pc, kind) {
  await gathered(pc);
  const sdp = pc.localDescription.sdp;
  if (!hasCandidates(sdp)) throw new LinkError('No network found. Connect to Wi-Fi (or a hotspot) first.');
  return encodeSignal(kind, sdp);
}

/**
 * Host side. Returns { code, link, accept(replyText), cancel() }: send `code`
 * to the joiner, paste their reply into accept(), then await link.opened.
 */
export async function createInvite() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const link = makeLink(pc);
  try {
    await pc.setLocalDescription(await pc.createOffer());
    const code = await localCode(pc, 'o');
    return {
      code,
      link,
      async accept(text) {
        const d = await decodeSignal(text);
        if (!d) throw new LinkError("That isn't a reply code. It starts with MOO1a.");
        if (d.kind !== 'a') throw new LinkError('That is an invite code. Paste the REPLY code your friend sends back.');
        await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        return link.opened;
      },
      cancel() { pc.close(); },
    };
  } catch (e) {
    pc.close();
    throw e;
  }
}

/** Joiner side: turn the host's invite into a reply code. Returns { code, link }; await link.opened. */
export async function acceptInvite(text) {
  const d = await decodeSignal(text);
  if (!d) throw new LinkError("That isn't an invite code. It starts with MOO1o (or paste the whole invite link).");
  if (d.kind !== 'o') throw new LinkError("That's a reply code. You need the INVITE code from the host.");
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const link = makeLink(pc);
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    return { code: await localCode(pc, 'a'), link };
  } catch (e) {
    pc.close();
    throw e instanceof LinkError ? e : new LinkError(`Couldn't read the invite (${e.message}).`);
  }
}

export const lanSupported = () => typeof RTCPeerConnection === 'function';

/** Public STUN servers, used only to learn this network's public address (never for the game link). */
const STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

/**
 * From an ICE candidate line, the address a STUN server saw ("srflx"), or null.
 * IPv6 is cut to its /64 prefix: every device on a home network has its own
 * IPv6 address but they share the prefix. Pure; tested.
 */
export function networkIdFromCandidate(line) {
  const f = String(line).replace(/^a=/, '').split(/\s+/);
  if (f.length < 8 || f[6] !== 'typ' || f[7] !== 'srflx') return null;
  const addr = f[4];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return addr;
  if (/^[0-9a-f:]+$/i.test(addr) && addr.includes(':')) {
    // Expand "::" so 2001:db8::1 and 2001:0db8:0:0::2 compare equal.
    const [head, tail] = addr.split('::');
    const h = head ? head.split(':') : [];
    const t = tail === undefined ? [] : tail ? tail.split(':') : [];
    const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    if (groups.length !== 8) return null;
    return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
  }
  return null;
}

/**
 * This network's public identity (its public IPv4, or IPv6 /64), via STUN.
 * Farmers behind the same router get the same answer. Null if STUN is blocked
 * or slow (then only room codes and invite links work).
 */
export async function publicNetworkId(timeoutMs = 2500) {
  if (!lanSupported()) return null;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });
  try {
    pc.createDataChannel('probe');
    const found = new Promise((resolve) => {
      let v6 = null;
      const done = (v) => { clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => done(v6), timeoutMs);
      pc.addEventListener('icecandidate', (e) => {
        if (!e.candidate) { done(v6); return; }
        const id = networkIdFromCandidate(e.candidate.candidate);
        if (!id) return;
        if (id.endsWith('/64')) v6 ??= id; // prefer IPv4: it's what a whole NAT'd home shares
        else done(id);
      });
    });
    await pc.setLocalDescription(await pc.createOffer());
    return await found;
  } catch {
    return null;
  } finally {
    pc.close();
  }
}
