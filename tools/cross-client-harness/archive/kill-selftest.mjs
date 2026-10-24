/**
 * THE KILL ROWS' OWN JUDGEMENTS, PINNED (`killrows.mjs`).
 *
 * Each row's question answered on a clean outcome and broken one assertion at a time, so a judgement
 * that stops firing has its symptom here, where on a live estate it would have none. Pure: no rig, no
 * browser, no `names.mjs` (`archive/reopen.mjs`, which kills and revives, is exercised only on a rig).
 *
 *   bun archive/kill-selftest.mjs
 */
import { KILL_ROWS, WINDOWS, delayOf, killRunsOwn, removalBoundOwn, runOutcome, stageKillsOwn, welcomeLines, welcomeOnceOwn, windowOf } from '../killrows.mjs';

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
ok('KILL-3 and KILL-4 are played on A1', KILL_ROWS['KILL-3'].devices[0] === 'A1' && KILL_ROWS['KILL-4'].devices[0] === 'A1');
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

if (failures) {
  console.error(`\n${failures} kill assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
