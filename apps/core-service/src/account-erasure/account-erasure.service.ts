import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import axios from 'axios';
import { ACCESS_TOKEN_TTL_SECONDS } from '../auth/token-lifetimes';
import {
  CORE_ERASURE_STATEMENTS,
  ERASURE_TARGETS,
  afterSuccess,
  describeFailure,
  retryDelayMs,
  subjectDigest,
} from './erasure-policy';

/** How often the worker looks for due jobs. A request also starts a drain at once. */
const DRAIN_INTERVAL_MS = 60_000;
/** How often the report runs. It also runs once shortly after boot. */
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_REPORT_DELAY_MS = 5 * 60 * 1000;
/** A job pending longer than this is ACCUSED by the report. */
const OVERDUE_AFTER_HOURS = 24;
/**
 * How long a claimed job is hidden from other claimers. Concurrency only - the calls are idempotent,
 * so a lease that runs out early costs one duplicate call, never a wrong result.
 */
const CLAIM_LEASE_SECONDS = 300;
/** Above the slowest downstream erasure measured, below the lease. */
const CALL_TIMEOUT_MS = 120_000;
/** Seconds added to the token TTL before the final pass, for clock skew between the hosts. */
const CREDENTIAL_SKEW_SECONDS = 60;
const CLAIM_BATCH = 10;

interface ClaimedJob {
  id: string;
  subjectId: string;
  service: string;
  attempts: number;
  credentialsExpireAt: Date;
  lastAttemptAt: Date;
}

/**
 * THE ACCOUNT ERASURE, AS A DURABLE QUEUE: an account is deactivated at once and erased everywhere
 * eventually, and "eventually" is a guarantee rather than a hope.
 *
 * `requestErasure` runs ONE transaction: core's own data about the account goes
 * ({@link CORE_ERASURE_STATEMENTS}), one job per downstream service is recorded, and the `users` row
 * is deleted - so nothing nominative is left in `users`, no session can be refreshed, and the
 * account can no longer sign in (`isErasurePending`, checked by the OIDC callback, because a new
 * sign-in would recreate the account under the same OIDC subject while its old data was still being
 * erased). The worker then calls each service's idempotent internal DELETE until it answers 2xx,
 * with backoff ({@link retryDelayMs}), and completes the job only after a call that started once
 * every token the account held had expired ({@link afterSuccess}).
 *
 * What would make it wrong is reported, not guessed at: every failed attempt is a `warn` line naming
 * the service and the next attempt, and a daily report accuses at `error` level every job pending
 * longer than {@link OVERDUE_AFTER_HOURS} hours.
 */
@Injectable()
export class AccountErasureService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountErasureService.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';
  private drainTimer: NodeJS.Timeout | null = null;
  private reportTimer: NodeJS.Timeout | null = null;
  private firstReport: NodeJS.Timeout | null = null;
  /** The drain in flight, so overlapping triggers share it instead of racing it. */
  private draining: Promise<void> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.drainTimer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
    this.reportTimer = setInterval(() => void this.report(), REPORT_INTERVAL_MS);
    this.firstReport = setTimeout(() => void this.report(), FIRST_REPORT_DELAY_MS);
    // Housekeeping must never hold the process open on shutdown.
    this.drainTimer.unref?.();
    this.reportTimer.unref?.();
    this.firstReport.unref?.();
  }

  onModuleDestroy(): void {
    for (const t of [this.drainTimer, this.reportTimer]) if (t) clearInterval(t);
    if (this.firstReport) clearTimeout(this.firstReport);
    this.drainTimer = this.reportTimer = this.firstReport = null;
  }

  /**
   * Deactivates the account and queues its erasure everywhere, in ONE transaction: either all of it
   * happens or nothing does, and the caller's error is the person's to retry.
   *
   * Idempotent: a second request finds no user row and a pending job per service, and adds nothing.
   */
  async requestErasure(subjectId: string): Promise<void> {
    const who = subjectId.slice(0, 8);
    this.logger.log(`[ERASURE] requested user=${who}`);

    const counts: Record<string, number> = {};
    await this.dataSource.transaction(async (manager) => {
      for (const s of CORE_ERASURE_STATEMENTS) {
        const params = s.replacement === undefined ? [subjectId] : [subjectId, s.replacement];
        const [, affected] = (await manager.query(s.sql, params)) as [unknown, number];
        if (affected > 0) counts[s.label] = affected;
      }
      for (const target of ERASURE_TARGETS) {
        await manager.query(
          `INSERT INTO account_erasure_jobs ("subjectId", service, "credentialsExpireAt")
           VALUES ($1, $2, now() + make_interval(secs => $3))
           ON CONFLICT ("subjectId", service) WHERE "completedAt" IS NULL DO NOTHING`,
          [subjectId, target.service, ACCESS_TOKEN_TTL_SECONDS + CREDENTIAL_SKEW_SECONDS]
        );
      }
      const [, users] = (await manager.query(`DELETE FROM users WHERE id = $1`, [subjectId])) as [
        unknown,
        number,
      ];
      counts.users = users;
    });

    this.logger.log(
      `[ERASURE] account deactivated user=${who} core=${JSON.stringify(counts)} ` +
        `jobs=${ERASURE_TARGETS.map((t) => t.service).join(',')}`
    );
    // The first attempt now rather than at the next tick: most erasures finish their first pass
    // before the person has closed the confirmation.
    void this.drain();
  }

  /** Whether an erasure of this subject is still running - a sign-in must be refused until it ends. */
  async isErasurePending(subjectId: string): Promise<boolean> {
    const rows = (await this.dataSource.query(
      `SELECT 1 FROM account_erasure_jobs WHERE "subjectId" = $1 AND "completedAt" IS NULL LIMIT 1`,
      [subjectId]
    )) as unknown[];
    return rows.length > 0;
  }

  /**
   * Runs every due job once. Single-flight inside the process; across processes, the claim is a
   * `FOR UPDATE SKIP LOCKED` that pushes the job's due time forward by a lease.
   */
  drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drainOnce()
        .catch((err: unknown) => {
          // The queue survives in the database; the next tick picks it up again.
          this.logger.error(`[ERASURE] drain failed: ${describeFailure(err)} ${String(err)}`);
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
      for (const job of claimed) await this.attempt(job);
    }
  }

  private async claim(): Promise<ClaimedJob[]> {
    const [rows] = (await this.dataSource.query(
      `UPDATE account_erasure_jobs
          SET "nextAttemptAt" = now() + make_interval(secs => $1), "lastAttemptAt" = now()
        WHERE id IN (
          SELECT id FROM account_erasure_jobs
           WHERE "completedAt" IS NULL AND "nextAttemptAt" <= now()
           ORDER BY "nextAttemptAt"
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING id, "subjectId", service, attempts, "credentialsExpireAt", "lastAttemptAt"`,
      [CLAIM_LEASE_SECONDS, CLAIM_BATCH]
    )) as [ClaimedJob[], number];
    return rows ?? [];
  }

  /** One call to one service, and the job's next state. Never throws: the outcome is the job row. */
  private async attempt(job: ClaimedJob): Promise<void> {
    const target = ERASURE_TARGETS.find((t) => t.service === job.service);
    const who = job.subjectId.slice(0, 8);
    if (!target) {
      // A row naming a service this build does not know cannot be completed by any retry.
      this.logger.error(`[ERASURE] unknown service=${job.service} job=${job.id} user=${who}`);
      return;
    }
    try {
      const res = await axios.delete(target.url(job.subjectId), {
        headers: { 'x-internal-secret': this.internalSecret },
        timeout: CALL_TIMEOUT_MS,
      });
      const outcome = afterSuccess(new Date(job.lastAttemptAt), new Date(job.credentialsExpireAt));
      if (outcome.kind === 'complete') {
        await this.dataSource.query(
          `UPDATE account_erasure_jobs
              SET "completedAt" = now(), "subjectId" = $2, "lastError" = NULL
            WHERE id = $1`,
          [job.id, subjectDigest(job.subjectId)]
        );
        this.logger.log(
          `[ERASURE] complete service=${job.service} user=${who} attempts=${job.attempts} ` +
            `answer=${JSON.stringify(res.data ?? null).slice(0, 200)}`
        );
      } else {
        await this.dataSource.query(
          `UPDATE account_erasure_jobs SET "nextAttemptAt" = $2, "lastError" = NULL WHERE id = $1`,
          [job.id, outcome.at]
        );
        this.logger.log(
          `[ERASURE] first pass done service=${job.service} user=${who} - ` +
            `final pass at ${outcome.at.toISOString()}, once every token of the account has expired`
        );
      }
    } catch (err) {
      const attempts = job.attempts + 1;
      const delayMs = retryDelayMs(attempts);
      const failure = describeFailure(err);
      await this.dataSource.query(
        `UPDATE account_erasure_jobs
            SET attempts = $2, "lastError" = $3,
                "nextAttemptAt" = now() + make_interval(secs => $4)
          WHERE id = $1`,
        [job.id, attempts, failure, Math.round(delayMs / 1000)]
      );
      this.logger.warn(
        `[ERASURE] attempt failed service=${job.service} user=${who} attempts=${attempts} ` +
          `error=${failure} - retried in ${Math.round(delayMs / 1000)}s`
      );
    }
  }

  /**
   * The daily report: one summary line, and one ERROR line per job pending longer than
   * {@link OVERDUE_AFTER_HOURS} hours - an erasure owed for a day is either a service that has been
   * refusing all that time or a defect, and the line carries the service, the attempts and the last
   * failure that tell the two apart.
   */
  async report(): Promise<{ pending: number; overdue: number; completed24h: number } | null> {
    try {
      const [summary] = (await this.dataSource.query(
        `SELECT count(*) FILTER (WHERE "completedAt" IS NULL)::int AS pending,
                count(*) FILTER (WHERE "completedAt" > now() - interval '24 hours')::int AS completed24h
           FROM account_erasure_jobs`
      )) as Array<{ pending: number; completed24h: number }>;
      const overdue = (await this.dataSource.query(
        `SELECT service, "subjectId", "requestedAt", attempts, "lastError"
           FROM account_erasure_jobs
          WHERE "completedAt" IS NULL AND "requestedAt" < now() - make_interval(hours => $1)
          ORDER BY "requestedAt"`,
        [OVERDUE_AFTER_HOURS]
      )) as Array<{
        service: string;
        subjectId: string;
        requestedAt: Date;
        attempts: number;
        lastError: string | null;
      }>;
      for (const job of overdue) {
        this.logger.error(
          `[ERASURE] OVERDUE service=${job.service} user=${job.subjectId.slice(0, 8)} ` +
            `requested=${new Date(job.requestedAt).toISOString()} attempts=${job.attempts} ` +
            `lastError=${job.lastError ?? 'none'}`
        );
      }
      const line =
        `[ERASURE] daily report: pending=${summary.pending} overdue=${overdue.length} ` +
        `completed24h=${summary.completed24h}`;
      if (overdue.length > 0) this.logger.error(line);
      else this.logger.log(line);
      return {
        pending: summary.pending,
        overdue: overdue.length,
        completed24h: summary.completed24h,
      };
    } catch (err) {
      // A report that cannot run is itself the thing to report.
      this.logger.error(`[ERASURE] daily report failed: ${describeFailure(err)} ${String(err)}`);
      return null;
    }
  }
}
