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
//                       wave's scale), from ('random' | 'all' | 'flank'),
//                       mix: true to draw each cow from the wave's mix instead,
//                       and optional onKill / onEscape (game, cowId) for the cows
//   call: (game) => {}  anything else (lulls, rushes, money)
//
// See Game.rollSurprises / updateSurprises for the runner.

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
        onKill: (game) => { game.money += prize; game.announce('cashcow', `Cash cow cashed: +${prize} moolah!`); },
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
    { at: 0, say: `A farmer dropped their wallet. +${30 + 8 * wave} moolah!`, call: (game) => { game.money += 30 + 8 * wave; } },
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
          game.money += cash;
          game.announce('milkman', `The milkman found your tank full and tipped you ${cash} moolah.`);
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
