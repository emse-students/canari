/**
 * THE KILL ROWS OF THE 1.4.1 CAMPAIGN - a process that dies with a commit in flight.
 *
 *   bun archive/kill.mjs --row KILL-1   # W1's tab closed, 20 runs                       (W1 W2)
 *   bun archive/kill.mjs --row KILL-2   # W1's whole browser killed, 10 runs              (W1 W2)
 *   bun archive/kill.mjs --row KILL-3   # A1 swiped from recents, 10 runs                 (A1 W2, class B)
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
import { KILL_BLOCKED, KILL_ROWS, WINDOWS, cookieCommitWaitMs, delayOf, killRunsOwn, panelMissing, removalBoundOwn, runCommits, runOutcome, stageKillsOwn, strayCommits, strayCommitsOwn, welcomeLines, welcomeOnceOwn, windowOf } from '../killrows.mjs';
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
  const { revived, serverEpoch, caughtUpMs } = await reviveAndSettle(c, seat, spec.kill, `${id}:${killer}#${i + 1}`, fromEpoch);
  const seq = runCommits(commitSequence(commitLines(c.group.id, runStart)), fromEpoch);
  const { outShown, inShown } = await trafficBothWays(c, seat, other, i);
  const judged = runOutcome({ window: window ?? 'stage', seq, fromEpoch, serverEpoch, caughtUpMs, outShown, inShown });
  judged.assertions.push(strayCommitsOwn(strays, i === 0 ? 'before the first run armed anything' : `between run ${i} and run ${i + 1}`));
  const consoles = keepConsoles(id, { [`${killer}-run${i + 1}-dying`]: dying, [`${killer}-run${i + 1}-revived`]: consoleDump({ page: { cx: seat.cx } }).page ?? '' });
  const run = { run: i + 1, window: window ?? 'stage', delayMs, fraction, msAfterSend: Date.now() - sentAt, cookieWaitMs, heldAtKill, acceptedAtKill, killed, revived, dead, strays, consoles, endAt: now(), ...judged };
  console.log(`[${id}] run ${i + 1}: ${run.window}${fraction === null ? ` +${delayMs} ms` : ` at ${fraction}`} -> ${judged.outcome}${judged.assertions.every((a) => a.ok) ? '' : ' (FAILING)'}`);
  return run;
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
  /** KILL-1..3: alternating windows, a drawn delay inside each. */
  async runs(c) {
    const runs = [];
    for (let i = 0; i < spec.runs; i++) runs.push(await killRun(c, i, { window: windowOf(i), delayMs: delayOf(spec), prevEnd: runs.at(-1)?.endAt ?? null }));
    return { runs, offline: [spec.devices[0]], judge: () => [...killRunsOwn(runs), tailStraysOwn(c, runs)] };
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

const ACTION_OF = { 'KILL-1': 'runs', 'KILL-2': 'runs', 'KILL-3': 'runs', 'KILL-4': 'stage', 'KILL-5': 'welcome', 'RM-3': 'removal' };

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
