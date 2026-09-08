#!/usr/bin/env node
/**
 * NOTIF-14 - the TITLE names its conversation: a DM says WHO, a salon says WHERE.
 *
 *   bun archive/notif14.mjs
 *
 * **WHY A TITLE IS WORTH A ROW OF ITS OWN.** It is the only part of a notification a person reads
 * before deciding whether to open it, and on a locked phone it is often the only part visible at
 * all. A body that is right under a title that says `2bd5add9-2a1b-...` is a notification nobody can
 * triage, and every other NOTIF row would still pass: they assert that the message ARRIVED and that
 * its text is carried, never what it is filed under.
 *
 * **TWO SHAPES, AND THEY ARE DIFFERENT QUESTIONS.** A direct message must be titled with the
 * SENDER's resolved display name - there is no other conversation to name. A salon message must
 * name the PLACE, community and channel, because the sender is one of many and the community is
 * what makes the message make sense. So the row measures both and reports them separately; a pass
 * on one says nothing about the other.
 *
 * **THE EXPECTED TITLE IS NEVER WRITTEN DOWN HERE, AND THAT IS TWO RULES AT ONCE.** This repository
 * is PUBLIC and no display name may enter a committed file, so the DM's expected value comes from
 * `peerNameFor` in the out-of-tree `names.mjs`, exactly as every other runner gets it. And it is the
 * stronger check anyway: the assertion is that TWO independent renderings of one fact agree - what
 * the notification says, and what the account file says the peer is called - rather than that a
 * string matches a literal somebody typed once.
 *
 * **AND IT RECORDS WHICH BUILDER FIRED, because the app has two and they do not agree.** A message
 * arriving over the WebSocket is notified by `tauri-plugin-notification`; one arriving as a push is
 * built by `CanariFirebaseMessagingService` in Kotlin. They differ in icon, channel, style and tap
 * behaviour ([backlog](../../docs/wiki/backlog.md)), so a title measured without saying which one
 * produced it is a measurement of whichever path the socket happened to be in. A backgrounded phone
 * usually gets the Kotlin one here - the socket drops behind HOME on this handset - so the run reads
 * logcat for `CanariFCM: showNotification` and names the builder in the record rather than assuming.
 *
 * **WHAT IT REFUSES TO CONCLUDE.** A title that is merely non-empty is not a pass: an id, a slug or
 * a raw uuid are all non-empty and all useless to a reader. The DM half therefore requires equality
 * with the resolved name AND that the title is not a uuid; the salon half requires BOTH names to be
 * present, because a title carrying only the channel (`general`) names no community and one carrying
 * only the community does not say which room.
 */
import { APP_TAB, client, ensureChat, openChannel, openConversation, send } from '../chat.mjs';
import { gate, logcatSince, report, watch } from '../watch.mjs';
import { mark, record, exitOnRecorded } from '../results.mjs';
import * as phone from '../phone.mjs';
import { requireFreshFcmLink } from '../fcmlink.mjs';
import { ignoringStrandedMentions } from '../stranded.mjs';
import { PORTS, VENUE, peerNameFor } from '../names.mjs';

// THE PHONE THIS ROW DRIVES, NAMED IN THE FILE. Binding it in the shell instead would let the row
// drive one handset and record a verdict against another's name; `useDevice` in `phone.mjs`. A row
// that ever needs A2 changes this line, deliberately. `make test-harness` asserts it is here.
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

/** A raw uuid is a non-empty title and a useless one - the thing this row exists to forbid. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The notification carrying `needle`, waited for and then READ - not merely counted.
 *
 * `awaitNotification` answers "did one arrive"; this row's question is what is written on it, so the
 * record has to be fetched from the same dump afterwards. Returned whole so the verdict can quote it.
 */
async function titledNotification(needle, timeoutMs = 60_000) {
  const inMs = await phone.awaitNotification(needle, timeoutMs).catch(() => null);
  const hit = phone.notifications().find((n) => n.full.includes(needle)) ?? null;
  return {
    inMs,
    title: hit?.title ?? null,
    body: hit?.body ?? null,
    drawn: hit ? phone.bodyIsDrawn(hit) : null,
  };
}

/**
 * Which of the two builders produced the notification in this window. READ, never assumed.
 *
 * `CanariFCM: showNotification` is the Kotlin push builder announcing itself; its absence, with a
 * notification nonetheless on screen, means the WebSocket path's plugin built it. The distinction is
 * the whole reason this row records a builder at all - the two disagree about icon, channel, style
 * and tap, so a title is only a fact about the path that produced it.
 */
async function builderSince(sinceMs) {
  const lines = await logcatSince(sinceMs).catch(() => []);
  return lines.some((l) => /CanariFCM: showNotification/.test(l))
    ? 'CanariFirebaseMessagingService (push)'
    : 'tauri-plugin-notification (WebSocket)';
}

const a1 = await withDeadline(client(PORTS.A1, 'tauri.localhost'), 60_000, 'A1 attach');
await withDeadline(ensureChat(a1), 60_000, 'A1 ensureChat').catch(() => null);
const w2 = await withDeadline(client(PORTS.W2, APP_TAB), 60_000, 'W2 attach');
await withDeadline(ensureChat(w2), 60_000, 'W2 ensureChat');

/**
 * THIS ROW USES BOTH TRANSPORTS, SO IT RENEWS THE PUSH ONE - which NOTIF-1b deliberately does not.
 *
 * 1b is delivered over the WebSocket by construction and a gate on a transport it does not use would
 * abort it over an unrelated fault. This row is the opposite case and the run of 2026-09-08 is why it
 * is not a guess: its DM half was built by the WebSocket plugin and its salon half by the Kotlin push
 * service, four seconds apart. A link that is ESTABLISHED and dead would therefore lose the salon
 * half only, and record a product verdict about a message that never left Google.
 */
const fcmLink = await requireFreshFcmLink('NOTIF-14', stage);

const oW2 = await watch(w2, 'notif14-w2');
const out = {
  fcmLinkMs: fcmLink?.tookMs ?? null,
  venue: { community: VENUE.community, channel: VENUE.channel },
};
const unmet = [];

try {
  // ── THE DM HALF ────────────────────────────────────────────────────────────────────────────
  stage('W2 opens the direct conversation');
  await withDeadline(openConversation(w2, peerNameFor('W2')), 90_000, 'W2 openConversation');

  stage('backgrounding the phone with HOME - the app must stay ALIVE');
  phone.home();
  await sleep(3_000);

  const dmMark = mark('NOTIF14DM');
  stage(`sending the DM marker ${dmMark}`);
  const dmSentAt = Date.now();
  await send(w2, `${dmMark} a direct message, whose title must name its sender`);
  const dm = await titledNotification(dmMark);
  out.dm = {
    ...dm,
    builtBy: await builderSince(dmSentAt),
    expected: '<peerNameFor(A1), from the out-of-tree names.mjs>',
  };
  stage(`DM notification in ${dm.inMs}ms, title=${JSON.stringify(dm.title)}`);

  const expectedDm = peerNameFor('A1');
  if (dm.inMs === null) unmet.push('theDirectMessageNeverNotified');
  else {
    // EQUALITY WITH WHAT THE ACCOUNT FILE SAYS, not "contains something name-like": two independent
    // renderings of one fact agreeing is the assertion, and a substring match would accept a title
    // that also carried an id.
    if (dm.title !== expectedDm) unmet.push('theDirectMessageTitleIsNotTheSendersResolvedName');
    if (dm.title && UUID.test(dm.title)) unmet.push('theDirectMessageTitleCarriesARawUuid');
  }
  // RECORDED WHATEVER THE VERDICT, and matched rather than quoted: printing the title would put a
  // display name in the ledger, which this campaign keeps out of committed files.
  out.dm.matchedTheResolvedName = dm.title === expectedDm;
  out.dm.title =
    dm.title === expectedDm
      ? '<the resolved peer name>'
      : `<UNEXPECTED, ${String(dm.title).length} chars>`;

  // ── THE SALON HALF ─────────────────────────────────────────────────────────────────────────
  stage(`W2 opens ${VENUE.community} / ${VENUE.channel}`);
  const opened = await withDeadline(
    openChannel(w2, VENUE.community, VENUE.channel),
    120_000,
    'W2 openChannel'
  ).catch((e) => ({ ok: false, why: String(e).slice(0, 160) }));

  if (opened && opened.ok === false) {
    // NOT A FAILING HALF - AN UNBUILT ONE. A venue the rig could not open is a precondition this
    // check did not establish, and reporting it as a product defect would be the row accusing the
    // product for the rig's own setup.
    out.salon = { skipped: `the venue would not open: ${opened.why}` };
  } else {
    const chMark = mark('NOTIF14CH');
    stage(`sending the salon marker ${chMark}`);
    const chSentAt = Date.now();
    await send(w2, `${chMark} a salon message, whose title must name where it was said`);
    const ch = await titledNotification(chMark);
    out.salon = { ...ch, builtBy: await builderSince(chSentAt) };
    stage(`salon notification in ${ch.inMs}ms, title=${JSON.stringify(ch.title)}`);

    if (ch.inMs === null) {
      // Read with the 2026-09-05 P2 - a COMMUNITY message is not decrypted in a background
      // notification - which is a different defect reached from the same gesture.
      unmet.push('theSalonMessageNeverNotified');
    } else {
      const t = String(ch.title);
      out.salon.namesTheCommunity = t.includes(VENUE.community);
      out.salon.namesTheChannel = t.includes(VENUE.channel);
      if (!out.salon.namesTheCommunity) unmet.push('theSalonTitleDoesNotNameItsCommunity');
      if (!out.salon.namesTheChannel) unmet.push('theSalonTitleDoesNotNameItsChannel');
      if (UUID.test(t)) unmet.push('theSalonTitleCarriesARawUuid');
    }
  }
} finally {
  stage('bringing the phone back to the foreground');
  phone.launch();
}

// THE VENUE'S DEAD MENTIONS ARE FORGIVEN, AND ONLY THOSE. Opening the salon re-renders chips left
// by MENTION-5 for accounts that do not exist, so W2 collects a `/api/users/<id> -> 404` this row
// has no opinion about - the cost `stranded.mjs` exists to carry, since it is paid by every row
// that so much as opens that channel. It is an ALLOWLIST of ids and never the 64-hex SHAPE, because
// forgiving the shape would forgive a 404 on a real member's profile, which is a defect the
// campaign exists to catch. Both ids seen on 2026-09-08 were already on the list, which is the
// property that list claims: it can only shrink.
const gated = gate(unmet.length > 0 ? 'FAIL' : 'PASS', {
  W2: ignoringStrandedMentions(await report(oW2)),
});
record('NOTIF-14', gated.verdict, { ...gated.detail, ...out, unmet });

exitOnRecorded();
