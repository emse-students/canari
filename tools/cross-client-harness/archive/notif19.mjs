#!/usr/bin/env node
/**
 * NOTIF-19 - a salon message whose seed was sealed ONE COMMIT AHEAD of a dead phone.
 *
 *   bun archive/notif19.mjs
 *
 * **THE USER'S REPORT OF 2026-09-27, AND THE DEFECT NOTIF-18 COULD NOT REACH.** A Pixel 6a showed
 * `Nouveau message dans #general` for community after community. Its logcat said why: the seed frame
 * was sealed at an epoch the phone did not hold yet, the background catch-up
 * (`POST /api/mls/push/commits`) answered 403, and nothing ever redrew the banner - 173 refusals to
 * one success in eight hours on production. `getCommitsSince` gated on `dm_group_members`, which a
 * key-distribution group never populates, so ANY newcomer to a community left every shut phone blind
 * until the app was reopened ([channel-encryption](../../../docs/wiki/protocols/channel-encryption.md)
 * section 16). NOTIF-18 never met it: its phone died at the roster's current epoch and nothing moved.
 *
 * **THE ADVANCE IS A NEW DEVICE, NOT A NEW ACCOUNT, AND THAT IS FORCED.** The rig holds two accounts:
 * W1, W3 and A1 are the owner, W2 the peer. So the peer speaks (the owner's own words never notify
 * the owner's phone), and the commit A1 must catch up on is W3 becoming a device the server has
 * never seen (`newdevice.mjs`) and joining the community's key group by external commit when it
 * loads the venue. Epoch before and after are READ, never assumed.
 *
 * **A SESSION MINTED AFTER THE ADVANCE, BY CONSTRUCTION.** Exactly NOTIF-18's argument: a salon
 * created after the kill has no session, so the peer's first send mints one and seals its seed at the
 * group's CURRENT epoch - one ahead of the phone.
 *
 * **AND THE ROW PROVES THE PHONE HAD TO CATCH UP, OR IT HAS MEASURED NOTHING.** A sender whose own
 * client had not yet processed W3's commit would seal at the old epoch, the phone would open it
 * without catching up, and a broken catch-up would PASS. So a run with no `fetchCommitsFromBackend`
 * line in logcat is `SETUP-FAILED`, never a green.
 *
 * Every other precondition - the roster asserted before the kill, the FCM link freshened last, W1
 * parked because it holds the handset's account, the salon swept - is NOTIF-18's, for NOTIF-18's
 * reasons; read that file's docblock rather than a copy here.
 */
import { APP_TAB, client, ensureChat, leaveConversation, openChannel, send } from '../chat.mjs';
import { createChannel, deleteChannel, enterCommunities, openCommunity } from '../comm.mjs';
import { channelIdOf, channelSessions, communityDistribution, workspaceIdOf } from '../grainedb.mjs';
import { becomeANewDeviceAndConfirm } from '../newdevice.mjs';
import { gate, logcatReport, logcatSince, report, watch } from '../watch.mjs';
import { exitOnRecorded, mark, record } from '../results.mjs';
import * as phone from '../phone.mjs';
import { requireFreshFcmLink } from '../fcmlink.mjs';
import { PORTS, VENUE } from '../names.mjs';

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
const firstAt = (lines, re) => lines.findIndex((l) => re.test(l));

const out = {};
const unmet = [];
let setupFailed = null;

const workspaceId = workspaceIdOf(VENUE.community);
if (!workspaceId) {
  record('NOTIF-19', 'SETUP-FAILED', {
    setupFailed: `no community named ${VENUE.community} - build the fixture with \`bun venue.mjs\``,
  });
  exitOnRecorded();
}

const w1 = await withDeadline(client(PORTS.W1, APP_TAB), 60_000, 'W1 attach');
const w2 = await withDeadline(client(PORTS.W2, APP_TAB), 60_000, 'W2 attach');
await withDeadline(ensureChat(w1), 60_000, 'W1 ensureChat');
await withDeadline(ensureChat(w2), 60_000, 'W2 ensureChat');

const oW1 = await watch(w1, 'notif19-w1');
const oW2 = await watch(w2, 'notif19-w2');
let killedAt = null;
let lines = [];

try {
  // ── THE HANDSET ON THE ROSTER, AT THE EPOCH IT DIES AT ──────────────────────────────────────
  stage('bringing A1 up so it holds the community key group at its current epoch');
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
    await withDeadline(openChannel(a1), 120_000, 'A1 openChannel');
  } finally {
    a1.close();
  }

  const before = communityDistribution(workspaceId);
  const handset = handsetOn(before);
  out.rosterBefore = {
    epoch: before?.epoch ?? null,
    devices: (before?.devices ?? []).length,
    handsetStatus: handset?.status ?? null,
  };
  if (!handset || handset.status !== 'active') {
    setupFailed = "the phone's device is not active on the community's key group, so nothing was owed to it";
    throw new Error(setupFailed);
  }

  const fcmLink = await requireFreshFcmLink('NOTIF-19', stage);
  out.fcmLinkMs = fcmLink?.tookMs ?? null;

  stage('killing A1 - a LIVE app ACKs the frame and the push service never runs');
  out.death = await withDeadline(phone.killAndProveDead(), 60_000, 'killAndProveDead');
  killedAt = Date.now();

  // ── THE ADVANCE: W3 BECOMES A NEW DEVICE AND JOINS THE KEY GROUP ────────────────────────────
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
    await withDeadline(enterCommunities(w3), 60_000, 'W3 enterCommunities');
    await withDeadline(openCommunity(w3, VENUE.community), 60_000, 'W3 openCommunity');
    const known = new Set((before.devices ?? []).map((d) => d.deviceId));
    let after = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      after = communityDistribution(workspaceId);
      const joined = (after?.devices ?? []).some((d) => !known.has(d.deviceId) && d.status === 'active');
      if (joined && after.epoch > before.epoch) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    out.rosterAfter = { epoch: after?.epoch ?? null, devices: (after?.devices ?? []).length };
    // W3 HOLDS THE HANDSET'S ACCOUNT TOO - parked for the same reason W1 is below.
    out.w3Parked = await withDeadline(leaveConversation(w3), 60_000, 'W3 leaveConversation');
  } finally {
    w3.close();
  }
  if (!(out.rosterAfter.epoch > before.epoch)) {
    setupFailed = `the key group did not advance (epoch ${before.epoch} -> ${out.rosterAfter.epoch})`;
    throw new Error(setupFailed);
  }
  stage(`key group advanced: epoch ${before.epoch} -> ${out.rosterAfter.epoch}, handset still at ${before.epoch}`);

  // ── A SALON THAT DID NOT EXIST WHEN THE PHONE DIED, AND THE PEER'S FIRST WORD IN IT ─────────
  const channelName = mark('n19').toLowerCase();
  out.channel = channelName;
  stage(`W1 creates the salon ${channelName}`);
  await withDeadline(enterCommunities(w1), 60_000, 'W1 enterCommunities');
  await withDeadline(openCommunity(w1, VENUE.community), 60_000, 'W1 openCommunity');
  await withDeadline(createChannel(w1, channelName), 120_000, 'createChannel');
  out.w1Parked = await withDeadline(leaveConversation(w1), 60_000, 'W1 leaveConversation');

  const channelId = channelIdOf(workspaceId, channelName);
  if (!channelId) {
    setupFailed = `the salon ${channelName} is not in the database after the create gesture`;
    throw new Error(setupFailed);
  }

  const marker = mark('N19');
  out.marker = marker;
  stage(`W2 opens it and speaks: ${marker}`);
  await withDeadline(openChannel(w2, VENUE.community, channelName), 120_000, 'W2 openChannel');
  const floor = phone.deviceNowMs();
  await withDeadline(send(w2, `${marker} sealed one commit ahead of a dead phone`), 120_000, 'send');

  // Waited on by the SALON, never by the marker - NOTIF-18's first trap.
  const inMs = await phone.awaitNotification(channelName, 120_000, floor).catch(() => null);
  lines = await logcatSince(killedAt).catch(() => []);
  const heldAt = firstAt(lines, new RegExp(`seed absent -> generic banner, frame HELD .*channel=${channelId}`));
  let redrawMs = null;
  if (heldAt >= 0) {
    stage('the handset held this frame for its key material - waiting for the redraw it promised');
    redrawMs = await phone.awaitNotification(marker, 60_000, floor).catch(() => null);
  }
  lines = await logcatSince(killedAt).catch(() => []);

  const hit = phone.notifications().find((n) => n.full.includes(channelName)) ?? null;
  out.notification = {
    inMs,
    redrawMs,
    drawn: hit ? phone.bodyIsDrawn(hit) : null,
    carriedThePlaintext: hit ? hit.full.includes(marker) : false,
    generic: hit ? phone.GENERIC_BODIES.some((re) => re.test(hit.body)) : null,
  };

  // ── THE CATCH-UP, WHICH IS THE WHOLE QUESTION ───────────────────────────────────────────────
  const fetchLines = lines.filter((l) => /fetchCommitsFromBackend:/.test(l));
  const refused = fetchLines.find((l) => /fetchCommitsFromBackend: HTTP \d+/.test(l)) ?? null;
  const served = fetchLines.find((l) => /fetchCommitsFromBackend: \d+ commit\(s\)/.test(l)) ?? null;
  out.catchUp = {
    attempted: fetchLines.length > 0,
    refusedWith: refused ? Number(/HTTP (\d+)/.exec(refused)[1]) : null,
    commitsServed: served ? Number(/: (\d+) commit\(s\)/.exec(served)[1]) : null,
  };
  out.push = {
    builtBy: lines.some((l) => /CanariFCM: showNotification/.test(l)) ? 'push' : 'websocket',
    seedsStored: Number(/stored (\d+) seed\(s\)/.exec(lines.find((l) => /absorbGraineSeeds: stored/.test(l)) ?? '')?.[1] ?? 0),
    heldForItsKeyMaterial: heldAt >= 0,
    selfReadCancelled: new RegExp(`type=channel_read .*channel=${channelId}`).test(lines.join('\n')),
  };
  out.sessions = channelSessions(channelId).length;
  stage(
    `catch-up: attempted=${out.catchUp.attempted} refused=${out.catchUp.refusedWith} ` +
      `served=${out.catchUp.commitsServed} | seeds=${out.push.seedsStored} ` +
      `plaintext=${out.notification.carriedThePlaintext}`
  );

  // ── THE VERDICT ─────────────────────────────────────────────────────────────────────────────
  if (out.push.builtBy !== 'push') {
    setupFailed = 'the notification was built by the WebSocket plugin, so the app was not really dead';
  } else if (out.push.selfReadCancelled) {
    setupFailed = "a read receipt from the handset's own account cancelled the salon's notifications";
  } else if (out.sessions !== 1) {
    setupFailed = `the salon carries ${out.sessions} sender sessions, so the row cannot say which seed it measured`;
  } else if (!out.catchUp.attempted) {
    // THE GUARD THAT KEEPS A BROKEN CATCH-UP FROM PASSING: the seed was sealed at an epoch the phone
    // already held, so the path under test never ran.
    setupFailed = 'the phone never had to catch up - the seed was not sealed ahead of it';
  } else if (inMs === null) {
    setupFailed = 'no notification for this salon reached the handset, so the shade was never measured';
  } else {
    if (out.catchUp.refusedWith !== null) unmet.push(`theCatchUpWasRefusedWith${out.catchUp.refusedWith}`);
    if (!(out.catchUp.commitsServed >= 1)) unmet.push('noCommitWasServedToTheCatchUp');
    if (out.push.seedsStored < 1) unmet.push('noSeedReachedTheNativeMirror');
    if (!out.notification.carriedThePlaintext) unmet.push('theShadeDidNotCarryTheDecryptedText');
    if (out.notification.generic) unmet.push('theBodyWasOneOfTheGenericFallbacks');
    if (hit && !out.notification.drawn) unmet.push('theBodyWasBuiltButNoScreenDrewIt');
  }
} finally {
  if (out.channel) {
    const swept = await openChannel(w1, VENUE.community, out.channel)
      .then(() => deleteChannel(w1))
      .then(() => 'deleted')
      .catch((e) => `failed: ${String(e).slice(0, 120)}`);
    stage(`teardown: ${out.channel} -> ${swept}`);
  }
  if (killedAt && lines.length === 0) lines = await logcatSince(killedAt).catch(() => []);
  stage('leaving A1 in the foreground');
  phone.launch();
}

const gated = gate(setupFailed ? 'SETUP-FAILED' : unmet.length > 0 ? 'FAIL' : 'PASS', {
  W1: await report(oW1),
  W2: await report(oW2),
  'A1-native': logcatReport(lines, 'A1'),
});
record('NOTIF-19', gated.verdict, { ...gated.detail, ...out, unmet, setupFailed });

exitOnRecorded();
