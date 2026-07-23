import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContentReport } from './entities/content-report.entity';
import { UserModeration } from './entities/user-moderation.entity';
import { sanitizeLog } from '../common/log.utils';

/** Number of distinct pending reports on the same content that triggers automatic hiding. */
const AUTO_HIDE_THRESHOLD = 5;

/** Handled reports (reviewed/dismissed) are purged this many days after being handled. */
const HANDLED_REPORT_RETENTION_DAYS = 7;

export interface CreateReportData {
  reporterId: string;
  contentType: 'post' | 'comment' | 'message';
  contentId: string;
  reason: string;
  details?: string;
  /** User ID of the content author, used to enable quick moderation actions. */
  reportedUserId?: string | null;
}

/** Handles content reports and user mute/unmute moderation actions. */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    @InjectRepository(ContentReport)
    private readonly reportRepo: Repository<ContentReport>,
    @InjectRepository(UserModeration)
    private readonly muteRepo: Repository<UserModeration>
  ) {}

  // ── Content reports ───────────────────────────────────────────────────────

  /**
   * Creates a new content report. Prevents duplicate reports from the same user on the same content.
   * If the number of pending reports for a post reaches AUTO_HIDE_THRESHOLD, the post is automatically
   * hidden from public feeds until a moderator reviews it.
   */
  async createReport(data: CreateReportData): Promise<ContentReport> {
    const existing = await this.reportRepo.findOne({
      where: {
        reporterId: data.reporterId,
        contentId: data.contentId,
        status: 'pending',
      },
    });
    if (existing) {
      throw new BadRequestException('You have already reported this content');
    }

    const report = this.reportRepo.create({
      reporterId: data.reporterId,
      contentType: data.contentType,
      contentId: data.contentId,
      reason: data.reason,
      details: data.details ?? null,
      reportedUserId: data.reportedUserId ?? null,
    });
    const saved = await this.reportRepo.save(report);

    // Auto-hide posts that accumulate too many pending reports.
    if (data.contentType === 'post') {
      const pendingCount = await this.reportRepo.count({
        where: { contentId: data.contentId, status: 'pending' },
      });
      if (pendingCount >= AUTO_HIDE_THRESHOLD) {
        await this.reportRepo.manager.query(
          `UPDATE posts SET "hiddenByModeration" = true WHERE id = $1`,
          [data.contentId]
        );
        this.logger.log(
          `Post ${sanitizeLog(data.contentId)} auto-hidden after ${pendingCount} pending reports`
        );
      }
    }

    return saved;
  }

  /**
   * Deletes reports handled (reviewed/dismissed) more than HANDLED_REPORT_RETENTION_DAYS ago,
   * so the moderation queue and DB don't accumulate stale entries. Lazy: run on each list call.
   * Falls back to createdAt for rows handled before reviewedAt existed.
   */
  private async purgeExpiredHandledReports(): Promise<void> {
    try {
      await this.reportRepo.manager.query(
        `DELETE FROM content_reports
         WHERE status <> 'pending'
           AND COALESCE("reviewedAt", "createdAt") < NOW() - make_interval(days => $1)`,
        [HANDLED_REPORT_RETENTION_DAYS]
      );
    } catch (e) {
      this.logger.warn(
        `Purge of handled reports failed: ${e instanceof Error ? e.message : 'unknown error'}`
      );
    }
  }

  /** Returns all pending content reports, newest first. */
  async listPendingReports(limit = 50, offset = 0): Promise<ContentReport[]> {
    await this.purgeExpiredHandledReports();
    return this.reportRepo.find({
      where: { status: 'pending' },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
      skip: offset,
    });
  }

  /**
   * Returns all content reports regardless of status, newest first.
   * Each report is enriched with `contentPreview` (a short text excerpt of the
   * reported content) and `postId` (the parent post ID for comment reports).
   */
  async listAllReports(
    limit = 50,
    offset = 0
  ): Promise<Array<ContentReport & { contentPreview: string | null; postId: string | null }>> {
    await this.purgeExpiredHandledReports();
    const reports = await this.reportRepo.find({
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
      skip: offset,
    });

    const postIds = reports.filter((r) => r.contentType === 'post').map((r) => r.contentId);
    const commentIds = reports.filter((r) => r.contentType === 'comment').map((r) => r.contentId);

    const postPreviews = new Map<string, string>();
    if (postIds.length > 0) {
      const rows: { id: string; markdown: string }[] = await this.reportRepo.manager.query(
        `SELECT id::text, LEFT(markdown, 250) AS markdown FROM posts WHERE id = ANY($1)`,
        [postIds]
      );
      for (const row of rows) postPreviews.set(row.id, row.markdown);
    }

    const commentPreviews = new Map<string, { text: string; postId: string }>();
    if (commentIds.length > 0) {
      const rows: { post_id: string; comment_id: string; text: string }[] =
        await this.reportRepo.manager.query(
          `SELECT p.id::text AS post_id, elem->>'id' AS comment_id, elem->>'text' AS text
           FROM posts p, jsonb_array_elements(COALESCE(p.comments, '[]'::jsonb)) elem
           WHERE elem->>'id' = ANY($1)`,
          [commentIds]
        );
      for (const row of rows)
        commentPreviews.set(row.comment_id, { text: row.text, postId: row.post_id });
    }

    return reports.map((r) => ({
      ...r,
      contentPreview:
        r.contentType === 'post'
          ? (postPreviews.get(r.contentId) ?? null)
          : r.contentType === 'comment'
            ? (commentPreviews.get(r.contentId)?.text ?? null)
            : null,
      postId:
        r.contentType === 'comment' ? (commentPreviews.get(r.contentId)?.postId ?? null) : null,
    }));
  }

  /**
   * Marks a report as reviewed or dismissed.
   * @param action 'reviewed' - report actioned; 'dismissed' - no action taken.
   */
  async reviewReport(
    reportId: string,
    moderatorId: string,
    action: 'reviewed' | 'dismissed'
  ): Promise<ContentReport> {
    const report = await this.reportRepo.findOne({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found');

    report.status = action;
    report.reviewedBy = moderatorId;
    report.reviewedAt = new Date();
    return this.reportRepo.save(report);
  }

  // ── User mute/unmute ──────────────────────────────────────────────────────

  /** Mutes a user: they can still read but cannot post, react, or comment. */
  async muteUser(userId: string, mutedBy: string, reason?: string): Promise<UserModeration> {
    let record = await this.muteRepo.findOne({ where: { userId } });
    if (record) {
      record.isMuted = true;
      record.mutedBy = mutedBy;
      record.mutedAt = new Date();
      record.mutedReason = reason ?? null;
    } else {
      record = this.muteRepo.create({
        userId,
        isMuted: true,
        mutedBy,
        mutedAt: new Date(),
        mutedReason: reason ?? null,
      });
    }
    return this.muteRepo.save(record);
  }

  /** Unmutes a user, re-enabling posting and reactions. */
  async unmuteUser(userId: string): Promise<UserModeration> {
    const record = await this.muteRepo.findOne({ where: { userId } });
    if (!record) throw new NotFoundException('Moderation record not found');
    record.isMuted = false;
    record.mutedBy = null;
    record.mutedAt = null;
    record.mutedReason = null;
    return this.muteRepo.save(record);
  }

  /** Returns whether a user is currently muted (false if no record exists). */
  async isUserMuted(userId: string): Promise<boolean> {
    const record = await this.muteRepo.findOne({ where: { userId } });
    return record?.isMuted ?? false;
  }

  /** Mute status for the authenticated user, including the reason shown in the app. */
  async getUserMuteStatus(userId: string): Promise<{
    isMuted: boolean;
    mutedReason: string | null;
    mutedAt: string | null;
  }> {
    const record = await this.muteRepo.findOne({ where: { userId } });
    if (!record?.isMuted) {
      return { isMuted: false, mutedReason: null, mutedAt: null };
    }
    return {
      isMuted: true,
      mutedReason: record.mutedReason ?? null,
      mutedAt: record.mutedAt ? record.mutedAt.toISOString() : null,
    };
  }

  /** Locates the parent post of a comment by scanning JSON comment arrays. */
  async findPostIdForComment(commentId: string): Promise<string | null> {
    const rows: { id: string }[] = await this.reportRepo.manager.query(
      `SELECT id FROM posts
       WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(comments, '[]'::jsonb)) elem
         WHERE elem->>'id' = $1
       )
       LIMIT 1`,
      [commentId]
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Removes a comment (and its replies) from any post that contains it.
   * Used by moderators when acting on comment reports.
   */
  async deleteCommentById(commentId: string): Promise<{ postId: string }> {
    const postId = await this.findPostIdForComment(commentId);
    if (!postId) throw new NotFoundException('Comment not found');

    await this.reportRepo.manager.query(
      `UPDATE posts SET comments = COALESCE(
         (
           SELECT jsonb_agg(elem)
           FROM jsonb_array_elements(COALESCE(comments, '[]'::jsonb)) elem
           WHERE elem->>'id' != $2 AND COALESCE(elem->>'parentId', '') != $2
         ),
         '[]'::jsonb
       )
       WHERE id = $1`,
      [postId, commentId]
    );
    return { postId };
  }

  /** Returns all currently muted users. */
  async listMutedUsers(): Promise<UserModeration[]> {
    return this.muteRepo.find({ where: { isMuted: true }, order: { mutedAt: 'DESC' } });
  }
}
