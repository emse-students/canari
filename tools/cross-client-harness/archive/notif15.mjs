/**
 * NOTIF-15: a reaction to YOUR OWN message notifies you, on the reactions channel, and no other
 * reaction says anything at all.
 *
 * ## The two halves, and why neither is enough alone
 *
 * The check has a POSITIVE and a NEGATIVE, and the negative is the reason this row exists. A build
 * that notified on every reaction in the conversation would pass any positive-only check: the
 * notification the user wants would be there, buried in the ones they do not. So the row measures
 * both, in one run, against the same shade - and the negative is only believable if the transport
 * was demonstrably alive while nothing arrived, which is what the peer's own MESSAGE in step 5 is
 * for. A silent phone and a dead phone look identical, and this harness has already recorded four
 * verdicts about an app it never reached (see `fcmlink.mjs`).
 *
 * ## The three things that have to be true of the bench, or the row measures nothing
 *
 * **THE APP MUST NOT BE IN FRONT, AND THAT IS THE PRODUCT'S OWN RULE RATHER THAN A CONVENIENCE.**
 * `CanariFirebaseMessagingService` computes `showsWhileForeground = form_reminder || (social &&
 * !isReaction)` and returns early for everything else: a reaction is deliberately EXCLUDED from the
 * exemption, because it is drawn into a conversation's own notification and posting one over a
 * conversation you are reading is noise. The board asks for a KILLED device rather than merely a
 * backgrounded one, which is the harder case: with no WebView and no Tauri MLS engine alive,
 * everything here is rendered by the FCM service's own JNI path.
 *
 * **THE PHONE MUST HOLD THE MESSAGE THE REACTION NAMES.** The push carries `messageId` and never a
 * copy - the reacted-to text is MLS plaintext and stopped reaching this server, Google and Apple on
 * 2026-09-16 - so the device renders the reaction against its OWN copy. The owner's message is
 * therefore TYPED ON THE PHONE, which makes holding it structural rather than something to wait for
 * and hope: you wrote it there, you left, somebody reacted.
 *
 * **AND NO OTHER DEVICE OF THE OWNER MAY BE LEFT IN THE CONVERSATION.** This one cost the first run
 * (2026-09-17). A read receipt is a silent push, and the phone cancels the conversation's
 * notifications when one arrives from the owner's own other device - so the witness notification was
 * BUILT (`notifId=1001`, 17:02:32.107) and removed 80 ms later (`FCM silent from self`,
 * 17:02:32.187), taking the reaction notification with it. The product was working perfectly; the
 * bench was reading its own left-over browser. `leaveConversation` is that lesson, and the parks
 * below are part of the verdict rather than tidy-up.
 *
 * ## What the verdict is read from
 *
 * The CHANNEL, not the text. `canari_reactions` versus `canari_messages` is a POLICY difference -
 * importance, sound, vibration, whether it may cross Do Not Disturb - and on 2026-09-17 a reaction
 * was posted on the messages channel, where it rang like a message and counted toward the unread
 * badge. A check matching on the body would have passed on exactly that build.
 *
 * Usage: bun archive/notif15.mjs
 */
import {
  APP_TAB,
  awaitMessage,
  client,
  ensureChat,
  leaveConversation,
  openConversation,
  parkConversation,
  reactToBubble,
  send,
} from '../chat.mjs';
import { mark, finishObserved } from '../results.mjs';
import { logcatReport, logcatSince, watch } from '../watch.mjs';
import { requireFreshFcmLink } from '../fcmlink.mjs';
import * as phone from '../phone.mjs';
import { ORIGIN, OWNER_NAME, PEER_NAME, PORTS } from '../names.mjs';

// The phone this row drives, declared - see the same line in `notif.mjs`. It also sets
// `ANDROID_SERIAL` for every adb spawned underneath, so a second handset on the bench cannot be
// driven by accident.
phone.useDevice('A1');

const ROW = 'NOTIF-15';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const stage = (s) => console.error(`[${String((Date.now() - T0) / 1000).padStart(7)}s] ${s}`);

/** A park answer that actually left, on either layout - anything else is an unmet precondition. */
const LEFT = ['already outside a conversation', 'left', 'routed away'];

/**
 * Every notification the phone has FILED UNDER `canari_reactions` since `sinceMs`.
 *
 * `updatedAt` is `mUpdateTimeMs` and not `when`, which matters more here than anywhere: a second
 * reaction in the same conversation UPDATES the first record in place (`reactionNotifKey`), so a
 * wrongly-pushed reaction in the negative half would not appear as a new row at all - it would
 * bump the row the positive half left behind. Reading the update time is what makes the negative
 * capable of failing.
 */
const reactionNotifsSince = (sinceMs) =>
  phone.notifications().filter((n) => n.channel === 'canari_reactions' && n.updatedAt >= sinceMs);

/** Waits for one, returning it with the elapsed ms, or null on timeout. */
async function awaitReactionNotif(sinceMs, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = reactionNotifsSince(sinceMs)[0];
    if (hit) return { hit, tookMs: Date.now() - t0 };
    await sleep(2_000);
  }
  return null;
}

// --- 0. The transport, before anything is measured over it ---------------------------------
const fcmLink = await requireFreshFcmLink(ROW, stage);

// The instant the phone's log window opens, so `logcatSince` is asked for exactly this row and not
// for whatever the handset was doing before it.
const phoneWindowFrom = Date.now();
const w2 = await client(PORTS.W2, APP_TAB); // the peer, who does all the reacting
// THE PHONE IS NOT ON `APP_TAB`. Tauri serves the frontend from inside the APK, so A1's tab is
// `http://tauri.localhost/...` while the browsers are on the estate's own host - the same fact that
// makes `ttfbMs` zero in the boot bench. `ORIGIN.A1` is where that is written down.
const a1 = await client(PORTS.A1, new URL(ORIGIN.A1).host); // the owner, on the phone
const oW2 = await watch(w2, 'notif15-w2');

// --- 1. The owner writes the message ON THE PHONE THAT WILL BE NOTIFIED ----------------------
const m1 = mark('n15own');
stage('phone opens the DM and types the message the reaction will be aimed at');
await ensureChat(a1);
await openConversation(a1, PEER_NAME);
await send(a1, m1);

stage('peer opens the DM and waits for it');
await ensureChat(w2);
await openConversation(w2, OWNER_NAME);
const seenByPeerMs = await awaitMessage(w2, m1, 45_000);
stage(`peer holds it after ${seenByPeerMs}ms`);

// --- 2. Every OTHER owner device leaves the conversation --------------------------------------
// See the docblock: an owner device left inside the DM emits read receipts, and a read receipt from
// self cancels this conversation's notifications on the phone. W1 and W3 both act as the owner.
stage('the owner browsers leave the conversation - a self-read receipt would cancel the shade');
const parkedBrowsers = {};
for (const name of ['W1', 'W3']) {
  const cx = await client(PORTS[name], APP_TAB).catch(() => null);
  parkedBrowsers[name] = cx ? await leaveConversation(cx) : 'unreachable';
}
stage(`owner browsers: ${Object.entries(parkedBrowsers).map(([k, v]) => `${k}=${v}`).join(', ')}`);

// --- 3. The phone leaves the conversation, then DIES -------------------------------------------
// `am kill` and never `am force-stop`: a force-stopped package sits in Android's STOPPED state and
// the framework cancels every FCM broadcast to it, so the row would measure Android refusing to
// deliver and call it a missing notification.
//
// Parked FIRST. A reaction notification is cancelled when its conversation is opened, and leaving
// the phone inside the DM would have it measure the cancel path on the next launch instead.
stage('phone parks the conversation, then is killed from HOME and proven dead');
const parkedPhone = await parkConversation(a1);
const deadInMs = (await phone.killAndProveDead()).deadInMs;
const foregroundAfterKill = phone.foregrounded();
if (foregroundAfterKill) {
  throw new Error('the app is still in front after the kill - a reaction is suppressed in foreground');
}

// --- 4. POSITIVE: the peer reacts to the OWNER's message --------------------------------------
const sincePositive = phone.deviceNowMs();
stage('peer reacts to the OWNER message - this one is supposed to notify');
await reactToBubble(w2, m1, '❤️');
const positive = await awaitReactionNotif(sincePositive, 90_000);
stage(
  positive
    ? `reaction notification after ${positive.tookMs}ms on channel=${positive.hit.channel}`
    : 'NO reaction notification in 90s'
);

// --- 5. The liveness witness, and the peer's own message to react to next ----------------------
// This message is BOTH halves of the negative's precondition: it proves push is still reaching this
// phone in this window, and it is a message whose author is NOT the owner - so a reaction to it must
// say nothing to the owner.
const m2 = mark('n15peer');
const sinceWitness = phone.deviceNowMs();
stage('peer sends its OWN message - the negative needs a target, and the shade needs a witness');
await send(w2, m2);
const witnessMs = await phone.awaitNotification(m2.slice(0, 12), 90_000, sinceWitness);
const witnessChannels = phone
  .notifications()
  .filter((n) => n.updatedAt >= sinceWitness && n.channel && n.channel !== 'canari_reactions')
  .map((n) => n.channel);
stage(
  witnessMs === null
    ? 'NO message notification for the peer message - the negative below would prove nothing'
    : `message notification after ${witnessMs}ms on ${witnessChannels.join(',') || 'an unnamed channel'}`
);

// --- 6. NEGATIVE: the peer reacts to ITS OWN message ------------------------------------------
const sinceNegative = phone.deviceNowMs();
stage('peer reacts to its OWN message - the owner must hear nothing about this one');
await reactToBubble(w2, m2, '😂');
await sleep(45_000);
const leaked = reactionNotifsSince(sinceNegative);
stage(
  leaked.length
    ? `LEAK: ${leaked.length} reaction notification(s) for a message the owner did not write`
    : 'silent, as specified - no reaction notification for the peer own message'
);

// --- 7. What the notification was allowed to SAY ------------------------------------------------
// THE THIRD ASSERTION IS THE PRIVACY ONE AND IT IS THE REASON THE PUSH CARRIES AN ID. Until
// 2026-09-16 this path sent `messagePreview` - 80 characters of the DECRYPTED message - so plaintext
// from an end-to-end encrypted conversation reached this server, Google and Apple on every reaction.
// The marker IS the message here, so its presence anywhere in the record is that leak returning, and
// looking for it in `full` rather than in the drawn body is deliberate: a copy that is carried but
// not rendered has still left the device.
const carried = {
  emoji: !!positive && positive.hit.full.includes('❤️'),
  actor: !!positive && positive.hit.full.includes(PEER_NAME),
  messageText: !!positive && positive.hit.full.includes(m1),
};

const preconditions =
  LEFT.includes(parkedPhone) && Object.values(parkedBrowsers).every((p) => LEFT.includes(p));
const notifiedOnReactionsChannel = !!positive && positive.hit.channel === 'canari_reactions';
const verdict =
  preconditions &&
  notifiedOnReactionsChannel &&
  carried.emoji &&
  carried.actor &&
  !carried.messageText &&
  leaked.length === 0 &&
  witnessMs !== null
    ? 'PASS'
    : 'FAIL';

await finishObserved(
  ROW,
  verdict,
  {
    fcmLink,
    parkedPhone,
    parkedBrowsers,
    deadInMs,
    foregroundAfterKill,
    seenByPeerMs,
    positive: positive
      ? {
          tookMs: positive.tookMs,
          channel: positive.hit.channel,
          // Booleans and never the strings themselves: `carried.actor` is an account's display
          // name, and a results row is read in places a name should not travel to.
          carried,
          // Whether the body will be DRAWN and not merely carried - `phone.bodyIsDrawn`.
          drawn: phone.bodyIsDrawn(positive.hit),
          template: positive.hit.template,
          key: positive.hit.key,
        }
      : null,
    // The negative is reported WITH its witness, never alone: nothing arriving is only evidence
    // about the app if something else was arriving at the same time.
    negative: { leaked: leaked.map((n) => n.key), witnessMs, witnessChannels },
  },
  // The phone's own log is an OBSERVER and not a detail field: a reaction that arrived over a
  // handset logging decrypt failures is not the same measurement as one that arrived over a quiet
  // one, and `gate` is what applies that to the verdict rather than leaving it to a reader.
  { W2: oW2, A1: logcatReport(await logcatSince(phoneWindowFrom), 'A1') },
  // THE ROW KILLED THE APP, SO THE ROW PUTS IT BACK - INCLUDING PAST THE PIN GATE. A cold launch
  // lands on the PIN screen, and a phone left there is a precondition the NEXT run fails on: the
  // second run of this very check died in `ensureChat` with "port 9333 is behind the PIN gate",
  // which is this row's own leftover reported as somebody else's unmet precondition. Teardown runs
  // after the verdict is durable and its failures cannot change it, so restoring here is free.
  async () => {
    stage('restoring: the phone is relaunched and taken back through the PIN gate');
    await phone.foreground({ port: PORTS.A1 }).catch(() => null);
    phone.unlockPin(PORTS.A1);
  }
);
