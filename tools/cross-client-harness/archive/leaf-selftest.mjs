/**
 * THE LEAF-REFRESH ROWS' OWN JUDGEMENTS, PINNED (`leafrows.mjs`).
 *
 * Each judge is run on a clean outcome and then broken one assertion at a time, so a judgement that
 * stops firing has its symptom here, where on a live estate it would have none. Pure: no rig, no
 * browser, no `names.mjs`.
 *
 *   bun archive/leaf-selftest.mjs
 */
import { rowGroupName, rowStem } from '../rowkit.mjs';
import { isGroupDebris } from '../debris.mjs';
import { commitSequence } from '../settlerows.mjs';
import {
  LEAF_ROWS,
  SETTLING_LINE,
  STRAY_NARRATION,
  cutDuringSubmit,
  ledgerNamesServer,
  refreshLandedOnce,
  refreshPremise,
  revokedLeafLeaves,
  sendsWaitForTheCommit,
  stageSurvivesReload,
  strayRemovals,
} from '../leafrows.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const allOk = (as) => as.length > 0 && as.every((a) => a.ok);
const failing = (as) => as.filter((a) => !a.ok).length;

const G = '11111111-2222-3333-4444-555555555555';
const nest = (s) => `[Nest] 1  - 11/16/2026, 10:00:00 AM     LOG [MessagingService] ${s}`;
const ACCEPT = (t, e) => nest(`[COMMIT][commit-${t}] ACCEPT group=${G} newEpoch=${e}`);
const DUP = (t, b) => nest(`[COMMIT][commit-${t}] DUPLICATE group=${G} device=d1 baseEpoch=${b} - already accepted, answered again`);
const MISMATCH = (t, b, a) => nest(`[COMMIT][commit-${t}] REJECT epoch_mismatch group=${G} baseEpoch=${b} activeEpoch=${a}`);

console.log('the table');
ok('three rows: -1, -2 and -4 (-3 was read by hand)', Object.keys(LEAF_ROWS).join() === 'LEAF-REFRESH-1,LEAF-REFRESH-2,LEAF-REFRESH-4');
ok('every row opens the two spare seats, owner first', Object.values(LEAF_ROWS).every((r) => r.devices.join() === 'W6,W7'));
ok('no row touches a seat another row or sitting owns (W1-W5)', Object.values(LEAF_ROWS).every((r) => r.devices.every((d) => /^W[678]$/.test(d))));
ok('only -1 has a side group, for its control', Object.entries(LEAF_ROWS).every(([k, r]) => !!r.side === (k === 'LEAF-REFRESH-1')));
ok('only -1 cuts the link', Object.entries(LEAF_ROWS).every(([k, r]) => r.cut === (k === 'LEAF-REFRESH-1')));
ok('only -4 revokes, and what it revokes is a seat it opens', LEAF_ROWS['LEAF-REFRESH-4'].revokes === 'W7' && !LEAF_ROWS['LEAF-REFRESH-1'].revokes && !LEAF_ROWS['LEAF-REFRESH-2'].revokes);

console.log('the group the rows mint is a throwaway name the sweeps may delete');
ok('LEAF-REFRESH-2 has the stem LEAF2', rowStem('LEAF-REFRESH-2') === 'LEAF2');
ok('a LEAF group name is on the debris allowlist', Object.keys(LEAF_ROWS).every((r) => isGroupDebris(rowGroupName(r))));
let refused = false;
try {
  rowStem('LEAF-OTHER-2');
} catch {
  refused = true;
}
ok('an id with another second word is not a row', refused);

console.log('the premise');
ok('an own-commit leaf can be armed', refreshPremise({ at: 1, epoch: 1, leaf: 'ab' }).length === 0);
ok('no entry cannot', refreshPremise(null).length === 1);
ok('an observation cannot', refreshPremise({ at: 1, epoch: 1, observed: true, leaf: 'ab' }).length === 1);
ok('an entry naming no leaf cannot', refreshPremise({ at: 1, epoch: 1 }).length === 1);

console.log('refreshLandedOnce');
const view = { activeEpoch: 4, commitEpochs: [1, 2, 3] };
const clean = commitSequence([ACCEPT('a', 4)]);
ok('one accepted refresh, one epoch, passes', allOk(refreshLandedOnce({ fromEpoch: 3, view, seq: clean })));
ok('a duplicate answer within the bound passes', allOk(refreshLandedOnce({ fromEpoch: 3, view, seq: commitSequence([ACCEPT('a', 4), DUP('b', 3)]) })));
ok('a duplicate beyond a bound of 0 fails (-2: the first request never left)', failing(refreshLandedOnce({ fromEpoch: 3, view, seq: commitSequence([ACCEPT('a', 4), DUP('b', 3)]), maxDuplicates: 0 })) === 1);
ok('two accepted commits fail', failing(refreshLandedOnce({ fromEpoch: 3, view: { activeEpoch: 5, commitEpochs: [3, 4] }, seq: commitSequence([ACCEPT('a', 4), ACCEPT('b', 5)]) })) >= 1);
ok('a refusal fails - a kept refresh is never rebuilt', failing(refreshLandedOnce({ fromEpoch: 3, view, seq: commitSequence([MISMATCH('a', 3, 4), ACCEPT('b', 4)]) })) === 1);
ok('no accepted commit fails', !allOk(refreshLandedOnce({ fromEpoch: 3, view: { activeEpoch: 3, commitEpochs: [1, 2] }, seq: [] })));

console.log('ledgerNamesServer');
const before = { at: 100, epoch: 3, leaf: 'aa' };
const armed = { at: 10, epoch: 3, leaf: 'aa' };
const after = { at: 5000, epoch: 4, leaf: 'bb' };
ok('a fresh refresh entry for the server epoch, a new leaf, passes', allOk(ledgerNamesServer({ before, armed, after, serverEpoch: 4 })));
ok('an entry for another epoch fails', failing(ledgerNamesServer({ before, armed, after: { ...after, epoch: 3 }, serverEpoch: 4 })) === 1);
ok('an observation fails', failing(ledgerNamesServer({ before, armed, after: { ...after, observed: true }, serverEpoch: 4 })) === 1);
ok('an entry still dated by the backdating fails', failing(ledgerNamesServer({ before, armed, after: { ...after, at: 10 }, serverEpoch: 4 })) === 1);
ok('the same leaf fails', failing(ledgerNamesServer({ before, armed, after: { ...after, leaf: 'aa' }, serverEpoch: 4 })) === 1);
ok('no entry fails', !allOk(ledgerNamesServer({ before, armed, after: null, serverEpoch: 4 })));

console.log('cutDuringSubmit (-1)');
const cutOk = { unknown: 'l', gatewayMs: 900, seqBefore: [], seqAfter: commitSequence([ACCEPT('a', 4)]), settled: 'l', heldRecords: [{}], unsentRecords: [{}, {}] };
ok('cut, kept, back with a 503 settlement, accepted after the return, passes', allOk(cutDuringSubmit(cutOk)));
ok('a decision before the settlement was let through fails (the request left)', failing(cutDuringSubmit({ ...cutOk, seqBefore: commitSequence([ACCEPT('a', 4)]) })) === 1);
ok('no unknown verdict fails', failing(cutDuringSubmit({ ...cutOk, unknown: null })) === 1);
ok('a gateway that never came back fails', failing(cutDuringSubmit({ ...cutOk, gatewayMs: null })) === 1);
ok('no held first request fails (the refresh never reached its POST)', failing(cutDuringSubmit({ ...cutOk, heldRecords: [] })) === 1);
ok('no 503 with the link up fails (the window was never open)', failing(cutDuringSubmit({ ...cutOk, unsentRecords: [] })) === 1);
ok('no accept after the return fails', failing(cutDuringSubmit({ ...cutOk, seqAfter: [] })) === 1);
ok('no accepted verdict fails', failing(cutDuringSubmit({ ...cutOk, settled: null })) === 1);

console.log('sendsWaitForTheCommit (-1)');
const wait = { controlReached: true, blockedShown: [0, 0], after: [1, 1, 1] };
ok('blocked while unknown, all once after, passes', allOk(sendsWaitForTheCommit(wait)));
ok('a send that leaked during the window fails', failing(sendsWaitForTheCommit({ ...wait, blockedShown: [0, 1] })) === 1);
ok('without the control the absence proves nothing', failing(sendsWaitForTheCommit({ ...wait, controlReached: false, blockedShown: null })) === 2);
ok('a text shown twice at the end fails', failing(sendsWaitForTheCommit({ ...wait, after: [1, 2, 1] })) === 1);
ok('a text never arriving fails', failing(sendsWaitForTheCommit({ ...wait, after: [] })) === 1);

console.log('stageSurvivesReload (-2)');
const stage = { holdRecords: [{}], seqBeforeReload: [], settlingLines: ['[COMMIT] settling 1 staged commit(s) by resubmission'], settled: 'l' };
ok('held, reloaded, settled from disk, passes', allOk(stageSurvivesReload(stage)));
ok('a decision before the reload fails (the request had left)', failing(stageSurvivesReload({ ...stage, seqBeforeReload: commitSequence([ACCEPT('a', 4)]) })) === 1);
ok('no settling line fails - the stage did not come from disk', failing(stageSurvivesReload({ ...stage, settlingLines: [] })) === 1);
ok('no accepted verdict fails', failing(stageSurvivesReload({ ...stage, settled: null })) === 1);
ok('the settling line parses', SETTLING_LINE.test('[COMMIT] settling 2 staged commit(s) by resubmission'));

console.log('strayRemovals and revokedLeafLeaves (-4)');
const S = (g, n) => `[STRAY] ${g}... ${n} revoked device(s) still hold a leaf - removing`;
const D = (g, e) => `[STRAY] ${g}... is now at epoch ${e} - the revoked leaves are gone from the tree`;
const lines = [
  '[STRAY] compared 2 tree(s): 2 roster(s) in one read, 0 refused, 0 not answered (nobody removed in them)',
  S('11111111', 1),
  D('11111111', 5),
  S('aaaaaaaa', 1),
  D('aaaaaaaa', 9),
  'noise',
];
const removals = strayRemovals(lines);
ok('two removals read, two finished', removals.started.length === 2 && removals.finished.length === 2);
ok('the summary line is narration the row forgives', STRAY_NARRATION.some((re) => re.test(lines[0])));
const revoke = {
  removals,
  groupShort: '11111111',
  deleted: { status: 200 },
  attempt: { status: 403, body: '{"code":"DEVICE_REVOKED"}' },
  refusalLines: ['x'],
  rowCommit: { deviceId: 'owner-dev', atEpoch: 4 },
  fromEpoch: 4,
  ownerDevice: 'owner-dev',
  serverEpoch: 5,
};
ok('one removal per group, the row group among them, refused from the revoked device, passes', allOk(revokedLeafLeaves(revoke)));
ok('two removals in one group fail', failing(revokedLeafLeaves({ ...revoke, removals: strayRemovals([...lines, S('aaaaaaaa', 1), D('aaaaaaaa', 10)]) })) === 1);
ok('a removal that never finished fails', failing(revokedLeafLeaves({ ...revoke, removals: strayRemovals([S('11111111', 1), D('11111111', 5), S('bbbbbbbb', 1)]) })) === 1);
ok('no removal in the row group fails', failing(revokedLeafLeaves({ ...revoke, removals: strayRemovals([S('aaaaaaaa', 1), D('aaaaaaaa', 9)]) })) >= 1);
ok('a commit that was not refused 403 fails', failing(revokedLeafLeaves({ ...revoke, attempt: { status: 400, body: 'DEVICE_REVOKED' } })) === 1);
ok('a 403 with another code fails', failing(revokedLeafLeaves({ ...revoke, attempt: { status: 403, body: '{"code":"NOT_A_MEMBER"}' } })) === 1);
ok('no gate line for the refusal fails', failing(revokedLeafLeaves({ ...revoke, refusalLines: [] })) === 1);
ok('a removal committed by another device fails', failing(revokedLeafLeaves({ ...revoke, rowCommit: { deviceId: 'peer-dev', atEpoch: 4 } })) === 1);
ok('a group that did not move fails', failing(revokedLeafLeaves({ ...revoke, serverEpoch: 4 })) === 1);
ok('a revocation that failed fails', failing(revokedLeafLeaves({ ...revoke, deleted: { status: null } })) >= 1);

if (failures) {
  console.error(`\n${failures} leaf-refresh assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
