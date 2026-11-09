/**
 * The directory, answered from memory: the bench measures a mount, not a profile lookup. Every
 * other export is the real module's.
 */
export * from '../../../src/lib/utils/users/displayName';

/** The real one asks `/api/users/batch`; here the id is its own name, at once. */
export async function resolveUserDisplayName(userId: string): Promise<string | null> {
  return userId;
}
