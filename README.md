# CowTD (goofytd)

An incredibly goofy but fun first-person tower defense game: defend your milk from cows.

## Game concept

- **Perspective:** first person.
- **Singleplayer:** tower defense. Cows come for your milk; you build and fight to stop them.
- **Multiplayer (later):** PvP. Not part of the first milestones, but don't make architecture choices that rule it out (keep simulation deterministic-friendly and separate from rendering/input).
- **Movement:** weirdly in-depth and satisfying FPS movement is a core pillar, not a polish item. Movement feel gets as much design attention as the towers.
- **Tone:** goofy. Cows, milk, absurdity. Fun over realism.

## Technical direction

- **No build step.** Plain JavaScript ES modules served as static files straight from GitHub Pages. No bundler, no transpiler, no `npm install` needed to run or deploy.
- **Rendering:** three.js (WebGL2), loaded from jsDelivr through an import map in `index.html`, pinned to an exact version.
- **Simulation is pure JS with no three.js or DOM imports** (`src/sim/`), so it runs unchanged in the browser, in Node tests, and later on a server.
- **Entities at scale:** hundreds to thousands of cows will use instanced meshes and flat, allocation-light data in hot loops.

### Decisions

| Decision | Choice | Why |
|---|---|---|
| Platform | No-build static site on GitHub Pages | Push to `main` and it's live; nothing to install or compile. Replaces the earlier Rust/Bevy/WASM plan. |
| Renderer | three.js 0.186.1 via CDN import map, WebGL2 | Works in every current browser with zero tooling; `InstancedMesh` covers large cow counts. |
| Player physics | Custom kinematic controller (Quake 3 / Source "pmove" style) | Movement feel is a pillar, so we own every number; deterministic and testable. |
| Player collision | Axis-aligned hull vs. static axis-aligned boxes, swept (no tunnelling) | Simple and exact for grey-box levels. Slopes/ramps need another shape type later. |
| Tick rate | Fixed 64 Hz simulation, camera interpolated between ticks | Frame-rate independent movement; matches Source/CS tick rates. |
| Default map | Open 200 m field, milk at the centre, 3 m boundary wall; movement playground at `?map=playground` | Empty space to build and test towers; the playground stays for tuning movement. |
| Mouse look | Pointer lock, with drag-to-look when the browser refuses the lock | A refused lock (sandboxed embed, Chrome's re-lock cooldown after Esc) used to leave the mouse unable to look, silently. |
| Camera / mouse look | `src/client/look.js`: mouse deltas are filtered (first 2 events after a lock change, NaN, and out-of-nowhere spikes: >400 counts and >6× the previous event; no fixed cap, because browsers sum a whole frame's motion into one event) and accumulated, applied once per frame; camera orientation is a quaternion built straight from yaw/pitch (no Euler order, no roll). Standard pointer lock by default, raw input opt-in with `?raw=1`; `?debug` shows live mouse stats | Rewrite after reports of the view spinning erratically; the whole path is unit-tested and checked against the real three.js camera. |
| Firefox echo filter | `MouseLook.isEcho()`: when Firefox's warp-to-anchor fails (seen on Linux X11/XWayland), every real delta is followed by an "echo" event whose movementX/Y is the cursor's whole offset from the anchor. After two confirmed echoes (each ≈ previous echo + the real delta between) those events are dropped; it switches off after 8 clean events. `?debug` shows `echoes` and `FIREFOX ECHO FILTER ON` | Cause of the jittery vertical look in Firefox, confirmed from a recorded event stream (`tests/fixtures/firefox-echo.json`, replayed in the tests). |
| Pointer-lock refusals | Within 1.5 s of leaving the lock (Chrome's cooldown) or on a first refusal: stay paused and ask for another click. Drag-to-look only with no API or two refusals outside the cooldown | Auto-switching to drag-look on any refusal made the game flip in and out of capture and left a free cursor that clicked out of the window. |
| Fullscreen on interaction | `Input.onGesture` listens (capture phase, on `window`) for mouse down, touch/pen up and key down, and requests fullscreen from that very gesture; skips Esc, F and the ⛶ button so they can still leave it. On by default; `?fs=0` opts out (stored). Touch also locks landscape where allowed | Browsers only grant fullscreen from a user gesture, and it also confines the cursor (Firefox needed that). Chrome counts mouse *down* but touch *up* as the activating event, hence both. |
| First wave | `main.js` sets `firstWave = null`: wave 1 starts only from the START WAVE 1 button or N. Later waves stay automatic on the field, manual in the playground | Lets you build before the cows come, without a countdown. The button is a DOM element, shown while `game.wave === 0`. |
| Sound | `src/client/audio.js`: every effect is synthesised with Web Audio (oscillators, filtered noise, envelopes), no sample files. At load each sound is rendered once into a bank (6 pitch variants for pitched sounds, 2 for the rest; 88 variants, 33 s, 6.4 MB), one `OfflineAudioContext` per variant rendered in parallel. Playback picks the fastest engine: **worklet** (`src/client/sfx-worklet.js`, one `AudioWorkletNode` mixes every voice on the audio thread; the main thread posts one batch of `[sound, variant, time, gainL, gainR]` per frame), **buffer** (no AudioWorklet: buffer source + gain + panner per sound), or **graph** (bank not rendered yet: live synthesis). Sim events (`shot`, `launch`, `splash`, `kill`, `drink`, `boom`, `wave`, `lost`, …) map to sounds (a shot can name its own: `zap`, `blast`; volleys sound once); upgrades play `upgrade`; UI sounds play where the click happens. Distance gain `(1 − d/70)²`, equal-power stereo pan from the view direction, per-sound throttle and overlap caps, 28 voices total, compressor on the master | No assets to download or license; thousands of cows and 40 towers would otherwise fire hundreds of sounds a second. Live synthesis built 8–20 nodes per sound: in a saturated 20 s mix (28 voices, ~89 sounds/s, headless Chromium, one desktop core) it rendered at only 2.6× realtime (≈40% of the audio thread; a phone would crackle) and took 298 ms of main thread. The bank + worklet renders the same mix at ≥70× realtime with 10 ms of main thread (~6 µs per sound vs ~170 µs); buffers alone reach 29× / 85 ms. Same sound: onsets sample-exact, pan identical, pure-tone sounds bit-for-bit in level, noisy ones within the per-play noise variation (≤10% RMS). Building the bank costs ~0.24 s wall and ~0.13 s of main thread in ~1.5 ms slices during load. The worklet URL goes through `import.meta.resolve`, so it gets its import-map version like every module. SharedArrayBuffer would avoid the per-frame message but needs COOP/COEP headers, which GitHub Pages can't send. The context is created on the first gesture (browsers lock audio until then). Events pushed outside `tick()` (hand-started waves, builds) are cleared by the next tick, so those sounds are triggered directly. |
| Touch | Floating left-thumb stick, drag-to-look, jump button that also steers, crouch toggle. Every button carries a word, not a letter; BUILD / SELL relabel themselves from the game state (`touchButtonState`, unit-tested) | Playable on phones; the jump thumb steering is what makes air strafing possible with two thumbs. The old corner row of `S− S+ HOP R ⛶ N ♪` was unreadable, so rarely-used settings moved into the pause menu and only play actions stay on screen. |
| Pause | `main.js` `setPaused`: the frame loop skips `player.step`/`game.tick` and doesn't feed the `FixedClock` (no fast-forward on resume); rendering continues behind the DOM menu (`src/client/menu.js`). P toggles it, the mouse is released while paused, and `Input.paused` makes game keys ignored. RESTART GAME needs two taps within 3 s | Gives phones a place for settings and a way to stop. The mouse has to be free to click the menu. The sim is untouched, so determinism isn't affected. |
| Cache busting | `tools/stamp.js` (`npm run stamp`) rewrites the import map in `index.html` so every module URL carries `?v=<content hash>`; `index.html` loads `main.js` with `import` (not `src=`) so it goes through the map too. A test fails when a hash is stale | GitHub Pages caches each file for 10 min and browsers reuse fresh cached scripts even on reload, so right after a deploy a phone ran the new page with old scripts: tower bar, PAUSE, BUILD and SELL all dead. Reproduced with a real HTTP cache in Chromium, and gone with the versioned map. A missed stamp only falls back to the old caching, never breaks the game. |
| Touch layout | Tower bar left of CROUCH in landscape (wraps rather than overflow); centred above BUILD / SELL in portrait, stats line hidden there | The bar used to have no width limit and slid off the left edge in portrait. Checked at 568×320 to 1024×768 and 360×740 to 768×1024: every button on-screen, none overlapping, every action working. |
| Touch button taps | `setPointerCapture` is wrapped in try/catch in `touch.js` | It throws `InvalidStateError` for a pointer that is already gone (a very quick tap) and, running before the action, silently dropped the tap. Capture only matters for drags. |

| Cow pathing | One shared flow field on a 2 m nav grid (`src/sim/navgrid.js`): Dijkstra outward from the cells around the milk, 8-way with no corner cutting, rebuilt only when a tower is built or sold | Cost is per grid, not per cow: 2000 cows tick in ~0.4 ms; a rebuild of the 100×100 field is ~2 ms. Towers can maze the cows, and the same field answers "how far is this cow from the milk" for targeting. |
| Tower placement | Towers snap to the nav grid (odd footprints centre on a cell, even on a corner). Refused on level geometry, other towers, cows, the player, the field edge, too little money, or if any spawner or cow would lose every path to the milk | Mazing is the fun part of TD, sealing the milk off would break it. The path check is a yes/no BFS (~1.5 ms with 2000 cows), and the build preview reruns it only when the aim, grid or money changes, or every 120 ms. |
| Towers are modular | `src/sim/towers.js`: a tower type is one `defineTower({...})` call: stats, `targeting` (`first`/`nearest`/`strongest` or a function), `attack` (`hitscan`/`lob`, a function, or null for a wall) and `parts` (coloured boxes to draw). The game, build bar, hotkeys and renderer all read the registry | Adding a tower touches one file; a test proves a custom tower with its own attack function works with no other changes. |
| Cows | Types in a `defineCow` registry (`src/sim/cows.js`); live cows in flat typed arrays with swap-remove; drawn as one `InstancedMesh` tinted per type (plus one wing `InstancedMesh` for flyers) | Thousands of cows without per-cow objects or draw calls. Nothing holds a cow slot across ticks (shells aim at a point), so swap-remove is safe. |
| Cow variants | Cow (wave 1+), Zoomies Cow (fast, fragile, wave 3+), Big Cow (slow, 170 HP, 15 milk, wave 4+), Flying Cow (wave 5+), Kaboom Cow (wave 6+), Tin Cow (wave 7+), Mama Cow (wave 8+), Raging Bull (wave 9+), Vet Cow (wave 10+), Ninja Cow (wave 11+). Each wave picks every cow's type with the seeded RNG from the types unlocked so far, weighted (10/4/2/3/2/2/2/2/1/1); a one-type mix draws no random number. HP scaling per wave applies to every type. The HUD announces a type's first wave | Variety without hand-written wave lists; data-only, so new types are one `defineCow` call. Weights keep plain cows the bulk of every wave. |
| Tower upgrades | Tower Defense King style: each tower has straight buff levels, then a **pick-one-of-two variant** that plays differently, then one or two more levels for that variant (`defineUpgrade({ from, kind, cost, ...overrides })` in `src/sim/towers.js`). A built tower just swaps its `def` to the new form (same id, place, kills); everything spent counts toward the 70% sell refund | Buffs keep upgrading as moolah-efficient as building more; variants are where the decisions are. Swapping `def` means the game, renderer and HUD needed no special cases. |
| Upgrade paths | **Milk Squirter** → Pressure → Double-Pump → *Moo-chine Gun* (spins up from 5 to 25 shots/s, decays when idle; boss killer) → Udder Annihilator, or *Moo-shotgun* (cone blast, up to 8 cows, 10 m; herd shredder) → Dairy Blunderbuss. **Butter Mortar** → Salted → Big Tub → *Butter Slick Lobber* (shells leave a puddle that slows to 60% and greases 5/s) → Hot Butter Slick, or *Popcorn Flak* (fast airbursts at flyers, half damage to walkers) → Kettle-Corn Battery. **Hay Bale** → Packed Bale (Kaboom-proof) → *Zappy Fence* (zaps up to 6 walkers within 3.2 m) → Bug Zapper (also flyers), or *Molasses Bale* (halves walkers' speed within 3.6 m) → Super-Glue (65% slow, flyers too) | Each variant answers one cow type: gatling for Big Cows, shotgun / slick for herds and Zoomies, flak for flyers, Packed Bales for Kaboom Cows, fences and goo for mazes. |
| Upgrade balance | Tuned with a harness: one tower beside a lane, a stream of 10×-HP cows, damage dealt per 100 moolah (`tests/upgrades.test.js` keeps a fast version). Buff levels stay flat in efficiency; each variant wins its niche by 1.3–2× (herds: shotgun 2.6 vs squirter 1.4; Big Cows: gatling 6.4 vs 5.8; flyers: flak 6.0 vs 3.9) and loses outside it; nothing exceeds 3× the plain tower | First pass had Butter Slick 4–9× too strong: overlapping puddles each applied their damage. Puddles now don't stack (a cow takes only the strongest), and flak was the worst anti-air per moolah until retuned. |
| New towers (Milk Frother, Hayloft Sniper) | **Milk Frother** (90; a flamethrower that's a café steam wand): `spray` attack, a 7 m cone hitting up to 6 walkers 10×/s for seeping damage (no red strobe, ignores Tin armour) and a burn. → Steam Wand → Cappuccino Cannon → *Crème Brûlée Torch* (big burns that **flambé**: a burning cow that dies lights every walker within 2.5 m at its burn for 75% of the time left; second-hand burns don't spread again) → Flambé Thrower → Baked Alaska Inferno, or *Soft-Serve Blaster* (brain freeze: slows and makes cows take ×1.2 damage from **every** tower) → Brain Freeze (×1.3) → Glacier Gelato (×1.4, 70% slow). **Hayloft Sniper** (110): `snipe` at the toughest cow in 38 m, 70 dmg / 2 s → Scoped Sniper (`seesCamo`: Ninjas at any range) → Long Moo-ser → *Cheddar Railgun* (`pierce`: armour-piercing slug through every cow on a line to the end of its range, capped hits) → Gouda Gauss Gun → Moo-ss Driver, or *Udder Assassin* (every 3rd shot ×3) → Silent Moo-n (every 2nd shot, executes non-boss cows under 20%) → The Moo-fessional (under 30%). Variants now get two more levels (6 in all) | Two holes in the roster: nothing cheap for a packed herd at close range, and nothing for Tin armour, Ninjas or bosses at a distance. Burns, freezes and executions are per-cow state in `CowPool` (`burnT/burnD/burnS/burnTower`, `chillT/chillV`), ticked in `updateBurns` after slicks; burns never stack (the hottest wins), like puddles. Executions skip cows over `EXECUTE_MAX_HP` 200 so Bessie and Mega Mama still need work. |
| Moolah multiplier (Auction Barn) | **Auction Barn** (120, 2×2, no gun): cows killed within its reach sell at auction for ×1.25 (10 m) → Livestock Exchange ×1.4 (12 m) → Stock Moo-ket ×1.55 (14 m) → *Bull Market* ×1.9 → Wall Street Bull ×2.25 → Golden Udder Exchange ×2.75 (18 m), or *Cheese Vault* (×1.55 and pays 5% interest on banked moolah, max 40, as each wave starts) → Aged Cheddar ×1.6 / 8% / 80 → Big Cheese Reserve ×1.65 / 10% / 150. Barns don't stack (the best barn in reach counts); they multiply with Happy Hour and War Moo-st bonuses; payouts round to whole moolah | A multiplier only makes sense if it's tied to *where* you kill, so it's a placement puzzle (build it where your killing ground is) and a target for Heifers, not a flat global %. Not stacking keeps barn spam from going exponential; the vault rewards saving with a cap so it stays linear. Measured over 14 waves with 16 gatlings round the milk: a plain barn earned +148 by wave 5 (paid off), +405 by wave 14; Golden Udder (1700 spent) paid off around wave 10. |
| New tower balance | Same lane harness, but cows ×40 HP so expensive towers can't max out at 100% kills (`tests/newtowers.test.js`). Herds: frother 1.03, brûlée3 1.07, soft-serve3 1.52, railgun3 1.66 vs squirter 0.55; Big Cows: assassin3 2.7 vs squirter 2.25, sniper 1.96, frother 1.02; Tin: railgun 1.02, frother 0.89 vs squirter 0.65. Soft-serve's main value (×1.4 damage for every other tower) isn't in the solo number | The first numbers had the frother line barely ahead of a squirter on herds and its upgrades getting *less* efficient, the snipers below a squirter on Big Cows, and the railgun at 3.7× a squirter (a straight lane is its best case); all retuned. |
| Six-tower build bar and new effects | Desktop bar spans the screen (it was `left: 50%`, which caps an absolute box at half the screen) and drops the hotkey badges under 1240 px; START WAVE lifts above a wrapped bar under 900 px. Touch landscape: names wrap inside 80 px slots so all six fit beside the thumb buttons at 740 px; portrait: a 3×2 grid. Frother jets draw as a fan of short streaks per squirt; burning cows flicker orange, frozen ones go icy blue; headshots, executions, flambé and auctioned kills (gold coin) puff. New sounds: `hiss`, `crack`, `cash` | Checked headless at 1280×720, 1024×600, 800×600, 740×360, 568×320, 390×844 and 360×640. |
| Slows | `CowPool.slowT/slowF`: speed × factor for some seconds; a weaker slow never overrides a stronger running one. Slowed cows are tinted butter-brown | One mechanism for molasses, glue and butter puddles. |
| Upgrade panel | DOM overlay (`src/client/upgrade-menu.js`), pure `upgradeModel()` tested in Node. Look at a tower, U / **UPGRADE** opens it; the game keeps running. One card for a buff, two for a path choice, each listing what changes (old → new, ▲ green / ▼ red for honest trade-offs); sheet, stats, cards and each card's rows cascade in, variants shimmer, buying pops the tower model and the level pip. Desktop keeps the mouse captured: 1/2 buy, U/Q close. Landscape: a sheet on the left that stops at the thumb buttons; portrait: a bottom sheet; short screens drop the stats row (cards already show from → to) so the buy buttons never need a scroll | Checked headless at 390×844, 360×640, 740×360, 568×320 and 1280×720: every card and button on screen, no thumb button covered in landscape, buy / variant / max / refuse / close all work, no errors. |
| Flying cows | `altitude > 0`: fly straight at the milk (ignore the flow field, walls and towers), ignored by placement checks, ranked by straight-line distance for targeting. Only towers with `hitsAir` (default true; the Butter Mortar is false) target them, and ground splash skips them; a shell fired at a flyer (Popcorn Flak) bursts at its height and hits only flyers | Mazing can't stop them, so they test raw firepower instead; the mortar's lob lands on the ground. |
| Late-game cows | Tin Cow: `armor` 4 off every direct hit, never below 25% of it; slick damage over time ignores it. Mama Cow: `splitInto` 3 Calves at the current wave's HP, popped with their own RNG stream (`splitRng`), appended after the dead cow is swap-removed. Raging Bull: ×2.2 speed under 50% of its max HP (`CowPool.maxHp`, set at spawn). Vet Cow: every 0.5 s heals other cows within 4.5 m by 3% of their max HP. Ninja Cow: towers can't pick it as a target until it's within 7 m (`camo`); splash, shotgun spray and auras still hit it. Surprise-only: Trojan Cow (6 Zoomies inside), Mega Mama (3 Mamas inside) | Each one answers a strategy the earlier cows let you get away with: Tin punishes squirter spam (6 → 2 damage) and rewards slicks and mortars; Mamas punish single-target towers; Bulls punish chip damage; Vets must be focused; Ninjas punish long-range-only defences. Split cows go in after `remove()` so every caller holding lower slots (shotgun, aura, zones) stays valid, and a separate RNG means kills never shift wave or surprise draws (tested). Vet heals are O(vets × cows) per pulse: 0.29 ms/tick with 2000 cows and 50 vets. |
| Kaboom cows | `blastRadius > 0`: when the cow's edge gets within `BLAST_TRIGGER` (1 m) of a tower's footprint (tower ids looked up in the 5×5 cells around it), it explodes: every tower whose footprint is within 2.6 m is wrecked (no refund), the cow dies with no bounty and no milk lost, one flow-field rebuild. Shot down first, it pops harmlessly | Punishes tight hay-bale mazes. 1 m means any cow walking in a cell next to a tower always goes off (with 0.5 m, half the cows walked past a wall end; there's a test). |
| Cows that hit back | Towers have HP (`hp`, default 60; Butter Mortar 100, Hay Bale 160, Packed Bale 200; +25% per upgrade level via `towerMaxHp`; upgrading fully repairs). They patch themselves at 10% max HP/s once 4 s pass without a hit. Headbutt Heifer (wave 12): walks the normal path; when a tower is within 1 m of it, it stops, snorts and rears back for 0.9 s, then bonks that tower for 20 HP, 2.2 s cooldown. Cud Spitter (wave 13): stops for 0.7 s and spits at the nearest shooting tower within 9 m that isn't already jammed: no shots for 2.5 s (never stacks) and 5 HP, 5 s cooldown. A tower bonked to 0 is wrecked and refunds 35% of what was spent on it (Kaboom still pays nothing). Tipping a cow cancels its wind-up | Retaliation has to be readable and answerable. Both cows telegraph (sound, pose, colour) and stand still while winding up, so they're free shots. Heifers only hit what's beside their path and never detour, so cheap bales lining the lane soak the bonks: measured with 12 wave-20 Heifers in a row, guns right on the lane lost 5 of 20, guns behind bales lost 0 of 60, and fully upgraded gatlings killed them before a single bonk. Spitters cost 0–5% of a 20-squirter line's firepower with 2–8 of them. Regen and the insurance refund keep one bad wave from snowballing. |
| War Moo-st | A surprise (wave 6+): a banner warns first, fog rolls in over 3 s, sits, and clears over 4 s (22 s total, `startFog`, `fogLevel`). Towers acquire targets at only 65% of their range at full fog (`game.sight`, used by `pick()`); the renderer blends the scene fog to 6–34 m and a grey sky. Kills pay 1.5× while it lasts, and a hidden group comes in from the field edge with a positioned horn | The fog is a real threat only to a thin defence and pays a solid one: with the fog up the whole time, 2 squirters let 3 more of 40 cows through and 2 mortars leaked 6 instead of 0, while every setup earned 32–50% more moolah. The positioned horn is how you find the hidden group without seeing it. Sight is sim state, so it stays deterministic. |
| Surprises | `src/sim/surprises.js`: scripted sequences rolled on top of the wave formula, never instead of it. From wave 2 a wave rolls one with chance 30% + 5%/wave (cap 75%); after 2 quiet waves the next always gets one; from wave 8 a rolled wave may get a second (25%); never the same one twice in a row. Each runs 0.5–14 s into the wave: Stampede, Ambush (from a random reachable spot on the field edge, unannounced until it hits), Cash Cow (bonus when shot), Big Bessie (boss + escort), Air Raid, Kaboom Convoy, Too Quiet (7 s hold, then the rest of the wave at 3.3× rate), The Big One (a calf), Moolah Drop, Happy Hour (bounties ×2 for 15 s, `boostBounty`), Cow Tipping (every walker knocked over for 3 s, `tipCows`), The Milkman (+15 milk, or moolah when full), Trojan Cow, Mega Mama, Rodeo (bulls from every spawner), Field Hospital (Big Cows with Vet escort), Ninja Night (Ninjas from the field edge, unannounced until they're in), War Moo-st (fog), Demolition Crew (Headbutt Heifers from wave 7), Spit Take (Cud Spitters with an escort from wave 9). Surprise-only cows have weight 0 | A wave can't be read off its number, while the formula still sets the baseline difficulty. Scripts are data (`defineSurprise`), so new ones are one call. They draw from their own RNG stream (and pass it to `spawnCow`), so a surprise never changes which cows the regular wave brings. Scheduled in `startWave` but fired in `tick()`, because `tick()` clears events pushed outside it. |
| Run seed | `main.js` picks a fresh seed per page load and per restart (`crypto.getRandomValues`); `?seed=N` pins one | With a fixed seed every run played out identically, which defeats surprises. The sim stays deterministic per seed, so replays and PvP (shared seed) still work. |
| Sim randomness | Seeded `mulberry32` (`src/sim/rng.js`), never `Math.random`; sim maths uses `+ - * /` and `sqrt` only (atan2 for model yaw lives in the renderer) | Same seed and inputs give the same match: needed for replays and lockstep PvP. Tested. |

Still open: cow-vs-cow and cow-vs-player collision (cows currently overlap; likely a uniform grid), WebGPU renderer, multiplayer networking model. JS floating-point maths (`Math.sin` etc.) is not guaranteed bit-identical across browsers, which matters for lockstep PvP; decide when PvP is scoped.

Record each decision here, with a one-line reason, once it is made.

## Running it

Any static file server works. ES modules don't load from `file://`, so you do need one:

```sh
python3 -m http.server 8080      # or: npx serve, or VS Code Live Server
# open http://localhost:8080   (movement test level: http://localhost:8080/?map=playground)
```

Deploying: in the repo's **Settings → Pages**, set the source to *Deploy from a branch*, branch `main`, folder `/ (root)`. The `.nojekyll` file makes Pages serve files as-is.

### Controls

| Input | Action |
|---|---|
| Click | Capture the mouse |
| W A S D / arrows | Move |
| Space or mouse wheel | Jump (wheel = classic bunny-hop bind) |
| C or Left Shift | Crouch (not Ctrl: Ctrl+W closes the browser tab) |
| R | Respawn |
| H | Toggle auto-hop (hold jump to keep hopping) |
| F | Toggle fullscreen. Any click, tap or key press also goes fullscreen (so it comes back after Esc); `?fs=0` opts out and remembers it, `?fs=1` opts back in |
| M | Mute / unmute sound (remembered) |
| [ and ] | Mouse sensitivity (saved in the browser) |
| \\ | Reset sensitivity to defaults |
| Esc | Release the mouse |
| 1 – 6 | Pick a tower to build (Milk Squirter, Butter Mortar, Hay Bale, Milk Frother, Hayloft Sniper, Auction Barn); the same key again stops building |
| Left click or E | Build the green ghost (red = not allowed, the reason shows under the crosshair) |
| Q or right click | Stop building |
| X | Sell the tower you're looking at (70% of everything spent on it back) |
| U | Upgrade panel for the tower you're looking at; while it's open 1 / 2 buy the cards and U or Q closes it |
| N | Start wave 1 (it never starts on its own, so you can build first), or the next wave now (the playground only has manual waves) |
| Enter | Restart after the cows drink all the milk (the **TRY AGAIN** button does the same) |
| P | Pause / resume (also releases the mouse; click RESUME or press P to carry on) |

If the browser refuses mouse capture (for example inside a sandboxed embed), a notice appears and you look by holding the left button and dragging instead.

Touch (phones and tablets; appears on the first tap):

| Input | Action |
|---|---|
| Left part of the screen | Floating move stick (put your thumb down anywhere there) |
| Drag on the right part | Look |
| **JUMP** | Jump; hold with auto-hop on to keep hopping; keep dragging the same thumb to steer |
| **CROUCH** | Crouch on/off (tap to switch; it says ON while active) |
| Tower bar (bottom) | Tap a tower to pick it; tap it again to stop building |
| **BUILD** | Build the ghost tower where you aim. Gold = ready, red = not allowed, dim = no tower picked (tapping it says what to do) |
| **SELL** | Sell the tower you're looking at; shows the refund, dim when you aren't looking at one |
| **UPGRADE** | Open the upgrade panel for the tower you're looking at (says the next level's price, "pick a path!" or MAXED). Left of SELL in landscape, above BUILD in portrait |
| **▶▶ NEXT WAVE** | Start the next wave now (hidden before wave 1, which has its own START WAVE 1 button) |
| **❚❚ PAUSE** | Freeze the game and open the menu: Resume, Sound, Auto-hop, Look speed − / +, Fullscreen, Respawn, Restart game (asks twice) |
| **TRY AGAIN** | Appears when the milk is gone; starts a fresh run |

The **START WAVE 1** button (bottom centre, shown until the first wave begins, and again after a restart) does the same as N; clicking it also captures the mouse.

Movement tunables can be changed live from the browser console, e.g. `goofytd.cfg.airAccel = 20`; the match too: `goofytd.game.money = 9999`, `goofytd.game.startWave()`.

## Tests

The same tests run in Node and in the browser, with a tiny built-in harness (no test framework):

```sh
node tests/run.js        # or: npm test
node tools/stamp.js      # or: npm run stamp — after changing anything in src/ (refreshes the ?v= versions in index.html; a test fails until you do)
```

`stamp.test.js` reads files, so it runs in Node only.

Or open `/tests/` on the local server or on the deployed Pages site.

They cover collision sweeps (including tunnelling), acceleration, friction, wall sliding, jump arc vs. ballistics, jump buffering, coyote time, step-up/step-down, crouching under ceilings, crouch-jump height, strafe-jump speed gain, determinism, the fixed-tick loop at different frame rates, every level spawn, the open-field walls holding a 40 m/s player, the touch stick mapping, the touch button labels (BUILD / SELL / NEXT WAVE states) and the pause menu (labels, two-tap restart), and the look path (delta filtering, exact turn rates, camera orientation vs movement axes, settings validation), and tower defence: spawners reach the milk on every level, cows walk the flow field and drink, waves start and grow, losing, grid snapping, every placement refusal, mazing without sealing the milk, cows never walking through towers, towers being solid for the player and selling, the sell raycast, squirter kills and bounties, mortar splash/lead/min range, a custom tower type plugging in, same-seed determinism, a 2000-cow / 40-tower benchmark (prints ms per tick), cow variants (wave mix and debuts, speed/size, flyers crossing a maze straight and dodging the mortar, Kaboom Cows wrecking towers with no refund, always triggering beside a wall, harmless when shot, determinism with explosions), tower upgrades (registry shape, prices and refunds, every refusal, gatling spin-up/down, shotgun cone and cap, zap reach and flyers, slows, non-stacking puddles, flak airbursts, Kaboom-proof bales, the balance regression, the panel model, determinism and a 40-upgraded-tower benchmark), surprises (definitions, chance curve, same seed same schedule and different seeds different ones, rate and the never-three-quiet-waves guarantee, regular waves unchanged by surprises, every script playing out with its banner and exact spawns, Cash Cow payout and escape, Too Quiet hold and rush, ambush points, banners surviving hand-started waves, Big Bessie), later cow variants (Tin armor and its floor, Mama and Mega Mama splits at wave HP without touching the wave RNG, a shotgun through a Mama herd, Bull enrage speed, Vet heal reach and cap, Ninja camo vs splash, cow tipping, Happy Hour, the milkman, Trojan and Mega Mama punchlines, determinism over 14 waves, a 2000-cow benchmark with Vets), cows that hit back (Heifer wind-up, bonk and cooldown, repair delay, wrecks and their refund, tipping cancelling a wind-up, upgrades toughening and repairing, Spitters jamming the nearest shooting tower and never a wall), War Moo-st (ramp, sight cut, clearing, the surprise's warning, bounty and positioned ambush), the new towers (frother cone through Tin armour with no flash, burn totals and kill credit, flambé spreading once, soft-serve freeze and brittleness and thawing, sniper camo spotting and strongest targeting, headshot cadence, executions sparing bosses, the railgun line through armour, barn multipliers not stacking but multiplying Happy Hour, capped vault interest, balance, determinism and a 40-tower benchmark), and sound: positioning and panning, every synthesised sound building a valid graph (a fake context that throws on what browsers throw on), throttling, muting and event mapping, the pre-rendered bank (every variant at its exact length), the engine fallback chain, the worklet engine building no nodes and batching one message per frame with the right channel gains, and the mixer (sample-exact starts, mixing, 44.1 kHz resampling, voice limits).

## Movement model

`src/sim/movement.js` follows Quake 3 / Source player movement, in metres and seconds:

- Ground: friction (with a stop speed for crisp stops), then accelerate toward the wish speed (7.5 m/s).
- Air: same acceleration, but the projected-speed cap is tiny (0.8 m/s) while the acceleration amount isn't. This is what makes **strafe jumping / bunny hopping** gain speed when you strafe and turn the mouse together.
- No friction on the tick you jump, so chained hops keep speed. Jump presses are buffered for 0.12 s; coyote time is 0.1 s.
- Step-slide climbs ledges up to 0.45 m; walking down stairs snaps to the ground instead of going airborne.
- Crouching shrinks the hull to 1.2 m. In the air the legs tuck up, so a **crouch jump** reaches 0.6 m higher.

The default level is the open field: four cow spawners (one per side) and waves that start on their own (first after 20 s, then 25 s after each wave finishes spawning; each wave has 4 more cows with 15% more HP; new cow types join from waves 3 to 13; from wave 2, scripted surprises can hit mid-wave). The movement test level (`?map=playground`) has a step-height row, stairs to a 3 m platform, a 1.1 m ledge (plain jump), a 1.7 m ledge (crouch jump only), a crawl tunnel, a pillar-lined bunny-hop runway, and the milk.

## Adding a tower

One call in `src/sim/towers.js` (field reference in the `defineTower` doc comment):

```js
defineTower({
  id: 'cheese-cannon', name: 'Cheese Cannon', blurb: 'big slow hits', cost: 80,
  footprint: 1, height: 1.4, attack: 'hitscan', targeting: 'strongest',
  range: 18, interval: 1.5, damage: 40, muzzle: [0, 1.2, -1], shotColor: 0xffc23a,
  parts: [
    { min: [-0.9, 0, -0.9], max: [0.9, 1.0, 0.9], color: 0xe8a33a },
    { min: [-0.2, 1.0, -1.0], max: [0.2, 1.4, 0.2], color: 0x333333, aim: true },
  ],
});
```

It shows up in the build bar with the next number key. Upgrades are `defineUpgrade` calls: `from` (the form it upgrades), `kind` (`'buff'` or `'variant'`), `cost`, and whatever fields change (`addParts` adds boxes to the model, `parts` replaces it). Two upgrades from the same form make a path choice. A new behaviour is an `attack(game, tower, cowSlot)` or `targeting(game, tower)` function, either inline or added to `ATTACKS` / `TARGETING`. Cows work the same way with `defineCow` in `src/sim/cows.js`.

## Layout

```
index.html              page, import map, HUD markup
src/main.js             entry point: frame loop wiring sim, input, render, HUD
src/fixed-clock.js      fixed-timestep accumulator (64 Hz) + interpolation alpha
src/player.js           player body: input latching, interpolation, respawn
src/level.js            levels (open field, movement playground): one block list for collision and meshes
src/sim/                pure simulation, no three.js / DOM
  vec3.js               small vector type
  collision.js          AABB world, swept-box queries
  movement.js           pmove-style movement tick
  navgrid.js            cow nav grid, flow field (Dijkstra), reachability check for placement
  cows.js               cow type registry + structure-of-arrays cow pool
  surprises.js          scripted mid-wave surprises (`defineSurprise`), chance curve, weighted pick
  towers.js             tower types + upgrade forms, targeting, attacks (hitscan, lob, shotgun, aura), towerStats
  game.js               the match: spawners, waves, cows, towers, upgrades, slicks, slows, money, milk, placement rules
  rng.js                seeded PRNG
src/client/             browser-only
  render.js             three.js scene, world-UV box meshes, grid texture, lights
  look.js               mouse-delta filter (spikes, Firefox echoes)/accumulator, view quaternion (pure, tested)
  input.js              pointer lock + drag-look fallback, keyboard, bindings, settings
  touch.js              touch stick, drag-look, labelled buttons (`touchButtonState`)
  menu.js               PauseMenu: DOM overlay with labelled settings buttons
  upgrade-menu.js       UpgradeMenu panel + pure upgradeModel() / statDeltas()
  build.js              build mode: crosshair -> ground point, placement preview, sell target
  td-render.js          instanced cows, tower models from `parts` (rebuilt + popped on upgrade), ghost, tracers, shells, slicks, puffs
  audio.js              procedural sound effects (Web Audio), sound bank, engines, positioning, throttling
  sfx-worklet.js        audio-thread mixer (AudioWorklet) for the pre-rendered bank
  hud.js                speed/state/FPS, milk/money/wave, build bar, placement text, game-over banner
tests/                  harness.js, *.test.js, run.js (Node), index.html (browser)
tools/stamp.js          writes `?v=<content hash>` for every module into the import map (cache busting)
```

`package.json` exists only so Node treats the files as ES modules and for the `npm test` / `npm run stamp` shortcuts. It has no dependencies.

## Development notes

- Find and explain the root cause of a bug rather than patching the symptom.
- Verify fixes programmatically where possible (tests, a headless run, a benchmark) instead of assuming they work.
- When debugging, give complete rewritten functions/files rather than partial diffs.
- Performance claims need numbers: measure entity counts and frame times rather than guessing.
- Keep this file current: when a decision, command or structure changes, update it in the same change.
