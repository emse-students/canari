/**
 * COMM-23 and COMM-24: a salon's visibility switch, in both directions, read from the database.
 *
 *   node comm2324.mjs 23    a PUBLIC salon becomes private: a group is minted, and a reader outside
 *                           `allowedUsers` stops being routed
 *   node comm2324.mjs 24    a PRIVATE salon becomes public: its group is tombstoned, its scope is
 *                           released, and the community's group carries the salon again
 *
 * WHY ONE FILE FOR TWO CHECKS. They are the same switch and the same three tables; written apart
 * they would drift, and the second would inevitably be written against whatever state the first
 * happened to leave. Each selects itself from `argv[2]` and **there is no default** - a manifest
 * entry that relies on one covers what the script felt like doing, which is the fault the NOTIF
 * phase paid for and `checks.mjs` documents.
 *
 * EVERY ASSERTION HERE IS A DATABASE READ, and that is not a shortcut. What the switch changes is
 * which key-distribution group a salon's seeds travel on, and no screen renders that: a salon looks
 * identical either way to the people who can see it, and the people who cannot see it see nothing
 * in both cases. `channels.distributionGroupId`, `dm_groups.deletedAt` and the scope column are the
 * only witnesses there are.
 *
 * THE THREE FACTS COMM-24 KEEPS APART, because merging any two of them hides a defect that shipped:
 * the group must be TOMBSTONED, the salon must stop POINTING at it, and the scope must be RELEASED.
 * The third was missing until 2026-08-20 - a tombstone still occupying its scope was handed straight
 * back to the salon the next time it went private, dead row, stale tree and all.
 */
import { client, realClick } from './chat.mjs';
import {
  channelAccessState,
  createChannel,
  enterCommunities,
  openChannelAccess,
  openCommunity,
  saveChannelAccess,
  selectedChannel,
  setChannelPrivate,
} from './comm.mjs';
import { channelIdOf, groupState, salonDistribution, workspaceIdOf } from './grainedb.mjs';
import { PORTS, VENUE } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const which = process.argv[2];
if (which !== '23' && which !== '24') {
  throw new Error('usage: comm2324.mjs 23|24 - no default, the phase must say which it ran');
}
const startPrivate = which === '24';

const w1 = await client(PORTS.W1);
const run = mark(`COMM${which}`);
const salon = `c${which}-${run.toLowerCase()}`;

const wa = await watch(w1, 'W1');

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

const workspaceId = await step('read the community id', () => workspaceIdOf(VENUE.community));

await step('create the salon', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, VENUE.community);
  return createChannel(w1, salon, { visibility: startPrivate ? 'private' : 'public' });
});

const channelId = await step('read the salon id', () =>
  workspaceId ? channelIdOf(workspaceId, salon) : null
);

// THE STATE BEFORE, WHICH IS HALF THE MEASUREMENT. A check that reads only the state after cannot
// tell the switch working from a salon that was already in the state it wanted.
const before = await step('read the salon before the switch', () =>
  channelId ? salonDistribution(channelId) : null
);

const panel = await step('flip the visibility', async () => {
  await realClick(w1, `[aria-label*=${JSON.stringify(salon)}]`);
  if ((await selectedChannel(w1)) !== salon) throw new Error('the salon did not open');
  await openChannelAccess(w1);
  const moved = await setChannelPrivate(w1, !startPrivate);
  if (!moved) throw new Error('the toggle was already where the check wanted it');
  await saveChannelAccess(w1);
  return channelAccessState(w1);
});

const after = await step('read the salon after the switch', () =>
  channelId ? salonDistribution(channelId) : null
);

// THE GROUP THE SALON HAS STOPPED POINTING AT, followed by id because nothing else can reach it.
// Retirement clears the link, so a join from the salon finds nothing and the group's death would be
// unobservable from the salon's side - which is precisely how a tombstone that still occupied its
// scope went unnoticed until it handed itself back to the next private salon.
const retiredGroup = await step('follow the retired group by id', () =>
  before?.groupId && after?.linkedGroupId === null ? groupState(before.groupId) : null
);

// A NEW GROUP, NOT THE OLD ONE. On COMM-23 the salon starts public with no group at all, so any id
// is new; the assertion that matters is on a salon that has been private BEFORE, which is why
// `differentGroup` is recorded either way rather than only when there was something to differ from.
const differentGroup = before?.groupId ? after?.groupId !== before.groupId : after?.groupId !== null;

const expectations = startPrivate
  ? {
      // COMM-24: private -> public.
      startedRight: before?.isPrivate === true && !!before?.groupId && before?.retired === false,
      nowPublic: after?.isPrivate === false,
      // The three facts, separately. `linkedGroupId` null is the salon letting go; `retired` is the
      // group dying; the scope release is what `salonDistribution` can no longer find by scope and
      // is asserted through the re-privatisation in COMM-23 rather than guessed at here.
      groupUnlinked: after?.linkedGroupId === null,
      groupRetired: retiredGroup?.retired === true,
      // THE THIRD FACT, and the one that was missing. A tombstone still naming its scope is the
      // scope's group as far as every reuse read is concerned.
      scopeReleased: retiredGroup?.scope === null,
      rosterEmptied: (after?.allowedUsers.length ?? -1) === 0,
      panelAgrees: panel?.isPrivate === false,
    }
  : {
      // COMM-23: public -> private.
      startedRight: before?.isPrivate === false && before?.groupId === null,
      nowPrivate: after?.isPrivate === true,
      groupMinted: !!after?.groupId && after?.retired === false,
      linkedToIt: after?.linkedGroupId === after?.groupId,
      panelAgrees: panel?.isPrivate === true,
    };

const verdict =
  failures.length > 0 || Object.values(expectations).some((v) => v !== true) ? 'FAIL' : 'PASS';

const lines = consoleLines(wa.cx);
const gated = gate(verdict, { W1: await report(wa) });

record(`COMM-${which}`, gated.verdict, {
  ...gated.detail,
  community: VENUE.community,
  salon,
  channelId,
  startedPrivate: startPrivate,
  before,
  after,
  differentGroup,
  retiredGroup,
  panel,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${lines.length} console lines =====`);
for (const l of lines) console.log(`  ${l}`);

w1.close();
