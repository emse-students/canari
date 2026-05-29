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
import { PostNotificationsService } from './post-notifications.service';
import { PushService } from '../push/push.service';

/** Handles reactions, comments, polls, and form submissions on posts. */
@Injectable()
export class PostInteractionsService {
  private readonly logger = new Logger(PostInteractionsService.name);

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly notifications: PostNotificationsService,
    private readonly push: PushService
  ) {}

  /**
   * Copies a reactions map into a null-prototype object to prevent prototype-pollution
   * attacks where a user ID like "__proto__" could shadow Object properties.
   */
  private sanitizeReactions(
    raw: Record<string, string> | null | undefined
  ): Record<string, string> {
    const out = Object.create(null) as Record<string, string>;
    if (!raw || typeof raw !== 'object') return out;
    for (const key of Object.keys(raw)) {
      if (
        ['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__'].includes(
          key
        )
      )
        continue;
      out[key] = raw[key];
    }
    return out;
  }

  /** Sets or replaces the reaction emoji for a user on a post (one reaction per user). */
  async addReaction(postId: string, userId: string, reactionType: string) {
    if (['__proto__', 'constructor', 'prototype'].includes(userId)) {
      throw new BadRequestException('Invalid userId');
    }
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const reactions = this.sanitizeReactions(post.reactions);
    const isNew = !reactions[userId];
    reactions[userId] = reactionType;
    post.reactions = reactions;
    await this.postRepo.save(post);

    // Notify post author of a new reaction (not for self-reactions or changes).
    if (isNew && post.authorId && post.authorId !== userId) {
      void (async () => {
        try {
          const actorName = await this.notifications.resolveActorName(userId);
          await this.notifications.createNotification({
            recipientId: post.authorId,
            type: 'reaction',
            postId,
            actorId: userId,
            text: reactionType,
          });
          await this.push.notify(
            post.authorId,
            'Nouvelle réaction',
            `${actorName} a réagi à votre publication ${reactionType}`,
            { type: 'social', postId }
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
    if (['__proto__', 'constructor', 'prototype'].includes(userId)) {
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
   * Appends a comment to a post. Enriches it with the author's display name from the
   * users table (non-fatal if unavailable). Fires notifications fire-and-forget style:
   * the post author gets a "comment" notification; the parent comment author gets a "reply".
   */
  async addComment(
    postId: string,
    data: { userId: string; text?: string; parentId?: string; media?: any }
  ) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');

    let displayName: string | null = null;
    let firstName: string | null = null;
    let lastName: string | null = null;
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

    const comment = {
      id: crypto.randomUUID(),
      userId: data.userId,
      displayName,
      firstName,
      lastName,
      text: data.text ?? '',
      parentId: data.parentId ?? null,
      likes: [] as string[],
      createdAt: new Date().toISOString(),
      ...(data.media ? { media: data.media } : {}),
    };
    post.comments = [...(post.comments ?? []), comment];
    await this.postRepo.save(post);

    // Fire-and-forget: notify post author, parent comment author, and mentioned users.
    // Each recipient is isolated in its own try/catch so that a DB failure for one
    // recipient does not prevent the others from being notified.
    void (async () => {
      const text = data.text ?? (data.media ? '📷 Image' : '');
      const preview = text.length > 60 ? text.slice(0, 57) + '…' : text;
      const actorName = await this.notifications.resolveActorName(data.userId);
      const alreadyNotified = new Set<string>([data.userId]);

      if (post.authorId && !post.associationId && !alreadyNotified.has(post.authorId)) {
        alreadyNotified.add(post.authorId);
        try {
          await this.notifications.createNotification({
            recipientId: post.authorId,
            type: 'comment',
            postId,
            actorId: data.userId,
            text: preview,
          });
          await this.push.notify(
            post.authorId,
            `${actorName} a commenté`,
            preview || 'Nouveau commentaire',
            { type: 'social', postId }
          );
        } catch (e) {
          this.logger.warn(
            `[NOTIFY] comment notification failed for post.authorId=${post.authorId}`,
            e
          );
        }
      }

      if (data.parentId) {
        const parent = post.comments.find((c: any) => c.id === data.parentId);
        if (parent?.userId && !alreadyNotified.has(parent.userId)) {
          alreadyNotified.add(parent.userId);
          try {
            await this.notifications.createNotification({
              recipientId: parent.userId,
              type: 'reply',
              postId,
              actorId: data.userId,
              text: preview,
            });
            await this.push.notify(
              parent.userId,
              `${actorName} a répondu`,
              preview || 'Nouvelle réponse',
              { type: 'social', postId }
            );
          } catch (e) {
            this.logger.warn(
              `[NOTIFY] reply notification failed for parent.userId=${parent.userId}`,
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
            await this.notifications.createNotification({
              recipientId,
              type: 'mention',
              postId,
              actorId: data.userId,
              text: preview,
            });
            await this.push.notify(
              recipientId,
              `${actorName} vous a mentionné`,
              preview || 'Vous avez été mentionné dans un commentaire',
              { type: 'social', postId }
            );
          } catch (e) {
            this.logger.warn(
              `[NOTIFY] mention notification failed for recipientId=${recipientId}`,
              e
            );
          }
        }
      }
    })();

    return { ok: true, comment };
  }

  /** Toggles a like on a comment - adds the userId if not present, removes it if already liked. */
  async likeComment(postId: string, commentId: string, userId: string) {
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
    return { ok: true, comment };
  }

  /** Updates the text of a comment. Only the original author may edit their own comment. */
  async editComment(postId: string, commentId: string, userId: string, text: string) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const comments: any[] = post.comments ?? [];
    const comment = comments.find((c: any) => c.id === commentId);
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.userId !== userId) throw new UnauthorizedException('Not your comment');
    comment.text = text;
    post.comments = comments;
    await this.postRepo.save(post);
    return { ok: true, comment };
  }

  /** Removes a comment and all of its replies. Original author or global admin may delete. */
  async deleteComment(postId: string, commentId: string, userId: string, isAdmin = false) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const comments: any[] = post.comments ?? [];
    const comment = comments.find((c: any) => c.id === commentId);
    if (!comment) throw new NotFoundException('Comment not found');
    if (!isAdmin && comment.userId !== userId) throw new UnauthorizedException('Not your comment');
    post.comments = comments.filter((c: any) => c.id !== commentId && c.parentId !== commentId);
    await this.postRepo.save(post);
    return { ok: true };
  }

  /**
   * Records a poll vote. Clears the user's previous votes across all options first,
   * then adds their new selection. Supports multiple-choice polls via optionIds array.
   * Also persists votesByUser so the frontend can restore the selection on reload.
   */
  async votePoll(postId: string, pollId: string, data: { userId: string; optionIds: string[] }) {
    const post = await this.postRepo
      .createQueryBuilder('post')
      .where('post.id = :postId', { postId })
      .getOne();
    if (!post) throw new NotFoundException('Poll not found');

    let updated = false;
    for (const poll of post.polls ?? []) {
      if (poll.id !== pollId) continue;
      const selectedIds = data.optionIds;
      for (const opt of poll.options) {
        opt.votes = (Array.isArray(opt.votes) ? opt.votes : []).filter(
          (v: string) => v !== data.userId
        );
      }
      for (const opt of poll.options) {
        if (selectedIds.includes(opt.id)) opt.votes.push(data.userId);
      }
      if (!poll.votesByUser) poll.votesByUser = {};
      poll.votesByUser[data.userId] = selectedIds;
      updated = true;
    }

    if (updated) {
      const saved = await this.postRepo.save(post);
      const entity = Array.isArray(saved) ? saved[0] : saved;
      return entity;
    }
    return post;
  }

  /**
   * Submits an embedded form on a post. Validates the post exists and that the
   * form is actually attached, then returns a stub success response. Full
   * submission logic lives in FormsService - cross-module wiring requires
   * extracting PostNotificationsService to break the circular dependency.
   */
  async submitForm(
    postId: string,
    formId: string,
    _data: { userId?: string; email?: string; selections: Record<string, any> }
  ) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException();
    const hasForm =
      post.attachedFormId === formId ||
      (post.forms ?? []).some((f: { id?: string }) => f.id === formId);
    if (!hasForm) throw new NotFoundException('Form not attached to this post');
    return { ok: true, requiresPayment: false, message: 'Formulaire envoyé.' };
  }
}
