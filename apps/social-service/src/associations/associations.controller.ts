import { Throttle } from '@nestjs/throttler';
import { mayCollect } from './collection-policy';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  GoneException,
  Query,
  Res,
  SetMetadata,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { isUUID } from 'class-validator';
import { FileInterceptor } from '@nestjs/platform-express';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { isInReviewCohort, profileOpenAcrossCohort } from '../review-cohort';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import { CONFIRM_PAYMENT_PER_MINUTE } from '../forms/forms.controller';
import {
  PERM_FLAG_KEY,
  GlobalAdminOrAssociationRoleGuard,
} from './guards/global-admin-or-association-role.guard';
import { GlobalAdminOrBdeSuperAdminGuard } from './guards/global-admin-or-bde-super-admin.guard';
import { ReviewerAccessGuard } from './guards/reviewer-access.guard';
import { AssociationPermissionFlag } from './entities/association-member.entity';
import { toAssociationView } from './association.projection';
import { SpacesService } from '../spaces/spaces.service';
import { AssociationsService } from './associations.service';
import { ProductsService } from './products.service';
import { PartnershipsService } from './partnerships.service';
import { assertInternalSecret } from '../internal/internal-secret.util';
import { FollowsService } from '../follows/follows.service';
import { AccountBellsService } from '../follows/account-bells.service';
import {
  AddMemberDto,
  CreateAssociationDto,
  AddDocumentReviewerDto,
  CreateAssociationDocumentDto,
  UpdateAssociationDocumentDto,
  UpdateAssociationNotesDto,
  CreateAssociationCalendarEventDto,
  CreateProductDto,
  GrantCotisantDto,
  ClosePaidNotGrantedDto,
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
import {
  AddPartnershipCodesDto,
  CreatePartnershipCardDto,
  UpdatePartnershipCardDto,
} from './dto/partnership.dto';
import { UserTagService } from '../users/user-tag.service';
import { UserProfileService } from './user-profile.service';
import { CreateRoleHistoryDto, UpdateRoleHistoryDto } from './dto/user-profile.dto';
import { buildAggregatedCalendarIcs } from './calendar-ics.util';
import { sanitizeLog } from '../common/log.utils';
import {
  ASSOCIATION_FIELD_PLATFORM_ADMIN_ONLY,
  ASSOCIATION_FIELD_RIGHT_MISSING,
  rightsAskedBy,
} from './association-update-rights';
import { wholeCentsOf } from '../common/core-payment-error';
import {
  AGENDA_SELECTION_REQUIRED,
  assertAgendaAccess,
  parseDirectoryQuery,
  parseSpaceSelection,
} from './directory-query';
import {
  EVENT_ICS_REFUSED_TAG,
  eventIcsSignatureMatches,
  withEventIcsSig,
} from './agenda-signature';

const LOGO_UPLOAD_MB = 2;

/**
 * The `code` of the 410 the retired key-paste route answers to the old store builds that still
 * show the field (docs/wiki/legacy-compatibility.md).
 */
export const LYDIA_KEY_PASTE_RETIRED = 'LYDIA_KEY_PASTE_RETIRED';

/**
 * Per user and association, the retired paste route's throttle - the one the live route had, so a
 * stuck old screen retrying cannot flood the WARN its hits are counted by.
 */
export const LYDIA_KEY_PASTE_SHIM_PER_MINUTE = 5;

/** The `code` of the 403 a BDE caller gets deleting an institution: the global admin's alone (2026-11-02). */
export const INSTITUTION_DELETE_ADMIN_ONLY = 'INSTITUTION_DELETE_ADMIN_ONLY';

/** Manages association resources including membership, logo, payout onboarding, follow relationships, and boutique products. */
@Controller('associations')
export class AssociationsController {
  private readonly logger = new Logger(AssociationsController.name);

  constructor(
    private readonly service: AssociationsService,
    private readonly productsService: ProductsService,
    private readonly partnershipsService: PartnershipsService,
    private readonly followsService: FollowsService,
    private readonly userTagService: UserTagService,
    private readonly userProfileService: UserProfileService,
    private readonly pushMutes: AccountBellsService,
    private readonly spaces: SpacesService
  ) {}

  // ── Document reviewers & cross-association review ────────────────────────────
  // NOTE: these static-prefixed routes are declared BEFORE the `:id` routes below
  // so Express does not shadow e.g. `reviewer/documents` with `:id/documents`.

  /**
   * Probe for the current user's document-reviewer entitlement (global admin,
   * BDE super-admin, or an explicit grant). Any logged-in user may call it; it
   * returns a boolean rather than 403 so the frontend can gate the `/documents` route.
   */
  @UseGuards(NginxAuthGuard)
  @Get('reviewer/access')
  async reviewerAccess(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') globalAdmin: string | undefined
  ) {
    const hasAccess =
      globalAdmin === 'true' ||
      (await this.service.isAssociationSuperAdmin(userId)) ||
      (await this.service.isDocumentReviewer(userId));
    return { hasAccess };
  }

  /**
   * Lists every association's public documents (grouped by association) with a
   * server-derived per-document CEK for client-side decryption. Reviewer-gated.
   */
  @UseGuards(NginxAuthGuard, ReviewerAccessGuard)
  @Get('reviewer/documents')
  listReviewerDocuments() {
    return this.service.listReviewerDocuments();
  }

  /** Lists all document-reviewer grants. Global admins and BDE super-admins only. */
  @UseGuards(NginxAuthGuard, GlobalAdminOrBdeSuperAdminGuard)
  @Get('document-reviewers')
  listDocumentReviewers() {
    return this.service.listDocumentReviewers();
  }

  /** Grants document-reviewer access to a user. Global admins and BDE super-admins only. */
  @UseGuards(NginxAuthGuard, GlobalAdminOrBdeSuperAdminGuard)
  @Post('document-reviewers')
  addDocumentReviewer(
    @Headers('x-user-id') grantedBy: string,
    @Body() dto: AddDocumentReviewerDto
  ) {
    return this.service.addDocumentReviewer(dto.userId, grantedBy);
  }

  /** Revokes a user's document-reviewer access. Global admins and BDE super-admins only. */
  @UseGuards(NginxAuthGuard, GlobalAdminOrBdeSuperAdminGuard)
  @Delete('document-reviewers/:userId')
  removeDocumentReviewer(@Param('userId') userId: string) {
    return this.service.removeDocumentReviewer(userId);
  }

  // ── Association reads (logged-in members) ─────────────────────────────────
  //
  // These answer the member view of the row (`toAssociationView`, an allowlist: no payout account,
  // no vault key, no notes) - which still carries `createdBy`, the document quota and the cotisation
  // configuration. None of that belongs to an anonymous caller, and nginx does not stop one: `/api/associations`
  // sits behind `auth_request`, but `AuthController.check()` answers 200 for anonymous (it only
  // sets `X-Logged-In: false`), so the guard has to be here.
  //
  // The unauthenticated audience has its own surface, with its own explicit projection:
  // `/api/public/associations*` (`PublicController`, `toPublic`), which is also what the SSR head
  // reads. Adding a field there is a deliberate act; adding a column to the entity must not be.

  /**
   * Returns associations. `?type=association|list` restricts; omit for both.
   *
   * THE DIRECTORY (D37) BY DEFAULT: only the associations whose rules reach one of the caller's
   * spaces, plus those the caller is a member of - a global admin included, as in the feed.
   * `?scope=all` is the whole catalogue, for screens that PICK an association (see
   * `directory-query.ts`); it is open to any signed-in caller because a hidden association is not
   * a secret - its page stays reachable by its link. `?campus=` / `?formation=` keep only the
   * associations whose rules reach a space matching them (the association map), in either scope.
   */
  @UseGuards(NginxAuthGuard)
  @Get()
  async list(
    @Headers('x-user-id') userId: string,
    @Query('type') type?: string,
    @Query('scope') scope?: string,
    @Query('campus') campus?: string,
    @Query('formation') formation?: string
  ) {
    const query = parseDirectoryQuery({ type, scope, campus, formation });
    return (
      await this.service
        .list(query.type, {
          viewerId: query.scope === 'directory' ? userId?.trim() : undefined,
          campus: query.campus,
          formation: query.formation,
        })
        .then((rows) => this.service.withPaymentsReady(rows))
    ).map((row) => toAssociationView(row));
  }

  /** Returns an association looked up by its URL slug. */
  @UseGuards(NginxAuthGuard)
  @Get('slug/:slug')
  async findBySlug(@Param('slug') slug: string) {
    const [row] = await this.service.withPaymentsReady([await this.service.findBySlug(slug)]);
    return toAssociationView(row);
  }

  /** Returns all associations the calling user is a member of, with the caller's own permissions. */
  @UseGuards(NginxAuthGuard)
  @Get('me/list')
  async myAssociations(@Headers('x-user-id') userId: string) {
    return (await this.service.withPaymentsReady(await this.service.listByUser(userId))).map(
      (row) => toAssociationView(row)
    );
  }

  /**
   * The associations whose BDE grants the caller each scoped power (WP6c step 2): `validateEvents`
   * (VALIDATE_EVENTS - validate, edit, deposit on, declare a break for) and `manageAsso`
   * (MANAGE_ASSO - administer as a super-admin). Computed by the server's own predicate so the
   * client draws per-association controls from the rule that will judge them, never from "is a BDE
   * somewhere". A global admin holds every power and the client already knows that tier.
   */
  @UseGuards(NginxAuthGuard)
  @Get('me/bde-reach')
  async myBdeReach(@Headers('x-user-id') userId: string) {
    const [validateEvents, manageAsso] = await Promise.all([
      // The agenda rule (owner, 2026-11-03): an institution's events are in it, its management is not.
      this.service.associationsUnderBdeAgendaRight(userId),
      this.service.associationsUnderBdeFlag(userId, AssociationPermissionFlag.MANAGE_ASSO),
    ]);
    return { validateEvents, manageAsso };
  }

  /** Returns all associations the calling user is following. */
  @UseGuards(NginxAuthGuard)
  @Get('me/following')
  myFollowedAssociations(@Headers('x-user-id') userId: string) {
    return this.followsService.listFollowedAssociations(userId);
  }

  /**
   * LEGACY (engagement WP-3, L8): the associations whose bell the caller set to `none`, read from
   * `account_bells`. Kept for builds older than the bell control - docs/wiki/legacy-compatibility.md.
   */
  @UseGuards(NginxAuthGuard)
  @Get('me/push-mutes')
  myPushMutes(@Headers('x-user-id') userId: string) {
    return this.pushMutes.listMuted(userId);
  }

  /**
   * Current association memberships for a user profile. Empty across the review cohort's boundary
   * (`profileOpenAcrossCohort`).
   *
   * SIGNED-IN ONLY SINCE 2026-11-02: a person's profile is not something the public showcase
   * (portail-etu.emse.fr) shows, and nothing Canari serves without an account may go further than
   * it does ([anonymous-surface](../../../../docs/wiki/anonymous-surface.md)).
   */
  @UseGuards(NginxAuthGuard)
  @Get('users/:userId/memberships')
  async listUserMemberships(
    @Param('userId') userId: string,
    @Headers('x-user-id') viewerId: string
  ) {
    if (!profileOpenAcrossCohort(viewerId, userId)) return [];
    return this.userProfileService.listMemberships(userId);
  }

  /** Past/honorary association roles for a user profile, gated like the memberships. */
  @UseGuards(NginxAuthGuard)
  @Get('users/:userId/role-history')
  async listUserRoleHistory(
    @Param('userId') userId: string,
    @Headers('x-user-id') viewerId: string
  ) {
    if (!profileOpenAcrossCohort(viewerId, userId)) return [];
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
   * `from`/`to` default to a rolling window when omitted; optional `associationId` limits to
   * one association. Public.
   *
   * A SIGNED-IN READER'S HISTORY STOPS WHERE THEIR OWN DOES: nothing starting before the August
   * their promo opens on (`promo-visibility.ts`, the rule the posts feed already used). An
   * anonymous reader is unchanged, having no promo to stop at.
   */
  @Get('calendar/feed')
  async aggregatedCalendarFeed(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('associationId') associationId?: string,
    @Query('includePending') includePending?: string,
    @Headers('x-user-id') userId?: string,
    @Headers('x-global-admin') ga?: string,
    @Query('campus') campus?: string,
    @Query('formation') formation?: string,
    @Query('sig') sig?: string
  ) {
    const selection = parseSpaceSelection({ campus, formation });
    assertAgendaAccess({ selection, associationId, sig, signedIn: Boolean(userId?.trim()) });
    // includePending is opt-in (the PDF export does not set it -> validated events only).
    // Honoured only for users allowed to propose (any asso), BDE admins, or global admins.
    let include = false;
    if ((includePending === 'true' || includePending === '1') && userId?.trim()) {
      include =
        ga === 'true' ||
        (await this.service.canViewPendingCalendarEvents(userId.trim())) ||
        (await this.service.isUserBdeAdmin(userId.trim()));
    }
    return withEventIcsSig(
      await this.service.listAggregatedCalendarFeed(from, to, associationId, {
        includePending: include,
        viewer: { userId: userId?.trim(), isGlobalAdmin: ga === 'true' },
        selection,
      })
    );
  }

  /**
   * Returns the iCalendar document for the aggregated feed.
   * Suitable for "subscribe by URL" in Apple/Google Calendar - `from`/`to` are optional and
   * default to a rolling window (see `AssociationsService.defaultCalendarFeedRange`), since a
   * subscribed URL is saved once by the calendar app and re-polled forever with no way to ever
   * add query params to it.
   *
   * `eventId` (optional) keeps only that event of the window - see the filter below. Its `sig` is
   * the EVENT's signature (`signEventIcs`, served on the event as `icsSig`): an unsigned or wrongly
   * signed one is a BODYLESS 403, logged `[AGENDA_ICS_REFUSED]` (owner, 2026-11-02).
   *
   * `campus` / `formation` (D40, optional): ONE FEED PER SELECTION - only the events a space of that
   * campus / formation reaches. An anonymous read with neither (and no `associationId`) is REFUSED
   * with a 400 `AGENDA_SELECTION_REQUIRED`; an unknown value is a 400 too.
   *
   * **NO PROMO CUTOFF HERE, AND THAT IS NOT A HOLE.** A calendar app sends no identity and never
   * will, so there is no promo to cut at; and the cutoff is a relevance limit on a public agenda,
   * not a confidentiality boundary - see `promo-visibility.ts`. Anything that must be SECRET is
   * refused by a guard, and this route has never served anything of the sort.
   */
  @Get('calendar/feed.ics')
  async aggregatedCalendarFeedIcs(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('associationId') associationId: string | undefined,
    @Query('eventId') eventId: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Query('campus') campus?: string,
    @Query('formation') formation?: string,
    @Query('sig') sig?: string
  ) {
    const selection = parseSpaceSelection({ campus, formation });
    const wanted = eventId?.trim();
    if (wanted) {
      // ONE EVENT'S LINK IS SIGNED FOR THAT EVENT. A refusal has no body: the browser that opened it
      // has nothing to render, and the tag is what counts the old unsigned links still in use.
      if (!eventIcsSignatureMatches(wanted, sig)) {
        this.logger.warn(
          `${EVENT_ICS_REFUSED_TAG} event=${sanitizeLog(wanted.slice(0, 36))} signed=${Boolean(sig?.trim())}`
        );
        res.status(403);
        return '';
      }
    } else {
      // `.ics` is always anonymous: a calendar app sends no identity.
      assertAgendaAccess({ selection, associationId, sig, signedIn: false });
    }
    const all = await this.service.listAggregatedCalendarFeed(from, to, associationId, {
      selection,
    });
    // `eventId` narrows the feed to ONE event: the link a phone's browser opens to hand a single
    // evening to the calendar app (iOS Safari shows its "Add to Calendar" sheet for a text/calendar
    // response; Android downloads it for whichever calendar app owns .ics). Same route, same
    // builder, same UID as the subscription - so importing one and subscribing never doubles it.
    const rows = wanted ? all.filter((r) => r.id === wanted) : all;
    const body = buildAggregatedCalendarIcs(rows, {
      frontendBaseUrl: process.env.FRONTEND_URL || 'http://localhost',
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=120');
    return body;
  }

  /**
   * The signature a subscription URL needs (D40 amended 2026-10-06): signed-in readers only, and
   * only for a selection inside their own spaces (403 `AGENDA_SELECTION_FORBIDDEN` otherwise; 400
   * `AGENDA_SELECTION_REQUIRED` for an empty one). The result names no one, see `agenda-signature.ts`.
   */
  @UseGuards(NginxAuthGuard)
  @Post('calendar/feed-signature')
  async signCalendarFeedSelection(
    @Headers('x-user-id') userId: string,
    @Body() body: { campus?: string; formation?: string; associationId?: string }
  ) {
    const selection = parseSpaceSelection({ campus: body?.campus, formation: body?.formation });
    const associationId = body?.associationId?.trim() || null;
    if (selection.campus === null && selection.formation === null && !associationId) {
      throw new BadRequestException({
        code: AGENDA_SELECTION_REQUIRED,
        message: 'Name a campus, a formation or an association to sign',
      });
    }
    return this.service.signAgendaFeedSelection(userId, selection, associationId);
  }

  /**
   * The spaces (formation x campus) the caller's agenda reaches: the options of the agenda's space
   * filter, which narrows the view and grants nothing (owner, 2026-11-10).
   */
  @UseGuards(NginxAuthGuard)
  @Get('calendar/spaces')
  agendaReachedSpaces(@Headers('x-user-id') userId: string) {
    return this.service.listAgendaReachedSpaces(userId);
  }

  /**
   * Pending agenda events the caller may see.
   * A global admin sees all; a BDE validator sees those of the associations its spaces reach, plus
   * (like any association admin) those of its own associations. Every event carries `canValidate`.
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
    // `canValidate` here says the caller validates SOMETHING (it opens the queue); which rows is
    // each event's own `canValidate`, scoped to the BDE governing the event association.
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
    // A review account reads only the rosters it belongs to; nobody else but an admin reads a
    // review account on one (review-cohort-reach.ts, review-cohort.ts).
    await this.service.assertReviewerMayReadRoster(userId, id);
    const includePermissions = await this.service.mayAct(
      userId,
      id,
      AssociationPermissionFlag.MANAGE_MEMBERS,
      { isGlobalAdmin: ga === 'true' }
    );
    const members = await this.service.listMembers(id, { includePermissions, callerId: userId });
    if (ga === 'true' || isInReviewCohort(userId)) return members;
    return members.filter((m) => !isInReviewCohort(m.userId));
  }

  /** Updates the display order of members. Requires MANAGE_MEMBERS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id/members/reorder')
  reorderMembers(@Param('id') id: string, @Body() dto: ReorderMembersDto) {
    return this.service.reorderMembers(id, dto.userIds);
  }

  /**
   * Returns scheduled events for the association (optional `from` / `to` ISO date bounds).
   * Cut at the caller's own promo, exactly as the aggregated feed is - a limit only one of the two
   * honoured would be no limit at all, since this route lists the same rows.
   *
   * WITHOUT A SESSION IT ANSWERS AN EMPTY LIST (owner, 2026-11-02): no event is published to an
   * anonymous reader (`AssociationsService.isAnonymousAgendaRead`); a signed-in reader keeps their
   * spaces. Each validated event carries `icsSig`, the signature of its own `.ics` link.
   */
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
    return withEventIcsSig(
      await this.service.listCalendarEvents(id, from, to, {
        includePending: include,
        includeRejected: includeRej,
        viewer: { userId: userId?.trim(), isGlobalAdmin: ga === 'true' },
      })
    );
  }

  /** Returns whether the calling user is following the specified association. */
  @UseGuards(NginxAuthGuard)
  @Get(':id/follow-status')
  followStatus(@Headers('x-user-id') userId: string, @Param('id') id: string) {
    return this.followsService.isFollowing(userId, id).then((following) => ({ following }));
  }

  /**
   * Returns whether the calling user may manage the payout account of the association.
   * Used by core-service before starting Connect onboarding. A malformed id is a 400 from the pipe:
   * it would otherwise reach Postgres's `uuid` column through `mayAct` and answer a 500.
   */
  @UseGuards(NginxAuthGuard)
  @Get(':id/manage-permission')
  async managePermission(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id', ParseUUIDPipe) id: string
  ) {
    const ok = await this.service.canManagePayoutAccount(userId, id, {
      isGlobalAdmin: ga === 'true',
    });
    if (ok) return { ok };
    // A list or an institution holds no Lydia account of its own (G5): refused with a typed code
    // BEFORE core-service calls Lydia's `business/create`, never after the link fails.
    const code = await this.service.payoutAccountRefusal(id);
    if (code) this.logger.warn(`[PERM] payout account refused on ${sanitizeLog(id)}: ${code}`);
    return code ? { ok, code } : { ok };
  }

  /**
   * The association's payout account - the Lydia `vendor_token` and the dashboard URL - for the
   * Lydia panel. MANAGE_PAYOUT_ACCOUNT only, the permission the onboarding and the disconnect ask
   * (`canManagePayoutAccount`, which a BDE super-admin does not inherit). The member reads never
   * carry these two (`toAssociationView`): the token is all Lydia's `request/cancel` needs besides a
   * sequential request id. A malformed id is a 400 from the pipe, never a 500 from Postgres.
   */
  @UseGuards(NginxAuthGuard)
  @Get(':id/payout-account')
  async payoutAccount(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id', ParseUUIDPipe) id: string
  ) {
    const isGlobalAdmin = ga === 'true';
    const allowed = await this.service.canManagePayoutAccount(userId, id, { isGlobalAdmin });
    if (!allowed) {
      this.logger.debug(`[PERM] payout account read refused on ${sanitizeLog(id)}`);
      throw new ForbiddenException('MANAGE_PAYOUT_ACCOUNT permission required');
    }
    // A global admin also reads a bridge's both states (lydia-account-bridge.ts).
    return this.service.getPayoutAccount(id, { isGlobalAdmin });
  }

  /**
   * Whether the association's Lydia Business private token is stored - `{ set }` and NOTHING else,
   * ever: the key is write-only. MANAGE_PAYOUT_ACCOUNT only, like the payout account it belongs to.
   * Read by the paste field of the old store builds alone since enrolment lot 1; it goes with the
   * paste shim below (legacy-compatibility.md).
   */
  @UseGuards(NginxAuthGuard)
  @Get(':id/lydia-business-key')
  async lydiaBusinessKeyStatus(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<{ set: boolean }> {
    await this.assertPayoutAccountManager(userId, ga, id, 'Business key status read');
    return { set: await this.service.isLydiaBusinessKeySet(id) };
  }

  /**
   * RETIRED (enrolment lot 1): the key is captured at `business/create` and a pasted one is no
   * longer stored. A SHIM kept for the store builds that still show the paste field
   * (legacy-compatibility.md): it reads no body, writes nothing and answers the typed 410
   * `LYDIA_KEY_PASTE_RETIRED`, which those screens show as their own "could not save" line. The
   * hit is logged at WARN - an old client in use - with the association and never a value. It keeps
   * the old route's throttle and MANAGE_PAYOUT_ACCOUNT check, so the WARN counts the managers still on
   * an old build and not anonymous noise: anyone else gets the 403 they always got.
   */
  @UseGuards(NginxAuthGuard, UserResourceThrottlerGuard)
  @Throttle({ default: { limit: LYDIA_KEY_PASTE_SHIM_PER_MINUTE, ttl: 60_000 } })
  @Put(':id/lydia-business-key')
  async retiredLydiaBusinessKeyPaste(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<never> {
    await this.assertPayoutAccountManager(userId, ga, id, 'retired Business key paste');
    this.logger.warn(
      `[LYDIA] retired key paste refused on association ${sanitizeLog(id)} by ${sanitizeLog(userId)} - an old client in use`
    );
    throw new GoneException({
      code: LYDIA_KEY_PASTE_RETIRED,
      message: 'The Lydia Business key is captured at enrolment; pasting one is retired',
    });
  }

  /** Refuses anyone but a MANAGE_PAYOUT_ACCOUNT holder of the association (403). */
  private async assertPayoutAccountManager(
    userId: string,
    ga: string | undefined,
    id: string,
    what: string
  ): Promise<void> {
    const allowed = await this.service.canManagePayoutAccount(userId, id, {
      isGlobalAdmin: ga === 'true',
    });
    if (!allowed) {
      this.logger.debug(`[PERM] ${what} refused on ${sanitizeLog(id)}`);
      throw new ForbiddenException('MANAGE_PAYOUT_ACCOUNT permission required');
    }
  }

  /** Recent posts and forms for this association (picker when linking calendar ↔ content). */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.PROPOSE_EVENT)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/link-candidates')
  linkCandidates(@Param('id') id: string) {
    return this.service.getCalendarLinkCandidates(id);
  }

  /**
   * LEGACY (engagement WP-3, L8): whether the caller's bell on this association is at `none`. A
   * build older than the bell control asks it - docs/wiki/legacy-compatibility.md.
   */
  @UseGuards(NginxAuthGuard)
  @Get(':id/push-mute')
  async pushMuteStatus(
    @Headers('x-user-id') userId: string,
    @Param('id', ParseUUIDPipe) id: string
  ) {
    return { muted: await this.pushMutes.isMuted(userId, id) };
  }

  /**
   * LEGACY (engagement WP-3, L8): sets the caller's bell on this association to `none`; the feed is
   * untouched. Idempotent. Kept for builds older than the bell control.
   */
  @UseGuards(NginxAuthGuard)
  @Put(':id/push-mute')
  muteAssociationPush(
    @Headers('x-user-id') userId: string,
    @Param('id', ParseUUIDPipe) id: string
  ) {
    return this.pushMutes.mute(userId, id);
  }

  /**
   * LEGACY (engagement WP-3, L8): back to posts and lives (the bell row deleted). Idempotent. Kept for
   * builds older than the bell control.
   */
  @UseGuards(NginxAuthGuard)
  @Delete(':id/push-mute')
  unmuteAssociationPush(
    @Headers('x-user-id') userId: string,
    @Param('id', ParseUUIDPipe) id: string
  ) {
    return this.pushMutes.unmute(userId, id);
  }

  /** Returns a single association by its ID. Logged-in callers only - see the note on `list`. */
  @UseGuards(NginxAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const [row] = await this.service.withPaymentsReady([await this.service.findById(id)]);
    return toAssociationView(row);
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
    if (dto.type === 'institution' && !isGlobalAdmin) {
      // D20/D24: a BDE's MANAGE_ASSO scopes to its own space; institutions are cross-space.
      throw new ForbiddenException('Only a global admin creates an institution');
    }
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
    return toAssociationView(await this.service.create(dto, userId, isGlobalAdmin));
  }

  /**
   * Deletes an association, its members and its calendar. Global admin, or a BDE member holding
   * `MANAGE_ASSO`.
   *
   * WIDENED FROM GLOBAL-ADMIN-ONLY ON 2026-09-10, BY THE USER, AND THE SYMMETRY IS THE ARGUMENT:
   * the same right already CREATES an association through the endpoint above, and administering
   * associations without being able to end one leaves every mistake permanent. The client used to
   * hide the whole Danger panel behind the stricter of its two controls, so a BDE administrator
   * saw neither this nor the archive beside it.
   *
   * Archiving stays the reversible answer and is a `PATCH { archived }` at `MANAGE_MEMBERS`; this is the one
   * that does not come back, which is why the caller reaches `remove` rather than the service
   * being trusted to identify them.
   *
   * SCOPED TO THE PARENT SINCE WP-D2 (E3, owner 2026-11-02): the BDE must GOVERN this association
   * (`isAssociationSuperAdminOf`: `MANAGE_ASSO` in its parent BDE); another BDE, whatever spaces the
   * association's audience reaches, does not end it, and an association with no parent is the
   * platform admin's to delete.
   *
   * AN INSTITUTION IS THE GLOBAL ADMIN'S TO DELETE (owner, 2026-11-02), as it is theirs to create
   * (D20): a BDE that governs one is refused 403 `INSTITUTION_DELETE_ADMIN_ONLY`, and keeps
   * deleting the associations and lists it governs.
   */
  @UseGuards(NginxAuthGuard)
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined
  ) {
    if (ga !== 'true') {
      if (!(await this.service.isAssociationSuperAdminOf(userId, id))) {
        this.logger.debug(
          `[PERM] delete association refused: no BDE MANAGE_ASSO over ${sanitizeLog(id)}`
        );
        throw new ForbiddenException(
          "Global admin or MANAGE_ASSO in the association's parent BDE required"
        );
      }
      const target = await this.service.findById(id);
      if (target.type === 'institution') {
        this.logger.log(
          `[PERM] delete institution ${sanitizeLog(id)} refused to a BDE caller: global admin only`
        );
        throw new ForbiddenException({
          code: INSTITUTION_DELETE_ADMIN_ONLY,
          message: 'Only a global admin may delete an institution',
        });
      }
    }
    return this.service.remove(id, userId, ga === 'true');
  }

  // ── Association details: each field asks its own right (UPDATE_FIELD_RIGHTS) ──

  /**
   * Updates association details. NOT ONE FLAG (owner, 2026-11-02): the guard admits a member, the
   * association's super-admin or the platform admin, and each field then asks the right
   * `UPDATE_FIELD_RIGHTS` names for it - `EDIT_PROFILE` for the profile, `MANAGE_MEMBERS` for
   * `archived`, `MANAGE_PRODUCTS` for the cotisation settings (D5), the platform admin alone for
   * `documentQuotaBytes` and a list's `parentAssociationId`. A body asks every right its fields
   * ask; one missing refuses the whole write (403, typed, naming the fields), so nothing is half
   * saved. When enabling a cotisation, the canonical product is provisioned/synced
   * (`provisionCotisationProduct`).
   */
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: UpdateAssociationDto
  ) {
    let patch = { ...dto };
    const isGlobalAdmin = ga === 'true';
    const asked = rightsAskedBy(patch);
    this.logger.debug(
      `[ASSO] update ${sanitizeLog(id)} fields=${Object.keys(patch).join(',') || '(none)'}`
    );
    if (asked.unknown.length > 0) {
      // The whitelisting ValidationPipe strips undeclared keys, so this is a DTO field nobody
      // placed in the table - a defect here, never a client's.
      this.logger.error(
        `[PERM] update ${sanitizeLog(id)}: no right for ${asked.unknown.join(',')}`
      );
      throw new ForbiddenException({
        code: ASSOCIATION_FIELD_RIGHT_MISSING,
        message: `No right is defined for ${asked.unknown.join(', ')}`,
      });
    }
    if (asked.platformAdmin.length > 0 && !isGlobalAdmin) {
      // No screen sends these to anyone but a platform administrator: a request that does is a
      // client defect or a hand-made call, and both are worth an accusing line.
      this.logger.error(
        `[PERM] update ${sanitizeLog(id)} refused for ${sanitizeLog(userId)}: ${asked.platformAdmin.join(',')} is platform-admin only`
      );
      throw new ForbiddenException({
        code: ASSOCIATION_FIELD_PLATFORM_ADMIN_ONLY,
        message: `${asked.platformAdmin.join(', ')} may be changed by a platform administrator only`,
        fields: asked.platformAdmin,
      });
    }
    for (const [flag, fields] of asked.flags) {
      if (!(await this.service.mayAct(userId, id, flag, { isGlobalAdmin }))) {
        const name = AssociationPermissionFlag[flag];
        this.logger.warn(
          `[PERM] update ${sanitizeLog(id)} refused for ${sanitizeLog(userId)}: ${fields.join(',')} asks ${name}`
        );
        throw new ForbiddenException({
          code: ASSOCIATION_FIELD_RIGHT_MISSING,
          message: `${name} permission required to change ${fields.join(', ')}`,
          right: name,
          fields,
        });
      }
    }
    if (asked.flags.size === 0 && asked.platformAdmin.length === 0) {
      throw new BadRequestException('Nothing to update');
    }
    const touchesCotisation = asked.flags.has(AssociationPermissionFlag.MANAGE_PRODUCTS);

    if ('parentAssociationId' in patch) {
      // Only a platform admin reaches here with it (refused above otherwise). The governing parent
      // is a DEPENDENCY (reform 2.7): its rules and its journal live in ONE place, so a change made
      // from the profile form is judged and recorded exactly as one made on the Dependencies panel.
      const { parentAssociationId, ...rest } = patch;
      await this.spaces.setParent(id, parentAssociationId ?? null, { userId });
      patch = rest;
      if (Object.keys(patch).length === 0) {
        return toAssociationView(await this.service.findById(id));
      }
    }

    const updated = await this.service.update(id, patch);
    // A cotisation stored enabled on an entity that may not collect NOW (an institution, a list
    // whose delegation was revoked) stays as it is: its product is not (re)provisioned, so the save
    // above is never followed by a refusal.
    if (touchesCotisation && updated.cotisationEnabled && mayCollect(updated)) {
      await this.productsService.provisionCotisationProduct(updated);
    }
    return toAssociationView(updated);
  }

  /**
   * Uploads and sets a logo for the association.
   *
   * `?slot=second` writes the list's SECOND theme logo (`logoMediaId2`) instead of the primary one.
   * A query parameter rather than a second route because everything either one does - the
   * permission flag, the 2 MB ceiling, the mime allowlist, the media upload, the deletion of what
   * it replaces - is identical, and the only difference is which column is written. Anything but
   * the literal `second` is the primary slot: an unknown value must not silently write the other
   * one.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.EDIT_PROFILE)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_UPLOAD_MB * 1024 * 1024 } }))
  @Post(':id/logo')
  async uploadLogo(
    @Param('id') id: string,
    @Headers('authorization') authorization: string | undefined,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; size: number } | undefined,
    @Query('slot') slot?: string
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('Missing file');
    }
    return toAssociationView(
      await this.service.setLogoFromUpload(
        id,
        { buffer: file.buffer, mimetype: file.mimetype, size: file.size },
        authorization,
        slot === 'second' ? 'second' : 'primary'
      )
    );
  }

  /** Removes a stored logo from an association; `?slot=second` clears the second theme's. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.EDIT_PROFILE)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/logo')
  async deleteLogo(
    @Param('id') id: string,
    @Headers('authorization') authorization: string | undefined,
    @Query('slot') slot?: string
  ) {
    return toAssociationView(
      await this.service.clearStoredLogo(
        id,
        authorization,
        slot === 'second' ? 'second' : 'primary'
      )
    );
  }

  /** Adds a user as a member of the association with the specified role. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/members')
  addMember(
    @Param('id') id: string,
    @Headers('x-user-id') callerId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: AddMemberDto
  ) {
    return this.service.addMember(
      { associationId: id, ...dto },
      { userId: callerId.trim(), isGlobalAdmin: ga === 'true' }
    );
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
    // A MANAGEMENT question (the last-admin guard), so the management predicate: no BDE over an
    // institution - never the agenda rule, which reaches an institution's events.
    const isBde = isGlobalAdmin
      ? false
      : await this.service.holdsBdeFlagOver(
          callerId,
          id,
          AssociationPermissionFlag.VALIDATE_EVENTS
        );
    return this.service.updateMemberRole(id, targetUserId, dto.role, dto.permissions, {
      granter: { userId: callerId.trim(), isGlobalAdmin },
      bypassLastAdmin: isGlobalAdmin || isBde,
    });
  }

  /**
   * THE "QUITTER" BUTTON (owner, 2026-11-03): the caller leaves the association. Any member, no role
   * guard - the only row it can touch is the caller's own, named by the vouched `x-user-id`, never by
   * a parameter. Refused `ASSOCIATION_LAST_MEMBER_MANAGER` for its last holder of `MANAGE_MEMBERS`.
   * Declared BEFORE `:id/members/:userId` so `me` is never read as a user id.
   */
  @UseGuards(NginxAuthGuard)
  @Delete(':id/members/me')
  leaveAssociation(@Param('id') id: string, @Headers('x-user-id') callerId: string) {
    return this.service.leaveAssociation(id, callerId.trim());
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
    // A MANAGEMENT question (the last-admin guard), so the management predicate: no BDE over an
    // institution - never the agenda rule, which reaches an institution's events.
    const isBde = isGlobalAdmin
      ? false
      : await this.service.holdsBdeFlagOver(
          callerId,
          id,
          AssociationPermissionFlag.VALIDATE_EVENTS
        );
    return this.service.removeMember(id, targetUserId, {
      granter: { userId: callerId.trim(), isGlobalAdmin },
      bypassLastAdmin: isGlobalAdmin || isBde,
    });
  }

  // ── Calendar (PROPOSE_EVENT flag) ─────────────────────────────────────────

  /**
   * Creates a calendar event for the association. IT GOES INTO THE PENDING QUEUE, WHOEVER ASKS -
   * a BDE admin and a global admin included (user, 2026-09-14). What the validator grant still
   * buys here is reach, not a verdict: `targetAssocId` may name another association, and `kind`
   * may be `break`. See `createCalendarEvent` in the service.
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
    // THE BDE OF THE TARGET'S SPACE, not any BDE (WP6c step 2): the validator grant is read on the
    // association the event will BELONG to, which is `targetAssocId` when one is named.
    const target = dto.targetAssocId?.trim() || id;
    const isBde = isGlobalAdmin ? false : await this.service.mayValidateEventsOf(userId, target);
    if (target !== id && !isGlobalAdmin && !isBde) {
      // Refused rather than silently filed on `:id`: a deposit aimed at another association and
      // landing on the caller's own would put the event on the wrong calendar with nobody told.
      this.logger.debug(
        `[PERM] deposit refused: no BDE VALIDATE_EVENTS over target ${sanitizeLog(target)}`
      );
      throw new ForbiddenException(
        "VALIDATE_EVENTS in the BDE of the target association's space required"
      );
    }
    return this.service.createCalendarEvent(id, dto, userId, { isGlobalAdmin, isBde });
  }

  /**
   * THE ONE RULE FOR EVERY WRITE ON AN EXISTING EVENT - and two routes had none at all.
   *
   * `POST/DELETE :id/events/:eventId/image` carried `NginxAuthGuard` alone, which proves only that
   * somebody is signed in. Their doc comments claimed "Requires MANAGE_EVENTS or global admin" and
   * no code said so, so ANY account could put a poster on any association's event or wipe one -
   * while the `PATCH` and `DELETE` beside them each spelled this check out by hand. A rule written
   * twice is a rule the third route forgets: it is written ONCE here now, and the routes call it.
   *
   * Returns the tier it established, since the callers need it for the cross-association paths.
   * `isBde` is scoped to THE EVENT (WP6c step 2): VALIDATE_EVENTS in the BDE of a space the event's
   * own association reaches, read from the row - never "a BDE somewhere".
   */
  private assertMayWriteEvent(
    userId: string,
    ga: string | undefined,
    associationId: string,
    eventId: string
  ): Promise<{ isGlobalAdmin: boolean; isBde: boolean }> {
    // The rule itself is the service's, because the co-organiser route (`coorganisation/`) asks it
    // too, and a rule written twice is the one the third route forgets.
    return this.service.assertMayWriteEvent(userId, ga === 'true', associationId, eventId);
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
    const { isGlobalAdmin, isBde } = await this.assertMayWriteEvent(userId, ga, id, eventId);
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
    const { isGlobalAdmin, isBde } = await this.assertMayWriteEvent(userId, ga, id, eventId);
    return this.service.deleteCalendarEvent(id, eventId, {
      isGlobalAdmin,
      isBde,
      callerUserId: userId,
    });
  }

  /**
   * May the caller decide (validate or reject) event `eventId`? A global admin, or VALIDATE_EVENTS
   * in the BDE of a space the EVENT'S association reaches (WP6c step 2) - read from the row, so the
   * association named in the URL cannot widen it. One check for both verdicts, so they cannot drift.
   */
  private async assertMayDecideEvent(
    userId: string,
    ga: string | undefined,
    eventId: string
  ): Promise<void> {
    if (ga === 'true') return;
    if (await this.service.mayValidateEvent(userId, eventId)) return;
    this.logger.debug(
      `[PERM] verdict refused on event ${sanitizeLog(eventId)}: no BDE governing its association`
    );
    throw new ForbiddenException(
      "VALIDATE_EVENTS in the BDE of the event association's space, or global admin, required"
    );
  }

  /**
   * Validates a pending calendar event (makes it publicly visible).
   * Requires VALIDATE_EVENTS in the BDE of the event association's space, or global admin.
   */
  @UseGuards(NginxAuthGuard)
  @Post(':id/events/:eventId/validate')
  async validateCalendarEvent(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id') id: string,
    @Param('eventId') eventId: string
  ) {
    await this.assertMayDecideEvent(userId, ga, eventId);
    return this.service.validateCalendarEvent(id, eventId, userId);
  }

  /**
   * Rejects a pending calendar event; keeps it visible to asso admins with an optional reason.
   * Requires VALIDATE_EVENTS in the BDE of the event association's space, or global admin.
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
    await this.assertMayDecideEvent(userId, ga, eventId);
    return this.service.rejectCalendarEvent(id, eventId, userId, dto.reason);
  }

  // ── Calendar event image ─────────────────────────────────────────────────

  /**
   * Uploads a poster/banner image for a calendar event. Same right as editing the event itself:
   * PROPOSE_EVENT on the association, or BDE / global admin.
   */
  @UseGuards(NginxAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  @Post(':id/events/:eventId/image')
  async uploadEventImage(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @UploadedFile() file: Express.Multer.File,
    @Headers('authorization') authorization: string | undefined
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const tier = await this.assertMayWriteEvent(userId, ga, id, eventId);
    return this.service.setEventImageFromUpload(id, eventId, file, authorization, tier);
  }

  /**
   * Removes the poster image from a calendar event. Same right as editing the event itself:
   * PROPOSE_EVENT on the association, or BDE / global admin.
   */
  @UseGuards(NginxAuthGuard)
  @Delete(':id/events/:eventId/image')
  async deleteEventImage(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Headers('authorization') authorization: string | undefined
  ) {
    const tier = await this.assertMayWriteEvent(userId, ga, id, eventId);
    return this.service.clearEventImage(id, eventId, authorization, tier);
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

  /**
   * Renames a document (display name) and/or toggles its visibility (private/public).
   * Returns 400 when trying to make a password-protected document public.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_DOCUMENTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id/documents/:docId')
  updateDocument(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Body() dto: UpdateAssociationDocumentDto
  ) {
    return this.service.updateDocument(id, docId, dto);
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

  /** Lists active tags issued by this association (admins with MANAGE_MEMBERS only). */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/tags')
  listTags(@Param('id') id: string) {
    return this.userTagService.listByAssoc(id);
  }

  /**
   * Manually grants a cotisation tag to a user (cash payment or admin override): one of THIS
   * association's tier tags, granted like the roster's manual add (`grantTagForAssociation`); the
   * derived expiry applies unless one is given. Requires MANAGE_MEMBERS flag.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/tags')
  grantTag(
    @Param('id') id: string,
    @Headers('x-user-id') grantedBy: string,
    @Body() dto: GrantTagDto
  ) {
    return this.userTagService.grantTagForAssociation(id, {
      userId: dto.userId,
      tagName: dto.tagName,
      grantedBy,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
  }

  /**
   * Revokes a cotisation tag. Requires MANAGE_MEMBERS flag.
   * `:id` is passed on to scope the delete: MANAGE_MEMBERS is per-association, so a tag issued by
   * another association must stay out of reach even when its id is known.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/tags/:tagId')
  revokeTag(@Param('id') id: string, @Param('tagId') tagId: string) {
    return this.userTagService.revoke(tagId, id);
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
   * Lists the association's cotisation tiers, so the roster UI can offer them when adding a
   * cotisant by hand. Requires MANAGE_MEMBERS - deliberately NOT MANAGE_PRODUCTS, since the whole
   * point is to be callable by whoever manages the roster.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/cotisation-tiers')
  listCotisationTiers(@Param('id') id: string) {
    return this.userTagService.listCotisationTiers(id);
  }

  /**
   * What the caller may do with this association's cotisations, for the forms admin: the tiers it
   * sells, by name, and whether this caller may hand one out.
   *
   * Not the roster endpoint above: that one requires MANAGE_MEMBERS, which a form manager
   * (MANAGE_FORMS) need not hold, and it carries the derived tag, which no screen has a use for.
   *
   * `mayGrant` is MANAGE_MEMBERS, the same right the manual roster add needs - a form that grants a
   * cotisation on payment does exactly what that button does, so it cannot be a cheaper way in. The
   * tier list itself is readable by any signed-in user, because a membership tier's NAME is already
   * public on the association page.
   *
   * `tierKeyFromLabel` is a CAPABILITY, not a setting: this social-service derives a new tier's
   * `variantKey` from its label (`deriveVariantKey` on create). The admin screen offers tier
   * creation only when it reads it, because an older server strips the unknown flag and would
   * create a BASE tier instead of the named one asked for. Always `true` from this release on; its
   * absence is what an older server looks like.
   */
  @UseGuards(NginxAuthGuard)
  @Get(':id/cotisation-options')
  async cotisationOptions(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') globalAdmin: string | undefined
  ) {
    const tiers = await this.userTagService.listCotisationTiers(id);
    const mayGrant = await this.service.mayAct(
      userId,
      id,
      AssociationPermissionFlag.MANAGE_MEMBERS,
      { isGlobalAdmin: globalAdmin === 'true' }
    );
    return {
      tiers: tiers.map(({ variantKey, name }) => ({ variantKey, name })),
      mayGrant,
      tierKeyFromLabel: true as const,
    };
  }

  /**
   * Manually adds a cotisant: grants one of the association's cotisation tiers to a user
   * (D10, tag only - no payment recorded). The tag is derived server-side from `variantKey`,
   * which must name an active tier; omit it for a single-tier association. Requires MANAGE_MEMBERS.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/cotisants')
  grantCotisant(
    @Param('id') id: string,
    @Headers('x-user-id') grantedBy: string,
    @Body() dto: GrantCotisantDto
  ) {
    return this.userTagService.grantCotisant(id, dto.userId, grantedBy, dto.variantKey ?? null);
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
    this.sendXlsxDownload(res, buffer, title, 'cotisants');
  }

  /**
   * Streams an XLSX buffer as a browser download with an ASCII-fallback filename plus an
   * RFC 5987 UTF-8 encoded filename so accents survive in modern browsers.
   */
  private sendXlsxDownload(
    res: Response,
    buffer: Buffer | ArrayBuffer,
    title: string,
    fallback: string
  ): void {
    const bytes = Buffer.from(buffer as ArrayBuffer);
    const asciiName =
      title
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .trim()
        .replace(/\s+/g, '_') || fallback;
    const encodedName = encodeURIComponent(title);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${asciiName}.xlsx"; filename*=UTF-8''${encodedName}.xlsx`,
      'Content-Length': bytes.byteLength,
    });
    res.send(bytes);
  }

  // ── Boutique (products) ───────────────────────────────────────────────────

  /** Returns all active products across all associations (requires login). Used on /shop. */
  @UseGuards(NginxAuthGuard)
  @Get('products/all')
  listAllProducts(@Headers('x-user-id') userId: string) {
    return this.productsService.listAllActive(userId);
  }

  /**
   * Returns active products for this association (its shop section).
   *
   * `x-user-id` is passed through so a gridded product quotes the price THIS person pays rather
   * than the "everyone else" cell. Signed-in only since 2026-11-02: the public showcase shows no
   * shop ([anonymous-surface](../../../../docs/wiki/anonymous-surface.md)).
   */
  @UseGuards(NginxAuthGuard)
  @Get(':id/products')
  listAssociationProducts(@Param('id') id: string, @Headers('x-user-id') userId: string) {
    return this.productsService.listByAssoc(id, userId);
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

  /** Exports this association's completed purchases (boutique + paid forms) as XLSX. Requires MANAGE_PRODUCTS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/purchases/export')
  async exportAssociationPurchases(@Param('id') id: string, @Res() res: Response) {
    const { buffer, title } = await this.productsService.exportAssociationPurchases(id);
    this.sendXlsxDownload(res, buffer, title, 'achats');
  }

  /**
   * Closes a payment marked `paid_not_granted` by recording which outcome settled it - `refunded`
   * or `granted` (the closing grants the tier by hand). Once per payment; the mark stays as history
   * and the hourly report stops counting it. Requires MANAGE_PRODUCTS, like the rest of this list.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/purchases/:purchaseId/close')
  closePaidNotGranted(
    @Param('id') id: string,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
    @Headers('x-user-id') closedBy: string,
    @Body() dto: ClosePaidNotGrantedDto
  ) {
    return this.productsService.closePaidNotGranted(
      id,
      purchaseId,
      closedBy,
      dto.outcome,
      // Validated present for `granted` (`ClosePaidNotGrantedDto`); a refund reads no tier.
      dto.expectDelivered ?? false
    );
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
   * The amount a cash sale of this product to `userId` records when the cashier types none, so the
   * cashier sees it before the sale. Requires MANAGE_PRODUCTS flag, like the sale itself.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/products/:productId/grant-quote')
  quoteCashSale(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Query('userId', ParseUUIDPipe) userId: string
  ) {
    return this.productsService.quoteCashSale(id, productId, userId);
  }

  /**
   * Creates a new product in the association's boutique.
   * Requires MANAGE_PRODUCTS flag. Product is inactive until the payout account onboarding is complete.
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

  /** Uploads a decorative icon for a product (e.g. a partner brand's logo). Requires MANAGE_PRODUCTS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_UPLOAD_MB * 1024 * 1024 } }))
  @Post(':id/products/:productId/icon')
  uploadProductIcon(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Headers('authorization') authorization: string | undefined,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; size: number } | undefined
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('Missing file');
    }
    return this.productsService.setProductIcon(
      id,
      productId,
      { buffer: file.buffer, mimetype: file.mimetype, size: file.size },
      authorization
    );
  }

  /** Removes a product's decorative icon. Requires MANAGE_PRODUCTS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/products/:productId/icon')
  deleteProductIcon(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Headers('authorization') authorization: string | undefined
  ) {
    return this.productsService.clearProductIcon(id, productId, authorization);
  }

  /**
   * Creates a checkout session for a product purchase (login required).
   * Optional body: `{ customAmountCents: number }` for products allowing custom amounts.
   */
  @UseGuards(NginxAuthGuard)
  @Post(':id/products/:productId/checkout')
  checkout(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Headers('x-user-id') userId: string,
    @Body()
    body?: {
      customAmountCents?: unknown;
      successUrl?: string;
      cancelUrl?: string;
      payerEmail?: string;
    }
  ) {
    // Read as `unknown` and checked HERE: an inline body type is never validated, so a fraction or
    // a string reached the bounds check (NaN passes it) and the charge (rounded by `toFixed(2)`).
    const customAmountCents = wholeCentsOf(body?.customAmountCents, this.logger, 'SHOP');
    return this.productsService.createCheckoutSession(
      id,
      productId,
      userId,
      customAmountCents,
      { successUrl: body?.successUrl, cancelUrl: body?.cancelUrl },
      body?.payerEmail
    );
  }

  /**
   * The payer's return from Lydia for ONE checkout attempt (`checkout_id` on the shop page): asks
   * the provider about the attempt's own request, records it if paid, and answers its status. Only
   * the BUYER may ask, about their own attempt of this product (anything else is a 404). NOT a
   * mark-paid: the caller names an attempt, and the payment is Lydia's answer about the request the
   * row stored (`ProductsService.confirmCheckout`). Throttled per user and attempt like the form's
   * `confirm-payment`, since each call may spend a `request/state`.
   */
  @UseGuards(NginxAuthGuard, UserResourceThrottlerGuard)
  @Throttle({ default: { limit: CONFIRM_PAYMENT_PER_MINUTE, ttl: 60_000 } })
  @Post(':id/products/:productId/checkouts/:checkoutId/confirm')
  @HttpCode(200)
  confirmCheckout(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('checkoutId', ParseUUIDPipe) checkoutId: string,
    @Headers('x-user-id') userId: string
  ) {
    return this.productsService.confirmCheckout(id, productId, checkoutId, userId);
  }

  /** Lists failed Cercle webhook deliveries for admin retry. Requires MANAGE_PRODUCTS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/webhook-failures')
  listWebhookFailures(@Param('id') id: string) {
    return this.productsService.listWebhookFailures(id);
  }

  // ── Partnerships ──────────────────────────────────────────────────────────
  // `partnerships/all` is declared before `:id/partnerships` for the same reason `products/all`
  // precedes `:id/products` above.

  /** Returns active partnership cards across every association (shown on the shop page). */
  @UseGuards(NginxAuthGuard)
  @Get('partnerships/all')
  listAllPartnerships(@Headers('x-user-id') userId: string) {
    return this.partnershipsService.listAllActive(userId);
  }

  /** Returns active partnership cards for this association (shown on its public page). */
  @UseGuards(NginxAuthGuard)
  @Get(':id/partnerships')
  listAssociationPartnerships(@Param('id') id: string, @Headers('x-user-id') userId: string) {
    return this.partnershipsService.listActiveByAssoc(id, userId);
  }

  /** Returns all partnership cards including inactive ones, with claim-pool stock counts. Requires MANAGE_PARTNERSHIPS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PARTNERSHIPS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/partnerships/manage')
  listAssociationPartnershipsForManage(@Param('id') id: string) {
    return this.partnershipsService.listAllForManage(id);
  }

  /** Creates a partnership card. Requires MANAGE_PARTNERSHIPS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PARTNERSHIPS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/partnerships')
  createPartnershipCard(@Param('id') id: string, @Body() dto: CreatePartnershipCardDto) {
    return this.partnershipsService.create(id, dto);
  }

  /** Updates a partnership card. Requires MANAGE_PARTNERSHIPS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PARTNERSHIPS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id/partnerships/:cardId')
  updatePartnershipCard(
    @Param('id') id: string,
    @Param('cardId') cardId: string,
    @Body() dto: UpdatePartnershipCardDto
  ) {
    return this.partnershipsService.update(id, cardId, dto);
  }

  /** Deletes a partnership card. Requires MANAGE_PARTNERSHIPS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PARTNERSHIPS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/partnerships/:cardId')
  deletePartnershipCard(@Param('id') id: string, @Param('cardId') cardId: string) {
    return this.partnershipsService.delete(id, cardId);
  }

  /** Uploads a decorative icon for a partnership card (e.g. the partner brand's logo). Requires MANAGE_PARTNERSHIPS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PARTNERSHIPS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_UPLOAD_MB * 1024 * 1024 } }))
  @Post(':id/partnerships/:cardId/icon')
  uploadPartnershipIcon(
    @Param('id') id: string,
    @Param('cardId') cardId: string,
    @Headers('authorization') authorization: string | undefined,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; size: number } | undefined
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('Missing file');
    }
    return this.partnershipsService.setCardIcon(
      id,
      cardId,
      { buffer: file.buffer, mimetype: file.mimetype, size: file.size },
      authorization
    );
  }

  /** Removes a partnership card's decorative icon. Requires MANAGE_PARTNERSHIPS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PARTNERSHIPS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/partnerships/:cardId/icon')
  deletePartnershipIcon(
    @Param('id') id: string,
    @Param('cardId') cardId: string,
    @Headers('authorization') authorization: string | undefined
  ) {
    return this.partnershipsService.clearCardIcon(id, cardId, authorization);
  }

  /** Bulk-adds codes to a code_pool partnership card's stock. Requires MANAGE_PARTNERSHIPS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PARTNERSHIPS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/partnerships/:cardId/codes')
  addPartnershipCodes(
    @Param('id') id: string,
    @Param('cardId') cardId: string,
    @Body() dto: AddPartnershipCodesDto
  ) {
    return this.partnershipsService.addCodes(id, cardId, dto);
  }

  /** Lists claimed codes for a partnership card with claimant names. Requires MANAGE_PARTNERSHIPS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PARTNERSHIPS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/partnerships/:cardId/claims')
  listPartnershipClaims(@Param('id') id: string, @Param('cardId') cardId: string) {
    return this.partnershipsService.listClaims(id, cardId);
  }

  /** Claims a partnership card (login required, any member - gated on `membersOnly` inside the service). */
  @UseGuards(NginxAuthGuard)
  @Post(':id/partnerships/:cardId/claim')
  claimPartnership(
    @Param('id') id: string,
    @Param('cardId') cardId: string,
    @Headers('x-user-id') userId: string
  ) {
    return this.partnershipsService.claimCard(cardId, userId);
  }

  /** Retries a failed Cercle webhook delivery. Requires MANAGE_PRODUCTS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/webhook-failures/:deliveryId/retry')
  retryWebhookDelivery(@Param('id') id: string, @Param('deliveryId') deliveryId: string) {
    return this.productsService.retryWebhookDelivery(id, deliveryId);
  }

  /**
   * Drops a failed Cercle webhook delivery from the audit list - for a top-up already settled by
   * hand on the Cercle side, where a retry would credit it twice. Requires MANAGE_PRODUCTS flag.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/webhook-failures/:deliveryId')
  deleteWebhookDelivery(@Param('id') id: string, @Param('deliveryId') deliveryId: string) {
    return this.productsService.deleteWebhookDelivery(id, deliveryId);
  }

  // ── Payment delegation (parent-association payment routing) ─────────────────

  /** Returns this association's payment-delegation state. Requires MANAGE_PRODUCTS flag. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/payment-delegation')
  getPaymentDelegation(@Param('id') id: string) {
    return this.service.getPaymentDelegation(id);
  }

  /**
   * Requests that this association's payments route to a parent association's payout account.
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

  /**
   * Parent accounting access: lists a delegated child's completed purchases (boutique + paid
   * forms). `:id` is the parent; the guard proves parent-admin, then `childAccountingScope` reads
   * what it may see: everything while approved, the payments its Business took once the delegation
   * ended. Requires MANAGE_PRODUCTS.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/payment-delegation/children/:childId/purchases')
  async listChildPurchases(@Param('id') id: string, @Param('childId') childId: string) {
    const { onlyRecordIds } = await this.service.childAccountingScope(id, childId);
    return this.productsService.listAssociationPurchases(childId, onlyRecordIds);
  }

  /** Parent accounting access: XLSX export of a delegated child's purchases. `:id` is the parent. Requires MANAGE_PRODUCTS. */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Get(':id/payment-delegation/children/:childId/purchases/export')
  async exportChildPurchases(
    @Param('id') id: string,
    @Param('childId') childId: string,
    @Res() res: Response
  ) {
    const { onlyRecordIds } = await this.service.childAccountingScope(id, childId);
    const { buffer, title } = await this.productsService.exportAssociationPurchases(
      childId,
      onlyRecordIds
    );
    this.sendXlsxDownload(res, buffer, title, 'achats');
  }

  /**
   * Approves a child's pending delegation request. `:id` is the parent. Requires MANAGE_PRODUCTS,
   * and the service narrows it: only the receiver's OWN shop managers or the platform administrator
   * accept, never a BDE governing it, and the acceptance is recorded (owner, 2026-11-02).
   *
   * The child can now take payments through the parent's account, so the products it had to leave
   * off sale for want of one go back on sale IN THE SAME TRANSACTION as the approval
   * (`approvePaymentDelegation`, owner review of #2967): a commit never leaves one withheld.
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/payment-delegation/children/:childId/approve')
  async approvePaymentDelegation(
    @Param('id') id: string,
    @Param('childId') childId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined
  ) {
    return this.service.approvePaymentDelegation(id, childId, {
      userId,
      isGlobalAdmin: ga === 'true',
    });
  }

  /**
   * Rejects a pending request or revokes an approved child's delegation. `:id` is the parent.
   * Requires MANAGE_PRODUCTS, and the service narrows it as for acceptance: the receiver's OWN shop
   * managers or the platform administrator, never a BDE governing it
   * (`DELEGATION_REVOKE_RECEIVER_ONLY`).
   */
  @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_PRODUCTS)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/payment-delegation/children/:childId/reject')
  rejectPaymentDelegation(
    @Param('id') id: string,
    @Param('childId') childId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined
  ) {
    return this.service.rejectPaymentDelegation(id, childId, {
      userId,
      isGlobalAdmin: ga === 'true',
    });
  }

  // ── Internal (called by core-service) ───────────────────────────────────────
  // These sit on the nginx-exposed /api/associations prefix (no infra change), so
  // they can be reached by any authenticated client. They grant entitlements and set
  // payout accounts, so each verifies the shared X-Internal-Secret (timing-safe) and
  // only accepts genuine server-to-server calls from core-service.

  /**
   * Links the Business core-service's onboarding just created: its vendor_token, dashboard URL and
   * private token (confirmed by Lydia, stored encrypted); called internally by core-service.
   * Refused with the typed 409 `LYDIA_ACCOUNT_ALREADY_LINKED` while a Business is linked.
   *
   * Answers `{ ok: true }` and nothing of the row: it returned the raw entity, vault key included,
   * and its one caller (core-service `createOnboarding`) never read the body.
   */
  @Post(':id/lydia-account')
  async setLydiaAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: { lydiaAccountId?: unknown; lydiaDashboardUrl?: unknown; businessPrivateToken?: unknown },
    @Headers('x-internal-secret') internalSecret: string
  ) {
    assertInternalSecret(internalSecret);
    await this.service.setLydiaAccountId(
      id,
      body?.lydiaAccountId,
      body?.lydiaDashboardUrl,
      body?.businessPrivateToken
    );
    return { ok: true as const };
  }

  /**
   * The global admin's "Valider l'onboarding", called internally by core-service: the SAME path as
   * Lydia's `BUSINESS_VALIDATED` (`ProductsService.markLydiaReady`, cause `admin`) - one writer of
   * the readiness, the transition logged and the managers told once, withheld products released on
   * every call. Refused when no Business is linked (nothing to validate).
   */
  @Post(':id/lydia-complete')
  async markLydiaComplete(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-internal-secret') internalSecret: string
  ) {
    assertInternalSecret(internalSecret);
    const vendorToken = await this.service.lydiaVendorTokenOf(id);
    if (!vendorToken) {
      throw new BadRequestException('No Lydia account is linked to this association');
    }
    await this.productsService.markLydiaReady(vendorToken, 'admin', { path: 'admin', id });
  }

  /** Unlinks the association's Lydia Business; called internally by core-service. */
  @Post(':id/lydia-disconnect')
  disconnectLydiaAccount(
    @Param('id') id: string,
    @Headers('x-internal-secret') internalSecret: string
  ) {
    assertInternalSecret(internalSecret);
    return this.service.clearLydiaAccount(id);
  }

  /**
   * A VERIFIED Lydia confirm callback for a boutique attempt, handed over by core-service as a
   * trigger (`ProductsService.handlePurchaseCompleted`): `checkoutId` is the attempt the order_ref
   * names, `requestId` Lydia's numeric id and `vendorToken` the Business whose key verified it. No
   * buyer and no amount are accepted - the attempt row holds both. Internal secret only.
   */
  @Post('products/:productId/purchase-completed')
  @HttpCode(200)
  purchaseCompleted(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() body: { checkoutId?: unknown; requestId?: unknown; vendorToken?: unknown },
    @Headers('x-internal-secret') internalSecret: string
  ) {
    assertInternalSecret(internalSecret);
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    const checkoutId = text(body?.checkoutId);
    const requestId = text(body?.requestId);
    const vendorToken = text(body?.vendorToken);
    if (!isUUID(checkoutId) || !/^\d{1,32}$/.test(requestId) || !vendorToken) {
      this.logger.warn(
        `[SHOP] purchase-completed refused: invalid checkoutId, requestId or vendorToken`
      );
      throw new BadRequestException('checkoutId, requestId and vendorToken are required');
    }
    return this.productsService.handlePurchaseCompleted(
      productId,
      checkoutId,
      requestId,
      vendorToken
    );
  }
}
