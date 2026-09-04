/**
 * COMM-23 and COMM-24: a salon's visibility switch, in both directions, read from the database.
 *
 *   bun comm2324.mjs 23    a PUBLIC salon becomes private: a group is minted, the owner it grants
 *                           is routed onto it, and a reader outside `allowedUsers` is not
 *   bun comm2324.mjs 24    a PRIVATE salon becomes public: its group is tombstoned, its scope is
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
import { client, realClick } from '../chat.mjs';
import {
  channelAccessState,
  createChannel,
  enterCommunities,
  grantChannelAccess,
  inPanel,
  openChannelAccess,
  openCommunity,
  saveChannelAccess,
  selectedChannel,
  setChannelPrivate,
} from '../comm.mjs';
import {
  awaitUserRouting,
  channelIdOf,
  groupState,
  salonDistribution,
  userIdOf,
  workspaceIdOf,
} from '../grainedb.mjs';
import { OWNER_NAME, PORTS, VENUE } from '../names.mjs';
import { mark, record } from '../results.mjs';
import { consoleLines, gate, report, watch } from '../watch.mjs';

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

// WHOSE ACCESS THE FLIP TO PRIVATE HAS TO PRESERVE. Read from the database rather than assumed,
// because `allowedUsers` holds ids and the only thing this rig knows is a display name.
const ownerId = await step('read the owner id', () => userIdOf(OWNER_NAME));

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

// THE FLIP TO PRIVATE GRANTS THE OWNER, AND THAT IS THE PRODUCT'S RULE RATHER THAN THIS CHECK'S
// CONVENIENCE. The access panel submits the allowlist it is holding, and for a salon that was public
// that list is EMPTY - so a save with nobody added produces the state the app warns about in as many
// words (`chat_no_allowed_members_warning`: "le canal sera inaccessible"), and since the 2026-08-19
// removal of ambient admin access it locks the actor out too. This check used to do exactly that and
// then assert a panel read-back the design forbids: measured 2026-08-25, `GET :channelId/access ->
// 403` with every database fact about the switch already correct. Granting the owner is also the
// MIRROR of the state COMM-24 starts from - creating a salon private grants its creator - so the two
// halves of the switch now begin and end in the same shape.
await step('flip the visibility', async () => {
  await realClick(w1, `[aria-label*=${JSON.stringify(salon)}]`);
  if ((await selectedChannel(w1)) !== salon) throw new Error('the salon did not open');
  await openChannelAccess(w1);
  const moved = await setChannelPrivate(w1, !startPrivate);
  if (!moved) throw new Error('the toggle was already where the check wanted it');
  // A grant is staged and committed by the save, so it belongs INSIDE the open panel and before it.
  if (!startPrivate) await grantChannelAccess(w1, OWNER_NAME);
  return saveChannelAccess(w1);
});

// THE MEMBER COMMITS ITS OWN ADD, so the entitlement above buys nothing until the owner LOADS the
// salon - and the salon has been open throughout, opened BEFORE the group existed. Leaving and
// coming back is what gives the client a reason to look. Without it the new group would sit at epoch
// 0 with an empty delivery roster, and the check would call a mint a success while nothing was
// routed anywhere - the shape COMM-22 paid a whole run to learn.
const routed = !startPrivate
  ? await step('route the owner onto the new group', async () => {
      // The community LIST, not a sibling channel: landing on the list is what unmounts the pane,
      // and re-entering the community is part of opening a salon rather than the caller's business -
      // COMM-22 lost six cycles to that exact omission.
      await enterCommunities(w1);
      await openCommunity(w1, VENUE.community);
      await realClick(w1, `[aria-label*=${JSON.stringify(salon)}]`);
      if ((await selectedChannel(w1)) !== salon) throw new Error('the salon did not re-open');
      return channelId && ownerId ? awaitUserRouting(channelId, ownerId, true) : null;
    })
  : null;

// A FRESH PANEL, BECAUSE THE SAVE CLOSED THE OLD ONE. Reading the state at the end of the flip
// answered `{isPrivate: null, allowed: [], writePolicy: null}` on every run: `saveChannelAccess`
// ends with `clearOverlays`, deliberately, so the read found no toggle and reported the instrument
// rather than the app - and `panelAgrees` then compared null with a boolean and failed a switch that
// had worked. Reading BEFORE the save would have been worse than useless: it would have echoed the
// click this check just made, not the app's answer. A reopened panel refetches, so what it states is
// the SERVER's view arriving on a screen - the same reason COMM-14 waits for the radiogroup instead
// of seeding a level. `inPanel` hands the screen back either way, including when the read throws.
const panel = await step('read the visibility back off a fresh panel', () =>
  inPanel(w1, openChannelAccess, () => channelAccessState(w1))
);

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
      // THE MIRROR OF COMM-24's `rosterEmptied`, and until 2026-08-25 this half asserted NOTHING
      // about the roster in any form: it read a group into existence and never asked whether anybody
      // was on it. Three separate facts, for the same reason COMM-24 keeps its three apart. The
      // allowlist is the ENTITLEMENT, and it is asserted EXACTLY - a flip that granted more than it
      // was asked to is as wrong as one that granted nobody.
      ownerAllowed:
        !!ownerId &&
        after?.allowedUsers.length === 1 &&
        after.allowedUsers[0].toLowerCase() === ownerId.toLowerCase(),
      // The delivery roster is what a seed frame is actually fanned out to, so this is the fact that
      // says the switch DID something: the salon's seeds now travel on a group somebody is on.
      ownerRouted: routed?.ok === true,
      // THERE IS DELIBERATELY NO EPOCH ASSERTION ON THIS PATH, and the first draft of this check
      // got it wrong: it demanded the epoch move past 0 and failed a switch that was correct. THE
      // CREATOR'S OWN LEAF COSTS NO COMMIT - the owner's client CREATES the group with itself
      // already in it, which is epoch 0 by construction. Measured 2026-08-25 next to COMM-24's
      // `before`, where the same account's salon sat at epoch 1: that 1 was the SECOND device
      // joining, not the first. An epoch here would therefore be asserting how many devices the
      // owner happens to own. `after.epoch` is recorded instead, and `ownerRouted` is the fact.
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
  // RECORDED, NEVER ASSERTED - there is no budget for this in the product, and inventing one here
  // would be the check deciding a requirement.
  ownerRoutedInMs: routed?.elapsedMs ?? null,
  panel,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${lines.length} console lines =====`);
for (const l of lines) console.log(`  ${l}`);

w1.close();
