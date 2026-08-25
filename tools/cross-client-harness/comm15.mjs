/**
 * COMM-15: a poll is created, voted on and closed - and the server never learns what it asked.
 *
 *   node comm15.mjs
 *
 * A POLL IS THE ONE CHANNEL MESSAGE THE SERVER PARTLY UNDERSTANDS, which is why this row is worth
 * running at all. Every other channel message is a body the server stores and cannot read; a poll
 * splits in two - the TALLY is server-side state (`metadata.poll`: option ids, who voted for which,
 * the deadline) because two devices must agree on a count, and the WORDS travel in the encrypted
 * body beside it. So the interesting assertion is not that voting works, it is where the seam falls:
 * the server holds every id and not one label, and the labels still reach the other client.
 *
 * READ ON BOTH SIDES, BECAUSE NEITHER ALONE IS EVIDENCE. A card showing "2 votes" proves nothing
 * about `votesByUser`, and `votesByUser` proves nothing about what either person can see. The tally
 * is therefore read from the DATABASE and the rendering from BOTH SCREENS, and each assertion says
 * which it came from.
 *
 * THE SINGLE-CHOICE REPLACEMENT IS THE ONE THAT GOES WRONG QUIETLY. `votePoll` clears the caller's
 * previous selection before recording the new one, so a second vote must REPLACE and not accumulate
 * - a defect that would leave a poll of three options reporting four votes from two people, and
 * which no screen would obviously contradict.
 *
 * CLOSING IS DRIVEN THROUGH THE NATIVE CONFIRMATION, not around it. `ChannelPoll` calls
 * `window.confirm`, the only confirmation in the product that is not the styled dialog - so
 * `answeringDialogs` answers the real one and the check asserts the app ASKED, with the app's own
 * words. Overriding `window.confirm` from the page would have measured a client nobody ships.
 *
 * IT BUILDS ITS OWN VENUE and deletes it: an auto-pinned poll left in the shared community would sit
 * at the top of a salon for every later check to read.
 */
import { apiPost, awaitMessage, client, realClick, send } from './chat.mjs';
import {
  acceptInviteLink,
  channelRow,
  closePollCard,
  composePoll,
  createChannel,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  inviteLink,
  openCommunity,
  openInviteLink,
  openPollComposer,
  pollCard,
  selectedChannel,
  votePollOption,
} from './comm.mjs';
import { channelIdOf, channelPolls, userIdOf, workspaceIdOf } from './grainedb.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, ignoringExpectedRefusal, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM15');
const community = `C15 ${run}`;
const salon = `c15-${run.toLowerCase()}`;

// THE WORDS THE SERVER MUST NEVER SEE. Marked with the run so a hit in a column is unambiguously
// this poll's and not a coincidence of vocabulary.
const question = `Question ${run} ?`;
const OPTIONS = [`Alpha ${run}`, `Beta ${run}`, `Gamma ${run}`];

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

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

/** Waits for the stored poll to satisfy `predicate`, and returns what it last saw either way. */
async function pollSettles(channelId, predicate, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const polls = channelPolls(channelId);
    if (polls.length === 1 && predicate(polls[0])) return polls[0];
    if (Date.now() > deadline) return polls.length === 1 ? polls[0] : null;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Waits for a client's card to satisfy `predicate`, and returns the last card it read. */
async function cardSettles(cx, predicate, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await pollCard(cx, question);
    if (last.present && predicate(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// -- A community of two, and a public salon ---------------------------------------------
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

await step('create the salon', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await createChannel(w1, salon, { visibility: 'public' });
});
const channelId = await step('read the salon id', () =>
  workspaceId ? channelIdOf(workspaceId, salon) : null
);
const peerId = await step('read the peer id', () => userIdOf(PEER_NAME));
const ownerId = await step('read the owner id', () => userIdOf(OWNER_NAME));

// A MESSAGE BEFORE THE POLL, and it is not decoration: it proves the salon carries traffic on both
// clients before anything is asserted about a card, so "the card never appeared" cannot be a salon
// that was never really joined.
await step('open the salon on both clients', async () => {
  await openSalon(w1);
  await enterCommunities(w2);
  await openCommunity(w2, community);
  await openSalon(w2);
});
const primed = await step('a plain message first', async () => {
  await send(w1, `${run}-primer`);
  return (await awaitMessage(w2, `${run}-primer`, 30_000)) ? true : false;
});

// -- The poll ----------------------------------------------------------------------------
await step('create the poll', async () => {
  await openSalon(w1);
  await openPollComposer(w1);
  await composePoll(w1, { question, options: OPTIONS, multiple: false });
});

const created = await step('the server stored it', () =>
  channelId ? pollSettles(channelId, (p) => !!p.poll) : null
);
const cardOnPeer = await step('the peer renders it', () =>
  cardSettles(w2, (c) => c.options.length === OPTIONS.length)
);

// Nothing below means anything unless a poll really exists on both sides.
const armed = !!workspaceId && !!channelId && !!created?.poll && cardOnPeer?.present === true;

// -- A vote, and then a SECOND one that must replace it ----------------------------------
const votedFor = OPTIONS[1];
const revotedFor = OPTIONS[2];

/**
 * The opaque id the client minted for a label, by position.
 *
 * THE ORDER IS THE ONLY BRIDGE between the two halves of a poll, and it is an assumption this check
 * makes deliberately rather than silently: the server stores `optionIds` in the order the client
 * sent the options, and holds no label to match them by. It is never trusted alone - every vote is
 * asserted BOTH by id here and by LABEL on the other client's card, and only the pair proves the
 * bridge holds.
 */
const optionIdOf = (label) => created?.poll?.optionIds?.[OPTIONS.indexOf(label)] ?? null;

const afterFirstVote = armed
  ? await step('the peer votes', async () => {
      await votePollOption(w2, question, votedFor);
      return pollSettles(channelId, (p) => (p.poll?.votesByUser?.[peerId] ?? []).length === 1);
    })
  : null;
const inviterSeesTheVote = armed
  ? await step('the author sees the tally', () =>
      cardSettles(w1, (c) => c.options.some((o) => o.label === votedFor && o.votes === 1))
    )
  : null;

const afterSecondVote = armed
  ? await step('the peer changes its mind', async () => {
      await votePollOption(w2, question, revotedFor);
      return pollSettles(
        channelId,
        (p) => (p.poll?.votesByUser?.[peerId] ?? [])[0] === optionIdOf(revotedFor)
      );
    })
  : null;

// -- Closing it, through the confirmation the app actually shows -------------------------
const closeDialogs = armed
  ? await step('the author closes the poll', async () => {
      await openSalon(w1);
      return closePollCard(w1);
    })
  : null;

const afterClose = armed
  ? await step('the server closed it', () => pollSettles(channelId, (p) => !!p.poll?.endsAt))
  : null;

// A CLOSED POLL MUST REFUSE A VOTE, and the refusal has to be the server's: the card stops offering
// the options, and a modified client would not be stopped by that.
const voteAfterClose =
  armed && afterClose?.poll?.endsAt
    ? await step('the peer votes into a closed poll', () =>
        apiPost(w2, `/api/channels/${channelId}/messages/${created.id}/poll/vote`, {
          optionIds: [optionIdOf(votedFor)],
        })
      )
    : null;

const cardAfterClose = armed ? await step('the peer sees it ended', () => cardSettles(w2, (c) => c.ended)) : null;

// THE AUTHOR'S OWN CARD, and it is the discriminator rather than a second copy of the same
// question: the author learns the new deadline from the close call's OWN response, the peer only
// from the broadcast. So the pair separates the two causes a single "the peer does not see it
// ended" cannot - a closure that never travels, from a card that never re-reads the clock.
const cardOnAuthorAfterClose = armed
  ? await step('the author sees it ended', () => cardSettles(w1, (c) => c.ended))
  : null;

// -- Its own debris goes ------------------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

/** Every word of the poll, as it must NEVER appear in a server column. */
const WORDS = [question, ...OPTIONS];
const storedText = created ? JSON.stringify({ poll: created.poll, content: created.content }) : '';

const expectations = {
  // The salon was live on both clients before any card was looked for.
  bothClientsWereInTheSalon: primed === true,
  // AUTO-PINNED, which is what makes a poll findable after a hundred messages.
  theServerPinnedIt: created?.pinned === true,
  // The tally is server-side state and starts empty, with one id per option and no labels.
  theServerHoldsOneIdPerOption: created?.poll?.optionIds?.length === OPTIONS.length,
  theServerHoldsNoLabel: !!created && !WORDS.some((w) => storedText.includes(w)),
  itIsSingleChoice: created?.poll?.multipleChoice === false,
  itHadNoDeadline: (created?.poll?.endsAt ?? null) === null,
  // THE LABELS STILL TRAVELLED, which is the other half of the same seam: encrypted, not withheld.
  thePeerSeesEveryLabel:
    Array.isArray(cardOnPeer?.options) &&
    OPTIONS.every((label) => cardOnPeer.options.some((o) => o.label === label)),
  // One card, not two - the deduplication every message kind owes.
  thePeerSeesOneCard: cardOnPeer?.cards === 1,

  // A vote is recorded against the voter, by option id.
  theVoteReachedTheServer:
    (afterFirstVote?.poll?.votesByUser?.[peerId] ?? [])[0] === optionIdOf(votedFor),
  theAuthorSawTheTally: inviterSeesTheVote?.options?.some(
    (o) => o.label === votedFor && o.votes === 1
  ),
  // SINGLE CHOICE REPLACES. Accumulating would report two votes from one person.
  theSecondVoteReplacedTheFirst:
    (afterSecondVote?.poll?.votesByUser?.[peerId] ?? []).length === 1 &&
    (afterSecondVote?.poll?.votesByUser?.[peerId] ?? [])[0] === optionIdOf(revotedFor),
  // The author never voted, so nothing may have appeared under their name.
  theAuthorsNameIsNotInTheTally: !(afterSecondVote?.poll?.votesByUser ?? {})[ownerId],

  // THE APP ASKED BEFORE CLOSING, in its own words.
  itAskedBeforeClosing: closeDialogs?.length === 1 && closeDialogs[0].type === 'confirm',
  // Closing forces the deadline into the past and UNPINS - a finished poll must not keep the top
  // of the salon.
  closingForcedTheDeadline:
    !!afterClose?.poll?.endsAt && new Date(afterClose.poll.endsAt).getTime() <= Date.now(),
  closingUnpinnedIt: afterClose?.pinned === false,
  // The server refuses a vote afterwards, whatever any screen offers.
  theServerRefusedAVoteAfterClosing: voteAfterClose?.status === 403,
  thePeerSeesItEnded: cardAfterClose?.ended === true,
  // The author closed it from this very screen, so their own card owes the answer first.
  theAuthorSeesItEnded: cardOnAuthorAfterClose?.ended === true,
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);
// The one refusal this check provokes on purpose, narrowed to the route and the status it asks for.
const gated = gate(verdict, {
  W1: await report(wa),
  W2: ignoringExpectedRefusal(await report(wb), [
    { path: new RegExp(`/poll/vote$`), status: [403] },
  ]),
});

record('COMM-15', gated.verdict, {
  ...gated.detail,
  community,
  salon,
  workspaceId,
  channelId,
  armed,
  question,
  options: OPTIONS,
  primed,
  created,
  cardOnPeer,
  afterFirstVote: afterFirstVote?.poll ?? null,
  inviterSeesTheVote,
  afterSecondVote: afterSecondVote?.poll ?? null,
  closeDialogs,
  afterClose,
  voteAfterClose,
  cardAfterClose,
  cardOnAuthorAfterClose,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
