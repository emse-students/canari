/**
 * Key-group frames this device acknowledged as unreadable for good, per group and per cause, for
 * the life of the app session.
 *
 * WHY IT EXISTS: a seed request says WHAT is missing (session ids) and nothing about WHY, and the
 * request volume measured on production 2026-10-12 (185 or more in 37 minutes from 34 devices of
 * one community, against 22 new sessions) could not be explained from the log
 * (`prod-queue-and-epoch-audit-2026-10-12`, F3). The one cause a device can see is a seed frame it
 * received and could not open - sealed at an epoch it had already left, or too far ahead in a
 * sender's ratchet. A lost frame's session id is unreadable too, so the count is per GROUP: the
 * request line prints it beside what it asks for, and a request on a group that lost frames is
 * evidence for that cause, one on a group that lost none is evidence against it.
 *
 * In memory on purpose: it describes this session's deliveries, which is what the request lines of
 * this session are read against. Nothing decides on it.
 */

const losses = new Map<string, Map<string, number>>();

/** Records one key-group frame acknowledged unreadable for good, under its classified cause. */
export function noteKeyGroupFrameLost(groupId: string, cause: string): void {
  const perCause = losses.get(groupId) ?? new Map<string, number>();
  perCause.set(cause, (perCause.get(cause) ?? 0) + 1);
  losses.set(groupId, perCause);
}

/**
 * The losses of one key group as `cause:count` pairs, `none` when it lost nothing - the form a log
 * line prints.
 */
export function describeKeyGroupFrameLosses(groupId: string): string {
  const perCause = losses.get(groupId);
  if (!perCause || perCause.size === 0) return 'none';
  return [...perCause]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cause, n]) => `${cause}:${n}`)
    .join(',');
}

/** Test seam: forgets every recorded loss. */
export function resetKeyGroupFrameLosses(): void {
  losses.clear();
}
