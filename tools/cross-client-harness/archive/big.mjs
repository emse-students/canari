/**
 * THE LARGE-GROUP ROWS OF THE 1.4.1 CAMPAIGN - every seat the rig has, in one conversation.
 *
 *   bun archive/big.mjs --row BIG-1|BIG-2|BIG-3     # class B: A1 and I1 are in play
 *   bun archive/big.mjs --row BIG-1-noI1|...        # the same row without I1, recorded under its own id
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.8; the table and every judge are `bigrows.mjs`.
 * BIG-1 and BIG-2 play in a group of their own (`mintRowGroup`, the three other accounts added in ONE
 * bulk Add); BIG-3 in a community of its own, deleted once the verdict is on disk.
 *
 * THE PHONE'S CHECKPOINT TIME (BIG-1) is the WebView's own `[MLS] Encrypted state checkpoint persisted.
 * (N ms)` line - the owed release-build measurement of `protocols/mls-protocol.md`, read on whatever
 * build the phone runs and recorded with that build (`results.mjs` `clientBuild`).
 */
import { awaitAppSettled, clearOverlays, openChannel, send } from '../chat.mjs';
import { BIG_ROWS, bulkAddOwn, playedRow, burstOwn, checkpointMs, communityEntitlement, inSendOrder, seedPerEventOwn, sessionsByPhase } from '../bigrows.mjs';
import { createChannel, createCommunity, deleteCommunity, inviteLink, openCommunity, openInviteLink, acceptInviteLink, removeCommunityMember, setHistoryVisibility } from '../comm.mjs';
import { psql } from '../estate.mjs';
import { awaitCommunityRouting, channelIdOf, communityDistribution, communityMemberIds, isCommunityMember, workspaceIdOf } from '../grainedb.mjs';
import { closeOverlays, openGroup } from '../groupnav.mjs';
import { checkInvariant, receivedOn } from '../invariant.mjs';
import {
  armLeafRefresh,
  assertRowOwns,
  awaitListed,
  closeSeats,
  commitLines,
  deviceIdOf,
  displayNameOf,
  mintRowGroup,
  observersOf,
  openSeats,
  serverView,
  userOf,
  watchersOf,
} from '../mlsrow.mjs';
import { clientBuild, errorDetail, finishObserved, keepConsoles, record } from '../results.mjs';
import { composeVerdict, invariantDetail, rowGroupName, rowMessageMark } from '../rowkit.mjs';
import { commitSequence } from '../settlerows.mjs';
import { GROUP_CREATION_NARRATION, bigRowNarration, consoleDump, consoleLines } from '../watch.mjs';
import { addMembers } from './addmember.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (!BIG_ROWS[id]) {
  console.error(`usage: bun archive/big.mjs --row ${Object.keys(BIG_ROWS).join('|')}`);
  process.exit(2);
}
const spec = BIG_ROWS[id];
// A VARIANT (`BIG-1-noI1`) PLAYS ITS ROW: the same action, names and marks; only the verdict keeps `id`.
const row = playedRow(id);
const since = new Date().toISOString();
let seats = null;
let community = null;
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cx = (d) => seats.seat[d].cx;

/** One seat per account: the first seat in `BIG_SEATS` order that is signed in as it. */
function firstSeatOfEach(user) {
  const out = {};
  for (const d of spec.devices) if (!Object.values(out).some((x) => user[x] === user[d])) out[d] = d;
  return Object.keys(out);
}

/** Polls `mark` on `device` until it shows or the bound passes; its `receivedOn` then. */
async function shownOn(device, mark, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await receivedOn(cx(device), mark);
    if (r.count > 0 || Date.now() > end) return r;
    await sleep(1_000);
  }
}

const ACTIONS = {
  /** BIG-1: the bulk Add is one commit; every device reads the first message; each phone's checkpoint. */
  async 'BIG-1'(c) {
    const others = firstSeatOfEach(c.user).filter((d) => c.user[d] !== c.user.W1);
    await addMembers(cx('W1'), others.map((d) => displayNameOf(c.user[d])));
    await closeOverlays(cx('W1'));
    const listed = {};
    for (const d of spec.devices.filter((x) => x !== 'W1')) listed[d] = await awaitListed(cx(d), c.group.name, 180_000);
    listed.W1 = 0;
    const seq = commitSequence(commitLines(c.group.id, c.startSince));
    const mark = rowMessageMark(row, 'FIRST');
    await send(cx('W1'), `${id} the first message [${mark}]`);
    const shown = {};
    for (const d of spec.devices) {
      if (listed[d] === null) {
        shown[d] = 0;
        continue;
      }
      await openGroup(cx(d), c.group.name, { label: id });
      shown[d] = (await shownOn(d, mark)).count;
    }
    const checkpoints = {};
    const builds = {};
    for (const p of spec.phones) {
      checkpoints[p] = checkpointMs(consoleLines(cx(p)));
      builds[p] = await clientBuild(cx(p)).catch(() => null);
    }
    return {
      members: spec.devices,
      detail: { decisions: seq, listed, checkpoints, builds },
      judge: () => bulkAddOwn({ accepts: seq.filter((s) => s.kind === 'ACCEPT').length, listed, shown, checkpoints }),
    };
  },

  /** BIG-2: three senders, ten each, at once; W1's own sends carry two leaf refreshes. */
  async 'BIG-2'(c) {
    const others = firstSeatOfEach(c.user).filter((d) => c.user[d] !== c.user.W1);
    await addMembers(cx('W1'), others.map((d) => displayNameOf(c.user[d])));
    await closeOverlays(cx('W1'));
    const premise = [];
    for (const d of spec.devices.filter((x) => x !== 'W1')) if ((await awaitListed(cx(d), c.group.name, 180_000)) === null) premise.push(`${d} never listed ${c.group.name}`);
    if (premise.length) return { premise };
    for (const d of spec.devices) await openGroup(cx(d), c.group.name, { navigate: false, label: id });
    const w1Device = await deviceIdOf(cx('W1'), c.user.W1);
    const burstSince = now();
    const marks = Object.fromEntries(spec.senders.map((s) => [s, Array.from({ length: spec.perSender }, (_, i) => rowMessageMark(row, `${s}${i}`))]));
    await Promise.all(
      spec.senders.map(async (s) => {
        for (let i = 0; i < spec.perSender; i++) {
          if (s === 'W1' && spec.commitsBefore.includes(i)) await armLeafRefresh(cx('W1'), c.user.W1, w1Device, c.group.id);
          await send(cx(s), `${id} ${s} ${i + 1}/${spec.perSender} [${marks[s][i]}]`);
        }
      })
    );
    // THE LAST MESSAGE IS GIVEN ITS BOUND ON EVERY DEVICE before anything is counted.
    const perDevice = {};
    for (const d of spec.devices) {
      for (const s of spec.senders) await shownOn(d, marks[s].at(-1), 90_000);
      const counts = {};
      const positions = {};
      for (const s of spec.senders) {
        positions[s] = [];
        for (const m of marks[s]) {
          const r = await receivedOn(cx(d), m);
          counts[m] = r.count;
          positions[s].push(r.position);
        }
      }
      perDevice[d] = { counts, ordered: inSendOrder(positions) };
    }
    const seq = commitSequence(commitLines(c.group.id, burstSince));
    return {
      members: spec.devices,
      detail: { decisions: seq },
      judge: () => burstOwn({ accepts: seq.filter((s) => s.kind === 'ACCEPT').length, expectedCommits: spec.commitsBefore.length, perDevice }),
    };
  },
};

/** BIG-3, whole: a community of its own, a removal, a newcomer, and the seeds each event minted. */
async function playCommunity(user) {
  const W1 = cx('W1');
  community = rowGroupName(row);
  await createCommunity(W1, community);
  await setHistoryVisibility(W1, 'joined');
  const link = await inviteLink(W1);
  await clearOverlays(W1);
  const workspaceId = workspaceIdOf(community, { memberUserId: user.W1 });
  if (!workspaceId) return { premise: [`${community} is not on the server after its creation`] };
  const newcomerUser = user[spec.newcomer];
  const joiners = firstSeatOfEach(user).filter((d) => user[d] !== user.W1 && user[d] !== newcomerUser);
  for (const d of joiners) {
    const seen = await openInviteLink(cx(d), link);
    if (!seen.valid) return { premise: [`${d}: the community's link was refused`] };
    await acceptInviteLink(cx(d));
  }
  await openCommunity(W1, community);
  const salon = `${community}-salon`;
  await createChannel(W1, salon, { visibility: 'public' });
  const channelId = channelIdOf(workspaceId, salon);
  if (!channelId || !UUID.test(channelId)) return { premise: [`${salon} is not on the server after its creation`] };
  const inPlay = spec.devices.filter((d) => user[d] !== newcomerUser);
  for (const d of inPlay) await openChannel(cx(d), community, salon);
  const premise = [];
  for (const u of new Set(inPlay.map((d) => user[d]))) if (!(await awaitCommunityRouting(workspaceId, u, true, 90_000)).ok) premise.push(`${u.slice(0, 8)} never took its seat in the community's group`);
  if (premise.length) return { premise };

  const say = async (tag) => {
    const out = [];
    for (const s of spec.senders) {
      await openChannel(cx(s), community, salon);
      const m = rowMessageMark(row, `${tag}${s}`);
      await send(cx(s), `${id} ${tag} from ${s} [${m}]`);
      out.push(m);
    }
    return out;
  };
  const epochAt = () => communityDistribution(workspaceId)?.epoch ?? null;
  const t0 = now();
  const before = [...(await say('A')), ...(await say('B'))];

  // THE REMOVAL: the third account, every one of its devices.
  const removedUser = user[spec.removed];
  const removedSeats = spec.devices.filter((d) => user[d] === removedUser);
  const e0 = epochAt();
  const tRemoval = now();
  await openCommunity(W1, community);
  await removeCommunityMember(W1, displayNameOf(removedUser));
  await clearOverlays(W1);
  const gone = await awaitCommunityRouting(workspaceId, removedUser, false, 90_000);
  const e1 = epochAt();
  const afterRemoval = [...(await say('C')), ...(await say('D'))];

  // THE NEWCOMER: the fourth account, by the link, under `joined`.
  const tJoin = now();
  const seen = await openInviteLink(cx(spec.newcomer), link);
  if (!seen.valid) return { premise: [`${spec.newcomer}: the community's link was refused`] };
  await acceptInviteLink(cx(spec.newcomer));
  await openChannel(cx(spec.newcomer), community, salon);
  await awaitCommunityRouting(workspaceId, newcomerUser, true, 90_000);
  const e2 = epochAt();
  const afterJoin = [...(await say('E')), ...(await say('F'))];

  // THE SEEDS, AS THE SERVER HOLDS THEM: one row per message, its author and its session, by time.
  const rows = psql(`SELECT "authorId", "senderSessionId", to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM channel_messages WHERE "channelId" = '${channelId}' AND "senderSessionId" IS NOT NULL ORDER BY "createdAt"`)
    .split('\n')
    .map((l) => l.trim().split('|'))
    .filter((r) => r.length === 3)
    .map(([authorId, sessionId, at]) => ({ authorId, sessionId, at }));
  const sessions = sessionsByPhase(
    rows.filter((r) => r.at >= t0),
    [tRemoval, tJoin]
  );
  const removedShown = {};
  for (const d of removedSeats) {
    let n = 0;
    for (const m of afterRemoval) n += (await receivedOn(cx(d), m)).count;
    removedShown[d] = n;
  }
  await awaitAppSettled(cx(spec.newcomer));
  const newcomer = { before: 0, after: 0 };
  for (const m of [...before, ...afterRemoval]) newcomer.before += (await receivedOn(cx(spec.newcomer), m)).count;
  for (const m of afterJoin) newcomer.after += (await shownOn(spec.newcomer, m, 30_000)).count;
  const dist = communityDistribution(workspaceId);
  const removedSeated = (dist?.devices ?? []).some((d) => d.userId.toLowerCase() === removedUser.toLowerCase() && d.status === 'active');
  return {
    own: seedPerEventOwn({ sessions, senders: spec.senders.map((s) => user[s]), removedShown, removedSeated, newcomer, afterExpected: afterJoin.length }),
    invariant: communityEntitlement({ pass: 'after the action', dist, members: communityMemberIds(workspaceId), users: [...new Set(Object.values(user))] }),
    detail: {
      community,
      workspaceId,
      channelId,
      epochs: { start: e0, afterRemoval: e1, afterJoin: e2 },
      removalSettledMs: gone.elapsedMs,
      stillMember: isCommunityMember(workspaceId, removedUser),
      sessions: Object.fromEntries(Object.entries(sessions).map(([a, p]) => [a.slice(0, 8), p.map((s) => s.length)])),
    },
  };
}

/** Set up, act, judge. */
async function play() {
  const user = Object.fromEntries(spec.devices.map((d) => [d, userOf(seats, d)]));
  if (row === 'BIG-3') return playCommunity(user);
  const group = await mintRowGroup(cx('W1'), row, user.W1);
  assertRowOwns({ kind: 'group', id: group.id, name: group.name }, row);
  await openGroup(cx('W1'), group.name, { navigate: false, label: id });
  const fromEpoch = serverView(group.id).activeEpoch;
  const c = { user, group, startSince: now() };
  const act = await ACTIONS[row](c);
  if (act.premise?.length) return { premise: act.premise, detail: { group: group.id } };
  const invariant = await checkInvariant({
    group: group.id,
    targets: seats.targets,
    members: act.members,
    conversation: group.name,
    fromEpoch,
    since,
    reload: true,
    watchers: watchersOf(seats),
  });
  return { own: act.judge(), invariant, detail: { group: group.id, name: group.name, fromEpoch, ...act.detail } };
}

try {
  seats = await openSeats(spec.devices, id);
  const out = await play();
  const { verdict, failures } = composeVerdict({ own: out.own ?? [], invariant: out.invariant ?? null, premise: out.premise ?? [] });
  for (const f of failures) console.log(`[${id}] ${f}`);
  console.log(`[${id}] assertions: ${verdict}`);
  // EVERY SEAT ITS BIG-ROW NARRATION (`bigRowNarration`: A1 its own lines too), W1 its group creation.
  const logs = Object.fromEntries(spec.devices.map((d) => [d, [...bigRowNarration(d), ...(d === 'W1' ? GROUP_CREATION_NARRATION : [])]]));
  const observers = await observersOf(seats, { logs });
  await finishObserved(
    id,
    verdict,
    { ...out.detail, own: out.own ?? [], failures, invariant: invariantDetail(out.invariant ?? null), serverWindowSince: since },
    observers,
    async () => {
      if (community) {
        // THE ROW'S COMMUNITY GOES WITH IT, once the verdict is on disk; a failure here is logged, never the row.
        await openCommunity(cx('W1'), community)
          .then(() => deleteCommunity(cx('W1'), community))
          .catch((e) => console.log(`[${id}] the row's community ${community} was NOT deleted: ${String(e?.message ?? e)}`));
      }
      closeSeats(seats);
    }
  );
} catch (e) {
  console.error(`[${id}] ${e?.stack ?? e}`);
  // AN ERROR KEEPS EVERY SEAT'S CONSOLE. BIG-1-noI1's first alpha.5 run (2026-10-26) ended on W3
  // refusing to open the row's group three times in 40 s, and nothing said what W3 was doing - a
  // twelve-device row is exactly where one busy seat hides. Reading a console never throws past here.
  let consoles = null;
  try {
    consoles = seats ? keepConsoles(id, consoleDump(Object.fromEntries(Object.entries(seats.seat ?? {}).map(([d, s]) => [d, { cx: s?.cx }])))) : null;
  } catch (k) {
    console.error(`[${id}] the seats' consoles could not be kept: ${String(k?.message ?? k)}`);
  }
  record(id, 'ERROR', { ...errorDetail(e), ...(consoles ? { consoles } : {}) });
  closeSeats(seats);
  process.exit(1);
}
