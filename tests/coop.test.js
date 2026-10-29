// LAN co-op: shared wallet and income scaling, command validation, lockstep
// (a host and joiners over fake links stay bit-identical), invite codes and
// farmer position smoothing. WebRTC itself is browser-only (net/peer.js).
import { test, assert } from './harness.js';
import { openField, levelCollision } from '../src/level.js';
import { Game, defaultGameConfig } from '../src/sim/game.js';
import { TOWER_TYPES } from '../src/sim/towers.js';
import { mulberry32 } from '../src/sim/rng.js';
import { applyCommand, sanitizeCommand, stateHash } from '../src/sim/commands.js';
import { Lockstep, HASH_EVERY, CLIENT_BUFFER, MAX_CATCHUP } from '../src/net/lockstep.js';
import { HostSession, JoinSession, MAX_FARMERS, cleanName } from '../src/net/session.js';
import { Track, INTERP_DELAY, lerpAngle, packPos } from '../src/net/track.js';
import { decodeSignal, encodeSignal, fromBase64Url, toBase64Url, SIGNAL_PREFIX } from '../src/net/signal.js';

const DT = 1 / 64;

function makeGame(seed = 7, players = 1, extra = {}) {
  const level = openField();
  const cfg = { ...defaultGameConfig(), seed, players, firstWave: null, ...extra };
  return new Game(level, levelCollision(level), cfg);
}

/** Run one machine's tick the way main.js does. */
function runTicks(sync, game, ticks, results = []) {
  const n = sync.ticksToRun(ticks);
  for (let i = 0; i < n; i++) {
    for (const c of sync.beginTick()) results.push({ c, r: applyCommand(game, c) });
    game.tick(DT);
    sync.endTick(game);
  }
  sync.flush();
  return n;
}

/**
 * A fake network: reliable messages arrive in order after a random delay of
 * 0–`jitter` "frames" (never overtaking), fast ones out of order and sometimes not at all.
 */
function fakeNet(seed = 1, jitter = 3) {
  const rng = mulberry32(seed);
  const inflight = [];
  let frame = 0;
  const lastDue = new Map();
  const net = {
    pair() {
      const a = { onmessage: () => {}, onclose: () => {} };
      const b = { onmessage: () => {}, onclose: () => {} };
      for (const [from, to] of [[a, b], [b, a]]) {
        from.send = (m) => {
          // In-order delivery per direction, like an ordered data channel.
          const due = Math.max(frame + Math.floor(rng() * (jitter + 1)), lastDue.get(from) ?? 0);
          lastDue.set(from, due);
          inflight.push({ to, m: JSON.stringify(m), fast: false, due });
        };
        from.sendFast = (m) => {
          if (rng() < 0.2) return; // lost
          inflight.push({ to, m: JSON.stringify(m), fast: true, due: frame + Math.floor(rng() * (jitter + 2)) });
        };
        from.close = () => { from.dead = to.dead = true; to.onclose(); };
      }
      return [a, b];
    },
    step() {
      frame++;
      const now = inflight.filter((x) => x.due <= frame);
      for (const x of now) inflight.splice(inflight.indexOf(x), 1);
      for (const x of now) if (!x.to.dead) x.to.onmessage(JSON.parse(x.m), x.fast);
    },
    get idle() { return inflight.length === 0; },
  };
  return net;
}

// ---- income ---------------------------------------------------------------

test('coop: one farmer earns exactly what solo always did', () => {
  const g = makeGame(3, 1);
  assert(g.incomeMult === 1 && g.money === defaultGameConfig().startMoney, `solo start ${g.money}`);
  g.startWave();
  assert(g.money === defaultGameConfig().startMoney + defaultGameConfig().waveBonus, `wave bonus ${g.money}`);
});

test('coop: every extra farmer adds +50% income (start money, wave bonus, bounties, cash surprises)', () => {
  const mults = [1, 2, 3, 4].map((n) => makeGame(3, n).incomeMult);
  assert(mults.join() === '1,1.5,2,2.5', `mults ${mults}`);
  const g = makeGame(3, 2);
  assert(g.money === 375, `2 farmers start with ${g.money}`);
  const before = g.money;
  g.startWave();
  assert(g.money - before === 38, `wave bonus 25 × 1.5 → ${g.money - before}`);
  // A kill pays bounty × 1.5 (rounded once, with barns and happy hour folded in).
  const g2 = makeGame(3, 2);
  const g1 = makeGame(3, 1);
  for (const game of [g1, g2]) {
    game.startWave();
    for (let k = 0; k < 64 * 6; k++) game.tick(DT); // a few cows walk in
  }
  const kill = (game) => { const m0 = game.money; game.damageCow(0, 1e9, null); return game.money - m0; };
  const p1 = kill(g1), p2 = kill(g2);
  assert(p1 > 0 && p2 === Math.round(p1 * 1.5), `bounty solo ${p1}, duo ${p2}`);
  // Cash surprises go through earn() too.
  const w = makeGame(3, 3);
  w.wave = 4;
  const m0 = w.money;
  w.queueSurprise('wallet');
  w.tick(DT);
  assert(w.money - m0 === Math.round((30 + 8 * 4) * 2), `wallet with 3 farmers paid ${w.money - m0}`);
});

test('coop: refunds are not multiplied (selling never prints moolah)', () => {
  const g = makeGame(5, 4);
  const t = g.placeTower('squirter', 6, -20);
  assert(t.id, `placed: ${t.reason}`);
  const refund = g.sellTower(t.id);
  assert(refund === Math.floor(TOWER_TYPES.squirter.cost * 0.7), `refund ${refund}`);
});

// ---- commands -------------------------------------------------------------

test('coop: malformed commands are refused, never thrown', () => {
  const bad = [null, 3, 'x', {}, { k: 'nope' }, { k: 'place', type: 'toString', x: 0, z: 0 },
    { k: 'place', type: 'squirter', x: NaN, z: 0 }, { k: 'place', type: '__proto__', x: 0, z: 0 },
    { k: 'sell', id: -1 }, { k: 'sell', id: 1.5 }, { k: 'upgrade', id: 1, form: 'constructor' },
    { k: 'reset', seed: 'a' }, { k: 'players', n: 0 }, { k: 'players', n: 99 }, { k: 'surprise', id: 'hasOwnProperty' }];
  for (const c of bad) assert(sanitizeCommand(c) === null, `accepted ${JSON.stringify(c)}`);
  const ok = sanitizeCommand({ k: 'place', type: 'squirter', x: 1, z: 2, evil: true, p: 9 });
  assert(ok && !('evil' in ok) && !('p' in ok), `extra fields kept: ${JSON.stringify(ok)}`);
});

test('coop: solo actions run at the next tick through the local lockstep', () => {
  const g = makeGame(11);
  const sync = new Lockstep({ role: 'local' });
  sync.submit({ k: 'place', type: 'squirter', x: 6, z: -20 });
  assert(g.towers.size === 0, 'built before the tick');
  const res = [];
  runTicks(sync, g, 1, res);
  assert(g.towers.size === 1 && res[0].r.ok && res[0].c.p === 0, 'not built at the tick');
  sync.submit({ k: 'wave' });
  runTicks(sync, g, 1, res);
  assert(g.wave === 1 && res[1].r.wave === 1, `wave ${g.wave}`);
  sync.submit({ k: 'place', type: 'squirter', x: 6, z: -20 });
  runTicks(sync, g, 1, res);
  assert(!res[2].r.ok && res[2].r.reason, 'double build should fail with a reason');
});

// ---- lockstep over a network ----------------------------------------------

/** Lobby with a host and `n` joiners over a fake network; returns machines once started. */
function lobby(net, n, seed = 99) {
  const host = new HostSession('Hosty', () => net.t);
  const joins = [];
  for (let k = 0; k < n; k++) {
    const [h, j] = net.pair();
    host.addLink(h);
    joins.push(new JoinSession(`Joe${k}`, j, () => net.t));
  }
  net.t = 0;
  for (let k = 0; k < 20; k++) net.step();
  assert(host.players.length === n + 1, `lobby has ${host.players.length}`);
  for (const j of joins) assert(j.players.length === n + 1 && j.me > 0, `joiner sees ${j.players.length}, me ${j.me}`);
  const started = [];
  for (const j of joins) j.onStart = (s) => started.push(s);
  const st = host.start(seed, 'field');
  for (let k = 0; k < 20; k++) net.step();
  assert(started.length === n && started.every((s) => s.seed === seed && s.players.length === n + 1), 'everyone started');
  const machines = [{ s: host, game: makeGame(seed, st.players.length) }];
  for (const j of joins) machines.push({ s: j, game: makeGame(seed, j.players.length) });
  return machines;
}

test('coop: host + 3 joiners stay bit-identical through 3000 ticks of everyone building, upgrading, selling and starting waves', () => {
  const net = fakeNet(42, 4);
  const ms = lobby(net, 3);
  const rng = mulberry32(5);
  const types = Object.keys(TOWER_TYPES);
  const hostHashes = [];
  const clientHashes = ms.slice(1).map(() => []);
  let issued = 0;
  for (let frame = 0; frame < 2600; frame++) {
    net.t = frame * 16;
    // Every farmer does something now and then, at the same moment, without waiting for anyone.
    for (const m of ms) {
      if (rng() < 0.03) {
        const r = rng();
        const g = m.game;
        const ids = [...g.towers.keys()];
        let c;
        if (r < 0.55) c = { k: 'place', type: types[Math.floor(rng() * types.length)], x: -30 + rng() * 60, z: -40 + rng() * 45 };
        else if (r < 0.75 && ids.length) {
          const t = g.towers.get(ids[Math.floor(rng() * ids.length)]);
          c = t.def.upgrades.length ? { k: 'upgrade', id: t.id, form: t.def.upgrades[0] } : { k: 'sell', id: t.id };
        } else if (r < 0.85 && ids.length) c = { k: 'sell', id: ids[Math.floor(rng() * ids.length)] };
        else c = { k: 'wave' };
        assert(m.s.lockstep.submit(c), `submit ${JSON.stringify(c)}`);
        issued++;
      }
    }
    // 60 fps vs a 64 Hz sim: mostly 1 tick a frame, sometimes 2.
    const ticks = frame % 15 === 0 ? 2 : 1;
    const before = ms[0].s.lockstep.tick;
    runTicks(ms[0].s.lockstep, ms[0].game, ticks);
    for (let k = before; k < ms[0].s.lockstep.tick; k++) hostHashes[k] = null;
    hostHashes[ms[0].s.lockstep.tick - 1] = stateHash(ms[0].game);
    ms.slice(1).forEach((m, k) => {
      const n = runTicks(m.s.lockstep, m.game, ticks);
      if (n) clientHashes[k][m.s.lockstep.tick - 1] = stateHash(m.game);
    });
    net.step();
  }
  // Drain: the clients catch up with everything the host ran.
  for (let frame = 0; frame < 200; frame++) {
    net.step();
    ms.slice(1).forEach((m, k) => {
      const n = runTicks(m.s.lockstep, m.game, 1);
      if (n) clientHashes[k][m.s.lockstep.tick - 1] = stateHash(m.game);
    });
  }
  const host = ms[0];
  assert(host.game.wave >= 3 && host.game.towers.size >= 3 && host.game.kills > 20, `too quiet: wave ${host.game.wave}, towers ${host.game.towers.size}, kills ${host.game.kills}`);
  assert(issued > 150, `only ${issued} commands`);
  for (const [k, m] of ms.slice(1).entries()) {
    assert(m.s.lockstep.tick === host.s.lockstep.tick, `joiner ${k} at tick ${m.s.lockstep.tick}, host ${host.s.lockstep.tick}`);
    assert(m.s.lockstep.desyncAt === null, `joiner ${k} desynced at ${m.s.lockstep.desyncAt}`);
    let compared = 0;
    for (let t = 0; t < hostHashes.length; t++) {
      if (hostHashes[t] == null || clientHashes[k][t] == null) continue;
      assert(hostHashes[t] === clientHashes[k][t], `joiner ${k} differs at tick ${t}`);
      compared++;
    }
    assert(compared > 500, `only ${compared} ticks compared`);
    assert(m.game.money === host.game.money && m.game.milk === host.game.milk && m.game.kills === host.game.kills, 'wallet differs');
  }
});

test('coop: the host stamps who sent a command; joiners can\'t restart or forge another farmer', () => {
  const net = fakeNet(3, 1);
  const [host, joe] = lobby(net, 1);
  const res = [];
  joe.s.lockstep.submit({ k: 'place', type: 'squirter', x: 6, z: -20, p: 0 });
  assert(joe.s.lockstep.submit({ k: 'reset', seed: 5 }) === false, 'joiner restart accepted locally');
  joe.s.link.send({ t: 'cmd', c: { k: 'reset', seed: 5 } }); // a modified client trying anyway
  for (let k = 0; k < 10; k++) net.step();
  runTicks(host.s.lockstep, host.game, 1, res);
  assert(res.length === 1 && res[0].c.k === 'place' && res[0].c.p === joe.s.me, `got ${JSON.stringify(res.map((x) => x.c))}`);
  for (let k = 0; k < 10; k++) net.step();
  const jres = [];
  runTicks(joe.s.lockstep, joe.game, 1, jres);
  assert(jres.length === 1 && jres[0].c.p === joe.s.me && jres[0].r.ok, 'joiner saw a different result');
});

test('coop: a farmer leaving lowers everyone\'s income at the same tick', () => {
  const net = fakeNet(8, 2);
  const ms = lobby(net, 2);
  assert(ms.every((m) => m.game.incomeMult === 2), 'three farmers should be ×2');
  ms[2].s.link.close(); // the third farmer quits
  const tickLeft = ms[0].s.lockstep.tick;
  for (let f = 0; f < 60; f++) {
    for (const m of ms.slice(0, 2)) runTicks(m.s.lockstep, m.game, 1);
    net.step();
  }
  for (const m of ms.slice(0, 2)) assert(m.game.players === 2 && m.game.incomeMult === 1.5, `players ${m.game.players}`);
  assert(ms[0].s.players.length === 2 && ms[1].s.players.length === 2, 'lobby lists differ');
  assert(!ms[1].s.remotes.has(ms[2].s.me), 'quitter still drawn');
  assert(stateHash(ms[0].game) === stateHash(ms[1].game) || ms[1].s.lockstep.tick !== ms[0].s.lockstep.tick, 'diverged');
  void tickLeft;
});

test('coop: a joiner whose game differs from the host notices (desync check)', () => {
  const net = fakeNet(9, 0);
  const [host, joe] = lobby(net, 1);
  joe.game.money += 1; // pretend a bug changed the joiner's game
  for (let f = 0; f < HASH_EVERY * 2 + 10; f++) {
    runTicks(host.s.lockstep, host.game, 1);
    net.step();
    runTicks(joe.s.lockstep, joe.game, 1);
  }
  assert(joe.s.lockstep.desyncAt !== null, 'desync not caught');
});

test('coop: joining a game in progress or a full lobby is refused politely', () => {
  const net = fakeNet(4, 0);
  const host = new HostSession('H', () => 0);
  const events = [];
  for (let k = 0; k < MAX_FARMERS; k++) { // one more than fits: the host is a farmer too
    const [h, j] = net.pair();
    host.addLink(h);
    const s = new JoinSession(`J${k}`, j, () => 0);
    s.onEvent = (e) => events.push(e);
  }
  for (let k = 0; k < 5; k++) net.step();
  assert(host.players.length === MAX_FARMERS, `players ${host.players.length}`);
  assert(events.some((e) => e.kind === 'full' && /full/.test(e.why)), 'fifth farmer not told the lobby is full');
  const colors = new Set(host.players.map((p) => p.color));
  assert(colors.size === MAX_FARMERS, 'two farmers share a shirt colour');
  host.start(1, 'field');
  // Someone leaves and another tries to slip in mid-game.
  const [h, j] = net.pair();
  host.addLink(h);
  const late = new JoinSession('Late', j, () => 0);
  late.onEvent = (e) => events.push(e);
  for (let k = 0; k < 5; k++) net.step();
  assert(events.some((e) => e.kind === 'full' && /started/.test(e.why)), 'late joiner not refused');
});

test('coop: client tick pacing follows the clock, catches up on a backlog, never outruns the host', () => {
  const ls = new Lockstep({ role: 'client', me: 1 });
  assert(ls.ticksToRun(1) === 0, 'ran a tick it never got');
  ls.receiveFrames({ t: 'f', s: 0, n: 2 });
  assert(ls.ticksToRun(1) === 1 && ls.ticksToRun(3) === 2, 'clock pacing');
  ls.receiveFrames({ t: 'f', s: 2, n: 40 });
  const n = ls.ticksToRun(1);
  assert(n > 1 && n <= MAX_CATCHUP, `catch-up ${n}`);
  ls.receiveFrames({ t: 'f', s: 99, n: 1 }); // a gap: something is badly wrong
  assert(ls.desyncAt === 99, 'gap not flagged');
  void CLIENT_BUFFER;
});

// ---- farmers moving ---------------------------------------------------------

test('coop: farmer positions are smoothed between snapshots and stale ones dropped', () => {
  const tr = new Track();
  assert(tr.sample(0) === null, 'empty track');
  tr.push(1000, packPos(1, { x: 0, y: 0, z: 0, yaw: 6.2, pitch: 0, crouched: false }));
  tr.push(1050, packPos(2, { x: 1, y: 0, z: 0, yaw: 0.1, pitch: 0.2, crouched: true }));
  assert(!tr.push(1060, packPos(1, { x: 50, y: 0, z: 0, yaw: 0, pitch: 0 })), 'old snapshot accepted');
  const s = tr.sample(1025 + INTERP_DELAY);
  assert(Math.abs(s.x - 0.5) < 1e-9, `x ${s.x}`);
  assert(Math.abs(s.speed - 20) < 1e-6, `speed ${s.speed}`);
  // Yaw goes the short way round through 0, not back across π.
  const yaw = ((s.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  assert(yaw > 6.2 || yaw < 0.1, `yaw went the long way: ${s.yaw}`);
  assert(tr.sample(5000).x === 1, 'should hold the newest');
  assert(Math.abs(lerpAngle(3, -3, 0.5) - Math.PI) < 0.3, 'wrap');
});

// ---- invite codes -----------------------------------------------------------

const SAMPLE_SDP = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=extmap-allow-mixed',
  'a=msid-semantic: WMS', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=candidate:1467250027 1 udp 2122260223 4a5c1b62-3c9f-4c1a-9e0f-0123456789ab.local 54321 typ host generation 0 network-id 1',
  'a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdefghijklmn', 'a=ice-options:trickle',
  'a=fingerprint:sha-256 ' + Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, '0').toUpperCase()).join(':'),
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', ''].join('\r\n');

test('coop: invite codes round-trip, survive chat-app wrapping, and reject junk', async () => {
  const code = await encodeSignal('o', SAMPLE_SDP);
  assert(code.startsWith(`${SIGNAL_PREFIX}o`) && /^[A-Za-z0-9_-]+$/.test(code), `bad code ${code.slice(0, 20)}`);
  assert(code.length < SAMPLE_SDP.length, `code (${code.length}) not shorter than the SDP (${SAMPLE_SDP.length})`);
  const link = `Join my farm! https://example.com/goofytd/#join=${code.slice(0, 40)}\n${code.slice(40)} `;
  const d = await decodeSignal(link);
  assert(d && d.kind === 'o', 'not found in a wrapped link');
  for (const line of ['a=candidate:', 'a=ice-ufrag:abcd', 'a=fingerprint:sha-256', 'a=setup:actpass', 'a=sctp-port:5000']) {
    assert(d.sdp.includes(line), `lost ${line}`);
  }
  assert(!d.sdp.includes('extmap-allow-mixed'), 'did not trim');
  assert(await decodeSignal('hello') === null && await decodeSignal(`${SIGNAL_PREFIX}oAAAA`) === null, 'junk decoded');
  const bytes = new Uint8Array([0, 255, 62, 63, 1]);
  assert(fromBase64Url(toBase64Url(bytes)).join() === bytes.join(), 'base64url');
});

test('coop: farmer names from the network are short and harmless', () => {
  assert(!/[<>"']/.test(cleanName('<img src=x onerror="alert(1)">')), 'markup kept');
  assert(cleanName('') === 'Farmer' && cleanName(null) === 'Farmer', 'empty name');
  assert(cleanName('x'.repeat(40)).length === 16, 'long name');
});
