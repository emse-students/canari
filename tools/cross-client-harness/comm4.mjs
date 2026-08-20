/**
 * COMM-4: a DIRECT invitation, and the one card it is allowed to leave on each side.
 *
 *   node comm4.mjs
 *
 * TWO WAYS INTO A COMMUNITY, AND THIS IS THE OTHER ONE. COMM-2 measures the invite LINK, where the
 * invitee acts; here the administrator acts and the invitee is a member before they have seen
 * anything. The only thing they are ever told is a card in their direct conversation - so that card
 * is not decoration, it is the entire notification, and a duplicate of it is the product saying the
 * same thing twice about something that happened once.
 *
 * THE TWO CARDS ARE NOT THE SAME CARD, and that is the first half of the row. `mkChannelInviteEnvelope`
 * names the INVITER and carries a Join button; `mkChannelInviteSentEnvelope` names the INVITEE and
 * deliberately carries none, because the sender is already inside. Asserting only "a card appeared"
 * would pass if both sides rendered the invitee's copy, which is a real way for this to break: the
 * inviter's copy exists only because MLS never hands a device back its own application message, so
 * it is INSERTED LOCALLY by `inviteMemberToChannel` and shares nothing with the path that produced
 * the other one.
 *
 * THE DEDUP IS THE SECOND HALF, AND IT IS WHAT THE RELOAD IS FOR. One invitation has three
 * independent producers - the inviter's local insert, the live `channel_invitation` event on every
 * other device, and the HISTORY REPLAY of that same MLS frame - and each would mint its own random
 * id and stack its own bubble. `channelInviteMessageId(channelId, inviteeId)` is what makes all
 * three converge, and a reload is the only gesture that puts two of them against each other on one
 * device: the invitee has the live copy on screen, and coming back up they meet the frame again.
 *
 * WHY THE THIRD PRODUCER IS NOT DRIVEN HERE. Inviting the same person twice is unreachable from the
 * product - `SidebarCommunityAdminModal` passes the current members as `excludeIds`, so the
 * autocomplete stops offering them - and reaching past the UI to the API would send no card at all,
 * since the DM is written by the client. The id still covers that case; nothing in this rig can
 * witness it, and the row does not claim otherwise.
 *
 * COUNTED PER COMMUNITY, NEVER PER WORDING. The description strings name the invitee and the
 * inviter but NOT the community, so every past run of this check leaves a card in the same shared
 * conversation that reads identically. The count is therefore taken over cards whose header carries
 * THIS run's community name - which also makes the check re-runnable, the property its own debris
 * would otherwise destroy.
 *
 * IT BUILDS ITS OWN VENUE and deletes it, because a direct invitation makes the peer a member of a
 * community and the shared one must not collect memberships from checks.
 */
import { client, ensureConversation, evaluate, goto } from './chat.mjs';
import {
  caption,
  commonTail,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  inviteToCommunity,
  openCommunity,
  saysMessage,
} from './comm.mjs';
import { communityRole, userIdOf, workspaceIdOf } from './grainedb.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM4');
const community = `C4 ${run}`;

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
 * The wording each side is supposed to be looking at, judged by its LITERAL parts.
 *
 * Never rebuilt with a name from `names.mjs`: those are what the sidebar is searched by, and a card
 * is worded with what the profile resolves to. See `saysMessage`.
 */
const SENT_KEY = 'msg_channel_invite_sent_description';
const GOT_KEY = 'msg_channel_invite_description_by';
const JOIN_TEXT = caption('msg_channel_invite_join_button');

/**
 * The tail all THREE invitation wordings share, so a card is FOUND before it is judged.
 *
 * COUNTING BY THE EXPECTED WORDING CANNOT TELL AN ABSENT CARD FROM AN UNEXPECTED ONE, and on
 * 2026-08-20 that is exactly what it produced: the invitee's card was written (`1 added` in the
 * batch) and counted zero, which reads as a delivery loss. `MessageBubble` has a third branch -
 * `msg_channel_invite_description`, the wording when the envelope carries no `inviterName` - and a
 * card rendered that way matches neither side's expected text.
 *
 * So the card is found by what every variant ends with, and what it actually SAYS is reported next
 * to the count. The zero then names its own cause instead of leaving three readings open.
 */
const DESC_TAIL = commonTail(
  'msg_channel_invite_sent_description',
  'msg_channel_invite_description_by',
  'msg_channel_invite_description'
);

/**
 * The invitation cards for ONE community in the open conversation, and whether each offers a Join.
 *
 * NO SELECTOR, BECAUSE THERE IS NO HOOK. The card carries no test id and its only distinguishing
 * markup is Tailwind colour classes, which are exactly the thing a style commit rewrites - so it is
 * found by its own text instead: the innermost element carrying the description, then the nearest
 * ancestor that carries the community name AND holds that one description alone - the header line
 * and the description are siblings inside the card, and nothing smaller than the card holds both.
 *
 * @returns `{ cards, withJoin, said }` - how many cards for this community, how many carry the
 *   button, and what each one actually says. `cards: null` means there was no conversation pane to
 *   read, which is a different finding from zero and must not be rounded into one.
 */
async function inviteCards(cx, communityName) {
  const raw = await evaluate(
    cx,
    `JSON.stringify((function () {
       var desc = ${JSON.stringify(DESC_TAIL)};
       var name = ${JSON.stringify(communityName)};
       var join = ${JSON.stringify(JOIN_TEXT)};
       var composer = document.querySelector('.chat-composer-footer .chat-composer-editor');
       var pane = composer ? composer.closest('section') : null;
       if (!pane) return { cards: null, withJoin: null, said: null };
       var holders = [].slice.call(pane.querySelectorAll('*')).filter(function (el) {
         if ((el.innerText || '').indexOf(desc) === -1) return false;
         return ![].slice.call(el.children).some(function (kid) {
           return (kid.innerText || '').indexOf(desc) !== -1;
         });
       });
       // AN ANCESTOR CARRYING THE NAME IS NOT A CARD. Every past run of this check leaves a card in
       // this same conversation, so a foreign card finds THIS run's name three levels up, in the
       // container that holds all of them - and that container was then counted as a second card.
       // Measured on 2026-08-20: six descriptions in the pane, five of them landing on one shared
       // ancestor holding all six. A root must therefore contain exactly ONE description, which is
       // what makes it a card rather than a list of them. What each card SAYS is collected here for
       // the same reason: evidence gathered wider than the count would describe another invitation.
       var roots = [];
       var said = [];
       holders.forEach(function (el) {
         var up = el;
         for (var i = 0; i < 5 && up; i++) {
           if ((up.innerText || '').indexOf(name) !== -1) {
             var alone = holders.filter(function (h) { return up.contains(h); }).length === 1;
             if (alone && roots.indexOf(up) === -1) {
               roots.push(up);
               said.push((el.innerText || '').trim());
             }
             return;
           }
           up = up.parentElement;
         }
       });
       return {
         cards: roots.length,
         withJoin: roots.filter(function (r) {
           return [].slice.call(r.querySelectorAll('button')).some(function (b) {
             return (b.innerText || '').indexOf(join) !== -1;
           });
         }).length,
         said: said,
       };
     })())`
  );
  return JSON.parse(raw);
}

/**
 * How many DIRECT-CONVERSATION rows the sidebar offers for one person.
 *
 * ASKED BECAUSE A CARD CAN BE WRITTEN AND STILL NOT BE ON SCREEN. The handler names the conversation
 * it wrote into; if a device holds TWO conversation rows for the same peer - which
 * `mergeDirectConversationDuplicates` exists because it happens - then one of them is the one a
 * person opens and the other is where the card went, and every count taken through the first is a
 * truthful zero about the wrong conversation. Two rows here is the finding; one row makes the zero
 * mean what it looks like.
 */
async function peerRows(cx, name) {
  return Number(
    await evaluate(
      cx,
      `(function () {
         var panel = document.querySelector('.sidebar-panel');
         if (!panel) return -1;
         var rows = [].slice.call(panel.querySelectorAll('button, [role=button], a, li'));
         var wanted = ${JSON.stringify(name)}.toLowerCase();
         return rows.filter(function (e) {
           var t = (e.innerText || '').trim().toLowerCase();
           return t.indexOf(wanted) === 0 && e.getBoundingClientRect().width > 0;
         }).length;
       })()`
    )
  );
}

/** Polls the open conversation until the community's card is there, or gives up and reports what is. */
async function awaitCard(cx, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await inviteCards(cx, community);
    if (seen.cards > 0) return seen;
    if (Date.now() > deadline) return seen;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// -- A community the peer is not in yet ---------------------------------------------
await step('create the community', async () => {
  await enterCommunities(w1);
  await createCommunity(w1, community);
  await openCommunity(w1, community);
});
const workspaceId = await step('read the community id', () => workspaceIdOf(community));

// -- The invitation itself -----------------------------------------------------------
await step('invite the peer directly', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await inviteToCommunity(w1, PEER_NAME, 'member');
});

// THE SERVER'S HALF, and the only thing that makes the two screens worth reading. A direct
// invitation IS a membership, not an offer: if the row is not there the invitation did not happen,
// and a missing card would then be the truth rather than a defect.
const peerJoined = await step('confirm the membership row', async () => {
  if (!workspaceId || !peerId) return null;
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (communityRole(workspaceId, peerId)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1500));
  }
});

const armed = !!workspaceId && !!peerId && peerJoined === true;

// -- What each side is shown ----------------------------------------------------------
const inviterSide = armed
  ? await step('read the inviter conversation', async () => {
      await ensureConversation(w1, PEER_NAME);
      return awaitCard(w1);
    })
  : null;

const inviteeSide = armed
  ? await step('read the invitee conversation', async () => {
      await ensureConversation(w2, OWNER_NAME);
      return awaitCard(w2);
    })
  : null;

// Taken with the conversation already open, so the sidebar is in the state the counts were read in.
const rows = armed
  ? {
      onTheInviter: await step('count the peer rows on the inviter', () => peerRows(w1, PEER_NAME)),
      onTheInvitee: await step('count the peer rows on the invitee', () => peerRows(w2, OWNER_NAME)),
    }
  : null;

// -- And what a second producer does to it --------------------------------------------
//
// `goto`, not `Page.reload`: a raw reload cancels whatever the page had in flight, and the check
// would then report its own aborted requests as dirt on the application.
const afterReload = armed
  ? await step('bring both clients back up and count again', async () => {
      await goto(w1, '/chat', { relaunch: 'the cards must be rebuilt from storage and replay' });
      await goto(w2, '/chat', { relaunch: 'the cards must be rebuilt from storage and replay' });
      await ensureConversation(w1, PEER_NAME);
      await ensureConversation(w2, OWNER_NAME);
      return {
        inviter: await awaitCard(w1),
        invitee: await awaitCard(w2),
      };
    })
  : null;

// -- Its own debris goes ---------------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const expectations = {
  // Both sides were told, IN THEIR OWN WORDS - the card is found by the tail every wording shares,
  // so "one card" and "the right card" are two assertions and a wrong one cannot read as none.
  inviterSeesTheCard: inviterSide?.cards === 1,
  inviteeSeesTheCard: inviteeSide?.cards === 1,
  inviterCardNamesTheInvitee:
    inviterSide?.said?.length === 1 && saysMessage(SENT_KEY, inviterSide.said[0]),
  inviteeCardNamesTheInviter:
    inviteeSide?.said?.length === 1 && saysMessage(GOT_KEY, inviteeSide.said[0]),
  // The only thing distinguishing the two envelopes: the person who sent it is already inside, and
  // is therefore offered nothing to join.
  onlyTheInviteeIsOfferedTheJoin: inviterSide?.withJoin === 0 && inviteeSide?.withJoin === 1,
  // ONE INVITATION, ONE BUBBLE, after the replay has had its own turn at the same frame.
  stillOneOnTheInviter: afterReload?.inviter.cards === 1,
  stillOneOnTheInvitee: afterReload?.invitee.cards === 1,
  joinSurvivedTheReload: afterReload?.inviter.withJoin === 0 && afterReload?.invitee.withJoin === 1,
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);

/**
 * What the INVITEE's device said about the invitation, kept in the record.
 *
 * A COUNT OF ZERO CARDS HAS THREE READINGS and the first run of this check could separate none of
 * them: the frame never arrived, it arrived and was refused, or it was written into a conversation
 * this check was not looking at. The dispatch line and the `[CHANNEL_INVITE]` line answer all three
 * between them, and they only exist because that run went looking for them and found the seam
 * silent. Recorded whatever the verdict is - on a PASS they are the proof the path really ran.
 */
const said = (lines) => lines.filter((l) => /System event|CHANNEL_INVITE|ADD_MSG/.test(l));
const inviteeSaid = said(linesW2);
const inviterSaid = said(linesW1);

const gated = gate(verdict, { W1: await report(wa), W2: await report(wb) });

record('COMM-4', gated.verdict, {
  ...gated.detail,
  community,
  workspaceId,
  armed,
  peerJoined,
  inviterSide,
  inviteeSide,
  rows,
  inviterSaid,
  inviteeSaid,
  afterReload,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
