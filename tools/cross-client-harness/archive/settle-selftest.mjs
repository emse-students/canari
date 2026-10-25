/**
 * THE SETTLEMENT ROWS' OWN JUDGEMENTS, PINNED (`settlerows.mjs`), AND THE FORGIVENESS OF WHAT THEIR
 * FAULTS PROVOKE (`rowkit.mjs` `provokedFailures` / `forgivingProvoked`).
 *
 * The gate's lines in order as `messaging.service.ts` writes them, then each row's question answered
 * on a clean settlement and broken one assertion at a time - so a judgement that stops firing has its
 * symptom here, where on a live estate it would have none. Pure: no rig, no browser, no `names.mjs`.
 *
 *   bun archive/settle-selftest.mjs
 */
import { forgivingProvoked, provokedFailures } from '../rowkit.mjs';
import { ignoringExpectedLog } from '../watch.mjs';
import {
  DUP3_SKIP,
  DUP7_ELSEWHERE,
  SEAT_CLAIM_OVERTAKEN_BODY,
  SETTLE_ROWS,
  INVITATION_FAILED,
  TOK_NARRATION,
  authLines,
  blockedHereOnly,
  commitSequence,
  decidedAfter,
  decryptsDuringHold,
  firedAtLeast,
  interveningOrder,
  nothingBefore,
  renewalFailedOwn,
  renewedOnceOwn,
  resubmissionLine,
  sessionSurvived,
  settleNarration,
  settledOnce,
} from '../settlerows.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const allOk = (as) => as.length > 0 && as.every((a) => a.ok);

const G = '11111111-2222-3333-4444-555555555555';
const nest = (s) => `[Nest] 1  - 10/25/2026, 10:00:00 AM     LOG [MessagingService] ${s}`;
const ACCEPT = (t, e) => nest(`[COMMIT][commit-${t}] ACCEPT group=${G} newEpoch=${e}`);
const DUP = (t, b) => nest(`[COMMIT][commit-${t}] DUPLICATE group=${G} device=d1 baseEpoch=${b} - already accepted, answered again`);
const MISMATCH = (t, b, a) => nest(`[COMMIT][commit-${t}] REJECT epoch_mismatch group=${G} baseEpoch=${b} activeEpoch=${a}`);

// ── the table ────────────────────────────────────────────────────────────────────────────────────
console.log('the table');
const rows = Object.entries(SETTLE_ROWS);
ok('every seat a row names is opened', rows.every(([, r]) => ['W1', r.subject, ...r.setup, ...(r.intervening ? [r.intervening.by, r.intervening.add ?? r.intervening.remove] : [])].every((d) => r.devices.includes(d))));
ok('W1 is always the committer, never its own subject', rows.every(([, r]) => r.devices[0] === 'W1' && r.subject !== 'W1'));
ok('a subject is never already in the group', rows.every(([, r]) => !r.setup.includes(r.subject)));
ok('DUP-2 commits on top with a member of the setup', SETTLE_ROWS['DUP-2'].setup.includes(SETTLE_ROWS['DUP-2'].intervening.by));
// AN INTERVENING ADD IS REFUSED AT THE ADD LOCK WHILE W1's ADD IS HELD (alpha.4) - that case is CC-1's.
ok('DUP-2 intervenes with a Remove of a setup member, never an Add', !SETTLE_ROWS['DUP-2'].intervening.add && SETTLE_ROWS['DUP-2'].setup.includes(SETTLE_ROWS['DUP-2'].intervening.remove));
ok('DUP-5 has W2 in BOTH groups, so a blocked send has a reader', SETTLE_ROWS['DUP-5'].setup.includes('W2') && SETTLE_ROWS['DUP-5'].side);
ok('DUP-6 has a side group for the decrypts', SETTLE_ROWS['DUP-6'].side === true);
ok('every cut row is a row that needs the gateway back', ['DUP-5', 'OFF-1', 'OFF-2', 'TOK-3'].every((k) => SETTLE_ROWS[k].cut) && !SETTLE_ROWS['DUP-1'].cut);
ok('TOK-3 waits past the 1 h access token', SETTLE_ROWS['TOK-3'].waitMinutes > 60);
ok('DUP-3 is absent and its SKIPPED reason names Q2', !SETTLE_ROWS['DUP-3'] && /Q2/.test(DUP3_SKIP));
ok('DUP-7 is absent and says where it is played', !SETTLE_ROWS['DUP-7'] && /new device|NEW device/i.test(DUP7_ELSEWHERE));
ok("the 409 body carries the code the client types by", SEAT_CLAIM_OVERTAKEN_BODY.code === 'SEAT_CLAIM_OVERTAKEN');

// ── the gate's decisions, in order ──────────────────────────────────────────────────────────────
console.log('commitSequence');
const seq1 = commitSequence([nest(`[COMMIT][commit-a] START group=${G}`), ACCEPT('a', 4), DUP('b', 3), 'foreign line']);
ok('ACCEPT then DUPLICATE, in order, START ignored', seq1.map((d) => d.kind).join() === 'ACCEPT,DUPLICATE' && seq1[0].newEpoch === 4);
ok('a REJECT keeps its reason', commitSequence([MISMATCH('c', 3, 4)])[0].reason === 'epoch_mismatch');

// ── the common core ────────────────────────────────────────────────────────────────────────────────
console.log('settledOnce');
const U2 = 'u2222222-aaaa';
const view = (over = {}) => ({
  activeEpoch: 4,
  commitEpochs: [0, 1, 2, 3],
  roster: ['u1', U2].map((userId) => ({ userId, awaitingAdmission: false })),
  seats: ['u1', U2].map((userId, i) => ({ userId, deviceId: `d${i}`, status: 'active', kicked: false })),
  ...over,
});
const s = (over = {}) => settledOnce({ fromEpoch: 3, view: view(), seq: commitSequence([ACCEPT('a', 4), DUP('a', 3)]), joined: [U2], ...over });
ok('one accept, one duplicate, epoch +1, joiner in -> all hold', allOk(s()));
ok('no duplicate where one is owed fails', !allOk(s({ seq: commitSequence([ACCEPT('a', 4)]) })));
ok('TWO accepts for one commit (rebuilt instead of kept) fails', !allOk(s({ seq: commitSequence([ACCEPT('a', 4), ACCEPT('b', 5)]), view: view({ activeEpoch: 5, commitEpochs: [0, 1, 2, 3, 4] }) })));
ok('a refusal of the kept commit fails', !allOk(s({ seq: commitSequence([ACCEPT('a', 4), MISMATCH('b', 3, 4), DUP('a', 3)]) })));
ok('the joiner without an active seat (no Welcome) fails', !allOk(s({ view: view({ seats: view().seats.filter((x) => x.userId !== U2) }) })));
ok('OFF-1: a duplicate where the first request never left fails', !allOk(s({ minDuplicates: 0, maxDuplicates: 0 })));
ok('OFF-1: one accept and no duplicate -> all hold', allOk(s({ seq: commitSequence([ACCEPT('a', 4)]), minDuplicates: 0, maxDuplicates: 0 })));
ok('an epoch that moved twice for one commit fails', !allOk(s({ view: view({ activeEpoch: 5 }) })));

// ── DUP-2 ────────────────────────────────────────────────────────────────────────────────────────
console.log('DUP-2 order');
ok("W4's accept, THEN W1's duplicate -> holds", allOk(interveningOrder({ fromEpoch: 3, seq: commitSequence([ACCEPT('a', 4), ACCEPT('w4', 5), DUP('a', 3)]) })));
ok("W1's duplicate BEFORE W4's commit (no intervening) fails", !allOk(interveningOrder({ fromEpoch: 3, seq: commitSequence([ACCEPT('a', 4), DUP('a', 3), ACCEPT('w4', 5)]) })));
ok("W4's commit never landed fails", !allOk(interveningOrder({ fromEpoch: 3, seq: commitSequence([ACCEPT('a', 4), DUP('a', 3)]) })));
const v2 = view({ activeEpoch: 5, commitEpochs: [0, 1, 2, 3, 4], roster: [...view().roster, { userId: 'u5', awaitingAdmission: false }], seats: [...view().seats, { userId: 'u5', deviceId: 'd5', status: 'active', kicked: false }] });
const v2r = view({ activeEpoch: 5, commitEpochs: [0, 1, 2, 3, 4] });
const dup2 = (over = {}) => settledOnce({ fromEpoch: 3, view: v2r, seq: commitSequence([ACCEPT('a', 4), ACCEPT('w4', 5), DUP('a', 3)]), accepts: 2, joined: [U2], removed: ['u5'], ...over });
ok('DUP-2 core: two accepts, a duplicate, the subject in and W5 removed -> all hold', allOk(dup2()));
ok('DUP-2: the removed user still on the roster fails', !allOk(dup2({ view: v2 })));
ok('DUP-2: a removed user keeping an active seat fails', !allOk(dup2({ view: view({ ...v2r, seats: [...v2r.seats, { userId: 'u5', deviceId: 'd5', status: 'active', kicked: false }] }) })));

// ── the later windows ──────────────────────────────────────────────────────────────────────────────
console.log('decided after / nothing before');
ok('a DUPLICATE after the return holds', decidedAfter('the return', commitSequence([DUP('a', 3)]), 'DUPLICATE').ok);
ok('nothing after the return fails', !decidedAfter('the return', [], 'DUPLICATE').ok);
ok('OFF-1: a decision before the return fails (the request left)', !nothingBefore('the return', commitSequence([ACCEPT('a', 4)])).ok);

// ── DUP-5 / DUP-6 ────────────────────────────────────────────────────────────────────────────────
console.log('DUP-5 blocked here only, DUP-6 decrypts during the hold');
ok('side delivered, blocked absent, settled after -> all hold', allOk(blockedHereOnly({ sideReceived: true, sideMs: 900, blockedShown: 0, settledAfter: true })));
ok('the blocked send shown on the peer fails', !allOk(blockedHereOnly({ sideReceived: true, sideMs: 900, blockedShown: 1, settledAfter: true })));
ok('no side delivery makes the absence meaningless, and fails', !allOk(blockedHereOnly({ sideReceived: false, sideMs: null, blockedShown: 0, settledAfter: true })));
ok('not settled at the reconnection fails', !allOk(blockedHereOnly({ sideReceived: true, sideMs: 900, blockedShown: 0, settledAfter: false })));
ok('shown inside the hold holds', allOk(decryptsDuringHold({ shownAt: 150, heldFrom: 100, heldUntil: 200 })));
ok('shown only after the hold ended fails', !allOk(decryptsDuringHold({ shownAt: 250, heldFrom: 100, heldUntil: 200 })));
ok('never shown fails', !allOk(decryptsDuringHold({ shownAt: null, heldFrom: 100, heldUntil: 200 })));

// ── TOK ──────────────────────────────────────────────────────────────────────────────────────────
console.log('TOK session');
ok('refreshed and signed in -> holds', allOk(sessionSurvived({ refreshes: 1, loggedOut: false })));
ok('logged out fails', !allOk(sessionSurvived({ refreshes: 1, loggedOut: true })));
ok('no refresh where one is owed fails', !allOk(sessionSurvived({ refreshes: 0, loggedOut: false })));

// ── the client's own lines ───────────────────────────────────────────────────────────────────────
console.log('narration');
const short = G.slice(0, 8);
ok('the resubmission line is the client\'s own sentence', resubmissionLine(G, 3, 'accepted') === `[COMMIT] ${short}... resubmission of the commit from epoch 3: accepted`);
const needles = settleNarration(G);
const hit = (line) => needles.some((n) => (typeof n === 'string' ? line.includes(n) : n.test(line)));
ok('the no-answer line of THIS group is forgiven', hit(`[COMMIT] ${short}... no answer to the commit from epoch 3 (TypeError: Failed to fetch) - resubmitting the same commit`));
ok('the settling banner is forgiven', hit('[COMMIT] settling 1 staged commit(s) by resubmission'));
ok("ANOTHER group's no-answer line is NOT", !hit('[COMMIT] 99999999... no answer to the commit from epoch 3 (x) - resubmitting the same commit'));
ok('a refusal clear failing is NOT narration', !hit(`[COMMIT] ${short}... could not clear the refused commit at 3: boom`));
ok('the owed Welcome DELIVERED for THIS group is forgiven', hit(`[COMMIT] ${short}... owed Welcome of an Add delivered to web-abc-def`));
ok('an owed Welcome NOT delivered stays dirt', !hit(`[COMMIT] ${short}... owed Welcome of an Add NOT delivered to web-abc-def - still owed: boom`));
ok("ANOTHER group's owed Welcome is NOT forgiven", !hit('[COMMIT] 99999999... owed Welcome of an Add delivered to web-abc-def'));

// ── what the faults provoked, forgiven one each ─────────────────────────────────────────────────
console.log('provoked failures');
const URL_ = 'https://dev.example/api/mls/commit';
const recs = [
  { rule: 0, mode: 'lose-answer', method: 'POST', url: URL_, done: 'failRequest' },
  { rule: 1, mode: 'status', method: 'POST', url: URL_, done: 'fulfillRequest', gave: 409 },
  { rule: 2, mode: 'hold', method: 'POST', url: URL_, done: 'continueRequest' },
  { rule: 3, mode: 'hold-answer', method: 'POST', url: URL_, answerError: 'Invalid InterceptionId.' },
  { rule: 4, mode: 'delay', method: 'POST', url: URL_, done: 'continueRequest' },
];
const prov = provokedFailures(recs);
ok('a lost answer, a fulfilled status and an abandoned hold are provoked; a release and a delay are not', prov.length === 3 && prov[0].status === null && prov[1].status === 409 && prov[2].status === null);
const rep = (over = {}) => ({ clean: false, errors: [], badHttp: [], exceptions: [], wsEvents: [], severe: [], unexplained: [], ...over });
let r = forgivingProvoked(
  rep({
    badHttp: [`POST ${URL_} -> net::ERR_CONNECTION_RESET`, `POST ${URL_} -> 409`],
    errors: [`Failed to load resource: the server responded with a status of 409 () <- POST ${URL_}`, `Failed to load resource: net::ERR_CONNECTION_RESET <- POST ${URL_}`],
  }),
  recs.slice(0, 2)
);
ok('the two provoked lines and their two echoes are forgiven -> clean', r.clean && r.badHttp.length === 0 && r.errors.length === 0);
ok('... and the record says what was forgiven', r.forgivenAsProvoked.provoked === 2 && r.forgivenAsProvoked.badHttp.length === 2 && r.forgivenAsProvoked.errors.length === 2);
r = forgivingProvoked(rep({ badHttp: [`POST ${URL_} -> 409`, `POST ${URL_} -> 409`] }), [recs[1]]);
ok('ONE provoked 409 forgives ONE line, never the second', !r.clean && r.badHttp.length === 1);
r = forgivingProvoked(rep({ badHttp: [`POST ${URL_} -> 503`] }), [recs[1]]);
ok('a provoked 409 does not forgive a 503', !r.clean && r.badHttp.length === 1);
r = forgivingProvoked(rep({ badHttp: [`POST https://dev.example/api/mls/other -> net::ERR_CONNECTION_RESET`] }), [recs[0]]);
ok('a provoked failure on one url does not forgive another url', !r.clean);
r = forgivingProvoked(rep({ badHttp: [`POST ${URL_} -> 409`] }), [{ ...recs[0] }]);
ok('a transport failure does not forgive a status', !r.clean);
r = forgivingProvoked(rep({ badHttp: [`POST ${URL_} -> 409`], unexplained: ['x'] }), [recs[1]]);
ok('an unexplained line still breaks the row', !r.clean);
r = forgivingProvoked(rep({ badHttp: [`POST ${URL_} -> 409`], wsEvents: ['12:00:00 closed'] }), [recs[1]]);
ok('a socket close still breaks the row (unless the row forgave the cut first)', !r.clean);
const untouched = rep({ clean: true });
ok('no provoked failure returns the report unchanged', forgivingProvoked(untouched, [recs[2]]) === untouched);
ok('firedAtLeast counts records', firedAtLeast('x', [1, 2], 2).ok && !firedAtLeast('x', [1], 2).ok);

// ── TOK: #2420's [AUTH] lines, row-scoped, and the 401 they follow ──────────────────────────────
console.log('TOK auth lines');
// Verbatim from #2420 (head df564fccc), with the page's stamp in front.
const A = {
  renewing: '[05:00:00.100] [AUTH] 401 on POST /api/mls/commit - renewing the token and sending the same request once more',
  meanwhile: '[05:00:00.100] [AUTH] POST /api/mls/commit: the token was renewed meanwhile - sent again with it',
  ok200: '[05:00:00.300] [AUTH] 200 on POST /api/mls/commit after the token renewal',
  failed: '[05:00:00.300] [AUTH] token renewal failed after a 401 on POST /api/mls/commit - TransportFailureError: request got no answer: TypeError: Failed to fetch - the request did nothing: DeliveryRenewalFailedError',
  abandoned: '[05:00:00.300] [AUTH] token renewal abandoned at the request deadline after a 401 on POST /api/mls/commit - TimeoutError: x - the request did nothing: DeliveryRenewalFailedError',
  refusedOnce: '[05:00:00.300] [AUTH] 401 on POST /api/mls/commit with a token already refused once renewed - not renewed again: DeliveryRefusedRenewedTokenError',
  refusedAgain: '[05:00:00.300] [AUTH] 401 again on POST /api/mls/commit with a renewed token - DeliveryRefusedRenewedTokenError; that token is not renewed again',
  account: '[05:00:00.300] [AUTH] POST /api/mls/commit was refused for one account and the token now names another - not sent again',
  body: '[05:00:00.300] [AUTH] the 401 body of POST /api/mls/commit could not be released: TypeError: x',
};
const al = authLines(Object.values(A));
ok('each [AUTH] shape lands in exactly its own key', Object.values(al).every((v) => v.length === 1) && al.renewalFailed[0] === A.failed && al.renewalAbandoned[0] === A.abandoned && al.refusedRenewedAgain[0] === A.refusedAgain);
ok('control: a 401 on ANOTHER request is not the commit renewal', authLines([A.renewing.replace('/api/mls/commit', '/api/mls/messages/ack')]).renewing.length === 0);
ok('the 201 the commit gate answers on ACCEPT is the success (alpha.4 TOK-1)', authLines([A.ok200.replace('200', '201')]).okAfterRenewal.length === 1);
ok('control: a 409 after the renewal is not a success', authLines([A.ok200.replace('200', '409')]).okAfterRenewal.length === 0);
ok('control: a reworded success is not matched', authLines([A.ok200.replace('after the token renewal', 'after renewal')]).okAfterRenewal.length === 0);

console.log('TOK-1 judge');
const one = (over = {}) => renewedOnceOwn({ auth: authLines([A.renewing, A.ok200]), fired401: 1, commitPosts: 2, ...over });
ok('one 401, one renewal, the same request once more, a 200 -> all hold', allOk(one()));
ok('control: no renewal line (the commit dropped in silence) FAILS', !allOk(one({ auth: authLines([A.ok200]) })));
ok('control: no 200 after the renewal FAILS', !allOk(one({ auth: authLines([A.renewing]) })));
ok('control: a third commit POST FAILS', !allOk(one({ commitPosts: 3 })));
ok('control: a second 401 FAILS', !allOk(one({ fired401: 2 })));
ok('control: any [AUTH] warn FAILS', !allOk(one({ auth: authLines([A.renewing, A.ok200, A.refusedAgain]) })));

console.log('TOK-2 judge');
const two = (over = {}) =>
  renewalFailedOwn({ auth: authLines([A.renewing, A.failed]), fired401: 1, commitPosts: 1, gestureFailed: true, unknownLines: 0, epochBefore: 2, epochAfter: 2, accepts: 0, subjectAdded: false, ...over });
ok('renewal failed typed, nothing resent, cleared, nobody added -> all hold', allOk(two()));
ok('control: the 1.4.0 shape (kept as unknown, settled by the next send) FAILS', !allOk(two({ unknownLines: 2, epochAfter: 3, accepts: 1, subjectAdded: true })));
ok('control: a renewal ABANDONED at the deadline is not this row', !allOk(two({ auth: authLines([A.renewing, A.abandoned]) })));
ok('control: a gesture that reported success FAILS', !allOk(two({ gestureFailed: false })));
ok('control: the commit sent again FAILS', !allOk(two({ commitPosts: 2 })));

console.log('TOK narration and the 401');
const narrated = (row, line) => ignoringExpectedLog(rep({ unexplained: [`log: ${line}`], warnings: [] }), TOK_NARRATION[row]).unexplained.length === 0;
ok("TOK-1 forgives its renewal and its 200", narrated('TOK-1', A.renewing) && narrated('TOK-1', A.ok200));
ok('control: TOK-1 does NOT forgive a failed renewal', !narrated('TOK-1', A.failed));
ok('TOK-2 forgives its renewal and its failure, at warn level too', narrated('TOK-2', A.renewing) && ignoringExpectedLog(rep({ unexplained: [], warnings: [A.failed] }), TOK_NARRATION['TOK-2']).warnings.length === 0);
ok('control: no TOK row forgives a renewed token refused again', !narrated('TOK-1', A.refusedAgain) && !narrated('TOK-2', A.refusedAgain));
// Verbatim from TOK-2 on alpha.4, stamps included.
const FAILED_ADD = {
  sync: '[17:26:08.277] [SYNC] processBulkAddition failed: DeliveryRenewalFailedError: POST /api/mls/commit answered 401 and the token renewal failed (TransportFailureError: request got no answer: TypeError: Failed to fetch) - the request did nothing',
  bulk: '[17:26:08.276] Bulk invite error: DeliveryRenewalFailedError: POST /api/mls/commit answered 401 and the token renewal failed (TransportFailureError: request got no answer: TypeError: Failed to fetch) - the request did nothing',
  wsDown: '[17:26:08.118] [A] ws-',
  outcome: '[17:26:08.279] [GROUP] an invitation added nobody (failed)',
};
ok("the app's failed-Add verdict is what TOK-2 reads, never the click", INVITATION_FAILED.test(FAILED_ADD.outcome) && !INVITATION_FAILED.test('[17:26:08.279] [GROUP] an invitation added nobody (outcome-unknown)'));
ok('TOK-2 forgives its failed Add, the error-level line included', narrated('TOK-2', FAILED_ADD.bulk) && narrated('TOK-2', FAILED_ADD.wsDown) && ignoringExpectedLog(rep({ errors: [FAILED_ADD.sync], unexplained: [], warnings: [] }), TOK_NARRATION['TOK-2']).errors.length === 0);
ok('control: TOK-1 forgives none of it', !narrated('TOK-1', FAILED_ADD.bulk) && !narrated('TOK-1', FAILED_ADD.wsDown));
ok('control: an Add failed for ANOTHER reason stays dirt on TOK-2', !narrated('TOK-2', FAILED_ADD.bulk.replace('DeliveryRenewalFailedError: POST /api/mls/commit answered 401 and the token renewal failed', 'ApiRefusalError: boom')));
ok('control: the narration is the TOK rows\' only (no other settle row names it)', Object.keys(TOK_NARRATION).join() === 'TOK-1,TOK-2');
const r401 = { rule: 0, mode: 'status-unsent', method: 'POST', url: URL_, done: 'fulfillRequest', gave: 401 };
r = forgivingProvoked(rep({ badHttp: [`POST ${URL_} -> 401`], errors: [`Failed to load resource: the server responded with a status of 401 () <- POST ${URL_}`.replace(' <- POST ', ' ')] }), [r401]);
ok("the row's own 401 is forgiven by its fault record (one line, one echo)", r.badHttp.length === 0 && r.forgivenAsProvoked.badHttp.length === 1);
r = forgivingProvoked(rep({ badHttp: [`POST ${URL_} -> 401`, `POST ${URL_} -> 401`] }), [r401]);
ok('control: a SECOND 401 on the commit stays dirt', !r.clean && r.badHttp.length === 1);
r = forgivingProvoked(rep({ badHttp: ['POST https://dev.example/api/mls/messages/ack -> 401'] }), [r401]);
ok('control: a 401 on another delivery request stays dirt', !r.clean && r.badHttp.length === 1);

if (failures) {
  console.error(`\n${failures} settlement assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
