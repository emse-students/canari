import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  SetMetadata,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { MIN_ROLE_KEY } from './guards/association-role.guard';
import { GlobalAdminOrAssociationRoleGuard } from './guards/global-admin-or-association-role.guard';
import { AssociationPermission } from './entities/association-member.entity';
import { AssociationsService } from './associations.service';
import { FollowsService } from '../follows/follows.service';
import {
  AddMemberDto,
  CreateAssociationDto,
  CreateAssociationCalendarEventDto,
  UpdateAssociationDto,
  UpdateAssociationCalendarEventDto,
  UpdateMemberRoleDto,
} from './dto/association.dto';
import { buildAggregatedCalendarIcs } from './calendar-ics.util';

const LOGO_UPLOAD_MB = 2;

/** Manages association resources including membership, logo, Stripe onboarding, and follow relationships. */
@Controller('associations')
export class AssociationsController {
  constructor(
    private readonly service: AssociationsService,
    private readonly followsService: FollowsService
  ) {}

  // ── Public ────────────────────────────────────────────────────────────────

  /** Returns all associations. */
  @Get()
  list() {
    return this.service.list();
  }

  /** Returns an association looked up by its URL slug. */
  @Get('slug/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.service.findBySlug(slug);
  }

  /** Returns all associations the calling user is a member of. */
  @UseGuards(NginxAuthGuard)
  @Get('me/list')
  myAssociations(@Headers('x-user-id') userId: string) {
    return this.service.listByUser(userId);
  }

  /** Returns all associations the calling user is following. */
  @UseGuards(NginxAuthGuard)
  @Get('me/following')
  myFollowedAssociations(@Headers('x-user-id') userId: string) {
    return this.followsService.listFollowedAssociations(userId);
  }

  /**
   * Aggregated agenda across associations (`startsAt` in `[from, to]`).
   * Optional `associationId` limits to one association. Public.
   */
  @Get('calendar/feed')
  aggregatedCalendarFeed(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('associationId') associationId?: string
  ) {
    return this.service.listAggregatedCalendarFeed(from, to, associationId);
  }

  /**
   * Same window as `calendar/feed`, but returns an iCalendar document (`text/calendar`).
   * Suitable for “subscribe by URL”, opening in Apple/Google Calendar, etc.
   */
  /** Pending agenda events the caller may validate (global admin or association admin). */
  @UseGuards(NginxAuthGuard)
  @Get('calendar/pending')
  async listPendingCalendarEvents(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    const isGlobalAdmin = ga === 'true';
    if (!isGlobalAdmin) {
      const can = await this.service.canModerateAnyAssociationCalendar(userId);
      if (!can) {
        throw new ForbiddenException('Association admin or global admin required');
      }
    }
    return this.service.listPendingCalendarEvents(userId, { isGlobalAdmin });
  }

  @Get('calendar/feed.ics')
  async aggregatedCalendarFeedIcs(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('associationId') associationId: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    const rows = await this.service.listAggregatedCalendarFeed(from, to, associationId);
    const body = buildAggregatedCalendarIcs(rows, {
      frontendBaseUrl: process.env.FRONTEND_URL || 'http://localhost:1420',
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=120');
    return body;
  }

  /** Returns all members of the specified association. */
  @Get(':id/members')
  listMembers(@Param('id') id: string) {
    return this.service.listMembers(id);
  }

  /** Returns scheduled events for the association (optional `from` / `to` ISO date bounds). */
  @Get(':id/events')
  async listCalendarEvents(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('includePending') includePending?: string,
    @Headers('x-user-id') userId?: string,
    @Headers('x-global-admin') ga?: string
  ) {
    const wantPending = includePending === 'true' || includePending === '1';
    let include = false;
    if (wantPending && userId?.trim()) {
      include = await this.service.canPostAs(userId.trim(), id, {
        isGlobalAdmin: ga === 'true',
      });
    }
    return this.service.listCalendarEvents(id, from, to, { includePending: include });
  }

  /** Returns whether the calling user is following the specified association. */
  @UseGuards(NginxAuthGuard)
  @Get(':id/follow-status')
  followStatus(@Headers('x-user-id') userId: string, @Param('id') id: string) {
    return this.followsService.isFollowing(userId, id).then((following) => ({ following }));
  }

  /** Returns whether the calling user has admin permission to manage the association. */
  @UseGuards(NginxAuthGuard)
  @Get(':id/manage-permission')
  async managePermission(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id') id: string
  ) {
    const ok = await this.service.canPostAs(userId, id, { isGlobalAdmin: ga === 'true' });
    return { ok };
  }

  /** Recent posts and forms for this association (picker when linking calendar ↔ content). */
  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/link-candidates')
  linkCandidates(@Param('id') id: string) {
    return this.service.getCalendarLinkCandidates(id);
  }

  /** Returns a single association by its ID. */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  // ── Authenticated ─────────────────────────────────────────────────────────

  /** Subscribes the calling user to follow the specified association. */
  @UseGuards(NginxAuthGuard)
  @Post(':id/follow')
  followAssociation(@Headers('x-user-id') userId: string, @Param('id') id: string) {
    return this.followsService.followAssociation(userId, id);
  }

  /** Unsubscribes the calling user from following the specified association. */
  @UseGuards(NginxAuthGuard)
  @Delete(':id/follow')
  unfollowAssociation(@Headers('x-user-id') userId: string, @Param('id') id: string) {
    return this.followsService.unfollowAssociation(userId, id);
  }

  // ── Global Admin only ─────────────────────────────────────────────────────

  /** Creates a new association; requires global admin privileges. */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Post()
  create(@Headers('x-user-id') userId: string, @Body() dto: CreateAssociationDto) {
    return this.service.create(dto, userId);
  }

  /** Deletes an association; requires global admin privileges. */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  // ── Global Admin OR Association Admin ─────────────────────────────────────

  /** Updates association details; requires association admin or global admin. */
  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAssociationDto) {
    return this.service.update(id, dto);
  }

  /** Uploads and sets a new logo for the association. */
  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_UPLOAD_MB * 1024 * 1024 } }))
  @Post(':id/logo')
  uploadLogo(
    @Param('id') id: string,
    @Headers('authorization') authorization: string | undefined,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; size: number } | undefined
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('Missing file');
    }
    return this.service.setLogoFromUpload(
      id,
      {
        buffer: file.buffer,
        mimetype: file.mimetype,
        size: file.size,
      },
      authorization
    );
  }

  /** Removes the stored logo from an association. */
  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/logo')
  deleteLogo(@Param('id') id: string, @Headers('authorization') authorization: string | undefined) {
    return this.service.clearStoredLogo(id, authorization);
  }

  /** Adds a user as a member of the association with the specified role. */
  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() dto: AddMemberDto) {
    return this.service.addMember(id, dto.userId, dto.role, dto.permission);
  }

  /** Updates the role or permission of an existing association member. */
  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id/members/:userId')
  updateMemberRole(
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() dto: UpdateMemberRoleDto
  ) {
    return this.service.updateMemberRole(id, targetUserId, dto.role, dto.permission);
  }

  /** Removes a member from the association. */
  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/members/:userId')
  removeMember(@Param('id') id: string, @Param('userId') targetUserId: string) {
    return this.service.removeMember(id, targetUserId);
  }

  /** Creates a calendar event for the association. */
  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/events')
  createCalendarEvent(
    @Headers('x-user-id') userId: string,
    @Param('id') id: string,
    @Body() dto: CreateAssociationCalendarEventDto
  ) {
    return this.service.createCalendarEvent(id, dto, userId);
  }

  /** Updates a calendar event. */
  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id/events/:eventId')
  updateCalendarEvent(
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() dto: UpdateAssociationCalendarEventDto
  ) {
    return this.service.updateCalendarEvent(id, eventId, dto);
  }

  /** Deletes a calendar event. */
  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/events/:eventId')
  deleteCalendarEvent(@Param('id') id: string, @Param('eventId') eventId: string) {
    return this.service.deleteCalendarEvent(id, eventId);
  }

  /** Validates a pending calendar event (makes it visible publicly). */
  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/events/:eventId/validate')
  validateCalendarEvent(
    @Headers('x-user-id') userId: string,
    @Param('id') id: string,
    @Param('eventId') eventId: string
  ) {
    return this.service.validateCalendarEvent(id, eventId, userId);
  }

  // ── Internal (called by core-service, bypass nginx auth in Docker network) ─

  /** Sets the Stripe account ID for an association; called internally by core-service. */
  @Post(':id/stripe-account')
  setStripeAccount(@Param('id') id: string, @Body() body: { stripeAccountId: string }) {
    return this.service.setStripeAccountId(id, body.stripeAccountId);
  }

  /** Marks Stripe onboarding as complete for an association; called internally by core-service. */
  @Post(':id/stripe-complete')
  markStripeComplete(@Param('id') id: string) {
    return this.service.markStripeOnboardingComplete(id);
  }
}
