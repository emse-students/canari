import type { EntityManager } from 'typeorm';
import type { LydiaReadinessCause } from './lydia-readiness';

/**
 * THE BRIDGE FROM A HISTORICAL LYDIA ACCOUNT TO THE BUSINESS CANARI ENROLLED (owner, 2026-11-13).
 *
 * TEMPORARY (docs/wiki/legacy-compatibility.md): some associations collect through a Lydia account
 * they held before Canari's enrolment existed. They enrol through Canari like everyone else, and
 * Canari keeps collecting on the historical account until Lydia validates the new Business - a
 * Business Lydia has not validated answers every `request/do` with error 5, so its tokens are never
 * used to collect before then. The switch is Lydia's `BUSINESS_VALIDATED` for the enrolled Business.
 *
 * The model (migration 167, `lydia_account_bridges`, one row per association on a bridge):
 * - `associations."lydiaAccountId"` and its columns stay THE ACTIVE collecting Business, so every
 *   collection path keeps resolving through `resolvePaymentTarget` (payment-delegation.util.ts)
 *   unchanged;
 * - the bridge row holds the OTHER Business - the "standby": the enrolled one while the historical
 *   account collects (`state = 'historical'`), the historical one once switched (`'switched'`);
 * - a switch or a switch back SWAPS the two, under the association row's lock (`FOR UPDATE`, the
 *   lock the readiness writer, the cashier claims and the purchase decision already take), the
 *   bridge row locked after it. Nothing else writes these columns.
 *
 * Three questions, three answers, each defined ONCE here:
 * - which Business COLLECTS: the association's columns (`resolvePaymentTarget`);
 * - which Business the MANAGERS manage (their enrolment, Responsable, cashiers, readiness):
 *   {@link managedVendorTokenSql} - the enrolled one whenever there is a bridge, never the
 *   historical account, which is invisible to them;
 * - which Business a ROW'S vendor token names, for its key (callbacks, `request/state`, refunds):
 *   {@link HELD_BUSINESSES_SQL} - every Business the association holds, active or standby.
 */

/** The tag of every bridge line: a switch, a switch back, a re-issue, a refused enrolment. */
export const LYDIA_BRIDGE_LOG_TAG = '[LYDIA-BRIDGE]';

/**
 * The `code` of the 409 refusing a second enrolment while the first enrolled Business is still
 * waiting for Lydia's validation. Mirrored in `libs/contracts/lydia-refusal-codes.json`.
 */
export const LYDIA_BUSINESS_PENDING_VALIDATION = 'LYDIA_BUSINESS_PENDING_VALIDATION';

/** Which Business of a bridge collects: the historical account, or the enrolled one. */
export type LydiaBridgeState = 'historical' | 'switched';

/** One `lydia_account_bridges` row, as the transitions read it (locked). */
export interface LydiaBridgeRow {
  associationId: string;
  historicalVendorToken: string;
  enrolledVendorToken: string | null;
  state: LydiaBridgeState;
  standbyKeyCiphertext: string | null;
  standbyDashboardUrl: string | null;
  standbyReady: boolean;
  standbyReadinessCause: LydiaReadinessCause | null;
  standbyReadinessAt: Date | string | null;
  switchedAt: Date | string | null;
  switchCount: number;
  switchBackCount: number;
  reissueCount: number;
}

/**
 * SQL: the vendor token of the STANDBY Business of bridge alias `b` - the enrolled one while the
 * historical account collects, the historical one once switched. NULL before the enrolment links.
 */
export function bridgeStandbyTokenSql(b = 'b'): string {
  return `(CASE WHEN ${b}.state = 'historical' THEN ${b}."enrolledVendorToken" ELSE ${b}."historicalVendorToken" END)`;
}

/**
 * SQL: THE Business an association's managers manage, for association alias `a` LEFT JOINed to its
 * bridge `b`: the enrolled Business while the historical account collects (NULL before the
 * enrolment links it - the managers see no Business and enrol), the association's own active one
 * otherwise. The historical account is never it.
 */
export function managedVendorTokenSql(a = 'a', b = 'b'): string {
  return `(CASE WHEN ${b}.state = 'historical' THEN ${b}."enrolledVendorToken" ELSE ${a}."lydiaAccountId" END)`;
}

/** The SQL join of an association alias `a` to its bridge `b` (none: every `b` column is NULL). */
export function bridgeJoinSql(a = 'a', b = 'b'): string {
  return `LEFT JOIN lydia_account_bridges ${b} ON ${b}."associationId" = ${a}.id`;
}

/**
 * SQL subquery: every Business Canari holds for an association, with its sealed key and its role -
 * `active` (it collects), `pending` (enrolled, waiting for Lydia's validation) or `retired` (the
 * historical account after the switch). The ONE lookup a ROW'S vendor token is resolved through:
 * the callback key, `request/state`, a refund, the reconciliation sweep's key check and the
 * webhook's log read. Alias it `h`.
 */
export const HELD_BUSINESSES_SQL = `(
  SELECT a.id AS "associationId", a."lydiaAccountId" AS "vendorToken",
         a."lydiaBusinessKeyCiphertext" AS sealed, a."lydiaOnboardingComplete" AS ready,
         'active'::text AS role
    FROM associations a WHERE a."lydiaAccountId" IS NOT NULL
  UNION ALL
  SELECT b."associationId", ${bridgeStandbyTokenSql('b')}, b."standbyKeyCiphertext", b."standbyReady",
         CASE WHEN b.state = 'historical' THEN 'pending' ELSE 'retired' END
    FROM lydia_account_bridges b WHERE ${bridgeStandbyTokenSql('b')} IS NOT NULL
)`;

/** The role of a Business in {@link HELD_BUSINESSES_SQL}. */
export type HeldBusinessRole = 'active' | 'pending' | 'retired';

/**
 * The vendor tokens of every Business association `associationId` holds (active or standby) - the
 * Businesses whose payments it refunds. `query` is a repository's or a transaction's.
 */
export async function vendorTokensHeldBy(
  query: (sql: string, params: unknown[]) => Promise<unknown>,
  associationId: string
): Promise<string[]> {
  const rows = (await query(
    `SELECT h."vendorToken" FROM ${HELD_BUSINESSES_SQL} h WHERE h."associationId" = $1`,
    [associationId]
  )) as Array<{ vendorToken: string | null }>;
  return rows.map((r) => r.vendorToken?.trim() ?? '').filter((t) => t.length > 0);
}

/**
 * The bridge of association `associationId`, locked `FOR UPDATE` in `manager`'s transaction, or
 * null when it is on none. The CALLER holds the association row's lock first: that is the order of
 * every bridge transition, so two of them never deadlock.
 */
export async function lockBridge(
  manager: Pick<EntityManager, 'query'>,
  associationId: string
): Promise<LydiaBridgeRow | null> {
  const rows = (await manager.query(
    `SELECT * FROM lydia_account_bridges WHERE "associationId" = $1 FOR UPDATE`,
    [associationId]
  )) as LydiaBridgeRow[];
  return rows[0] ?? null;
}

/**
 * The association whose bridge names `vendorToken` as its ENROLLED Business, read WITHOUT a lock
 * (the caller locks the association, then re-reads the bridge with {@link lockBridge}), or null.
 */
export async function bridgeOfEnrolled(
  manager: Pick<EntityManager, 'query'>,
  vendorToken: string
): Promise<string | null> {
  const rows = (await manager.query(
    `SELECT "associationId" FROM lydia_account_bridges WHERE "enrolledVendorToken" = $1`,
    [vendorToken]
  )) as Array<{ associationId: string }>;
  return rows[0]?.associationId ?? null;
}

/** The readiness a swapped-out Business keeps in the standby columns. */
export interface StandbyReadiness {
  ready: boolean;
  cause: LydiaReadinessCause | null;
  /** Null: the database's `now()`. */
  at: Date | string | null;
}

/**
 * SWAPS the active Business of association `associationId` with its bridge's standby one, in
 * `manager`'s transaction: the standby's token, sealed key, dashboard URL and readiness go into the
 * association's columns, and the outgoing active Business into the standby columns with
 * `outgoing` as its readiness. `to` is the state the bridge ends in: `switched` (the enrolled
 * Business collects) or `historical` (back to the historical account). The CALLER holds the
 * association row's lock and `bridge` locked after it, and has checked the transition is due; this
 * throws (rolling the caller's transaction back) when the association's active Business is not the
 * one the bridge says is outgoing - it never writes half a swap.
 */
export async function swapBridge(
  manager: Pick<EntityManager, 'query'>,
  bridge: LydiaBridgeRow,
  to: LydiaBridgeState,
  outgoing: StandbyReadiness
): Promise<void> {
  const incoming = to === 'switched' ? bridge.enrolledVendorToken : bridge.historicalVendorToken;
  const outgoingToken =
    to === 'switched' ? bridge.historicalVendorToken : bridge.enrolledVendorToken;
  if (!incoming || !outgoingToken || bridge.state === to) {
    throw new Error(`bridge of ${bridge.associationId}: no ${to} transition from ${bridge.state}`);
  }
  // The outgoing Business's sealed key and dashboard URL, read under the lock the caller holds.
  const [active] = (await manager.query(
    `SELECT "lydiaBusinessKeyCiphertext" AS sealed, "lydiaDashboardUrl" AS url
       FROM associations WHERE id = $1 AND "lydiaAccountId" = $2`,
    [bridge.associationId, outgoingToken]
  )) as Array<{ sealed: string | null; url: string | null }>;
  if (!active) {
    throw new Error(
      `bridge of ${bridge.associationId}: the active Business is not the ${bridge.state} one`
    );
  }
  await manager.query(
    `UPDATE associations
        SET "lydiaAccountId" = $2, "lydiaBusinessKeyCiphertext" = $3, "lydiaDashboardUrl" = $4,
            "lydiaOnboardingComplete" = $5, "lydiaReadinessCause" = $6, "lydiaReadinessAt" = $7
      WHERE id = $1`,
    [
      bridge.associationId,
      incoming,
      bridge.standbyKeyCiphertext,
      bridge.standbyDashboardUrl,
      bridge.standbyReady,
      bridge.standbyReadinessCause,
      bridge.standbyReadinessAt,
    ]
  );
  await manager.query(
    `UPDATE lydia_account_bridges
        SET state = $2::varchar, "standbyKeyCiphertext" = $3, "standbyDashboardUrl" = $4,
            "standbyReady" = $5, "standbyReadinessCause" = $6,
            "standbyReadinessAt" = COALESCE($7::timestamptz, now()),
            "switchedAt" = CASE WHEN $2::varchar = 'switched' THEN now() ELSE "switchedAt" END,
            "switchCount" = "switchCount" + CASE WHEN $2::varchar = 'switched' THEN 1 ELSE 0 END,
            "switchBackCount" = "switchBackCount" + CASE WHEN $2::varchar = 'historical' THEN 1 ELSE 0 END
      WHERE "associationId" = $1`,
    [
      bridge.associationId,
      to,
      active.sealed,
      active.url,
      outgoing.ready,
      outgoing.cause,
      outgoing.at,
    ]
  );
}
