/**
 * COMM-11: kicked from a community, and taken out of every private salon inside it.
 *
 *   node comm11.mjs
 *
 * THE COMMUNITY'S CUT SAYS NOTHING ABOUT ITS SALONS, and that is the whole row. Since 2026-08-20
 * each private salon distributes its seeds on a group of its own, so a departure that only cut the
 * community's group would leave the leaver routed every seed of every private salon they were in -
 * a person removed from the front door who still has the keys to the rooms. Two groups, two rosters,
 * and the check reads both before and after.
 *
 * THREE INDEPENDENT WITHDRAWALS, ASSERTED SEPARATELY BECAUSE THEY FAIL SEPARATELY:
 *
 *   the membership row  - what every permission check consults;
 *   the routing rows    - what decides which devices a frame is DELIVERED to, on BOTH groups;
 *   `allowedUsers`      - the salon's authorization. Left behind, it is not merely untidy: the
 *                         roster reconciliation diffs the MLS tree against exactly this list, so a
 *                         name still in it is a leaf re-authorised at every reconciliation, and the
 *                         removal is undone by the very mechanism meant to enforce it.
 *
 * AND THE CLIENT'S OWN HALF, which no table can show: the community must leave W2's sidebar. A
 * server that cut everything correctly while the removed person's app went on displaying the
 * community is a defect with no database symptom at all.
 *
 * IT BUILDS ITS OWN VENUE. The shared community cannot be used: this check removes W2 from it, and
 * every other row in the phase needs W2 to still be there.
 */
import { client, realClick } from './chat.mjs';
import {
  acceptInviteLink,
  createChannel,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  grantChannelAccess,
  inviteLink,
  listCommunities,
  openChannelAccess,
  openCommunity,
  openInviteLink,
  removeCommunityMember,
  saveChannelAccess,
  selectedChannel,
} from './comm.mjs';
import {
  channelIdOf,
  communityDistribution,
  isCommunityMember,
  salonDistribution,
  userIdOf,
  workspaceIdOf,
} from './grainedb.mjs';
import { PEER_NAME, PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM11');
const community = `C11 ${run}`;
const salon = `c11-${run.toLowerCase()}`;

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

const peerId = await step('resolve the peer user id', () => userIdOf(PEER_NAME));

// -- A community, a private salon, and the peer inside both ------------------------
await step('create the community', async () => {
  await enterCommunities(w1);
  await createCommunity(w1, community);
  await openCommunity(w1, community);
});
const workspaceId = await step('read the community id', () => workspaceIdOf(community));

await step('put the peer in the community', async () => {
  if (!workspaceId) return;
  const link = await inviteLink(w1);
  const preview = await openInviteLink(w2, link);
  if (preview.valid) await acceptInviteLink(w2);
});

await step('create the private salon with the peer in it', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await createChannel(w1, salon, { visibility: 'private' });
  await realClick(w1, `[aria-label*=${JSON.stringify(salon)}]`);
  await openChannelAccess(w1);
  await grantChannelAccess(w1, PEER_NAME);
  await saveChannelAccess(w1);
});
const channelId = await step('read the salon id', () =>
  workspaceId ? channelIdOf(workspaceId, salon) : null
);

// Opening it on the peer is what puts their device into the salon's group by external commit - and
// therefore what writes the routing row this check is about to watch disappear.
await step('open the salon on the peer', async () => {
  await enterCommunities(w2);
  await openCommunity(w2, community);
  await realClick(w2, `[aria-label*=${JSON.stringify(salon)}]`);
  if ((await selectedChannel(w2)) !== salon) throw new Error('the salon did not open on the peer');
});

/** The peer's device rows on both groups, and their name on the salon's roster. */
const holdings = () => {
  const comm = workspaceId ? communityDistribution(workspaceId) : null;
  const sal = channelId ? salonDistribution(channelId) : null;
  return {
    onCommunityGroup: !!peerId && !!comm && comm.devices.some((d) => d.userId === peerId),
    onSalonGroup: !!peerId && !!sal && sal.devices.some((d) => d.userId === peerId),
    inAllowedUsers: !!peerId && !!sal && sal.allowedUsers.includes(peerId),
    isMember: !!peerId && !!workspaceId && isCommunityMember(workspaceId, peerId),
  };
};

const before = await step('wait for the peer on BOTH rosters', async () => {
  const deadline = Date.now() + 40000;
  for (;;) {
    const now = holdings();
    if (now.onCommunityGroup && now.onSalonGroup) return now;
    if (Date.now() > deadline) return now;
    await new Promise((r) => setTimeout(r, 1500));
  }
});

// Nothing below means anything unless the peer really held all four. A removal measured against an
// empty set is the purest vacuous pass this phase can produce.
const armed =
  !!workspaceId &&
  !!channelId &&
  !!peerId &&
  before?.isMember === true &&
  before?.onCommunityGroup === true &&
  before?.onSalonGroup === true &&
  before?.inAllowedUsers === true;

const sidebarBefore = armed ? await step('read the peer sidebar', () => listCommunities(w2)) : null;

// -- The removal -------------------------------------------------------------------
await step('remove the peer from the community', async () => {
  if (!armed) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await removeCommunityMember(w1, PEER_NAME);
});

const after = armed
  ? await (async () => {
      const deadline = Date.now() + 30000;
      for (;;) {
        const now = holdings();
        if (!now.isMember && !now.onCommunityGroup && !now.onSalonGroup && !now.inAllowedUsers) {
          return now;
        }
        if (Date.now() > deadline) return now;
        await new Promise((r) => setTimeout(r, 1500));
      }
    })()
  : null;

// THE CLIENT'S HALF. Bounded, because the purge follows an event that arrives after the removal.
const sidebarAfter = armed
  ? await (async () => {
      const deadline = Date.now() + 25000;
      for (;;) {
        const list = await listCommunities(w2).catch(() => null);
        if (list && !list.some((n) => n.includes(community))) return list;
        if (Date.now() > deadline) return list;
        await new Promise((r) => setTimeout(r, 1500));
      }
    })()
  : null;

// -- Its own debris goes -------------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const expectations = {
  membershipRowGone: after?.isMember === false,
  communityRoutingDropped: after?.onCommunityGroup === false,
  // THE ROW'S SUBJECT. The community's cut says nothing about a salon's own group.
  salonRoutingDropped: after?.onSalonGroup === false,
  // Not tidiness: the reconciliation diffs the tree against this list, so a surviving name is a
  // leaf re-authorised at every pass - the removal undone by its own enforcement.
  salonRosterCleared: after?.inAllowedUsers === false,
  // What no table can show.
  peerSidebarShowedIt: Array.isArray(sidebarBefore) && sidebarBefore.some((n) => n.includes(community)),
  peerSidebarPurged: Array.isArray(sidebarAfter) && !sidebarAfter.some((n) => n.includes(community)),
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);
const gated = gate(verdict, { W1: await report(wa), W2: await report(wb) });

record('COMM-11', gated.verdict, {
  ...gated.detail,
  community,
  salon,
  workspaceId,
  channelId,
  before,
  after,
  sidebarBefore,
  sidebarAfter,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
