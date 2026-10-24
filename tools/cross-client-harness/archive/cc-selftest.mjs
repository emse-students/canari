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
import { CC5_PREMISE, CC_ROWS, doubleRemoveOwn, parseCommitLines, rebuiltRaceOwn, refreshRaceOwn } from '../ccrows.mjs';

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
ok('CC-5 is absent and says why', !CC_ROWS['CC-5'] && /fifth campaign account/.test(CC5_PREMISE));

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
ok('a LOCK refusal fails, and says it is a question for the row', failed(r({ parsed: parseCommitLines([ACCEPT('a', 4), LOCKED('b', 4), ACCEPT('b2', 5)]) })).some((w) => /concurrent_commit/.test(w) && /question/.test(w)));
ok('two refusals fail', !allOk(r({ parsed: parseCommitLines([ACCEPT('a', 4), MISMATCH('b', 3, 4), MISMATCH('b2', 3, 4), ACCEPT('b3', 5)]) })));
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

if (failures) {
  console.error(`\n${failures} CC assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
