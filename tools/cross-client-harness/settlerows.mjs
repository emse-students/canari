/**
 * THE SETTLEMENT ROWS OF THE 1.4.1 CAMPAIGN - DUP, OFF-1/-2, TOK - their table and their judges.
 *
 * Pure, so `archive/settle-selftest.mjs` pins every judge on a checkout with no rig; the action is
 * `archive/settle.mjs`. `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2 is the plan, and the
 * mechanism every row exercises is commit settlement (#2269, `BaseMlsService.runCommitTransaction`):
 * a commit whose ANSWER the client did not read is KEPT staged, resubmitted with the same bytes, and
 * the gate answers an accepted one `duplicate`.
 *
 * THE EVIDENCE IS THE GATE'S OWN LOG, IN ORDER. `[COMMIT][trace] ACCEPT | REJECT <reason> | DUPLICATE`
 * for the row's group, read after the invariant (`commitSequence`). The client's narration of the
 * same settlement (`[COMMIT] <group>... resubmission of the commit from epoch N: <verdict>`) is what
 * the runner WAITS on between steps - a fact the client states, never a sleep.
 *
 * What each row does that the plan did not spell out, and why, is on the row's `note`.
 */
import { activeSeats, onRoster } from './ccrows.mjs';
import { commitsSince } from './rowkit.mjs';

/**
 * The rows `archive/settle.mjs` plays. `subject` is the commit under test: W1 Adds `subject`'s user to
 * the row's group. `setup` are seats W1 Adds first, unfaulted. `side` mints a SECOND group holding W2,
 * for the rows whose question is about another conversation. `cut` means the row takes W1 off the
 * network (`net.mjs` `armCut` at the start, `cutHard` in the row).
 */
export const SETTLE_ROWS = {
  'DUP-1': {
    devices: ['W1', 'W2'],
    setup: [],
    subject: 'W2',
    what: 'the commit lands and its answer is lost: kept, resubmitted, answered duplicate, merged once',
  },
  'DUP-2': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    setup: ['W4', 'W5'],
    subject: 'W2',
    intervening: { by: 'W4', remove: 'W5' },
    what: 'DUP-1, and W4 commits between the lost answer and the resubmission: still duplicate, past base + 1',
    note:
      "W4's commit is a Remove of W5, never an Add: W1's Add holds the group's add lock while its resubmission is held, so a second Add is refused at the lock ('Add-lock busy', alpha.4 2026-10-25) - that case is CC-1's. A Remove takes no add lock (CC-2), so the row now covers a Remove beside a held Add",
  },
  'DUP-4': {
    devices: ['W1', 'W2'],
    setup: [],
    subject: 'W2',
    what: 'a resubmission answered 409 SEAT_CLAIM_OVERTAKEN: the stage is kept, not rebuilt; the next settlement decides',
  },
  'DUP-5': {
    devices: ['W1', 'W2', 'W4'],
    setup: ['W2'],
    subject: 'W4',
    side: true,
    cut: true,
    what: 'the commit answered 503: unknown, kept, sends blocked in that group only, settled at the next gateway connection',
    note: 'the subject is an Add of W4, not W2: W2 must already hold the group to show that a send there is blocked, and the side group is where it must not be',
  },
  'DUP-6': {
    devices: ['W1', 'W2'],
    setup: [],
    subject: 'W2',
    side: true,
    what: 'the commit never answers (write deadline) twice: the stage is kept, and decrypts in another group flow during the hold',
  },
  'OFF-1': {
    devices: ['W1', 'W2'],
    setup: [],
    subject: 'W2',
    cut: true,
    what: 'cut after the stage, before the POST leaves: the reconnection resubmits, accepted, merged once',
  },
  'OFF-2': {
    devices: ['W1', 'W2'],
    setup: [],
    subject: 'W2',
    cut: true,
    what: 'cut after the POST reached the server: the reconnection resubmits and is answered duplicate',
    note: "`hold-answer` then `fail()` once the cut is in place - a bare `lose-answer` would let the immediate resubmission through before the cut",
  },
  'TOK-1': {
    devices: ['W1', 'W2'],
    setup: [],
    subject: 'W2',
    what: 'the commit POST answered 401 once: refresh, the same bytes again, merged once, no logout',
    note: '`status-unsent 401`, not `status 401`: a real 401 comes from the auth guard BEFORE the gate, so the server never saw the request',
  },
  'TOK-2': {
    devices: ['W1', 'W2'],
    setup: [],
    subject: 'W2',
    what: 'the renewal a 401 needs fails as TRANSPORT: no logout; the request did nothing, so the stage is cleared and the gesture fails typed (#2420)',
  },
  'TOK-3': {
    devices: ['W1', 'W2'],
    setup: [],
    subject: 'W2',
    cut: true,
    waitMinutes: 61,
    what: 'the access token expires with the socket open, then a commit and a reconnection: re-authenticated, settled',
  },
};

/** DUP-3 is decided, not forgotten: the runner records it `SKIPPED` with this reason (plan Q2). */
export const DUP3_SKIP =
  "not played on the bench (plan Q2, settled 2026-10-24): the stall must be INSIDE the server's commit transaction, which no client-side fault reaches; unit coverage stands in";

/** DUP-7 is played by the device-enrolment runner, which owns a wipeable W3 and its PIN. */
export const DUP7_ELSEWHERE = 'DUP-7 needs a NEW device (W3, wipeable, PIN): it is played by the device runner, not here';

/** The 409 body the server's seat-claim gate answers (`ConflictException`), which the client types by its `code`. */
export const SEAT_CLAIM_OVERTAKEN_BODY = {
  code: 'SEAT_CLAIM_OVERTAKEN',
  message: 'this commit is not accepted',
  error: 'seat_claim_overtaken',
};

/**
 * The gate's decisions for one group, IN ORDER - an ordered list, because DUP-2 and OFF-1 are about
 * WHEN a decision came relative to another, which `parseCommitLines`' three arrays cannot say.
 *
 * @param {string[]} lines `commitLines(group, since)` output
 * @returns {{kind: 'ACCEPT'|'REJECT'|'DUPLICATE', trace: string, newEpoch?: number, reason?: string}[]}
 */
export function commitSequence(lines) {
  const out = [];
  for (const l of lines ?? []) {
    const m = /\[COMMIT\]\[([^\]]+)\] (ACCEPT|REJECT|DUPLICATE)\b(?: (\S+))?(.*)$/.exec(l);
    if (!m) continue;
    const [, trace, kind, word, rest] = m;
    if (kind === 'ACCEPT') out.push({ kind, trace, newEpoch: Number(/newEpoch=(\d+)/.exec(`${word ?? ''}${rest}`)?.[1] ?? NaN) });
    else if (kind === 'REJECT') out.push({ kind, trace, reason: word ?? '' });
    else out.push({ kind, trace });
  }
  return out;
}

const count = (seq, kind) => seq.filter((d) => d.kind === kind).length;

/**
 * The client lines a settlement row PROVOKES on W1, scoped to the row's group by its short id - the
 * client narrating the very fault the row armed. Forgiven on W1 only (`observersOf` `logs`), and
 * nothing that names another group.
 *
 * @param {string} groupId
 */
export function settleNarration(groupId) {
  const short = String(groupId).slice(0, 8);
  return [
    `[COMMIT] ${short}... no answer to the commit from epoch`,
    `[COMMIT] ${short}... resubmission of the commit from epoch`,
    /^\[COMMIT\] settling \d+ staged commit\(s\) by resubmission$/,
  ];
}

/** The needle `awaitLine` waits on for the client's own verdict on a resubmission of the commit from `fromEpoch`. */
export const resubmissionLine = (groupId, fromEpoch, verdict) =>
  `[COMMIT] ${String(groupId).slice(0, 8)}... resubmission of the commit from epoch ${fromEpoch}: ${verdict}`;

/**
 * THE COMMON CORE OF EVERY SETTLEMENT ROW: the commit under test landed ONCE, whatever the client
 * read of it, and its joiner is in.
 *
 * @param {object} p
 * @param {number} p.fromEpoch the server's epoch before the commit under test
 * @param {object} p.view `serverView` after the invariant
 * @param {ReturnType<typeof commitSequence>} p.seq the gate's decisions since the commit was started
 * @param {string[]} p.joined users that must be on the roster with an active seat
 * @param {string[]} [p.removed] users the row removed, that must be off the roster with no active seat
 * @param {number} [p.accepts] commits that must be accepted (1; DUP-2 has W4's as well)
 * @param {number} [p.minDuplicates] the resubmissions that must have been answered `duplicate`
 * @param {number} [p.maxDuplicates] ... and at most (OFF-1: 0, its first request never left)
 */
export function settledOnce({ fromEpoch, view, seq, joined, removed = [], accepts = 1, minDuplicates = 1, maxDuplicates = Infinity }) {
  const out = [];
  const acc = seq.filter((d) => d.kind === 'ACCEPT');
  const dup = count(seq, 'DUPLICATE');
  const rejects = seq.filter((d) => d.kind === 'REJECT').map((d) => d.reason);
  out.push({ what: `${accepts} commit(s) accepted, never a second epoch for one commit (${acc.length})`, ok: acc.length === accepts });
  out.push({ what: `the first accepted commit moved ${fromEpoch} -> ${fromEpoch + 1} (${acc[0]?.newEpoch ?? 'none'})`, ok: acc[0]?.newEpoch === fromEpoch + 1 });
  out.push({
    what: `resubmissions answered duplicate: ${dup} (${minDuplicates}${maxDuplicates === Infinity ? '+' : `..${maxDuplicates}`})`,
    ok: dup >= minDuplicates && dup <= maxDuplicates,
  });
  out.push({ what: `nothing refused - a kept commit is settled, never rebuilt (${rejects.join(',') || 'none'})`, ok: rejects.length === 0 });
  out.push({ what: `the active epoch moved by exactly ${accepts} (${fromEpoch} -> ${view.activeEpoch})`, ok: view.activeEpoch === fromEpoch + accepts });
  const moved = commitsSince(view.commitEpochs, fromEpoch);
  out.push({ what: `the commit log holds ${accepts} row(s) since ${fromEpoch} (${moved.join(',') || 'none'})`, ok: moved.length === accepts });
  for (const u of joined) {
    out.push({ what: `${u.slice(0, 8)} joined: on the roster, admitted, with an active seat (the Welcome went out once merged)`, ok: onRoster(view, u) && activeSeats(view, u).length > 0 });
  }
  // A USER THE ROW REMOVED (DUP-2's W5): off the roster and holding no active seat - a Remove merged once.
  for (const u of removed) {
    out.push({ what: `${u.slice(0, 8)} removed: off the roster, no active seat`, ok: !onRoster(view, u) && activeSeats(view, u).length === 0 });
  }
  return out;
}

/** The fault fired as many times as the row needs - a count below it is the row not having happened. */
export const firedAtLeast = (label, records, n) => ({ what: `${label} acted ${records.length} time(s) (${n}+ needed)`, ok: records.length >= n });

/**
 * DUP-2: W1's resubmission was answered AFTER W4's commit moved the group past `base + 1` - the
 * order is the row's question, so it is read off the sequence, not inferred.
 */
export function interveningOrder({ fromEpoch, seq }) {
  const second = seq.findIndex((d) => d.kind === 'ACCEPT' && d.newEpoch === fromEpoch + 2);
  const lastDup = seq.map((d) => d.kind).lastIndexOf('DUPLICATE');
  return [
    { what: `W4's commit was accepted to ${fromEpoch + 2}`, ok: second >= 0 },
    { what: "W1's resubmission was answered duplicate AFTER it - at an epoch past base + 1", ok: second >= 0 && lastDup > second },
  ];
}

/**
 * A decision in a LATER window (`seqAfter`, read from the instant the row did something) - DUP-4's
 * settling send, DUP-5's and OFF-*'s reconnection: the settlement happened THERE, not before.
 *
 * @param {string} where what the window starts at, for the sentence
 * @param {ReturnType<typeof commitSequence>} seqAfter
 * @param {'ACCEPT'|'DUPLICATE'} kind
 */
export const decidedAfter = (where, seqAfter, kind) => ({
  what: `the settlement is ${kind} after ${where} (${seqAfter.map((d) => d.kind).join(',') || 'nothing'})`,
  ok: seqAfter.some((d) => d.kind === kind),
});

/** OFF-1: nothing reached the gate while the request was held and cut - the first decision is after the return. */
export const nothingBefore = (where, seqBefore) => ({
  what: `the gate decided nothing before ${where} - the request never left (${seqBefore.map((d) => d.kind).join(',') || 'nothing'})`,
  ok: seqBefore.length === 0,
});

/**
 * DUP-5's two probes, judged together: a send in the SIDE group reached W2 while the row's group was
 * unknown (the positive control), and W1's send in the row's group had NOT reached W2 by then - an
 * absence that means something only because the same peer, over the same link, got the other one.
 *
 * @param {{sideReceived: boolean, sideMs: number|null, blockedShown: number|null, settledAfter: boolean}} p
 */
export function blockedHereOnly({ sideReceived, sideMs, blockedShown, settledAfter }) {
  return [
    { what: `W1's send in the side group reached W2 while the row's commit was unknown (${sideMs ?? 'never'} ms)`, ok: sideReceived },
    {
      what: `W1's send in the row's group had NOT reached W2 by then (shown ${blockedShown ?? 'unread'} time(s))`,
      ok: sideReceived && blockedShown === 0,
    },
    { what: 'the group was settled at the gateway reconnection', ok: settledAfter },
  ];
}

/**
 * DUP-6's probe: W2's message in the side group was shown on W1 while W1's commit request was STILL
 * held - the MLS lock is not held for the whole hold. `heldUntil` is when the second hold was let go
 * (or the request abandoned), `shownAt` when W1 showed the message.
 */
export function decryptsDuringHold({ shownAt, heldFrom, heldUntil }) {
  return [
    {
      what: `W2's side-group message was shown on W1 during the hold (${shownAt ?? 'never'} in ${heldFrom ?? '?'}..${heldUntil ?? '?'})`,
      ok: !!shownAt && !!heldFrom && shownAt >= heldFrom && (!heldUntil || shownAt <= heldUntil),
    },
  ];
}

/**
 * THE DELIVERY CLIENT'S `[AUTH]` LINES (#2420), as it writes them about the commit POST - the ONLY
 * request TOK-1 and TOK-2 refuse 401. Anchored on each sentence; never on the level (three are
 * `console.log`, the rest `console.warn`), and the stamp in front is the page's.
 *
 * NARRATION ON THE TOK ROWS ONLY, never a global rule: a 401 on a delivery request in any other row
 * is a token that failed for real, and stays dirt there.
 */
export const AUTH_LINES = {
  renewing: /\[AUTH\] 401 on POST \/api\/mls\/commit - renewing the token and sending the same request once more$/,
  renewedMeanwhile: /\[AUTH\] POST \/api\/mls\/commit: the token was renewed meanwhile - sent again with it$/,
  okAfterRenewal: /\[AUTH\] 200 on POST \/api\/mls\/commit after the token renewal$/,
  renewalFailed: /\[AUTH\] token renewal failed after a 401 on POST \/api\/mls\/commit - .+ - the request did nothing: DeliveryRenewalFailedError$/,
  renewalAbandoned: /\[AUTH\] token renewal abandoned at the request deadline after a 401 on POST \/api\/mls\/commit - /,
  refusedRenewedOnce: /\[AUTH\] 401 on .+ with a token already refused once renewed - not renewed again: DeliveryRefusedRenewedTokenError$/,
  refusedRenewedAgain: /\[AUTH\] 401 again on .+ with a renewed token - DeliveryRefusedRenewedTokenError; that token is not renewed again$/,
  accountChanged: /\[AUTH\] .+ was refused for one account and the token now names another - not sent again$/,
  bodyNotReleased: /\[AUTH\] the 401 body of .+ could not be released: /,
};

/** The `[AUTH]` warns: none is expected on TOK-1, and on TOK-2 only `renewalFailed`. */
const AUTH_WARNS = ['renewalFailed', 'renewalAbandoned', 'refusedRenewedOnce', 'refusedRenewedAgain', 'accountChanged', 'bodyNotReleased'];

/** A page's console lines sorted by {@link AUTH_LINES}: each key, the lines it matched. */
export function authLines(lines) {
  const texts = (lines ?? []).map((l) => (typeof l === 'string' ? l : l.text));
  return Object.fromEntries(Object.entries(AUTH_LINES).map(([k, re]) => [k, texts.filter((t) => re.test(t))]));
}

/** What each TOK row expects W1 to narrate - forgiven there and nowhere else. */
export const TOK_NARRATION = {
  'TOK-1': [AUTH_LINES.renewing, AUTH_LINES.okAfterRenewal],
  'TOK-2': [AUTH_LINES.renewing, AUTH_LINES.renewalFailed],
};

const noWarnBut = (auth, allowed = []) => {
  const seen = AUTH_WARNS.filter((k) => !allowed.includes(k) && auth[k].length);
  return { what: `no other [AUTH] warn (${seen.length ? seen.join(', ') : 'none'})`, ok: seen.length === 0 };
};

/**
 * TOK-1, POSITIVELY: ONE 401 in front of the commit, ONE renewal, the same request sent ONCE more and
 * answered 200 - not merely "no logout", which a commit dropped in silence would also show.
 *
 * @param {{auth: ReturnType<typeof authLines>, fired401: number, commitPosts: number}} p
 */
export function renewedOnceOwn({ auth, fired401, commitPosts }) {
  return [
    { what: `exactly one 401 was put in front of the commit POST (${fired401})`, ok: fired401 === 1 },
    { what: `W1 announced one renewal (${auth.renewing.length})`, ok: auth.renewing.length === 1 },
    { what: `the same request went out once more: two commit POSTs in all (${commitPosts})`, ok: commitPosts === 2 },
    { what: `it was answered 200 after the renewal (${auth.okAfterRenewal.length})`, ok: auth.okAfterRenewal.length === 1 },
    noWarnBut(auth),
  ];
}

/**
 * TOK-2 (#2420): the renewal a 401 needs FAILS, so the request did nothing - the server answered 401,
 * the bytes never reached the gate. The stage is CLEARED, not kept as unknown: the gesture fails
 * typed, nothing is sent again, no "no answer to the commit" line, and a later send settles nothing
 * (the group does not move, the subject is not added). Only a renewal ABANDONED at the request
 * deadline still keeps the stage, and that is not this row.
 *
 * @param {{auth: ReturnType<typeof authLines>, fired401: number, commitPosts: number, gestureFailed: boolean,
 *   unknownLines: number, epochBefore: number, epochAfter: number, accepts: number, subjectAdded: boolean}} p
 */
export function renewalFailedOwn({ auth, fired401, commitPosts, gestureFailed, unknownLines, epochBefore, epochAfter, accepts, subjectAdded }) {
  return [
    { what: `exactly one 401 was put in front of the commit POST (${fired401})`, ok: fired401 === 1 },
    { what: `W1 announced one renewal (${auth.renewing.length})`, ok: auth.renewing.length === 1 },
    { what: `the renewal failed, typed, once (${auth.renewalFailed.length} DeliveryRenewalFailedError)`, ok: auth.renewalFailed.length === 1 },
    { what: `the commit was not sent again (${commitPosts} commit POST(s))`, ok: commitPosts === 1 },
    { what: `the gesture failed (${gestureFailed ? 'it did' : 'it reported success'})`, ok: gestureFailed },
    { what: `the stage was not kept as unknown (${unknownLines} no-answer / kept line(s))`, ok: unknownLines === 0 },
    { what: `a later send settled nothing: epoch ${epochBefore} -> ${epochAfter}, ${accepts} ACCEPT(s)`, ok: epochAfter === epochBefore && accepts === 0 },
    { what: `the subject was not added (${subjectAdded ? 'on the roster' : 'absent'})`, ok: !subjectAdded },
    noWarnBut(auth, ['renewalFailed']),
  ];
}

/**
 * TOK rows: a refresh happened and the session survived it. `refreshes` are the `/api/auth/refresh`
 * requests the page made during the row; `loggedOut` is the login screen after it.
 */
export function sessionSurvived({ refreshes, loggedOut, needRefresh = true }) {
  const out = [{ what: `W1 is still signed in (${loggedOut ? 'the login screen is up' : 'no login screen'})`, ok: !loggedOut }];
  if (needRefresh) out.push({ what: `the access token was refreshed during the row (${refreshes} request(s))`, ok: refreshes >= 1 });
  return out;
}

