/**
 * COMM-19: the last administrator cannot leave, and the last MEMBER takes the community with them.
 *
 *   node comm19.mjs
 *
 * TWO RULES THAT LOOK LIKE ONE AND ARE OPPOSITE. A community may never be left ungoverned, so the
 * only admin is refused while anyone else is still in it - and yet the same person, once nobody else
 * remains, must be allowed out, because refusing there would make a community nobody belongs to and
 * nobody can delete. The whole design is in which of the two a departure falls into, so the check
 * makes the SAME person perform the SAME gesture twice and asks for opposite outcomes.
 *
 * THE REFUSAL IS READ FROM THE TABLE AND FROM THE SCREEN, and neither alone would do. A membership
 * row that survived proves the server refused; it says nothing about whether the person was TOLD,
 * and a refusal nobody explains is a button that does nothing. The app's own sentence - "this
 * community would be left with no administrator" - is looked for in the client's log, so a server
 * that refuses correctly behind a silent UI still fails this row.
 *
 * THE ORDER IS THE ASSERTION. W2 leaves BETWEEN the two attempts, and nothing else changes: same
 * admin, same community, same gesture. If the second attempt were allowed for any reason other than
 * "there is nobody left to govern", this check could not tell - which is why the roster is read
 * before each attempt rather than assumed from the one before.
 *
 * IT BUILDS ITS OWN VENUE, and the last gesture destroys it - the community's deletion IS the final
 * assertion, so there is nothing to clean up afterwards. A run that dies in the middle leaves a
 * community behind on purpose: it is the evidence.
 */
import { client } from './chat.mjs';
import {
  acceptInviteLink,
  caption,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  inviteLink,
  leaveCommunity,
  openCommunity,
  openInviteLink,
} from './comm.mjs';
import { communityRole, isCommunityMember, userIdOf, workspaceFootprint, workspaceIdOf } from './grainedb.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import {
  awaitLine,
  consoleLines,
  gate,
  ignoringExpectedRefusal,
  report,
  watch,
} from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM19');
const community = `C19 ${run}`;

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

const ownerId = await step('resolve the owner user id', () => userIdOf(OWNER_NAME));
const peerId = await step('resolve the peer user id', () => userIdOf(PEER_NAME));

// -- A community with exactly one admin and one other member ----------------------
await step('create the community', async () => {
  await enterCommunities(w1);
  await createCommunity(w1, community);
  await openCommunity(w1, community);
});
const workspaceId = await step('read the community id', () => workspaceIdOf(community));

await step('put the peer in it', async () => {
  if (!workspaceId) return;
  const link = await inviteLink(w1);
  const preview = await openInviteLink(w2, link);
  if (preview.valid) await acceptInviteLink(w2);
});

const rosterBefore = workspaceId ? workspaceFootprint(workspaceId).members : null;
const ownerIsAdmin = workspaceId && ownerId ? communityRole(workspaceId, ownerId) === 'admin' : null;
const peerIsNotAdmin =
  workspaceId && peerId ? communityRole(workspaceId, peerId) !== 'admin' : null;

// Nothing below means anything unless there is exactly ONE admin and somebody else to be governed.
const armed = !!workspaceId && rosterBefore === 2 && ownerIsAdmin === true && peerIsNotAdmin === true;

// -- Attempt 1: refused, because W2 would be left with nobody in charge ------------
await step('the sole admin tries to leave', async () => {
  if (!armed) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await leaveCommunity(w1);
});

const stillAMember = armed && ownerId ? isCommunityMember(workspaceId, ownerId) : null;
// THE SCREEN'S HALF, AWAITED RATHER THAN SAMPLED. `leaveCurrentWorkspace` reports the refusal
// through the app's own log, but the round trip that produces it finishes after the click returns -
// read once, this recorded "never explained" about a client that explained it 300 ms later.
const refusalShown = armed
  ? (await awaitLine(wa.cx, caption('chat_community_no_admin_left_error'))) !== null
  : null;

// -- W2 leaves, and nothing else changes ------------------------------------------
await step('the other member leaves', async () => {
  if (!armed) return;
  await enterCommunities(w2);
  await openCommunity(w2, community);
  await leaveCommunity(w2);
});

const rosterBetween = armed
  ? await (async () => {
      const deadline = Date.now() + 20000;
      for (;;) {
        const n = workspaceFootprint(workspaceId).members;
        if (n === 1) return n;
        if (Date.now() > deadline) return n;
        await new Promise((r) => setTimeout(r, 1500));
      }
    })()
  : null;

// -- Attempt 2: the same gesture, now allowed, and it destroys the community --------
await step('the last member leaves', async () => {
  if (!armed || rosterBetween !== 1) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await leaveCommunity(w1);
});

const footprintAfter = armed
  ? await (async () => {
      const deadline = Date.now() + 25000;
      for (;;) {
        const now = workspaceFootprint(workspaceId);
        if (now.workspace === 0) return now;
        if (Date.now() > deadline) return now;
        await new Promise((r) => setTimeout(r, 1500));
      }
    })()
  : null;

// A run that could not destroy it must not leave it behind holding a live invite.
await step('remove the community if the last leave did not', async () => {
  if (!workspaceId || footprintAfter?.workspace === 0) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const expectations = {
  soleAdminWasRefused: stillAMember === true,
  // A refusal nobody explains is a button that does nothing.
  refusalWasExplained: refusalShown === true,
  peerCouldLeave: rosterBetween === 1,
  // The same gesture, the same person, the opposite outcome - and it takes the community with it.
  lastMemberCouldLeave: footprintAfter?.workspace === 0,
  // The departure of the last member is a real deletion, not a community with no members in it.
  noOrphanChannels: footprintAfter?.channels === 0,
  noOrphanMembers: footprintAfter?.members === 0,
  noOrphanRoles: footprintAfter?.roles === 0,
  noOrphanInvites: footprintAfter?.invites === 0,
  noLiveDistributionGroup: footprintAfter?.liveDistributionGroups === 0,
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);
// THE 400 IS THE MEASUREMENT, not noise: this check exists to make a request that is refused. The
// pair is narrow on purpose - this path, this status - so a 500 from the same endpoint, or a 400
// from anywhere else on the page, still breaks `clean`.
const gated = gate(verdict, {
  W1: ignoringExpectedRefusal(await report(wa), [
    { path: /\/api\/channels\/workspaces\/[0-9a-f-]+\/leave$/, status: [400] },
  ]),
  W2: await report(wb),
});

record('COMM-19', gated.verdict, {
  ...gated.detail,
  community,
  workspaceId,
  rosterBefore,
  ownerIsAdmin,
  peerIsNotAdmin,
  stillAMember,
  refusalShown,
  rosterBetween,
  footprintAfter,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
