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

Still open: collision approach for thousands of cows (likely a uniform grid), WebGPU renderer, multiplayer networking model. JS floating-point maths (`Math.sin` etc.) is not guaranteed bit-identical across browsers, which matters for lockstep PvP; decide when PvP is scoped.

Record each decision here, with a one-line reason, once it is made.

## Running it

Any static file server works. ES modules don't load from `file://`, so you do need one:

```sh
python3 -m http.server 8080      # or: npx serve, or VS Code Live Server
# open http://localhost:8080
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
| [ and ] | Mouse sensitivity (saved in the browser) |
| Esc | Release the mouse |

Movement tunables can be changed live from the browser console, e.g. `goofytd.cfg.airAccel = 20`.

## Tests

The same tests run in Node and in the browser, with a tiny built-in harness (no test framework):

```sh
node tests/run.js        # or: npm test
```

Or open `/tests/` on the local server or on the deployed Pages site.

They cover collision sweeps (including tunnelling), acceleration, friction, wall sliding, jump arc vs. ballistics, jump buffering, coyote time, step-up/step-down, crouching under ceilings, crouch-jump height, strafe-jump speed gain, determinism, and the fixed-tick loop at different frame rates.

## Movement model

`src/sim/movement.js` follows Quake 3 / Source player movement, in metres and seconds:

- Ground: friction (with a stop speed for crisp stops), then accelerate toward the wish speed (7.5 m/s).
- Air: same acceleration, but the projected-speed cap is tiny (0.8 m/s) while the acceleration amount isn't. This is what makes **strafe jumping / bunny hopping** gain speed when you strafe and turn the mouse together.
- No friction on the tick you jump, so chained hops keep speed. Jump presses are buffered for 0.12 s; coyote time is 0.1 s.
- Step-slide climbs ledges up to 0.45 m; walking down stairs snaps to the ground instead of going airborne.
- Crouching shrinks the hull to 1.2 m. In the air the legs tuck up, so a **crouch jump** reaches 0.6 m higher.

The test level (`src/level.js`) has a step-height row, stairs to a 3 m platform, a 1.1 m ledge (plain jump), a 1.7 m ledge (crouch jump only), a crawl tunnel, a pillar-lined bunny-hop runway, and the milk.

## Layout

```
index.html              page, import map, HUD markup
src/main.js             entry point: frame loop wiring sim, input, render, HUD
src/fixed-clock.js      fixed-timestep accumulator (64 Hz) + interpolation alpha
src/player.js           player body: input latching, interpolation, respawn
src/level.js            level blocks: single source for collision and meshes
src/sim/                pure simulation, no three.js / DOM
  vec3.js               small vector type
  collision.js          AABB world, swept-box queries
  movement.js           pmove-style movement tick
src/client/             browser-only
  render.js             three.js scene, world-UV box meshes, grid texture, lights
  input.js              pointer lock, keyboard, mouse, bindings, sensitivity
  hud.js                speed/state/FPS overlay
tests/                  harness.js, *.test.js, run.js (Node), index.html (browser)
```

`package.json` exists only so Node treats the files as ES modules and for the `npm test` shortcut. It has no dependencies.

## Development notes

- Find and explain the root cause of a bug rather than patching the symptom.
- Verify fixes programmatically where possible (tests, a headless run, a benchmark) instead of assuming they work.
- When debugging, give complete rewritten functions/files rather than partial diffs.
- Performance claims need numbers: measure entity counts and frame times rather than guessing.
- Keep this file current: when a decision, command or structure changes, update it in the same change.
