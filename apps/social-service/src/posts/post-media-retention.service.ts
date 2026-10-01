import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Post } from './entities/post.entity';
import { applyMediaRetentionClass } from '../internal/media-retention-class';

/**
 * Keeps the media service's retention class in step with what the feed actually references.
 *
 * The media service holds ciphertext and an index of `{createdAt, lastAccessAt, ownerId}`. It
 * cannot tell a post photo from a chat photo, so it deletes anything nobody has opened for the
 * idle window - and on 2026-09-23 that had already taken 22 of the feed's 44 media while all 43
 * illustrated posts remained, each rendering an "expired" box for ever. A post is a permanent row;
 * an idle window is the wrong question to ask of its body.
 *
 * This service owns the other half of that fact. The client marks a post upload `archive` as it
 * happens; social-service marks what was uploaded BEFORE the class existed, and releases what a
 * deleted post no longer cites.
 *
 * **Every call here is best-effort and says so in the log.** A failed classify means an object
 * keeps the ordinary idle window and the next boot re-applies it; a failed release means an object
 * is kept longer than it needs to be. Neither is worth failing a user's delete over, and neither
 * is allowed to pass silently - a swallowed branch in a best-effort path leaves nothing else.
 */
@Injectable()
export class PostMediaRetentionService implements OnModuleInit {
  private readonly logger = new Logger(PostMediaRetentionService.name);

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>
  ) {}

  /**
   * Re-applies `archive` to every media the feed still references, once per boot.
   *
   * It exists for two states no upload-time flag can cover: objects stored before the class did,
   * and an index rebuilt after a loss - `media_metadata.json` is a FILE, and `download()` silently
   * re-creates a missing entry with `createdAt = now` and no class at all. Running it at every
   * boot rather than once is deliberate: it is idempotent, it costs one query, and a repair that
   * only ever ran in a migration is a repair that is not there the day it is needed.
   */
  async onModuleInit(): Promise<void> {
    const ids = await this.referencedMediaIds();
    if (ids.length === 0) {
      this.logger.log('Media retention backfill: the feed references no media');
      return;
    }
    const changed = await applyMediaRetentionClass(this.httpService, this.logger, ids, 'archive');
    // The two outcomes are worth distinguishing: 0 is the steady state, anything else means the
    // index had lost a classification and this is the repair that put it back.
    this.logger.log(
      changed === null
        ? `Media retention backfill FAILED for ${ids.length} referenced object(s) - they keep the idle window until the next boot`
        : `Media retention backfill: ${ids.length} referenced object(s), ${changed} newly classified`
    );
  }

  /** Marks media as archived, so the idle sweep never takes them. */
  async classify(mediaIds: string[]): Promise<void> {
    if (mediaIds.length > 0) {
      await applyMediaRetentionClass(this.httpService, this.logger, mediaIds, 'archive');
    }
  }

  /**
   * Moves media onto the idle window (`ephemeral`), so the sweep reclaims them in its own time.
   *
   * Deliberately not an immediate delete. An edit that merely removes an image reaches here too,
   * and the honest answer to "this row no longer cites it" is the idle clock rather than destroying
   * the object on the spot. It names `ephemeral` explicitly because the sweep is an allowlist: an
   * object with no class is one it never takes.
   */
  async release(mediaIds: string[]): Promise<void> {
    if (mediaIds.length > 0) {
      await applyMediaRetentionClass(this.httpService, this.logger, mediaIds, 'ephemeral');
    }
  }

  /**
   * Every media id the feed currently points at: a post's own attachments and its comments'.
   *
   * Read in SQL rather than by loading posts, because this runs at boot on the whole table and the
   * bodies are the largest column in it.
   */
  private async referencedMediaIds(): Promise<string[]> {
    const rows: Array<{ mediaId: string | null }> = await this.postRepo.query(`
      SELECT m->>'mediaId' AS "mediaId"
        FROM posts p, jsonb_array_elements(p.images) m
       WHERE jsonb_typeof(p.images) = 'array'
      UNION
      SELECT c->'media'->>'mediaId' AS "mediaId"
        FROM posts p, jsonb_array_elements(p.comments) c
       WHERE jsonb_typeof(p.comments) = 'array'
         AND jsonb_typeof(c->'media') = 'object'
    `);
    return rows.map((row) => row.mediaId).filter((id): id is string => typeof id === 'string');
  }
}

/** Media ids a post's own attachment list cites. Tolerates the legacy `images` shapes. */
export function postMediaIds(post: Pick<Post, 'media'>): string[] {
  const media = Array.isArray(post.media) ? post.media : [];
  return media
    .map((entry) => (entry as { mediaId?: unknown } | null)?.mediaId)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * Media ids a post's comments cite.
 *
 * A comment carries ONE media as an object, where a post carries an array - the two shapes differ
 * and reading a comment's with the post's accessor silently finds nothing.
 */
export function commentMediaIds(comments: unknown): string[] {
  if (!Array.isArray(comments)) return [];
  return comments
    .map((comment) => (comment as { media?: { mediaId?: unknown } } | null)?.media?.mediaId)
    .filter((id): id is string => typeof id === 'string');
}
