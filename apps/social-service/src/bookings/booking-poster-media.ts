import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { applyMediaRetentionClass } from '../internal/media-retention-class';
import type { SpacePoster } from './entities/booking-space.entity';

/**
 * THE POSTER'S LIFETIME AT THE MEDIA SERVICE (D35, WP-B6) - the posts' pattern
 * (`PostMediaRetentionService`), for the one image a space cites.
 *
 * The client uploads a poster `archive` (kept by the idle sweep), as a post image. This side then:
 * - KEEPS an ASSOCIATION space's poster as `association`, the class that also survives its
 *   uploader's account deletion: the poster is the entity's, not the organiser's who happened to
 *   pick it (the posts do the same for an association post's media, at the erasure). A PERSONAL
 *   space's poster stays `archive`: it is its owner's, and goes with their account.
 * - RELEASES a poster no space cites any more (replaced, removed, its space or its association
 *   deleted) to `ephemeral`, so the idle sweep reclaims it in its own time - never an immediate
 *   delete, the posts' rule for an image an edit removed.
 *
 * Best-effort, as every caller of {@link applyMediaRetentionClass}: the organiser's save is not
 * failed over it, and a failure is logged with what it left (a poster kept longer, or one not yet
 * protected from its uploader's erasure).
 */
@Injectable()
export class BookingPosterMedia {
  private readonly logger = new Logger(BookingPosterMedia.name);

  constructor(private readonly http: HttpService) {}

  /** Classifies the poster a space now cites: `association` for an entity's, `archive` for a person's. */
  async keep(space: { id: string; associationId: string | null; poster: SpacePoster | null }) {
    if (!space.poster) return;
    const cls = space.associationId ? 'association' : 'archive';
    const changed = await applyMediaRetentionClass(
      this.http,
      this.logger,
      [space.poster.mediaId],
      cls
    );
    if (changed === null) {
      this.logger.warn(
        `[BOOKINGS] poster of space=${space.id.slice(0, 8)} NOT classified '${cls}' - it keeps the class it was uploaded with`
      );
    } else {
      this.logger.log(`[BOOKINGS] poster of space=${space.id.slice(0, 8)} kept as '${cls}'`);
    }
  }

  /** Releases posters no space cites any more to the idle sweep (`ephemeral`). */
  async release(mediaIds: string[], why: string) {
    if (mediaIds.length === 0) return;
    const changed = await applyMediaRetentionClass(this.http, this.logger, mediaIds, 'ephemeral');
    if (changed === null) {
      this.logger.warn(
        `[BOOKINGS] ${mediaIds.length} poster(s) NOT released (${why}) - the media service keeps them: ${mediaIds.join(',')}`
      );
    } else {
      this.logger.log(`[BOOKINGS] ${mediaIds.length} poster(s) released (${why})`);
    }
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
