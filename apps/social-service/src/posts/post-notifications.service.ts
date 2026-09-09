import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PostNotification } from './entities/post-notification.entity';
import { Post } from './entities/post.entity';
import { PushService } from '../push/push.service';
import {
  mentionContent,
  replyContent,
  reactionContent,
  commentContent,
  eventProposedContent,
  eventValidatedContent,
  eventRejectedContent,
  eventUpdatedContent,
  eventDeletedContent,
  type PushContent,
} from '../push/push-content';

/** Manages in-app notifications triggered by post interactions (comments, reactions, mentions). */
@Injectable()
export class PostNotificationsService {
  private readonly logger = new Logger(PostNotificationsService.name);

  constructor(
    @InjectRepository(PostNotification) private readonly notifRepo: Repository<PostNotification>,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly push: PushService
  ) {}

  /**
   * Maps a notification type to WHAT its push says, for callers that do not build their own.
   * Callers with more context (reaction emoji, comment preview) send their own and pass
   * `skipPush: true` to `createNotification` instead of relying on this.
   *
   * An unknown type gets NO push rather than an invented sentence. It used to fall through to a
   * hardcoded "Nouvelle notification", which is a sentence no table can translate and no reader
   * learns anything from - and it hid the fact that a type had been added without a push.
   */
  private pushContent(type: string, actorName: string, text: string): PushContent | null {
    switch (type) {
      case 'mention':
        return mentionContent(actorName, text);
      case 'reply':
        return replyContent(actorName, text);
      case 'reaction':
        return reactionContent(actorName, text);
      case 'comment':
        return commentContent(actorName, text);
      // The agenda's five. `text` is the event's TITLE for all of them - never a composed sentence,
      // which is what the server used to send here and could not translate.
      case 'event_proposed':
        return eventProposedContent(actorName, text);
      case 'event_validated':
        return eventValidatedContent(actorName, text);
      case 'event_rejected':
        return eventRejectedContent(actorName, text);
      case 'event_updated':
        return eventUpdatedContent(actorName, text);
      case 'event_deleted':
        return eventDeletedContent(actorName, text);
      default:
        return null;
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
    const content = this.pushContent(data.type, actorName, data.text);
    if (!content) {
      this.logger.warn(
        `[NOTIFY] no push content for type=${data.type} - the in-app notification was written, ` +
          'the system one was not. Add the type to pushContent or send your own push.'
      );
      return;
    }
    void this.push.notifyContent(data.recipientId, content, {
      type: 'social',
      postId: data.postId,
    });
  }

  /**
   * `createNotification` for a SET of recipients: one actor lookup, one insert, one push each.
   *
   * The agenda notifies whole groups - every proposer in an association, every calendar manager -
   * and doing that through the singular method would be one name lookup and one round trip per
   * member. The association service used to batch it itself by writing to the repository directly,
   * which is precisely how its push escaped `pushContent` and stayed English for as long as it did.
   * Batching belongs here so that the mapping cannot be bypassed to get it.
   *
   * Returns how many rows were written, so a caller can log a delivery that reached nobody.
   */
  async createNotifications(data: {
    recipientIds: string[];
    type: string;
    postId: string;
    actorId: string;
    text: string;
    actorName?: string;
    /** Extra fields for the push payload, e.g. the association the event belongs to. */
    pushData?: Record<string, string>;
  }): Promise<number> {
    const recipients = [...new Set(data.recipientIds)].filter((id) => id !== data.actorId);
    if (recipients.length === 0) return 0;

    const actorName = data.actorName ?? (await this.resolveActorName(data.actorId));
    await this.notifRepo.save(
      recipients.map((recipientId) =>
        this.notifRepo.create({
          recipientId,
          type: data.type,
          postId: data.postId,
          actorId: data.actorId,
          text: data.text,
          actorName,
        })
      )
    );

    const content = this.pushContent(data.type, actorName, data.text);
    if (!content) {
      this.logger.warn(
        `[NOTIFY] no push content for type=${data.type} - ${recipients.length} in-app ` +
          'notification(s) were written, no system one was. Add the type to pushContent.'
      );
      return recipients.length;
    }
    // Fire-and-forget, and caught PER RECIPIENT: a batch that catches once loses every failure
    // after the first, and in a best-effort path the log is all a loss leaves.
    void Promise.all(
      recipients.map((recipientId) =>
        this.push
          .notifyContent(recipientId, content, { type: 'social', ...data.pushData })
          .catch((e) => this.logger.warn(`[NOTIFY] push failed for ${recipientId}: ${String(e)}`))
      )
    );
    return recipients.length;
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
