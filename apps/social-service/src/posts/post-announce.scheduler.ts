import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThanOrEqual } from 'typeorm';
import { Post } from './entities/post.entity';
import { PostNotificationsService } from './post-notifications.service';
import { previewOf } from '../push/push-content';
import { announceRecipientsSql } from '../spaces/reader-spaces';

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
 * one sweeper: an association's post goes to everyone who can SEE THAT POST, a person's post goes
 * to those of that person's followers who can see it.
 *
 * WHO CAN SEE A POST IS `postVisibleToUserSql` (WP6b, `spaces/reader-spaces.ts`) - the same
 * predicate every read applies, so a notification never points at a post its recipient would get
 * a 404 for. Until WP6b it was "everyone who can see the feed", because every post went to all of
 * it. FOLLOWING an association still adds nothing to what you are told: everyone the association
 * reaches is told already, and `association_follows` is deliberately not consulted here.
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
      order: { publishedAt: 'ASC' },
      take: ANNOUNCE_BATCH,
    });
    if (pending.length === 0) return;

    let announced = 0;
    let reached = 0;
    for (const post of pending) {
      try {
        // BEFORE the send. See the class docblock.
        const recipientIds = await this.stampAndReadRecipients(post);
        const count = post.associationId
          ? await this.announceAssociationPost(post, recipientIds)
          : await this.announcePersonalPost(post, recipientIds);
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
   * An association published: everyone who can see this post is told.
   *
   * The actor NAME is the association's, while the actor ID stays the member who pressed publish -
   * `createNotifications` excludes the actor from its own recipients, and an officer being told
   * about their own association's post is exactly what that exclusion is for.
   */
  private async announceAssociationPost(post: Post, recipientIds: string[]): Promise<number> {
    const rows: unknown = await this.postRepo.manager.query(
      `SELECT name, "logoUrl", "logoMediaId" FROM associations WHERE id = $1`,
      [post.associationId]
    );
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    const name = row ? String(row.name ?? '') : '';
    if (!name) {
      // Not a fallback into a generic sentence: an association with no name is a broken row, and
      // announcing it as "quelqu'un" would hide that. The post stays stamped and nobody is told.
      throw new Error(`association ${post.associationId} has no name`);
    }
    return this.notifications.createNotifications({
      recipientIds,
      type: 'association_post',
      postId: post.id,
      actorId: post.authorId,
      actorName: name,
      // The association's OWN identity, not `actorId` above (the publishing member) - see
      // `PostNotification`'s docblock for why the row needs both.
      associationId: post.associationId,
      // BOTH, and they are not the same fact. The URL is what the in-app notification row shows;
      // the id is what a push may concatenate, and deriving one from the other is what showed a
      // member's face on 40 of 91 associations - see `publicMediaIconId`.
      associationLogoUrl: row?.logoUrl ?? null,
      associationLogoMediaId: row?.logoMediaId ?? null,
      text: previewOf(post.markdown ?? ''),
      pushData: { postId: post.id },
    });
  }

  /**
   * A person published: the people who follow them are told, and nobody else.
   *
   * NEVER for an anonymous post - not masked, SKIPPED. Masking the actor is what a post's own
   * card does when read, and that is enough there because the feed audience is "everyone". A
   * follower's candidate set is not everyone: `announcePersonalPost` exists at all only because
   * this reader follows a small, known set of people, so a masked notification would still say
   * "one of the few accounts you follow just posted anonymously" - which narrows the author down
   * by exactly the fact this notification carries, whatever name is on it. The only fix that
   * removes the signal is to never announce it.
   */
  private async announcePersonalPost(post: Post, recipientIds: string[]): Promise<number> {
    if (post.anonymous) return 0;
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

  /**
   * Stamps `post` and reads who to tell - everyone who can see it, minus its author, narrowed to
   * the author's followers for a personal post (the rule is in `spaces/reader-spaces.ts`) - IN ONE
   * TRANSACTION, so the post row stays locked from the stamp to the read.
   *
   * A republication (`republications.service.ts`) takes the same row lock before it decides
   * whether the post was already announced. Either it commits first, and this read already counts
   * its audience, or it waits for this one, sees the stamp, and tells the readers it newly reaches
   * itself. Without the lock a republication landing between the stamp and the read would be
   * announced twice to the same reader.
   *
   * An anonymous personal post is stamped and nobody is asked about: see `announcePersonalPost`.
   */
  private stampAndReadRecipients(post: Post): Promise<string[]> {
    return this.postRepo.manager.transaction(async (manager) => {
      await manager.update(Post, post.id, { feedNotifiedAt: new Date() });
      if (!post.associationId && post.anonymous) return [];
      const rows: unknown = await manager.query(announceRecipientsSql(!post.associationId), [
        post.id,
      ]);
      return Array.isArray(rows) ? rows.map((r) => String(r.id)) : [];
    });
  }
}
