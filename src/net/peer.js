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
