/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Post } from './entities/post.entity';
import { sameSideOfReviewCohort } from '../review-cohort';
import { isUnsafeObjectKey, withOwnEntry } from '../common/object-keys';
import {
  ANONYMOUS_NOTIFICATION_ACTOR_ID,
  ANONYMOUS_NOTIFICATION_ACTOR_NAME,
  PostNotificationsService,
} from './post-notifications.service';
import { PushService } from '../push/push.service';
import { isAnonymousPoll, recordAnonymousVote } from './anonymous-poll';
import { CommentIdentityService, commentIdentityOf, commentRights } from './comment-identity';
import { PostMediaRetentionService, commentMediaIds } from './post-media-retention.service';
import { isExpiredReel } from './reel.constants';
import {
  reactionContent,
  reactionTypeToEmoji,
  commentContent,
  replyContent,
  mentionContent,
  previewOf,
} from '../push/push-content';

/** Handles reactions, comments, polls, and form submissions on posts. */
@Injectable()
export class PostInteractionsService {
  private readonly logger = new Logger(PostInteractionsService.name);

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly notifications: PostNotificationsService,
    private readonly push: PushService,
    private readonly mediaRetention: PostMediaRetentionService,
    private readonly identity: CommentIdentityService
  ) {}

  /**
   * Copies a reactions map into a null-prototype object to prevent prototype-pollution
   * attacks where a user ID like "__proto__" could shadow Object properties.
   *
   * @see isUnsafeObjectKey - the list this spelled out, which differed from the three other copies.
   */
  private sanitizeReactions(
    raw: Record<string, string> | null | undefined
  ): Record<string, string> {
    const out = Object.create(null) as Record<string, string>;
    if (!raw || typeof raw !== 'object') return out;
    for (const key of Object.keys(raw)) {
      if (isUnsafeObjectKey(key)) continue;
      out[key] = raw[key];
    }
    return out;
  }

  /** Sets or replaces the reaction emoji for a user on a post (one reaction per user). */
  async addReaction(postId: string, userId: string, reactionType: string) {
    if (isUnsafeObjectKey(userId)) {
      throw new BadRequestException('Invalid userId');
    }
    const post = await this.postRepo.findOne({ where: { id: postId } });
    // A reel past its expiry is dead to every reader until the worker removes it; a reaction on it
    // would be content nobody can ever see.
    if (!post || isExpiredReel(post)) throw new NotFoundException('Post not found');
    const reactions = this.sanitizeReactions(post.reactions);
    const isNew = !reactions[userId];
    reactions[userId] = reactionType;
    post.reactions = reactions;
    await this.postRepo.save(post);

    // Notify post author of a new reaction (not for self-reactions or changes), never across the
    // review cohort's boundary (review-cohort.ts).
    if (
      isNew &&
      post.authorId &&
      post.authorId !== userId &&
      sameSideOfReviewCohort(userId, post.authorId)
    ) {
      void (async () => {
        try {
          const actorName = await this.notifications.resolveActorName(userId);
          await this.notifications.createNotification({
            recipientId: post.authorId,
            type: 'reaction',
            postId,
            actorId: userId,
            text: reactionType,
            skipPush: true,
          });
          // THE ACTOR'S FACE, AND THE EMOJI RATHER THAN THE STORED LABEL: this push carried
          // neither (user, 2026-10-08 - six faceless "a réagi Marteau" for one post).
          await this.push.notifyContent(
            post.authorId,
            reactionContent(actorName, reactionTypeToEmoji(reactionType), {
              kind: 'user',
              userId,
            }),
            {
              type: 'social',
              postId,
            }
          );
        } catch (e) {
          this.logger.warn(
            `[NOTIFY] reaction notification failed for post.authorId=${post.authorId}`,
            e
          );
        }
      })();
    }

    return { ok: true, reactions: post.reactions };
  }

  /** Removes the user's reaction from a post. */
  async removeReaction(postId: string, userId: string) {
    if (isUnsafeObjectKey(userId)) {
      throw new BadRequestException('Invalid userId');
    }
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const reactions = this.sanitizeReactions(post.reactions);
    delete reactions[userId];
    post.reactions = reactions;
    await this.postRepo.save(post);
    return { ok: true, reactions: post.reactions };
  }

  /**
   * Appends a comment to a post. Fires notifications fire-and-forget style: the post author gets
   * a "comment" notification; the parent comment author gets a "reply".
   *
   * `data.anonymous` / `data.associationId` say who the comment speaks as (`comment-identity.ts`).
   * The caller has already checked the right to speak for an association. EITHER WAY the REAL
   * `userId` is stored - mute, report and erasure act on the account - but then NO NAME is: a
   * name in `post.comments` would reach every reader of the array. Notifications are masked HERE,
   * at the write, because a notification row has no read-time shaping.
   *
   * @returns the comment as its writer is to see it.
   */
  async addComment(
    postId: string,
    data: {
      userId: string;
      text?: string;
      parentId?: string;
      media?: any;
      anonymous?: boolean;
      associationId?: string;
    },
    isGlobalAdmin = false
  ) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post || isExpiredReel(post)) throw new NotFoundException('Post not found');

    const { anonymous, associationId } = commentIdentityOf(data);
    const masked = anonymous || !!associationId;

    let displayName: string | null = null;
    let firstName: string | null = null;
    let lastName: string | null = null;
    if (!masked) {
      try {
        const rows: any[] = await this.postRepo.manager.query(
          `SELECT "displayName", "firstName", "lastName" FROM users WHERE id = $1 LIMIT 1`,
          [data.userId]
        );
        if (rows[0]) {
          ({ displayName = null, firstName = null, lastName = null } = rows[0]);
        }
      } catch {
        /* non-fatal */
      }
    }

    const existingComments: any[] = post.comments ?? [];

    // Validate parentId references an actual comment on this post.
    if (data.parentId) {
      const parent = existingComments.find((c: any) => c.id === data.parentId);
      if (!parent) throw new NotFoundException('Parent comment not found');

      // Enforce max nesting depth of 3 to prevent DoS via deeply nested threads.
      let depth = 1;
      let current = parent;
      while (current?.parentId) {
        current = existingComments.find((c: any) => c.id === current.parentId);
        depth++;
        if (depth >= 3)
          throw new BadRequestException('Comment nesting limit reached (max 3 levels)');
      }
    }

    const comment = {
      id: crypto.randomUUID(),
      userId: data.userId,
      ...(masked ? {} : { displayName, firstName, lastName }),
      ...(anonymous ? { anonymous: true } : {}),
      ...(associationId ? { associationId } : {}),
      text: data.text ?? '',
      parentId: data.parentId ?? null,
      likes: [] as string[],
      createdAt: new Date().toISOString(),
      ...(data.media ? { media: data.media } : {}),
    };
    post.comments = [...existingComments, comment];
    await this.postRepo.save(post);

    // Fire-and-forget: notify the post author (also for an association post), the parent comment
    // author, and mentioned users.
    // Each recipient is isolated in its own try/catch so that a DB failure for one
    // recipient does not prevent the others from being notified.
    void (async () => {
      const text = data.text ?? (data.media ? '📷 Image' : '');
      const preview = previewOf(text);
      // The stored row keeps its mention tokens for the app to resolve; a push cannot.
      const pushPreview = await this.notifications.renderMentionsForPush(preview);
      // WHO THE NOTICE SAYS IT IS FROM: nobody for an anonymous comment, the association for an
      // association's. The real id still keeps the writer out of their own notices below.
      let actorId = data.userId;
      let actorName: string;
      if (anonymous) {
        actorId = ANONYMOUS_NOTIFICATION_ACTOR_ID;
        actorName = ANONYMOUS_NOTIFICATION_ACTOR_NAME;
      } else if (associationId) {
        actorId = ANONYMOUS_NOTIFICATION_ACTOR_ID;
        actorName = await this.associationName(associationId);
      } else {
        actorName = await this.notifications.resolveActorName(data.userId);
      }
      const alreadyNotified = new Set<string>([data.userId]);
      const notify = (recipientId: string, type: 'comment' | 'reply' | 'mention') =>
        this.notifications.createNotification({
          recipientId,
          type,
          postId,
          actorId,
          actorName: masked ? actorName : undefined,
          text: preview,
          skipPush: true,
        });
      const pushContentFor = {
        comment: commentContent,
        reply: replyContent,
        mention: mentionContent,
      };
      const send = async (recipientId: string, type: 'comment' | 'reply' | 'mention') => {
        // Never across the review cohort's boundary (review-cohort.ts), whatever names the
        // recipient: the post's author, the parent's, or a mention in the text.
        if (!sameSideOfReviewCohort(data.userId, recipientId)) {
          this.logger.log(`[NOTIFY] ${type} not sent: across the review cohort's boundary`);
          return;
        }
        await notify(recipientId, type);
        await this.push.notifyContent(recipientId, pushContentFor[type](actorName, pushPreview), {
          type: 'social',
          postId,
          commentId: comment.id,
        });
      };

      if (post.authorId && !alreadyNotified.has(post.authorId)) {
        alreadyNotified.add(post.authorId);
        try {
          await send(post.authorId, 'comment');
        } catch (e) {
          this.logger.warn(
            `[NOTIFY] comment notification failed for post.authorId=${post.authorId}`,
            e
          );
        }
      }

      if (data.parentId) {
        const parent = post.comments.find((c: any) => c.id === data.parentId);
        // A reply to an association's comment reaches everyone who speaks for it; to an anonymous
        // one, the real account behind it - the replier never learns who that is.
        let recipients: string[] = parent?.userId ? [parent.userId] : [];
        if (parent?.associationId) {
          try {
            recipients = await this.identity.holdersOf(parent.associationId);
          } catch (e) {
            this.logger.warn(
              `[NOTIFY] holders of association ${String(parent.associationId)} unreadable, reply not delivered`,
              e
            );
            recipients = [];
          }
        }
        for (const recipientId of recipients) {
          if (alreadyNotified.has(recipientId)) continue;
          alreadyNotified.add(recipientId);
          try {
            await send(recipientId, 'reply');
          } catch (e) {
            this.logger.warn(
              `[NOTIFY] reply notification failed for parent.userId=${recipientId}`,
              e
            );
          }
        }
      }

      // Mention notifications
      if (data.text) {
        const mentionedIds = this.notifications.resolveMentionedUserIds(data.text);
        for (const recipientId of mentionedIds) {
          if (alreadyNotified.has(recipientId)) continue;
          alreadyNotified.add(recipientId);
          try {
            await send(recipientId, 'mention');
          } catch (e) {
            this.logger.warn(
              `[NOTIFY] mention notification failed for recipientId=${recipientId}`,
              e
            );
          }
        }
      }
    })();

    const [served] = await this.identity.serve([comment], post, {
      viewerId: data.userId,
      isGlobalAdmin,
    });
    return { ok: true, comment: served };
  }

  /** The association's display name for a notice, or a neutral word when it cannot be read. */
  private async associationName(associationId: string): Promise<string> {
    try {
      const rows: { name: string }[] = await this.postRepo.manager.query(
        `SELECT name FROM associations WHERE id = $1`,
        [associationId]
      );
      if (rows[0]?.name) return rows[0].name;
      this.logger.warn(`[NOTIFY] association ${associationId} has no name row`);
    } catch (e) {
      this.logger.warn(`[NOTIFY] association ${associationId} name unreadable`, e);
    }
    return ANONYMOUS_NOTIFICATION_ACTOR_NAME;
  }

  /** Toggles a like on a comment - adds the userId if not present, removes it if already liked. */
  async likeComment(postId: string, commentId: string, userId: string, isGlobalAdmin = false) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const comments: any[] = post.comments ?? [];
    const comment = comments.find((c: any) => c.id === commentId);
    if (!comment) throw new NotFoundException('Comment not found');
    const likes: string[] = comment.likes ?? [];
    comment.likes = likes.includes(userId)
      ? likes.filter((id) => id !== userId)
      : [...likes, userId];
    post.comments = comments;
    await this.postRepo.save(post);
    const [served] = await this.identity.serve([comment], post, {
      viewerId: userId,
      isGlobalAdmin,
    });
    return { ok: true, comment: served };
  }

  /**
   * Updates the text of a comment. `commentRights` says who: the writer of an ordinary or an
   * anonymous comment, any holder of `POST_AS_ASSO` (or a platform admin) for an association's.
   */
  async editComment(
    postId: string,
    commentId: string,
    userId: string,
    text: string,
    isGlobalAdmin = false
  ) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const comments: any[] = post.comments ?? [];
    const comment = comments.find((c: any) => c.id === commentId);
    if (!comment) throw new NotFoundException('Comment not found');
    const viewer = await this.identity.viewerFor([comment], { viewerId: userId, isGlobalAdmin });
    if (!commentRights(comment, viewer).canEdit) {
      throw new UnauthorizedException('Not your comment');
    }
    comment.text = text;
    // Served as "(modifie)" - the client had no way to tell an edited comment from the original.
    comment.editedAt = new Date().toISOString();
    post.comments = comments;
    await this.postRepo.save(post);
    const [served] = await this.identity.serve([comment], post, {
      viewerId: userId,
      isGlobalAdmin,
    });
    return { ok: true, comment: served };
  }

  /**
   * Removes a comment and all of its replies, for whoever `commentRights` lets: the writer, a
   * platform admin, a content moderator for an anonymous one, any association holder for its own.
   */
  async deleteComment(postId: string, commentId: string, userId: string, isAdmin = false) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const comments: any[] = post.comments ?? [];
    const comment = comments.find((c: any) => c.id === commentId);
    if (!comment) throw new NotFoundException('Comment not found');
    const viewer = await this.identity.viewerFor([comment], {
      viewerId: userId,
      isGlobalAdmin: isAdmin,
    });
    if (!commentRights(comment, viewer).canDelete) {
      throw new UnauthorizedException('Not your comment');
    }
    const removed = comments.filter((c: any) => c.id === commentId || c.parentId === commentId);
    post.comments = comments.filter((c: any) => c.id !== commentId && c.parentId !== commentId);
    await this.postRepo.save(post);
    // The replies go with it, so their media do too - taking only the comment's own would leave
    // every reply's photo archived for ever with nothing left on screen pointing at it.
    await this.mediaRetention.release(commentMediaIds(removed));
    return { ok: true };
  }

  /**
   * Records a poll vote. Clears the user's previous votes across all options first,
   * then adds their new selection. Supports multiple-choice polls via optionIds array.
   * Also persists votesByUser so the frontend can restore the selection on reload.
   *
   * IT ENFORCED NOTHING UNTIL 2026-09-23, AND THE RULES IT DID NOT APPLY WERE ALL WRITTEN DOWN.
   * `multipleChoice: false` was a CLIENT convention - the radio inputs sent one id, so one id was
   * what arrived, and a request that sent five recorded five votes on a single-choice poll. An
   * `endsAt` in the past only ever hid the buttons. And an option id belonging to no option of
   * this poll cast no vote but was still written into `votesByUser`, so it came back to every
   * reader as part of somebody's selection.
   *
   * A CAP ONLY THE CLIENT APPLIES IS A CAP A CRAFTED REQUEST IGNORES. The three rules now live in
   * `pollDraft.ts` (what may be composed), `pollVote.ts` (what may be selected) and here (what may
   * be RECORDED), and only this one is not advisory.
   *
   * @throws BadRequestException when the poll has closed, or the selection exceeds what the poll
   *   allows - a refusal, never a silent truncation, because a vote is not a thing to guess at.
   * @returns the STORED post, which is not an answer to anybody: the route serves it through
   *   `PostsService.serveToReader`, as every single-post response is served.
   */
  async votePoll(
    postId: string,
    pollId: string,
    data: { userId: string; optionIds: string[] }
  ): Promise<Post> {
    // Use a pessimistic write lock to prevent two concurrent votes from silently
    // overwriting each other (check-then-act race on the JSON polls column).
    let result: any;
    await this.postRepo.manager.transaction(async (manager) => {
      const post = await manager
        .createQueryBuilder(Post, 'post')
        .where('post.id = :postId', { postId })
        .setLock('pessimistic_write')
        .getOne();
      if (!post) throw new NotFoundException('Poll not found');

      let updated = false;
      for (const poll of (post as any).polls ?? []) {
        if (poll.id !== pollId) continue;

        if (poll.endsAt && new Date(poll.endsAt).getTime() <= Date.now()) {
          throw new BadRequestException('Poll closed');
        }
        // The channel poll has refused this since CodeQL #2477/#2476; the post poll kept only the
        // null-prototype map, which stops the shadowing and not the key being CARRIED.
        if (isUnsafeObjectKey(data.userId)) {
          throw new BadRequestException('Invalid userId');
        }
        // An id this poll does not have is not a refusal, it is nothing: it can only come from a
        // stale option list, and dropping it leaves the rest of the selection standing.
        const known = new Set<string>(poll.options.map((o: any) => o.id));
        const selectedIds = [...new Set<string>(data.optionIds)].filter((id) => known.has(id));
        // `maxSelections` is only ever consulted alongside `multipleChoice`, exactly as
        // `normalizeMaxSelections` composes it - a single-choice poll is capped at one and carries
        // no second number saying so.
        const allowed = poll.multipleChoice
          ? typeof poll.maxSelections === 'number'
            ? poll.maxSelections
            : poll.options.length
          : 1;
        if (selectedIds.length > allowed) {
          throw new BadRequestException('Too many options selected');
        }
        // An anonymous poll cannot be changed or retracted - that needs the previous choice, which
        // it does not keep - so it takes the vote once and is done (see `anonymous-poll.ts`).
        if (isAnonymousPoll(poll)) {
          try {
            recordAnonymousVote(poll, data.userId, selectedIds);
          } catch (e) {
            throw new BadRequestException((e as Error).message);
          }
          updated = true;
          continue;
        }
        for (const opt of poll.options) {
          opt.votes = (Array.isArray(opt.votes) ? opt.votes : []).filter(
            (v: string) => v !== data.userId
          );
        }
        for (const opt of poll.options) {
          if (selectedIds.includes(opt.id)) opt.votes.push(data.userId);
        }
        // A new null-prototype map, the key written as an own entry (`withOwnEntry`), never by
        // assignment: the id was refused above, and the write itself cannot walk a prototype.
        poll.votesByUser = withOwnEntry<string[]>(poll.votesByUser, data.userId, selectedIds);
        updated = true;
      }

      // Every poll that matches either records the vote or throws, so nothing recorded means no
      // poll of this post has that id: a vote on nothing, answered as such.
      if (!updated) {
        this.logger.debug(`votePoll ${postId.slice(0, 8)}: no poll ${pollId.slice(0, 8)}`);
        throw new NotFoundException('Poll not found');
      }
      const saved = await manager.save(post as any);
      result = Array.isArray(saved) ? saved[0] : saved;
    });
    return result as Post;
  }
}
