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
 * Where each held session becomes readable for `forUserId` - the floors their seeds must travel at.
 *
 * Grouped by channel because that is how the server authorizes the question: the caller must be
 * able to read the channel whose messages draw the floor. A repair request is built per channel, so
 * this is one call in every ordinary case and stays correct if that ever stops being true.
 *
 * @param held Sessions this device holds and was asked for.
 * @param forUserId Whose arrival draws the floors.
 * @returns `sessionId -> lowest readable index`. A session ABSENT from the map has nothing that
 *   member may read and must be withheld whole.
 * @throws When any channel's floors cannot be established. The caller must then refuse: a boundary
 *   nobody can place is not a boundary, and guessing it wide is the expensive half of the same
 *   asymmetry `historyVisibilityFor` already fails closed on.
 */
export async function historyFloorsFor(
  held: readonly StoredGraineSession[],
  forUserId: string
): Promise<Map<string, number>> {
  const byChannel = new Map<string, string[]>();
  for (const session of held) {
    byChannel.set(session.channelId, [
      ...(byChannel.get(session.channelId) ?? []),
      session.sessionId,
    ]);
  }

  const floors = new Map<string, number>();
  for (const [channelId, sessionIds] of byChannel) {
    const answer = await channels().graineHistoryFloor(channelId, forUserId, sessionIds);
    for (const [sessionId, floor] of Object.entries(answer)) floors.set(sessionId, floor);
  }
  return floors;
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
