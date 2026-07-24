import type { EntityManager } from 'typeorm';

/** Shape returned by the users table query. */
interface UserNameRow {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
}

/** Builds a human-readable display name from the user row fields. */
function formatDisplayName(row: UserNameRow): string {
  return row.displayName?.trim() || [row.firstName, row.lastName].filter(Boolean).join(' ') || '';
}

/**
 * Resolves a user's human-readable display name from the shared `users` table
 * (auth-service schema, same database). Returns '' when the user is unknown or
 * the query fails - callers always treat the name as best-effort decoration
 * (notification titles, call ring banners), never as authorization data.
 */
export async function resolveUserDisplayName(
  manager: EntityManager,
  userId: string
): Promise<string> {
  try {
    const rows: UserNameRow[] = await manager.query(
      `SELECT id, "displayName", "firstName", "lastName" FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    if (!rows[0]) return '';
    return formatDisplayName(rows[0]);
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
    const rows: UserNameRow[] = await manager.query(
      `SELECT id, "displayName", "firstName", "lastName" FROM users WHERE id = ANY($1)`,
      [unique]
    );
    for (const row of rows) {
      result.set(row.id, formatDisplayName(row));
    }
  } catch {
    // Best-effort: return empty map on failure.
  }
  return result;
}
