import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PostNotification } from './entities/post-notification.entity';
import { Post } from './entities/post.entity';

/** Manages in-app notifications triggered by post interactions (comments, reactions, mentions). */
@Injectable()
export class PostNotificationsService {
  constructor(
    @InjectRepository(PostNotification) private readonly notifRepo: Repository<PostNotification>,
    @InjectRepository(Post) private readonly postRepo: Repository<Post>
  ) {}

  /**
   * Extracts `@DisplayName` patterns from text and resolves them to user IDs via the users table.
   * Returns deduplicated IDs (max 20).
   */
  async resolveMentionedUserIds(text: string): Promise<string[]> {
    const names = [
      ...new Set([...text.matchAll(/@([\wÀ-ž][^\s@]*)/gu)].map((m) => m[1].trim()).filter(Boolean)),
    ];
    if (names.length === 0) return [];
    try {
      const rows: { id: string }[] = await this.postRepo.manager.query(
        `SELECT id FROM users WHERE "displayName" = ANY($1)
           OR TRIM(CONCAT("firstName", ' ', "lastName")) = ANY($1)
         LIMIT 20`,
        [names]
      );
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
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

  /** Creates a notification unless actor and recipient are the same person. */
  async createNotification(data: {
    recipientId: string;
    type: string;
    postId: string;
    actorId: string;
    text: string;
  }) {
    if (data.recipientId === data.actorId) return;
    const actorName = await this.resolveActorName(data.actorId);
    await this.notifRepo.save(this.notifRepo.create({ ...data, actorName }));
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
