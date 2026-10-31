import { resolveUserDisplayName, getUserDisplayNameSync } from '$lib/utils/users/displayName';

/** A voter carried WITH its id: two voters may share a display name, never an id. */
export interface PollVoter {
  id: string;
  name: string;
}

/** Names the hover tooltip draws before it says "+ N". A longer list belongs in the sheet. */
export const POLL_TOOLTIP_MAX_VOTERS = 10;

/**
 * Splits a voter list into what a tooltip may draw and how many it leaves out.
 *
 * A tooltip is a fixed box over the page: 45 names made it taller than the screen and the top of it
 * was cut off (user, 2026-10-24). The cap keeps its height a constant; the rest is one tap away in
 * the sheet, which scrolls.
 */
export function capVoters<T>(
  voters: T[],
  max = POLL_TOOLTIP_MAX_VOTERS
): { shown: T[]; extra: number } {
  return { shown: voters.slice(0, max), extra: Math.max(0, voters.length - max) };
}

/** Resolves voter ids to display names, keeping the id as the row's identity. */
export async function resolvePollVoters(ids: string[]): Promise<PollVoter[]> {
  const names = await Promise.all(ids.map((id) => resolveUserDisplayName(id)));
  return names.map((n, i) => ({ id: ids[i], name: n ?? getUserDisplayNameSync(ids[i], ids[i]) }));
}
