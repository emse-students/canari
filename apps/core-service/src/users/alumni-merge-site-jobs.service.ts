import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { DataSource, EntityManager } from 'typeorm';
import { describeFailure, retryDelayMs } from '../account-erasure/erasure-policy';
import { readHandoffSigner, type HandoffSigner } from '../auth/handoff/handoff.service';
import { ECOSYSTEM_SITES } from '../auth/handoff/handoff-sites';
import {
  HANDOFF_TOKEN_LIFETIME_SECONDS,
  signAlumniMergeCallToken,
} from '../auth/handoff/handoff-token';
import { DurableQueueRunner } from '../common/durable-queue';

/** How often the worker looks for due jobs. `complete` also starts a drain at once. */
const DRAIN_INTERVAL_MS = 60_000;
/** How often the report runs, and how long after boot it first runs. */
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_REPORT_DELAY_MS = 5 * 60 * 1000;
/** A job pending longer than this is ACCUSED by the report. */
const OVERDUE_AFTER_HOURS = 24;
/** How long a site that answered 404 (its endpoint not served yet) waits before it is asked again. */
const UNREADY_RETRY_HOURS = 24;
/**
 * How long a job the site REFUSED (401: the token's signature, issuer, audience or time) waits before
 * it is asked again: slow, since no retry alone fixes a refusal, but not never, so a key rotation or
 * a site's redeploy heals it without a hand on the job.
 */
const REFUSED_RETRY_HOURS = 1;
/** A refusal class as the site names it in `{ outcome }` (`wrong_audience`, `expired`...). */
const REFUSAL_CLASS = /^[a-z][a-z_]{0,31}$/;
/** How long a claimed job is hidden from other claimers; above one call's timeout. */
const CLAIM_LEASE_SECONDS = 120;
/** One site's transfer is one local transaction there; this bounds a site that hangs. */
const CALL_TIMEOUT_MS = 30_000;
/** The path every sibling site serves the transfer on (D54). */
export const ALUMNI_MERGE_SITE_PATH = '/api/internal/alumni-merge';

/**
 * The sites that hold an account per MiConnect subject: every MiConnect site of the contract
 * (`libs/contracts/ecosystem-sites.json`) - Sky, MiGallery, Le Cercle. Portail-etu keeps no account
 * (D53) and is not a MiConnect site, so it is not one. Derived, never typed: a site added to the
 * contract is owed its job.
 */
export const ALUMNI_MERGE_SITES: readonly string[] = ECOSYSTEM_SITES.filter((s) => s.miconnect).map(
  (s) => s.id
);

/**
 * What a site answers it did (D53): a `transfer` answers `absent`, `transferred` or `merged`; an
 * `erase` answers `absent` or `erased`.
 */
export type AlumniMergeSiteOutcome = 'absent' | 'transferred' | 'merged' | 'erased';
const OUTCOMES: readonly AlumniMergeSiteOutcome[] = ['absent', 'transferred', 'merged', 'erased'];

/**
 * What a job asks of its site: move the duplicate's account onto the target's subject, or - once the
 * target was erased (`erasure-policy.ts`, `alumni_merge_site_jobs_owed`) - erase it.
 */
export type AlumniMergeSiteJobKind = 'transfer' | 'erase';

/** A site job as the admin page shows it. `unready`: the site does not serve its endpoint yet. */
export interface AlumniMergeSiteState {
  site: string;
  state: 'pending' | 'unready' | 'blocked' | 'done';
  outcome: AlumniMergeSiteOutcome | null;
  attempts: number;
  lastError: string | null;
}

interface ClaimedJob {
  id: string;
  /** Null once the target's erasure deleted the merge row. */
  mergeId: string | null;
  site: string;
  kind: AlumniMergeSiteJobKind;
  duplicateSubject: string;
  /** Null for an `erase` (the CHECK of migration 030). */
  targetSubject: string | null;
  attempts: number;
}

/** A refusal a site typed on its own state: no retry changes it (D54). */
class SiteBlockedError extends Error {
  constructor(readonly code: string) {
    super(`blocked: ${code}`);
  }
}

/**
 * The site is not ready for the call: a `404` (it does not serve `ALUMNI_MERGE_SITE_PATH` yet, its half
 * of D54 not shipped) or a `503 { outcome: 'not_configured' }` (it serves it, but its trust in Canari's
 * keys is not configured). Not a failure - the job waits, asked again daily, and the daily report
 * names the site once with its count. A site that serves the path never answers 404: an account it
 * does not hold is `absent`, a 2xx.
 */
class SiteUnreadyError extends Error {}

/**
 * A `401 { outcome: <class> }`: the site REFUSED the token (its signature, type, issuer, audience,
 * time or claims). A typed refusal, said at ERROR on EVERY attempt, with the site and the class -
 * never a silent retry - and asked again on a slow cadence, since a deployment fixes it, not a retry.
 */
class SiteRefusedError extends Error {
  constructor(readonly refusal: string) {
    super(`refused: ${refusal}`);
  }
}

/** A 2xx that does not say what was done: the contract is broken, retried until it is not. */
class SiteContractError extends Error {
  readonly code = 'SITE_ANSWER_MALFORMED';
}

/**
 * How a job is named in a log line: its merge, or `merge=erased` with its own id once the target's
 * erasure deleted the merge row; its site and its kind. Never a person (D58).
 */
function jobTag(job: {
  id: string;
  mergeId: string | null;
  site: string;
  kind: AlumniMergeSiteJobKind;
}): string {
  const merge = job.mergeId
    ? `merge=${job.mergeId.slice(0, 8)}`
    : `merge=erased job=${job.id.slice(0, 8)}`;
  return `${merge} site=${job.site} kind=${job.kind}`;
}

/** Where a site job's call goes: the site's origin from the contract, and the one path. */
function siteUrl(site: string): string {
  const found = ECOSYSTEM_SITES.find((s) => s.id === site);
  if (!found) throw Object.assign(new Error(`no site named ${site}`), { code: 'UNKNOWN_SITE' });
  return `${found.origin}${ALUMNI_MERGE_SITE_PATH}`;
}

/**
 * THE ALUMNI MERGE'S SIBLING-SITE JOBS (D52-D54): when a merge completes, each sibling site that
 * holds an account under the duplicate's subject moves what it owns onto the target's subject and
 * erases the rest, in one local transaction, and answers what it did.
 *
 * {@link writeJobs} records one job per site IN the transaction that closes the merge, so a closed
 * merge always owes its sites. The worker - the account-erasure queue's runner
 * ({@link DurableQueueRunner}), its backoff and its failure description - calls
 * `POST <site>/api/internal/alumni-merge` with a 60-second ES256 token signed by the handoff key,
 * `typ: canari-merge+jwt`, audience the site, claims `mode` (`transfer` or `erase`), `dup`, `target`
 * (a transfer only), `jti` = the job id; the site verifies it with the ONE verifier Canari ships,
 * `libs/handoff/alumni-merge-verify.ts`, vendored. A `2xx` naming its outcome completes the job; a
 * `409` naming a typed refusal BLOCKS it (the state refused, not the network: no retry, an ERROR
 * line); a `401 { outcome: <class> }` is a REFUSED token, an ERROR line on every attempt, asked again
 * hourly; a `404` or a `503 { outcome: 'not_configured' }` is a site not ready - UNREADY, asked
 * again daily, no line per try; anything else is retried with backoff.
 *
 * EACH JOB CARRIES THE SUBJECTS IT NEEDS and never reads its merge row. The target's erasure turns a
 * job still owed into an `erase` while a call may be in flight, so every write that settles an attempt
 * names the job's KIND as claimed and checks that it wrote one row: none means the job changed or left
 * under the call, said at ERROR, and the job as it now stands runs at its next turn.
 *
 * IDEMPOTENCE FROM DURABLE STATE: the job row says what is owed, the site's own tables say what is
 * done - a duplicate subject with no account there is `absent`, whether it never signed in or a first
 * call already moved it. The daily report accuses every job pending over a day and every blocked one,
 * naming the merge and the site, never a person (D58).
 */
@Injectable()
export class AlumniMergeSiteJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AlumniMergeSiteJobs');
  private readonly runner = new DurableQueueRunner({
    tag: '[ALUMNI_MERGE_SITE]',
    logger: this.logger,
    drainOnce: () => this.drainOnce(),
    report: () => this.report(),
    drainIntervalMs: DRAIN_INTERVAL_MS,
    reportIntervalMs: REPORT_INTERVAL_MS,
    firstReportDelayMs: FIRST_REPORT_DELAY_MS,
  });
  private readonly signer: HandoffSigner | null;

  constructor(private readonly dataSource: DataSource) {
    this.signer = readHandoffSigner(this.logger);
  }

  onModuleInit(): void {
    this.runner.start();
  }

  onModuleDestroy(): void {
    this.runner.stop();
  }

  /** Runs every due job once (single flight); called after a merge completes, and by the tick. */
  drain(): Promise<void> {
    return this.runner.drain();
  }

  /**
   * Records one job per site for a completed merge, inside the caller's transaction (the one that
   * closes the merge row). Idempotent: the unique index on (merge, site) adds nothing twice.
   */
  async writeJobs(
    manager: EntityManager,
    mergeId: string,
    duplicateSubject: string,
    targetSubject: string
  ): Promise<void> {
    for (const site of ALUMNI_MERGE_SITES) {
      await manager.query(
        `INSERT INTO alumni_merge_site_jobs ("mergeId", site, "duplicateSubject", "targetSubject")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("mergeId", site) DO NOTHING`,
        [mergeId, site, duplicateSubject, targetSubject]
      );
    }
    this.logger.log(
      `[ALUMNI_MERGE_SITE] jobs written merge=${mergeId.slice(0, 8)} sites=${ALUMNI_MERGE_SITES.join(',')}`
    );
  }

  /** The site states of each merge, for the admin page. */
  async statesOf(mergeIds: string[]): Promise<Map<string, AlumniMergeSiteState[]>> {
    const out = new Map<string, AlumniMergeSiteState[]>();
    if (mergeIds.length === 0) return out;
    const rows = (await this.dataSource.query(
      `SELECT "mergeId", site, attempts, "lastError", "blockedAt", "unreadySince", outcome, "completedAt"
         FROM alumni_merge_site_jobs WHERE "mergeId" = ANY($1) ORDER BY site`,
      [mergeIds]
    )) as Array<{
      mergeId: string;
      site: string;
      attempts: number;
      lastError: string | null;
      blockedAt: Date | null;
      unreadySince: Date | null;
      outcome: string | null;
      completedAt: Date | null;
    }>;
    for (const r of rows) {
      const list = out.get(r.mergeId) ?? [];
      list.push({
        site: r.site,
        state: r.completedAt
          ? 'done'
          : r.blockedAt
            ? 'blocked'
            : r.unreadySince
              ? 'unready'
              : 'pending',
        outcome: OUTCOMES.find((o) => o === r.outcome) ?? null,
        attempts: r.attempts,
        lastError: r.lastError,
      });
      out.set(r.mergeId, list);
    }
    return out;
  }

  private async drainOnce(): Promise<void> {
    for (;;) {
      const job = await this.claim();
      if (!job) return;
      await this.attempt(job);
    }
  }

  private async claim(): Promise<ClaimedJob | undefined> {
    const [rows] = (await this.dataSource.query(
      `UPDATE alumni_merge_site_jobs
          SET "nextAttemptAt" = now() + make_interval(secs => $1), "lastAttemptAt" = now()
        WHERE id IN (
          SELECT id FROM alumni_merge_site_jobs
           WHERE "completedAt" IS NULL AND "blockedAt" IS NULL AND "nextAttemptAt" <= now()
           ORDER BY "nextAttemptAt"
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING id, "mergeId", site, kind, "duplicateSubject", "targetSubject", attempts`,
      [CLAIM_LEASE_SECONDS]
    )) as [ClaimedJob[], number];
    return rows?.[0];
  }

  /** One call to the site; throws what failed, returns the outcome the site named. */
  private async call(job: ClaimedJob): Promise<AlumniMergeSiteOutcome> {
    if (!this.signer) {
      // A deployment fault, said at error by readHandoffSigner at boot; retried, so the job runs the
      // moment the key is provisioned, and accused by the report after a day.
      throw Object.assign(new Error('no handoff signing key on this estate'), {
        code: 'NO_SIGNING_KEY',
      });
    }
    const iat = Math.floor(Date.now() / 1000);
    const token = signAlumniMergeCallToken(this.signer.key, this.signer.jwk.kid, {
      iss: this.signer.issuer,
      aud: job.site,
      mode: job.kind,
      dup: job.duplicateSubject,
      ...(job.kind === 'transfer' && job.targetSubject ? { target: job.targetSubject } : {}),
      jti: job.id,
      iat,
      exp: iat + HANDOFF_TOKEN_LIFETIME_SECONDS,
    });
    try {
      const res = await axios.post<{ outcome?: unknown }>(
        siteUrl(job.site),
        {},
        { headers: { authorization: `Bearer ${token}` }, timeout: CALL_TIMEOUT_MS }
      );
      const outcome = OUTCOMES.find((o) => o === res.data?.outcome);
      if (!outcome) throw new SiteContractError(`answer ${res.status} names no outcome`);
      return outcome;
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { code?: unknown } } };
      const status = e?.response?.status;
      const outcome = (e?.response?.data as { outcome?: unknown } | undefined)?.outcome;
      // Classified on the status and a TYPED body field, never on prose.
      if (status === 404 || (status === 503 && outcome === 'not_configured')) {
        throw new SiteUnreadyError();
      }
      if (status === 401) {
        throw new SiteRefusedError(
          typeof outcome === 'string' && REFUSAL_CLASS.test(outcome) ? outcome : 'unclassified'
        );
      }
      const code = e?.response?.data?.code;
      if (
        e?.response?.status === 409 &&
        typeof code === 'string' &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
      ) {
        throw new SiteBlockedError(code);
      }
      throw err;
    }
  }

  /** One pass of one job, and its next state. Never throws: the outcome is the job row. */
  private async attempt(job: ClaimedJob): Promise<void> {
    const tag = jobTag(job);
    try {
      const outcome = await this.call(job);
      // An `erase` whose merge row is gone has nothing left to show: done, it is deleted, so the
      // duplicate's subject does not outlive the work it was kept for.
      const settled =
        job.mergeId === null
          ? await this.settle(job, tag, 'DELETE FROM alumni_merge_site_jobs', [])
          : await this.settle(
              job,
              tag,
              `UPDATE alumni_merge_site_jobs
                  SET "completedAt" = now(), outcome = $3, "lastError" = NULL, "unreadySince" = NULL`,
              [outcome]
            );
      if (settled) {
        this.logger.log(
          `[ALUMNI_MERGE_SITE] done ${tag} outcome=${outcome} attempts=${job.attempts}`
        );
      }
    } catch (err) {
      if (err instanceof SiteBlockedError) {
        const settled = await this.settle(
          job,
          tag,
          'UPDATE alumni_merge_site_jobs SET "blockedAt" = now(), "lastError" = $3, "unreadySince" = NULL',
          [`HTTP 409 ${err.code}`]
        );
        if (settled) {
          this.logger.error(
            `[ALUMNI_MERGE_SITE] BLOCKED ${tag} refusal=${err.code} - the site refused on its own state, ` +
              'no retry; a human must look (docs/wiki/profiles-and-access.md, D53)'
          );
        }
        return;
      }
      if (err instanceof SiteRefusedError) {
        await this.recordRefusal(job, err, tag);
        return;
      }
      if (err instanceof SiteUnreadyError) {
        // NOT A FAILURE, SO NOT A WARN PER TRY: the site has not shipped its half. Asked again daily;
        // the daily report names the site once, with how many jobs wait for it.
        const settled = await this.settle(
          job,
          tag,
          `UPDATE alumni_merge_site_jobs
              SET "unreadySince" = COALESCE("unreadySince", now()), "lastError" = 'HTTP 404 site_unready',
                  "nextAttemptAt" = now() + make_interval(hours => $3)`,
          [UNREADY_RETRY_HOURS]
        );
        if (settled) {
          this.logger.debug(
            `[ALUMNI_MERGE_SITE] unready ${tag}: the site answers 404, asked again in ${UNREADY_RETRY_HOURS}h`
          );
        }
        return;
      }
      await this.recordFailure(job, err, tag);
    }
  }

  /**
   * Writes the result of one attempt on the job AS CLAIMED: still owed (`completedAt` null) and of the
   * kind it was claimed with. `statement` is an `UPDATE ... SET ...` or a `DELETE FROM`, its extra
   * parameters from `$3`. False, said at ERROR, when no row matched: the job left (a cascade, which
   * migration 030 makes impossible) or changed under the call (the target's erasure turned a transfer
   * into an erase meanwhile); this attempt's result is then not recorded, and the job as it now
   * stands runs at its next turn.
   */
  private async settle(
    job: ClaimedJob,
    tag: string,
    statement: string,
    params: unknown[]
  ): Promise<boolean> {
    const [rows] = (await this.dataSource.query(
      `${statement} WHERE id = $1 AND "completedAt" IS NULL AND kind = $2 RETURNING id`,
      [job.id, job.kind, ...params]
    )) as [unknown[], number];
    if ((rows ?? []).length === 1) return true;
    this.logger.error(
      `[ALUMNI_MERGE_SITE] settled ${tag} but its row is gone or changed under the call (the ` +
        'target erased meanwhile turns a transfer into an erase) - this result is not recorded, ' +
        'the job as it stands runs next'
    );
    return false;
  }

  /**
   * A refused token: counted as an attempt, asked again in {@link REFUSED_RETRY_HOURS}, and said at
   * ERROR every time - the site and the class, so a refusal never hides behind a retry.
   */
  private async recordRefusal(job: ClaimedJob, err: SiteRefusedError, tag: string): Promise<void> {
    const attempts = job.attempts + 1;
    try {
      await this.settle(
        job,
        tag,
        `UPDATE alumni_merge_site_jobs
            SET attempts = $3, "lastError" = $4, "unreadySince" = NULL,
                "nextAttemptAt" = now() + make_interval(hours => $5)`,
        [attempts, `HTTP 401 ${err.refusal}`, REFUSED_RETRY_HOURS]
      );
    } catch (writeErr) {
      this.logger.error(
        `[ALUMNI_MERGE_SITE] could not record a refusal ${tag}: ${describeFailure(writeErr)}`
      );
    }
    this.logger.error(
      `[ALUMNI_MERGE_SITE] REFUSED ${tag} class=${err.refusal} attempts=${attempts} - the site refused ` +
        `the token; a deployment fixes it (key, issuer, audience, clock), asked again in ${REFUSED_RETRY_HOURS}h`
    );
  }

  private async recordFailure(job: ClaimedJob, err: unknown, tag: string): Promise<void> {
    const attempts = job.attempts + 1;
    const delaySeconds = Math.round(retryDelayMs(attempts) / 1000);
    const failure = describeFailure(err);
    try {
      await this.settle(
        job,
        tag,
        `UPDATE alumni_merge_site_jobs
            SET attempts = $3, "lastError" = $4, "unreadySince" = NULL,
                "nextAttemptAt" = now() + make_interval(secs => $5)`,
        [attempts, failure, delaySeconds]
      );
    } catch (writeErr) {
      // The lease still runs out, so the job is retried; only this attempt's record is lost.
      this.logger.error(
        `[ALUMNI_MERGE_SITE] could not record a failure ${tag}: ${describeFailure(writeErr)}`
      );
    }
    this.logger.warn(
      `[ALUMNI_MERGE_SITE] attempt failed ${tag} attempts=${attempts} error=${failure} - retried in ${delaySeconds}s`
    );
  }

  /**
   * The daily report: one ERROR line per job pending longer than {@link OVERDUE_AFTER_HOURS} hours
   * and per blocked job, naming the merge and the site (never a person); one WARN line per site that
   * does not serve its endpoint yet, with how many jobs wait for it (never one per job); and one
   * summary line - an error while any is overdue or blocked.
   */
  async report(): Promise<{
    pending: number;
    unready: number;
    blocked: number;
    overdue: number;
  } | null> {
    try {
      const rows = (await this.dataSource.query(
        `SELECT id, "mergeId", site, kind, attempts, "lastError", "createdAt", "blockedAt"
           FROM alumni_merge_site_jobs
          WHERE "completedAt" IS NULL
            AND ("blockedAt" IS NOT NULL
                 OR ("unreadySince" IS NULL AND "createdAt" < now() - make_interval(hours => $1)))
          ORDER BY "createdAt"`,
        [OVERDUE_AFTER_HOURS]
      )) as Array<{
        id: string;
        mergeId: string | null;
        kind: AlumniMergeSiteJobKind;
        site: string;
        attempts: number;
        lastError: string | null;
        createdAt: Date;
        blockedAt: Date | null;
      }>;
      const [summary] = (await this.dataSource.query(
        `SELECT count(*) FILTER (WHERE "completedAt" IS NULL AND "blockedAt" IS NULL
                                   AND "unreadySince" IS NULL)::int AS pending,
                count(*) FILTER (WHERE "completedAt" IS NULL AND "blockedAt" IS NULL
                                   AND "unreadySince" IS NOT NULL)::int AS unready,
                count(*) FILTER (WHERE "completedAt" IS NULL AND "blockedAt" IS NOT NULL)::int AS blocked
           FROM alumni_merge_site_jobs`
      )) as Array<{ pending: number; unready: number; blocked: number }>;
      const waiting = (await this.dataSource.query(
        `SELECT site, count(*)::int AS jobs, min("unreadySince") AS since
           FROM alumni_merge_site_jobs
          WHERE "completedAt" IS NULL AND "blockedAt" IS NULL AND "unreadySince" IS NOT NULL
          GROUP BY site ORDER BY site`
      )) as Array<{ site: string; jobs: number; since: Date }>;
      for (const w of waiting) {
        this.logger.warn(
          `[ALUMNI_MERGE_SITE] site=${w.site} does not serve ${ALUMNI_MERGE_SITE_PATH} yet: ${w.jobs} ` +
            `job(s) wait for it since ${new Date(w.since).toISOString()}, asked again daily`
        );
      }
      for (const r of rows) {
        this.logger.error(
          `[ALUMNI_MERGE_SITE] ${r.blockedAt ? 'BLOCKED' : 'OVERDUE'} ${jobTag(r)} ` +
            `created=${new Date(r.createdAt).toISOString()} attempts=${r.attempts} lastError=${r.lastError ?? 'none'}`
        );
      }
      const overdue = rows.filter((r) => !r.blockedAt).length;
      const line =
        `[ALUMNI_MERGE_SITE] daily report: pending=${summary.pending} unready=${summary.unready} ` +
        `blocked=${summary.blocked} overdue=${overdue}`;
      if (rows.length > 0) this.logger.error(line);
      else this.logger.log(line);
      return {
        pending: summary.pending,
        unready: summary.unready,
        blocked: summary.blocked,
        overdue,
      };
    } catch (err) {
      this.logger.error(
        `[ALUMNI_MERGE_SITE] daily report failed: ${describeFailure(err)} ${String(err)}`
      );
      return null;
    }
  }
}
