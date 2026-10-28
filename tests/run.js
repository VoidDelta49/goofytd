// Node entry point: `node tests/run.js` (or `npm test`). Exits non-zero on failure.
import './sim.test.js';
import './loop.test.js';
import './input.test.js';
import { runAll } from './harness.js';

const { failed } = await runAll();
process.exitCode = failed ? 1 : 0;
