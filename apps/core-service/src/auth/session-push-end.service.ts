import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import axios from 'axios';
import { chatDeliveryUrl } from '../internal/service-urls';
import { describeFailure, retryDelayMs } from '../account-erasure/erasure-policy';

/** How often the worker looks for due endings. A revocation also starts a drain at once. */
const DRAIN_INTERVAL_MS = 60_000;
/**
 * How long one call to chat-delivery-service may take. Bounded because nothing awaits it on the
 * user's path, and an unbounded call would hold a socket for a service that is down.
 */
const CALL_TIMEOUT_MS = 10_000;
/**
 * How long a claimed row is hidden from other claimers. Concurrency only - the call is idempotent,
 * so a lease that runs out early costs one duplicate call, never a wrong result. Above the call
 * timeout, so a row is never claimed twice while its one call can still be running.
 */
const CLAIM_LEASE_SECONDS = 60;
/** ONE row per claim, for the reason `AccountErasureService` gives: rows run one after the other. */
const CLAIM_BATCH = 1;

/** A deleted session, as the outbox needs it: the session, the account, the device it named. */
export interface EndedSession {
  id: string;
  userId: string;
  deviceId?: string | null;
}

/** Why a session ended - for the log line only. */
export type SessionEndCause = 'logout' | 'revoked-by-owner' | 'revoked-others' | 'replay';

interface ClaimedEnding {
  sessionId: string;
  userId: string;
  deviceId: string;
  cause: string;
  attempts: number;
  createdAt: Date;
}

/**
 * ENDING A SESSION ENDS THE PUSH REGISTRATION THAT SESSION MADE, AS A DURABLE OUTBOX - the server
 * half of "a sign-out ends the device's push registration" (`docs/wiki/sessions.md`).
 *
 * The push token row lives in chat-delivery-service, the session row here. {@link enqueue} runs
 * INSIDE the transaction that deletes the session and writes one `session_push_endings` row per
 * ended session that named a device (migration 016), so the session's end and its push ending are
 * one fact: both are recorded or neither is. {@link drain} then calls chat-delivery-service's
 * `DELETE /api/internal/push/users/:userId/devices/:deviceId?sessionId=` until it answers 2xx, and
 * deletes the row. The pattern is `AccountErasureService`'s: a claim under `FOR UPDATE SKIP LOCKED`
 * with a lease, single-flight in the process, a drain right after the commit and one every
 * {@link DRAIN_INTERVAL_MS}, backoff ({@link retryDelayMs}) on failure.
 *
 * The delete is BY SESSION (chat-delivery migration 037): it removes the registration the ended
 * session wrote and never a newer one a re-sign-in on the same device wrote, whatever the order.
 * A registration written before rows named a session holds NULL, and is ended only when no live
 * session of the account names the device (`unbound=end`) - the one case in which it cannot belong
 * to a session still signed in.
 *
 * Every failed attempt is logged at ERROR with its attempts and its age: a push ending owed is a
 * device still receiving an account's notifications after it left, and nothing else reports it.
 */
@Injectable()
export class SessionPushEndService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionPushEndService.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';
  private drainTimer: NodeJS.Timeout | null = null;
  /** The drain in flight, so overlapping triggers share it instead of racing it. */
  private draining: Promise<void> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.drainTimer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
    // Housekeeping must never hold the process open on shutdown.
    this.drainTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  /**
   * Records the push ending each ended session owes, in the caller's transaction - the one that
   * deleted the sessions. A session that never named a device (a web tab, a holder that never
   * unlocked) has no registration to end. Idempotent per session: a second writer adds nothing.
   *
   * @returns how many endings were recorded, so the caller drains only when there is something to.
   */
  async enqueue(
    manager: EntityManager,
    ended: ReadonlyArray<EndedSession>,
    cause: SessionEndCause
  ): Promise<number> {
    const withDevice = ended.filter((row) => !!row.deviceId);
    if (withDevice.length < ended.length) {
      this.logger.debug(
        `[PUSH_SESSION_END] cause=${cause} - ${ended.length - withDevice.length} ended session(s) ` +
          `named no device`
      );
    }
    for (const row of withDevice) {
      await manager.query(
        `INSERT INTO session_push_endings ("sessionId", "userId", "deviceId", cause)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("sessionId") DO NOTHING`,
        [row.id, row.userId, row.deviceId, cause]
      );
      this.logger.log(
        `[PUSH_SESSION_END] queued user=${row.userId.slice(0, 8)} device=${row.deviceId} ` +
          `session=${row.id.slice(0, 8)} cause=${cause}`
      );
    }
    return withDevice.length;
  }

  /**
   * Runs every due ending once. Single-flight inside the process; across processes, the claim is a
   * `FOR UPDATE SKIP LOCKED` that pushes the row's due time forward by a lease. Never rejects: the
   * queue survives in the database and the next tick picks it up again.
   */
  drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drainOnce()
        .catch((err: unknown) => {
          this.logger.error(`[PUSH_SESSION_END] drain failed: ${describeFailure(err)}`);
        })
        .finally(() => {
          this.draining = null;
        });
    }
    return this.draining;
  }

  private async drainOnce(): Promise<void> {
    for (;;) {
      const claimed = await this.claim();
      if (claimed.length === 0) return;
      for (const row of claimed) await this.attempt(row);
    }
  }

  private async claim(): Promise<ClaimedEnding[]> {
    const [rows] = (await this.dataSource.query(
      `UPDATE session_push_endings
          SET "nextAttemptAt" = now() + make_interval(secs => $1)
        WHERE "sessionId" IN (
          SELECT "sessionId" FROM session_push_endings
           WHERE "nextAttemptAt" <= now()
           ORDER BY "nextAttemptAt"
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING "sessionId", "userId", "deviceId", cause, attempts, "createdAt"`,
      [CLAIM_LEASE_SECONDS, CLAIM_BATCH]
    )) as [ClaimedEnding[], number];
    return rows ?? [];
  }

  /**
   * Whether a registration written before rows named a session may be ended too: only when no live
   * session of the account names the device - a live one is the device's current session, and an
   * unbound registration may be its own.
   */
  private async unboundPolicy(row: ClaimedEnding): Promise<'end' | 'keep'> {
    const live = (await this.dataSource.query(
      `SELECT 1 FROM auth_sessions
        WHERE "userId" = $1 AND "deviceId" = $2 AND "expiresAt" > now()
        LIMIT 1`,
      [row.userId, row.deviceId]
    )) as unknown[];
    return live.length > 0 ? 'keep' : 'end';
  }

  /** One call for one ending, and the row's next state. Never throws: the outcome is the row. */
  private async attempt(row: ClaimedEnding): Promise<void> {
    const who =
      `user=${row.userId.slice(0, 8)} device=${row.deviceId} ` +
      `session=${row.sessionId.slice(0, 8)} cause=${row.cause}`;
    try {
      const unbound = await this.unboundPolicy(row);
      const res = await axios.delete<{ removed?: number }>(
        chatDeliveryUrl(
          `internal/push/users/${encodeURIComponent(row.userId)}/devices/${encodeURIComponent(row.deviceId)}`
        ),
        {
          params: { sessionId: row.sessionId, unbound },
          headers: { 'x-internal-secret': this.internalSecret },
          timeout: CALL_TIMEOUT_MS,
        }
      );
      // Deleted only once chat-delivery has answered 2xx: axios rejects every other status.
      await this.dataSource.query(`DELETE FROM session_push_endings WHERE "sessionId" = $1`, [
        row.sessionId,
      ]);
      this.logger.log(
        `[PUSH_SESSION_END] ended ${who} unbound=${unbound} ` +
          `removed=${res.data?.removed ?? 'unstated'} attempts=${row.attempts}`
      );
    } catch (err) {
      await this.recordFailure(row, who, err);
    }
  }

  private async recordFailure(row: ClaimedEnding, who: string, err: unknown): Promise<void> {
    const attempts = row.attempts + 1;
    const delaySeconds = Math.round(retryDelayMs(attempts) / 1000);
    const failure = describeFailure(err);
    try {
      await this.dataSource.query(
        `UPDATE session_push_endings
            SET attempts = $2, "lastError" = $3,
                "nextAttemptAt" = now() + make_interval(secs => $4)
          WHERE "sessionId" = $1`,
        [row.sessionId, attempts, failure, delaySeconds]
      );
    } catch (writeErr) {
      // The lease still runs out, so the row is retried; only this attempt's record is lost.
      this.logger.error(
        `[PUSH_SESSION_END] could not record a failure ${who}: ${describeFailure(writeErr)}`
      );
    }
    const ageSeconds = Math.round((Date.now() - new Date(row.createdAt).getTime()) / 1000);
    this.logger.error(
      `[PUSH_SESSION_END] the push registration was NOT ended ${who} attempts=${attempts} ` +
        `age=${ageSeconds}s error=${failure} - retried in ${delaySeconds}s`
    );
  }
}
