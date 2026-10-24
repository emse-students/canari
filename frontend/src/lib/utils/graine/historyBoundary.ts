import type { StoredGraineSession } from '$lib/db/types';
import { ChannelService } from '$lib/services/ChannelService';
import { historyVisibilityFor } from './runtime';

/**
 * Where a community's past stops for one of its members (WP-34).
 *
 * `historyVisibility` is not one rule but the same rule read at two moments, and the second one was
 * missing for a year: the JOIN-TIME bundle asks "may this newcomer be handed the past", and the
 * REPAIR path asks "may this member be handed THIS seed". `gatherCommunityHistory` answered the
 * first and nothing answered the second, so a community set to `joined` refused the bundle and then
 * handed the very same seeds over one session id at a time, because a newcomer meets ciphertext it
 * cannot open and asks for exactly those sessions by name. The setting was stored, broadcast,
 * narrowed fail-closed, enforced on one path and bypassed entirely on the other.
 *
 * This module owns the rule for both paths, and both sides of the wire use it:
 *
 *   the ANSWERER, because that is where a seed is about to leave a device and therefore the only
 *   place enforcement can live at all - a rule the requester applies to itself is a rule a modified
 *   client does not have;
 *
 *   the REQUESTER, because a member who already knows the community closes its past, and already
 *   knows when they arrived, must not spend a frame on the whole group to be told so. Learning by
 *   being refused what a fact in hand could have said is traffic the design owes.
 *
 * **A SESSION CAN SPAN AN ARRIVAL, so the answer is a FLOOR and not a yes or a no.** Rotation is
 * decided by the SENDER, from the distribution group's epoch, at the moment it seals its next
 * message - and a join is an EXTERNAL commit, so the sender learns of it late and seals a few more
 * messages under the session it already had. (A removal is committed by a remaining member, which
 * is why that direction rotates immediately and this one does not - the asymmetry is visible in
 * COMM-12's own log, four markers under two sessions.) Withholding such a session costs the newcomer
 * messages sent AFTER they arrived; handing it over gives them messages sent before. Only
 * `firstIndex` expresses the difference, and it is the field that exists for exactly this: "non-zero
 * when the seed was handed over mid-session, so a member who joined late cannot open messages sent
 * before they were allowed to".
 *
 * **The floor is computed by the SERVER, and that is what makes it deterministic.** Both halves -
 * the member's arrival row and the message dates - are its own columns, written by one clock, so
 * every device that asks gets the same number for the same state and neither the member answering
 * nor the member asking supplies anything the result depends on. No device clock enters the
 * decision at any point.
 *
 * Protocol: `docs/wiki/protocols/channel-encryption.md`.
 */

/**
 * Built on first use, never at import.
 *
 * This module is reached from the frame handler, which the community-join path imports very early;
 * a constructor running at import time makes the whole graph order-sensitive.
 */
let channelServiceInstance: ChannelService | null = null;
function channels(): ChannelService {
  channelServiceInstance ??= new ChannelService();
  return channelServiceInstance;
}

/**
 * How many session ids one floor query names at most.
 *
 * The ids travel in the query string (`?sessions=a,b,...`), about 37 bytes each, and a history
 * bundle under `joined` asks for EVERY held session of the community - up to
 * `GRAINE_HISTORY_BUNDLE_MAX_SEEDS`. One query for all of them would be a URL past what the edge
 * accepts, refused as a whole, and a refusal here fails closed: the member would be handed nothing.
 * 100 ids is under 4 KB of query.
 */
export const HISTORY_FLOOR_QUERY_MAX_SESSIONS = 100;

/** How many floor queries one answer keeps in flight at once (see {@link historyFloorsFor}). */
export const HISTORY_FLOOR_QUERY_CONCURRENCY = 4;

/**
 * Where each held session becomes readable for `forUserId` - the floors their seeds must travel at.
 *
 * Grouped by channel because that is how the server authorizes the question: the caller must be
 * able to read the channel whose messages draw the floor. A repair request is built per channel, so
 * this is one call in every ordinary case and stays correct if that ever stops being true. A channel
 * with more sessions than {@link HISTORY_FLOOR_QUERY_MAX_SESSIONS} is asked in slices.
 *
 * @param held Sessions this device holds (or was handed) - only their salon and id are read.
 * @param forUserId Whose arrival draws the floors.
 * @returns `sessionId -> lowest readable index`. A session ABSENT from the map has nothing that
 *   member may read and must be withheld whole.
 * @throws When any channel's floors cannot be established. The caller must then refuse: a boundary
 *   nobody can place is not a boundary, and guessing it wide is the expensive half of the same
 *   asymmetry `historyVisibilityFor` already fails closed on.
 */
export async function historyFloorsFor(
  held: readonly Pick<StoredGraineSession, 'channelId' | 'sessionId'>[],
  forUserId: string
): Promise<Map<string, number>> {
  const byChannel = new Map<string, string[]>();
  for (const session of held) {
    const ids = byChannel.get(session.channelId);
    if (ids) ids.push(session.sessionId);
    else byChannel.set(session.channelId, [session.sessionId]);
  }

  const queries: { channelId: string; slice: string[] }[] = [];
  for (const [channelId, sessionIds] of byChannel) {
    for (let at = 0; at < sessionIds.length; at += HISTORY_FLOOR_QUERY_MAX_SESSIONS) {
      queries.push({
        channelId,
        slice: sessionIds.slice(at, at + HISTORY_FLOOR_QUERY_MAX_SESSIONS),
      });
    }
  }
  if (queries.length > 1) {
    console.debug(
      `[GRAINE] placing ${held.length} history floor(s) for ${forUserId} in ${queries.length} queries, ` +
        `${HISTORY_FLOOR_QUERY_CONCURRENCY} at a time`
    );
  }

  // A FEW AT A TIME, NOT ONE AFTER ANOTHER: a capped history bundle can name 8000 sessions, which
  // is 80 queries - sequential, that held the answer for 80 round trips. Bounded so one answer does
  // not open 80 requests at once. Any refusal fails the whole (fail-closed, the caller says so).
  const floors = new Map<string, number>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < queries.length) {
      const { channelId, slice } = queries[next++];
      const answer = await channels().graineHistoryFloor(channelId, forUserId, slice);
      for (const [sessionId, floor] of Object.entries(answer)) floors.set(sessionId, floor);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(HISTORY_FLOOR_QUERY_CONCURRENCY, queries.length) }, worker)
  );
  return floors;
}

/**
 * Applies the floors {@link historyFloorsFor} returned to a list of seeds: each kept seed RAISED to
 * its floor, never lowered, and every session absent from `floors` withheld whole.
 *
 * ONE implementation for the three places a floor is applied - the two answers that hand seeds over
 * (`gatherNamedSessions`, `gatherCommunityHistory`) and the receiver that absorbs a bundle under
 * `joined` (`absorbSeedBundle`) - so "raise, never lower" cannot be written three ways.
 *
 * @returns The seeds that may travel or be kept, floors applied, and the ids withheld.
 */
export function applyHistoryFloors<T extends { sessionId: string; firstIndex: number }>(
  seeds: readonly T[],
  floors: ReadonlyMap<string, number>
): { kept: T[]; withheld: string[] } {
  const kept: T[] = [];
  const withheld: string[] = [];
  for (const seed of seeds) {
    const floor = floors.get(seed.sessionId);
    if (floor === undefined) {
      withheld.push(seed.sessionId);
      continue;
    }
    // RAISED, NEVER LOWERED. A held floor is what this device was given itself, and a floor that
    // widened access would be the leak this whole boundary exists to close.
    kept.push({ ...seed, firstIndex: Math.max(seed.firstIndex, floor) });
  }
  return { kept, withheld };
}

/**
 * The instant before which a member may not be handed anything, or `null` when the community
 * shares its past and there is no boundary at all.
 *
 * **Used only to decide whether it is worth ASKING**, never to decide what may be given - that is
 * {@link historyFloorsFor}, on the answering side. Both timestamps it is compared against come from
 * the server too: this is the arrival row, and the other side is a message's own `createdAt`.
 *
 * **Read fresh every time, never cached.** A member who is removed and invited back starts again,
 * later, and a cached start is the EARLIER one - the more permissive one. The call is one roster
 * fetch on a path that already crosses the network, so there is nothing to buy back.
 *
 * @param workspaceId The community whose rule applies.
 * @param userId Whose arrival draws the line - lower-cased here.
 * @returns Epoch milliseconds of that member's arrival, or `null` when the past is shared.
 * @throws When the past is closed and the arrival cannot be established.
 */
export async function historyFloorFor(workspaceId: string, userId: string): Promise<number | null> {
  if (historyVisibilityFor(workspaceId) === 'shared') return null;

  const who = userId.toLowerCase();
  const members = await channels().listWorkspaceMembers(workspaceId);
  const row = members.find((m) => String(m.userId ?? '').toLowerCase() === who);
  if (!row) {
    throw new Error(`${who} is not on the roster of community ${workspaceId.slice(0, 8)}`);
  }
  const joinedAt = Date.parse(String(row.joinedAt ?? ''));
  if (!Number.isFinite(joinedAt)) {
    throw new Error(`${who} has no readable arrival date in community ${workspaceId.slice(0, 8)}`);
  }
  return joinedAt;
}

/**
 * Whether something dated `at` sits on the readable side of `floor`.
 *
 * One line, exported, so the one caller that needs it cannot drift into a different comparison.
 * The boundary is inclusive of the arrival itself.
 */
export function withinHistoryFloor(floor: number | null, at: number): boolean {
  return floor === null || at >= floor;
}
