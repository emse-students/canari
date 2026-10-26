/**
 * THE KILL ROWS OF THE 1.4.1 CAMPAIGN - a process that dies with a commit in flight.
 *
 *   bun archive/kill.mjs --row KILL-1   # W1's tab closed, 20 runs                       (W1 W2)
 *   bun archive/kill.mjs --row KILL-2   # W1's whole browser killed, 10 runs              (W1 W2)
 *   bun archive/kill.mjs --row KILL-3   # W1's browser killed after a send or a receive, 12 runs (W1 W2)
 *   bun archive/kill.mjs --row KILL-4   # A1 force-stopped inside the stage + checkpoint  (A1 W2, class B)
 *   bun archive/kill.mjs --row KILL-5   # W1's tab closed between the merge and the Welcome (W1 W2)
 *   bun archive/kill.mjs --row RM-3     # W1's tab closed between the roster delete and the Remove
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2; the table, the windows and every judge are
 * `killrows.mjs`, the kill and the revival `archive/reopen.mjs`. Each run's commit is a LEAF REFRESH
 * (`armLeafRefresh`, then a send): the only commit a seat can make twenty times in one group with no
 * membership to spend. The kill waits on the commit request being HELD (`fault.mjs`), so it lands on
 * the side of the server the run chose - never on whichever side the timing favoured.
 */
import { evaluate } from '../cdp.mjs';
import { send } from '../chat.mjs';
import { armFault } from '../fault.mjs';
import { closeOverlays, openGroup } from '../groupnav.mjs';
import { checkInvariant, receivedOn } from '../invariant.mjs';
import { KILL3_WINDOWS, KILL_BLOCKED, KILL_ROWS, UNSENT_LABELS, WINDOWS, kill3Outcome, kill3WindowOf, kill3WindowsOwn, cookieCommitWaitMs, delayOf, killRunsOwn, panelMissing, removalBoundOwn, runCommits, runOutcome, stageKillsOwn, strayCommits, strayCommitsOwn, welcomeLines, welcomeOnceOwn, windowOf } from '../killrows.mjs';
import { SITE } from '../site.mjs';
import { activeSeats, onRoster } from '../ccrows.mjs';
import {
  COMMIT_POST,
  armLeafRefresh,
  assertRowOwns,
  awaitClientEpoch,
  awaitListed,
  closeSeats,
  commitLines,
  deviceIdOf,
  displayNameOf,
  mintRowGroup,
  observersOf,
  openSeats,
  serverView,
  userOf,
  watchersOf,
} from '../mlsrow.mjs';
import { errorDetail, finishObserved, keepConsoles, record } from '../results.mjs';
import { composeVerdict, invariantDetail, rowMessageMark } from '../rowkit.mjs';
import { commitSequence, settleNarration } from '../settlerows.mjs';
import { RM8_W1_NARRATION } from '../offlinerows.mjs';
import { GROUP_CREATION_NARRATION, consoleDump, consoleLines, report } from '../watch.mjs';
import { addMembers, openGroupSettings, removeMember } from './addmember.mjs';
import { killSeat, reviveSeat } from './reopen.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (!KILL_ROWS[id]) {
  console.error(`usage: bun archive/kill.mjs --row ${Object.keys(KILL_ROWS).join('|')}`);
  process.exit(2);
}
if (KILL_BLOCKED[id]) {
  console.error(`${id}: ${KILL_BLOCKED[id]}`);
  process.exit(2);
}
const spec = KILL_ROWS[id];
const since = new Date().toISOString();
let seats = null;
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outcome = (p) =>
  p.then(
    (value) => ({ ok: true, value }),
    (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 300) })
  );
const accepts = (seq) => seq.filter((d) => d.kind === 'ACCEPT').length;

/** Polls one client's pane until `marker` shows; its count then, or 0 at the bound. */
async function shownCount(cx, marker, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = (await receivedOn(cx, marker)).count;
    if (n > 0 || Date.now() > deadline) return n;
    await sleep(400);
  }
}

/** The dead page's own observation, summarised - read from the events it had, never from the page. */
async function deadReport(w) {
  try {
    const r = await report(w);
    return { clean: r.clean, errors: (r.errors ?? []).length, badHttp: (r.badHttp ?? []).length };
  } catch (e) {
    return { unreadable: String(e?.message ?? e).slice(0, 160) };
  }
}

/**
 * THE DYING PAGE'S CONSOLE IS KEPT EVEN WHEN THE REVIVAL THROWS. It is read before the kill and was
 * written only at the end of a run, so a revival that threw lost it - alpha.5's KILL-2 run 10
 * (2026-10-26), where the kill took W1's cookie jar and the record kept nothing from that run. The
 * error is rethrown unchanged: keeping the evidence never turns a rig ERROR into a verdict. The
 * revived page's console rides on the error when `reviveSeat` could read it (`failedRevival`).
 *
 * @param {string} label the run's console label, `<seat>-run<n>`
 * @param {string} dying the dying page's console, read before the kill
 * @param {() => Promise<any>} revive the revival
 */
async function revivingKeepsDying(label, dying, revive) {
  try {
    return await revive();
  } catch (e) {
    const kept = keepConsoles(id, { [`${label}-dying`]: dying, ...(e?.revivedConsole ? { [`${label}-revived`]: e.revivedConsole } : {}) });
    for (const [which, path] of Object.entries(kept ?? {})) console.log(`[${id}] ${label}: the revival failed - ${which} console kept at ${path}`);
    throw e;
  }
}

/** Revives `seat`, reopens the group on it, and settles the run on the server and the seat. */
async function reviveAndSettle(c, seat, how, label, fromEpoch) {
  const revived = await reviveSeat(seat, how, label);
  revived.listedMs = await openRevived(seat, c.group.name);
  // A KEPT COMMIT SETTLES AT THE CONNECTION: given the bound every settlement here gets, then read.
  await awaitClientEpoch(seat.cx, c.group.id, fromEpoch + 1, 30_000);
  const serverEpoch = serverView(c.group.id).activeEpoch;
  const caughtUpMs = await awaitClientEpoch(seat.cx, c.group.id, serverEpoch, 30_000);
  return { revived, serverEpoch, caughtUpMs };
}

/** Both directions of the group, once each, after a run. */
async function trafficBothWays(c, seat, other, i) {
  const out = rowMessageMark(id, `O${i}`);
  const inn = rowMessageMark(id, `I${i}`);
  await send(seat.cx, `${id} run ${i + 1} out [${out}]`);
  await send(other.cx, `${id} run ${i + 1} in [${inn}]`);
  return { outShown: await shownCount(other.cx, out), inShown: await shownCount(seat.cx, inn) };
}

/**
 * Waits until the browser's newest refresh cookie is committed to the profile's cookie file, so a
 * browser kill relaunches on the CURRENT token (`cookieCommitWaitMs`). Returns how long it waited;
 * throws when the browser holds no refresh cookie, a premise the row cannot play without.
 */
async function awaitCookieCommitted(cx, label) {
  const host = new URL(SITE).hostname;
  let waitedMs = 0;
  for (;;) {
    const { cookies } = await cx.send('Network.getAllCookies');
    const refresh = cookies.find((c) => c.name === 'canari_refresh' && c.domain === host);
    const waitMs = cookieCommitWaitMs({ expiresSec: refresh?.expires ?? null, nowMs: Date.now() });
    if (waitMs === null) throw new Error(`${label}: no refresh cookie for ${host} before the kill - the seat is not signed in`);
    if (waitMs === 0) return waitedMs;
    console.log(`[${id}] ${label}: waiting ${waitMs} ms for the newest refresh cookie to reach disk`);
    await sleep(waitMs);
    waitedMs += waitMs;
  }
}

/**
 * One run: a refresh commit held on its side of the server, the kill after the drawn delay (or at the
 * fraction of the measured window), the revival, the outcome.
 */
async function killRun(c, i, { window = null, delayMs = 0, fraction = null, windowMs = null, prevEnd = null }) {
  const killer = spec.devices[0];
  const seat = seats.seat[killer];
  const other = seats.seat.W2;
  // Before the commit is held, never after: the drawn delay places the kill, and nothing may stretch it.
  const cookieWaitMs = spec.kill === 'browser' ? await awaitCookieCommitted(seat.cx, `${killer}#${i + 1}`) : null;
  // THE WINDOW OPENS BEFORE THE EPOCH IS READ, and `strayCommits` sorts what landed in between by the
  // epoch it names - the reverse order counted a commit the epoch read had already seen (KILL-2 run 2).
  const runStart = now();
  const fromEpoch = serverView(c.group.id).activeEpoch;
  // An own commit since the previous run settled, before this one armed anything, is no run's.
  const strays = strayCommits(commitSequence(commitLines(c.group.id, prevEnd ?? runStart)), fromEpoch);
  await armLeafRefresh(seat.cx, c.user[killer], c.device, c.group.id);
  const f = await armFault(seat.cx, [{ ...COMMIT_POST, fault: window ? WINDOWS[window] : 'hold once' }]);
  await send(seat.cx, `${id} run ${i + 1} trigger [${rowMessageMark(id, `K${i}`)}]`);
  const sentAt = Date.now();
  if (fraction === null) {
    await f.awaitHeld(1, 45_000);
    await sleep(delayMs);
  } else {
    await sleep(Math.round(fraction * windowMs));
  }
  const heldAtKill = f.held().length;
  const acceptedAtKill = accepts(runCommits(commitSequence(commitLines(c.group.id, runStart)), fromEpoch));
  const dead = await deadReport(seat.w);
  // THE DYING PAGE'S CONSOLE, read before the kill takes it: the row's end keeps only the last page.
  const dying = consoleDump({ page: { cx: seat.cx } }).page ?? '';
  const killed = await killSeat(seat, spec.kill);
  const { revived, serverEpoch, caughtUpMs } = await revivingKeepsDying(`${killer}-run${i + 1}`, dying, () => reviveAndSettle(c, seat, spec.kill, `${id}:${killer}#${i + 1}`, fromEpoch));
  const seq = runCommits(commitSequence(commitLines(c.group.id, runStart)), fromEpoch);
  const { outShown, inShown } = await trafficBothWays(c, seat, other, i);
  const judged = runOutcome({ window: window ?? 'stage', seq, fromEpoch, serverEpoch, caughtUpMs, outShown, inShown });
  judged.assertions.push(strayCommitsOwn(strays, i === 0 ? 'before the first run armed anything' : `between run ${i} and run ${i + 1}`));
  const consoles = keepConsoles(id, { [`${killer}-run${i + 1}-dying`]: dying, [`${killer}-run${i + 1}-revived`]: consoleDump({ page: { cx: seat.cx } }).page ?? '' });
  const run = { run: i + 1, window: window ?? 'stage', delayMs, fraction, msAfterSend: Date.now() - sentAt, cookieWaitMs, heldAtKill, acceptedAtKill, killed, revived, dead, strays, consoles, endAt: now(), ...judged };
  console.log(`[${id}] run ${i + 1}: ${run.window}${fraction === null ? ` +${delayMs} ms` : ` at ${fraction}`} -> ${judged.outcome}${judged.assertions.every((a) => a.ok) ? '' : ' (FAILING)'}`);
  return run;
}

/**
 * One KILL-3 run: a send (or a receive) on W1, the browser killed `delayMs` after the window's
 * moment, the relaunch, then the killed message and the next message each way counted.
 *
 * THE MOMENT DEPENDS ON THE WINDOW:
 * - in the two held windows, the message POST is held on its side of the server;
 * - in `after-send`, it is the send's answer;
 * - in `after-receive`, it is W2's message showing on W1.
 *
 * Each moment is waited for as an event, and the drawn delay is all that places the kill after it.
 */
async function kill3Run(c, i, { window, delayMs, prevEnd }) {
  const seat = seats.seat.W1;
  const other = seats.seat.W2;
  const cookieWaitMs = await awaitCookieCommitted(seat.cx, `W1#${i + 1}`);
  const runStart = now();
  const fromEpoch = serverView(c.group.id).activeEpoch;
  const strays = strayCommits(commitSequence(commitLines(c.group.id, prevEnd ?? runStart)), fromEpoch);
  const mark = rowMessageMark(id, `K${i}`);
  const receiving = window === 'after-receive';
  const fault = KILL3_WINDOWS[window] ?? 'delay 0 once';
  const f = receiving ? null : await armFault(seat.cx, [{ match: '/api/mls/send', method: 'POST', fault }]);
  let gesture = null;
  let moment = null;
  if (receiving) {
    await send(other.cx, `${id} run ${i + 1} received [${mark}]`);
    moment = await outcome(shownCount(seat.cx, mark).then((n) => (n > 0 ? n : Promise.reject(new Error('never shown on W1')))));
  } else {
    // NOT awaited for the held windows: the composer's send ends on a POST that the hold keeps open.
    gesture = outcome(send(seat.cx, `${id} run ${i + 1} sent [${mark}]`));
    moment = await outcome(KILL3_WINDOWS[window] ? f.awaitHeld(1, 45_000) : f.awaitFired(0, 1, 45_000));
  }
  if (!moment.ok) return { run: i + 1, window, premise: `the ${window} moment never came: ${moment.error}` };
  await sleep(delayMs);
  const dead = await deadReport(seat.w);
  const dying = consoleDump({ page: { cx: seat.cx } }).page ?? '';
  const killed = await killSeat(seat, 'browser');
  const sendGesture = gesture ? await gesture : null;
  const revived = await revivingKeepsDying(`W1-run${i + 1}`, dying, () => reviveSeat(seat, 'browser', `${id}:W1#${i + 1}`));
  revived.listedMs = await openRevived(seat, c.group.name);
  const serverEpoch = serverView(c.group.id).activeEpoch;
  const caughtUpMs = await awaitClientEpoch(seat.cx, c.group.id, serverEpoch, 30_000);
  // A MESSAGE THAT NEVER REACHED THE SERVER IS RESENT OR SHOWN UNSENT. That is read BEFORE the next
  // send, because the queued and in-flight states show on the last own message only. The poll waits
  // for the first of the two, and its bound is an abort: what neither arrived nor said so by then is
  // judged a silent loss.
  const unsent = window === 'send-before-server' ? await awaitDeliveredOrUnsent(seat.cx, other.cx, mark) : null;
  const { outShown, inShown } = await trafficBothWays(c, seat, other, i);
  // READ LAST, after the traffic both ways: a resend the revival owes has had its moment by then.
  const killedShown = (await receivedOn(receiving ? seat.cx : other.cx, mark)).count;
  const seq = runCommits(commitSequence(commitLines(c.group.id, runStart)), fromEpoch);
  const judged = kill3Outcome({ window, killedShown, outShown, inShown, accepts: accepts(seq), moved: serverView(c.group.id).activeEpoch - fromEpoch, caughtUpMs, unsentLabel: unsent?.label ?? null });
  judged.assertions.push(strayCommitsOwn(strays, i === 0 ? 'before the first run armed anything' : `between run ${i} and run ${i + 1}`));
  const consoles = keepConsoles(id, { [`W1-run${i + 1}-dying`]: dying, [`W1-run${i + 1}-revived`]: consoleDump({ page: { cx: seat.cx } }).page ?? '' });
  const run = { run: i + 1, window, delayMs, cookieWaitMs, killed, revived, dead, sendGesture, unsent, strays, consoles, endAt: now(), ...judged };
  console.log(`[${id}] run ${i + 1}: ${window} +${delayMs} ms -> ${judged.outcome}${judged.assertions.every((a) => a.ok) ? '' : ' (FAILING)'}`);
  return run;
}

/** The unsent state `marker`'s own bubble shows (one of `UNSENT_LABELS`), or null; and how many own bubbles carry it. */
const UNSENT_ON = (marker) => `JSON.stringify((function () {
  var labels = ${JSON.stringify(UNSENT_LABELS)};
  var rows = [].slice.call(document.querySelectorAll('[data-own="true"]')).filter(function (r) { return (r.innerText || '').indexOf(${JSON.stringify(marker)}) !== -1; });
  var label = null;
  rows.forEach(function (r) { labels.forEach(function (l) { if (label === null && (r.innerText || '').indexOf(l) !== -1) label = l; }); });
  return { rows: rows.length, label: label };
})())`;

/**
 * Polls until the killed message is on W2 or W1's own bubble says it is unsent, the abort 30 s. The
 * last reading either way, with how long it took.
 */
async function awaitDeliveredOrUnsent(senderCx, peerCx, marker, abortMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const delivered = (await receivedOn(peerCx, marker)).count;
    const own = JSON.parse(await evaluate(senderCx, UNSENT_ON(marker)));
    if (delivered > 0 || own.label !== null || Date.now() - t0 > abortMs) return { delivered, ownRows: own.rows, label: delivered > 0 ? null : own.label, ms: Date.now() - t0 };
    await sleep(500);
  }
}

/** What W1's open member panel shows: its count line and the user ids it offers to remove. */
const PANEL = String.raw`JSON.stringify({ members: (document.body.innerText.match(/MEMBRES\s*\(\d+\)/i) || [''])[0], buttons: [].slice.call(document.querySelectorAll('[data-remove-member]')).map(function (e) { return e.getAttribute('data-remove-member'); }) })`;

/** Reads the panel until it offers every one of `userIds`, or the abort; the last reading either way. */
async function awaitPanelLists(cx, userIds, abortMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const panel = JSON.parse(await evaluate(cx, PANEL));
    if (!panelMissing(panel, userIds).length || Date.now() - t0 > abortMs) return panel;
    await sleep(500);
  }
}

/**
 * Every own commit since the last run settled, read when the row judges - after the invariant's
 * reload too, which commits nothing on a healthy client. No run armed any of them.
 */
function tailStraysOwn(c, runs) {
  const last = runs.at(-1);
  const tail = last ? commitSequence(commitLines(c.group.id, last.endAt)).filter((d) => d.kind === 'ACCEPT') : [];
  return strayCommitsOwn(tail, 'after the last run settled');
}

/**
 * Opens the group on a REVIVED seat once its sidebar lists it: a fresh document draws its conversation
 * list after the unlock, and `openGroup` looked before it had (KILL-5, 2026-10-25: "no sidebar row",
 * the row there seconds later). The wait is recorded; a seat that never lists the group still throws.
 */
async function openRevived(seat, name) {
  const listedMs = await awaitListed(seat.cx, name, 60_000);
  await openGroup(seat.cx, name, { label: id });
  return listedMs;
}

const ACTIONS = {
  /** KILL-1 and KILL-2: alternating windows, a drawn delay inside each. */
  async runs(c) {
    const runs = [];
    for (let i = 0; i < spec.runs; i++) runs.push(await killRun(c, i, { window: windowOf(i), delayMs: delayOf(spec), prevEnd: runs.at(-1)?.endAt ?? null }));
    return { runs, offline: [spec.devices[0]], judge: () => [...killRunsOwn(runs), tailStraysOwn(c, runs)] };
  },

  /** KILL-3: a send or a receive, the browser killed after it, four windows in rotation. */
  async sends(c) {
    const runs = [];
    for (let i = 0; i < spec.runs; i++) {
      const run = await kill3Run(c, i, { window: kill3WindowOf(i), delayMs: delayOf(spec), prevEnd: runs.at(-1)?.endAt ?? null });
      if (run.premise) return { premise: [`run ${run.run}: ${run.premise}`], offline: ['W1'], detail: { runs } };
      runs.push(run);
    }
    return { runs, offline: ['W1'], judge: () => [...kill3WindowsOwn(runs), ...killRunsOwn(runs, { windows: false }), tailStraysOwn(c, runs)] };
  },

  /** KILL-4: one un-killed run measures the stage + checkpoint window; each kill lands at a fraction of it. */
  async stage(c) {
    const seat = seats.seat[spec.devices[0]];
    const fromEpoch = serverView(c.group.id).activeEpoch;
    await armLeafRefresh(seat.cx, c.user[spec.devices[0]], c.device, c.group.id);
    const f = await armFault(seat.cx, [{ ...COMMIT_POST, fault: 'hold once' }]);
    await send(seat.cx, `${id} calibration [${rowMessageMark(id, 'CAL')}]`);
    const t0 = Date.now();
    await f.awaitHeld(1, 45_000);
    const windowMs = Date.now() - t0;
    await f.release();
    await f.disarm();
    await awaitClientEpoch(seat.cx, c.group.id, fromEpoch + 1, 30_000);
    console.log(`[${id}] the send-to-request window measured ${windowMs} ms`);
    const runs = [];
    for (const [i, fraction] of spec.fractions.entries()) runs.push(await killRun(c, i, { fraction, windowMs, prevEnd: runs.at(-1)?.endAt ?? null }));
    return { runs, windowMs, offline: [spec.devices[0]], judge: () => [...stageKillsOwn({ windowMs, runs }), ...killRunsOwn(runs, { windows: false }), tailStraysOwn(c, runs)] };
  },

  /** KILL-5: the Welcome request held, the tab closed; the revived W1 owes it, W2 joins once. */
  async welcome(c) {
    const W1 = seats.seat.W1;
    const f = await armFault(W1.cx, [{ match: '/api/mls/welcome', method: 'POST', fault: 'hold once' }]);
    const g = outcome(addMembers(W1.cx, [c.name(spec.subject)]));
    let heldWelcome = false;
    try {
      await f.awaitHeld(1, 60_000);
      heldWelcome = true;
    } catch (e) {
      return { premise: [`the Welcome request was never held: ${String(e?.message ?? e).slice(0, 160)}`], detail: { gesture: await g } };
    }
    const dead = await deadReport(W1.w);
    const killed = await killSeat(W1, 'tab');
    const gesture = await g;
    const revived = await reviveSeat(W1, 'tab', `${id}:W1`);
    revived.listedMs = await openRevived(W1, c.group.name);
    const W2 = seats.seat.W2;
    const listed = (await awaitListed(W2.cx, c.group.name, 90_000)) !== null;
    const caughtUpMs = listed ? await awaitClientEpoch(W2.cx, c.group.id, serverView(c.group.id).activeEpoch, 60_000) : null;
    // A SECOND COPY, IF ONE COMES, comes from the revived W1's settlement: given the same bound.
    await sleep(15_000);
    const welcome = welcomeLines(consoleLines(W2.cx), c.group.id);
    const seq = commitSequence(commitLines(c.group.id, c.startSince));
    return {
      offline: ['W1'],
      joiners: [],
      detail: { gesture, dead, killed, revived, welcome, decisions: seq },
      judge: () => welcomeOnceOwn({ accepts: accepts(seq), welcome, listed, caughtUpMs, heldWelcome }),
    };
  },

  /** RM-3: the roster delete answered, the tab closed before the Remove commit; then W2 Adds W5. */
  async removal(c) {
    const W1 = seats.seat.W1;
    const W4user = c.user[spec.subject];
    await openGroupSettings(W1.cx);
    // THE PANEL IS THE PREMISE: the removal is a click on the subject's row, so a panel that does not
    // list every invitee the setup's ONE bulk Add admitted asks nothing about the kill (2026-10-25: the
    // panel read only `active` device rows and left out a newcomer whose Welcome was not yet opened,
    // #2433). Waited for as an event - every remove button present - and INVALID with the panel's text.
    const invitees = spec.setup.map((d) => c.user[d]);
    const panel = await awaitPanelLists(W1.cx, invitees);
    const missing = panelMissing(panel, invitees);
    if (missing.length) {
      return { premise: [`W1's panel does not list ${missing.map((u) => u.slice(0, 8)).join(', ')}: ${panel.members || 'no member count'}, remove buttons for ${panel.buttons.map((u) => u.slice(0, 8)).join(', ') || 'nobody'}`], detail: { panel } };
    }
    const f = await armFault(W1.cx, [{ match: `/api/mls/groups/${c.group.id}/members/`, method: 'DELETE', fault: 'hold-answer once' }]);
    const g = outcome(removeMember(W1.cx, W4user, c.group.name, { label: id }));
    try {
      await f.awaitHeld(1, 45_000);
    } catch (e) {
      return { premise: [`the roster delete was never held: ${String(e?.message ?? e).slice(0, 160)}`], detail: { gesture: await g } };
    }
    const dead = await deadReport(W1.w);
    const killed = await killSeat(W1, 'tab');
    const killedMs = Date.parse(killed.killedAt);
    const gesture = await g;
    const atKill = serverView(c.group.id);
    const rosterDropped = !onRoster(atKill, W4user);
    const seatsAtKill = activeSeats(atKill, W4user).length;
    const commitBeforeKill = accepts(commitSequence(commitLines(c.group.id, c.startSince)));
    const revived = await reviveSeat(W1, 'tab', `${id}:W1`);
    revived.listedMs = await openRevived(W1, c.group.name);

    // THE NEXT MEMBER COMMIT: W2 Adds W5.
    const W2 = seats.seat.W2;
    await closeOverlays(W2.cx);
    await openGroup(W2.cx, c.group.name, { navigate: false, label: id });
    const nextAdd = await outcome(addMembers(W2.cx, [c.name(spec.next)]));
    let goneAfterMs = null;
    const deadline = killedMs + spec.boundMs;
    while (Date.now() < deadline) {
      if (activeSeats(serverView(c.group.id), W4user).length === 0) {
        goneAfterMs = Date.now() - killedMs;
        break;
      }
      await sleep(2_000);
    }
    const w5in = onRoster(serverView(c.group.id), c.user[spec.next]);
    return {
      offline: ['W1'],
      members: ['W1', 'W2', ...(w5in ? [spec.next] : [])],
      joiners: w5in ? [spec.next] : [],
      detail: { gesture, dead, killed, revived, nextAdd, rosterDropped, seatsAtKill, commitBeforeKill, goneAfterMs },
      judge: () => removalBoundOwn({ rosterDropped, commitBeforeKill, seatsAtKill, goneAfterMs, boundMs: spec.boundMs }),
    };
  },
};

const ACTION_OF = { 'KILL-1': 'runs', 'KILL-2': 'runs', 'KILL-3': 'sends', 'KILL-4': 'stage', 'KILL-5': 'welcome', 'RM-3': 'removal' };

/** Set up, act, judge. */
async function play() {
  const user = Object.fromEntries(spec.devices.map((d) => [d, userOf(seats, d)]));
  const cx = (d) => seats.seat[d].cx;
  const name = (d) => displayNameOf(user[d]);
  const owner = spec.devices[0];
  const group = await mintRowGroup(cx(owner), id, user[owner]);
  assertRowOwns({ kind: 'group', id: group.id, name: group.name }, id);
  await openGroup(cx(owner), group.name, { navigate: false, label: id });
  const premise = [];
  const setup = spec.setup ?? spec.devices.filter((d) => d !== owner && d !== spec.subject);
  if (setup.length) {
    await addMembers(cx(owner), setup.map(name));
    for (const d of setup) if ((await awaitListed(cx(d), group.name, 60_000)) === null) premise.push(`${d} never listed ${group.name}`);
    await closeOverlays(cx(owner));
  }
  if (premise.length) return { premise, detail: { group: group.id } };
  if (setup.includes('W2')) await openGroup(cx('W2'), group.name, { navigate: false, label: id });

  const fromEpoch = serverView(group.id).activeEpoch;
  const startSince = now();
  const device = await deviceIdOf(cx(owner), user[owner]);
  const c = { user, name, group, fromEpoch, startSince, device };
  const act = await ACTIONS[ACTION_OF[id]](c);
  if (act.premise?.length) return { premise: act.premise, offline: act.offline ?? [], detail: { group: group.id, fromEpoch, ...act.detail } };

  const members = act.members ?? spec.devices;
  for (const d of act.joiners ?? (spec.subject ? [spec.subject] : [])) await awaitListed(cx(d), group.name, 60_000);
  const invariant = await checkInvariant({
    group: group.id,
    targets: seats.targets,
    members,
    conversation: group.name,
    fromEpoch,
    since,
    reload: true,
    watchers: watchersOf(seats),
  });
  const seq = commitSequence(commitLines(group.id, startSince));
  return {
    own: act.judge(),
    invariant,
    offline: act.offline ?? [],
    detail: { group: group.id, name: group.name, fromEpoch, decisions: seq, ...(act.runs ? { runs: act.runs } : {}), ...(act.windowMs ? { windowMs: act.windowMs } : {}), ...act.detail, ...(spec.note ? { note: spec.note } : {}) },
  };
}

try {
  seats = await openSeats(spec.devices, id);
  const out = await play();
  const { verdict, failures } = composeVerdict({ own: out.own ?? [], invariant: out.invariant ?? null, premise: out.premise ?? [] });
  for (const f of failures) console.log(`[${id}] ${f}`);
  console.log(`[${id}] assertions: ${verdict}`);
  const owner = spec.devices[0];
  // THE REVIVED PAGE NARRATES ITS SETTLEMENT; that, and the group's creation, are the row's own.
  // RM-3 adds two: W1's collection of W4's surviving leaf is the REPAIR the row measures (one
  // departed member, the same sweep RM-8 reads), and W2's Add of W5 says what any Add says.
  const ownerLogs = [...GROUP_CREATION_NARRATION, ...(out.detail?.group ? settleNarration(out.detail.group) : [])];
  const logs = id === 'RM-3' ? { [owner]: [...ownerLogs, ...RM8_W1_NARRATION], W2: GROUP_CREATION_NARRATION } : { [owner]: ownerLogs };
  const observers = await observersOf(seats, { logs, offline: out.offline ?? [] });
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
