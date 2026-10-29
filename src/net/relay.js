// Matchmaking relay: a tiny public pub/sub service that carries the WebRTC
// handshake (a few small messages) so farmers don't paste codes. Gameplay
// never goes through it: once the handshake is done the browsers talk
// directly, and only over the local network (peer.js uses no ICE servers).
//
// Default: ntfy.sh (free, no account, CORS-enabled). Subscribe with a
// WebSocket on /<topic,topic>/ws, publish with a plain-text POST (a "simple"
// request, so no CORS preflight). `?relay=<base url>` swaps the server (e.g. a
// self-hosted ntfy, or a local stand-in for tests); `?relay=off` disables it.
//
// Interface (MemoryRelay in the tests implements the same):
//   listen(topics, onMessage(topic, obj), onState('open'|'down')) -> { close() }
//   send(topic, obj) -> Promise<boolean>

export const DEFAULT_RELAY = 'https://ntfy.sh';
/** Reconnect a dropped subscription after this long (ms). */
const RETRY_MS = 3000;
/** ntfy turns bigger messages into attachments; ours are well under 1 KB. */
const MAX_MESSAGE = 3500;

export class NtfyRelay {
  constructor(base = DEFAULT_RELAY) {
    this.base = String(base).replace(/\/+$/, '');
  }

  listen(topics, onMessage, onState = () => {}) {
    const url = `${this.base.replace(/^http/, 'ws')}/${topics.join(',')}/ws`;
    let ws = null, closed = false, retry = 0;
    const open = () => {
      try { ws = new WebSocket(url); } catch { onState('down'); retry = setTimeout(open, RETRY_MS); return; }
      ws.onopen = () => onState('open');
      ws.onmessage = (e) => {
        let ev, m;
        try { ev = JSON.parse(e.data); } catch { return; }
        if (ev?.event !== 'message' || typeof ev.message !== 'string') return;
        try { m = JSON.parse(ev.message); } catch { return; }
        if (m && typeof m === 'object') onMessage(ev.topic, m);
      };
      ws.onclose = () => {
        if (closed) return;
        onState('down');
        retry = setTimeout(open, RETRY_MS);
      };
    };
    open();
    return {
      close() {
        closed = true;
        clearTimeout(retry);
        try { ws?.close(); } catch { /* already gone */ }
      },
    };
  }

  async send(topic, obj) {
    const body = JSON.stringify(obj);
    if (body.length > MAX_MESSAGE) return false;
    try {
      // cache=no: deliver to whoever is listening now, keep nothing on the server.
      const r = await fetch(`${this.base}/${topic}?cache=no&firebase=no`, { method: 'POST', body });
      return r.ok;
    } catch {
      return false;
    }
  }
}

/** The relay to use on this page: ?relay=off / ?relay=<url> / ntfy.sh. Null when disabled. */
export function relayFromParams(params) {
  const v = params.get('relay');
  if (v === 'off') return null;
  return new NtfyRelay(v || DEFAULT_RELAY);
}
