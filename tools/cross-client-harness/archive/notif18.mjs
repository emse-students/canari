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
 * **THE ONE ORDERING THE ROW CANNOT GRADE.** The seed frame is armed before the message is sent and
 * both go to an OFFLINE device, so both skip the ten-second deferral and leave in order. FCM does
 * not promise to deliver them in that order, and a seed that lands AFTER the message it unlocks
 * makes the generic banner the CORRECT outcome - the mirror is a bounded cache and a miss is
 * designed to degrade. So the two logcat lines are compared by position, and a message handled
 * before its seed arrived is `SETUP-FAILED` naming the inversion. Grading it `FAIL` would file the
 * push layer's ordering as this application's defect.
 */
import { APP_TAB, client, ensureChat, openChannel, send } from '../chat.mjs';
import { createChannel, deleteChannel, enterCommunities, openCommunity } from '../comm.mjs';
import { channelIdOf, channelSessions, communityDistribution, workspaceIdOf } from '../grainedb.mjs';
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
  await withDeadline(send(w2, `${marker} the first thing said under a session A1 never saw minted`), 120_000, 'send');

  const inMs = await phone.awaitNotification(marker, 120_000, floor).catch(() => null);
  const hit = phone.notifications().find((n) => n.full.includes(marker)) ?? null;
  out.notification = {
    inMs,
    channel: hit?.channel ?? null,
    drawn: hit ? phone.bodyIsDrawn(hit) : null,
    // Matched, never quoted: a shade record carries real conversation content and this repository
    // is public.
    carriedThePlaintext: hit ? hit.full.includes(marker) : false,
    generic: hit ? phone.GENERIC_BODIES.some((re) => re.test(hit.body)) : null,
  };
  stage(`notification in ${inMs}ms, channel ${out.notification.channel}`);

  // ── WHAT THE PUSH SERVICE ACTUALLY DID, OUT OF LOGCAT ───────────────────────────────────────
  lines = await logcatSince(killedAt).catch(() => []);
  const absorbAt = firstAt(lines, /absorbGraineSeeds: stored \d+ seed\(s\)/);
  const handledAt = firstAt(lines, new RegExp(`handleChannelMessage: notification title=.*${marker}`));
  const genericAt = firstAt(lines, new RegExp(`no seed/ciphertext -> generic notification channel=${channelId}`));
  const storedMatch = absorbAt >= 0 ? /stored (\d+) seed\(s\)/.exec(lines[absorbAt]) : null;
  out.push = {
    builtBy: lines.some((l) => /CanariFCM: showNotification/.test(l)) ? 'push' : 'websocket',
    keyMaterialRecognised: lines.some((l) => /decryptProto: graine key material/.test(l)),
    seedsStored: storedMatch ? Number(storedMatch[1]) : 0,
    seedBeforeMessage: absorbAt >= 0 && handledAt >= 0 ? absorbAt < handledAt : null,
    fellBackToTheGenericBanner: genericAt >= 0,
  };
  stage(
    `push: builtBy=${out.push.builtBy} seeds=${out.push.seedsStored} ` +
      `seedBeforeMessage=${out.push.seedBeforeMessage} generic=${out.push.fellBackToTheGenericBanner}`
  );

  // ONE SESSION, AND THAT IS THE ARGUMENT RATHER THAN AN ASSERTION ABOUT A CLOCK. The salon was
  // minted after the kill, so no session for it can predate the kill; a second session here would
  // mean the sender rotated mid-row and the row no longer knows which seed it measured.
  out.sessions = channelSessions(channelId).length;

  // ── THE VERDICT ─────────────────────────────────────────────────────────────────────────────
  if (inMs === null) {
    setupFailed = 'no notification reached the handset at all, so nothing about the seed was measured';
  } else if (out.push.builtBy !== 'push') {
    setupFailed =
      'the notification was built by the WebSocket plugin, so the app was not really dead and the ' +
      'push path this row exists for never ran';
  } else if (out.push.seedBeforeMessage === false) {
    setupFailed =
      'the seed frame was handled AFTER the message it unlocks - FCM delivered them out of order, ' +
      'and a mirror miss is designed to degrade to the generic banner, so this run cannot grade it';
  } else if (out.sessions !== 1) {
    setupFailed = `the salon carries ${out.sessions} sender sessions, so the row cannot say which seed it measured`;
  } else {
    if (!out.push.keyMaterialRecognised) unmet.push('theSilentFrameWasNotRecognisedAsKeyMaterial');
    if (out.push.seedsStored < 1) unmet.push('noSeedReachedTheNativeMirror');
    if (out.push.fellBackToTheGenericBanner) unmet.push('thePushServiceFellBackToTheGenericBanner');
    if (!out.notification.carriedThePlaintext) unmet.push('theShadeDidNotCarryTheDecryptedText');
    if (out.notification.generic) unmet.push('theBodyWasOneOfTheGenericFallbacks');
    if (!out.notification.drawn) unmet.push('theBodyWasBuiltButNoScreenDrewIt');
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
