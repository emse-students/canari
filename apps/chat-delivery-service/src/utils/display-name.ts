import type { EntityManager } from 'typeorm';

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
    const rows: {
      displayName: string | null;
      firstName: string | null;
      lastName: string | null;
    }[] = await manager.query(
      `SELECT "displayName", "firstName", "lastName" FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    if (!rows[0]) return '';
    const { displayName, firstName, lastName } = rows[0];
    return displayName?.trim() || [firstName, lastName].filter(Boolean).join(' ') || '';
  } catch {
    return '';
  }
}
