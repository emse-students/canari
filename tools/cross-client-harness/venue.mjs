/**
 * Builds the campaign's SHARED venue if it is not there, and states what it found if it is.
 *
 *   node venue.mjs [--dry]
 *
 * `Campagne de test` / `general` IS A FIXTURE, NOT ONE ROW'S SETUP. Twenty-odd runners build their
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
 * first: the community is created only if no row names it, the channel only if the community has
 * none by that name, the peer invited only if no membership row is theirs. Run twice and the second
 * run is four `SELECT`s. Nothing here deletes, so there is no allowlist to get wrong - the estate's
 * destructive half is `cleanup.mjs` and stays there.
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
import { channelIdOf, communityMemberIds, userIdOf, workspaceIdOf } from './grainedb.mjs';
import { OWNER_NAME, PEER_NAME, PORTS, VENUE } from './names.mjs';

const dry = process.argv.includes('--dry');

/** What the tables say about the venue right now. Read once per phase of the build, never cached. */
function state() {
  const workspaceId = workspaceIdOf(VENUE.community);
  const channelId = workspaceId ? channelIdOf(workspaceId, VENUE.channel) : null;
  const members = workspaceId ? communityMemberIds(workspaceId) : [];
  return { workspaceId, channelId, members };
}

const before = state();
console.log(
  `[venue] "${VENUE.community}" ${before.workspaceId ? `is ${before.workspaceId.slice(0, 8)}` : 'DOES NOT EXIST'}, ` +
    `"${VENUE.channel}" ${before.channelId ? `is ${before.channelId.slice(0, 8)}` : 'is MISSING'}, ` +
    `${before.members.length} member(s)`
);

// WHO MUST BE IN IT, resolved before any gesture: a display name that resolves to nothing is a
// stale `names.mjs` or a renamed account, and inviting into the void would report success.
const owner = userIdOf(OWNER_NAME);
const peer = userIdOf(PEER_NAME);
if (!owner || !peer) {
  console.log(`[venue] REFUSING - owner ${owner ? 'ok' : 'UNRESOLVED'}, peer ${peer ? 'ok' : 'UNRESOLVED'}`);
  process.exit(1);
}

const owed = [];
if (!before.workspaceId) owed.push(`create the community "${VENUE.community}"`);
if (before.workspaceId && !before.channelId) owed.push(`create its "${VENUE.channel}" channel`);
if (!before.members.includes(owner)) owed.push(`put ${OWNER_NAME} in it`);
if (!before.members.includes(peer)) owed.push(`put ${PEER_NAME} in it`);

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

const after = state();
console.log(
  `[venue] now: community ${after.workspaceId ? after.workspaceId.slice(0, 8) : 'MISSING'}, ` +
    `channel ${after.channelId ? after.channelId.slice(0, 8) : 'MISSING'}, ` +
    `${after.members.length} member(s)`
);
const still = [];
if (!after.workspaceId) still.push('the community is not there');
if (after.workspaceId && !after.channelId) still.push(`there is no "${VENUE.channel}" channel`);
if (!after.members.includes(owner)) still.push(`${OWNER_NAME} is not a member`);
if (!after.members.includes(peer)) still.push(`${PEER_NAME} is not a member`);
for (const s of still) console.log(`  STILL WRONG: ${s}`);
for (const f of failed) console.log(`  failure: ${f}`);

w1.close();
process.exit(still.length === 0 ? 0 : 1);
