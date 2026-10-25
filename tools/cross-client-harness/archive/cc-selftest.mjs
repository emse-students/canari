/**
 * THE CC ROWS' OWN JUDGEMENTS, PINNED (`ccrows.mjs`).
 *
 * The gate's `[COMMIT]` lines parsed as the server writes them (`messaging.service.ts`), then each
 * row's question answered on a clean race and broken one assertion at a time - so a judgement that
 * stops firing has its symptom here, where on a live race it would have none. Pure: no rig, no
 * browser, no `names.mjs`.
 *
 *   bun archive/cc-selftest.mjs
 */
import {
  CC5_PREMISE,
  CC_ROWS,
  RACE_HOLD_MS,
  RACE_REFUSALS,
  doubleRemoveOwn,
  lockRaceLoser,
  lockRaceOwn,
  parseCommitLines,
  parseLockLines,
  rebuiltRaceOwn,
  refreshRaceOwn,
  refusalCodes,
} from '../ccrows.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADD_LOCK_REFUSED_NARRATION } from '../watch.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const allOk = (as) => as.length > 0 && as.every((a) => a.ok);
const failed = (as) => as.filter((a) => !a.ok).map((a) => a.what);

const G = '11111111-2222-3333-4444-555555555555';
// The gate's lines, shaped as `messaging.service.ts` logs them, behind a Nest prefix.
const nest = (s) => `[Nest] 1  - 10/24/2026, 10:00:00 PM    WARN [MessagingService] ${s}`;
const ACCEPT = (t, e) => nest(`[COMMIT][commit-${t}] ACCEPT group=${G} newEpoch=${e}`);
const MISMATCH = (t, b, a) => nest(`[COMMIT][commit-${t}] REJECT epoch_mismatch group=${G} baseEpoch=${b} activeEpoch=${a}`);
const LOST = (t, b, a) => nest(`[COMMIT][commit-${t}] REJECT epoch_mismatch group=${G} baseEpoch=${b} activeEpoch=${a} reason=epoch_moved - another commit at this base landed first`);
const LOCKED = (t, e) => nest(`[COMMIT][commit-${t}] REJECT concurrent_commit group=${G} currentEpoch=${e}`);
const START = (t, b) => nest(`[COMMIT][commit-${t}] START group=${G} device=d1 baseEpoch=${b}`);

// ── parsing ──────────────────────────────────────────────────────────────────────────────────
console.log('parseCommitLines');
const p = parseCommitLines([START('a', 3), ACCEPT('a', 4), MISMATCH('b', 3, 4), START('b2', 4), ACCEPT('b2', 5), 'unrelated line']);
ok('two accepts, with their new epochs', p.accepts.length === 2 && p.accepts[0].newEpoch === 4 && p.accepts[1].newEpoch === 5);
ok('one refusal, its reason the word after REJECT', p.rejects.length === 1 && p.rejects[0].reason === 'epoch_mismatch');
ok('START and foreign lines are not decisions', p.accepts.length + p.rejects.length + p.duplicates.length === 3);
ok('the transaction that lost the advance is an epoch_mismatch too', parseCommitLines([LOST('c', 3, 4)]).rejects[0]?.reason === 'epoch_mismatch');
ok('the lock refusal keeps its own reason', parseCommitLines([LOCKED('d', 3)]).rejects[0]?.reason === 'concurrent_commit');
ok('a DUPLICATE is its own kind', parseCommitLines([nest(`[COMMIT][commit-e] DUPLICATE group=${G} device=d1 baseEpoch=3 - already accepted, answered again`)]).duplicates.length === 1);

// ── the table ────────────────────────────────────────────────────────────────────────────────
console.log('CC table');
ok('CC-1 races two Adds of two different users', CC_ROWS['CC-1'].race.W1.add === 'W4' && CC_ROWS['CC-1'].race.W2.add === 'W5');
ok('CC-2 races an Add against a Remove of someone else', CC_ROWS['CC-2'].race.W1.remove === 'W4' && CC_ROWS['CC-2'].race.W2.add === 'W5');
ok('CC-3 races two Removes of the SAME member', CC_ROWS['CC-3'].race.W1.remove === CC_ROWS['CC-3'].race.W2.remove);
ok('CC-4 races a refresh against an Add', CC_ROWS['CC-4'].race.W1.refresh === true && CC_ROWS['CC-4'].race.W2.add === 'W4');
ok('a removed seat is not a member at the end', !CC_ROWS['CC-2'].members.includes('W4') && !CC_ROWS['CC-3'].members.includes('W4'));
ok('every seat a row names is opened', Object.values(CC_ROWS).every((r) => [...r.setup, ...Object.keys(r.race), ...r.members].every((d) => r.devices.includes(d))));
ok('the setup holds whoever a row removes', Object.values(CC_ROWS).every((r) => Object.values(r.race).every((a) => !a.remove || r.setup.includes(a.remove))));
ok('CC-5 is absent and says why', !CC_ROWS['CC-5'] && CC5_PREMISE.startsWith('BLOCKED-ON-ACCOUNT') && /fifth campaign account/.test(CC5_PREMISE));

// ── CC-1 / CC-2 ──────────────────────────────────────────────────────────────────────────────
console.log('CC-1 / CC-2 rebuilt race');
const U3 = 'u3333333-aaaa';
const U4 = 'u4444444-bbbb';
const U5 = 'u5555555-cccc';
const view = (over = {}) => ({
  activeEpoch: 5,
  commitEpochs: [0, 1, 2, 3, 4],
  roster: ['u1', 'u2', U4, U5].map((userId) => ({ userId, awaitingAdmission: false })),
  seats: ['u1', 'u2', U4, U5].map((userId, i) => ({ userId, deviceId: `d${i}`, status: 'active', kicked: false })),
  ...over,
});
const clean = parseCommitLines([ACCEPT('a', 4), MISMATCH('b', 3, 4), ACCEPT('b2', 5)]);
const both = { W1: { ok: true }, W2: { ok: true } };
const r = (over = {}) => rebuiltRaceOwn({ fromEpoch: 3, view: view(), parsed: clean, added: [U4, U5], outcomes: both, ...over });
ok('one accepted, the other refused epoch_mismatch and rebuilt -> all hold', allOk(r()));
ok('only one accepted (the loser never rebuilt) fails', !allOk(r({ parsed: parseCommitLines([ACCEPT('a', 4), MISMATCH('b', 3, 4)]), view: view({ activeEpoch: 4, commitEpochs: [0, 1, 2, 3] }) })));
ok('no refusal at all (the hold never made a race) fails', !allOk(r({ parsed: parseCommitLines([ACCEPT('a', 4), ACCEPT('b', 5)]) })));
ok('a LOCK refusal is the same outcome -> all hold (the code is detail, not the contract)', allOk(r({ parsed: parseCommitLines([ACCEPT('a', 4), LOCKED('b', 4), ACCEPT('b2', 5)]) })));
ok('the refusal code is named in the assertion', r({ parsed: parseCommitLines([ACCEPT('a', 4), LOCKED('b', 4), ACCEPT('b2', 5)]) }).some((a) => a.ok && /concurrent_commit/.test(a.what)));
ok('refusals of both kinds before the rebuild landed -> all hold', allOk(r({ parsed: parseCommitLines([ACCEPT('a', 4), LOCKED('b', 4), MISMATCH('b2', 3, 4), ACCEPT('b3', 5)]) })));
ok('an UNTYPED refusal (not a race answer) fails', !allOk(r({ parsed: parseCommitLines([ACCEPT('a', 4), nest(`[COMMIT][commit-z] REJECT commit_malformed group=${G} device=d2`), ACCEPT('b3', 5)]) })));
ok('TWO winners of one epoch fails', !allOk(r({ parsed: parseCommitLines([ACCEPT('a', 4), ACCEPT('b', 4), MISMATCH('c', 3, 4)]) })));
ok('refusalCodes lists the codes in order', refusalCodes(parseCommitLines([LOCKED('b', 4), MISMATCH('c', 3, 4)])).join() === 'concurrent_commit,epoch_mismatch');
ok('both race refusals are typed', RACE_REFUSALS.includes('epoch_mismatch') && RACE_REFUSALS.includes('concurrent_commit'));
ok('an epoch that moved three times fails', !allOk(r({ view: view({ activeEpoch: 6, commitEpochs: [0, 1, 2, 3, 4, 5] }) })));
ok('an added user missing from the roster fails (an Add lost)', !allOk(r({ view: view({ roster: view().roster.filter((x) => x.userId !== U5) }) })));
ok('an added user with no active seat fails', !allOk(r({ view: view({ seats: view().seats.map((s) => (s.userId === U4 ? { ...s, status: 'pending' } : s)) }) })));
ok('a gesture that died fails, with its error', failed(r({ outcomes: { W1: { ok: true }, W2: { ok: false, error: 'picker offers no X' } } })).some((w) => w.includes('picker offers no X')));
const cc2view = view({ roster: ['u1', 'u2', U5].map((userId) => ({ userId, awaitingAdmission: false })), seats: view().seats.filter((s) => s.userId !== U3) });
ok('CC-2: the removed user gone, the added one in -> all hold', allOk(r({ view: cc2view, added: [U5], removed: [U3] })));
ok('CC-2: the removed user still on the roster fails', !allOk(r({ view: cc2view, added: [U5], removed: [U4] })));
ok('CC-2: the removed user keeping an active seat (a leaf) fails', !allOk(
  r({ view: { ...cc2view, roster: cc2view.roster, seats: [...cc2view.seats, { userId: U3, deviceId: 'dx', status: 'active', kicked: false }] }, added: [U5], removed: [U3] })
));

// ── CC-1, the add lock ───────────────────────────────────────────────────────────────────────
console.log('CC-1 add-lock race');
// `locks.controller.ts`, behind a Nest prefix; the owner is `<user>:<device>`.
const LOCK = (dev, acquired, g = G) => nest(`[ADD_LOCK] group=${g} owner=u2:${dev} acquired=${acquired}`);
ok('CC-1 is the lock race', CC_ROWS['CC-1'].lockRace === true && !CC_ROWS['CC-2'].lockRace);
const locks = parseLockLines([LOCK('dev-w2', true), LOCK('dev-w1', false), LOCK('dev-x', true, 'other-group'), 'unrelated'], G);
ok('parseLockLines keeps this group\'s decisions, in order', locks.length === 2 && locks[0].device === 'dev-w2' && locks[0].acquired && locks[1].device === 'dev-w1' && !locks[1].acquired);
const racers = { W1: 'dev-w1', W2: 'dev-w2' };
ok('one granted, one refused -> the refused seat is the loser', lockRaceLoser(locks, racers) === 'W1');
ok('both granted (no contention) -> no loser, INCONCLUSIVE', lockRaceLoser(parseLockLines([LOCK('dev-w2', true), LOCK('dev-w1', true)], G), racers) === null);
ok('no lock line at all -> no loser', lockRaceLoser([], racers) === null);
ok('a refusal of a device that is not a racer -> no loser', lockRaceLoser(parseLockLines([LOCK('dev-w2', true), LOCK('dev-x', false)], G), racers) === null);
ok('a seat both refused and granted (a retry) is not a clean loser', lockRaceLoser(parseLockLines([LOCK('dev-w2', true), LOCK('dev-w1', false), LOCK('dev-w1', true)], G), racers) === null);
const v1 = view({ activeEpoch: 4, commitEpochs: [0, 1, 2, 3], roster: ['u1', 'u2', U5].map((userId) => ({ userId, awaitingAdmission: false })), seats: view().seats.filter((s) => s.userId !== U4) });
const l = (over = {}) => lockRaceOwn({ fromEpoch: 3, view: v1, parsed: parseCommitLines([ACCEPT('a', 4)]), winnerAdded: U5, loserAdded: U4, outcomes: both, winner: 'W2', ...over });
ok('one accept, no refusal, winner\'s user in, loser\'s user out -> all hold', allOk(l()));
ok('a commit REFUSED (the loser built one) fails', !allOk(l({ parsed: parseCommitLines([ACCEPT('a', 4), MISMATCH('b', 3, 4)]) })));
ok('two accepts fails', !allOk(l({ parsed: parseCommitLines([ACCEPT('a', 4), ACCEPT('b', 5)]), view: { ...v1, activeEpoch: 5 } })));
ok('the loser\'s user on the roster (an Add half-done) fails', !allOk(l({ view: { ...v1, roster: [...v1.roster, { userId: U4, awaitingAdmission: false }] } })));
ok('the loser\'s user with a seat fails', !allOk(l({ view: { ...v1, seats: [...v1.seats, { userId: U4, deviceId: 'dy', status: 'active', kicked: false }] } })));
ok('the winner\'s user missing fails', !allOk(l({ view: { ...v1, roster: v1.roster.filter((x) => x.userId !== U5) } })));
ok('the winner\'s gesture died fails; the loser\'s outcome is not judged', !allOk(l({ outcomes: { W2: { ok: false, error: 'x' } } })) && allOk(l({ outcomes: { W2: { ok: true }, W1: { ok: false, error: 'cancelled' } } })));
const busy = (s) => ADD_LOCK_REFUSED_NARRATION.some((re) => re.test(s));
ok('the loser\'s two narration lines are forgiven', busy(`[WARN] Add-lock busy for ${G} - invite cancelled (another device is in progress).`) && busy(`[SYNC] Add-lock busy for ${G}, aborting to avoid concurrent commits`));
ok('control: another WARN is not', !busy(`[WARN] Add-lock release failed for ${G}`) && !busy(`[WARN] Add-lock busy for ${G} - invite cancelled (another device is in progress). extra`));

// ── CC-3 ─────────────────────────────────────────────────────────────────────────────────────
console.log('CC-3 double remove');
const v3 = view({ activeEpoch: 4, commitEpochs: [0, 1, 2, 3], roster: ['u1', 'u2'].map((userId) => ({ userId, awaitingAdmission: false })), seats: view().seats.filter((s) => ['u1', 'u2'].includes(s.userId)) });
const d = (over = {}) => doubleRemoveOwn({ fromEpoch: 3, view: v3, parsed: parseCommitLines([ACCEPT('a', 4), MISMATCH('b', 3, 4)]), removed: U4, outcomes: both, ...over });
ok('one Remove lands, the other refused and not rebuilt -> all hold', allOk(d()));
ok('a rebuilt SECOND Remove (two accepts) fails', !allOk(d({ parsed: parseCommitLines([ACCEPT('a', 4), MISMATCH('b', 3, 4), ACCEPT('b2', 5)]), view: { ...v3, activeEpoch: 5, commitEpochs: [0, 1, 2, 3, 4] } })));
ok('the member still on the roster fails', !allOk(d({ removed: 'u2' })));

// ── CC-4 ─────────────────────────────────────────────────────────────────────────────────────
console.log('CC-4 refresh against an Add');
const armed = { at: 1_000, epoch: 3 };
const v4 = view({ roster: ['u1', 'u2', U4].map((userId) => ({ userId, awaitingAdmission: false })), seats: view().seats.filter((s) => s.userId !== U5) });
const f = (over = {}) => refreshRaceOwn({ fromEpoch: 3, view: v4, parsed: clean, added: U4, armed, ledgerAfter: { at: 9_000, epoch: 5 }, outcomes: both, ...over });
ok('both landed in some order, the ledger re-dated -> all hold', allOk(f()));
ok('the refresh lost and was taken again at a later send (three accepts, epoch +3) -> all hold', allOk(f({ parsed: parseCommitLines([ACCEPT('a', 4), MISMATCH('b', 3, 4), ACCEPT('c', 5), ACCEPT('d', 6)]), view: { ...v4, activeEpoch: 6 } })));
ok('the refresh never landed (ledger still backdated) fails', !allOk(f({ ledgerAfter: { at: 1_000, epoch: 3 } })));
ok('a ledger rewritten as an OBSERVATION is not a refresh', !allOk(f({ ledgerAfter: { at: 9_000, epoch: 5, observed: true } })));
ok('the Add lost fails', !allOk(f({ view: { ...v4, roster: v4.roster.filter((x) => x.userId !== U4) } })));
ok('an epoch that moved more than the accepts fails', !allOk(f({ view: { ...v4, activeEpoch: 7 } })));

// A HOLD LONGER THAN THE PRODUCT'S WRITE DEADLINE MEASURES THE DEADLINE, NOT THE RACE - read from the
// frontend's own table, so a deadline that shrinks fails here rather than on a live CC-1.
console.log('the race hold stays under the commit POST deadline');
const deadlineSrc = readFileSync(join(import.meta.dir, '../../../frontend/src/lib/utils/requestDeadline.ts'), 'utf8');
const writeMs = Number(/^\s*write:\s*([\d_]+),/m.exec(deadlineSrc)?.[1]?.replaceAll('_', ''));
ok(`the write deadline is read from requestDeadline.ts (${writeMs} ms)`, Number.isFinite(writeMs) && writeMs > 0);
ok(`RACE_HOLD_MS (${RACE_HOLD_MS}) leaves at least 5 s under it`, RACE_HOLD_MS <= writeMs - 5_000);

if (failures) {
  console.error(`\n${failures} CC assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
