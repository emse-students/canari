/**
 * COMM-8: a private salon is invisible to a non-member, unfetchable by them, and NEVER SENT ITS SEED.
 *
 *   node comm8.mjs
 *
 * THREE QUESTIONS, AND THE THIRD IS THE ONE THAT CHANGED. Until 2026-08-20 a private salon was kept
 * private by the server declining to serve its ciphertext, while every member of the community held
 * the key that would have opened it. Now the salon has its own key-distribution group, so the
 * guarantee is that the seed is never sealed to anyone outside `allowedUsers` - and no screen can
 * show that. W2 sees an empty sidebar whether they were denied the ciphertext, denied the seed, or
 * simply never told the salon exists, and those are three mechanisms with three different failures.
 * So the first two are asked of the SCREEN and of the API, and the third of the DATABASE.
 *
 * IT NEEDS BOTH ACCOUNTS IN THE SAME COMMUNITY and W2 out of the salon - which is the point: a
 * check run against someone who is not in the community at all would pass on the community
 * membership rule and say nothing about the salon's. The community roster is read next to the
 * salon's for exactly that reason: three devices on one, one on the other, from the same run.
 *
 * DEBRIS IS LEFT BEHIND, like every check in this phase - deleting the salon would delete the
 * evidence of a failure with it. `cleanup.mjs` is the deliberate, separate step.
 */
import { apiGet, client, realClick, send } from './chat.mjs';
import {
  channelRow,
  createChannel,
  enterCommunities,
  grantChannelAccess,
  openChannelAccess,
  openCommunity,
  saveChannelAccess,
  selectedChannel,
} from './comm.mjs';
import {
  channelIdOf,
  communityDistribution,
  salonDistribution,
  userIdOf,
  workspaceIdOf,
} from './grainedb.mjs';
import { PEER_NAME, PORTS, VENUE } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, ignoringExpectedRefusal, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const run = mark('COMM8');
const salon = `c8-${run.toLowerCase()}`;

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

// ── W1 creates the private salon and puts one message in it ───────────────────
await step('open the community on W1', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, VENUE.community);
});
await step('create the private salon', () => createChannel(w1, salon, { visibility: 'private' }));

const marker = mark('COMM8MSG');
const openedOnW1 = await step('open it and post', async () => {
  await realClick(w1, `[aria-label*=${JSON.stringify(salon)}]`);
  const selected = await selectedChannel(w1);
  const sentAt = await send(w1, `COMM-8 ${marker}`);
  return { selected, sentAt };
});

// ── The DATABASE: who was actually sent the seed ──────────────────────────────
const workspaceId = await step('read the community id', () => workspaceIdOf(VENUE.community));
const channelId = await step('read the salon id', () =>
  workspaceId ? channelIdOf(workspaceId, salon) : null
);
const salonRoster = await step('read the salon roster', () =>
  channelId ? salonDistribution(channelId) : null
);
const communityRoster = await step('read the community roster', () =>
  workspaceId ? communityDistribution(workspaceId) : null
);
const peerUserId = await step('read the peer id', () => userIdOf(PEER_NAME));

// THE ASSERTION THAT CARRIES THE WHOLE CHECK, and it is an ABSENCE: the peer is on the community's
// delivery roster and on none of the salon's. Stated as two facts rather than one, because "not on
// the salon's" alone is also what an empty group looks like.
const peerOnCommunity = !!(
  peerUserId && communityRoster?.devices.some((d) => d.userId === peerUserId)
);
const peerOnSalon = !!(peerUserId && salonRoster?.devices.some((d) => d.userId === peerUserId));

// ── The SCREEN: the salon is not in the peer's sidebar ────────────────────────
const onPeer = await step('look for it on W2', async () => {
  await enterCommunities(w2);
  await openCommunity(w2, VENUE.community);
  return channelRow(w2, salon);
});

// ── The API: the peer cannot fetch it by id either ────────────────────────────
// ASKED AS THE PEER, from the peer's own page, and AUTHENTICATED - see `apiGet`. A bare
// credentialed fetch answers 401 here, and 401 is not an answer to this question: it says the
// endpoint never looked at the account, so it would report a perfect access rule for a rule that
// had been deleted. What this asks for is a 403 or a 404 - the salon refusing a real reader.
const peerFetch = await step('fetch it by id from W2', async () => {
  if (!channelId) throw new Error('no salon id to fetch');
  return apiGet(w2, `/api/channels/${channelId}/messages`);
});

// ── ARMING THE INSTRUMENT: prove the query can say YES ────────────────────────
// WITHOUT THIS THE CHECK IS VACUOUS AND WOULD NEVER SAY SO. "The peer holds no routing row on the
// salon's group" is trivially true of a group with no rows at all - which is exactly what a salon
// with one member has, since a device is written into the delivery roster when it COMMITS to the
// group and the creator initialises it without one. So the same query is asked again after the peer
// is granted access and opens the salon: if it cannot answer YES here, its NO above proved nothing.
// `testing-methodology.md`: a passing check that never armed its precondition measures nothing.
const armed = await step('grant the peer access, then look again', async () => {
  await realClick(w1, `[aria-label*=${JSON.stringify(salon)}]`);
  await openChannelAccess(w1);
  await grantChannelAccess(w1, PEER_NAME);
  await saveChannelAccess(w1);

  await enterCommunities(w2);
  await openCommunity(w2, VENUE.community);
  await realClick(w2, `[aria-label*=${JSON.stringify(salon)}]`);
  await selectedChannel(w2);
  // The peer's device enters the group by external commit, which is what writes its routing row -
  // so this is polled rather than read once, and the timeout is the fact, not a tuning knob.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const now = channelId ? salonDistribution(channelId) : null;
    if (now?.devices.some((d) => d.userId === peerUserId)) return { onSalonRoster: true, roster: now.devices.length };
    if (Date.now() > deadline) return { onSalonRoster: false, roster: now?.devices.length ?? null };
    await new Promise((r) => setTimeout(r, 1500));
  }
});

const verdict = !armed?.onSalonRoster
  ? 'VACUOUS'
  : failures.length > 0 ||
  openedOnW1?.selected !== salon ||
  !openedOnW1?.sentAt ||
  salonRoster?.isPrivate !== true ||
  !salonRoster?.groupId ||
  salonRoster?.retired !== false ||
  !communityRoster ||
  !peerUserId ||
  !peerOnCommunity ||
  peerOnSalon ||
  onPeer?.present !== false ||
  ![403, 404].includes(peerFetch?.status)
    ? 'FAIL'
    : 'PASS';

const raw = [
  ['W1', consoleLines(wa.cx)],
  ['W2', consoleLines(wb.cx)],
];
// W2's REFUSAL IS THIS CHECK'S OWN MEASUREMENT, so it is forgiven on W2 and nowhere else: the
// salon's endpoint answering 403 to a non-member is the assertion above, and leaving it in the dirt
// would make COMM-8 permanently `PASS-DIRTY` - which is dirt nobody reads.
const obs = {
  W1: await report(wa),
  W2: ignoringExpectedRefusal(await report(wb), [
    { path: new RegExp(`/api/channels/${channelId}/messages$`), status: [403, 404] },
  ]),
};
const gated = gate(verdict, obs);

record('COMM-8', gated.verdict, {
  ...gated.detail,
  community: VENUE.community,
  salon,
  channelId,
  marker,
  postedOnW1: openedOnW1,
  // The two rosters side by side: this is the evidence, and a verdict without it is a claim.
  salonDevices: salonRoster?.devices.map((d) => `${d.userId.slice(0, 8)}:${d.status}`) ?? null,
  communityDevices:
    communityRoster?.devices.map((d) => `${d.userId.slice(0, 8)}:${d.status}`) ?? null,
  peer: peerUserId ? peerUserId.slice(0, 8) : null,
  peerOnCommunity,
  peerOnSalon,
  // The arming, recorded whatever it said: a VACUOUS verdict has to name WHY, and a PASS has to
  // carry the proof that its absence was an absence rather than an empty table.
  armed,
  salonEpoch: salonRoster?.epoch ?? null,
  sidebarOnPeer: onPeer,
  peerFetchStatus: peerFetch?.status ?? null,
  // The BODY too, truncated: a 403 and a 404 are different refusals and the campaign board asks
  // which one this endpoint gives, not merely that it gave one.
  peerFetchBody: peerFetch?.body ?? peerFetch?.threw ?? null,
  failures,
});

for (const [label, lines] of raw) {
  console.log(`\n===== ${label}: ${lines.length} console lines =====`);
  for (const l of lines) console.log(`  ${l}`);
}

w1.close();
w2.close();
