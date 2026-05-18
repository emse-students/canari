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
  CreateAssociationCalendarEventDto,
  CreateProductDto,
  GrantTagDto,
  UpdateAssociationDto,
  UpdateAssociationCalendarEventDto,
  UpdateMemberRoleDto,
  UpdateProductDto,
} from './dto/association.dto';
import { UserTagService } from '../users/user-tag.service';
import { buildAggregatedCalendarIcs } from './calendar-ics.util';

const LOGO_UPLOAD_MB = 2;

/** Manages association resources including membership, logo, Stripe onboarding, follow relationships, and boutique products. */
@Controller('associations')
export class AssociationsController {
  constructor(
    private readonly service: AssociationsService,
    private readonly productsService: ProductsService,
    private readonly followsService: FollowsService,
    private readonly userTagService: UserTagService
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
   * Global admin or BDE admin sees all; association admins see only their own.
   */
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
    return this.service.listMembers(id, { includePermissions });
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

  /** Returns whether the calling user has permission to post on behalf of the association. */
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

  // ── Global Admin OR BDE CREATE_ASSO ──────────────────────────────────────

  /**
   * Creates a new association.
   * Allowed for global admins, or BDE members holding the CREATE_ASSO flag.
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
      // isUserBdeAdmin checks VALIDATE_EVENTS; CREATE_ASSO is a separate flag
      const canCreateAsso = await this.service.callerHasAnyBdeFlag(
        userId,
        AssociationPermissionFlag.CREATE_ASSO
      );
      if (!canCreateAsso) {
        throw new ForbiddenException('Global admin or BDE CREATE_ASSO permission required');
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
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: UpdateAssociationDto
  ) {
    const patch = { ...dto };
    if (ga !== 'true') {
      // Only global admins may toggle BDE status or adjust document quota
      delete patch.isBDE;
      delete patch.documentQuotaBytes;
    }
    return this.service.update(id, patch);
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
  updateMemberRole(
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() dto: UpdateMemberRoleDto
  ) {
    return this.service.updateMemberRole(id, targetUserId, dto.role, dto.permissions);
  }

  /** Removes a member from the association. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/members/:userId')
  removeMember(@Param('id') id: string, @Param('userId') targetUserId: string) {
    return this.service.removeMember(id, targetUserId);
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

  // ── Cotisation tags (MANAGE_MEMBERS flag) ────────────────────────────────

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

  // ── Boutique (products) ───────────────────────────────────────────────────

  /** Returns all active products across all associations (requires login). Used on /shop. */
  @UseGuards(NginxAuthGuard)
  @Get('products/all')
  listAllProducts() {
    return this.productsService.listAllActive();
  }

  /** Returns active products for this association (shown on the public association page). */
  @Get(':id/products')
  listAssociationProducts(@Param('id') id: string) {
    return this.productsService.listByAssoc(id);
  }

  /**
   * Creates a new product in the association's boutique.
   * Requires MANAGE_PRODUCTS flag. Product is inactive until Stripe Connect onboarding is complete.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/products')
  createProduct(@Param('id') id: string, @Body() dto: CreateProductDto) {
    return this.productsService.create(id, dto);
  }

  /** Updates a product in the association's boutique. Requires MANAGE_PRODUCTS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id/products/:productId')
  updateProduct(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body() dto: UpdateProductDto
  ) {
    return this.productsService.update(id, productId, dto);
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
    @Body() body?: { customAmountCents?: number }
  ) {
    return this.productsService.createCheckoutSession(
      id,
      productId,
      userId,
      body?.customAmountCents
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
   * No auth guard — only reachable from the internal Docker network.
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
