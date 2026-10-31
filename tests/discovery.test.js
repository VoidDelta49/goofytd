// Co-op matchmaking: farms in the same room find each other with no codes
// pasted, room codes, refusals, and the public-network id parsing. Uses an
// in-memory relay and fake WebRTC calls; peer.js / relay.js network I/O is
// covered by the headless-browser run.
import { test, assert } from './harness.js';
import { Finder, HostBeacon, MAX_PENDING, CODE_ALPHABET, newRoomCode, normalizeCode, roomTopic } from '../src/net/discovery.js';
import { networkIdFromCandidate } from '../src/net/peer.js';
import { relayFromParams, NtfyRelay } from '../src/net/relay.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Pub/sub in memory with the relay interface. Delivery is async, like a real one. */
class MemoryRelay {
  constructor() { this.subs = new Set(); this.sent = []; this.refuse = false; this.error = null; }
  listen(topics, onMessage, onState = () => {}) {
    const sub = { topics: new Set(topics), onMessage };
    this.subs.add(sub);
    setTimeout(() => onState('open'), 0);
    return { close: () => this.subs.delete(sub) };
  }
  async send(topic, obj) {
    if (this.refuse) { this.error = 'limit'; return false; }
    this.error = null;
    const m = JSON.stringify(obj);
    this.sent.push({ topic, obj });
    setTimeout(() => { for (const s of [...this.subs]) if (s.topics.has(topic)) s.onMessage(topic, JSON.parse(m)); }, 1);
    return true;
  }
}

/** Fake WebRTC: an invite's accept(reply) resolves to a link if the reply answers that invite. */
let nextInvite = 1;
function fakeCreateInvite(log) {
  return async () => {
    const n = nextInvite++;
    const inv = {
      code: `MOO1o-${n}`,
      cancelled: false,
      async accept(reply) {
        if (reply !== `MOO1a-${n}`) throw new Error(`wrong reply ${reply}`);
        return { invite: n };
      },
      cancel() { inv.cancelled = true; },
    };
    log?.push(inv);
    return inv;
  };
}
async function fakeAcceptInvite(code) {
  const n = /^MOO1o-(\d+)$/.exec(code)?.[1];
  if (!n) throw new Error('bad invite');
  return { code: `MOO1a-${n}`, link: { joined: Number(n) } };
}

function host(relay, topics, info = {}) {
  const links = [];
  const st = { name: 'Hosty', players: 1, max: 4, open: true, ...info };
  const b = new HostBeacon({ relay, topics, info: () => st, createInvite: fakeCreateInvite(), onLink: (l) => links.push(l) });
  b.start();
  return { b, links, st };
}

function finder(relay, topics, name = 'Joe', extra = {}) {
  const f = new Finder({ relay, topics, name, acceptInvite: fakeAcceptInvite, ...extra });
  f.start();
  return f;
}

test('discovery: a farm in your network room shows up and you join it with one tap', async () => {
  const relay = new MemoryRelay();
  const room = await roomTopic('net', '203.0.113.7');
  const h = host(relay, [room]);
  const f = finder(relay, [room]);
  await tick(20);
  assert(f.hosts.size === 1, `found ${f.hosts.size} farms`);
  const farm = [...f.hosts.values()][0];
  assert(farm.name === 'Hosty' && farm.players === 1 && farm.max === 4, JSON.stringify(farm));
  const link = await f.connect(farm.id);
  await tick(20);
  assert(link.joined > 0 && h.links.length === 1 && h.links[0].invite === link.joined, 'link pair mismatch');
  assert(h.b.pending.size === 0, 'invite left pending');
  f.stop(); h.b.stop();
});

test('discovery: a host that starts later is seen without asking again, and its bye removes it', async () => {
  const relay = new MemoryRelay();
  const room = await roomTopic('net', '198.51.100.2');
  const f = finder(relay, [room]);
  await tick(20);
  assert(f.hosts.size === 0, 'phantom farm');
  const h = host(relay, [room]);
  await tick(20);
  assert(f.hosts.size === 1, 'late host not announced');
  h.b.stop();
  await tick(20);
  assert(f.hosts.size === 0, 'bye ignored');
  f.stop();
});

test('discovery: different networks and different codes never see each other', async () => {
  const relay = new MemoryRelay();
  const h = host(relay, [await roomTopic('net', '203.0.113.7'), await roomTopic('code', 'K7QM')]);
  const other = finder(relay, [await roomTopic('net', '203.0.113.8')]);
  const wrongCode = finder(relay, [await roomTopic('code', 'K7QN')]);
  const rightCode = finder(relay, [await roomTopic('code', 'K7QM')]);
  await tick(20);
  assert(other.hosts.size === 0 && wrongCode.hosts.size === 0, 'leaked across rooms');
  assert(rightCode.hosts.size === 1, 'room code did not find the farm');
  const farm = await rightCode.firstHost(100);
  assert(farm.name === 'Hosty', 'firstHost');
  let failed = false;
  await wrongCode.firstHost(30).catch(() => { failed = true; });
  assert(failed, 'firstHost should give up');
  for (const x of [other, wrongCode, rightCode]) x.stop();
  h.b.stop();
});

test('discovery: three farmers join the same farm at once', async () => {
  const relay = new MemoryRelay();
  const room = await roomTopic('code', 'ABCD');
  const h = host(relay, [room]);
  const fs = ['A', 'B', 'C'].map((n) => finder(relay, [room], n));
  await tick(20);
  const links = await Promise.all(fs.map((f) => f.connect([...f.hosts.keys()][0])));
  await tick(20);
  assert(new Set(links.map((l) => l.joined)).size === 3 && h.links.length === 3, `links ${h.links.length}`);
  fs.forEach((f) => f.stop()); h.b.stop();
});

test('discovery: a full or started farm says no, and a host never holds more than a few open invites', async () => {
  const relay = new MemoryRelay();
  const room = await roomTopic('code', 'FULL');
  const h = host(relay, [room]);
  const f = finder(relay, [room]);
  await tick(20);
  const id = [...f.hosts.keys()][0];
  h.st.open = false;
  h.st.why = 'the farm is full';
  let err = null;
  await f.connect(id).catch((e) => { err = e; });
  assert(err && /full/.test(err.message), `got ${err?.message}`);
  // Spam: joins that never answer.
  h.st.open = true;
  for (let k = 0; k < 10; k++) relay.send(room, { v: 1, t: 'join', from: `spam${k}`, to: h.b.id, name: 'x' });
  await tick(30);
  assert(h.b.pending.size === MAX_PENDING, `pending ${h.b.pending.size}`);
  f.stop(); h.b.stop();
  assert(h.b.pending.size === 0, 'stop left invites open');
});

test('discovery: junk on the relay is ignored', async () => {
  const relay = new MemoryRelay();
  const room = await roomTopic('net', 'x');
  const f = finder(relay, [room]);
  for (const junk of [null, 1, {}, { v: 2, t: 'host', from: 'a' }, { v: 1, t: 'host' }, { v: 1, t: 'host', from: 'x'.repeat(40) }]) {
    relay.send(room, junk);
  }
  relay.send(room, { v: 1, t: 'host', from: 'abc', name: '<b>Evil</b>', players: 2, max: 4 });
  await tick(20);
  assert(f.hosts.size === 1, `hosts ${f.hosts.size}`);
  assert(!/[<>]/.test(f.hosts.get('abc').name), 'markup in a farm name');
  f.stop();
});

test('discovery: an idle lobby sends nothing (the public relay allows ~250 messages a day per network)', async () => {
  const relay = new MemoryRelay();
  const room = await roomTopic('net', '203.0.113.9');
  const h = host(relay, [room]);
  const f = finder(relay, [room]);
  await tick(30);
  const settled = relay.sent.length;
  assert(settled <= 3, `startup used ${settled} messages`); // announce, seek, reply
  await tick(120);
  assert(relay.sent.length === settled, `idle traffic: ${relay.sent.length - settled} messages`);
  await f.connect([...f.hosts.keys()][0]);
  await tick(20);
  assert(relay.sent.length - settled === 3, `a join took ${relay.sent.length - settled} messages`);
  f.stop(); h.b.stop();
});

test('discovery: a relay that refuses messages says so instead of "the host didn\'t answer"', async () => {
  const relay = new MemoryRelay();
  const room = await roomTopic('net', '203.0.113.10');
  const h = host(relay, [room]);
  let trouble = null;
  const f = finder(relay, [room], 'Joe', { onTrouble: (t) => { trouble = t; } });
  await tick(20);
  relay.refuse = true;
  let err = null;
  const t0 = Date.now();
  await f.connect([...f.hosts.keys()][0]).catch((e) => { err = e; });
  assert(err && /daily limit/.test(err.message), `got ${err?.message}`);
  assert(Date.now() - t0 < 100, 'waited for a timeout instead of failing fast');
  assert(f.waiting === null, 'still waiting after a failed join');
  f.seek();
  await tick(5);
  assert(trouble && /daily limit/.test(trouble), `seek trouble: ${trouble}`);
  f.stop(); h.b.stop();
});

test('discovery: a farm that vanished without a bye is dropped after it fails to answer', async () => {
  const relay = new MemoryRelay();
  const room = await roomTopic('net', '203.0.113.11');
  const f = finder(relay, [room], 'Joe', { offerTimeoutMs: 30 });
  relay.send(room, { v: 1, t: 'host', from: 'ghost', name: 'Gone', players: 1, max: 4 });
  await tick(10);
  assert(f.hosts.has('ghost'), 'ghost not listed');
  let err = null;
  await f.connect('ghost').catch((e) => { err = e; });
  assert(err && /didn't answer/.test(err.message), `got ${err?.message}`);
  assert(!f.hosts.has('ghost'), 'ghost farm kept');
  f.stop();
});

test('discovery: room codes are short, unambiguous and forgiving to type', () => {
  for (let k = 0; k < 200; k++) {
    const c = newRoomCode();
    assert(c.length === 4 && [...c].every((ch) => CODE_ALPHABET.includes(ch)), c);
    assert(normalizeCode(c) === c, 'round trip');
  }
  assert(!/[01OIL]/.test(CODE_ALPHABET), 'look-alikes in the alphabet');
  assert(normalizeCode(' k7-qm ') === 'K7QM', 'case/space/dash');
  assert(normalizeCode('K7Q') === null && normalizeCode('K0QM') === null && normalizeCode('') === null, 'bad codes');
});

test('discovery: room topics are stable, separate per kind, and do not reveal the IP', async () => {
  const a = await roomTopic('net', '203.0.113.7');
  assert(a === await roomTopic('net', '203.0.113.7'), 'unstable');
  assert(a !== await roomTopic('code', '203.0.113.7'), 'kinds collide');
  assert(/^goofytd-n[0-9a-f]{24}$/.test(a) && !a.includes('203'), a);
  assert(a.length <= 64, 'ntfy topics are at most 64 chars');
});

test('discovery: the network id comes from the STUN-seen (srflx) address; IPv6 shares its /64', () => {
  const v4 = 'candidate:842163049 1 udp 1677729535 203.0.113.5 54400 typ srflx raddr 0.0.0.0 rport 0 generation 0';
  assert(networkIdFromCandidate(v4) === '203.0.113.5', 'v4');
  assert(networkIdFromCandidate(`a=${v4}`) === '203.0.113.5', 'a= prefix');
  assert(networkIdFromCandidate('candidate:1 1 udp 2122260223 4a5c1b62-3c9f.local 54321 typ host') === null, 'host candidate');
  const p1 = networkIdFromCandidate('candidate:1 1 udp 1 2001:db8:abcd:12:1:2:3:4 9 typ srflx raddr :: rport 0');
  const p2 = networkIdFromCandidate('candidate:1 1 udp 1 2001:0db8:abcd:0012::99 9 typ srflx raddr :: rport 0');
  assert(p1 === '2001:db8:abcd:12::/64' && p1 === p2, `${p1} vs ${p2}`);
});

test('discovery: ?relay picks the matchmaking server', () => {
  assert(relayFromParams(new URLSearchParams('relay=off')) === null, 'off');
  assert(relayFromParams(new URLSearchParams('')).base === 'https://ntfy.sh', 'default');
  const r = relayFromParams(new URLSearchParams('relay=http://localhost:8090/'));
  assert(r instanceof NtfyRelay && r.base === 'http://localhost:8090', r.base);
});
