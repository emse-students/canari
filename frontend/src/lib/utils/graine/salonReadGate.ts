import { GroupDrainAbandonedError, type IMlsService } from '$lib/mls-client/IMlsService';
import { getTabLeadership, onLeaderTabChanged } from '$lib/mls-client/tabLeader';
import { isGraineReady, rawChannelId, requireGraineRuntime, scopeForChannel } from './runtime';

/**
 * Why a salon page is decoded WHOLE without waiting for its key group: each one is a state in which
 * the wait could not end, or could not change what the decode finds - never a guess that it is short.
 *
 * - `no-runtime`: no session is wired, so there is no store a seed could land in.
 * - `no-scope`: the salon is not registered to a community (its listing did not name it), so no
 *   key group carries its seeds here.
 * - `key-group-unregistered`: its community's key group is not registered on this device - no
 *   drain of it can run.
 * - `follower`: a web follower tab holds no socket and drains nothing; the leader writes the seeds.
 *   Also what a leader DEMOTED during the wait answers: from then on it drains nothing either.
 * - `closed`: the MLS service ended before the drain did (`GroupDrainAbandonedError`).
 */
type SalonReadUnwaited =
  | 'no-runtime'
  | 'no-scope'
  | 'key-group-unregistered'
  | 'follower'
  | 'closed';

/** What a salon reader learns about the seeds its page may still be waiting for. */
export type SalonReadGate =
  | { kind: 'drained'; groupId: string; waited: boolean }
  | { kind: 'unwaited'; reason: SalonReadUnwaited };

/**
 * The key group is still being drained: a row whose seed is missing now may find it in the queue.
 * `drained()` is the wait, started only by a reader that HAS such a row - a page whose every seed is
 * held registers no waiter at all.
 */
export interface SalonKeysDraining {
  kind: 'draining';
  groupId: string;
  drained: () => Promise<SalonReadGate>;
}

/**
 * Where the seeds of a salon's page stand NOW, read from state, never waited for.
 *
 * WHY A READER ASKS (1.6.11 logs, 2026-11-14). A seed is a durable frame on the key group, so a
 * device coming back holds the seeds its members minted while it was away in its pending queue - and
 * a salon opened on a cold start or a resume decoded its page while that queue was still being
 * listed. Every row of a session whose seed was in the queue read `unreadable - missing seed`, was
 * warned, and was drawn only by the re-read the drain's end announced: a race that healed cleanly,
 * which is still a defect.
 *
 * WHAT THE ANSWER ORDERS, AND WHAT IT DOES NOT. `draining` orders only the rows whose seed is
 * MISSING after the drain: the store is the discriminator, so a row whose seed is held is decoded and
 * drawn at once, whatever the link is doing (charter principle 2, and the slow-link rule that no
 * screen waits for the network to draw). A missing row is neither warned nor asked for until
 * {@link SalonKeysDraining.drained} resolves; after it, a seed still missing is one this device was
 * never sent, and the warning and the request say something true.
 *
 * AN EVENT, NEVER A CLOCK: the drain proof is the one the seed request waits on (`repair.ts`,
 * `whenAskable`), and every way it cannot end is a {@link SalonReadUnwaited} decided from state, here
 * or - for a demotion or a service closing during the wait - by the event that makes it so. Never
 * await `drained()` inside a frame of the key group itself: that frame is the group's current work,
 * so the group cannot drain until it returns.
 *
 * @param channelId Raw uuid or `channel_`-prefixed. Read after `whenSalonEntryDecided`, so a salon
 *   being entered has its scope registered by then.
 */
export function salonKeysNow(channelId: string): SalonReadGate | SalonKeysDraining {
  const channel = rawChannelId(channelId);
  const tag = channel.slice(0, 8);
  if (!isGraineReady()) return unwaited(tag, 'no-runtime');
  if (getTabLeadership() === 'follower') return unwaited(tag, 'follower');
  const scope = scopeForChannel(channel);
  if (!scope) return unwaited(tag, 'no-scope');
  const { mlsService } = requireGraineRuntime('cannot order a salon read after its key group');
  const groupId = mlsService.distributionGroupFor(scope);
  if (!groupId) return unwaited(tag, 'key-group-unregistered');
  if (mlsService.isGroupDrained(groupId)) return { kind: 'drained', groupId, waited: false };
  return { kind: 'draining', groupId, drained: () => waitForDrain(mlsService, tag, groupId) };
}

/**
 * The wait behind {@link SalonKeysDraining.drained}. It settles on the FIRST of three events, each a
 * proof and none a clock: the group drains (`whenGroupDrained`), the service closes
 * (`GroupDrainAbandonedError`), or this tab is demoted to follower - which closes its socket, so the
 * group would never read drained here again and the wait would hang until the reload the demotion
 * schedules. A demotion BEFORE the wait is read from state, for the same reason.
 */
async function waitForDrain(
  mlsService: IMlsService,
  tag: string,
  groupId: string
): Promise<SalonReadGate> {
  if (getTabLeadership() === 'follower') return unwaited(tag, 'follower');
  console.debug(
    `[CHANNEL] page of ${tag} holds its rows with no seed until key group ${groupId.slice(0, 8)}... drains`
  );
  let stopWatching: () => void = () => {};
  const demoted = new Promise<'demoted'>((resolve) => {
    stopWatching = onLeaderTabChanged(() => {
      if (getTabLeadership() === 'follower') resolve('demoted');
    });
  });
  try {
    const outcome = await Promise.race([
      mlsService.whenGroupDrained(groupId).then(() => 'drained' as const),
      demoted,
    ]);
    if (outcome === 'demoted') return unwaited(tag, 'follower');
    return { kind: 'drained', groupId, waited: true };
  } catch (e) {
    if (e instanceof GroupDrainAbandonedError) return unwaited(tag, 'closed');
    throw e;
  } finally {
    stopWatching();
  }
}

/** Says why the page of `tag` is decoded without the drain, and answers it. */
function unwaited(tag: string, reason: SalonReadUnwaited): SalonReadGate {
  // `follower` and `no-runtime` are routine (a second tab, a test or a signed-out shell); the others
  // mean a row missing its seed now may be unreadable for a reason the drain could not settle.
  if (reason === 'follower' || reason === 'no-runtime') {
    console.debug(`[CHANNEL] page of ${tag} decoded without its key-group drain - ${reason}`);
  } else {
    console.info(`[CHANNEL] page of ${tag} decoded without its key-group drain - ${reason}`);
  }
  return { kind: 'unwaited', reason };
}
