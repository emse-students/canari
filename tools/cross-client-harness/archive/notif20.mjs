#!/usr/bin/env node
/**
 * NOTIF-20 - the seed travels with the message: a dead phone draws a salon message in clear on the
 * FIRST banner, with no hold and no redraw.
 *
 *   bun archive/notif20.mjs
 *
 * **THE USER'S DESIGN OF 2026-09-27 (*"la cle voyage avec le message"*), AND WHAT IT REMOVES.**
 * Until then a session's seed reached a phone on its OWN silent push, and FCM promises no order
 * between that push and the message's. NOTIF-19 passed with the message first: the banner went up
 * generic, was HELD, and was redrawn when the seed landed - two posts, and a race. Since
 * [channel-encryption](../../../docs/wiki/protocols/channel-encryption.md) section 19 every message
 * carries the MLS frame that distributed its session's seed, the phone opens it when its mirror has
 * nothing, and both pushes run on ONE lane, so the order FCM chooses decides only WHERE the seed comes
 * from, never whether the first banner is readable.
 *
 * **TWO STAGES, BECAUSE ONE CANNOT FORCE THE FRAME.** Stage A is NOTIF-19's own shape - a join while
 * the phone is dead rotates the session, so its seed is sealed one commit ahead - and it asserts the
 * user-facing invariant under whatever order FCM delivered: plaintext first, nothing held, nothing
 * redrawn, and it RECORDS the source. It cannot choose that source, so it cannot prove the frame.
 * Stage B does: the phone's seed mirror is removed (`forgetGraineMirror` - the state every iPhone is
 * in, since a silent push never wakes its extension) and the peer speaks again under the SAME
 * session. That message is not the one that minted the session, so this is also the property the
 * rule was written for: a push can be withheld (a salon at `mentions`), so the first message a phone
 * RECEIVES under a session is not always the first one sent. Its frame is still sealed ahead of the
 * phone's persisted state - the background path never writes `mls.bin` - so the catch-up is exercised
 * too. A stage-B banner drawn from anything but the frame is `SETUP-FAILED`, never a green.
 *
 * Every other precondition - the roster asserted before the kill, the FCM link freshened last, W1 and
 * W3 parked because they hold the handset's account, W3 as the new device because the rig holds two
 * accounts - is NOTIF-18's and NOTIF-19's, for their reasons; read those docblocks, not a copy here.
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

const ROW = 'NOTIF-20';
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
 * What the phone did with ONE message of the salon, read off logcat between two instants.
 *
 * The source line names the message by its index, so a stage is never credited with the other's
 * seed; the hold and the redraw are channel-wide, because either one in a stage is the defect.
 */
function readStage(lines, channelId, index) {
  const text = lines.join('\n');
  const source = new RegExp(
    `seed source=(mirror|frame) channel=${channelId} session=\\S+ index=${index}\\b`
  ).exec(text);
  return {
    source: source ? source[1] : null,
    held: new RegExp(`frame HELD .*channel=${channelId}`).test(text),
    redrawn:
      new RegExp(`seed landed while the generic banner was going up -> redrawing channel=${channelId}`).test(text) ||
      /drainPendingChannelFrames: \d+ banner\(s\) waiting on this key material -> redrawing/.test(text),
    frameCatchUp: /openSeedFrame: seed frame refused group=[0-9a-f]+ locality=LOCAL -> commit catch-up/.test(text),
    frameFailed: /openSeedFrame: (no frame on this push|frame did not yield|the frame opened and holds no seed|seed frame refused .*locality=(ABSENT|UNKNOWN))/.test(text),
  };
}

/** The banner for `marker`, drawn and in clear, or why not. */
function readBanner(marker, inMs) {
  const hit = phone.notifications().find((n) => n.full.includes(marker)) ?? null;
  return {
    inMs,
    drawn: hit ? phone.bodyIsDrawn(hit) : null,
    carriedThePlaintext: Boolean(hit),
    generic: hit ? phone.GENERIC_BODIES.some((re) => re.test(hit.body)) : null,
  };
}

const out = {};
const unmet = [];
let setupFailed = null;

const workspaceId = workspaceIdOf(VENUE.community);
if (!workspaceId) {
  record(ROW, 'SETUP-FAILED', {
    setupFailed: `no community named ${VENUE.community} - build the fixture with \`bun venue.mjs\``,
  });
  exitOnRecorded();
}

const w1 = await withDeadline(client(PORTS.W1, APP_TAB), 60_000, 'W1 attach');
const w2 = await withDeadline(client(PORTS.W2, APP_TAB), 60_000, 'W2 attach');
await withDeadline(ensureChat(w1), 60_000, 'W1 ensureChat');
await withDeadline(ensureChat(w2), 60_000, 'W2 ensureChat');

const oW1 = await watch(w1, 'notif20-w1');
const oW2 = await watch(w2, 'notif20-w2');
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

  const fcmLink = await requireFreshFcmLink(ROW, stage);
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
    out.w3Parked = await withDeadline(leaveConversation(w3), 60_000, 'W3 leaveConversation');
  } finally {
    w3.close();
  }
  if (!(out.rosterAfter.epoch > before.epoch)) {
    setupFailed = `the key group did not advance (epoch ${before.epoch} -> ${out.rosterAfter.epoch})`;
    throw new Error(setupFailed);
  }
  stage(`key group advanced: epoch ${before.epoch} -> ${out.rosterAfter.epoch}, handset still at ${before.epoch}`);

  // ── A SALON THAT DID NOT EXIST WHEN THE PHONE DIED ──────────────────────────────────────────
  const channelName = mark('n20').toLowerCase();
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
  await withDeadline(openChannel(w2, VENUE.community, channelName), 120_000, 'W2 openChannel');

  // ── STAGE A: THE SESSION'S FIRST MESSAGE, IN WHATEVER ORDER FCM DELIVERS ────────────────────
  const markerA = mark('N20A');
  out.markerA = markerA;
  stage(`stage A - W2 speaks first: ${markerA}`);
  const floorA = phone.deviceNowMs();
  const sinceA = Date.now();
  await withDeadline(send(w2, `${markerA} the first word of a session a dead phone never saw`), 120_000, 'send A');
  // WAITED ON BY THE MARKER, and that is this row's whole claim: the FIRST banner is in clear. A
  // generic banner redrawn later would also match a marker wait, which is why the log below must
  // also show no hold and no redraw.
  const inA = await phone.awaitNotification(markerA, 120_000, floorA).catch(() => null);
  lines = await logcatSince(sinceA).catch(() => []);
  out.stageA = { ...readStage(lines, channelId, 0), banner: readBanner(markerA, inA) };
  stage(`stage A: source=${out.stageA.source} held=${out.stageA.held} redrawn=${out.stageA.redrawn} inMs=${inA}`);

  // ── STAGE B: THE MIRROR GONE, A LATER MESSAGE OF THE SAME SESSION ───────────────────────────
  out.mirrorBefore = phone.graineMirrorSessions(channelId);
  out.mirrorForgotten = phone.forgetGraineMirror();
  if (!out.mirrorForgotten.removed) {
    setupFailed = `the seed mirror could not be removed: ${out.mirrorForgotten.error ?? 'still there'}`;
    throw new Error(setupFailed);
  }
  const markerB = mark('N20B');
  out.markerB = markerB;
  stage(`stage B - mirror removed, W2 speaks again under the same session: ${markerB}`);
  const floorB = phone.deviceNowMs();
  const sinceB = Date.now();
  await withDeadline(send(w2, `${markerB} a later word the phone holds no seed for`), 120_000, 'send B');
  const inB = await phone.awaitNotification(markerB, 120_000, floorB).catch(() => null);
  const linesB = await logcatSince(sinceB).catch(() => []);
  out.stageB = { ...readStage(linesB, channelId, 1), banner: readBanner(markerB, inB) };
  out.mirrorAfter = phone.graineMirrorSessions(channelId);
  stage(`stage B: source=${out.stageB.source} catchUp=${out.stageB.frameCatchUp} held=${out.stageB.held} inMs=${inB}`);

  lines = await logcatSince(killedAt).catch(() => []);
  out.builtBy = lines.some((l) => /CanariFCM: showNotification/.test(l)) ? 'push' : 'websocket';
  out.selfReadCancelled = new RegExp(`type=channel_read .*channel=${channelId}`).test(lines.join('\n'));
  out.sessions = channelSessions(channelId).length;

  // ── THE VERDICT ─────────────────────────────────────────────────────────────────────────────
  if (out.builtBy !== 'push') {
    setupFailed = 'the notification was built by the WebSocket plugin, so the app was not really dead';
  } else if (out.selfReadCancelled) {
    setupFailed = "a read receipt from the handset's own account cancelled the salon's notifications";
  } else if (out.sessions !== 1) {
    // Stage B must reuse stage A's session, or it measured a fresh mint and not a later message.
    setupFailed = `the salon carries ${out.sessions} sender sessions, so stage B did not reuse stage A's`;
  } else if (inA === null || inB === null) {
    setupFailed = `no banner in clear for stage ${inA === null ? 'A' : 'B'} within the wait`;
    // A missing plaintext banner IS the failure when a generic one did arrive - say which.
    const generic = phone.notifications().find((n) => n.full.includes(channelName));
    if (generic) {
      setupFailed = null;
      unmet.push(inA === null ? 'stageAFirstBannerWasNotInClear' : 'stageBFirstBannerWasNotInClear');
    }
  } else if (out.stageB.source !== 'frame') {
    // THE GUARD THAT KEEPS STAGE B HONEST: a mirror it could still read means the frame never ran.
    setupFailed = `stage B drew from ${out.stageB.source ?? 'nothing named'}, not from the frame`;
  }
  if (!setupFailed) {
    for (const [name, s] of [['stageA', out.stageA], ['stageB', out.stageB]]) {
      if (s.held) unmet.push(`${name}HeldTheBannerForItsSeed`);
      if (s.redrawn) unmet.push(`${name}RedrewTheBanner`);
      if (s.frameFailed) unmet.push(`${name}FramePathFailed`);
      if (s.banner.generic) unmet.push(`${name}BodyWasAGenericFallback`);
      if (s.banner.carriedThePlaintext && !s.banner.drawn) unmet.push(`${name}BodyWasBuiltButNoScreenDrewIt`);
    }
    // Sealed one commit ahead of what the phone persisted, so the frame had to be caught up.
    if (!out.stageB.frameCatchUp) unmet.push('stageBFrameWasNotCaughtUp');
    if (!(out.mirrorAfter >= 1)) unmet.push('theFrameSeedNeverReachedTheMirror');
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
  // Opening the app rebuilds the seed mirror stage B removed, from the durable store.
  stage('leaving A1 in the foreground');
  phone.launch();
}

const gated = gate(setupFailed ? 'SETUP-FAILED' : unmet.length > 0 ? 'FAIL' : 'PASS', {
  W1: await report(oW1),
  W2: await report(oW2),
  'A1-native': logcatReport(lines, 'A1'),
});
record(ROW, gated.verdict, { ...gated.detail, ...out, unmet, setupFailed });

exitOnRecorded();
