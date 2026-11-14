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
  untraceableCents: number;
  /**
   * The same measure, one row per association (or list) the payment was recorded for
   * (`purchase_records."associationId"`; a refund's `lydia_refunds."associationId"`), sorted by
   * `fluxCents` descending (owner, 2026-11-14: which association the total comes from). The totals
   * above are the SUMS of these rows - one query, one definition of the flux.
   */
  byAssociation: LydiaFluxShare[];
}

/** One association's part of a window's flux, cents TTC (`LydiaFluxMeasure.byAssociation`). */
export interface LydiaFluxShare {
  associationId: string;
  /** NULL when the association no longer exists. */
  name: string | null;
  /** `association`, `list` or `institution`; NULL when it no longer exists. */
  type: string | null;
  paidCents: number;
  paymentCount: number;
  refundedCents: number;
  refundCount: number;
  fluxCents: number;
  /** Its payments on a Business Canari did not enrol (a historical account): not counted. */
  excludedCents: number;
  excludedCount: number;
  /** Its payments no row ties to a Business: counted nowhere. */
  untraceableCents: number;
  untraceableCount: number;
}

/** The numeric fields a share and the whole measure have in common, summed share by share. */
const SUMMED = [
  'paidCents',
  'paymentCount',
  'refundedCents',
  'refundCount',
  'fluxCents',
  'excludedCents',
  'excludedCount',
  'untraceableCents',
  'untraceableCount',
] as const;

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
         r."associationId" AS "associationId",
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
 * Measures the flux of `[from, to)` (two `YYYY-MM-DD` dates, Paris midnights), association by
 * association; the totals are the sums of those rows. Three reads, whatever the volume. A refund counts on the date Lydia executed it - its answer, or the manager's
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
  const paymentRows = (await query(
    `SELECT p."associationId",
       COALESCE(SUM(p.amount) FILTER (WHERE ${ENROLLED_SQL}), 0)::bigint AS "paidCents",
       COUNT(*) FILTER (WHERE ${ENROLLED_SQL})::int AS "paymentCount",
       COALESCE(SUM(p.amount) FILTER (WHERE p.token IS NOT NULL AND NOT (${ENROLLED_SQL})), 0)::bigint
         AS "excludedCents",
       COUNT(*) FILTER (WHERE p.token IS NOT NULL AND NOT (${ENROLLED_SQL}))::int AS "excludedCount",
       COALESCE(SUM(p.amount) FILTER (WHERE p.token IS NULL), 0)::bigint AS "untraceableCents",
       COUNT(*) FILTER (WHERE p.token IS NULL)::int AS "untraceableCount",
       COUNT(*) FILTER (WHERE p.token IS NOT NULL AND NOT p."onRecord")::int AS "recordWithoutToken",
       COUNT(*) FILTER (WHERE e."vendorToken" IS NOT NULL AND h."historicalVendorToken" IS NOT NULL)::int
         AS "contradictionCount"
       FROM (${PAYMENTS_SQL}) p
       LEFT JOIN lydia_enrolled_businesses e ON e."vendorToken" = p.token
       LEFT JOIN lydia_account_bridges h ON h."historicalVendorToken" = p.token
      GROUP BY p."associationId"`,
    [from, to]
  )) as Array<Record<string, string | number>>;
  const refundRows = (await query(
    `SELECT f."associationId",
            COALESCE(SUM(f."amountCents"), 0)::bigint AS "refundedCents",
            COUNT(*)::int AS "refundCount"
       FROM lydia_refunds f
       LEFT JOIN lydia_enrolled_businesses e ON e."vendorToken" = f."vendorToken"
       LEFT JOIN lydia_account_bridges h ON h."historicalVendorToken" = f."vendorToken"
      WHERE ${ENROLLED_SQL}
        AND (f.status = 'confirmed' OR (f.status = 'pending' AND f.outcome = 'refunded-unrecorded'))
        AND COALESCE(f."answeredAt", f."resolvedAt", f."calledAt", f."requestedAt") >= ${WINDOW_SQL}
        AND COALESCE(f."answeredAt", f."resolvedAt", f."calledAt", f."requestedAt") < ${WINDOW_END_SQL}
      GROUP BY f."associationId"`,
    [from, to]
  )) as Array<Record<string, string | number>>;
  const byId = new Map<string, LydiaFluxShare>();
  const shareOf = (associationId: string): LydiaFluxShare => {
    let share = byId.get(associationId);
    if (!share) {
      share = { associationId, name: null, type: null } as LydiaFluxShare;
      for (const k of SUMMED) share[k] = 0;
      byId.set(associationId, share);
    }
    return share;
  };
  for (const row of paymentRows) {
    const share = shareOf(String(row.associationId));
    for (const k of [
      'paidCents',
      'paymentCount',
      'excludedCents',
      'excludedCount',
      'untraceableCents',
      'untraceableCount',
    ] as const) {
      share[k] = Number(row[k] ?? 0);
    }
  }
  for (const row of refundRows) {
    const share = shareOf(String(row.associationId));
    share.refundedCents = Number(row.refundedCents ?? 0);
    share.refundCount = Number(row.refundCount ?? 0);
  }
  if (byId.size > 0) {
    const names = (await query(
      `SELECT id, name, type FROM associations WHERE id = ANY($1::uuid[])`,
      [[...byId.keys()]]
    )) as Array<{ id: string; name: string; type: string }>;
    for (const n of names) {
      const share = byId.get(n.id);
      if (share) Object.assign(share, { name: n.name, type: n.type });
    }
  }
  const byAssociation = [...byId.values()]
    .map((share) => ({ ...share, fluxCents: share.paidCents - share.refundedCents }))
    .sort((x, y) => y.fluxCents - x.fluxCents || y.paidCents - x.paidCents);
  const payments = {
    contradictionCount: paymentRows.reduce((n, r) => n + Number(r.contradictionCount ?? 0), 0),
    recordWithoutToken: paymentRows.reduce((n, r) => n + Number(r.recordWithoutToken ?? 0), 0),
  };
  const contradictions = payments.contradictionCount;
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
  // ONE definition of the flux: the whole is the sum of its shares, never a second query.
  const measure = { byAssociation } as LydiaFluxMeasure;
  for (const k of SUMMED) measure[k] = byAssociation.reduce((n, share) => n + share[k], 0);
  if (measure.untraceableCount > 0) {
    // A Lydia payment no row ties to a Business is counted NOWHERE - neither in the flux nor as
    // excluded - so the counter under-reads by exactly these. Accusing: since migration 120 every
    // issuing call writes the token, so one in a current window is a writer that skipped it.
    logger.error(
      `${LYDIA_FLUX_LOG_TAG} [${from}, ${to}): ${measure.untraceableCount} Lydia payment(s) name no ` +
        `Business and are counted nowhere`
    );
  }
  const recordWithoutToken = payments.recordWithoutToken;
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
      ` excluded=${measure.excludedCents} (${measure.excludedCount}) associations=${byAssociation.length}`
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
