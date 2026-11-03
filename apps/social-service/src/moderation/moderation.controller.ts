import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { ModerationService } from './moderation.service';
import { AssociationsService } from '../associations/associations.service';
import { CreateReportDto, MuteUserDto, ReviewReportDto } from './dto/moderation.dto';
import { MODERATOR_REQUIRED } from '../spaces/bde-moderation';

/**
 * Moderation endpoints: content reporting (all authenticated users)
 * and admin actions (BDE MODERATE flag or global admin).
 *
 * SCOPED SINCE 2026-11-02 (owner): a global admin acts everywhere; a BDE `MODERATE` holder opens
 * these routes (`assertModerator`, the door) but reads and acts only within the spaces its BDE
 * governs (`spaces/bde-moderation.ts`) - the queue and the muted list are narrowed, and an act on a
 * target outside that scope is a 403 `MODERATION_OUT_OF_SCOPE`.
 */
@Controller('moderation')
export class ModerationController {
  constructor(
    private readonly service: ModerationService,
    private readonly assocService: AssociationsService
  ) {}

  /** Guard helper - throws 403 unless caller is a global admin or holds the MODERATE flag in a BDE. */
  private async assertModerator(userId: string, isGlobalAdmin: boolean): Promise<void> {
    // One predicate, shared with the post controls that give the same people the same reach.
    const canModerate = await this.assocService.isContentModerator(userId, { isGlobalAdmin });
    if (!canModerate) {
      throw new ForbiddenException({
        code: MODERATOR_REQUIRED,
        message: 'BDE MODERATE permission or global admin required',
      });
    }
  }

  /** Refuses (typed 403) unless the caller moderates `targetUserId` as a person: a mute, an unmute. */
  private async assertModeratesUser(
    userId: string,
    isGlobalAdmin: boolean,
    targetUserId: string
  ): Promise<void> {
    await this.assertModerator(userId, isGlobalAdmin);
    if (await this.assocService.mayModerateUser(userId, targetUserId, { isGlobalAdmin })) return;
    await this.assocService.refuseModeration(userId, `user:${targetUserId}`);
  }

  // ── Public (authenticated) reports ───────────────────────────────────────

  /** Submits a content report. Any authenticated user may file one. */
  @UseGuards(NginxAuthGuard)
  @Post('reports')
  createReport(@Headers('x-user-id') userId: string, @Body() dto: CreateReportDto) {
    return this.service.createReport({
      reporterId: userId,
      contentType: dto.contentType,
      contentId: dto.contentId,
      reason: dto.reason,
      details: dto.details,
      reportedUserId: dto.reportedUserId ?? null,
      liveId: dto.liveId,
      message: dto.message,
    });
  }

  // ── Admin (BDE MODERATE or global admin) ─────────────────────────────────

  /** Lists all content reports (pending first). Requires MODERATE or global admin. */
  @UseGuards(NginxAuthGuard)
  @Get('reports')
  async listReports(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    const isGlobalAdmin = ga === 'true';
    await this.assertModerator(userId, isGlobalAdmin);
    const reports = await this.service.listAllReports(
      { userId, isGlobalAdmin },
      limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50,
      offset ? parseInt(offset, 10) || 0 : 0
    );
    // Which person on each row this caller may mute: a BDE mutes the people of its own spaces only,
    // and a reporter or an author may live elsewhere than the content they touched.
    const mutable = await this.assocService.moderatedUserIds(
      userId,
      reports.flatMap((r) => [r.reporterId, r.reportedUserId ?? '']),
      { isGlobalAdmin }
    );
    return reports.map((r) => ({
      ...r,
      canMuteReporter: mutable.has(r.reporterId),
      canMuteReportedUser: !!r.reportedUserId && mutable.has(r.reportedUserId),
    }));
  }

  /** Marks a report as reviewed or dismissed. Requires MODERATE or global admin. */
  @UseGuards(NginxAuthGuard)
  @Patch('reports/:reportId')
  async reviewReport(
    @Param('reportId') reportId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: ReviewReportDto
  ) {
    const isGlobalAdmin = ga === 'true';
    await this.assertModerator(userId, isGlobalAdmin);
    if (!(await this.assocService.mayModerateReport(userId, reportId, { isGlobalAdmin }))) {
      await this.assocService.refuseModeration(userId, `report:${reportId}`);
    }
    return this.service.reviewReport(reportId, userId, dto.action);
  }

  // ── Mute / unmute ─────────────────────────────────────────────────────────

  /** Mutes a user (read-only mode). Requires MODERATE or global admin. */
  @UseGuards(NginxAuthGuard)
  @Post(':userId/mute')
  async muteUser(
    @Param('userId') targetUserId: string,
    @Headers('x-user-id') callerUserId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: MuteUserDto
  ) {
    await this.assertModeratesUser(callerUserId, ga === 'true', targetUserId);
    return this.service.muteUser(targetUserId, callerUserId, dto.reason);
  }

  /** Unmutes a user. Requires MODERATE or global admin. */
  @UseGuards(NginxAuthGuard)
  @Post(':userId/unmute')
  async unmuteUser(
    @Param('userId') targetUserId: string,
    @Headers('x-user-id') callerUserId: string,
    @Headers('x-global-admin') ga: string | undefined
  ) {
    await this.assertModeratesUser(callerUserId, ga === 'true', targetUserId);
    return this.service.unmuteUser(targetUserId);
  }

  /** Returns all currently muted users. Requires MODERATE or global admin. */
  @UseGuards(NginxAuthGuard)
  @Get('muted')
  async listMutedUsers(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    const isGlobalAdmin = ga === 'true';
    await this.assertModerator(userId, isGlobalAdmin);
    return this.service.listMutedUsers({ userId, isGlobalAdmin });
  }

  /** Returns the mute status of the calling user (called by post-guard middleware). */
  @UseGuards(NginxAuthGuard)
  @Get('me/mute-status')
  async myMuteStatus(@Headers('x-user-id') userId: string) {
    return this.service.getUserMuteStatus(userId);
  }

  /** Deletes a reported comment (and replies). Requires MODERATE or global admin. */
  @UseGuards(NginxAuthGuard)
  @Post('comments/:commentId/delete')
  async deleteReportedComment(
    @Param('commentId') commentId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined
  ) {
    const isGlobalAdmin = ga === 'true';
    await this.assertModerator(userId, isGlobalAdmin);
    // A comment is judged by the post it sits under; a missing one stays the service's 404.
    const postId = await this.service.findPostIdForComment(commentId);
    if (postId && !(await this.assocService.mayModeratePost(userId, postId, { isGlobalAdmin }))) {
      await this.assocService.refuseModeration(userId, `comment:${commentId}`);
    }
    return this.service.deleteCommentById(commentId);
  }
}
