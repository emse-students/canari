import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { fcmErrorCode } from './fcm-errors';

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
 * NEVER IN THE WAY OF A SEND. The sender fills a {@link PushDeliveryTally} in memory while it sends
 * and hands it to {@link PUSH_DELIVERY_RECORDER} once the batch has settled (in a `finally`, so a
 * failed token prune does not lose it); a fetch route hands it the device. Neither waits for the
 * database. The recorder writes ONE thing at a time per process and folds everything handed over
 * meanwhile into the next write, so a burst of batches holds one pool connection. A failed write logs
 * at WARN and is dropped: the count is a witness, never a precondition, and the push already left.
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
  | 'welcome_request'
  /** An empty new-mail push (mail lot 5, `MailAlertService.alert`). */
  | 'mail';

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

  /** Adds every count and accepted device of `other` to this tally (the caller keeps one kind). */
  absorb(other: PushDeliveryTally): void {
    for (const row of other.counts.values()) {
      const key = PushDeliveryTally.keyOf(row.platform, row.outcome, row.code);
      const mine = this.counts.get(key);
      if (mine) mine.count += row.count;
      else this.counts.set(key, { ...row });
    }
    for (const id of other.acceptedIds) this.acceptedIds.add(id);
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

  private static keyOf(platform: string, outcome: PushDeliveryOutcome, code: string): string {
    return `${platform}\u0000${outcome}\u0000${code}`;
  }

  private bump(platform: string, outcome: PushDeliveryOutcome, code: string): void {
    const key = PushDeliveryTally.keyOf(platform, outcome, code);
    const row = this.counts.get(key);
    if (row) row.count++;
    else this.counts.set(key, { platform, outcome, code, count: 1 });
  }
}

/**
 * Adds a batch's counts to `push_delivery_daily`, one upsert for every row. The day is the
 * DATABASE's UTC date, so every replica counts on one clock. Rows are inserted in the tally's order
 * (`WITH ORDINALITY ... ORDER BY`), which is what keeps two concurrent writes (two replicas)
 * deadlock-free.
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
 * THE ROWS ARE LOCKED IN ("userId", "deviceId") ORDER FIRST - the order `deleteAccountPushTokens`,
 * `deleteStalePushTokens` and `storeEnvelopes` lock rows in - so a stamp across many users never
 * forms a cycle with an erasure, the stale sweep or an envelope store; `FOR NO KEY UPDATE` is what
 * the UPDATE itself takes, so it blocks no foreign-key check. A row deleted since the send is simply
 * not matched. `GREATEST` keeps the date from going back when two writes commit out of order.
 */
const STAMP_SENT_SQL = `
  UPDATE push_token p
     SET "lastPushSentAt" = GREATEST(COALESCE(p."lastPushSentAt", '-infinity'), now())
    FROM (SELECT id FROM push_token WHERE id = ANY($1::uuid[])
           ORDER BY "userId", "deviceId" FOR NO KEY UPDATE) l
   WHERE p.id = l.id`;

/**
 * Stamps `lastPushFetchedAt` on every registration that fetched since the last write, in ONE
 * statement, locked in the same ("userId", "deviceId") order as {@link STAMP_SENT_SQL}.
 */
const STAMP_FETCHED_SQL = `
  UPDATE push_token p
     SET "lastPushFetchedAt" = GREATEST(COALESCE(p."lastPushFetchedAt", '-infinity'), now())
    FROM (SELECT t.id FROM push_token t
            JOIN unnest($1::varchar[], $2::varchar[]) AS f("userId", "deviceId")
              ON t."userId" = f."userId" AND t."deviceId" = f."deviceId"
           ORDER BY t."userId", t."deviceId" FOR NO KEY UPDATE OF t) l
   WHERE p.id = l.id`;

/**
 * Writes what one tally holds: its counts, then its devices' `lastPushSentAt`. NEVER THROWS - each
 * write that fails logs at WARN with the trace and what it would have written, and the other is still
 * attempted. Called by {@link PushDeliveryRecorder}, one write at a time.
 *
 * @param manager - Any manager of this service's database (a repository's `.manager`).
 * @param tally - What the batches did; an empty one writes nothing.
 * @param logger - Where the WARN goes.
 * @param traceId - The batch's trace (`<first>+<n>` when batches were folded together).
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
 * Stamps `lastPushFetchedAt` on the registrations whose native handler fetched what a push pointed
 * at (`GET /mls/push/fetch-proto`, `GET /mls/push/wake`) - the server's own sight of a push ARRIVING,
 * which the 2026-11-21 diagnosis had to read from the edge access log. NEVER THROWS: a failed stamp
 * logs at WARN with how many devices it lost and the routes that asked.
 *
 * @param devices - `userId`/`deviceId` pairs, each once.
 * @param routes - The routes the fetches came by, for the WARN.
 */
export async function recordPushFetches(
  manager: EntityManager,
  devices: ReadonlyArray<{ userId: string; deviceId: string }>,
  logger: Logger,
  routes: string
): Promise<void> {
  if (devices.length === 0) return;
  logger.debug(`[PUSH_RECORD] lastPushFetchedAt on ${devices.length} device(s) routes=${routes}`);
  try {
    await manager.query(STAMP_FETCHED_SQL, [
      devices.map((d) => d.userId),
      devices.map((d) => d.deviceId),
    ]);
  } catch (e) {
    logger.warn(
      `[PUSH_RECORD] lastPushFetchedAt NOT stamped on ${devices.length} device(s) ` +
        `routes=${routes}: ${String(e)}`
    );
  }
}

/**
 * THE ONE WRITER of the push delivery record in a process. Senders and fetch routes hand it what they
 * did and return at once; it writes ONE thing at a time, and everything handed over while a write is
 * in flight is folded into the next one: the tallies of one kind into one tally, the fetched devices
 * into one set. A burst of a hundred batches therefore costs a handful of writes on ONE pool
 * connection, never a hundred autocommit upserts queued on the same hot counter rows, each holding a
 * connection while it waits.
 *
 * No timer: the next write starts when the previous one ends, and the loop stops when nothing is
 * pending - in the same synchronous step as its last check, so nothing handed over can be stranded.
 *
 * WHAT IT DOES NOT SURVIVE, said rather than hidden:
 * - A write that never settles (a database that accepts the connection and never answers) stalls
 *   the writer with NO line: everything handed over after it piles up in memory, folded, unwritten.
 *   No timer bounds it - a deadline here would be a guess about the database, and the sends it counts
 *   are not affected. The pool's own errors still reach the WARN when they come.
 * - The process's exit: SIGTERM ({@link drainForExit}, from `drainOnSigterm`) first SAYS what is
 *   still pending - synchronously, so a SIGKILL after the grace period still leaves the line - then
 *   waits for the writer. A process killed without SIGTERM loses what was pending, unlogged.
 */
export class PushDeliveryRecorder {
  private readonly logger = new Logger('PushDeliveryRecorder');
  private readonly pendingTallies = new Map<PushDeliveryKind, PushDeliveryTally>();
  private readonly pendingFetches = new Map<string, { userId: string; deviceId: string }>();
  private readonly pendingRoutes = new Set<string>();
  /** Send batches still waiting on their pushes, which will hand a tally over when they settle. */
  private readonly batchesInFlight = new Set<Promise<void>>();
  private firstTrace: string | null = null;
  private foldedBatches = 0;
  private manager: EntityManager | null = null;
  private running: Promise<void> | null = null;
  /**
   * What the last write carried - in flight while `running` is set, and kept after it for the ERROR
   * line, which runs once the writer has already let go of `running`.
   */
  private inFlight = 'nothing';

  /**
   * Hands over what one send batch did. Returns at once; the write follows.
   *
   * @param manager - This service's database manager (a repository's `.manager`).
   * @param tally - The batch's tally; an empty one is dropped here.
   * @param traceId - The batch's trace, named by a failure's WARN.
   */
  record(manager: EntityManager, tally: PushDeliveryTally, traceId: string): void {
    if (tally.isEmpty) return;
    const pending = this.pendingTallies.get(tally.kind);
    if (pending) {
      pending.absorb(tally);
    } else {
      const copy = new PushDeliveryTally(tally.kind);
      copy.absorb(tally);
      this.pendingTallies.set(tally.kind, copy);
    }
    if (this.firstTrace === null) this.firstTrace = traceId;
    this.foldedBatches++;
    this.kick(manager);
  }

  /** Hands over that `userId`/`deviceId` fetched what a push pointed at, by `route`. Returns at once. */
  fetched(manager: EntityManager, userId: string, deviceId: string, route: string): void {
    this.pendingFetches.set(`${userId} ${deviceId}`, { userId, deviceId });
    this.pendingRoutes.add(route);
    this.kick(manager);
  }

  /** Resolves once everything handed over so far is written, or its loss logged. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * Tracks a send batch whose pushes are still in flight and which hands its tally over when they
   * settle (the message fan-out, whose pushes are fire-and-forget): {@link finishBatchesInFlight}
   * waits for it at exit, so its counts and stamps reach the writer before the writer is drained.
   * Tracked for its settlement only - the batch logs its own failures.
   */
  trackBatch(batch: Promise<unknown>): void {
    const settled = batch.then(
      () => undefined,
      () => undefined
    );
    this.batchesInFlight.add(settled);
    void settled.finally(() => this.batchesInFlight.delete(settled));
  }

  /**
   * The exit's first step for the record (`finishWorkOwedBeforeExit`, before {@link drainForExit}):
   * says SYNCHRONOUSLY how many send batches are still waiting on their pushes - so a SIGKILL during
   * the wait still leaves the line - then waits for them, so each hands its tally over. Says nothing
   * when none is in flight.
   */
  async finishBatchesInFlight(): Promise<void> {
    const owed = [...this.batchesInFlight];
    if (owed.length === 0) return;
    this.logger.log(
      `[PUSH_RECORD] exit - ${owed.length} send batch(es) still waiting on their pushes - waiting for them`
    );
    await Promise.all(owed);
  }

  /**
   * The exit's hand-over (`drainOnSigterm`): logs, SYNCHRONOUSLY and before any wait, what is not yet
   * written - the pending counter rows per kind, the pending fetched devices, whether a write is in
   * flight - so a SIGKILL after the grace period still leaves the evidence of what it cost; then
   * waits for the writer. Says nothing when nothing is pending or in flight.
   */
  async drainForExit(): Promise<void> {
    const kinds = [...this.pendingTallies.values()].map(
      (t) =>
        `${t.kind}:${t.rows().reduce((n, r) => n + (r.outcome === 'attempted' ? r.count : 0), 0)}`
    );
    if (kinds.length > 0 || this.pendingFetches.size > 0 || this.running) {
      this.logger.log(
        `[PUSH_RECORD] exit - not yet written: attempted ${kinds.length > 0 ? kinds.join(' ') : 'none'}, ` +
          `${this.pendingFetches.size} fetched device(s); write in flight: ${this.running ? this.inFlight : 'none'} ` +
          `- waiting for the writer`
      );
    }
    await this.settled();
  }

  private kick(manager: EntityManager): void {
    this.manager = manager;
    if (this.running) return;
    // `drain` catches every write's failure itself; a throw out of it is a defect of the writer, and
    // what it dropped is named here, at ERROR.
    this.running = this.drain().catch((e: unknown) => {
      this.logger.error(`[PUSH_RECORD] the writer failed - DROPPED ${this.inFlight}: ${String(e)}`);
    });
  }

  private async drain(): Promise<void> {
    // Hand-overs made in the same tick are folded into the first write.
    await Promise.resolve();
    try {
      while (this.pendingTallies.size > 0 || this.pendingFetches.size > 0) {
        const manager = this.manager as EntityManager;
        const tallies = [...this.pendingTallies.values()];
        this.pendingTallies.clear();
        const trace =
          this.foldedBatches > 1
            ? `${this.firstTrace}+${this.foldedBatches - 1}`
            : (this.firstTrace ?? 'fetch');
        this.firstTrace = null;
        this.foldedBatches = 0;
        const fetches = [...this.pendingFetches.values()];
        this.pendingFetches.clear();
        const routes = [...this.pendingRoutes].sort().join(',');
        this.pendingRoutes.clear();
        this.inFlight =
          `trace=${trace} kinds=${tallies.map((t) => t.kind).join(',') || 'none'} ` +
          `fetched=${fetches.length}`;
        for (const tally of tallies) {
          await recordPushDeliveries(manager, tally, this.logger, trace);
        }
        await recordPushFetches(manager, fetches, this.logger, routes);
      }
    } finally {
      // The same synchronous step as the empty check above: a hand-over after it starts a new drain.
      this.running = null;
    }
  }
}

/** The process's one {@link PushDeliveryRecorder}: every send path and fetch route hands it over. */
export const PUSH_DELIVERY_RECORDER = new PushDeliveryRecorder();
