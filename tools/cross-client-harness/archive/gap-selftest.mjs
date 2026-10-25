/**
 * THE GAP ROWS' PULL REWRITES AND JUDGEMENTS, PINNED (`gaprows.mjs`).
 *
 * A rewrite that drops the wrong row, or drops a whole page, makes a GAP row measure the rig instead
 * of the client - an empty page ends the client's drain (`pullPendingMessagesJson`), which would turn
 * GAP-1 into a member that simply received nothing. So each transform is driven on pages shaped as
 * `GET /api/mls/messages/:user/:device` answers them, and each judge on a clean outcome broken one
 * assertion at a time. Pure: no rig, no browser, no `names.mjs`.
 *
 *   bun archive/gap-selftest.mjs
 */
import {
  COMMIT_LOG,
  GAP4_SKIP,
  GAP_ROWS,
  PENDING_PULL,
  captureRows,
  dropCommitRows,
  gapOneOwn,
  injectRows,
  linesAbout,
  pastFrameOwn,
  readdressRow,
  startAfter,
  tooDistantOwn,
} from '../gaprows.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const allOk = (as) => as.length > 0 && as.every((a) => a.ok);

const G = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';
const row = (id, over = {}) => ({ id, groupId: G, isCommit: false, isWelcome: false, senderId: 'u1', createdAt: `2026-10-25T10:00:0${id.length % 10}.000Z`, ...over });

// ── the table ────────────────────────────────────────────────────────────────────────────────────
console.log('the table');
ok('the pull is matched by METHOD too (the ACK shares the prefix)', PENDING_PULL.method === 'GET' && COMMIT_LOG.method === 'GET');
ok('GAP-1 makes two commits, so its frames are N+2', GAP_ROWS['GAP-1'].adds.length === 2 && GAP_ROWS['GAP-1'].adds.every((d) => GAP_ROWS['GAP-1'].devices.includes(d)));
ok('GAP-2 goes past max_past_epochs (2)', GAP_ROWS['GAP-2'].pastEpochs > 2);
ok('GAP-3 skips past the forward distance (2000) and sends more than it skips', GAP_ROWS['GAP-3'].skip > 2000 && GAP_ROWS['GAP-3'].send > GAP_ROWS['GAP-3'].skip);
ok('GAP-4 is absent and its SKIPPED reason names the writer', !GAP_ROWS['GAP-4'] && /shared-payload writer/.test(GAP4_SKIP));

// ── GAP-1: the commits out of the pull ──────────────────────────────────────────────────────────
console.log('dropCommitRows');
{
  const page = [row('c1', { isCommit: true }), row('a1'), row('c2', { isCommit: true }), row('x1', { groupId: OTHER, isCommit: true }), row('a2')];
  const rec = {};
  const out = JSON.parse(dropCommitRows(G)(JSON.stringify(page), rec));
  ok("this group's commits are taken out", !out.some((r) => r.id === 'c1' || r.id === 'c2') && rec.dropped.join() === 'c1,c2');
  ok('its frames, and ANOTHER group\'s commit, stay', out.map((r) => r.id).join() === 'a1,x1,a2');
  ok('the group id is compared case-insensitively', JSON.parse(dropCommitRows(G.toUpperCase())(JSON.stringify(page), {})).length === 3);
  const onlyCommits = JSON.stringify([row('c1', { isCommit: true })]);
  const rec2 = {};
  ok('a page of nothing but its commits is passed whole - never an empty page', dropCommitRows(G)(onlyCommits, rec2) === onlyCommits && rec2.keptAllCommits === 1 && !rec2.dropped);
  ok('a page with nothing to drop is returned byte for byte', dropCommitRows(G)(JSON.stringify([row('a1')]), {}) === JSON.stringify([row('a1')]));
  ok('a body that is not a JSON array is passed through', dropCommitRows(G)('<html>', {}) === '<html>');
}

// ── GAP-2: capture, re-address, replay at the front ─────────────────────────────────────────────
console.log('captureRows / injectRows / readdressRow');
{
  const got = [];
  const text = JSON.stringify([row('a1'), row('b1', { senderId: 'u2' })]);
  ok('a capture changes nothing', captureRows((r) => r.senderId === 'u2', got)(text, {}) === text);
  ok('... and copies what its predicate selects', got.length === 1 && got[0].id === 'b1');
  const back = readdressRow(got[0], { recipientId: 'u2', deviceId: 'd2' });
  ok('a re-addressed row keeps its frame and changes only its address', back.id === 'b1' && back.recipientId === 'u2' && back.deviceId === 'd2' && back.senderId === 'u2');
  const rec = {};
  const out = JSON.parse(injectRows([row('old')])(JSON.stringify([row('n1'), row('n2')]), rec));
  ok('the replayed row goes IN FRONT, so the next page is asked after a genuine row', out.map((r) => r.id).join() === 'old,n1,n2');
  ok('... and the record names it', rec.injected.join() === 'old');
  ok('an empty page still carries the replay', JSON.parse(injectRows([row('old')])('[]', {})).length === 1);
}

// ── GAP-3: the first page starts after the cut ──────────────────────────────────────────────────
console.log('startAfter');
{
  const at = '2026-10-25T10:00:00.123Z';
  const moved = new URL(startAfter(at)('https://h/api/mls/messages/u/d?limit=500&caps=x'));
  ok('the first page is asked after the cut point', moved.searchParams.get('after') === at && moved.searchParams.get('limit') === '500' && moved.searchParams.get('caps') === 'x');
  const later = 'https://h/api/mls/messages/u/d?limit=500&after=2026-10-25T11%3A00%3A00.000Z';
  ok("a later page keeps the client's own paging", startAfter(at)(later) === later);
}

// ── the lines a GAP row reads ───────────────────────────────────────────────────────────────────
console.log('linesAbout');
const S = G.slice(0, 8);
const L = linesAbout(
  [
    `[GAP] ${S}… frozen behind >30s and rung-1 replay failed - forget + welcome_request`,
    { text: `[MLS] LOST frame for ${S}… from u1: generation too far ahead of our sender ratchet - x`, level: 'log' },
    `[MLS] Duplicate delivery for ${S}… - silent ACK (past epoch application frame, already read by live delivery, frame ab)`,
    `[MLS] Decryption error for ${S}… (unknown): x → re-add`,
    `[GAP] ${OTHER.slice(0, 8)}… live frame ahead`,
  ],
  G
);
ok('each kind is counted for THIS group only', L.gap.length === 1 && L.rung2.length === 1 && L.lost.length === 1 && L.generationGap.length === 1 && L.duplicate.length === 1 && L.reAdd.length === 1);

// ── the judges ──────────────────────────────────────────────────────────────────────────────────
console.log('GAP-1 judge');
const none = linesAbout([], G);
const gapOnly = linesAbout([`[GAP] ${S}… replaying`], G);
const g1 = (over = {}) => gapOneOwn({ dropped: ['c1', 'c2'], held: 1, shown: { m1: 1, m2: 1 }, lines: gapOnly, ...over });
ok('commits dropped, rung 1 held, every frame once -> all hold', allOk(g1()));
ok('a frame shown twice fails', !allOk(g1({ shown: { m1: 2, m2: 1 } })));
ok('a frame never shown (dropped by the client) fails', !allOk(g1({ shown: { m1: 0, m2: 1 } })));
ok('no gap met (the pull carried the commits) fails', !allOk(g1({ lines: none })));
ok('rung 1 never asked fails', !allOk(g1({ held: 0 })));
ok('a forget + re-Welcome where rung 1 should heal fails', !allOk(g1({ lines: linesAbout([`[GAP] ${S}… forget + welcome_request`], G) })));

console.log('GAP-2 judge');
const dup = linesAbout([`[MLS] Duplicate delivery for ${S}… - silent ACK (x)`], G);
const g2 = (over = {}) => pastFrameOwn({ injected: 2, epochBefore: 7, epochAfter: 7, shown: { a: 1, b: 1 }, lines: dup, ...over });
ok('classified a duplicate, nothing else, epoch still -> all hold', allOk(g2()));
ok('read as an epoch gap fails', !allOk(g2({ lines: linesAbout([`[MLS] Duplicate delivery for ${S}… x`, `[GAP] ${S}… x`], G) })));
ok('a re-add fails', !allOk(g2({ lines: linesAbout([`[MLS] Duplicate delivery for ${S}… x`, `[MLS] Decryption error for ${S}… (wrong-epoch): x → re-add`], G) })));
ok('the replay shown again fails', !allOk(g2({ shown: { a: 2, b: 1 } })));
// THE QUEUE ANSWERS FIRST for a row already taken in, and its line names no group (2026-10-25).
const QREP = (id) => `[QUEUE] delivery ${id.slice(0, 8)}... arrived twice - the pull listed a row this device had already acknowledged; not decrypting it again, acknowledging it once more`;
const qdup = linesAbout([QREP('cca6907d-d72c-49f7-a658-e38236608c2a')], G, ['cca6907d-d72c-49f7-a658-e38236608c2a']);
ok('a queue-level repeat of an INJECTED id is the classification', qdup.duplicate.length === 1 && allOk(g2({ lines: qdup })));
ok('control: a queue repeat of an id that was NOT injected is not', linesAbout([QREP('deadbeef-0000-0000-0000-000000000000')], G, ['cca6907d-d72c-49f7-a658-e38236608c2a']).duplicate.length === 0);
ok('control: with no injected ids a queue repeat counts for nothing', linesAbout([QREP('cca6907d-d72c-49f7-a658-e38236608c2a')], G).duplicate.length === 0);
ok('an epoch that moved fails', !allOk(g2({ epochAfter: 8 })));
ok('nothing injected fails', !allOk(g2({ injected: 0 })));

console.log('GAP-3 judge');
const far = linesAbout([`[MLS] LOST frame for ${S}… from u1: generation too far ahead of our sender ratchet - x`], G);
const g3 = (over = {}) => tooDistantOwn({ skipped: 2050, cutAt: '2026-10-25T10:00:00.000Z', lines: far, ...over });
ok('a generation gap, no epoch-gap loop -> all hold', allOk(g3()));
ok('read as an epoch gap fails', !allOk(g3({ lines: linesAbout([`[MLS] LOST frame for ${S}… generation too far ahead`, `[GAP] ${S}… x`], G) })));
ok('no generation gap named fails', !allOk(g3({ lines: none })));
ok('a skip inside the forward distance fails (nothing proved)', !allOk(g3({ skipped: 1500 })));
ok('no cut point fails', !allOk(g3({ cutAt: null })));

if (failures) {
  console.error(`\n${failures} GAP assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
