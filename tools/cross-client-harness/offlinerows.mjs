/**
 * THE OFFLINE AND DEGRADED-LINK ROWS OF THE 1.4.1 CAMPAIGN - OFF-3, OFF-5, NET-1..3, RM-8 - their
 * table and their judges.
 *
 * Pure, so `archive/offline-selftest.mjs` pins every judge on a checkout with no rig; the action is
 * `archive/offline.mjs`. `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2 is the plan. Where
 * `archive/settle.mjs` asks what happens to ONE commit whose answer went missing, these rows ask what
 * a seat does across a DURATION without a working link: away while others move on (OFF-3), its radios
 * gone mid-Add (OFF-5), a slow link (NET-1), a flapping socket (NET-2), a captive portal (NET-3), and
 * a departure attempted offline (RM-8).
 */
import { activeSeats, onRoster } from './ccrows.mjs';

/** The rows `archive/offline.mjs` plays. */
export const OFFLINE_ROWS = {
  'OFF-3': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    setup: ['W2'],
    subject: 'W5',
    advance: 3,
    what: "W1's Add is staged, then W1 is away while W2 moves the group three epochs: on return the kept commit is refused, cleared, caught up and re-issued if its intent still holds",
    note: "W2's three commits are an Add of W4, then two of W2's own leaf refreshes - the Add is what makes W2's leaf one its own commit dated, so it can be refreshed at all; W5 is the subject, so W1's intent still holds on return",
  },
  'OFF-5': {
    devices: ['A1', 'W2'],
    subject: 'W2',
    what: 'the phone loses both radios in the middle of an Add it is making: kept, settled at the next connection without reopening the app',
    note: "OFF-2's shape on A1: the answer is held after the server accepted, then the radios go (`svc wifi disable; svc data disable`, and the USB reverse on the local estate), then the held answer is failed",
  },
  'NET-1': {
    devices: ['W1', 'W2', 'W4', 'W5'],
    subjects: ['W2', 'W4', 'W5'],
    link: { latencyMs: 800, downBytesPerSecond: 50_000, upBytesPerSecond: 50_000 },
    what: 'a slow link (800 ms, 50 kB/s) while a three-person Add runs: it completes or settles; a spent lock budget is followed by a clean retry',
    note: 'CDP emulates latency and throughput, never loss: the "lossy" half of the plan is not reproduced and the record says so',
  },
  'NET-2': {
    devices: ['W1', 'W2'],
    ticks: 60,
    tickMs: 5_000,
    flapEvery: 2,
    refreshEvery: 18,
    what: "W2's socket flaps every 10 s for five minutes while W1 sends and commits: the invariant holds at the end and every message shows once",
  },
  'NET-3': {
    devices: ['W1', 'W2', 'W4'],
    subject: 'W4',
    portalMs: 20_000,
    what: 'a captive portal answers every /api/ call 200 text/html: no logout, the commit kept as unknown (never cleared), recovered when it ends',
    note: 'the commit under the portal is an Add of W4: a leaf refresh is only scheduled AFTER a send the server accepted, which the portal prevents',
  },
  'RM-8': {
    devices: ['W1', 'W2'],
    what: 'W2 leaves a group while its requests fail (`cut()`): no half-left group - the server and W2 agree, whichever way it went',
  },
};

/** OFF-4 is blocked on an account, not forgotten. */
export const OFF4_PREMISE =
  'BLOCKED-ON-ACCOUNT: OFF-4 needs ten membership changes, an Add/Remove loop of a fifth campaign account (see the runners page)';

/** What a captive portal answers instead of the API. */
export const PORTAL_HTML = '<!doctype html><html><head><title>Wi-Fi login</title></head><body><form action="/login"><input name="room"></form></body></html>';

/** The client's line when it clears a kept commit the gate refused (`settleUnresolvedLocked`). */
export const keptRefusedLine = (groupId, fromEpoch) => `[COMMIT] ${String(groupId).slice(0, 8)}... the kept commit from epoch ${fromEpoch}: refused - cleared`;

/** The client's line when a commit got no usable answer and is resubmitted (`runCommitTransaction`). */
export const noAnswerLine = (groupId, fromEpoch) => `[COMMIT] ${String(groupId).slice(0, 8)}... no answer to the commit from epoch ${fromEpoch}`;

/** The client's line when a resubmission could not be sent inside the MLS lock's budget. */
export const LOCK_BUDGET_SPENT = 'lock budget of';

const kinds = (seq) => seq.map((d) => d.kind).join(',') || 'nothing';

/**
 * OFF-3: the kept commit was REFUSED at the return (`epoch_mismatch` - the gate looked in its log
 * first and found it never landed), cleared by the client, W1 caught up, and - its intent still
 * holding - the Add was made again and landed.
 *
 * @param {object} p
 * @param {{kind: string, reason?: string}[]} p.seqAfter the gate's decisions since W1's return
 * @param {string|null} p.clearedLine the client's own `refused - cleared` line
 * @param {number|null} p.caughtUpMs W1 reached the server's epoch after the return
 * @param {object} p.view `serverView` at the end
 * @param {string} p.subject the user W1 meant to add
 */
export function staleStageOwn({ seqAfter, clearedLine, caughtUpMs, view, subject, advanced }) {
  const refusal = seqAfter.find((d) => d.kind === 'REJECT');
  return [
    { what: `W2 moved the group ${advanced} epoch(s) while W1 was away`, ok: advanced >= 3 },
    { what: `the kept commit was refused at the return (${refusal ? refusal.reason : kinds(seqAfter)})`, ok: refusal?.reason === 'epoch_mismatch' },
    { what: `W1 cleared it (${clearedLine ?? 'no line'})`, ok: !!clearedLine },
    { what: `W1 caught up to the server's epoch (${caughtUpMs ?? 'never'} ms)`, ok: caughtUpMs !== null },
    {
      what: `the intent still held, so it was re-issued: ${subject.slice(0, 8)} on the roster with an active seat, and an ACCEPT after the refusal`,
      ok: !!refusal && onRoster(view, subject) && activeSeats(view, subject).length > 0 && seqAfter.findIndex((d) => d.kind === 'ACCEPT') > seqAfter.indexOf(refusal),
    },
  ];
}

/**
 * NET-1: every person of the Add is in, with a seat; a spent lock budget, if any, was followed by
 * the commit landing (a clean retry), never by a commit that stayed out.
 */
export function slowLinkOwn({ view, subjects, budgetLines, accepts }) {
  const allIn = subjects.every((u) => onRoster(view, u) && activeSeats(view, u).length > 0);
  return [
    { what: `the Add completed over the slow link: ${subjects.length} admitted with an active seat`, ok: allIn },
    { what: `the gate accepted it (${accepts} accept(s))`, ok: accepts >= 1 },
    { what: `a spent lock budget (${budgetLines.length}) was followed by a clean retry`, ok: budgetLines.length === 0 || (allIn && accepts >= 1) },
  ];
}

/** NET-2: every message W1 sent shows ONCE on W2, and every flap's restore reconnected. */
export function flapOwn({ shown, flaps, reconnects }) {
  const out = [
    { what: `W2's socket flapped ${flaps} time(s)`, ok: flaps >= 10 },
    { what: `every flap's restore reconnected (${reconnects.filter((r) => r !== null).length}/${reconnects.length})`, ok: reconnects.length === flaps && reconnects.every((r) => r !== null) },
  ];
  const counts = Object.values(shown);
  const wrong = Object.entries(shown).filter(([, n]) => n !== 1);
  out.push({ what: `every message shows ONCE on W2 (${counts.length - wrong.length}/${counts.length}${wrong.length ? `; ${wrong.slice(0, 3).map(([m, n]) => `${m}=${n}`).join(' ')}` : ''})`, ok: counts.length > 0 && wrong.length === 0 });
  return out;
}

/**
 * NET-3: W1 stayed signed in throughout; its commit got no usable answer and was KEPT (the no-answer
 * line), not refused and cleared; once the portal ended, the commit landed and the message sent under
 * it arrived.
 */
export function portalOwn({ loggedOutDuring, loggedOutAfter, noAnswer, clearedLine, joined, messageShown }) {
  return [
    { what: `no logout under the portal (${loggedOutDuring ? 'the login screen came up' : 'signed in'})`, ok: !loggedOutDuring },
    { what: `no logout after it (${loggedOutAfter ? 'the login screen came up' : 'signed in'})`, ok: !loggedOutAfter },
    { what: `the commit's 200 text/html read as NO answer, a transport failure (${noAnswer ?? 'no line'})`, ok: !!noAnswer },
    { what: `the commit was never cleared as refused (${clearedLine ?? 'not cleared'})`, ok: !clearedLine },
    { what: 'the commit landed once the portal ended: the subject joined', ok: joined },
    { what: `the message sent under the portal reached W2 after it (${messageShown})`, ok: messageShown === 1 },
  ];
}

/**
 * RM-8: no half-left group. Either W2 is gone on BOTH sides (off the roster, no seat, not listed) or
 * still a member on both (on the roster, an active seat, listed, at the server's epoch).
 *
 * @param {{view: object, user: string, listed: boolean, atServerEpoch: boolean, gesture: {ok: boolean, error?: string}}} p
 */
export function departureOwn({ view, user, listed, atServerEpoch, gesture }) {
  const onServer = onRoster(view, user);
  const seated = activeSeats(view, user).length > 0;
  const left = !onServer && !seated && !listed;
  const stayed = onServer && seated && listed && atServerEpoch;
  return [
    {
      what: `no half-left group: server ${onServer ? 'member' : 'gone'}${seated ? ' with a seat' : ''}, W2 ${listed ? 'lists it' : 'does not list it'}${listed ? (atServerEpoch ? ' at the server epoch' : ' BEHIND the server epoch') : ''}`,
      ok: left || stayed,
    },
    { what: `the leave either completed or was refused with a reason (${gesture.ok ? 'completed' : gesture.error})`, ok: gesture.ok ? left : !!gesture.error },
  ];
}
