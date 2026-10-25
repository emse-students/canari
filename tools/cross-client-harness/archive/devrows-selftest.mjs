/**
 * THE DEVICE ROWS' OWN JUDGEMENTS, PINNED (`devicerows.mjs`).
 *
 * Each row's question answered on a clean outcome and broken one assertion at a time, so a judgement
 * that stops firing has its symptom here, where on a live estate it would have none. Pure: no rig, no
 * browser, no `names.mjs`.
 *
 *   bun archive/devrows-selftest.mjs
 */
import {
  BG_WELCOME,
  dup7Narration,
  DEV5_ELSEWHERE,
  DEV_ROWS,
  appearances,
  bgAnswered,
  bgWelcomeOwn,
  bgWelcomeTrace,
  deviceAddedOwn,
  deviceSeat,
  mintedLine,
  offlineRevokeOwn,
  originalArrivalOwn,
  raceEnrolOwn,
  reenrolledDevice,
  revokedOwn,
  addAcrossReloadPremise,
  commitLinesBy,
  welcomeAcrossReloadOwn,
} from '../devicerows.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const allOk = (as) => as.length > 0 && as.every((a) => a.ok);
const failing = (as) => as.filter((a) => !a.ok).length;

const G = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';

// ── the table ───────────────────────────────────────────────────────────────────────────────────
ok('DEV-5 is not a row here, and says where it went', !DEV_ROWS['DEV-5'] && DEV5_ELSEWHERE.includes('CORRUPT-8'));
ok('every row mints only on a wipeable seat (W3, W6)', Object.values(DEV_ROWS).every((r) => r.mint.every((d) => ['W3', 'W6'].includes(d))));
ok('no row seats a minted device as a fixture member', Object.values(DEV_ROWS).every((r) => r.mint.every((d) => !r.devices.includes(d))));
ok('every row has W1 to act from', Object.values(DEV_ROWS).every((r) => r.devices.includes('W1')));
ok('DEV-4 mints two', DEV_ROWS['DEV-4'].mint.length === 2 && DEV_ROWS['DEV-4'].together);
ok('DEV-7 has a judgement for every variant', DEV_ROWS['DEV-7'].variants.every((v) => BG_WELCOME[v]));

// ── the pure readers ────────────────────────────────────────────────────────────────────────────
const seatView = { seats: [{ userId: 'u', deviceId: 'd-active', status: 'active', kicked: false }, { userId: 'u', deviceId: 'd-kicked', status: 'active', kicked: true }, { userId: 'u', deviceId: 'd-left', status: 'removed', kicked: false }] };
ok('an active seat reads active', deviceSeat(seatView, 'd-active') === 'active');
ok('a kicked seat is not active', deviceSeat(seatView, 'd-kicked') === 'kicked');
ok('a seat with another status reads that status', deviceSeat(seatView, 'd-left') === 'removed');
ok('no seat reads absent', deviceSeat(seatView, 'd-none') === 'absent');

const srv = [
  `[BG_WELCOME][bg-wlc-1] START group=${G} sender=u:d target=u:n baseEpoch=4`,
  '[BG_WELCOME][bg-wlc-1] commit accepted -> activeEpoch=5',
  '[BG_WELCOME][bg-wlc-1] DONE Welcome stored with the commit',
  `[BG_WELCOME][bg-wlc-2] START group=${OTHER} sender=u:d target=u:n baseEpoch=9`,
  '[BG_WELCOME][bg-wlc-2] REJECT commit epoch_mismatch',
];
const trace = bgWelcomeTrace(srv, G);
ok("the trace keeps the group's START and its trace's later lines", trace.length === 3);
ok("the trace drops another group's lines, REJECT included", !trace.some((l) => l.includes('REJECT')));

ok('one appearance, never doubled', JSON.stringify(appearances([0, 0, 1, 1, 0])) === JSON.stringify({ shown: 1, most: 1 }));
ok('shown, gone, shown again is two', appearances([1, 0, 1]).shown === 2);
ok('two at once is most 2', appearances([0, 2, 2]).most === 2);
ok('never shown is zero', appearances([0, 0]).shown === 0 && appearances([]).most === 0);

ok('the MINTED line is read', mintedLine('noise\nMINTED {"deviceId":"web-1","enrolled":true}\n').deviceId === 'web-1');
ok('the LAST MINTED line wins', mintedLine('MINTED {"deviceId":"a"}\nMINTED {"deviceId":"b"}').deviceId === 'b');
ok('no MINTED line is null', mintedLine('crashed') === null);
ok('an unreadable MINTED line is null', mintedLine('MINTED {nope') === null);

ok('a sent Welcome ends the answer', bgAnswered(['processWelcomeRequestBackground: group=g target=t accepted at base 4 - Welcome sent - staged Add merged']));
ok('a stale refusal ends the answer', bgAnswered(['processWelcomeRequestBackground: REFUSED epoch_mismatch: built on base 4, the group is at 5']));
ok('a staged Welcome alone does not', !bgAnswered(['processWelcomeRequestBackground: Welcome staged ... baseEpoch=4']));

// ── DEV-1 ───────────────────────────────────────────────────────────────────────────────────────
const added = { seatedMs: 4_000, notice: { shown: 1, most: 1 }, lines: { W1: 0, W2: 1 } };
ok('DEV-1: seated, one notice, one line on the contact and none on the owner passes', allOk(deviceAddedOwn(added)));
ok('DEV-1: never seated fails', failing(deviceAddedOwn({ ...added, seatedMs: null })) === 1);
ok('DEV-1: a notice shown twice fails', failing(deviceAddedOwn({ ...added, notice: { shown: 2, most: 1 } })) === 1);
ok('DEV-1: two notices at once fails', failing(deviceAddedOwn({ ...added, notice: { shown: 1, most: 2 } })) === 1);
ok('DEV-1: no notice fails', failing(deviceAddedOwn({ ...added, notice: { shown: 0, most: 0 } })) === 1);
ok('DEV-1: a doubled device line on W2 fails', failing(deviceAddedOwn({ ...added, lines: { W1: 0, W2: 2 } })) === 1);
ok('DEV-1: a missing device line on W2 fails', failing(deviceAddedOwn({ ...added, lines: { W1: 0, W2: 0 } })) === 1);
ok('DEV-1: a device line on the owner fails - the notice is its alert', failing(deviceAddedOwn({ ...added, lines: { W1: 1, W2: 1 } })) === 1);

// ── DEV-2 / DEV-3 ───────────────────────────────────────────────────────────────────────────────
const revoked = { seatGoneMs: 2_000, toldMs: 1_000, listedAfter: false };
ok('DEV-2: seat gone, told, not listed passes', allOk(revokedOwn(revoked)));
ok('DEV-2: a seat that stayed fails', failing(revokedOwn({ ...revoked, seatGoneMs: null })) === 1);
ok('DEV-2: a device never told fails', failing(revokedOwn({ ...revoked, toldMs: null })) === 1);
ok('DEV-2: a revoked device still listing the group fails', failing(revokedOwn({ ...revoked, listedAfter: true })) === 1);
ok('DEV-3: cut throughout passes', allOk(offlineRevokeOwn({ ...revoked, cutHeld: true })));
ok('DEV-3: a cut that did not hold fails - the row did not happen', failing(offlineRevokeOwn({ ...revoked, cutHeld: false })) === 1);
ok('DEV-3: speaks of the RETURNING device', offlineRevokeOwn({ ...revoked, cutHeld: true }).some((a) => a.what.includes('returning device')));

// THE RE-ENROLMENT DEBRIS: only a fresh id of the SAME account, named by the revoked seat's own storage.
const OWNER = 'aaaa1111';
const MINTED = `web-${OWNER}-mvnp0001-aaaa`;
const FRESH = `web-${OWNER}-mvnp0002-bbbb`;
ok('re-enrol: a fresh id of the owner on the revoked seat is the row\'s debris', reenrolledDevice({ mintedId: MINTED, now: { userId: OWNER, deviceId: FRESH }, ownerId: OWNER }) === FRESH);
ok('re-enrol: the minted id itself is not debris (the seat never rotated)', reenrolledDevice({ mintedId: MINTED, now: { userId: OWNER, deviceId: MINTED }, ownerId: OWNER }) === null);
ok('re-enrol: a wiped seat (no id) records nothing', reenrolledDevice({ mintedId: MINTED, now: null, ownerId: OWNER }) === null);
ok('re-enrol: CONTROL - another account\'s device is never recorded', reenrolledDevice({ mintedId: MINTED, now: { userId: 'bbbb2222', deviceId: 'web-bbbb2222-mvnp0003-cccc' }, ownerId: OWNER }) === null);
ok('re-enrol: CONTROL - an id that does not carry the owner is never recorded', reenrolledDevice({ mintedId: MINTED, now: { userId: OWNER, deviceId: 'web-cccc3333-mvnp0004-dddd' }, ownerId: OWNER }) === null);
ok('re-enrol: an unknown owner records nothing', reenrolledDevice({ mintedId: MINTED, now: { userId: OWNER, deviceId: FRESH }, ownerId: null }) === null);

// ── DEV-4 ───────────────────────────────────────────────────────────────────────────────────────
const race = { minted: [{ device: 'W3', enrolled: true }, { device: 'W6', enrolled: true }], seated: { W3: 3_000, W6: 5_000 }, ownerCaughtUpMs: 800 };
ok('DEV-4: both enrolled and seated, one tree passes', allOk(raceEnrolOwn(race)));
ok('DEV-4: one refused enrolment fails', failing(raceEnrolOwn({ ...race, minted: [race.minted[0], { device: 'W6', enrolled: false, refused: 'cap' }] })) === 1);
ok('DEV-4: one never seated fails', failing(raceEnrolOwn({ ...race, seated: { W3: 3_000, W6: null } })) === 1);
ok('DEV-4: the owner behind the server fails', failing(raceEnrolOwn({ ...race, ownerCaughtUpMs: null })) === 1);

// ── DEV-6 ───────────────────────────────────────────────────────────────────────────────────────
const arrival = { revoked: true, listed: true, earlyShown: 1 };
ok('DEV-6: revoked, listed, the early message read passes', allOk(originalArrivalOwn(arrival)));
ok('DEV-6: the early message missing fails (#2254 back)', failing(originalArrivalOwn({ ...arrival, earlyShown: 0 })) === 1);
ok('DEV-6: the early message twice fails', failing(originalArrivalOwn({ ...arrival, earlyShown: 2 })) === 1);
ok('DEV-6: no revoke fails - the row did not happen', failing(originalArrivalOwn({ ...arrival, revoked: false })) === 1);
ok('DEV-6: not listed fails', failing(originalArrivalOwn({ ...arrival, listed: false })) >= 1);

// ── DEV-7 ───────────────────────────────────────────────────────────────────────────────────────
const coldPhone = ['processWelcomeRequestBackground: Welcome staged ... baseEpoch=4', 'processWelcomeRequestBackground: group=g target=t accepted at base 4 - Welcome sent - staged Add merged'];
const coldServer = trace;
ok('DEV-7 cold: both phone lines, the three server lines, the newcomer reads passes', allOk(bgWelcomeOwn('cold', { phone: coldPhone, server: coldServer, newcomerRead: 1 })));
ok('DEV-7 cold: a missing Welcome sent line fails', failing(bgWelcomeOwn('cold', { phone: coldPhone.slice(0, 1), server: coldServer, newcomerRead: 1 })) === 1);
ok('DEV-7 cold: OUTCOME UNKNOWN on the phone fails', failing(bgWelcomeOwn('cold', { phone: [...coldPhone, 'OUTCOME UNKNOWN'], server: coldServer, newcomerRead: 1 })) === 1);
ok('DEV-7 cold: no DONE on the server fails', failing(bgWelcomeOwn('cold', { phone: coldPhone, server: coldServer.slice(0, 2), newcomerRead: 1 })) === 1);
ok('DEV-7 cold: a REJECT on the server fails', failing(bgWelcomeOwn('cold', { phone: coldPhone, server: [...coldServer, '[BG_WELCOME][bg-wlc-1] REJECT commit epoch_mismatch'], newcomerRead: 1 })) === 1);
ok('DEV-7 cold: the newcomer not reading fails', failing(bgWelcomeOwn('cold', { phone: coldPhone, server: coldServer, newcomerRead: 0 })) === 1);
const openedWebview = ['[COMMIT] settling 1 staged commit(s) by resubmission', '[COMMIT] g accepted - merged'];
ok('DEV-7 opened: left to the foreground, settled by it, passes', allOk(bgWelcomeOwn('opened', { phone: ['stage left in mls.bin (left-to-foreground)'], webview: openedWebview, server: coldServer.slice(0, 1), newcomerRead: 1 })));
ok('DEV-7 opened: already settled by the foreground passes too', allOk(bgWelcomeOwn('opened', { phone: ['already settled by the foreground'], webview: openedWebview, server: coldServer.slice(0, 1), newcomerRead: 1 })));
ok('DEV-7 opened: an ERASES line in the WebView fails', failing(bgWelcomeOwn('opened', { phone: ['already settled by the foreground'], webview: [...openedWebview, 'the foreground ERASES the stage'], server: coldServer.slice(0, 1), newcomerRead: 1 })) === 1);
ok('DEV-7 opened: no phone line of either kind fails', failing(bgWelcomeOwn('opened', { phone: [], webview: openedWebview, server: coldServer.slice(0, 1), newcomerRead: 1 })) === 1);
const stalePhone = ['processWelcomeRequestBackground: REFUSED epoch_mismatch: built on base 4, the group is at 5'];
const staleServer = [`[BG_WELCOME][bg-wlc-3] START group=${G} baseEpoch=4`, '[BG_WELCOME][bg-wlc-3] REJECT commit epoch_mismatch'];
ok('DEV-7 stale: the refusal, and a server REJECT, passes', allOk(bgWelcomeOwn('stale', { phone: stalePhone, server: staleServer, newcomerRead: 1 })));
ok('DEV-7 stale: ACCEPTED AND NOT HELD fails', failing(bgWelcomeOwn('stale', { phone: [...stalePhone, 'ACCEPTED AND NOT HELD'], server: staleServer, newcomerRead: 1 })) === 1);
ok('DEV-7: an unknown variant fails', failing(bgWelcomeOwn('warm', { phone: [], server: [], newcomerRead: 1 })) === 1);

// ── DUP-7 ───────────────────────────────────────────────────────────────────────────────────────
const seq = [
  { kind: 'ACCEPT', newEpoch: 2 },
  { kind: 'DUPLICATE' },
];
const once = { joined: 1, redelivered: 1, failed: [] };
const reload = { seq, heldWelcome: true, reloaded: true, welcome: once, listed: true };
ok('DUP-7: one accept, a duplicate, held, reloaded, joined once passes', allOk(welcomeAcrossReloadOwn(reload)));
ok('DUP-7: no duplicate fails - the answer was never lost', failing(welcomeAcrossReloadOwn({ ...reload, seq: seq.slice(0, 1) })) === 1);
ok('DUP-7: two accepts fails', failing(welcomeAcrossReloadOwn({ ...reload, seq: [...seq, { kind: 'ACCEPT', newEpoch: 3 }] })) === 1);
ok('DUP-7: the Welcome never held fails - the row did not happen', failing(welcomeAcrossReloadOwn({ ...reload, heldWelcome: false })) === 1);
ok('DUP-7: no reload fails', failing(welcomeAcrossReloadOwn({ ...reload, reloaded: false })) === 1);
ok('DUP-7: joined twice fails', failing(welcomeAcrossReloadOwn({ ...reload, welcome: { ...once, joined: 2 } })) === 1);
ok('DUP-7: never joined fails', failing(welcomeAcrossReloadOwn({ ...reload, welcome: { ...once, joined: 0 }, listed: false })) === 2);
ok('DUP-7: a second copy processed as a join fails', failing(welcomeAcrossReloadOwn({ ...reload, welcome: { ...once, failed: ['GroupAlreadyExists'] } })) === 1);
{
  // Verbatim from DUP-7 on alpha.4, stamps stripped as the gate strips them.
  const G = 'a57fd3c2-0000-4000-8000-000000000000';
  const n = dup7Narration(G);
  const hit = (s) => n.some((re) => re.test(s));
  ok('DUP-7 forgives the killed Welcome, its warning and the owed delivery of ITS group', hit('[SYNC] Welcome failed -> 223bc34e…:web-223bc34e…-mvn2msl6-7do6: TransportFailureError: request got no answer: TypeError: Failed to fetch') && hit('[WARN] No Welcome delivered: no member addition will be announced until delivery succeeds.') && hit('[COMMIT] a57fd3c2... owed Welcome of an Add delivered to web-223bc34e…-mvn2msl6-7do6'));
  ok('control: a refused Welcome, another group, and NOT delivered stay dirt', !hit('[SYNC] Welcome failed -> 223bc34e…:web-x: ApiRefusalError: 409') && !hit('[COMMIT] 99999999... owed Welcome of an Add delivered to web-x') && !hit('[COMMIT] a57fd3c2... owed Welcome of an Add NOT delivered to web-x - still owed: boom'));
}
ok('DUP-7: an Add that really happens - W4 is invited in the row, never set up, and nothing is minted', DEV_ROWS['DUP-7'].mint.length === 0 && DEV_ROWS['DUP-7'].addedInRow.includes('W4') && DEV_ROWS['DUP-7'].devices.includes('W4'));
{
  const G = 'group=dc8c0f10-0140-4150-8215-98c965289da2';
  const lines = [
    `[COMMIT][commit-a] START ${G} device=web-aaaa-mvn1-x baseEpoch=2`,
    `[COMMIT][commit-a] ACCEPT ${G} newEpoch=3`,
    `[COMMIT][commit-b] START ${G} device=web-aaaa-mvn1-x baseEpoch=2`,
    `[COMMIT][commit-b] DUPLICATE ${G} device=web-aaaa-mvn1-x baseEpoch=2 - already accepted`,
    `[COMMIT][commit-c] START ${G} device=web-bbbb-mvn2-y baseEpoch=3`,
    `[COMMIT][commit-c] ACCEPT ${G} newEpoch=4`,
  ];
  const mine = commitLinesBy(lines, 'aaaa');
  ok("DUP-7: only W1's commits are judged - the invitee's own later commit is not a second accept", mine.length === 4 && !mine.some((l) => l.includes('commit-c')));
  ok('DUP-7: CONTROL - an account that posted nothing keeps no line', commitLinesBy(lines, 'cccc').length === 0);
}
ok('DUP-7: W1 never committed (rule #0 vacuous) is a premise, not a verdict', addAcrossReloadPremise({ vacuous: [0, 1] }).length === 1);
ok('DUP-7: CONTROL - a held Welcome that never came is NOT a premise once W1 committed', addAcrossReloadPremise({ vacuous: [1] }).length === 0);
ok('DUP-7: both rules fired, no premise', addAcrossReloadPremise({ vacuous: [] }).length === 0);

if (failures) {
  console.error(`\n${failures} device-row assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
