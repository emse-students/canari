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
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { CreateReportDto, MuteUserDto, ReviewReportDto } from './dto/moderation.dto';

/**
 * Moderation endpoints: content reporting (all authenticated users)
 * and admin actions (BDE MODERATE flag or global admin).
 */
@Controller('moderation')
export class ModerationController {
  constructor(
    private readonly service: ModerationService,
    private readonly assocService: AssociationsService
  ) {}

  /** Guard helper - throws 403 unless caller is a global admin or holds the MODERATE flag in a BDE. */
  private async assertModerator(userId: string, isGlobalAdmin: boolean): Promise<void> {
    if (isGlobalAdmin) return;
    const canModerate = await this.assocService.callerHasAnyBdeFlag(
      userId,
      AssociationPermissionFlag.MODERATE
    );
    if (!canModerate) {
      throw new ForbiddenException('BDE MODERATE permission or global admin required');
    }
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
    await this.assertModerator(userId, ga === 'true');
    return this.service.listAllReports(
      limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50,
      offset ? parseInt(offset, 10) || 0 : 0
    );
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
    await this.assertModerator(userId, ga === 'true');
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
    await this.assertModerator(callerUserId, ga === 'true');
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
    await this.assertModerator(callerUserId, ga === 'true');
    return this.service.unmuteUser(targetUserId);
  }

  /** Returns all currently muted users. Requires MODERATE or global admin. */
  @UseGuards(NginxAuthGuard)
  @Get('muted')
  async listMutedUsers(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    await this.assertModerator(userId, ga === 'true');
    return this.service.listMutedUsers();
  }

  /** Returns the mute status of the calling user (called by post-guard middleware). */
  @UseGuards(NginxAuthGuard)
  @Get('me/mute-status')
  async myMuteStatus(@Headers('x-user-id') userId: string) {
    const isMuted = await this.service.isUserMuted(userId);
    return { isMuted };
  }
}
