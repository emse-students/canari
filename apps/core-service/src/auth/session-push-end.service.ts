import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import axios from 'axios';
import { chatDeliveryUrl } from '../internal/service-urls';
import { afterSuccess, describeFailure, retryDelayMs } from '../account-erasure/erasure-policy';
import { ACCESS_TOKEN_TTL_SECONDS, CREDENTIAL_SKEW_SECONDS } from './token-lifetimes';

/** How often the worker looks for due endings. A revocation also starts a drain at once. */
const DRAIN_INTERVAL_MS = 60_000;
/**
 * How long one call to chat-delivery-service may take. Bounded because nothing awaits it on the
 * user's path, and an unbounded call would hold a socket for a service that is down.
 */
const CALL_TIMEOUT_MS = 10_000;
/**
 * How long a claimed row is hidden from other claimers. Concurrency only - the calls are idempotent,
 * so a lease that runs out early costs one duplicate pass, never a wrong result. Above the two call
 * timeouts of a pass, so a row is never claimed twice while its pass can still be running.
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

/**
 * Why a session ended - for the log line only. `restored`: a restore key consumed on a new phone
 * ended the session it was bound to (`RestoreCredentialsService.consume`).
 */
export type SessionEndCause =
  | 'logout'
  | 'revoked-by-owner'
  | 'revoked-others'
  | 'replay'
  | 'restored';

interface ClaimedEnding {
  sessionId: string;
  userId: string;
  deviceId: string | null;
  cause: string;
  attempts: number;
  endedAt: Date;
  /** When this pass was claimed: what {@link afterSuccess} compares with the tokens' expiry. */
  claimedAt: Date;
}

/**
 * ENDING A SESSION ENDS THE PUSH REGISTRATIONS IT LEAVES BEHIND, AS A DURABLE OUTBOX - the server
 * half of "a sign-out ends the device's push registration" (`docs/wiki/sessions.md`).
 *
 * The push token rows live in chat-delivery-service, the session row here. {@link enqueue} runs
 * INSIDE the transaction that deletes the session and writes one `session_push_endings` row per
 * deliberately ended session (migration 016), so the session's end and its push ending are one fact:
 * both are recorded or neither is. {@link drain} drives each row to completion the way
 * `AccountErasureService` drives `account_erasure_jobs`: a claim under `FOR UPDATE SKIP LOCKED` with
 * a lease, single-flight in the process, a drain right after the commit and one every
 * {@link DRAIN_INTERVAL_MS}, backoff ({@link retryDelayMs}) on a failure.
 *
 * ONE PASS deletes, on chat-delivery-service (`DELETE /api/internal/push/users/:userId/sessions/
 * :sessionId`): the row the ended session registered, by session (chat-delivery migration 037), on
 * whatever device; and, when the session named a device, that device's row if it is bound to NO
 * live session - read first, judged here, then deleted only if the row still names what was read, so
 * a registration written in between is never reached.
 *
 * A FINAL PASS, as the account erasure's: an access token minted before the session ended stays
 * valid for up to {@link ACCESS_TOKEN_TTL_SECONDS} and can still register under the ended session's
 * id. A pass that succeeded before every such token expired is followed by exactly one more at that
 * instant ({@link afterSuccess}); the row is deleted only after it.
 *
 * Every failed pass is logged at ERROR with its attempts and its age; a 400 - an address no retry
 * can fix - is accused once and the row dropped.
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
   * deleted the sessions. Every session, whether or not it named a device: one that registered
   * before it named its device is ended by session alone. Idempotent per session: a second writer
   * adds nothing.
   *
   * @returns how many endings were recorded, so the caller drains only when there is something to.
   */
  async enqueue(
    manager: EntityManager,
    ended: ReadonlyArray<EndedSession>,
    cause: SessionEndCause
  ): Promise<number> {
    for (const row of ended) {
      await manager.query(
        `INSERT INTO session_push_endings ("sessionId", "userId", "deviceId", cause)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("sessionId") DO NOTHING`,
        [row.id, row.userId, row.deviceId ?? null, cause]
      );
      this.logger.log(
        `[PUSH_SESSION_END] queued user=${row.userId.slice(0, 8)} ` +
          `device=${row.deviceId ?? 'unnamed'} session=${row.id.slice(0, 8)} cause=${cause}`
      );
    }
    return ended.length;
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
        RETURNING "sessionId", "userId", "deviceId", cause, attempts, "endedAt",
                  now() AS "claimedAt"`,
      [CLAIM_LEASE_SECONDS, CLAIM_BATCH]
    )) as [ClaimedEnding[], number];
    return rows ?? [];
  }

  private headers(): { 'x-internal-secret': string } {
    return { 'x-internal-secret': this.internalSecret };
  }

  /**
   * The binding to delete on the device the session named, or null when there is nothing there to
   * end: no registration, one bound to the ending session itself (the by-session delete takes it),
   * or one bound to a session that is still live - the device's current one. Read BEFORE liveness is
   * judged, so a session that signs in and registers after the read changes the binding, and the
   * compare-and-delete then fails rather than reaching it.
   */
  private async staleBinding(row: ClaimedEnding): Promise<string | null> {
    if (!row.deviceId) return null;
    const res = await axios.get<{ registered?: boolean; sessionId?: string | null }>(
      chatDeliveryUrl(
        `internal/push/users/${encodeURIComponent(row.userId)}/devices/${encodeURIComponent(row.deviceId)}`
      ),
      { headers: this.headers(), timeout: CALL_TIMEOUT_MS }
    );
    if (!res.data?.registered) return null;
    const bound = res.data.sessionId ?? null;
    if (bound === row.sessionId) return null;
    if (bound !== null) {
      const live = (await this.dataSource.query(
        `SELECT 1 FROM auth_sessions WHERE id = $1 AND "userId" = $2 AND "expiresAt" > now()`,
        [bound, row.userId]
      )) as unknown[];
      if (live.length > 0) return null;
    }
    return bound ?? 'none';
  }

  /** One pass for one ending, and the row's next state. Never throws: the outcome is the row. */
  private async attempt(row: ClaimedEnding): Promise<void> {
    const who =
      `user=${row.userId.slice(0, 8)} device=${row.deviceId ?? 'unnamed'} ` +
      `session=${row.sessionId.slice(0, 8)} cause=${row.cause}`;
    try {
      const ifBoundTo = await this.staleBinding(row);
      const res = await axios.delete<{ removed?: number }>(
        chatDeliveryUrl(
          `internal/push/users/${encodeURIComponent(row.userId)}/sessions/${encodeURIComponent(row.sessionId)}`
        ),
        {
          params: ifBoundTo ? { device: row.deviceId, ifBoundTo } : undefined,
          headers: this.headers(),
          timeout: CALL_TIMEOUT_MS,
        }
      );
      // Only reached on a 2xx: axios rejects every other status.
      const removed = res.data?.removed ?? 'unstated';
      const credentialsExpireAt = new Date(
        new Date(row.endedAt).getTime() +
          (ACCESS_TOKEN_TTL_SECONDS + CREDENTIAL_SKEW_SECONDS) * 1000
      );
      const outcome = afterSuccess(new Date(row.claimedAt), credentialsExpireAt);
      if (outcome.kind === 'complete') {
        await this.dataSource.query(`DELETE FROM session_push_endings WHERE "sessionId" = $1`, [
          row.sessionId,
        ]);
        this.logger.log(
          `[PUSH_SESSION_END] ended ${who} removed=${removed} stale=${ifBoundTo ?? 'none'} ` +
            `attempts=${row.attempts}`
        );
      } else {
        await this.dataSource.query(
          `UPDATE session_push_endings SET "nextAttemptAt" = $2, "lastError" = NULL
            WHERE "sessionId" = $1`,
          [row.sessionId, outcome.at]
        );
        this.logger.log(
          `[PUSH_SESSION_END] first pass done ${who} removed=${removed} stale=${ifBoundTo ?? 'none'} ` +
            `- final pass at ${outcome.at.toISOString()}, once every access token of the session expired`
        );
      }
    } catch (err) {
      await this.recordFailure(row, who, err);
    }
  }

  private async recordFailure(row: ClaimedEnding, who: string, err: unknown): Promise<void> {
    const failure = describeFailure(err);
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 400) {
      // The route refused the ADDRESS itself (an id it does not accept): no retry can change that,
      // so retrying for ever would only repeat this line. Accused once, and the row goes.
      await this.dropPermanent(row, who, failure);
      return;
    }
    const attempts = row.attempts + 1;
    const delaySeconds = Math.round(retryDelayMs(attempts) / 1000);
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
    const ageSeconds = Math.round((Date.now() - new Date(row.endedAt).getTime()) / 1000);
    this.logger.error(
      `[PUSH_SESSION_END] the push registration was NOT ended ${who} attempts=${attempts} ` +
        `age=${ageSeconds}s error=${failure} - retried in ${delaySeconds}s`
    );
  }

  private async dropPermanent(row: ClaimedEnding, who: string, failure: string): Promise<void> {
    try {
      await this.dataSource.query(`DELETE FROM session_push_endings WHERE "sessionId" = $1`, [
        row.sessionId,
      ]);
    } catch (writeErr) {
      this.logger.error(
        `[PUSH_SESSION_END] could not drop a refused ending ${who}: ${describeFailure(writeErr)}`
      );
      return;
    }
    this.logger.error(
      `[PUSH_SESSION_END] REFUSED for good ${who} error=${failure} - chat-delivery-service does not ` +
        `accept this address, no retry can end it; the ending is dropped ` +
        `(libs/contracts/device-id.json is what bindDevice must enforce)`
    );
  }
}
