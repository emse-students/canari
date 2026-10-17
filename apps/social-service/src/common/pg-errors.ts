/** Postgres error code for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

/** Postgres error code for an EXCLUDE constraint violation. */
const EXCLUSION_VIOLATION = '23P01';

/** The SQLSTATE a driver error carries, or undefined for anything that is not one. */
function sqlState(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

/**
 * Whether a driver error is Postgres refusing a duplicate on a UNIQUE index - read from its SQLSTATE
 * code, never from its message, so a reworded driver error cannot change the answer.
 */
export function isUniqueViolation(err: unknown): boolean {
  return sqlState(err) === UNIQUE_VIOLATION;
}

/**
 * Whether a driver error is Postgres refusing a row an EXCLUDE constraint forbids - for bookings,
 * a second live booking on the same resource and instant (`bookings_live_no_overlap`, migration
 * 087). Read from the SQLSTATE, like `isUniqueViolation`; the constraint's name is in
 * `(err as { constraint?: string }).constraint` when a caller must tell two exclusions apart.
 */
export function isExclusionViolation(err: unknown): boolean {
  return sqlState(err) === EXCLUSION_VIOLATION;
}
