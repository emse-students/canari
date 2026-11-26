/**
 * ADM-11 AND ADM-12 - THE CARD FOR A SEAT THAT IS NOT AN ASK, read on a state built for it.
 *
 *   bun archive/admitcard.mjs              # both rows, one revocation, two groups (W6 W9)
 *   bun archive/admitcard.mjs --dry        # read the premise (the account's devices), change nothing
 *
 * WHAT IS READ. Step 2 of the admission fix-forward (`docs/wiki/protocols/admission-fix-forward.md`,
 * slice 2): a person seated in a GROUP conversation with no leaf in its tree, whose seat is NOT an
 * invitation-link ask, is raised to a member as the join-request card ("X veut rejoindre la
 * conversation"), on a tree confirmed at the server's epoch (`askAMemberToAdmit`). Refuser removes the
 * seat (`declineSeat`) and the person's external commit is then refused; Accepter brings them back.
 *
 * WHY A CONSTRUCTED STATE (S15, 2026-11-20). Three web runs of the product's own revoke path never
 * raised the card: the new device was added as a FURTHER device by a member whose tree still held the
 * revoked leaf, or it entered by its own external commit before anyone was asked. So this runner
 * orders the three facts the card needs instead of hoping for them, each read before the next step:
 *
 *  1. a NEW device of the person signs in on the wiped seat, its registration HELD (no KeyPackage, no
 *     seat a member could add) - a session cannot revoke its own device (`409 OWN_DEVICE`), so the
 *     new one revokes the old;
 *  2. the person's EVERY leaf is gone by a COMMIT - the old device is revoked, and the run waits until
 *     none of their devices is active in either group while the roster seat stands; only then is the
 *     registration released;
 *  3. the new device's external commit never reaches the server - a request-stage fault answers it `503` (the
 *     server never saw it, `status-unsent`), so the device falls back to asking a member
 *     (`requestReAdd` step 9). The bytes are kept (`keepBody`): ADM-11 sends them again after the
 *     Decline, to the real server, and that refusal is the row's second half.
 *
 * WHO. W6 (the owner's scratch seat) creates two groups with the fifth account (W9, its only seat) and
 * the peer, and is the member who reads the card. The fifth account is the rig's own (a local
 * identity-provider account made for S15), and W9 holds nothing another row rests on: every device of
 * that account is revoked here, and nothing else - the allowlist is the account `ACCOUNT_OF.W9` names.
 *
 * THE FAULT IS PART OF THE STATE, AND THE PRODUCT'S OWN DOOR IS NOT TESTED HERE. Holding the external
 * commit back is what slice 3 (the emission side) will make the client do by itself; until then the
 * client still self-joins, and this row says nothing about that door. It reads the MEMBER side only.
 */
import { psql, srvLines } from '../estate.mjs';
import { armFault } from '../fault.mjs';
import { openGroup } from '../groupnav.mjs';
import { checkInvariant, receivedOn } from '../invariant.mjs';
import { ACCOUNT_OF, PEER_NAME } from '../names.mjs';
import {
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
import { errorDetail, record, recordObserved } from '../results.mjs';
import { composeVerdict, invariantDetail, provokedFailures, rowMessageMark } from '../rowkit.mjs';
import { recordCreated } from '../campaign.mjs';
import { reloadAndWait } from '../cdp.mjs';
import { evaluate, goto, send } from '../chat.mjs';
import { LEAF_REVOKED_WIPE_NARRATION, strayRemovals } from '../leafrows.mjs';
import {
  ADMIT_CARD_FAULT,
  acceptedCardOwn,
  askLinesFor,
  declinedCardOwn,
  noLeafPremise,
  replayRefusal,
  seatRemovedLines,
  seatState,
} from '../admitrows.mjs';
import { GROUP_CREATION_NARRATION, REVOKED_SIGN_OUT_NARRATION, admissionMemberNarration, consoleLines, stripStamp } from '../watch.mjs';
import { answerAsk, awaitAsk } from './grouplink.mjs';
import { spawnSync } from 'node:child_process';
import { HARNESS_ROOT } from '../scriptpath.mjs';
import { hasKeyPackage } from '../devices.mjs';

const MEMBER = 'W6';
const SUBJECT = 'W9';
const ROWS = ['ADM-11', 'ADM-12'];
const dry = process.argv.includes('--dry');
const since = new Date().toISOString();
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seats = null;
let fault = null;

/** Every line of a seat's console since `from`, unstamped. */
const plainLines = (cx, from = 0) => consoleLines(cx).slice(from).map((l) => stripStamp(l));

/** The devices of `userId` the server holds a KeyPackage for - what a group's creation would add. */
const keyPackageDevices = (userId) =>
  String(psql(`SELECT DISTINCT "deviceId" FROM key_package WHERE "userId" = '${userId}'`))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Revokes `deviceId` of the subject account through the product's own route, from the subject's own
 * page. THE ALLOWLIST IS THE ACCOUNT: only a device of the account `ACCOUNT_OF.W9` names, which no
 * other seat holds.
 */
async function revoke(cx, userId, deviceId) {
  if (ACCOUNT_OF[SUBJECT] !== 'fifth') throw new Error(`${SUBJECT} must be the fifth account's seat, not ${ACCOUNT_OF[SUBJECT]}`);
  if (!deviceId.includes(userId)) throw new Error(`revoke: ${deviceId.slice(0, 20)}... is not a device of the subject account`);
  const script = `(async function () {
    try {
      var r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!r.ok) return JSON.stringify({ err: 'refresh answered ' + r.status });
      var token = (await r.json()).access_token;
      var del = await fetch('/api/mls/devices/' + ${JSON.stringify(userId)} + '/' + ${JSON.stringify(deviceId)}, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      return JSON.stringify({ status: del.status, body: (await del.text()).slice(0, 200) });
    } catch (e) { return JSON.stringify({ err: String(e) }); }
  })()`;
  const out = JSON.parse(await evaluate(cx, script, { awaitPromise: true }));
  console.log(`[admitcard] revoked ${deviceId.slice(0, 24)}...: ${out.err ?? `${out.status} ${out.body}`}`);
  return out;
}

/** POSTs `body` (a kept commit) to the commit route from the subject's page; the server's answer. */
async function replayCommit(cx, body) {
  const script = `(async function () {
    try {
      var r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!r.ok) return JSON.stringify({ err: 'refresh answered ' + r.status });
      var token = (await r.json()).access_token;
      var c = await fetch('/api/mls/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: ${JSON.stringify(body)} });
      return JSON.stringify({ status: c.status, body: (await c.text()).slice(0, 400) });
    } catch (e) { return JSON.stringify({ err: String(e) }); }
  })()`;
  return JSON.parse(await evaluate(cx, script, { awaitPromise: true }));
}

/** Runs a rig atom (`login.mjs`, `pin.mjs`) for the subject seat in its own process; throws on failure. */
function atom(script) {
  const r = spawnSync(process.execPath, [`${HARNESS_ROOT}/${script}`, '--device', SUBJECT], { encoding: 'utf8', timeout: 240_000 });
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
  console.log(`[admitcard] ${script}: exit ${r.status} - ${tail.slice(0, 300)}`);
  if (r.status !== 0) throw new Error(`${script} --device ${SUBJECT} failed (exit ${r.status})`);
}

/** Waits until the seat's page holds a device id for `userId` other than `not`; that id, or null. */
async function awaitNewDevice(cx, userId, not, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await deviceIdOf(cx, userId).catch(() => null);
    if (d && d !== not) return d;
    if (Date.now() > deadline) return null;
    await sleep(1_000);
  }
}

async function play() {
  const S = seats.seat[SUBJECT].cx;
  const M = seats.seat[MEMBER].cx;
  const subject = userOf(seats, SUBJECT);
  const member = userOf(seats, MEMBER);
  const d0 = await deviceIdOf(S, subject);
  if (!d0) return { premise: [`${SUBJECT} holds no enrolled device of the subject account - log it in first`] };
  // THE ACCOUNT IS THE RIG'S: its devices but the seat's own are revoked first, so the groups the row
  // mints hold exactly ONE leaf of the person - the one whose revocation the row then reads.
  const others = keyPackageDevices(subject).filter((d) => d !== d0);
  console.log(`[admitcard] subject ${subject.slice(0, 8)}: seat device ${d0.slice(0, 24)}..., ${others.length} other device(s) with a KeyPackage`);
  if (dry) return { dry: true, detail: { d0, others: others.length } };
  for (const d of others) await revoke(S, subject, d);

  // ── 1. Two groups holding the person's one leaf ────────────────────────────────────────────────
  const names = [displayNameOf(subject), PEER_NAME];
  const groups = {};
  for (const row of ROWS) {
    // A FRESH DOCUMENT FOR EACH MINT: the group just created is left open, and on this window's layout
    // it covers the "Nouvelle discussion" control (zero-sized, measured on the first run).
    await reloadAndWait(M);
    groups[row] = await mintRowGroup(M, row, member, names);
    console.log(`[admitcard] ${row}: minted ${groups[row].name} (${groups[row].id.slice(0, 8)}...)`);
  }
  // THE SEAT READS ITS LIST WHERE THE LIST IS: a sign-in lands on the feed, which lists no conversation.
  if ((await evaluate(S, 'location.pathname')) !== '/chat') await goto(S, '/chat');
  for (const row of ROWS) {
    const v = await awaitServer(groups[row].id, (view) => seatState(view, subject).active > 0, 60_000);
    if (!v.settled) return { premise: [`${row}: the subject's device never held an active seat in ${groups[row].name}`], detail: { groups } };
    if ((await awaitListed(S, groups[row].name, 90_000)) === null) return { premise: [`${SUBJECT} never listed ${groups[row].name}`], detail: { groups } };
  }

  // ── 2. A new session signs in, and no device of it exists yet ───────────────────────────────────
  // A SESSION CANNOT REVOKE ITS OWN DEVICE (`409 OWN_DEVICE`, measured on the second run), and the
  // person's only device must go. So the seat's origin is wiped and the account signs in again, but is
  // NOT unlocked: the web client mints its device id, and registers it, only past the PIN (measured on
  // the third run - no `mls_device_id_*` key after the sign-in, and a hold on `register-device` that
  // never fired before the PIN). That session revokes the old device while nothing of the new one
  // exists to be added - the S15 shape, a new device added as a further device of a member who still
  // held a leaf, cannot occur.
  //
  // The new device's external commit is answered 503 before the server sees it, every time, and its
  // bytes kept. THE ROW'S OWN REPLAY IS NOT THE DEVICE'S DOOR: the rule lets exactly the replayed BYTES
  // through, so they reach the real server (the fifth run's replay was answered by the fault itself),
  // while any attempt of the device's own - other bytes - is still answered, even in the same instant.
  let replayBody = null;
  fault = await armFault(S, [{ ...ADMIT_CARD_FAULT, keepBody: true, when: (req) => req.body !== replayBody }]);
  const origin = new URL(await evaluate(S, 'location.href')).origin;
  await S.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  await evaluate(S, `location.href = ${JSON.stringify(origin)}`);
  atom('login.mjs');

  // ── 3. The person's every leaf goes, by a commit; the seat stands ─────────────────────────────────
  const revokedD0 = await revoke(S, subject, d0);
  const linesAtReload = consoleLines(M).length;
  await reloadAndWait(M);
  const strayBy = Date.now() + 180_000;
  while (Date.now() < strayBy) {
    // EITHER MEMBER DEVICE MAY REMOVE THE LEAF (the owner has others online): the fact is the
    // server's - no seat of the person active in either group.
    const views = ROWS.map((r) => seatState(serverView(groups[r].id), subject));
    if (views.every((s) => s.active === 0)) break;
    await sleep(1_500);
  }
  const removals = strayRemovals(plainLines(M, linesAtReload));
  const after = {};
  for (const row of ROWS) {
    const view = serverView(groups[row].id);
    after[row] = {
      seat: seatState(view, subject),
      epoch: view.activeEpoch,
      // Which member device committed the removal is recorded, not asserted: any device of the owner's
      // that is online may (the reload of W6 only guarantees one is).
      removedByW6: removals.finished.some((x) => x.group === groups[row].id.slice(0, 8)),
    };
  }
  const premise = noLeafPremise({ revoked: revokedD0, after, rows: ROWS });
  console.log(`[admitcard] after the revocation: ${JSON.stringify(after)}`);
  if (!premise.every((p) => p.ok)) return { premise: premise.filter((p) => !p.ok).map((p) => p.what), detail: { groups, after } };

  // ── 4. Only now is the new device made: unlocked, enrolled, then its list opened ───────────────────
  atom('pin.mjs');
  const d1 = await awaitNewDevice(S, subject, d0);
  if (!d1) return { premise: [`${SUBJECT} never held a new device after the PIN`], detail: { groups, after } };
  recordCreated({ kind: 'device', id: d1, by: 'ADM-11' });
  // ENROLLED BEFORE THE PAGE IS LEFT: a navigation in the instant after the PIN reloaded a first
  // enrolment in flight, and the next document rotated the id it found without saved state (sixth run,
  // `[MLS] Rotating device identity (saved state lost ...)`). The published KeyPackage is the fact.
  const kpBy = Date.now() + 60_000;
  while (!hasKeyPackage(d1) && Date.now() < kpBy) await sleep(1_000);
  console.log(`[admitcard] new device ${d1.slice(0, 24)}... (KeyPackage ${hasKeyPackage(d1) ? 'published' : 'NOT published'})`);
  // The PIN lands on the feed; the conversations are read where they are listed.
  await goto(S, '/chat');

  // ── 5. The card, on the member, per group ─────────────────────────────────────────────────────────
  const cards = {};
  for (const row of ROWS) {
    await openGroup(M, groups[row].name, { navigate: true, label: row });
    cards[row] = await awaitAsk(M, subject, 180_000);
    console.log(`[admitcard] ${row}: the card ${cards[row] === null ? 'NEVER showed' : `showed in ${cards[row]} ms`}`);
  }
  // Read from the revocation on: the ask may be raised before the member's screen is looked at.
  const asks = Object.fromEntries(ROWS.map((r) => [r, askLinesFor(plainLines(M, linesAtReload), subject, groups[r].id)]));

  // ── 6. ADM-11: Refuser removes the seat; the kept external commit is then refused ─────────────────
  const declineGroup = groups['ADM-11'];
  let declined = { seat: null, replay: null, gate: [], line: 0 };
  if (cards['ADM-11'] !== null) {
    await openGroup(M, declineGroup.name, { navigate: true, label: 'ADM-11' });
    // A NAVIGATION IS A NEW DOCUMENT, and its store raises the ask again only at its own sweep (the eighth
    // run answered into a row not drawn yet): the row is awaited on the screen it is answered on.
    if ((await awaitAsk(M, subject, 120_000)) === null) throw new Error('ADM-11: the card did not come back after opening the group to answer it');
    await answerAsk(M, subject, 'decline');
    const v = await awaitServer(declineGroup.id, (view) => seatState(view, subject).state === 'absent', 60_000);
    declined.seat = seatState(v, subject);
    // READ OVER THE WHOLE WINDOW SINCE THE REVOCATION, never from an index taken at the Decline: the
    // seventh run read none from such an index while the line was in the page's console. ADM-12 answers
    // Accepter, so the one `removed` answer about the person in this window is ADM-11's.
    // AWAITED, NOT SAMPLED: the server's row can read `absent` before the member has logged the answer
    // it was given (the ninth run sampled at that instant and read none; the line was in its console).
    const lineBy = Date.now() + 30_000;
    while ((declined.line = seatRemovedLines(plainLines(M, linesAtReload), subject)) === 0 && Date.now() < lineBy) await sleep(500);
    const kept = fault.records.filter((r) => typeof r.body === 'string' && r.body.includes(declineGroup.id));
    if (kept.length) {
      const replayedAt = now();
      replayBody = kept[kept.length - 1].body;
      declined.replay = await replayCommit(S, replayBody);
      await sleep(2_000);
      declined.gate = srvLines('chat-delivery-service', new Date(Date.parse(replayedAt) - 2_000).toISOString()).filter(
        (l) => l.includes('[COMMIT]') && l.includes(declineGroup.id) && l.includes('REJECT')
      );
    }
    console.log(`[admitcard] ADM-11: seat ${JSON.stringify(declined.seat)}, replay ${JSON.stringify(declined.replay)}, ${declined.gate.length} gate REJECT line(s)`);
  }

  // ── 6. ADM-12: Accepter brings the person back, while the fault still holds their own door ─────────
  const approveGroup = groups['ADM-12'];
  let accepted = { seat: null, listed: false, received: 0 };
  if (cards['ADM-12'] !== null) {
    await openGroup(M, approveGroup.name, { navigate: true, label: 'ADM-12' });
    if ((await awaitAsk(M, subject, 120_000)) === null) throw new Error('ADM-12: the card did not come back after opening the group to answer it');
    await answerAsk(M, subject, 'approve');
    const v = await awaitServer(approveGroup.id, (view) => seatState(view, subject).active > 0, 120_000);
    accepted.seat = seatState(v, subject);
  }
  const report = await fault.disarm();
  fault = null;
  if (cards['ADM-12'] !== null) {
    accepted.listed = (await awaitListed(S, approveGroup.name, 90_000)) !== null;
    const mark = rowMessageMark('ADM-12', 'AFTER');
    await openGroup(M, approveGroup.name, { navigate: true, label: 'ADM-12' });
    await send(M, `ADM-12 after the Accept [${mark}]`);
    if (accepted.listed) {
      await openGroup(S, approveGroup.name, { navigate: true, label: 'ADM-12' });
      for (let i = 0; i < 30 && accepted.received === 0; i++) {
        accepted.received = (await receivedOn(S, mark)).count;
        if (accepted.received === 0) await sleep(1_000);
      }
    }
    console.log(`[admitcard] ADM-12: seat ${JSON.stringify(accepted.seat)}, listed ${accepted.listed}, received ${accepted.received}`);
  }

  const external = report.records.filter((r) => r.rule === 0).length;
  return {
    groups,
    report,
    detail: { d0: d0.slice(0, 24), d1: d1.slice(0, 24), after, cards, asks, declineLine: declined.line, externalCommitsHeldBack: external },
    own: {
      'ADM-11': [...premise, ...declinedCardOwn({ card: cards['ADM-11'], asks: asks['ADM-11'], seatLine: declined.line, seat: declined.seat, replay: replayRefusal(declined.replay), gate: declined.gate.length, external })],
      'ADM-12': [...premise, ...acceptedCardOwn({ card: cards['ADM-12'], asks: asks['ADM-12'], ...accepted })],
    },
  };
}

try {
  seats = await openSeats([MEMBER, SUBJECT], 'ADM-11');
  const out = await play();
  if (out.dry) {
    console.log(`[admitcard] dry: ${JSON.stringify(out.detail)}`);
    closeSeats(seats);
    process.exit(0);
  }
  const judged = {};
  for (const row of ROWS) {
    const group = out.groups?.[row];
    const invariant = group
      ? await checkInvariant({
          group: group.id,
          targets: seats.targets,
          members: row === 'ADM-12' ? [MEMBER, SUBJECT] : [MEMBER],
          conversation: group.name,
          fromEpoch: out.detail?.after?.[row]?.epoch ?? null,
          since,
          reload: true,
          watchers: watchersOf(seats),
          // The 503s the fault answered are the row's own, counted one for one.
          provoked: { [SUBJECT]: provokedFailures(out.report?.records ?? []) },
        })
      : null;
    judged[row] = { group, invariant, ...composeVerdict({
      own: out.own?.[row] ?? [],
      invariant,
      premise: out.premise ?? [],
      vacuousFaults: out.report?.vacuous?.map((i) => ({ rule: i, fault: out.report.rules[i].fault })) ?? [],
    }) };
    for (const f of judged[row].failures) console.log(`[${row}] ${f}`);
    console.log(`[${row}] assertions: ${judged[row].verdict}`);
  }
  // ONE REPORT FOR THE TWO ROWS: a seat's report drains its events, and both rows share one window.
  // Each seat is forgiven the narration of its own part in BOTH groups, and nothing wider.
  const memberLogs = [...GROUP_CREATION_NARRATION];
  if (out.groups) {
    memberLogs.push(...admissionMemberNarration(out.groups['ADM-11'].id, { declined: true }));
    memberLogs.push(...admissionMemberNarration(out.groups['ADM-12'].id, { admitted: true }));
  }
  const observers = await observersOf(seats, {
    logs: { [MEMBER]: memberLogs, [SUBJECT]: [...REVOKED_SIGN_OUT_NARRATION, ...LEAF_REVOKED_WIPE_NARRATION] },
    provoked: { [SUBJECT]: out.report?.records ?? [] },
    // THE REFUSALS THE ROW PROVOKES ON THE SUBJECT, and only those: the replayed commit (403); the
    // wiped page's refresh, its cookie gone with the origin (401); and the roster of the conversation
    // the person was just declined from, asked by their own device once their seat is gone (403).
    refusals: {
      [SUBJECT]: [
        { path: /^\/api\/mls\/commit$/, status: [403] },
        // The path is read with its query (`watch.mjs` `pathOfLine`): the client stamps `?clientVersion=`.
        { path: /^\/api\/auth\/refresh(\?|$)/, status: [401] },
        ...(out.groups ? [{ path: new RegExp(`^/api/mls/groups/${out.groups['ADM-11'].id}/user-members$`), status: [403] }] : []),
      ],
    },
  });
  let worst = 0;
  for (const row of ROWS) {
    const { group, invariant, verdict, failures } = judged[row];
    const done = await recordObserved(
      row,
      verdict,
      { ...out.detail, group: group?.id ?? null, own: out.own?.[row] ?? [], failures, invariant: invariantDetail(invariant), serverWindowSince: since },
      observers
    );
    if (done.verdict !== 'PASS') worst = 1;
  }
  closeSeats(seats);
  process.exit(worst);
} catch (e) {
  console.error(`[admitcard] ${e?.stack ?? e}`);
  if (fault) await fault.disarm().catch(() => {});
  for (const row of ROWS) record(row, 'ERROR', errorDetail(e));
  closeSeats(seats);
  process.exit(1);
}
