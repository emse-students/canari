/**
 * What the per-account, per-community records of the history ask share (`historyAnswered.ts`,
 * `historyClosedSeen.ts`): each keeps one `localStorage` map of community id to record, with its
 * own validation on read, and forgets a community the same way.
 */

/**
 * Drops `workspaceId` from the records `read` returns for `userId`, writing back only when there
 * was something to drop - a community this device never recorded costs no write.
 *
 * @returns whether a record was dropped.
 */
export function forgetCommunityRecord<R>(
  read: (userId: string) => Record<string, R>,
  write: (userId: string, records: Record<string, R>) => void,
  userId: string,
  workspaceId: string
): boolean {
  const records = read(userId);
  if (!(workspaceId in records)) return false;
  delete records[workspaceId];
  write(userId, records);
  return true;
}
