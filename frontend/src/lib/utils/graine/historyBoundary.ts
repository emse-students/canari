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
 * **The boundary is unambiguous, and that is a property of the design rather than a hope.** Every
 * membership change commits to the community's distribution group and advances its epoch, and
 * `graineRotationReason` rotates on any epoch it does not recognise - an ADD included, deliberately.
 * So a session minted before a member arrived is rotated away at the next send after their arrival,
 * and NO session ever spans a join. Withholding a pre-arrival seed therefore costs that member
 * nothing they could otherwise have read: there is no tail of a live session on the far side of the
 * boundary to lose.
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
 * The instant before which a member may not be handed anything, or `null` when the community
 * shares its past and there is no boundary at all.
 *
 * **Read fresh every time, never cached.** A member who is removed and invited back starts again,
 * later, and a cached start is the EARLIER one - which is the more permissive one, and precisely
 * the mistake this whole module exists to prevent. The call is one roster fetch on a path that
 * already crosses the network, so there is nothing to buy back.
 *
 * @param workspaceId The community whose rule applies.
 * @param userId Whose arrival draws the line - lower-cased here.
 * @returns Epoch milliseconds of that member's arrival, or `null` when the past is shared.
 * @throws When the past is closed and the arrival cannot be established. The caller must then
 *   refuse: a boundary nobody can place is not a boundary, and guessing it wide is the expensive
 *   half of the same asymmetry `historyVisibilityFor` already fails closed on.
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
 * One line, exported, and used by both sides so they cannot drift into two different comparisons.
 * The boundary is inclusive of the arrival itself: a seed minted in the same millisecond as the
 * join is the joiner's own arrival rotation, not the past.
 */
export function withinHistoryFloor(floor: number | null, at: number): boolean {
  return floor === null || at >= floor;
}
