/**
 * THE LEAF-REFRESH ROWS - a due refresh meets a cut link, a reload and a revoked device.
 *
 *   bun archive/leaf.mjs --row LEAF-REFRESH-1   # the link is cut while the refresh is submitted   (W6 W7)
 *   bun archive/leaf.mjs --row LEAF-REFRESH-2   # the page is reloaded while its commit POST is held (W6 W7)
 *   bun archive/leaf.mjs --row LEAF-REFRESH-4   # a device of the peer is revoked                   (W6 W7)
 *
 * `leafrows.mjs` is the table and every judge (pinned by `archive/leaf-selftest.mjs`); the mechanism
 * under test is `leafRefresh.ts` plus `BaseMlsService.runCommitTransaction`'s checkpoint of the stage
 * BEFORE its first request ([mls-protocol](../../../docs/wiki/protocols/mls-protocol.md#the-periodic-leaf-refresh)).
 *
 * THE SHAPE, every row: the owner (W6) mints the row's own group (R5-owned) and Adds the peer (W7) in
 * one Add, which is the owner's OWN commit and so dates its leaf in the ledger. The ledger is then
 * BACKDATED eight days (`mlsrow.mjs` `armLeafRefresh`), AFTER the fault is armed, so the owner's next
 * durable send is the refresh trigger and no earlier frame spends it. Each step waits on a FACT - a
 * fault holding a request, the client's own `[COMMIT] ... resubmission ...: <verdict>` line, the
 * gateway reconnecting, a pane showing a marker - never a clock. The gate's `[COMMIT]` lines, in
 * order, are the evidence (`settlerows.mjs` `commitSequence`), read after the invariant (R8).
 *
 * THE SEATS ARE THE SPARE PROFILES W6 (owner account) and W7 (peer account), and nothing else is
 * attached: W1-W5 belong to the other rows and sittings. Every dev write is the row's own group (its
 * name is `LEAF<n>-<mark>`), deleted once the verdict is on disk and only on a PASS; LEAF-REFRESH-4
 * also revokes W7's own campaign-owned device and leaves W7 to be re-enrolled by hand.
 */
import { awaitGatewayConnected, evaluate, send } from '../chat.mjs';
import { assertCampaignOwned } from '../campaign.mjs';
import { reloadAndWait } from '../cdp.mjs';
import { armFault } from '../fault.mjs';
import { closeOverlays, deleteGroup, openGroup } from '../groupnav.mjs';
import { checkInvariant, receivedOn } from '../invariant.mjs';
import {
  COMMIT_POST,
  armLeafRefresh,
  assertRowOwns,
  awaitListed,
  awaitServer,
  closeSeats,
  commitLines,
  deviceIdOf,
  displayNameOf,
  leafLedgerEntry,
  mintRowGroup,
  observersOf,
  openSeats,
  serverView,
  userOf,
  watchersOf,
} from '../mlsrow.mjs';
import { psql } from '../estate.mjs';
import { errorDetail, finishObserved, record } from '../results.mjs';
import { composeVerdict, invariantDetail, provokedFailures, rowMessageMark } from '../rowkit.mjs';
import { commitSequence, settleNarration } from '../settlerows.mjs';
import { LEAF_ROWS, STRAY_NARRATION, acceptedLine, cutDuringSubmit, ledgerNamesServer, refreshLandedOnce, refreshPremise, revokedLeafLeaves, sendsWaitForTheCommit, stageSurvivesReload, strayRemovals, unknownLine } from '../leafrows.mjs';
import { GROUP_CREATION_NARRATION, REVOKED_REFUSALS, REVOKED_SIGN_OUT_NARRATION, awaitLine, consoleLines, stripStamp } from '../watch.mjs';
import { addMembers } from './addmember.mjs';
import { armCut, cutHard } from './net.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (!LEAF_ROWS[id]) {
  console.error(`usage: bun archive/leaf.mjs --row ${Object.keys(LEAF_ROWS).join('|')}  (LEAF-REFRESH-3 was read by hand: it arms no fault)`);
  process.exit(2);
}
const spec = LEAF_ROWS[id];
/** The owner commits and is refreshed; the peer reads. By the table's order, never by a spelt name. */
const [OWNER, PEER] = spec.devices;
const since = new Date().toISOString();
let seats = null;
/** The groups this row minted, deleted after a passing verdict. */
const minted = [];

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A gesture's outcome, captured and never thrown: a row with a fault EXPECTS gestures that do not finish cleanly. */
const outcome = (p) =>
  p.then(
    (value) => ({ ok: true, value }),
    (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 300) })
  );

/** Polls one client's pane until `marker` shows; true if it did before the bound. A fact, polled. */
async function shown(cx, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await receivedOn(cx, marker)).count > 0) return true;
    if (Date.now() > deadline) return false;
    await sleep(400);
  }
}

/** How many times `marker` is shown in a client's open pane right now. */
const countOn = async (cx, marker) => (await receivedOn(cx, marker)).count;

/** The owner's console lines with the stamp removed, from index `from` on. */
const plainLines = (cx, from = 0) => consoleLines(cx).slice(from).map((l) => stripStamp(l));

/**
 * THE ROWS' ACTIONS. Each starts with the group minted, the peer in it, and the owner's leaf dated by
 * its own commit; it arms its fault, backdates the ledger, makes its gesture and returns `judge(view,
 * seq)` - its own assertions, given the server's view and the gate's decisions.
 */
const ACTIONS = {
  /**
   * LEAF-REFRESH-1. The refresh commit's POST is held BEFORE the server; the link is cut and the held
   * request failed (it never left). The client resubmits into the cut, hears nothing and KEEPS the
   * stage (`unknown`); a second text is sent while cut. The fault is then swapped for one answering
   * every commit request `503` unsent and the link returns: the settlement at the reconnection is
   * answered 503, so the commit stays unknown with the link UP and the gateway connected - the window
   * the row reads. There the owner sends another text in the row's group and one in a SIDE group to the
   * same peer: the side one must arrive (the link is up) and none of the row group's must have. Then
   * the 503 is lifted and the owner is cut and returned once more, which settles the commit
   * (`settle.mjs` DUP-5's shape): accepted, and every queued text arrives once.
   */
  async 'LEAF-REFRESH-1'(c) {
    const O = c.cx(OWNER);
    const P = c.cx(PEER);
    const rulesA = [{ ...COMMIT_POST, fault: 'hold once' }];
    const fa = await armFault(O, rulesA);
    const armed = (await armLeafRefresh(O, c.user[OWNER], c.ownerDevice, c.group.id)).after;
    console.log(`[${id}] the owner's refresh ledger is backdated to ${new Date(armed.at).toISOString()} - due at its next send`);
    const marks = { trigger: rowMessageMark(id, 'T'), second: rowMessageMark(id, 'U'), third: rowMessageMark(id, 'V'), side: rowMessageMark(id, 'C') };
    const trigger = outcome(send(O, `${id} refresh trigger [${marks.trigger}]`));
    await fa.awaitHeld(1, 45_000);
    console.log(`[${id}] the due refresh's commit POST is held before the server - submitted, not left`);

    // THE CUT IS PUT IN PLACE WITH THE COMMIT HELD, and then the held request dies: the first request
    // provably never reached the gate. Every later request goes through the dead link and fails for real.
    const cutC = await cutHard(O);
    console.log(`[${id}] the owner is cut (${cutC.socketsClosed} socket(s) closed)`);
    await fa.fail();
    const unknown = await awaitLine(O, unknownLine(c.group.id, c.fromEpoch), 60_000);
    console.log(`[${id}] while cut, the client says: ${unknown ?? 'NO unknown verdict'}`);
    const secondSend = await outcome(send(O, `${id} second [${marks.second}]`));
    const repA = await fa.disarm();

    // THE SETTLEMENT IS ANSWERED 503 FROM HERE ON, so the commit stays unknown with the link up.
    const rulesB = [{ ...COMMIT_POST, fault: 'status-unsent 503' }];
    const fb = await armFault(O, rulesB);
    const before = O.events.length;
    await cutC.restore();
    const gatewayMs = await awaitGatewayConnected(O, before, 45_000);
    console.log(`[${id}] the owner is back; gateway ${gatewayMs === null ? 'NOT reconnected' : `reconnected in ${gatewayMs} ms`}`);
    await fb.awaitFired(0, 1, 60_000).catch(() => {});
    console.log(`[${id}] the settlement was answered 503 ${fb.fired(0)} time(s) with the link up`);
    const thirdSend = await outcome(send(O, `${id} third [${marks.third}]`));
    await openGroup(O, c.side.name, { navigate: false, label: id });
    await send(O, `${id} side [${marks.side}]`);
    await openGroup(P, c.side.name, { navigate: false, label: id });
    const controlReached = await shown(P, marks.side, 25_000);
    await openGroup(P, c.group.name, { navigate: false, label: id });
    const blockedShown = controlReached ? [await countOn(P, marks.second), await countOn(P, marks.third)] : null;
    const triggerDuring = controlReached ? await countOn(P, marks.trigger) : null;
    console.log(`[${id}] side text reached the peer: ${controlReached}; row-group texts shown on the peer meanwhile: second/third ${blockedShown}, trigger ${triggerDuring}`);
    const seqBefore = commitSequence(commitLines(c.group.id, c.startSince));
    const liftedAt = now();
    const repB = await fb.disarm();

    // LIFTED, AND SETTLED AT A RECONNECTION: cut and returned once more.
    await openGroup(O, c.group.name, { navigate: false, label: id });
    const cut2 = await cutHard(O);
    const restoredAt = now();
    const before2 = O.events.length;
    await cut2.restore();
    const gateway2Ms = await awaitGatewayConnected(O, before2, 45_000);
    const settled = await awaitLine(O, acceptedLine(c.group.id, c.fromEpoch), 60_000);
    const arrived = {};
    for (const k of ['trigger', 'second', 'third']) arrived[k] = await shown(P, marks[k], 30_000);
    const triggerGesture = await trigger;
    const ledgerAfter = await settledLedger(O, c);
    const records = [...repA.records, ...repB.records];
    return {
      records,
      vacuous: [...repA.vacuous.map((i) => ({ rule: i, fault: `${OWNER} ${rulesA[i].fault}` })), ...repB.vacuous.map((i) => ({ rule: i, fault: `${OWNER} ${rulesB[i].fault}` }))],
      offline: true,
      detail: { armedAt: armed.at, ledgerBefore: c.ledgerBefore, ledgerAfter, trigger: triggerGesture, secondSend, thirdSend, clientUnknown: unknown, clientSettled: settled, gatewayMs, gateway2Ms, liftedAt, restoredAt, decidedBeforeSettlement: seqBefore, controlReached, blockedShown, triggerDuring, arrived, answered503: repB.records.length },
      judge: async (view, seq) => {
        const after = commitSequence(commitLines(c.group.id, liftedAt));
        return [
          ...cutDuringSubmit({ unknown, gatewayMs, seqBefore, seqAfter: after, settled, heldRecords: repA.records, unsentRecords: repB.records }),
          ...sendsWaitForTheCommit({
            controlReached,
            blockedShown,
            after: arrived.second && arrived.third && arrived.trigger ? [await countOn(P, marks.trigger), await countOn(P, marks.second), await countOn(P, marks.third)] : [],
          }),
          ...refreshLandedOnce({ fromEpoch: c.fromEpoch, view, seq }),
          ...ledgerNamesServer({ before: c.ledgerBefore, armed, after: ledgerAfter, serverEpoch: view.activeEpoch }),
        ];
      },
    };
  },

  /**
   * LEAF-REFRESH-2. The refresh commit's POST is held; the stage was checkpointed to disk before it
   * (`checkpointStageBeforeSend`), so the page is RELOADED with the request held - it dies with the
   * document and the gate decides nothing. After the reload the settlement must find the stage on
   * disk, resubmit and be accepted, and the ledger must name the epoch the server holds.
   */
  async 'LEAF-REFRESH-2'(c) {
    const O = c.cx(OWNER);
    const rules = [{ ...COMMIT_POST, fault: 'hold once' }];
    const f = await armFault(O, rules);
    const armed = (await armLeafRefresh(O, c.user[OWNER], c.ownerDevice, c.group.id)).after;
    console.log(`[${id}] the owner's refresh ledger is backdated to ${new Date(armed.at).toISOString()} - due at its next send`);
    const triggerMark = rowMessageMark(id, 'T');
    const trigger = outcome(send(O, `${id} refresh trigger [${triggerMark}]`));
    await f.awaitHeld(1, 45_000);
    console.log(`[${id}] the due refresh's commit POST is held before the server`);
    const seqBeforeReload = commitSequence(commitLines(c.group.id, c.startSince));
    const linesAtReload = consoleLines(O).length;
    const reloadedAt = now();
    const reloadMs = await reloadAndWait(O);
    console.log(`[${id}] the owner's page was reloaded with the request held (${reloadMs} ms to load)`);
    // THE HELD REQUEST BELONGED TO THE DOCUMENT THAT WAS REPLACED: disarming releases a dead interception.
    const rep = await f.disarm().catch((e) => {
      console.log(`[${id}] disarm after the reload: ${String(e?.message ?? e).slice(0, 160)}`);
      return { records: f.records, vacuous: [] };
    });
    const gatewayMs = await awaitGatewayConnected(O, 0, 60_000);
    const settled = await awaitLine(O, acceptedLine(c.group.id, c.fromEpoch), 60_000);
    const settlingLines = plainLines(O, linesAtReload).filter((l) => /^\[COMMIT\] settling \d+ staged commit\(s\) by resubmission$/.test(l));
    const triggerGesture = await Promise.race([trigger, sleep(1000).then(() => ({ ok: false, error: 'the gesture did not end after the reload' }))]);
    const ledgerAfter = await settledLedger(O, c);
    await openGroup(O, c.group.name, { navigate: false, label: id });
    return {
      records: rep.records,
      vacuous: (rep.vacuous ?? []).map((i) => ({ rule: i, fault: `${OWNER} ${rules[i].fault}` })),
      detail: { armedAt: armed.at, ledgerBefore: c.ledgerBefore, ledgerAfter, trigger: triggerGesture, reloadedAt, gatewayMs, decidedBeforeReload: seqBeforeReload, settlingLines, clientSettled: settled },
      judge: (view, seq) => [
        ...stageSurvivesReload({ holdRecords: rep.records, seqBeforeReload, settlingLines, settled }),
        ...refreshLandedOnce({ fromEpoch: c.fromEpoch, view, seq, maxDuplicates: 0 }),
        ...ledgerNamesServer({ before: c.ledgerBefore, armed, after: ledgerAfter, serverEpoch: view.activeEpoch }),
      ],
    };
  },

  /**
   * LEAF-REFRESH-4. The peer's own device is revoked through the product's own route, and in the SAME
   * page script a commit is attempted from it (the revocation's wipe cannot interleave with one
   * script): the gate must refuse it `DEVICE_REVOKED`. The owner then reconnects - its page is
   * reloaded - and removes the revoked leaf from every conversation it holds, one removal per group.
   */
  async 'LEAF-REFRESH-4'(c) {
    const O = c.cx(OWNER);
    const P = c.cx(PEER);
    const revoked = c.peerDevice;
    // A DESTRUCTIVE GESTURE TOUCHES ONLY WHAT THE CAMPAIGN CREATED (R5): the device must be in the ledger.
    assertCampaignOwned({ kind: 'device', id: revoked }, id);
    const script = `(async function () {
      try {
        var r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (!r.ok) return JSON.stringify({ err: 'refresh answered ' + r.status });
        var token = (await r.json()).access_token;
        var auth = { Authorization: 'Bearer ' + token };
        var del = await fetch('/api/mls/devices/' + ${JSON.stringify(c.user[PEER])} + '/' + ${JSON.stringify(revoked)}, { method: 'DELETE', headers: auth });
        var delBody = (await del.text()).slice(0, 300);
        var headers = Object.assign({ 'Content-Type': 'application/json' }, auth);
        var att = await fetch('/api/mls/commit', { method: 'POST', headers: headers, body: JSON.stringify({ groupId: ${JSON.stringify(c.group.id)}, deviceId: ${JSON.stringify(revoked)}, senderId: ${JSON.stringify(c.user[PEER])}, baseEpoch: ${c.fromEpoch}, commit: 'AAAA' }) });
        return JSON.stringify({ deleted: { status: del.status, body: delBody }, attempt: { status: att.status, body: (await att.text()).slice(0, 400) } });
      } catch (e) { return JSON.stringify({ err: String(e) }); }
    })()`;
    const revokedAt = now();
    const raw = JSON.parse(await evaluate(P, script, { awaitPromise: true }));
    if (raw.err) throw new Error(`the revocation script failed: ${raw.err}`);
    console.log(`[${id}] revoked ${revoked.slice(0, 20)}...: DELETE ${raw.deleted.status}; a commit from it answered ${raw.attempt.status} ${raw.attempt.body.slice(0, 120)}`);
    const linesAtReload = consoleLines(O).length;
    const reloadMs = await reloadAndWait(O);
    console.log(`[${id}] the owner's page was reloaded (${reloadMs} ms) - its next connection`);
    await awaitLine(O, '[STRAY] compared', 90_000);
    // THE ROW'S OWN GROUP DECIDES WHEN THE WORK IS DONE: its removal finishing is a fact, and the rest
    // of the owner's groups are drained until every removal that started has finished.
    const short = c.group.id.slice(0, 8);
    const doneBy = Date.now() + 180_000;
    let removals = strayRemovals(plainLines(O, linesAtReload));
    for (;;) {
      removals = strayRemovals(plainLines(O, linesAtReload));
      const rowDone = removals.finished.some((x) => x.group === short);
      const open = removals.started.filter((s) => !removals.finished.some((x) => x.group === s.group)).length;
      if (rowDone && open === 0) break;
      if (Date.now() > doneBy) break;
      await sleep(1500);
    }
    // A SECOND READ A BEAT LATER: a removal that started in the interval is part of the row's account.
    await sleep(3000);
    removals = strayRemovals(plainLines(O, linesAtReload));
    const view = serverView(c.group.id);
    const last = JSON.parse(
      psql(`SELECT coalesce(json_agg(r), '[]'::json) FROM (SELECT "senderDeviceId" AS "deviceId", "baseEpoch" AS "atEpoch" FROM mls_commit_log WHERE "groupId" = '${c.group.id}' ORDER BY "baseEpoch" DESC LIMIT 1) r`)
    )[0] ?? null;
    // THE ROW'S WHOLE WINDOW, not the instant of the call: the window opens at the row's start.
    // WHOLE SECONDS: a `--since` with a fraction dropped this very REFUSE line on dev (measured 2026-11-16: the same window, 4 lines with .749Z and 5 with the whole second).
    const windowFrom = new Date(Date.parse(c.startSince) - 2000).toISOString().replace(/\.\d+Z$/, 'Z');
    const windowLines = commitLines(c.group.id, windowFrom);
    console.log(`[${id}] the gate's lines for the row group since ${windowFrom}: ${windowLines.length} (${windowLines.filter((l) => l.includes('REJECT')).length} REJECT); revoked device ${revoked}`);
    const refusalLines = windowLines.filter(
      (l) => l.includes('REJECT device_revoked') && l.includes(revoked)
    );
    return {
      records: [],
      vacuous: [],
      revokedSeat: PEER,
      detail: { revoked, revokedAt, deleted: raw.deleted, attempt: raw.attempt, removals, rowCommit: last, refusalLines: refusalLines.length },
      judge: () =>
        revokedLeafLeaves({
          removals,
          groupShort: short,
          deleted: raw.deleted,
          attempt: raw.attempt,
          refusalLines,
          rowCommit: last,
          fromEpoch: c.fromEpoch,
          ownerDevice: c.ownerDevice,
          serverEpoch: view.activeEpoch,
        }),
    };
  },
};

/**
 * The owner's ledger entry once it names the epoch after the refresh (the merge writes it), or the
 * entry as it stands at the bound. Polled on the entry itself - a fact - not on a delay.
 */
async function settledLedger(cx, c) {
  const deadline = Date.now() + 30_000;
  let entry = null;
  for (;;) {
    entry = await leafLedgerEntry(cx, c.user[OWNER], c.ownerDevice, c.group.id);
    if ((entry && entry.epoch === c.fromEpoch + 1 && !entry.observed) || Date.now() > deadline) return entry;
    await sleep(500);
  }
}

/** Set up, act, judge. */
async function play() {
  const user = Object.fromEntries(spec.devices.map((d) => [d, userOf(seats, d)]));
  const cx = (d) => seats.seat[d].cx;
  const name = (d) => displayNameOf(user[d]);
  const premise = [];
  // THE CUT IS ARMED FIRST: its reload is a navigation, and every later step must run on the page it leaves.
  if (spec.cut) await armCut(cx(OWNER));

  // THE SIDE GROUP (LEAF-REFRESH-1): the positive control - the same peer over the same link, in
  // another conversation, while the row's commit is unknown.
  let side = null;
  if (spec.side) {
    side = await mintRowGroup(cx(OWNER), id, user[OWNER]);
    minted.push(side.name);
    assertRowOwns({ kind: 'group', id: side.id, name: side.name }, id);
    await openGroup(cx(OWNER), side.name, { navigate: false, label: id });
    await addMembers(cx(OWNER), [name(PEER)]);
    if ((await awaitListed(cx(PEER), side.name, 60_000)) === null) premise.push(`${PEER} never listed the side group ${side.name}`);
    await closeOverlays(cx(OWNER));
  }
  const group = await mintRowGroup(cx(OWNER), id, user[OWNER]);
  minted.push(group.name);
  assertRowOwns({ kind: 'group', id: group.id, name: group.name }, id);
  await openGroup(cx(OWNER), group.name, { navigate: false, label: id });
  await addMembers(cx(OWNER), [name(PEER)]);
  if ((await awaitListed(cx(PEER), group.name, 60_000)) === null) premise.push(`${PEER} never listed ${group.name} after the setup Add`);
  const settled = await awaitServer(
    group.id,
    (v) => (v.seats ?? []).some((s) => s.userId.toLowerCase() === user[PEER].toLowerCase() && s.status === 'active'),
    30_000
  );
  if (!settled.settled) premise.push('the setup Add did not leave the peer active within 30 s');
  await closeOverlays(cx(OWNER));
  const ownerDevice = await deviceIdOf(cx(OWNER), user[OWNER]);
  const peerDevice = await deviceIdOf(cx(PEER), user[PEER]);
  if (!ownerDevice) premise.push('the owner device id could not be read');
  // THE OWNER'S LEAF MUST BE ONE ITS OWN COMMIT PRODUCED: the ledger entry is written once the merge lands.
  let ledgerBefore = null;
  const ledgerBy = Date.now() + 20_000;
  while (ownerDevice && Date.now() < ledgerBy) {
    ledgerBefore = await leafLedgerEntry(cx(OWNER), user[OWNER], ownerDevice, group.id);
    if (ledgerBefore) break;
    await sleep(500);
  }
  if (id !== 'LEAF-REFRESH-4') premise.push(...refreshPremise(ledgerBefore));
  if (premise.length) return { premise, detail: { group: group.id, ledgerBefore } };

  const fromEpoch = serverView(group.id).activeEpoch;
  const startSince = now();
  const c = { cx, user, name, group, side, fromEpoch, startSince, ownerDevice, peerDevice, ledgerBefore };
  const act = await ACTIONS[id](c);
  if (act.premise?.length) return { premise: act.premise, detail: { group: group.id, fromEpoch, ...act.detail } };

  // A REVOKED SEAT IS NOT A MEMBER ANY MORE: the invariant reads the owner alone, over its own group.
  const members = act.revokedSeat ? spec.devices.filter((d) => d !== act.revokedSeat) : spec.devices;
  const invariant = await checkInvariant({
    group: group.id,
    targets: seats.targets.filter((t) => members.includes(t.device)),
    members,
    conversation: group.name,
    fromEpoch,
    since,
    reload: true,
    watchers: Object.fromEntries(Object.entries(watchersOf(seats)).filter(([d]) => members.includes(d))),
    provoked: { [OWNER]: provokedFailures(act.records) },
  });
  const view = serverView(group.id);
  const seq = commitSequence(commitLines(group.id, startSince));
  return {
    own: await act.judge(view, seq),
    invariant,
    vacuousFaults: act.vacuous,
    records: act.records,
    offline: act.offline,
    revokedSeat: act.revokedSeat,
    narration: [...settleNarration(group.id), ...(id === 'LEAF-REFRESH-4' ? STRAY_NARRATION : [])],
    detail: { group: group.id, name: group.name, fromEpoch, decisions: seq, faultRecords: act.records, ...act.detail, ...(spec.note ? { note: spec.note } : {}) },
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
    logs: {
      [OWNER]: [...GROUP_CREATION_NARRATION, ...(out.narration ?? [])],
      ...(out.revokedSeat ? { [out.revokedSeat]: REVOKED_SIGN_OUT_NARRATION } : {}),
    },
    refusals: out.revokedSeat ? { [out.revokedSeat]: REVOKED_REFUSALS } : {},
    provoked: { [OWNER]: out.records ?? [] },
    offline: out.offline ? [OWNER] : [],
  });
  await finishObserved(
    id,
    verdict,
    { ...out.detail, own: out.own ?? [], failures, invariant: invariantDetail(out.invariant ?? null), serverWindowSince: since },
    observers,
    async () => {
      // THE ROW'S GROUP GOES ONCE ITS VERDICT IS ON DISK, and only when its own assertions held: a failing
      // row's group is the evidence a reader opens next, left for `cleanup.mjs`.
      if (verdict === 'PASS') {
        for (const name of minted) {
          const gone = await deleteGroup(seats.seat[OWNER].cx, name).catch((e) => `NOT deleted: ${String(e?.message ?? e).slice(0, 160)}`);
          console.log(`[${id}] the row's group ${name}: ${gone}`);
        }
      }
      closeSeats(seats);
    }
  );
} catch (e) {
  console.error(`[${id}] ${e?.stack ?? e}`);
  record(id, 'ERROR', errorDetail(e));
  closeSeats(seats);
  process.exit(1);
}
