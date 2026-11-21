import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { fcmErrorCode } from './fcm-errors';
import { cutDeviceId, cutUserId } from './log-repeat';

/**
 * PUSH DELIVERY RECORDS - what the push chain did, kept in the database so a deploy does not erase it
 * (owner, 2026-11-21: "totals + last delivery"; migration 054, docs/wiki/services/chat-delivery.md,
 * "Push delivery records").
 *
 * WHY: a read-only diagnosis on 2026-11-21 could not answer "was member X's notification sent, and
 * did it arrive?". The batch path logged only a total, and every counter lived in container logs that
 * reset at each deploy. Two records answer it, and neither carries content:
 *
 * 1. `push_delivery_daily` - per UTC day, kind, platform and outcome, a COUNT. Incremented once per
 *    send batch (one upsert of a handful of rows), never a row per send. No account, no device.
 * 2. `push_token."lastPushSentAt"` / `"lastPushFetchedAt"` - per device registration, the last time a
 *    provider ACCEPTED a push for it, and the last time its native handler FETCHED what a push
 *    pointed at. On the registration row, so they die with it: a session end, a revocation, an
 *    invalid token's prune, the account's erasure.
 *
 * NEVER IN THE WAY OF A SEND. The sender fills a {@link PushDeliveryTally} in memory while it sends,
 * and hands it to {@link recordPushDeliveries} once the batch has settled, without awaiting it. A
 * failed write logs at WARN and is dropped: the count is a witness, never a precondition, and the
 * push it describes already left.
 */

/** Which send path a push left by: the column `kind`. */
export type PushDeliveryKind =
  /** An MLS frame queued to an offline device (`sendFcmForQueued`). */
  | 'message'
  /** A `sendPushToUser` push: posts, comments, reactions, salons, reminders. */
  | 'social'
  /** A call ring, FCM or the iOS VoIP push. */
  | 'ring'
  /** A ring's end - a state signal, kept apart so it never inflates the rings. */
  | 'ring_end'
  /** `welcome_request_pending`, the admission nudge to the other members' Android devices. */
  | 'welcome_request';

/**
 * What became of one attempt at the provider: the column `outcome`. `attempted = accepted + failed`
 * on every (day, kind, platform); `pruned` is counted ON TOP of its `failed`, for the token the
 * failure proved gone (its row deleted, or an iOS VoIP token cleared).
 */
export type PushDeliveryOutcome = 'attempted' | 'accepted' | 'failed' | 'pruned';

/** The `code` column's width: an FCM code is `messaging/<name>`, under 64 characters. */
const CODE_MAX = 96;

/** The `code` of an iOS VoIP push APNs answered 410: the token is gone, and was cleared. */
export const APNS_VOIP_GONE = 'apns-voip/gone';
/** The `code` of an iOS VoIP push refused for any other reason; its status is on the `[apns-voip]` line. */
export const APNS_VOIP_REFUSED = 'apns-voip/refused';

/** The one destination fact a tally needs: the registration row and its platform. */
export interface PushDestination {
  id: string;
  platform: string;
}

/** One counter row of a flush. */
export interface PushDeliveryCount {
  platform: string;
  outcome: PushDeliveryOutcome;
  code: string;
  count: number;
}

/**
 * The provider code a failed FCM send is counted under: the structured code (`fcmErrorCode`, the same
 * classifier the log line uses), `none` when the throw carried none. Bounded, never prose.
 */
export function pushFailureCode(error: unknown): string {
  return (fcmErrorCode(error) ?? 'none').slice(0, CODE_MAX);
}

/**
 * What one send batch did, accumulated in memory while it sends - no I/O, no await. One per fan-out
 * (every device of one frame, one user's push, one ring), flushed once by {@link recordPushDeliveries}.
 */
export class PushDeliveryTally {
  private readonly counts = new Map<string, PushDeliveryCount>();
  private readonly acceptedIds = new Set<string>();

  constructor(readonly kind: PushDeliveryKind) {}

  /** The provider is about to be asked: counted whatever it answers. */
  attempted(pt: PushDestination): void {
    this.bump(pt.platform, 'attempted', '');
  }

  /** The provider accepted the push: counted, and the device's `lastPushSentAt` is owed. */
  accepted(pt: PushDestination): void {
    this.bump(pt.platform, 'accepted', '');
    this.acceptedIds.add(pt.id);
  }

  /** The provider refused it, under `code` ({@link pushFailureCode}, or an `APNS_VOIP_*`). */
  failed(pt: PushDestination, code: string): void {
    this.bump(pt.platform, 'failed', code.slice(0, CODE_MAX));
  }

  /** The refusal proved the token gone, and it was removed. */
  pruned(pt: PushDestination): void {
    this.bump(pt.platform, 'pruned', '');
  }

  /** Whether nothing was attempted - a flush then writes nothing. */
  get isEmpty(): boolean {
    return this.counts.size === 0;
  }

  /**
   * The counter rows, in ONE order (platform, outcome, code): two flushes that touch the same rows
   * lock them in the same order, so they wait for each other and never deadlock.
   */
  rows(): PushDeliveryCount[] {
    return [...this.counts.values()].sort(
      (a, b) =>
        a.platform.localeCompare(b.platform) ||
        a.outcome.localeCompare(b.outcome) ||
        a.code.localeCompare(b.code)
    );
  }

  /** The registration rows a provider accepted a push for, sorted. */
  acceptedTokenIds(): string[] {
    return [...this.acceptedIds].sort();
  }

  private bump(platform: string, outcome: PushDeliveryOutcome, code: string): void {
    const key = `${platform}\u0000${outcome}\u0000${code}`;
    const row = this.counts.get(key);
    if (row) row.count++;
    else this.counts.set(key, { platform, outcome, code, count: 1 });
  }
}

/**
 * Adds a batch's counts to `push_delivery_daily`, one upsert for every row. The day is the
 * DATABASE's UTC date, so every replica counts on one clock. Rows are inserted in the tally's order
 * (`WITH ORDINALITY ... ORDER BY`), which is what keeps two concurrent flushes deadlock-free.
 */
const INCREMENT_SQL = `
  INSERT INTO push_delivery_daily ("day", "kind", "platform", "outcome", "code", "count")
  SELECT (now() AT TIME ZONE 'UTC')::date, $1, r.platform, r.outcome, r.code, r.n
    FROM unnest($2::varchar[], $3::varchar[], $4::varchar[], $5::bigint[])
         WITH ORDINALITY AS r(platform, outcome, code, n, ord)
   ORDER BY r.ord
  ON CONFLICT ("day", "kind", "platform", "outcome", "code")
  DO UPDATE SET "count" = push_delivery_daily."count" + EXCLUDED."count"`;

/**
 * Stamps `lastPushSentAt` on every accepted registration of a batch, in ONE statement.
 *
 * THE ROWS ARE LOCKED IN ("userId", "deviceId") ORDER FIRST - the order `deleteAccountPushTokens` and
 * `storeEnvelopes` lock a user's rows in - so a stamp across many users never forms a cycle with an
 * erasure or an envelope store; `FOR NO KEY UPDATE` is what the UPDATE itself takes, so it blocks
 * no foreign-key check. A row deleted since the send is simply not matched. `GREATEST` keeps the date
 * from going back when two flushes commit out of order.
 */
const STAMP_SENT_SQL = `
  UPDATE push_token p
     SET "lastPushSentAt" = GREATEST(COALESCE(p."lastPushSentAt", '-infinity'), now())
    FROM (SELECT id FROM push_token WHERE id = ANY($1::uuid[])
           ORDER BY "userId", "deviceId" FOR NO KEY UPDATE) l
   WHERE p.id = l.id`;

/** Stamps `lastPushFetchedAt` on one registration (see {@link stampPushFetched}). */
const STAMP_FETCHED_SQL = `
  UPDATE push_token
     SET "lastPushFetchedAt" = GREATEST(COALESCE("lastPushFetchedAt", '-infinity'), now())
   WHERE "userId" = $1 AND "deviceId" = $2`;

/**
 * Writes what one send batch did: its counts, then its devices' `lastPushSentAt`. NEVER THROWS - each
 * write that fails logs at WARN with the batch's trace and what it would have written, and the other
 * is still attempted. Callers do not await it (`void`): the pushes it describes already left.
 *
 * @param manager - Any manager of this service's database (a repository's `.manager`).
 * @param tally - What the batch did; an empty one writes nothing.
 * @param logger - The sender's logger, so the WARN names the path that lost the count.
 * @param traceId - The batch's trace, as its own lines print it.
 */
export async function recordPushDeliveries(
  manager: EntityManager,
  tally: PushDeliveryTally,
  logger: Logger,
  traceId: string
): Promise<void> {
  if (tally.isEmpty) return;
  const rows = tally.rows();
  logger.debug(
    `[PUSH_RECORD][${traceId}] kind=${tally.kind} ${rows.length} counter row(s), ` +
      `${tally.acceptedTokenIds().length} accepted device(s)`
  );
  try {
    await manager.query(INCREMENT_SQL, [
      tally.kind,
      rows.map((r) => r.platform),
      rows.map((r) => r.outcome),
      rows.map((r) => r.code),
      rows.map((r) => r.count),
    ]);
  } catch (e) {
    logger.warn(
      `[PUSH_RECORD][${traceId}] daily counts NOT recorded kind=${tally.kind} ` +
        rows
          .map((r) => `${r.platform}/${r.outcome}${r.code ? `/${r.code}` : ''}=${r.count}`)
          .join(' ') +
        `: ${String(e)}`
    );
  }
  const accepted = tally.acceptedTokenIds();
  if (accepted.length === 0) return;
  try {
    await manager.query(STAMP_SENT_SQL, [accepted]);
  } catch (e) {
    logger.warn(
      `[PUSH_RECORD][${traceId}] lastPushSentAt NOT stamped kind=${tally.kind} on ${accepted.length} ` +
        `device(s): ${String(e)}`
    );
  }
}

/**
 * Stamps `lastPushFetchedAt` for the device whose native handler just fetched what a push pointed at
 * (`GET /mls/push/fetch-proto`, `GET /mls/push/wake`) - the server's own sight of the push ARRIVING,
 * which the 2026-11-21 diagnosis had to read from the edge access log. Stamped on every fetch the
 * PushSecret admitted, `gone` answers included: a `gone` still proves the push reached the handler.
 *
 * NEVER THROWS: a failed stamp logs at WARN and the fetch is answered as if it had succeeded.
 *
 * @param route - The fetching route, for the WARN (`fetch-proto`, `wake`).
 */
export async function stampPushFetched(
  manager: EntityManager,
  userId: string,
  deviceId: string,
  logger: Logger,
  route: string
): Promise<void> {
  try {
    await manager.query(STAMP_FETCHED_SQL, [userId, deviceId]);
  } catch (e) {
    logger.warn(
      `[PUSH_RECORD] lastPushFetchedAt NOT stamped route=${route} user=${cutUserId(userId)} ` +
        `device=${cutDeviceId(deviceId)}: ${String(e)}`
    );
  }
}
