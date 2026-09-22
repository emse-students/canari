import type { EntityManager } from 'typeorm';
import { formatUserDisplayName, type UserNameRow } from './user-display-name';

/**
 * READING A NAME OUT OF THE SHARED `users` TABLE - the two queries, and nothing else.
 *
 * The RULE deciding which column wins is `user-display-name.ts`, a file this service shares
 * byte-for-byte with social-service and which the frontend's own implementation is asserted
 * against. It used to live here, preferring `displayName`, where the client preferred
 * `firstName lastName` - so one account could be titled one way in a push notification and another
 * way in the screen that notification opened.
 */

/** Shape returned by the users table query - the name columns plus the key they are filed under. */
interface IdentifiedUserNameRow extends UserNameRow {
  id: string;
}

/**
 * Resolves a user's human-readable display name from the shared `users` table
 * (core-service schema, same database). Returns '' when the user is unknown or
 * the query fails - callers always treat the name as best-effort decoration
 * (notification titles, call ring banners), never as authorization data.
 */
export async function resolveUserDisplayName(
  manager: EntityManager,
  userId: string
): Promise<string> {
  try {
    const rows: IdentifiedUserNameRow[] = await manager.query(
      `SELECT id, "displayName", "firstName", "lastName" FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    if (!rows[0]) return '';
    return formatUserDisplayName(rows[0]);
  } catch {
    return '';
  }
}

/**
 * Resolves display names for multiple userIds in a single SQL round-trip.
 * Returns a Map of userId → displayName (empty string when unknown).
 * Callers always treat the name as best-effort decoration, never as authorization data.
 */
export async function resolveUserDisplayNamesBatch(
  manager: EntityManager,
  userIds: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return result;

  try {
    const rows: IdentifiedUserNameRow[] = await manager.query(
      `SELECT id, "displayName", "firstName", "lastName" FROM users WHERE id = ANY($1)`,
      [unique]
    );
    for (const row of rows) {
      result.set(row.id, formatUserDisplayName(row));
    }
  } catch {
    // Best-effort: return empty map on failure.
  }
  return result;
}
