// Surprises: scripted sequences that the game rolls on top of the standard
// wave formula, so a wave can't be read off the wave number alone. Pure sim
// (no three/DOM); every random choice comes from the game's own surprise rng,
// so a seed replays the same surprises at the same moments.
//
// Each surprise is defineSurprise({ id, name, firstWave, weight, delay, script }):
//   firstWave, weight   when it can be rolled and how often relative to the others
//   delay [min, max]    seconds after the wave starts before the script runs
//   script(ctx)         returns the steps, { at, ... } sorted or not, where `at`
//                       is seconds after the script starts. ctx = { wave, rng, game }.
// Step kinds (one per step):
//   say: 'text'         banner on screen (a 'surprise' event)
//   spawn: cowTypeId    a stream of cows; with count, every (s), hp (× this
//                       wave's scale), from ('random' | 'all' | 'flank' | 'drop'
//                       (anywhere mid-field, 25+ m from the milk) | 'same'),
//                       mix: true to draw each cow from the wave's mix instead,
//                       and optional onKill / onEscape (game, cowId) for the cows
//   call: (game) => {}  anything else (lulls, rushes, money)
//
// See Game.rollSurprises / updateSurprises for the runner.

import { COW_TYPE_LIST, COW_TYPES, MAX_COW_RADIUS, waveMix, pickFromMix } from './cows.js';
import { TOWER_FORMS } from './towers.js';

export const SURPRISES = {};
export const SURPRISE_LIST = [];

export function defineSurprise(def) {
  for (const k of ['id', 'name', 'script']) {
    if (def[k] === undefined) throw new Error(`surprise ${def.id}: missing ${k}`);
  }
  if (SURPRISES[def.id]) throw new Error(`surprise ${def.id} defined twice`);
  const s = Object.freeze({ firstWave: 2, weight: 1, delay: [2, 12], ...def });
  SURPRISES[def.id] = s;
  SURPRISE_LIST.push(s);
  return s;
}

/** Chance that wave `wave` rolls a surprise (before the drought guarantee). */
export function surpriseChance(cfg, wave) {
  if (wave < 2) return 0;
  return Math.min(cfg.surpriseMax, cfg.surpriseBase + cfg.surpriseGrowth * (wave - 2));
}

/** Weighted pick of a surprise that can happen in `wave`, skipping ids in `exclude`. r in [0, 1). */
export function pickSurprise(wave, r, exclude = []) {
  const pool = SURPRISE_LIST.filter((s) => s.weight > 0 && s.firstWave <= wave && !exclude.includes(s.id));
  if (pool.length === 0) return null;
  let total = 0;
  for (const s of pool) total += s.weight;
  let x = r * total;
  for (const s of pool) {
    if (x < s.weight) return s;
    x -= s.weight;
  }
  return pool[pool.length - 1];
}

// ---- the surprises -------------------------------------------------------

defineSurprise({
  id: 'stampede', name: 'Stampede', firstWave: 3, weight: 4,
  script: ({ wave }) => [
    { at: 0, say: 'STAMPEDE! Something spooked the Zoomies!' },
    { at: 0.5, spawn: 'fast', count: 5 + 2 * wave, every: 0.1, from: 'random' },
  ],
});

defineSurprise({
  id: 'ambush', name: 'Ambush', firstWave: 4, weight: 3,
  // No warning: the banner comes with the cows, from somewhere that isn't a spawner.
  script: ({ wave }) => [
    { at: 0, spawn: 'cow', mix: true, count: 3 + wave, every: 0.25, from: 'flank', announce: 'AMBUSH! Cows are coming in from the edge of the field!' },
  ],
});

defineSurprise({
  id: 'cashcow', name: 'Cash Cow', firstWave: 2, weight: 3,
  script: ({ wave }) => {
    const prize = 40 + 10 * wave;
    return [
      { at: 0, say: `A CASH COW is loose! Catch it for ${prize} moolah!` },
      {
        at: 0.3, spawn: 'golden', count: 1, from: 'random', hp: 1,
        onKill: (game) => { game.announce('cashcow', `Cash cow cashed: +${game.earn(prize)} moolah!`); },
        onEscape: (game) => game.announce('cashcow', 'The Cash Cow got away. Rich cow now.'),
      },
    ];
  },
});

defineSurprise({
  id: 'bessie', name: 'Big Bessie', firstWave: 5, weight: 2, delay: [4, 14],
  script: ({ wave }) => [
    { at: 0, say: 'The ground shakes... BIG BESSIE has entered the field.' },
    { at: 1.5, spawn: 'fast', count: 3 + Math.floor(wave / 2), every: 0.2, from: 'random', tag: 'escort' },
    { at: 2.5, spawn: 'bessie', count: 1, from: 'same', hp: 1 + 0.3 * wave },
  ],
});

defineSurprise({
  id: 'airraid', name: 'Air Raid', firstWave: 6, weight: 2,
  script: ({ wave }) => [
    { at: 0, say: 'AIR RAID! Cows. In the sky. Again.' },
    { at: 1, spawn: 'flying', count: 2 + Math.floor(wave / 2), every: 0.35, from: 'all' },
  ],
});

defineSurprise({
  id: 'convoy', name: 'Kaboom Convoy', firstWave: 7, weight: 2,
  script: ({ wave }) => [
    { at: 0, say: 'A Big Cow is escorting something... that ticks.' },
    { at: 0.5, spawn: 'big', count: 1, from: 'random', hp: 1.5 },
    { at: 1.4, spawn: 'boomer', count: 2 + Math.floor(wave / 3), every: 0.35, from: 'same' },
  ],
});

defineSurprise({
  id: 'tooquiet', name: 'Too Quiet', firstWave: 3, weight: 2, delay: [0.5, 2],
  script: () => [
    { at: 0, say: "...it's quiet. Too quiet.", call: (game) => { game.spawnHold = 7; } },
    { at: 7, say: 'THERE THEY ARE! All of them! At once!', call: (game) => { game.spawnRate = 0.3; } },
  ],
});

defineSurprise({
  id: 'fakeout', name: 'The Big One', firstWave: 4, weight: 1,
  script: () => [
    { at: 0, say: 'THE BIG ONE IS COMING. Brace yourself.' },
    { at: 4, spawn: 'calf', count: 1, from: 'random', hp: 1 },
    { at: 5, say: "...oh. It's a calf. Carry on." },
  ],
});

defineSurprise({
  id: 'wallet', name: 'Moolah Drop', firstWave: 2, weight: 1,
  script: ({ wave }) => [
    { at: 0, call: (game) => { game.announce('wallet', `A farmer dropped their wallet. +${game.earn(30 + 8 * wave)} moolah!`); } },
  ],
});

defineSurprise({
  id: 'happyhour', name: 'Happy Hour', firstWave: 3, weight: 2,
  script: () => [
    { at: 0, say: 'HAPPY HOUR! Every cow is worth double for 15 seconds!', call: (game) => game.boostBounty(2, 15) },
    { at: 15, say: 'Happy Hour is over. Back to regular-priced cows.' },
  ],
});

defineSurprise({
  id: 'tipping', name: 'Cow Tipping', firstWave: 5, weight: 2, delay: [6, 14],
  script: () => [
    { at: 0, say: 'Some teenagers snuck in and TIPPED THE COWS. Free shots!', call: (game) => game.tipCows(3) },
  ],
});

defineSurprise({
  id: 'milkman', name: 'The Milkman', firstWave: 6, weight: 1,
  script: ({ wave }) => {
    const milk = 15, cash = 20 + 5 * wave;
    return [{
      at: 0, call: (game) => {
        const room = game.cfg.milk - game.milk;
        if (room > 0) {
          game.milk += Math.min(milk, room);
          game.announce('milkman', `The milkman dropped by: +${Math.min(milk, room)} milk!`);
        } else {
          game.announce('milkman', `The milkman found your tank full and tipped you ${game.earn(cash)} moolah.`);
        }
      },
    }];
  },
});

defineSurprise({
  id: 'trojan', name: 'Trojan Cow', firstWave: 6, weight: 2,
  script: () => [
    { at: 0, say: 'A suspiciously large wooden cow is rolling in. Probably fine.' },
    { at: 0.6, spawn: 'trojan', count: 1, from: 'random', onKill: (game) => game.announce('trojan', 'IT WAS FULL OF ZOOMIES!') },
  ],
});

defineSurprise({
  id: 'matryoshka', name: 'Mega Mama', firstWave: 8, weight: 2, delay: [3, 12],
  script: () => [
    { at: 0, say: "MEGA MAMA is here. She's... very expecting." },
    { at: 1, spawn: 'megamama', count: 1, from: 'random', onKill: (game) => game.announce('matryoshka', "Mama's mamas have calves. It's cows all the way down.") },
  ],
});

defineSurprise({
  id: 'rodeo', name: 'Rodeo', firstWave: 9, weight: 2,
  script: ({ wave }) => [
    { at: 0, say: "YEEHAW! It's a RODEO. Don't make the bulls angry. (You will.)" },
    { at: 0.8, spawn: 'bull', count: 3 + Math.floor(wave / 3), every: 0.4, from: 'all' },
  ],
});

defineSurprise({
  id: 'hospital', name: 'Field Hospital', firstWave: 10, weight: 2, delay: [3, 10],
  script: ({ wave }) => [
    { at: 0, say: 'A Big Cow tank column with VET COW support. Shoot the medics first!' },
    { at: 1, spawn: 'big', count: 2 + Math.floor(wave / 5), every: 0.8, from: 'random' },
    { at: 1.4, spawn: 'vet', count: 2, every: 0.8, from: 'same' },
  ],
});

defineSurprise({
  id: 'ninjas', name: 'Ninja Night', firstWave: 11, weight: 2,
  // Ninjas don't announce themselves until they're already in.
  script: ({ wave }) => [
    { at: 0, spawn: 'ninja', count: 3 + Math.floor(wave / 2), every: 0.3, from: 'flank', announce: '...wait, were those NINJA COWS?' },
  ],
});

defineSurprise({
  id: 'warmoost', name: 'War Moo-st', firstWave: 6, weight: 2, delay: [3, 10],
  // Fog: towers see 35% less far and you see much less. Fair warning first, a
  // hidden group whose horn tells you which way to look, and kills pay 1.5×
  // while it lasts.
  script: ({ wave }) => [
    { at: 0, say: "Is it just me, or is it getting MOO-STY out here? (Fog incoming: kills pay 1.5×)" },
    { at: 3, call: (game) => { game.startFog(22); game.boostBounty(1.5, 22); } },
    {
      at: 9, spawn: 'cow', mix: true, count: 3 + Math.floor(wave / 2), every: 0.5, from: 'flank',
      announce: 'Something is mooing out there in the mist...',
    },
  ],
});

defineSurprise({
  id: 'demolition', name: 'Demolition Crew', firstWave: 7, weight: 2, delay: [3, 10],
  script: ({ wave }) => [
    { at: 0, say: 'DEMOLITION CREW! Headbutt Heifers are after your towers. Hay bales by the lane soak the bonks!' },
    { at: 1, spawn: 'ram', count: 2 + Math.floor(wave / 4), every: 0.6, from: 'random' },
  ],
});

defineSurprise({
  id: 'spittake', name: 'Spit Take', firstWave: 9, weight: 2, delay: [3, 10],
  script: ({ wave }) => [
    { at: 0, say: 'CUD SPITTERS! Green goo jams a tower for a few seconds. Gross, but not fatal.' },
    { at: 1, spawn: 'spitter', count: 2 + Math.floor(wave / 5), every: 0.7, from: 'random' },
    { at: 1.5, spawn: 'cow', mix: true, count: 4 + Math.floor(wave / 3), every: 0.3, from: 'same' },
  ],
});

// ---- the second batch ------------------------------------------------------
// Helpers for scripts that act on the cows already on the field. Bosses are
// always left alone (MAMA does what MAMA wants).

/** Slots of live non-boss cows, high to low (safe to remove or kill while walking it). */
function fieldCows(game, keep = () => true) {
  const out = [];
  for (let i = game.cows.count - 1; i >= 0; i--) {
    const type = COW_TYPE_LIST[game.cows.type[i]];
    if (!type.boss && keep(type, i)) out.push(i);
  }
  return out;
}

/** The `n` cows scoring highest by `score(i)` (ties to the lower id), as stable ids. */
function topCowIds(game, n, score, keep) {
  const { cows } = game;
  return fieldCows(game, keep)
    .map((i) => ({ id: cows.id[i], s: score(i) }))
    .sort((a, b) => b.s - a.s || a.id - b.id)
    .slice(0, n).map((c) => c.id);
}

function slotOf(game, id) {
  for (let i = 0; i < game.cows.count; i++) if (game.cows.id[i] === id) return i;
  return -1;
}

defineSurprise({
  id: 'thunder', name: 'Thunderstorm', firstWave: 4, weight: 2, delay: [3, 10],
  // Eight lightning bolts on random cows (bosses too: lightning doesn't care), 1.5 s apart.
  script: ({ wave }) => {
    const steps = [{ at: 0, say: 'THUNDERSTORM! Cows are basically lightning rods with legs.' }];
    for (let k = 0; k < 8; k++) {
      steps.push({
        at: 1.5 + 1.5 * k, call: (game) => {
          if (game.cows.count === 0) return;
          const i = Math.floor(game.surpriseRng() * game.cows.count);
          if (COW_TYPE_LIST[game.cows.type[i]].friendly) return; // the Lost Calf is under divine protection
          const x = game.cows.x[i], z = game.cows.z[i];
          game.events.push({ kind: 'splash', x, y: 1.5, z, radius: 1.3, color: 0xfff6a0 });
          game.damageCow(i, (40 + 6 * wave) * game.hpScale, null);
        },
      });
    }
    return steps;
  },
});

defineSurprise({
  id: 'ghosts', name: 'Ghost Herd', firstWave: 7, weight: 2,
  script: ({ wave }) => [
    { at: 0, say: 'BOOOO-vine! A GHOST HERD drifts in. Only close-range or scoped anti-air can see them.' },
    { at: 1, spawn: 'ghost', count: 3 + Math.floor(wave / 2), every: 0.45, from: 'random' },
  ],
});

defineSurprise({
  id: 'zombies', name: 'Night of the Living Beef', firstWave: 5, weight: 2,
  script: ({ wave }) => [
    { at: 0, say: 'NIGHT OF THE LIVING BEEF! Shoot a Zombie Cow and its bottom half keeps coming.' },
    { at: 1, spawn: 'zombie', count: 4 + Math.floor(wave / 2), every: 0.5, from: 'random' },
  ],
});

defineSurprise({
  id: 'kamikaze', name: 'Moo-ftwaffe', firstWave: 8, weight: 1, delay: [4, 12],
  script: ({ wave }) => [
    { at: 0, say: 'INCOMING MOO-FTWAFFE! Kamikaze Cows blow up the first tower they fly over. FLAK, NOW!' },
    { at: 2.5, spawn: 'kamikaze', count: 2 + Math.floor(wave / 4), every: 0.6, from: 'random' },
  ],
});

defineSurprise({
  id: 'balloons', name: 'Balloon Festival', firstWave: 7, weight: 2,
  script: ({ wave }) => [
    { at: 0, say: 'Hot air BALLOON COWS! Slow, chunky, way up high, and worth a fortune.' },
    { at: 1, spawn: 'balloon', count: 2 + Math.floor(wave / 4), every: 1.2, from: 'random' },
  ],
});

defineSurprise({
  id: 'greased', name: 'Greased Lightning', firstWave: 6, weight: 2,
  script: ({ wave }) => [
    { at: 0, say: 'Someone BUTTERED these cows. Slows slide right off them!' },
    { at: 0.8, spawn: 'greased', count: 4 + Math.floor(wave / 2), every: 0.3, from: 'random' },
  ],
});

defineSurprise({
  id: 'knights', name: 'Cow-valry', firstWave: 10, weight: 2, delay: [3, 10],
  script: ({ wave }) => [
    { at: 0, say: '*trumpets* THE COW-VALRY! Full plate armour. Small guns go "tink".' },
    { at: 1.5, spawn: 'knight', count: 3 + Math.floor(wave / 4), every: 0.7, from: 'random' },
  ],
});

defineSurprise({
  id: 'mitosis', name: 'Cell Division', firstWave: 6, weight: 2,
  script: ({ wave }) => [
    { at: 0, say: 'BLOB COWS! Pop one and it splits in two. Then those split. Science!' },
    { at: 1, spawn: 'blob', count: 2 + Math.floor(wave / 4), every: 0.8, from: 'random' },
  ],
});

defineSurprise({
  id: 'pinata', name: 'Piñata Party', firstWave: 4, weight: 2,
  script: ({ wave }) => {
    const prize = 30 + 8 * wave;
    return [
      { at: 0, say: `A PIÑATA COW! Whack it for ${prize} moolah of candy (and calves).` },
      {
        at: 0.8, spawn: 'pinata', count: 1, from: 'random',
        onKill: (game) => game.announce('pinata', `CANDY! +${game.earn(prize)} moolah! ...and calves. So many calves.`),
      },
    ];
  },
});

defineSurprise({
  id: 'lostcalf', name: 'Lost Calf', firstWave: 3, weight: 2,
  // The rare surprise where you want a cow to reach the milk.
  script: ({ wave }) => {
    const prize = 50 + 10 * wave;
    return [
      { at: 0, say: `A LOST CALF is looking for its mum. Your towers won't aim at it: walk it home for ${prize} moolah. Mind the splash!` },
      {
        at: 1, spawn: 'lostcalf', count: 1, from: 'random', hp: 1,
        onEscape: (game) => game.announce('lostcalf', `The Lost Calf made it home! Mum pays ${game.earn(prize)} moolah in gratitude.`),
        onKill: (game) => {
          const fine = Math.min(game.money, 25);
          game.money -= fine;
          game.announce('lostcalf', `You... you got the Lost Calf. Animal welfare fined you ${fine} moolah.`);
        },
      },
    ];
  },
});

defineSurprise({
  id: 'fieldtrip', name: 'Field Trip', firstWave: 3, weight: 2,
  script: ({ wave }) => [
    { at: 0, say: 'SCHOOL FIELD TRIP! A whole class of calves, and nobody is holding hands.' },
    { at: 0.6, spawn: 'calf', count: 15 + 2 * wave, every: 0.12, from: 'random' },
  ],
});

defineSurprise({
  id: 'ufo', name: 'Close Encounter', firstWave: 6, weight: 1, delay: [5, 14],
  // Beams up the toughest cows: no bounty, but they never reach the milk.
  script: ({ wave }) => [
    { at: 0, say: 'A UFO is hovering over the field... it wants the BIG ones.' },
    {
      at: 3, call: (game) => {
        const ids = topCowIds(game, 2 + Math.floor(wave / 5), (i) => game.cows.maxHp[i], (t) => !t.friendly);
        let n = 0;
        for (const id of ids) { const i = slotOf(game, id); if (i >= 0 && game.abductCow(i)) n++; }
        game.announce('ufo', n ? `*BWOOOOM* ${n} cow${n === 1 ? '' : 's'} abducted. Probably for science.` : 'The UFO found nothing worth taking and left, disappointed.');
      },
    },
  ],
});

defineSurprise({
  id: 'moonlanding', name: 'Moo-n Landing', firstWave: 8, weight: 2, delay: [3, 10],
  // Not from the edge like an ambush: dropped right into the middle of your field.
  script: ({ wave }) => [
    { at: 0, say: 'Something is falling out of the sky... MOO-TANTS FROM SPACE!' },
    { at: 2, spawn: 'alien', count: 3 + Math.floor(wave / 3), every: 0.25, from: 'drop' },
    { at: 4, spawn: 'alien', count: 3 + Math.floor(wave / 3), every: 0.25, from: 'drop' },
  ],
});

defineSurprise({
  id: 'cownado', name: 'Cownado', firstWave: 5, weight: 2, delay: [6, 14],
  // Picks up the cows closest to the milk and drops them back at the spawners.
  script: ({ wave }) => [
    { at: 0, say: 'COWNADO! Hold onto your hats. The cows should hold onto... nothing. They have hooves.' },
    {
      at: 2.5, call: (game) => {
        const ids = topCowIds(game, 4 + Math.floor(wave / 3), (i) => -game.cowPathDistance(i));
        for (const id of ids) {
          const i = slotOf(game, id);
          if (i < 0) continue;
          const s = game.spawners[Math.floor(game.surpriseRng() * game.spawners.length)];
          game.events.push({ kind: 'splash', x: game.cows.x[i], y: 1, z: game.cows.z[i], radius: 1.2, color: 0xc8c8c8 });
          game.teleportCow(i, s.x, s.z);
        }
        game.announce('cownado', `The Cownado flung ${ids.length} cow${ids.length === 1 ? '' : 's'} back where they came from!`);
      },
    },
  ],
});

defineSurprise({
  id: 'moonwalk', name: 'Moonwalk', firstWave: 4, weight: 2, delay: [6, 14],
  script: () => [
    { at: 0, say: 'Someone is blasting 80s pop on the farm radio...' },
    { at: 1.5, say: 'HEE-HEE! The cows are MOONWALKING away from the milk!', call: (game) => game.startMoonwalk(5) },
  ],
});

defineSurprise({
  id: 'espresso', name: 'Espresso Spill', firstWave: 5, weight: 2, delay: [4, 12],
  // Faster, but jittery: they take more damage while it lasts.
  script: () => [
    { at: 0, say: 'A barista truck crashed. The cows got into the ESPRESSO. Fast and twitchy: they take +30% damage!',
      call: (game) => {
        for (const i of fieldCows(game, (t) => !t.friendly)) { game.slowCow(i, 1.6, 7); game.chillCow(i, 1.3, 7); }
      } },
  ],
});

defineSurprise({
  id: 'overclock', name: 'Overclock', firstWave: 3, weight: 2,
  script: () => [
    { at: 0, say: 'POWER SURGE! Every tower is overclocked: +60% fire rate for 12 seconds!', call: (game) => game.overclock(1.6, 12) },
    { at: 12, say: 'Something smells like burnt circuits. Towers back to normal.' },
  ],
});

defineSurprise({
  id: 'supermoon', name: 'Super Moon', firstWave: 4, weight: 2,
  script: () => [
    { at: 0, say: 'A SUPER MOON lights up the field! Towers see 30% further for 15 seconds.', call: (game) => game.boostSight(1.3, 15) },
  ],
});

defineSurprise({
  id: 'taxman', name: 'The Taxman', firstWave: 5, weight: 1,
  script: ({ wave }) => [
    {
      at: 0, call: (game) => {
        const tax = Math.min(Math.floor(game.money * 0.1), 30 + 10 * wave);
        if (tax >= 15) {
          game.money -= tax;
          game.announce('taxman', `The Internal Ruminant Service audited you. -${tax} moolah. Nothing is certain but death and taxes.`);
        } else {
          game.announce('taxman', `The Internal Ruminant Service felt sorry for you: tax refund of ${game.earn(15)} moolah.`);
        }
      },
    },
  ],
});

defineSurprise({
  id: 'subsidy', name: 'Dairy Subsidy', firstWave: 3, weight: 1,
  // Pays for a full tank: the more milk you've kept, the bigger the cheque.
  script: ({ wave }) => [
    {
      at: 0, call: (game) => {
        const full = Math.max(0, Math.min(1, game.milk / game.cfg.milk));
        const paid = game.earn(Math.round((30 + 12 * wave) * full));
        game.announce('subsidy', `DAIRY SUBSIDY! The government pays ${paid} moolah for your ${Math.round(full * 100)}% full milk tank.`);
      },
    },
  ],
});

defineSurprise({
  id: 'combo', name: 'Kill Streak Challenge', firstWave: 4, weight: 2, delay: [3, 8],
  script: ({ wave }) => {
    let start = 0;
    const goal = 10 + 2 * wave, prize = 40 + 10 * wave;
    return [
      { at: 0, say: `CHALLENGE! Take down ${goal} cows in 15 seconds for ${prize} moolah. GO GO GO!`, call: (game) => { start = game.kills; } },
      {
        at: 15, call: (game) => {
          const got = game.kills - start;
          game.announce('combo', got >= goal
            ? `CHALLENGE COMPLETE! ${got} cows down. +${game.earn(prize)} moolah!`
            : `Challenge failed: ${got}/${goal}. The crowd boos politely.`);
        },
      },
    ];
  },
});

defineSurprise({
  id: 'glitch', name: 'Copy-Paste Glitch', firstWave: 7, weight: 1, delay: [6, 14],
  // Every cow on the field (up to a cap) gets a twin right next to it, at the same health.
  script: ({ wave }) => [
    { at: 0, say: 'ERR0R: C0W.EXE HAS DUPLIC4TED. Ctrl+Z not found.',
      call: (game) => {
        const { cows } = game;
        const src = fieldCows(game, (t) => !t.friendly && t !== COW_TYPES.golden).slice(0, 8 + 2 * wave);
        for (const i of src) {
          const type = COW_TYPE_LIST[cows.type[i]];
          // Twins come from the split stream: they're copies, not new arrivals (and never shift a surprise's spawn draws).
          const j = game.spawnCow(type, cows.x[i], cows.z[i], cows.maxHp[i], game.splitRng, 1);
          if (j >= 0) cows.hp[j] = cows.hp[i];
        }
      } },
  ],
});

defineSurprise({
  id: 'shrinkray', name: 'Shrink Ray', firstWave: 5, weight: 2, delay: [6, 14],
  script: () => [
    { at: 0, say: 'A mad scientist fired a SHRINK RAY! Every cow out there just lost half its health.',
      call: (game) => {
        for (const i of fieldCows(game)) { game.cows.hp[i] *= 0.5; game.cows.hitAge[i] = 0; }
      } },
  ],
});

defineSurprise({
  id: 'gymday', name: 'Leg Day', firstWave: 6, weight: 2, delay: [6, 14],
  // Tougher, but sore: slow for a while.
  script: () => [
    { at: 0, say: 'The cows hit the gym: +60% health! ...but it was LEG DAY. They can barely walk.',
      call: (game) => {
        const { cows } = game;
        for (const i of fieldCows(game, (t) => !t.friendly)) {
          cows.maxHp[i] *= 1.6; cows.hp[i] *= 1.6;
          game.slowCow(i, 0.6, 12);
        }
      } },
  ],
});

defineSurprise({
  id: 'mud', name: 'Mud Season', firstWave: 3, weight: 2, delay: [3, 10],
  // Three big mud puddles where the herd is walking right now (or anywhere, if the field is empty).
  script: () => [
    { at: 0, say: 'It rained all night. MUD PUDDLES on the path! Cows slog through at half speed.',
      call: (game) => {
        const r = game.surpriseRng;
        for (let k = 0; k < 3; k++) {
          let p = null;
          if (game.cows.count) {
            const i = Math.floor(r() * game.cows.count);
            if (COW_TYPE_LIST[game.cows.type[i]].altitude <= 0) p = { x: game.cows.x[i], z: game.cows.z[i] };
          }
          p ??= game.dropPoint();
          if (p) game.zones.push({ x: p.x, z: p.z, radius: 3, t: 0, T: 20, dps: 0, slow: 0.5, tower: 0, color: 0x6b4a2a });
        }
      } },
  ],
});

// ---- the third batch: peak silliness --------------------------------------

/** Steps calling fn(game, k) every `step` s from `from` to `to` (inclusive). */
function every(from, to, step, fn) {
  const out = [];
  for (let k = 0, t = from; t <= to + 1e-9; k++, t = from + k * step) out.push({ at: t, call: (game) => fn(game, k) });
  return out;
}

/** Can this cow be messed with? Not bosses, not the friendly ones, not the Cash Cow. */
const ordinary = (t) => !t.boss && !t.friendly && t !== COW_TYPES.golden;
const walking = (t) => ordinary(t) && t.altitude <= 0;

/** Tip cow i over for `time` s (asleep, posing, collapsed: the sim can't tell). */
function knockOver(game, i, time) {
  game.cows.slowMult[i] = 0;
  game.cows.slowTime[i] = Math.max(game.cows.slowTime[i], time);
}

/** Nearest cow to (x, z) within `reach` m passing `keep`, other than slot `not` and slots in `skip`; -1 if none. Ties to the lower slot. */
function nearestCow(game, x, z, reach, keep = ordinary, not = -1, skip = null) {
  const { cows } = game;
  let best = -1, bestD = reach * reach;
  for (let i = 0; i < cows.count; i++) {
    if (i === not || skip?.has(i) || !keep(COW_TYPE_LIST[cows.type[i]])) continue;
    const d = (cows.x[i] - x) ** 2 + (cows.z[i] - z) ** 2;
    if (d < bestD || (best < 0 && d <= bestD)) { best = i; bestD = d; }
  }
  return best;
}

/** Slots of cows of type `id`, high to low. */
const slotsOfType = (game, id) => fieldCows(game, (t) => t === COW_TYPES[id]);

/** A random cow passing `keep`, or -1. */
function randomCow(game, keep = ordinary) {
  const pool = fieldCows(game, keep);
  return pool.length ? pool[Math.floor(game.surpriseRng() * pool.length)] : -1;
}

defineSurprise({
  id: 'conga', name: 'Conga Line', firstWave: 4, weight: 2,
  script: ({ wave }) => [
    { at: 0, say: 'Da-da-da-da-da-da-da HEY! A CONGA LINE! Take out the leader and the whole line falls over.' },
    {
      at: 0.5, spawn: 'congaleader', count: 1, from: 'random', hp: 1,
      onKill: (game) => {
        const line = slotsOfType(game, 'conga');
        for (const i of line) knockOver(game, i, 4);
        game.announce('conga', `The Conga Leader is down! ${line.length} dancers trip over each other.`);
      },
      onEscape: (game) => game.announce('conga', 'The Conga Leader danced right into your milk. The party never stops.'),
    },
    { at: 1.0, spawn: 'conga', count: 8 + wave, every: 0.35, from: 'same' },
  ],
});

defineSurprise({
  id: 'oppositeday', name: 'Opposite Day', firstWave: 4, weight: 1, delay: [3, 10],
  script: () => [
    { at: 0, say: "IT'S OPPOSITE DAY! For 10 seconds, cows that reach your milk bring you milk instead. Let them through?!",
      call: (game) => game.startMilkGift(10) },
    { at: 10, say: 'Opposite Day is over. (Or is it? Yes. It is.)' },
  ],
});

defineSurprise({
  id: 'prom', name: 'Prom Night', firstWave: 5, weight: 2, delay: [6, 14],
  // The toughest cow on the field gets crowned: triple health, and a big prize for dethroning it.
  script: ({ wave }) => {
    const prize = 40 + 12 * wave;
    return [{
      at: 0, call: (game) => {
        const { cows } = game;
        const [id] = topCowIds(game, 1, (i) => cows.maxHp[i], (t, i) => ordinary(t) && !game.tracked.has(cows.id[i]));
        if (id === undefined) { game.announce('prom', 'It was prom night, but no cows showed up. The punch bowl is untouched.'); return; }
        const i = slotOf(game, id);
        const name = COW_TYPE_LIST[cows.type[i]].name;
        cows.maxHp[i] *= 3; cows.hp[i] *= 3;
        game.tracked.set(id, {
          onKill: (g) => g.announce('prom', `DETHRONED! The Prom Royalty is down. +${g.earn(prize)} moolah!`),
          onEscape: (g) => g.announce('prom', 'The Prom Royalty sipped your milk like a champagne flute. Iconic.'),
        });
        game.announce('prom', `PROM NIGHT! A ${name} was crowned Prom Royalty: triple health. Dethrone it for ${prize} moolah!`, cows.x[i], cows.z[i]);
      },
    }];
  },
});

defineSurprise({
  id: 'hotpotato', name: 'Hot Potato', firstWave: 5, weight: 2, delay: [4, 10],
  // A cow is handed a hot potato that hops to the nearest cow every 2 s, then goes off in the herd.
  script: ({ wave }) => {
    let holder = -1, x = 0, z = 0, done = false;
    const find = (game) => {
      let i = holder >= 0 ? slotOf(game, holder) : -1;
      if (i < 0) i = nearestCow(game, x, z, 1e9); // dropped: whoever is closest picks it up
      if (i >= 0) { holder = game.cows.id[i]; x = game.cows.x[i]; z = game.cows.z[i]; }
      return i;
    };
    return [
      { at: 0, say: 'HOT POTATO! One cow is holding a ticking spud. It keeps getting passed... until it doesn\'t.',
        call: (game) => {
          const i = randomCow(game);
          if (i < 0) { done = true; game.announce('hotpotato', 'Nobody to hand the potato to. You eat it. Delicious.'); return; }
          holder = game.cows.id[i]; x = game.cows.x[i]; z = game.cows.z[i];
        } },
      ...every(2, 12, 2, (game) => {
        if (done) return;
        let i = find(game);
        if (i < 0) return;
        const j = nearestCow(game, x, z, 8, ordinary, i);
        if (j >= 0) { i = j; holder = game.cows.id[j]; x = game.cows.x[j]; z = game.cows.z[j]; }
        game.events.push({ kind: 'splash', x, y: 1.8, z, radius: 0.8, color: 0xffa040 });
      }),
      { at: 14, call: (game) => {
        if (done) return;
        const i = find(game);
        if (i < 0) { game.announce('hotpotato', 'The potato rolled away and went off in an empty field. Mashed.'); return; }
        const kills = game.kills;
        game.events.push({ kind: 'boom', x, z, radius: 4, wrecked: 0 });
        game.splash(x, z, 4, (60 + 10 * wave) * game.hpScale, null);
        game.announce('hotpotato', `KA-SPUD! The potato went off: ${game.kills - kills} cow${game.kills - kills === 1 ? '' : 's'} mashed.`, x, z);
      } },
    ];
  },
});

defineSurprise({
  id: 'lava', name: 'The Floor Is Lava', firstWave: 5, weight: 2, delay: [5, 12],
  script: ({ wave }) => [
    { at: 0, say: 'THE FLOOR IS LAVA! Every cow on the ground catches fire. The flying cows are being smug about it.',
      call: (game) => {
        for (const i of fieldCows(game, walking)) {
          game.igniteCow(i, (4 + 0.6 * wave) * game.hpScale, 5, 0, 0);
          game.events.push({ kind: 'splash', x: game.cows.x[i], y: 0.2, z: game.cows.z[i], radius: 0.7, color: 0xff5a1a });
        }
      } },
  ],
});

defineSurprise({
  id: 'influencer', name: 'Influencer', firstWave: 6, weight: 2,
  // Every 2 s it stops for a selfie and every cow around it stops to pose: free shots, if you can stand it.
  script: () => [
    { at: 0, say: "OMG an INFLUENCER COW. Every few seconds it stops for a selfie and the cows nearby pose. Don't forget to like and subscribe." },
    {
      at: 1, spawn: 'influencer', count: 1, from: 'random',
      onKill: (game) => game.announce('influencer', 'The Influencer has been UNFOLLOWED. Its 3 followers are devastated.'),
      onEscape: (game) => game.announce('influencer', 'The Influencer posted a selfie with your milk. #blessed #stolen'),
    },
    ...every(3, 21, 2, (game) => {
      const { cows } = game;
      for (const v of slotsOfType(game, 'influencer')) {
        const x = cows.x[v], z = cows.z[v];
        game.events.push({ kind: 'splash', x, y: 2, z, radius: 1.6, color: 0xffffff });
        knockOver(game, v, 1.2);
        for (const i of fieldCows(game, walking)) {
          if (i !== v && (cows.x[i] - x) ** 2 + (cows.z[i] - z) ** 2 <= 49) knockOver(game, i, 1.2);
        }
      }
    }),
  ],
});

defineSurprise({
  id: 'stocks', name: 'Cow Stock Exchange', firstWave: 4, weight: 2,
  // Bounties swing wildly every 3 s for 15 s.
  script: () => {
    const prices = [0.5, 1, 2, 3, 4];
    return [
      { at: 0, say: 'The MOO-DAQ is open! Cow prices are going to swing like crazy for 15 seconds. Buy low, shoot high!' },
      ...every(1, 13, 3, (game) => {
        const m = prices[Math.floor(game.surpriseRng() * prices.length)];
        game.bountyMult = m;
        game.bountyTime = 3.05;
        game.announce('stocks', m < 1 ? `MOO-DAQ CRASH! Cows worth ×${m}. HOLD YOUR FIRE (or don't)!`
          : m === 1 ? 'MOO-DAQ: flat. Cows at regular price. Boring.'
          : `MOO-DAQ RALLY! Cows worth ×${m}! SELL SELL SELL (by shooting)!`);
      }),
      { at: 16, say: 'The MOO-DAQ is closed. Your portfolio is... cows.' },
    ];
  },
});

defineSurprise({
  id: 'cardboard', name: 'Cardboard Decoys', firstWave: 5, weight: 2,
  script: ({ wave }) => [
    { at: 0, say: 'A suspicious herd is coming in... wait, are those CARDBOARD CUTOUTS? Your towers are falling for it!' },
    { at: 0.5, spawn: 'decoy', count: 4 + Math.floor(wave / 3), every: 0.5, from: 'random' },
    { at: 1.5, spawn: 'cow', mix: true, count: 3 + Math.floor(wave / 3), every: 0.5, from: 'same' },
  ],
});

defineSurprise({
  id: 'trenchcoat', name: 'Three Calves in a Trenchcoat', firstWave: 4, weight: 2,
  // Towers think it's a farmer. Get it with splash before it gets close, or it pops open by the milk.
  script: () => [
    { at: 0, say: 'A very tall farmer in a trenchcoat is walking toward your milk. Totally normal. Nothing to see here.' },
    { at: 1, spawn: 'trenchcoat', count: 1, from: 'random', hp: 1 },
    ...every(1.5, 22, 0.5, (game) => {
      for (const i of slotsOfType(game, 'trenchcoat')) {
        if (game.cowPathDistance(i) > 25) continue;
        const x = game.cows.x[i], z = game.cows.z[i];
        game.burstCow(i);
        game.announce('trenchcoat', 'IT WAS THREE CALVES IN A TRENCHCOAT THE WHOLE TIME!', x, z);
      }
    }),
  ],
});

defineSurprise({
  id: 'tipjar', name: 'Tip Jar', firstWave: 3, weight: 1,
  script: ({ wave }) => [{
    at: 0, call: (game) => {
      const n = fieldCows(game, ordinary).length;
      if (n === 0) { game.announce('tipjar', `An empty field left you a tip out of pity: ${game.earn(1)} moolah.`); return; }
      const paid = game.earn(Math.min(2 * n, 60 + 5 * wave));
      game.announce('tipjar', `For once, the cows tip YOU! ${n} cows chipped in ${paid} moolah. They still want your milk.`);
    },
  }],
});

defineSurprise({
  id: 'speedtrap', name: 'Speed Trap', firstWave: 5, weight: 2, delay: [5, 14],
  // Every walker over the limit gets a ticket (you keep the fine) and a slow-down.
  script: ({ wave }) => [{
    at: 0, call: (game) => {
      const { cows } = game;
      let tickets = 0;
      for (const i of fieldCows(game, walking)) {
        const t = COW_TYPE_LIST[cows.type[i]];
        const v = t.speed * (cows.slowTime[i] > 0 ? cows.slowMult[i] : 1);
        if (v <= 4.5) continue;
        tickets++;
        game.slowCow(i, 0.5, 8);
      }
      game.announce('speedtrap', tickets
        ? `WEE-OO WEE-OO! SPEED TRAP! ${tickets} cow${tickets === 1 ? '' : 's'} ticketed and slowed. You keep the fines: +${game.earn(tickets * (3 + Math.floor(wave / 4)))} moolah.`
        : 'A cow cop set up a speed trap. Nobody was speeding. The cop eats a donut.');
    },
  }],
});

defineSurprise({
  id: 'godcow', name: 'Fairy Godcow', firstWave: 3, weight: 1,
  script: ({ wave }) => [{
    at: 0, call: (game) => {
      const can = [...game.towers.values()].filter((t) => t.def.upgrades.length > 0);
      if (can.length) {
        const t = can[Math.floor(game.surpriseRng() * can.length)];
        const form = game.autoNext(t.def), cost = TOWER_FORMS[form].upgradeCost;
        game.money += cost; // she pays for it
        if (game.upgradeTower(t.id, form).ok) {
          game.announce('godcow', `A FAIRY GODCOW waved her wand: your ${t.def.name} got a free upgrade! Bibbidi-bobbidi-MOO.`, t.x, t.z);
          return;
        }
        game.money -= cost;
      }
      game.announce('godcow', `A FAIRY GODCOW found nothing to upgrade, so she left ${game.earn(30 + 5 * wave)} moolah under your pillow.`);
    },
  }],
});

defineSurprise({
  id: 'tourists', name: 'Wrong Farm', firstWave: 3, weight: 2,
  // Tourist cows wander in, realise they're at the wrong farm, and leave. Shoot them for cash before they go.
  script: ({ wave }) => [
    { at: 0, say: 'A tour bus! TOURIST COWS are taking photos of your towers. Bag a few before they leave!' },
    { at: 0.5, spawn: 'tourist', count: 6 + Math.floor(wave / 2), every: 0.3, from: 'random' },
    { at: 9, call: (game) => {
      let n = 0;
      for (const i of slotsOfType(game, 'tourist')) if (game.abductCow(i)) n++;
      game.announce('tourists', n
        ? `"...this is the WRONG FARM. We wanted the CHEESE farm." ${n} tourist${n === 1 ? '' : 's'} got back on the bus.`
        : 'The tour bus left empty. Nobody got back on. You monster.');
    } },
  ],
});

defineSurprise({
  id: 'gps', name: 'GPS Outage', firstWave: 4, weight: 2, delay: [5, 14],
  script: () => [
    { at: 0, say: 'The cow GPS satellite went down! The herd is walking in circles. "Recalculating..."', call: (game) => game.startGpsOutage(6) },
    { at: 6, say: 'GPS is back. "In 200 metres, turn toward the milk."' },
  ],
});

defineSurprise({
  id: 'moshpit', name: 'Mosh Pit', firstWave: 6, weight: 2, delay: [5, 14],
  // Crowded cows hurt each other: up to 60% of max HP for a cow with five or more neighbours.
  script: () => [
    { at: 0, say: 'Someone put on heavy metal. MOSH PIT! The more crowded the cows, the more they hurt each other.',
      call: (game) => {
        const { cows } = game;
        const pad = MAX_COW_RADIUS();
        const hurt = [];
        for (const i of fieldCows(game, ordinary)) {
          let n = 0;
          for (const k of game.cowHash.near(cows, cows.x[i], cows.z[i], 2.5 + pad)) {
            if (k !== i && (cows.x[k] - cows.x[i]) ** 2 + (cows.z[k] - cows.z[i]) ** 2 <= 2.5 * 2.5) n++;
          }
          if (n) hurt.push([i, 0.12 * Math.min(n, 5) * cows.maxHp[i]]);
        }
        let moshed = 0;
        // fieldCows lists slots high to low, so kills never move an unhit cow into a slot still to come.
        for (const [i, d] of hurt) { game.damageCow(i, d, null); moshed++; }
        game.announce('moshpit', moshed ? `\\m/ ${moshed} cows moshed! \\m/` : 'Nobody moshed. The cows are standing too far apart. Lame.');
      } },
  ],
});

defineSurprise({
  id: 'costume', name: 'Costume Party', firstWave: 5, weight: 2, delay: [5, 14],
  // Every cow on the field dresses up as a random other cow from this wave (and keeps its share of health).
  script: () => [
    { at: 0, say: "COSTUME PARTY! Every cow out there just dressed up as a different cow. Don't trust anyone.",
      call: (game) => {
        const mix = waveMix(game.wave);
        for (const i of fieldCows(game, ordinary)) game.setCowType(i, pickFromMix(mix, game.surpriseRng()));
      } },
  ],
});

defineSurprise({
  id: 'icerink', name: 'Ice Rink', firstWave: 4, weight: 2, delay: [5, 14],
  script: () => [
    { at: 0, say: 'A cold snap froze the field into an ICE RINK! Cows are faster but can NOT take corners.', call: (game) => game.startIce(8) },
    { at: 8, say: 'The ice melted. The cows are pretending that never happened.' },
  ],
});

defineSurprise({
  id: 'bowling', name: 'Cosmic Bowling', firstWave: 5, weight: 2, delay: [4, 12],
  // A giant bowling ball rolls from a spawner down the cows' path to the milk, flattening walkers on the way.
  script: ({ wave }) => {
    let cell = -1, kills = 0, done = false;
    return [
      { at: 0, say: 'A GIANT BOWLING BALL is rolling down the lane! STEE-RIKE?',
        call: (game) => {
          const s = game.spawners[Math.floor(game.surpriseRng() * game.spawners.length)];
          cell = s.cell; kills = game.kills;
        } },
      ...every(1, 9, 0.15, (game) => {
        if (done || cell < 0) return;
        const { grid } = game;
        for (let k = 0; k < 2 && cell >= 0 && !grid.goal[cell]; k++) cell = grid.next[cell];
        if (cell < 0 || grid.goal[cell]) {
          done = true;
          const n = game.kills - kills;
          game.announce('bowling', n >= 8 ? `STEE-RIKE!!! ${n} cows bowled over!` : n >= 3 ? `Spare. ${n} cows down.` : n ? `${n} cow${n === 1 ? '' : 's'}. Bit of a gutter ball.` : 'Gutter ball. Not a single cow. Embarrassing.');
          return;
        }
        const x = grid.centerX(cell), z = grid.centerZ(cell);
        game.events.push({ kind: 'splash', x, y: 1, z, radius: 1.8, color: 0x2a2a6a });
        game.splash(x, z, 1.8, (150 + 20 * wave) * game.hpScale, null);
      }),
    ];
  },
});

defineSurprise({
  id: 'yawn', name: 'Contagious Yawn', firstWave: 4, weight: 2, delay: [5, 14],
  // One cow nods off, and the yawn spreads to every cow within 3 m of a sleeper, once a second.
  script: () => {
    const asleep = new Set();
    const spread = (game) => {
      const { cows } = game;
      const sleepers = [];
      for (let i = 0; i < cows.count; i++) if (asleep.has(cows.id[i])) sleepers.push(i);
      for (const i of fieldCows(game, walking)) {
        if (asleep.has(cows.id[i])) continue;
        if (sleepers.some((s) => (cows.x[s] - cows.x[i]) ** 2 + (cows.z[s] - cows.z[i]) ** 2 <= 9)) {
          asleep.add(cows.id[i]);
          knockOver(game, i, 4);
        }
      }
    };
    return [
      { at: 0, say: '*YAAAAWN* One cow yawned... oh no, it\'s CONTAGIOUS.',
        call: (game) => {
          const i = randomCow(game, walking);
          if (i < 0) return;
          asleep.add(game.cows.id[i]);
          knockOver(game, i, 4);
        } },
      ...every(1, 6, 1, spread),
      { at: 7, call: (game) => game.announce('yawn', asleep.size > 1 ? `${asleep.size} cows caught the yawn and took a nap. Zzz.` : 'Nobody caught the yawn. Tough crowd.') },
    ];
  },
});

defineSurprise({
  id: 'bingo', name: 'Cow Bingo', firstWave: 4, weight: 2, delay: [5, 14],
  // Every cow's ear tag ending in the drawn number is out (you get the bounty).
  script: () => [{
    at: 0, call: (game) => {
      const n = Math.floor(game.surpriseRng() * 10);
      let out = 0;
      for (const i of fieldCows(game, ordinary)) {
        if (game.cows.id[i] % 10 !== n) continue;
        game.events.push({ kind: 'splash', x: game.cows.x[i], y: 1.4, z: game.cows.z[i], radius: 1, color: 0xff3af0 });
        game.damageCow(i, Infinity, null);
        out++;
      }
      game.announce('bingo', `B-I-N-G-O! The number is ${n}! Every cow with an ear tag ending in ${n} is OUT: ${out} cow${out === 1 ? '' : 's'}.`);
    },
  }],
});

defineSurprise({
  id: 'love', name: 'Love Is in the Air', firstWave: 5, weight: 2, delay: [5, 14],
  // Pairs of cows standing close fall in love and run off together. They leave you a thank-you card.
  script: ({ wave }) => [{
    at: 0, call: (game) => {
      const { cows } = game;
      const used = new Set(), pairs = [];
      const cap = 4 + Math.floor(wave / 3);
      for (const i of fieldCows(game, walking).reverse()) {
        if (pairs.length >= cap) break;
        if (used.has(i)) continue;
        const j = nearestCow(game, cows.x[i], cows.z[i], 2.2, walking, i, used);
        if (j < 0) continue;
        used.add(i); used.add(j);
        pairs.push([cows.id[i], cows.id[j]]);
      }
      let gift = 0;
      for (const pair of pairs) {
        for (const id of pair) {
          const i = slotOf(game, id);
          if (i < 0) continue;
          gift += COW_TYPE_LIST[cows.type[i]].bounty / 2;
          game.events.push({ kind: 'splash', x: cows.x[i], y: 2, z: cows.z[i], radius: 1, color: 0xff5a8a });
          game.abductCow(i);
        }
      }
      game.announce('love', pairs.length
        ? `<3 LOVE IS IN THE AIR <3 ${pairs.length} cow couple${pairs.length === 1 ? '' : 's'} ran off together. They left a thank-you card with ${game.earn(gift)} moolah.`
        : 'Love was in the air, but every cow kept its distance. Very British.');
    },
  }],
});

defineSurprise({
  id: 'speaker', name: 'Moo-tivational Speaker', firstWave: 6, weight: 2,
  // While it lives, every cow within 8 m is fired up (faster).
  script: () => [
    { at: 0, say: '"YOU CAN DO IT! BELIEVE IN YOUR MILK!" A MOO-TIVATIONAL SPEAKER is pumping up the herd. Shut it down!' },
    {
      at: 1, spawn: 'speaker', count: 1, from: 'random',
      onKill: (game) => game.announce('speaker', 'The speech is over. Nobody was moo-tivated. The herd goes back to its slump.'),
    },
    ...every(2, 22, 1, (game) => {
      const { cows } = game;
      for (const v of slotsOfType(game, 'speaker')) {
        for (const i of fieldCows(game, ordinary)) {
          if (i !== v && (cows.x[i] - cows.x[v]) ** 2 + (cows.z[i] - cows.z[v]) ** 2 <= 64) game.slowCow(i, 1.5, 1.2);
        }
      }
    }),
  ],
});

defineSurprise({
  id: 'combine', name: 'Cow-mbine!', firstWave: 7, weight: 2, delay: [5, 14],
  // Up to five cows standing together bolt into one MECHA-MOO with all their health.
  script: () => [
    { at: 0, say: 'Cows... ASSEMBLE! Five cows are forming a MECHA-MOO!' },
    { at: 2, call: (game) => {
      const { cows } = game;
      const seed = randomCow(game, walking);
      const parts = [];
      if (seed >= 0) {
        const x = cows.x[seed], z = cows.z[seed];
        for (const i of fieldCows(game, walking)) {
          const d = (cows.x[i] - x) ** 2 + (cows.z[i] - z) ** 2;
          if (d <= 36) parts.push({ id: cows.id[i], d });
        }
        parts.sort((a, b) => a.d - b.d || a.id - b.id).splice(5);
      }
      if (parts.length < 3) { game.announce('combine', 'The cows tried to combine, but there weren\'t enough of them. Awkward high-fives all round.'); return; }
      let hp = 0, x = 0, z = 0;
      const first = slotOf(game, parts[0].id), fx = cows.x[first], fz = cows.z[first];
      for (const { id } of parts) {
        const i = slotOf(game, id);
        hp += cows.hp[i]; x += cows.x[i]; z += cows.z[i];
        game.abductCow(i);
      }
      x /= parts.length; z /= parts.length;
      const c = game.grid.cellAt(x, z);
      if (c < 0 || !game.grid.walkable(c)) { x = fx; z = fz; } // the middle of the huddle is a wall: build it where the closest one stood
      // Built from the split stream: it's made of cows already on the field, not a new arrival.
      const j = game.spawnCow(COW_TYPES.mecha, x, z, hp, game.splitRng, 0);
      game.events.push({ kind: 'splash', x, y: 1.5, z, radius: 2.5, color: 0x9aa8ff });
      game.announce('combine', j >= 0 ? `MECHA-MOO ONLINE! ${parts.length} cows, ${Math.round(hp)} HP of pure beef robot.` : 'The Mecha-Moo fell apart before it could stand up.', x, z);
    } },
  ],
});

defineSurprise({
  id: 'gale', name: 'Gale Force', firstWave: 6, weight: 1, delay: [5, 14],
  // Flying cows are blown 20 m back, away from the milk.
  script: () => [{
    at: 0, call: (game) => {
      const { cows, grid } = game;
      let n = 0;
      for (const i of fieldCows(game, (t) => ordinary(t) && t.altitude > 0)) {
        const dx = cows.x[i] - game.milkX, dz = cows.z[i] - game.milkZ, len = Math.hypot(dx, dz) || 1;
        for (const push of [20, 10]) {
          const x = cows.x[i] + (dx / len) * push, z = cows.z[i] + (dz / len) * push;
          if (grid.cellAt(x, z) < 0) continue;
          game.teleportCow(i, x, z);
          n++;
          break;
        }
      }
      game.announce('gale', n
        ? `GALE FORCE WINDS! ${n} flying cow${n === 1 ? '' : 's'} blown way back. Wheeeee!`
        : 'A huge gust blew through. No flying cows to blow away. A farmer lost a hat, though.');
    },
  }],
});

defineSurprise({
  id: 'icecream', name: 'Ice Cream Truck', firstWave: 5, weight: 2, delay: [4, 12],
  // The jingle pulls every walker within 12 m into a tight crowd round the truck for 5 s. Splash time.
  script: () => {
    let p = null;
    return [
      { at: 0, say: '♪ Do-do-do-do-dooo ♪ The ICE CREAM TRUCK is here! The cows are queueing up. Perfect splash target.',
        call: (game) => {
          const i = randomCow(game, walking);
          p = i >= 0 ? { x: game.cows.x[i], z: game.cows.z[i] } : game.dropPoint();
          if (p) game.events.push({ kind: 'splash', x: p.x, y: 1.2, z: p.z, radius: 2, color: 0xffb8e0 });
        } },
      ...every(0.1, 5, 0.1, (game) => {
        if (!p) return;
        const { cows, grid } = game;
        for (const i of fieldCows(game, walking)) {
          const dx = p.x - cows.x[i], dz = p.z - cows.z[i], d = Math.hypot(dx, dz);
          if (d > 12) continue;
          if (d > 0.8) {
            const x = cows.x[i] + (dx / d) * 0.2, z = cows.z[i] + (dz / d) * 0.2;
            const c = grid.cellAt(x, z);
            if (c >= 0 && grid.walkable(c)) game.teleportCow(i, x, z);
          }
          game.slowCow(i, 0.2, 0.4);
        }
      }),
      { at: 5.5, say: 'The ice cream truck drove off. The cows are sad and lactose-confused.' },
    ];
  },
});
