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
 * Whether a driver error is Postgres refusing a duplicate on THE unique index `indexName`: the
 * SQLSTATE and the constraint name the driver reports beside it, so a transaction writing to several
 * unique indexes tells which one answered without reading a message.
 */
export function violatesUniqueIndex(err: unknown, indexName: string): boolean {
  return isUniqueViolation(err) && (err as { constraint?: string }).constraint === indexName;
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

/** Postgres error code for a row naming a parent that does not exist. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Whether a driver error is Postgres refusing a row whose foreign key names nothing - an id the
 * caller sent that does not exist. Read from the SQLSTATE, like the others.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return sqlState(err) === FOREIGN_KEY_VIOLATION;
}

/** Postgres error code for a transaction chosen as the victim of a deadlock. */
const DEADLOCK_DETECTED = '40P01';

/**
 * Whether a driver error is Postgres breaking a deadlock by aborting THIS transaction. Nothing it
 * wrote stands, so the same request may simply be sent again - which is how a caller should answer
 * it, as a typed "try again", never as a 500.
 */
export function isDeadlock(err: unknown): boolean {
  return sqlState(err) === DEADLOCK_DETECTED;
}
