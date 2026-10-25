/**
 * THE ADMISSION ROWS' OWN JUDGEMENTS AND THE WAITING SEAT'S ROUTE TABLE, PINNED (`admitrows.mjs`).
 *
 * Each row's question answered on a clean outcome and broken one assertion at a time, so a judgement
 * that stops firing has its symptom here, where on a live estate it would have none. Pure: no rig, no
 * browser, no `names.mjs`.
 *
 *   bun archive/admit-selftest.mjs
 */
import {
  ADMIT_ROWS,
  OLD_REF,
  admittedOwn,
  baseWithheldRepeats,
  declinedOwn,
  isAwaitingRefusal,
  isPowerOfTen,
  memberRoutes,
  noAskOwn,
  oldBuildOwn,
  oldMemberOwn,
  outsiderOwn,
  probeOwn,
  raceOwn,
  rateLimitedOwn,
  reinviteOwn,
  seatState,
  staleAddOwn,
} from '../admitrows.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const allOk = (as) => as.length > 0 && as.every((a) => a.ok);
const failing = (as) => as.filter((a) => !a.ok).length;

const G = '11111111-2222-3333-4444-555555555555';
const J = 'u4444444-jjjj';
const REFUSED = { status: 409, body: '{"error":"awaiting_admission","message":"..."}' };
const view = (rows = [], seats = []) => ({ roster: rows, seats });
const waiting = view([{ userId: J, awaitingAdmission: true }]);
const admitted = view([{ userId: J, awaitingAdmission: false }], [{ userId: J, deviceId: 'd', status: 'active', kicked: false }]);

// ── the table ────────────────────────────────────────────────────────────────────────────────────
console.log('the table');
const rows = Object.entries(ADMIT_ROWS);
ok('every row has an owner it opens, and a setup of seats it opens', rows.every(([, r]) => r.devices.includes(r.owner) && (r.setup ?? []).every((d) => r.devices.includes(d))));
ok('a joiner is never in the setup, nor the owner', rows.every(([, r]) => !r.joiner || (r.joiner !== r.owner && !(r.setup ?? []).includes(r.joiner))));
ok('A1 (the OWNER) never joins or stays outside a group the owner is in', ['ADM-5', 'ADM-7'].every((k) => ADMIT_ROWS[k].owner !== 'W1' && !ADMIT_ROWS[k].setup.includes('W1')));
ok('the old rows name the old seat and the tag', ['ADM-5', 'ADM-6', 'ADM-7'].every((k) => ADMIT_ROWS[k].old === 'A1') && OLD_REF === 'v1.4.0');
ok('ADM-3 races two different members', ADMIT_ROWS['ADM-3'].race.approve !== ADMIT_ROWS['ADM-3'].race.decline);

// ── the route table ──────────────────────────────────────────────────────────────────────────────
console.log('memberRoutes');
const routes = memberRoutes(G, { enrolUser: 'u5', vouchUser: 'u5', vouchDevice: 'd5' });
const named = routes.map((r) => r.what);
ok('every route the plan names is called', ['roster', 'members', 'enrol someone', 'mint a link', 'vouch', 'history', 'exclusions', 'call initiate', 'call ring'].every((w) => named.includes(w)));
ok('every path is under /api/ and group routes name the group', routes.every((r) => r.path.startsWith('/api/')) && routes.filter((r) => r.path.includes('/groups/')).every((r) => r.path.includes(G)));
ok('a POST carries a body, a GET none', routes.every((r) => (r.method === 'POST') === (r.body !== undefined)));
ok('the 409 awaiting_admission is the only refusal read as one', isAwaitingRefusal(REFUSED) && !isAwaitingRefusal({ status: 403, body: 'awaiting_admission' }) && !isAwaitingRefusal({ status: 409, body: 'conflict' }));

// ── seatState ────────────────────────────────────────────────────────────────────────────────────
console.log('seatState');
ok('waiting, admitted, absent', seatState(waiting, J).state === 'waiting' && seatState(admitted, J).state === 'admitted' && seatState(view(), J).state === 'absent');
ok('compared case-folded', seatState(admitted, J.toUpperCase()).active === 1);

// ── ADM-1 ────────────────────────────────────────────────────────────────────────────────────────
console.log('ADM-1 admittedOwn');
const a1 = (over = {}) => admittedOwn({ waitingText: true, base: REFUSED, waitingSeat: 'waiting', asks: { W1: 900, W2: 1200 }, admitted: seatState(admitted, J), listed: true, gone: { W1: 3000, W2: 5000 }, ...over });
ok('waiting, refused, asked twice, admitted, listed, gone twice -> all hold', allOk(a1()));
ok('the base answered 200 fails', failing(a1({ base: { status: 200, body: 'x' } })) === 1);
ok('one member never shown the ask fails', failing(a1({ asks: { W1: 900, W2: null } })) === 1);
ok('an ask that stays on a screen fails', failing(a1({ gone: { W1: 3000, W2: null } })) === 1);
ok('still waiting after the Add fails', failing(a1({ admitted: seatState(waiting, J) })) === 1);

// ── ADM-2 ────────────────────────────────────────────────────────────────────────────────────────
console.log('ADM-2 declinedOwn');
const a2 = (over = {}) => declinedOwn({ asks: { W1: 1, W2: 1 }, after: seatState(view(), J), excluded: false, listed: false, shown: 0, ...over });
ok('withdrawn and nothing more -> all hold', allOk(a2()));
ok('an exclusion written fails', failing(a2({ excluded: true })) === 1);
ok('a roster row left fails', failing(a2({ after: seatState(waiting, J) })) === 1);
ok('the joiner reading the conversation fails twice', failing(a2({ listed: true, shown: 1 })) === 2);

// ── ADM-3 ────────────────────────────────────────────────────────────────────────────────────────
console.log('ADM-3 raceOwn');
const both = { W1: { ok: true }, W2: { ok: true } };
ok('the Add won: admitted, listed throughout the end -> all hold', allOk(raceOwn({ outcomes: both, after: seatState(admitted, J), listedTrail: [false, true, true] })));
ok('the Decline won: absent, never listed -> all hold', allOk(raceOwn({ outcomes: both, after: seatState(view(), J), listedTrail: [false, false] })));
ok('listed then not: an admitted person stripped', failing(raceOwn({ outcomes: both, after: seatState(view(), J), listedTrail: [false, true, false] })) === 1);
ok('admitted on the server, not listed: the two sides disagree', failing(raceOwn({ outcomes: both, after: seatState(admitted, J), listedTrail: [false, false] })) === 1);

// ── ADM-4 ────────────────────────────────────────────────────────────────────────────────────────
console.log('ADM-4 probeOwn');
const answers = routes.map((r) => ({ what: r.what, method: r.method, ...REFUSED }));
ok('every route refused, still waiting, nobody enrolled -> all hold', allOk(probeOwn({ answers, after: seatState(waiting, J), enrolled: 'absent' })));
ok('one route answering 200 fails', failing(probeOwn({ answers: [...answers.slice(1), { what: 'roster', method: 'GET', status: 200, body: '[]' }], after: seatState(waiting, J), enrolled: 'absent' })) === 1);
ok('a route answering 403 is not the waiting refusal', failing(probeOwn({ answers: [{ what: 'x', method: 'GET', status: 403, body: 'awaiting_admission' }], after: seatState(waiting, J), enrolled: 'absent' })) === 1);
ok('the seat admitted by its own calls fails', failing(probeOwn({ answers, after: seatState(admitted, J), enrolled: 'absent' })) === 1);
ok('someone enrolled by the waiting seat fails', failing(probeOwn({ answers, after: seatState(waiting, J), enrolled: 'admitted' })) === 1);

// ── the old rows ─────────────────────────────────────────────────────────────────────────────────
console.log('the old rows');
ok('the old build is matched by commit prefix', allOk(oldBuildOwn({ device: 'A1', build: { commit: 'abc1234' }, oldCommit: 'abc1234def' })));
ok('a new build on the old row fails', failing(oldBuildOwn({ device: 'A1', build: { commit: 'fff9999' }, oldCommit: 'abc1234def' })) === 1);
ok('no tag in this checkout fails', failing(oldBuildOwn({ device: 'A1', build: { commit: 'abc1234' }, oldCommit: null })) === 1);
const nest = (s) => `[Nest] 1  - LOG [MessagingService] ${s}`;
const withheld = (n, g = G) => nest(`[GROUP_INFO] group=${g} user=u awaits a member's admission - base withheld (repeat=${n}, said at 1, 10, 100...)`);
ok('repeats parsed for this group only', baseWithheldRepeats([withheld(1), withheld(10), withheld(1, 'other'), 'noise'], G).join() === '1,10');
ok('powers of ten only', [1, 10, 100, 1000].every(isPowerOfTen) && ![0, 2, 11, 20, NaN].some(isPowerOfTen));
ok('rate-limited lines hold', allOk(rateLimitedOwn([1, 10])));
ok('a line per retry fails', failing(rateLimitedOwn([1, 2, 3])) === 1);
ok('no line at all fails', failing(rateLimitedOwn([])) === 1);
ok('ADM-6: admitted by the shim, no error -> all hold', allOk(oldMemberOwn({ admitted: seatState(admitted, J), listed: true, admissionErrors: 0, addedBy: 'A1 (the shim)' })));
ok('ADM-6: an [ADMISSION] ERROR fails', failing(oldMemberOwn({ admitted: seatState(admitted, J), listed: true, admissionErrors: 1, addedBy: 'W1' })) === 1);
const out7 = (over = {}) => outsiderOwn({ base: { status: 403 }, uninvited: 0, notices: 0, after: seatState(view(), J), ...over });
ok('ADM-7: refused, silent, absent -> all hold', allOk(out7()));
ok('ADM-7: the base served fails', failing(out7({ base: { status: 200 } })) === 1);
ok('ADM-7: an uninvited-entry line fails', failing(out7({ uninvited: 1 })) === 1);
ok('ADM-7: a notice on a member fails', failing(out7({ notices: 1 })) === 1);

// ── ADM-8 ────────────────────────────────────────────────────────────────────────────────────────
console.log('ADM-8 noAskOwn');
const absent = seatState(view(), J);
ok('the mint refused on a 1:1 -> all hold', allOk(noAskOwn([{ kind: 'direct', mint: { status: 400 }, accept: null, askLines: 0, after: absent }])));
ok('minted, the accept refused -> all hold', allOk(noAskOwn([{ kind: 'key-group', mint: { status: 201 }, accept: { status: 404 }, askLines: 0, after: absent }])));
ok('minted and accepted fails', failing(noAskOwn([{ kind: 'direct', mint: { status: 201 }, accept: { status: 201 }, askLines: 0, after: absent }])) === 1);
ok('an ask raised fails', failing(noAskOwn([{ kind: 'direct', mint: { status: 400 }, accept: null, askLines: 1, after: absent }])) === 1);
ok('a waiting seat written fails', failing(noAskOwn([{ kind: 'direct', mint: { status: 400 }, accept: null, askLines: 0, after: seatState(waiting, J) }])) === 1);
ok('a kind with no conversation to mint on is a failure, not a pass', failing(noAskOwn([{ kind: 'key-group', missing: 'none' }])) === 1);

// ── ADM-9 ────────────────────────────────────────────────────────────────────────────────────────
console.log('ADM-9 reinviteOwn');
const a9 = (over = {}) => reinviteOwn({ declined: absent, rewaiting: 'waiting', asks: { W1: 900, W2: 1200 }, admitted: seatState(admitted, J), listed: true, ...over });
ok('declined, waiting again, asked, admitted, listed -> all hold', allOk(a9()));
ok('the second link refused (no waiting seat) fails', failing(a9({ rewaiting: 'absent' })) === 1);
ok('the Add after the Decline not admitting fails', failing(a9({ admitted: absent })) === 1);
ok('the first ask never declined fails', failing(a9({ declined: seatState(waiting, J) })) === 1);

// ── ADM-10 ───────────────────────────────────────────────────────────────────────────────────────
console.log('ADM-10 staleAddOwn');
const a10 = (over = {}) => staleAddOwn({ held: { ok: true }, declined: absent, trail: ['absent', 'absent'], after: absent, listed: false, gateRefused: 1, routeEnrolled: 0, ...over });
ok('held, declined, refused at the gate, nothing enrolled -> all hold', allOk(a10()));
ok('the member-add route enrolling after the Decline fails (alpha.4)', failing(a10({ routeEnrolled: 1 })) === 1);
ok('no gate refusal fails', failing(a10({ gateRefused: 0 })) === 1);
ok('one admitted sample fails', failing(a10({ trail: ['absent', 'admitted', 'absent'] })) === 1);
ok('the commit never held fails', failing(a10({ held: { ok: false, error: 'timeout' } })) === 1);
ok('ADM-10 orders two different members', ADMIT_ROWS['ADM-10'].stale.approve !== ADMIT_ROWS['ADM-10'].stale.decline);

if (failures) {
  console.error(`\n${failures} admission assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
