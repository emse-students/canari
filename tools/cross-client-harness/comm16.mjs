/**
 * COMM-16: deleting a channel, then the whole community, and what must be left behind - nothing.
 *
 *   node comm16.mjs
 *
 * THE ROW CHANGED MEANING ON 2026-08-18 and this is written against what deletion IS now. It used to
 * ask that a deleted community's slug stay RESERVED, which was true of a soft delete: the row
 * survived, tombstoned, and went on holding the name. Deletion became a real delete, so the
 * assertion inverted - the name must be FREE again - and a check still asking the old question would
 * fail a correct server.
 *
 * IT IS ASKED OF THE TABLES, NOT OF THE SIDEBAR. "The community is gone" read off a screen is a
 * statement about one client's cache, and the failure this row exists to catch is precisely the one
 * a screen cannot show: a workspace row deleted while its members, its roles, its invitations or its
 * key-distribution group survive, each pointing at something that no longer exists. Those are
 * counted per table.
 *
 * IT BUILDS ITS OWN VENUE AND DESTROYS IT, which is the only check in this phase that can say that.
 * Everything else leaves debris on purpose so a failure can be read afterwards; here the destruction
 * IS the subject, so there is nothing to preserve - and a check that deleted the campaign's shared
 * community to prove a point would end the campaign.
 *
 * IT FOUND ONE, ON ITS FIRST RUN. `channelRowGone` came back false and the reflex was to soften the
 * question - the row survives by design, archiving is a product decision, the check is wrong. It was
 * not: `DELETE /channels/:id` set `archived = true` and, in the same call, destroyed the group
 * holding the salon's seeds, so a private salon ended as ciphertext no client keeps a key for,
 * invisible to every listing and removable only by deleting its community. That is the shape the
 * community's own deletion had rejected two days earlier, one scope up. The server was changed; this
 * assertion is unchanged, and it is here because a check that had been relaxed to match the code
 * would have proved the defect correct for as long as anyone cared to look.
 *
 * THE MESSAGES ARE ASKED FOR SEPARATELY, because nothing in this schema cascades - there is not one
 * foreign key on `channels`. A delete that took the row and left its messages would pass every
 * assertion above and leave exactly the orphan this row exists to catch.
 *
 * THE SLUG IS PROVED FREE BY USING IT, not by reading a table twice. A second community created with
 * the same name either gets the same slug or it does not, and that is the fact a person would meet.
 */
import { client, realClick } from './chat.mjs';
import {
  createChannel,
  createCommunity,
  deleteChannel,
  deleteCommunity,
  enterCommunities,
  openCommunity,
} from './comm.mjs';
import {
  channelExists,
  channelIdOf,
  channelMessageCount,
  slugTaken,
  workspaceFootprint,
  workspaceIdOf,
} from './grainedb.mjs';
import { PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const wa = await watch(w1, 'W1');

const run = mark('COMM16');
const community = `C16 ${run}`;
const channel = `c16-${run.toLowerCase()}`;

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

// -- Build something worth deleting -------------------------------------------
await step('create the community and a channel in it', async () => {
  await enterCommunities(w1);
  await createCommunity(w1, community);
  await openCommunity(w1, community);
  await createChannel(w1, channel);
});

const workspaceId = await step('read the community id', () => workspaceIdOf(community));
const channelId = await step('read the channel id', () =>
  workspaceId ? channelIdOf(workspaceId, channel) : null
);
const footprintBefore = workspaceId ? workspaceFootprint(workspaceId) : null;

// Nothing below means anything if the community was never really created - a run that asserts the
// absence of rows that never existed is the purest form of a vacuous pass.
const armed = !!workspaceId && !!channelId && footprintBefore?.channels >= 1;

// -- The channel ---------------------------------------------------------------
await step('delete the channel', async () => {
  if (!armed) return;
  await realClick(w1, `[aria-label*=${JSON.stringify(channel)}]`);
  await deleteChannel(w1);
});

const channelGone = armed
  ? await (async () => {
      const deadline = Date.now() + 20000;
      for (;;) {
        if (!channelExists(channelId)) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 1500));
      }
    })()
  : null;

const channelMessagesAfter = armed ? channelMessageCount(channelId) : null;
const footprintAfterChannel = armed && workspaceId ? workspaceFootprint(workspaceId) : null;

// -- The community, by typing its name -----------------------------------------
await step('delete the community', async () => {
  if (!armed) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const footprintAfter = armed && workspaceId
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

// -- Is the name free again ----------------------------------------------------
const slugBefore = footprintBefore?.slug ?? null;
const slugFreeInTable = slugBefore ? !slugTaken(slugBefore) : null;

// PROVED BY USING IT. A second community of the same name is what a person would actually do, and
// whether it gets the same slug is the answer they would actually get.
const reused = armed
  ? await step('create a second community with the same name', async () => {
      await enterCommunities(w1);
      await createCommunity(w1, community);
      const again = workspaceIdOf(community);
      return again ? { id: again, slug: workspaceFootprint(again).slug } : null;
    })
  : null;

// Its own debris goes too - this check destroys what it makes, and that includes the proof.
await step('delete the second community', async () => {
  if (!reused) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});
const secondGone = reused ? workspaceFootprint(reused.id).workspace === 0 : null;

const expectations = {
  channelRowGone: channelGone === true,
  noOrphanChannelMessages: channelMessagesAfter === 0,
  // The channel goes and the community does NOT go with it.
  communitySurvivedItsChannel: footprintAfterChannel?.workspace === 1,
  workspaceRowGone: footprintAfter?.workspace === 0,
  // Every table that pointed at it, at zero. A row surviving here is an orphan nothing will report.
  noOrphanChannels: footprintAfter?.channels === 0,
  noOrphanMembers: footprintAfter?.members === 0,
  noOrphanRoles: footprintAfter?.roles === 0,
  noOrphanInvites: footprintAfter?.invites === 0,
  noLiveDistributionGroup: footprintAfter?.liveDistributionGroups === 0,
  // The name, by both routes.
  slugFreeInTable: slugFreeInTable === true,
  slugReusable: !!reused && reused.slug === slugBefore,
  cleanedUpAfterItself: secondGone === true,
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const lines = consoleLines(wa.cx);
const gated = gate(verdict, { W1: await report(wa) });

record('COMM-16', gated.verdict, {
  ...gated.detail,
  community,
  channel,
  workspaceId,
  channelId,
  footprintBefore,
  channelMessagesAfter,
  footprintAfterChannel,
  footprintAfter,
  slugBefore,
  slugOfSecond: reused?.slug ?? null,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${lines.length} console lines =====`);
for (const l of lines) console.log(`  ${l}`);

w1.close();
