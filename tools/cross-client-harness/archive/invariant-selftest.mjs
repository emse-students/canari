/**
 * THE FIVE INVARIANTS EVERY MLS ROW ASSERTS, PINNED (R8, `invariantverdict.mjs`).
 *
 * One clean observation, then each invariant broken on its own - so a rule that stops firing has a
 * symptom here, where on a live window it would have none. And the approximations: a reading the
 * rig cannot take must be SAID, never read as a pass.
 *
 *   bun archive/invariant-selftest.mjs
 */
import { FORBIDDEN, behindServer, forbiddenIn, forgiveProvoked5xx, invariantVerdict, movedUnderJudge, settleDecision, settledRounds } from '../invariantverdict.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

const G = '11111111-2222-3333-4444-555555555555';
const OWNER = 'u-owner-0001';
const PEER = 'u-peer-00002';

/** A clean world: W1 (owner) and W2 (peer) at epoch 9, the row moved 7 -> 9, two messages from W1. */
function world() {
  const recv = (own) => [
    { marker: 'm0', count: 1, own, authorId: own ? null : OWNER, position: 10 },
    { marker: 'm1', count: 1, own, authorId: own ? null : OWNER, position: 11 },
  ];
  return {
    group: G,
    fromEpoch: 7,
    clients: [
      { device: 'W1', userId: OWNER, deviceId: 'd1', member: true, epochs: { [G]: 9 }, loggedOut: false, lines: ['[MLS] fine'], rowWatched: true, http5xx: [], received: recv(true) },
      { device: 'W2', userId: PEER, deviceId: 'd2', member: true, epochs: { [G]: 9 }, loggedOut: false, lines: [], rowWatched: true, http5xx: [], received: recv(false) },
    ],
    server: {
      activeEpoch: 9,
      commitEpochs: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      roster: [
        { userId: OWNER, awaitingAdmission: false },
        { userId: PEER, awaitingAdmission: false },
      ],
      seats: [
        { userId: OWNER, deviceId: 'd1', status: 'active', kicked: false },
        { userId: PEER, deviceId: 'd2', status: 'active', kicked: false },
      ],
      lines: ['[Nest] LOG [COMMIT] accepted'],
    },
    message: { markers: ['m0', 'm1'], authorId: OWNER },
  };
}
const failsOn = (v, n, re) => v.failures.some((f) => f.invariant === n && re.test(f.what));

// ── the clean world ─────────────────────────────────────────────────────────────────────────────
const clean = invariantVerdict(world());
ok('a clean world passes', clean.ok);
ok('and SAYS what it could not observe: the fingerprint, the stage, the leaves', [1, 2, 5].every((n) => clean.approximations.some((a) => a.invariant === n)));
const direct = world();
for (const c of direct.clients) Object.assign(c, { fingerprint: 'fp9', pendingSubmission: false, leafUsers: [OWNER, PEER] });
const directV = invariantVerdict(direct);
ok('a collector that reads the direct values leaves no approximation', directV.ok && directV.approximations.length === 0);

// ── 1. one tree ─────────────────────────────────────────────────────────────────────────────────
let w = world();
w.clients[1].epochs[G] = 8;
ok('1: a member one epoch behind fails', failsOn(invariantVerdict(w), 1, /disagree on the epoch/));
w = world();
w.server.activeEpoch = 10;
w.server.commitEpochs.push(9);
ok('1: devices agreeing with each other but not with the server fail', failsOn(invariantVerdict(w), 1, /the server at 10/));
w = world();
w.clients[0].epochs = null;
w.clients[0].epochsWhy = 'no hook';
ok('1: an unreadable epoch is a failure, never "agrees"', failsOn(invariantVerdict(w), 1, /unobservable/));
w = world();
delete w.clients[1].epochs[G];
ok('1: a member holding no state for the group fails', failsOn(invariantVerdict(w), 1, /holds no state/));
w = world();
for (const c of w.clients) c.fingerprint = c.device === 'W1' ? 'aaaa' : 'bbbb';
ok('1: equal epochs with different fingerprints fail (the fork the numbers hide)', failsOn(invariantVerdict(w), 1, /fingerprint/));
w = world();
w.clients[1].lines.push('[FORK] group 11111111 at epoch 9: u:d signed an epoch fingerprint that is not ours');
ok('1: a client [FORK] line fails', failsOn(invariantVerdict(w), 1, /fork finding/));
w = world();
w.server.lines.push('[Nest] WARN [INTEGRITY] fork in 11111111 reported by u');
ok('1: a server [INTEGRITY] report fails', failsOn(invariantVerdict(w), 1, /integrity finding/));

// ── 2. no stage left; one commit-log row per epoch moved ────────────────────────────────────────
w = world();
w.clients[0].pendingSubmission = true;
ok('2: a staged commit left behind fails', failsOn(invariantVerdict(w), 2, /staged commit/));
w.expectStage = true;
ok('2: ... unless the row is ABOUT a staged commit', !invariantVerdict(w).failures.some((f) => f.invariant === 2));
w = world();
w.server.commitEpochs = [0, 1, 2, 3, 4, 5, 6, 8];
ok('2: a gap in the commit log over the moved epochs fails', failsOn(invariantVerdict(w), 2, /expected exactly \[7,8\]/));
w = world();
w.server.commitEpochs.push(9);
ok('2: a commit-log row at the active epoch (accepted, not applied) fails', failsOn(invariantVerdict(w), 2, /at or past the active epoch/));
w = world();
w.fromEpoch = null;
ok('2: a row that recorded no starting epoch fails rather than skipping the check', failsOn(invariantVerdict(w), 2, /no starting epoch/));
w = world();
w.fromEpoch = 10;
ok('2: an epoch that went BACK fails', failsOn(invariantVerdict(w), 2, /went BACK/));

// ── 3. a message after the event: every member, once, in order, right author ────────────────────
w = world();
w.message = null;
ok('3: no post-event message is a failure', failsOn(invariantVerdict(w), 3, /no message/));
w = world();
w.clients[1].received[1].count = 0;
ok('3: a message that never arrived fails', failsOn(invariantVerdict(w), 3, /never arrived/));
w = world();
w.clients[1].received[0].count = 2;
ok('3: a message shown twice fails', failsOn(invariantVerdict(w), 3, /shown 2 times/));
w = world();
w.clients[1].received[0].position = 12;
ok('3: messages out of order fail', failsOn(invariantVerdict(w), 3, /out of order/));
w = world();
w.clients[1].received[0].own = true;
ok("3: the peer showing the owner's message as its OWN fails", failsOn(invariantVerdict(w), 3, /shown as OWN/));
w = world();
w.clients[1].received[0].authorId = 'u-someone-else';
ok('3: a message attributed to another sender fails', failsOn(invariantVerdict(w), 3, /attributed to/));

// ── 4. forbidden lines, 5xx, logout ─────────────────────────────────────────────────────────────
for (const [line, name] of [
  ['[BG_WELCOME] ACCEPTED AND NOT HELD for g', 'accepted-not-held'],
  ['[GRAINE] this ERASES the seed', 'erases'],
  ['[HISTORY] bundle UNREADABLE', 'unreadable'],
  ['[STAGE] g is ABSENT from the state this foreground keeps', 'absent-from-foreground'],
]) {
  ok(`4: "${name}" on a client fails`, forbiddenIn([line]).length === 1 && forbiddenIn([line])[0].startsWith(name));
  w = world();
  w.server.lines.push(line);
  ok(`4: "${name}" on the server fails`, failsOn(invariantVerdict(w), 4, new RegExp(name)));
}
ok('4: every forbidden name is pinned above', FORBIDDEN.length === 4);
ok('4: [ADMISSION] at info is the mechanism working, not dirt', forbiddenIn(['[ADMISSION] ask raised for g']).length === 0);
ok('4: [ADMISSION] at ERROR (server text) fails', forbiddenIn(['[Nest] ERROR [ADMISSION] lift failed']).length === 1);
ok('4: [ADMISSION] at error LEVEL (a client console.error) fails', forbiddenIn([{ text: '[ADMISSION] lift failed', level: 'error' }]).length === 1);
ok('4: "erased" in prose is not "ERASES"', forbiddenIn(['the draft was erased']).length === 0);
w = world();
w.clients[0].http5xx = ['502 https://dev.example/api/mls/commit'];
ok('4: a 5xx a client received fails', failsOn(invariantVerdict(w), 4, /5xx/));
// A 5xx THE ROW'S OWN FAULT PROVOKED (DUP-5) is forgiven ONCE per provoked answer, and said.
w = world();
w.clients[0].http5xx = ['503 https://dev.example/api/mls/commit'];
w.clients[0].provoked5xx = [{ status: 503, url: 'https://dev.example/api/mls/commit' }];
{
  const v = invariantVerdict(w);
  ok('4: a provoked 503 is forgiven', v.ok);
  ok('4: ... and named as an approximation, never silent', v.approximations.some((a) => a.invariant === 4 && /own fault provoked/.test(a.what)));
}
w.clients[0].http5xx.push('503 https://dev.example/api/mls/commit');
ok('4: a SECOND 503 on the same path, unprovoked, still fails', failsOn(invariantVerdict(w), 4, /5xx/));
w = world();
w.clients[0].http5xx = ['502 https://dev.example/api/mls/commit'];
w.clients[0].provoked5xx = [{ status: 503, url: 'https://dev.example/api/mls/commit' }];
ok('4: a provoked 503 does not forgive a 502', failsOn(invariantVerdict(w), 4, /502/));
ok('4: a provoked 4xx or transport failure forgives no 5xx', forgiveProvoked5xx(['503 u'], [{ status: 409, url: 'u' }, { status: null, url: 'u' }]).kept.length === 1);
ok('4: the forgiveness matches the 120-char url the collector keeps', forgiveProvoked5xx([`503 ${'x'.repeat(120)}`], [{ status: 503, url: 'x'.repeat(150) }]).kept.length === 0);
w = world();
w.server.lines.push('[Nest] ERROR [ExceptionsHandler] boom');
ok('4: an unhandled exception on the server (a 5xx) fails', failsOn(invariantVerdict(w), 4, /unhandled exception/));
w = world();
w.clients[1].loggedOut = true;
ok('4: a logged-out client fails', failsOn(invariantVerdict(w), 4, /logged out/));
w = world();
w.server.lines = null;
ok('4: an unread server window fails, never reads as quiet', failsOn(invariantVerdict(w), 4, /not read/));
w = world();
w.server.lines = null;
w.server.unreachable = 'ssh: timeout';
ok('4: an unreachable server is a failure with its reason', failsOn(invariantVerdict(w), 1, /could not be read: ssh/));
w = world();
w.clients[0].rowWatched = false;
const probeOnly = invariantVerdict(w);
ok('4: a console watched only during the probe passes AND is named as an approximation', probeOnly.ok && probeOnly.approximations.some((a) => a.invariant === 4));
w = world();
w.clients[0].lines = null;
ok('4: a console not observed at all fails', failsOn(invariantVerdict(w), 4, /not observed at all/));

// ── 5. roster and tree agree ────────────────────────────────────────────────────────────────────
w = world();
w.server.seats[1].kicked = true;
ok('5: a roster user with no live seat fails', failsOn(invariantVerdict(w), 5, /on the roster with no leaf/));
w = world();
w.server.seats.push({ userId: 'u-stray', deviceId: 'd9', status: 'active', kicked: false });
ok('5: a seat with no roster row fails (the stray leaf)', failsOn(invariantVerdict(w), 5, /a leaf with no roster row/));
w = world();
w.server.roster.push({ userId: 'u-waiting', awaitingAdmission: true });
ok('5: a person AWAITING admission is not owed a leaf (#2358)', invariantVerdict(w).ok);
w = world();
w.server.seats.push({ userId: PEER, deviceId: 'd3', status: 'pending', kicked: false });
ok('5: a pending seat (Welcome not yet sent) is not a leaf either way', invariantVerdict(w).ok);
w = world();
for (const c of w.clients) c.leafUsers = c.device === 'W1' ? [OWNER, PEER] : [OWNER];
ok('5: a direct leaf reading wins over the seats, per device', failsOn(invariantVerdict(w), 5, /W2: on the roster with no leaf/));
w = world();
w.server.seats[0].status = 'pending';
ok('5: a member device in play without an active seat fails', failsOn(invariantVerdict(w), 5, /W1: a member device in play with no active seat/));

// ── a non-member device in play ─────────────────────────────────────────────────────────────────
w = world();
w.clients.push({ device: 'W3', userId: 'u-gone', deviceId: 'd7', member: false, epochs: {}, loggedOut: false, lines: [], rowWatched: true, http5xx: [], received: [] });
ok('a removed device in play is judged for logout and lines, not for the tree', invariantVerdict(w).ok);
w.clients[2].lines.push('[X] ACCEPTED AND NOT HELD');
ok('... and its forbidden line still fails', failsOn(invariantVerdict(w), 4, /W3/));
w = world();
for (const c of w.clients) c.member = false;
ok('an invariant over no member at all fails', failsOn(invariantVerdict(w), 1, /no member device/));

// THE RELOAD PASS WAITS FOR ITS OWN CONNECTION COMMITS (RM-8, 2026-10-25): who is behind the server.
ok('a member at the server epoch is settled', behindServer({ W1: { [G]: 3 }, W2: { [G]: 3 } }, G, 3).length === 0);
ok('a member one commit behind is waited for', behindServer({ W1: { [G]: 2 }, W2: { [G]: 3 } }, G, 3).join() === 'W1');
ok('a member ahead of a server read taken a moment earlier is not behind', behindServer({ W1: { [G]: 4 } }, G, 3).length === 0);
ok('a member that does not hold the group, or exposes no epochs, is behind', behindServer({ W1: {}, W2: null }, G, 3).join() === 'W1,W2');
ok('no server epoch to reach: nobody is waited for', behindServer({ W1: null }, G, null).length === 0);
// Settled = two agreeing rounds; the controls are the RM-8 sample itself and a group still moving.
ok('two clean rounds at one epoch: settled', settledRounds([{ serverEpoch: 3, behind: [] }, { serverEpoch: 3, behind: [] }]));
ok('one clean round is not settled', !settledRounds([{ serverEpoch: 3, behind: [] }]));
ok('the RM-8 sample (W1 one commit behind) is not settled', !settledRounds([{ serverEpoch: 2, behind: [] }, { serverEpoch: 3, behind: ['W1'] }]));
ok('two clean rounds at different epochs: still moving', !settledRounds([{ serverEpoch: 2, behind: [] }, { serverEpoch: 3, behind: [] }]));

// What a pass does with its settlement (`settleDecision`): judged, unjudged, and the note it carries.
const R = (serverEpoch, behind = []) => ({ serverEpoch, behind });
const quick = { settled: true, ms: 500, rounds: [R(3), R(3)] };
const slow = { settled: true, ms: 4000, rounds: [R(2, ['W1']), R(3, ['W1']), R(3), R(3)] };
const never = { settled: false, ms: 60000, rounds: [R(2, ['W1']), R(3, ['W1'])] };
const dq = settleDecision('after the action', quick, { judgeUnsettled: true });
ok('settled at the first two readings: judged, no note', dq.judge && dq.approximation === null && dq.unjudged === null);
const ds = settleDecision('after the action', slow, { judgeUnsettled: true });
ok('settled only after more rounds: judged, and the pass says how many', ds.judge && /settled only after 4 rounds/.test(ds.approximation?.what ?? ''));
const dn = settleDecision('after the action', never, { judgeUnsettled: true });
ok('never settled after the action: judged anyway, noted UNSETTLED with who was behind', dn.judge && /judged UNSETTLED/.test(dn.approximation?.what ?? '') && /behind: W1/.test(dn.approximation.what));
const dr = settleDecision('after a reload of every web client', never, { judgeUnsettled: false });
ok('never settled after the reload: unjudged, the reason carried, nothing failed', !dr.judge && dr.unjudged?.unsettled?.startsWith('the group never settled after a reload') && dr.unjudged.failures.length === 0);
ok('... and settled after the reload: judged', settleDecision('after a reload of every web client', quick, { judgeUnsettled: false }).judge);

// A commit landing between the settlement and the judge's reads (`movedUnderJudge`): DEV-2 alpha.5.
ok('settled at 3, the server at 4 after the judge: moved, judge again', movedUnderJudge(quick, 4));
ok('settled at 3, the server still at 3: the pass stands', !movedUnderJudge(quick, 3));
ok('an unsettled settlement is never "moved" - it is judged or unjudged as it was', !movedUnderJudge(never, 4));

console.log(failures ? `[invariant] ${failures} FAILURE(S)` : '[invariant] clean - every invariant fails on its own fault, and every approximation is named');
process.exit(failures ? 1 : 0);
