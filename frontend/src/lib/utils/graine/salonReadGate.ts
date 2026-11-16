import { GroupDrainAbandonedError } from '$lib/mls-client/IMlsService';
import { getTabLeadership } from '$lib/mls-client/tabLeader';
import { isGraineReady, rawChannelId, requireGraineRuntime, scopeForChannel } from './runtime';

/**
 * Why a salon page is decoded WITHOUT waiting for its key group: each one is a state in which the
 * wait could not end, or could not change what the decode finds - never a guess that it is short.
 *
 * - `no-runtime`: no session is wired, so there is no store a seed could land in.
 * - `no-scope`: the salon is not registered to a community (its listing did not name it), so no
 *   key group carries its seeds here.
 * - `key-group-unregistered`: its community's key group is not registered on this device - no
 *   drain of it can run.
 * - `follower`: a web follower tab holds no socket and drains nothing; the leader writes the seeds.
 * - `closed`: the MLS service ended before the drain did (`GroupDrainAbandonedError`).
 */
type SalonReadUnwaited =
  | 'no-runtime'
  | 'no-scope'
  | 'key-group-unregistered'
  | 'follower'
  | 'closed';

/** What a salon reader learns before decoding its page. */
export type SalonReadGate =
  | { kind: 'drained'; groupId: string; waited: boolean }
  | { kind: 'unwaited'; reason: SalonReadUnwaited };

/**
 * Resolves once a salon page may be DECODED: the key group carrying the salon's seeds is drained
 * on this link (`IMlsService.whenGroupDrained` - the mailbox listed since the socket opened, and the
 * group's frames applied), or it is known that no such drain can run here.
 *
 * WHY A READER WAITS FOR THE DRAIN (1.6.11 logs, 2026-11-14). A seed is a durable frame on the key
 * group, so a device coming back holds the seeds its members minted while it was away in its
 * pending queue - and a salon opened on a cold start or a resume fetched and decoded its page
 * while that queue was still being listed. Every row of a session whose seed was in the queue read
 * `unreadable - missing seed`, was warned, and was drawn only by the re-read the drain's end
 * announced: a race that healed cleanly, which is still a defect. The two paths overlapped because
 * nothing ordered the decode after the drain; this is that order. The page is FETCHED meanwhile
 * (and the stored copy drawn), so the wait costs only the decode, and after it a seed still missing
 * is one this device was never sent - the warning and the request then say something true.
 *
 * AN EVENT, NEVER A CLOCK: the drain proof is the same one the seed request waits on
 * (`repair.ts`, `whenAskable`), and every way it cannot end is a {@link SalonReadUnwaited} decided
 * from state before waiting. Never await it inside a frame of the key group itself: that frame is
 * the group's current work, so the group cannot drain until it returns.
 *
 * @param channelId Raw uuid or `channel_`-prefixed. Called after `whenSalonEntryDecided`, so a salon
 *   being entered has its scope registered by then.
 */
export async function whenSalonKeysDrained(channelId: string): Promise<SalonReadGate> {
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
  console.debug(
    `[CHANNEL] page of ${tag} waits for key group ${groupId.slice(0, 8)}... to drain before it is decoded`
  );
  try {
    await mlsService.whenGroupDrained(groupId);
  } catch (e) {
    if (e instanceof GroupDrainAbandonedError) return unwaited(tag, 'closed');
    throw e;
  }
  return { kind: 'drained', groupId, waited: true };
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
