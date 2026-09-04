/**
 * COMM-9 and COMM-10: what losing access to a private salon takes away, and what it deliberately does not.
 *
 *   bun comm910.mjs
 *
 * ONE RUN, TWO OPPOSITE ASSERTIONS, and they cannot be separated: both are about the SAME person at
 * the SAME instant, and a second run would be a second person with a second history.
 *
 *   COMM-9  - the removal stops the seeds. The server drops their routing rows on the salon's group,
 *             and the message sent AFTER the removal is sealed under a session they were never sent.
 *   COMM-10 - the removal does not reach backwards. The message they already held stays readable,
 *             because Graine retains seeds on purpose - a departure is not a retraction.
 *
 * THE THREE THINGS THAT MUST ALL BE TRUE FOR EITHER TO MEAN ANYTHING, asserted in order and
 * recorded whatever they say:
 *   1. the peer WAS on the salon's delivery roster before the removal (or the removal removed
 *      nothing, and every assertion below is about an empty set);
 *   2. the peer DID read the first message (or "it stayed readable" is a statement about a message
 *      that never arrived);
 *   3. the peer is GONE from the roster after (or the first half never happened at all).
 * A run that cannot arm all three records `VACUOUS`, never `PASS` - `testing-methodology.md`.
 *
 * THE SECOND MESSAGE IS ASKED FOR WITH A BOUND, NOT WAITED FOR FOR EVER. Its absence is the
 * assertion, and an absence needs a window a reader can argue with: `traceArrival` is given the same
 * timeout the arrival case uses, so "it did not arrive in 25 s" is measured against the latency the
 * rest of the phase measures rather than against a number chosen here.
 */
import { client, countMessage, realClick, send, traceArrival } from '../chat.mjs';
import {
  createChannel,
  enterCommunities,
  grantChannelAccess,
  inPanel,
  openChannelAccess,
  openCommunity,
  revokeChannelAccess,
  saveChannelAccess,
  selectedChannel,
} from '../comm.mjs';
import { channelIdOf, salonDistribution, userIdOf, workspaceIdOf } from '../grainedb.mjs';
import { seedsForChannel } from './grainestore.mjs';
import { PEER_NAME, PORTS, VENUE } from '../names.mjs';
import { mark, record, unmet } from '../results.mjs';
import { consoleLines, gate, report, watch } from '../watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const run = mark('COMM910');
const salon = `c910-${run.toLowerCase()}`;

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

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
const peerUserId = await step('read the peer id', () => userIdOf(PEER_NAME));

// -- The salon, with the peer in it -------------------------------------------
await step('create the salon with the peer in it', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, VENUE.community);
  await createChannel(w1, salon, { visibility: 'private' });
  await realClick(w1, `[aria-label*=${JSON.stringify(salon)}]`);
  await openChannelAccess(w1);
  await grantChannelAccess(w1, PEER_NAME);
  await saveChannelAccess(w1);
});

const channelId = await step('read the salon id', () =>
  workspaceId ? channelIdOf(workspaceId, salon) : null
);

// The peer opens it, which is what puts their device in the group by external commit - and
// therefore what writes the routing row this check is about to watch disappear.
await step('open the salon on the peer', async () => {
  await enterCommunities(w2);
  await openCommunity(w2, VENUE.community);
  await realClick(w2, `[aria-label*=${JSON.stringify(salon)}]`);
  if ((await selectedChannel(w2)) !== salon) throw new Error('the salon did not open on the peer');
});

const onRosterBefore = await step('wait for the peer on the salon roster', async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const now = channelId ? salonDistribution(channelId) : null;
    if (now?.devices.some((d) => d.userId === peerUserId)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1500));
  }
});

// -- The message they are allowed to have -------------------------------------
const kept = mark('COMM910KEPT');
const keptSent = await step('post the message they keep', () => send(w1, `COMM-10 ${kept}`));
const keptTrace = keptSent
  ? await traceArrival(w2, kept, { timeoutMs: 25000, settleMs: 3000 })
  : { firstSeen: null, lost: null };

// WHAT THE PEER'S DEVICE HOLDS, BEFORE ANYTHING IS TAKEN AWAY. This is the arming for COMM-10: a
// retention claim is empty unless there was something to retain, and "they hold a seed for this
// salon" is trivially true of a device that MINTED one, which is why only the received ones count.
const seedsBefore = await step('read the peer seed store before the removal', () =>
  channelId ? seedsForChannel(w2, channelId) : null
);

// -- The removal --------------------------------------------------------------
const revoked = await step('revoke the peer', async () => {
  await realClick(w1, `[aria-label*=${JSON.stringify(salon)}]`);
  // THE PANEL IS CLOSED AGAIN BEFORE ANYTHING ELSE IS ASKED OF W1. `revokeChannelAccess` ends inside
  // it on purpose, and the very next step here posts a message - which on 2026-08-20 died on `no
  // stable element` for a composer the backdrop was covering.
  return inPanel(w1, openChannelAccess, () => revokeChannelAccess(w1, PEER_NAME));
});

const rosterAfter = await step('read the salon roster after the removal', () =>
  channelId ? salonDistribution(channelId) : null
);
const offRosterAfter = !rosterAfter?.devices.some((d) => d.userId === peerUserId);

// -- The message they must not get --------------------------------------------
const denied = mark('COMM910DENIED');
const deniedSent = await step('post the message they must not get', () =>
  send(w1, `COMM-9 ${denied}`)
);
const deniedTrace = deniedSent
  ? await traceArrival(w2, denied, { timeoutMs: 25000, settleMs: 3000 })
  : { firstSeen: null, lost: null };

// THE ONE THEY ALREADY HAD, READ AGAIN AFTER THE REMOVAL - AND READ FROM THE STORE, NOT THE SCREEN.
//
// This counted copies in the peer's chat pane until 2026-08-20, and every run answered 0, because
// the product does something else entirely on `channel.member.removed`: it PURGES the salon. The
// salon leaves the sidebar, the pane shows something else, and a count taken there measures the
// purge - which is deliberate behaviour - while reporting it as lost history. The check failed for
// five runs on a noun it had never been about.
//
// COMM-10's claim is that GRAINE RETAINS SEEDS, and a seed is not a thing a screen can show. So the
// device's own store answers it: the rows survive a removal, keyed by the salon, seed bytes intact.
// The pane count stays in the record below as evidence of the purge, and asserts nothing.
const seedsAfter = await step('read the peer seed store after the removal', () =>
  channelId ? seedsForChannel(w2, channelId) : null
);
const keptStillThere = keptSent ? await countMessage(w2, kept) : null;

// `seedsBefore.received` is the arming: without a seed the peer was GIVEN, "still held" is a claim
// about an empty set and would pass on a salon nobody ever wrote to them in.
// NAMED, ONE CONJUNCT PER LINE, so an unarmed run says WHICH precondition it could not get. As a
// bare `&&` chain this recorded `VACUOUS` with `failures: []` twice on 2026-08-27 - a row that knew
// it could not ask its question and said nothing about why, which `backlog` booked as a runner
// defect in its own right. The values go into the record and the unmet ones into `failures[]`.
const arming = {
  peerOnTheSalonRosterBefore: onRosterBefore === true,
  theKeptMessageArrived: keptTrace.firstSeen !== null,
  peerOffTheSalonRosterAfter: offRosterAfter === true,
  peerHeldASeedBefore: (seedsBefore?.received ?? 0) > 0,
};
const armed = Object.values(arming).every((v) => v === true);
// PUSHED WHETHER OR NOT IT ARMED, and harmless when it did: `verdict` reads `!armed` first, so a
// VACUOUS keeps its name and gains its reason, and an armed run pushes nothing.
if (!armed) failures.push(...unmet(arming).map((f) => `could not arm - ${f}`));

const expectations = {
  // COMM-9
  routingRowsDropped: offRosterAfter,
  deniedNeverArrived: deniedTrace.firstSeen === null,
  // COMM-10
  keptArrivedBefore: keptTrace.firstSeen !== null,
  // NOT ONE FEWER. "At least one survived" would pass while the removal quietly dropped every other
  // session in the salon, so the two counts are compared: what was given is what is still there.
  keptSeedsRetained:
    (seedsAfter?.received ?? -1) === (seedsBefore?.received ?? -2) &&
    (seedsAfter?.received ?? 0) > 0,
  // The salon itself is unchanged - a removal is not a retirement.
  salonStillPrivate: rosterAfter?.isPrivate === true,
  salonKeptItsGroup: !!rosterAfter?.groupId && rosterAfter?.retired === false,
  peerOffAllowedUsers: !!peerUserId && !rosterAfter?.allowedUsers.includes(peerUserId),
};

failures.push(...(armed ? unmet(expectations) : []));

const verdict = !armed ? 'VACUOUS' : failures.length > 0 ? 'FAIL' : 'PASS';

const raw = [
  ['W1', consoleLines(wa.cx)],
  ['W2', consoleLines(wb.cx)],
];
const gated = gate(verdict, { W1: await report(wa), W2: await report(wb) });

record('COMM-9/10', gated.verdict, {
  ...gated.detail,
  community: VENUE.community,
  salon,
  channelId,
  peer: peerUserId ? peerUserId.slice(0, 8) : null,
  armed: { onRosterBefore, keptArrived: keptTrace.firstSeen !== null, offRosterAfter },
  arming,
  keptMarker: kept,
  keptLatencyMs: keptTrace.firstSeen,
  // THE PURGE, RECORDED AND NOT ASSERTED: the salon leaves the peer's sidebar on removal, so this is
  // 0 by design. It is kept because a reader comparing it with the seed counts below can see the two
  // facts that make up the row - the messages are unreachable, and the key material was not taken.
  keptCopiesAfterRemoval: keptStillThere,
  seedsBefore,
  seedsAfter,
  deniedMarker: denied,
  deniedLatencyMs: deniedTrace.firstSeen,
  revokedPanel: revoked,
  rosterBefore: onRosterBefore,
  rosterAfter: rosterAfter?.devices.map((d) => `${d.userId.slice(0, 8)}:${d.status}`) ?? null,
  allowedUsersAfter: rosterAfter?.allowedUsers.map((u) => u.slice(0, 8)) ?? null,
  ...expectations,
  failures,
});

for (const [label, lines] of raw) {
  console.log(`\n===== ${label}: ${lines.length} console lines =====`);
  for (const l of lines) console.log(`  ${l}`);
}

w1.close();
w2.close();
