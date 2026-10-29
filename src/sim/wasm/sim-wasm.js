// Loads the Rust sim core (sim-rs/, compiled to sim.wasm by CI or
// `npm run wasm`). Plain WebAssembly, no wasm-bindgen, no bundler: the
// exports are a handful of C-ABI functions and the arrays live in WASM
// memory, viewed from JS as typed arrays.
//
// If sim.wasm is missing (fresh checkout without a Rust build) or fails to
// load, `wasm` is null and the sim runs its JS implementations instead.
// Set globalThis.COWTD_NO_WASM = true before loading to force JS.

import { WASM_VERSION } from './version.js';

async function load() {
  if (!WASM_VERSION || globalThis.COWTD_NO_WASM) return null;
  if (typeof WebAssembly === 'undefined') return null;
  try {
    let bytes;
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { readFile } = await import('node:fs/promises');
      bytes = await readFile(new URL('./sim.wasm', import.meta.url));
    } else {
      // ?v= busts GitHub Pages' 10-minute cache, like the import map does for modules.
      const res = await fetch(new URL(`./sim.wasm?v=${WASM_VERSION}`, import.meta.url));
      if (!res.ok) return null;
      bytes = await res.arrayBuffer();
    }
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance.exports;
  } catch (err) {
    console.warn('CowTD: sim.wasm failed to load, using the JS sim', err);
    return null;
  }
}

/** The Rust exports (nav_new, nav_rebuild, memory, ...), or null for the JS fallback. */
export const wasm = await load();
