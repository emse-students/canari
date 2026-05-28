import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContentReport } from './entities/content-report.entity';
import { UserModeration } from './entities/user-moderation.entity';

/** Number of distinct pending reports on the same content that triggers automatic hiding. */
const AUTO_HIDE_THRESHOLD = 5;

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
        console.log(
          `[moderation] Post ${data.contentId} auto-hidden after ${pendingCount} pending reports`
        );
      }
    }

    return saved;
  }

  /** Returns all pending content reports, newest first. */
  async listPendingReports(): Promise<ContentReport[]> {
    return this.reportRepo.find({
      where: { status: 'pending' },
      order: { createdAt: 'DESC' },
    });
  }

  /** Returns all content reports regardless of status, newest first. */
  async listAllReports(): Promise<ContentReport[]> {
    return this.reportRepo.find({ order: { createdAt: 'DESC' } });
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

  /** Returns all currently muted users. */
  async listMutedUsers(): Promise<UserModeration[]> {
    return this.muteRepo.find({ where: { isMuted: true }, order: { mutedAt: 'DESC' } });
  }
}
