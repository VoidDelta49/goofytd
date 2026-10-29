// Player actions as plain data. Every change a player makes to the match
// (build, sell, upgrade, auto-upgrade settings, fast-forward, start a wave, restart) is a command applied at the
// start of a tick, in the same order on every machine. Singleplayer goes
// through the same path, so co-op can't drift from what solo players test.
// Pure: no DOM, no three.js. Commands arrive over the network, so they're
// validated here and anything malformed is refused, never thrown.

import { TOWER_FORMS, TOWER_TYPES } from './towers.js';
import { SURPRISES } from './surprises.js';
import { GAME_SPEEDS } from './game.js';

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => Number.isInteger(v) && v >= 0;
const MAX_PLAYERS = 8;

/**
 * Check a command's shape. Returns a clean copy (only the known fields) or
 * null. `p` (who sent it) is stamped by whoever relays it, never trusted from the wire.
 */
export function sanitizeCommand(c) {
  if (!c || typeof c !== 'object') return null;
  switch (c.k) {
    case 'place':
      return Object.hasOwn(TOWER_TYPES, c.type) && num(c.x) && num(c.z) ? { k: 'place', type: c.type, x: c.x, z: c.z } : null;
    case 'sell':
      return int(c.id) ? { k: 'sell', id: c.id } : null;
    case 'upgrade':
      return int(c.id) && Object.hasOwn(TOWER_FORMS, c.form) ? { k: 'upgrade', id: c.id, form: c.form } : null;
    case 'wave':
      return { k: 'wave' };
    case 'reset':
      return int(c.seed) ? { k: 'reset', seed: c.seed >>> 0 } : null;
    case 'players':
      return Number.isInteger(c.n) && c.n >= 1 && c.n <= MAX_PLAYERS ? { k: 'players', n: c.n } : null;
    case 'surprise':
      return typeof c.id === 'string' && Object.hasOwn(SURPRISES, c.id) ? { k: 'surprise', id: c.id } : null;
    case 'auto':
      return typeof c.on === 'boolean' ? { k: 'auto', on: c.on } : null;
    case 'speed':
      return GAME_SPEEDS.includes(c.x) ? { k: 'speed', x: c.x } : null;
    case 'autopath': {
      // Only a real path choice, and only one of its own variants.
      const f = typeof c.form === 'string' && Object.hasOwn(TOWER_FORMS, c.form) ? TOWER_FORMS[c.form] : null;
      return f && f.upgrades.length > 1 && f.upgrades.includes(c.pick) ? { k: 'autopath', form: c.form, pick: c.pick } : null;
    }
    default:
      return null;
  }
}

/** Commands only the host may send (a client asking for them is ignored). */
export const HOST_ONLY = new Set(['reset', 'players', 'surprise']);

/**
 * Apply one (sanitized) command to the game. Returns { ok, reason?, ... } so
 * the client can give the player who sent it feedback. Building skips the
 * "standing in the way" check: other farmers' positions aren't part of the
 * shared sim, so the sender checks them before sending (see BuildController).
 */
export function applyCommand(game, c) {
  switch (c.k) {
    case 'place': {
      const r = game.placeTower(c.type, c.x, c.z);
      return r.reason ? { ok: false, reason: r.reason } : { ok: true, tower: r };
    }
    case 'sell': {
      const t = game.towers.get(c.id);
      if (!t) return { ok: false, reason: 'already gone' };
      return { ok: true, tower: t, refund: game.sellTower(c.id) };
    }
    case 'upgrade': {
      const r = game.upgradeTower(c.id, c.form);
      return r.ok ? { ok: true, tower: r.tower } : { ok: false, reason: r.reason, tower: r.tower };
    }
    case 'wave': {
      const before = game.wave;
      game.startWave();
      return game.wave !== before ? { ok: true, wave: game.wave, interest: game.lastInterest } : { ok: false };
    }
    case 'reset':
      game.cfg.seed = c.seed;
      game.reset();
      return { ok: true };
    case 'players':
      game.players = c.n;
      return { ok: true };
    case 'surprise':
      return { ok: game.queueSurprise(c.id) !== false };
    case 'auto':
      game.autoUpgrade = c.on;
      return { ok: true, on: c.on };
    case 'speed':
      game.timeScale = c.x;
      return { ok: true, x: c.x };
    case 'autopath':
      game.autoPick[c.form] = c.pick;
      return { ok: true, form: c.form, pick: c.pick };
    default:
      return { ok: false };
  }
}

/**
 * Fingerprint of the shared match state, bit-exact (hashes the doubles' bytes),
 * so two machines that ran the same commands must agree. Used to catch desyncs.
 */
export function stateHash(game) {
  const f = new Float64Array(1);
  const u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  const mix = (v) => {
    f[0] = v;
    h = Math.imul(h ^ u[0], 0x01000193);
    h = Math.imul(h ^ u[1], 0x01000193);
  };
  mix(game.money); mix(game.milk); mix(game.wave); mix(game.kills); mix(game.cows.count); mix(game.towers.size); mix(game.autoUpgrade ? 1 : 0); mix(game.timeScale);
  const c = game.cows;
  for (let i = 0; i < c.count; i++) { mix(c.x[i]); mix(c.z[i]); mix(c.hp[i]); mix(c.id[i]); }
  for (const t of game.towers.values()) { mix(t.id); mix(t.hp); mix(t.cooldown); }
  for (const [id, b] of game.bosses) { mix(id); mix(b.phase); mix(b.actT); mix(b.stompCd); mix(b.wallopCd); }
  return h >>> 0;
}
