/**
 * COMM-22: a salon carrying MANY Graine sessions - what it costs to read, and what repairs a gap.
 *
 *   node comm22.mjs [--cycles 6]
 *
 * A SESSION IS THE UNIT THAT ROTATES, AND A MESSAGE COUNT CANNOT SEE IT. Every other COMM row asks
 * who may reach a salon; this one asks what reading one costs once its seeds have multiplied. A
 * session is per (channel, sender) and rotates on departure, on 100 messages or on 7 days, so the
 * expensive salon is not the busy one - it is the CHURNED one, where twelve messages can sit under
 * twelve different seeds. A check that counted messages would score those two exactly backwards.
 *
 * ROSTER CHURN IS THE ONLY LEVER TWO ACCOUNTS HAVE, and it is the honest one: 100 messages per
 * rotation is an hour of typing and 7 days is not a check. A roster change commits to the salon's
 * own distribution group, the epoch moves, and the next send mints - so a cycle of
 * grant/join/send/revoke/send yields two sessions. That is the real shape of the defect this row is
 * looking for, too: a salon nobody has churned holds one seed per sender and would pass any version
 * of this check.
 *
 * THE TWO HALVES OF THE CHURN ARE NOT COMMITTED BY THE SAME DEVICE, and the first version of this
 * check assumed they were. **A grant commits nothing.** It writes `allowedUsers`, and the entitled
 * device puts its OWN leaf in the tree when it next loads the salon - that is
 * `ensureDistributionGroupFor`, "ensures THIS DEVICE is in scope's group", called wherever a salon
 * is loaded. A revoke is the mirror: the leaver cannot remove themselves, so a remaining member
 * diffs the roster against the tree and commits the removal (`rosterReconcile`, which computes
 * strays and nothing else - it has no notion of an addition at all).
 *
 * Measured on production 2026-08-21, because the first two runs of this check disagreed with its own
 * premise: after a grant, the salon's group sat at epoch 1 holding only the owner's two devices for
 * a full SIXTY SECONDS with the peer idle - then moved to epoch 2 within 1 863 ms of the peer
 * opening the salon. Six cycles of grant/send/revoke/send therefore produced ONE session, and the
 * check reported VACUOUS about a product that was behaving exactly as designed. So the peer OPENS
 * the salon after each grant, and both halves of the churn are waited for by polling the delivery
 * roster rather than by sleeping - a fixed delay here is indistinguishable from the mechanism
 * missing, which is the whole reason the first run could not say which it had found.
 *
 * THE GAP COMES FOR FREE AND IS NOT MANUFACTURED. While the peer is revoked they hold no routing row
 * on the salon's group, so the seeds minted in that window are never delivered to them. Re-granting
 * makes them entitled to those rows again - `history_visibility` is set to `shared` here precisely
 * so that entitlement is total - and the seeds have to come back through a repair. So the second
 * half of this row is armed by the first, with nothing written into anybody's store: `grainestore`
 * is read-only on purpose, and a harness able to delete a seed could destroy history no peer still
 * has.
 *
 * THE SENDER IS THE POSITIVE CONTROL. W1 minted every session, so it holds every seed by
 * construction: if W1 cannot render its own transcript the finding is not about repair at all, and a
 * check made only of the receiver's half would report that as a repair failure.
 *
 * THE COLD READ IS THE ONE THAT COUNTS. A client that never left the salon may still hold decrypted
 * rows in memory, so the time worth reporting is measured after a reload and a PIN, from the click
 * that opens the salon to the moment the last marker is on screen. The warm figure is recorded
 * beside it rather than instead of it - two numbers that differ are the interesting result.
 *
 * TIMES ARE RECORDED, NEVER ASSERTED. There is no budget for this in the product and inventing one
 * here would be the check deciding a requirement. What IS asserted is that the transcript arrives
 * whole.
 *
 * IT BUILDS ITS OWN VENUE and deletes it.
 */
import { client, countMessage, evaluate, realClick, send } from './chat.mjs';
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
  openCommunitySettings,
  openInviteLink,
  revokeChannelAccess,
  saveChannelAccess,
  selectedChannel,
  setHistoryVisibility,
} from './comm.mjs';
import {
  awaitUserRouting,
  channelIdOf,
  channelSessions,
  messageCount,
  salonDistribution,
  userIdOf,
  workspaceIdOf,
} from './grainedb.mjs';
import { seedsForChannel } from './grainestore.mjs';
import { ACCOUNT_OF, PEER_NAME, PORTS } from './names.mjs';
import { unlockClient } from './pingate.mjs';
import { mark, record } from './results.mjs';
import {
  EVICTED_REJOIN_NARRATION,
  consoleLines,
  gate,
  ignoringExpectedLog,
  report,
  watch,
} from './watch.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

/**
 * How many grant/send/revoke/send cycles to drive.
 *
 * SIX IS A FLOOR ARGUED FROM THE MECHANISM, not a round number: below four sessions a salon is
 * indistinguishable from an unchurned one and the check would pass on a product that had never
 * rotated at all. Six cycles is twelve sends across twelve epochs, and the arming below refuses to
 * produce a verdict if the transcript comes back holding fewer sessions than that.
 */
const CYCLES = Math.max(2, Number(arg('cycles', 6)));

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM22');
const community = `C22 ${run}`;
const salon = `c22-${run.toLowerCase()}`;

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens the salon: enters its COMMUNITY first, then clicks the row.
 *
 * ENTERING THE COMMUNITY IS PART OF OPENING THE SALON, and leaving it to the caller cost every one
 * of six cycles on 2026-08-21. `leaveSalon` is `enterCommunities`, which lands on the community
 * LIST with nothing selected - so the salon rail is empty, and the poll below waits out its whole
 * window for a row nobody was going to draw. The failure reads `the salon never appeared in the
 * sidebar`, which is true and says nothing whatever about the salon. Both gestures are idempotent,
 * so doing them on every call is free and removes the class.
 */
async function openSalon(cx, timeoutMs = 30_000) {
  await enterCommunities(cx);
  await openCommunity(cx, community);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await channelRow(cx, salon)).present) break;
    if (Date.now() > deadline) throw new Error('the salon never appeared in the sidebar');
    await sleep(1500);
  }
  await realClick(cx, `[aria-label*=${JSON.stringify(salon)}]`);
  const open = await selectedChannel(cx);
  if (open !== salon) throw new Error(`wrong salon open: ${JSON.stringify(open)}`);
}

/**
 * Waits until the peer either HOLDS or does not hold delivery rows on the salon's own group.
 *
 * THE DELIVERY ROSTER IS THE POST-CONDITION OF BOTH HALVES OF THE CHURN, and it is the only thing
 * that is: a grant is entitlement and a revoke is an intention, while `dm_device_group_memberships`
 * is what a seed frame is actually fanned out to. Polling it turns each gesture into an assertion -
 * a cycle that carries on without the epoch having moved is a cycle that mints no session, and a
 * sleep in this place could not tell that apart from a slow one. It is also where the check would
 * SEE the departure defect of 2026-08-19 come back, which is the reason the row exists.
 *
 * @param {boolean} wanted whether the peer should be on the roster by the end
 * @returns the epoch it settled at - so the caller can record that it really moved
 */
async function awaitPeerRouting(wanted, timeoutMs = 60_000) {
  if (!channelId || !peerId) throw new Error('awaitPeerRouting needs the salon and the peer');
  const { ok, dist } = await awaitUserRouting(channelId, peerId, wanted, timeoutMs);
  // A ROSTER THAT NEVER SETTLED IS THIS CHECK'S FAILURE, so the shared helper's result becomes a
  // throw HERE: every call site in the churn below is a gesture whose post-condition this is, and a
  // cycle carrying on without it would measure the wrong session.
  if (!ok) {
    throw new Error(
      `the peer is ${wanted ? 'not' : 'still'} on the salon's delivery roster after ${timeoutMs} ms ` +
        `(wanted ${wanted ? 'on' : 'off'}, epoch ${dist?.epoch ?? '?'}, ${dist?.devices?.length ?? 0} device rows)`
    );
  }
  return dist?.epoch ?? null;
}

/**
 * Waits until the salon's distribution group has moved PAST `epoch`, and returns where it landed.
 *
 * THE EPOCH IS WHAT ROTATES A SESSION, AND DROPPED ROUTING ROWS ARE NOT THE EPOCH. A revoke has two
 * halves and only one of them is immediate: the server drops the leaver's delivery rows straight
 * away (measured at ~2 s), while their LEAF stays in the tree until a REMAINING member diffs the
 * roster against it and commits the Remove - which happens when that member next loads the salon.
 * Until that commit lands the epoch has not moved, `graineRotationReason` sees nothing to rotate
 * for, and the next send goes out under the session the leaver still holds. Waiting on the rows
 * alone is therefore waiting on the wrong half: COMM-22's third run did exactly that, sent
 * immediately after, and put both of the cycle's messages under ONE session.
 *
 * @param {number} epoch the epoch to get past
 */
async function awaitEpochAbove(epoch, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = salonDistribution(channelId)?.epoch ?? null;
    if (typeof now === 'number' && now > epoch) return now;
    if (Date.now() > deadline) {
      throw new Error(`the salon's group never moved past epoch ${epoch} in ${timeoutMs} ms (still ${now})`);
    }
    await sleep(2000);
  }
}

/**
 * Sends, and does not return until the SERVER holds one more row for this salon.
 *
 * `send` PROVES THE COMPOSER EMPTIED, WHICH IS THE CLIENT'S OPINION. That is the right
 * post-condition for the gesture - a click that lands while the draft stays put is the failure it
 * was written for - but it says nothing about the row. Measured 2026-08-21: twelve sends, twelve
 * emptied composers, no error line on either client, no failing request in the window, and TEN rows
 * on the server. The run reported `everyMessageReachedTheServer: false` and could not name which two
 * were missing, because the only evidence it kept was a total.
 *
 * A COUNT AT THE END CANNOT LOCATE A LOSS. Asking after each send turns the aggregate into a
 * per-gesture assertion: the cycle that lost a message fails AT that message, with the marker in the
 * sentence, while the state that produced it is still on both clients. It also removes the other
 * reading of the same number - a message still sitting in the outbox when the total was read - since
 * a send that is merely slow satisfies this within the window and a send that is lost never does.
 *
 * @returns the row count the server settled at, so a caller can record that it really moved
 */
async function sendConfirmed(cx, text, timeoutMs = 30_000) {
  const before = messageCount(channelId);
  await send(cx, text);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = messageCount(channelId);
    if (typeof now === 'number' && typeof before === 'number' && now > before) return now;
    if (Date.now() > deadline) {
      throw new Error(
        `"${text}" left the composer and never reached the server ` +
          `(${before} -> ${now} row(s) for the salon in ${timeoutMs} ms)`
      );
    }
    await sleep(1500);
  }
}

/** Leaves the salon so the next open is a real open, not a no-op on an already-rendered pane. */
async function leaveSalon(cx) {
  await enterCommunities(cx);
  await sleep(500);
}

/**
 * How long the whole transcript takes to arrive, from the click that opens the salon.
 *
 * IT POLLS FOR THE LAST MARKER, NOT FOR A SETTLED PANE. "Nothing has changed for 700 ms" answers a
 * different question and would time a client that had given up as though it had finished. A window
 * that expires returns null with the count it reached, so a partial render is reported as partial
 * rather than as a slow success.
 */
async function timeTranscript(cx, marks, timeoutMs = 120_000) {
  const t0 = Date.now();
  await openSalon(cx, timeoutMs);
  const deadline = t0 + timeoutMs;
  let seen = 0;
  for (;;) {
    const counts = await Promise.all(marks.map((m) => countMessage(cx, m)));
    seen = counts.filter((n) => n > 0).length;
    if (seen === marks.length) return { ms: Date.now() - t0, seen, of: marks.length };
    if (Date.now() > deadline) return { ms: null, seen, of: marks.length };
    await sleep(500);
  }
}

// -- A private salon, and a peer who will be let in and put out again ---------------------
await step('create the community', async () => {
  await enterCommunities(w1);
  await createCommunity(w1, community);
  await openCommunity(w1, community);
});
const workspaceId = await step('read the community id', () => workspaceIdOf(community));

// SHARED HISTORY, SET BEFORE ANYBODY JOINS. It is what makes the peer entitled to every session
// minted while they were out - without it a missing seed is a POLICY, and the check would be
// measuring `history_visibility` while claiming to measure repair.
await step('let the whole history be shared', async () => {
  await openCommunitySettings(w1);
  await setHistoryVisibility(w1, 'shared');
});

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

// -- The churn: every grant and every revoke moves the epoch, so every send mints -----------
const inside = [];
const outside = [];
const cycles = [];

for (let i = 1; i <= CYCLES && channelId; i += 1) {
  const cycle = await step(`cycle ${i}`, async () => {
    await openSalon(w1);
    // GRANT AND REVOKE END THE PANEL DIFFERENTLY, so they are called differently. A grant is staged
    // and `saveChannelAccess` commits it AND clears the modal, so it is the last gesture inside an
    // `openChannelAccess` - wrapping it in `inPanel` closes the panel before the save can happen,
    // and the save then misses a button that is no longer mounted. A revoke commits on its own
    // confirmation and leaves the panel up, so it is the one that needs `inPanel` to close it.
    await openChannelAccess(w1);
    await grantChannelAccess(w1, PEER_NAME);
    await saveChannelAccess(w1);

    // THE PEER COMMITS ITS OWN ADD, so the gesture that moves the epoch is the peer LOADING the
    // salon, not the owner granting it. Without this the roster never changes, no send rotates, and
    // twelve messages sit under one seed.
    await openSalon(w2);
    const joinedAt = await awaitPeerRouting(true);

    const withPeer = `${run}-in${i}`;
    await sendConfirmed(w1, withPeer);
    inside.push(withPeer);

    await inPanel(w1, openChannelAccess, () => revokeChannelAccess(w1, PEER_NAME));
    await awaitPeerRouting(false);
    // THE SENDER IS THE REMAINING MEMBER, so the Remove commit is its job - and it only reconciles
    // when it loads the salon. Leaving and coming back is what gives it that reason; without it the
    // leaver's leaf stays in the tree, the epoch stands still, and the send below reuses the very
    // session the revoke was supposed to retire.
    await leaveSalon(w1);
    await openSalon(w1);
    const leftAt = await awaitEpochAbove(joinedAt);

    const withoutPeer = `${run}-out${i}`;
    await sendConfirmed(w1, withoutPeer);
    outside.push(withoutPeer);

    return { i, withPeer, withoutPeer, joinedAt, leftAt };
  });
  if (cycle) cycles.push(cycle);
}

// THE PEER ENDS UP INSIDE, which is the state the second half is about: entitled to everything,
// holding only what was delivered while they were on the roster.
await step('let the peer back in for good', async () => {
  await openSalon(w1);
  await openChannelAccess(w1);
  await grantChannelAccess(w1, PEER_NAME);
  await saveChannelAccess(w1);
  // Entitlement is not routing, and the reads below are about a peer who is BOTH. Asserted here
  // rather than left to the warm read, so a peer that never got back on the roster is reported as
  // this step failing and not as the transcript being incomplete.
  await openSalon(w2);
  return awaitPeerRouting(true);
});

const everyMarker = [...inside, ...outside];
const sessions = await step('read the sessions the transcript holds', () =>
  channelId ? channelSessions(channelId) : null
);
const onServer = await step('read the message count', () => (channelId ? messageCount(channelId) : null));

// ARMING IS A MEASUREMENT, NOT AN INTENTION. The gestures above ask for many sessions; only the
// server can say whether the product minted them, and a run that produced two is not a run about
// many.
const armed =
  !!workspaceId &&
  !!channelId &&
  !!peerId &&
  everyMarker.length === CYCLES * 2 &&
  onServer === CYCLES * 2 &&
  (sessions?.length ?? 0) >= CYCLES;

// -- The sender's own transcript, which is the positive control ----------------------------
const senderRead = armed
  ? await step('the sender reads its own transcript', async () => {
      await leaveSalon(w1);
      return timeTranscript(w1, everyMarker);
    })
  : null;

// -- The peer, warm: it has been in and out of this salon all run ---------------------------
const warmRead = armed
  ? await step('the peer reads it warm', async () => {
      // `timeTranscript` opens the salon, and opening it enters the community.
      return timeTranscript(w2, everyMarker);
    })
  : null;

const seedsWarm = armed ? await step('seeds the peer holds warm', () => seedsForChannel(w2, channelId)) : null;

// -- The peer, cold: reloaded onto the deployed bundle, PIN re-entered -----------------------
//
// THE GATE IS ASSERTED, NOT LOGGED. A client that never came back from the PIN renders, answers
// every probe and reports on an EMPTY STORE, so a cold read taken behind a closed gate returns zero
// markers and the check blames the application for the harness's own locked browser. `unlockClient`
// re-reads the client after typing and says whether it actually got through; anything but
// `unlocked` makes the cold half unaskable, which is `coldGate` below and never a FAIL.
const coldRead = armed
  ? await step('the peer reads it cold', async () => {
      await evaluate(w2, 'location.reload()').catch(() => null);
      await sleep(6000);
      const gateW2 = await unlockClient(w2, PORTS.W2, ACCOUNT_OF.W2, { match: 'canari-emse.fr' });
      if (gateW2.verdict !== 'unlocked') {
        return { ms: null, seen: 0, of: everyMarker.length, gate: gateW2.verdict, pin: gateW2.said };
      }
      const timing = await timeTranscript(w2, everyMarker);
      return { ...timing, gate: gateW2.verdict, pin: gateW2.said };
    })
  : null;

const seedsCold = armed ? await step('seeds the peer holds cold', () => seedsForChannel(w2, channelId)) : null;

// -- Its own debris goes ---------------------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);
const saying = (lines, re) => lines.filter((l) => re.test(l));

// WHAT THE REPAIR SOUNDED LIKE, from both ends. A seed reaches a device by its sender distributing
// it, by the group's durable log replaying it, or by a repair answering for it, and only the console
// separates the three. Recorded rather than asserted: which path supplied a given seed is the
// product's business, and demanding one of them would freeze an implementation into a check.
const repair = {
  // WHAT THE PEER COULD NOT RENDER, IN THE PRODUCT'S OWN WORDS. The first spelling of this counted
  // `[GRAINE] no seed for session ` and matched NOTHING, on a run whose peer hit the case six times:
  // the sentence exists, but it is `[CHANNEL] Message <row> of <salon> is unreadable and is not
  // rendered - no seed for session <id> (repairable)`, written by `reportUnreadableChannelMessage`,
  // and no `[GRAINE]` line carries those words at all. A predicate that cannot fire is worse than an
  // absent one: it reports zero and is read as evidence.
  peerMissedASession: saying(linesW2, /is unreadable and is not rendered - no seed for session /).length,
  peerAbsorbed: saying(linesW2, /\[GRAINE\] absorbed \d+\//),
  peerAskedForHistory: saying(linesW2, /\[GRAINE\] (asking|could not ask) for /).length,
  senderAnswered: saying(linesW1, /\[GRAINE\] answered .* with \d+ seed/),
  senderWithheld: saying(linesW1, /\[GRAINE\] (withholding|refusing) /),
  truncatedBundles: saying(linesW2, /TRUNCATED bundle/).length,
};

// -- Two observations this row surfaces and does NOT judge --------------------------------------

/**
 * Message rows the peer refused to render, and the reason each carried.
 *
 * THREE REASONS, TWO OF WHICH ARE THE PRODUCT WORKING. `reportUnreadableChannelMessage` classifies
 * from the ERROR TYPE and prints the class: a missing seed is `(repairable)` and triggers the
 * history request; a row below the handover floor was sent before this device was given the seed,
 * which is `history_visibility` doing its job; anything else is the string of an error nobody
 * classified, and that is the one this check is entitled to fail on.
 */
const unreadableRows = saying(linesW2, /is unreadable and is not rendered/);
const unclassifiedRows = unreadableRows.filter(
  (l) => !/\(repairable\)|sent before this device was given the seed/.test(l)
);

/**
 * Frames that arrived sealed under an epoch whose secrets are gone - RECORDED, NOT JUDGED.
 *
 * Measured on 2026-08-21, six cycles, SIX of these, one per cycle, every one of them `msg_epoch=0`
 * while the group stood at 3, 5, 7, 9, 11 and 13 - and both clients saw the same frame at the same
 * second. The product names the recovery in the same breath ("its seed comes back through a history
 * request, not a redelivery") and the transcript proves the recovery: 12 markers of 12, warm and
 * cold, and a seed per session in the store.
 *
 * SO IT IS NOT THIS ROW'S FAILURE, AND IT IS NOT NOTHING EITHER. A frame nobody can open is work
 * done twice on every rotation, and the cause is not established: `queued_message` holds no publish
 * matching it, which points at a REPLAY rather than at a sender sealing under a stale handle - and
 * "points at" is not a finding. It is carried here so the next run can say whether it is still six,
 * and `docs/wiki/backlog.md` carries what is known and what is not.
 */
const pastEpochFrames = [
  ...saying(linesW1, /Past-epoch application frame/),
  ...saying(linesW2, /Past-epoch application frame/),
];

const expectations = {
  // The churn really produced what the row is about.
  theSalonHoldsManySessions: (sessions?.length ?? 0) >= CYCLES,
  everyMessageReachedTheServer: onServer === CYCLES * 2,
  // The control: the sender minted every seed, so it can read everything it wrote.
  theSenderReadsEverything: senderRead?.seen === everyMarker.length,
  // The subject: a member entitled to the whole history reads the whole history, warm and cold.
  thePeerReadsEverythingWarm: warmRead?.seen === everyMarker.length,
  thePeerReadsEverythingCold: coldRead?.seen === everyMarker.length,
  // A seed per session it is entitled to, read from the device's own store rather than from a pane.
  //
  // ON `received`, NOT ON `held`. The peer never sends in this salon, so today the two are equal -
  // but `held` counts a seed this device MINTED just the same, and a retention claim built on the
  // raw count would pass on a salon the peer had only ever written to. `received` is the figure the
  // store was given a separate field for, and it is the one the row is about.
  thePeerHoldsASeedPerSession: (seedsCold?.received ?? 0) >= (sessions?.length ?? 0),
  // A gap that is never repaired is the one failure the transcript itself cannot show - so what is
  // asserted is an UNCLASSIFIED refusal to render, not the word "unreadable".
  //
  // THE FIRST SPELLING MATCHED THE WRONG SENTENCE. It looked for `unreadable for good`, which is
  // `[GRAINE] frame on <group> is unreadable for good (<kind>) - acknowledged; its seed comes back
  // through a history request, not a redelivery`: a statement about ONE FRAME, ending in the name of
  // the mechanism that covers it. It fired six times on a run whose peer then read all twelve
  // markers warm AND cold and held a seed per session - i.e. the run where nothing stayed
  // unreadable is the run this predicate called a failure. That is the campaign's own rule about a
  // predicate that named the last incident, so it was re-measured against the population it runs on
  // rather than deleted: the line that means "a person could not see this message" is
  // `[CHANNEL] Message ... is unreadable and is not rendered`, and the reason it carries is what
  // separates a loss from the protocol working. See `unclassifiedRows` above.
  nothingStaysUnreadable: unclassifiedRows.length === 0,
};

// A COLD READ TAKEN BEHIND A CLOSED GATE IS NOT A FAILING COLD READ, it is an absent one - "the
// instrument could not be brought to a state where the question is askable". Both causes of vacuity
// are recorded separately below (`armed`, `coldGate`) because a single word cannot tell them apart.
const coldGate = coldRead?.gate ?? null;
const verdict =
  !armed || (armed && coldGate !== 'unlocked')
    ? 'VACUOUS'
    : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
      ? 'FAIL'
      : 'PASS';

// THIS ROW EVICTS ITS PEER SIX TIMES, so it owns what the peer says on the way back in: a device
// removed by somebody else's commit never processes that commit, keeps the local group, and finds it
// unrouted the next time it opens the salon. Forgiven ON W2 ONLY - W1 is the client doing the
// revoking and has no eviction to recover from, so the same sentence there would be a device thrown
// out by something nobody asked for, which is a finding. See `EVICTED_REJOIN_NARRATION`.
const gated = gate(verdict, {
  W1: await report(wa),
  W2: ignoringExpectedLog(await report(wb), EVICTED_REJOIN_NARRATION),
});

record('COMM-22', gated.verdict, {
  ...gated.detail,
  community,
  salon,
  workspaceId,
  channelId,
  armed,
  cycles: cycles.length,
  // THE EPOCHS THE CHURN ACTUALLY MOVED THROUGH, which is the evidence that the salon under test is
  // the churned one this row is named for. A run whose epochs do not climb produced its sessions
  // some other way, and the session count alone could not say so.
  epochs: cycles.map((c) => ({ i: c.i, joined: c.joinedAt, left: c.leftAt })),
  messages: everyMarker.length,
  onServer,
  sessions: (sessions ?? []).map((s) => ({ messages: s.messages })),
  sessionCount: sessions?.length ?? null,
  // RECORDED, NEVER ASSERTED: the product carries no budget for these and a check must not invent
  // one. Two numbers that differ are the result worth reading.
  senderRead,
  warmRead,
  coldRead,
  coldGate,
  seedsWarm,
  seedsCold,
  repair,
  // Recorded beside the verdict because neither is asserted and both are the reason to look again.
  unreadableRows,
  pastEpochFrames,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
