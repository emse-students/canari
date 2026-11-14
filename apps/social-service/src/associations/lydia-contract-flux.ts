import { Logger } from '@nestjs/common';

/**
 * THE PLATFORM'S LYDIA FLUX - what the Lydia partnership counts, measured from Canari's own rows
 * (docs/wiki/lydia-contract-flux.md).
 *
 * The flux of a contract year is the volume collected on the Businesses CANARI'S ENROLMENT created:
 * the payments Lydia confirmed within the year minus the refunds executed within the year, TTC,
 * across every association. A payment taken on a historical account (an association's own Lydia
 * account, collecting through a bridge, lydia-account-bridge.ts) never counts: it belongs to that
 * association's earlier Lydia contract.
 *
 * WHICH BUSINESS TOOK A PAYMENT is the purchase record's own vendor token (migration 169), written
 * with the record at the settlement, so it survives the deletion of the answer that issued it. A
 * record written without it (an image older than 169, during a rollout) is read through the row that
 * issued it - `product_checkouts."vendorToken"` of a boutique purchase's paid attempt,
 * `submissions."lydiaVendorToken"` of a form answer (the trace a refund follows,
 * `RefundsService.targetsOf`) - and counted as `recordWithoutToken`, logged at WARN. WHETHER THAT BUSINESS IS CANARI-ENROLLED is
 * `lydia_enrolled_businesses` (migration 168), written by the link itself
 * ({@link recordEnrolledBusiness}). Neither is inferred from a date or an association's current
 * columns, which a bridge swaps and an unlink clears.
 */

/** Runs one SQL statement on whatever connection the caller holds. */
export type FluxQuery = (sql: string, params: unknown[]) => Promise<unknown>;

/** The log tag of every line about the platform's Lydia flux. */
export const LYDIA_FLUX_LOG_TAG = '[LYDIA-FLUX]';

/** What one contract-year window holds, in cents TTC. */
export interface LydiaFluxMeasure {
  /** Payments confirmed in the window on a Canari-enrolled Business. */
  paidCents: number;
  paymentCount: number;
  /** Refunds executed in the window of payments taken on a Canari-enrolled Business. */
  refundedCents: number;
  refundCount: number;
  /** `paidCents - refundedCents`: the flux. */
  fluxCents: number;
  /** Payments confirmed in the window on a Business Canari did NOT enrol (a historical account). */
  excludedCents: number;
  excludedCount: number;
  /** Lydia payments in the window whose Business no row names: counted nowhere, reported. */
  untraceableCount: number;
}

/** A `YYYY-MM-DD` calendar date. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `value` is a real `YYYY-MM-DD` date (no 2026-02-30). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * The window's bounds as instants: midnight in Paris of each date, the contract's calendar (the
 * platform and its partner are French). `[from, to)`.
 */
const WINDOW_SQL = `($1::date::timestamp AT TIME ZONE 'Europe/Paris')`;
const WINDOW_END_SQL = `($2::date::timestamp AT TIME ZONE 'Europe/Paris')`;

/**
 * Every Lydia payment Canari recorded: money Lydia confirmed (`paid`, `paid_not_granted`, or
 * `refunded` - refunded since, and the refund is counted on its own date), online, with the vendor
 * token of the Business that took it - the record's own (migration 169), else the issuing row's - or
 * NULL when no row names it. `onRecord` says which.
 */
const PAYMENTS_SQL = `
  SELECT r."amountCents" AS amount,
         (r."lydiaVendorToken" IS NOT NULL) AS "onRecord",
         COALESCE(r."lydiaVendorToken",
           CASE WHEN r.source = 'product' THEN (
                  SELECT c."vendorToken" FROM product_checkouts c
                   WHERE c."purchaseRecordId" = r.id AND c.status = 'paid'
                   ORDER BY c."vendorToken" LIMIT 1)
                ELSE s."lydiaVendorToken" END) AS token
    FROM purchase_records r
    LEFT JOIN submissions s ON r.source = 'form' AND s.id = r."submissionId"
   WHERE r."paymentMethod" = 'online'
     AND r.status IN ('paid', 'paid_not_granted', 'refunded')
     AND r."paidAt" >= ${WINDOW_SQL} AND r."paidAt" < ${WINDOW_END_SQL}`;

/**
 * Whether the Business of the joined row counts: Canari's enrolment created it (`e`, migration 168)
 * AND no bridge holds it as an association's historical account (`h`, migration 167). The second
 * test is the bridge's own durable fact, so a historical account never counts even if a ledger row
 * names it by mistake (reported, see `contradictionCount`).
 */
const ENROLLED_SQL = `e."vendorToken" IS NOT NULL AND h."historicalVendorToken" IS NULL`;

/**
 * Measures the flux of `[from, to)` (two `YYYY-MM-DD` dates, Paris midnights). Two reads, whatever
 * the volume. A refund counts on the date Lydia executed it - its answer, or the manager's
 * declaration after checking Lydia (the date the statement prints) - and only once Lydia refunded:
 * `confirmed`, or `pending` with Lydia's own `refunded-unrecorded` answer.
 */
export async function measureLydiaFlux(
  query: FluxQuery,
  from: string,
  to: string,
  logger: Logger = new Logger('LydiaContractFlux')
): Promise<LydiaFluxMeasure> {
  logger.debug(`${LYDIA_FLUX_LOG_TAG} measuring [${from}, ${to})`);
  const [payments] = (await query(
    `SELECT
       COALESCE(SUM(p.amount) FILTER (WHERE ${ENROLLED_SQL}), 0)::bigint AS "paidCents",
       COUNT(*) FILTER (WHERE ${ENROLLED_SQL})::int AS "paymentCount",
       COALESCE(SUM(p.amount) FILTER (WHERE p.token IS NOT NULL AND NOT (${ENROLLED_SQL})), 0)::bigint
         AS "excludedCents",
       COUNT(*) FILTER (WHERE p.token IS NOT NULL AND NOT (${ENROLLED_SQL}))::int AS "excludedCount",
       COUNT(*) FILTER (WHERE p.token IS NULL)::int AS "untraceableCount",
       COUNT(*) FILTER (WHERE p.token IS NOT NULL AND NOT p."onRecord")::int AS "recordWithoutToken",
       COUNT(*) FILTER (WHERE e."vendorToken" IS NOT NULL AND h."historicalVendorToken" IS NOT NULL)::int
         AS "contradictionCount"
       FROM (${PAYMENTS_SQL}) p
       LEFT JOIN lydia_enrolled_businesses e ON e."vendorToken" = p.token
       LEFT JOIN lydia_account_bridges h ON h."historicalVendorToken" = p.token`,
    [from, to]
  )) as Array<Record<string, string | number>>;
  const [refunds] = (await query(
    `SELECT COALESCE(SUM(f."amountCents"), 0)::bigint AS "refundedCents",
            COUNT(*)::int AS "refundCount"
       FROM lydia_refunds f
       LEFT JOIN lydia_enrolled_businesses e ON e."vendorToken" = f."vendorToken"
       LEFT JOIN lydia_account_bridges h ON h."historicalVendorToken" = f."vendorToken"
      WHERE ${ENROLLED_SQL}
        AND (f.status = 'confirmed' OR (f.status = 'pending' AND f.outcome = 'refunded-unrecorded'))
        AND COALESCE(f."answeredAt", f."resolvedAt", f."calledAt", f."requestedAt") >= ${WINDOW_SQL}
        AND COALESCE(f."answeredAt", f."resolvedAt", f."calledAt", f."requestedAt") < ${WINDOW_END_SQL}`,
    [from, to]
  )) as Array<Record<string, string | number>>;
  const contradictions = Number(payments?.contradictionCount ?? 0);
  if (contradictions > 0) {
    // Two durable facts disagree: the ledger says Canari enrolled the Business, a bridge says it is
    // an association's historical account. The bridge wins (never counted), and this accuses the
    // ledger row - a historical account linked through the enrolment, or backfilled before its
    // bridge was opened (migration 168).
    logger.error(
      `${LYDIA_FLUX_LOG_TAG} [${from}, ${to}): ${contradictions} payment(s) on a Business recorded ` +
        `as enrolled AND held as a bridge's historical account - excluded`
    );
  }
  const measure: LydiaFluxMeasure = {
    paidCents: Number(payments?.paidCents ?? 0),
    paymentCount: Number(payments?.paymentCount ?? 0),
    refundedCents: Number(refunds?.refundedCents ?? 0),
    refundCount: Number(refunds?.refundCount ?? 0),
    fluxCents: 0,
    excludedCents: Number(payments?.excludedCents ?? 0),
    excludedCount: Number(payments?.excludedCount ?? 0),
    untraceableCount: Number(payments?.untraceableCount ?? 0),
  };
  measure.fluxCents = measure.paidCents - measure.refundedCents;
  if (measure.untraceableCount > 0) {
    // A Lydia payment no row ties to a Business is counted NOWHERE - neither in the flux nor as
    // excluded - so the counter under-reads by exactly these. Accusing: since migration 120 every
    // issuing call writes the token, so one in a current window is a writer that skipped it.
    logger.error(
      `${LYDIA_FLUX_LOG_TAG} [${from}, ${to}): ${measure.untraceableCount} Lydia payment(s) name no ` +
        `Business and are counted nowhere`
    );
  }
  const recordWithoutToken = Number(payments?.recordWithoutToken ?? 0);
  if (recordWithoutToken > 0) {
    // Migration 169 backfilled every record and the settlement writes the token since: a record
    // without it was written by an older image during a rollout, or by a writer that skipped it.
    // Counted through the row that issued it, which a deleted answer would have lost.
    logger.warn(
      `${LYDIA_FLUX_LOG_TAG} [${from}, ${to}): ${recordWithoutToken} payment record(s) carry no ` +
        `Business of their own - read through the row that issued them`
    );
  }
  logger.log(
    `${LYDIA_FLUX_LOG_TAG} [${from}, ${to}): flux=${measure.fluxCents} paid=${measure.paidCents}` +
      ` (${measure.paymentCount}) refunded=${measure.refundedCents} (${measure.refundCount})` +
      ` excluded=${measure.excludedCents} (${measure.excludedCount})`
  );
  return measure;
}

/**
 * Records that `vendorToken` is a Business CANARI'S ENROLMENT created, on the connection of the
 * transaction that links it (`AssociationsService.setLydiaAccountId`, the one link path, called only
 * after `business/create`). Idempotent; never deleted - see migration 168.
 */
export async function recordEnrolledBusiness(
  query: FluxQuery,
  associationId: string,
  vendorToken: string
): Promise<void> {
  await query(
    `INSERT INTO lydia_enrolled_businesses ("vendorToken", "associationId", source)
     VALUES ($1, $2, 'enrolment') ON CONFLICT ("vendorToken") DO NOTHING`,
    [vendorToken, associationId]
  );
}
