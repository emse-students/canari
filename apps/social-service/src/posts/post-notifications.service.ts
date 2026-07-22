import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PostNotification } from './entities/post-notification.entity';
import { Post } from './entities/post.entity';
import { PushService } from '../push/push.service';
import {
  pushMentionTitle,
  pushMentionBody,
  pushReplyTitle,
  pushReplyBody,
  pushReactionTitle,
  pushReactionBody,
  pushCommentTitle,
  pushCommentBody,
} from './push-messages';

/** Manages in-app notifications triggered by post interactions (comments, reactions, mentions). */
@Injectable()
export class PostNotificationsService {
  constructor(
    @InjectRepository(PostNotification) private readonly notifRepo: Repository<PostNotification>,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly push: PushService
  ) {}

  /**
   * Builds the FCM push title/body for a notification type (mirrors the in-app wording).
   * Fallback path for callers that don't build a richer push themselves (e.g. mentions in a
   * brand-new post) - callers with more context (reaction emoji, comment preview) should send
   * their own push and pass `skipPush: true` to `createNotification` instead of relying on this.
   */
  private pushContent(
    type: string,
    actorName: string,
    text: string
  ): { title: string; body: string } {
    switch (type) {
      case 'mention':
        return { title: pushMentionTitle(actorName), body: pushMentionBody(text) };
      case 'reply':
        return { title: pushReplyTitle(actorName), body: pushReplyBody(text) };
      case 'reaction':
        return { title: pushReactionTitle(), body: pushReactionBody(actorName, text) };
      case 'comment':
        return { title: pushCommentTitle(actorName), body: pushCommentBody(text) };
      default:
        return { title: actorName, body: text || 'Nouvelle notification' };
    }
  }

  /** `@[userId]` - 64 lowercase hex chars (OIDC sub, no dashes). */
  private static readonly MENTION_UUID_RE = /@\[([0-9a-f]{64})\]/gi;

  /** Extracts `@[id]` mention targets from text. Returns deduplicated IDs (max 20). */
  resolveMentionedUserIds(text: string): string[] {
    const ids = new Set<string>();
    for (const match of text.matchAll(PostNotificationsService.MENTION_UUID_RE)) {
      ids.add(match[1].toLowerCase());
    }
    return [...ids].slice(0, 20);
  }

  /** Looks up a user's display name from the shared users table. */
  async resolveActorName(actorId: string): Promise<string> {
    try {
      const rows: unknown = await this.postRepo.manager.query(
        `SELECT "displayName", "firstName", "lastName" FROM users WHERE id = $1`,
        [actorId]
      );
      if (!Array.isArray(rows) || rows.length === 0) return actorId;
      const u: unknown = rows[0];
      if (typeof u !== 'object' || u === null) return actorId;
      const row = u as Record<string, unknown>;
      const displayName = typeof row.displayName === 'string' ? row.displayName.trim() : '';
      const firstName = typeof row.firstName === 'string' ? row.firstName : '';
      const lastName = typeof row.lastName === 'string' ? row.lastName : '';
      const fromParts = [firstName, lastName].filter((p) => p.length > 0).join(' ');
      return displayName || fromParts || actorId;
    } catch {
      /* non-fatal */
    }
    return actorId;
  }

  /**
   * Creates a notification unless actor and recipient are the same person.
   * Pass `actorName` to skip the DB lookup (e.g. system-generated notifications).
   * Pass `skipPush: true` when the caller already sends its own push (e.g. with a richer
   * message than `pushContent` can build) - otherwise the recipient gets duplicate pushes.
   */
  async createNotification(data: {
    recipientId: string;
    type: string;
    postId: string;
    actorId: string;
    text: string;
    actorName?: string;
    skipPush?: boolean;
  }) {
    if (data.recipientId === data.actorId) return;
    const { skipPush, ...notifData } = data;
    const actorName = data.actorName ?? (await this.resolveActorName(data.actorId));
    await this.notifRepo.save(this.notifRepo.create({ ...notifData, actorName }));

    if (skipPush) return;

    // FCM push so every visible notification also triggers a system notification, even with the app closed. Fire-and-forget.
    const { title, body } = this.pushContent(data.type, actorName, data.text);
    void this.push.notify(data.recipientId, title, body, { type: 'social', postId: data.postId });
  }

  /** Returns the most recent notifications for a user, newest first. */
  async getNotifications(userId: string, limit = 30) {
    return this.notifRepo.find({
      where: { recipientId: userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /** Marks every notification for a user as read (called when the bell dropdown is opened). */
  async markAllRead(userId: string) {
    await this.notifRepo.update({ recipientId: userId }, { read: true });
    return { ok: true };
  }
}
