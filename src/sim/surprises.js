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

import { COW_TYPE_LIST, COW_TYPES } from './cows.js';

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
