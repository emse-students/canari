/**
 * THE FLOOR ROWS' OWN JUDGEMENTS AND THE VERDICT COMPOSITION EVERY 1.4.1 ROW SHARES, PINNED.
 *
 * `rowkit.mjs` decides how a row's own assertions, the invariant of section 4.0 and an armed fault
 * become ONE verdict; `floorrows.mjs` decides FLOOR-1..3's own questions. Both are pure, so this runs
 * on a checkout with no rig, no browser and no `names.mjs`. A clean case first, then each assertion
 * broken on its own - a rule that stops firing has its symptom here, where on a live row it has none.
 *
 *   bun archive/floor-selftest.mjs
 */
import { FLOOR1_BOUND_MS, FLOOR_ROWS, floor1Own, floor2Own, floor3Premise } from '../floorrows.mjs';
import { ROW_GROUPS, commitsSince, composeVerdict, rowGroupName, rowMessageMark, rowStem } from '../rowkit.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const allOk = (as) => as.length > 0 && as.every((a) => a.ok);
const failed = (as) => as.filter((a) => !a.ok).map((a) => a.what);

// ── rowkit: names ────────────────────────────────────────────────────────────────────────────
console.log('rowkit names');
ok('FLOOR-2 stems to FLOOR2', rowStem('FLOOR-2') === 'FLOOR2');
ok('a two-digit row keeps its number', rowStem('DUP-12') === 'DUP12');
ok('a row of another campaign is refused', throws(() => rowStem('GRP-3')));
ok('a bare prefix is refused', throws(() => rowStem('FLOOR')));
ok('a lower-case id is refused', throws(() => rowStem('floor-1')));
ok('every group of section 4.2 is a known prefix', ['FLOOR', 'CC', 'DUP', 'OFF', 'KILL', 'GAP', 'RM', 'ADM', 'DEV', 'BIG', 'TOK', 'NET'].every((g) => ROW_GROUPS.includes(g)));
ok('a minted group name starts with its stem and a dash', /^FLOOR2-[0-9a-z]+$/.test(rowGroupName('FLOOR-2')));
ok('two mints in one process differ', rowGroupName('CC-1') !== rowGroupName('CC-1'));
ok('a message marker is never a group shape', !/^(FLOOR|CC)\d+-/.test(rowMessageMark('FLOOR-1', 'A')) && !/^CC\d+-/.test(rowMessageMark('CC-3', 'B')));
ok('a message marker names its row and tag', rowMessageMark('FLOOR-1', 'A').startsWith('MFL1A-') && rowMessageMark('CC-3', 'B').startsWith('MCC3B-'));

// ── rowkit: commits ──────────────────────────────────────────────────────────────────────────
console.log('rowkit commitsSince');
ok('the commits at or past fromEpoch, sorted', commitsSince([3, 0, 1, 2], 2).join() === '2,3');
ok('none moved is empty', commitsSince([0, 1], 2).length === 0);
ok('a missing log is empty, not a throw', commitsSince(undefined, 0).length === 0);

// ── rowkit: composition ──────────────────────────────────────────────────────────────────────
console.log('rowkit composeVerdict');
const cleanInv = { ok: true, passes: [{ pass: 'after the action', ok: true, failures: [], approximations: [] }] };
const dirtyInv = { ok: false, passes: [{ pass: 'after a reload of every web client', ok: false, failures: [{ invariant: 3, what: 'W2: m0 x2' }], approximations: [] }] };
const good = [{ what: 'one commit', ok: true }];
ok('own and invariant clean -> PASS', composeVerdict({ own: good, invariant: cleanInv }).verdict === 'PASS');
ok('an own assertion fails -> FAIL, named', (() => {
  const v = composeVerdict({ own: [{ what: 'one commit', ok: false }], invariant: cleanInv });
  return v.verdict === 'FAIL' && v.failures.includes('one commit');
})());
ok('an invariant fails -> FAIL, with its number and pass', (() => {
  const v = composeVerdict({ own: good, invariant: dirtyInv });
  return v.verdict === 'FAIL' && v.failures.some((f) => f.startsWith('invariant 3 (after a reload'));
})());
ok('a missing invariant is a FAIL, never a PASS', composeVerdict({ own: good, invariant: null }).verdict === 'FAIL');
const unsettledInv = { ok: false, passes: [cleanInv.passes[0], { pass: 'after a reload of every web client', ok: false, failures: [], approximations: [], unsettled: 'the group never settled after the reload' }] };
ok('a reload pass that never settled -> INCONCLUSIVE with the reason, never a PASS or a FAIL', (() => {
  const v = composeVerdict({ own: good, invariant: unsettledInv });
  return v.verdict === 'INCONCLUSIVE' && v.failures.some((f) => f.includes('never settled'));
})());
ok('... and a premise missing still wins: INVALID', composeVerdict({ own: good, invariant: unsettledInv, premise: ['no group'] }).verdict === 'INVALID');
ok('nothing asserted -> INVALID', composeVerdict({}).verdict === 'INVALID');
ok('a premise missing -> INVALID, even over clean assertions', composeVerdict({ own: good, invariant: cleanInv, premise: ['W4 never listed'] }).verdict === 'INVALID');
ok('a premise outranks a fault that never fired', composeVerdict({ own: good, invariant: cleanInv, premise: ['x'], vacuousFaults: [{ rule: 0, fault: 'hold' }] }).verdict === 'INVALID');
ok('a fault that never fired -> VACUOUS, even over clean assertions', composeVerdict({ own: good, invariant: cleanInv, vacuousFaults: [{ rule: 0, fault: 'hold' }] }).verdict === 'VACUOUS');
ok('VACUOUS outranks FAIL: the case the row exists for did not happen', composeVerdict({ own: [{ what: 'x', ok: false }], invariant: cleanInv, vacuousFaults: [{ rule: 1, fault: 'lose-answer' }] }).verdict === 'VACUOUS');

// ── floorrows: the table ─────────────────────────────────────────────────────────────────────
console.log('FLOOR table');
ok('FLOOR-1 is W1 W2, unattended', FLOOR_ROWS['FLOOR-1'].devices.join() === 'W1,W2' && FLOOR_ROWS['FLOOR-1'].class === 'U');
ok('FLOOR-2 is W1 W2 W4 W5, unattended', FLOOR_ROWS['FLOOR-2'].devices.join() === 'W1,W2,W4,W5' && FLOOR_ROWS['FLOOR-2'].class === 'U');
ok('FLOOR-3 adds A1 and I1, bench', ['A1', 'I1'].every((p) => FLOOR_ROWS['FLOOR-3'].devices.includes(p)) && FLOOR_ROWS['FLOOR-3'].class === 'B');
ok('FLOOR-3 keeps the four browsers in play', ['W1', 'W2', 'W4', 'W5'].every((d) => FLOOR_ROWS['FLOOR-3'].devices.includes(d)));

// ── FLOOR-1 ──────────────────────────────────────────────────────────────────────────────────
console.log('FLOOR-1 own');
const leg = (from, to, over = {}) => ({ from, to, marker: `M${from}`, arrivalMs: 400, receiver: { count: 1, own: false }, sender: { count: 1, own: true }, ...over });
const legs = () => [leg('W1', 'W2'), leg('W2', 'W1')];
const reloaded = () => [
  { device: 'W1', marker: 'MW1', count: 1 },
  { device: 'W1', marker: 'MW2', count: 1 },
  { device: 'W2', marker: 'MW1', count: 1 },
  { device: 'W2', marker: 'MW2', count: 1 },
];
ok('both ways, fast, once, right side, once after reload -> all hold', allOk(floor1Own(legs(), reloaded())));
ok('at the bound is late (< 2 s, strictly)', !allOk(floor1Own([leg('W1', 'W2', { arrivalMs: FLOOR1_BOUND_MS }), leg('W2', 'W1')], reloaded())));
ok('never arrived fails, and says never', failed(floor1Own([leg('W1', 'W2', { arrivalMs: null }), leg('W2', 'W1')], reloaded())).some((w) => w.includes('never')));
ok('two copies on the receiver fails', !allOk(floor1Own([leg('W1', 'W2', { receiver: { count: 2, own: false } }), leg('W2', 'W1')], reloaded())));
ok('the receiver showing it as its OWN fails (wrong author)', !allOk(floor1Own([leg('W1', 'W2', { receiver: { count: 1, own: true } }), leg('W2', 'W1')], reloaded())));
ok('the sender showing it as another\'s fails', !allOk(floor1Own([leg('W1', 'W2', { sender: { count: 1, own: false } }), leg('W2', 'W1')], reloaded())));
ok('one direction only fails', !allOk(floor1Own([leg('W1', 'W2')], reloaded())));
ok('a duplicate after the reload fails', !allOk(floor1Own(legs(), [...reloaded().slice(1), { device: 'W1', marker: 'MW1', count: 2 }])));
ok('no re-count after the reload fails', !allOk(floor1Own(legs(), [])));

// ── FLOOR-2 ──────────────────────────────────────────────────────────────────────────────────
console.log('FLOOR-2 own');
const U = ['u1', 'u2', 'u4', 'u5'];
const D = ['d1', 'd2', 'd4', 'd5'];
const view = (over = {}) => ({
  activeEpoch: 2,
  commitEpochs: [0, 1],
  roster: U.map((userId) => ({ userId, awaitingAdmission: false })),
  seats: D.map((deviceId, i) => ({ userId: U[i], deviceId, status: 'active', kicked: false })),
  ...over,
});
const f2 = (v, over = {}) => floor2Own({ fromEpoch: 1, view: v, expectUsers: U, inPlayDeviceIds: D, ...over });
ok('one bulk commit, four users in, every seat active -> all hold', allOk(f2(view())));
ok('one Add per member (three commits) fails', !allOk(f2(view({ activeEpoch: 4, commitEpochs: [0, 1, 2, 3] }))));
ok('three commits fail on the commit count, named', failed(f2(view({ activeEpoch: 4, commitEpochs: [0, 1, 2, 3] }))).some((w) => w.startsWith('ONE commit')));
ok('no commit at all fails', !allOk(f2(view({ activeEpoch: 1, commitEpochs: [0] }))));
ok('a user missing from the roster fails', !allOk(f2(view({ roster: view().roster.slice(0, 3) }))));
ok('a user still awaiting admission fails', !allOk(f2(view({ roster: view().roster.map((r, i) => (i === 3 ? { ...r, awaitingAdmission: true } : r)) }))));
ok('a pending seat fails', !allOk(f2(view({ seats: view().seats.map((s, i) => (i === 2 ? { ...s, status: 'pending' } : s)) }))));
ok('a kicked seat fails', !allOk(f2(view({ seats: view().seats.map((s, i) => (i === 1 ? { ...s, kicked: true } : s)) }))));
ok('an in-play device with no seat fails', !allOk(f2(view({ seats: view().seats.slice(0, 3) }))));
ok('no seats at all fails', !allOk(f2(view({ seats: [] }), { inPlayDeviceIds: [] })));
ok('user and device ids compare case-blind', allOk(f2(view(), { expectUsers: U.map((u) => u.toUpperCase()), inPlayDeviceIds: D.map((d) => d.toUpperCase()) })));

// ── FLOOR-3 ──────────────────────────────────────────────────────────────────────────────────
console.log('FLOOR-3 premise');
ok('both phones in play -> nothing missing', floor3Premise(['A1', 'I1'], ['W1', 'A1', 'I1']).length === 0);
ok('a phone absent -> named', floor3Premise(['A1', 'I1'], ['W1', 'A1']).join() === 'I1 was not in play as a member');

if (failures) {
  console.error(`\n${failures} FLOOR / rowkit assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
