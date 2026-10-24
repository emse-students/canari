import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import axios from 'axios';
import { ACCESS_TOKEN_TTL_SECONDS, CREDENTIAL_SKEW_SECONDS } from '../auth/token-lifetimes';
import {
  CORE_ERASURE_STATEMENTS,
  ERASURE_ORDER,
  ERASURE_TARGETS,
  UNKNOWN_SERVICE,
  afterSuccess,
  classifyFailure,
  describeFailure,
  replayCandidates,
  retryDelayMs,
  subjectDigest,
  type ErasureJournalExport,
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
/**
 * ONE job per claim: jobs run one after the other, each up to {@link CALL_TIMEOUT_MS}, so a batch
 * leased together would let the last ones' lease run out while the first still ran.
 */
const CLAIM_BATCH = 1;
/**
 * A completed row keeps a digest of the subject for this long, then is deleted: an unsalted hash of
 * an identifier that is guessable from the school's own directory is an identifier, kept for ever.
 * Backups are kept 14 days, so 30 covers a replay of the erasures they predate.
 */
const JOURNAL_RETENTION_DAYS = 30;
/**
 * Identical consecutive failures of the `core` job (a database statement, deterministic) after which
 * it is classed PERMANENT: a deployment's SQL that fails the same way N times will not pass by itself.
 */
const REPEATED_LOCAL_FAILURE_LIMIT = 5;

interface ClaimedJob {
  id: string;
  subjectId: string;
  service: string;
  attempts: number;
  credentialsExpireAt: Date;
  lastAttemptAt: Date;
  lastError: string | null;
  sameFailureRun: number;
}

/** Where a subject's erasure stands, as the sign-in refusal needs it. */
export type ErasureState = 'none' | 'pending' | 'blocked';

/**
 * THE ACCOUNT ERASURE, AS A DURABLE QUEUE: an account is deactivated at once and erased everywhere
 * eventually, and "eventually" is a guarantee rather than a hope.
 *
 * `requestErasure` runs ONE transaction: core's own data about the account goes
 * ({@link CORE_ERASURE_STATEMENTS}, the `users` row last), and one job per part of the erasure is
 * recorded - core's own part included, because a token still valid for up to an hour can write a
 * block or a correction request after the request ran. No session can be refreshed, and the account
 * can no longer sign in ({@link erasureState}, checked by the OIDC callback: a new sign-in would
 * recreate the account under the same OIDC subject while its old data was still being erased). The
 * worker then runs each part until it succeeds, with backoff ({@link retryDelayMs}), and completes
 * the job only after a pass that started once every token the account held had expired
 * ({@link afterSuccess}).
 *
 * What would make it wrong is reported, not guessed at: every failed attempt is logged with its
 * failure and its class ({@link classifyFailure}) - a PERMANENT one at `error` at once - and a daily
 * report accuses at `error` level every job pending longer than {@link OVERDUE_AFTER_HOURS} hours and
 * every job blocked on a permanent failure.
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
   * Idempotent: a second request finds no user row and a pending job per part, and adds nothing.
   */
  async requestErasure(subjectId: string): Promise<void> {
    const who = subjectId.slice(0, 8);
    this.logger.log(`[ERASURE] requested user=${who}`);

    let counts: Record<string, number> = {};
    await this.dataSource.transaction(async (manager) => {
      // Held to the commit: a sign-in's `confirmAfterSignIn` waits for it, then sees the jobs.
      await lockSubject(manager, subjectId);
      counts = await eraseCoreRows(manager, subjectId);
      for (const target of ERASURE_TARGETS) {
        await manager.query(
          `INSERT INTO account_erasure_jobs ("subjectId", service, "credentialsExpireAt")
           VALUES ($1, $2, now() + make_interval(secs => $3))
           ON CONFLICT ("subjectId", service) WHERE "completedAt" IS NULL DO NOTHING`,
          [subjectId, target.service, ACCESS_TOKEN_TTL_SECONDS + CREDENTIAL_SKEW_SECONDS]
        );
      }
    });

    this.logger.log(
      `[ERASURE] account deactivated user=${who} core=${JSON.stringify(counts)} ` +
        `jobs=${ERASURE_TARGETS.map((t) => t.service).join(',')}`
    );
    // The first attempt now rather than at the next tick: most erasures finish their first pass
    // before the person has closed the confirmation.
    void this.drain();
  }

  /**
   * Where an erasure of this subject stands. A sign-in is refused while it is not `none`; `blocked`
   * (a pending job whose last failure is permanent) is the case a retry has not been shown to fix,
   * so the person is told to contact us rather than to wait.
   */
  async erasureState(
    subjectId: string,
    manager: EntityManager = this.dataSource.manager
  ): Promise<ErasureState> {
    const [row] = (await manager.query(
      `SELECT count(*)::int AS pending,
              count(*) FILTER (WHERE "lastFailureKind" = 'permanent')::int AS blocked
         FROM account_erasure_jobs WHERE "subjectId" = $1 AND "completedAt" IS NULL`,
      [subjectId]
    )) as Array<{ pending: number; blocked: number }>;
    if (!row || row.pending === 0) return 'none';
    return row.blocked > 0 ? 'blocked' : 'pending';
  }

  /**
   * Closes the race the first refusal cannot: an OIDC callback that read {@link erasureState} BEFORE
   * a `DELETE /users/me` committed, then wrote the user row and a session AFTER it. Called once the
   * session exists, and before any token leaves the server.
   *
   * It takes the subject's erasure lock - the one `requestErasure` holds for its whole transaction -
   * so exactly one of two orders is possible, and both are safe: the erasure committed first, and it
   * is seen here (what the sign-in wrote is erased again, in this transaction, and the caller
   * refuses); or it starts after, and its own transaction deletes this session and the user row, and
   * its final pass is due after this sign-in's access token expires. No long-held connection: the
   * lock lives as long as this short transaction.
   *
   * @returns the state found; `none` means the sign-in may proceed.
   */
  async confirmAfterSignIn(subjectId: string): Promise<ErasureState> {
    return this.dataSource.transaction(async (manager) => {
      await lockSubject(manager, subjectId);
      const state = await this.erasureState(subjectId, manager);
      if (state === 'none') return state;
      this.logger.warn(
        `[ERASURE] a sign-in raced an erasure user=${subjectId.slice(0, 8)} state=${state} - ` +
          `the rows it wrote are erased again`
      );
      await eraseCoreRows(manager, subjectId);
      return state;
    });
  }

  /**
   * The CURRENT journal, in the form a restore carries across ({@link ErasureJournalExport}). Read by
   * `restore-replay export` BEFORE a backup replaces the database: the restored journal predates
   * every erasure made after the archive, so this is the only record of them that survives.
   */
  async exportJournal(): Promise<ErasureJournalExport> {
    const completed = (await this.dataSource.query(
      `SELECT "subjectId" AS digest, max("requestedAt") AS "requestedAt"
         FROM account_erasure_jobs WHERE "completedAt" IS NOT NULL
        GROUP BY "subjectId" ORDER BY "subjectId"`
    )) as Array<{ digest: string; requestedAt: Date | string }>;
    const pending = (await this.dataSource.query(
      `SELECT "subjectId", max("requestedAt") AS "requestedAt"
         FROM account_erasure_jobs WHERE "completedAt" IS NULL
        GROUP BY "subjectId" ORDER BY "subjectId"`
    )) as Array<{ subjectId: string; requestedAt: Date | string }>;
    this.logger.log(
      `[ERASURE] journal exported for a restore: completed=${completed.length} pending=${pending.length}`
    );
    return {
      completed: completed.map((r) => ({
        digest: r.digest,
        requestedAt: new Date(r.requestedAt).toISOString(),
      })),
      pending: pending.map((r) => ({
        subjectId: r.subjectId,
        requestedAt: new Date(r.requestedAt).toISOString(),
      })),
    };
  }

  /**
   * Erases again every account a backup restore brought back: called once the restored database is
   * live, with the journal {@link exportJournal} read from the database it replaced.
   *
   * A restored account the journal names (pending, or completed by digest) is requested again only
   * if its row was created BEFORE the latest erasure of it was requested - an account created after
   * it is the same person's NEW account (same id: `users.id` is the OIDC subject), which nobody asked
   * to erase, and it is logged as kept rather than touched. That holds for a pending one too: the
   * replay may be re-run long after the restore, once a replayed erasure completed. Each replay is {@link requestErasure}
   * itself, so the account is deactivated at once and its jobs run like any other erasure.
   * Idempotent: a subject already replayed has no user row left and its jobs are already pending.
   *
   * Throws on the first failure: the restore must then stop and say so, not report itself complete.
   */
  async replayAfterRestore(
    journal: ErasureJournalExport
  ): Promise<{ candidates: number; replayed: number; keptNewer: number }> {
    const restored = (await this.dataSource.query(`SELECT id FROM users`)) as Array<{ id: string }>;
    const candidates = replayCandidates(
      journal,
      restored.map((r) => r.id)
    );
    this.logger.log(
      `[ERASURE] replay after a restore: journal completed=${journal.completed.length} ` +
        `pending=${journal.pending.length} restoredUsers=${restored.length} ` +
        `candidates=${candidates.length}`
    );
    let replayed = 0;
    let keptNewer = 0;
    for (const c of candidates) {
      // `createdAt` is a NOT NULL `timestamp` filled by CURRENT_TIMESTAMP on this service's own
      // connection, and this cast reads it back on that same connection, so both sides use the
      // session zone it was written in (UTC in the deployed images) - whatever that zone is.
      const older = (await this.dataSource.query(
        `SELECT 1 FROM users WHERE id = $1 AND "createdAt" < $2::timestamptz`,
        [c.subjectId, c.requestedBefore]
      )) as unknown[];
      if (older.length === 0) {
        keptNewer++;
        this.logger.log(
          `[ERASURE] replay keeps user=${c.subjectId.slice(0, 8)}: its account was created after ` +
            `its erasure was requested (${c.requestedBefore}), so it is a new account`
        );
        continue;
      }
      this.logger.log(
        `[ERASURE] replay erases user=${c.subjectId.slice(0, 8)} again (requested ${c.requestedBefore})`
      );
      await this.requestErasure(c.subjectId);
      replayed++;
    }
    this.logger.log(
      `[ERASURE] replay done: candidates=${candidates.length} replayed=${replayed} keptNewer=${keptNewer}`
    );
    return { candidates: candidates.length, replayed, keptNewer };
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
             -- A part runs only once the part it follows has COMPLETED for the same subject (a
             -- completed job carries a digest, so only a job still owed can match).
             AND NOT EXISTS (
               SELECT 1 FROM account_erasure_jobs prior
                WHERE prior."subjectId" = account_erasure_jobs."subjectId"
                  AND prior."completedAt" IS NULL
                  AND (account_erasure_jobs.service, prior.service) IN
                      (SELECT * FROM unnest($3::text[], $4::text[])))
           ORDER BY "nextAttemptAt"
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING id, "subjectId", service, attempts, "credentialsExpireAt", "lastAttemptAt",
                  "lastError", "sameFailureRun"`,
      [
        CLAIM_LEASE_SECONDS,
        CLAIM_BATCH,
        ERASURE_ORDER.map(([service]) => service),
        ERASURE_ORDER.map(([, after]) => after),
      ]
    )) as [ClaimedJob[], number];
    return rows ?? [];
  }

  /**
   * One pass of one part of the erasure: core's own rows in-process, or one service's internal
   * DELETE. Throws what failed; the answer it returns is for the log line only.
   */
  private async run(job: ClaimedJob): Promise<string> {
    const target = ERASURE_TARGETS.find((t) => t.service === job.service);
    if (!target) {
      // A row naming a part this build does not know cannot be completed by any retry: a PERMANENT
      // failure, journalled like any other so the report and the sign-in refusal both see it.
      throw Object.assign(new Error(`no erasure target named ${job.service}`), {
        code: UNKNOWN_SERVICE,
      });
    }
    if (target.kind === 'local') {
      const counts = await this.dataSource.transaction((manager) =>
        eraseCoreRows(manager, job.subjectId)
      );
      return JSON.stringify(counts);
    }
    const res = await axios.delete(target.url(job.subjectId), {
      headers: { 'x-internal-secret': this.internalSecret },
      timeout: CALL_TIMEOUT_MS,
    });
    return JSON.stringify(res.data ?? null).slice(0, 200);
  }

  /**
   * One pass of one job, and the job's next state. Never throws: the outcome is the job row. Every
   * write is guarded by `"completedAt" IS NULL`, so a pass that outlived its lease, or a job an
   * operator closed meanwhile, cannot reopen or rewrite a finished row.
   */
  private async attempt(job: ClaimedJob): Promise<void> {
    const who = job.subjectId.slice(0, 8);
    try {
      const answer = await this.run(job);
      const outcome = afterSuccess(new Date(job.lastAttemptAt), new Date(job.credentialsExpireAt));
      if (outcome.kind === 'complete') {
        await this.dataSource.query(
          `UPDATE account_erasure_jobs
              SET "completedAt" = now(), "subjectId" = $2, "lastError" = NULL,
                  "sameFailureRun" = 0, "lastFailureKind" = NULL
            WHERE id = $1 AND "completedAt" IS NULL`,
          [job.id, subjectDigest(job.subjectId)]
        );
        this.logger.log(
          `[ERASURE] complete service=${job.service} user=${who} attempts=${job.attempts} ` +
            `answer=${answer}`
        );
      } else {
        await this.dataSource.query(
          `UPDATE account_erasure_jobs
              SET "nextAttemptAt" = $2, "lastError" = NULL, "sameFailureRun" = 0,
                  "lastFailureKind" = NULL
            WHERE id = $1 AND "completedAt" IS NULL`,
          [job.id, outcome.at]
        );
        this.logger.log(
          `[ERASURE] first pass done service=${job.service} user=${who} - ` +
            `final pass at ${outcome.at.toISOString()}, once every token of the account has expired`
        );
      }
    } catch (err) {
      await this.recordFailure(job, err);
    }
  }

  private async recordFailure(job: ClaimedJob, err: unknown): Promise<void> {
    const who = job.subjectId.slice(0, 8);
    const attempts = job.attempts + 1;
    const delaySeconds = Math.round(retryDelayMs(attempts) / 1000);
    const failure = describeFailure(err);
    // Consecutive identical failures: the run grows only on the same fingerprint as the previous
    // attempt, and restarts at 1 on a different one (a success resets it to 0).
    const sameFailureRun = job.lastError === failure ? job.sameFailureRun + 1 : 1;
    let kind = classifyFailure(err);
    const target = ERASURE_TARGETS.find((t) => t.service === job.service);
    if (
      kind === 'transient' &&
      target?.kind === 'local' &&
      sameFailureRun >= REPEATED_LOCAL_FAILURE_LIMIT
    ) {
      // A local pass has no network to blame: the same database error again and again is a defect.
      kind = 'permanent';
    }
    try {
      await this.dataSource.query(
        `UPDATE account_erasure_jobs
            SET attempts = $2, "lastError" = $3, "sameFailureRun" = $6,
                -- STICKY: a job that failed permanent once stays permanent until a pass succeeds, so
                -- the sign-in message never flips between "wait" and "contact us" with each attempt.
                "lastFailureKind" = CASE WHEN "lastFailureKind" = 'permanent' THEN 'permanent'
                                         ELSE $4 END,
                "nextAttemptAt" = now() + make_interval(secs => $5)
          WHERE id = $1 AND "completedAt" IS NULL`,
        [job.id, attempts, failure, kind, delaySeconds, sameFailureRun]
      );
    } catch (writeErr) {
      // The lease still runs out, so the job is retried; only this attempt's record is lost.
      this.logger.error(
        `[ERASURE] could not record a failure service=${job.service} user=${who}: ` +
          `${describeFailure(writeErr)}`
      );
    }
    const line =
      `[ERASURE] attempt failed service=${job.service} user=${who} attempts=${attempts} ` +
      `error=${failure} kind=${kind} - retried in ${delaySeconds}s`;
    // A permanent failure is accused NOW: waiting a day for the report is a day of a person locked
    // out by something no retry is expected to fix.
    if (kind === 'permanent') {
      this.logger.error(`${line} - a human must look (docs/wiki/account-erasure.md#operating-it)`);
    } else {
      this.logger.warn(line);
    }
  }

  /** Deletes completed journal rows older than {@link JOURNAL_RETENTION_DAYS}. */
  private async purgeJournal(): Promise<number> {
    const [, deleted] = (await this.dataSource.query(
      `DELETE FROM account_erasure_jobs
        WHERE "completedAt" < now() - make_interval(days => $1)`,
      [JOURNAL_RETENTION_DAYS]
    )) as [unknown, number];
    if (deleted > 0)
      this.logger.log(`[ERASURE] journal: ${deleted} completed row(s) past retention purged`);
    return deleted;
  }

  /**
   * The daily report: one summary line, and one ERROR line per job pending longer than
   * {@link OVERDUE_AFTER_HOURS} hours - an erasure owed for a day is either a service that has been
   * refusing all that time or a defect, and the line carries the service, the attempts, the last
   * failure and its class that tell the two apart. The summary is itself an error while any job is
   * blocked on a permanent failure, or overdue.
   */
  async report(): Promise<{
    pending: number;
    blocked: number;
    overdue: number;
    completed24h: number;
  } | null> {
    // Its own try: a purge that fails must not take the overdue and blocked accusations with it.
    try {
      await this.purgeJournal();
    } catch (err) {
      this.logger.error(`[ERASURE] journal purge failed: ${describeFailure(err)} ${String(err)}`);
    }
    try {
      const [summary] = (await this.dataSource.query(
        `SELECT count(*) FILTER (WHERE "completedAt" IS NULL)::int AS pending,
                count(*) FILTER (WHERE "completedAt" IS NULL
                                   AND "lastFailureKind" = 'permanent')::int AS blocked,
                count(*) FILTER (WHERE "completedAt" > now() - interval '24 hours')::int AS completed24h,
                count(*) FILTER (WHERE "completedAt" > now() - interval '24 hours'
                                   AND resolution IS NOT NULL)::int AS closed24h
           FROM account_erasure_jobs`
      )) as Array<{ pending: number; blocked: number; completed24h: number; closed24h: number }>;
      const overdue = (await this.dataSource.query(
        `SELECT service, "subjectId", "requestedAt", attempts, "lastError", "lastFailureKind"
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
        lastFailureKind: string | null;
      }>;
      for (const job of overdue) {
        this.logger.error(
          `[ERASURE] OVERDUE service=${job.service} user=${job.subjectId.slice(0, 8)} ` +
            `requested=${new Date(job.requestedAt).toISOString()} attempts=${job.attempts} ` +
            `lastError=${job.lastError ?? 'none'} kind=${job.lastFailureKind ?? 'none'}`
        );
      }
      const line =
        `[ERASURE] daily report: pending=${summary.pending} blocked=${summary.blocked} ` +
        `overdue=${overdue.length} completed24h=${summary.completed24h} ` +
        `closedByOperator24h=${summary.closed24h}`;
      if (overdue.length > 0 || summary.blocked > 0) this.logger.error(line);
      else this.logger.log(line);
      return {
        pending: summary.pending,
        blocked: summary.blocked,
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

/**
 * The per-subject erasure lock, held until the caller's transaction ends: `requestErasure` and a
 * sign-in's `confirmAfterSignIn` exclude each other on it, so neither can interleave with the other.
 */
async function lockSubject(manager: EntityManager, subjectId: string): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `account-erasure:${subjectId}`,
  ]);
}

/**
 * core-service's own rows about the account ({@link CORE_ERASURE_STATEMENTS}, the `users` row last),
 * inside the caller's transaction. Run by the request, by every pass of the `core` job, and by a
 * sign-in that raced the request - idempotent, so any of them may run it again.
 *
 * @returns the rows each statement changed, by label, for the log line.
 */
export async function eraseCoreRows(
  manager: EntityManager,
  subjectId: string
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const s of CORE_ERASURE_STATEMENTS) {
    const params = s.replacement === undefined ? [subjectId] : [subjectId, s.replacement];
    const [, affected] = (await manager.query(s.sql, params)) as [unknown, number];
    if (affected > 0) counts[s.label] = affected;
  }
  return counts;
}
