# CowTD (goofytd)

An incredibly goofy but fun first-person tower defense game: defend your milk from cows.

## Game concept

- **Perspective:** first person.
- **Singleplayer:** tower defense. Cows come for your milk; you build and fight to stop them.
- **Multiplayer (later):** PvP. Not part of the first milestones, but don't make architecture choices that rule it out (keep simulation deterministic-friendly and separate from rendering/input).
- **Movement:** weirdly in-depth and satisfying FPS movement is a core pillar, not a polish item. Movement feel gets as much design attention as the towers.
- **Tone:** goofy. Cows, milk, absurdity. Fun over realism.

## Technical direction

- **Language/platform:** Rust, targeting the web (WebAssembly in the browser).
- **Engine:** Bevy, rendering through wgpu.
- **Why Rust:** the game has to handle hundreds to thousands of entities (cow waves, projectiles, towers) at a steady frame rate.
- **Entity design:** data-oriented, using Bevy's ECS. Avoid per-entity heap allocation and per-entity work that doesn't need to happen in hot paths.
- **Open decisions (not decided yet):**
  - Rendering backend on the web: WebGPU vs. WebGL2 fallback (both are reachable through wgpu).
  - Physics/collision approach for the movement controller and for thousands of cows (custom vs. a library).
  - Multiplayer networking model (to be decided when PvP is scoped).
- Record each decision here, with a one-line reason, once it is made.

## Repository

- Remote: https://github.com/VoidDelta49/goofytd (default branch `main`).
- Currently contains only a `LICENSE` and this README. No code, build setup or tooling yet.
- Layout, build commands and test commands: add them here as they are created.

## Development notes

- Find and explain the root cause of a bug rather than patching the symptom.
- Verify fixes programmatically where possible (tests, a headless run, a benchmark) instead of assuming they work.
- When debugging, give complete rewritten functions/files rather than partial diffs.
- Performance claims need numbers: measure entity counts and frame times rather than guessing.
- Keep this file current: when a decision, command or structure changes, update it in the same change.
