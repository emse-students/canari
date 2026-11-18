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
import { ignoringExpectedLog, ignoringExpectedRefusal } from '../watch.mjs';
import {
  LEAF_REVOKED_REFUSALS,
  LEAF_REVOKED_WIPE_NARRATION,
  LEAF_ROWS,
  LEAF_ROW_NARRATION,
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
let refusedFold = false;
try {
  rowStem('FLOOR-REFRESH-2');
} catch {
  refusedFold = true;
}
ok('the REFRESH word is folded for LEAF only', refusedFold);

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

console.log('the narration: each sentence read on 2026-11-16 is forgiven at its own level, and only its happy spelling');
const rep = (unexplained, extra = {}) => ({ errors: [], warnings: [], unexplained, badHttp: [], exceptions: [], severe: [], wsEvents: [], ...extra });
const flow = [
  'debug: [03:07:50.000] [overlayStack] register Modal#3, depth 2',
  'debug: [03:07:50.000] [historyOverlay] a navigation closes 1 open overlay(s)',
  'debug: [03:07:50.000] [chat.entry] short thread: asking for older history (window 0)',
  'debug: [03:07:50.000] [ChatArea] older-history load retired by a conversation switch',
  'debug: [03:49:46.333] [ChatArea] peer scrollback answer (asked) retired by a conversation switch',
  'debug: [03:07:50.000] [keyboardViewport] baseline 917 -> 917 (settled)',
  'debug: [03:55:24.897] [TRUST] KeyPackage for f7a9bb80:web-f7a9bb80…-mvph014o-yj6l vetted: pinned',
  'debug: [03:07:50.000] [NICKNAME] 30 salon placement(s) changed',
  'info: [03:07:50.000] [NICKNAME] 2 nickname(s) of 1 conversation(s) restated for the notifications',
  'info: [03:07:50.000] [CHAT_VIEW] 7961b78c entry settled: pinned=true isNearBottom=true newestVisible=false rows=0 fromBottom=0',
  'info: [03:07:50.000] [GRAINE] the history of community 17cc181b is not asked: no other member, and none of our other devices on its key group is online to receive the request',
  'info: [03:07:50.000] [GRAINE] the history of community f6220e7e waits for a device: 2 member(s) answered "I hold nothing" from every device online, and each has another device on the key group, offline - asked at the next start',
  'log: [03:07:50.000] [JOIN_PUSH] 7961b78c... join push -> f7a9bb80…:web-f7a9bb80…-mvph014o-yj6l (addressable when its Welcome was answered)',
  'log: [03:07:50.000] [LEDGER] opened the ledgers the MLS state carries for f7a9bb80... - 38 key(s)',
  'log: [03:07:50.000] [PENDING] web-c71e1a5b…-mwigbyf0-0lx7 already in tree for 7961b78c… - invitation fulfilled, vouching',
  "debug: [05:46:26.107] [Pending] c8c28876... is being created by this device - its 13 row(s) are left to the creation's own Add; any row it does not answer waits for the next sweep",
  "debug: [05:46:26.118] [Discovery] c8c28876... is being created by this device - its row is the creation's to write",
  'log: [03:07:50.000] [NOTIF] Inbound in 899e4e12… while the window is in front but idle (no gesture for 120 s) - asking.',
  'log: [03:07:50.000] [NOTIF] Not raised for 899e4e12… - permission is "default"; asking.',
  'log: [03:45:23.793] [PENDING] Group 19bbc4ba…: lock held by another device - skip, its asks stay as shown',
  'log: [03:29:46.318] [QUEUE] delivery b8258a4e... arrived twice - the pull listed a row the socket had already handed in, before this device had sent its acknowledgement - the ordinary crossing, and that acknowledgement covers it; not decrypting it again.',
  'debug: [03:27:46.877] [GRAINE] not answering c71e1a5b…\'s request 8fc8590d… in community f6220e7e: it names tauri-f7a9bb80…-mwhxtiln-rdtg, not this device - the requester saw it offline or outside the key group\'s tree',
];
ok('every observed flow line is forgiven', ignoringExpectedLog(rep(flow), LEAF_ROW_NARRATION).unexplained.length === 0);
ok('a placeholder written for a group being created stays dirt', ignoringExpectedLog(rep(['info: [05:46:26.118] [DISCOVERY] Placeholder c8c28876... created.']), LEAF_ROW_NARRATION).unexplained.length === 1);
ok('at the wrong level it is dirt', ignoringExpectedLog(rep(['warn: [03:07:50.000] [JOIN_PUSH] 7961b78c... join push -> f7a9bb80…:web-x (addressable when its Welcome was answered)']), LEAF_ROW_NARRATION).unexplained.length === 1);
ok('a push that was NOT DELIVERED stays dirt', ignoringExpectedLog(rep(['log: [03:07:50.000] [JOIN_PUSH] 7961b78c... NOT DELIVERED to f7a9bb80…:web-x - the server answered its Welcome offline']), LEAF_ROW_NARRATION).unexplained.length === 1);
ok('a vouching of anything but "already in tree" stays dirt', ignoringExpectedLog(rep(['log: [03:07:50.000] [PENDING] web-x recovery request failed: 500']), LEAF_ROW_NARRATION).unexplained.length === 1);
ok('a live frame the SERVER published twice stays dirt', ignoringExpectedLog(rep(['log: [03:07:50.000] [QUEUE] delivery b8258a4e... arrived twice - THE SERVER PUBLISHED THE SAME ROW TWICE']), LEAF_ROW_NARRATION).unexplained.length === 1);
const wipe = [
  'log: [03:07:50.000] [A] clear',
  'log: [03:07:50.000] [A] ws-',
  'log: [03:07:50.000] [COMPOSER] signed out: staging of 0, replies of 0 and drafts of 3 conversation(s) forgotten',
  'log: [03:07:50.000] [FORM-DRAFT-COPY] store closed: the database is being deleted',
  'log: [03:07:50.000] [LOCAL-COPIES] no key in hand - copies closed',
  'log: [03:07:50.000] [PEER-NAMES] no key in hand - directory closed',
  'log: [03:07:50.000] [PUBLISH-QUEUE] stopped',
  'info: [03:07:50.000] [TAB-COMMIT] store closed: the database is being deleted',
  'info: [03:07:50.000] [TAB-COMMIT] drain (this tab is unavailable)',
  'debug: [03:07:50.000] [AvatarUrl] avatar token cleared - avatar URLs unsigned',
  'debug: [03:07:50.000] [backToOrigin] entry ab12N replaced: origin kept (/posts)',
];
ok("the revoked seat's wipe steps are forgiven", ignoringExpectedLog(rep(wipe), LEAF_REVOKED_WIPE_NARRATION).unexplained.length === 0);
ok('a wipe that SURVIVED stays dirt', ignoringExpectedLog(rep(['error: [RESET] the database SURVIVED the wipe']), LEAF_REVOKED_WIPE_NARRATION).unexplained.length === 1);
ok('the wipe lines are not forgiven to a seat given only the flow list', ignoringExpectedLog(rep(wipe), LEAF_ROW_NARRATION).unexplained.length === wipe.length);
const revokedEcho = { errors: ['Failed to load resource: the server responded with a status of 403 () <- POST https://dev.example/api/mls/commit'], badHttp: ['POST https://dev.example/api/mls/commit -> 403'] };
ok("the revoked commit's 403 is forgiven on -4's revoked seat", ignoringExpectedRefusal(rep([], revokedEcho), LEAF_REVOKED_REFUSALS).clean);
ok('the same 403 on another route stays a finding', !ignoringExpectedRefusal(rep([], { ...revokedEcho, badHttp: ['POST https://dev.example/api/mls/other -> 403'] }), LEAF_REVOKED_REFUSALS).clean);

if (failures) {
  console.error(`\n${failures} leaf-refresh assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
