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
| Sound | `src/client/audio.js`: every effect is synthesised with Web Audio when it plays (oscillators, filtered noise, envelopes), no sample files. Sim events (`shot`, `launch`, `splash`, `kill`, `drink`, `boom`, `wave`, `lost`) map to sounds; UI sounds play where the click happens. Distance gain `(1 − d/70)²`, stereo pan from the view direction, per-sound throttle and overlap caps, 28 voices total, compressor on the master | No assets to download or license; thousands of cows and 40 towers would otherwise fire hundreds of sounds a second. Created on the first gesture (browsers lock audio until then). Events pushed outside `tick()` (hand-started waves, builds) are cleared by the next tick, so those sounds are triggered directly. |
| Touch | Floating left-thumb stick, drag-to-look, jump button that also steers, crouch toggle. Every button carries a word, not a letter; BUILD / SELL relabel themselves from the game state (`touchButtonState`, unit-tested) | Playable on phones; the jump thumb steering is what makes air strafing possible with two thumbs. The old corner row of `S− S+ HOP R ⛶ N ♪` was unreadable, so rarely-used settings moved into the pause menu and only play actions stay on screen. |
| Pause | `main.js` `setPaused`: the frame loop skips `player.step`/`game.tick` and doesn't feed the `FixedClock` (no fast-forward on resume); rendering continues behind the DOM menu (`src/client/menu.js`). P toggles it, the mouse is released while paused, and `Input.paused` makes game keys ignored. RESTART GAME needs two taps within 3 s | Gives phones a place for settings and a way to stop. The mouse has to be free to click the menu. The sim is untouched, so determinism isn't affected. |
| Cache busting | `tools/stamp.js` (`npm run stamp`) rewrites the import map in `index.html` so every module URL carries `?v=<content hash>`; `index.html` loads `main.js` with `import` (not `src=`) so it goes through the map too. A test fails when a hash is stale | GitHub Pages caches each file for 10 min and browsers reuse fresh cached scripts even on reload, so right after a deploy a phone ran the new page with old scripts: tower bar, PAUSE, BUILD and SELL all dead. Reproduced with a real HTTP cache in Chromium, and gone with the versioned map. A missed stamp only falls back to the old caching, never breaks the game. |
| Touch layout | Tower bar left of CROUCH in landscape (wraps rather than overflow); centred above BUILD / SELL in portrait, stats line hidden there | The bar used to have no width limit and slid off the left edge in portrait. Checked at 568×320 to 1024×768 and 360×740 to 768×1024: every button on-screen, none overlapping, every action working. |
| Touch button taps | `setPointerCapture` is wrapped in try/catch in `touch.js` | It throws `InvalidStateError` for a pointer that is already gone (a very quick tap) and, running before the action, silently dropped the tap. Capture only matters for drags. |

| Cow pathing | One shared flow field on a 2 m nav grid (`src/sim/navgrid.js`): Dijkstra outward from the cells around the milk, 8-way with no corner cutting, rebuilt only when a tower is built or sold | Cost is per grid, not per cow: 2000 cows tick in ~0.4 ms; a rebuild of the 100×100 field is ~2 ms. Towers can maze the cows, and the same field answers "how far is this cow from the milk" for targeting. |
| Tower placement | Towers snap to the nav grid (odd footprints centre on a cell, even on a corner). Refused on level geometry, other towers, cows, the player, the field edge, too little money, or if any spawner or cow would lose every path to the milk | Mazing is the fun part of TD, sealing the milk off would break it. The path check is a yes/no BFS (~1.5 ms with 2000 cows), and the build preview reruns it only when the aim, grid or money changes, or every 120 ms. |
| Towers are modular | `src/sim/towers.js`: a tower type is one `defineTower({...})` call: stats, `targeting` (`first`/`nearest`/`strongest` or a function), `attack` (`hitscan`/`lob`, a function, or null for a wall) and `parts` (coloured boxes to draw). The game, build bar, hotkeys and renderer all read the registry | Adding a tower touches one file; a test proves a custom tower with its own attack function works with no other changes. |
| Cows | Types in a `defineCow` registry (`src/sim/cows.js`); live cows in flat typed arrays with swap-remove; drawn as one `InstancedMesh` tinted per type (plus one wing `InstancedMesh` for flyers) | Thousands of cows without per-cow objects or draw calls. Nothing holds a cow slot across ticks (shells aim at a point), so swap-remove is safe. |
| Cow variants | Cow (wave 1+), Zoomies Cow (fast, fragile, wave 3+), Big Cow (slow, 170 HP, 15 milk, wave 4+), Flying Cow (wave 5+), Kaboom Cow (wave 6+). Each wave picks every cow's type with the seeded RNG from the types unlocked so far, weighted (10/4/2/3/2); a one-type mix draws no random number. HP scaling per wave applies to every type. The HUD announces a type's first wave | Variety without hand-written wave lists; data-only, so new types are one `defineCow` call. Weights keep plain cows the bulk of every wave. |
| Flying cows | `altitude > 0`: fly straight at the milk (ignore the flow field, walls and towers), ignored by placement checks, ranked by straight-line distance for targeting. Only towers with `hitsAir` (default true; the Butter Mortar is false) target them, and splash skips them | Mazing can't stop them, so they test raw firepower instead; the mortar's lob lands on the ground. |
| Kaboom cows | `blastRadius > 0`: when the cow's edge gets within `BLAST_TRIGGER` (1 m) of a tower's footprint (tower ids looked up in the 5×5 cells around it), it explodes: every tower whose footprint is within 2.6 m is wrecked (no refund), the cow dies with no bounty and no milk lost, one flow-field rebuild. Shot down first, it pops harmlessly | Punishes tight hay-bale mazes. 1 m means any cow walking in a cell next to a tower always goes off (with 0.5 m, half the cows walked past a wall end; there's a test). |
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
| 1 2 3 | Pick a tower to build (Milk Squirter, Butter Mortar, Hay Bale); the same key again stops building |
| Left click or E | Build the green ghost (red = not allowed, the reason shows under the crosshair) |
| Q or right click | Stop building |
| X | Sell the tower you're looking at (70% back) |
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

They cover collision sweeps (including tunnelling), acceleration, friction, wall sliding, jump arc vs. ballistics, jump buffering, coyote time, step-up/step-down, crouching under ceilings, crouch-jump height, strafe-jump speed gain, determinism, the fixed-tick loop at different frame rates, every level spawn, the open-field walls holding a 40 m/s player, the touch stick mapping, the touch button labels (BUILD / SELL / NEXT WAVE states) and the pause menu (labels, two-tap restart), and the look path (delta filtering, exact turn rates, camera orientation vs movement axes, settings validation), and tower defence: spawners reach the milk on every level, cows walk the flow field and drink, waves start and grow, losing, grid snapping, every placement refusal, mazing without sealing the milk, cows never walking through towers, towers being solid for the player and selling, the sell raycast, squirter kills and bounties, mortar splash/lead/min range, a custom tower type plugging in, same-seed determinism, a 2000-cow / 40-tower benchmark (prints ms per tick), cow variants (wave mix and debuts, speed/size, flyers crossing a maze straight and dodging the mortar, Kaboom Cows wrecking towers with no refund, always triggering beside a wall, harmless when shot, determinism with explosions), and sound: positioning and panning, every synthesised sound building a valid graph (a fake context that throws on what browsers throw on), throttling, muting and event mapping.

## Movement model

`src/sim/movement.js` follows Quake 3 / Source player movement, in metres and seconds:

- Ground: friction (with a stop speed for crisp stops), then accelerate toward the wish speed (7.5 m/s).
- Air: same acceleration, but the projected-speed cap is tiny (0.8 m/s) while the acceleration amount isn't. This is what makes **strafe jumping / bunny hopping** gain speed when you strafe and turn the mouse together.
- No friction on the tick you jump, so chained hops keep speed. Jump presses are buffered for 0.12 s; coyote time is 0.1 s.
- Step-slide climbs ledges up to 0.45 m; walking down stairs snaps to the ground instead of going airborne.
- Crouching shrinks the hull to 1.2 m. In the air the legs tuck up, so a **crouch jump** reaches 0.6 m higher.

The default level is the open field: four cow spawners (one per side) and waves that start on their own (first after 20 s, then 25 s after each wave finishes spawning; each wave has 4 more cows with 15% more HP; new cow types join from waves 3, 4, 5 and 6). The movement test level (`?map=playground`) has a step-height row, stairs to a 3 m platform, a 1.1 m ledge (plain jump), a 1.7 m ledge (crouch jump only), a crawl tunnel, a pillar-lined bunny-hop runway, and the milk.

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

It shows up in the build bar with the next number key. A new behaviour is an `attack(game, tower, cowSlot)` or `targeting(game, tower)` function, either inline or added to `ATTACKS` / `TARGETING`. Cows work the same way with `defineCow` in `src/sim/cows.js`.

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
  towers.js             tower type registry, targeting strategies, attacks
  game.js               the match: spawners, waves, cows, towers, money, milk, placement rules
  rng.js                seeded PRNG
src/client/             browser-only
  render.js             three.js scene, world-UV box meshes, grid texture, lights
  look.js               mouse-delta filter (spikes, Firefox echoes)/accumulator, view quaternion (pure, tested)
  input.js              pointer lock + drag-look fallback, keyboard, bindings, settings
  touch.js              touch stick, drag-look, labelled buttons (`touchButtonState`)
  menu.js               PauseMenu: DOM overlay with labelled settings buttons
  build.js              build mode: crosshair -> ground point, placement preview, sell target
  td-render.js          instanced cows, tower models from `parts`, ghost, tracers, shells, puffs
  audio.js              procedural sound effects (Web Audio), positioning, throttling
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
