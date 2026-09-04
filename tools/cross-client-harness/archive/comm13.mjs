/**
 * COMM-13: an administrator JOINS a private salon, and the salon records nothing about it.
 *
 *   bun comm13.mjs
 *
 * THIS ROW MEASURES A DESIGN DECISION, NOT A FEATURE. Until 2026-08-20 an administrator held every
 * private salon's key by construction - one distribution group per community - and what kept a
 * private salon private from them was the server declining to serve it. Now each private salon has
 * its own group, so an administrator reaches one by JOINING it, in one click, and their name lands
 * in its member list where the people inside can see it. The old arrangement gave them the contents
 * and showed their presence to nobody; this one is the trade, and the row exists to hold both ends
 * of it.
 *
 * FOUR ASSERTIONS, AND THE LAST TWO ARE THE ONES THAT CAN ROT:
 *
 *   the SIDEBAR shows the salon with a join affordance and nothing behind it. Read from the row's
 *   accessible name, which is a different string entirely when the salon is unjoined - so this is
 *   the product's own statement about the state, not a colour a screenshot would have to judge;
 *
 *   the SERVER refuses before and serves after. `GET /channels/:id/distribution-group` is the one
 *   endpoint that decides whether a device may be handed the salon's keys at all, so it is the
 *   question worth asking - 403 before the join, 200 after. Asked from the admin's OWN page and
 *   AUTHENTICATED (`apiGet`): a bare credentialed fetch answers 401, and 401 says the endpoint
 *   never looked at the account, which would report a perfect access rule for a rule that was gone;
 *
 *   the MEMBER LIST gains their name. Read from the DATABASE, because the whole point is what the
 *   people already in the salon can see - and `allowedUsers` is what the roster reconciliation
 *   diffs the MLS tree against, so a join that did not reach it is a leaf that gets removed again;
 *
 *   the TRANSCRIPT gains NOTHING. An assertion of ABSENCE, counted rather than looked at: a
 *   permanent line in a conversation recording that it is being read is a different thing from
 *   letting its members see who reads it, and the decision was to have the second without the
 *   first. Nothing else in the product would ever complain if a system message appeared here.
 *
 * THE ADMIN HAS TO BE SOMEBODY ELSE. W1 creates the salon, so W1 is inside it; the join can only be
 * measured on an administrator who is not. W2 is therefore promoted to admin BEFORE the salon
 * exists, and the promotion is verified against the roles table rather than assumed - an unjoined
 * row shown to a plain member would be a different defect wearing this check's clothes.
 *
 * IT BUILDS ITS OWN VENUE and destroys it, because it promotes a member and leaves a salon with two
 * administrators in it - neither of which the shared community should inherit.
 */
import { apiGet, client, evaluate, realClick } from '../chat.mjs';
import {
  acceptInviteLink,
  caption,
  captionWith,
  createChannel,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  inviteLink,
  openCommunity,
  openInviteLink,
  selectedChannel,
  setMemberRole,
} from '../comm.mjs';
import {
  channelIdOf,
  channelMessageCount,
  communityRole,
  salonDistribution,
  userIdOf,
  workspaceIdOf,
} from '../grainedb.mjs';
import { PEER_NAME, PORTS } from '../names.mjs';
import { mark, record } from '../results.mjs';
import { consoleLines, gate, ignoringExpectedRefusal, report, watch } from '../watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM13');
const community = `C13 ${run}`;
const salon = `c13-${run.toLowerCase()}`;

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

/**
 * The salon's row as the sidebar names it, or null when no row carries either name.
 *
 * TWO DIFFERENT ACCESSIBLE NAMES, and that is the whole reading. `Sidebar.svelte` gives an unjoined
 * private salon the "join as administrator" name and a joined one the "private channel" name, on
 * the SAME button - so which one is present says which state the product believes it is in, in the
 * product's own words rather than in a colour or an opacity.
 */
async function sidebarState(cx, name) {
  const joinName = captionWith('chat_channel_join_as_admin_aria', { name });
  // A PREFIX for the joined case and an exact match for the other, because only one of them can
  // grow: a joined row appends its unread count to the same label, an unjoined one serves nothing
  // and can have none.
  const privateName = `${caption('chat_channel_private_label')} ${name}`;
  return evaluate(
    cx,
    `(function () {
       var buttons = [].slice.call(document.querySelectorAll('button[aria-label]'));
       for (var i = 0; i < buttons.length; i++) {
         var label = buttons[i].getAttribute('aria-label') || '';
         if (label === ${JSON.stringify(joinName)}) return 'unjoined';
         if (label.indexOf(${JSON.stringify(privateName)}) === 0) return 'joined';
       }
       return 'absent';
     })()`
  );
}

// -- A community, an administrator who is not the creator, and a private salon ------
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

await step('promote the peer to administrator', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await setMemberRole(w1, PEER_NAME, 'admin');
});

// Read rather than assumed: an unjoined row shown to a plain MEMBER is a different defect, and it
// would pass every assertion below while measuring the opposite of this row.
const peerIsAdmin = await step('confirm the promotion in the roles table', async () => {
  if (!workspaceId || !peerId) return null;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (communityRole(workspaceId, peerId) === 'admin') return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1500));
  }
});

// W1 creates it, so W1 is in it. The peer is the administrator this row is about.
await step('create the private salon without the peer', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await createChannel(w1, salon, { visibility: 'private' });
});
const channelId = await step('read the salon id', () =>
  workspaceId ? channelIdOf(workspaceId, salon) : null
);

// -- Before the join ----------------------------------------------------------------
const before = await step('read the salon from the peer, before joining', async () => {
  await enterCommunities(w2);
  await openCommunity(w2, community);
  const deadline = Date.now() + 25_000;
  for (;;) {
    const state = await sidebarState(w2, salon);
    if (state !== 'absent') return state;
    if (Date.now() > deadline) return state;
    await new Promise((r) => setTimeout(r, 1500));
  }
});

const keysBefore = await step('ask the server for the salon keys, as the peer', async () => {
  if (!channelId) throw new Error('no salon id to ask about');
  return apiGet(w2, `/api/channels/${channelId}/distribution-group`);
});

const rosterBefore = channelId ? salonDistribution(channelId)?.allowedUsers ?? null : null;
const transcriptBefore = channelId ? channelMessageCount(channelId) : null;

// Nothing below means anything unless the peer really is an administrator standing OUTSIDE a salon
// the server is really refusing them.
const armed =
  !!workspaceId &&
  !!channelId &&
  !!peerId &&
  peerIsAdmin === true &&
  before === 'unjoined' &&
  keysBefore?.status === 403;

// -- The join, which is one click on that same row ---------------------------------
await step('join the salon as the administrator', async () => {
  if (!armed) return;
  const joinName = captionWith('chat_channel_join_as_admin_aria', { name: salon });
  await realClick(w2, `button[aria-label=${JSON.stringify(joinName)}]`);
});

const after = armed
  ? await (async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const state = await sidebarState(w2, salon);
        if (state === 'joined') return state;
        if (Date.now() > deadline) return state;
        await new Promise((r) => setTimeout(r, 1500));
      }
    })()
  : null;

// A SECOND CLICK, and deliberately so. The join does not select the salon - `joinPrivateChannelAsAdmin`
// re-reads the workspaces from the server rather than flipping a local flag, because joining changes
// what four routes answer. So the row has to become an ordinary one and then be opened like any
// other, which is also the only thing that proves the salon is now readable rather than merely
// listed.
const opened =
  armed && after === 'joined'
    ? await step('open it', async () => {
        await realClick(w2, `[aria-label*=${JSON.stringify(salon)}]`);
        return selectedChannel(w2);
      })
    : null;

const keysAfter = armed
  ? await (async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const answer = await apiGet(w2, `/api/channels/${channelId}/distribution-group`).catch(
          () => null
        );
        if (answer?.status === 200) return answer;
        if (Date.now() > deadline) return answer;
        await new Promise((r) => setTimeout(r, 2000));
      }
    })()
  : null;

const rosterAfter = armed
  ? await (async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const list = salonDistribution(channelId)?.allowedUsers ?? null;
        if (list && peerId && list.includes(peerId)) return list;
        if (Date.now() > deadline) return list;
        await new Promise((r) => setTimeout(r, 1500));
      }
    })()
  : null;

// AN ABSENCE, AND THEREFORE A WINDOW. Read after the roster has already moved, so the transcript has
// had every chance a system message would have needed - an absence sampled before the state settled
// would be a pass nobody could argue with.
const transcriptAfter = armed ? channelMessageCount(channelId) : null;

// -- Its own debris goes -------------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const expectations = {
  // The salon EXISTS for them and serves nothing until they act.
  sawItUnjoined: before === 'unjoined',
  serverRefusedTheKeysBefore: keysBefore?.status === 403,
  // One click, and the same row becomes the salon itself.
  oneClickJoined: after === 'joined',
  itOpened: opened === salon,
  serverServesTheKeysAfter: keysAfter?.status === 200,
  // Not tidiness: the roster reconciliation diffs the MLS tree against this list, so a join that
  // did not reach it is a leaf removed again at the next pass.
  theSalonSeesThem: Array.isArray(rosterAfter) && !!peerId && rosterAfter.includes(peerId),
  theSalonDidNotSeeThemBefore:
    Array.isArray(rosterBefore) && !!peerId && !rosterBefore.includes(peerId),
  // THE DECISION, ASSERTED AS AN ABSENCE. Presence is visible in the member list; it is deliberately
  // not written into the conversation, and nothing else in the product would complain if it were.
  transcriptRecordedNothing:
    typeof transcriptBefore === 'number' && transcriptAfter === transcriptBefore,
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);
// THE 403 IS THE MEASUREMENT, not noise: this check exists to be refused the salon's keys before it
// joins. Narrow on purpose - this path, this status - so a 403 from anywhere else still breaks
// `clean`, and so does a 500 from this one.
const gated = gate(verdict, {
  W1: await report(wa),
  W2: ignoringExpectedRefusal(await report(wb), [
    { path: new RegExp(`/api/channels/${channelId}/distribution-group$`), status: [403] },
  ]),
});

record('COMM-13', gated.verdict, {
  ...gated.detail,
  community,
  salon,
  workspaceId,
  channelId,
  armed,
  peerIsAdmin,
  before,
  after,
  opened,
  keysBefore: keysBefore?.status ?? null,
  keysAfter: keysAfter?.status ?? null,
  rosterBefore,
  rosterAfter,
  transcriptBefore,
  transcriptAfter,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
