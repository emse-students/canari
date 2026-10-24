/**
 * The one way a per-community record store (`historyAnswered.ts`, `historyClosedSeen.ts`,
 * `pagedHistoryAnswer.ts`) forgets a community, so they cannot drift apart.
 */

/**
 * Removes `workspaceId` from a per-account record map held in storage, writing back only when
 * something was actually there (a no-op must cost no storage write).
 *
 * @param read Reads every record of `userId`, by community.
 * @param write Writes them back (and removes the key when none is left).
 */
export function forgetWorkspaceRecord<T>(
  userId: string,
  workspaceId: string,
  read: (userId: string) => Record<string, T>,
  write: (userId: string, records: Record<string, T>) => void
): void {
  const records = read(userId);
  if (!(workspaceId in records)) return;
  delete records[workspaceId];
  write(userId, records);
}
