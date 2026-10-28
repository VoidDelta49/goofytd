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
| Touch | Floating left-thumb stick, drag-to-look, jump button that also steers, crouch toggle | Playable on phones; the jump thumb steering is what makes air strafing possible with two thumbs. |

| Cow pathing | One shared flow field on a 2 m nav grid (`src/sim/navgrid.js`): Dijkstra outward from the cells around the milk, 8-way with no corner cutting, rebuilt only when a tower is built or sold | Cost is per grid, not per cow: 2000 cows tick in ~0.4 ms; a rebuild of the 100×100 field is ~2 ms. Towers can maze the cows, and the same field answers "how far is this cow from the milk" for targeting. |
| Tower placement | Towers snap to the nav grid (odd footprints centre on a cell, even on a corner). Refused on level geometry, other towers, cows, the player, the field edge, too little money, or if any spawner or cow would lose every path to the milk | Mazing is the fun part of TD, sealing the milk off would break it. The path check is a yes/no BFS (~1.5 ms with 2000 cows), and the build preview reruns it only when the aim, grid or money changes, or every 120 ms. |
| Towers are modular | `src/sim/towers.js`: a tower type is one `defineTower({...})` call: stats, `targeting` (`first`/`nearest`/`strongest` or a function), `attack` (`hitscan`/`lob`, a function, or null for a wall) and `parts` (coloured boxes to draw). The game, build bar, hotkeys and renderer all read the registry | Adding a tower touches one file; a test proves a custom tower with its own attack function works with no other changes. |
| Cows | Types in a `defineCow` registry (`src/sim/cows.js`); live cows in flat typed arrays with swap-remove; drawn as one `InstancedMesh` | Thousands of cows without per-cow objects or draw calls. Nothing holds a cow slot across ticks (shells aim at a point), so swap-remove is safe. |
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
| F | Toggle fullscreen. Once the Firefox echo filter has fired (that browser lets the cursor roam out of the window), clicking into the game goes fullscreen automatically; `?fs=1` forces that, `?fs=0` turns it off |
| [ and ] | Mouse sensitivity (saved in the browser) |
| \\ | Reset sensitivity to defaults |
| Esc | Release the mouse |
| 1 2 3 | Pick a tower to build (Milk Squirter, Butter Mortar, Hay Bale); the same key again stops building |
| Left click or E | Build the green ghost (red = not allowed, the reason shows under the crosshair) |
| Q or right click | Stop building |
| X | Sell the tower you're looking at (70% back) |
| N | Start the next wave now (the playground only has manual waves) |
| Enter | Restart after the cows drink all the milk |

If the browser refuses mouse capture (for example inside a sandboxed embed), a notice appears and you look by holding the left button and dragging instead.

Touch (phones and tablets; appears on the first tap):

| Input | Action |
|---|---|
| Left part of the screen | Floating move stick (put your thumb down anywhere there) |
| Drag on the right part | Look |
| JUMP | Jump; hold with auto-hop on to keep hopping; keep dragging the same thumb to steer |
| DUCK | Crouch toggle |
| S− / S+ | Look sensitivity (degrees per pixel, saved in the browser) |
| HOP, R, ⛶ | Auto-hop toggle, respawn, fullscreen (also locks landscape where the browser allows) |
| BUILD | Cycle the tower to build (then off) |
| PLACE | Build the ghost, or sell the tower you're looking at when not building |
| N | Start the next wave now |

Movement tunables can be changed live from the browser console, e.g. `goofytd.cfg.airAccel = 20`; the match too: `goofytd.game.money = 9999`, `goofytd.game.startWave()`.

## Tests

The same tests run in Node and in the browser, with a tiny built-in harness (no test framework):

```sh
node tests/run.js        # or: npm test
```

Or open `/tests/` on the local server or on the deployed Pages site.

They cover collision sweeps (including tunnelling), acceleration, friction, wall sliding, jump arc vs. ballistics, jump buffering, coyote time, step-up/step-down, crouching under ceilings, crouch-jump height, strafe-jump speed gain, determinism, the fixed-tick loop at different frame rates, every level spawn, the open-field walls holding a 40 m/s player, the touch stick mapping, and the look path (delta filtering, exact turn rates, camera orientation vs movement axes, settings validation), and tower defence: spawners reach the milk on every level, cows walk the flow field and drink, waves start and grow, losing, grid snapping, every placement refusal, mazing without sealing the milk, cows never walking through towers, towers being solid for the player and selling, the sell raycast, squirter kills and bounties, mortar splash/lead/min range, a custom tower type plugging in, same-seed determinism, and a 2000-cow / 40-tower benchmark (prints ms per tick).

## Movement model

`src/sim/movement.js` follows Quake 3 / Source player movement, in metres and seconds:

- Ground: friction (with a stop speed for crisp stops), then accelerate toward the wish speed (7.5 m/s).
- Air: same acceleration, but the projected-speed cap is tiny (0.8 m/s) while the acceleration amount isn't. This is what makes **strafe jumping / bunny hopping** gain speed when you strafe and turn the mouse together.
- No friction on the tick you jump, so chained hops keep speed. Jump presses are buffered for 0.12 s; coyote time is 0.1 s.
- Step-slide climbs ledges up to 0.45 m; walking down stairs snaps to the ground instead of going airborne.
- Crouching shrinks the hull to 1.2 m. In the air the legs tuck up, so a **crouch jump** reaches 0.6 m higher.

The default level is the open field: four cow spawners (one per side) and waves that start on their own (first after 20 s, then 25 s after each wave finishes spawning; each wave has 4 more cows with 15% more HP). The movement test level (`?map=playground`) has a step-height row, stairs to a 3 m platform, a 1.1 m ledge (plain jump), a 1.7 m ledge (crouch jump only), a crawl tunnel, a pillar-lined bunny-hop runway, and the milk.

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
  touch.js              touch stick, drag-look and buttons
  build.js              build mode: crosshair -> ground point, placement preview, sell target
  td-render.js          instanced cows, tower models from `parts`, ghost, tracers, shells, puffs
  hud.js                speed/state/FPS, milk/money/wave, build bar, placement text, game-over banner
tests/                  harness.js, *.test.js, run.js (Node), index.html (browser)
```

`package.json` exists only so Node treats the files as ES modules and for the `npm test` shortcut. It has no dependencies.

## Development notes

- Find and explain the root cause of a bug rather than patching the symptom.
- Verify fixes programmatically where possible (tests, a headless run, a benchmark) instead of assuming they work.
- When debugging, give complete rewritten functions/files rather than partial diffs.
- Performance claims need numbers: measure entity counts and frame times rather than guessing.
- Keep this file current: when a decision, command or structure changes, update it in the same change.
