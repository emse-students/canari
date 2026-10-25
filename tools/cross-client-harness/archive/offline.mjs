/**
 * THE OFFLINE AND DEGRADED-LINK ROWS OF THE 1.4.1 CAMPAIGN - a seat without a working link, for a while.
 *
 *   bun archive/offline.mjs --row OFF-3   # W1's Add kept while it is away three epochs   (W1 W2 W4 W5)
 *   bun archive/offline.mjs --row OFF-5   # A1's radios go in the middle of its Add        (A1 W2, class B)
 *   bun archive/offline.mjs --row NET-1   # an Add of three over 800 ms / 50 kB/s          (W1 W2 W4 W5)
 *   bun archive/offline.mjs --row NET-2   # W2's socket flaps every 10 s for five minutes  (W1 W2)
 *   bun archive/offline.mjs --row NET-3   # a captive portal answers every /api/ call      (W1 W2 W4)
 *   bun archive/offline.mjs --row RM-8    # W2 leaves while its requests fail              (W1 W2)
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2; the table and every judge are
 * `offlinerows.mjs`. OFF-4 is BLOCKED-ON-ACCOUNT (`OFF4_PREMISE`). Every step waits on a fact - a
 * fault firing, a client line, the gateway's reconnection, the server's view - except the two
 * durations the plan itself names as the row's INPUT (NET-2's flap period, NET-3's portal), which are
 * the condition under test and never something asserted.
 */
import { LOGIN_SHOWING, awaitGatewayConnected, evaluate, send } from '../chat.mjs';
import { armFault } from '../fault.mjs';
import { closeOverlays, openGroup } from '../groupnav.mjs';
import { checkInvariant, receivedOn } from '../invariant.mjs';
import {
  COMMIT_POST,
  armLeafRefresh,
  assertRowOwns,
  awaitAddLockFree,
  awaitClientEpoch,
  awaitListed,
  awaitServer,
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
import { ADD_ABANDONED_NOTICE, LOCK_BUDGET_SPENT, OFFLINE_BLOCKED, OFFLINE_ROWS, PORTAL_HTML, RM8_NARRATION, departureOwn, flapOwn, keptRefusedLine, noAnswerLine, portalOwn, slowLinkOwn, staleStageOwn } from '../offlinerows.mjs';
import { errorDetail, finishObserved, record } from '../results.mjs';
import { composeVerdict, invariantDetail, provokedFailures, rowMessageMark } from '../rowkit.mjs';
import { commitSequence, decidedAfter, resubmissionLine, settleNarration, settledOnce } from '../settlerows.mjs';
import { GROUP_CREATION_NARRATION, awaitLine, consoleLines } from '../watch.mjs';
import { addMembers, leaveGroup, openGroupSettings } from './addmember.mjs';
import { armCut, cut, cutHard, degrade } from './net.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (!OFFLINE_ROWS[id]) {
  console.error(`usage: bun archive/offline.mjs --row ${Object.keys(OFFLINE_ROWS).join('|')}  (OFF-4 is BLOCKED-ON-ACCOUNT)`);
  process.exit(2);
}
if (OFFLINE_BLOCKED[id]) {
  console.error(`${id}: ${OFFLINE_BLOCKED[id]}`);
  process.exit(2);
}
const spec = OFFLINE_ROWS[id];
const since = new Date().toISOString();
let seats = null;
const now = () => new Date().toISOString();
const outcome = (p) =>
  p.then(
    (value) => ({ ok: true, value }),
    (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 300) })
  );
const loggedOut = async (cx) => (await evaluate(cx, LOGIN_SHOWING)) === true;

/**
 * Waits for the gesture's commit to be HELD, and when it never comes, says what the GESTURE did. A
 * pick that failed is otherwise swallowed by `outcome` and the row reports only "1 held request(s)
 * never happened" (OFF-5, 2026-10-25: the app logged nothing at all, and the cause was unreadable).
 */
async function awaitHeldOrSay(f, g, timeoutMs) {
  try {
    await f.awaitHeld(1, timeoutMs);
  } catch (e) {
    const settled = await Promise.race([g, new Promise((r) => setTimeout(() => r({ pending: true }), 1000))]);
    throw new Error(`${String(e?.message ?? e)}; the gesture: ${JSON.stringify(settled)}`);
  }
}

/** Restores a cut and waits for the gateway; the ms it took, or null. */
async function restoreAndReconnect(cx, restore, timeoutMs = 45_000) {
  const before = cx.events.length;
  await restore();
  return awaitGatewayConnected(cx, before, timeoutMs);
}

/** Polls one client's pane until `marker` shows; its count then, or 0 at the bound. */
async function shownCount(cx, marker, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = (await receivedOn(cx, marker)).count;
    if (n > 0 || Date.now() > deadline) return n;
    await new Promise((r) => setTimeout(r, 400));
  }
}

const ACTIONS = {
  /**
   * OFF-3: W1's Add of W5 is held before the server, W1 is cut and the request failed - a kept stage,
   * offline. W2 moves the group three epochs; W1 comes back.
   */
  async 'OFF-3'(c) {
    const W1 = c.cx('W1');
    const W2 = c.cx('W2');
    const premise = [];
    const rules = [{ ...COMMIT_POST, fault: 'hold once' }];
    const f = await armFault(W1, rules);
    const g = outcome(addMembers(W1, [c.name(spec.subject)]));
    await awaitHeldOrSay(f, g, 45_000);
    const cutW1 = await cutHard(W1);
    await f.fail();
    const unknown = await awaitLine(W1, resubmissionLine(c.group.id, c.fromEpoch, 'unknown'), 30_000);
    const gesture = await g;
    const rep = await f.disarm();

    // W2 MOVES THE GROUP THREE EPOCHS: an Add of W4 (its own commit, which makes its leaf its own),
    // then two refreshes of that leaf.
    let advanced = 0;
    // W1 TOOK THE ADD LOCK and was cut holding it; W2's Add is refused until the server drops it.
    const lockFreedMs = await awaitAddLockFree(c.group.id, 45_000);
    if (lockFreedMs === null) premise.push("W1's add lock was still held on the server 45 s after its cut");
    await closeOverlays(W2);
    await openGroup(W2, c.group.name, { navigate: false, label: id });
    const w4 = await outcome(addMembers(W2, [c.name('W4')]));
    if ((await awaitServer(c.group.id, (v) => v.activeEpoch > c.fromEpoch, 30_000)).settled) advanced++;
    else premise.push(`W2's Add of W4 did not land (${w4.error ?? 'no epoch move'})`);
    const w2dev = await deviceIdOf(W2, c.user.W2);
    await closeOverlays(W2);
    for (let i = 0; i < spec.advance - 1 && !premise.length; i++) {
      const at = serverView(c.group.id).activeEpoch;
      try {
        await armLeafRefresh(W2, c.user.W2, w2dev, c.group.id);
      } catch (e) {
        premise.push(`W2 refresh ${i + 1}: ${String(e?.message ?? e)}`);
        break;
      }
      await send(W2, `${id} refresh ${i + 1} [${rowMessageMark(id, `R${i}`)}]`);
      if ((await awaitServer(c.group.id, (v) => v.activeEpoch > at, 30_000)).settled) advanced++;
      else premise.push(`W2 refresh ${i + 1} did not move the epoch`);
    }

    const returnedAt = now();
    const gatewayMs = await restoreAndReconnect(W1, cutW1.restore);
    const clearedLine = await awaitLine(W1, keptRefusedLine(c.group.id, c.fromEpoch), 45_000);
    const caughtUpMs = await awaitClientEpoch(W1, c.group.id, serverView(c.group.id).activeEpoch, 45_000);
    // THE RE-ISSUE IS GIVEN THE SAME BOUND AS EVERY SETTLEMENT HERE; its absence is the finding.
    // THE OTHER WAY THE INTENT IS KEPT: abandoned with a typed notice (`ADD_ABANDONED_NOTICE`, empty until the fix names it).
    const notices = consoleLines(W1).filter((l) => ADD_ABANDONED_NOTICE.some((re) => re.test(l))).length;
    const reissued = await awaitServer(c.group.id, (v) => (v.roster ?? []).some((r) => r.userId.toLowerCase() === c.user[spec.subject].toLowerCase()), 45_000);
    return {
      premise,
      records: { W1: rep.records },
      offline: ['W1'],
      members: reissued.settled ? spec.devices : spec.devices.filter((d) => d !== spec.subject),
      joiners: ['W4', ...(reissued.settled ? [spec.subject] : [])],
      narration: { W1: settleNarration(c.group.id) },
      detail: { gesture, notices, lockFreedMs, w2Add: w4, clientUnknown: unknown, gatewayMs, clearedLine, caughtUpMs, returnedAt },
      judge: (view) => staleStageOwn({ seqAfter: commitSequence(commitLines(c.group.id, returnedAt)), clearedLine, caughtUpMs, view, subject: c.user[spec.subject], advanced, notices }),
    };
  },

  /** OFF-5: OFF-2 on A1, with the radios as the cut. */
  async 'OFF-5'(c) {
    const A1 = c.cx('A1');
    const phone = await import('../phone.mjs');
    // `useDevice` in `phone.mjs`: the radios belong to the phone this row names, never "the attached one".
    phone.useDevice('A1');
    const { estateReverse, sitePort } = await import('../a1apk.mjs');
    const local = sitePort() !== null;
    const radios = (on) => {
      phone.sh(`svc wifi ${on ? 'enable' : 'disable'}`);
      phone.sh(`svc data ${on ? 'enable' : 'disable'}`);
      if (local) estateReverse(on);
    };
    const rules = [{ ...COMMIT_POST, fault: 'hold-answer once' }];
    const f = await armFault(A1, rules);
    const g = outcome(addMembers(A1, [c.name(spec.subject)]));
    await awaitHeldOrSay(f, g, 60_000);
    radios(false);
    let unknown = null;
    let returnedAt = null;
    let gatewayMs = null;
    let seqBefore = [];
    try {
      await f.fail();
      unknown = await awaitLine(A1, resubmissionLine(c.group.id, c.fromEpoch, 'unknown'), 45_000);
      seqBefore = commitSequence(commitLines(c.group.id, c.startSince));
    } finally {
      returnedAt = now();
      const before = A1.events.length;
      radios(true);
      gatewayMs = await awaitGatewayConnected(A1, before, 90_000);
    }
    const gesture = await g;
    const rep = await f.disarm();
    const settled = await awaitLine(A1, resubmissionLine(c.group.id, c.fromEpoch, 'accepted'), 60_000);
    const stillInFront = phone.foregrounded();
    return {
      records: { A1: rep.records },
      offline: ['A1'],
      members: spec.devices,
      joiners: [spec.subject],
      narration: { A1: settleNarration(c.group.id) },
      detail: { gesture, clientUnknown: unknown, gatewayMs, clientSettled: settled, stillInFront, decidedBeforeReturn: seqBefore, local },
      judge: (view, seq) => {
        const after = commitSequence(commitLines(c.group.id, returnedAt));
        return [
          { what: `the server accepted the Add before the radios went (${seqBefore.filter((d) => d.kind === 'ACCEPT').length})`, ok: seqBefore.filter((d) => d.kind === 'ACCEPT').length === 1 },
          { what: `A1 kept the stage with no radio (${unknown ?? 'no line'})`, ok: !!unknown },
          { what: `A1's gateway reconnected when the radios came back (${gatewayMs ?? 'never'} ms)`, ok: gatewayMs !== null },
          decidedAfter('the radios came back', after, 'DUPLICATE'),
          { what: `settled at that connection, the app never reopened (${settled ? 'settled' : 'not settled'}, ${stillInFront ? 'still in front' : 'NOT in front'})`, ok: !!settled && stillInFront },
          ...settledOnce({ fromEpoch: c.fromEpoch, view, seq, joined: [c.user[spec.subject]] }),
        ];
      },
    };
  },

  /** NET-1: one bulk Add of three over a slow link on the committer. */
  async 'NET-1'(c) {
    const W1 = c.cx('W1');
    const link = await degrade(W1, spec.link);
    let gesture;
    let landed;
    try {
      gesture = await outcome(addMembers(W1, spec.subjects.map(c.name)));
      landed = await awaitServer(
        c.group.id,
        (v) => spec.subjects.every((d) => (v.seats ?? []).some((s) => s.userId.toLowerCase() === c.user[d].toLowerCase() && s.status === 'active')),
        120_000
      );
    } finally {
      await link.restore();
    }
    const budgetLines = consoleLines(W1).filter((t) => t.includes(LOCK_BUDGET_SPENT) && t.includes(c.group.id.slice(0, 8)));
    return {
      records: {},
      offline: [],
      members: spec.devices,
      joiners: spec.subjects,
      narration: { W1: settleNarration(c.group.id) },
      detail: { gesture, link: spec.link, landedInTime: landed.settled, budgetLines, loss: 'not emulated - CDP has no loss rate' },
      judge: (view, seq) => slowLinkOwn({ view, subjects: spec.subjects.map((d) => c.user[d]), budgetLines, accepts: seq.filter((d) => d.kind === 'ACCEPT').length }),
    };
  },

  /**
   * NET-2: a tick every `tickMs`; W1 sends on every tick and refreshes its leaf every `refreshEvery`;
   * W2's socket is cut on one tick in `flapEvery` and restored on the next.
   */
  async 'NET-2'(c) {
    const W1 = c.cx('W1');
    const W2 = c.cx('W2');
    const w1dev = await deviceIdOf(W1, c.user.W1);
    const marks = [];
    const reconnects = [];
    const refreshErrors = [];
    let flaps = 0;
    let down = null;
    for (let t = 0; t < spec.ticks; t++) {
      const tickEnd = Date.now() + spec.tickMs;
      if (t % spec.flapEvery === 0) {
        down = await cutHard(W2);
        flaps++;
      } else if (down) {
        reconnects.push(await restoreAndReconnect(W2, down.restore, spec.tickMs));
        down = null;
      }
      if (t > 0 && t % spec.refreshEvery === 0) {
        await armLeafRefresh(W1, c.user.W1, w1dev, c.group.id).catch((e) => refreshErrors.push(String(e?.message ?? e)));
      }
      const m = rowMessageMark(id, `T${t}`);
      await send(W1, `${id} tick ${t + 1}/${spec.ticks} [${m}]`);
      marks.push(m);
      const left = tickEnd - Date.now();
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    }
    if (down) reconnects.push(await restoreAndReconnect(W2, down.restore));
    await awaitClientEpoch(W2, c.group.id, serverView(c.group.id).activeEpoch, 60_000);
    await openGroup(W2, c.group.name, { navigate: false, label: id });
    const shown = {};
    for (const m of marks) shown[m] = await shownCount(W2, m, 5_000);
    return {
      records: {},
      offline: ['W2'],
      members: spec.devices,
      joiners: [],
      narration: { W1: settleNarration(c.group.id) },
      detail: { flaps, reconnects, refreshErrors, sent: marks.length },
      judge: () => flapOwn({ shown, flaps, reconnects }),
    };
  },

  /** NET-3: every /api/ call of W1's answered 200 text/html for `portalMs`, while W1 Adds W4 and sends. */
  async 'NET-3'(c) {
    const W1 = c.cx('W1');
    const portal = { status: 200, body: PORTAL_HTML, contentType: 'text/html; charset=utf-8' };
    // THE PORTAL GOES UP ONLY ONCE THE COMMIT IS HELD. Armed with the picks (2026-10-25, alpha.3), a
    // portal on every /api/ call answered the Add's own pre-checks (block status, members) first: the
    // client skipped the invitee, no commit was ever made, and the row judged a commit that did not
    // exist. So the commit is HELD, the portal is opened, and the held commit gets the portal's page.
    let portalUp = false;
    const rules = [
      { ...COMMIT_POST, fault: 'hold once' },
      { match: '/api/', fault: 'status-unsent 200', body: portal.body, contentType: portal.contentType, when: () => portalUp },
    ];
    const mark = rowMessageMark(id, 'P');
    let f = null;
    let portalEnds = 0;
    let loggedOutDuring = false;
    let gesture = null;
    let sendOutcome = null;
    let commitAnswered = 0;
    let rep = { records: [] };
    try {
      const g = outcome(
        addMembers(W1, [c.name(spec.subject)], {
          beforeSubmit: async () => {
            f = await armFault(W1, rules);
          },
        })
      );
      // The fault exists once the picks are made; until then only the gesture can say anything.
      let settled = false;
      void g.then(() => (settled = true));
      const armedBy = Date.now() + 60_000;
      while (!f && !settled && Date.now() < armedBy) await new Promise((r) => setTimeout(r, 250));
      if (!f) return { premise: [`the Add never reached its submission (${(await g).error ?? 'no error'})`], records: {}, offline: [], detail: { gesture: await g } };
      await awaitHeldOrSay(f, g, 45_000);
      portalUp = true;
      portalEnds = Date.now() + spec.portalMs;
      commitAnswered = await f.answerHeld(portal);
      gesture = await g;
      await closeOverlays(W1);
      sendOutcome = await outcome(send(W1, `${id} under the portal [${mark}]`));
      loggedOutDuring = await loggedOut(W1);
      const left = portalEnds - Date.now();
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      loggedOutDuring = loggedOutDuring || (await loggedOut(W1));
    } finally {
      if (f) rep = await f.disarm();
    }
    const noAnswer = await awaitLine(W1, noAnswerLine(c.group.id, c.fromEpoch), 5_000);
    const clearedLine = await awaitLine(W1, keptRefusedLine(c.group.id, c.fromEpoch), 1_000);
    // RECOVERY: the next send settles a kept commit (`settleBeforeSend`) - the outbox's own, or ours.
    await send(W1, `${id} after the portal [${rowMessageMark(id, 'A')}]`).catch(() => {});
    const joined = (await awaitServer(c.group.id, (v) => (v.seats ?? []).some((s) => s.userId.toLowerCase() === c.user[spec.subject].toLowerCase() && s.status === 'active'), 60_000)).settled;
    await openGroup(c.cx('W2'), c.group.name, { navigate: false, label: id });
    const messageShown = await shownCount(c.cx('W2'), mark, 60_000);
    const loggedOutAfter = await loggedOut(W1);
    return {
      records: { W1: rep.records },
      offline: [],
      members: joined ? spec.devices : spec.devices.filter((d) => d !== spec.subject),
      joiners: joined ? [spec.subject] : [],
      narration: { W1: settleNarration(c.group.id) },
      premise: commitAnswered === 1 ? [] : [`the held commit was not answered by the portal (${commitAnswered})`],
      detail: { gesture, sendOutcome, portalMs: spec.portalMs, answered: rep.records.length, commitAnswered, noAnswer, clearedLine },
      judge: () => portalOwn({ loggedOutDuring, loggedOutAfter, noAnswer, clearedLine, joined, messageShown }),
    };
  },

  /** RM-8: W2 leaves while `cut()` fails every request it makes; then the link comes back. */
  async 'RM-8'(c) {
    const W2 = c.cx('W2');
    await closeOverlays(W2);
    await openGroup(W2, c.group.name, { navigate: false, label: id });
    await openGroupSettings(W2);
    const link = await cut(W2);
    let gesture;
    try {
      gesture = await outcome(leaveGroup(W2, c.group.name, { label: id }));
    } finally {
      await link.restore();
    }
    // THE TWO SIDES ARE GIVEN TIME TO AGREE, and the row records whether they did - never a guess at which.
    const deadline = Date.now() + 60_000;
    let listed;
    let view;
    let atServerEpoch = false;
    for (;;) {
      view = serverView(c.group.id);
      listed = (await awaitListed(W2, c.group.name, 1_000)) !== null;
      atServerEpoch = listed && (await awaitClientEpoch(W2, c.group.id, view.activeEpoch, 1_000)) !== null;
      const onServer = (view.roster ?? []).some((r) => r.userId.toLowerCase() === c.user.W2.toLowerCase());
      if (onServer === listed || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    const stayed = (view.roster ?? []).some((r) => r.userId.toLowerCase() === c.user.W2.toLowerCase());
    return {
      records: {},
      offline: ['W2'],
      members: stayed ? spec.devices : ['W1'],
      joiners: [],
      // THE EXIT REPLAY IS THE MECHANISM UNDER TEST (#2259): its narration is expected. So is the
      // `memberLeft` notice the cut loses - a named P3 (backlog), expected in THIS row only.
      narration: { W2: RM8_NARRATION },
      detail: { gesture, stayed, listed, atServerEpoch },
      judge: (v) => departureOwn({ view: v, user: c.user.W2, listed, atServerEpoch, gesture }),
    };
  },
};

/** Set up, act, judge. */
async function play() {
  const user = Object.fromEntries(spec.devices.map((d) => [d, userOf(seats, d)]));
  const cx = (d) => seats.seat[d].cx;
  const name = (d) => displayNameOf(user[d]);
  const owner = spec.devices[0];
  if (['OFF-3'].includes(id)) await armCut(cx('W1'));
  if (['NET-2'].includes(id)) await armCut(cx('W2'));

  const group = await mintRowGroup(cx(owner), id, user[owner]);
  assertRowOwns({ kind: 'group', id: group.id, name: group.name }, id);
  await openGroup(cx(owner), group.name, { navigate: false, label: id });
  const premise = [];
  const setup = spec.setup ?? (spec.subject === 'W2' || spec.subjects?.includes('W2') ? [] : ['W2']);
  if (setup.length) {
    await addMembers(cx(owner), setup.map(name));
    for (const d of setup) if ((await awaitListed(cx(d), group.name, 60_000)) === null) premise.push(`${d} never listed ${group.name}`);
    await closeOverlays(cx(owner));
  }
  if (premise.length) return { premise, detail: { group: group.id } };

  const fromEpoch = serverView(group.id).activeEpoch;
  const startSince = now();
  const act = await ACTIONS[id]({ cx, user, name, group, fromEpoch, startSince });
  const base = { records: act.records, offline: act.offline, narration: act.narration ?? {} };
  if (act.premise?.length) return { ...base, premise: act.premise, detail: { group: group.id, fromEpoch, ...act.detail } };

  for (const d of act.joiners ?? []) await awaitListed(cx(d), group.name, 60_000);
  const invariant = await checkInvariant({
    group: group.id,
    targets: seats.targets,
    members: act.members,
    conversation: group.name,
    fromEpoch,
    since,
    reload: true,
    watchers: watchersOf(seats),
    provoked: Object.fromEntries(Object.entries(act.records ?? {}).map(([d, r]) => [d, provokedFailures(r)])),
  });
  const view = serverView(group.id);
  const seq = commitSequence(commitLines(group.id, startSince));
  return {
    ...base,
    own: act.judge(view, seq),
    invariant,
    detail: { group: group.id, name: group.name, fromEpoch, decisions: seq, ...act.detail, faultRecords: act.records, ...(spec.note ? { note: spec.note } : {}) },
  };
}

try {
  seats = await openSeats(spec.devices, id);
  const out = await play();
  const { verdict, failures } = composeVerdict({ own: out.own ?? [], invariant: out.invariant ?? null, premise: out.premise ?? [] });
  for (const f of failures) console.log(`[${id}] ${f}`);
  console.log(`[${id}] assertions: ${verdict}`);
  const owner = spec.devices[0];
  const logs = { [owner]: [...GROUP_CREATION_NARRATION] };
  for (const [d, n] of Object.entries(out.narration ?? {})) logs[d] = [...(logs[d] ?? []), ...n];
  const observers = await observersOf(seats, { logs, provoked: out.records ?? {}, offline: out.offline ?? [] });
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
