import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type EntityManager } from 'typeorm';
import { isBlockedBetween } from '../common/user-blocks';
import { RedisService } from '../common/redis/redis.service';
import { previewOf } from '../push/push-content';
import {
  NEWLY_REACHED_BY_MEMBER_REPOST_SQL,
  postVisibleToViewerSql,
} from '../spaces/reader-spaces';
import { MemberRepost } from './entities/member-repost.entity';
import { PostNotificationsService } from './post-notifications.service';
import { invalidatePostListCache } from './post-list-cache';
import { dropMemberRepostsOf, lockPostRow } from './republication-sql';
import { isWithheldPost, type PostRow } from './republications.service';

/**
 * The stable codes a member-repost refusal carries, which the client maps to its own sentence -
 * never the message, which is developer prose.
 */
export const MEMBER_REPOST_CODES = {
  /** An anonymous post: a repost would tie it to the small, known set its reposter follows. */
  anonymous: 'MEMBER_REPOST_ANONYMOUS',
  /** The reposter wrote the post: their followers already see it. */
  ownPost: 'MEMBER_REPOST_OWN_POST',
  /** A block stands between the reposter and the author, in either direction. */
  blocked: 'MEMBER_REPOST_BLOCKED',
  /** The author does not consent (their account setting, or the post's own override). */
  notAllowed: 'MEMBER_REPOST_NOT_ALLOWED',
  /** The reposter already reposted this post. */
  already: 'MEMBER_REPOST_ALREADY',
  /** The consent of a post may be set only by its author, on a personal post. */
  notAuthor: 'MEMBER_REPOST_NOT_AUTHOR',
} as const;

/** The notification type of a repost reaching a reader for the first time. */
export const MEMBER_REPOST_NOTIFICATION = 'member_repost';

/** The author's consent on one post, as the author's own card shows it. */
export interface RepostConsent {
  /** The post's own override; null follows the account setting. */
  override: boolean | null;
  /** What applies now: the override, else the account setting (ON by default). */
  effective: boolean;
}

/**
 * The SQL of "the author of post row `post` consents to a member repost of it" (WP-F6, owner
 * 2026-11-01): an ENTITY post always (Q2, no consent asked); a personal post by its own override,
 * else its author's account setting, else ON (no settings row = the default).
 */
export function repostConsentSql(post: string): string {
  return `(${post}."associationId" IS NOT NULL OR COALESCE(${post}."allowReposts",
    (SELECT rc_set."allowReposts" FROM user_repost_settings rc_set WHERE rc_set."userId" = ${post}."authorId"),
    true))`;
}

/**
 * The block's half of the cascade: the reposts EITHER person made of the OTHER's PERSONAL posts.
 * An entity post is left alone on purpose - its `authorId` is the officer who wrote it in the
 * association's name, and a repost vanishing when its reposter blocked that officer would tell the
 * reposter who wrote it. The reader predicate checks the same blocks, so a severing this misses
 * (it is best-effort, called from core-service) opens nothing.
 */
export async function severMemberRepostsBetween(
  manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  userA: string,
  userB: string
): Promise<number> {
  const result = await manager.query(
    `DELETE FROM member_reposts mr USING posts p
      WHERE p.id = mr."postId" AND p."associationId" IS NULL
        AND ((mr."reposterId" = $1 AND p."authorId" = $2)
          OR (mr."reposterId" = $2 AND p."authorId" = $1))`,
    [userA, userB]
  );
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}

/**
 * The author's consent lock: every write that reads or changes a person's consent - a repost of one
 * of their personal posts, their account setting, a post override - takes it first (then the post
 * row, for the writes that have one), so a repost cannot read "yes" while a "no" deletes the rows
 * it is about to add. Transaction-scoped, released at commit.
 */
async function lockAuthorConsent(manager: EntityManager, authorId: string): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `member-repost:author:${authorId}`,
  ]);
}

/**
 * MEMBER REPOSTS (WP-F6, decisions 1 and Q2 of the follow requests, user 2026-10-25; consent shape,
 * owner 2026-11-01). A PERSON republishes a post to THEIR OWN ACCEPTED followers, reels included:
 *
 * - a PERSONAL post with its author's consent - an account setting "Autoriser mes abonnes a republier
 *   mes posts", ON by default, and a per-post override either way;
 * - an ENTITY post (association, list, institution) without consent, still reaching only the
 *   reposter's ACCEPTED followers (Q2);
 * - never an anonymous post; never across a block, both ways;
 * - a post the reposter sees WITHOUT a read grant and without the administrator's by-id reach (the
 *   same predicate D38b's request passes).
 *
 * The row is `member_reposts`; the reader predicate (`memberRepostReachesUserSql`) does the rest.
 * WHO IS TOLD: only the readers who see the post for the FIRST time (the D38 rule), computed on
 * state under the post row's lock (`NEWLY_REACHED_BY_MEMBER_REPOST_SQL`), never on a clock.
 *
 * REMOVAL: hiding the post (`dropMemberRepostsOf`), deleting it (foreign key), the reposter's or the
 * author's erasure, a block between reposter and author (`severMemberRepostsBetween`), and a
 * withdrawn consent (the setting or the override turned off) - each deletes the rows.
 */
@Injectable()
export class MemberRepostsService {
  private readonly logger = new Logger(MemberRepostsService.name);

  constructor(
    @InjectRepository(MemberRepost) private readonly repo: Repository<MemberRepost>,
    private readonly notifications: PostNotificationsService,
    private readonly redis: RedisService
  ) {}

  /**
   * `actorId` reposts `postId` to their accepted followers. Refusals, in this order, each with an
   * integration case: absent, hidden, scheduled or expired (404); not seen without a grant (404,
   * nothing confirmed); anonymous (400); own post (400); a block with a personal post's author
   * (403); no consent (403); already reposted (409). A muted actor is refused at the route.
   */
  async repost(postId: string, actorId: string): Promise<{ postId: string; newlyReached: number }> {
    let recipients: string[] = [];
    let post: PostRow | null = null;
    await this.repo.manager.transaction(async (manager) => {
      post = await this.loadPost(manager, postId);
      if (!post || isWithheldPost(post)) throw new NotFoundException('Post not found');
      // Seen FIRST, so nothing below confirms a post the actor cannot see - not even that it is
      // anonymous.
      await this.assertVisibleWithoutGrant(manager, postId, actorId);
      if (post.anonymous) {
        this.logger.debug(`[REPOST-M] ${postId.slice(0, 8)} refused: anonymous`);
        throw refusal(BadRequestException, MEMBER_REPOST_CODES.anonymous, 'An anonymous post');
      }
      const personal = !post.associationId;
      if (personal && post.authorId === actorId) {
        throw refusal(BadRequestException, MEMBER_REPOST_CODES.ownPost, 'Your own post');
      }
      if (personal && (await isBlockedBetween(manager, actorId, post.authorId))) {
        this.logger.debug(`[REPOST-M] ${postId.slice(0, 8)} refused: a block with its author`);
        throw refusal(ForbiddenException, MEMBER_REPOST_CODES.blocked, 'A block stands');
      }
      // The consent lock, then the post row: the order `setAccountConsent` / `setPostConsent` take.
      if (personal) await lockAuthorConsent(manager, post.authorId);
      const locked: { feedNotifiedAt: Date | null; consents: boolean }[] = await manager.query(
        `SELECT posts."feedNotifiedAt", ${repostConsentSql('posts')} AS consents
           FROM posts WHERE posts.id = $1 FOR UPDATE`,
        [postId]
      );
      if (locked.length === 0) throw new NotFoundException('Post not found');
      if (locked[0].consents !== true) {
        this.logger.debug(`[REPOST-M] ${postId.slice(0, 8)} refused: its author does not consent`);
        throw refusal(ForbiddenException, MEMBER_REPOST_CODES.notAllowed, 'Reposts not allowed');
      }
      const announced = locked[0].feedNotifiedAt !== null;
      // Asked BEFORE the row exists: "after minus before". An entity post not yet announced is
      // announced to everyone who sees it by then, these readers included - told nothing here.
      const tell = personal || announced;
      const newly: { id: string }[] = tell
        ? await manager.query(NEWLY_REACHED_BY_MEMBER_REPOST_SQL, [postId, actorId])
        : [];
      const inserted: unknown[] = await manager.query(
        `INSERT INTO member_reposts ("postId", "reposterId") VALUES ($1, $2)
           ON CONFLICT DO NOTHING RETURNING "postId"`,
        [postId, actorId]
      );
      if (inserted.length === 0) {
        throw refusal(ConflictException, MEMBER_REPOST_CODES.already, 'Already reposted');
      }
      recipients = newly.map((r) => r.id);
      this.logger.log(
        `[REPOST-M] ${postId.slice(0, 8)} reposted by ${actorId.slice(0, 8)} ` +
          `(personal=${personal}, announced=${announced}, newly reached=${recipients.length})`
      );
    });
    await this.dropFeedCache();
    await this.tellNewlyReached(post as unknown as PostRow, actorId, recipients);
    return { postId, newlyReached: recipients.length };
  }

  /** The reposter takes their own repost back. 404 when there is none. */
  async unrepost(postId: string, actorId: string): Promise<{ ok: true }> {
    const result: unknown = await this.repo.manager.query(
      `DELETE FROM member_reposts WHERE "postId" = $1 AND "reposterId" = $2`,
      [postId, actorId]
    );
    const removed = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    if (removed === 0) throw new NotFoundException('Repost not found');
    this.logger.log(`[REPOST-M] ${postId.slice(0, 8)} unreposted by ${actorId.slice(0, 8)}`);
    await this.dropFeedCache();
    return { ok: true };
  }

  /** The caller's account-wide consent; no row is the default, ON. */
  async accountConsent(userId: string): Promise<{ allowReposts: boolean }> {
    const rows: { allowReposts: boolean }[] = await this.repo.manager.query(
      `SELECT "allowReposts" FROM user_repost_settings WHERE "userId" = $1`,
      [userId]
    );
    return { allowReposts: rows[0]?.allowReposts ?? true };
  }

  /**
   * Sets the caller's account-wide consent. Turning it OFF withdraws it at once: every repost of
   * their personal posts that has no override saying yes is deleted, in the same transaction, under
   * the consent lock a repost takes - so no repost outlives the "no".
   */
  async setAccountConsent(
    userId: string,
    allowReposts: boolean
  ): Promise<{ allowReposts: boolean; removed: number }> {
    let removed = 0;
    await this.repo.manager.transaction(async (manager) => {
      await lockAuthorConsent(manager, userId);
      await manager.query(
        `INSERT INTO user_repost_settings ("userId", "allowReposts", "updatedAt") VALUES ($1, $2, now())
           ON CONFLICT ("userId") DO UPDATE SET "allowReposts" = EXCLUDED."allowReposts", "updatedAt" = now()`,
        [userId, allowReposts]
      );
      if (!allowReposts) {
        const result: unknown = await manager.query(
          `DELETE FROM member_reposts mr USING posts p
            WHERE p.id = mr."postId" AND p."authorId" = $1 AND p."associationId" IS NULL
              AND p."allowReposts" IS NOT TRUE`,
          [userId]
        );
        removed = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
      }
    });
    this.logger.log(
      `[REPOST-M] ${userId.slice(0, 8)} account consent=${allowReposts} (removed ${removed})`
    );
    if (removed > 0) await this.dropFeedCache();
    return { allowReposts, removed };
  }

  /**
   * Sets one post's override (`null` follows the account setting again). Only the AUTHOR of a
   * PERSONAL post may: an entity post has no consent to give (404 to anyone else - the refusal
   * confirms nothing). An override that leaves the post without consent deletes its reposts.
   */
  async setPostConsent(
    postId: string,
    actorId: string,
    allowReposts: boolean | null
  ): Promise<RepostConsent & { removed: number }> {
    let removed = 0;
    let effective = true;
    await this.repo.manager.transaction(async (manager) => {
      const post = await this.loadPost(manager, postId);
      if (!post || post.authorId !== actorId) throw new NotFoundException('Post not found');
      if (post.associationId) {
        throw refusal(BadRequestException, MEMBER_REPOST_CODES.notAuthor, 'Not a personal post');
      }
      await lockAuthorConsent(manager, actorId);
      await lockPostRow(manager, postId);
      await manager.query(`UPDATE posts SET "allowReposts" = $2 WHERE id = $1`, [
        postId,
        allowReposts,
      ]);
      const rows: { consents: boolean }[] = await manager.query(
        `SELECT ${repostConsentSql('posts')} AS consents FROM posts WHERE posts.id = $1`,
        [postId]
      );
      effective = rows[0]?.consents === true;
      if (!effective) removed = await dropMemberRepostsOf(manager, postId);
    });
    this.logger.log(
      `[REPOST-M] ${postId.slice(0, 8)} override=${allowReposts} effective=${effective} (removed ${removed})`
    );
    if (removed > 0) await this.dropFeedCache();
    return { override: allowReposts, effective, removed };
  }

  /** "X a relaye une publication": to the readers the repost reached first. Best effort. */
  private async tellNewlyReached(
    post: PostRow,
    actorId: string,
    recipientIds: string[]
  ): Promise<void> {
    if (recipientIds.length === 0) return;
    try {
      await this.notifications.createNotifications({
        recipientIds,
        type: MEMBER_REPOST_NOTIFICATION,
        postId: post.id,
        actorId,
        text: previewOf(post.markdown ?? ''),
        pushData: { postId: post.id },
      });
    } catch (e: unknown) {
      // The repost is committed; what a failure loses is the notification, and this line is all
      // that loss leaves.
      this.logger.warn(`[REPOST-M] ${post.id} reposted but its new readers were not told`, e);
    }
  }

  private async loadPost(manager: EntityManager, postId: string): Promise<PostRow | null> {
    const rows: PostRow[] = await manager.query(
      `SELECT id, "authorId", "associationId", COALESCE(anonymous, false) AS anonymous,
              "hiddenByModeration", "scheduledAt", kind, "expiresAt", markdown
         FROM posts WHERE id = $1`,
      [postId]
    );
    return rows[0] ?? null;
  }

  private async assertVisibleWithoutGrant(
    manager: EntityManager,
    postId: string,
    actorId: string
  ): Promise<void> {
    const rows: { visible: boolean }[] = await manager.query(
      `SELECT ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: false, readGrants: false })} AS visible
         FROM posts WHERE posts.id = $1`,
      [postId, actorId]
    );
    if (rows[0]?.visible !== true) {
      this.logger.debug(`[REPOST-M] ${postId.slice(0, 8)} not visible to ${actorId.slice(0, 8)}`);
      throw new NotFoundException('Post not found');
    }
  }

  private async dropFeedCache(): Promise<void> {
    try {
      await invalidatePostListCache(this.redis);
    } catch (e: unknown) {
      this.logger.warn('[CACHE] feed cache sweep failed after a member repost', e);
    }
  }
}

/** An HTTP refusal carrying a stable `code` - the client maps the code, never the message. */
function refusal(
  Kind: typeof BadRequestException | typeof ConflictException | typeof ForbiddenException,
  code: string,
  message: string
) {
  return new Kind({ code, message });
}
