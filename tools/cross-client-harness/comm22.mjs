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
 * rotation is an hour of typing and 7 days is not a check. Each grant and each revoke commits to the
 * salon's own distribution group, the epoch moves, and the next send mints - so a cycle of
 * grant/send/revoke/send yields two sessions and costs four gestures. That is the real shape of the
 * defect this row is looking for, too: a salon nobody has churned holds one seed per sender and
 * would pass any version of this check.
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
import { execFileSync } from 'node:child_process';
import {
  awaitMessage,
  client,
  countMessage,
  evaluate,
  realClick,
  send,
} from './chat.mjs';
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
import { channelIdOf, channelSessions, messageCount, userIdOf, workspaceIdOf } from './grainedb.mjs';
import { seedsForChannel } from './grainestore.mjs';
import { ACCOUNT_OF, PEER_NAME, PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

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

/** Enters the PIN through the CLI, which reads it from test-accounts.json - never from argv. */
function unlock(port, account) {
  try {
    const out = execFileSync(
      process.execPath,
      ['pin.mjs', '--port', String(port), '--account', account, '--match', 'canari-emse.fr'],
      { cwd: new URL('.', import.meta.url).pathname.replace(/^\//, ''), encoding: 'utf8' }
    );
    return out.trim().split('\n').pop();
  } catch (e) {
    return `pin.mjs failed: ${String(e.stdout || e.message).slice(0, 200)}`;
  }
}

/** Opens the salon on a client already inside the community, waiting for the row to arrive first. */
async function openSalon(cx, timeoutMs = 30_000) {
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
    await inPanel(w1, openChannelAccess, () => grantChannelAccess(w1, PEER_NAME));
    await saveChannelAccess(w1);

    const withPeer = `${run}-in${i}`;
    await send(w1, withPeer);
    inside.push(withPeer);

    await inPanel(w1, openChannelAccess, () => revokeChannelAccess(w1, PEER_NAME));

    const withoutPeer = `${run}-out${i}`;
    await send(w1, withoutPeer);
    outside.push(withoutPeer);

    return { i, withPeer, withoutPeer };
  });
  if (cycle) cycles.push(cycle);
}

// THE PEER ENDS UP INSIDE, which is the state the second half is about: entitled to everything,
// holding only what was delivered while they were on the roster.
await step('let the peer back in for good', async () => {
  await openSalon(w1);
  await inPanel(w1, openChannelAccess, () => grantChannelAccess(w1, PEER_NAME));
  await saveChannelAccess(w1);
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
      await enterCommunities(w2);
      await openCommunity(w2, community);
      return timeTranscript(w2, everyMarker);
    })
  : null;

const seedsWarm = armed ? await step('seeds the peer holds warm', () => seedsForChannel(w2, channelId)) : null;

// -- The peer, cold: reloaded onto the deployed bundle, PIN re-entered -----------------------
const coldRead = armed
  ? await step('the peer reads it cold', async () => {
      await evaluate(w2, 'location.reload()').catch(() => null);
      await sleep(6000);
      const pin = unlock(PORTS.W2, ACCOUNT_OF.W2);
      await sleep(4000);
      await enterCommunities(w2);
      await openCommunity(w2, community);
      const timing = await timeTranscript(w2, everyMarker);
      return { ...timing, pin };
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
  peerMissedASession: saying(linesW2, /\[GRAINE\] no seed for session /).length,
  peerAbsorbed: saying(linesW2, /\[GRAINE\] absorbed \d+\//),
  peerAskedForHistory: saying(linesW2, /\[GRAINE\] (asking|could not ask) for /).length,
  senderAnswered: saying(linesW1, /\[GRAINE\] answered .* with \d+ seed/),
  senderWithheld: saying(linesW1, /\[GRAINE\] (withholding|refusing) /),
  truncatedBundles: saying(linesW2, /TRUNCATED bundle/).length,
};

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
  thePeerHoldsASeedPerSession: (seedsCold?.length ?? 0) >= (sessions?.length ?? 0),
  // A gap that is never repaired is the one failure the transcript itself cannot show.
  nothingStaysUnreadable: saying(linesW2, /unreadable for good/).length === 0,
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const gated = gate(verdict, { W1: await report(wa), W2: await report(wb) });

record('COMM-22', gated.verdict, {
  ...gated.detail,
  community,
  salon,
  workspaceId,
  channelId,
  armed,
  cycles: cycles.length,
  messages: everyMarker.length,
  onServer,
  sessions: (sessions ?? []).map((s) => ({ messages: s.messages })),
  sessionCount: sessions?.length ?? null,
  // RECORDED, NEVER ASSERTED: the product carries no budget for these and a check must not invent
  // one. Two numbers that differ are the result worth reading.
  senderRead,
  warmRead,
  coldRead,
  seedsWarm: seedsWarm?.length ?? null,
  seedsCold: seedsCold?.length ?? null,
  repair,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
