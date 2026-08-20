/**
 * COMM-2: an invite link, from minting it to being a member because of it.
 *
 *   node comm2.mjs
 *
 * IT IS THE PRIMITIVE THE REST OF THE PHASE IS WAITING ON. COMM-11, COMM-12 and COMM-19 each need a
 * SECOND member in a community they built themselves, and there is exactly one gesture in the
 * product that puts one there without a pre-existing DM. So this row is not only its own assertion -
 * everything after it inherits whatever this proves, which is why the join is asserted against the
 * membership table and not against a sidebar that has been wrong before.
 *
 * THE PREVIEW IS ASSERTED, NOT JUST THE ACCEPT. A link's whole purpose is telling you what you are
 * about to join BEFORE you join it, and a preview that renders an empty name - or refuses a link the
 * server considers perfectly good - is invisible from the database and invisible to a check that
 * only looks for a membership row afterwards. The name shown to W2 is compared to the name W1 typed.
 *
 * ONE LIVE LINK, AND READING IT AGAIN GIVES THE SAME ONE. That is the rule the invite rework
 * settled - a link nobody can enumerate is not revocable, so there is one, and rotation is the only
 * way to mint another. Read twice, ten seconds apart, from the same panel: two different tokens
 * would mean the panel mints on open, which is how a revoked link goes on working.
 *
 * IT BUILDS ITS OWN VENUE AND DESTROYS IT. The shared community cannot be used: W2 is already in it,
 * so a join would assert nothing, and the interesting state - "not a member, then a member" - only
 * exists somewhere W2 has never been. Deleted at the end for the same reason COMM-16 deletes its
 * own, and by the same gesture.
 *
 * THE ROLE IS PART OF IT. A join that landed someone as an administrator would pass every assertion
 * about membership and be a governance hole; `communityRole` reads what they actually got.
 */
import { client } from './chat.mjs';
import {
  acceptInviteLink,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  inviteLink,
  openCommunity,
  openInviteLink,
} from './comm.mjs';
import {
  communityRole,
  isCommunityMember,
  userIdOf,
  workspaceFootprint,
  workspaceIdOf,
} from './grainedb.mjs';
import { PEER_NAME, PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM2');
const community = `C2 ${run}`;

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

// -- W1 builds a community W2 has never been in ---------------------------------
await step('create the community', async () => {
  await enterCommunities(w1);
  await createCommunity(w1, community);
  await openCommunity(w1, community);
});

const workspaceId = await step('read the community id', () => workspaceIdOf(community));
// The membership tables are keyed by user id; `PEER_NAME` is a DISPLAY name and matches no row.
const peerId = await step('resolve the peer user id', () => userIdOf(PEER_NAME));

// The premise, checked rather than assumed: W2 must NOT already be a member, or "they joined" is a
// statement about a row that was there before the check started.
const peerBefore = workspaceId && peerId ? isCommunityMember(workspaceId, peerId) : null;

const link = await step('mint the invite link', () => inviteLink(w1));

// ONE LIVE LINK. Read again from a freshly opened panel - if the panel mints on open, this differs.
const linkAgain = await step('read the link a second time', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, community);
  return inviteLink(w1);
});

const armed =
  !!workspaceId && !!peerId && peerBefore === false && !!link && link.includes('/c/join/');

// -- W2 follows it ---------------------------------------------------------------
const preview = armed ? await step('preview the link on W2', () => openInviteLink(w2, link)) : null;

await step('accept the invitation', async () => {
  if (!preview?.valid) return;
  await acceptInviteLink(w2);
});

const peerAfter = armed
  ? await (async () => {
      const deadline = Date.now() + 20000;
      for (;;) {
        if (isCommunityMember(workspaceId, peerId)) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 1500));
      }
    })()
  : null;

const peerRole = peerAfter ? communityRole(workspaceId, peerId) : null;
const footprint = workspaceId ? workspaceFootprint(workspaceId) : null;

// -- Its own debris goes ----------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});
const venueGone = workspaceId ? workspaceFootprint(workspaceId).workspace === 0 : null;

const expectations = {
  linkIsAJoinUrl: !!link && link.includes('/c/join/'),
  // Reading it again gives the same token: one live link, rotation the only way to mint another.
  linkIsStable: !!link && link === linkAgain,
  previewAccepted: preview?.valid === true,
  // What the link is FOR: it names what you are about to join, before you join it.
  previewNamesTheCommunity: preview?.name === community,
  peerBecameMember: peerAfter === true,
  // A join must not hand out governance. `communityRole` answers in canonical vocabulary, not in
  // the French label the column stores.
  peerJoinedAsAMember: peerRole === 'member',
  // Two members and no more - a join that duplicated a row would still satisfy the check above.
  exactlyTwoMembers: footprint?.members === 2,
  cleanedUpAfterItself: venueGone === true,
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);
const gated = gate(verdict, { W1: await report(wa), W2: await report(wb) });

record('COMM-2', gated.verdict, {
  ...gated.detail,
  community,
  workspaceId,
  peerBefore,
  peerId: peerId ? `${peerId.slice(0, 8)}...` : null,
  // The token is NOT recorded: `results.ndjson` lives outside the work tree precisely so a
  // credential cannot be committed, and a live invite is one. Its SHAPE is the assertion.
  linkPath: link ? new URL(link).pathname.replace(/\/[^/]+$/, '/<token>') : null,
  preview,
  peerRole,
  footprint,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
