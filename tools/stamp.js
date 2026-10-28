// Cache-busting for a no-build site. GitHub Pages serves every file with
// `Cache-Control: max-age=600`, and browsers reuse fresh cached scripts
// without asking, even on reload. For ~10 minutes after a deploy a browser
// can run the NEW index.html against OLD cached modules (or a mix), which
// breaks whatever the two versions disagree on.
//
// Fix: the import map in index.html points every module URL at the same URL
// plus `?v=<hash of that file's content>`. A changed file gets a URL the
// browser has never cached, so it always matches the page that names it.
// The server ignores the query, so a missed stamp only means "cached as
// before", never a broken game. `node tests/run.js` fails until you restamp.
//
// Usage: node tools/stamp.js   (rewrites the import map in index.html)

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every module under src/, as './src/...' paths (sorted, forward slashes). */
export function moduleFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push('./' + relative(root, p).split('\\').join('/'));
    }
  };
  walk(join(root, 'src'));
  return out.sort();
}

export function versionOf(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 10);
}

/** The import map `imports` the page should have: three.js plus one versioned entry per module. */
export function expectedImports(root = ROOT, keep = {}) {
  const imports = {};
  for (const [k, v] of Object.entries(keep)) if (!k.startsWith('./src/')) imports[k] = v;
  for (const f of moduleFiles(root)) imports[f] = `${f}?v=${versionOf(readFileSync(join(root, f)))}`;
  return imports;
}

const MAP_RE = /(<script type="importmap">)([\s\S]*?)(<\/script>)/;

export function readImportMap(html) {
  const m = MAP_RE.exec(html);
  if (!m) throw new Error('index.html has no <script type="importmap">');
  return JSON.parse(m[2]);
}

/** index.html with its import map rewritten to `imports`. */
export function stampHtml(html, imports) {
  const lines = Object.entries(imports).map(([k, v]) => `        ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const json = `\n    {\n      "imports": {\n${lines.join(',\n')}\n      }\n    }\n  `;
  return html.replace(MAP_RE, (_, a, _b, c) => a + json + c);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = join(ROOT, 'index.html');
  const html = readFileSync(file, 'utf8');
  const next = stampHtml(html, expectedImports(ROOT, readImportMap(html).imports));
  if (next !== html) writeFileSync(file, next);
  console.log(next !== html ? 'index.html import map updated' : 'index.html import map already current');
}
