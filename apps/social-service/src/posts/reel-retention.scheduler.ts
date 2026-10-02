import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { invalidatePostListCache } from './post-list-cache';
import {
  PostMediaRetentionService,
  commentMediaOwners,
  postMediaIds,
} from './post-media-retention.service';
import type { ReelPurgeOutcome } from '../internal/reel-media';

/** How many due reels one query takes. Bounds memory (a reel row carries its comments) and nothing else - the run loops until none is due. */
const BATCH = 50;

/** What one run did, returned for the test and summarised in the log. */
export interface ReelPurgeReport {
  /** Due reels the run looked at. */
  due: number;
  /** Rows deleted. */
  deleted: number;
  /** Reels kept for the next tick because a blob (or the call) failed. */
  failed: number;
  /** Per-blob outcomes across the run. */
  blobs: Record<ReelPurgeOutcome, number>;
}

/**
 * Deletes a CanaReel - the post, its comments and reactions, its notifications AND its media
 * blobs - once its `expiresAt` has passed (decision C6, 30 days after publication).
 *
 * THE STATE IS THE ROW. A reel is due when `kind = 'reel' AND "expiresAt" <= NOW()`, and a deleted
 * row is a finished one: there is no "last run", no marker and no window that a missed tick could
 * leave a gap in. So the worker is idempotent from durable state alone - a crash between the blobs
 * and the row leaves a due row whose blobs the media service now answers `absent` for (success), and
 * the next tick deletes the row. Running it twice in a row deletes once.
 *
 * ORDER: blobs first, row second, and the row ONLY if no blob came back `failed`. The other order
 * would delete the one record of which blob to delete and strand it for ever. While a row waits for
 * its retry it is invisible: every read excludes a reel past its expiry, so a reel whose blob will
 * not delete is never on screen.
 *
 * ISOLATION: a `try` per reel, and the failed ids are excluded from the run's own next query, so
 * one reel the store refuses can neither stop the batch nor spin the loop.
 *
 * THE ALLOWLIST: the row delete names `kind = 'reel'` and the expiry in its own `WHERE`, so a
 * non-reel post cannot be reached by this code whatever id arrives; and the blobs are deleted by
 * the media service only on their uploader's say-so (`MediaService.purgeReels`).
 *
 * OBSERVED by the `[REEL_GC]` line (only when something was due - a run that did nothing is the
 * steady state and says nothing), the per-reel `warn`s, and the `reels` block of `/admin/storage`
 * whose `overdue` is this worker's verdict on itself.
 */
@Injectable()
export class ReelRetentionScheduler {
  private readonly logger = new Logger(ReelRetentionScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly retention: PostMediaRetentionService,
    private readonly redis: RedisService
  ) {}

  /** Hourly, at :23 - off the minute the announce sweeper and the other GC jobs use. */
  @Cron('23 * * * *')
  async purgeExpiredReels(): Promise<void> {
    if (this.running) {
      this.logger.warn('[REEL_GC] the previous run is still going - this tick is skipped');
      return;
    }
    this.running = true;
    try {
      await this.purgeOnce();
    } catch (e) {
      this.logger.warn('[REEL_GC] run failed before it could process the due reels', e);
    } finally {
      this.running = false;
    }
  }

  /** The whole run, separated so a test can call it without a scheduler. */
  async purgeOnce(): Promise<ReelPurgeReport> {
    const report: ReelPurgeReport = {
      due: 0,
      deleted: 0,
      failed: 0,
      blobs: { deleted: 0, absent: 0, refused: 0, failed: 0 },
    };
    const keptForRetry: string[] = [];

    for (;;) {
      const rows: DueReel[] = await this.postRepo.manager.query(
        `SELECT id, "authorId", images, comments
           FROM posts
          WHERE kind = 'reel' AND "expiresAt" <= NOW()
            AND id <> ALL($1::uuid[])
          ORDER BY "expiresAt" ASC
          LIMIT $2`,
        [keptForRetry, BATCH]
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        report.due += 1;
        try {
          if (await this.purgeReel(row, report)) report.deleted += 1;
          else {
            report.failed += 1;
            keptForRetry.push(row.id);
          }
        } catch (e) {
          report.failed += 1;
          keptForRetry.push(row.id);
          // The CAUSE on the line itself, not an error object: an axios failure dumps a whole
          // request/socket graph, and the one fact a reader needs is what refused.
          const code = (e as { code?: string } | null)?.code;
          this.logger.warn(
            `[REEL_GC] reel=${row.id} kept for the next tick: ${code ?? ''} ${
              e instanceof Error && e.message ? e.message : String(e)
            }`.replace(/\s+/g, ' ')
          );
        }
      }
    }

    if (report.deleted > 0) {
      try {
        await invalidatePostListCache(this.redis);
      } catch (e) {
        this.logger.warn('[REEL_GC] feed cache sweep failed - pages stay stale for up to 30 s', e);
      }
    }
    if (report.due > 0) {
      const b = report.blobs;
      this.logger.log(
        `[REEL_GC] due=${report.due} deleted=${report.deleted} failed=${report.failed} ` +
          `blobs(deleted=${b.deleted} absent=${b.absent} refused=${b.refused} failed=${b.failed})`
      );
    }
    return report;
  }

  /**
   * One reel: blobs, then row. Returns true when the row went, false when it must wait.
   * Throws on a transport failure, which the caller records as the same "wait".
   */
  private async purgeReel(row: DueReel, report: ReelPurgeReport): Promise<boolean> {
    const items = [
      ...postMediaIds({ media: row.images as never }).map((mediaId) => ({
        mediaId,
        ownerId: row.authorId,
      })),
      ...commentMediaOwners(row.comments),
    ];
    const results = await this.retention.purgeReelBlobs(items);

    const stuck: string[] = [];
    for (const { mediaId } of items) {
      // A result the media service did not give is NOT a success: unknown means the blob may be
      // there, and the row is the only record of it.
      const outcome = results[mediaId] ?? 'failed';
      report.blobs[outcome] += 1;
      if (outcome === 'failed') stuck.push(mediaId);
      else if (outcome === 'refused') {
        this.logger.warn(
          `[REEL_GC] reel=${row.id} cites ${mediaId}, which is not its uploader's to delete - left alone`
        );
      }
    }
    if (stuck.length > 0) {
      this.logger.warn(
        `[REEL_GC] reel=${row.id} kept: ${stuck.length} blob(s) not deleted (${stuck.join(', ')})`
      );
      return false;
    }

    await this.postRepo.manager.transaction(async (tx) => {
      await tx.query(`DELETE FROM post_notifications WHERE "postId" = $1`, [row.id]);
      await tx.query(`DELETE FROM posts WHERE id = $1 AND kind = 'reel' AND "expiresAt" <= NOW()`, [
        row.id,
      ]);
    });
    return true;
  }
}

/** The columns a due reel is read with: just what deleting it needs. */
interface DueReel {
  id: string;
  authorId: string;
  images: unknown;
  comments: unknown;
}
