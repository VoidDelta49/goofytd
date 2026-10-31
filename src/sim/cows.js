// Cow enemies. Types are plain data in a registry; live cows sit in flat
// typed arrays (structure of arrays) so thousands of them stay cheap and
// allocation-free in the hot loop. Pure: no three.js, no DOM.

/**
 * Cow types by id. To add one, call defineCow() with these fields:
 *   id, name, hp, speed (m/s), bounty (moolah on kill), damage (milk taken
 *   on arrival), radius (m, for hits and spacing), scale (visual size), color
 *   (tint multiplied over the cow's own colours).
 * Optional behaviour:
 *   altitude     metres above the ground; > 0 means it flies: straight at the
 *                milk over walls and towers, ignored by placement, and only
 *                towers with hitsAir can shoot it (splash lands under it)
 *   blastRadius  > 0 means it explodes when it walks up to a tower, wrecking
 *                every tower within this many metres (no refund)
 *   armor        flat damage taken off every direct hit (never below 25% of
 *                the hit); damage over time (slicks) ignores it
 *   splitInto, splitCount   on death, this many cows of type splitInto pop
 *                out where it fell (at the current wave's HP)
 *   enrageBelow, enrageSpeed   under this fraction of its max HP it runs at
 *                speed × enrageSpeed
 *   healRate, healRadius   every HEAL_PULSE s, other cows within healRadius m
 *                get healRate × HEAL_PULSE of their max HP back
 *   camo         towers can't pick it as a target until it's within this many
 *                metres (splash, spray and auras still hit it)
 *   ramDamage    > 0: a Headbutt Heifer. When a tower is within RAM_REACH of
 *                its edge it stops, winds up for `windup` s (a 'windup' event:
 *                snort, lean back) and headbutts it for ramDamage tower HP.
 *                Then it can't again for `abilityCooldown` s
 *   spitRange, spitStun, spitDamage   a Cud Spitter: stops, winds up, and spits
 *                at the nearest shooting tower within spitRange m that isn't
 *                already stunned: it can't fire for spitStun s (never stacks)
 *   windup, abilityCooldown   for both of the above. A tipped cow can't act,
 *                and tipping it mid wind-up cancels the attack
 *   firstWave, weight   when it starts showing up in waves, and how often
 *                relative to the others (see waveMix)
 *   boss         a boss: spawned by boss waves (Game.bossEvery), gets the boss
 *                health bar, can't be tipped, and runs its own attack script
 *                (see `bossAttacks` and Game.bossAct). Bosses keep their extra
 *                state in Game.bosses, keyed by cow id
 *   upright      drawn standing on its hind legs (its own model)
 *   slowResist   0..1: this much of every slow is shrugged off (0.5 halves it)
 *   friendly     towers never pick it as a target (splash and sprays still hit it)
 *   blurb        one line for the "new cow" announcement
 * The big herd (wave 3+), each optional:
 *   shield       HP of a bubble that soaks damage first (scales with the wave like HP)
 *   dodgeEvery   every n-th direct hit misses it
 *   regen        heals this fraction of its max HP per second
 *   sprint       { period, time, mult }: for `time` s of every `period` s it runs × mult
 *   panic        runs × (1 + panic × fraction of HP lost)
 *   lastDash     { within, mult }: × mult once its path to the milk is under `within` m
 *   blink        { every, cells }: teleports `cells` cells along its path every `every` s
 *   lay          { every, type }: drops a cow of `type` behind it every `every` s
 *   swapEvery    every n s it swaps places with the cow nearest the milk
 *   burrow       { period, hidden }: underground for `hidden` s of every `period` s
 *                (no targeting, no damage at all)
 *   phase        { period, hidden }: invisible to targeting for `hidden` s of every
 *                `period` s (splash still hits it)
 *   straight     walks straight at the milk over towers and walls, like a flyer on foot
 *   zigzag       { amp, freq }: weaves side to side (amp × its speed)
 *   taunt        towers that can see it must shoot it first
 *   shellproof   mortar shells (and their statuses) don't touch it
 *   burnImmune, chillImmune   fire / brain freeze (and marks) don't stick
 *   burnVuln     burns hurt × this
 *   slowInvert   every slow (and stun) makes it faster instead
 *   jamEvery     { n, time }: every n-th direct hit jams the tower that shot it
 *   steal        moolah it takes when it reaches the milk (never below 0)
 *   guard        { radius, mult }: cows within radius (itself too) take × mult damage
 *   yawn         { radius, mult }: towers within radius reload × mult as fast (worst one counts)
 *   cheer        { radius, mult }: other cows within radius run × mult (every heal pulse)
 *   revive       once per cow: at 0 HP it gets back up with this fraction of max HP
 *   mitosis      the first time it drops under half HP it splits into two (no bounty)
 *   deathHaste   { radius, mult, time }: when it drops, nearby cows run faster
 *   deathEmp     { radius, stun }: when it drops, towers within radius are jammed
 *   deathSpikes  { radius, damage }: when it drops, towers within radius take damage
 *   deathHeal    { radius, frac }: when it drops, nearby cows heal frac of max HP
 */
export const COW_TYPES = {};
/** Index -> type, so a cow stores its type as a small integer. */
export const COW_TYPE_LIST = [];

/** Seconds between a Vet Cow's heals. */
export const HEAL_PULSE = 0.5;

export function defineCow(def) {
  for (const k of ['id', 'hp', 'speed', 'bounty', 'damage', 'radius']) {
    if (def[k] === undefined) throw new Error(`cow type ${def.id}: missing ${k}`);
  }
  if (def.splitInto && !(def.splitCount > 0)) throw new Error(`cow type ${def.id}: splitInto needs splitCount`);
  if ((def.ramDamage > 0 || def.spitRange > 0) && !(def.windup > 0 && def.abilityCooldown > 0)) {
    throw new Error(`cow type ${def.id}: an attack needs windup and abilityCooldown`);
  }
  if ([def.blink, def.lay, def.swapEvery].filter(Boolean).length > 1) throw new Error(`cow type ${def.id}: blink, lay and swapEvery share one timer`);
  if (COW_TYPES[def.id]) throw new Error(`cow type ${def.id} defined twice`);
  if (COW_TYPE_LIST.length >= 256) throw new Error('too many cow types (stored as a byte)');
  const t = Object.freeze({
    name: def.id, scale: 1, color: 0xffffff, altitude: 0, blastRadius: 0, firstWave: 1, weight: 1,
    armor: 0, splitInto: null, splitCount: 0, enrageBelow: 0, enrageSpeed: 1, healRate: 0, healRadius: 0, camo: 0,
    ramDamage: 0, spitRange: 0, spitStun: 0, spitDamage: 0, windup: 0, abilityCooldown: 0,
    boss: null, upright: false, slowResist: 0, friendly: false, blurb: '',
    shield: 0, dodgeEvery: 0, regen: 0, sprint: null, panic: 0, lastDash: null, blink: null, lay: null, swapEvery: 0,
    burrow: null, phase: null, straight: false, zigzag: null, taunt: false, shellproof: false,
    burnImmune: false, chillImmune: false, burnVuln: 1, slowInvert: false, jamEvery: null, steal: 0,
    guard: null, yawn: null, cheer: null, revive: 0, mitosis: false,
    deathHaste: null, deathEmp: null, deathSpikes: null, deathHeal: null,
    ...def, index: COW_TYPE_LIST.length,
  });
  COW_TYPES[def.id] = t;
  COW_TYPE_LIST.push(t);
  return t;
}

/** Cow types that can appear in wave `wave`, with their weights: [{ type, weight }]. */
export function waveMix(wave) {
  return COW_TYPE_LIST.filter((t) => t.weight > 0 && t.firstWave <= wave).map((t) => ({ type: t, weight: t.weight }));
}

/** Pick from a waveMix with r in [0, 1). Deterministic for a given r. */
export function pickFromMix(mix, r) {
  let total = 0;
  for (const m of mix) total += m.weight;
  let x = r * total;
  for (const m of mix) {
    if (x < m.weight) return m.type;
    x -= m.weight;
  }
  return mix[mix.length - 1].type;
}

/** Cow types that show up for the first time in wave `wave` (for the HUD). */
export function cowDebuts(wave) {
  return COW_TYPE_LIST.filter((t) => t.weight > 0 && t.firstWave === wave && wave > 1);
}

defineCow({
  id: 'cow', name: 'Cow', hp: 30, speed: 3.2, bounty: 4, damage: 5, radius: 0.55, scale: 1, color: 0xffffff,
  weight: 10,
});

defineCow({
  id: 'fast', name: 'Zoomies Cow', hp: 16, speed: 7, bounty: 3, damage: 3, radius: 0.45, scale: 0.75, color: 0xfff09a,
  firstWave: 3, weight: 4,
});

defineCow({
  id: 'big', name: 'Big Cow', hp: 170, speed: 2.1, bounty: 16, damage: 15, radius: 0.9, scale: 1.7, color: 0xf0dcc0,
  firstWave: 4, weight: 2,
});

defineCow({
  id: 'flying', name: 'Flying Cow', hp: 24, speed: 3.8, bounty: 6, damage: 5, radius: 0.5, scale: 0.9, color: 0xbfe0ff,
  altitude: 4, firstWave: 5, weight: 3,
});

defineCow({
  id: 'boomer', name: 'Kaboom Cow', hp: 45, speed: 3.4, bounty: 8, damage: 10, radius: 0.55, scale: 1.05, color: 0xff5a4a,
  blastRadius: 2.6, firstWave: 6, weight: 2,
});

defineCow({
  id: 'tin', name: 'Tin Cow', hp: 60, speed: 2.6, bounty: 9, damage: 8, radius: 0.6, scale: 1.1, color: 0xb8c4cc,
  armor: 4, firstWave: 7, weight: 2,
});

defineCow({
  id: 'mama', name: 'Mama Cow', hp: 70, speed: 2.8, bounty: 6, damage: 8, radius: 0.65, scale: 1.25, color: 0xffc8dc,
  splitInto: 'calf', splitCount: 3, firstWave: 8, weight: 2,
});

defineCow({
  id: 'bull', name: 'Raging Bull', hp: 80, speed: 3.0, bounty: 10, damage: 10, radius: 0.65, scale: 1.2, color: 0x9a5434,
  enrageBelow: 0.5, enrageSpeed: 2.2, firstWave: 9, weight: 2,
});

defineCow({
  id: 'vet', name: 'Vet Cow', hp: 50, speed: 3.0, bounty: 12, damage: 5, radius: 0.55, scale: 1, color: 0xa8ffb8,
  healRate: 0.06, healRadius: 4.5, firstWave: 10, weight: 1,
});

defineCow({
  id: 'ninja', name: 'Ninja Cow', hp: 35, speed: 4.2, bounty: 9, damage: 6, radius: 0.5, scale: 0.9, color: 0x3a3a4a,
  camo: 7, firstWave: 11, weight: 1,
});

// Cows that hit back. Both stand still while they wind up, so they're free shots,
// and both are easy to read: a snort and a lean back, or a puffed-up green spitter.

defineCow({
  id: 'ram', name: 'Headbutt Heifer', hp: 80, speed: 2.8, bounty: 11, damage: 8, radius: 0.6, scale: 1.15, color: 0x8a6a5a,
  ramDamage: 20, windup: 0.9, abilityCooldown: 2.2, firstWave: 12, weight: 2,
});

defineCow({
  id: 'spitter', name: 'Cud Spitter', hp: 40, speed: 3.0, bounty: 9, damage: 5, radius: 0.55, scale: 1, color: 0x9ad36a,
  spitRange: 9, spitStun: 2.5, spitDamage: 5, windup: 0.7, abilityCooldown: 5, firstWave: 13, weight: 1,
});

// Surprise-only cows (weight 0: never in a wave mix; surprises.js spawns them).

defineCow({
  id: 'golden', name: 'Cash Cow', hp: 40, speed: 5.2, bounty: 0, damage: 2, radius: 0.5, scale: 0.95, color: 0xffc933,
  weight: 0,
});

defineCow({
  // radius > cell/2 gives no herd offset, so she walks cell centres and never clips towers.
  id: 'bessie', name: 'Big Bessie', hp: 400, speed: 1.6, bounty: 60, damage: 40, radius: 1.1, scale: 2.5, color: 0xd9a066,
  weight: 0,
});

// The boss. Spawned by boss waves (every Game cfg.bossEvery waves), never by a mix.
// Every attack is telegraphed and she stands still for it, so each one is also a window of free shots.

defineCow({
  id: 'bigmama', name: 'BIG MAMA BESSIE', hp: 2000, speed: 1.5, bounty: 300, damage: 60, radius: 1.1, scale: 2.1, color: 0xffffff,
  // Mild armour: a swarm of chip damage is weak against her, real guns aren't.
  armor: 3, slowResist: 0.5, upright: true, weight: 0,
  // Last phase: MAMA IS ANGRY. Faster and stomps more often (reuses the Raging Bull enrage).
  enrageBelow: 1 / 3, enrageSpeed: 1.4,
  boss: Object.freeze({
    /** Hoof Stomp: rears up and slams the ground. Every tower within `radius` m (to its edge) takes `damage` and is stunned. */
    stomp: Object.freeze({ radius: 7, damage: 15, stun: 1.5, windup: 1.4, cooldown: 9, angryCooldown: 6, first: 4 }),
    /** Purse Wallop: a tower right next to her gets her handbag. */
    wallop: Object.freeze({ damage: 45, windup: 0.9, cooldown: 4 }),
    /** "MAMA'S BABIES!": under each fraction of max HP she stops, bellows, and calls cows of `type` to her side. */
    summon: Object.freeze({ at: Object.freeze([2 / 3, 1 / 3]), type: 'mama', count: 2, bellow: 1.5 }),
  }),
});

defineCow({
  id: 'calf', name: 'Calf', hp: 6, speed: 4.5, bounty: 1, damage: 1, radius: 0.35, scale: 0.5, color: 0xffffff,
  weight: 0,
});

defineCow({
  id: 'trojan', name: 'Trojan Cow', hp: 120, speed: 2.4, bounty: 10, damage: 12, radius: 0.85, scale: 1.6, color: 0x9a7a50,
  splitInto: 'fast', splitCount: 6, weight: 0,
});

defineCow({
  id: 'megamama', name: 'Mega Mama', hp: 220, speed: 2.0, bounty: 20, damage: 20, radius: 0.95, scale: 2.0, color: 0xff9ec0,
  splitInto: 'mama', splitCount: 3, weight: 0,
});

// More surprise-only cows (see the second batch in surprises.js).

defineCow({
  id: 'ghost', name: 'Ghost Cow', hp: 18, speed: 3.4, bounty: 7, damage: 4, radius: 0.5, scale: 0.95, color: 0xe8f0ff,
  altitude: 3, camo: 6, weight: 0,
});

defineCow({
  // Flies straight over everything and goes off on the first tower it passes: shoot them down first.
  id: 'kamikaze', name: 'Kamikaze Cow', hp: 14, speed: 4.6, bounty: 9, damage: 6, radius: 0.5, scale: 0.85, color: 0xff8a3a,
  altitude: 2.5, blastRadius: 1.8, weight: 0,
});

defineCow({
  id: 'balloon', name: 'Balloon Cow', hp: 140, speed: 1.6, bounty: 22, damage: 10, radius: 0.8, scale: 1.4, color: 0xff8a5c,
  altitude: 7, weight: 0,
});

defineCow({
  // Buttered up: slows slide right off (tipping still works).
  id: 'greased', name: 'Greased Cow', hp: 50, speed: 4.0, bounty: 8, damage: 6, radius: 0.55, scale: 1, color: 0xfff3b0,
  slowResist: 1, weight: 0,
});

defineCow({
  // Heavy plate; dent it under 40% and it charges.
  id: 'knight', name: 'Cow-valry Knight', hp: 90, speed: 2.4, bounty: 14, damage: 10, radius: 0.65, scale: 1.2, color: 0xd0d8e8,
  armor: 9, enrageBelow: 0.4, enrageSpeed: 2, weight: 0,
});

defineCow({
  id: 'blob', name: 'Blob Cow', hp: 60, speed: 2.6, bounty: 4, damage: 8, radius: 0.7, scale: 1.3, color: 0x9cf0e0,
  splitInto: 'blobling', splitCount: 2, weight: 0,
});

defineCow({
  id: 'blobling', name: 'Blobling', hp: 26, speed: 3.2, bounty: 3, damage: 4, radius: 0.5, scale: 0.9, color: 0x9cf0e0,
  splitInto: 'blobette', splitCount: 2, weight: 0,
});

defineCow({
  id: 'blobette', name: 'Blobette', hp: 10, speed: 3.8, bounty: 2, damage: 2, radius: 0.35, scale: 0.6, color: 0x9cf0e0,
  weight: 0,
});

defineCow({
  id: 'pinata', name: 'Piñata Cow', hp: 150, speed: 2.2, bounty: 5, damage: 10, radius: 0.75, scale: 1.4, color: 0xff66cc,
  splitInto: 'calf', splitCount: 6, weight: 0,
});

defineCow({
  // Kill it and the bottom half keeps coming.
  id: 'zombie', name: 'Zombie Cow', hp: 45, speed: 2.2, bounty: 6, damage: 6, radius: 0.55, scale: 1, color: 0x8fae6a,
  splitInto: 'crawler', splitCount: 1, weight: 0,
});

defineCow({
  id: 'crawler', name: 'Zombie Cow (bottom half)', hp: 20, speed: 1.4, bounty: 3, damage: 3, radius: 0.45, scale: 0.7, color: 0x6f8e4a,
  weight: 0,
});

defineCow({
  // Towers won't aim at it; your splash and sprays still can. Takes no milk: it just wants its mum.
  id: 'lostcalf', name: 'Lost Calf', hp: 30, speed: 3.0, bounty: 0, damage: 0, radius: 0.35, scale: 0.55, color: 0xffe0f0,
  friendly: true, weight: 0,
});

defineCow({
  id: 'alien', name: 'Moo-tant', hp: 40, speed: 3.8, bounty: 8, damage: 6, radius: 0.5, scale: 0.85, color: 0x7affd0,
  weight: 0,
});

// Third batch of surprise-only cows.

defineCow({
  id: 'conga', name: 'Conga Cow', hp: 28, speed: 3.0, bounty: 4, damage: 4, radius: 0.5, scale: 0.95, color: 0xff6ad5,
  weight: 0,
});

defineCow({
  id: 'congaleader', name: 'Conga Leader', hp: 90, speed: 3.0, bounty: 12, damage: 6, radius: 0.55, scale: 1.1, color: 0xffe14d,
  weight: 0,
});

defineCow({
  // Stops every few seconds for a selfie, and everyone nearby stops to pose.
  id: 'influencer', name: 'Influencer Cow', hp: 60, speed: 2.8, bounty: 15, damage: 6, radius: 0.55, scale: 1, color: 0xffa6e8,
  weight: 0,
});

defineCow({
  // Cardboard: lots of "health", takes no milk, pays nothing worth mentioning. Towers fall for it anyway.
  id: 'decoy', name: 'Cardboard Cow', hp: 150, speed: 2.5, bounty: 1, damage: 0, radius: 0.55, scale: 1, color: 0xc49a6c,
  weight: 0,
});

defineCow({
  // Towers think it's a tall farmer and won't aim at it. Near the milk, the calves come out.
  id: 'trenchcoat', name: 'Suspiciously Tall Farmer', hp: 30, speed: 3.0, bounty: 3, damage: 9, radius: 0.55, scale: 1.2, color: 0x6b5a3a,
  friendly: true, splitInto: 'calf', splitCount: 3, weight: 0,
});

defineCow({
  id: 'tourist', name: 'Tourist Cow', hp: 30, speed: 2.6, bounty: 6, damage: 3, radius: 0.55, scale: 1, color: 0x88ccff,
  weight: 0,
});

defineCow({
  // Everyone near it gets fired up (faster) until you end the speech.
  id: 'speaker', name: 'Moo-tivational Speaker', hp: 70, speed: 2.4, bounty: 16, damage: 6, radius: 0.6, scale: 1.1, color: 0xff9a3c,
  weight: 0,
});

defineCow({
  // Several cows bolted together. Its HP is set from theirs when it forms.
  id: 'mecha', name: 'MECHA-MOO', hp: 100, speed: 2.0, bounty: 30, damage: 20, radius: 1.0, scale: 2.2, color: 0x9aa8ff,
  weight: 0,
});

// ---- The big herd: 50 more cows (wave 3 onwards) ----------------------------
// Most bring a new trick (see the field list at the top); the rest are odd
// sizes, speeds and splits. Spread over waves 3–30 so every few waves something new walks in.

const herd = (defs) => { for (const d of defs) defineCow({ weight: 1, radius: 0.55, scale: 1, ...d }); };

herd([
  // Waves 3–9: easy to read, one trick each.
  { id: 'tiny', name: 'Teacup Cow', blurb: 'tiny, fast, and there are lots of them', hp: 5, speed: 6, bounty: 1, damage: 1, radius: 0.3, scale: 0.4, color: 0xffe0e8, firstWave: 3, weight: 2 },
  { id: 'bubble', name: 'Bubble Wrap Cow', blurb: 'a bubble soaks the first hits: pop it, then pop her', hp: 25, shield: 30, speed: 3, bounty: 6, damage: 5, scale: 1.05, color: 0xd8f4ff, firstWave: 3 },
  { id: 'espresso', name: 'Espresso Cow', blurb: 'every 4 s she has another shot and bolts', hp: 26, speed: 2.8, sprint: { period: 4, time: 1.2, mult: 2.6 }, bounty: 5, damage: 4, color: 0x8a5a32, firstWave: 4 },
  { id: 'matrix', name: 'Matrix Cow', blurb: 'dodges every third shot. Woah', hp: 32, dodgeEvery: 3, speed: 3.2, bounty: 6, damage: 5, color: 0x2c3a2c, firstWave: 5 },
  { id: 'panic', name: 'Panic Cow', blurb: 'the more you hurt her, the faster she runs', hp: 40, panic: 1.5, speed: 2.6, bounty: 6, damage: 5, color: 0xffb0b0, firstWave: 5 },
  { id: 'yoga', name: 'Yoga Cow', blurb: 'breathes in, heals up: 4% of her health every second', hp: 45, regen: 0.04, speed: 2.6, bounty: 7, damage: 5, color: 0xc8a0ff, firstWave: 6 },
  { id: 'dizzy', name: 'Dizzy Cow', blurb: 'weaves all over the lane. Shells miss her', hp: 34, zigzag: { amp: 1.1, freq: 0.8 }, speed: 3.2, bounty: 5, damage: 5, color: 0xe0ff9a, firstWave: 6 },
  { id: 'drama', name: 'Drama Cow', blurb: 'when she goes down, the herd around her stampedes in grief', hp: 40, deathHaste: { radius: 6, mult: 1.6, time: 3 }, speed: 3, bounty: 7, damage: 5, color: 0xff6a9a, firstWave: 7 },
  { id: 'piggy', name: 'Piggy Bank Cow', blurb: 'runs off with your savings: catch her for a fat bounty', hp: 30, speed: 5.4, bounty: 30, damage: 2, scale: 0.9, color: 0xff9ac0, firstWave: 8 },
  { id: 'mole', name: 'Mole Cow', blurb: 'burrows for 2 s of every 5: untouchable underground', hp: 50, burrow: { period: 5, hidden: 2 }, speed: 2.8, bounty: 8, damage: 6, color: 0x6a5040, firstWave: 8 },
  { id: 'bush', name: 'Cow in a Bush', blurb: 'very convincing shrubbery: towers only spot it within 4 m', hp: 60, camo: 4, speed: 1.9, bounty: 8, damage: 7, scale: 1.15, color: 0x4a8a3a, firstWave: 9 },
  { id: 'procrastinator', name: 'Procrastinator Cow', blurb: 'dawdles all wave, then sprints the last 20 m', hp: 55, lastDash: { within: 20, mult: 2.6 }, speed: 1.6, bounty: 8, damage: 8, color: 0xa0a0b8, firstWave: 9 },
  { id: 'quantum', name: 'Quantum Cow', blurb: 'every 3.5 s she is suddenly three cells closer', hp: 38, blink: { every: 3.5, cells: 3 }, speed: 2.8, bounty: 8, damage: 6, color: 0x9a7aff, firstWave: 9 },
  // Waves 10–17: tricks that mess with your towers.
  { id: 'chameleon', name: 'Chameleon Cow', blurb: 'invisible to targeting 2 s out of every 4 (splash still finds her)', hp: 42, phase: { period: 4, hidden: 2 }, speed: 3, bounty: 8, damage: 6, color: 0x5ad8a0, firstWave: 10 },
  { id: 'parkour', name: 'Parkour Cow', blurb: 'vaults your mazes: runs straight at the milk', hp: 36, straight: true, speed: 3.4, bounty: 9, damage: 6, scale: 0.95, color: 0xff8a3a, firstWave: 10 },
  { id: 'umbrella', name: 'Umbrella Cow', blurb: 'mortar shells bounce off her brolly', hp: 55, shellproof: true, speed: 2.8, bounty: 8, damage: 6, color: 0x3a6adf, firstWave: 11 },
  { id: 'taxman', name: 'Tax Collector Cow', blurb: 'if she reaches the milk, she takes 25 moolah too', hp: 50, steal: 25, speed: 2.6, bounty: 10, damage: 5, color: 0x5a5f6a, firstWave: 11 },
  { id: 'pogo', name: 'Pogo Cow', blurb: 'boing boing: weaving and bouncing ahead in bursts', hp: 40, zigzag: { amp: 0.8, freq: 1.4 }, sprint: { period: 3, time: 0.8, mult: 2 }, speed: 3, bounty: 8, damage: 5, color: 0xffd84d, firstWave: 11 },
  { id: 'sleepy', name: 'Sleepy Cow', blurb: 'her yawns are contagious: towers within 7 m reload 35% slower', hp: 60, yawn: { radius: 7, mult: 0.65 }, speed: 2.2, bounty: 10, damage: 6, scale: 1.1, color: 0xb0b8e0, firstWave: 12 },
  { id: 'fireproof', name: 'Lava Lamp Cow', blurb: 'groovy and fireproof: burns slide right off', hp: 55, burnImmune: true, speed: 3, bounty: 8, damage: 6, color: 0xff5ad0, firstWave: 12 },
  { id: 'pigeon', name: 'Pigeon-Toed Cow', blurb: 'pop her and two Flying Cows flap out', hp: 45, splitInto: 'flying', splitCount: 2, speed: 2.8, bounty: 6, damage: 5, color: 0xa0a8b8, firstWave: 12 },
  { id: 'chicken', name: 'Chicken Cow', blurb: 'lays a Chick-Cow every 2.5 s. Nobody knows how', hp: 55, lay: { every: 2.5, type: 'chick' }, speed: 2.4, bounty: 9, damage: 6, color: 0xfff4d0, firstWave: 13 },
  { id: 'polar', name: 'Polar Cow', blurb: 'brain freeze? never heard of it. Shrugs off half of every slow', hp: 60, chillImmune: true, slowResist: 0.5, speed: 2.8, bounty: 9, damage: 6, scale: 1.1, color: 0xf8fcff, firstWave: 13 },
  { id: 'disco', name: 'Disco Ball Cow', blurb: 'every 4th hit dazzles the tower that shot her for 1.2 s', hp: 55, jamEvery: { n: 4, time: 1.2 }, speed: 2.8, bounty: 10, damage: 6, color: 0xe0e0f0, firstWave: 14 },
  { id: 'cheer', name: 'Cheerleader Cow', blurb: 'GO HERD GO! Cows around her run 35% faster', hp: 50, cheer: { radius: 5, mult: 1.35 }, speed: 2.8, bounty: 11, damage: 5, color: 0xff3a6a, firstWave: 14 },
  { id: 'turtle', name: 'Turtle Cow', blurb: 'a shell made of armour, a pace made of patience', hp: 90, armor: 10, speed: 1.4, bounty: 11, damage: 8, scale: 1.15, color: 0x5a8a4a, firstWave: 14 },
  { id: 'clown', name: 'Rodeo Clown Cow', blurb: 'HEY, OVER HERE! Towers that see her must shoot her first', hp: 120, armor: 2, taunt: true, speed: 2.4, bounty: 12, damage: 6, scale: 1.1, color: 0xff4a4a, firstWave: 15 },
  { id: 'magnet', name: 'Magnet Cow', blurb: 'drops with a pulse that jams towers within 6 m for 2 s', hp: 55, deathEmp: { radius: 6, stun: 2 }, speed: 2.8, bounty: 10, damage: 6, color: 0xd04848, firstWave: 15 },
  { id: 'grandma', name: 'Grandma Cow', blurb: 'slow, sweet, and keeps bringing the grandcalves', hp: 90, lay: { every: 3, type: 'calf' }, speed: 1.6, bounty: 12, damage: 8, scale: 1.2, color: 0xd8c8e8, firstWave: 15 },
  { id: 'bodyguard', name: 'Bodyguard Cow', blurb: 'in sunglasses: cows within 4 m (and him) take half damage', hp: 110, guard: { radius: 4, mult: 0.5 }, speed: 2.4, bounty: 14, damage: 8, scale: 1.3, color: 0x2c2f3a, firstWave: 16 },
  { id: 'contrarian', name: 'Contrarian Cow', blurb: 'slow her down? she speeds up. Just to spite you', hp: 50, slowInvert: true, speed: 2.4, bounty: 9, damage: 6, color: 0x9a3ad0, firstWave: 16 },
  { id: 'jetpack', name: 'Jetpack Cow', blurb: 'flies, and hits the afterburner every 3 s', hp: 34, altitude: 3, sprint: { period: 3, time: 1, mult: 2.2 }, speed: 3.4, bounty: 10, damage: 5, scale: 0.95, color: 0xb8c0d0, firstWave: 16 },
  { id: 'mitosis', name: 'Mitosis Cow', blurb: 'hurt her past half and there are suddenly two of her', hp: 70, mitosis: true, speed: 2.6, bounty: 8, damage: 6, scale: 1.1, color: 0x9cf09c, firstWave: 17 },
  { id: 'medic', name: 'Paramedic Cow', blurb: 'goes down healing everyone within 6 m by 40%', hp: 55, deathHeal: { radius: 6, frac: 0.4 }, speed: 3, bounty: 11, damage: 5, color: 0xffffff, firstWave: 17 },
  // Waves 18–30: combos, heavies and cows that really hold a grudge.
  { id: 'cactus', name: 'Cactus Cow', blurb: 'prickly to the end: her death spikes hurt towers within 3.5 m', hp: 70, deathSpikes: { radius: 3.5, damage: 35 }, speed: 2.6, bounty: 11, damage: 7, color: 0x5aa84a, firstWave: 18 },
  { id: 'hover', name: 'Hover Cow', blurb: 'a hovering bubble-cow. Flak first, then everything', hp: 40, altitude: 1.6, shield: 40, speed: 3, bounty: 11, damage: 6, color: 0xc0f0ff, firstWave: 18 },
  { id: 'tanker', name: 'Lactose Tanker', blurb: 'so slow. So thirsty. Drinks 40 milk if she gets there', hp: 140, speed: 1.2, bounty: 16, damage: 40, radius: 0.9, scale: 1.7, color: 0xf0f0d8, firstWave: 18 },
  { id: 'mime', name: 'Mime Cow', blurb: 'dodges every other shot, silently, inside an invisible box', hp: 30, dodgeEvery: 2, speed: 3, bounty: 10, damage: 5, color: 0xf4f4f4, firstWave: 19 },
  { id: 'prankster', name: 'Prankster Cow', blurb: 'every 6 s she swaps places with the cow nearest your milk', hp: 55, swapEvery: 6, speed: 2.6, bounty: 11, damage: 6, color: 0xffa020, firstWave: 19 },
  { id: 'phoenix', name: 'Phoenix Cow', blurb: 'fireproof, and gets back up once at half health', hp: 60, revive: 0.5, burnImmune: true, speed: 3, bounty: 14, damage: 7, color: 0xff7a1a, firstWave: 20 },
  { id: 'sumo', name: 'Sumo Cow', blurb: 'four hundred pounds of nope: shrugs off most slows', hp: 300, slowResist: 0.6, speed: 1.5, bounty: 30, damage: 25, radius: 1.0, scale: 2.1, color: 0xf0c8a0, firstWave: 20 },
  { id: 'cowboy', name: 'Cowboy Cow', blurb: 'yeehaw: bursts of speed, and steals 15 moolah if she makes it', hp: 50, steal: 15, sprint: { period: 4, time: 1.4, mult: 2.2 }, speed: 2.8, bounty: 11, damage: 6, color: 0xb07a3a, firstWave: 20 },
  { id: 'vampire', name: 'Vampire Cow', blurb: 'heals 6%/s, but burns hurt her double', hp: 60, regen: 0.06, burnVuln: 2, speed: 3, bounty: 12, damage: 6, color: 0x5a1a2a, firstWave: 21 },
  { id: 'riot', name: 'Riot Cow', blurb: 'a bubble shield on top of riot armour', hp: 80, shield: 60, armor: 5, speed: 2.2, bounty: 15, damage: 8, scale: 1.2, color: 0x3a4a6a, firstWave: 22 },
  { id: 'stunt', name: 'Stunt Cow', blurb: 'takes a fall, gets right back up at full health, then panics', hp: 50, revive: 1, panic: 1.2, speed: 2.8, bounty: 14, damage: 6, color: 0xffd0a0, firstWave: 22 },
  { id: 'glitch', name: 'Glitch Cow', blurb: 'blinks forward every 2 s and flickers out of sight', hp: 45, blink: { every: 2, cells: 2 }, phase: { period: 3, hidden: 1 }, speed: 2.8, bounty: 13, damage: 6, color: 0x3affd0, firstWave: 23 },
  { id: 'bagpipe', name: 'Bagpipe Cow', blurb: 'the herd marches faster, your towers wince and slow', hp: 80, cheer: { radius: 5, mult: 1.25 }, yawn: { radius: 6, mult: 0.8 }, speed: 2.4, bounty: 15, damage: 7, scale: 1.1, color: 0x4a7a3a, firstWave: 24 },
  { id: 'cosmic', name: 'Cosmic Cow', blurb: 'flies high and fades between dimensions', hp: 50, altitude: 5, phase: { period: 3.5, hidden: 1.5 }, speed: 3, bounty: 13, damage: 6, color: 0x6a3aff, firstWave: 24 },
  { id: 'hydra', name: 'Hydra Cow', blurb: 'cut off one head, three more grow back (and they split too)', hp: 90, splitInto: 'hydrahead', splitCount: 3, speed: 2.4, bounty: 12, damage: 8, radius: 0.75, scale: 1.4, color: 0x2a8a6a, firstWave: 25 },
  { id: 'beekeeper', name: 'Beekeeper Cow', blurb: 'veiled against shells, and her bees guard the herd (×0.7 damage)', hp: 70, shellproof: true, guard: { radius: 3.5, mult: 0.7 }, speed: 2.6, bounty: 14, damage: 7, color: 0xf0e8c0, firstWave: 26 },
  { id: 'lumberjack', name: 'Lumberjack Cow', blurb: 'plaid, armoured, and his death throes splinter towers within 4 m', hp: 90, armor: 3, deathSpikes: { radius: 4, damage: 50 }, speed: 2.4, bounty: 15, damage: 8, scale: 1.2, color: 0xc03a2a, firstWave: 26 },
  { id: 'wifi', name: 'Wi-Fi Cow', blurb: 'towers near her keep buffering, and she drops with a 3 s blackout', hp: 60, yawn: { radius: 9, mult: 0.8 }, deathEmp: { radius: 7, stun: 3 }, speed: 2.6, bounty: 14, damage: 6, color: 0x3a8adf, firstWave: 27 },
  { id: 'unicorn', name: 'Moo-nicorn', blurb: 'sparkly, fast in bursts, and not done after one death', hp: 65, revive: 0.6, sprint: { period: 3.5, time: 1.2, mult: 2.4 }, speed: 3, bounty: 20, damage: 8, color: 0xffc8ff, firstWave: 28 },
  { id: 'houdini', name: 'Moo-dini', blurb: 'the great escape artist: blinks and swaps her way to your milk', hp: 60, swapEvery: 4, phase: { period: 4, hidden: 1.5 }, speed: 2.8, bounty: 18, damage: 8, color: 0x6a1a8a, firstWave: 30 },
]);

// Born from the herd (never in a wave mix).
defineCow({ id: 'chick', name: 'Chick-Cow', hp: 6, speed: 4, bounty: 1, damage: 1, radius: 0.3, scale: 0.4, color: 0xfff08a, weight: 0 });
defineCow({ id: 'hydrahead', name: 'Hydra Head', hp: 30, speed: 3.2, bounty: 4, damage: 3, radius: 0.5, scale: 0.85, color: 0x3aa87a, mitosis: true, weight: 0 });

/**
 * True while a burrowing (or phasing) cow is hidden from towers: a fixed
 * window of every period, offset by its id so a herd doesn't sync up.
 * `burrowOnly` asks only about burrowing (which also blocks damage).
 */
export function cowHidden(type, id, time, burrowOnly = false) {
  const b = type.burrow ?? (burrowOnly ? null : type.phase);
  if (!b) return false;
  return (time + (id % 17) * 0.29) % b.period < b.hidden;
}

/** Triangle wave in [-1, 1] (no trig: lockstep co-op needs bit-identical sims). */
export function tri(x) {
  const p = ((x % 2) + 2) % 2;
  return p < 1 ? 2 * p - 1 : 3 - 2 * p;
}

/** Widest cow (m), so area queries can pad their reach by it. */
export const MAX_COW_RADIUS = () => COW_TYPE_LIST.reduce((m, t) => Math.max(m, t.radius), 0);

for (const t of COW_TYPE_LIST) {
  if (t.boss && !COW_TYPES[t.boss.summon.type]) throw new Error(`cow type ${t.id}: summons unknown ${t.boss.summon.type}`);
  if (t.splitInto && !COW_TYPES[t.splitInto]) throw new Error(`cow type ${t.id}: splits into unknown ${t.splitInto}`);
  if (t.lay && !COW_TYPES[t.lay.type]) throw new Error(`cow type ${t.id}: lays unknown ${t.lay.type}`);
}

// ---- live cow state ----------------------------------------------------------
//
// Every per-cow value is one typed array, declared once in the table below.
// To give cows new state, add a defineCowField() line next to the feature
// that uses it: the pool allocates, spawns, removes and clears it for you.
// Read and write it as `cows.<name>[slot]`.

/** Cow ability phases, in `cows.abilityState`. */
export const ABILITY_COOLDOWN = 0;
export const ABILITY_WINDUP = 1;

/** Declared fields, in declaration order: { name, array, spawn, doc }. */
export const COW_FIELDS = [];
let poolsMade = false;

/**
 * Declare a per-cow array.
 * @param {string} name   property name on the pool (`cows.name[slot]`)
 * @param {Function} array typed array constructor (Float64Array, Uint8Array, ...)
 * @param {number | ((type: object, at: {x:number,z:number,offsetX:number,offsetZ:number,id:number}) => number)} spawn
 *   value a freshly spawned cow gets: a constant, or computed from its type and spawn point
 * @param {string} doc    what it means (shows up in COW_FIELDS for tooling)
 */
export function defineCowField(name, array, spawn = 0, doc = '') {
  if (poolsMade) throw new Error(`cow field ${name}: define fields before the first CowPool`);
  if (COW_FIELDS.some((f) => f.name === name)) throw new Error(`cow field ${name} defined twice`);
  if (['count', 'capacity', 'nextId', 'spawn', 'remove', 'clear'].includes(name)) throw new Error(`cow field ${name}: reserved name`);
  COW_FIELDS.push(Object.freeze({ name, array, spawn, doc }));
}

// Identity and health
defineCowField('id', Uint32Array, (t, at) => at.id, 'stable id, so renderers, replays and bosses can tell cows apart (slots move)');
defineCowField('type', Uint8Array, (t) => t.index, 'index into COW_TYPE_LIST');
defineCowField('hp', Float64Array, (t) => t.hp, 'current HP (Game.spawnCow scales it per wave)');
defineCowField('maxHp', Float64Array, (t) => t.hp, 'HP at spawn after wave scaling, for heals, enrage and boss phases');
defineCowField('hitAge', Float64Array, Infinity, 'seconds since last hit, for the damage flash');

// Movement
defineCowField('x', Float64Array, (t, at) => at.x, 'position (m)');
defineCowField('z', Float64Array, (t, at) => at.z);
defineCowField('prevX', Float64Array, (t, at) => at.x, 'position at the previous tick, for render interpolation');
defineCowField('prevZ', Float64Array, (t, at) => at.z);
defineCowField('vx', Float64Array, 0, 'velocity (m/s)');
defineCowField('vz', Float64Array, 0);
defineCowField('offsetX', Float64Array, (t, at) => at.offsetX, 'fixed aim offset inside each cell, so a herd spreads out instead of walking single file');
defineCowField('offsetZ', Float64Array, (t, at) => at.offsetZ);

// Slows (molasses, butter slick, glue, boss resist applied by the tower)
defineCowField('slowTime', Float64Array, 0, 'seconds of slow left');
defineCowField('slowMult', Float64Array, 1, 'speed multiplier while slowed (0 = stuck)');

// Headbutt Heifer / Cud Spitter attacks
defineCowField('abilityState', Uint8Array, ABILITY_COOLDOWN, 'ABILITY_COOLDOWN or ABILITY_WINDUP');
// Spitters wait a moment after spawning, so they don't all fire the second they walk in.
defineCowField('abilityTime', Float64Array, (t) => (t.spitRange > 0 ? t.abilityCooldown * 0.4 : 0), 'seconds left of the wind-up or cooldown');
defineCowField('abilityTarget', Uint32Array, 0, 'tower id being wound up at (an id, never a slot: towers can be sold or wrecked mid wind-up)');

// On fire (Milk Frother family)
defineCowField('burnTime', Float64Array, 0, 'seconds of burning left');
defineCowField('burnDps', Float64Array, 0, 'burn damage per second');
defineCowField('burnSpread', Float64Array, 0, 'a burning cow that dies lights cows within this many metres');
defineCowField('burnSource', Uint32Array, 0, 'tower id credited with burn kills');

// Brain freeze (Soft-Serve family)
defineCowField('chillTime', Float64Array, 0, 'seconds of brain freeze left');
defineCowField('chillMult', Float64Array, 1, 'damage taken from everything is multiplied by this while frozen');

// The big herd (shields, dodges, timers, hastes, once-only tricks)
defineCowField('shieldHp', Float64Array, (t) => t.shield, 'bubble left to soak damage (Game.spawnCow scales it per wave)');
defineCowField('hitCount', Uint16Array, 0, 'direct hits taken, for dodgeEvery / jamEvery');
defineCowField('flags', Uint8Array, 0, 'once-only tricks used: 1 revived, 2 split (mitosis)');
defineCowField('periodT', Float64Array, (t) => (t.blink?.every ?? t.lay?.every ?? t.swapEvery ?? 0) * 0.5, 'seconds to the next blink / lay / swap');
defineCowField('hasteT', Float64Array, 0, 'seconds of haste left (cheer, drama, contrarian)');
defineCowField('hasteMult', Float64Array, 1, 'speed multiplier while hasted');

/**
 * Live cows, densely packed in slots 0..count-1, one typed array per field
 * in COW_FIELDS. Removing a cow moves the last cow into its slot, so
 * iteration never skips holes. Nothing outside holds a slot index across
 * ticks (tower shots resolve the same tick); hold `id`s instead.
 */
export class CowPool {
  constructor(capacity = 4096) {
    poolsMade = true;
    this.capacity = capacity;
    this.count = 0;
    this.nextId = 1;
    /** Bumped whenever slots or positions change (spawn, remove, clear, a movement step), for caches like CowHash. */
    this.version = 0;
    /** [array, spawn] per field, for spawn/remove. */
    this.columns = COW_FIELDS.map((f) => {
      const a = new f.array(capacity);
      this[f.name] = a;
      return [a, f.spawn];
    });
    this.at = { x: 0, z: 0, offsetX: 0, offsetZ: 0, id: 0 };
  }

  /** Spawn a cow of `type` at (x, z) with a herd offset. Returns the slot, or -1 when full. */
  spawn(type, x, z, offsetX, offsetZ) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.version++;
    const at = this.at;
    at.x = x; at.z = z; at.offsetX = offsetX; at.offsetZ = offsetZ; at.id = this.nextId++;
    for (const [a, spawn] of this.columns) a[i] = typeof spawn === 'function' ? spawn(type, at) : spawn;
    return i;
  }

  remove(i) {
    this.version++;
    const last = --this.count;
    if (i === last) return;
    for (const [a] of this.columns) a[i] = a[last];
  }

  clear() { this.count = 0; this.version++; }
}
