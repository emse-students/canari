import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import type { EntityManager, Repository } from 'typeorm';
import { mediaUrl } from '../internal/service-urls';
import { BookingSpace, type SpacePoster } from './entities/booking-space.entity';

const internalHeaders = () => ({ 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' });

/**
 * The lock every write that changes WHO CITES a poster takes on its media id, inside its
 * transaction: a claim (held until the citing row commits) and a release (held across its re-read
 * of the citations and its call). So a release never reads "uncited" while a claim it races is
 * between the media service and its commit (review of #2045).
 */
async function lockPoster(m: Pick<EntityManager, 'query'>, mediaId: string): Promise<void> {
  await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `booking-poster:${mediaId}`,
  ]);
}

/**
 * THE POSTER'S LIFETIME AT THE MEDIA SERVICE (D35, WP-B6), for the one image a space cites.
 *
 * The client uploads a poster `poster-pending` - a class only the poster field names, swept by age
 * if nothing claims it. This side then:
 * - CLAIMS it INSIDE the transaction that stores the space's row (`internal/poster-claim`), under
 *   the poster's lock: the media service moves it to `poster-association` (an entity's space: it
 *   outlives its uploader's erasure, as an association document does) or `poster` (a personal
 *   space), bound to THAT space, ONLY when it is the acting member's own fresh poster upload. An id
 *   is not a secret: without this, a member could cite a stranger's image, an association document
 *   or their own post's photo, then remove the poster and hand that object to the idle sweep
 *   (review of #2045). A refused claim refuses the save (`poster-not-yours`); an unanswered one too
 *   (`try-again`) - never stored on trust. A repeated claim for the same space is idempotent.
 * - RELEASES it (`internal/poster-release`, which moves a claimed poster and nothing else) once NO
 *   space cites it, re-read under the poster's lock - replaced, removed, its space or its association
 *   deleted, or its save rolled back.
 * - RECONCILES every hour: a claimed poster no space cites - a save that died between its claim and
 *   its commit - is released. No grace period is needed: a claim in flight holds the poster's lock,
 *   so the release waits for its commit and then finds it cited.
 * Never an immediate delete: the idle sweep reclaims a released poster in its own time.
 */
@Injectable()
export class BookingPosterMedia {
  private readonly logger = new Logger(BookingPosterMedia.name);
  private reconciling = false;

  constructor(
    private readonly http: HttpService,
    @InjectRepository(BookingSpace) private readonly spaces: Repository<BookingSpace>
  ) {}

  /**
   * Claims `mediaId` for `actorId` as the poster of `spaceId` (of `associationId`, null: personal),
   * inside `m`, the transaction that will store the row - or throws: 400 `poster-not-yours`, 503
   * `try-again`, and the transaction rolls back.
   */
  async claim(
    m: Pick<EntityManager, 'query'>,
    mediaId: string,
    actorId: string,
    spaceId: string,
    associationId: string | null
  ): Promise<void> {
    const retentionClass = associationId ? 'poster-association' : 'poster';
    this.logger.debug(
      `[BOOKINGS] poster claim media=${mediaId.slice(0, 8)} as '${retentionClass}'`
    );
    await lockPoster(m, mediaId);
    let claimed: string[];
    try {
      const res = await firstValueFrom(
        this.http.post<{ claimed: string[]; refused: string[] }>(
          mediaUrl('media/internal/poster-claim'),
          { mediaIds: [mediaId], ownerId: actorId, spaceId, retentionClass },
          { headers: internalHeaders() }
        )
      );
      claimed = res.data?.claimed ?? [];
    } catch (err) {
      this.logger.warn(
        `[BOOKINGS] poster claim failed, the save is refused: ${err instanceof Error ? err.message : String(err)}`
      );
      throw new ServiceUnavailableException({ code: 'try-again' });
    }
    if (!claimed.includes(mediaId)) {
      this.logger.warn(
        `[BOOKINGS] poster refused: media=${mediaId.slice(0, 8)} is not user=${actorId.slice(0, 8)}'s fresh poster upload for space=${spaceId.slice(0, 8)}`
      );
      throw new BadRequestException({ code: 'poster-not-yours' });
    }
    this.logger.log(
      `[BOOKINGS] poster claimed media=${mediaId.slice(0, 8)} as '${retentionClass}'`
    );
  }

  /** Releases the posters among `mediaIds` that no space cites any more. */
  releaseUncited(mediaIds: string[], why: string): Promise<void> {
    return releaseUncitedPosters(this.http, this.spaces.manager, this.logger, mediaIds, why);
  }

  /** Hourly, at :47 - off the minutes the other purges use. */
  @Cron('47 * * * *')
  async reconcile(): Promise<void> {
    if (this.reconciling) {
      this.logger.warn(`[BOOKINGS] poster reconciliation still running - this tick is skipped`);
      return;
    }
    this.reconciling = true;
    try {
      await this.reconcileOnce();
    } catch (e) {
      this.logger.warn(
        `[BOOKINGS] poster reconciliation failed - retried next hour: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Releases every CLAIMED poster no space cites: the media service lists them, the database says
   * which are cited, and the rest go through {@link releaseUncitedPosters}, which re-reads each under
   * its lock. Returns how many were handed to the release.
   */
  async reconcileOnce(): Promise<number> {
    const res = await firstValueFrom(
      this.http.get<{ posters: Array<{ mediaId: string; spaceId: string | null }> }>(
        mediaUrl('media/internal/poster-list'),
        { headers: internalHeaders() }
      )
    );
    const ids = (res.data?.posters ?? []).map((p) => p.mediaId);
    if (ids.length === 0) return 0;
    const cited = new Set(
      (
        (await this.spaces.query(
          `SELECT DISTINCT poster->>'mediaId' AS id FROM booking_spaces WHERE poster->>'mediaId' = ANY($1)`,
          [ids]
        )) as { id: string }[]
      ).map((r) => r.id)
    );
    const orphans = ids.filter((id) => !cited.has(id));
    if (orphans.length === 0) return 0;
    this.logger.warn(
      `[BOOKINGS] ${orphans.length} claimed poster(s) cited by no space (a save that died between its claim and its commit, or a release that failed) - released`
    );
    await this.releaseUncited(orphans, 'reconciliation');
    return orphans.length;
  }
}

/**
 * Releases to the idle sweep the posters among `mediaIds` that no booking space cites any more -
 * the one release path, also used by an association's delete. Each id in its own transaction,
 * under its lock: the citation is re-read there, so a claim racing the release is either committed
 * (cited: kept) or rolled back (uncited: released), never half-seen. Best-effort: a failure is
 * logged with the id it left, and the hourly reconciliation finds it again.
 */
export async function releaseUncitedPosters(
  http: HttpService,
  db: Pick<EntityManager, 'transaction'>,
  logger: Logger,
  mediaIds: string[],
  why: string
): Promise<void> {
  let released = 0;
  let kept = 0;
  for (const id of new Set(mediaIds)) {
    try {
      const outcome = await db.transaction(async (m) => {
        await lockPoster(m, id);
        const cited = (await m.query(
          `SELECT 1 FROM booking_spaces WHERE poster->>'mediaId' = $1 LIMIT 1`,
          [id]
        )) as unknown[];
        if (cited.length > 0) return 'cited' as const;
        const res = await firstValueFrom(
          http.post<{ released: string[]; refused: string[] }>(
            mediaUrl('media/internal/poster-release'),
            { mediaIds: [id] },
            { headers: internalHeaders() }
          )
        );
        return (res.data?.released ?? []).includes(id)
          ? ('released' as const)
          : ('refused' as const);
      });
      if (outcome === 'released') released++;
      else if (outcome === 'cited') kept++;
      else {
        // Not a claimed poster at the media service: an upload never claimed (the sweep takes it
        // by age) or one already released. Nothing to do, and nothing else may be touched.
        logger.log(`[BOOKINGS] poster ${id} (${why}): not a claimed poster at the media service`);
      }
    } catch (err) {
      logger.warn(
        `[BOOKINGS] poster ${id} NOT released (${why}) - retried by the hourly reconciliation: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (released + kept > 0) {
    logger.log(
      `[BOOKINGS] posters (${why}): ${released} released, ${kept} kept - another space still cites them`
    );
  }
}

/**
 * The poster a request carries, copied FIELD BY FIELD - the body's own keys are never stored (the
 * module's rule, review of #2006). `undefined`: the request does not touch it.
 */
export function posterOf(dto: SpacePoster | null | undefined): SpacePoster | null | undefined {
  if (dto === undefined || dto === null) return dto;
  return {
    type: 'image',
    mediaId: dto.mediaId.toLowerCase(),
    key: dto.key.toLowerCase(),
    iv: dto.iv.toLowerCase(),
    mimeType: dto.mimeType,
    size: dto.size,
    ...(dto.width !== undefined ? { width: dto.width } : {}),
    ...(dto.height !== undefined ? { height: dto.height } : {}),
  };
}
