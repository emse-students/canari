/**
 * COMM-12: re-invited after a removal - what comes next arrives, what was missed does not come back.
 *
 *   node comm12.mjs
 *
 * THE ROW IS A CONDITIONAL, so it is run TWICE with one variable changed and nothing else. "The past
 * only as `history_visibility` allows" cannot be checked by watching a single community: a refusal
 * observed under `joined` is indistinguishable from history that never works at all, and an arrival
 * observed under `shared` is indistinguishable from a rule nobody enforces. The two arms are the
 * SAME function called with a different argument, so every difference between them is the setting.
 *
 * THE MECHANISM IS BINARY, AND THAT IS NOT AN APPROXIMATION. `gatherCommunityHistory` returns null
 * outright under `joined` - no bundle is sent at all - and under `shared` it sends every seed the
 * answering device holds. There is no per-message filtering anywhere, and the server holds no key
 * with which to do any. So a newcomer under `joined` reads what is minted after them only because
 * those seeds are distributed live to everyone; nothing older can ever reach them.
 *
 * REMOVAL WIPES THE SEEDS LOCALLY (`purgeWorkspaceLocally` -> `forgetCommunityGraine`), which is
 * what makes the second half of this row sharp. A re-invited member is not a member resuming: they
 * are a newcomer again, holding nothing, asking the same history question and getting the same
 * answer. Under `joined` that costs them what they COULD read before they were removed, permanently.
 * Under `shared` all of it comes back, including the window they were absent for. Both are asserted.
 *
 * EVERY ABSENCE IS MEASURED BEHIND A POSITIVE ANCHOR. W1 posts a fresh message after each join and
 * W2 must RECEIVE it before any refusal is sampled - otherwise "not readable" is only "not yet", and
 * the check would report a defect every time the network was slow. The anchor also proves the pane
 * is alive and on the right channel, which is the other way an absence lies.
 *
 * AND THE ANCHOR ALONE IS NOT ENOUGH, which the first version of this check got wrong. The anchor is
 * a LIVE message, so it proves the live seed reached W2 and says nothing whatever about the HISTORY
 * BUNDLE, which travels on a different exchange and may still be in flight. Sampling once behind it
 * would have accused the `shared` arm of refusing the past whenever the bundle happened to land
 * second - the same fault COMM-19 shipped days earlier by reading an async log the instant a click
 * returned. So every reading here is polled to the SAME bounded window in BOTH arms: an arrival
 * returns as soon as it renders, a refusal spends the whole window before it is believed, and the
 * two arms are therefore compared over identical patience.
 *
 * FOUR MESSAGES PER ARM, EACH MINTED IN A DIFFERENT RELATION TO W2:
 *
 *   PAST  - before W2 ever joined         -> history, under the rule
 *   IN1   - while W2 was a member         -> live, then wiped by the removal
 *   OUT   - while W2 was removed          -> history, under the rule
 *   IN2   - after W2 was re-invited       -> live again, and it must arrive in BOTH arms
 *
 * TWO MEMBERS IS A PRECONDITION, NOT A CONVENIENCE. The history question is answered by ONE member -
 * `resolveAnswerer` picks the lowest OTHER member - so with exactly W1 and W2 in the community, W1 is
 * necessarily the answerer and is necessarily online, because this check is driving it. Add a third
 * member and the answerer might be someone else, possibly offline, and a refusal here would stop
 * meaning "the rule was applied" and start meaning "nobody was there to apply it". Any later row
 * that wants three members must arm that separately.
 *
 * IT BUILDS AND DESTROYS ITS OWN VENUES. The shared community cannot be used: this check removes W2
 * from a community and sets a Graine policy on it, and every other row in the phase needs neither.
 */
import { awaitMessage, client, realClick, sample, send } from './chat.mjs';
import {
  acceptInviteLink,
  createChannel,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  inviteLink,
  listCommunities,
  openCommunity,
  openInviteLink,
  removeCommunityMember,
  selectedChannel,
  setHistoryVisibility,
} from './comm.mjs';
import {
  channelIdOf,
  channelMessageCount,
  historyVisibilityOf,
  isCommunityMember,
  userIdOf,
  workspaceIdOf,
} from './grainedb.mjs';
import { PEER_NAME, PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM12');

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

/**
 * How long a message is given to become readable before its absence is called a refusal.
 *
 * ONE CONSTANT, USED BY BOTH ARMS, because the arms are only comparable if they were equally
 * patient. It is generous on purpose: an arrival costs nothing here (the poll returns the moment the
 * marker renders), so the only thing a wide window buys is time spent on the refusals - and paying
 * it is what makes those refusals worth reporting.
 */
const READ_WINDOW_MS = 25000;

/**
 * Polls the receiver until the marker is READ, or until the window closes.
 *
 * RETURNS THE LAST SAMPLE EITHER WAY, so an absence still carries the facts that say what its zero
 * means - the composer's presence, the pane's size, the whole body's count and which conversation
 * the header names. A zero off a dead pane is a harness fault wearing the costume of a refusal, and
 * `reads`/`refuses` below both insist on `composer` for exactly that reason.
 */
async function readWithin(cx, marker, timeoutMs = READ_WINDOW_MS) {
  const started = Date.now();
  for (;;) {
    const s = await sample(cx, marker);
    const waitedMs = Date.now() - started;
    if (s?.composer === true && s.count > 0) return { ...s, waitedMs };
    if (waitedMs > timeoutMs) return { ...s, waitedMs, windowExhausted: true };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Puts W2 in the community by its live link, and says whether the server agrees they are in. */
async function joinAsPeer(workspaceId, peerId) {
  const link = await inviteLink(w1);
  const preview = await openInviteLink(w2, link);
  if (!preview.valid) throw new Error(`the invite preview refused the link: ${preview.name}`);
  await acceptInviteLink(w2);
  return !!peerId && isCommunityMember(workspaceId, peerId);
}

/** Opens the arm's channel on W2 and waits for a marker W1 has just posted. */
async function anchorOnPeer(community, channel, marker) {
  await enterCommunities(w2);
  await openCommunity(w2, community);
  await realClick(w2, `[aria-label*=${JSON.stringify(channel)}]`);
  if ((await selectedChannel(w2)) !== channel) throw new Error('the channel did not open on W2');
  await awaitMessage(w2, marker, 30000);
}

/** Selects the arm's channel on W1 and posts one marked message. */
async function post(community, channel, marker) {
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await realClick(w1, `[aria-label*=${JSON.stringify(channel)}]`);
  if ((await selectedChannel(w1)) !== channel) throw new Error('the channel did not open on W1');
  return send(w1, `COMM-12 ${marker}`);
}

/**
 * One arm: a community set to `visibility`, four messages, a removal and a re-invitation.
 *
 * Returns what W2 could READ at each of the two joins, plus everything needed to decide whether the
 * arm was armed at all. It never throws: a step that fails records itself and the arm comes back
 * unarmed, which is a VACUOUS verdict rather than a false accusation.
 */
async function arm(visibility, peerId) {
  const community = `C12 ${visibility} ${run}`;
  const channel = `c12-${visibility}-${run.toLowerCase()}`;
  const m = {
    past: `${run}-PAST-${visibility}`,
    in1: `${run}-IN1-${visibility}`,
    out: `${run}-OUT-${visibility}`,
    in2: `${run}-IN2-${visibility}`,
  };
  const tag = `[${visibility}]`;
  const out = { community, channel, markers: m, visibility };

  await step(`${tag} create the community`, async () => {
    await enterCommunities(w1);
    await createCommunity(w1, community);
    await openCommunity(w1, community);
  });
  out.workspaceId = await step(`${tag} read the community id`, () => workspaceIdOf(community));
  if (!out.workspaceId) return out;

  // SET BEFORE ANYBODY JOINS, and read back from the table. `shared` is the column's default, so
  // this arm's gesture is a no-op save - it is performed anyway, because the two arms must differ
  // in the VALUE and not in whether the control was ever touched.
  await step(`${tag} set the history rule`, () => setHistoryVisibility(w1, visibility));
  out.stored = historyVisibilityOf(out.workspaceId);

  await step(`${tag} create the channel and post the past message`, async () => {
    await createChannel(w1, channel);
    await post(community, channel, m.past);
  });
  out.channelId = channelIdOf(out.workspaceId, channel);

  // -- First join: W2 arrives after PAST was minted --------------------------------
  out.joinedFirst = await step(`${tag} the peer joins`, () => joinAsPeer(out.workspaceId, peerId));
  await step(`${tag} post while the peer is in`, () => post(community, channel, m.in1));
  // IN1 is the anchor AND an assertion: live distribution must reach a member.
  out.firstJoin = await step(`${tag} read the first join`, async () => {
    await anchorOnPeer(community, channel, m.in1);
    return { in1: await readWithin(w2, m.in1), past: await readWithin(w2, m.past) };
  });

  // -- Removed, and one message minted while they are out ---------------------------
  await step(`${tag} remove the peer`, async () => {
    await enterCommunities(w1);
    await openCommunity(w1, community);
    await removeCommunityMember(w1, PEER_NAME);
  });
  out.removed = await step(`${tag} confirm the removal`, async () => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const gone = !peerId || !isCommunityMember(out.workspaceId, peerId);
      // The client half, which no table can show: the community must leave W2's sidebar. It is also
      // what proves the local purge ran - and the purge is what makes the second join a NEWCOMER's.
      const list = await listCommunities(w2).catch(() => null);
      const purged = Array.isArray(list) && !list.some((n) => n.includes(community));
      if (gone && purged) return { serverSide: gone, clientSide: purged };
      if (Date.now() > deadline) return { serverSide: gone, clientSide: purged };
      await new Promise((r) => setTimeout(r, 1500));
    }
  });
  await step(`${tag} post while the peer is out`, () => post(community, channel, m.out));

  // -- Re-invited: the same person, holding nothing ---------------------------------
  out.joinedAgain = await step(`${tag} the peer is re-invited`, () =>
    joinAsPeer(out.workspaceId, peerId)
  );
  await step(`${tag} post after the re-invitation`, () => post(community, channel, m.in2));
  // IN2 is the anchor for three refusals, and the row's own first half: what is minted from now on
  // must arrive, in BOTH arms, whatever the history rule says.
  out.secondJoin = await step(`${tag} read the second join`, async () => {
    await anchorOnPeer(community, channel, m.in2);
    return {
      in2: await readWithin(w2, m.in2),
      past: await readWithin(w2, m.past),
      in1: await readWithin(w2, m.in1),
      out: await readWithin(w2, m.out),
    };
  });

  // THE CIPHERTEXT IS THERE EITHER WAY. Four rows on the server is what separates "W2 cannot open
  // it" from "it was never delivered", and only the first is what this row is about.
  out.storedMessages = out.channelId ? channelMessageCount(out.channelId) : null;

  await step(`${tag} delete the community`, async () => {
    await enterCommunities(w1);
    await openCommunity(w1, community);
    await deleteCommunity(w1, community);
  });
  return out;
}

const peerId = await step('resolve the peer user id', () => userIdOf(PEER_NAME));

const joined = await arm('joined', peerId);
const shared = await arm('shared', peerId);

/** Whether W2's pane really rendered the marker - and never a zero read off a dead pane. */
const reads = (s) => s?.composer === true && s.count > 0;
/** An absence, from a pane that was alive AND after the full window was spent waiting for it. */
const refuses = (s) => s?.composer === true && s.count === 0 && s.windowExhausted === true;

// Nothing below means anything unless both arms really happened: the setting stored, the peer in
// twice and out once, and four ciphertexts on the server in each.
const armedArm = (a) =>
  !!a.workspaceId &&
  !!a.channelId &&
  a.stored === a.visibility &&
  a.joinedFirst === true &&
  a.removed?.serverSide === true &&
  a.removed?.clientSide === true &&
  a.joinedAgain === true &&
  a.storedMessages === 4;
const armed = !!peerId && armedArm(joined) && armedArm(shared);

const expectations = {
  // -- What holds in BOTH arms, whatever the rule says --------------------------------
  // A member reads what is minted while they are in it. Live distribution, not history.
  livePostReachedTheMember: reads(joined.firstJoin?.in1) && reads(shared.firstJoin?.in1),
  // THE ROW'S FIRST HALF: re-invited, they receive the sessions minted from now on.
  reInvitedReadsWhatComesNext: reads(joined.secondJoin?.in2) && reads(shared.secondJoin?.in2),

  // -- `joined`: nothing older than the arrival, on either join -----------------------
  joinedRefusesThePast: refuses(joined.firstJoin?.past),
  joinedStillRefusesThePastAfterReturning: refuses(joined.secondJoin?.past),
  // The removal wiped the seeds, so what they COULD read before is gone for good.
  joinedLosesWhatItCouldReadBefore: refuses(joined.secondJoin?.in1),
  joinedRefusesTheWindowItMissed: refuses(joined.secondJoin?.out),

  // -- `shared`: the positive control, refusal by refusal ------------------------------
  // Without these, every line above is satisfied by a client that decrypts nothing at all.
  sharedGivesThePast: reads(shared.firstJoin?.past),
  sharedGivesThePastAgainAfterReturning: reads(shared.secondJoin?.past),
  sharedGivesBackWhatTheRemovalWiped: reads(shared.secondJoin?.in1),
  sharedGivesTheWindowItMissed: reads(shared.secondJoin?.out),
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);
const gated = gate(verdict, { W1: await report(wa), W2: await report(wb) });

record('COMM-12', gated.verdict, {
  ...gated.detail,
  joined,
  shared,
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
