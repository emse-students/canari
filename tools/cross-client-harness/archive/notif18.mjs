#!/usr/bin/env node
/**
 * NOTIF-18 - a salon message sealed under a Graine session MINTED WHILE THE PHONE WAS DEAD.
 *
 *   bun archive/notif18.mjs
 *
 * **THE USER'S OWN REPORT, AND THE ONE CELL THE FIX SHIPPED WITHOUT.** Reported on Android and
 * measured on production 2026-09-20: three messages in one salon in fifty seconds, the first
 * carrying its plaintext in the shade and the next two reading `Nouveau message dans #general`. The
 * sender had rotated between the first and the second, and the new session's seed - a SILENT
 * `keyMaterial` frame - was thrown away unread by `CanariFirebaseMessagingService`, which returned
 * before any decrypt on `if (silent && !CALLS_ENABLED)`. The seed never reached the mirror, so every
 * message of that session was blind until the reader next opened the app. The fix and the whole
 * path it travels are
 * `docs/wiki/protocols/channel-encryption.md` section 14; everything holding it today is a unit test
 * and a cross-language string guardrail, and *a green gate is not a working system*. This is the row
 * that makes the phone say it.
 *
 * **WHAT MAKES THE SESSION NEW, AND WHY IT IS A NEW SALON RATHER THAN A ROTATION.** A Graine session
 * is scoped to (channel, sender) and `shouldRotateGraineSession` mints one when there is none. A
 * salon created while the phone is dead therefore GUARANTEES, by construction rather than by
 * timing, that the session the first message is sealed under did not exist when the phone stopped
 * running - which is exactly the state the report describes, reached without having to provoke a
 * roster change and without touching anybody's membership.
 *
 * **AND THIS IS WHERE IT PARTS COMPANY WITH NOTIF-17b, WHICH REFUSED FOR THE OPPOSITE REASON.**
 * That row minted a GROUP while A1 was dead and found that the server owed A1 nothing: a device
 * offline when it is added is not on the new group's delivery roster, so no push was sent and there
 * was nothing to measure. A PUBLIC salon has no group of its own. Its seeds and its messages both
 * travel on the COMMUNITY's distribution group, which A1's device joined while it was alive and
 * which a new channel does not disturb - `createChannel` mints a group only for a private salon.
 * The roster is therefore read and ASSERTED before the kill: if the phone's `tauri-` device is not
 * on it, this row has measured nothing and says so rather than reporting the silence as the defect.
 *
 * **A KILLED APP IS THE PRECONDITION, NOT A DETAIL.** A live app keeps its socket, ACKs the frame,
 * and `scheduleDeferredPush` never fires - so `CanariFirebaseMessagingService` never runs and the
 * seed reaches the mirror by the ordinary foreground path, which was never broken. The builder is
 * read out of logcat and a run the WebSocket served records `SETUP-FAILED`, exactly as NOTIF-17b
 * learned to do.
 *
 * **THE ORDER IS THE ANSWER, AND IT IS READ AT BOTH ENDS.** Two independent services push the two
 * frames this row is about - `social-service` sends the salon message, `chat-delivery-service` sends
 * the seed - and nothing sequences them. So the row reads the phone's order out of logcat AND the
 * send order out of both server logs, because *read the other end before filing a client defect*:
 * a seed handled after its message is a `FAIL` either way (the banner never redraws), and the
 * server times are what separate "we sent them in that order" from "the transport reordered them".
 * The first run, 2026-09-21, measured the former.
 *
 * **THREE TRAPS THIS ROW WALKED INTO ON ITS FIRST RUN, ALL OF THEM ALREADY WRITTEN DOWN.**
 *
 * 1. **IT WAITED ON THE MESSAGE MARKER**, so a shade holding `Nouveau message dans #<salon>` made
 *    the marker absent, which reads as "nothing arrived" and then as a timeout. That is the exact
 *    conflation `GENERIC_BODIES` exists for (`phone.mjs`), and it graded a reproduced defect
 *    `SETUP-FAILED - no notification reached the handset at all` while the banner was on the
 *    screen. The wait is on the SALON NAME now: it is in the title whether or not the body
 *    decrypted, which is the only handle that survives the failure being hunted.
 * 2. **IT LOCATED THE MESSAGE IN LOGCAT BY THAT SAME MARKER**, so the ordering discriminator went
 *    unbound in precisely the case it exists for. It keys on the channel id now.
 * 3. **IT LEFT W1 SITTING IN THE SALON IT HAD JUST CREATED.** W1 holds the SAME ACCOUNT as the
 *    handset, its read receipt is a silent push, and the phone cancels the conversation's
 *    notifications on one from itself - `leaveConversation`'s own docblock records that costing
 *    NOTIF-15 a run. The park is a precondition of the verdict rather than tidy-up, and the
 *    CANCELLATION is read off the phone rather than inferred from what the park returned: a park
 *    can honestly answer "already outside a conversation" about a pane it read wrong, and this row
 *    would then believe a shade that had been emptied under it.
 *
 * **AND A FOURTH, WHICH IS A PRODUCT DEFECT AND NOT A TRAP AT ALL.** The third run built the banner
 * (`showNotification: notifId=1002`) and the shade never showed it, for 120 s. The app logged
 * nothing, because nothing failed on its side: `manager.notify` hands the record to system_server
 * over a binder queue and returns. The OS is what says so - `NotificationService: Cannot find
 * enqueued record for key: 0|fr.emse.canari|1002|...`, i.e. the record was cancelled between being
 * enqueued and being posted. A row that reads only its own app's log cannot tell that from a dead
 * FCM link, so it reported "no notification reached the handset at all" - a refusal, about an
 * answer. The system's line is read now, and the silence it explains is a `FAIL` clause.
 */
import { APP_TAB, client, ensureChat, leaveConversation, openChannel, send } from '../chat.mjs';
import { createChannel, deleteChannel, enterCommunities, openCommunity } from '../comm.mjs';
import { channelIdOf, channelSessions, communityDistribution, workspaceIdOf } from '../grainedb.mjs';
import { srvLines } from '../estate.mjs';
import { gate, logcatReport, logcatSince, report, watch } from '../watch.mjs';
import { exitOnRecorded, mark, record } from '../results.mjs';
import * as phone from '../phone.mjs';
import { requireFreshFcmLink } from '../fcmlink.mjs';
import { PORTS, VENUE } from '../names.mjs';

// THE PHONE THIS ROW DRIVES, NAMED IN THE FILE - `useDevice` in `phone.mjs`, asserted by
// `make test-harness`.
phone.useDevice('A1');

const T0 = Date.now();
const stage = (s) => console.error(`[${String((Date.now() - T0) / 1000).padStart(6)}s] ${s}`);
const withDeadline = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_r, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    ),
  ]);

/** The phone's own device on a distribution roster - the web clients are all `web-`. */
const handsetOn = (dist) => (dist?.devices ?? []).find((d) => d.deviceId.startsWith('tauri-'));

/**
 * Where a needle first occurs in a logcat window, or -1.
 *
 * POSITION, NOT TIMESTAMP. `logcat -d` is chronological, and two lines from the same process a
 * second apart are exactly the comparison this row needs - parsing `MM-DD hh:mm:ss.mmm` back into a
 * clock would add a timezone to a question that does not have one.
 */
const firstAt = (lines, re) => lines.findIndex((l) => re.test(l));

/**
 * The second-of-day a Nest line was written, or null - `09/21/2026, 8:55:16 AM`.
 *
 * SECONDS ARE ALL THE SERVICES PRINT, and that is enough for the only question asked of them: did
 * the two pushes leave in the order their correctness depends on. A sub-second inversion is
 * invisible here and is reported as "the same second" rather than as an order, so the row never
 * claims a precision its instrument does not have.
 */
function sentAtOf(lines, re) {
  const line = lines.find((l) => re.test(l));
  const at = line && /(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/.exec(line);
  if (!at) return null;
  const h = Number(at[1]) % 12 + (at[4] === 'PM' ? 12 : 0);
  return h * 3600 + Number(at[2]) * 60 + Number(at[3]);
}

const out = {};
const unmet = [];
let setupFailed = null;

const workspaceId = workspaceIdOf(VENUE.community);
if (!workspaceId) {
  record('NOTIF-18', 'SETUP-FAILED', {
    setupFailed: `no community named ${VENUE.community} - build the fixture with \`bun venue.mjs\``,
  });
  exitOnRecorded();
}

const w1 = await withDeadline(client(PORTS.W1, APP_TAB), 60_000, 'W1 attach');
const w2 = await withDeadline(client(PORTS.W2, APP_TAB), 60_000, 'W2 attach');
await withDeadline(ensureChat(w1), 60_000, 'W1 ensureChat');
await withDeadline(ensureChat(w2), 60_000, 'W2 ensureChat');

const oW1 = await watch(w1, 'notif18-w1');
const oW2 = await watch(w2, 'notif18-w2');
let killedAt = null;
let lines = [];

try {
  // ── THE PRECONDITION THE WHOLE ROW RESTS ON ─────────────────────────────────────────────────
  // The handset must be on the COMMUNITY's delivery roster before it dies, because that is the one
  // transport a public salon's seeds and messages have. A member's own device commits its add when
  // that member LOADS the community, so the phone is brought up and walked into the venue first -
  // an invited account that has never opened it is entitled to a salon it cannot receive a word
  // from, which is `venue.mjs`'s own finding and would read here as the defect being hunted.
  stage('bringing A1 up so it can commit its own add to the community roster');
  const up = await phone.ensure({ port: PORTS.A1 });
  out.phoneUp = up;
  if (!up.ok) {
    setupFailed = `the phone is not measurable: ${up.reason}`;
    throw new Error(setupFailed);
  }
  const unlocked = phone.unlockPin(PORTS.A1);
  stage(`pin gate -> ${unlocked}`);
  const a1 = await withDeadline(client(PORTS.A1, 'tauri.localhost'), 90_000, 'A1 attach');
  try {
    await withDeadline(ensureChat(a1), 90_000, 'A1 ensureChat');
    await withDeadline(openChannel(a1), 120_000, 'A1 openChannel');
  } finally {
    a1.close();
  }

  const dist = communityDistribution(workspaceId);
  const handset = handsetOn(dist);
  out.roster = {
    groupId: dist?.groupId ?? null,
    epoch: dist?.epoch ?? null,
    devices: (dist?.devices ?? []).length,
    // The id itself is a device belonging to a real account and this repository is public, so the
    // row records that the handset is THERE and its status, never which handset it is.
    handsetStatus: handset?.status ?? null,
  };
  if (!handset || handset.status !== 'active') {
    setupFailed =
      "the phone's device is not active on the community's distribution roster, so no seed and no " +
      'message was ever owed to it - this row would have measured a silence it caused';
    throw new Error(setupFailed);
  }
  stage(`roster: ${out.roster.devices} device(s), epoch ${out.roster.epoch}, handset active`);

  // A PUSH ROW BY CONSTRUCTION - the whole question is what Google delivers to a dead process, and
  // a link that is ESTABLISHED and dead would record a silence that was never this application's.
  // TAKEN HERE, AS LATE AS IT CAN BE: the toggle revives the link by making Play services dial
  // again, and reviving it DELIVERS the 24 h backlog into the shade seconds later (NOTIF-7b). Doing
  // it before the kill puts that flood a full salon-creation ahead of the floor this row reads.
  const fcmLink = await requireFreshFcmLink('NOTIF-18', stage);
  out.fcmLinkMs = fcmLink?.tookMs ?? null;

  // ── THE KILL ────────────────────────────────────────────────────────────────────────────────
  stage('killing A1 - a LIVE app ACKs the frame and the push service never runs');
  out.death = await withDeadline(phone.killAndProveDead(), 60_000, 'killAndProveDead');
  killedAt = Date.now();

  // ── A SALON THAT DID NOT EXIST WHEN THE PHONE DIED ──────────────────────────────────────────
  // Created by W1, which holds the community. A creation mints no session; the first SEND does, and
  // that is W2's, a different account from the one the handset carries.
  const channelName = mark('n18').toLowerCase();
  out.channel = channelName;
  stage(`W1 creates the salon ${channelName}, which A1 has never heard of`);
  await withDeadline(enterCommunities(w1), 60_000, 'W1 enterCommunities');
  await withDeadline(openCommunity(w1, VENUE.community), 60_000, 'W1 openCommunity');
  await withDeadline(createChannel(w1, channelName), 120_000, 'createChannel');
  // W1 HOLDS THE HANDSET'S OWN ACCOUNT, AND CREATING A SALON LEAVES IT INSIDE ONE. Its read receipt
  // is a silent push and the phone cancels a conversation's notifications on one from itself, so a
  // browser left in there deletes the banner this row is about - `leaveConversation`'s docblock
  // records that costing NOTIF-15 a run. A park that did not park is an unmet precondition, not a
  // tidy-up that failed.
  out.w1Parked = await withDeadline(leaveConversation(w1), 60_000, 'W1 leaveConversation');
  stage(`W1 out of the salon it just created: ${out.w1Parked}`);

  const channelId = channelIdOf(workspaceId, channelName);
  out.salonIsInTheDatabase = Boolean(channelId);
  if (!channelId) {
    setupFailed = `the salon ${channelName} is not in the database after the create gesture`;
    throw new Error(setupFailed);
  }

  const marker = mark('N18');
  out.marker = marker;
  stage(`W2 opens it and speaks: ${marker}`);
  await withDeadline(openChannel(w2, VENUE.community, channelName), 120_000, 'W2 openChannel');
  // THE FLOOR IS READ FROM THE DEVICE'S OWN CLOCK, not this workstation's - NOTIF-7b tapped a
  // notification from hours earlier because the two disagree, and a shade record is timestamped by
  // the phone.
  const floor = phone.deviceNowMs();
  // THE STATE THAT DECIDES WHETHER THE BANNER SURVIVES BEING POSTED, READ BEFORE THE SEND. The app
  // rebuilds the messages bundle's summary after every post and CANCELS it when it counts no unread
  // conversation - and cancelling a group summary cancels that group's children, the ones still
  // enqueued included. So a summary left in the shade with no child of its own is the loaded gun,
  // and it is a state an earlier row's teardown produces. Read here, not after the wait, where a
  // summary the successful post itself created would answer a different question. 9999 is the app's
  // reserved id for it (`GROUP_SUMMARY_ID`), spelt here because the shade names records by id only.
  out.summaryInTheShadeBeforeTheSend = phone.notifications().some((n) => /\|9999\|/.test(n.key));
  await withDeadline(send(w2, `${marker} the first thing said under a session A1 never saw minted`), 120_000, 'send');

  // WAITED ON BY THE SALON, NEVER BY THE MARKER. The title is `<community> - #<salon>` whatever the
  // body turns out to be, and the marker is absent in exactly the case this row exists to catch -
  // so waiting on it turns a reproduced defect into a timeout that reads as "nothing arrived". It
  // did, on this row's first run. The salon name carries the run's own stamp, so it cannot match a
  // notification any earlier row left behind.
  const inMs = await phone.awaitNotification(channelName, 120_000, floor).catch(() => null);

  // A BANNER BUILT BEFORE ITS SEED IS OWED A REDRAW, AND THE HANDLER SAYS SO ITSELF. `frame HELD`
  // is the device stating it could not open this message and has kept it for its key material - a
  // FACT, so the row waits for the correction only where one was promised, and never guesses.
  // This is also why the wait below may name the marker where the first one must not: the first
  // wait runs in the case where the marker is precisely what is missing, this one only where the
  // device has undertaken to produce it. A correction that does not come is the defect, and the
  // clause at the bottom names it rather than letting the row time out into "nothing arrived".
  lines = await logcatSince(killedAt).catch(() => []);
  const heldAt = firstAt(lines, new RegExp(`seed absent -> generic banner, frame HELD .*channel=${channelId}`));
  let redrawMs = null;
  if (heldAt >= 0) {
    stage('the handset held this frame for its key material - waiting for the redraw it promised');
    redrawMs = await phone.awaitNotification(marker, 60_000, floor).catch(() => null);
  }

  const hit = phone.notifications().find((n) => n.full.includes(channelName)) ?? null;
  out.notification = {
    inMs,
    // Null when no redraw was owed, which is the ordinary case: the seed won the race and the very
    // first banner carried the plaintext.
    redrawMs,
    channel: hit?.channel ?? null,
    drawn: hit ? phone.bodyIsDrawn(hit) : null,
    // Matched, never quoted: a shade record carries real conversation content and this repository
    // is public.
    carriedThePlaintext: hit ? hit.full.includes(marker) : false,
    generic: hit ? phone.GENERIC_BODIES.some((re) => re.test(hit.body)) : null,
  };
  stage(`notification in ${inMs}ms, channel ${out.notification.channel}`);

  // ── WHAT THE PUSH SERVICE ACTUALLY DID, OUT OF LOGCAT ───────────────────────────────────────
  // RE-READ, because the wait above may have run for a minute and the redraw is at its far end.
  lines = await logcatSince(killedAt).catch(() => []);
  const absorbAt = firstAt(lines, /absorbGraineSeeds: stored \d+ seed\(s\)/);
  // KEYED ON THE CHANNEL, NEVER ON THE MARKER - `type=channel ` with the trailing space, so
  // `type=channel_read` (a silent frame this row's own other device can send) cannot match it.
  const handledAt = firstAt(lines, new RegExp(`type=channel .*groupId=${channelId}`));
  const genericAt = firstAt(lines, new RegExp(`no seed/ciphertext -> generic notification channel=${channelId}`));
  const storedMatch = absorbAt >= 0 ? /stored (\d+) seed\(s\)/.exec(lines[absorbAt]) : null;
  // BUILT AND POSTED ARE TWO EVENTS, AND ONLY THE SECOND ONE IS A SHADE. `manager.notify` hands the
  // record to system_server over a binder queue and returns; the app logs `showNotification:
  // notifId=N` and considers itself finished. When something cancels N inside that window the app
  // says NOTHING - nothing failed on its side - and the only witness is the OS's own line,
  // `Cannot find enqueued record for key: 0|<pkg>|N|...`. Without it this row can say no more than
  // "no notification arrived", which is the same sentence a dead FCM link writes and a completely
  // different defect. `logcatSince` is unfiltered, so the system's line is already in hand.
  const builtLine = lines.find((l) => /CanariFCM: showNotification: notifId=\d+/.test(l));
  const notifId = builtLine ? Number(/notifId=(\d+)/.exec(builtLine)[1]) : null;
  out.push = {
    builtBy: lines.some((l) => /CanariFCM: showNotification/.test(l)) ? 'push' : 'websocket',
    keyMaterialRecognised: lines.some((l) => /decryptProto: graine key material/.test(l)),
    seedsStored: storedMatch ? Number(storedMatch[1]) : 0,
    // AN OBSERVATION, NOT A CLAUSE, SINCE 2026-09-21. FCM promises no order across two sends, so
    // a seed arriving after the message it unlocks is a legitimate interleaving rather than a
    // defect - what is graded is whether the handler absorbed it. It stays recorded because it is
    // what the two clauses below mean, and because a run where it flips is a run worth reading.
    seedBeforeMessage: absorbAt >= 0 && handledAt >= 0 ? absorbAt < handledAt : null,
    fellBackToTheGenericBanner: genericAt >= 0,
    // THE UNDERTAKING, AND WHETHER IT WAS KEPT. `HELD` says the ciphertext is here and the seed is
    // not YET, so this message will be redrawn; the generic line with no HELD beside it is the
    // other case entirely - a ciphertext the server could not inline, which no seed can open.
    heldForItsKeyMaterial: heldAt >= 0,
    redrawnWhenTheSeedLanded:
      heldAt < 0
        ? null
        : lines.some(
            (l) =>
              /seed landed while the generic banner was going up -> redrawing/.test(l) ||
              /drainPendingChannelFrames: \d+ banner\(s\) waiting/.test(l)
          ),
    selfReadCancelled: new RegExp(`type=channel_read .*channel=${channelId}`).test(lines.join('\n')),
    builtNotifId: notifId,
    destroyedBeforeItLanded:
      notifId !== null &&
      lines.some((l) => l.includes(`Cannot find enqueued record for key: 0|${phone.PKG}|${notifId}|`)),
  };
  // AND WHAT IT LOOKS LIKE AFTERWARDS - a summary here that was absent before the send is the app
  // rebuilding its own bundle, which is the healthy outcome and NOT the state that destroys a post.
  out.notification.summaryInTheShade = phone.notifications().some((n) => /\|9999\|/.test(n.key));

  // ── AND WHAT THE SERVER DID, BECAUSE A CLIENT DEFECT IS NOT FILED WITHOUT THE OTHER END ─────
  // Two services, two pushes, nothing sequencing them: `social-service` sends the salon message,
  // `chat-delivery-service` sends the seed. The phone's order is the outcome; these two lines say
  // whether the send order produced it or the transport did.
  const since = `${Math.ceil((Date.now() - killedAt) / 1000) + 30}s`;
  out.sent = {
    messagePushAt: sentAtOf(srvLines('social-service', since), new RegExp(`\\[CHANNEL_PUSH\\] channel=${channelId}`)),
    seedPushAt: sentAtOf(srvLines('chat-delivery-service', since), /\[PUSH_SEND\].*device=tauri-.*inlineProto=true/),
  };
  out.sent.order =
    out.sent.messagePushAt === null || out.sent.seedPushAt === null
      ? 'one of the two pushes is not in the log'
      : out.sent.seedPushAt < out.sent.messagePushAt
        ? 'the seed left first'
        : out.sent.seedPushAt > out.sent.messagePushAt
          ? 'THE MESSAGE LEFT FIRST'
          : 'the same second - no order to read';
  stage(
    `push: builtBy=${out.push.builtBy} seeds=${out.push.seedsStored} ` +
      `seedBeforeMessage=${out.push.seedBeforeMessage} generic=${out.push.fellBackToTheGenericBanner} ` +
      `held=${out.push.heldForItsKeyMaterial} redrawn=${out.push.redrawnWhenTheSeedLanded} ` +
      `| server: ${out.sent.order}`
  );

  // ONE SESSION, AND THAT IS THE ARGUMENT RATHER THAN AN ASSERTION ABOUT A CLOCK. The salon was
  // minted after the kill, so no session for it can predate the kill; a second session here would
  // mean the sender rotated mid-row and the row no longer knows which seed it measured.
  out.sessions = channelSessions(channelId).length;

  // ── THE VERDICT ─────────────────────────────────────────────────────────────────────────────
  if (out.push.builtBy !== 'push') {
    setupFailed =
      'the notification was built by the WebSocket plugin, so the app was not really dead and the ' +
      'push path this row exists for never ran';
  } else if (out.push.selfReadCancelled) {
    // OBSERVED ON THE PHONE, NOT INFERRED FROM THE PARK'S RETURN STRING. `parkConversation` can
    // honestly answer "already outside a conversation" about a pane it read wrong, and this row
    // would then trust a shade the owner's own other device had emptied. The cancellation itself
    // is a logcat line, so it is read rather than argued about.
    setupFailed =
      `a read receipt from this account's own other device cancelled the salon's notifications ` +
      `(W1 park said: ${out.w1Parked}) - the shade cannot be believed on this run`;
  } else if (out.sessions !== 1) {
    setupFailed = `the salon carries ${out.sessions} sender sessions, so the row cannot say which seed it measured`;
  } else if (inMs === null && !out.push.destroyedBeforeItLanded) {
    // A SILENCE NOBODY EXPLAINS IS STILL A REFUSAL. The clause below turns the EXPLAINED silence
    // into a finding; this is what is left of the other one - and the row does not guess between a
    // transport that never delivered and a shade it misread.
    setupFailed =
      'no notification for this salon reached the handset and nothing in the system log says why, ' +
      'so the shade was never measured';
  } else {
    // THE ORDER IS NOT GRADED, THE OUTCOME IS - changed 2026-09-21, when the handler became
    // order-independent. FCM promises no order across two sends and no sender-side serialisation
    // can buy one, so a seed arriving after the message it unlocks is an interleaving the design
    // must absorb, not a finding. What is owed is that the blind banner be CORRECTED: the handler
    // says `frame HELD` when it undertakes to do so, and this row holds it to it. The server's own
    // send order travels in `sent` beside these, so the reader is never left guessing which end
    // produced the interleaving that was absorbed.
    if (out.push.destroyedBeforeItLanded) unmet.push('theBannerWasCancelledBetweenBeingBuiltAndBeingPosted');
    if (!out.push.keyMaterialRecognised) unmet.push('theSilentFrameWasNotRecognisedAsKeyMaterial');
    if (out.push.seedsStored < 1) unmet.push('noSeedReachedTheNativeMirror');
    // A generic body with nothing held beside it is a message this device can NEVER open, which is
    // a different defect from a late seed and must not be reported as one.
    if (out.push.fellBackToTheGenericBanner && !out.push.heldForItsKeyMaterial)
      unmet.push('theBannerWentUpBlindWithNoKeyMaterialToWaitFor');
    if (out.push.redrawnWhenTheSeedLanded === false)
      unmet.push('theFrameWasHeldForItsSeedAndTheBannerWasNEVERREDRAWN');
    // THE SHADE CLAUSES NEED A SHADE RECORD. With the banner destroyed before it landed there is
    // nothing to read, and asking these three anyway turns ONE defect into four findings - the
    // padding that makes a verdict unreadable and hides which of them is the cause.
    if (hit) {
      if (!out.notification.carriedThePlaintext) unmet.push('theShadeDidNotCarryTheDecryptedText');
      if (out.notification.generic) unmet.push('theBodyWasOneOfTheGenericFallbacks');
      if (!out.notification.drawn) unmet.push('theBodyWasBuiltButNoScreenDrewIt');
    }
  }
} finally {
  // THE SALON THIS ROW MINTED IS SWEPT BY THIS ROW - a per-run salon in a SHARED fixture is debris
  // every later row's sidebar count has to step over, which is the cost `notif17b.mjs` records for
  // its groups. A teardown that throws would replace this row's verdict with a cleanup failure, so
  // it is caught and reported as text.
  if (out.channel) {
    const swept = await openChannel(w1, VENUE.community, out.channel)
      .then(() => deleteChannel(w1))
      .then(() => 'deleted')
      .catch((e) => `failed: ${String(e).slice(0, 120)}`);
    stage(`teardown: ${out.channel} -> ${swept}`);
  }
  // READ BEFORE THE RELAUNCH, ALWAYS - and this is the second read only when the first never
  // happened. A cold start floods the window with boot narration, and a report taken after it
  // describes a process that started twenty seconds after the question was answered.
  if (killedAt && lines.length === 0) lines = await logcatSince(killedAt).catch(() => []);
  stage('leaving A1 in the foreground');
  phone.launch();
}

// A1 IS NOT WATCHED THROUGH `watch()`: this row kills the process, and a CDP observer does not
// survive the process it is attached to. Its native half is the logcat window, which is read above.
const gated = gate(setupFailed ? 'SETUP-FAILED' : unmet.length > 0 ? 'FAIL' : 'PASS', {
  W1: await report(oW1),
  W2: await report(oW2),
  'A1-native': logcatReport(lines, 'A1'),
});
record('NOTIF-18', gated.verdict, { ...gated.detail, ...out, unmet, setupFailed });

exitOnRecorded();
