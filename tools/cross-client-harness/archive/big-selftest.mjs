/**
 * THE LARGE-GROUP ROWS' OWN JUDGEMENTS, PINNED (`bigrows.mjs`).
 *
 * Each row's question answered on a clean outcome and broken one assertion at a time, so a judgement
 * that stops firing has its symptom here, where on a live estate it would have none. Pure: no rig, no
 * browser, no `names.mjs`.
 *
 *   bun archive/big-selftest.mjs
 */
import { BIG_ROWS, BIG_SEATS, bulkAddOwn, burstOwn, checkpointMs, communityEntitlement, inSendOrder, seedPerEventOwn, sessionsByPhase } from '../bigrows.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const allOk = (as) => as.length > 0 && as.every((a) => a.ok);
const failing = (as) => as.filter((a) => !a.ok).length;

// ── the table ───────────────────────────────────────────────────────────────────────────────────
ok('every seat of the rig is in play, the two phones included', BIG_SEATS.length === 10 && BIG_SEATS.includes('A1') && BIG_SEATS.includes('I1'));
ok('every row uses every seat', Object.values(BIG_ROWS).every((r) => r.devices === BIG_SEATS));
ok('BIG-2: three senders, thirty messages, two commits inside the burst', BIG_ROWS['BIG-2'].senders.length === 3 && BIG_ROWS['BIG-2'].perSender * 3 === 30 && BIG_ROWS['BIG-2'].commitsBefore.every((i) => i > 0 && i < BIG_ROWS['BIG-2'].perSender));
ok('BIG-3: the removed and the newcomer are different seats, neither a sender', BIG_ROWS['BIG-3'].removed !== BIG_ROWS['BIG-3'].newcomer && !BIG_ROWS['BIG-3'].senders.includes(BIG_ROWS['BIG-3'].removed));

// ── checkpointMs ────────────────────────────────────────────────────────────────────────────────
ok('checkpointMs reads every duration, in order', JSON.stringify(checkpointMs(['x', '[MLS] Encrypted state checkpoint persisted. (1412 ms)', '[MLS] Encrypted state checkpoint persisted. (88 ms)'])) === '[1412,88]');
ok('checkpointMs skips a line with no duration', checkpointMs(['[MLS] Encrypted state checkpoint persisted.']).length === 0);

// ── BIG-1 ───────────────────────────────────────────────────────────────────────────────────────
const add = { accepts: 1, listed: { W1: 0, W2: 3_000, A1: 9_000 }, shown: { W1: 1, W2: 1, A1: 1 }, checkpoints: { A1: [1400], I1: [900] } };
ok('BIG-1: one commit, everyone listed and reading once, both phones timed passes', allOk(bulkAddOwn(add)));
ok('BIG-1: two commits fails - the Add was not bulk', failing(bulkAddOwn({ ...add, accepts: 2 })) === 1);
ok('BIG-1: a device that never listed fails', failing(bulkAddOwn({ ...add, listed: { ...add.listed, W2: null } })) === 1);
ok('BIG-1: the first message twice fails', failing(bulkAddOwn({ ...add, shown: { ...add.shown, A1: 2 } })) === 1);
ok('BIG-1: a phone with no checkpoint line fails', failing(bulkAddOwn({ ...add, checkpoints: { A1: [1400], I1: [] } })) === 1);

// ── BIG-2 ───────────────────────────────────────────────────────────────────────────────────────
ok('inSendOrder: increasing positions are in order', inSendOrder({ W1: [1, 4, 9] }).W1 === true);
ok('inSendOrder: a swap is not', inSendOrder({ W1: [1, 9, 4] }).W1 === false);
ok('inSendOrder: a missing message is not', inSendOrder({ W1: [1, undefined, 4] }).W1 === false);
const burst = { accepts: 2, expectedCommits: 2, perDevice: { W1: { counts: { a: 1, b: 1 }, ordered: { W1: true, W2: true } }, A1: { counts: { a: 1, b: 1 }, ordered: { W1: true, W2: true } } } };
ok('BIG-2: two commits, all once, all in order passes', allOk(burstOwn(burst)));
ok('BIG-2: one commit fails - the burst missed one', failing(burstOwn({ ...burst, accepts: 1 })) === 1);
ok('BIG-2: a duplicate on one device fails', failing(burstOwn({ ...burst, perDevice: { ...burst.perDevice, A1: { ...burst.perDevice.A1, counts: { a: 2, b: 1 } } } })) === 1);
ok('BIG-2: a loss on one device fails', failing(burstOwn({ ...burst, perDevice: { ...burst.perDevice, A1: { ...burst.perDevice.A1, counts: { a: 0, b: 1 } } } })) === 1);
ok('BIG-2: one sender out of order fails', failing(burstOwn({ ...burst, perDevice: { ...burst.perDevice, W1: { ...burst.perDevice.W1, ordered: { W1: true, W2: false } } } })) === 1);

// ── BIG-3 ───────────────────────────────────────────────────────────────────────────────────────
const S1 = '11111111-0000-0000-0000-000000000001';
const S2 = '22222222-0000-0000-0000-000000000002';
const cuts = ['2026-10-25T10:00:00.000Z', '2026-10-25T11:00:00.000Z'];
const rows = [
  { authorId: S1, sessionId: 'a0', at: '2026-10-25T09:00:00.000Z' },
  { authorId: S1, sessionId: 'a0', at: '2026-10-25T09:30:00.000Z' },
  { authorId: S1, sessionId: 'a1', at: '2026-10-25T10:30:00.000Z' },
  { authorId: S1, sessionId: 'a2', at: '2026-10-25T11:30:00.000Z' },
  { authorId: S2, sessionId: 'b0', at: '2026-10-25T09:00:00.000Z' },
  { authorId: S2, sessionId: 'b1', at: '2026-10-25T10:30:00.000Z' },
  { authorId: S2, sessionId: 'b2', at: '2026-10-25T11:30:00.000Z' },
];
const sessions = sessionsByPhase(rows, cuts);
ok('sessionsByPhase cuts at each event', JSON.stringify(sessions[S1]) === JSON.stringify([['a0'], ['a1'], ['a2']]));
ok('sessionsByPhase puts an instant ON a cut in the later phase', sessionsByPhase([{ authorId: S1, sessionId: 'x', at: cuts[0] }], cuts)[S1][1][0] === 'x');
const seed = { sessions, senders: [S1, S2], removedShown: { W4: 0, W8: 0 }, removedSeated: false, newcomer: { before: 0, after: 4 }, afterExpected: 4 };
ok('BIG-3: one session per phase per sender, nothing leaked, newcomer from its admission passes', allOk(seedPerEventOwn(seed)));
const perEpoch = sessionsByPhase([...rows, { authorId: S1, sessionId: 'a1b', at: '2026-10-25T10:40:00.000Z' }], cuts);
ok('BIG-3: a second session inside one phase fails - a seed per epoch, not per event', failing(seedPerEventOwn({ ...seed, sessions: perEpoch })) === 2);
const noRotate = sessionsByPhase(rows.map((r) => (r.authorId === S2 ? { ...r, sessionId: 'b0' } : r)), cuts);
ok('BIG-3: no rotation on an event fails', failing(seedPerEventOwn({ ...seed, sessions: noRotate })) === 1);
ok('BIG-3: a sender with no messages in a phase fails', failing(seedPerEventOwn({ ...seed, sessions: { ...sessions, [S2]: [['b0'], [], ['b2']] } })) === 2);
ok('BIG-3: the removed device reading after its removal fails', failing(seedPerEventOwn({ ...seed, removedShown: { W4: 0, W8: 1 } })) === 1);
ok('BIG-3: the removed account still seated fails', failing(seedPerEventOwn({ ...seed, removedSeated: true })) === 1);
ok('BIG-3: the newcomer reading the past fails', failing(seedPerEventOwn({ ...seed, newcomer: { before: 2, after: 4 } })) === 1);
ok('BIG-3: the newcomer missing what came after fails', failing(seedPerEventOwn({ ...seed, newcomer: { before: 0, after: 3 } })) === 1);

// ── the community invariant ─────────────────────────────────────────────────────────────────────
const dist = { devices: [{ userId: S1, status: 'active' }, { userId: S2, status: 'active' }] };
ok('community: members seated and nobody else holds', communityEntitlement({ pass: 'p', dist, members: [S1, S2], users: [S1, S2] }).ok);
ok('community: a removed user still seated breaks it', !communityEntitlement({ pass: 'p', dist, members: [S1], users: [S1, S2] }).ok);
ok('community: a member with no seat breaks it', !communityEntitlement({ pass: 'p', dist: { devices: [dist.devices[0]] }, members: [S1, S2], users: [S1, S2] }).ok);
ok('community: an unread group breaks it', !communityEntitlement({ pass: 'p', dist: null, members: [], users: [] }).ok);

if (failures) {
  console.error(`\n${failures} large-group assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
