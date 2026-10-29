/**
 * KICK-COMMIT, SALON-REVOKE-COMMIT, DEVREVOKE-KEYGROUP - a removal is COMMITTED, not only unrouted.
 *
 *   bun run.mjs --file removals.mjs --row KICK-COMMIT           (W1 W2)
 *   bun run.mjs --file removals.mjs --row SALON-REVOKE-COMMIT   (W1 W2)
 *   bun run.mjs --file removals.mjs --row DEVREVOKE-KEYGROUP    (W1 W6, and W3 minted as a new owner device)
 *
 * THROUGH `run.mjs`, ALWAYS: its preflight brings each seat the row names (`REMOVAL_ROWS` `devices`)
 * to a known starting point and stamps the build; a bare `bun archive/removals.mjs` skips both.
 *
 * The table and the judge are `removalrows.mjs`. Every row builds its own community, routes its
 * subject onto the row's key groups (asserted on the delivery roster, so an unarmed row is VACUOUS
 * and not a PASS), reads each group's server epoch, makes ONE gesture, and then reads every group's
 * epoch once a round for `COMMIT_ROUNDS` rounds. The commit log names who moved each one.
 *
 * NOTHING HERE RELOADS THE ACTOR. A kick and a salon revoke are judged on the actor's session as it
 * is: `performance.timeOrigin` is read before the gesture and after the last round, and a different
 * one is a FAIL, never a rescue. DEVREVOKE-KEYGROUP drives the device panel from W6 because that
 * panel is reached by a full navigation; W1 stays loaded and is never touched during the rounds.
 *
 * IT DELETES ITS COMMUNITY. DEVREVOKE-KEYGROUP leaves W3 on a revoked device - W3 is minted fresh by
 * the row and owed a sign-in before any later W3 row, as it was before.
 */
import { spawnSync } from 'node:child_process';
import { clearOverlays, client, evaluate, realClick, send } from '../chat.mjs';
import {
  acceptInviteLink,
  channelRow,
  createChannel,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  grantChannelAccess,
  inPanel,
  inviteLink,
  openChannelAccess,
  openCommunity,
  openInviteLink,
  removeCommunityMember,
  revokeChannelAccess,
  selectedChannel,
} from '../comm.mjs';
import { dismissMintedNoticesOn } from '../devicenotice.mjs';
import { awaitCommunityRouting, awaitUserRouting, channelIdOf, communityChannels, communityDistribution, groupCommits, groupEpochAndRoster, keyGroupsOfDevice, salonDistribution, userIdOf, workspaceIdOf } from '../grainedb.mjs';
import { becomeANewDeviceAndConfirm } from '../newdevice.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from '../names.mjs';
import { COMMIT_ROUNDS, REMOVAL_ROWS, ROUND_MS, removalNarration, removalOwn } from '../removalrows.mjs';
import { exitOnRecorded, mark, record } from '../results.mjs';
import { HARNESS_ROOT, requireScript } from '../scriptpath.mjs';
import { EVICTED_REJOIN_NARRATION, PAGE_BOOT_NARRATION, gate, ignoringExpectedLog, report, watch } from '../watch.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};
const id = arg('row');
const spec = REMOVAL_ROWS[id];
if (!spec) {
  console.error(`usage: bun run.mjs --file removals.mjs --row ${Object.keys(REMOVAL_ROWS).join('|')}`);
  process.exit(2);
}
const log = (s) => console.log(`[${id}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** This page's MLS device ids, from the client's own store (`mls_device_id_<userId>`). */
const DEVICE_IDS = `Object.keys(localStorage).filter((k) => k.startsWith('mls_device_id_')).map((k) => localStorage.getItem(k))`;
const TIME_ORIGIN = 'performance.timeOrigin';

const run = mark(id.replace(/-/g, '').slice(0, 10));
const community = `RM ${run}`;
const salon = `rm-${run.toLowerCase()}`;

const w1 = await client(PORTS.W1);
const wa = await watch(w1, 'W1');
const w2 = spec.subject === 'W2' ? await client(PORTS.W2) : null;
const wb = w2 ? await watch(w2, 'W2') : null;
let w3 = null;
/** The device id W3 was minted as (DEVREVOKE-KEYGROUP): the one notice this row may dismiss on the owner seats. */
let mintedIds = [];

/** Opens the row's salon the way every COMM row does: the community list, the community, the salon. */
async function openSalon(cx) {
  await enterCommunities(cx);
  await openCommunity(cx, community);
  for (let i = 0; i < 20 && !(await channelRow(cx, salon)).present; i++) await sleep(1500);
  await realClick(cx, `[aria-label*=${JSON.stringify(salon)}]`);
  if ((await selectedChannel(cx)) !== salon) throw new Error(`the salon ${salon} did not open`);
}

/** The community with its private salon, and the peer let into both when the row's subject is W2. */
async function venue() {
  await enterCommunities(w1);
  await createCommunity(w1, community);
  await openCommunity(w1, community);
  const workspaceId = workspaceIdOf(community);
  if (spec.subject === 'W2') {
    const link = await inviteLink(w1);
    const preview = await openInviteLink(w2, link);
    if (preview.valid) await acceptInviteLink(w2);
  }
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await createChannel(w1, salon, { visibility: 'private' });
  const channelId = channelIdOf(workspaceId, salon);
  await openSalon(w1);
  if (spec.subject === 'W2') {
    await inPanel(w1, openChannelAccess, () => grantChannelAccess(w1, PEER_NAME));
    await openSalon(w2);
    const peerId = userIdOf(PEER_NAME);
    const salonRouted = await awaitUserRouting(channelId, peerId, true);
    const communityRouted = await awaitCommunityRouting(workspaceId, peerId, true, 60_000);
    log(`peer routed: salon ${salonRouted.ok} (${salonRouted.elapsedMs} ms), community ${communityRouted.ok} (${communityRouted.elapsedMs} ms)`);
  }
  // BACK ON THE SALON before sending: the access panel is a side panel on this viewport, and a send
  // typed under it lands nowhere.
  await openSalon(w1);
  await send(w1, `${run}-in`);
  return { workspaceId, channelId };
}

/** The row's key groups and the subject's devices on them, read before the gesture. */
function groupsBefore(v, subjectDevices) {
  const ids =
    spec.subject === 'W3'
      ? subjectDevices.flatMap((d) => keyGroupsOfDevice(d).map((g) => ({ groupId: g.groupId, scope: g.scope })))
      : [
          ...(spec.groups.includes('community') ? [{ groupId: communityDistribution(v.workspaceId)?.groupId, scope: 'community' }] : []),
          { groupId: salonDistribution(v.channelId)?.groupId, scope: 'salon' },
        ];
  const seen = new Set();
  return ids
    .filter((g) => g.groupId && !seen.has(g.groupId) && seen.add(g.groupId))
    .map((g) => {
      const now = groupEpochAndRoster(g.groupId);
      return { ...g, before: now?.epoch ?? null, routedBefore: !!now && now.devices.some((d) => subjectDevices.includes(d)) };
    });
}

/** Every group's epoch once a round until each moved past its `before`, or the rounds run out. */
async function rounds(groups) {
  for (const g of groups) g.movedAtRound = null;
  for (let r = 1; r <= COMMIT_ROUNDS && groups.some((g) => g.movedAtRound === null); r++) {
    for (const g of groups) {
      if (g.movedAtRound !== null) continue;
      const now = groupEpochAndRoster(g.groupId);
      if (now && now.epoch > g.before) g.movedAtRound = r;
    }
    await sleep(ROUND_MS);
  }
}

/** The device revoke, through the real panel on W6, under the allowlist of exactly one device. */
function revokeDevice(deviceId) {
  const purge = (args) => {
    const r = spawnSync(process.execPath, [requireScript('purge-devices.mjs'), '--port', String(PORTS.W6), ...args], { cwd: HARNESS_ROOT, encoding: 'utf8' });
    const out = r.stdout ?? '';
    const json = out.slice(out.lastIndexOf('\n{') + 1);
    try {
      return JSON.parse(json);
    } catch {
      throw new Error(`purge-devices answered no report (exit ${r.status}): ${(r.stderr || out).slice(-400)}`);
    }
  };
  const seen = purge([]);
  if (!seen.sparedIds.includes(deviceId)) throw new Error(`the device to revoke is not in W6's panel (${seen.sparedIds.length} deletable)`);
  const done = purge(['--only', deviceId, '--expect', String(seen.deletableBefore)]);
  if (done.deleted !== 1) throw new Error(`the revoke deleted ${done.deleted} device(s): ${JSON.stringify(done.failures)}`);
  return done;
}

const detail = { community, salon };
/** The row's ids its narration is scoped to (`removalNarration`), read once the venue exists. */
let rowIds = null;
let verdict = 'ERROR';
let failures = [];
try {
  const v = await venue();
  Object.assign(detail, v);
  const actorDevices = await evaluate(w1, DEVICE_IDS);
  let subjectDevices;
  if (spec.subject === 'W3') {
    const minted = await becomeANewDeviceAndConfirm({ report: (s) => log(`newdevice: ${s}`) });
    if (!minted?.cx || minted.refused) throw new Error(`W3 was not minted: ${minted?.refused ?? 'no client'}`);
    w3 = minted.cx;
    await openSalon(w3);
    subjectDevices = await evaluate(w3, DEVICE_IDS);
    mintedIds = [...subjectDevices];
    // THE NEW DEVICE PUTS ITS OWN LEAF IN, on loading: waited for on the roster, in rounds.
    const onEvery = () => spec.groups.every((scope) => keyGroupsOfDevice(subjectDevices[0]).some((g) => g.scope === scope));
    for (let r = 0; r < COMMIT_ROUNDS && !onEvery(); r++) await sleep(ROUND_MS);
  } else {
    subjectDevices = salonDistribution(v.channelId).devices.filter((d) => d.userId.toLowerCase() === userIdOf(PEER_NAME).toLowerCase()).map((d) => d.deviceId);
  }
  const groups = groupsBefore(v, subjectDevices);
  log(`armed on ${groups.length} key group(s): ${JSON.stringify(groups)}`);
  const channels = communityChannels(v.workspaceId);
  rowIds = {
    workspaceId: v.workspaceId,
    channelIds: channels.channelIds,
    keyGroupIds: [...channels.keyGroupIds, communityDistribution(v.workspaceId)?.groupId, ...groups.map((g) => g.groupId)].filter(Boolean),
    ownerUserId: userIdOf(OWNER_NAME),
    subjectUserId: spec.subject === 'W2' ? userIdOf(PEER_NAME) : null,
  };
  const origin = await evaluate(w1, TIME_ORIGIN);

  // THE GESTURE - one per row.
  if (id === 'KICK-COMMIT') {
    await enterCommunities(w1);
    await openCommunity(w1, community);
    detail.kick = await removeCommunityMember(w1, PEER_NAME);
    await clearOverlays(w1);
  } else if (id === 'SALON-REVOKE-COMMIT') {
    await inPanel(w1, openChannelAccess, () => revokeChannelAccess(w1, PEER_NAME));
    await openSalon(w1);
  } else {
    detail.revoke = revokeDevice(subjectDevices[0]);
  }

  await rounds(groups);
  for (const g of groups) {
    const now = groupEpochAndRoster(g.groupId);
    g.after = now?.epoch ?? null;
    g.routedAfter = !!now && now.devices.some((d) => subjectDevices.includes(d));
    g.commits = groupCommits(g.groupId).filter((c) => c.baseEpoch >= g.before);
  }
  const originAfter = await evaluate(w1, TIME_ORIGIN).catch(() => null);
  const measured = { groups, actorDevices: id === 'DEVREVOKE-KEYGROUP' ? [] : actorDevices, subjectDevices, reloaded: originAfter !== origin };
  ({ verdict, failures } = removalOwn(id, measured));
  Object.assign(detail, measured, { w1Devices: actorDevices });
  for (const f of failures) log(f);
} catch (e) {
  failures = [`${e?.message ?? e}`];
  detail.error = String(e?.stack ?? e).slice(0, 1200);
  console.error(`[${id}] ${detail.error}`);
} finally {
  try {
    await enterCommunities(w1);
    await openCommunity(w1, community);
    await deleteCommunity(w1, community);
    detail.deleted = true;
  } catch (e) {
    detail.deleted = `not deleted: ${String(e?.message ?? e).slice(0, 200)}`;
  }
}

/**
 * A seat's report with what THIS row made it say forgiven (`removalNarration`), and its boot narration
 * only when its window saw a document replaced - the rule `observersOf` applies to the MLS rows.
 */
async function observed(seat, w, extra = []) {
  let rep = await report(w);
  if ((rep.documentsReplaced ?? 0) > 0) rep = ignoringExpectedLog(rep, PAGE_BOOT_NARRATION);
  return ignoringExpectedLog(rep, [...extra, ...(rowIds ? removalNarration(id, seat, rowIds) : [])]);
}

const gated = gate(verdict, {
  W1: await observed('W1', wa),
  ...(wb ? { W2: await observed('W2', wb, EVICTED_REJOIN_NARRATION) } : {}),
});
record(id, gated.verdict, { ...gated.detail, ...detail, failures });
log(`verdict: ${gated.verdict}`);
// THE OWNER SEATS' "NOUVEL APPAREIL" NOTICE OF THE MINTED W3, dismissed after the verdict (`devicenotice.mjs`).
// W6 drove the device panel in its own process, so it is attached here for this alone.
// An unreachable W6 is logged and never keeps the seats below from closing (review, 2026-10-27).
let w6 = null;
try {
  w6 = mintedIds.length ? await client(PORTS.W6) : null;
} catch (e) {
  console.error(`[${id}] W6 not reached for the notice dismissal: ${String(e?.message ?? e)}`);
}
await dismissMintedNoticesOn([
  { seat: 'W1', cx: w1, minted: mintedIds },
  { seat: 'W6', cx: w6, minted: mintedIds },
]);
w6?.close();
w1.close();
w2?.close();
w3?.close();
exitOnRecorded();
