/** Postgres error code for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Whether a driver error is Postgres refusing a duplicate on a UNIQUE index - read from its SQLSTATE
 * code, never from its message, so a reworded driver error cannot change the answer.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}
