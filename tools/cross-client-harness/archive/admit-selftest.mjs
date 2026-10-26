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
  admitRefusedFor,
  admittedOwn,
  baseWithheldRepeats,
  advancedFor,
  commitStarts,
  connectionOpens,
  deviceRefusals,
  dockerInstant,
  declinedOwn,
  gateRefusals,
  isAwaitingRefusal,
  isPowerOfTen,
  memberRoutes,
  noAskOwn,
  oldBuildOwn,
  oldMemberOwn,
  outsiderOwn,
  perConnection,
  probeOwn,
  raceOwn,
  rateLimitedOwn,
  refusedCommits,
  refusedTracesFor,
  refusedWholeOwn,
  reinviteOwn,
  routeEnrolments,
  seatState,
  staleAddOwn,
  undatedAdmissions,
  welcomeRefusedFor,
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
const refusedClean = { gateRefused: 1, admitRefused: 1, welcomeRefused: 0, advanced: 0, welcomes: 0, undated: 0 };
ok('the Decline won and the Add was refused whole -> all hold', allOk(raceOwn({ outcomes: both, after: seatState(view(), J), listedTrail: [false, false], refusal: refusedClean })));
ok('the Decline won, refused by the inline-Welcome line alone -> all hold', allOk(raceOwn({ outcomes: both, after: seatState(view(), J), listedTrail: [false], refusal: { ...refusedClean, admitRefused: 0, welcomeRefused: 1 } })));
ok('the Decline won, the refused commit accepted after all -> fails', failing(raceOwn({ outcomes: both, after: seatState(view(), J), listedTrail: [false], refusal: { ...refusedClean, advanced: 1 } })) === 1);
ok('the Decline won, a Welcome queued for the joiner -> fails', failing(raceOwn({ outcomes: both, after: seatState(view(), J), listedTrail: [false], refusal: { ...refusedClean, welcomes: 1 } })) === 1);
ok('the Decline won, the joiner let back in undated -> fails (ADM-3c)', failing(raceOwn({ outcomes: both, after: seatState(view(), J), listedTrail: [false], refusal: { ...refusedClean, undated: 1 } })) === 1);
ok('the Add won: no refusal fact is asked of it, an undated Add included', allOk(raceOwn({ outcomes: both, after: seatState(admitted, J), listedTrail: [true], refusal: { gateRefused: 0, admitRefused: 0, welcomeRefused: 0, advanced: 1, welcomes: 1, undated: 1 } })));

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
const a6 = (over = {}) => oldMemberOwn({ admitted: seatState(admitted, J), listed: true, admissionErrors: 0, addedBy: 'W1', ...over });
ok('ADM-6: one refusal per connection holds, and is judged', allOk(a6({ refusalsPerConnection: [0, 1, 1] })) && a6({ refusalsPerConnection: [0, 1, 1] }).length === 4);
ok('ADM-6: two refusals in one connection is a wedge', failing(a6({ refusalsPerConnection: [1, 2] })) === 1);
ok('ADM-6: no refusal at all makes NO per-connection assertion (never a vacuous pass)', a6({ refusalsPerConnection: [] }).length === 3 && a6({ refusalsPerConnection: [0, 0] }).length === 3);
ok('ADM-6: the shim path asserts its ADMITTED_UNDATED line', allOk(a6({ addedBy: 'A1 (the shim)', shim: true, shimUndated: 1 })) && failing(a6({ addedBy: 'A1 (the shim)', shim: true, shimUndated: 0 })) === 1);
ok('ADM-6: the W1 path does not ask for it', a6({ shimUndated: 0 }).length === 3);
ok('perConnection: a refusal goes to the connection open at its instant', perConnection([5, 15, 16, 25], [10, 20]).join() === '1,2,1');
ok('perConnection: no opening is one bucket; openings are sorted', perConnection([1, 2], []).join() === '2' && perConnection([15], [20, 10]).join() === '0,1,0');
const NEST_AT = '10/25/2026, 9:17:22 PM';
const DS = '2026-10-25T21:17:22.123456789Z';
ok('dockerInstant: docker stamps read to the millisecond, a line without one is null', dockerInstant(`${DS} [Nest] 1  - x`) === Date.parse('2026-10-25T21:17:22.123Z') && dockerInstant('2026-10-25T21:17:22Z y') === Date.parse('2026-10-25T21:17:22Z') && dockerInstant(`[Nest] 1  - ${NEST_AT} x`) === null);
const A1U = 'aaaaaaaa' + 'f'.repeat(56);
const opened = (at, user = A1U, device = 'dev-a1') => `${at} 2026-10-25T21:17:22.400000Z  INFO chat_gateway::handlers: New WebSocket connection: User=${user}, Device=${device}, addressed_history=false, join_ask=false`;
ok('connectionOpens: docker instants, this user and device only', connectionOpens([opened('2026-10-25T21:17:22.500000000Z'), opened('2026-10-25T21:18:00.000000000Z', A1U, 'other'), opened('2026-10-25T21:18:00.000000000Z', 'e'.repeat(64))], A1U, 'dev-a1').join() === String(Date.parse('2026-10-25T21:17:22.500Z')));
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
const a10 = (over = {}) => staleAddOwn({ held: { ok: true }, declined: absent, trail: ['absent', 'absent'], after: absent, listed: false, ...refusedClean, routeEnrolled: 0, ...over });
ok('held, declined, refused whole at the gate, nothing enrolled -> all hold', allOk(a10()));
ok('the member-add route enrolling after the Decline fails (alpha.4)', failing(a10({ routeEnrolled: 1 })) === 1);
ok('no gate refusal fails', failing(a10({ gateRefused: 0 })) === 1);
ok('the commit not refused whole (no REJECT admit_refused) fails', failing(a10({ admitRefused: 0 })) === 1);
ok('the refused commit accepted after all fails', failing(a10({ advanced: 1 })) === 1);
ok('refused by the inline-Welcome line alone holds (that line fires first, admit_refused never)', allOk(a10({ admitRefused: 0, welcomeRefused: 1 })));
ok('neither refusal line fails', failing(a10({ admitRefused: 0, welcomeRefused: 0 })) === 1);
ok('a Welcome queued for the refused person fails', failing(a10({ welcomes: 2 })) === 1);
ok('an undated admission of the joiner fails (ADM-3c)', failing(a10({ undated: 1 })) === 1);
ok('the joiner left with a seat fails: not in no tree', failing(a10({ after: { state: 'absent', active: 1 } })) === 1);
ok('refusedWholeOwn alone: five assertions, all hold on a clean refusal', refusedWholeOwn({ ...refusedClean, after: absent }).length === 5 && allOk(refusedWholeOwn({ ...refusedClean, after: absent })));
ok('one admitted sample fails', failing(a10({ trail: ['absent', 'admitted', 'absent'] })) === 1);
ok('the commit never held fails', failing(a10({ held: { ok: false, error: 'timeout' } })) === 1);
const JU = 'bbbbbbbb' + 'c'.repeat(56);
const SINCE = 'departed_since_decision decidedAtSeatGeneration=3 decidedBy=invitation seat=none';
const UNDATED = 'departed_and_undated decidedBy=base_epoch seat=awaiting';
const gate = (reason, user = 'bbbbbbbb', group = G, trace = 'commit-7be79bc7', committer = 'aaaaaaaa') =>
  `[Nest] 1  - ${NEST_AT}     WARN [MessagingService] [ADD_MEMBER][${trace}] NOT_ENROLLED group=${group} user=${user} reason=${reason} committer=${committer} - the commit is refused whole`;
ok('gateRefusals: both Decline reasons about the joiner in the group count', gateRefusals([gate(SINCE), gate(UNDATED)], G, JU) === 2);
ok('gateRefusals: blocked and committer_not_on_roster do not', gateRefusals([gate('blocked'), gate('committer_not_on_roster')], G, JU) === 0);
ok('gateRefusals: another user or another group does not', gateRefusals([gate(SINCE, 'dddddddd'), gate(SINCE, 'bbbbbbbb', 'other-group')], G, JU) === 0);
ok('gateRefusals: the pre-#2505 line (its admits dropped) does not', gateRefusals([`WARN [MessagingService] [ADD_MEMBER][commit-7be79bc7] NOT_ENROLLED group=${G} user=bbbbbbbb reason=departed_since_decision committer=aaaaaaaa - its admits dropped, the leaf has no seat`], G, JU) === 0);
const reject = (reason = 'admit_refused', users = 'bbbbbbbb', group = G) =>
  `[Nest] 1  - ${NEST_AT}     WARN [MessagingService] [COMMIT][commit-7be79bc7] REJECT ${reason} group=${group} baseEpoch=4 users=${users} - the commit would give them a leaf no seat holds; nothing advanced`;
const rc = refusedCommits([reject(), reject('committer_not_on_roster', 'cccccccc'), reject('admit_refused', 'bbbbbbbb', 'other-group'), 'noise'], G);
ok('refusedCommits: this group only, with trace, reason, base epoch and users', rc.length === 2 && rc[0].trace === 'commit-7be79bc7' && rc[0].baseEpoch === 4 && rc[0].users.join() === 'bbbbbbbb' && rc[1].reason === 'committer_not_on_roster');
ok('admitRefusedFor: admit_refused naming the joiner counts, among several users', admitRefusedFor([reject(), reject('admit_refused', 'dddddddd,bbbbbbbb')], G, JU) === 2);
ok('admitRefusedFor: committer_not_on_roster, another user or group does not', admitRefusedFor([reject('committer_not_on_roster'), reject('admit_refused', 'dddddddd'), reject('admit_refused', 'bbbbbbbb', 'other-group')], G, JU) === 0);
const enrolled = (by, kind = 'ENROLLED by commit', user = 'bbbbbbbb') => `LOG [MessagingService] [ADD_MEMBER][commit-1a2b3c4d] ${kind} group=${G} user=${user} committer=aaaaaaaa decidedBy=${by}`;
ok('undatedAdmissions: ENROLLED and ADMITTED_UNDATED by base_epoch count', undatedAdmissions([enrolled('base_epoch'), `${enrolled('base_epoch', 'ADMITTED_UNDATED')} decidedAtSeatGeneration=2 seat=awaiting - an Add with no invitation generation answered an ask`], G, JU) === 2);
ok('undatedAdmissions: decidedBy=invitation, or another user, does not', undatedAdmissions([enrolled('invitation'), enrolled('base_epoch', 'ENROLLED by commit', 'dddddddd')], G, JU) === 0);
const wrefuse = (target = JU, trace = 'commit-8e8e8e8e', group = G) =>
  `[Nest] 1  - ${NEST_AT}     WARN [MessagingService] [COMMIT][${trace}] REJECT welcome_target_not_admitted group=${group} target=${target}:web-bbbb - the Welcome it carries is for a person this commit may not admit`;
ok('welcomeRefusedFor: the inline-Welcome refusal of the joiner counts (full id, matched by prefix)', welcomeRefusedFor([wrefuse()], G, JU) === 1);
ok('welcomeRefusedFor: another target or group does not', welcomeRefusedFor([wrefuse('d'.repeat(64)), wrefuse(JU, 'commit-8e8e8e8e', 'other-group')], G, JU) === 0);
const start = (trace, base, device = 'dev-a1', group = G) => `LOG [MessagingService] [COMMIT][${trace}] START group=${group} device=${device} baseEpoch=${base}`;
const accept = (trace, newEpoch, group = G) => `LOG [MessagingService] [COMMIT][${trace}] ACCEPT group=${group} newEpoch=${newEpoch}`;
const admits = (trace, devices) => `LOG [MessagingService] [COMMIT][${trace}] ADMITS group=${G} atEpoch=5 devices=${devices}`;
ok('commitStarts: trace -> device and base, this group only', commitStarts([start('commit-11111111', 4), start('commit-22222222', 4, 'x', 'other-group')], G).get('commit-11111111')?.baseEpoch === 4 && commitStarts([start('commit-22222222', 4, 'x', 'other-group')], G).size === 0);
ok('refusedTracesFor: both refusal paths, deduplicated', refusedTracesFor([reject(), wrefuse(), wrefuse()], G, JU).sort().join() === 'commit-7be79bc7,commit-8e8e8e8e');
const refusedAt4 = [start('commit-7be79bc7', 4), reject()];
ok('advancedFor: a clean refusal advanced nothing', advancedFor(refusedAt4, G, JU) === 0);
ok('advancedFor: an unrelated leaf refresh from the same base is not the refusal failing', advancedFor([...refusedAt4, start('commit-aaaa0001', 4), accept('commit-aaaa0001', 5)], G, JU) === 0);
ok('advancedFor: a rebuilt Add without the person is not either', advancedFor([...refusedAt4, start('commit-aaaa0002', 4), admits('commit-aaaa0002', 'dddddddd:web-d'), accept('commit-aaaa0002', 5)], G, JU) === 0);
ok('advancedFor: an ACCEPT of the refused trace itself counts', advancedFor([...refusedAt4, accept('commit-7be79bc7', 5)], G, JU) === 1);
ok('advancedFor: another trace from the same base admitting the person counts', advancedFor([...refusedAt4, start('commit-aaaa0003', 4), admits('commit-aaaa0003', `dddddddd:web-d,bbbbbbbb:web-b`), accept('commit-aaaa0003', 5)], G, JU) === 1);
ok('advancedFor: an admission of the person from a LATER base is not this refusal (the judges read the end state)', advancedFor([...refusedAt4, start('commit-aaaa0004', 6), admits('commit-aaaa0004', 'bbbbbbbb:web-b'), accept('commit-aaaa0004', 7)], G, JU) === 0);
const stamped = (at, line) => `${at} ${line}`;
const dr = deviceRefusals(
  [
    stamped('2026-10-25T21:17:20.000000000Z', start('commit-11111111', 4, 'dev-a1')),
    stamped('2026-10-25T21:17:21.250000000Z', reject('admit_refused', 'bbbbbbbb').replace('commit-7be79bc7', 'commit-11111111')),
    stamped('2026-10-25T21:17:21.300000000Z', reject('admit_refused', 'bbbbbbbb').replace('commit-7be79bc7', 'commit-11111111')),
    stamped('2026-10-25T21:17:22.000000000Z', start('commit-22222222', 4, 'dev-w1')),
    stamped('2026-10-25T21:17:23.000000000Z', reject('admit_refused', 'bbbbbbbb').replace('commit-7be79bc7', 'commit-22222222')),
    stamped('2026-10-25T21:17:24.000000000Z', start('commit-33333333', 4, 'dev-a1')),
    stamped('2026-10-25T21:17:25.500000000Z', wrefuse(JU, 'commit-33333333')),
  ],
  G,
  'dev-a1'
);
ok("deviceRefusals: one per refused trace of THIS device (W1's, the same user, is not A1's), both paths, docker instants", dr.join() === [Date.parse('2026-10-25T21:17:21.250Z'), Date.parse('2026-10-25T21:17:25.500Z')].join());
const done = (user = JU, group = G) => `LOG [MembersController] [ADD_MEMBER][add-member-c3adcdfe] DONE group=${group} user=${user} devices=6`;
ok('routeEnrolments: a DONE about the joiner in the group counts, case-folded', routeEnrolments([done(JU.toUpperCase())], G, JU) === 1);
ok('routeEnrolments: a DONE about another user or group does not', routeEnrolments([done('e'.repeat(64)), done(JU, 'other-group')], G, JU) === 0);
ok('ADM-10 orders two different members', ADMIT_ROWS['ADM-10'].stale.approve !== ADMIT_ROWS['ADM-10'].stale.decline);

if (failures) {
  console.error(`\n${failures} admission assertion(s) failed`);
  process.exit(1);
}
console.log('all good');
