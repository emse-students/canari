#!/usr/bin/env node
/**
 * NOTIF-2 - a DM message sealed ONE COMMIT AHEAD of a dead phone: NOTIF-19's exact twin, on a DM.
 *
 *   bun archive/notif2.mjs
 *
 * **WHY THE TWIN EXISTS (user, 2026-09-27: a DM and a salon must behave the same for the person
 * reading them).** NOTIF-19 proved that a shut phone behind its community's key group catches up
 * and reads the salon. Nothing had ever asked the same question of a DM: the row said "a generic
 * fallback is CORRECT", an expectation written before the background catch-up existed, and no
 * runner had ever measured it. A generic banner on a DM, where the same phone decrypts a salon, is
 * exactly the inhomogeneity the user named - so the bar is the plaintext, as it is for NOTIF-19.
 *
 * **THE ADVANCE IS THE SAME, FOR THE SAME FORCED REASON.** Two accounts: W1, W3 and A1 are the
 * owner, W2 the peer. The peer speaks (the owner's own words never notify the owner's phone), and
 * the commit A1 must catch up on is W3 becoming a device the server has never seen
 * (`newdevice.mjs`) and entering the owner<->peer DM. Epoch before and after are READ off
 * `dm_groups.activeEpoch`, never assumed - and which member's client commits the add does not
 * matter to the row, only that the DM moved past the phone.
 *
 * **AND THE ROW PROVES THE PHONE HAD TO CATCH UP, OR IT HAS MEASURED NOTHING.** A peer whose client
 * had not processed the add would encrypt at the old epoch, the phone would decrypt without catching
 * up, and a broken catch-up would PASS. So a run with no `fetchCommitsFromBackend` line in logcat is
 * `SETUP-FAILED`, never a green - NOTIF-19's guard, unchanged.
 *
 * Every other precondition - the FCM link freshened last, W1 and W3 parked because they hold the
 * handset's account and a read from either cancels its banner - is NOTIF-18's and NOTIF-19's, for
 * their reasons; read those docblocks rather than a copy here.
 */
import { APP_TAB, client, ensureChat, leaveConversation, openDM, send } from '../chat.mjs';
import { directConversation, userIdOf } from '../grainedb.mjs';
import { becomeANewDeviceAndConfirm } from '../newdevice.mjs';
import { gate, logcatReport, logcatSince, report, watch } from '../watch.mjs';
import { exitOnRecorded, mark, record } from '../results.mjs';
import * as phone from '../phone.mjs';
import { requireFreshFcmLink } from '../fcmlink.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from '../names.mjs';

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

/** The phone's own device on a roster - the web clients are all `web-`. */
const handsetOn = (dm) => (dm?.devices ?? []).find((d) => d.deviceId.startsWith('tauri-'));

const out = {};
const unmet = [];
let setupFailed = null;

const ownerId = userIdOf(OWNER_NAME);
const peerId = userIdOf(PEER_NAME);
const before = ownerId && peerId ? directConversation(ownerId, peerId) : null;
if (!before) {
  record('NOTIF-2', 'SETUP-FAILED', {
    setupFailed: 'no single live DM between the owner and the peer - open one from W2 first',
  });
  exitOnRecorded();
}

const w1 = await withDeadline(client(PORTS.W1, APP_TAB), 60_000, 'W1 attach');
const w2 = await withDeadline(client(PORTS.W2, APP_TAB), 60_000, 'W2 attach');
await withDeadline(ensureChat(w1), 60_000, 'W1 ensureChat');
await withDeadline(ensureChat(w2), 60_000, 'W2 ensureChat');

const oW1 = await watch(w1, 'notif2-w1');
const oW2 = await watch(w2, 'notif2-w2');
let killedAt = null;
let lines = [];

try {
  // ── THE HANDSET IN THE DM, AT THE EPOCH IT DIES AT ──────────────────────────────────────────
  stage('bringing A1 up so it holds the DM at its current epoch');
  const up = await phone.ensure({ port: PORTS.A1 });
  out.phoneUp = up;
  if (!up.ok) {
    setupFailed = `the phone is not measurable: ${up.reason}`;
    throw new Error(setupFailed);
  }
  stage(`pin gate -> ${phone.unlockPin(PORTS.A1)}`);
  const a1 = await withDeadline(client(PORTS.A1, 'tauri.localhost'), 90_000, 'A1 attach');
  try {
    await withDeadline(ensureChat(a1), 90_000, 'A1 ensureChat');
    await withDeadline(openDM(a1, PEER_NAME), 120_000, 'A1 openDM');
    await withDeadline(leaveConversation(a1), 60_000, 'A1 leaveConversation');
  } finally {
    a1.close();
  }

  const atDeath = directConversation(ownerId, peerId);
  const handset = handsetOn(atDeath);
  out.rosterBefore = {
    epoch: atDeath?.epoch ?? null,
    devices: (atDeath?.devices ?? []).length,
    handsetStatus: handset?.status ?? null,
  };
  if (!handset || handset.status !== 'active') {
    setupFailed = "the phone's device is not active in the DM, so nothing was owed to it";
    throw new Error(setupFailed);
  }

  const fcmLink = await requireFreshFcmLink('NOTIF-2', stage);
  out.fcmLinkMs = fcmLink?.tookMs ?? null;

  stage('killing A1 - a LIVE app ACKs the frame and the push service never runs');
  out.death = await withDeadline(phone.killAndProveDead(), 60_000, 'killAndProveDead');
  killedAt = Date.now();

  // ── THE ADVANCE: W3 BECOMES A NEW DEVICE AND ENTERS THE DM ──────────────────────────────────
  stage('W3 becomes a device the server has never seen');
  const minted = await withDeadline(becomeANewDeviceAndConfirm({ report: stage }), 240_000, 'newdevice');
  out.w3Minted = { refused: minted.refused ?? null, enrolled: minted.enrolled ?? null };
  if (minted.refused || !minted.enrolled) {
    setupFailed = `W3 could not become a new device: ${minted.refused ?? 'not enrolled'}`;
    throw new Error(setupFailed);
  }
  minted.cx?.close?.();
  const w3 = await withDeadline(client(PORTS.W3, APP_TAB), 60_000, 'W3 attach');
  try {
    await withDeadline(ensureChat(w3), 90_000, 'W3 ensureChat');
    const known = new Set((atDeath.devices ?? []).map((d) => d.deviceId));
    let after = null;
    let opened = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      after = directConversation(ownerId, peerId);
      const joined = (after?.devices ?? []).some((d) => !known.has(d.deviceId) && d.status === 'active');
      if (joined && after.epoch > atDeath.epoch) break;
      // The DM row appears on W3 once its device is IN the group; opening it is what a person
      // would do, and it drives whichever join path the client owns.
      if (!opened) opened = await openDM(w3, PEER_NAME).then(() => true).catch(() => false);
      await new Promise((r) => setTimeout(r, 1000));
    }
    out.rosterAfter = { epoch: after?.epoch ?? null, devices: (after?.devices ?? []).length, w3Opened: opened };
    // W3 HOLDS THE HANDSET'S ACCOUNT - a read from it would cancel the banner under test.
    out.w3Parked = await withDeadline(leaveConversation(w3), 60_000, 'W3 leaveConversation');
  } finally {
    w3.close();
  }
  if (!(out.rosterAfter.epoch > atDeath.epoch)) {
    setupFailed = `the DM did not advance (epoch ${atDeath.epoch} -> ${out.rosterAfter.epoch})`;
    throw new Error(setupFailed);
  }
  stage(`DM advanced: epoch ${atDeath.epoch} -> ${out.rosterAfter.epoch}, handset still at ${atDeath.epoch}`);
  out.w1Parked = await withDeadline(leaveConversation(w1), 60_000, 'W1 leaveConversation');

  // ── THE PEER SPEAKS INTO THE DM ─────────────────────────────────────────────────────────────
  const marker = mark('N2');
  out.marker = marker;
  stage(`W2 opens the DM and speaks: ${marker}`);
  await withDeadline(openDM(w2, OWNER_NAME), 120_000, 'W2 openDM');
  const floor = phone.deviceNowMs();
  const sentAt = Date.now();
  await withDeadline(send(w2, `${marker} sealed one commit ahead of a dead phone`), 120_000, 'send');

  // Waited on by the SENDER'S NAME, never by the marker - a generic banner carries no marker, and
  // waiting on it would turn a FAIL into a timeout.
  const inMs = await phone.awaitNotification(PEER_NAME, 120_000, floor).catch(() => null);
  lines = await logcatSince(killedAt).catch(() => []);
  // EVERY GUARD BELOW READS FROM THE SEND ONWARD, and the first version of this row did not. The DM
  // predates the run, so the window since the kill holds two things that are not about this message:
  // W3's enrolment waking the dead phone for OTHER groups (each with its own catch-up, and
  // `fetchCommitsFromBackend` names no group), and a read by W3 cancelling the PREVIOUS run's banner
  // still in the shade - which graded a clean run `SETUP-FAILED` on 2026-09-27, 15 s before the send.
  const afterSend = await logcatSince(sentAt).catch(() => []);
  const dm8 = before.groupId.slice(0, 8);

  const hit = phone.notifications().find((n) => n.full.includes(PEER_NAME)) ?? null;
  out.notification = {
    inMs,
    drawn: hit ? phone.bodyIsDrawn(hit) : null,
    carriedThePlaintext: hit ? hit.full.includes(marker) : false,
    generic: hit ? phone.GENERIC_BODIES.some((re) => re.test(hit.body)) : null,
  };

  // ── THE CATCH-UP, WHICH IS THE WHOLE QUESTION ───────────────────────────────────────────────
  // The catch-up that counts is the one that follows THIS DM's refusal.
  const refusalAt = afterSend.findIndex((l) => l.includes(`tryDecrypt refused group=${dm8}`));
  const fetchLines =
    refusalAt < 0 ? [] : afterSend.slice(refusalAt).filter((l) => /fetchCommitsFromBackend:/.test(l));
  const refused = fetchLines.find((l) => /fetchCommitsFromBackend: HTTP \d+/.test(l)) ?? null;
  const served = fetchLines.find((l) => /fetchCommitsFromBackend: \d+ commit\(s\)/.test(l)) ?? null;
  out.catchUp = {
    attempted: fetchLines.length > 0,
    refusedWith: refused ? Number(/HTTP (\d+)/.exec(refused)[1]) : null,
    commitsServed: served ? Number(/: (\d+) commit\(s\)/.exec(served)[1]) : null,
  };
  out.push = {
    builtBy: lines.some((l) => /CanariFCM: showNotification/.test(l)) ? 'push' : 'websocket',
    selfReadCancelled: afterSend.some((l) =>
      l.includes(`cancelConversationNotification: notif removed group=${dm8}`)
    ),
  };
  stage(
    `catch-up: attempted=${out.catchUp.attempted} refused=${out.catchUp.refusedWith} ` +
      `served=${out.catchUp.commitsServed} | plaintext=${out.notification.carriedThePlaintext}`
  );

  // ── THE VERDICT ─────────────────────────────────────────────────────────────────────────────
  if (out.push.builtBy !== 'push') {
    setupFailed = 'the notification was built by the WebSocket plugin, so the app was not really dead';
  } else if (out.push.selfReadCancelled) {
    setupFailed = "a read from the handset's own account cancelled the DM's notification";
  } else if (!out.catchUp.attempted) {
    setupFailed = 'the phone never had to catch up - the message was not sealed ahead of it';
  } else if (inMs === null) {
    setupFailed = 'no notification from the peer reached the handset, so the shade was never measured';
  } else {
    if (out.catchUp.refusedWith !== null) unmet.push(`theCatchUpWasRefusedWith${out.catchUp.refusedWith}`);
    if (!(out.catchUp.commitsServed >= 1)) unmet.push('noCommitWasServedToTheCatchUp');
    if (!out.notification.carriedThePlaintext) unmet.push('theShadeDidNotCarryTheDecryptedText');
    if (out.notification.generic) unmet.push('theBodyWasOneOfTheGenericFallbacks');
    if (hit && !out.notification.drawn) unmet.push('theBodyWasBuiltButNoScreenDrewIt');
  }
} finally {
  if (killedAt && lines.length === 0) lines = await logcatSince(killedAt).catch(() => []);
  stage('leaving A1 in the foreground');
  phone.launch();
}

const gated = gate(setupFailed ? 'SETUP-FAILED' : unmet.length > 0 ? 'FAIL' : 'PASS', {
  W1: await report(oW1),
  W2: await report(oW2),
  'A1-native': logcatReport(lines, 'A1'),
});
record('NOTIF-2', gated.verdict, { ...gated.detail, ...out, unmet, setupFailed });

exitOnRecorded();
