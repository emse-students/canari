/**
 * THE HAND ROWS' RECORDING, PINNED (`handrows.mjs`).
 *
 * A person's observation is never written as a watched PASS, a dirty server window demotes it, and
 * the arguments refuse a row, a verdict or a start the plan does not allow. Pure: no rig, no browser,
 * no `names.mjs`.
 *
 *   bun archive/handrow-selftest.mjs
 */
import { HAND_ROWS, HAND_UNOBSERVABLE, HAND_VERDICTS, handRecord, parseHandArgs } from '../handrows.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const SINCE = '2026-10-25T11:00:00.000Z';
const args = (...a) => parseHandArgs(a, NOW);

// ── the table ───────────────────────────────────────────────────────────────────────────────────
ok('the O rows of section 4.3 that need a person are the table', JSON.stringify(Object.keys(HAND_ROWS)) === '["LIFE-5","CALL-12","CALL-13"]');
ok('TOK-3 is not a hand row - the clock alone plays it', !('TOK-3' in HAND_ROWS));
ok('a person cannot state PASS-DIRTY or UNOBSERVED', !HAND_VERDICTS.includes('PASS-DIRTY') && !HAND_VERDICTS.includes('UNOBSERVED'));

// ── parseHandArgs ───────────────────────────────────────────────────────────────────────────────
const good = args('--row', 'LIFE-5', '--verdict', 'PASS', '--what', 'the app opened sealed, the passcode unsealed it', '--since', SINCE);
ok('a full line parses', !('error' in good) && good.row === 'LIFE-5' && good.since === SINCE);
ok('an unknown row is refused', 'error' in args('--row', 'MSG-1', '--verdict', 'PASS', '--what', 'x', '--since', SINCE));
ok('a missing row is refused', 'error' in args('--verdict', 'PASS', '--what', 'x', '--since', SINCE));
ok('a verdict outside the list is refused', 'error' in args('--row', 'LIFE-5', '--verdict', 'PASS-DIRTY', '--what', 'x', '--since', SINCE));
ok('an empty observation is refused', 'error' in args('--row', 'LIFE-5', '--verdict', 'PASS', '--what', '  ', '--since', SINCE));
ok('a flag swallowed as a value is refused', 'error' in args('--row', 'LIFE-5', '--verdict', 'PASS', '--what', '--since', SINCE));
ok('a PASS without --since is refused', 'error' in args('--row', 'LIFE-5', '--verdict', 'PASS', '--what', 'x'));
ok('a --since that is not ISO UTC is refused', 'error' in args('--row', 'LIFE-5', '--verdict', 'PASS', '--what', 'x', '--since', '25/10 11:00'));
ok('a --since in the future is refused', 'error' in args('--row', 'LIFE-5', '--verdict', 'PASS', '--what', 'x', '--since', '2026-10-25T13:00:00.000Z'));
const skip = args('--row', 'CALL-12', '--verdict', 'SKIPPED', '--what', 'no CallKit build on the bench');
ok('a SKIPPED needs no --since', !('error' in skip) && skip.since === null);

// ── handRecord ──────────────────────────────────────────────────────────────────────────────────
const cleanWindow = { since: SINCE, clean: true };
const dirtyWindow = { since: SINCE, clean: false, dirt: { errors: 2 } };
const pass = handRecord({ ...good, serverWindow: cleanWindow });
ok('a PASS over a clean window stays PASS', pass.verdict === 'PASS');
ok('it is recorded unobservable, never clean', pass.detail.unobservable === HAND_UNOBSERVABLE && !('clean' in pass.detail));
ok("it carries the person's words and the row's gesture", pass.detail.handObserved === good.what && pass.detail.handGesture === HAND_ROWS['LIFE-5']);
ok('it carries the server window, clean, with no dirt', pass.detail.serverClean === true && pass.detail.serverWindow.since === SINCE && !('dirt_server' in pass.detail));
const dirty = handRecord({ ...good, serverWindow: dirtyWindow });
ok('a PASS over a dirty window is PASS-DIRTY', dirty.verdict === 'PASS-DIRTY');
ok("the window's dirt is named", dirty.detail.serverClean === false && dirty.detail.dirt_server.errors === 2);
const blind = handRecord({ ...good, serverWindow: { since: SINCE, clean: false, unreachable: 'docker logs refused' } });
ok('an unreadable window demotes too, and says why', blind.verdict === 'PASS-DIRTY' && blind.detail.dirt_server.unreachable === 'docker logs refused');
ok('no window at all is never a clean server', handRecord({ ...good, serverWindow: null }).verdict === 'PASS-DIRTY');
ok('a FAIL is never rewritten', handRecord({ ...good, verdict: 'FAIL', serverWindow: dirtyWindow }).verdict === 'FAIL');
const skipped = handRecord({ ...skip, serverWindow: null });
ok('a SKIPPED records the reason and no window', skipped.verdict === 'SKIPPED' && skipped.detail.reason === skip.what && !('serverWindow' in skipped.detail));

if (failures) {
  console.error(`\n${failures} hand-row assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
