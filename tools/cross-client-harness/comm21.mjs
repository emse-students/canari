/**
 * COMM-21: someone is removed from a private salon with a half-written message still on screen.
 *
 *   node comm21.mjs
 *
 * THE INTERESTING MOMENT IS NOT THE REMOVAL, IT IS WHAT THE REMOVED PERSON IS HOLDING. Every other
 * COMM row about access asks what a member may reach; this one asks what happens to the one thing
 * the product lets them hold privately - an unsent draft in an open composer - at the instant the
 * salon stops being theirs. The failure it is looking for is the app leaving them in a salon that
 * no longer exists for them: a composer that still accepts typing, a send that fails with a red
 * error rather than an explanation, or a sidebar row that stays until a reload.
 *
 * THE DRAFT ITSELF IS RECORDED, NOT ASSERTED. A draft is component state - the campaign's own
 * negative rows say so, switching conversation already loses it - so demanding that it survive
 * would be a check inventing a feature. What IS asserted is that the person is not left typing into
 * a salon they have been removed from.
 *
 * THREE PLACES MUST AGREE, and each is read where it actually lives: the salon's ROSTER
 * (`allowedUsers`), the DELIVERY roster of its distribution group - which is what a seed frame is
 * fanned out to, and the only evidence that a removed member stops being SENT anything - and the
 * SCREEN. A check reading only the screen would pass while the server kept posting them seeds.
 *
 * THE PROBE IS THE SAME REQUEST TWICE, refused for two different reasons, as in COMM-7: a
 * session-less body reaches the write check first, so it comes back 400 while the member is still
 * in the salon and 403 once they are not. Without the 400 the 403 could equally be a malformed
 * probe, and the check would be reporting a removal while measuring its own request.
 *
 * IT BUILDS ITS OWN VENUE and deletes it.
 */
import {
  apiPost,
  armComposer,
  awaitMessage,
  client,
  countMessage,
  evaluate,
  fireComposer,
  realClick,
  send,
} from './chat.mjs';
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
  revokeChannelAccess,
  saveChannelAccess,
  selectedChannel,
} from './comm.mjs';
import { channelIdOf, salonDistribution, userIdOf, workspaceIdOf } from './grainedb.mjs';
import { PEER_NAME, PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, ignoringExpectedRefusal, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM21');
const community = `C21 ${run}`;
const salon = `c21-${run.toLowerCase()}`;

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

/** The body that reaches the write check and can never reach the database. */
const PROBE = { ciphertext: 'comm21-probe', nonce: 'comm21-probe' };

/** What the composer currently holds, and whether it is still offered at all. */
async function composerState(cx) {
  return JSON.parse(
    await evaluate(
      cx,
      `JSON.stringify((function () {
         var el = document.querySelector('.chat-composer-footer .chat-composer-editor');
         if (!el) return { present: false, editable: false, draft: null };
         return {
           present: true,
           editable: el.isContentEditable === true && el.getAttribute('aria-disabled') !== 'true',
           draft: (el.innerText || '').trim(),
         };
       })())`
    )
  );
}

/** Opens the salon on a client already inside the community, waiting for the row to arrive first. */
async function openSalon(cx) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if ((await channelRow(cx, salon)).present) break;
    if (Date.now() > deadline) throw new Error('the salon never appeared in the sidebar');
    await new Promise((r) => setTimeout(r, 1500));
  }
  await realClick(cx, `[aria-label*=${JSON.stringify(salon)}]`);
  const open = await selectedChannel(cx);
  if (open !== salon) throw new Error(`wrong salon open: ${JSON.stringify(open)}`);
}

/** Waits for the removal to reach a client's own screen, and reports what it settled on. */
async function screenSettles(cx, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = {
      row: (await channelRow(cx, salon)).present,
      open: await selectedChannel(cx),
      composer: await composerState(cx),
    };
    if (!last.row && last.open !== salon) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// -- A private salon with two people in it -----------------------------------------------
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

await step('create the private salon', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await createChannel(w1, salon, { visibility: 'private' });
});
const channelId = await step('read the salon id', () =>
  workspaceId ? channelIdOf(workspaceId, salon) : null
);
const peerId = await step('read the peer id', () => userIdOf(PEER_NAME));

await step('let the peer in', async () => {
  await openSalon(w1);
  await openChannelAccess(w1);
  await grantChannelAccess(w1, PEER_NAME);
  await saveChannelAccess(w1);
});

// -- Arming: the peer is really in, and really writing ------------------------------------
const beforeMarker = `${run}-in`;
const peerWroteBefore = await step('the peer posts while it may', async () => {
  await enterCommunities(w2);
  await openCommunity(w2, community);
  await openSalon(w2);
  await send(w2, beforeMarker);
  return (await awaitMessage(w1, beforeMarker, 30_000)) ? true : false;
});

// The positive control, taken while the peer is still a member of the salon.
const probeBefore = await step('probe the write check as a member', () =>
  channelId ? apiPost(w2, `/api/channels/${channelId}/messages`, PROBE) : null
);

const routedBefore = await step('the peer is routed the salon seeds', () =>
  channelId ? salonDistribution(channelId) : null
);

// THE HALF-WRITTEN MESSAGE. Armed and deliberately NOT fired - this is the state the row is about.
const draft = `${run}-half-written`;
const composerBefore = await step('the peer starts typing', async () => {
  await armComposer(w2, draft);
  return composerState(w2);
});

const armed =
  !!workspaceId &&
  !!channelId &&
  !!peerId &&
  peerWroteBefore === true &&
  probeBefore?.status === 400 &&
  composerBefore?.draft === draft;

// -- The removal, while that draft is on screen -------------------------------------------
const revoked = armed
  ? await step('remove the peer from the salon', async () => {
      await openSalon(w1);
      // Scoped, so the backdrop is gone before W1 is read again below - `countMessage` would still
      // have found the pane's text under it, which is exactly how this class of fault survives a run
      // and fails the next check that needs to CLICK something.
      return inPanel(w1, openChannelAccess, () => revokeChannelAccess(w1, PEER_NAME));
    })
  : null;

const screenAfter = armed ? await step('what the peer is left with', () => screenSettles(w2)) : null;

// WHATEVER THE SCREEN DID, THE SERVER DECIDES. Read after the screen so a client that closed the
// salon instantly is not credited with a refusal it never asked for.
const probeAfter = armed
  ? await step('probe the write check after the removal', () =>
      apiPost(w2, `/api/channels/${channelId}/messages`, PROBE)
    )
  : null;

const routedAfter = armed ? await step('the peer is no longer routed', () => salonDistribution(channelId)) : null;

// THE END-TO-END HALF: if a composer is somehow still offered, firing it must land nothing.
const sentAnyway =
  armed && screenAfter?.composer?.editable && screenAfter?.open === salon
    ? await step('the peer sends the draft anyway', async () => {
        await fireComposer(w2).catch(() => null);
        await new Promise((r) => setTimeout(r, 8000));
        return (await countMessage(w1, draft)) > 0;
      })
    : null;

// -- Its own debris goes ------------------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const namesPeer = (dist) =>
  (dist?.devices ?? []).some((d) => String(d.userId ?? '').toLowerCase() === String(peerId).toLowerCase());

const expectations = {
  // THE ROSTER, read from the COLUMN and not from the panel that was just used to change it: a
  // check that saves a setting and reads it back off the same screen has asked one component twice.
  thePeerWasOnTheRoster: (routedBefore?.allowedUsers ?? []).some(
    (u) => u.toLowerCase() === String(peerId).toLowerCase()
  ),
  theRosterDropsThePeer: !(routedAfter?.allowedUsers ?? []).some(
    (u) => u.toLowerCase() === String(peerId).toLowerCase()
  ),
  // THE DELIVERY ROSTER, which is the only evidence they stop being SENT anything.
  thePeerWasRoutedBefore: namesPeer(routedBefore) === true,
  thePeerIsNoLongerRouted: namesPeer(routedAfter) === false,
  // THE SCREEN. Not "a toast appeared" - the salon must stop being a place this person is in.
  theSalonLeavesTheSidebar: screenAfter?.row === false,
  theConversationCloses: screenAfter?.open !== salon,
  // THE SERVER'S OWN REFUSAL, and the control that makes it attributable.
  theProbeReachedTheWriteCheck: probeBefore?.status === 400,
  theServerRefusesThePeer: probeAfter?.status === 403 || probeAfter?.status === 404,
  // Nothing the peer was holding may land afterwards.
  nothingTheDraftBecameLanded: sentAnyway !== true,
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);
const gated = gate(verdict, {
  W1: await report(wa),
  W2: ignoringExpectedRefusal(await report(wb), [
    { path: new RegExp(`/api/channels/${channelId}/messages$`), status: [400, 403, 404] },
  ]),
});

record('COMM-21', gated.verdict, {
  ...gated.detail,
  community,
  salon,
  workspaceId,
  channelId,
  armed,
  peerWroteBefore,
  probeBefore,
  probeAfter,
  routedBefore,
  routedAfter,
  revoked,
  composerBefore,
  screenAfter,
  sentAnyway,
  // RECORDED, NOT ASSERTED: a draft is component state and the product never promised to keep it.
  // Worth a figure in the record so a decision to keep drafts has a before to compare with.
  draftSurvived: screenAfter?.composer?.draft === draft,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
