#!/usr/bin/env node
/**
 * NOTIF-21 - whoever admits a newcomer Welcomes them: a phone invited to a community while it is
 * DEAD joins the key group in the background and draws the first salon message in clear.
 *
 *   bun archive/notif21.mjs
 *
 * **THE USER'S DECISION OF 2026-09-27 (*"L'ajouteur envoie un welcome"*), AND WHAT IT CLOSES.**
 * Until then a community newcomer entered the key group only by its OWN external commit, made when
 * its app loaded the community - so a shut phone took every salon push and opened none. Two Gala
 * members invited on production at 14:35 had still not joined six hours later. Since
 * [channel-encryption](../../../docs/wiki/protocols/channel-encryption.md) section 20 the admitter's
 * client adds every device the newcomer has published a KeyPackage for and Welcomes each, and the add
 * commit declares them (`admits`) so the server queues each one what it can open from that epoch.
 *
 * **WHAT THE ROW PROVES, AND BY WHICH FACT.** The phone is dead through the whole admission, so
 * nothing it does can be the door: its key-group row must go `active` while it is still dead (the
 * background Welcome, `processReceivedWelcomeBackground`), and the key group's commit log must hold
 * NO commit sent by the HANDSET - an external join is a commit its own device sends. The account's
 * two web clients are live and may join by their own commits; that is allowed, and the admitter
 * must rebuild on their epoch rather than give up. Then the first
 * message in `general` must reach the dead phone as a banner in clear.
 *
 * A FRESH COMMUNITY PER RUN, made by W2 and deleted after. The venue already holds both accounts,
 * and the rig has only two - so the only way to have a newcomer is a community that did not exist.
 * The other preconditions (the FCM link freshened last, the death proven) are NOTIF-18's, for its
 * reasons; read that docblock rather than a copy here.
 */
import { APP_TAB, client, ensureChat, openChannel, send } from '../chat.mjs';
import { evaluate } from '../cdp.mjs';
import {
  createCommunity,
  deleteCommunity,
  inPanel,
  inviteToCommunity,
  openCommunitySettings,
} from '../comm.mjs';
import { communityDistribution, groupCommits, userIdOf, workspaceIdOf } from '../grainedb.mjs';
import { gate, logcatReport, logcatSince, report, watch } from '../watch.mjs';
import { exitOnRecorded, mark, record } from '../results.mjs';
import * as phone from '../phone.mjs';
import { requireFreshFcmLink } from '../fcmlink.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from '../names.mjs';

phone.useDevice('A1');

const ROW = 'NOTIF-21';
const T0 = Date.now();
const stage = (s) => console.error(`[${String((Date.now() - T0) / 1000).padStart(6)}s] ${s}`);
const withDeadline = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_r, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    ),
  ]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = {};
const unmet = [];
let setupFailed = null;

const ownerId = userIdOf(OWNER_NAME);
const peerId = userIdOf(PEER_NAME);
if (!ownerId || !peerId) {
  record(ROW, 'SETUP-FAILED', { setupFailed: 'the two rig accounts are not both in the database' });
  exitOnRecorded();
}

const w2 = await withDeadline(client(PORTS.W2, APP_TAB), 60_000, 'W2 attach');
await withDeadline(ensureChat(w2), 60_000, 'W2 ensureChat');
const oW2 = await watch(w2, 'notif21-w2');
let killedAt = null;
let handsetDeviceId = null;
let lines = [];
let community = null;

try {
  // ── THE PHONE, UP ONCE SO ITS KEYPACKAGE AND PUSH TOKEN ARE CURRENT, THEN DEAD ──────────────
  stage('bringing A1 up so its KeyPackage and push token are current');
  const up = await phone.ensure({ port: PORTS.A1 });
  out.phoneUp = up;
  if (!up.ok) {
    setupFailed = `the phone is not measurable: ${up.reason}`;
    throw new Error(setupFailed);
  }
  stage(`pin gate -> ${phone.unlockPin(PORTS.A1)}`);
  // THE HANDSET IS THIS PHONE'S OWN DEVICE, READ OFF IT, NEVER "the first `tauri-` device of the owner":
  // since the iPhone enrolled (2026-10-01) the account holds several native devices, and the first
  // one in the roster is whichever the server lists first - a push-dead iPhone read `pending` and
  // failed the row for a join the phone had made (2026-10-05).
  const a1 = await client(PORTS.A1, 'tauri.localhost', { focus: false });
  handsetDeviceId = await evaluate(
    a1,
    `(function () { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k.indexOf('mls_device_id_') === 0) return localStorage.getItem(k); } return null; })()`
  );
  out.handsetDeviceId = handsetDeviceId ? handsetDeviceId.slice(-24) : null;
  if (!handsetDeviceId || !handsetDeviceId.startsWith('tauri-')) {
    setupFailed = 'the phone does not report a native device id';
    throw new Error(setupFailed);
  }
  const fcmLink = await requireFreshFcmLink(ROW, stage);
  out.fcmLinkMs = fcmLink?.tookMs ?? null;
  stage('killing A1 - nothing it does may be the door into the group');
  out.death = await withDeadline(phone.killAndProveDead(), 60_000, 'killAndProveDead');
  killedAt = Date.now();

  // ── A COMMUNITY THE NEWCOMER HAS NEVER BEEN IN ──────────────────────────────────────────────
  community = mark('N21');
  out.community = community;
  stage(`W2 creates ${community}`);
  await withDeadline(createCommunity(w2, community), 60_000, 'createCommunity');
  const workspaceId = workspaceIdOf(community);
  let before = null;
  for (let i = 0; i < 30 && !before; i++) {
    const dist = workspaceId ? communityDistribution(workspaceId) : null;
    if (dist && dist.devices.some((d) => d.userId === peerId && d.status === 'active')) before = dist;
    else await sleep(1000);
  }
  if (!before) {
    setupFailed = 'the new community never published a key group holding W2';
    throw new Error(setupFailed);
  }
  out.before = { epoch: before.epoch, devices: before.devices.length };

  // ── THE ADMISSION, WITH THE PHONE DEAD ──────────────────────────────────────────────────────
  stage(`W2 invites ${OWNER_NAME.slice(0, 3)}... from the members tab`);
  const invitedAt = Date.now();
  // IN A PANEL THAT IS CLOSED AFTERWARDS: the members tab is a modal, and every later gesture -
  // opening `general`, the teardown's own settings click - is aimed at the page behind it.
  out.inviteStatus = String(
    await withDeadline(
      inPanel(w2, openCommunitySettings, () => inviteToCommunity(w2, OWNER_NAME)),
      60_000,
      'invite'
    )
  ).slice(0, 160);

  // The handset's row must appear AND go active while the app is dead: only the background Welcome
  // can do that, because nothing else on a killed phone runs.
  let after = null;
  let handset = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    after = communityDistribution(workspaceId);
    handset = (after?.devices ?? []).find(
      (d) => d.userId === ownerId && d.deviceId === handsetDeviceId
    );
    if (handset?.status === 'active') break;
    await sleep(1000);
  }
  out.handset = handset ? { status: handset.status, afterMs: Date.now() - invitedAt } : null;
  out.after = {
    epoch: after?.epoch ?? null,
    ownerDevices: (after?.devices ?? []).filter((d) => d.userId === ownerId).length,
  };
  // ONLY THE HANDSET'S OWN COMMITS ACCUSE: the newcomer's two web clients are live and loading the
  // community, so an external join from either is the design working (run 3, 2026-09-28: both
  // joined in the admitter's second, and the admitter rebuilt on their epoch). The dead phone is
  // the one device that cannot act, so a commit from it would mean it was not dead.
  out.commits = groupCommits(before.groupId).map((c) => ({
    by:
      c.senderDeviceId === handset?.deviceId
        ? 'handset'
        : after?.devices?.some((d) => d.userId === ownerId && d.deviceId === c.senderDeviceId)
          ? 'newcomer-web'
          : 'admitter-or-other',
    baseEpoch: c.baseEpoch,
  }));
  stage(`handset ${handset?.status ?? 'absent'}, epoch ${before.epoch} -> ${after?.epoch}, commits ${JSON.stringify(out.commits)}`);

  // ── THE FIRST MESSAGE, TO A PHONE THAT IS STILL DEAD ────────────────────────────────────────
  const marker = mark('N21M');
  out.marker = marker;
  await withDeadline(openChannel(w2, community, 'general'), 120_000, 'W2 openChannel');
  const floor = phone.deviceNowMs();
  const sentAt = Date.now();
  stage(`W2 speaks: ${marker}`);
  await withDeadline(send(w2, `${marker} the first word to a newcomer whose phone is off`), 120_000, 'send');
  const inMs = await phone.awaitNotification(marker, 120_000, floor).catch(() => null);
  const hit = phone.notifications().find((n) => n.full.includes(marker)) ?? null;
  out.banner = {
    inMs,
    drawn: hit ? phone.bodyIsDrawn(hit) : null,
    generic: hit ? phone.GENERIC_BODIES.some((re) => re.test(hit.body)) : null,
  };
  stage(`banner inMs=${inMs} drawn=${out.banner.drawn} generic=${out.banner.generic}`);

  lines = await logcatSince(killedAt).catch(() => []);
  const text = lines.join('\n');
  out.welcomedInBackground = new RegExp(
    `processReceivedWelcomeBackground: .*group joined group=${before.groupId}`
  ).test(text);
  out.builtBy = (await logcatSince(sentAt).catch(() => [])).some((l) => /CanariFCM: showNotification/.test(l))
    ? 'push'
    : 'websocket';

  // ── THE VERDICT ─────────────────────────────────────────────────────────────────────────────
  if (out.builtBy !== 'push' && inMs !== null) {
    setupFailed = 'the notification was built by the WebSocket plugin, so the app was not really dead';
  } else {
    if (!handset) unmet.push('theHandsetWasNeverAdded');
    else if (handset.status !== 'active') unmet.push('theHandsetNeverJoinedWhileDead');
    if (!out.welcomedInBackground) unmet.push('noBackgroundWelcomeForTheKeyGroup');
    if (out.commits.some((c) => c.by === 'handset')) unmet.push('theDeadHandsetMadeACommit');
    if (!(after?.epoch > before.epoch)) unmet.push('theKeyGroupNeverAdvanced');
    if (inMs === null) unmet.push('noBannerInClear');
    if (out.banner.generic) unmet.push('bannerWasAGenericFallback');
    if (hit && !out.banner.drawn) unmet.push('bannerWasBuiltButNoScreenDrewIt');
  }
} catch (e) {
  // A THROWN GESTURE IS A RESULT TOO: without this the run exits recording nothing, and the board
  // cannot tell a row that was not run from one whose setup broke.
  setupFailed ??= `the row threw before its verdict: ${String(e).slice(0, 200)}`;
} finally {
  if (community) {
    const swept = await deleteCommunity(w2, community)
      .then(() => 'deleted')
      .catch((e) => `failed: ${String(e).slice(0, 120)}`);
    stage(`teardown: ${community} -> ${swept}`);
  }
  if (killedAt && lines.length === 0) lines = await logcatSince(killedAt).catch(() => []);
  stage('leaving A1 in the foreground');
  phone.launch();
}

const gated = gate(setupFailed ? 'SETUP-FAILED' : unmet.length > 0 ? 'FAIL' : 'PASS', {
  W2: await report(oW2),
  'A1-native': logcatReport(lines, 'A1'),
});
record(ROW, gated.verdict, { ...gated.detail, ...out, unmet, setupFailed });

exitOnRecorded();
