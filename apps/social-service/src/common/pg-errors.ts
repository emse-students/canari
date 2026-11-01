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

/** A query runner (a TypeORM repository's or manager's `query`), outside any aborted transaction. */
export type CatalogQuery = (sql: string, params: unknown[]) => Promise<unknown>;

/**
 * The columns of the index named `indexName` in `schemaName` (a unique constraint's backing index
 * carries the constraint's name). `$2` null matches any schema, for a driver error that names none.
 */
const INDEX_COLUMNS_SQL = `
  SELECT a.attname
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
   WHERE i.relname = $1 AND ($2::text IS NULL OR n.nspname = $2)`;

/**
 * Whether a driver error is Postgres refusing a duplicate on the unique index whose columns are
 * EXACTLY `columns` - whatever that index is called. `violatesUniqueIndex` needs the name, and a
 * name is only as reliable as the schema it was read from: a table built by `synchronize` and the
 * live one built by hand can name the same index differently. The SQLSTATE and the constraint the
 * driver reports are structured fields; the columns are read from the catalog for THAT constraint,
 * never from the error's `detail` prose (localised by `lc_messages`). One catalog read, on the
 * violation path only. `query` must run outside the transaction the violation aborted.
 */
export async function violatesUniqueColumns(
  err: unknown,
  columns: readonly string[],
  query: CatalogQuery
): Promise<boolean> {
  if (!isUniqueViolation(err)) return false;
  const { constraint, schema } = err as { constraint?: string; schema?: string };
  if (!constraint) return false;
  const rows = (await query(INDEX_COLUMNS_SQL, [constraint, schema ?? null])) as {
    attname: string;
  }[];
  const got = rows.map((r) => r.attname).sort();
  const want = [...columns].sort();
  return got.length === want.length && got.every((c, i) => c === want[i]);
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
