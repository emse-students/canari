import type { Logger } from '@nestjs/common';

/**
 * EACH ITEM IS ACCUSED ONCE - the ledger behind chat-delivery's hourly health reports.
 *
 * The reports name permanent states: a commit-log hole cannot be refilled, a conversation with no
 * holder cannot be reopened. Printed every hour, the same ERROR became 24 identical lines a day, the
 * line a reader learns to skip - and the next real hole would have hidden behind it (CLAUDE.md, "NOISE
 * IS NEVER ACCEPTABLE"). So a report hands every item it finds to {@link settleAccusations}, which
 * answers ONE question from durable state: was this item already accused in this exact state? Only
 * the items it was not (`fresh`) are printed at the report's level, with the evidence the line always
 * carried. The others (`known`) are counted by one daily LOG line per report
 * ({@link summarizeAccusations}). An item the report stops naming leaves the ledger and is logged once.
 *
 * NO CLOCK DECIDES ANYTHING. A state is re-accused when its fingerprint changes and never because time
 * passed; `accusedAt` is printed, never compared. The daily summary is scheduled, but what it says is
 * read from the table, so running it twice, or after a missed day, says the same true thing.
 *
 * THE LEDGER IS NEVER EVIDENCE THAT ANYTHING IS BROKEN: the report's own query is, every hour. A row
 * here exists only while the report keeps naming its item, and a report that consulted the ledger to
 * decide what is broken would silence the very trigger it de-duplicates.
 */

/** What the ledger needs of a database: one parameterised statement. A manager or a DataSource. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Every report that keeps a ledger, by the name stored in `report_accusations.report`. */
export const REPORT_KINDS = {
  commitLogHole: 'commit_log_hole',
  holders: 'holders',
  strandedDevice: 'stranded_device',
  staleBase: 'stale_base',
} as const;

/** One of {@link REPORT_KINDS}. */
export type ReportKind = (typeof REPORT_KINDS)[keyof typeof REPORT_KINDS];

/** An item a report names: its identity, and the fingerprint of the state that makes it accusable. */
export interface ReportItem {
  /** A group id, or a device id - unique within one report's run. */
  id: string;
  /** What was accused. Must not contain anything that moves while the defect stands still. */
  state: string;
}

/** An item that left the ledger because its report no longer names it. */
export interface LeftItem {
  itemId: string;
  state: string;
  accusedAt: Date;
}

/** What {@link settleAccusations} decided for one run of one report. */
export interface Settlement<T extends ReportItem> {
  /** Items accused by THIS run: new, or in a state the ledger did not hold. Print them. */
  fresh: T[];
  /** Items already accused in this exact state. Count them, never print them again. */
  known: T[];
  /** Items the ledger held that this run no longer names - healed, or gone with their group. */
  left: LeftItem[];
}

/**
 * Settles one run of one report against the ledger: claims the items to accuse, releases the items
 * that left.
 *
 * THE CLAIM IS ONE STATEMENT, so it is safe across replicas: an `INSERT ... ON CONFLICT DO UPDATE`
 * whose update fires only when the stored state DIFFERS, `RETURNING` exactly the rows it wrote. Two
 * replicas running the same report at the same hour race on the primary key, and only the statement
 * that wrote the row returns it - one accusation, never two. The release is one `DELETE ...
 * RETURNING`, so an item that left is logged by the one replica whose delete took it.
 *
 * `items` with one id twice would make PostgreSQL refuse the claim (an `ON CONFLICT DO UPDATE` may
 * not touch a row twice); the reports build their items from grouped rows, so that is impossible by
 * construction - and if it ever happened the throw reaches the cron's own `catch`, at ERROR.
 *
 * @param db - anything with a `query`, so the caller passes its repository's manager.
 * @param report - which report's ledger.
 * @param items - every item the report names THIS run, whether new or already accused.
 * @param logger - receives the one LOG line naming the items that left - and nothing else, at any level.
 * @param prefix - the report's own log prefix, so the line reads as part of that report.
 */
export async function settleAccusations<T extends ReportItem>(
  db: Queryable,
  report: ReportKind,
  items: T[],
  logger: Pick<Logger, 'log'>,
  prefix: string
): Promise<Settlement<T>> {
  const ids = items.map((i) => i.id);

  let claimed = new Set<string>();
  if (items.length > 0) {
    const rows = (await db.query(
      `INSERT INTO report_accusations (report, "itemId", state)
       SELECT $1, i.id, i.state
         FROM unnest($2::text[], $3::text[]) AS i(id, state)
       ON CONFLICT (report, "itemId") DO UPDATE
          SET state = EXCLUDED.state, "accusedAt" = now()
        WHERE report_accusations.state IS DISTINCT FROM EXCLUDED.state
       RETURNING "itemId"`,
      [report, ids, items.map((i) => i.state)]
    )) as { itemId: string }[];
    claimed = new Set(rows.map((r) => r.itemId));
  }

  // Wrapped in a CTE so the statement is a SELECT: TypeORM's PostgreSQL driver answers a bare
  // `DELETE ... RETURNING` with `[rows, rowCount]`, not the rows (measured by the integration spec).
  const left = (await db.query(
    `WITH gone AS (
       DELETE FROM report_accusations
        WHERE report = $1 AND NOT ("itemId" = ANY($2::text[]))
       RETURNING "itemId", state, "accusedAt"
     )
     SELECT "itemId", state, "accusedAt" FROM gone ORDER BY "itemId"`,
    [report, ids]
  )) as LeftItem[];
  if (left.length > 0) {
    // ONCE, at LOG: an accusation that stopped being true is news, and only the replica whose
    // delete took the row prints it.
    logger.log(
      `${prefix}: ${left.length} item(s) accused earlier are no longer reported (healed, or gone ` +
        `with their group) and leave the ledger: ` +
        left
          .map((l) => `${l.itemId}(${l.state}, accused ${new Date(l.accusedAt).toISOString()})`)
          .join(' ')
    );
  }

  const fresh = items.filter((i) => claimed.has(i.id));
  // NOTHING is logged for the known items, not even at DEBUG: an hourly line about an unchanged
  // state is the very noise this ledger removes. The report counts them in its own line when it
  // accuses something new, and `summarizeAccusations` counts them once a day.
  const known = items.filter((i) => !claimed.has(i.id));
  return { fresh, known, left };
}

/** The one daily line of one report: how many items stand accused, and since when. */
export interface AccusationSummary {
  report: ReportKind;
  known: number;
  firstAccused: Date | null;
  lastAccused: Date | null;
}

/**
 * The daily count of what the reports already accused: ONE LOG line per report, read from the table.
 *
 * WHY IT EXISTS. Once an item is accused it is not printed again, so without this line a reader of a
 * single day's log could not tell "nothing is broken" from "the same eleven holes are still there".
 * `lastAccused` is the newest accusation: every known item has stood unchanged since at least then.
 *
 * Every report gets its line, zero included, so a missing line means the summary did not run rather
 * than that nothing is known. Correct whenever it runs: nothing here depends on when the last one did.
 *
 * @param labels - how each report names its items in the line, e.g. "group(s) with a hole".
 */
export async function summarizeAccusations(
  db: Queryable,
  logger: Pick<Logger, 'log'>,
  labels: Record<ReportKind, { prefix: string; items: string }>
): Promise<AccusationSummary[]> {
  const rows = (await db.query(
    `SELECT report, COUNT(*)::int AS known,
            MIN("accusedAt") AS "firstAccused", MAX("accusedAt") AS "lastAccused"
       FROM report_accusations
      GROUP BY report`
  )) as { report: string; known: number; firstAccused: Date; lastAccused: Date }[];
  const byReport = new Map(rows.map((r) => [r.report, r]));

  const out: AccusationSummary[] = [];
  for (const report of Object.values(REPORT_KINDS)) {
    const row = byReport.get(report);
    const summary: AccusationSummary = {
      report,
      known: Number(row?.known ?? 0),
      firstAccused: row ? new Date(row.firstAccused) : null,
      lastAccused: row ? new Date(row.lastAccused) : null,
    };
    out.push(summary);
    const { prefix, items } = labels[report];
    logger.log(
      summary.known === 0
        ? `${prefix}: daily summary - 0 ${items} already accused`
        : `${prefix}: daily summary - ${summary.known} ${items} already accused, unchanged since ` +
            `${summary.lastAccused?.toISOString()} (first accused ${summary.firstAccused?.toISOString()}); ` +
            `a new item or a changed state is accused on the hour it appears`
    );
  }
  return out;
}
