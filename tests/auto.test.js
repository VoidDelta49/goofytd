// Auto-upgrade: the optional "towers buy their own next level" setting.
// Cheapest affordable level first (spreads money over the defence), one buy per
// AUTO_EVERY, follows each path choice the farmer made (or the first path),
// never overspends, survives restarts, travels as commands, stays deterministic.

import { test, assert } from './harness.js';
import { levelCollision, openField } from '../src/level.js';
import { Game, AUTO_EVERY, defaultGameConfig } from '../src/sim/game.js';
import { TOWER_FORMS, TOWER_TYPES } from '../src/sim/towers.js';
import { applyCommand, sanitizeCommand, stateHash } from '../src/sim/commands.js';
import { upgradeModel } from '../src/client/upgrade-menu.js';

const DT = 1 / 64;
const run = (g, seconds) => { for (let i = 0; i < Math.round(seconds * 64); i++) g.tick(DT); };

function fieldGame(over = {}) {
  const level = openField();
  return new Game(level, levelCollision(level), { ...defaultGameConfig(), firstWave: null, waveGap: null, surprises: false, ...over });
}

const SPOTS = [[5, -30], [-5, -30], [5, -40], [-5, -40], [15, -30], [-15, -30]];
const place = (g, type, k) => {
  const t = g.placeTower(type, SPOTS[k][0], SPOTS[k][1]);
  assert(t.id, `place ${type}: ${t.reason}`);
  return t;
};
const cmd = (g, c) => applyCommand(g, sanitizeCommand(c));

test('auto-upgrade: off by default, so nothing upgrades by itself', () => {
  const g = fieldGame({ startMoney: 100000 });
  const t = place(g, 'squirter', 0);
  run(g, 10);
  assert(!g.autoUpgrade && t.def.id === 'squirter', `became ${t.def.id}`);
});

test('auto-upgrade: cheapest level first, one buy per AUTO_EVERY, spread over every tower', () => {
  const g = fieldGame({ startMoney: 100000 });
  const a = place(g, 'squirter', 0), b = place(g, 'squirter', 1), m = place(g, 'mortar', 2);
  cmd(g, { k: 'auto', on: true });
  const levels = () => [a, b, m].map((t) => t.def.level);
  const seen = [];
  let money = g.money;
  for (let i = 0; i < Math.round(3 * AUTO_EVERY * 64) + 2; i++) {
    g.tick(DT);
    for (const e of g.events) if (e.kind === 'upgraded') {
      assert(e.auto === true && Number.isFinite(e.x) && Number.isFinite(e.z), 'auto event shape');
      const t = g.towers.get(e.tower);
      assert(money - g.money === TOWER_FORMS[e.form].upgradeCost, 'paid the upgrade cost');
      money = g.money;
      seen.push({ tick: i, cost: TOWER_FORMS[e.form].upgradeCost, level: t.def.level });
    }
  }
  assert(seen.length === 3, `3 buys in 3 intervals, got ${seen.length}`);
  for (let k = 1; k < seen.length; k++) {
    assert(seen[k].tick - seen[k - 1].tick === Math.round(AUTO_EVERY * 64) + 1, `spacing ${seen[k].tick - seen[k - 1].tick}`);
  }
  // Each pick was the cheapest available at the time: nobody reaches level 3 while another tower sits at 1.
  run(g, 60);
  const lv = levels();
  assert(lv.every((l) => l >= 2), `all upgraded: ${lv}`);
});

test('auto-upgrade: never spends what it does not have, and stops when everything is maxed', () => {
  const g = fieldGame({ startMoney: 100000 });
  const t = place(g, 'squirter', 0);
  const firstCost = TOWER_FORMS[t.def.upgrades[0]].upgradeCost;
  g.money = firstCost - 1;
  cmd(g, { k: 'auto', on: true });
  run(g, 5);
  assert(t.def.level === 1 && g.money === firstCost - 1, 'waited for the money');
  g.money = firstCost;
  g.tick(DT);
  assert(t.def.level === 2 && g.money === 0, 'bought the moment it could');
  g.money = 1e6;
  run(g, 20);
  assert(t.def.upgrades.length === 0, `maxed: ${t.def.id}`);
  const left = g.money;
  run(g, 5);
  assert(g.money === left, 'no buys once maxed');
});

test('auto-upgrade: takes the first path unless the farmer picked one, then every tower like it follows', () => {
  const g = fieldGame({ startMoney: 100000 });
  const a = place(g, 'squirter', 0);
  cmd(g, { k: 'auto', on: true });
  run(g, 10);
  const choice = TOWER_FORMS.squirter3;
  assert(choice.upgrades.length === 2, 'squirter3 is a path choice');
  assert(TOWER_FORMS[a.def.id].root === 'squirter' && a.def.upgrades.length === 0, `a maxed: ${a.def.id}`);
  let f = a.def; while (f.from !== choice.id) f = TOWER_FORMS[f.from];
  assert(f.id === choice.upgrades[0], `default path is the first: went ${f.id}`);

  // Buying the other variant by hand teaches auto-upgrade.
  cmd(g, { k: 'auto', on: false });
  const b = place(g, 'squirter', 1);
  for (const id of ['squirter2', 'squirter3', choice.upgrades[1]]) assert(g.upgradeTower(b.id, id).ok, id);
  assert(g.autoPick.squirter3 === choice.upgrades[1], 'remembered');
  const c = place(g, 'squirter', 2);
  cmd(g, { k: 'auto', on: true });
  run(g, 10);
  f = c.def; while (f.from !== choice.id) f = TOWER_FORMS[f.from];
  assert(f.id === choice.upgrades[1], `followed the farmer's path: ${f.id}`);

  // Or set it directly.
  cmd(g, { k: 'auto', on: false });
  const d = place(g, 'squirter', 3);
  assert(cmd(g, { k: 'autopath', form: 'squirter3', pick: choice.upgrades[0] }).ok, 'autopath');
  cmd(g, { k: 'auto', on: true });
  run(g, 10);
  f = d.def; while (f.from !== choice.id) f = TOWER_FORMS[f.from];
  assert(f.id === choice.upgrades[0], `autopath set: ${f.id}`);
});

test('auto-upgrade: every tower type climbs its tree to the top', () => {
  const g = fieldGame({ startMoney: 1e7 });
  const towers = Object.keys(TOWER_TYPES).map((id, k) => place(g, id, k));
  cmd(g, { k: 'auto', on: true });
  run(g, 60);
  for (const t of towers) assert(t.def.upgrades.length === 0, `${t.def.root} stopped at ${t.def.id}`);
});

test('auto-upgrade: commands are validated, survive a restart and change the state hash', () => {
  for (const bad of [{ k: 'auto' }, { k: 'auto', on: 1 }, { k: 'autopath', form: 'squirter', pick: 'squirter2' },
    { k: 'autopath', form: 'squirter3', pick: 'mortar2' }, { k: 'autopath', form: '__proto__', pick: 'x' }, { k: 'autopath', form: 'nope', pick: 'gatling' }]) {
    assert(sanitizeCommand(bad) === null, `accepted ${JSON.stringify(bad)}`);
  }
  const g = fieldGame({ startMoney: 1000 });
  const h0 = stateHash(g);
  cmd(g, { k: 'auto', on: true });
  assert(stateHash(g) !== h0, 'hash covers the setting');
  cmd(g, { k: 'autopath', form: 'squirter3', pick: TOWER_FORMS.squirter3.upgrades[1] });
  cmd(g, { k: 'reset', seed: 7 });
  assert(g.autoUpgrade && g.autoPick.squirter3 === TOWER_FORMS.squirter3.upgrades[1], 'kept across restart');
});

test('auto-upgrade: two games fed the same commands stay identical through waves', () => {
  const play = () => {
    const g = fieldGame({ startMoney: 600, seed: 42 });
    place(g, 'squirter', 0); place(g, 'squirter', 1); place(g, 'mortar', 2);
    cmd(g, { k: 'auto', on: true });
    for (let w = 0; w < 6; w++) { cmd(g, { k: 'wave' }); run(g, 20); }
    return { hash: stateHash(g), levels: [...g.towers.values()].map((t) => t.def.id).join() };
  };
  const a = play(), b = play();
  assert(a.hash === b.hash && a.levels === b.levels, 'deterministic');
  assert(a.levels !== 'squirter,squirter,mortar', `bought something with wave income: ${a.levels}`);
});

test('auto-upgrade: the panel marks the card it will take', () => {
  const g = fieldGame({ startMoney: 100000 });
  const t = place(g, 'squirter', 0);
  for (const id of ['squirter2', 'squirter3']) g.upgradeTower(t.id, id);
  const pick = TOWER_FORMS.squirter3.upgrades[1];
  g.autoPick.squirter3 = pick;
  const m = upgradeModel(t, g.money, { on: true, next: g.autoNext(t.def) });
  assert(m.auto && m.options.filter((o) => o.autoPick).map((o) => o.id).join() === pick, 'marks the remembered path');
  assert(upgradeModel(t, g.money).options.every((o) => !o.autoPick), 'no mark without auto state');
});
