/**
 * THE SETTLEMENT ROWS OF THE 1.4.1 CAMPAIGN - a commit whose ANSWER is lost, refused or late.
 *
 *   bun archive/settle.mjs --row DUP-1   # lose-answer: kept, resubmitted, duplicate        (W1 W2)
 *   bun archive/settle.mjs --row DUP-2   # ... and W4 commits before the resubmission       (W1 W2 W4 W5)
 *   bun archive/settle.mjs --row DUP-3   # records SKIPPED with the plan's reason (Q2)
 *   bun archive/settle.mjs --row DUP-4   # the resubmission answered 409 SEAT_CLAIM_OVERTAKEN (W1 W2)
 *   bun archive/settle.mjs --row DUP-5   # 503: blocked in that group only, settled at reconnection (W1 W2 W4)
 *   bun archive/settle.mjs --row DUP-6   # no answer twice; another group decrypts meanwhile (W1 W2)
 *   bun archive/settle.mjs --row OFF-1   # cut before the POST leaves                       (W1 W2)
 *   bun archive/settle.mjs --row OFF-2   # cut after the POST reached the server            (W1 W2)
 *   bun archive/settle.mjs --row TOK-1   # the commit answered 401 by the auth guard        (W1 W2)
 *   bun archive/settle.mjs --row TOK-2   # the refresh it needs fails as transport          (W1 W2)
 *   bun archive/settle.mjs --row TOK-3   # OFF-2 after 61 min with the socket open          (W1 W2, unattended)
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2; the table and every judge are
 * `settlerows.mjs`. DUP-7 is not here: it needs a new, wipeable device (`settlerows.mjs` `DUP7_ELSEWHERE`).
 *
 * THE SHAPE, every row: W1 mints the row's own group (R5) - and a SIDE group with W2 first when the
 * row's question is about another conversation - Adds the setup seats unfaulted, reads the epoch,
 * then ARMS THE FAULT ON W1 (`fault.mjs`) and makes the commit under test: an Add of the row's
 * subject. Each step after that waits on a FACT - a fault firing, the client's own `[COMMIT] ...
 * resubmission of the commit from epoch N: <verdict>` line, the gateway's reconnection - never a
 * sleep. Faults are disarmed before the invariant (R8), which forgives exactly the failures they
 * provoked (`checkInvariant({provoked})`, `observersOf({provoked})`), one each. The gate's own log,
 * IN ORDER, is the row's evidence (`commitSequence`), read after the invariant.
 */
import { LOGIN_SHOWING, awaitGatewayConnected, evaluate, requestsSince, send } from '../chat.mjs';
import { armFault } from '../fault.mjs';
import { closeOverlays, openGroup } from '../groupnav.mjs';
import { onRoster } from '../ccrows.mjs';
import { checkInvariant, receivedOn } from '../invariant.mjs';
import {
  COMMIT_POST,
  assertRowOwns,
  awaitClientEpoch,
  awaitListed,
  awaitServer,
  closeSeats,
  commitLines,
  displayNameOf,
  mintRowGroup,
  observersOf,
  openSeats,
  serverView,
  userOf,
  watchersOf,
} from '../mlsrow.mjs';
import { errorDetail, exitOnRecorded, finishObserved, record } from '../results.mjs';
import { composeVerdict, invariantDetail, provokedFailures, rowMessageMark } from '../rowkit.mjs';
import {
  DUP3_SKIP,
  DUP7_ELSEWHERE,
  SEAT_CLAIM_OVERTAKEN_BODY,
  SETTLE_ROWS,
  INVITATION_FAILED,
  TOK_NARRATION,
  authLines,
  blockedHereOnly,
  commitSequence,
  decidedAfter,
  decryptsDuringHold,
  firedAtLeast,
  interveningOrder,
  nothingBefore,
  renewalFailedOwn,
  renewedOnceOwn,
  resubmissionLine,
  sessionSurvived,
  settleNarration,
  dup2DeferredJoinNarration,
  settledOnce,
} from '../settlerows.mjs';
import { GROUP_CREATION_NARRATION, REMOVE_NARRATION, awaitLine, consoleLines } from '../watch.mjs';
import { addMembers, removeMember } from './addmember.mjs';
import { armCut, cutHard } from './net.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (id === 'DUP-3') {
  record('DUP-3', 'SKIPPED', { reason: DUP3_SKIP });
  exitOnRecorded();
}
if (id === 'DUP-7') {
  console.error(DUP7_ELSEWHERE);
  process.exit(2);
}
if (!SETTLE_ROWS[id]) {
  console.error(`usage: bun archive/settle.mjs --row ${Object.keys(SETTLE_ROWS).join('|')}|DUP-3`);
  process.exit(2);
}
const spec = SETTLE_ROWS[id];
const since = new Date().toISOString();
let seats = null;

const REFRESH = /\/api\/auth\/refresh(\?|$)/;
/** The commit POST's url, for COUNTING requests (`COMMIT_POST` is a fault rule, matched by prefix and method). */
const COMMIT_URL = /\/api\/mls\/commit(\?|$)/;
const now = () => new Date().toISOString();
/** A gesture's outcome, captured and never thrown: a row with a fault EXPECTS gestures that do not finish cleanly. */
const outcome = (p) =>
  p.then(
    (value) => ({ ok: true, value }),
    (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 300) })
  );
/** Rules that never fired, in `composeVerdict`'s shape. */
const vacuousOf = (rules, rep) => rep.vacuous.map((i) => ({ rule: i, fault: `W1 ${rules[i].fault}` }));
const byRule = (records, i) => records.filter((r) => r.rule === i);

/** Polls one client's pane until `marker` shows; the wall time it did, or null at the bound. */
async function shownAt(cx, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await receivedOn(cx, marker)).count > 0) return Date.now();
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Takes W1 off the network (socket closed too), runs `whileCut`, restores it and waits for the gateway
 * to say it is back. Returns the instant of the restore, which is where a "settled at the reconnection"
 * window starts.
 */
async function cutAndReturn(cx, whileCut) {
  const c = await cutHard(cx);
  console.log(`[${id}] W1 cut (${c.socketsClosed} socket(s) closed)`);
  const during = await whileCut();
  const restoredAt = now();
  const before = cx.events.length;
  await c.restore();
  const gatewayMs = await awaitGatewayConnected(cx, before, 45_000);
  console.log(`[${id}] W1 back at ${restoredAt}; gateway ${gatewayMs === null ? 'NOT reconnected' : `reconnected in ${gatewayMs} ms`}`);
  return { restoredAt, gatewayMs, during };
}

/**
 * THE ROWS' ACTIONS. Each starts with the fault armed on W1 and the subject not yet added, and
 * returns the fault's records and vacuous rules, the row's detail, and `judge(view, seq, after)` -
 * its own assertions, given the server's view and the gate's decisions (whole row; and since a
 * named instant).
 */
const ACTIONS = {
  /** DUP-1: the answer is lost; the immediate resubmission is answered duplicate. */
  async 'DUP-1'(c) {
    const rules = [{ ...COMMIT_POST, fault: 'lose-answer once' }];
    const f = await armFault(c.cx('W1'), rules);
    const g = outcome(addMembers(c.cx('W1'), [c.name(spec.subject)]));
    await f.awaitFired(0, 1, 45_000).catch(() => {});
    const settled = await awaitLine(c.cx('W1'), resubmissionLine(c.group.id, c.fromEpoch, 'accepted'), 30_000);
    const gesture = await g;
    const rep = await f.disarm();
    return {
      records: rep.records,
      vacuous: vacuousOf(rules, rep),
      detail: { gesture, clientSettled: settled },
      judge: (view, seq) => [
        firedAtLeast('lose-answer', byRule(rep.records, 0), 1),
        { what: `W1 said its resubmission was accepted (${settled ?? 'no line in 30 s'})`, ok: !!settled },
        ...settledOnce({ fromEpoch: c.fromEpoch, view, seq, joined: [c.user[spec.subject]] }),
      ],
    };
  },

  /**
   * DUP-2: the first request goes through (held, released), its answer is lost, and the resubmission
   * is HELD before the server while W4 - at the new epoch - commits a REMOVE of W5; then released.
   *
   * A REMOVE, NOT AN ADD (2026-10-25, alpha.4): W1's Add keeps the group's add lock while its
   * resubmission is held, so W4's Add was refused at the lock ('Add-lock busy') and the row could
   * never reach its question. An intervening Add during a held Add is CC-1's subject; a Remove takes
   * no add lock (CC-2), so this row asks its question with a Remove beside the held Add.
   */
  async 'DUP-2'(c) {
    const rules = [
      { ...COMMIT_POST, fault: 'hold x2' },
      { ...COMMIT_POST, fault: 'lose-answer once' },
    ];
    const f = await armFault(c.cx('W1'), rules);
    const g = outcome(addMembers(c.cx('W1'), [c.name(spec.subject)]));
    const premise = [];
    await f.awaitHeld(1, 45_000);
    await f.release();
    await f.awaitFired(1, 1, 30_000);
    await f.awaitHeld(1, 30_000);
    const heldAt = Date.now();
    // W4 COMMITS ON TOP OF W1's COMMIT, never beside it: the server accepted it, and W4 holds it.
    const landed = await awaitServer(c.group.id, (v) => v.activeEpoch >= c.fromEpoch + 1, 20_000);
    const w4Ms = await awaitClientEpoch(c.cx('W4'), c.group.id, c.fromEpoch + 1, 20_000);
    if (!landed.settled) premise.push(`W1's first request was not accepted to ${c.fromEpoch + 1} within 20 s`);
    if (w4Ms === null) premise.push(`W4 did not reach epoch ${c.fromEpoch + 1} within 20 s - its commit would race, not follow`);
    let w4 = { ok: false, error: 'not attempted' };
    let moved = { settled: false };
    if (!premise.length) {
      await closeOverlays(c.cx('W4'));
      await openGroup(c.cx('W4'), c.group.name, { navigate: false, label: id });
      w4 = await outcome(removeMember(c.cx('W4'), c.user[spec.intervening.remove], c.group.name, { label: id }));
      moved = await awaitServer(c.group.id, (v) => v.activeEpoch >= c.fromEpoch + 2, 20_000);
      // THE HELD RESUBMISSION HAS A DEADLINE OF ITS OWN (the 30 s write deadline): W4's commit must
      // have landed inside it, or the row measured an abandoned request instead.
      if (!moved.settled) premise.push(`W4's Remove of W5 did not land within 20 s of the hold`);
    }
    const heldMs = Date.now() - heldAt;
    await f.release();
    const settled = await awaitLine(c.cx('W1'), resubmissionLine(c.group.id, c.fromEpoch, 'accepted'), 30_000);
    const gesture = await g;
    const rep = await f.disarm();
    const subjectNarration = [];
    return {
      premise,
      records: rep.records,
      vacuous: vacuousOf(rules, rep),
      joiners: [spec.subject],
      removed: [spec.intervening.remove],
      // W2's narration is decided by the judge, which runs after the invariant: by then the Welcome
      // its add-lock wait was waiting for has arrived or has not (`dup2DeferredJoinNarration`).
      narrationBy: { [spec.intervening.by]: REMOVE_NARRATION, [spec.subject]: subjectNarration },
      detail: { gesture, w4Gesture: w4, heldMs, clientSettled: settled },
      judge: (view, seq) => {
        subjectNarration.push(...dup2DeferredJoinNarration(consoleLines(c.cx(spec.subject)), c.group.id));
        return [
        firedAtLeast('hold', byRule(rep.records, 0), 2),
        firedAtLeast('lose-answer', byRule(rep.records, 1), 1),
        { what: `W4's Remove of W5 completed${w4.ok ? '' : ` (${w4.error})`}`, ok: w4.ok },
        { what: `W1 said its resubmission was accepted (${settled ?? 'no line in 30 s'})`, ok: !!settled },
        ...interveningOrder({ fromEpoch: c.fromEpoch, seq }),
        ...settledOnce({
          fromEpoch: c.fromEpoch,
          view,
          seq,
          accepts: 2,
          joined: [c.user[spec.subject]],
          removed: [c.user[spec.intervening.remove]],
        }),
      ];
      },
    };
  },

  /**
   * DUP-4: the answer is lost, and the immediate resubmission - which the server answered
   * `duplicate` - is answered `409 SEAT_CLAIM_OVERTAKEN` instead. The stage must be KEPT; the next
   * send settles it.
   */
  async 'DUP-4'(c) {
    const rules = [
      { ...COMMIT_POST, fault: 'lose-answer once' },
      { ...COMMIT_POST, fault: 'status 409 once', body: SEAT_CLAIM_OVERTAKEN_BODY },
    ];
    const f = await armFault(c.cx('W1'), rules);
    const g = outcome(addMembers(c.cx('W1'), [c.name(spec.subject)]));
    await f.awaitFired(1, 1, 45_000).catch(() => {});
    const unknown = await awaitLine(c.cx('W1'), resubmissionLine(c.group.id, c.fromEpoch, 'unknown'), 20_000);
    const gesture = await g;
    const rep = await f.disarm();
    const settleSince = now();
    await closeOverlays(c.cx('W1'));
    await send(c.cx('W1'), `${id} settles [${rowMessageMark(id, 'S')}]`);
    const settled = await awaitLine(c.cx('W1'), resubmissionLine(c.group.id, c.fromEpoch, 'accepted'), 30_000);
    return {
      records: rep.records,
      vacuous: vacuousOf(rules, rep),
      detail: { gesture, clientUnknown: unknown, clientSettled: settled, settleSince },
      judge: (view, seq) => {
        const after = commitSequence(commitLines(c.group.id, settleSince));
        return [
          firedAtLeast('lose-answer', byRule(rep.records, 0), 1),
          firedAtLeast('status 409 SEAT_CLAIM_OVERTAKEN', byRule(rep.records, 1), 1),
          { what: `W1 KEPT the stage: its resubmission was read as unknown (${unknown ?? 'no line in 20 s'})`, ok: !!unknown },
          { what: `the next send settled it: W1 said accepted (${settled ?? 'no line in 30 s'})`, ok: !!settled },
          decidedAfter('the next send', after, 'DUPLICATE'),
          // TWO duplicates: the resubmission the 409 answered over, and the settling one.
          ...settledOnce({ fromEpoch: c.fromEpoch, view, seq, minDuplicates: 2, joined: [c.user[spec.subject]] }),
        ];
      },
    };
  },

  /**
   * DUP-5: every commit request answered 503 while the fault is armed - the server ACCEPTED the
   * first. A send in the row's group must be blocked, one in the side group must not; the fault is
   * lifted and W1 is cut and returned, and the reconnection settles the group.
   */
  async 'DUP-5'(c) {
    const W1 = c.cx('W1');
    const rules = [{ ...COMMIT_POST, fault: 'status 503' }];
    const f = await armFault(W1, rules);
    const g = outcome(addMembers(W1, [c.name(spec.subject)]));
    await f.awaitFired(0, 2, 45_000).catch(() => {});
    const unknown = await awaitLine(W1, resubmissionLine(c.group.id, c.fromEpoch, 'unknown'), 20_000);
    const gesture = await g;
    // THE ROW'S GROUP: a send there settles first, meets the 503 again, and must not go out.
    await closeOverlays(W1);
    const blockedMark = rowMessageMark(id, 'B');
    const blockedSend = await outcome(send(W1, `${id} blocked [${blockedMark}]`));
    // THE SIDE GROUP: the positive control - the same peer, the same link, another conversation.
    const sideMark = rowMessageMark(id, 'C');
    await openGroup(W1, c.side.name, { navigate: false, label: id });
    const sideFrom = Date.now();
    await send(W1, `${id} side [${sideMark}]`);
    await openGroup(c.cx('W2'), c.side.name, { navigate: false, label: id });
    const sideAt = await shownAt(c.cx('W2'), sideMark, 20_000);
    await openGroup(c.cx('W2'), c.group.name, { navigate: false, label: id });
    const blockedShown = sideAt ? (await receivedOn(c.cx('W2'), blockedMark)).count : null;
    const rep = await f.disarm();
    const back = await cutAndReturn(W1, async () => null);
    const settled = await awaitLine(W1, resubmissionLine(c.group.id, c.fromEpoch, 'accepted'), 30_000);
    const blockedLater = await shownAt(c.cx('W2'), blockedMark, 20_000);
    return {
      records: rep.records,
      vacuous: vacuousOf(rules, rep),
      offline: true,
      detail: { gesture, blockedSend, clientUnknown: unknown, clientSettled: settled, ...back, sideMs: sideAt ? sideAt - sideFrom : null, blockedShown, blockedArrivedAfterReturn: blockedLater !== null },
      judge: (view, seq) => {
        const after = commitSequence(commitLines(c.group.id, back.restoredAt));
        return [
          firedAtLeast('status 503', byRule(rep.records, 0), 2),
          { what: `W1 read the commit as unknown and kept it (${unknown ?? 'no line in 20 s'})`, ok: !!unknown },
          { what: `the gateway reconnected after the cut (${back.gatewayMs ?? 'never'} ms)`, ok: back.gatewayMs !== null },
          ...blockedHereOnly({ sideReceived: sideAt !== null, sideMs: sideAt ? sideAt - sideFrom : null, blockedShown, settledAfter: after.some((d) => d.kind === 'DUPLICATE') }),
          ...settledOnce({ fromEpoch: c.fromEpoch, view, seq, joined: [c.user[spec.subject]] }),
        ];
      },
    };
  },

  /**
   * DUP-6: the commit's answer is held past the client's write deadline, twice (the first request and
   * its resubmission). Meanwhile W2 sends in the side group, and W1 must show it - the MLS lock is not
   * held for the length of the hold. The next send in the row's group settles it.
   */
  async 'DUP-6'(c) {
    const W1 = c.cx('W1');
    const rules = [{ ...COMMIT_POST, fault: 'hold-answer x2' }];
    const f = await armFault(W1, rules);
    const g = outcome(addMembers(W1, [c.name(spec.subject)]));
    await f.awaitFired(0, 1, 45_000);
    const heldFrom = Date.now();
    const sideMark = rowMessageMark(id, 'C');
    await openGroup(c.cx('W2'), c.side.name, { navigate: false, label: id });
    await send(c.cx('W2'), `${id} side [${sideMark}]`);
    await closeOverlays(W1);
    await openGroup(W1, c.side.name, { navigate: false, label: id });
    const sideAt = await shownAt(W1, sideMark, 25_000);
    await f.awaitFired(0, 2, 75_000).catch(() => {});
    const unknown = await awaitLine(W1, resubmissionLine(c.group.id, c.fromEpoch, 'unknown'), 75_000);
    const heldUntil = Date.now();
    const gesture = await g;
    const rep = await f.disarm();
    const settleSince = now();
    await openGroup(W1, c.group.name, { navigate: false, label: id });
    await send(W1, `${id} settles [${rowMessageMark(id, 'S')}]`);
    const settled = await awaitLine(W1, resubmissionLine(c.group.id, c.fromEpoch, 'accepted'), 30_000);
    return {
      records: rep.records,
      vacuous: vacuousOf(rules, rep),
      detail: { gesture, clientUnknown: unknown, clientSettled: settled, heldFrom, heldUntil, sideShownAt: sideAt, settleSince },
      judge: (view, seq) => {
        const after = commitSequence(commitLines(c.group.id, settleSince));
        return [
          firedAtLeast('hold-answer', byRule(rep.records, 0), 2),
          { what: `W1 kept the stage after the second expiry (${unknown ?? 'no line in 75 s'})`, ok: !!unknown },
          ...decryptsDuringHold({ shownAt: sideAt, heldFrom, heldUntil }),
          { what: `the next send settled it: W1 said accepted (${settled ?? 'no line in 30 s'})`, ok: !!settled },
          decidedAfter('the next send', after, 'DUPLICATE'),
          ...settledOnce({ fromEpoch: c.fromEpoch, view, seq, joined: [c.user[spec.subject]] }),
        ];
      },
    };
  },

  /** OFF-1: the POST is held BEFORE the server, W1 is cut, and the held request is failed - it never left. */
  async 'OFF-1'(c) {
    const W1 = c.cx('W1');
    const rules = [{ ...COMMIT_POST, fault: 'hold once' }];
    const f = await armFault(W1, rules);
    const g = outcome(addMembers(W1, [c.name(spec.subject)]));
    await f.awaitHeld(1, 45_000);
    let unknown = null;
    let gesture = null;
    let seqBefore = [];
    const back = await cutAndReturn(W1, async () => {
      await f.fail();
      unknown = await awaitLine(W1, resubmissionLine(c.group.id, c.fromEpoch, 'unknown'), 30_000);
      gesture = await g;
      seqBefore = commitSequence(commitLines(c.group.id, c.startSince));
    });
    const rep = await f.disarm();
    const settled = await awaitLine(W1, resubmissionLine(c.group.id, c.fromEpoch, 'accepted'), 30_000);
    return {
      records: rep.records,
      vacuous: vacuousOf(rules, rep),
      offline: true,
      detail: { gesture, clientUnknown: unknown, clientSettled: settled, ...back, decidedBeforeReturn: seqBefore },
      judge: (view, seq) => {
        const after = commitSequence(commitLines(c.group.id, back.restoredAt));
        return [
          firedAtLeast('hold (then failed)', byRule(rep.records, 0), 1),
          { what: `W1 kept the stage while cut (${unknown ?? 'no line in 30 s'})`, ok: !!unknown },
          { what: `the gateway reconnected (${back.gatewayMs ?? 'never'} ms)`, ok: back.gatewayMs !== null },
          nothingBefore('the return', seqBefore),
          decidedAfter('the return', after, 'ACCEPT'),
          { what: `W1 said its resubmission was accepted (${settled ?? 'no line in 30 s'})`, ok: !!settled },
          ...settledOnce({ fromEpoch: c.fromEpoch, view, seq, minDuplicates: 0, maxDuplicates: 0, joined: [c.user[spec.subject]] }),
        ];
      },
    };
  },

  /** OFF-2: the server accepted and its answer is held; W1 is cut, then the held answer is failed. */
  async 'OFF-2'(c) {
    return offTwo(c);
  },

  /** TOK-1: the auth guard's 401, before the gate; the client renews and sends the SAME bytes (#2420). */
  async 'TOK-1'(c) {
    const W1 = c.cx('W1');
    const rules = [{ ...COMMIT_POST, fault: 'status-unsent 401 once' }];
    const idx = W1.events.length;
    const f = await armFault(W1, rules);
    const g = outcome(addMembers(W1, [c.name(spec.subject)]));
    await f.awaitFired(0, 1, 45_000).catch(() => {});
    const gesture = await g;
    // COUNTED AT THE GESTURE'S END, so a leaf refresh the page starts later is not this Add's resend.
    const commitPosts = requestsSince(W1, COMMIT_URL, idx).length;
    const rep = await f.disarm();
    await awaitServer(c.group.id, (v) => v.activeEpoch > c.fromEpoch, 30_000);
    const refreshes = requestsSince(W1, REFRESH, idx).length;
    const loggedOut = (await evaluate(W1, LOGIN_SHOWING)) === true;
    const auth = authLines(consoleLines(W1));
    return {
      records: rep.records,
      vacuous: vacuousOf(rules, rep),
      narration: TOK_NARRATION[id],
      detail: { gesture, refreshes, loggedOut, commitPosts, auth },
      judge: (view, seq) => [
        ...renewedOnceOwn({ auth, fired401: provokedFailures(byRule(rep.records, 0)).length, commitPosts }),
        ...sessionSurvived({ refreshes, loggedOut }),
        // The first request never reached the gate: ONE accept, and nothing to call a duplicate.
        ...settledOnce({ fromEpoch: c.fromEpoch, view, seq, minDuplicates: 0, maxDuplicates: 0, joined: [c.user[spec.subject]] }),
      ],
    };
  },

  /**
   * TOK-2: the commit is refused 401 by the guard, and the renewal it triggers loses its answer. Since
   * #2420 the request DID NOTHING (the bytes never reached the gate), so the stage is cleared and the
   * gesture fails typed; the send that follows is the probe - a kept stage would be settled by it,
   * before it goes out.
   */
  async 'TOK-2'(c) {
    const W1 = c.cx('W1');
    const rules = [
      { ...COMMIT_POST, fault: 'status-unsent 401 once' },
      { match: '/api/auth/refresh', method: 'POST', fault: 'lose-answer once' },
    ];
    const idx = W1.events.length;
    const linesBefore = consoleLines(W1).length;
    const f = await armFault(W1, rules);
    const g = outcome(addMembers(W1, [c.name(spec.subject)]));
    await f.awaitFired(1, 1, 45_000).catch(() => {});
    // The app's own verdict on the Add, which the click cannot see (`INVITATION_FAILED`).
    const failedLine = await awaitLine(W1, '[GROUP] an invitation added nobody (failed)', 30_000);
    const gesture = await g;
    const commitPosts = requestsSince(W1, COMMIT_URL, idx).length;
    const rep = await f.disarm();
    const probeSince = now();
    await closeOverlays(W1);
    const probe = await outcome(send(W1, `${id} probe [${rowMessageMark(id, 'S')}]`));
    const epochAfter = serverView(c.group.id).activeEpoch;
    const refreshes = requestsSince(W1, REFRESH, idx).length;
    const loggedOut = (await evaluate(W1, LOGIN_SHOWING)) === true;
    const short = c.group.id.slice(0, 8);
    const lines = consoleLines(W1);
    const auth = authLines(lines);
    const unknownLines = lines.filter((l) => l.includes(`[COMMIT] ${short}... no answer to the commit`) || (l.includes(short) && l.includes('kept until a resubmission answers'))).length;
    return {
      records: rep.records,
      vacuous: vacuousOf(rules, rep),
      // NOBODY JOINS: the subject is judged absent by the roster, and the invariant reads W1 alone.
      joiners: [],
      members: spec.devices.filter((d) => d !== spec.subject),
      narration: TOK_NARRATION[id],
      detail: { gesture, failedLine, refreshes, loggedOut, commitPosts, probe, probeSince, epochAfter, unknownLines, auth },
      judge: (view, seq) => [
        firedAtLeast('lose-answer on the renewal', byRule(rep.records, 1), 1),
        ...renewalFailedOwn({
          auth,
          fired401: provokedFailures(byRule(rep.records, 0)).length,
          commitPosts,
          gestureFailed: !gesture.ok || lines.slice(linesBefore).some((l) => INVITATION_FAILED.test(l)),
          unknownLines,
          epochBefore: c.fromEpoch,
          epochAfter,
          accepts: seq.filter((d) => d.kind === 'ACCEPT').length,
          subjectAdded: onRoster(view, c.user[spec.subject]),
        }),
        ...sessionSurvived({ refreshes, loggedOut }),
      ],
    };
  },

  /** TOK-3: an hour with the socket open, so the access token expires; then OFF-2's commit and return. */
  async 'TOK-3'(c) {
    const W1 = c.cx('W1');
    const idx = W1.events.length;
    console.log(`[${id}] waiting ${spec.waitMinutes} min with the socket open - the access token (1 h) expires`);
    await new Promise((r) => setTimeout(r, spec.waitMinutes * 60_000));
    const out = await offTwo(c);
    const refreshes = requestsSince(W1, REFRESH, idx).length;
    const loggedOut = (await evaluate(W1, LOGIN_SHOWING)) === true;
    return {
      ...out,
      detail: { ...out.detail, waitedMinutes: spec.waitMinutes, refreshes, loggedOut },
      judge: (view, seq) => [...sessionSurvived({ refreshes, loggedOut }), ...out.judge(view, seq)],
    };
  },
};

/** OFF-2's action, shared with TOK-3: the answer held after the server accepted, W1 cut, the answer failed. */
async function offTwo(c) {
  const W1 = c.cx('W1');
  const rules = [{ ...COMMIT_POST, fault: 'hold-answer once' }];
  const f = await armFault(W1, rules);
  const g = outcome(addMembers(W1, [c.name(spec.subject)]));
  await f.awaitHeld(1, 45_000);
  let unknown = null;
  let gesture = null;
  let seqBefore = [];
  const back = await cutAndReturn(W1, async () => {
    await f.fail();
    unknown = await awaitLine(W1, resubmissionLine(c.group.id, c.fromEpoch, 'unknown'), 30_000);
    gesture = await g;
    seqBefore = commitSequence(commitLines(c.group.id, c.startSince));
  });
  const rep = await f.disarm();
  const settled = await awaitLine(W1, resubmissionLine(c.group.id, c.fromEpoch, 'accepted'), 30_000);
  return {
    records: rep.records,
    vacuous: vacuousOf(rules, rep),
    offline: true,
    detail: { gesture, clientUnknown: unknown, clientSettled: settled, ...back, decidedBeforeReturn: seqBefore },
    judge: (view, seq) => {
      const after = commitSequence(commitLines(c.group.id, back.restoredAt));
      const accepted = seqBefore.filter((d) => d.kind === 'ACCEPT').length;
      return [
        firedAtLeast('hold-answer (then failed)', byRule(rep.records, 0), 1),
        { what: `the server accepted the commit BEFORE the cut - its answer was what was lost (${accepted})`, ok: accepted === 1 },
        { what: `W1 kept the stage while cut (${unknown ?? 'no line in 30 s'})`, ok: !!unknown },
        { what: `the gateway reconnected (${back.gatewayMs ?? 'never'} ms)`, ok: back.gatewayMs !== null },
        decidedAfter('the return', after, 'DUPLICATE'),
        { what: `W1 said its resubmission was accepted (${settled ?? 'no line in 30 s'})`, ok: !!settled },
        ...settledOnce({ fromEpoch: c.fromEpoch, view, seq, joined: [c.user[spec.subject]] }),
      ];
    },
  };
}

/** Set up, act, judge. */
async function play() {
  const user = Object.fromEntries(spec.devices.map((d) => [d, userOf(seats, d)]));
  const cx = (d) => seats.seat[d].cx;
  const name = (d) => displayNameOf(user[d]);
  const premise = [];
  // THE CUT IS ARMED FIRST: its reload is a navigation, and every later step must run on the page it leaves.
  if (spec.cut) await armCut(cx('W1'));

  let side = null;
  if (spec.side) {
    side = await mintRowGroup(cx('W1'), id, user.W1);
    assertRowOwns({ kind: 'group', id: side.id, name: side.name }, id);
    await openGroup(cx('W1'), side.name, { navigate: false, label: id });
    await addMembers(cx('W1'), [name('W2')]);
    if ((await awaitListed(cx('W2'), side.name, 60_000)) === null) premise.push(`W2 never listed the side group ${side.name}`);
    await closeOverlays(cx('W1'));
  }
  const group = await mintRowGroup(cx('W1'), id, user.W1);
  assertRowOwns({ kind: 'group', id: group.id, name: group.name }, id);
  await openGroup(cx('W1'), group.name, { navigate: false, label: id });
  if (spec.setup.length) {
    await addMembers(cx('W1'), spec.setup.map(name));
    for (const d of spec.setup) if ((await awaitListed(cx(d), group.name, 60_000)) === null) premise.push(`${d} never listed ${group.name} after the setup Add`);
    const settled = await awaitServer(
      group.id,
      (v) => spec.setup.every((d) => (v.seats ?? []).some((s) => s.userId.toLowerCase() === user[d].toLowerCase() && s.status === 'active')),
      30_000
    );
    if (!settled.settled) premise.push('the setup Add did not leave every setup seat active within 30 s');
    await closeOverlays(cx('W1'));
  }
  if (premise.length) return { premise, detail: { group: group.id, side: side?.id ?? null } };

  const fromEpoch = serverView(group.id).activeEpoch;
  const startSince = now();
  const c = { cx, user, name, group, side, fromEpoch, startSince };
  const act = await ACTIONS[id](c);
  if (act.premise?.length) return { premise: act.premise, records: act.records, offline: act.offline, detail: { group: group.id, fromEpoch, ...act.detail } };

  // EVERY JOINER LISTS THE GROUP BEFORE THE INVARIANT SENDS TO IT; one that never does is judged below
  // by the roster (`settled` in `settlerows.mjs`), and LEFT OUT OF THE INVARIANT'S MEMBERS - the probe
  // throws opening a conversation a seat does not list, which recorded eight rows of the 2026-10-25
  // pass as ERROR or INVALID with no verdict on the row's own question (an Add whose commit was
  // settled late never enrolled its invitee). Excluded, the roster assertion fails: FAIL, with evidence.
  const unlisted = [];
  for (const d of act.joiners ?? [spec.subject]) if ((await awaitListed(cx(d), group.name, 60_000)) === null) unlisted.push(d);
  if (unlisted.length) console.log(`[${id}] ${unlisted.join(', ')} never listed ${group.name} - its Add is judged by the roster`);
  const invariant = await checkInvariant({
    group: group.id,
    targets: seats.targets,
    // A SEAT THE ROW REMOVED holds no group to send to: it is out of the members, judged by the roster.
    members: (act.members ?? spec.devices).filter((d) => !unlisted.includes(d) && !(act.removed ?? []).includes(d)),
    conversation: group.name,
    fromEpoch,
    since,
    reload: true,
    watchers: watchersOf(seats),
    provoked: { W1: provokedFailures(act.records) },
  });
  const view = serverView(group.id);
  const seq = commitSequence(commitLines(group.id, startSince));
  return {
    own: act.judge(view, seq),
    invariant,
    vacuousFaults: act.vacuous,
    records: act.records,
    offline: act.offline,
    narration: [...settleNarration(group.id), ...(act.narration ?? [])],
    narrationBy: act.narrationBy ?? {},
    detail: { group: group.id, name: group.name, side: side?.id ?? null, fromEpoch, decisions: seq, faultRecords: act.records, ...act.detail, ...(unlisted.length ? { unlisted } : {}), ...(spec.note ? { note: spec.note } : {}) },
  };
}

try {
  seats = await openSeats(spec.devices, id);
  const out = await play();
  const { verdict, failures } = composeVerdict({
    own: out.own ?? [],
    invariant: out.invariant ?? null,
    vacuousFaults: out.vacuousFaults ?? [],
    premise: out.premise ?? [],
  });
  for (const f of failures) console.log(`[${id}] ${f}`);
  console.log(`[${id}] assertions: ${verdict}`);
  const observers = await observersOf(seats, {
    // W1 made the row's Add; a seat whose own gesture the row made (DUP-2's W4 Remove) names its narration.
    logs: { ...out.narrationBy, W1: [...GROUP_CREATION_NARRATION, ...(out.narration ?? [])] },
    provoked: { W1: out.records ?? [] },
    offline: out.offline ? ['W1'] : [],
  });
  await finishObserved(
    id,
    verdict,
    { ...out.detail, own: out.own ?? [], failures, invariant: invariantDetail(out.invariant ?? null), serverWindowSince: since },
    observers,
    () => closeSeats(seats)
  );
} catch (e) {
  console.error(`[${id}] ${e?.stack ?? e}`);
  record(id, 'ERROR', errorDetail(e));
  closeSeats(seats);
  process.exit(1);
}
