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
  Put,
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
import { PERM_FLAG_KEY } from './guards/association-role.guard';
import { GlobalAdminOrAssociationRoleGuard } from './guards/global-admin-or-association-role.guard';
import { AssociationPermissionFlag } from './entities/association-member.entity';
import { AssociationsService } from './associations.service';
import { ProductsService } from './products.service';
import { FollowsService } from '../follows/follows.service';
import {
  AddMemberDto,
  CreateAssociationDto,
  CreateAssociationDocumentDto,
  UpdateAssociationNotesDto,
  CreateAssociationCalendarEventDto,
  CreateProductDto,
  GrantCotisantDto,
  GrantProductPurchaseDto,
  GrantTagDto,
  ListCotisantsQueryDto,
  RejectCalendarEventDto,
  ReorderMembersDto,
  RequestPaymentDelegationDto,
  UpdateAssociationDto,
  UpdateAssociationCalendarEventDto,
  UpdateMemberRoleDto,
  UpdateProductDto,
} from './dto/association.dto';
import { UserTagService } from '../users/user-tag.service';
import { UserProfileService } from './user-profile.service';
import { CreateRoleHistoryDto, UpdateRoleHistoryDto } from './dto/user-profile.dto';
import { buildAggregatedCalendarIcs } from './calendar-ics.util';

const LOGO_UPLOAD_MB = 2;

/** Manages association resources including membership, logo, Stripe onboarding, follow relationships, and boutique products. */
@Controller('associations')
export class AssociationsController {
  constructor(
    private readonly service: AssociationsService,
    private readonly productsService: ProductsService,
    private readonly followsService: FollowsService,
    private readonly userTagService: UserTagService,
    private readonly userProfileService: UserProfileService
  ) {}

  // ── Public ────────────────────────────────────────────────────────────────

  /** Returns associations. Pass `?type=association|list` to restrict; omit for both. */
  @Get()
  list(@Query('type') type?: string) {
    const filter = type === 'association' || type === 'list' ? type : undefined;
    return this.service.list(filter);
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

  /** Public - current association memberships for a user profile. */
  @Get('users/:userId/memberships')
  listUserMemberships(@Param('userId') userId: string) {
    return this.userProfileService.listMemberships(userId);
  }

  /** Public - past/honorary association roles for a user profile. */
  @Get('users/:userId/role-history')
  listUserRoleHistory(@Param('userId') userId: string) {
    return this.userProfileService.listRoleHistory(userId);
  }

  /** Adds a past role entry to the caller's profile. */
  @UseGuards(NginxAuthGuard)
  @Post('users/me/role-history')
  createMyRoleHistory(@Headers('x-user-id') userId: string, @Body() dto: CreateRoleHistoryDto) {
    return this.userProfileService.createRoleHistory(userId, dto);
  }

  /** Updates a past role entry on the caller's profile. */
  @UseGuards(NginxAuthGuard)
  @Patch('users/me/role-history/:entryId')
  updateMyRoleHistory(
    @Headers('x-user-id') userId: string,
    @Param('entryId') entryId: string,
    @Body() dto: UpdateRoleHistoryDto
  ) {
    return this.userProfileService.updateRoleHistory(userId, entryId, dto);
  }

  /** Removes a past role entry from the caller's profile. */
  @UseGuards(NginxAuthGuard)
  @Delete('users/me/role-history/:entryId')
  deleteMyRoleHistory(@Headers('x-user-id') userId: string, @Param('entryId') entryId: string) {
    return this.userProfileService.deleteRoleHistory(userId, entryId);
  }

  /**
   * Aggregated agenda across associations (`startsAt` in `[from, to]`).
   * Optional `associationId` limits to one association. Public.
   */
  @Get('calendar/feed')
  async aggregatedCalendarFeed(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('associationId') associationId?: string,
    @Query('includePending') includePending?: string,
    @Headers('x-user-id') userId?: string,
    @Headers('x-global-admin') ga?: string
  ) {
    // includePending is opt-in (the PDF export does not set it -> validated events only).
    // Honoured only for users allowed to propose (any asso), BDE admins, or global admins.
    let include = false;
    if ((includePending === 'true' || includePending === '1') && userId?.trim()) {
      include =
        ga === 'true' ||
        (await this.service.canViewPendingCalendarEvents(userId.trim())) ||
        (await this.service.isUserBdeAdmin(userId.trim()));
    }
    return this.service.listAggregatedCalendarFeed(from, to, associationId, {
      includePending: include,
    });
  }

  /**
   * Returns the iCalendar document for the aggregated feed.
   * Suitable for "subscribe by URL" in Apple/Google Calendar.
   */
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

  /**
   * Pending agenda events the caller may see.
   * Global admin or BDE admin (VALIDATE_EVENTS) sees all; association admins (PROPOSE_EVENT) see only their own.
   * Response includes `canValidate` so the frontend can conditionally show the validate button.
   */
  @UseGuards(NginxAuthGuard)
  @Get('calendar/pending')
  async listPendingCalendarEvents(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    const isGlobalAdmin = ga === 'true';
    let isBde = false;
    if (!isGlobalAdmin) {
      isBde = await this.service.isUserBdeAdmin(userId);
      const can = isBde || (await this.service.canViewPendingCalendarEvents(userId));
      if (!can) {
        throw new ForbiddenException('Association admin or global admin required');
      }
    }
    const events = await this.service.listPendingCalendarEvents(userId, { isGlobalAdmin });
    return { canValidate: isGlobalAdmin || isBde, events };
  }

  /**
   * Lists members of an association.
   * Returns `permissions` bitmask only when the caller holds `MANAGE_MEMBERS`; otherwise only `isAdmin` (boolean).
   */
  @UseGuards(NginxAuthGuard)
  @Get(':id/members')
  async listMembers(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    const isGlobalAdmin = ga === 'true';
    let includePermissions = isGlobalAdmin;
    if (!isGlobalAdmin) {
      includePermissions = await this.service.callerHasFlag(
        userId,
        id,
        AssociationPermissionFlag.MANAGE_MEMBERS
      );
    }
    return this.service.listMembers(id, { includePermissions, callerId: userId });
  }

  /** Updates the display order of members. Requires MANAGE_MEMBERS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id/members/reorder')
  reorderMembers(@Param('id') id: string, @Body() dto: ReorderMembersDto) {
    return this.service.reorderMembers(id, dto.userIds);
  }

  /** Returns scheduled events for the association (optional `from` / `to` ISO date bounds). */
  @Get(':id/events')
  async listCalendarEvents(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('includePending') includePending?: string,
    @Query('includeRejected') includeRejected?: string,
    @Headers('x-user-id') userId?: string,
    @Headers('x-global-admin') ga?: string
  ) {
    // A member allowed to propose (any asso), a BDE admin, or a global admin
    // can see pending events on the calendar of ALL associations.
    const wantPending = includePending === 'true' || includePending === '1';
    const wantRejected = includeRejected === 'true' || includeRejected === '1';
    let include = false;
    let includeRej = false;
    if (userId?.trim()) {
      const uid = userId.trim();
      if (wantPending) {
        include =
          ga === 'true' ||
          (await this.service.canViewPendingCalendarEvents(uid)) ||
          (await this.service.isUserBdeAdmin(uid));
      }
      // Rejected events (management view) are only visible to editors of THIS asso.
      if (wantRejected) {
        includeRej = await this.service.canPostAs(uid, id, { isGlobalAdmin: ga === 'true' });
      }
    }
    return this.service.listCalendarEvents(id, from, to, {
      includePending: include,
      includeRejected: includeRej,
    });
  }

  /** Returns whether the calling user is following the specified association. */
  @UseGuards(NginxAuthGuard)
  @Get(':id/follow-status')
  followStatus(@Headers('x-user-id') userId: string, @Param('id') id: string) {
    return this.followsService.isFollowing(userId, id).then((following) => ({ following }));
  }

  /**
   * Returns whether the calling user may manage Stripe Connect for the association.
   * Used by core-service before starting Connect onboarding.
   */
  @UseGuards(NginxAuthGuard)
  @Get(':id/manage-permission')
  async managePermission(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id') id: string
  ) {
    const ok = await this.service.canManageStripeConnect(userId, id, {
      isGlobalAdmin: ga === 'true',
    });
    return { ok };
  }

  /** Recent posts and forms for this association (picker when linking calendar ↔ content). */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.PROPOSE_EVENT)
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

  // ── Global Admin OR BDE MANAGE_ASSO ──────────────────────────────────────

  /**
   * Creates a new association.
   * Allowed for global admins, or BDE members holding the MANAGE_ASSO flag.
   */
  @UseGuards(NginxAuthGuard)
  @Post()
  async create(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: CreateAssociationDto
  ) {
    const isGlobalAdmin = ga === 'true';
    if (!isGlobalAdmin) {
      // isUserBdeAdmin checks VALIDATE_EVENTS; MANAGE_ASSO is a separate flag
      const canCreateAsso = await this.service.callerHasAnyBdeFlag(
        userId,
        AssociationPermissionFlag.MANAGE_ASSO
      );
      if (!canCreateAsso) {
        throw new ForbiddenException('Global admin or BDE MANAGE_ASSO permission required');
      }
    }
    return this.service.create(dto, userId);
  }

  /** Deletes an association; requires global admin privileges. */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  // ── Global Admin OR Association Admin (MANAGE_MEMBERS) ───────────────────

  /**
   * Updates association details.
   * `isBDE` and `documentQuotaBytes` are silently ignored unless the caller is a global admin.
   * Cotisation config fields (`cotisationEnabled`/`cotisationMode`/`cotisationExpiresAt`) require
   * MANAGE_PRODUCTS (D5), stricter than this endpoint's baseline MANAGE_MEMBERS. When enabling,
   * the canonical cotisation product is provisioned/synced (see `provisionCotisationProduct`).
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: UpdateAssociationDto
  ) {
    const patch = { ...dto };
    const isGlobalAdmin = ga === 'true';
    if (!isGlobalAdmin) {
      // Only global admins may toggle BDE status or adjust document quota
      delete patch.isBDE;
      delete patch.documentQuotaBytes;
    }

    const touchesCotisation =
      patch.cotisationEnabled !== undefined ||
      patch.cotisationMode !== undefined ||
      patch.cotisationExpiresAt !== undefined;
    if (touchesCotisation && !isGlobalAdmin) {
      const canManageProducts =
        (await this.service.isAssociationSuperAdmin(userId)) ||
        (await this.service.callerHasFlag(userId, id, AssociationPermissionFlag.MANAGE_PRODUCTS));
      if (!canManageProducts) {
        throw new ForbiddenException(
          'MANAGE_PRODUCTS permission required to edit cotisation settings'
        );
      }
    }

    const updated = await this.service.update(id, patch);
    if (touchesCotisation && updated.cotisationEnabled) {
      await this.productsService.provisionCotisationProduct(updated);
    }
    return updated;
  }

  /** Uploads and sets a new logo for the association. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
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
      { buffer: file.buffer, mimetype: file.mimetype, size: file.size },
      authorization
    );
  }

  /** Removes the stored logo from an association. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/logo')
  deleteLogo(@Param('id') id: string, @Headers('authorization') authorization: string | undefined) {
    return this.service.clearStoredLogo(id, authorization);
  }

  /** Adds a user as a member of the association with the specified role. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() dto: AddMemberDto) {
    return this.service.addMember({ associationId: id, ...dto });
  }

  /** Updates the role or permission bitmask of an existing association member. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id/members/:userId')
  async updateMemberRole(
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Headers('x-user-id') callerId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: UpdateMemberRoleDto
  ) {
    const isGlobalAdmin = ga === 'true';
    const isBde = isGlobalAdmin ? false : await this.service.isUserBdeAdmin(callerId);
    return this.service.updateMemberRole(id, targetUserId, dto.role, dto.permissions, {
      bypassLastAdmin: isGlobalAdmin || isBde,
    });
  }

  /** Removes a member from the association. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/members/:userId')
  async removeMember(
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Headers('x-user-id') callerId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    const isGlobalAdmin = ga === 'true';
    const isBde = isGlobalAdmin ? false : await this.service.isUserBdeAdmin(callerId);
    return this.service.removeMember(id, targetUserId, { bypassLastAdmin: isGlobalAdmin || isBde });
  }

  // ── Calendar (PROPOSE_EVENT flag) ─────────────────────────────────────────

  /**
   * Creates a calendar event for the association.
   * BDE admins and global admins: validated immediately, may target another association via `targetAssocId`.
   * Regular admins with PROPOSE_EVENT: goes into pending queue.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.PROPOSE_EVENT)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/events')
  async createCalendarEvent(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id') id: string,
    @Body() dto: CreateAssociationCalendarEventDto
  ) {
    const isGlobalAdmin = ga === 'true';
    const isBde = isGlobalAdmin ? false : await this.service.isUserBdeAdmin(userId);
    return this.service.createCalendarEvent(id, dto, userId, { isGlobalAdmin, isBde });
  }

  /**
   * Updates a calendar event.
   * BDE admins and global admins may update events from any association.
   */
  @UseGuards(NginxAuthGuard)
  @Patch(':id/events/:eventId')
  async updateCalendarEvent(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() dto: UpdateAssociationCalendarEventDto
  ) {
    const isGlobalAdmin = ga === 'true';
    const isBde = isGlobalAdmin ? false : await this.service.isUserBdeAdmin(userId);
    if (!isGlobalAdmin && !isBde) {
      // Regular admin must have PROPOSE_EVENT in this association
      const hasPerm = await this.service.callerHasFlag(
        userId,
        id,
        AssociationPermissionFlag.PROPOSE_EVENT
      );
      if (!hasPerm) {
        throw new ForbiddenException('PROPOSE_EVENT flag or BDE admin required');
      }
    }
    return this.service.updateCalendarEvent(id, eventId, dto, {
      isGlobalAdmin,
      isBde,
      callerUserId: userId,
    });
  }

  /**
   * Deletes a calendar event.
   * BDE admins and global admins may delete events from any association.
   */
  @UseGuards(NginxAuthGuard)
  @Delete(':id/events/:eventId')
  async deleteCalendarEvent(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id') id: string,
    @Param('eventId') eventId: string
  ) {
    const isGlobalAdmin = ga === 'true';
    const isBde = isGlobalAdmin ? false : await this.service.isUserBdeAdmin(userId);
    if (!isGlobalAdmin && !isBde) {
      const hasPerm = await this.service.callerHasFlag(
        userId,
        id,
        AssociationPermissionFlag.PROPOSE_EVENT
      );
      if (!hasPerm) {
        throw new ForbiddenException('PROPOSE_EVENT flag or BDE admin required');
      }
    }
    return this.service.deleteCalendarEvent(id, eventId, {
      isGlobalAdmin,
      isBde,
      callerUserId: userId,
    });
  }

  /**
   * Validates a pending calendar event (makes it publicly visible).
   * Requires VALIDATE_EVENTS in a BDE association, or global admin.
   */
  @UseGuards(NginxAuthGuard)
  @Post(':id/events/:eventId/validate')
  async validateCalendarEvent(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id') id: string,
    @Param('eventId') eventId: string
  ) {
    const isGlobalAdmin = ga === 'true';
    if (!isGlobalAdmin) {
      const isBde = await this.service.isUserBdeAdmin(userId);
      if (!isBde) {
        throw new ForbiddenException(
          'Only BDE admins (VALIDATE_EVENTS flag) or global admins can validate events'
        );
      }
    }
    return this.service.validateCalendarEvent(id, eventId, userId);
  }

  /**
   * Rejects a pending calendar event; keeps it visible to asso admins with an optional reason.
   * Requires VALIDATE_EVENTS in a BDE association, or global admin.
   */
  @UseGuards(NginxAuthGuard)
  @Post(':id/events/:eventId/reject')
  async rejectCalendarEvent(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() dto: RejectCalendarEventDto
  ) {
    const isGlobalAdmin = ga === 'true';
    if (!isGlobalAdmin) {
      const isBde = await this.service.isUserBdeAdmin(userId);
      if (!isBde) {
        throw new ForbiddenException(
          'Only BDE admins (VALIDATE_EVENTS flag) or global admins can reject events'
        );
      }
    }
    return this.service.rejectCalendarEvent(id, eventId, userId, dto.reason);
  }

  // ── Calendar event image ─────────────────────────────────────────────────

  /** Uploads a poster/banner image for a calendar event. Requires MANAGE_EVENTS or global admin. */
  @UseGuards(NginxAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  @Post(':id/events/:eventId/image')
  uploadEventImage(
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @UploadedFile() file: Express.Multer.File,
    @Headers('authorization') authorization: string | undefined
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.service.setEventImageFromUpload(id, eventId, file, authorization);
  }

  /** Removes the poster image from a calendar event. Requires MANAGE_EVENTS or global admin. */
  @UseGuards(NginxAuthGuard)
  @Delete(':id/events/:eventId/image')
  deleteEventImage(
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Headers('authorization') authorization: string | undefined
  ) {
    return this.service.clearEventImage(id, eventId, authorization);
  }

  // ── Document vault (MANAGE_DOCUMENTS flag) ───────────────────────────────

  /**
   * Returns the hex vault key for the association (generates it on first call).
   * Client derives per-document CEK via HKDF(vaultKey, salt=docId, info="doc-vault").
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_DOCUMENTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/vault-key')
  getVaultKey(@Param('id') id: string) {
    return this.service.getOrCreateVaultKey(id).then((key) => ({ key }));
  }

  /** Lists documents in the vault with quota usage stats (no mediaId). */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_DOCUMENTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/documents')
  listDocuments(@Param('id') id: string) {
    return this.service.listDocuments(id);
  }

  /**
   * Registers a new document in the vault.
   * Returns 409 if a document with the same name exists; 413 if quota exceeded.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_DOCUMENTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/documents')
  createDocument(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Body() dto: CreateAssociationDocumentDto
  ) {
    return this.service.createDocument(id, dto, userId);
  }

  /** Returns full document detail including mediaId (for decryption + download). */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_DOCUMENTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/documents/:docId')
  getDocumentDetail(@Param('id') id: string, @Param('docId') docId: string) {
    return this.service.getDocumentDetail(id, docId);
  }

  /** Deletes a document record and its media blob. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_DOCUMENTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/documents/:docId')
  deleteDocument(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Headers('authorization') authorization: string | undefined
  ) {
    return this.service.deleteDocument(id, docId, authorization);
  }

  /** Returns the association's vault-encrypted shared notepad (opaque ciphertext). */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_DOCUMENTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/notes')
  async getNotes(@Param('id') id: string) {
    const ciphertext = await this.service.getNotesCiphertext(id);
    return { ciphertext };
  }

  /** Stores the association's vault-encrypted shared notepad. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_DOCUMENTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Put(':id/notes')
  async setNotes(@Param('id') id: string, @Body() dto: UpdateAssociationNotesDto) {
    await this.service.setNotesCiphertext(id, dto.ciphertext ?? '');
    return { ok: true };
  }

  // ── Forms (MANAGE_FORMS flag) ────────────────────────────────────────────

  /** Returns all forms linked to this association (admins with MANAGE_FORMS only). */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_FORMS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/forms')
  listAssociationForms(@Param('id') id: string) {
    return this.service.listFormsByAssociation(id);
  }

  // ── Cotisation tags (MANAGE_MEMBERS flag) ────────────────────────────────

  /**
   * Searches distinct tag names for an association (products, forms, grants).
   * Any association member may call this when configuring forms or products.
   */
  @UseGuards(NginxAuthGuard)
  @Get(':id/tag-catalog')
  async searchTagCatalog(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') globalAdmin: string,
    @Query('q') q?: string
  ) {
    const isGlobalAdmin = globalAdmin === 'true';
    if (!isGlobalAdmin && !(await this.service.isMember(userId, id))) {
      throw new ForbiddenException('Access restricted to association members.');
    }
    return this.service.searchTagCatalog(id, q);
  }

  /** Lists active tags issued by this association (admins with MANAGE_MEMBERS only). */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/tags')
  listTags(@Param('id') id: string) {
    return this.userTagService.listByAssoc(id);
  }

  /**
   * Manually grants a cotisation tag to a user (cash payment or admin override).
   * Requires MANAGE_MEMBERS flag.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/tags')
  grantTag(
    @Param('id') id: string,
    @Headers('x-user-id') grantedBy: string,
    @Body() dto: GrantTagDto
  ) {
    return this.userTagService.grantOrRenew({
      userId: dto.userId,
      tagName: dto.tagName,
      issuingAssocId: id,
      grantedBy,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });
  }

  /** Revokes a cotisation tag. Requires MANAGE_MEMBERS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/tags/:tagId')
  revokeTag(@Param('tagId') tagId: string) {
    return this.userTagService.revoke(tagId);
  }

  /**
   * Returns a searchable, paginated, promo-sorted page of the association's active
   * cotisant roster (D9). Requires MANAGE_MEMBERS flag.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/cotisants')
  listCotisants(@Param('id') id: string, @Query() query: ListCotisantsQueryDto) {
    return this.userTagService.listCotisants(id, {
      search: query.search,
      offset: query.offset,
      limit: query.limit,
    });
  }

  /**
   * Manually adds a cotisant: grants the association's canonical cotisation tag to a user
   * (D10, tag only - no payment recorded). The tag is derived server-side. Requires MANAGE_MEMBERS.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/cotisants')
  grantCotisant(
    @Param('id') id: string,
    @Headers('x-user-id') grantedBy: string,
    @Body() dto: GrantCotisantDto
  ) {
    return this.userTagService.grantCotisant(id, dto.userId, grantedBy);
  }

  /**
   * Exports the association's full active cotisant roster as an XLSX download (D8).
   * Requires MANAGE_MEMBERS flag.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/cotisants/export')
  async exportCotisants(@Param('id') id: string, @Res() res: Response) {
    const { buffer, title } = await this.userTagService.exportCotisants(id);

    // ASCII fallback (strips accents) + RFC 5987 UTF-8 encoded filename for modern browsers
    const asciiName =
      title
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .trim()
        .replace(/\s+/g, '_') || 'cotisants';
    const encodedName = encodeURIComponent(title);

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${asciiName}.xlsx"; filename*=UTF-8''${encodedName}.xlsx`,
      'Content-Length': buffer.byteLength,
    });

    res.send(Buffer.from(buffer));
  }

  // ── Boutique (products) ───────────────────────────────────────────────────

  /** Returns all active products across all associations (requires login). Used on /shop. */
  @UseGuards(NginxAuthGuard)
  @Get('products/all')
  listAllProducts(@Headers('x-user-id') userId: string) {
    return this.productsService.listAllActive(userId);
  }

  /** Returns active products for this association (shown on the public association page). */
  @Get(':id/products')
  listAssociationProducts(@Param('id') id: string) {
    return this.productsService.listByAssoc(id);
  }

  /** Returns all products including inactive ones. Requires MANAGE_PRODUCTS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/products/manage')
  listAssociationProductsForManage(@Param('id') id: string) {
    return this.productsService.listAllByAssoc(id);
  }

  /** Lists all paid purchases for this association. Requires MANAGE_PRODUCTS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/purchases')
  listAssociationPurchases(@Param('id') id: string) {
    return this.productsService.listAssociationPurchases(id);
  }

  /** Lists buyers for a boutique product. Requires MANAGE_PRODUCTS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/products/:productId/purchases')
  listProductPurchases(@Param('id') id: string, @Param('productId') productId: string) {
    return this.productsService.listProductPurchases(id, productId);
  }

  /**
   * Manually grants a product to a user as if they had purchased it (cash, retroactive).
   * Requires MANAGE_PRODUCTS flag.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/products/:productId/grant')
  grantProductPurchase(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Headers('x-user-id') grantedBy: string,
    @Body() dto: GrantProductPurchaseDto
  ) {
    return this.productsService.grantProductPurchase(id, productId, grantedBy, dto);
  }

  /**
   * Creates a new product in the association's boutique.
   * Requires MANAGE_PRODUCTS flag. Product is inactive until Stripe Connect onboarding is complete.
   * `balance_topup` (Cercle) products additionally require a platform global admin (D7) -
   * enforced in the service, not just this guard.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/products')
  createProduct(
    @Param('id') id: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: CreateProductDto
  ) {
    return this.productsService.create(id, dto, ga === 'true');
  }

  /**
   * Updates a product in the association's boutique. Requires MANAGE_PRODUCTS flag.
   * Updating an existing `balance_topup` (Cercle) product additionally requires a platform
   * global admin (D7) - enforced in the service, not just this guard.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id/products/:productId')
  updateProduct(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: UpdateProductDto
  ) {
    return this.productsService.update(id, productId, dto, ga === 'true');
  }

  /** Removes a product from the association's boutique. Requires MANAGE_PRODUCTS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/products/:productId')
  deleteProduct(@Param('id') id: string, @Param('productId') productId: string) {
    return this.productsService.delete(id, productId);
  }

  /**
   * Creates a Stripe Checkout session for a product purchase (login required).
   * Optional body: `{ customAmountCents: number }` for products allowing custom amounts.
   */
  @UseGuards(NginxAuthGuard)
  @Post(':id/products/:productId/checkout')
  checkout(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Headers('x-user-id') userId: string,
    @Body() body?: { customAmountCents?: number; successUrl?: string; cancelUrl?: string }
  ) {
    return this.productsService.createCheckoutSession(
      id,
      productId,
      userId,
      body?.customAmountCents,
      { successUrl: body?.successUrl, cancelUrl: body?.cancelUrl }
    );
  }

  /** Lists failed Cercle webhook deliveries for admin retry. Requires MANAGE_PRODUCTS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/webhook-failures')
  listWebhookFailures(@Param('id') id: string) {
    return this.productsService.listWebhookFailures(id);
  }

  /** Retries a failed Cercle webhook delivery. Requires MANAGE_PRODUCTS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/webhook-failures/:deliveryId/retry')
  retryWebhookDelivery(@Param('deliveryId') deliveryId: string) {
    return this.productsService.retryWebhookDelivery(deliveryId);
  }

  // ── Payment delegation (parent-association Stripe routing) ─────────────────

  /** Returns this association's payment-delegation state. Requires MANAGE_PRODUCTS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/payment-delegation')
  getPaymentDelegation(@Param('id') id: string) {
    return this.service.getPaymentDelegation(id);
  }

  /**
   * Requests that this association's payments route to a parent association's Stripe account.
   * Creates a `pending` link the parent must approve. Requires MANAGE_PRODUCTS flag.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/payment-delegation')
  requestPaymentDelegation(@Param('id') id: string, @Body() dto: RequestPaymentDelegationDto) {
    return this.service.requestPaymentDelegation(id, dto.parentAssociationId);
  }

  /** Clears this association's payment delegation (cancel pending or drop approved). Requires MANAGE_PRODUCTS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/payment-delegation')
  cancelPaymentDelegation(@Param('id') id: string) {
    return this.service.cancelPaymentDelegation(id);
  }

  /**
   * Lists associations requesting or granted delegation to this one (the parent's approval queue).
   * `:id` is the parent; the guard proves the caller administers it. Requires MANAGE_PRODUCTS.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/payment-delegation/children')
  listDelegatedChildren(@Param('id') id: string) {
    return this.service.listDelegatedChildren(id);
  }

  /** Approves a child's pending delegation request. `:id` is the parent. Requires MANAGE_PRODUCTS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/payment-delegation/children/:childId/approve')
  approvePaymentDelegation(@Param('id') id: string, @Param('childId') childId: string) {
    return this.service.approvePaymentDelegation(id, childId);
  }

  /** Rejects a pending request or revokes an approved child's delegation. `:id` is the parent. Requires MANAGE_PRODUCTS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/payment-delegation/children/:childId/reject')
  rejectPaymentDelegation(@Param('id') id: string, @Param('childId') childId: string) {
    return this.service.rejectPaymentDelegation(id, childId);
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

  /**
   * Called by core-service Stripe webhook when a product purchase completes.
   * No auth guard - only reachable from the internal Docker network.
   */
  @Post('products/:productId/purchase-completed')
  purchaseCompleted(
    @Param('productId') productId: string,
    @Body() body: { userId: string; amountCents: number; paymentIntentId: string }
  ) {
    return this.productsService.handlePurchaseCompleted(
      productId,
      body.userId,
      body.amountCents,
      body.paymentIntentId
    );
  }
}
