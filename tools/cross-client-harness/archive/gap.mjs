/**
 * THE GAP ROWS OF THE 1.4.1 CAMPAIGN - a member whose frames do not arrive in the order they were made.
 *
 *   bun archive/gap.mjs --row GAP-1   # frames of N+2 before the commits N+1, N+2      (W1 W2 W4 W5)
 *   bun archive/gap.mjs --row GAP-2   # past-epoch frames, another's and our own, again (W1 W2)
 *   bun archive/gap.mjs --row GAP-3   # W2 never sees the first 2000+ frames            (W1 W2, ~40 min)
 *   bun archive/gap.mjs --row GAP-4   # records SKIPPED: the shared-payload writer stays off
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2; the table, the pull rewrites and every judge
 * are `gaprows.mjs`, whose header says why the PENDING PULL is the one lever a client-side rig has on
 * the order of a member's stream. Every row takes W2 off the network (`net.mjs` `armCut` at the start,
 * `cutHard` in the row), lets the server queue what W2 misses, and rewrites the pull W2 drains on its
 * return. Each step waits on a fact - the gateway's reconnection, a rewrite firing, a held request, a
 * frame received on W2's socket, W2's own console line - never a sleep. The invariant (R8) runs after,
 * with the row's watchers; W2's console is read for the row's own lines BEFORE it, because `report()`
 * drains the events.
 */
import { awaitGatewayConnected, send } from '../chat.mjs';
import { psql } from '../estate.mjs';
import { armFault } from '../fault.mjs';
import { GAP4_SKIP, GAP_ROWS, COMMIT_LOG, PENDING_PULL, captureRows, dropCommitRows, gapOneOwn, injectRows, linesAbout, ownEchoLine, pastFrameOwn, readdressRow, startAfter, tooDistantOwn } from '../gaprows.mjs';
import { closeOverlays, openGroup } from '../groupnav.mjs';
import { checkInvariant, receivedOn } from '../invariant.mjs';
import {
  armLeafRefresh,
  assertRowOwns,
  awaitClientEpoch,
  awaitListed,
  awaitServer,
  closeSeats,
  deviceIdOf,
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
import { GROUP_CREATION_NARRATION, awaitLine, consoleLines } from '../watch.mjs';
import { addMembers } from './addmember.mjs';
import { armCut, cutHard } from './net.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (id === 'GAP-4') {
  record('GAP-4', 'SKIPPED', { reason: GAP4_SKIP });
  exitOnRecorded();
}
if (!GAP_ROWS[id]) {
  console.error(`usage: bun archive/gap.mjs --row ${Object.keys(GAP_ROWS).join('|')}|GAP-4`);
  process.exit(2);
}
const spec = GAP_ROWS[id];
const since = new Date().toISOString();
let seats = null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Polls one client's pane until `marker` shows; its count then, or 0 at the bound. */
async function shownCount(cx, marker, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = (await receivedOn(cx, marker)).count;
    if (n > 0 || Date.now() > deadline) return n;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Socket frames W2 received for `groupId` since event `index` - the fact that a live send reached it. */
const framesFor = (cx, groupId, index) =>
  cx.events.slice(index).filter((e) => e.method === 'Network.webSocketFrameReceived' && String(e.params?.response?.payloadData ?? '').includes(groupId)).length;

/** Waits until W2 has received `n` socket frames for `groupId` since `index`; the count reached. */
async function awaitFrames(cx, groupId, index, n, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = framesFor(cx, groupId, index);
    if (got >= n || Date.now() > deadline) return got;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Takes a seat off the network, runs `whileCut`, restores it and waits for its gateway. */
async function offAndBack(cx, label, whileCut, { onReturn = null } = {}) {
  const c = await cutHard(cx);
  console.log(`[${id}] ${label} cut (${c.socketsClosed} socket(s) closed)`);
  const during = await whileCut();
  if (onReturn) await onReturn();
  const before = cx.events.length;
  await c.restore();
  const gatewayMs = await awaitGatewayConnected(cx, before, 45_000);
  console.log(`[${id}] ${label} back; gateway ${gatewayMs === null ? 'NOT reconnected' : `in ${gatewayMs} ms`}`);
  return { during, gatewayMs, backIndex: before };
}

const ACTIONS = {
  /**
   * GAP-1: W1 commits N+1 and N+2 (two Adds) and sends at N+2 while W2 is cut. On W2's return its
   * pull loses this group's commit rows, so the frames meet a member at N; rung 1's commit-log fetch
   * is HELD while W1 sends live, then released.
   */
  async 'GAP-1'(c) {
    const W1 = c.cx('W1');
    const W2 = c.cx('W2');
    const premise = [];
    const marks = [];
    let f = null;
    let liveFrames = 0;
    let heldMs = null;
    const back = await offAndBack(
      W2,
      'W2',
      async () => {
        for (const [i, d] of spec.adds.entries()) {
          await addMembers(W1, [c.name(d)]);
          await closeOverlays(W1);
          const moved = await awaitServer(c.group.id, (v) => v.activeEpoch >= c.fromEpoch + i + 1, 30_000);
          if (!moved.settled) premise.push(`W1's Add of ${d} did not land within 30 s`);
          if ((await awaitListed(c.cx(d), c.group.name, 60_000)) === null) premise.push(`${d} never listed ${c.group.name}`);
        }
        for (let i = 0; i < spec.queued; i++) {
          const m = rowMessageMark(id, `Q${i}`);
          await send(W1, `${id} queued ${i + 1}/${spec.queued} [${m}]`);
          marks.push(m);
        }
      },
      {
        // ARMED WHILE W2 IS STILL CUT, so the first pull of its return is the one rewritten.
        onReturn: async () => {
          f = await armFault(W2, [
            { ...PENDING_PULL, fault: 'rewrite', transform: dropCommitRows(c.group.id) },
            { ...COMMIT_LOG, fault: 'hold-answer' },
          ]);
        },
      }
    );
    let rep = null;
    try {
      await f.awaitFired(0, 1, 30_000).catch(() => {});
      await f.awaitHeld(1, 30_000).catch(() => premise.push("rung 1's commit-log fetch never came within 30 s of the pull - no gap was met"));
      const heldAt = Date.now();
      const liveIndex = W2.events.length;
      for (let i = 0; i < spec.live; i++) {
        const m = rowMessageMark(id, `L${i}`);
        await send(W1, `${id} live ${i + 1}/${spec.live} [${m}]`);
        marks.push(m);
      }
      liveFrames = await awaitFrames(W2, c.group.id, liveIndex, spec.live);
      heldMs = Date.now() - heldAt;
      await f.release();
    } finally {
      rep = await f.disarm();
    }
    await openGroup(W2, c.group.name, { navigate: false, label: id });
    const shown = {};
    for (const m of marks) shown[m] = await shownCount(W2, m);
    const lines = linesAbout(consoleLines(W2), c.group.id);
    const dropped = rep.records.filter((r) => r.rule === 0).flatMap((r) => r.dropped ?? []);
    const held = rep.records.filter((r) => r.rule === 1).length;
    return {
      premise,
      records: { W2: rep.records },
      vacuous: dropped.length === 0 ? [{ rule: 0, fault: 'W2 rewrite (no commit row was in the pull)' }] : [],
      offline: ['W2'],
      joiners: spec.adds,
      narration: { W2: [`[GAP] ${c.group.id.slice(0, 8)}`] },
      detail: { gatewayMs: back.gatewayMs, dropped, held, heldMs, liveFrames, shown, gapLines: lines.gap.slice(0, 5) },
      own: gapOneOwn({ dropped, held, shown, lines }),
    };
  },

  /**
   * GAP-2: one frame of W1's and one of W2's own are CAPTURED from the pulls that drain them (each
   * reader cut while the other sends), the group moves three epochs (W1's leaf refreshes), and both
   * frames are handed to W2 again at the front of a later pull.
   */
  async 'GAP-2'(c) {
    const W1 = c.cx('W1');
    const W2 = c.cx('W2');
    const premise = [];
    const records = { W1: [], W2: [] };
    const sameGroup = (r) => String(r?.groupId ?? '').toLowerCase() === c.group.id.toLowerCase() && r?.isCommit !== true && r?.isWelcome !== true;

    /** Captures, from `reader`'s pull, the last frame `author` sent after it was cut. */
    const capture = async (reader, readerLabel, author, authorUser, mark) => {
      const got = [];
      let f = null;
      await offAndBack(
        c.cx(reader),
        readerLabel,
        async () => {
          await openGroup(c.cx(author), c.group.name, { navigate: false, label: id });
          await send(c.cx(author), `${id} captured [${mark}]`);
        },
        { onReturn: async () => (f = await armFault(c.cx(reader), [{ ...PENDING_PULL, fault: 'rewrite', transform: captureRows((r) => sameGroup(r) && String(r.senderId).toLowerCase() === authorUser.toLowerCase(), got) }])) }
      );
      await f.awaitFired(0, 1, 30_000).catch(() => {});
      const rep = await f.disarm();
      records[reader].push(...rep.records);
      return got.at(-1) ?? null;
    };

    const markA = rowMessageMark(id, 'A');
    const markB = rowMessageMark(id, 'B');
    const theirs = await capture('W2', 'W2', 'W1', c.user.W1, markA);
    const own = await capture('W1', 'W1', 'W2', c.user.W2, markB);
    if (!theirs) premise.push("no frame of W1's was in W2's pull to capture");
    if (!own) premise.push("no frame of W2's was in W1's pull to capture");
    if (premise.length) return { premise, records };

    // THREE EPOCHS PAST, beyond max_past_epochs = 2: W1's own leaf refresh, re-armed each time.
    const w1dev = await deviceIdOf(W1, c.user.W1);
    await openGroup(W1, c.group.name, { navigate: false, label: id });
    for (let i = 0; i < spec.pastEpochs; i++) {
      const at = serverView(c.group.id).activeEpoch;
      try {
        await armLeafRefresh(W1, c.user.W1, w1dev, c.group.id);
      } catch (e) {
        premise.push(`refresh ${i + 1}: ${String(e?.message ?? e)}`);
        break;
      }
      await send(W1, `${id} refresh ${i + 1} [${rowMessageMark(id, `R${i}`)}]`);
      if (!(await awaitServer(c.group.id, (v) => v.activeEpoch > at, 30_000)).settled) {
        premise.push(`refresh ${i + 1} did not move the epoch within 30 s`);
        break;
      }
    }
    if (premise.length) return { premise, records };

    const epochBefore = serverView(c.group.id).activeEpoch;
    const w2dev = await deviceIdOf(W2, c.user.W2);
    const replay = [theirs, readdressRow(own, { recipientId: c.user.W2, deviceId: w2dev })];
    let f = null;
    const back = await offAndBack(W2, 'W2', async () => null, {
      onReturn: async () => (f = await armFault(W2, [{ ...PENDING_PULL, fault: 'rewrite once', transform: injectRows(replay) }])),
    });
    await f.awaitFired(0, 1, 30_000).catch(() => {});
    // EITHER CLASSIFICATION IS THE ANSWER: the MLS layer's duplicate, or the queue's repeat of an
    // injected id it already took in (`linesAbout`), which comes first and names no group.
    const replayIds = replay.map((r) => r.id);
    const duplicateLine = await awaitLine(W2, `[MLS] Duplicate delivery for ${c.group.id.slice(0, 8)}`, 20_000, (l) =>
      replayIds.some((rid) => l.includes(`[QUEUE] delivery ${String(rid).slice(0, 8)}... arrived twice`))
    );
    const rep = await f.disarm();
    records.W2.push(...rep.records);
    const epochAfter = serverView(c.group.id).activeEpoch;
    await openGroup(W2, c.group.name, { navigate: false, label: id });
    const shown = { [markA]: await shownCount(W2, markA), [markB]: await shownCount(W2, markB) };
    const injectedIds = rep.records.flatMap((r) => r.injected ?? []);
    const lines = linesAbout(consoleLines(W2), c.group.id, injectedIds);
    const injected = injectedIds.length;
    return {
      premise,
      records,
      vacuous: injected === 0 ? [{ rule: 0, fault: 'W2 rewrite once (nothing injected)' }] : [],
      offline: ['W1', 'W2'],
      joiners: [],
      // THE OWN-ECHO LINE IS EXPECTED HERE ONLY because this row hands W2 its own frame (#2421);
      // anywhere else an own frame coming back is a delivery defect, and stays dirt.
      narration: { W2: [`[MLS] Duplicate delivery for ${c.group.id.slice(0, 8)}`, ownEchoLine(c.group.id.slice(0, 8))] },
      detail: { gatewayMs: back.gatewayMs, epochBefore, epochAfter, duplicateLine, shown, capturedIds: replay.map((r) => r.id) },
      own: pastFrameOwn({ injected, epochBefore, epochAfter, shown, lines }),
    };
  },

  /**
   * GAP-3: W1 sends more than the forward distance while W2 is cut; W2's first pull on its return
   * starts AFTER the first `skip` frames, so its first frame is too far ahead to derive. W2 must name
   * it a generation gap and re-join (the ladder).
   */
  async 'GAP-3'(c) {
    const W1 = c.cx('W1');
    const W2 = c.cx('W2');
    const premise = [];
    const w2dev = await deviceIdOf(W2, c.user.W2);
    if (!w2dev || !/^[\w:.-]+$/.test(w2dev)) premise.push(`W2's device id is unreadable (${w2dev})`);
    if (!UUID.test(c.group.id)) premise.push('the group id is not a uuid');
    if (premise.length) return { premise, records: {} };
    let f = null;
    let cutAt = null;
    let queuedRows = 0;
    const back = await offAndBack(
      W2,
      'W2',
      async () => {
        for (let i = 0; i < spec.send; i++) {
          await send(W1, `${id} ${i + 1}/${spec.send}`);
          if ((i + 1) % 100 === 0) console.log(`[${id}] sent ${i + 1}/${spec.send}`);
        }
      },
      {
        onReturn: async () => {
          const where = `"groupId" = '${c.group.id}' AND "deviceId" = '${w2dev}' AND "isCommit" IS NOT TRUE AND "isWelcome" IS NOT TRUE`;
          queuedRows = Number(String(psql(`SELECT count(*) FROM queued_message WHERE ${where}`)).trim()) || 0;
          cutAt =
            String(
              psql(`SELECT to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM queued_message WHERE ${where} ORDER BY "createdAt" OFFSET ${spec.skip - 1} LIMIT 1`)
            ).trim() || null;
          if (queuedRows <= spec.skip || !cutAt) premise.push(`only ${queuedRows} frame(s) queued for W2 - ${spec.skip + 1}+ needed`);
          f = await armFault(W2, [{ ...PENDING_PULL, fault: 'rewrite-url once', url: startAfter(cutAt ?? '') }]);
        },
      }
    );
    await f.awaitFired(0, 1, 30_000).catch(() => {});
    const lost = await awaitLine(W2, `[MLS] LOST frame for ${c.group.id.slice(0, 8)}`, 120_000);
    const rep = await f.disarm();
    // RECOVERED THROUGH THE LADDER: W2 holds the group again at the server's epoch.
    const recoveredMs = await awaitClientEpoch(W2, c.group.id, serverView(c.group.id).activeEpoch, 120_000);
    const lines = linesAbout(consoleLines(W2), c.group.id);
    return {
      premise,
      records: { W2: rep.records },
      vacuous: rep.records.some((r) => r.changed) ? [] : [{ rule: 0, fault: 'W2 rewrite-url once (the pull was not moved)' }],
      offline: ['W2'],
      joiners: [],
      narration: { W2: [`[MLS] LOST frame for ${c.group.id.slice(0, 8)}`, `[MLS] Frames are being lost in ${c.group.id.slice(0, 8)}`] },
      detail: { gatewayMs: back.gatewayMs, queuedRows, cutAt, firstLost: lost, recoveredMs },
      own: [
        ...tooDistantOwn({ skipped: spec.skip, cutAt, lines }),
        { what: `W2 re-joined at the server's epoch (${recoveredMs ?? 'not within 120 s'})`, ok: recoveredMs !== null },
      ],
    };
  },
};

/** Set up, act, judge. */
async function play() {
  const user = Object.fromEntries(spec.devices.map((d) => [d, userOf(seats, d)]));
  const cx = (d) => seats.seat[d].cx;
  const name = (d) => displayNameOf(user[d]);
  // EVERY SEAT A ROW CUTS IS ARMED FIRST: the reload is a navigation, and each later step runs on its page.
  await armCut(cx('W2'));
  if (id === 'GAP-2') await armCut(cx('W1'));

  const group = await mintRowGroup(cx('W1'), id, user.W1);
  assertRowOwns({ kind: 'group', id: group.id, name: group.name }, id);
  await openGroup(cx('W1'), group.name, { navigate: false, label: id });
  await addMembers(cx('W1'), [name('W2')]);
  const premise = [];
  if ((await awaitListed(cx('W2'), group.name, 60_000)) === null) premise.push(`W2 never listed ${group.name}`);
  await closeOverlays(cx('W1'));
  if (premise.length) return { premise, detail: { group: group.id } };

  const fromEpoch = serverView(group.id).activeEpoch;
  const act = await ACTIONS[id]({ cx, user, name, group, fromEpoch });
  const base = { records: act.records, offline: act.offline, narration: act.narration ?? {} };
  if (act.premise?.length) return { ...base, premise: act.premise, detail: { group: group.id, fromEpoch, ...act.detail } };

  for (const d of act.joiners ?? []) await awaitListed(cx(d), group.name, 60_000);
  const invariant = await checkInvariant({
    group: group.id,
    targets: seats.targets,
    members: spec.devices,
    conversation: group.name,
    fromEpoch,
    since,
    reload: true,
    watchers: watchersOf(seats),
    provoked: Object.fromEntries(Object.entries(act.records ?? {}).map(([d, r]) => [d, provokedFailures(r)])),
  });
  return {
    ...base,
    own: act.own,
    invariant,
    vacuousFaults: act.vacuous,
    detail: { group: group.id, name: group.name, fromEpoch, ...act.detail, faultRecords: act.records, ...(spec.note ? { note: spec.note } : {}) },
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
  const narration = out.narration ?? {};
  const observers = await observersOf(seats, {
    logs: { W1: GROUP_CREATION_NARRATION, ...Object.fromEntries(Object.entries(narration).map(([d, n]) => [d, d === 'W1' ? [...GROUP_CREATION_NARRATION, ...n] : n])) },
    provoked: out.records ?? {},
    offline: out.offline ?? [],
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
