// Invite and reply codes: a WebRTC session description squeezed into text a
// player can paste into a chat app. There's no signalling server, so the two
// browsers swap these by hand (or via an invite link). No ICE servers are used
// either: only local-network addresses go in the code, which is what keeps
// co-op LAN-only. Pure (CompressionStream, TextEncoder, btoa), so Node tests it.

/** Version prefix, then 'o' (host's offer) or 'a' (joiner's answer). */
export const SIGNAL_PREFIX = 'MOO1';
const CODE_RE = new RegExp(`${SIGNAL_PREFIX}([oa])([A-Za-z0-9_-]+)`);

export function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * Drop SDP lines a data-channel-only session doesn't need, to shorten the code.
 * Only attributes both Chrome and Firefox treat as optional.
 */
export function trimSdp(sdp) {
  return sdp.split(/\r?\n/)
    .filter((l) => l && !/^a=(extmap-allow-mixed|msid-semantic|ice-options)/.test(l))
    .join('\r\n') + '\r\n';
}

/** @param {'o'|'a'} kind @param {string} sdp */
export async function encodeSignal(kind, sdp) {
  const raw = new TextEncoder().encode(trimSdp(sdp));
  const packed = typeof CompressionStream === 'function' ? await pipe(raw, new CompressionStream('deflate-raw')) : raw;
  return `${SIGNAL_PREFIX}${kind}${toBase64Url(packed)}`;
}

/**
 * Find a code in pasted text (a bare code, an invite link, or a chat message
 * that wraps it across lines). Returns { kind, sdp } or null.
 */
export async function decodeSignal(text) {
  const m = CODE_RE.exec(String(text).replace(/\s+/g, ''));
  if (!m) return null;
  try {
    const bytes = fromBase64Url(m[2]);
    const raw = typeof DecompressionStream === 'function' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
    const sdp = new TextDecoder().decode(raw);
    return sdp.startsWith('v=0') ? { kind: m[1], sdp } : null;
  } catch {
    return null;
  }
}

/** Does this description carry any address to connect to? (No network = no candidates.) */
export function hasCandidates(sdp) { return /^a=candidate:/m.test(sdp); }
