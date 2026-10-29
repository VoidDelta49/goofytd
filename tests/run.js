// Node entry point: `node tests/run.js` (or `npm test`). Exits non-zero on failure.
import './sim.test.js';
import './loop.test.js';
import './input.test.js';
import './td.test.js';
import './cows.test.js';
import './audio.test.js';
import './upgrades.test.js';
import './surprises.test.js';
import './variants.test.js';
import './retaliation.test.js';
import './bosses.test.js';
import './newtowers.test.js';
import './coop.test.js';
import './discovery.test.js';
import './cull.test.js';
import './auto.test.js';
import './speed.test.js';
import './navgrid.test.js';
import './cowhash.test.js';
import './stamp.test.js'; // Node only: reads index.html and the sources
import { runAll } from './harness.js';

const { failed } = await runAll();
process.exitCode = failed ? 1 : 0;
