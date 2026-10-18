import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import type { Repository } from 'typeorm';
import { applyMediaRetentionClass } from '../internal/media-retention-class';
import { mediaUrl } from '../internal/service-urls';
import { BookingSpace, type SpacePoster } from './entities/booking-space.entity';

/** The query a release needs, so the association's delete can run it without this module. */
type Query = (sql: string, params: unknown[]) => Promise<unknown[]>;

/**
 * THE POSTER'S LIFETIME AT THE MEDIA SERVICE (D35, WP-B6), for the one image a space cites.
 *
 * The client uploads a poster `archive`, as a post image. This side then:
 * - CLAIMS it before the space stores it (`internal/poster-claim`, the reels' rule tightened): the
 *   media service sets `association` (an entity's space: it outlives its uploader's erasure, as an
 *   association post's media does) or keeps `archive` (a personal space) ONLY on the acting member's
 *   own fresh upload no other surface has classified. An id is not a secret: without this, a member
 *   could cite a stranger's image or an association document, then remove the poster and hand that
 *   object to the idle sweep (review of #2045). A refused claim refuses the save (`poster-not-yours`);
 *   a media service that does not answer refuses it too (`try-again`) - never stored on trust.
 * - RELEASES a poster to `ephemeral` once NO space cites it any more (replaced, removed, its space
 *   or its association deleted), read from the database after the commit - so a poster two spaces
 *   share is not taken from the one still showing it. Never an immediate delete: the idle sweep
 *   reclaims it in its own time, the posts' rule for an image an edit removed.
 */
@Injectable()
export class BookingPosterMedia {
  private readonly logger = new Logger(BookingPosterMedia.name);

  constructor(
    private readonly http: HttpService,
    @InjectRepository(BookingSpace) private readonly spaces: Repository<BookingSpace>
  ) {}

  /**
   * Claims `mediaId` for `actorId` as the poster of a space of `associationId` (null: personal),
   * or throws: 400 `poster-not-yours`, 503 `try-again`.
   */
  async claim(mediaId: string, actorId: string, associationId: string | null): Promise<void> {
    const retentionClass = associationId ? 'association' : 'archive';
    this.logger.debug(
      `[BOOKINGS] poster claim media=${mediaId.slice(0, 8)} as '${retentionClass}'`
    );
    let refused: string[];
    try {
      const res = await firstValueFrom(
        this.http.post<{ claimed: string[]; refused: string[] }>(
          mediaUrl('media/internal/poster-claim'),
          { mediaIds: [mediaId], ownerId: actorId, retentionClass },
          { headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' } }
        )
      );
      refused = res.data?.refused ?? [mediaId];
      if (!(res.data?.claimed ?? []).includes(mediaId)) refused = [mediaId];
    } catch (err) {
      this.logger.warn(
        `[BOOKINGS] poster claim failed, the save is refused: ${err instanceof Error ? err.message : String(err)}`
      );
      throw new ServiceUnavailableException({ code: 'try-again' });
    }
    if (refused.length > 0) {
      this.logger.warn(
        `[BOOKINGS] poster refused: media=${mediaId.slice(0, 8)} is not user=${actorId.slice(0, 8)}'s fresh upload`
      );
      throw new BadRequestException({ code: 'poster-not-yours' });
    }
    this.logger.log(
      `[BOOKINGS] poster claimed media=${mediaId.slice(0, 8)} as '${retentionClass}'`
    );
  }

  /** Releases the posters among `mediaIds` that no space cites any more. */
  releaseUncited(mediaIds: string[], why: string): Promise<void> {
    return releaseUncitedPosters(
      this.http,
      (sql, params) => this.spaces.query(sql, params),
      this.logger,
      mediaIds,
      why
    );
  }
}

/**
 * Releases to the idle sweep (`ephemeral`) the posters among `mediaIds` that no booking space
 * cites any more - the one release path, also used by an association's delete. Best-effort, as
 * every caller of {@link applyMediaRetentionClass}: a failure is logged with the ids it left.
 */
export async function releaseUncitedPosters(
  http: HttpService,
  query: Query,
  logger: Logger,
  mediaIds: string[],
  why: string
): Promise<void> {
  const unique = [...new Set(mediaIds)];
  if (unique.length === 0) return;
  let cited: { id: string }[];
  try {
    cited = (await query(
      `SELECT DISTINCT poster->>'mediaId' AS id FROM booking_spaces WHERE poster->>'mediaId' = ANY($1)`,
      [unique]
    )) as { id: string }[];
  } catch (err) {
    // Not knowing who cites them, none is released: a kept poster costs storage, a wrong release
    // costs another space its image.
    logger.warn(
      `[BOOKINGS] ${unique.length} poster(s) NOT released (${why}) - the citation read failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  const still = new Set(cited.map((c) => c.id));
  const free = unique.filter((id) => !still.has(id));
  if (still.size > 0) {
    logger.log(`[BOOKINGS] ${still.size} poster(s) kept (${why}): another space still cites them`);
  }
  if (free.length === 0) return;
  const changed = await applyMediaRetentionClass(http, logger, free, 'ephemeral');
  if (changed === null) {
    logger.warn(
      `[BOOKINGS] ${free.length} poster(s) NOT released (${why}) - the media service keeps them: ${free.join(',')}`
    );
  } else {
    logger.log(`[BOOKINGS] ${free.length} poster(s) released (${why}) changed=${changed}`);
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
