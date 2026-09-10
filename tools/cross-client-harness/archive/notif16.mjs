#!/usr/bin/env node
/**
 * NOTIF-16 - a mention is filed on `canari_mentions` and a plain message on `canari_messages`.
 *
 *   bun archive/notif16.mjs
 *
 * **A CHANNEL IS A POLICY, NOT A LABEL.** Android gives each notification channel its own
 * importance, sound, vibration and Do-Not-Disturb standing, and it gives the USER a switch per
 * channel. `canari_mentions` exists so that being named can be louder than being talked near, and
 * so that someone who mutes the chatter still hears their own name. Every other NOTIF row asserts
 * that a notification ARRIVED and that its text was carried; none asks where it was filed, and a
 * notification filed on the wrong channel is one the user's own mute, sound and DND choices apply
 * to the wrong way round. That is the whole subject of this row.
 *
 * **WHAT THIS ROW IS *NOT* ABOUT, AND THE BOARD USED TO SAY OTHERWISE.** It was written as "the
 * importance split that bypass-DND rests on". There is no importance split: `canari_mentions` and
 * `canari_messages` are BOTH `IMPORTANCE_HIGH` (`CanariApplication.ensureChannels`), and the device
 * reports `mBypassDnd=false` on both. That is not a defect - `setBypassDnd(true)` IS requested for
 * mentions, and the comment on the line above it already says the system honours it only once the
 * user grants the channel DND access. Code and device agree. So the measurable question is ROUTING,
 * and the policy fields are RECORDED rather than asserted: this row must not encode as a product
 * expectation something only a human grant can produce.
 *
 * **TWO ROUTES, AND THAT IS WHY THE MATRIX IS 2x2.** NOTIF-14 measured, on ONE backgrounded phone,
 * a DM notified by `tauri-plugin-notification` over the WebSocket and a salon message notified by
 * `CanariFirebaseMessagingService` four seconds later: **the builder is a property of the message's
 * ROUTE, not of the app's state.** The two do not agree here. The Kotlin service reads the
 * decrypted text for `@[myUserId]` and picks `CHANNEL_MENTIONS` or `CHANNEL_MESSAGES` from it. The
 * web half exports exactly two channel constants, `canari_messages` and `canari_calls`, and passes
 * `CHANNEL_MESSAGES` unconditionally - it has no mentions branch at all. So the row sends a plain
 * message AND a mention down EACH route and reports four cells, because a pass measured on one
 * route says nothing whatever about the other, and a run that happened to take the push route for
 * both would report a clean split for a product that only has one half of it.
 *
 * **WHY THE READ IS TAKEN BETWEEN SENDS AND NOT AT THE END.** The push builder keeps a stable
 * notification id per conversation and re-`notify()`s over it, so a second message to the same
 * conversation UPDATES the record the first one made - including its channel. Reading both at the
 * end would therefore read the second message's channel twice and report the split as broken, or
 * as working, depending only on which order the sends went out. Each half is read before the next
 * send exists.
 *
 * **AND IT ASSERTS "AT LEAST ONE RECORD ON THE EXPECTED CHANNEL", DELIBERATELY.** The push builder
 * also posts a group summary (`setGroupSummary(true)`, `GROUP_KEY_MESSAGES`), so a marker can
 * appear on two records at once - the child and the summary that quotes it - and those two are
 * allowed to differ. Requiring every matching record to agree would fail on correct behaviour. The
 * weaker predicate admits no false pass: when a mention is filed as a plain message, NO record
 * carrying its marker is on `canari_mentions`. Every channel seen is recorded either way.
 */
import {
  APP_TAB,
  client,
  ensureChat,
  fireComposer,
  mentionInComposer,
  openChannel,
  openConversation,
  send,
} from '../chat.mjs';
import { gate, logcatSince, report, watch } from '../watch.mjs';
import { mark, record, exitOnRecorded } from '../results.mjs';
import * as phone from '../phone.mjs';
import { requireFreshFcmLink } from '../fcmlink.mjs';
import { ignoringStrandedMentions } from '../stranded.mjs';
import { PORTS, VENUE, peerNameFor } from '../names.mjs';

// THE PHONE THIS ROW DRIVES, NAMED IN THE FILE - `useDevice` in `phone.mjs`, asserted by
// `make test-harness`. Binding it in the shell would let the row drive one handset and record a
// verdict against another's name.
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

const CHANNEL_MESSAGES = 'canari_messages';
const CHANNEL_MENTIONS = 'canari_mentions';

/**
 * Which of the two builders produced a notification in this window. READ, never assumed.
 *
 * `CanariFCM: showNotification` is the Kotlin push builder announcing itself; its absence, with a
 * notification nonetheless on screen, means the WebSocket path's plugin built it. Recording it is
 * the point of the row: the channel a message lands on is a fact about the path that carried it.
 */
async function builderSince(sinceMs) {
  const lines = await logcatSince(sinceMs).catch(() => []);
  return lines.some((l) => /CanariFCM: showNotification/.test(l)) ? 'push' : 'websocket';
}

/**
 * Send one message and read WHERE the OS filed the notification it produced.
 *
 * Every record carrying the marker is collected, not the first - see the header: a child and its
 * group summary may both quote it, and those two are allowed to differ.
 *
 * @param {() => Promise<unknown>} sendIt the gesture that puts the message on the wire
 * @param {string} marker the unique token to find the notification by
 * @param {string} expected the channel this message is required to land on
 */
async function fileAt(sendIt, marker, expected) {
  const sentAt = Date.now();
  await sendIt();
  const inMs = await phone.awaitNotification(marker, 60_000).catch(() => null);
  const hits = phone.notifications().filter((n) => n.full.includes(marker));
  const channels = [...new Set(hits.map((n) => n.channel))];
  return {
    inMs,
    expected,
    channels,
    filedAsExpected: channels.includes(expected),
    records: hits.length,
    builtBy: await builderSince(sentAt),
    drawn: hits.length > 0 ? hits.every((n) => phone.bodyIsDrawn(n)) : null,
  };
}

const a1 = await withDeadline(client(PORTS.A1, 'tauri.localhost'), 60_000, 'A1 attach');
// ANNOUNCED, NOT SWALLOWED. W2's equivalent on the next line is allowed to throw; A1's was silent,
// so a phone that never reached the chat surface produced a run indistinguishable from one that did.
await withDeadline(ensureChat(a1), 60_000, 'A1 ensureChat').catch((e) =>
  stage(`A1 ensureChat FAILED - ${e?.message || e}`)
);
const w2 = await withDeadline(client(PORTS.W2, APP_TAB), 60_000, 'W2 attach');
await withDeadline(ensureChat(w2), 60_000, 'W2 ensureChat');

// BOTH TRANSPORTS ARE USED BY CONSTRUCTION HERE, so the push one is renewed. A link that is
// ESTABLISHED and dead would lose the salon half only and record a product verdict about a channel
// choice Google never delivered.
const fcmLink = await requireFreshFcmLink('NOTIF-16', stage);

const oW2 = await watch(w2, 'notif16-w2');
const out = {
  fcmLinkMs: fcmLink?.tookMs ?? null,
  venue: { community: VENUE.community, channel: VENUE.channel },
  // THE POLICY AS THE DEVICE HOLDS IT, so the verdict can be read without the phone in hand. Both
  // message channels are IMPORTANCE_HIGH, and neither bypasses DND until the user grants it.
  channelPolicy: null,
};
const unmet = [];

/** A1's own display name, from the out-of-tree account file - never a literal in a public repo. */
const mentionTarget = peerNameFor('W2');

/** Mention A1 in whatever composer is open, then append the marker and fire. */
const mentionThen = (text) => async () => {
  await mentionInComposer(w2, mentionTarget.split(' ')[0], { expectName: mentionTarget });
  await w2.send('Input.insertText', { text: ` ${text}` });
  await fireComposer(w2);
};

try {
  // THE CHANNELS AS DECLARED, read once. The dump prints each channel the app created with the
  // importance the SYSTEM settled on - the only place the difference between "requested" and
  // "granted" is visible.
  // DEDUPLICATED: the dump prints a channel once per record that cites it, so the same channel
  // appears several times and a plain list would read as though the app had declared duplicates.
  const dump = phone.sh('dumpsys notification');
  const seen = [
    ...dump.matchAll(/NotificationChannel\{mId='(canari_\w+)'[^}]*?mImportance=(-?\d+), mBypassDnd=(\w+)/g),
  ].map((m) => `${m[1]}:imp${m[2]}${m[3] === 'true' ? ':bypassesDnd' : ''}`);
  out.channelPolicy = [...new Set(seen)].sort().join(' ');

  stage('W2 opens the direct conversation');
  await withDeadline(openConversation(w2, peerNameFor('W2')), 90_000, 'W2 openConversation');

  stage('backgrounding the phone with HOME - the app must stay ALIVE');
  phone.home();
  await sleep(3_000);

  // -- THE DIRECT CONVERSATION: plain, then mention -------------------------------------------
  const dmPlain = mark('N16DMP');
  stage(`DM, plain: ${dmPlain}`);
  out.dmPlain = await fileAt(
    () => send(w2, `${dmPlain} a plain direct message`),
    dmPlain,
    CHANNEL_MESSAGES
  );
  stage(`  -> ${out.dmPlain.channels.join(',') || 'nothing'} via ${out.dmPlain.builtBy}`);

  const dmMention = mark('N16DMM');
  stage(`DM, mention: ${dmMention}`);
  out.dmMention = await fileAt(
    mentionThen(`${dmMention} a direct message naming you`),
    dmMention,
    CHANNEL_MENTIONS
  ).catch((e) => ({ skipped: `the DM composer would not mention: ${String(e).slice(0, 160)}` }));
  stage(`  -> ${out.dmMention.channels?.join(',') ?? out.dmMention.skipped}`);

  // -- THE SALON: plain, then mention ---------------------------------------------------------
  stage(`W2 opens ${VENUE.community} / ${VENUE.channel}`);
  const opened = await withDeadline(
    openChannel(w2, VENUE.community, VENUE.channel),
    120_000,
    'W2 openChannel'
  ).catch((e) => ({ ok: false, why: String(e).slice(0, 160) }));

  if (opened && opened.ok === false) {
    // AN UNBUILT HALF, NOT A FAILING ONE - a venue the rig could not open is a precondition this
    // check did not establish, and calling it a product defect would be the row accusing the
    // product for the rig's own setup.
    out.salonPlain = { skipped: `the venue would not open: ${opened.why}` };
    out.salonMention = { skipped: `the venue would not open: ${opened.why}` };
  } else {
    const chPlain = mark('N16CHP');
    stage(`salon, plain: ${chPlain}`);
    out.salonPlain = await fileAt(
      () => send(w2, `${chPlain} a plain salon message`),
      chPlain,
      CHANNEL_MESSAGES
    );
    stage(`  -> ${out.salonPlain.channels.join(',') || 'nothing'} via ${out.salonPlain.builtBy}`);

    const chMention = mark('N16CHM');
    stage(`salon, mention: ${chMention}`);
    out.salonMention = await fileAt(
      mentionThen(`${chMention} a salon message naming you`),
      chMention,
      CHANNEL_MENTIONS
    ).catch((e) => ({
      skipped: `the salon composer would not mention: ${String(e).slice(0, 160)}`,
    }));
    stage(`  -> ${out.salonMention.channels?.join(',') ?? out.salonMention.skipped}`);
  }

  // -- THE VERDICT ----------------------------------------------------------------------------
  // A half that never notified is NOT a filing defect and must not be reported as one; it is the
  // failure NOTIF-1b and NOTIF-7 exist for, and naming it separately keeps this row's FAIL meaning
  // what its title says.
  for (const [name, half] of Object.entries({
    dmPlain: out.dmPlain,
    dmMention: out.dmMention,
    salonPlain: out.salonPlain,
    salonMention: out.salonMention,
  })) {
    if (!half || half.skipped) continue;
    if (half.inMs === null) unmet.push(`${name}NeverNotified`);
    else if (!half.filedAsExpected) unmet.push(`${name}IsNotFiledOn_${half.expected}`);
  }
} finally {
  stage('bringing the phone back to the foreground');
  phone.launch();
}

// The venue's dead mention chips are forgiven and only those - see `stranded.mjs`; it is an
// ALLOWLIST of ids and never the 64-hex shape, because forgiving the shape would forgive a 404 on
// a real member's profile, which is a defect this campaign exists to catch.
const gated = gate(unmet.length > 0 ? 'FAIL' : 'PASS', {
  W2: ignoringStrandedMentions(await report(oW2)),
});
record('NOTIF-16', gated.verdict, { ...gated.detail, ...out, unmet });

exitOnRecorded();
