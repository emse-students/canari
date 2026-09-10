import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThanOrEqual } from 'typeorm';
import { Post } from './entities/post.entity';
import { PostNotificationsService } from './post-notifications.service';
import { previewOf } from '../push/push-content';
import { FEED_AUDIENCE_IDS_SQL } from './feed-audience';

/**
 * HOW MANY UNANNOUNCED POSTS ONE TICK TAKES.
 *
 * The steady state is zero or one: the measured rate on the 2026-09-10 copy of production is 7.01
 * posts a week in total and 0.53 of them from an association, against a sweep every minute. The
 * bound is therefore not a rate limit, it is what keeps a MISTAKE cheap - if migration 058's
 * backfill were ever skipped, the archive would look unannounced, and this is the difference
 * between announcing 25 posts and announcing all of them.
 */
const ANNOUNCE_BATCH = 25;

/**
 * NOBODY WAS TOLD ABOUT A POST. This is the thing that tells them.
 *
 * Reported by the user on 2026-09-10 as two asks in one breath - *"Les gens doivent avoir une
 * notif pour tous les posts d'associations"* and *"...pour tous les posts de gens ou d'assos
 * qu'ils suivent"*. They are ONE mechanism with TWO recipient derivations, which is why they are
 * one sweeper: an association's post goes to everyone who can see the feed, a person's post goes
 * to that person's followers.
 *
 * NOTE THAT THE FIRST ASK SUBSUMES HALF OF THE SECOND. If every association post reaches the whole
 * feed audience, then FOLLOWING an association adds nothing to what you are told, and
 * `association_follows` is deliberately not consulted here. It would become the opt-in the moment
 * the first rule is ever narrowed - which is the one change that would make this file need a third
 * derivation rather than a different one.
 *
 * WHY A SWEEPER AND NOT A CALL IN `createPost`. Two reasons, and the second is the real one.
 * `scheduledAt` exists on `posts` and **nothing has ever published a scheduled post** - the column
 * appears only inside a `WHERE` clause - so a post can become visible without any request
 * happening at the moment it does. And a notification sent inline is a notification that a
 * rollback silently keeps: the announcement has to be decided from the row's committed state, not
 * from the code path that wrote it.
 *
 * IDEMPOTENCE COMES FROM `feedNotifiedAt` AND FROM NOTHING ELSE - not from a window, not from the
 * cron's period. It is stamped BEFORE the notifications go out, the same trade
 * `forms-reminder.scheduler.ts` documents: a crash between the stamp and the send loses one
 * announcement, where the other order would re-announce on every tick for as long as it kept
 * failing. Losing a notification is recoverable by a human; a push loop is not.
 */
@Injectable()
export class PostAnnounceScheduler {
  private readonly logger = new Logger(PostAnnounceScheduler.name);

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly notifications: PostNotificationsService
  ) {}

  @Cron('* * * * *')
  async announcePosts(): Promise<void> {
    const now = new Date();
    // Two `where` objects and not one, because they differ only in `scheduledAt` and TypeORM has
    // no OR inside a single object. An array is an OR of the whole clause, so every other
    // condition is repeated deliberately rather than by accident.
    const common = { feedNotifiedAt: IsNull(), hiddenByModeration: false } as const;
    const pending = await this.postRepo.find({
      where: [
        { ...common, scheduledAt: IsNull() },
        { ...common, scheduledAt: LessThanOrEqual(now) },
      ],
      order: { createdAt: 'ASC' },
      take: ANNOUNCE_BATCH,
    });
    if (pending.length === 0) return;

    let announced = 0;
    let reached = 0;
    for (const post of pending) {
      try {
        // BEFORE the send. See the class docblock.
        await this.postRepo.update(post.id, { feedNotifiedAt: new Date() });
        const count = post.associationId
          ? await this.announceAssociationPost(post)
          : await this.announcePersonalPost(post);
        announced++;
        reached += count;
        this.logger.log(
          `[ANNOUNCE] post=${post.id.slice(0, 8)} ` +
            `kind=${post.associationId ? 'association' : 'personal'} recipients=${count}`
        );
      } catch (e: unknown) {
        // Per post: one association whose name cannot be read must not silence the other posts in
        // the batch. The row is already stamped, so this post is not retried - which is the
        // deliberate half of the trade above, and why the loss is logged loudly enough to find.
        this.logger.warn(`[ANNOUNCE] failed for post=${post.id}`, e);
      }
    }
    this.logger.log(`[ANNOUNCE] swept: posts=${announced}/${pending.length} recipients=${reached}`);
  }

  /**
   * An association published: everyone who can see the feed is told.
   *
   * The actor NAME is the association's, while the actor ID stays the member who pressed publish -
   * `createNotifications` excludes the actor from its own recipients, and an officer being told
   * about their own association's post is exactly what that exclusion is for.
   */
  private async announceAssociationPost(post: Post): Promise<number> {
    const rows: unknown = await this.postRepo.manager.query(
      `SELECT name FROM associations WHERE id = $1`,
      [post.associationId]
    );
    const name = Array.isArray(rows) && rows.length > 0 ? String(rows[0].name ?? '') : '';
    if (!name) {
      // Not a fallback into a generic sentence: an association with no name is a broken row, and
      // announcing it as "quelqu'un" would hide that. The post stays stamped and nobody is told.
      throw new Error(`association ${post.associationId} has no name`);
    }
    const recipientIds = await this.audienceIds();
    return this.notifications.createNotifications({
      recipientIds,
      type: 'association_post',
      postId: post.id,
      actorId: post.authorId,
      actorName: name,
      text: previewOf(post.markdown ?? ''),
      pushData: { postId: post.id },
    });
  }

  /** A person published: the people who follow them are told, and nobody else. */
  private async announcePersonalPost(post: Post): Promise<number> {
    const rows: unknown = await this.postRepo.manager.query(
      `SELECT "followerUserId" FROM user_follows WHERE "followedUserId" = $1`,
      [post.authorId]
    );
    const recipientIds = Array.isArray(rows) ? rows.map((r) => String(r.followerUserId)) : [];
    if (recipientIds.length === 0) return 0;
    return this.notifications.createNotifications({
      recipientIds,
      type: 'followed_post',
      postId: post.id,
      actorId: post.authorId,
      text: previewOf(post.markdown ?? ''),
      pushData: { postId: post.id },
    });
  }

  /** Everyone the feed is visible to. The rule itself is in `feed-audience.ts`, stated once. */
  private async audienceIds(): Promise<string[]> {
    const rows: unknown = await this.postRepo.manager.query(FEED_AUDIENCE_IDS_SQL);
    return Array.isArray(rows) ? rows.map((r) => String(r.id)) : [];
  }
}
