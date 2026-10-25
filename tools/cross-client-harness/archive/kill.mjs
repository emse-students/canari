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
import { send } from '../chat.mjs';
import { armFault } from '../fault.mjs';
import { closeOverlays, openGroup } from '../groupnav.mjs';
import { checkInvariant, receivedOn } from '../invariant.mjs';
import { KILL_ROWS, WINDOWS, delayOf, killRunsOwn, removalBoundOwn, runOutcome, stageKillsOwn, welcomeLines, welcomeOnceOwn, windowOf } from '../killrows.mjs';
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
import { errorDetail, finishObserved, record } from '../results.mjs';
import { composeVerdict, invariantDetail, rowMessageMark } from '../rowkit.mjs';
import { commitSequence, settleNarration } from '../settlerows.mjs';
import { GROUP_CREATION_NARRATION, consoleLines, report } from '../watch.mjs';
import { addMembers, openGroupSettings, removeMember } from './addmember.mjs';
import { killSeat, reviveSeat } from './reopen.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (!KILL_ROWS[id]) {
  console.error(`usage: bun archive/kill.mjs --row ${Object.keys(KILL_ROWS).join('|')}`);
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
  await openGroup(seat.cx, c.group.name, { label: id });
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
 * One run: a refresh commit held on its side of the server, the kill after the drawn delay (or at the
 * fraction of the measured window), the revival, the outcome.
 */
async function killRun(c, i, { window = null, delayMs = 0, fraction = null, windowMs = null }) {
  const killer = spec.devices[0];
  const seat = seats.seat[killer];
  const other = seats.seat.W2;
  const fromEpoch = serverView(c.group.id).activeEpoch;
  const runStart = now();
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
  const acceptedAtKill = accepts(commitSequence(commitLines(c.group.id, runStart)));
  const dead = await deadReport(seat.w);
  const killed = await killSeat(seat, spec.kill);
  const { revived, serverEpoch, caughtUpMs } = await reviveAndSettle(c, seat, spec.kill, `${id}:${killer}#${i + 1}`, fromEpoch);
  const seq = commitSequence(commitLines(c.group.id, runStart));
  const { outShown, inShown } = await trafficBothWays(c, seat, other, i);
  const judged = runOutcome({ window: window ?? 'stage', seq, fromEpoch, serverEpoch, caughtUpMs, outShown, inShown });
  const run = { run: i + 1, window: window ?? 'stage', delayMs, fraction, msAfterSend: Date.now() - sentAt, heldAtKill, acceptedAtKill, killed, revived, dead, ...judged };
  console.log(`[${id}] run ${i + 1}: ${run.window}${fraction === null ? ` +${delayMs} ms` : ` at ${fraction}`} -> ${judged.outcome}${judged.assertions.every((a) => a.ok) ? '' : ' (FAILING)'}`);
  return run;
}

const ACTIONS = {
  /** KILL-1..3: alternating windows, a drawn delay inside each. */
  async runs(c) {
    const runs = [];
    for (let i = 0; i < spec.runs; i++) runs.push(await killRun(c, i, { window: windowOf(i), delayMs: delayOf(spec) }));
    return { runs, offline: [spec.devices[0]], judge: () => killRunsOwn(runs) };
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
    for (const [i, fraction] of spec.fractions.entries()) runs.push(await killRun(c, i, { fraction, windowMs }));
    return { runs, windowMs, offline: [spec.devices[0]], judge: () => [...stageKillsOwn({ windowMs, runs }), ...killRunsOwn(runs, { windows: false })] };
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
    await openGroup(W1.cx, c.group.name, { label: id });
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
    await openGroup(W1.cx, c.group.name, { label: id });

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
  const observers = await observersOf(seats, { logs: { [owner]: [...GROUP_CREATION_NARRATION, ...(out.detail?.group ? settleNarration(out.detail.group) : [])] }, offline: out.offline ?? [] });
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
