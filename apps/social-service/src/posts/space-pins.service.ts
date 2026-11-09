import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager, Repository } from 'typeorm';
import { RedisService } from '../common/redis/redis.service';
import { Post } from './entities/post.entity';
import { invalidatePostListCache } from './post-list-cache';
import {
  MAY_PIN_IN_SPACE_SQL,
  PIN_SPACES_FOR_VIEWER_SQL,
  PIN_STANDING_IN_SPACE_SQL,
  POST_NOT_FOUND,
  POST_NOT_IN_SPACE,
  POST_PINNABLE_IN_SPACE_SQL,
  SPACE_NOT_FOUND,
  SPACE_PIN_FORBIDDEN,
  SPACE_PIN_LIMIT,
  SPACE_PIN_LIMIT_CODE,
  SPACE_PIN_LIST_SQL,
  pinStateOf,
  type PinSpace,
  type PinState,
} from './space-pins';

/** Who is acting: the caller's id and whether they administer the platform. */
export interface PinActor {
  userId: string;
  isGlobalAdmin: boolean;
}

/**
 * What a pin or unpin answers. `pinned` is the post's state IN THAT SPACE after the act - what an
 * older client toggles its button on (it sends no space, and pins where exactly one fits).
 */
export interface PinResult {
  ok: true;
  pinned: boolean;
  spaceId: string;
  state: PinState;
}

/** One row of a governor's pin list for a space. */
export interface SpacePinEntry {
  postId: string;
  pinnedAt: Date;
  /** `shown` (one of the 3 readers see first) or `pending` ("en attente": kept, not shown). */
  state: Exclude<PinState, null>;
}

/**
 * PINS PER SPACE (WP-PIN, docs/wiki/spaces-and-audiences-reform.md section 11): pin, unpin, the
 * governor's list, and the per-page context the cards are stamped from. Every rule is SQL in
 * `space-pins.ts`; this service orders the statements and turns each refusal into a typed error.
 */
@Injectable()
export class SpacePinsService {
  private readonly logger = new Logger(SpacePinsService.name);

  constructor(
    @InjectRepository(Post)
    private readonly postRepo: Repository<Post>,
    private readonly redis: RedisService
  ) {}

  /**
   * For each post of a page, the spaces where `actor` may pin it, with the pin's state there. One
   * query for the page. Empty for a post the actor may pin nowhere - which is `canPin: false`.
   */
  async pinSpacesFor(postIds: string[], actor: PinActor): Promise<Map<string, PinSpace[]>> {
    const byPost = new Map<string, PinSpace[]>();
    if (postIds.length === 0) return byPost;
    const rows: unknown = await this.postRepo.manager.query(PIN_SPACES_FOR_VIEWER_SQL, [
      postIds,
      actor.userId,
      actor.isGlobalAdmin,
    ]);
    for (const row of Array.isArray(rows)
      ? (rows as {
          postId: string;
          spaceId: string;
          formation: string;
          campus: string;
          rank: number | null;
        }[])
      : []) {
      const list = byPost.get(row.postId) ?? [];
      list.push({
        spaceId: row.spaceId,
        formation: row.formation,
        campus: row.campus,
        state: pinStateOf(row.rank),
      });
      byPost.set(row.postId, list);
    }
    return byPost;
  }

  /**
   * Pins `postId` in `spaceId`, the space the client named.
   *
   * THE CAP HOLDS UNDER CONCURRENCY BY SERIALISING ON THE SPACE: the transaction takes an advisory
   * lock keyed on the space, THEN reads the rank and the shown count, then inserts - so two pins at
   * 2 of 3 leave exactly 3. Already shown there: answered as done, nothing written. A 4th is refused
   * with `space_pin_limit`, "en attente" pins or not: only the shown ones are counted.
   */
  async pin(postId: string, actor: PinActor, target: string): Promise<PinResult> {
    this.logger.debug(`[PIN] pin post=${postId} space=${target} admin=${actor.isGlobalAdmin}`);
    const result = await this.postRepo.manager.transaction(async (m) => {
      await this.assertMayPin(m, actor, target);
      await this.lockSpace(m, target);
      await this.assertPostExists(m, postId);
      const [{ pinnable }] = (await m.query(POST_PINNABLE_IN_SPACE_SQL, [postId, target])) as {
        pinnable: boolean;
      }[];
      if (!pinnable) {
        this.logger.log(`[PIN] refused: post ${postId} is not visible in space ${target}`);
        throw new ConflictException({
          code: POST_NOT_IN_SPACE,
          message: 'The post is not visible to the readers of this space',
        });
      }
      const [{ rank, shown }] = (await m.query(PIN_STANDING_IN_SPACE_SQL, [postId, target])) as {
        rank: number | null;
        shown: number;
      }[];
      if (pinStateOf(rank) === 'shown') {
        this.logger.debug(`[PIN] post ${postId} already shown in space ${target}: nothing written`);
        return { ok: true as const, pinned: true, spaceId: target, state: 'shown' as const };
      }
      if (shown >= SPACE_PIN_LIMIT) {
        this.logger.log(
          `[PIN] refused: space ${target} already shows ${shown} pin(s) (post ${postId})`
        );
        throw new ConflictException({
          code: SPACE_PIN_LIMIT_CODE,
          limit: SPACE_PIN_LIMIT,
          message: `This space already shows ${SPACE_PIN_LIMIT} pinned posts - unpin one first`,
        });
      }
      await m.query(
        `INSERT INTO post_space_pins (post_id, space_id, pinned_by) VALUES ($1, $2, $3)
         ON CONFLICT (post_id, space_id) DO NOTHING`,
        [postId, target, actor.userId]
      );
      this.logger.log(`[PIN] post ${postId} pinned in space ${target} (${shown + 1} shown)`);
      return { ok: true as const, pinned: true, spaceId: target, state: 'shown' as const };
    });
    await this.invalidateFeeds();
    return result;
  }

  /**
   * Unpins `postId` from `spaceId`, the space the client named. Unpinning what is not pinned is
   * answered as done. An "en attente" pin of that space is promoted by the shared rank, with nothing
   * to write.
   */
  async unpin(postId: string, actor: PinActor, target: string): Promise<PinResult> {
    this.logger.debug(`[PIN] unpin post=${postId} space=${target} admin=${actor.isGlobalAdmin}`);
    await this.postRepo.manager.transaction(async (m) => {
      await this.assertMayPin(m, actor, target);
      await this.lockSpace(m, target);
      await this.assertPostExists(m, postId);
      await m.query(`DELETE FROM post_space_pins WHERE post_id = $1 AND space_id = $2`, [
        postId,
        target,
      ]);
      this.logger.log(`[PIN] post ${postId} unpinned from space ${target}`);
    });
    await this.invalidateFeeds();
    return { ok: true, pinned: false, spaceId: target, state: null };
  }

  /** The governor's list of a space: its visible pins, the 3 shown first, then the "en attente". */
  async listForSpace(spaceId: string, actor: PinActor): Promise<SpacePinEntry[]> {
    this.logger.debug(`[PIN] list space=${spaceId}`);
    await this.assertMayPin(this.postRepo.manager, actor, spaceId);
    const rows = (await this.postRepo.manager.query(SPACE_PIN_LIST_SQL, [spaceId])) as {
      postId: string;
      pinnedAt: Date;
      rank: number;
    }[];
    return rows.map((r) => ({
      postId: r.postId,
      pinnedAt: r.pinnedAt,
      state: pinStateOf(r.rank) ?? 'pending',
    }));
  }

  /**
   * A typed 404 for a post that does not exist - asked only AFTER the caller is authorised, so an
   * unauthorised caller learns nothing about which posts exist.
   */
  private async assertPostExists(m: EntityManager, postId: string): Promise<void> {
    const rows = (await m.query(`SELECT 1 FROM posts WHERE id = $1`, [postId])) as unknown[];
    if (rows.length === 0) {
      this.logger.log(`[PIN] refused: no post ${postId}`);
      throw new NotFoundException({ code: POST_NOT_FOUND, message: 'Post not found' });
    }
  }

  /** Serialises every pin write of one space (the cap's guarantee). */
  private async lockSpace(m: EntityManager, spaceId: string): Promise<void> {
    await m.query(`SELECT pg_advisory_xact_lock(hashtextextended('post_space_pins:' || $1, 0))`, [
      spaceId,
    ]);
  }

  /**
   * THE FIRST CHECK of every pin surface: a typed 403 for a caller who does not govern the space -
   * an unknown space included, so only the platform admin is told `space_not_found` (404).
   */
  private async assertMayPin(m: EntityManager, actor: PinActor, spaceId: string): Promise<void> {
    const rows = (await m.query(MAY_PIN_IN_SPACE_SQL, [
      actor.userId,
      actor.isGlobalAdmin,
      spaceId,
    ])) as { found: boolean; may: boolean }[];
    if (rows.length === 0 && actor.isGlobalAdmin) {
      this.logger.log(`[PIN] refused: no space ${spaceId}`);
      throw new NotFoundException({ code: SPACE_NOT_FOUND, message: 'Space not found' });
    }
    if (rows.length === 0 || !rows[0].may) {
      this.logger.log(`[PIN] refused: ${actor.userId} does not govern space ${spaceId}`);
      throw this.forbidden();
    }
  }

  /** The one typed 403 of every pin surface. */
  private forbidden(): ForbiddenException {
    return new ForbiddenException({
      code: SPACE_PIN_FORBIDDEN,
      message: "Only the platform admin or a MODERATE holder of this space's BDE pins here",
    });
  }

  /** A pin reorders every reader's feed of that space: the whole cache goes, as for any post write. */
  private async invalidateFeeds(): Promise<void> {
    try {
      await invalidatePostListCache(this.redis);
    } catch (e: unknown) {
      this.logger.warn('[CACHE] feed cache sweep failed after a pin - pages stay stale', e);
    }
  }
}
