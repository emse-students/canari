/**
 * THE KILL ROWS' OWN JUDGEMENTS, PINNED (`killrows.mjs`).
 *
 * Each row's question answered on a clean outcome and broken one assertion at a time, so a judgement
 * that stops firing has its symptom here, where on a live estate it would have none. Pure: no rig, no
 * browser, no `names.mjs` (`archive/reopen.mjs`, which kills and revives, is exercised only on a rig).
 *
 *   bun archive/kill-selftest.mjs
 */
import { COOKIE_COMMIT_MS, KILL3_WINDOWS, KILL_BLOCKED, KILL_ROWS, REFRESH_COOKIE_TTL_S, UNSENT_LABELS, WINDOWS, kill3Outcome, kill3WindowOf, kill3WindowsOwn, cookieCommitWaitMs, delayOf, killRunsOwn, panelMissing, removalBoundOwn, runCommits, runOutcome, storageLost, strayCommits, strayCommitsOwn, stageKillsOwn, welcomeLines, welcomeOnceOwn, windowOf } from '../killrows.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const allOk = (as) => as.length > 0 && as.every((a) => a.ok);
const failing = (as) => as.filter((a) => !a.ok).length;

const G = '11111111-2222-3333-4444-555555555555';
const A = { kind: 'ACCEPT', newEpoch: 5 };
const D = { kind: 'DUPLICATE' };

// ── the table ────────────────────────────────────────────────────────────────────────────────────
console.log('the table');
const rows = Object.entries(KILL_ROWS);
ok('every seat a row names is opened', rows.every(([, r]) => [r.subject, r.next, ...(r.setup ?? [])].filter(Boolean).every((d) => r.devices.includes(d))));
ok('KILL-1 is 20 runs of a tab close, KILL-2 a browser kill', KILL_ROWS['KILL-1'].runs === 20 && KILL_ROWS['KILL-1'].kill === 'tab' && KILL_ROWS['KILL-2'].kill === 'browser');
ok('KILL-4 is played on A1, KILL-3 on a web seat with a browser kill', KILL_ROWS['KILL-4'].devices[0] === 'A1' && KILL_ROWS['KILL-3'].devices[0] === 'W1' && KILL_ROWS['KILL-3'].kill === 'browser');
ok('KILL-3 is no longer blocked, KILL-4 still is', !KILL_BLOCKED['KILL-3'] && !!KILL_BLOCKED['KILL-4']);

// ── KILL-3 ───────────────────────────────────────────────────────────────────────────────────────
console.log('KILL-3 kill3Outcome');
const k3 = (over = {}) => kill3Outcome({ window: 'after-send', killedShown: 1, outShown: 1, inShown: 1, accepts: 0, moved: 0, caughtUpMs: 900, ...over });
const tw3 = Array.from({ length: KILL_ROWS['KILL-3'].runs }, (_, i) => kill3WindowOf(i));
ok('twelve runs are three of each window', Object.keys(KILL3_WINDOWS).every((w) => tw3.filter((x) => x === w).length === 3));
ok('the held windows hold, the others observe', KILL3_WINDOWS['send-before-server'].startsWith('hold ') && KILL3_WINDOWS['send-after-accept'].startsWith('hold-answer') && KILL3_WINDOWS['after-send'] === null);
ok('delivered once, nothing committed, the ratchet alive -> all hold', allOk(k3().assertions));
ok('the next message out lost (a rolled-back ratchet) fails', failing(k3({ outShown: 0 }).assertions) === 1);
ok('a stored message lost after the kill fails', failing(k3({ window: 'send-after-accept', killedShown: 0 }).assertions) === 1);
ok('a received message shown twice after the revival fails', failing(k3({ window: 'after-receive', killedShown: 2 }).assertions) === 1);
ok('a message that never reached the server may be absent if W1 shows it unsent', allOk(k3({ window: 'send-before-server', killedShown: 0, unsentLabel: UNSENT_LABELS[2] }).assertions));
ok('... and resent once is fine', allOk(k3({ window: 'send-before-server', killedShown: 1 }).assertions));
ok('... but absent with no unsent state is a SILENT LOSS, and fails', failing(k3({ window: 'send-before-server', killedShown: 0 }).assertions) === 1 && k3({ window: 'send-before-server', killedShown: 0 }).outcome === 'silently lost');
ok('the unsent labels are the four states, in the French interface', UNSENT_LABELS.length === 4 && UNSENT_LABELS.includes('\u00c9chec'));
ok('... but never twice', failing(k3({ window: 'send-before-server', killedShown: 2 }).assertions) >= 1);
ok('a commit coming of a plain send is a heal, and fails', failing(k3({ accepts: 1, moved: 1 }).assertions) === 1);
ok('a row that skipped a window fails its coverage', failing(kill3WindowsOwn([{ window: 'after-send' }, { window: 'after-receive' }])) === 1);
ok('every window played -> coverage holds', allOk(kill3WindowsOwn(Object.keys(KILL3_WINDOWS).map((window) => ({ window })))));
ok('KILL-4 says why it is not timed on a line, and why not am kill', /CHECKPOINT/.test(KILL_ROWS['KILL-4'].note) && /am kill/.test(KILL_ROWS['KILL-4'].note));
ok('KILL-4 fractions lie strictly inside the window', KILL_ROWS['KILL-4'].fractions.every((f) => f > 0 && f < 1));
ok('RM-3 removes a member it set up and adds one it did not', KILL_ROWS['RM-3'].setup.includes(KILL_ROWS['RM-3'].subject) && !KILL_ROWS['RM-3'].setup.includes(KILL_ROWS['RM-3'].next));

// ── the windows ──────────────────────────────────────────────────────────────────────────────────
console.log('the windows');
ok('a window holds before the server, the other after the accept', WINDOWS['before-server'].startsWith('hold ') && WINDOWS['after-accept'].startsWith('hold-answer'));
const tw = Array.from({ length: 20 }, (_, i) => windowOf(i));
ok('twenty runs are ten of each window', tw.filter((w) => w === 'before-server').length === 10 && tw.filter((w) => w === 'after-accept').length === 10);
ok('the delay stays inside 0..maxDelayMs', delayOf(KILL_ROWS['KILL-1'], () => 0) === 0 && delayOf(KILL_ROWS['KILL-1'], () => 0.999) <= 800);

// ── runOutcome ───────────────────────────────────────────────────────────────────────────────────
console.log('runOutcome');
const run = (over = {}) => runOutcome({ window: 'after-accept', seq: [A, D], fromEpoch: 4, serverEpoch: 5, caughtUpMs: 300, outShown: 1, inShown: 1, ...over });
ok('accepted, resubmitted duplicate, caught up, traffic both ways -> merged, all hold', run().outcome === 'merged' && allOk(run().assertions));
ok('before the server, resubmitted and accepted -> merged', allOk(run({ window: 'before-server', seq: [A] }).assertions));
const cleared = run({ window: 'before-server', seq: [], serverEpoch: 4 });
ok('before the server, never sent -> cleared, all hold', cleared.outcome === 'cleared' && allOk(cleared.assertions));
ok('after the accept, cleared is a failure', failing(run({ seq: [], serverEpoch: 4 }).assertions) === 1);
ok('two accepts is neither', run({ seq: [A, A], serverEpoch: 6 }).outcome === 'neither' && failing(run({ seq: [A, A], serverEpoch: 6 }).assertions) === 2);
ok('an epoch moved without an accept is neither', run({ seq: [], serverEpoch: 5, window: 'before-server' }).outcome === 'neither');
ok('not caught up fails', failing(run({ caughtUpMs: null }).assertions) === 1);
ok('a blocked group (nothing in) fails', failing(run({ inShown: 0 }).assertions) === 1);
ok('a duplicate shown fails', failing(run({ outShown: 2 }).assertions) === 1);

// ── killRunsOwn / stageKillsOwn ──────────────────────────────────────────────────────────────────
console.log('killRunsOwn');
const r1 = { run: 1, window: 'before-server', ...cleared };
const r2 = { run: 2, window: 'after-accept', ...run() };
ok('both windows, all clean -> all hold', allOk(killRunsOwn([r1, r2])));
ok('one window only fails coverage', failing(killRunsOwn([r1])) === 1);
ok('a failing run is named by its number', killRunsOwn([r1, { ...r2, ...run({ caughtUpMs: null }) }]).some((a) => !a.ok && a.what.startsWith('run 2 ')));
ok('no runs fails', failing(killRunsOwn([], { windows: false })) === 1);
ok('KILL-4: a kill inside the window holds', allOk(stageKillsOwn({ windowMs: 900, runs: [{ heldAtKill: 0 }, { heldAtKill: 1 }] })));
ok('KILL-4: every kill after the request left fails', failing(stageKillsOwn({ windowMs: 900, runs: [{ heldAtKill: 1 }] })) === 1);
ok('KILL-4: no measured window fails', failing(stageKillsOwn({ windowMs: null, runs: [{ heldAtKill: 0 }] })) === 1);

// ── KILL-5 ───────────────────────────────────────────────────────────────────────────────────────
console.log('KILL-5');
const ready = `[WELCOME] Group ${G.slice(0, 8)}… ready`;
const again = `[WELCOME] ${G.slice(0, 8)}… already held - redelivered Welcome ignored (idempotent)`;
const other = '[WELCOME] Group 99999999… ready';
const wl = welcomeLines([ready, again, other, 'noise'], G);
ok('welcomeLines counts this group only', wl.joined === 1 && wl.redelivered === 1 && wl.failed.length === 0);
ok('a processing error is a failure line', welcomeLines([`[WELCOME] Erreur traitement ${G.slice(0, 8)}…: boom`], G).failed.length === 1);
const k5 = (over = {}) => welcomeOnceOwn({ accepts: 1, welcome: wl, listed: true, caughtUpMs: 100, heldWelcome: true, ...over });
ok('one accept, one join, a redelivery ignored -> all hold', allOk(k5()));
ok('two joins fails', failing(k5({ welcome: { ...wl, joined: 2 } })) === 1);
ok('no join fails', failing(k5({ welcome: { ...wl, joined: 0 } })) === 1);
ok('a failure line fails', failing(k5({ welcome: { ...wl, failed: ['x'] } })) === 1);
ok('the Welcome not held is the premise failing', failing(k5({ heldWelcome: false })) === 1);
ok('not listed fails', failing(k5({ listed: false })) === 1);

// ── RM-3 ─────────────────────────────────────────────────────────────────────────────────────────
console.log('RM-3');
const rm = (over = {}) => removalBoundOwn({ rosterDropped: true, commitBeforeKill: 0, seatsAtKill: 1, goneAfterMs: 42_000, boundMs: 300_000, ...over });
ok('roster dropped, no commit, seat gone in time -> all hold', allOk(rm()));
ok('a surviving seat at the kill is recorded, never failed', allOk(rm({ seatsAtKill: 2 })) && allOk(rm({ seatsAtKill: 0 })));
ok('the roster not dropped is the premise failing', failing(rm({ rosterDropped: false })) === 1);
ok('a Remove commit before the kill is the premise failing', failing(rm({ commitBeforeKill: 1 })) === 1);
ok('a seat never taken within the bound fails', failing(rm({ goneAfterMs: null })) === 1);

// RM-3's premise: the panel lists every invitee of the one bulk Add (#2433, 2026-10-25).
ok('the panel offering both invitees misses nobody', panelMissing({ buttons: ['AAA', 'bbb'] }, ['aaa', 'BBB']).length === 0);
ok('control: the alpha.3 panel (one invitee only) misses the other', panelMissing({ buttons: ['c71e'] }, ['c71e', '223b']).join() === '223b');
ok('a whole profile whose storage answers is not lost', storageLost({ quotaDb: true, idb: null, estimate: null }) === null);
ok('control: the 2026-10-25 W1 revival (no quota db, both calls failing) is lost and says so', /quota database.*indexedDB: UnknownError.*estimate/.test(storageLost({ quotaDb: false, idb: 'UnknownError: Internal error.', estimate: 'TypeError: Internal error when calculating storage usage.' }) ?? ''));
ok('the KILL-2 replay revival (storage whole, an empty cookie jar) is lost and names the jar', /cookie jar/.test(storageLost({ quotaDb: true, idb: null, estimate: null, cookies: 0 }) ?? ''));
ok('control: a jar that kept other cookies is not lost (a product sign-out clears only its own)', storageLost({ quotaDb: true, idb: null, estimate: null, cookies: 3 }) === null);
ok('control: a jar not read accuses nothing', storageLost({ quotaDb: true, idb: null, estimate: null, cookies: null }) === null);
ok('control: one failing call alone is enough',storageLost({ quotaDb: true, idb: 'UnknownError: Internal error.', estimate: null }) !== null);
// KILL-2's premise: the kill waits for the newest refresh cookie to reach disk (2026-10-25).
const T0 = 1_800_000_000_000;
const exp = (receivedMs) => receivedMs / 1000 + REFRESH_COOKIE_TTL_S;
ok('a cookie received 70 s ago is on disk', cookieCommitWaitMs({ expiresSec: exp(T0 - 70_000), nowMs: T0 }) === 0);
ok('control: the reproduced sign-out (kill 5 s after a rotation) waits out the rest', cookieCommitWaitMs({ expiresSec: exp(T0 - 5_000), nowMs: T0 }) === COOKIE_COMMIT_MS - 5_000);
ok('control: no refresh cookie is an unmet premise, not a zero wait', cookieCommitWaitMs({ expiresSec: null, nowMs: T0 }) === null);
ok('control: an unreadable panel misses everyone', panelMissing(null, ['a', 'b']).length === 2);

// KILL-2 run 2 on alpha.4: a commit landing between the window opening and the epoch read (2026-10-25).
const RUN2 = [{ kind: 'ACCEPT', trace: 'commit-e48a5d06', newEpoch: 4 }, { kind: 'ACCEPT', trace: 'commit-efef320a', newEpoch: 5 }];
ok('the replayed run 2: the commit the epoch read already saw is a stray', strayCommits(RUN2, 4).map((d) => d.trace).join() === 'commit-e48a5d06');
ok('the replayed run 2: the run keeps only its own commit, so it merged once', runOutcome({ window: 'after-accept', seq: runCommits(RUN2, 4), fromEpoch: 4, serverEpoch: 5, caughtUpMs: 3, outShown: 1, inShown: 1 }).outcome === 'merged');
ok('the replayed run 2: the stray fails its own assertion, by trace', !strayCommitsOwn(strayCommits(RUN2, 4), 'between run 1 and run 2').ok && strayCommitsOwn(strayCommits(RUN2, 4), 'x').what.includes('commit-e48a5d06->4'));
ok('control: a run with no stray passes it', strayCommitsOwn([], 'between run 1 and run 2').ok);
ok('control: a REJECT or DUPLICATE is never a stray', strayCommits([{ kind: 'REJECT', trace: 't', reason: 'epoch_mismatch' }, { kind: 'DUPLICATE', trace: 'u' }], 9).length === 0);
ok('control: two accepts past the read are still neither', runOutcome({ window: 'after-accept', seq: runCommits(RUN2, 3), fromEpoch: 3, serverEpoch: 5, caughtUpMs: 3, outShown: 1, inShown: 1 }).outcome === 'neither');

if (failures) {
  console.error(`\n${failures} kill assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
