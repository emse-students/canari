/**
 * COMM-3: the four ways an invite link stops working, and the one control proving they are refusals.
 *
 *   bun comm3.mjs
 *
 * COMM-2 PROVED A LINK WORKS. This asks what happens when it should not, which is the half a
 * permissive server passes by accident: every assertion here is a REFUSAL, and a check made only of
 * refusals passes perfectly against a preview that is simply broken. So the rotated case previews
 * BOTH tokens - the revoked one must be refused AND the new one accepted, in the same run, on the
 * same client. That positive control is the reason the rotated case is here at all.
 *
 * FOUR CASES, ONE ANSWER, AND THAT IS THE PRODUCT'S DECISION. The server answers all four with the
 * same 404 and the client draws the same sentence, deliberately - an invite page that distinguished
 * "expired" from "never existed" would tell a stranger which tokens are real. So the check's value
 * is not in the answers, which are identical, but in the ARMING: each of the four states has to be
 * shown to really exist before its refusal means anything, and each is armed a different way.
 *
 *   expired  - aged in the database, because no interface can produce it (see arm.mjs). The panel's
 *              shortest expiry is a day away, and deleting the row would test "no invite" instead.
 *   used up  - `maxUses = 1`, then W2 really joins and really leaves. The row is consumed by the
 *              product, not by a write, and leaving does not give a use back.
 *   revoked  - regenerated. There is no revoke control: one live link at a time IS the revocation,
 *              which is why the panel warns that regenerating kills the previous one.
 *   orphaned - the community deleted under it. Since 2026-08-18 that leaves no row at all, so the
 *              link points at nothing rather than at a tombstone.
 *
 * EACH CASE BUILDS AND DESTROYS ITS OWN COMMUNITY. They cannot share one: three of the four are
 * states of THE community's single live invite, and a shared venue would have them overwrite each
 * other in whatever order the cases happened to run.
 */
import { client } from '../chat.mjs';
import {
  acceptInviteLink,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  inviteLink,
  leaveCommunity,
  openCommunity,
  openInviteLink,
  rotateInvite,
  setInviteBounds,
} from '../comm.mjs';
import { expireInvite } from '../arm.mjs';
import { isCommunityMember, userIdOf, workspaceIdOf } from '../grainedb.mjs';
import { PEER_NAME, PORTS } from '../names.mjs';
import { mark, record } from '../results.mjs';
import { consoleLines, gate, report, watch } from '../watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM3');

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

/** Builds a community for one case, hands its id and link to `body`, then destroys it whatever happened. */
async function inItsOwnCommunity(label, body) {
  const community = `C3 ${label} ${run}`;
  await step(`${label}: create the community`, async () => {
    await enterCommunities(w1);
    await createCommunity(w1, community);
    await openCommunity(w1, community);
  });
  const workspaceId = await step(`${label}: read the community id`, () => workspaceIdOf(community));
  let outcome = null;
  try {
    outcome = workspaceId ? await body({ community, workspaceId }) : null;
  } catch (e) {
    failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // ALWAYS, even after a failure: a case that dies half way must not leave a community behind
  // holding a live invite, which is precisely the debris the next case would then trip over.
  await step(`${label}: delete the community`, async () => {
    if (!workspaceId) return;
    await enterCommunities(w1);
    await openCommunity(w1, community);
    await deleteCommunity(w1, community);
  });
  return { community, workspaceId, ...(outcome || {}) };
}

// -- expired ---------------------------------------------------------------------
const expired = await inItsOwnCommunity('expired', async ({ workspaceId }) => {
  const link = await inviteLink(w1);
  const aged = expireInvite(workspaceId);
  const preview = await openInviteLink(w2, link);
  return { aged, preview };
});

// -- used up ---------------------------------------------------------------------
const usedUp = await inItsOwnCommunity('usedup', async ({ community, workspaceId }) => {
  await setInviteBounds(w1, { maxUses: 1 });
  // Bounds apply at MINT, and this community has never had a link - so the FIRST mint carries them
  // and `inviteLink` is the gesture that performs it. Rotating would be the move on a community
  // that already has one, and refuses here by design rather than silently minting the first.
  const link = await inviteLink(w1);

  const first = await openInviteLink(w2, link);
  if (first.valid) await acceptInviteLink(w2);
  const joined = peerId ? isCommunityMember(workspaceId, peerId) : null;

  await step('usedup: leave the community on W2', async () => {
    await enterCommunities(w2);
    await openCommunity(w2, community);
    await leaveCommunity(w2);
  });
  const left = peerId ? !isCommunityMember(workspaceId, peerId) : null;

  // The same token, now that its one use is spent. Leaving gives no use back.
  const second = await openInviteLink(w2, link);
  return { first, joined, left, second };
});

// -- revoked by rotation, WITH the positive control --------------------------------
const revoked = await inItsOwnCommunity('revoked', async () => {
  const old = await inviteLink(w1);
  const fresh = await rotateInvite(w1);
  const previewOld = await openInviteLink(w2, old);
  const previewFresh = await openInviteLink(w2, fresh);
  return { differs: !!old && !!fresh && old !== fresh, previewOld, previewFresh };
});

// -- orphaned: the community deleted under the link ---------------------------------
const orphanCommunity = `C3 orphan ${run}`;
const orphan = await step('orphan: build, mint, destroy', async () => {
  await enterCommunities(w1);
  await createCommunity(w1, orphanCommunity);
  await openCommunity(w1, orphanCommunity);
  const link = await inviteLink(w1);
  await deleteCommunity(w1, orphanCommunity);
  const gone = workspaceIdOf(orphanCommunity) === null;
  const preview = await openInviteLink(w2, link);
  return { gone, preview };
});

// Every case must have been ARMED, or its refusal is a statement about a link that was never in the
// state it names - which is how a check of refusals passes against a preview that refuses everything.
const armed =
  !!peerId &&
  expired.aged === 1 &&
  usedUp.joined === true &&
  usedUp.left === true &&
  revoked.differs === true &&
  orphan?.gone === true;

const expectations = {
  expiredIsRefused: expired.preview?.valid === false,
  usedUpWasReallySpent: usedUp.first?.valid === true,
  usedUpIsRefused: usedUp.second?.valid === false,
  revokedIsRefused: revoked.previewOld?.valid === false,
  // THE POSITIVE CONTROL. Without it every line above is satisfied by a broken preview.
  rotationMintedAWorkingLink: revoked.previewFresh?.valid === true,
  orphanedIsRefused: orphan?.preview?.valid === false,
  // A refusal that still admitted somebody would be the only outcome worse than accepting.
  peerIsNowInNoneOfThem: [expired, usedUp, revoked].every(
    (c) => !c.workspaceId || !peerId || !isCommunityMember(c.workspaceId, peerId)
  ),
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);
const gated = gate(verdict, { W1: await report(wa), W2: await report(wb) });

record('COMM-3', gated.verdict, {
  ...gated.detail,
  // Tokens are never recorded - `results.ndjson` lives outside the work tree so a credential cannot
  // be committed, and a live invite is one. What is recorded is what each preview DECIDED.
  expired: { aged: expired.aged, preview: expired.preview },
  usedUp: { first: usedUp.first, joined: usedUp.joined, left: usedUp.left, second: usedUp.second },
  revoked: {
    differs: revoked.differs,
    previewOld: revoked.previewOld,
    previewFresh: revoked.previewFresh,
  },
  orphan,
  armed,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
