import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { blockedUserIdsFor } from '../common/blocked-user-ids';
import { isUniqueViolation } from '../common/pg-errors';
import { isBlockedBetween } from '../common/user-blocks';
import { ModerationService } from '../moderation/moderation.service';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { NOTIFICATIONS_TARGET } from '../push/push-target';
import { DELETED_ACCOUNT } from '../internal/account-erasure';
import {
  LIVE_CHAT_REPORT_MAX_KEEP_MS,
  LIVE_CUT_DETAILS_MAX,
  LIVE_CUT_REASONS,
  LIVE_CUT_RETENTION_MS,
  LIVE_INGEST_MAX_CONCURRENT,
  LIVE_KEY_HEX_RE,
  LIVE_MANIFEST_WINDOW,
  LIVE_RECONNECT_WINDOW_MS,
  LIVE_RESERVATION_TTL_MS,
  LIVE_RETAINED_SEGMENTS,
  LIVE_TRIM_BATCH,
  LIVE_RULES_VERSION,
  LIVE_SEAT_LEASE_MS,
  LIVE_SEGMENT_BURST,
  LIVE_SEGMENT_MIN_DURATION_MS,
  LIVE_START_WINDOW_MS,
  LIVE_STARTS_PER_HOUR,
  LIVE_WITHDRAWAL_FROM_CUTS,
  type LiveCutReason,
  type LiveEndReason,
} from './live.constants';
import { LiveSeats } from './live-seats';
import { LIVE_SEGMENT_STORE, type LiveSegmentStore } from './live-segment-store';
import { LiveAnnouncer, type ClaimedLive } from './live-announcer';
import {
  consequenceOf,
  lockStanding,
  otherCutsOnRecord,
  standingOf,
  type LiveStanding,
  type LiveStrikeConsequence,
} from './live-strikes';
import { liveVisibleToViewerSql } from '../spaces/reader-spaces';
import { short } from './live-log';
import {
  isLiveKeySealingConfigured,
  LIVE_KEY_ENCRYPTION_SECRET_ENV,
  LiveKeyUnavailableError,
  openLiveKeyOr503,
  sealLiveKey,
  storedLiveKeyColumns,
  type StoredLiveKey,
} from './live-key-at-rest';

/** A live as its viewers read it: the key included (L2, Q4). */
export interface LiveView {
  id: string;
  broadcasterId: string;
  associationId: string | null;
  startedAt: Date;
  lastSegmentAt: Date | null;
  nextIndex: number;
  key: string;
}

/** A live in the list of open lives - no key: the key is read by opening it. */
export interface LiveListItem {
  id: string;
  broadcasterId: string;
  associationId: string | null;
  startedAt: Date;
}

/**
 * One segment of a manifest: `name` is its address, `GET /api/media/public/live/<liveId>/<name>` -
 * no token, answered by Canari's nginx cache (WP-L4, lives.md "Serving a segment").
 */
export interface LiveManifestSegment {
  index: number;
  name: string;
  bytes: number;
}

/** What a viewer polls. `serverNow` and `lastSegmentAt` are both the database's clock. */
export interface LiveManifest {
  liveId: string;
  nextIndex: number;
  lastSegmentAt: Date | null;
  serverNow: Date;
  segments: LiveManifestSegment[];
  /**
   * HOW MANY ACCOUNTS WATCH THIS LIVE - the seats it holds on the host's cap, the caller's own
   * included, the broadcaster never (it takes none). A COUNT ONLY: no response of this API names a
   * viewer, to anybody (lives.md, "The viewer count"). The owner decided viewers see the count
   * (2026-10-21), EXACT and not rounded - confirmed by the owner 2026-10-21. `null` only on the broadcaster's poll when the count did not answer ({@link LiveSeats.watching}).
   */
  viewers: number | null;
}

/** The answer to an ingest, and to its idempotent repeat. */
export interface LiveIngestResult {
  index: number;
  name: string;
  nextIndex: number;
}

/** What the end of a live answers. */
export interface LiveEndResult {
  id: string;
  endedAt: Date;
  endReason: LiveEndReason;
}

/** What a staff cut answers (WP-L8), and its idempotent repeat. */
/** A `live_cuts` row as the live's own answers read it once the live row may be gone. */
export interface CutRecord {
  broadcasterId: string;
  reason: LiveCutReason;
  cutAt: Date;
  /** How the live ended - `cut` when the cut ended it, else its earlier end (never `erased`). */
  liveEndedAt: Date;
  liveEndReason: Exclude<LiveEndReason, 'erased'>;
  /** The cut's place on its broadcaster's ladder, fixed when it was recorded (migration 099). */
  strike: number;
}

/** The {@link CutRecord} columns, ONE list for every read of a cut. */
const CUT_COLUMNS = `"broadcasterId", reason, "cutAt", "liveEndedAt", "liveEndReason", strike`;

export interface LiveCutResult {
  liveId: string;
  broadcasterId: string;
  reason: LiveCutReason;
  cutAt: Date;
  /** The live's end: `cut` when the cut ended it, the earlier reason when it had already ended. */
  endReason: LiveEndReason;
  /** False on a repeat: the live was cut before, and nothing changed. */
  newlyCut: boolean;
  /** The broadcaster's OTHER cuts on record (the rolling `LIVE_STRIKE_WINDOW_MS`). */
  priorCuts: number;
  /** This cut's place on the broadcaster's ladder: 1 + `priorCuts` when it was recorded. */
  strike: number;
  /** What it did to the broadcaster: `warning` (strike 1) or `suspended` (strike 2 and later). */
  consequence: LiveStrikeConsequence;
  /** The broadcaster's standing after it - the suspension's end, a withdrawal due. */
  standing: LiveStanding;
}

/** A member's standing with the first-live rules (L11): what the pre-live screen asks. */
export interface LiveRulesStatus {
  /** The version a start requires today ({@link LIVE_RULES_VERSION}). */
  version: number;
  /** The version the member accepted, or null if never. */
  acceptedVersion: number | null;
  acceptedAt: Date | null;
}

/** The outcome of deleting an ended live's segments and row. */
export type LivePurgeOutcome = 'deleted' | 'kept';

/** What one pass of the orphan reaper did ({@link LivesService.reapOrphans}). */
export interface LiveOrphanReport {
  /** `live/<id>/` folders with no live row behind them, emptied and proven empty. */
  reaped: number;
  /** Orphan folders the store refused to empty, left for the next run. */
  kept: number;
}

/** What the reservation step decided: answer a repeat, report an end, or go on to the store. */
type IngestStep =
  | { kind: 'repeat'; result: LiveIngestResult }
  | { kind: 'ended'; endedAt: Date | null; endReason: LiveEndReason }
  | { kind: 'reserved'; name: string };

/** What the confirm step decided: the segment was recorded, or the live had ended meanwhile. */
type ConfirmOutcome =
  | { kind: 'stored'; result: LiveIngestResult; claimed: ClaimedLive | null }
  | { kind: 'ended'; endedAt: Date | null; endReason: LiveEndReason | null };

/** The columns every access decision reads, and the stored key, opened only by `openLiveKey`. */
interface LiveRow extends StoredLiveKey {
  id: string;
  broadcasterId: string;
  associationId: string | null;
  startedAt: Date;
  lastSegmentAt: Date | null;
  nextIndex: number;
  endedAt: Date | null;
  endReason: LiveEndReason | null;
}

const LIVE_COLUMNS = `id, "broadcasterId", "associationId", ${storedLiveKeyColumns()}, "startedAt",
  "lastSegmentAt", "nextIndex", "endedAt", "endReason"`;

/** How many plaintext keys one query of the backfill takes; it loops until none is left. */
const PLAINTEXT_KEY_BATCH = 100;

/** An association id: a uuid, checked before it reaches a `uuid` column (a 500 otherwise). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Short form of an account id for a log line. */

/**
 * The live row, its key, its removed viewers and its segments (WP-L2, WP-L3;
 * docs/wiki/services/lives.md).
 *
 * EVERY WRITE TO A LIVE TAKES ITS ROW LOCK, so the three things that change a live - a segment, an
 * end, a removal - are serialised by PostgreSQL rather than reconciled afterwards. NO LOCK, AND NO
 * POOLED CONNECTION, IS HELD ACROSS THE CALL TO MEDIA-SERVICE: an ingest RESERVES its index in one
 * short committed transaction (`pendingName`), stores with no transaction open, and CONFIRMS in a
 * second short one. The reservation is what orders the rest:
 *
 * - only one ingest of an index stores at a time (another is a 409 `LIVE_SEGMENT_IN_PROGRESS`);
 * - an end commits at once, and the CONFIRM that follows it records nothing and answers 410;
 * - the PURGE leaves a live alone while its reservation is set, and no reservation can be taken
 *   once the end has committed, so the store it waits for is the last one that can ever land.
 *
 * So no segment is recorded after its live's end, and none is stored after its purge - except a
 * write that outlives the store's own timeout, which the orphan reaper takes.
 */
/**
 * The key and the manifest of a live: the one read a platform admin may make of a review account's
 * live, by its id, to judge a report (`liveVisibleToUserSql`'s `adminSeesCohort`). Never a write.
 */
const WATCH_ONLY = { adminSeesCohort: true } as const;

@Injectable()
export class LivesService implements OnModuleDestroy {
  private readonly logger = new Logger(LivesService.name);
  /** Segment ingests running in this instance, bounded by {@link LIVE_INGEST_MAX_CONCURRENT}. */
  private ingestsInFlight = 0;
  /** Announcements started after a segment 0's commit and not yet settled (WP-L7). */
  private readonly announcements = new Set<Promise<void>>();

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(LIVE_SEGMENT_STORE) private readonly store: LiveSegmentStore,
    private readonly associations: AssociationsService,
    private readonly moderation: ModerationService,
    private readonly seats: LiveSeats,
    private readonly announcer: LiveAnnouncer,
    private readonly notifications: PostNotificationsService
  ) {}

  /**
   * Starts a live. Any member may (L1), unless muted; broadcasting AS an association needs
   * `POST_AS_ASSO` there, as a post does. The key is generated by the broadcaster's client - the
   * client generates every content key - and only its shape is checked here.
   *
   * THE FIRST-LIVE RULES (L11): the member must have accepted {@link LIVE_RULES_VERSION}. The client
   * sends `acceptedRulesVersion` when the member tapped Start on the screen showing them, and this
   * call records it ({@link assertRulesAccepted}); without it, an earlier acceptance of the current
   * version must be on record, or the start is 403 `LIVE_RULES_NOT_ACCEPTED`.
   */
  async start(
    broadcasterId: string,
    input: { key?: unknown; associationId?: unknown; acceptedRulesVersion?: unknown }
  ): Promise<LiveView> {
    this.logger.debug(`[LIVE] start asked by ${short(broadcasterId)}`);
    if (typeof input.key !== 'string' || !LIVE_KEY_HEX_RE.test(input.key)) {
      throw new BadRequestException({ code: 'LIVE_KEY_INVALID' });
    }
    const key = input.key;
    // Refused BEFORE anything is written: a live whose key cannot be sealed is never stored.
    if (!isLiveKeySealingConfigured()) {
      this.logger.error(
        `[LIVE] start refused for ${short(broadcasterId)}: ${LIVE_KEY_ENCRYPTION_SECRET_ENV} is unset or shorter than 32 characters`
      );
      throw new ServiceUnavailableException({ code: 'LIVE_KEY_SEALING_UNAVAILABLE' });
    }
    const raw = input.associationId ?? null;
    const associationId = typeof raw === 'string' && UUID_RE.test(raw) ? raw : null;
    if (raw !== null && associationId === null) {
      throw new BadRequestException({ code: 'LIVE_ASSOCIATION_INVALID' });
    }
    if (await this.moderation.isUserMuted(broadcasterId)) {
      this.logger.debug(`[LIVE] start refused: ${short(broadcasterId)} is muted`);
      throw new ForbiddenException({ code: 'LIVE_MUTED' });
    }
    if (
      associationId !== null &&
      !(await this.associations.mayAct(
        broadcasterId,
        associationId,
        AssociationPermissionFlag.POST_AS_ASSO
      ))
    ) {
      this.logger.debug(
        `[LIVE] start refused: ${short(broadcasterId)} may not speak for ${short(associationId)}`
      );
      throw new ForbiddenException({ code: 'LIVE_ASSOCIATION_FORBIDDEN' });
    }
    await this.assertRulesAccepted(broadcasterId, input.acceptedRulesVersion);
    let row: LiveRow;
    try {
      row = await this.db.transaction(async (tx) => {
        // THE STRIKE LADDER (WP-L8b): a withdrawn or suspended right refuses the start. Read under
        // the account's standing lock, the one a cut takes before it counts, so a start never slips
        // between a cut's count and its commit.
        await lockStanding(tx, broadcasterId);
        const standing = await standingOf(tx, broadcasterId);
        if (standing.withdrawnAt) {
          this.logger.log(`[LIVE] start refused: ${short(broadcasterId)}'s right was withdrawn`);
          throw new ForbiddenException({ code: 'LIVE_BROADCAST_WITHDRAWN' });
        }
        if (standing.suspendedUntil) {
          this.logger.log(
            `[LIVE] start refused: ${short(broadcasterId)} is suspended until ${standing.suspendedUntil.toISOString()}`
          );
          throw new ForbiddenException({
            code: 'LIVE_BROADCAST_SUSPENDED',
            suspendedUntil: standing.suspendedUntil,
          });
        }
        // The rolling hour of starts, from rows that outlive their live (`live_starts`). Two starts
        // racing both read the same count, and the one-open-live index lets one of them through.
        const [{ recent }]: { recent: number }[] = await tx.query(
          `SELECT count(*)::int AS recent FROM live_starts
            WHERE "broadcasterId" = $1 AND "startedAt" + $2 * interval '1 millisecond' > now()`,
          [broadcasterId, LIVE_START_WINDOW_MS]
        );
        if (recent >= LIVE_STARTS_PER_HOUR) {
          this.logger.warn(
            `[LIVE] start refused: ${short(broadcasterId)} started ${recent} lives in the hour`
          );
          throw new HttpException(
            { code: 'LIVE_START_RATE', limit: LIVE_STARTS_PER_HOUR },
            HttpStatus.TOO_MANY_REQUESTS
          );
        }
        // The id is chosen here, not by the column default: the seal is bound to it.
        const id = randomUUID();
        const sealed = sealLiveKey(id, key);
        const rows: LiveRow[] = await tx.query(
          `INSERT INTO lives (id, "broadcasterId", "associationId", "liveKeyCiphertext", "liveKeyVersion")
           VALUES ($1, $2, $3, $4, $5) RETURNING ${LIVE_COLUMNS}`,
          [id, broadcasterId, associationId, sealed.liveKeyCiphertext, sealed.liveKeyVersion]
        );
        await tx.query(`INSERT INTO live_starts ("broadcasterId") VALUES ($1)`, [broadcasterId]);
        return rows[0];
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        this.logger.debug(`[LIVE] start refused: ${short(broadcasterId)} already has an open live`);
        throw new ConflictException({ code: 'LIVE_ALREADY_OPEN' });
      }
      throw e;
    }
    this.logger.log(`[LIVE] ${row.id} started by ${short(broadcasterId)}`);
    // The broadcaster's own key, just sealed: answered as received, nothing to open.
    return toView(row, key);
  }

  /**
   * The first-live rules (L11), checked or recorded before a start:
   *
   * - `accepted` absent: the member's recorded acceptance must be at least {@link LIVE_RULES_VERSION};
   * - `accepted` equal to it: the acceptance is RECORDED (raised, never lowered) - the member tapped
   *   Start on the screen showing these rules. Recorded even if the start is refused afterwards
   *   (rate, an open live): the acceptance happened, whatever became of the start;
   * - any other value: refused - a client showing older rules has not shown these.
   *
   * Refused with 403 `LIVE_RULES_NOT_ACCEPTED` and the `rulesVersion` the client must show.
   */
  private async assertRulesAccepted(userId: string, accepted: unknown): Promise<void> {
    if (accepted === LIVE_RULES_VERSION) {
      await this.db.query(
        `INSERT INTO live_rules_acceptances ("userId", "rulesVersion", "acceptedAt")
         VALUES ($1, $2, now())
         ON CONFLICT ("userId") DO UPDATE
           SET "rulesVersion" = EXCLUDED."rulesVersion", "acceptedAt" = EXCLUDED."acceptedAt"
           WHERE live_rules_acceptances."rulesVersion" < EXCLUDED."rulesVersion"`,
        [userId, LIVE_RULES_VERSION]
      );
      this.logger.debug(`[LIVE] ${short(userId)} accepted the live rules v${LIVE_RULES_VERSION}`);
      return;
    }
    if (accepted === undefined || accepted === null) {
      const { acceptedVersion } = await this.rulesStatus(userId);
      if (acceptedVersion !== null && acceptedVersion >= LIVE_RULES_VERSION) return;
    }
    this.logger.debug(
      `[LIVE] start refused: ${short(userId)} has not accepted the live rules v${LIVE_RULES_VERSION}`
    );
    throw new ForbiddenException({
      code: 'LIVE_RULES_NOT_ACCEPTED',
      rulesVersion: LIVE_RULES_VERSION,
    });
  }

  /** The member's standing with the first-live rules: the version required, the one accepted. */
  async rulesStatus(userId: string): Promise<LiveRulesStatus> {
    const rows: { rulesVersion: number; acceptedAt: Date }[] = await this.db.query(
      `SELECT "rulesVersion", "acceptedAt" FROM live_rules_acceptances WHERE "userId" = $1`,
      [userId]
    );
    return {
      version: LIVE_RULES_VERSION,
      acceptedVersion: rows[0]?.rulesVersion ?? null,
      acceptedAt: rows[0]?.acceptedAt ?? null,
    };
  }

  /**
   * The open lives the viewer may watch: not ended, visible to them as a post of the same broadcaster
   * would be (`liveVisibleToViewerSql`), not blocked either way, not removed from.
   */
  async listOpen(viewerId: string): Promise<LiveListItem[]> {
    const blocked = await blockedUserIdsFor(this.db.manager, viewerId);
    const rows: LiveListItem[] = await this.db.query(
      `SELECT l.id, l."broadcasterId", l."associationId", l."startedAt"
         FROM lives l
        WHERE l."endedAt" IS NULL
          AND ${liveVisibleToViewerSql('l', '$1')}
          AND l."broadcasterId" <> ALL($2::varchar[])
          AND NOT EXISTS (SELECT 1 FROM live_removed_viewers r
                           WHERE r."liveId" = l.id AND r."viewerId" = $1)
        ORDER BY l."startedAt" DESC
        LIMIT 50`,
      [viewerId, blocked]
    );
    return rows;
  }

  /** One live and its key, to a viewer allowed to watch it ({@link assertMayWatch}). */
  async get(viewerId: string, liveId: string): Promise<LiveView> {
    const row = await this.assertMayWatch(this.db.manager, viewerId, liveId, WATCH_ONLY);
    // Opened before the seat is taken: a key that cannot be read (503) seats nobody.
    const key = openLiveKeyOr503(row.id, row);
    await this.takeSeat(row, viewerId);
    return toView(row, key);
  }

  /**
   * The manifest a viewer polls: the newest {@link LIVE_MANIFEST_WINDOW} segments, or the ones from
   * `from` on. Refused exactly as the key is - a removed viewer learns no new segment name - and
   * 410 from the moment the live has ended: the manifest stops at `endedAt`.
   */
  async manifest(viewerId: string, liveId: string, from?: number): Promise<LiveManifest> {
    const row = await this.assertMayWatch(this.db.manager, viewerId, liveId, WATCH_ONLY);
    const viewers = await this.viewerCount(row, viewerId, await this.takeSeat(row, viewerId));
    const start = from ?? Math.max(0, row.nextIndex - LIVE_MANIFEST_WINDOW);
    const segments: LiveManifestSegment[] = await this.db.query(
      `SELECT s."index", s.name, s.bytes
         FROM live_segments s
        WHERE s."liveId" = $1 AND s."index" >= $2
        ORDER BY s."index" ASC
        LIMIT $3`,
      [liveId, start, LIVE_MANIFEST_WINDOW]
    );
    return {
      liveId,
      nextIndex: row.nextIndex,
      lastSegmentAt: row.lastSegmentAt,
      serverNow: row.serverNow,
      segments,
      viewers,
    };
  }

  /**
   * Takes segment `index` of a live from its broadcaster.
   *
   * - `index === nextIndex`: stored under a fresh random name, counted, `lastSegmentAt` written.
   * - `index < nextIndex`: a repeat. The same bytes answer as the first time did (a lost answer
   *   retried); different bytes are a 409, never a replacement.
   * - `index > nextIndex`: out of order, 409 - the manifest is a gapless sequence.
   * - `nextIndex` reserved by an ingest still storing: 409 `LIVE_SEGMENT_IN_PROGRESS`.
   * - past the live's rate (`LIVE_SEGMENT_BURST`): 429 `LIVE_SEGMENT_TOO_FAST`;
   *   {@link LIVE_INGEST_MAX_CONCURRENT} ingests already running here: 503 `LIVE_INGEST_BUSY`.
   *
   * A live has no duration cap and no total byte budget (owner, 2026-10-31); the 4 MiB segment cap
   * and the rate above bound what it can take. After `endedAt`, 410. The
   * three steps - reserve, store, confirm - are in the class comment.
   */
  async ingest(
    broadcasterId: string,
    liveId: string,
    index: number,
    data: Buffer
  ): Promise<LiveIngestResult> {
    if (this.ingestsInFlight >= LIVE_INGEST_MAX_CONCURRENT) {
      // A signal, not a path: it means media-service is slow enough for ingests to pile up.
      this.logger.warn(
        `[LIVE] segment ${index} of ${liveId} refused: ${this.ingestsInFlight} ingests already storing`
      );
      throw new ServiceUnavailableException({ code: 'LIVE_INGEST_BUSY' });
    }
    this.ingestsInFlight += 1;
    try {
      return await this.ingestOnce(broadcasterId, liveId, index, data);
    } finally {
      this.ingestsInFlight -= 1;
    }
  }

  private async ingestOnce(
    broadcasterId: string,
    liveId: string,
    index: number,
    data: Buffer
  ): Promise<LiveIngestResult> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const step = await this.reserve(broadcasterId, liveId, index, sha256);
    if (step.kind === 'repeat') return step.result;
    if (step.kind === 'ended') throw liveEnded(step.endedAt, step.endReason);

    // NO TRANSACTION IS OPEN HERE: the reservation committed, and the store may take its time.
    try {
      await this.store.store(liveId, step.name, data);
    } catch (e) {
      this.logger.warn(
        `[LIVE] segment ${index} of ${liveId} not stored, reservation released: ${causeOf(e)}`
      );
      await this.release(liveId, step.name);
      throw new ServiceUnavailableException({ code: 'LIVE_STORE_UNAVAILABLE' });
    }

    const outcome = await this.confirm(liveId, index, step.name, data.length, sha256);
    if (outcome.kind === 'ended') {
      // The live ended while this segment was storing: nothing was recorded, and this was the store
      // its purge was waiting for - so the purge runs now rather than at the next sweep.
      await this.purgeBestEffort(liveId, 'after an ingest that met the end');
      throw liveEnded(outcome.endedAt, outcome.endReason);
    }
    // Segment 0 claimed the live's announcement in its own commit (WP-L7): the push goes after that
    // commit, NOT AWAITED - segment 0's answer and this ingest's slot do not wait for the audience
    // query and the fan-out. Once per live still holds: the claim is the commit, not this call.
    if (outcome.claimed) this.announceInBackground(liveId, outcome.claimed);
    await this.trim(liveId);
    return outcome.result;
  }

  /**
   * THE TRIM: a running live keeps only its newest {@link LIVE_RETAINED_SEGMENTS} segments, so what
   * it stores never depends on how long it lasts (owner, 2026-10-31). Run after each confirmed
   * segment.
   *
   * IDEMPOTENT FROM DURABLE STATE, NOT FROM A CLOCK: the segments to trim are the `live_segments`
   * rows with `index < nextIndex - retained`, and a row is deleted only AFTER the store proved its
   * object gone. A crash between the store's delete and the row's, a refused delete or a media
   * outage leave the row, so the next pass finds it again (an absent object deletes without error).
   * `storedBytes` falls by exactly the bytes of the rows deleted, inside the same transaction.
   *
   * BEST EFFORT FOR THE INGEST: a failure is logged at `warn` and never fails the segment that was
   * just stored - the end's purge deletes the whole prefix whatever this left, so correctness never
   * rests on this pass; only the bound does, and it is re-asked by every segment.
   */
  private async trim(liveId: string): Promise<void> {
    try {
      const rows: { index: number; name: string }[] = await this.db.query(
        `SELECT s."index", s.name
           FROM live_segments s JOIN lives l ON l.id = s."liveId"
          WHERE s."liveId" = $1 AND s."index" < l."nextIndex" - $2
          ORDER BY s."index" ASC LIMIT $3`,
        [liveId, LIVE_RETAINED_SEGMENTS, LIVE_TRIM_BATCH]
      );
      if (rows.length === 0) return;
      const answer = await this.store.deleteSegments(
        liveId,
        rows.map((r) => r.name)
      );
      const gone = new Set(answer.deleted);
      const indexes = rows.filter((r) => gone.has(r.name)).map((r) => r.index);
      if (answer.failed.length > 0) {
        this.logger.warn(
          `[LIVE_TRIM] ${liveId}: the store refused ${answer.failed.length} of ${rows.length} segment(s) - asked again by the next segment`
        );
      }
      if (indexes.length === 0) return;
      const freed = await this.db.transaction(async (tx): Promise<number> => {
        const [deleted] = (await tx.query(
          `DELETE FROM live_segments WHERE "liveId" = $1 AND "index" = ANY($2::int[]) RETURNING bytes`,
          [liveId, indexes]
        )) as [{ bytes: number }[], number];
        const bytes = deleted.reduce((sum, r) => sum + Number(r.bytes), 0);
        if (bytes > 0) {
          await tx.query(
            `UPDATE lives SET "storedBytes" = GREATEST(0, "storedBytes" - $2::bigint) WHERE id = $1`,
            [liveId, bytes]
          );
        }
        return bytes;
      });
      this.logger.log(
        `[LIVE_TRIM] ${liveId}: trimmed ${indexes.length} segment(s) behind the window (${indexes[0]}..${indexes[indexes.length - 1]}), ${freed} B`
      );
    } catch (e) {
      this.logger.warn(
        `[LIVE_TRIM] ${liveId}: the trim failed, asked again by the next segment: ${causeOf(e)}`
      );
    }
  }

  /**
   * Starts a claimed live's announcement and tracks it until it settles. `announce` logs its own
   * failures and never throws; a rejection reaching here would be a defect in it, so it is logged at
   * error rather than swallowed - and it never reaches the segment.
   */
  private announceInBackground(liveId: string, claimed: ClaimedLive): void {
    const pending = this.announcer
      .announce(liveId, claimed)
      .then(() => undefined)
      .catch((e: unknown) => {
        this.logger.error(`[LIVE_ANNOUNCE] ${liveId} announce threw: ${causeOf(e)}`);
      })
      .finally(() => this.announcements.delete(pending));
    this.announcements.add(pending);
  }

  /**
   * Resolves once every announcement started so far has settled - a PROOF of completion, for a
   * shutdown and for the tests that read the push, never a delay.
   */
  async announcementsSettled(): Promise<void> {
    while (this.announcements.size > 0) await Promise.all(this.announcements);
  }

  /** Waits for the announcements in flight before the module goes away. */
  async onModuleDestroy(): Promise<void> {
    await this.announcementsSettled();
  }

  /**
   * Step one of an ingest, ONE SHORT TRANSACTION: every check under the row lock, then the
   * reservation of `nextIndex` (`pendingName`, `pendingSha256`, `pendingAt`), committed before the
   * store is called. A reservation older than {@link LIVE_RESERVATION_TTL_MS} is one whose ingest
   * cannot still be waiting on its store (a crash, a lost release): it is taken over, with a warn.
   */
  private async reserve(
    broadcasterId: string,
    liveId: string,
    index: number,
    sha256: string
  ): Promise<IngestStep> {
    return this.db.transaction(async (tx): Promise<IngestStep> => {
      const rows: (LiveRow & {
        pendingName: string | null;
        reservationLive: boolean | null;
        allowance: number;
      })[] = await tx.query(
        `SELECT ${LIVE_COLUMNS}, "pendingName",
                "pendingAt" + $2 * interval '1 millisecond' > now() AS "reservationLive",
                ($3::int + floor(extract(epoch FROM now() - "startedAt") * 1000 / $4::int))::int
                  AS "allowance"
           FROM lives WHERE id = $1 FOR UPDATE`,
        [liveId, LIVE_RESERVATION_TTL_MS, LIVE_SEGMENT_BURST, LIVE_SEGMENT_MIN_DURATION_MS]
      );
      const row = rows[0];
      if (!row) {
        // A live STAFF CUT and already purged: its broadcaster is told why, as before the purge.
        await this.refuseIfCut(tx, liveId, broadcasterId, 'broadcaster');
        throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
      }
      if (row.broadcasterId !== broadcasterId) {
        this.logger.debug(`[LIVE] segment refused: ${short(broadcasterId)} is not ${liveId}'s`);
        // The same 404 as a live that does not exist: a write route is no oracle for one that does.
        throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
      }
      if (row.endedAt) {
        this.logger.debug(`[LIVE] segment ${index} refused: ${liveId} ended (${row.endReason})`);
        throw liveEnded(row.endedAt, row.endReason);
      }
      if (index < row.nextIndex) {
        const prior: { name: string; sha256: string }[] = await tx.query(
          `SELECT name, sha256 FROM live_segments WHERE "liveId" = $1 AND "index" = $2`,
          [liveId, index]
        );
        if (prior[0]?.sha256 === sha256) {
          this.logger.debug(`[LIVE] segment ${index} of ${liveId} repeated, same bytes`);
          return {
            kind: 'repeat',
            result: { index, name: prior[0].name, nextIndex: row.nextIndex },
          };
        }
        this.logger.warn(`[LIVE] segment ${index} of ${liveId} repeated with DIFFERENT bytes`);
        throw new ConflictException({ code: 'LIVE_SEGMENT_CONFLICT', nextIndex: row.nextIndex });
      }
      if (index > row.nextIndex) {
        this.logger.debug(
          `[LIVE] segment ${index} of ${liveId} out of order (expected ${row.nextIndex})`
        );
        throw new ConflictException({
          code: 'LIVE_SEGMENT_OUT_OF_ORDER',
          nextIndex: row.nextIndex,
        });
      }
      if (row.pendingName !== null) {
        if (row.reservationLive) {
          this.logger.debug(`[LIVE] segment ${index} of ${liveId} is already being stored`);
          throw new ConflictException({
            code: 'LIVE_SEGMENT_IN_PROGRESS',
            nextIndex: row.nextIndex,
          });
        }
        this.logger.warn(
          `[LIVE] segment ${index} of ${liveId}: an abandoned reservation (${row.pendingName}) is taken over`
        );
      }
      if (index >= row.allowance) {
        this.logger.warn(
          `[LIVE] segment ${index} of ${liveId} refused: faster than the live's age allows (${row.allowance})`
        );
        throw new HttpException(
          { code: 'LIVE_SEGMENT_TOO_FAST', nextIndex: row.nextIndex },
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
      const name = randomUUID();
      await tx.query(
        `UPDATE lives SET "pendingName" = $2, "pendingSha256" = $3, "pendingAt" = now()
          WHERE id = $1`,
        [liveId, name, sha256]
      );
      this.logger.debug(`[LIVE] segment ${index} of ${liveId} reserved as ${name}`);
      return { kind: 'reserved', name };
    });
  }

  /**
   * Step three of an ingest, ONE SHORT TRANSACTION: under the row lock, record the segment and clear
   * the reservation - unless the live ended meanwhile (the reservation is cleared, nothing recorded,
   * `'ended'`) or the reservation is no longer this ingest's (taken over as abandoned: 409).
   *
   * Segment 0 also CLAIMS the live's announcement (`announcedAt`, WP-L7) in this same transaction:
   * the first frame and the claim are one commit, so the announcement is decided by durable state and
   * by no second path. `claimed` is set only for the call that wrote the stamp.
   */
  private async confirm(
    liveId: string,
    index: number,
    name: string,
    bytes: number,
    sha256: string
  ): Promise<ConfirmOutcome> {
    return this.db.transaction(async (tx): Promise<ConfirmOutcome> => {
      const rows: {
        endedAt: Date | null;
        endReason: LiveEndReason | null;
        pendingName: string | null;
        nextIndex: number;
      }[] = await tx.query(
        `SELECT "endedAt", "endReason", "pendingName", "nextIndex" FROM lives WHERE id = $1 FOR UPDATE`,
        [liveId]
      );
      const row = rows[0];
      if (!row) {
        this.logger.warn(`[LIVE] segment ${index} of ${liveId} stored after its live was deleted`);
        const cut = await this.cutOf(tx, liveId);
        return {
          kind: 'ended',
          endedAt: cut?.cutAt ?? null,
          endReason: cut ? 'cut' : null,
        };
      }
      if (row.endedAt) {
        await tx.query(
          `UPDATE lives SET "pendingName" = NULL, "pendingSha256" = NULL, "pendingAt" = NULL
            WHERE id = $1 AND "pendingName" = $2`,
          [liveId, name]
        );
        this.logger.debug(`[LIVE] segment ${index} of ${liveId} stored, but the live has ended`);
        return { kind: 'ended', endedAt: row.endedAt, endReason: row.endReason };
      }
      if (row.pendingName !== name || row.nextIndex !== index) {
        this.logger.warn(
          `[LIVE] segment ${index} of ${liveId}: its reservation was taken over, nothing recorded`
        );
        throw new ConflictException({
          code: 'LIVE_SEGMENT_RESERVATION_LOST',
          nextIndex: row.nextIndex,
        });
      }
      await tx.query(
        `INSERT INTO live_segments ("liveId", "index", name, bytes, sha256)
         VALUES ($1, $2, $3, $4, $5)`,
        [liveId, index, name, bytes, sha256]
      );
      await tx.query(
        `UPDATE lives SET "nextIndex" = "nextIndex" + 1, "lastSegmentAt" = now(),
                "storedBytes" = "storedBytes" + $2,
                "pendingName" = NULL, "pendingSha256" = NULL, "pendingAt" = NULL
          WHERE id = $1`,
        [liveId, bytes]
      );
      this.logger.debug(`[LIVE] segment ${index} of ${liveId} stored (${bytes} B)`);
      let claimed: ClaimedLive | null = null;
      if (index === 0) {
        const [stamped] = (await tx.query(
          `UPDATE lives SET "announcedAt" = now()
            WHERE id = $1 AND "announcedAt" IS NULL
            RETURNING "broadcasterId", "associationId"`,
          [liveId]
        )) as [ClaimedLive[], number];
        claimed = stamped[0] ?? null;
        this.logger.debug(
          `[LIVE] ${liveId} ${claimed ? 'claimed for its announcement' : 'already announced'}`
        );
      }
      return { kind: 'stored', result: { index, name, nextIndex: index + 1 }, claimed };
    });
  }

  /**
   * Clears a reservation whose store failed, so the same index is accepted at once. Only THIS
   * ingest's (`pendingName`). A failure here is logged and left to the reservation's age.
   */
  private async release(liveId: string, name: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE lives SET "pendingName" = NULL, "pendingSha256" = NULL, "pendingAt" = NULL
          WHERE id = $1 AND "pendingName" = $2`,
        [liveId, name]
      );
    } catch (e) {
      this.logger.warn(
        `[LIVE] ${liveId}: reservation ${name} not released, it expires with its age: ${causeOf(e)}`
      );
    }
  }

  /** {@link purgeEnded}, logged rather than thrown - the sweep finishes what this does not. */
  private async purgeBestEffort(liveId: string, when: string): Promise<void> {
    try {
      await this.purgeEnded(liveId);
    } catch (e) {
      this.logger.warn(`[LIVE] ${liveId}: purge ${when} failed, the sweep retries: ${causeOf(e)}`);
    }
  }

  /**
   * Ends a live, by its broadcaster. Idempotent WHILE THE ROW EXISTS: an ended live answers its end
   * again. The segments and the row are deleted at once (L3) - a viewer still seated (owed the
   * segments its last manifest named), a store that refuses, or a segment still storing, leaves them
   * to the sweep ({@link purgeEnded}) - and once the row is gone a repeated end is a
   * 404 `LIVE_NOT_FOUND`, which the broadcaster's client reads as "ended and deleted": nothing keeps a
   * deleted live's end (no replay, L3), so there is nothing to answer it with.
   */
  async end(broadcasterId: string, liveId: string): Promise<LiveEndResult> {
    // An UPDATE ... RETURNING answers `[rows, affected]` through TypeORM's postgres driver.
    const [rows] = (await this.db.query(
      `UPDATE lives SET "endedAt" = now(), "endReason" = 'broadcaster'
        WHERE id = $1 AND "broadcasterId" = $2 AND "endedAt" IS NULL
        RETURNING id, "endedAt", "endReason"`,
      [liveId, broadcasterId]
    )) as [{ id: string; endedAt: Date; endReason: LiveEndReason }[], number];
    let ended = rows[0];
    if (!ended) {
      const current: LiveRow[] = await this.db.query(
        `SELECT ${LIVE_COLUMNS} FROM lives WHERE id = $1`,
        [liveId]
      );
      const row = current[0];
      if (!row) {
        // A live STAFF CUT and purged keeps its cut (`live_cuts`): its broadcaster's end is answered
        // with it, so the screen says why rather than "ended and deleted".
        const cut = await this.cutOf(this.db.manager, liveId);
        if (cut && cut.broadcasterId === broadcasterId) {
          this.logger.debug(`[LIVE] end of ${liveId} answered from its cut (${cut.liveEndReason})`);
          return { id: liveId, endedAt: cut.liveEndedAt, endReason: cut.liveEndReason };
        }
        throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
      }
      if (row.broadcasterId !== broadcasterId) {
        this.logger.debug(`[LIVE] end refused: ${short(broadcasterId)} is not ${liveId}'s`);
        throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
      }
      // Ended already (by an earlier call, the sweep, an erasure): the same fact, answered again.
      ended = { id: row.id, endedAt: row.endedAt!, endReason: row.endReason! };
      this.logger.debug(`[LIVE] end of ${liveId} repeated (${row.endReason})`);
    } else {
      this.logger.log(`[LIVE] ${liveId} ended by its broadcaster`);
    }
    await this.purgeBestEffort(liveId, 'at end');
    return ended;
  }

  /**
   * Removes a viewer from a live, by its broadcaster (L6). Idempotent. The broadcaster cannot remove
   * themselves, and an ended live has nobody left to remove.
   */
  async removeViewer(
    broadcasterId: string,
    liveId: string,
    viewerId: unknown
  ): Promise<{ liveId: string; viewerId: string }> {
    if (typeof viewerId !== 'string' || viewerId.trim() === '' || viewerId.length > 255) {
      throw new BadRequestException({ code: 'LIVE_VIEWER_INVALID' });
    }
    const viewer = viewerId.trim().toLowerCase();
    if (viewer === broadcasterId) throw new BadRequestException({ code: 'LIVE_VIEWER_IS_SELF' });
    await this.db.transaction(async (tx) => {
      const rows: LiveRow[] = await tx.query(
        `SELECT ${LIVE_COLUMNS} FROM lives WHERE id = $1 FOR UPDATE`,
        [liveId]
      );
      const row = rows[0];
      if (!row) throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
      if (row.broadcasterId !== broadcasterId) {
        this.logger.debug(`[LIVE] removal refused: ${short(broadcasterId)} is not ${liveId}'s`);
        throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
      }
      if (row.endedAt) throw liveEnded(row.endedAt, row.endReason);
      await tx.query(
        `INSERT INTO live_removed_viewers ("liveId", "viewerId") VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [liveId, viewer]
      );
    });
    this.logger.log(`[LIVE] ${liveId}: viewer ${short(viewer)} removed by the broadcaster`);
    // The removal is the row above; the seat is freed now rather than when its lease lapses, and a
    // failure here only means it lapses (the removed viewer's next poll is refused 403 anyway).
    await this.seats.release(liveId, viewer).catch((e: unknown) => {
      this.logger.warn(
        `[LIVE_SEAT] ${liveId}: removed viewer's seat left to its lease: ${String(e)}`
      );
    });
    return { liveId, viewerId: viewer };
  }

  /**
   * THE STAFF CUT (WP-L8, D6): the live equivalent of a moderator deleting a post. The caller's
   * moderator standing is checked by the controller (`isContentModerator`, the posts predicate).
   *
   * ONE TRANSACTION, under the live's row lock - the lock every segment, end and removal takes, so a
   * cut is ordered against them by PostgreSQL rather than reconciled afterwards:
   *
   * 1. the cut is RECORDED in `live_cuts` (once per live: a repeat answers the first cut);
   * 2. an OPEN live is ENDED with `endReason = 'cut'` - from then on its key and manifest answer
   *    `410 LIVE_ENDED` with `endReason: 'cut'`, its broadcaster's next segment too, and it leaves
   *    `GET /api/lives`; a live already ended KEEPS its reason, before the purge and after it (the
   *    cut row copies it) - the cut is still recorded, so a broadcaster ending their live as the
   *    moderator presses does not escape the record, nor the ladder;
   * 3. its STRIKE is fixed on the row (WP-L8b): 1 + the broadcaster's other cuts on record, counted
   *    under the account's standing lock (`live-strikes.ts`), taken BEFORE the row lock as a start
   *    takes it. Strike 1 is the warning, strike 2 and later suspend the right to broadcast for
   *    `LIVE_SUSPENSION_MS`; from `LIVE_WITHDRAWAL_FROM_CUTS` cuts on record the answer says a
   *    withdrawal is due - staff decide it ({@link withdraw}), the code never does;
   * 4. every PENDING report on the LIVE is marked `reviewed` by this moderator - the report's own
   *    trail. A reported chat LINE of it is not: it is a report about its author, answered apart.
   *
   * After the commit: the purge (seats released, segments and row deleted - or left to the sweep
   * while a segment is storing, whose confirm then purges), and the broadcaster's in-app notice
   * ({@link notifyCut}: the warning or the suspension).
   *
   * 400 `LIVE_CUT_REASON_INVALID` / `LIVE_CUT_DETAILS_INVALID`; 404 `LIVE_NOT_FOUND` for a live with
   * no row and no cut (absent, or ended and already purged - nothing is left to cut); 410
   * `LIVE_ENDED` with `endReason: 'erased'` for a live whose broadcaster's account was erased (no
   * cut is recorded: the erased all share one id, which would pool them as one offender).
   */
  async cut(
    reviewerId: string,
    liveId: string,
    input: { reason?: unknown; details?: unknown }
  ): Promise<LiveCutResult> {
    this.logger.debug(`[LIVE_CUT] ${liveId} asked by ${short(reviewerId)}`);
    const { reason, details } = parseModerationNote(input);

    const result = await this.db.transaction(async (tx): Promise<LiveCutResult> => {
      // THE STANDING LOCK FIRST, the row lock second - the order a start takes them too, so the two
      // never wait on each other in a cycle. The broadcaster is read unlocked to name the lock: it
      // only ever changes to the erased tombstone, which the locked read below refuses anyway.
      const owner: { broadcasterId: string }[] = await tx.query(
        `SELECT "broadcasterId" FROM lives WHERE id = $1`,
        [liveId]
      );
      if (owner[0]) await lockStanding(tx, owner[0].broadcasterId);
      const rows: LiveRow[] = await tx.query(
        `SELECT ${LIVE_COLUMNS} FROM lives WHERE id = $1 FOR UPDATE`,
        [liveId]
      );
      const row = rows[0];
      if (!row) {
        const earlier = await this.cutOf(tx, liveId);
        if (!earlier) throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
        this.logger.debug(`[LIVE_CUT] ${liveId} was cut already (row purged)`);
        return {
          liveId,
          broadcasterId: earlier.broadcasterId,
          reason: earlier.reason,
          cutAt: earlier.cutAt,
          endReason: earlier.liveEndReason,
          newlyCut: false,
          priorCuts: await otherCutsOnRecord(tx, earlier.broadcasterId, liveId),
          strike: earlier.strike,
          consequence: consequenceOf(earlier.strike),
          standing: await standingOf(tx, earlier.broadcasterId),
        };
      }
      // AN ERASED BROADCASTER'S LIVE IS NOT CUT: every erased account shares DELETED_ACCOUNT, so a
      // cut recorded under it would pool every deleted member into ONE repeat offender. The erasure
      // already ended the live; the answer is the one a viewer gets.
      if (row.broadcasterId === DELETED_ACCOUNT || row.endReason === 'erased') {
        this.logger.log(`[LIVE_CUT] ${liveId} refused: its broadcaster's account was erased`);
        throw liveEnded(row.endedAt, row.endReason ?? 'erased');
      }
      // An OPEN live is ended by the cut; an ENDED one keeps its end - the cut records the decision
      // and rewrites nothing, so the answer before the purge and after it (from `live_cuts`) agree.
      let liveEndedAt = row.endedAt;
      let endReason = row.endReason as Exclude<LiveEndReason, 'erased'> | null;
      if (!liveEndedAt) {
        const [ended] = (await tx.query(
          `UPDATE lives SET "endedAt" = now(), "endReason" = 'cut'
            WHERE id = $1 AND "endedAt" IS NULL
            RETURNING "endedAt"`,
          [liveId]
        )) as [{ endedAt: Date }[], number];
        liveEndedAt = ended[0].endedAt;
        endReason = 'cut';
      }
      // THE STRIKE (WP-L8b): 1 + the broadcaster's other cuts on record, counted under the standing
      // lock and FIXED on the row - the ladder's durable state.
      const priorCuts = await otherCutsOnRecord(tx, row.broadcasterId, liveId);
      // An INSERT ... RETURNING answers its rows alone (an UPDATE answers `[rows, affected]`).
      const inserted: { cutAt: Date; strike: number }[] = await tx.query(
        `INSERT INTO live_cuts ("liveId", "broadcasterId", "associationId", "reviewerId", reason,
                                details, "liveStartedAt", "liveEndedAt", "liveEndReason", strike)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT ("liveId") DO NOTHING
         RETURNING "cutAt", strike`,
        [
          liveId,
          row.broadcasterId,
          row.associationId,
          reviewerId,
          reason,
          details,
          row.startedAt,
          liveEndedAt,
          endReason,
          priorCuts + 1,
        ]
      );
      const newlyCut = inserted.length > 0;
      const cut = newlyCut
        ? { reason: reason as LiveCutReason, cutAt: inserted[0].cutAt, strike: inserted[0].strike }
        : (await this.cutOf(tx, liveId))!;
      if (newlyCut) {
        // The report's own trail, as a moderator closing it by hand would leave it.
        await tx.query(
          `UPDATE content_reports SET status = 'reviewed', "reviewedBy" = $2, "reviewedAt" = now()
            WHERE "contentType" = 'live' AND "contentId" = $1 AND status = 'pending'`,
          [liveId, reviewerId]
        );
      }
      return {
        liveId,
        broadcasterId: row.broadcasterId,
        reason: cut.reason,
        cutAt: cut.cutAt,
        endReason: endReason!,
        newlyCut,
        priorCuts,
        strike: cut.strike,
        consequence: consequenceOf(cut.strike),
        standing: await standingOf(tx, row.broadcasterId),
      };
    });

    if (result.newlyCut) {
      this.logger.log(
        `[LIVE_CUT] ${liveId} cut by ${short(reviewerId)} reason=${result.reason} ` +
          `broadcaster=${short(result.broadcasterId)} end=${result.endReason} priorCuts=${result.priorCuts} ` +
          `strike=${result.strike} consequence=${result.consequence}` +
          (result.standing.withdrawalDue ? ' withdrawalDue' : '')
      );
      await this.notifyCut(result);
    }
    await this.purgeBestEffort(liveId, 'after a cut');
    return result;
  }

  /**
   * The broadcaster's in-app notice of a NEW cut, by its consequence on the ladder (WP-L8b):
   *
   * - `live_suspended` from strike 2 on - always, whether the cut ended the live or recorded the
   *   decision on a live already ended: a suspension the member is not told of is one they meet as
   *   a bare refusal. Its end is `GET /api/lives/standing`'s.
   * - `live_cut` at strike 1 (the WARNING) when the cut ended the live. A cut of a live its
   *   broadcaster had already ended is still strike 1 on record and is not notified: the notice says
   *   moderators stopped the live, which they did not.
   *
   * `text` the reason CODE (the client words it), no actor (`''`, as an anonymous post's notice:
   * which moderator cut is not the broadcaster's to read). AND A PUSH, through the same call
   * (`social_live_cut` / `social_live_suspended`, fixed sentences the device words), whose tap opens
   * the notifications list (`NOTIFICATIONS_TARGET`): the live is deleted, so there is no page of it
   * to open. The broadcaster's own screen is told at once anyway, by the 410 its next segment gets;
   * the push is for the broadcaster who already left it. Best-effort: the cut is already durable.
   */
  private async notifyCut(cut: LiveCutResult): Promise<void> {
    if (cut.broadcasterId === DELETED_ACCOUNT) return;
    const type =
      cut.consequence === 'suspended'
        ? 'live_suspended'
        : cut.endReason === 'cut'
          ? 'live_cut'
          : null;
    if (type === null) {
      this.logger.debug(`[LIVE_CUT] ${cut.liveId}: strike 1 on a live already ended - no notice`);
      return;
    }
    this.logger.debug(`[LIVE_CUT] ${cut.liveId}: ${type} notice and push to the broadcaster`);
    try {
      await this.notifications.createNotification({
        recipientId: cut.broadcasterId,
        type,
        postId: cut.liveId,
        actorId: '',
        actorName: '',
        text: cut.reason,
        pushData: { target: NOTIFICATIONS_TARGET },
      });
    } catch (e) {
      this.logger.warn(
        `[LIVE_CUT] ${cut.liveId}: the broadcaster's notice was not written: ${causeOf(e)}`
      );
    }
  }

  /**
   * The cut of a live, if staff cut it - read once the live's own row may be gone. Public for the
   * chat's hide (`LiveChatService`), which answers a cut-then-purged live as every route does.
   */
  async cutOf(manager: EntityManager, liveId: string): Promise<CutRecord | null> {
    const rows: CutRecord[] = await manager.query(
      `SELECT ${CUT_COLUMNS} FROM live_cuts WHERE "liveId" = $1`,
      [liveId]
    );
    return rows[0] ?? null;
  }

  /**
   * A live with NO ROW that staff cut: throws its `410 LIVE_ENDED` (`endReason: 'cut'`) to the
   * broadcaster, and to a viewer the live would have been VISIBLE to (the rule of a post, asked of
   * the cut's own copy of the broadcaster and association) with no block between them - so the cut
   * tells nobody else that the live existed, as the 404 before the end does. Returns otherwise. Public
   * for the chat's writes (`LiveChatService`), so a message on a cut-then-purged live answers the same.
   */
  async refuseIfCut(
    manager: EntityManager,
    liveId: string,
    callerId: string,
    as: 'broadcaster' | 'viewer'
  ): Promise<void> {
    const rows: (CutRecord & { visible: boolean })[] = await manager.query(
      `SELECT ${CUT_COLUMNS}, ${liveVisibleToViewerSql('live_cuts', '$2')} AS visible
         FROM live_cuts WHERE "liveId" = $1`,
      [liveId, callerId]
    );
    const cut = rows[0];
    if (!cut) return;
    const own = cut.broadcasterId === callerId;
    if (as === 'broadcaster' ? !own : !own && cut.visible !== true) return;
    if (!own && (await isBlockedBetween(manager, callerId, cut.broadcasterId))) return;
    this.logger.debug(`[LIVE] ${liveId} answered as cut to ${short(callerId)}`);
    throw liveEnded(cut.liveEndedAt, cut.liveEndReason);
  }

  /** Deletes the cuts older than {@link LIVE_CUT_RETENTION_MS} - the record's whole lifetime. */
  async pruneCuts(): Promise<number> {
    const [, affected] = (await this.db.query(
      // The column alone on its side, so `live_cuts_cut_at_idx` serves the predicate.
      `DELETE FROM live_cuts WHERE "cutAt" <= now() - $1::float8 * interval '1 millisecond'`,
      [LIVE_CUT_RETENTION_MS]
    )) as [unknown, number];
    if (affected > 0) this.logger.log(`[LIVE_GC] ${affected} cut(s) past their retention deleted`);
    return affected;
  }

  /**
   * ERASES THE REPORTED CHAT LINES WHOSE TIME IS UP (WP-L8b; owner, 2026-10-20) - one rule on
   * durable state, two halves: a line whose report is no longer `pending` (handled: reviewed or
   * dismissed), and a line kept {@link LIVE_CHAT_REPORT_MAX_KEEP_MS}, handled or NOT. The second is
   * a commitment broken - nobody answered the report in 90 days - so it logs at `warn` with its count.
   * A deleted report takes its line by the foreign key's cascade.
   */
  async pruneReportedChatLines(): Promise<number> {
    const [, handled] = (await this.db.query(
      `DELETE FROM live_chat_reported_lines k
        WHERE NOT EXISTS (SELECT 1 FROM content_reports r
                           WHERE r.id = k."reportId" AND r.status = 'pending')`
    )) as [unknown, number];
    const [, bounded] = (await this.db.query(
      // The column alone on its side, so `live_chat_reported_lines_kept_at_idx` serves it.
      `DELETE FROM live_chat_reported_lines
        WHERE "keptAt" <= now() - $1::float8 * interval '1 millisecond'`,
      [LIVE_CHAT_REPORT_MAX_KEEP_MS]
    )) as [unknown, number];
    if (handled > 0) {
      this.logger.log(
        `[LIVE_GC] ${handled} reported chat line(s) erased: their report was handled`
      );
    }
    if (bounded > 0) {
      this.logger.warn(
        `[LIVE_GC] ${bounded} reported chat line(s) erased UNHANDLED: their report waited the ` +
          `${LIVE_CHAT_REPORT_MAX_KEEP_MS / 86_400_000}-day bound`
      );
    }
    return handled + bounded;
  }

  /** The caller's own standing with the right to broadcast (`GET /api/lives/standing`). */
  async standing(userId: string): Promise<Omit<LiveStanding, 'withdrawalDue'>> {
    const { cutsOnRecord, suspendedUntil, withdrawnAt } = await standingOf(this.db.manager, userId);
    return { cutsOnRecord, suspendedUntil, withdrawnAt };
  }

  /**
   * STAFF WITHDRAW AN ACCOUNT'S RIGHT TO BROADCAST (the ladder's 3rd step, owner 2026-10-20: a
   * person's decision). Allowed once {@link LIVE_WITHDRAWAL_FROM_CUTS} cuts are on record, else 409
   * `LIVE_WITHDRAWAL_NOT_DUE` with the count - the ladder is the owner's, and a moderator who wants
   * an account silenced sooner has the mute. Idempotent: a repeat answers the first withdrawal with
   * `newlyWithdrawn: false`. An open live of the account is NOT ended by it: that is a cut.
   * The member is told by a `live_withdrawn` notice (reason code, no actor) and its push
   * (`social_live_withdrawn`, opening the notifications list).
   */
  async withdraw(
    reviewerId: string,
    userId: string,
    input: { reason?: unknown; details?: unknown }
  ): Promise<{
    userId: string;
    reason: LiveCutReason;
    withdrawnAt: Date;
    newlyWithdrawn: boolean;
    cutsOnRecord: number;
  }> {
    const { reason, details } = parseModerationNote(input);
    const target = parseAccountId(userId);
    const result = await this.db.transaction(async (tx) => {
      await lockStanding(tx, target);
      // The cuts the withdrawal rests on, held FOR SHARE: an account erasure deletes them BEFORE it
      // deletes the withdrawal rows, so it either waits for this commit (and its later DELETE then
      // sees the row written here) or has deleted them first (and the count below, a new
      // statement, reads them gone and refuses). Never a withdrawal row left behind an erasure.
      await tx.query(`SELECT 1 FROM live_cuts WHERE "broadcasterId" = $1 FOR SHARE`, [target]);
      const standing = await standingOf(tx, target);
      const existing: { reason: LiveCutReason; withdrawnAt: Date }[] = await tx.query(
        `SELECT reason, "withdrawnAt" FROM live_broadcast_withdrawals WHERE "userId" = $1`,
        [target]
      );
      if (existing[0]) {
        return { ...existing[0], newlyWithdrawn: false, cutsOnRecord: standing.cutsOnRecord };
      }
      if (standing.cutsOnRecord < LIVE_WITHDRAWAL_FROM_CUTS) {
        this.logger.log(
          `[LIVE_STRIKE] withdrawal of ${short(target)} refused: ${standing.cutsOnRecord} cut(s) on record`
        );
        throw new ConflictException({
          code: 'LIVE_WITHDRAWAL_NOT_DUE',
          cutsOnRecord: standing.cutsOnRecord,
          required: LIVE_WITHDRAWAL_FROM_CUTS,
        });
      }
      const rows: { withdrawnAt: Date }[] = await tx.query(
        `INSERT INTO live_broadcast_withdrawals ("userId", "reviewerId", reason, details)
         VALUES ($1, $2, $3, $4) RETURNING "withdrawnAt"`,
        [target, reviewerId, reason, details]
      );
      return {
        reason,
        withdrawnAt: rows[0].withdrawnAt,
        newlyWithdrawn: true,
        cutsOnRecord: standing.cutsOnRecord,
      };
    });
    if (result.newlyWithdrawn) {
      this.logger.log(
        `[LIVE_STRIKE] ${short(target)}'s right to broadcast withdrawn by ${short(reviewerId)} ` +
          `reason=${result.reason} cutsOnRecord=${result.cutsOnRecord}`
      );
      try {
        await this.notifications.createNotification({
          recipientId: target,
          type: 'live_withdrawn',
          postId: target,
          actorId: '',
          actorName: '',
          text: result.reason,
          pushData: { target: NOTIFICATIONS_TARGET },
        });
      } catch (e) {
        this.logger.warn(
          `[LIVE_STRIKE] ${short(target)}: the withdrawal notice was not written: ${causeOf(e)}`
        );
      }
    } else {
      this.logger.debug(`[LIVE_STRIKE] ${short(target)} was withdrawn already`);
    }
    return { userId: target, ...result };
  }

  /** Staff LIFT a withdrawal: the row goes, starts are allowed again. Idempotent (`lifted: false`). */
  async liftWithdrawal(
    reviewerId: string,
    userId: string
  ): Promise<{ userId: string; lifted: boolean }> {
    const target = parseAccountId(userId);
    const lifted = await this.db.transaction(async (tx) => {
      await lockStanding(tx, target);
      const [, affected] = (await tx.query(
        `DELETE FROM live_broadcast_withdrawals WHERE "userId" = $1`,
        [target]
      )) as [unknown, number];
      return affected > 0;
    });
    if (lifted) {
      this.logger.log(`[LIVE_STRIKE] ${short(target)}'s withdrawal lifted by ${short(reviewerId)}`);
    } else {
      this.logger.debug(`[LIVE_STRIKE] lift of ${short(target)}: nothing withdrawn`);
    }
    return { userId: target, lifted };
  }

  /**
   * Ends every open live whose broadcaster stopped sending for {@link LIVE_RECONNECT_WINDOW_MS}
   * (`dropped`, Q5) - the ONLY way a live ends by itself: it has no longest duration. The predicate reads `lastSegmentAt`, which
   * only the broadcaster's ingest writes - the broadcaster's own liveness. An `UPDATE` waits for an
   * ingest holding the row and re-reads the predicate after it, so a live that just took a segment
   * is never ended by a sweep that started before it.
   */
  async endDue(): Promise<{ id: string; endReason: LiveEndReason }[]> {
    const [rows] = (await this.db.query(
      `UPDATE lives
          SET "endedAt" = now(),
              "endReason" = 'dropped'
        WHERE "endedAt" IS NULL
          AND COALESCE("lastSegmentAt", "startedAt") + $1 * interval '1 millisecond' <= now()
        RETURNING id, "endReason"`,
      [LIVE_RECONNECT_WINDOW_MS]
    )) as [{ id: string; endReason: LiveEndReason }[], number];
    for (const r of rows) this.logger.log(`[LIVE] ${r.id} ended by the sweep: ${r.endReason}`);
    return rows;
  }

  /**
   * THE BACKFILL OF MIGRATION 110: seals every live whose row still holds its key in the previous,
   * plaintext form - written before the migration, or by the previous release's replica during the
   * rolling deploy. Run by every sweep, so it needs no "done" marker: the state is the row.
   *
   * ONE STATEMENT PER ROW writes the ciphertext and NULLs the plaintext together, and only if the
   * plaintext is still the one read (`"liveKey" = $4`): an interruption leaves each row wholly in one
   * form or the other, and a re-run, or two replicas racing, seal a row once. A row that fails is
   * logged at ERROR and excluded from the rest of this run, so it neither stops the batch nor spins
   * the loop. With no secret configured nothing is sealed and that is said at ERROR, once per run.
   * In the steady state it is one empty query on a partial index.
   */
  async sealPlaintextKeys(): Promise<{ sealed: number; failed: number }> {
    const outcome = { sealed: 0, failed: 0 };
    const skipped: string[] = [];
    for (;;) {
      const rows: { id: string; liveKey: string }[] = await this.db.query(
        `SELECT id, "liveKey" FROM lives
          WHERE "liveKey" IS NOT NULL AND id <> ALL($1::uuid[])
          ORDER BY id LIMIT $2`,
        [skipped, PLAINTEXT_KEY_BATCH]
      );
      if (rows.length === 0) return outcome;
      if (!isLiveKeySealingConfigured()) {
        this.logger.error(
          `[LIVE_KEY] ${rows.length}+ live(s) hold a plaintext key and none can be sealed: ` +
            `${LIVE_KEY_ENCRYPTION_SECRET_ENV} is unset or shorter than 32 characters`
        );
        outcome.failed += rows.length;
        return outcome;
      }
      for (const row of rows) {
        try {
          const sealed = sealLiveKey(row.id, row.liveKey);
          const [, changed] = (await this.db.query(
            `UPDATE lives
                SET "liveKeyCiphertext" = $2, "liveKeyVersion" = $3, "liveKey" = NULL
              WHERE id = $1 AND "liveKey" = $4`,
            [row.id, sealed.liveKeyCiphertext, sealed.liveKeyVersion, row.liveKey]
          )) as [unknown, number];
          if (changed === 1) {
            outcome.sealed += 1;
          } else {
            // Excluded like a failure, so the loop ends by construction whatever the row became.
            this.logger.debug(`[LIVE_KEY] ${row.id} was sealed or deleted meanwhile`);
            skipped.push(row.id);
          }
        } catch (e) {
          // `sealLiveKey` logs its own typed refusal; anything else is the database's.
          if (!(e instanceof LiveKeyUnavailableError)) {
            this.logger.error(`[LIVE_KEY] ${row.id} could not be sealed: ${String(e)}`);
          }
          outcome.failed += 1;
          skipped.push(row.id);
        }
      }
    }
  }

  /** The ended lives still holding a row, oldest end first, minus the ones a run already kept. */
  async endedLiveIds(exclude: string[], limit: number): Promise<string[]> {
    const rows: { id: string }[] = await this.db.query(
      `SELECT id FROM lives
        WHERE "endedAt" IS NOT NULL AND id <> ALL($1::uuid[])
        ORDER BY "endedAt" ASC LIMIT $2`,
      [exclude, limit]
    );
    return rows.map((r) => r.id);
  }

  /**
   * Deletes an ENDED live's segments from the store, then its row (the segment rows and the
   * removed-viewer list go with it by cascade).
   *
   * THE ROW GOES ONLY ON A PROOF: the store re-lists the live's prefix after deleting, and the row
   * is deleted only when that listing is EMPTY and nothing failed. A refusal keeps the row - the only
   * record that the prefix exists - for the next sweep.
   *
   * NOT WHILE A SEGMENT IS STORING: a live whose reservation is younger than
   * {@link LIVE_RESERVATION_TTL_MS} is `'kept'` before the store is touched (its confirm purges it).
   * No reservation can be taken after the end, so once this read finds none, no store of this live
   * is in flight but one past its own timeout. An OPEN live is never touched (`'kept'`, with a warn),
   * and an id with NO ROW is purged in the store alone - the orphan reaper's case.
   *
   * NOT WHILE A VIEWER STILL HOLDS A SEAT ON A LIVE THAT ENDED BY ITSELF: a seat is renewed by every
   * manifest read and nothing else, so a held seat is a viewer that was told of segments within the
   * lease and has not said it left - the segments its last manifest named are still its to fetch
   * (LIVE-WEB-2, `1.5.1-alpha.7`: the end's purge deleted segments 5 and 6 between the manifest that
   * named them and their download, a `404` on both viewers). A viewer gives its seat back on the
   * end's `410`; one that never does lets it lapse within {@link LIVE_SEAT_LEASE_MS}.
   *
   * The drain is decided from FACTS this read takes, never from `endReason` (a cut of a live already
   * ended keeps its earlier reason, an erasure keeps one already written):
   * - a `live_cuts` row, or a broadcaster that is {@link DELETED_ACCOUNT}: moderation or the account's
   *   deletion removed it, so it is removed NOW, every seat with it;
   * - `endedAt` older than the lease: `assertMayWatch` answers `410` from `endedAt` on, so no seat
   *   can have been renewed since, and every one has lapsed - the database's clock says so and Redis
   *   is not asked (an outage of it never holds media past the lease);
   * - otherwise the seats are read; one held, or a count that cannot be read, keeps the live.
   * THROWS on a transport failure, which the callers log and leave to the next sweep.
   */
  async purgeEnded(liveId: string): Promise<LivePurgeOutcome> {
    const rows: {
      ended: boolean;
      removed: boolean;
      withinLease: boolean | null;
      storeInFlight: boolean | null;
    }[] = await this.db.query(
      `SELECT l."endedAt" IS NOT NULL AS ended,
              (l."broadcasterId" = $4
                 OR EXISTS (SELECT 1 FROM live_cuts c WHERE c."liveId" = l.id)) AS removed,
              l."endedAt" + $3 * interval '1 millisecond' > now() AS "withinLease",
              l."pendingAt" + $2 * interval '1 millisecond' > now() AS "storeInFlight"
         FROM lives l WHERE l.id = $1`,
      [liveId, LIVE_RESERVATION_TTL_MS, LIVE_SEAT_LEASE_MS, DELETED_ACCOUNT]
    );
    const row = rows[0];
    if (row && !row.ended) {
      this.logger.warn(`[LIVE_GC] ${liveId} is OPEN: the purge path refuses it`);
      return 'kept';
    }
    if (row && !row.removed && row.withinLease) {
      // `null` was logged by `watching` as the error it is: whether a viewer is owed a segment is
      // unknown, so nothing is deleted under it - for at most the lease, after which this read is
      // not taken at all.
      const seated = await this.seats.watching(liveId, 'purge');
      if (seated === null) return 'kept';
      if (seated > 0) {
        this.logger.debug(
          `[LIVE_GC] ${liveId} kept: ${seated} viewer(s) still seated, owed the segments their last manifest named`
        );
        return 'kept';
      }
    } else if (!row || row.removed) {
      // A cut, an erasure or a row-less folder: nothing is owed to anybody, so every seat goes now
      // and the next live's viewers do not wait a lease for them. Best-effort: a failure is the lease.
      await this.seats.releaseLive(liveId).catch((e: unknown) => {
        this.logger.warn(
          `[LIVE_SEAT] ${liveId}: ended live's seats left to their lease: ${String(e)}`
        );
      });
    }
    if (row?.storeInFlight) {
      this.logger.debug(`[LIVE_GC] ${liveId} kept: a segment is still storing`);
      return 'kept';
    }
    const result = await this.store.purge(liveId);
    if (result.failed > 0 || result.remaining > 0) {
      this.logger.warn(
        `[LIVE_GC] ${liveId} kept: deleted=${result.deleted} failed=${result.failed} remaining=${result.remaining}`
      );
      return 'kept';
    }
    if (row) {
      await this.db.query(`DELETE FROM lives WHERE id = $1 AND "endedAt" IS NOT NULL`, [liveId]);
    }
    this.logger.debug(`[LIVE_GC] ${liveId} deleted (${result.deleted} segment object(s))`);
    return 'deleted';
  }

  /**
   * THE ORPHAN REAPER: every `live/<id>/` folder the store holds with NO live row behind it is
   * purged and proven empty. A ROW-STATE RULE, NOT A CLOCK: a folder is written only under a
   * reservation, which needs the row, and a row is deleted only once its prefix proved empty with no
   * reservation in flight - so a folder whose row is gone was written after its purge, by a store
   * that outlived its own timeout. The listing is read BEFORE the rows, so a live started in between
   * is never mistaken for one (its folder was not listed).
   */
  async reapOrphans(): Promise<LiveOrphanReport> {
    const report: LiveOrphanReport = { reaped: 0, kept: 0 };
    const listed = (await this.store.listLives()).filter((id) => UUID_RE.test(id));
    if (listed.length === 0) return report;
    const known: { id: string }[] = await this.db.query(
      `SELECT id FROM lives WHERE id = ANY($1::uuid[])`,
      [listed]
    );
    const rowed = new Set(known.map((r) => r.id.toLowerCase()));
    for (const id of listed) {
      if (rowed.has(id.toLowerCase())) continue;
      this.logger.warn(`[LIVE_GC] ${id}: a segment folder with no live row - reaping it`);
      try {
        if ((await this.purgeEnded(id)) === 'deleted') {
          report.reaped += 1;
          continue;
        }
      } catch (e) {
        this.logger.warn(`[LIVE_GC] orphan ${id} kept for the next run: ${causeOf(e)}`);
      }
      report.kept += 1;
    }
    return report;
  }

  /** Deletes the `live_starts` rows older than the window they are counted in. */
  async pruneStarts(): Promise<number> {
    const [, affected] = (await this.db.query(
      `DELETE FROM live_starts WHERE "startedAt" + $1 * interval '1 millisecond' <= now()`,
      [LIVE_START_WINDOW_MS]
    )) as [unknown, number];
    if (affected > 0)
      this.logger.debug(`[LIVE_GC] ${affected} start(s) older than the hour deleted`);
    return affected;
  }

  /**
   * Gives the viewer leaving a live its seat back (`DELETE /api/lives/:id/seat`). No watch check: a
   * viewer may always give back what it holds, even once the live has ended or it was removed.
   * The seat is the ACCOUNT's (lives.md, "The viewer cap"): one device leaving frees it for an
   * account watching on two, whose other device takes it again at its next poll.
   */
  async leave(viewerId: string, liveId: string): Promise<void> {
    await this.seats.release(liveId, viewerId);
  }

  /**
   * THE VIEWER CAP (lives.md, "The viewer cap"): a viewer reading the key or polling the manifest
   * takes or renews a seat, 503 `LIVE_FULL` past the host's cap. Taken AFTER the watch check, so a
   * removed, blocked or ended answer is never masked as "full". The broadcaster takes none: its
   * reads cost the uplink nothing a viewer's would.
   *
   * Answers the live's viewer count as the take counted it, or `null` for the broadcaster (no seat,
   * no take) - who asks {@link viewerCount} instead, and only where a count is shown.
   */
  private async takeSeat(row: LiveRow, viewerId: string): Promise<number | null> {
    if (row.broadcasterId === viewerId) return null;
    return this.seats.take(row.id, viewerId);
  }

  /**
   * THE VIEWER COUNT a manifest carries (lives.md, "The viewer count") - from the seats, no second
   * tracker: a viewer's from its own take (`taken`), the broadcaster's from a read-only count of the
   * same set. Asked by the manifest only: the key read shows no count, so it runs no count.
   */
  private async viewerCount(
    row: LiveRow,
    viewerId: string,
    taken: number | null
  ): Promise<number | null> {
    return row.broadcasterId === viewerId ? this.seats.watching(row.id) : taken;
  }

  /**
   * The watch rule ({@link assertMayWatch}) for a caller outside this service - the live chat's
   * writes (WP-L6), which are refused exactly as the key is. Throws the same typed refusals.
   */
  async mayWatch(viewerId: string, liveId: string): Promise<void> {
    // A WRITE to the live (a chat line, a burst): never by an admin across the review cohort's
    // boundary - `adminSeesCohort` opens the key and the manifest to judge a report, nothing more.
    await this.assertMayWatch(this.db.manager, viewerId, liveId, { adminSeesCohort: false });
  }

  /**
   * Who may read a live's key and manifest:
   *
   * - absent, NOT VISIBLE to the viewer (the rule of a post by the same broadcaster or association,
   *   `liveVisibleToViewerSql` - spaces respected), or a broadcaster blocked either way: 404
   *   `LIVE_NOT_FOUND` - invisible, as the feed hides them, and asked BEFORE the end so a 410 never
   *   tells an outsider that a live existed;
   * - ended: 410 to everybody, the broadcaster included - nothing is served after `endedAt`;
   * - a viewer the broadcaster removed: 403 `LIVE_VIEWER_REMOVED`.
   */
  private async assertMayWatch(
    manager: EntityManager,
    viewerId: string,
    liveId: string,
    opts: { adminSeesCohort: boolean }
  ): Promise<LiveRow & { serverNow: Date }> {
    // `serverNow` from the same clock that wrote `lastSegmentAt`, so a viewer compares like with like.
    const rows: (LiveRow & { serverNow: Date; visible: boolean })[] = await manager.query(
      `SELECT ${LIVE_COLUMNS}, now() AS "serverNow",
              ${liveVisibleToViewerSql('lives', '$2', opts)} AS visible
         FROM lives WHERE id = $1`,
      [liveId, viewerId]
    );
    const found = rows[0];
    if (!found) {
      // A live staff CUT and already purged is still a 410 that says so, to whom it was visible.
      await this.refuseIfCut(manager, liveId, viewerId, 'viewer');
      throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
    }
    const { visible, ...row } = found;
    // `=== true` and nothing looser: a driver answering `'t'` must not widen the gate.
    if (visible !== true) {
      this.logger.debug(`[LIVE] ${liveId} hidden from ${short(viewerId)}: not in its audience`);
      throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
    }
    const own = row.broadcasterId === viewerId;
    if (!own && (await isBlockedBetween(manager, viewerId, row.broadcasterId))) {
      this.logger.debug(`[LIVE] ${liveId} hidden from ${short(viewerId)}: a block`);
      throw new NotFoundException({ code: 'LIVE_NOT_FOUND' });
    }
    if (row.endedAt) throw liveEnded(row.endedAt, row.endReason);
    if (!own) {
      const removed: unknown[] = await manager.query(
        `SELECT 1 FROM live_removed_viewers WHERE "liveId" = $1 AND "viewerId" = $2`,
        [liveId, viewerId]
      );
      if (removed.length > 0) {
        this.logger.debug(`[LIVE] ${liveId} refused to removed viewer ${short(viewerId)}`);
        throw new ForbiddenException({ code: 'LIVE_VIEWER_REMOVED' });
      }
    }
    return row;
  }
}

/**
 * THE ONE 410 OF THE LIVE API: `{ code: 'LIVE_ENDED', endedAt, endReason }`. `endReason` is what a
 * screen branches on - `cut` (staff ended it, WP-L8) is told apart from every other end, never by a
 * message. Either field is null only when the server no longer knows (a live deleted mid-store).
 */
export function liveEnded(endedAt: Date | null, endReason: LiveEndReason | null): GoneException {
  return new GoneException({ code: 'LIVE_ENDED', endedAt, endReason });
}

/** The viewer's answer: the row and its key, already opened by the caller (`openLiveKey`). */
function toView(row: LiveRow, key: string): LiveView {
  return {
    id: row.id,
    broadcasterId: row.broadcasterId,
    associationId: row.associationId,
    startedAt: row.startedAt,
    lastSegmentAt: row.lastSegmentAt,
    nextIndex: row.nextIndex,
    key,
  };
}

/**
 * A staff decision's `{ reason, details? }` - a cut or a withdrawal: a reason CODE from
 * {@link LIVE_CUT_REASONS} (400 `LIVE_CUT_REASON_INVALID`), and an optional note of at most
 * {@link LIVE_CUT_DETAILS_MAX} characters (400 `LIVE_CUT_DETAILS_INVALID`), blank read as none.
 */
function parseModerationNote(input: { reason?: unknown; details?: unknown }): {
  reason: LiveCutReason;
  details: string | null;
} {
  const reason = input.reason;
  if (typeof reason !== 'string' || !(LIVE_CUT_REASONS as readonly string[]).includes(reason)) {
    throw new BadRequestException({ code: 'LIVE_CUT_REASON_INVALID' });
  }
  const rawDetails = input.details ?? null;
  if (
    rawDetails !== null &&
    (typeof rawDetails !== 'string' || rawDetails.length > LIVE_CUT_DETAILS_MAX)
  ) {
    throw new BadRequestException({ code: 'LIVE_CUT_DETAILS_INVALID' });
  }
  const details = typeof rawDetails === 'string' && rawDetails.trim() !== '' ? rawDetails : null;
  return { reason: reason as LiveCutReason, details };
}

/**
 * An account id from a URL, as every account id is compared: trimmed, lower case, at most 255
 * characters. The erased tombstone is refused: it pools every erased account, so no decision may
 * name it. 400 `LIVE_ACCOUNT_INVALID`.
 */
function parseAccountId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (id === '' || id.length > 255 || id === DELETED_ACCOUNT.toLowerCase()) {
    throw new BadRequestException({ code: 'LIVE_ACCOUNT_INVALID' });
  }
  return id;
}

/** The cause of a failure on one line - an axios error carries a whole socket graph otherwise. */
function causeOf(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  const status = (e as { response?: { status?: number } } | null)?.response?.status;
  const message = e instanceof Error ? e.message : String(e);
  return `${code ?? ''} ${status ?? ''} ${message}`.replace(/\s+/g, ' ').trim();
}
