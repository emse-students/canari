/**
 * THE OFFLINE AND DEGRADED-LINK ROWS' OWN JUDGEMENTS, PINNED (`offlinerows.mjs`), AND THE TWO RIG
 * PIECE THEY ADDED (the content type of a fulfilled fault). `degrade` (`archive/net.mjs`) is not
 * here: net.mjs reaches `names.mjs`, which a checkout has not.
 *
 * Each row's question answered on a clean outcome and broken one assertion at a time, so a judgement
 * that stops firing has its symptom here, where on a live estate it would have none. Pure: no rig, no
 * browser, no `names.mjs`.
 *
 *   bun archive/offline-selftest.mjs
 */
import { fulfilBody } from '../fault.mjs';
import { EXIT_REPLAY_NARRATION, LOCK_BUDGET_SPENT, OFF4_PREMISE, OFFLINE_ROWS, PORTAL_HTML, departureOwn, flapOwn, keptRefusedLine, noAnswerLine, portalOwn, slowLinkOwn, staleStageOwn } from '../offlinerows.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const allOk = (as) => as.length > 0 && as.every((a) => a.ok);
const failing = (as) => as.filter((a) => !a.ok).length;

const G = '11111111-2222-3333-4444-555555555555';
const U5 = 'u5555555-aaaa';
const view = (users) => ({
  activeEpoch: 7,
  roster: users.map((userId) => ({ userId, awaitingAdmission: false })),
  seats: users.map((userId, i) => ({ userId, deviceId: `d${i}`, status: 'active', kicked: false })),
});

// ── the table ────────────────────────────────────────────────────────────────────────────────────
console.log('the table');
const rows = Object.entries(OFFLINE_ROWS);
ok('every subject a row names is a seat it opens', rows.every(([, r]) => [r.subject, ...(r.subjects ?? []), ...(r.setup ?? [])].filter(Boolean).every((d) => r.devices.includes(d))));
ok('a subject is never in the setup', rows.every(([, r]) => !(r.setup ?? []).includes(r.subject)));
ok('OFF-3 moves the group three epochs, OFF-5 is played on A1', OFFLINE_ROWS['OFF-3'].advance === 3 && OFFLINE_ROWS['OFF-5'].devices[0] === 'A1');
ok('NET-1 is 800 ms at 50 kB/s each way, and says loss is not emulated', OFFLINE_ROWS['NET-1'].link.latencyMs === 800 && OFFLINE_ROWS['NET-1'].link.downBytesPerSecond === 50_000 && /loss/.test(OFFLINE_ROWS['NET-1'].note));
const n2 = OFFLINE_ROWS['NET-2'];
ok('NET-2 is five minutes, a flap every 10 s', n2.ticks * n2.tickMs === 300_000 && n2.flapEvery * n2.tickMs === 10_000);
ok('OFF-4 is absent and its premise names the account it waits on', !OFFLINE_ROWS['OFF-4'] && /BLOCKED-ON-ACCOUNT/.test(OFF4_PREMISE));

// ── the client's lines ────────────────────────────────────────────────────────────────────────────
console.log('the lines');
ok('the kept-refused line is the client\'s', keptRefusedLine(G, 4) === '[COMMIT] 11111111... the kept commit from epoch 4: refused - cleared');
ok('the no-answer line is a prefix of the client\'s', `[COMMIT] 11111111... no answer to the commit from epoch 4 (TypeError) - resubmitting the same commit`.includes(noAnswerLine(G, 4)));
ok('the lock-budget needle matches the client\'s', '[COMMIT] 11111111... MLS lock budget of 8000 ms is spent'.includes(LOCK_BUDGET_SPENT));

// ── OFF-3 ────────────────────────────────────────────────────────────────────────────────────────
console.log('OFF-3 staleStageOwn');
const REJ = { kind: 'REJECT', reason: 'epoch_mismatch' };
const ACC = { kind: 'ACCEPT', newEpoch: 7 };
const off3 = (over = {}) => staleStageOwn({ seqAfter: [REJ, ACC], clearedLine: 'x', caughtUpMs: 900, view: view(['u1', U5]), subject: U5, advanced: 3, ...over });
ok('refused, cleared, caught up, re-issued -> all hold', allOk(off3()));
ok('two epochs moved is not the row', failing(off3({ advanced: 2 })) === 1);
ok('a refusal other than epoch_mismatch fails', failing(off3({ seqAfter: [{ kind: 'REJECT', reason: 'stale_seat' }, ACC] })) === 1);
ok('no refusal at all fails twice (the refusal, and the re-issue after it)', failing(off3({ seqAfter: [ACC] })) === 2);
ok('not cleared fails', failing(off3({ clearedLine: null })) === 1);
ok('never caught up fails', failing(off3({ caughtUpMs: null })) === 1);
ok('not re-issued fails', failing(off3({ view: view(['u1']) })) === 1);
ok('an accept BEFORE the refusal is no re-issue', failing(off3({ seqAfter: [ACC, REJ] })) === 1);

// ── NET-1 ────────────────────────────────────────────────────────────────────────────────────────
console.log('NET-1 slowLinkOwn');
const subs = ['u2', 'u4', U5];
const net1 = (over = {}) => slowLinkOwn({ view: view(['u1', ...subs]), subjects: subs, budgetLines: [], accepts: 1, ...over });
ok('all in, accepted, no budget spent -> all hold', allOk(net1()));
ok('a spent budget followed by the landing holds', allOk(net1({ budgetLines: ['lock budget of 8000 ms'] })));
ok('a spent budget and one person out fails twice', failing(net1({ budgetLines: ['b'], view: view(['u1', 'u2', 'u4']) })) === 2);
ok('no accept fails twice', failing(net1({ accepts: 0, budgetLines: ['b'] })) === 2);

// ── NET-2 ────────────────────────────────────────────────────────────────────────────────────────
console.log('NET-2 flapOwn');
const shown = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`m${i}`, 1]));
const recon = Array.from({ length: 30 }, () => 800);
const net2 = (over = {}) => flapOwn({ shown, flaps: 30, reconnects: recon, ...over });
ok('thirty flaps, every one back, every message once -> all hold', allOk(net2()));
ok('a duplicate shown fails', failing(net2({ shown: { ...shown, m7: 2 } })) === 1);
ok('a lost message fails', failing(net2({ shown: { ...shown, m7: 0 } })) === 1);
ok('a restore that never reconnected fails', failing(net2({ reconnects: [...recon.slice(1), null] })) === 1);
ok('fewer reconnects than flaps fails', failing(net2({ reconnects: recon.slice(1) })) === 1);
ok('nothing sent is not a pass', failing(net2({ shown: {} })) === 1);

// ── NET-3 ────────────────────────────────────────────────────────────────────────────────────────
console.log('NET-3 portalOwn');
const net3 = (over = {}) => portalOwn({ loggedOutDuring: false, loggedOutAfter: false, noAnswer: 'line', clearedLine: null, joined: true, messageShown: 1, ...over });
ok('signed in, kept as unknown, landed, delivered -> all hold', allOk(net3()));
ok('a logout under the portal fails', failing(net3({ loggedOutDuring: true })) === 1);
ok('the HTML read as a refusal (cleared) fails', failing(net3({ clearedLine: 'cleared' })) === 1);
ok('no no-answer line fails', failing(net3({ noAnswer: null })) === 1);
ok('not landed fails', failing(net3({ joined: false })) === 1);
ok('delivered twice fails', failing(net3({ messageShown: 2 })) === 1);

// ── RM-8 ─────────────────────────────────────────────────────────────────────────────────────────
console.log('RM-8 departureOwn');
const done = { ok: true };
const refused = { ok: false, error: 'timeout waiting for the name to go' };
ok('gone on both sides, leave completed -> all hold', allOk(departureOwn({ view: view(['u1']), user: 'u2', listed: false, atServerEpoch: false, gesture: done })));
ok('still a member on both sides, leave refused with a reason -> all hold', allOk(departureOwn({ view: view(['u1', 'u2']), user: 'u2', listed: true, atServerEpoch: true, gesture: refused })));
ok('gone on the server, still listed on W2 -> half-left', failing(departureOwn({ view: view(['u1']), user: 'u2', listed: true, atServerEpoch: false, gesture: done })) >= 1);
ok('member on the server, W2 not listing it -> half-left', failing(departureOwn({ view: view(['u1', 'u2']), user: 'u2', listed: false, atServerEpoch: false, gesture: refused })) === 1);
ok('member on both, but W2 behind the epoch -> half-left', failing(departureOwn({ view: view(['u1', 'u2']), user: 'u2', listed: true, atServerEpoch: false, gesture: refused })) === 1);
ok('a "completed" leave that left W2 a member fails', failing(departureOwn({ view: view(['u1', 'u2']), user: 'u2', listed: true, atServerEpoch: true, gesture: done })) === 1);

// The exit replay's narration, as W2 logged it on dev.9335201 (2026-10-25), and a KEPT exit that stays dirt.
const narrated = (l) => EXIT_REPLAY_NARRATION.some((re) => re.test(l));
ok('the replay announcement is narration', narrated('[EXIT] replaying 1 exit(s) the server never answered - oldest owed for 2s'));
ok('the replayed leave is narration', narrated('[EXIT] 477435be... leave replayed - server removed this user'));
ok('a replayed DELETE is not RM-8 narration', !narrated('[EXIT] 477435be... delete replayed - server deleted it'));
ok('an exit that could not be recorded stays dirt', !narrated('[EXIT] 477435be... leave could NOT be recorded (x) - a transport failure loses it'));

// ── the rig pieces ───────────────────────────────────────────────────────────────────────────────
console.log('the rig pieces');
const html = fulfilBody(PORTAL_HTML, 'text/html; charset=utf-8');
ok('a portal body is sent as text/html', html.responseHeaders[0].value.startsWith('text/html') && atob(html.body).startsWith('<!doctype html>'));
ok('no content type keeps the default', fulfilBody('x').responseHeaders[0].value.startsWith('text/plain') && fulfilBody({ a: 1 }).responseHeaders[0].value.startsWith('application/json'));
if (failures) {
  console.error(`\n${failures} offline assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
