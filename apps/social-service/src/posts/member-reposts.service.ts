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
import { acceptedFollowSql } from '../follows/follow-status';
import { PERSON_KEY, decodeFollowCursor, encodeFollowCursor } from '../follows/follow-cursor';
import { clampLimit } from '../follows/follow-requests.service';
import { previewOf } from '../push/push-content';
import {
  NEWLY_REACHED_BY_MEMBER_REPOST_SQL,
  memberRepostCarriesSql,
  memberRepostablePostSql,
  postVisibleToViewerSql,
} from '../spaces/reader-spaces';
import { MemberRepost } from './entities/member-repost.entity';
import { MEMBER_REPOST_NOTIFICATION, PostNotificationsService } from './post-notifications.service';
import { invalidatePostListCacheFor } from './post-list-cache';
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
  /** The author does not consent (their account setting, or the post's own override). */
  notAllowed: 'MEMBER_REPOST_NOT_ALLOWED',
  /** The reposter already reposted this post. */
  already: 'MEMBER_REPOST_ALREADY',
  /** The consent of a post may be set only by its author, on a personal post. */
  notAuthor: 'MEMBER_REPOST_NOT_AUTHOR',
  /**
   * The author asked to remove a repost their list does not show: none by that person, or one by
   * someone a block or the review cohort keeps off the list. ONE answer for both, so the removal
   * is no probe of who reposted.
   */
  notListed: 'MEMBER_REPOST_NOT_LISTED',
} as const;

/** One person on the author's list of who reposted their post (`MemberRepostsService.reposters`). */
export interface ReposterEntry {
  userId: string;
  /** When they reposted it. */
  createdAt: Date;
  /** Opaque: passed back as `after`, the next page starts right after this row (`follow-cursor.ts`). */
  cursor: string;
}

/**
 * The SQL of "repost row `mr` by reposter row `reposter` (a `users` alias) of post row `post` is one
 * its AUTHOR is shown" - on the author's list, in the card's count, and as what the author may
 * remove. It is `memberRepostCarriesSql` asked with the AUTHOR as the reader: the reposter on the
 * author's side of the review cohort, no block either way between them, not muted, and still seeing
 * the post first-hand. So the author learns who reposted only among the people the app otherwise
 * lets them meet, and a stale row - one that reaches nobody - is neither listed nor counted.
 */
export function repostShownToAuthorSql(post: string, mr: string, reposter: string): string {
  return `(${mr}."postId" = ${post}.id AND ${post}."associationId" IS NULL
    AND NOT COALESCE(${post}.anonymous, false)
    AND ${memberRepostCarriesSql(post, reposter, `${post}."authorId"`)})`;
}

/**
 * What may be reposted: a post the reposter sees FIRST-HAND - its own audience, the author's
 * accepted followers, and for an ENTITY post an association carrying it - never only through
 * another member's repost (decided 2026-11-01: no chain, the author's consent covers one step of
 * reach), and never a PERSONAL post seen only through a carrier the author accepted (D38b): that
 * consent covered the carrier's audience, not a second hop to a reader's followers (review of
 * #2965, 2026-11-02). Grant-free and without the administrator's by-id reach, as D38b's request.
 */
export const FIRST_HAND = {
  adminSeesAll: false,
  readGrants: false,
  memberReposts: false,
  personalRepublications: false,
} as const;

export { MEMBER_REPOST_NOTIFICATION };

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
 * The 404 of a repost refused for a post the actor may not act on - absent, withheld, not seen
 * first-hand, or across a block with a personal post's author. ONE answer for all of them, so a
 * refusal never tells the actor which: in particular, never that a block stands (a private gesture,
 * `moderation-and-blocking.md`).
 */
function postNotFound(): NotFoundException {
  return new NotFoundException('Post not found');
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
 * - an ENTITY post (association, list, institution - an allowlist, `MEMBER_REPOSTABLE_ASSOCIATION_TYPES`)
 *   without consent when it addresses at least one space, still reaching only the reposter's ACCEPTED
 *   followers (Q2); never the post of a members-only entity (`memberRepostablePostSql`, owner
 *   2026-11-02, lists admitted the same day: "Oui partout sans exception");
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
   * integration case: absent, hidden, scheduled or expired (404); not seen without a grant, or the
   * post of a members-only entity or of an unlisted type (`memberRepostablePostSql`, owner
   * 2026-11-02) (404, nothing confirmed); anonymous (400); own post (400); a block with a personal post's author
   * (the SAME 404, so the answer does not reveal the block); no consent (403); already reposted
   * (409). A muted actor is refused at the route, and the route is throttled per caller.
   *
   * The answer carries no count of who was reached: the reposter learns nothing about their
   * followers' access from it.
   */
  async repost(postId: string, actorId: string): Promise<{ postId: string }> {
    let recipients: string[] = [];
    let post: PostRow | null = null;
    await this.repo.manager.transaction(async (manager) => {
      post = await this.loadPost(manager, postId);
      if (!post || isWithheldPost(post)) throw postNotFound();
      // Seen FIRST, so nothing below confirms a post the actor cannot see - not even that it is
      // anonymous.
      await this.assertRepostableFirstHand(manager, postId, actorId);
      if (post.anonymous) {
        this.logger.debug(`[REPOST-M] ${postId.slice(0, 8)} refused: anonymous`);
        throw refusal(BadRequestException, MEMBER_REPOST_CODES.anonymous, 'An anonymous post');
      }
      const personal = !post.associationId;
      if (personal && post.authorId === actorId) {
        this.logger.debug(`[REPOST-M] ${postId.slice(0, 8)} refused: the reposter's own post`);
        throw refusal(BadRequestException, MEMBER_REPOST_CODES.ownPost, 'Your own post');
      }
      if (personal && (await isBlockedBetween(manager, actorId, post.authorId))) {
        this.logger.debug(`[REPOST-M] ${postId.slice(0, 8)} refused: a block with its author`);
        throw postNotFound();
      }
      // The consent lock, then the post row: the order `setAccountConsent` / `setPostConsent` take.
      if (personal) await lockAuthorConsent(manager, post.authorId);
      const locked: { feedNotifiedAt: Date | null; consents: boolean }[] = await manager.query(
        `SELECT posts."feedNotifiedAt", ${repostConsentSql('posts')} AS consents
           FROM posts WHERE posts.id = $1 FOR UPDATE`,
        [postId]
      );
      if (locked.length === 0) throw postNotFound();
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
      // AT MOST ONCE PER (post, reader), EVER: the ledger keeps the readers already told about this
      // post through a repost - whoever reposted it, however many times it was taken back - and only
      // the pairs written NOW are told. Durable state, in this transaction; never a clock.
      recipients = await recordNotices(
        manager,
        postId,
        newly.map((r) => r.id)
      );
      this.logger.log(
        `[REPOST-M] ${postId.slice(0, 8)} reposted by ${actorId.slice(0, 8)} ` +
          `(personal=${personal}, announced=${announced}, newly reached=${newly.length}, ` +
          `told=${recipients.length})`
      );
    });
    await this.dropFeedCacheOf([actorId]);
    const reposted = post as unknown as PostRow;
    if (!reposted.associationId) await this.dropAuthorCountOf(reposted.authorId);
    await this.tellNewlyReached(reposted, actorId, recipients);
    return { postId };
  }

  /**
   * The reposter takes their own repost back. 404 when there is none. The post's author is read in
   * the same statement: a personal post's author caches a `repostCount` this changes.
   */
  async unrepost(postId: string, actorId: string): Promise<{ ok: true }> {
    const gone: { authorId: string; associationId: string | null }[] =
      await this.repo.manager.query(
        `WITH gone AS (
           DELETE FROM member_reposts WHERE "postId" = $1 AND "reposterId" = $2 RETURNING "postId")
         SELECT p."authorId", p."associationId" FROM gone JOIN posts p ON p.id = gone."postId"`,
        [postId, actorId]
      );
    if (gone.length === 0) throw new NotFoundException('Repost not found');
    this.logger.log(`[REPOST-M] ${postId.slice(0, 8)} unreposted by ${actorId.slice(0, 8)}`);
    await this.dropFeedCacheOf([actorId]);
    if (!gone[0].associationId) await this.dropAuthorCountOf(gone[0].authorId);
    return { ok: true };
  }

  /**
   * The AUTHOR's list of who reposted their personal post, the most recent first, one page after
   * `after` (keyset on `(repostedAt, reposterId)`, `follow-cursor.ts`). Only the people
   * `repostShownToAuthorSql` lets the author see. Anyone but the author of a personal,
   * non-anonymous post gets the 404 of a post not seen: the list confirms nothing to them.
   */
  async reposters(
    postId: string,
    actorId: string,
    limit: number,
    after: string | undefined
  ): Promise<ReposterEntry[]> {
    const cursor = decodeFollowCursor(after, PERSON_KEY);
    const post = await this.loadPost(this.repo.manager, postId);
    if (!isOwnPersonalPost(post, actorId)) {
      this.logger.debug(`[REPOST-M] ${postId.slice(0, 8)} reposters refused: not its author`);
      throw postNotFound();
    }
    const params: unknown[] = [postId, clampLimit(limit)];
    const afterClause = cursor
      ? `AND (mr."repostedAt", mr."reposterId") < ($${params.push(cursor.at)}::timestamptz, $${params.push(cursor.id)}::varchar)`
      : '';
    const rows: { userId: string; createdAt: Date; sortKey: string }[] =
      await this.repo.manager.query(
        `SELECT mr."reposterId" AS "userId", mr."repostedAt" AS "createdAt",
                mr."repostedAt"::text AS "sortKey"
           FROM member_reposts mr
           JOIN posts p ON p.id = mr."postId"
           JOIN users u ON u.id = mr."reposterId"
          WHERE mr."postId" = $1 AND ${repostShownToAuthorSql('p', 'mr', 'u')}
            ${afterClause}
          ORDER BY mr."repostedAt" DESC, mr."reposterId" DESC
          LIMIT $2`,
        params
      );
    this.logger.debug(
      `[REPOST-M] ${postId.slice(0, 8)} reposters listed to its author: ${rows.length}` +
        (cursor ? ' after a cursor' : '')
    );
    return rows.map(({ userId, createdAt, sortKey }) => ({
      userId,
      createdAt,
      cursor: encodeFollowCursor(sortKey, userId),
    }));
  }

  /**
   * The AUTHOR removes ONE repost of their personal post (owner, 2026-11-02): a plain delete, under
   * the consent lock then the post row - the order `repost` and `setPostConsent` take - so it cannot
   * interleave with a repost or a consent change of the same author. Only a repost the author's
   * list shows may go (`repostShownToAuthorSql`); any other answers ONE typed 404, so the removal
   * tells the author nothing the list does not.
   *
   * The reposter is NOT told: their card simply stops offering "Annuler ma republication", as after
   * a withdrawn consent. They may repost the post again while the author consents - a durable
   * per-person refusal was not asked for; an author who wants no reposts at all withdraws consent on
   * the post. `member_repost_notices` is left alone, as every removal leaves it: a reader told once
   * about this post is never told again, whoever reposts it later.
   */
  async removeRepostAsAuthor(
    postId: string,
    actorId: string,
    reposterId: string
  ): Promise<{ ok: true }> {
    await this.repo.manager.transaction(async (manager) => {
      const post = await this.loadPost(manager, postId);
      if (!isOwnPersonalPost(post, actorId)) {
        this.logger.debug(
          `[REPOST-M] ${postId.slice(0, 8)} author removal refused: not its author`
        );
        throw postNotFound();
      }
      await lockAuthorConsent(manager, actorId);
      await lockPostRow(manager, postId);
      const gone: unknown[] = await manager.query(
        `WITH gone AS (
           DELETE FROM member_reposts mr USING posts p, users u
            WHERE mr."postId" = $1 AND mr."reposterId" = $2
              AND p.id = mr."postId" AND u.id = mr."reposterId"
              AND ${repostShownToAuthorSql('p', 'mr', 'u')}
           RETURNING mr."reposterId")
         SELECT "reposterId" FROM gone`,
        [postId, reposterId]
      );
      if (gone.length === 0) {
        this.logger.debug(`[REPOST-M] ${postId.slice(0, 8)} author removal: no listed repost`);
        throw new NotFoundException({
          code: MEMBER_REPOST_CODES.notListed,
          message: 'Repost not found',
        });
      }
    });
    this.logger.log(
      `[REPOST-M] ${postId.slice(0, 8)} repost by ${reposterId.slice(0, 8)} removed by its author`
    );
    await this.dropFeedCacheOf([actorId, reposterId]);
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
    let reposters: string[] = [];
    await this.repo.manager.transaction(async (manager) => {
      await lockAuthorConsent(manager, userId);
      await manager.query(
        `INSERT INTO user_repost_settings ("userId", "allowReposts", "updatedAt") VALUES ($1, $2, now())
           ON CONFLICT ("userId") DO UPDATE SET "allowReposts" = EXCLUDED."allowReposts", "updatedAt" = now()`,
        [userId, allowReposts]
      );
      if (!allowReposts) {
        const rows: { reposterId: string }[] = await manager.query(
          `WITH gone AS (
             DELETE FROM member_reposts mr USING posts p
              WHERE p.id = mr."postId" AND p."authorId" = $1 AND p."associationId" IS NULL
                AND p."allowReposts" IS NOT TRUE
             RETURNING mr."reposterId")
           SELECT "reposterId" FROM gone`,
          [userId]
        );
        reposters = rows.map((r) => r.reposterId);
      }
    });
    const removed = reposters.length;
    this.logger.log(
      `[REPOST-M] ${userId.slice(0, 8)} account consent=${allowReposts} (removed ${removed})`
    );
    // The author's own cards carry their consent; the removed reposts' audiences lose the posts.
    await this.dropFeedCacheOf([userId, ...reposters]);
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
    let reposters: string[] = [];
    let effective = true;
    await this.repo.manager.transaction(async (manager) => {
      const post = await this.loadPost(manager, postId);
      if (!post || post.authorId !== actorId) throw postNotFound();
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
      if (!effective) reposters = await dropMemberRepostsOf(manager, postId);
    });
    const removed = reposters.length;
    this.logger.log(
      `[REPOST-M] ${postId.slice(0, 8)} override=${allowReposts} effective=${effective} (removed ${removed})`
    );
    await this.dropFeedCacheOf([actorId, ...reposters]);
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

  /** Seen first-hand without a grant, and a post a repost may carry at all - else ONE 404. */
  private async assertRepostableFirstHand(
    manager: EntityManager,
    postId: string,
    actorId: string
  ): Promise<void> {
    const rows: { visible: boolean }[] = await manager.query(
      `SELECT ${postVisibleToViewerSql('posts', '$2', FIRST_HAND)}
              AND ${memberRepostablePostSql('posts')} AS visible
         FROM posts WHERE posts.id = $1`,
      [postId, actorId]
    );
    if (rows[0]?.visible !== true) {
      this.logger.debug(
        `[REPOST-M] ${postId.slice(0, 8)} not repostable first-hand by ${actorId.slice(0, 8)}`
      );
      throw postNotFound();
    }
  }

  /**
   * Drops the AUTHOR's own cached pages after a repost of their personal post is added or taken
   * back: their card carries `repostCount`, and a cached page would show a count the reposter list
   * contradicts for up to the page's TTL. Their followers' pages are untouched - a repost changes
   * nothing they are shown. Best effort, logged.
   */
  private async dropAuthorCountOf(authorId: string): Promise<void> {
    try {
      const dropped = await invalidatePostListCacheFor(this.redis, [authorId]);
      this.logger.debug(`[CACHE] member repost write: ${dropped} page(s) of its author dropped`);
    } catch (e: unknown) {
      this.logger.warn(
        "[CACHE] the author's feed cache was not dropped after a member repost write",
        e
      );
    }
  }

  /**
   * Drops the cached feed pages a repost write can change, and only those: the pages of `people`
   * themselves (a reposter's `repostedByMe`, an author's `repostConsent`) and of each one's ACCEPTED
   * followers - the only readers `memberRepostReachesUserSql` opens a post to through a reposter and
   * the only ones the card names them to; for an author, the readers whose `canRepost` offer on
   * their posts most often reads the consent. Every other reader's page is untouched. What it
   * leaves is that offer on a reader who sees the author's post through a shared space: a hint the
   * write re-checks under the consent lock, stale for at most the page's TTL - as before this
   * narrowing, whose full sweep ran only when rows were removed. Best effort, logged.
   */
  private async dropFeedCacheOf(people: string[]): Promise<void> {
    const unique = [...new Set(people)];
    try {
      const followers: { id: string }[] = await this.repo.manager.query(
        `SELECT DISTINCT uf."followerUserId" AS id FROM user_follows uf
          WHERE uf."followedUserId" = ANY($1::text[]) AND ${acceptedFollowSql('uf')}`,
        [unique]
      );
      const dropped = await invalidatePostListCacheFor(this.redis, [
        ...unique,
        ...followers.map((f) => f.id),
      ]);
      this.logger.debug(
        `[CACHE] member repost write: ${dropped} feed page(s) of ${unique.length} person(s) ` +
          `and ${followers.length} follower(s) dropped`
      );
    } catch (e: unknown) {
      this.logger.warn('[CACHE] feed cache drop failed after a member repost write', e);
    }
  }
}

/**
 * Writes the (post, reader) pairs of `recipientIds` not yet in `member_repost_notices` and answers
 * those readers - the ones to tell now. A pair already present is a reader told before, by any
 * repost of this post, and is told nothing again.
 */
async function recordNotices(
  manager: EntityManager,
  postId: string,
  recipientIds: string[]
): Promise<string[]> {
  if (recipientIds.length === 0) return [];
  const rows: { recipientId: string }[] = await manager.query(
    `INSERT INTO member_repost_notices ("postId", "recipientId")
     SELECT $1, r FROM unnest($2::text[]) AS r
     ON CONFLICT DO NOTHING RETURNING "recipientId"`,
    [postId, [...new Set(recipientIds)]]
  );
  return rows.map((r) => r.recipientId);
}

/**
 * `post` is a personal, non-anonymous post `actorId` wrote - the only kind whose reposters its
 * author is shown and may remove. An entity post's `authorId` is the officer who wrote it in the
 * association's name: it has no consent to give, and no reposter list either.
 */
function isOwnPersonalPost(post: PostRow | null, actorId: string): boolean {
  return !!post && post.authorId === actorId && !post.associationId && !post.anonymous;
}

/** An HTTP refusal carrying a stable `code` - the client maps the code, never the message. */
function refusal(
  Kind: typeof BadRequestException | typeof ConflictException | typeof ForbiddenException,
  code: string,
  message: string
) {
  return new Kind({ code, message });
}
