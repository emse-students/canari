/**
 * Builds the campaign's SHARED venue if it is not there, and states what it found if it is.
 *
 *   bun venue.mjs [--dry]
 *
 * THE VENUE IS A FIXTURE, NOT ONE ROW'S SETUP. Twenty-odd runners build their
 * salon inside it rather than minting a community of their own - the community is the expensive half
 * and a per-row one would multiply the estate by twenty - so it is the ground every one of them
 * stands on, and nothing in the rig used to be able to state that it existed.
 *
 * IT WAS GONE ON 2026-08-25, cleanly, through the product, by a gesture no surviving log window
 * covers: `channel_workspaces` held no row, no distribution group was orphaned, and the
 * social-service log had been replaced by a deploy. Rung 9 then discovered it one row at a time -
 * COMM-5, COMM-8, COMM-9/10 and COMM-14, each spending a full cycle to report "the community was
 * never listed", which reads as a sidebar defect and was a missing fixture. `run.mjs`'s preflight now
 * refuses a run instead, and this is the command that refusal points at.
 *
 * IT IS IDEMPOTENT, AND IT HAS NO DESTRUCTIVE PATH AT ALL. Every gesture is guarded by the table
 * first: the community is created only if no row names it AND THE OWNER IS IN IT, the channel only
 * if the community has none by that name, the peer invited only if no membership row is theirs, and
 * the peer's client opened only if no DELIVERY row is. Run twice and the second run is reads alone,
 * with no client opened at all. Nothing here deletes, so there is no allowlist to get wrong - the
 * estate's destructive half is `cleanup.mjs` and stays there.
 *
 * IT ASSERTS TRANSPORT, NOT ONLY ENTITLEMENT, and the distinction is the whole reason the last
 * gesture exists. `channel_members` says who MAY read the venue; `dm_device_group_memberships` on
 * the community's distribution group says whose device a frame is actually fanned out to, and a
 * public `general` carries no group of its own so that community roster is the only transport it
 * has. A member's device commits its OWN add when that member LOADS the community, so an invited
 * peer that has never opened it is entitled to a venue it cannot receive a message from.
 *
 * IT DRIVES THE PRODUCT, NEVER THE DATABASE, for the same reason `cleanup.mjs` does: a community
 * inserted as rows would have no key-distribution group, and every check that posts into it would
 * then be measuring a venue no real gesture could have produced. Building it through the screens is
 * also a standing check that the create path still works.
 *
 * AND IT ANSWERS FROM THE TABLE. What the screen says after a click is that the click landed; what
 * the campaign needs is the row. So each gesture is followed by a read of `channel_workspaces`,
 * `channels` and `channel_members`, and the exit code is that read's verdict rather than the
 * gestures'.
 *
 * THE CHANNEL IS PUBLIC, deliberately: every check that posts into the venue does so without asking
 * for a grant, and a private `general` would turn all twenty of them into access-control rows.
 */
import { client } from './chat.mjs';
import {
  createChannel,
  createCommunity,
  enterCommunities,
  inviteToCommunity,
  openCommunity,
} from './comm.mjs';
import {
  awaitCommunityRouting,
  channelIdOf,
  communityDistribution,
  communityMemberIds,
  userIdOf,
  workspaceFootprint,
  workspaceIdOf,
} from './grainedb.mjs';
import { OWNER_NAME, PEER_NAME, PORTS, VENUE } from './names.mjs';

const dry = process.argv.includes('--dry');

/**
 * How long a member's own device is given to commit its add after the community is loaded.
 *
 * TEN SECONDS IS A VERDICT, NOT A BUDGET. The rig's standing rule is that no wait here exceeds
 * it - ten seconds shows whether a mechanism works - and a roster that has not moved by then is
 * reported rather than waited on, because a longer wait turns a broken commit into a slow one and
 * the fixture would be declared whole either way.
 */
const ROUTING_MS = 10_000;

// WHO MUST BE IN IT, resolved BEFORE the first read rather than after it. The owner is not merely
// something to assert at the end - it is HALF THE FIXTURE'S IDENTITY, because a community is ours
// by virtue of a membership row and never by virtue of its name. A display name that resolves to
// nothing is a stale `names.mjs` or a renamed account, and inviting into the void reports success.
const owner = userIdOf(OWNER_NAME);
const peer = userIdOf(PEER_NAME);
if (!owner || !peer) {
  console.log(`[venue] REFUSING - owner ${owner ? 'ok' : 'UNRESOLVED'}, peer ${peer ? 'ok' : 'UNRESOLVED'}`);
  process.exit(1);
}

/** What the tables say about the venue right now. Read once per phase of the build, never cached. */
function state() {
  const workspaceId = workspaceIdOf(VENUE.community, { memberUserId: owner });
  const channelId = workspaceId ? channelIdOf(workspaceId, VENUE.channel) : null;
  const members = workspaceId ? communityMemberIds(workspaceId) : [];
  // MEMBERSHIP IS ENTITLEMENT; THE DELIVERY ROW IS WHAT A FRAME TRAVELS ON. `general` is public and
  // so carries no group of its own - the COMMUNITY's group fans its messages out - which makes this
  // roster, not `channel_members`, the thing that decides whether the fixture can carry a message.
  const dist = workspaceId ? communityDistribution(workspaceId) : null;
  const routed = new Set((dist?.devices ?? []).map((d) => d.userId.toLowerCase()));
  return { workspaceId, channelId, members, dist, routed };
}

const before = state();
console.log(
  `[venue] "${VENUE.community}" ${before.workspaceId ? `is ${before.workspaceId.slice(0, 8)}` : 'DOES NOT EXIST'}, ` +
    `"${VENUE.channel}" ${before.channelId ? `is ${before.channelId.slice(0, 8)}` : 'is MISSING'}, ` +
    `${before.members.length} member(s), ${before.routed.size} routed`
);

// THE NAME MAY BE HELD BY A COMMUNITY THAT IS NOT OURS, AND THAT IS A REFUSAL RATHER THAN A BUILD.
// A community's slug is derived from its name and carries a UNIQUE index estate-wide, so a name
// somebody else holds can be neither joined - we have no membership row and the client cannot even
// list it - nor created again, because the insert collides. Both gestures then fail a long way from
// the cause: the create reports a server error, and the invite reports `the community was never
// listed`, which reads as a sidebar defect. Measured on 2026-09-04, when the local estate was
// seeded from a production dump and the venue name turned out to belong to two real members.
if (!before.workspaceId) {
  const foreign = workspaceIdOf(VENUE.community);
  if (foreign) {
    const it = workspaceFootprint(foreign);
    console.log(
      `[venue] REFUSING - "${VENUE.community}" already exists as ${foreign.slice(0, 8)} with ` +
        `${it.members} member(s), and ${OWNER_NAME} is not one of them. Its slug "${it.slug}" is ` +
        `unique estate-wide, so this fixture can be neither joined nor rebuilt under that name.`
    );
    console.log(
      `[venue] The campaign runs on a COPY OF PRODUCTION, so a human-chosen venue name will ` +
        `collide with a real community sooner or later. Point VENUE.community at a name the ` +
        `campaign's OWN accounts hold.`
    );
    process.exit(1);
  }
}

// CREATING A COMMUNITY MAKES ITS CREATOR A MEMBER, so the owner's seat is never owed separately -
// it is implied by the create, and by the scoped read above for a community that already exists.
const owed = [];
if (!before.workspaceId) {
  owed.push(`create the community "${VENUE.community}" (its creator becomes its first member)`);
} else {
  if (!before.channelId) owed.push(`create its "${VENUE.channel}" channel`);
  if (!before.members.includes(peer)) owed.push(`put ${PEER_NAME} in it`);
  if (!before.routed.has(peer.toLowerCase())) {
    owed.push(`have ${PEER_NAME} load it, so its device joins the delivery roster`);
  }
}

if (owed.length === 0) {
  console.log('[venue] nothing owed - the fixture is whole');
  process.exit(0);
}
for (const o of owed) console.log(`  owed: ${o}`);
if (dry) {
  console.log('[venue] --dry: nothing built');
  process.exit(0);
}

const w1 = await client(PORTS.W1);
const failed = [];
const did = async (what, fn) => {
  try {
    await fn();
    console.log(`[venue] ${what}`);
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    failed.push(`${what}: ${said}`);
    console.log(`[venue] COULD NOT ${what} - ${said}`);
  }
};

// THE COMMUNITY FIRST, AND CREATING IT MAKES ITS CREATOR A MEMBER - so the owner's membership is
// never a separate gesture, only ever a separate ASSERTION. An owner missing from an existing
// community is a state this cannot repair from here (they would have to be invited by someone who
// can manage it, and W1 is the only client here), so it is reported and not attempted.
if (!before.workspaceId) {
  await did(`created the community`, async () => {
    await enterCommunities(w1);
    await createCommunity(w1, VENUE.community);
  });
}

// RE-READ RATHER THAN ASSUME THE CREATE MADE A CHANNEL. Some create paths mint a default one and
// some do not; which it is decides whether the next gesture is a creation or a collision, and the
// table is the only place that says.
const afterCommunity = state();
if (afterCommunity.workspaceId && !afterCommunity.channelId) {
  await did(`created the "${VENUE.channel}" channel`, async () => {
    await enterCommunities(w1);
    await openCommunity(w1, VENUE.community);
    await createChannel(w1, VENUE.channel, { visibility: 'public' });
  });
}

// A DIRECT INVITATION IS A MEMBERSHIP, NOT AN OFFER (see COMM-4), which is why the peer needs no
// gesture on their own client and why the membership row below is the whole assertion.
const afterChannel = state();
if (afterChannel.workspaceId && !afterChannel.members.includes(peer)) {
  await did(`invited ${PEER_NAME}`, async () => {
    await enterCommunities(w1);
    await openCommunity(w1, VENUE.community);
    await inviteToCommunity(w1, PEER_NAME, 'member');
  });
}

// THE INVITE IS ENTITLEMENT AND THE DELIVERY ROW IS TRANSPORT, and only the second one carries a
// message. A member's device commits its OWN add, so the row appears when that member LOADS the
// community and never when the owner invites them - which is why this is a gesture on the PEER's
// client rather than another read. Measured 2026-09-04: a venue built minutes earlier held the
// owner's single device, and a peer invited seconds before was absent from the only roster a public
// salon's frames travel on. The fixture looked whole in `channel_members` and could not carry a
// message to the peer.
//
// W2 IS OPENED ONLY WHEN THIS IS OWED, so a whole fixture still costs one client and no gesture.
const afterInvite = state();
if (afterInvite.workspaceId && !afterInvite.routed.has(peer.toLowerCase())) {
  let routedIn = null;
  let w2 = null;
  await did(`had ${PEER_NAME} load the community`, async () => {
    w2 = await client(PORTS.W2);
    await enterCommunities(w2);
    await openCommunity(w2, VENUE.community);
    // A DEADLINE IS A RESULT: `awaitCommunityRouting` reports rather than throws, and only this
    // caller knows that a roster which never moved means the load did not commit an add.
    const routed = await awaitCommunityRouting(afterInvite.workspaceId, peer, true, ROUTING_MS);
    if (!routed.ok) {
      throw new Error(
        `the community opened, but its device never joined the delivery roster within ` +
          `${ROUTING_MS}ms - the roster holds ${routed.dist?.devices.length ?? 0} device(s) at ` +
          `epoch ${routed.dist?.epoch ?? '?'}`
      );
    }
    routedIn = routed.elapsedMs;
  });
  w2?.close();
  if (routedIn !== null) {
    console.log(`[venue] ${PEER_NAME}'s device joined the delivery roster after ${routedIn}ms`);
  }
}

const after = state();
console.log(
  `[venue] now: community ${after.workspaceId ? after.workspaceId.slice(0, 8) : 'MISSING'}, ` +
    `channel ${after.channelId ? after.channelId.slice(0, 8) : 'MISSING'}, ` +
    `${after.members.length} member(s), ${after.routed.size} routed`
);
// SYMMETRIC WITH `owed`, AND SCOPED THE SAME WAY: a missing community and an owner with no seat in
// it are ONE state here, not two, because the read that produced `after` already required the seat.
// Reporting them separately printed two sentences for one fault and invited the reader to look for
// a membership bug that is not there.
const still = [];
if (!after.workspaceId) {
  still.push(`there is no "${VENUE.community}" that ${OWNER_NAME} is a member of`);
} else {
  if (!after.channelId) still.push(`there is no "${VENUE.channel}" channel`);
  if (!after.members.includes(peer)) still.push(`${PEER_NAME} is not a member`);
  // THE LAST ASSERTION IS TRANSPORT, NOT ENTITLEMENT. A fixture that is whole in `channel_members`
  // and empty on the delivery roster is one every runner would build inside and none could deliver
  // from, which is the shape of a missing fixture rather than a slow one.
  for (const who of [
    [OWNER_NAME, owner],
    [PEER_NAME, peer],
  ]) {
    if (!after.routed.has(who[1].toLowerCase())) {
      still.push(`${who[0]} holds no delivery row on the community's distribution group`);
    }
  }
}
for (const s of still) console.log(`  STILL WRONG: ${s}`);
for (const f of failed) console.log(`  failure: ${f}`);

w1.close();
process.exit(still.length === 0 ? 0 : 1);
