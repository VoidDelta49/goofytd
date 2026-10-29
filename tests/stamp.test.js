// Node only (reads files): the import map must version every module with its current content hash.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, assert } from './harness.js';
import { ROOT, WASM_VERSION_FILE, expectedImports, moduleFiles, readImportMap, wasmVersionJs } from '../tools/stamp.js';

test('cache: index.html import map versions every module with its content hash (run `node tools/stamp.js`)', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const have = readImportMap(html).imports;
  const want = expectedImports(ROOT, have);
  const stale = Object.keys(want).filter((k) => have[k] !== want[k]);
  const extra = Object.keys(have).filter((k) => !(k in want));
  assert(stale.length === 0 && extra.length === 0,
    `import map out of date; run \`node tools/stamp.js\`. stale: ${stale.join(', ') || '-'} · extra: ${extra.join(', ') || '-'}`);
  assert(have.three?.includes('three@0.186.1'), 'three.js entry lost');
  assert(moduleFiles().includes('./src/main.js'), 'module scan found no main.js');
});

test('cache: the page loads main.js through the import map, not a bare script src', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  // <script src> bypasses import maps, so main.js itself would never get its version.
  assert(!/<script[^>]+src=["'][^"']*main\.js/.test(html), 'main.js loaded with src=, which skips the version');
  assert(/import\s+['"]\.\/src\/main\.js['"]/.test(html), 'no `import "./src/main.js"` entry script');
});

test('cache: version.js carries the current sim.wasm hash (run `node tools/stamp.js`)', () => {
  assert(readFileSync(join(ROOT, WASM_VERSION_FILE), 'utf8') === wasmVersionJs(ROOT),
    'sim.wasm changed (or appeared/vanished) without restamping; run `node tools/stamp.js`');
});
