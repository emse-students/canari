#!/usr/bin/env node
/**
 * NOTIF-17b - a first message into a conversation this device has NO RECORD OF, arriving as a PUSH.
 *
 *   bun archive/notif17b.mjs
 *
 * **THIS IS THE USER'S OWN REPORT, AS CLOSE AS TWO ACCOUNTS CAN GET TO IT.** Reported from
 * production on 2026-09-08: *"Quelqu'un m'envoie un message alors que nous n'avons pas encore de
 * discussion. Je recois bien la notif, et le message est bien dechiffre. Mais quand je clique sur la
 * notif 1) Je n'arrive [pas] dans la conversation 2) la conversation n'apparait pas directement
 * (apres un redemarrage de l'app oui a priori, mais pas suite a reception de la notif)."*
 *
 * **WHAT IT IS NOT, AND THE LIMIT IS THE FIXTURE'S.** NOTIF-17 proper asks about an unknown
 * CORRESPONDENT, and this rig owns two accounts - `owner` (W1, A1, W3) and `peer` (W2) - which have
 * talked. A third account is owed by the USER and NOTIF-17 stays `pending` until it exists. The
 * defect is keyed on a groupId the booting app has no conversation for, and **a group created
 * seconds ago is exactly that**, whether or not the two people have met elsewhere.
 *
 * **THE APP MUST BE KILLED, AND THE FIRST VERSION OF THIS ROW GOT THAT BACKWARDS.** It backgrounded
 * a LIVE A1 and passed - on a path that was never broken. A1's own log said why:
 * `[NOTIF] Inbound ... (no push is sent for a frame this client ACKed)`. A live app keeps its socket,
 * ACKs the frame, and `scheduleDeferredPush` never fires, so `CanariFirebaseMessagingService` never
 * runs, nothing is written to `fcm_message_cache.ndjson`, and the conversation is materialised by the
 * ordinary in-app path. **A row that can pass without exercising the mechanism it names is a row that
 * lies**, so the builder is now a PRECONDITION rather than a note: a run delivered over the WebSocket
 * records `SETUP-FAILED` and no product verdict at all.
 *
 * **THE SEQUENCE THE DEFECT ACTUALLY NEEDS.** `consumeFcmCache` writes the placeholder conversation
 * row AT CONSUMPTION TIME, and consumption happens at boot AFTER the conversation list has been
 * loaded from the database (`sessionAuth` loads first, by its own comment). So the group has to be
 * absent from the database when the app starts and present in the cache:
 *
 *   1. A1 is KILLED - proven dead, not merely backgrounded.
 *   2. W2 mints a group, adds A1, and speaks into it. A1 cannot ACK, so the server pushes.
 *   3. The Kotlin service decrypts and appends to the cache. The notification is the evidence.
 *   4. A1 is launched. Conversations load - the group is not among them - and THEN the cache is
 *      consumed, which is the moment the row is about.
 *
 * **AND IT CARRIES ITS OWN CONTROL, WHICH IS WHAT MAKES IT DIAGNOSTIC.** If the conversation is
 * absent after that first start, the app is restarted ONCE more and asked again. The user's report
 * names precisely this shape - invisible on the start that received it, present after a further
 * restart - so a second start that SHOWS it proves the placeholder reached the database and only the
 * in-memory list was skipped. That separates the defect from "the message never arrived at all",
 * which the same empty sidebar would otherwise mean.
 */
import { APP_TAB, client, ensureChat, evaluate, send } from '../chat.mjs';
import { closeOverlays, createGroup, deleteGroup } from '../groupnav.mjs';
import { addMember } from './addmember.mjs';
import { gate, ignoringExpectedLog, logcatSince, report, watch } from '../watch.mjs';
import { mark, record, exitOnRecorded } from '../results.mjs';
import * as phone from '../phone.mjs';
import { requireFreshFcmLink } from '../fcmlink.mjs';
import { PORTS, peerNameFor } from '../names.mjs';

// THE PHONE THIS ROW DRIVES, NAMED IN THE FILE - `useDevice` in `phone.mjs`, asserted by
// `make test-harness`.
phone.useDevice('A1');

const T0 = Date.now();
const stage = (s) => console.error(`[${String((Date.now() - T0) / 1000).padStart(6)}s] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const withDeadline = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_r, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    ),
  ]);

/** Every conversation row A1's sidebar is showing, as text - `pin.mjs` owns this selector. */
const sidebarOf = async (cx) =>
  JSON.parse(
    await evaluate(
      cx,
      `JSON.stringify([].map.call(document.querySelectorAll('aside button, nav button'),
         function (b) { return (b.innerText || '').trim().slice(0, 60); }).filter(Boolean))`
    )
  );

/**
 * Bring A1 up from DEAD, unlock it, and report what its sidebar lists.
 *
 * THREE THINGS A COLD START BREAKS, each of which cost this row a run:
 *
 * 1. **The devtools forward dies with the process.** The app comes back under a new pid and the old
 *    `adb forward` points at nothing, so the attach fails `ECONNRESET` on 9333 rather than waiting.
 *    `notif7.mjs` carries the same line for the same reason.
 * 2. **A cold start comes back to the PIN gate**, and every read behind that modal answers about a
 *    screen the user is not looking at - an empty sidebar there means "locked", not "no
 *    conversations", which is the exact false negative this row would otherwise report as the
 *    defect it is hunting.
 * 3. **The cache is consumed AFTER the conversation list loads.** A read taken the instant `/chat`
 *    renders measures the moment before the one this row is about.
 */
async function startAndRead(what) {
  stage(`${what}: launching A1`);
  phone.launch();
  await sleep(3_000);
  phone.forwardDevtools(PORTS.A1);

  // THE WEBVIEW MUST BE ANSWERING BEFORE `pin.mjs` IS ASKED TO DRIVE IT. `unlockPin` spawns a second
  // process that makes its own connection and reports a bare `exit 1` when there is nothing there
  // yet - which is what a cold start looks like for the first few seconds, and what cost this row a
  // run. `client()` polls for the target, so attaching first turns "not up yet" into a wait instead
  // of a failure. The probe is closed again because the unlock navigates, and a context held across
  // that is a context that answers about the page before it.
  const probe = await withDeadline(client(PORTS.A1, 'tauri.localhost'), 90_000, `${what} probe`);
  probe.close();

  const unlocked = phone.unlockPin(PORTS.A1);
  stage(`${what}: pin gate -> ${unlocked}`);

  const cx = await withDeadline(client(PORTS.A1, 'tauri.localhost'), 90_000, `${what} attach`);
  try {
    await withDeadline(ensureChat(cx), 90_000, `${what} ensureChat`);
    await sleep(8_000);
    return { rows: await sidebarOf(cx), pid: phone.pid(), unlocked };
  } finally {
    cx.close();
  }
}

const w2 = await withDeadline(client(PORTS.W2, APP_TAB), 60_000, 'W2 attach');
await withDeadline(ensureChat(w2), 60_000, 'W2 ensureChat');

// A PUSH ROW BY CONSTRUCTION - the whole precondition is that Google delivers. A link that is
// ESTABLISHED and dead would record `SETUP-FAILED` for a message that never left Google.
const fcmLink = await requireFreshFcmLink('NOTIF-17b', stage);

const oW2 = await watch(w2, 'notif17b-w2');
const out = { fcmLinkMs: fcmLink?.tookMs ?? null };
const unmet = [];
let setupFailed = null;

try {
  const groupName = `N17B-${mark('G').split('-')[1]}`;
  out.group = groupName;

  stage('killing A1 - a LIVE app ACKs the frame and no push is ever sent');
  await withDeadline(phone.killAndProveDead(), 60_000, 'killAndProveDead');
  const killedAt = Date.now();

  stage(`W2 creates the group ${groupName} that A1 has never seen`);
  await withDeadline(createGroup(w2, groupName, { label: 'notif17b' }), 120_000, 'createGroup');

  stage('W2 adds A1 to it - the Welcome A1 must process while it is not running');
  await withDeadline(addMember(w2, peerNameFor('W2')), 120_000, 'addMember');
  // THE INVITE PANEL STAYS UP AND IT SITS ON THE COMPOSER. Measured on this row's first run: `send`
  // threw `no stable element for .chat-composer-footer .chat-composer-editor` with
  // `onTopAtOwnCentre: false, whatIsOnTop: BUTTON`. `createGroup` opens with `closeOverlays` for the
  // same reason; the debt is owed after adding a member too, not only before.
  await closeOverlays(w2);
  await sleep(3_000);

  const marker = mark('N17B');
  stage(`W2 speaks into it: ${marker}`);
  await send(w2, `${marker} the first thing ever said in this conversation`);

  const inMs = await phone.awaitNotification(marker, 90_000).catch(() => null);
  const hit = phone.notifications().find((n) => n.full.includes(marker)) ?? null;
  out.notification = {
    inMs,
    channel: hit?.channel ?? null,
    drawn: hit ? phone.bodyIsDrawn(hit) : null,
    // Matched, never quoted: the body carries a display name and this repository is public.
    carriedTheMessage: hit ? hit.full.includes(marker) : false,
    generic: hit ? phone.GENERIC_BODIES.some((re) => re.test(hit.body)) : null,
  };

  // THE PRECONDITION, READ OUT OF LOGCAT RATHER THAN ASSUMED - see the header. Only the Kotlin
  // service writes `fcm_message_cache.ndjson`, so if it did not run there is nothing at boot for the
  // consumption path to mishandle and this row has measured nothing.
  const lines = await logcatSince(killedAt).catch(() => []);
  out.builtBy = lines.some((l) => /CanariFCM: showNotification/.test(l)) ? 'push' : 'websocket';
  stage(`notification in ${inMs}ms via ${out.builtBy}, channel ${out.notification.channel}`);

  if (inMs === null) {
    setupFailed = 'the first message into a new conversation never notified a KILLED device';
  } else if (out.builtBy !== 'push') {
    setupFailed =
      'the notification was built by the WebSocket plugin, so no FCM cache was written and the ' +
      'consumption path this row exists for was never entered';
  } else if (out.notification.generic) {
    // A REAL PRODUCT FINDING and not a setup fault: the push service ran and could not decrypt.
    unmet.push('theNotificationCarriedTheGenericFallbackBody');
  }

  if (!setupFailed) {
    // ── THE HALF THE USER REPORTED ───────────────────────────────────────────────────────────
    const first = await startAndRead('first start, the one that received it');
    out.firstStart = { rows: first.rows.length, visible: first.rows.some((r) => r.includes(groupName)) };
    stage(`first start: ${first.rows.length} row(s), conversation visible: ${out.firstStart.visible}`);

    if (!out.firstStart.visible) {
      unmet.push('theConversationIsNotOnScreenOnTheStartThatReceivedIt');
      // THE CONTROL, and it only runs when the row has already failed - see the header. A second
      // start that SHOWS it proves the placeholder reached the database and only the in-memory list
      // was skipped, which is the user's exact shape; a second start that does not is a different
      // and worse defect, and the two must not share a verdict.
      stage('it is absent - restarting once more to separate the two causes');
      await withDeadline(phone.killAndProveDead(), 60_000, 'second killAndProveDead');
      const second = await startAndRead('second start, the control');
      out.secondStart = {
        rows: second.rows.length,
        visible: second.rows.some((r) => r.includes(groupName)),
      };
      out.diagnosis = out.secondStart.visible
        ? 'the placeholder REACHED the database and only the in-memory list was skipped - the reported defect exactly'
        : 'it is absent after a second start too, so the message did not reach durable storage at all - a DIFFERENT and worse defect';
      stage(`second start: conversation visible: ${out.secondStart.visible}`);
    }
  }
} finally {
  // THE GROUP THIS ROW MINTED IS SWEPT BY THIS ROW. Every run leaves one more conversation in both
  // accounts otherwise, and two NOTIF rows count sidebar entries - four runs of this check took A1
  // from 4 rows to 8 before the teardown existed. `deleteGroup` answers `not listed` harmlessly when
  // the row died before creating it, so no guard is needed beyond the catch: a teardown that throws
  // would replace this row's verdict with a cleanup failure, which is the fault `run.mjs`'s own
  // teardown comment records.
  if (out.group) {
    const swept = await deleteGroup(w2, out.group).catch((e) => `failed: ${String(e).slice(0, 120)}`);
    stage(`teardown: ${out.group} -> ${swept}`);
  }
  stage('leaving A1 in the foreground');
  phone.launch();
}

// A1 IS NOT WATCHED THROUGH `watch()` HERE, because this row kills it twice and a CDP observer does
// not survive the process it is attached to - the console for each start is read by the runner that
// opens it. W2's report is the one that spans the whole row.
//
// ONE FORGIVENESS, NAMED: `reconcilePublishedKeyPackages: REFUSED to purge ...` is the open prekey
// P1 (`docs/wiki/backlog.md`) accusing itself on every device boot, and this row boots A1 up to
// three times. It is not this row's finding and it is not noise to be demoted - it is tracked, and
// forgiving it HERE by name keeps that P1's own rows meaning what they say.
const gated = gate(setupFailed ? 'SETUP-FAILED' : unmet.length > 0 ? 'FAIL' : 'PASS', {
  W2: ignoringExpectedLog(await report(oW2), [/^\[MLS\] reconcilePublishedKeyPackages: REFUSED/]),
});
record('NOTIF-17b', gated.verdict, { ...gated.detail, ...out, unmet, setupFailed });

exitOnRecorded();
