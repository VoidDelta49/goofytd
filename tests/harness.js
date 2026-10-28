// Tiny test harness that runs unchanged in Node and in the browser, so the
// project needs no test framework and no build step.

const registered = [];

export function test(name, fn) {
  registered.push({ name, fn });
}

export class AssertionError extends Error {}

export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new AssertionError(msg);
}

export function assertClose(actual, expected, tol, what = 'value') {
  assert(Math.abs(actual - expected) <= tol, `${what}: expected ${expected} ± ${tol}, got ${actual}`);
}

/** Run every registered test. Returns { passed, failed, results }. */
export async function runAll(log = console.log) {
  const results = [];
  for (const { name, fn } of registered) {
    const t0 = performance.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: performance.now() - t0 });
      log(`ok    ${name}`);
    } catch (err) {
      results.push({ name, ok: false, error: err });
      log(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  log(`\n${results.length - failed} passed, ${failed} failed`);
  return { passed: results.length - failed, failed, results };
}
