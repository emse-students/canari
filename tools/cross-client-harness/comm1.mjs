/**
 * COMM-1: a community, a channel, a message - and both peers converge on it.
 *
 *   node comm1.mjs
 *
 * THE FIRST CHECK OF THE PHASE, and therefore the one that proves `comm.mjs` at all. Every gesture
 * in that module was written against the source and has never been run against a client; a check
 * that is really testing the app cannot also be the first thing to discover that a caption moved.
 * So this one is deliberately the whole vocabulary in order - create, open, create a channel, post,
 * read - and its failures are worth reading twice before they are believed about the app.
 *
 * WHAT IT ASKS, precisely: that a community created on W1 becomes reachable to W2 through the
 * invitation W1 mints, that a channel created in it appears on both, and that a message posted in
 * that channel arrives at the other peer. Three separate things, and the record says which of them
 * held - a single boolean here would answer "the phase does not work" and nothing more.
 *
 * IT LEAVES ITS DEBRIS BEHIND, on purpose. Deleting the community at the end would delete the
 * evidence of a failure with it, and the campaign's cleanup is a separate, deliberate step
 * (`cleanup.mjs`) run when the debris is no longer worth reading.
 */
import { client, countMessage, send, traceArrival } from './chat.mjs';
import {
  channelRow,
  control,
  createChannel,
  createCommunity,
  enterCommunities,
  inPanel,
  inviteLink,
  openCommunity,
  openCommunitySettings,
  selectedChannel,
} from './comm.mjs';
import { goto, realClick, until } from './chat.mjs';
import { PORTS } from './names.mjs';
import { mark, record, unmet } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const run = mark('COMM1');
const community = `C1 ${run}`;
const channel = `c1-${run.toLowerCase()}`;

// Attached BEFORE the first gesture, unlike the MSG checks: those open a conversation that already
// exists, while this one creates everything it touches, so the boot chatter is not separable from
// the work and the work is what is under test.
const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    // NAMED, NOT SWALLOWED, and the run continues: a check that stops at the first refusal reports
    // one fact where it could have reported five, and the later steps are exactly what says whether
    // the cause was this gesture or the state it left behind.
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

await step('createCommunity', () => createCommunity(w1, community));
const link = await step('inviteLink', () =>
  inPanel(w1, openCommunitySettings, () => inviteLink(w1))
);

// W2 JOINS THROUGH THE LINK, which is the only path a second account has into a community it did
// not create. The join page carries no app shell, so nothing here may wait on one - a settle that
// waits for the sidebar times out on a page that has none, which is the fault `invite.mjs` paid for.
const joined = await step('join', async () => {
  if (!link) throw new Error('no invite link to join with');
  await goto(w2, new URL(link).pathname, { relaunch: 'the join page has no click path' });
  await until(w2, `document.body.innerText.length > 0`, 15000);
  // The caption is READ from the app's own messages, like every other one in this phase: a French
  // literal here would be the exact drift `comm.mjs` refuses to allow, and would break under
  // `--locale en` on a client that is not running French.
  const accept = await realClick(w2, control('community_join_btn'));
  await until(w2, `location.pathname.indexOf('/c/join') === -1`, 25000);
  return accept.received ?? null;
});

await step('openCommunity(W1)', () => openCommunity(w1, community));
await step('createChannel', () => createChannel(w1, channel));

// POLLED, NOT READ ONCE, and that is the whole difference between this row and a coin toss. The
// channel was created on W1 a moment ago and reaches W2 over the socket, so `channelRow` - one
// synchronous DOM read with no settle of its own - answers `present:false` for a row that is simply
// not painted yet. It did exactly that on 2026-08-27 and cost COMM-1 a FAIL the run's own later
// steps contradicted: W2 went on to CLICK that channel by `aria-label` and `selectedChannel(w2)`
// returned it, the message arrived in 291 ms, and both copies were 1. The same unchanged runner had
// recorded `present:true` on the previous build, which is what a race looks like in a ledger.
//
// It returns what it settled at rather than throwing, like `railSettlingAt` in COMM-17: an absent
// row after the deadline is the finding, and reporting the absence is more use than a stack trace.
const onW2 = await step('openCommunity(W2)', async () => {
  await enterCommunities(w2);
  await openCommunity(w2, community);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = await channelRow(w2, channel);
    if (row?.present === true) return row;
    if (Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 500));
  }
});

// The channel is opened by NAME on both sides, and the selection is read back from `aria-current` -
// the only witness there is, since selecting a channel changes no url.
const openedOn = await step('open the channel', async () => {
  await realClick(w1, `[aria-label=${JSON.stringify(channel)}]`);
  await realClick(w2, `[aria-label=${JSON.stringify(channel)}]`);
  return { w1: await selectedChannel(w1), w2: await selectedChannel(w2) };
});

const marker = mark('COMM1MSG');
const sentAt = await step('send', () => send(w1, `COMM-1 ${marker}`));
const trace = sentAt
  ? await traceArrival(w2, marker, { timeoutMs: 25000, settleMs: 3000 })
  : { firstSeen: null, lost: null, samples: [], last: null };

const copies = sentAt ? { w1: await countMessage(w1, marker), w2: await countMessage(w2, marker) } : null;

// NAMED RATHER THAN DISJOINED, so a failure says which half of the row broke. As a bare `||` chain
// this recorded `[FAIL] ... "failures":[]` - nine terms, one of them fired, and nothing said which.
const expectations = {
  communityHasAnInviteLink: !!link,
  channelReachesThePeer: onW2?.present === true,
  channelOpensOnBothSides: openedOn?.w1 === channel && openedOn?.w2 === channel,
  messageArrived: trace.firstSeen !== null,
  messageStayedArrived: trace.lost === null,
  exactlyOneCopyEachSide: copies?.w1 === 1 && copies?.w2 === 1,
};
failures.push(...unmet(expectations));

const verdict = failures.length > 0 ? 'FAIL' : 'PASS';

const raw = [
  ['W1', consoleLines(wa.cx)],
  ['W2', consoleLines(wb.cx)],
];
const obs = { W1: await report(wa), W2: await report(wb) };
const gated = gate(verdict, obs);

record('COMM-1', gated.verdict, {
  ...gated.detail,
  community,
  channel,
  inviteLink: link ? new URL(link).pathname : null,
  joinClick: joined,
  channelOnPeer: onW2,
  selected: openedOn,
  marker,
  sentAt,
  latencyMs: trace.firstSeen,
  lostAgainMs: trace.lost,
  copies,
  ...expectations,
  failures,
});

for (const [label, lines] of raw) {
  console.log(`\n===== ${label}: ${lines.length} console lines =====`);
  for (const l of lines) console.log(`  ${l}`);
}

w1.close();
w2.close();
