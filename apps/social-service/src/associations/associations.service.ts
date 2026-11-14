import { OFFERED_BY_SPACE_KEY_SQL, type PublicSpaceKey } from '../spaces/public-space';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  assertMayCollect,
  assertMayHoldOwnAccount,
  assertMayRequestDelegation,
  ASSOCIATION_KIND_DOES_NOT_SELL,
  LIST_NO_OWN_LYDIA_ACCOUNT,
  type CollectionSubject,
  collectionModeOf,
  mayCollect,
  writablePermissions,
} from './collection-policy';
import {
  assertInstitutionMemberWrite,
  assertWithinGrantCeiling,
  grantCeiling,
  LAST_MEMBER_MANAGER,
  logSuperAdminExcludedGrant,
  type GranterStanding,
  type MemberGranter,
} from './member-flag-ceiling';
import { describeHttpError } from '../common/http-error-log';
import {
  SecretBoxUnavailableError,
  isSecretBoxConfigured,
  openSecret,
  sealSecret,
} from '../common/secret-box';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { assertCotisationModeClearable } from './members-only-gate';
import { isUUID } from 'class-validator';
import { In, IsNull, Not, Repository, type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { randomBytes, hkdfSync } from 'crypto';
import { firstValueFrom } from 'rxjs';
import FormData from 'form-data';
import { AxiosError } from 'axios';
import { mediaUrl } from '../internal/service-urls';
import { MEMBER_CHANGED_MEANWHILE } from '../channels/permissions';
import { applyMediaRetentionClass } from '../internal/media-retention-class';
import { releaseUncitedPosters } from '../bookings/booking-poster-media';
import type { SpaceSelection } from './directory-query';
import {
  AGENDA_SELECTION_FORBIDDEN,
  selectionWithinSpaces,
  signAgendaSelection,
} from './agenda-signature';
import { Association } from './entities/association.entity';
import {
  assertReviewerReachesAssociation,
  assertRosterStaysOnOneSide,
} from './review-cohort-reach';
import { isInReviewCohort } from '../review-cohort';
import {
  assertCotisationStemFree,
  isCotisationStemCollision,
  stemCollidesElsewhere,
} from './cotisation-namespace';
import type { AssociationPayoutAccount } from './association.projection';
import { listLydiaCashiers } from './lydia-cashiers-list';
import {
  LYDIA_CASHIER_PHONE_IN_USE,
  claimLost,
  claimTokenOf,
  clearClaim,
  confirmedOf,
  lockAssociation,
  numberHeldBy,
  writeClaim,
} from './lydia-cashier-claim';
import {
  LYDIA_ENROLMENT_IN_FLIGHT,
  LYDIA_READINESS_LOG_TAG,
  paymentsNotReady,
  type LydiaReadinessCause,
} from './lydia-readiness';
import {
  HELD_BUSINESSES_SQL,
  LYDIA_BRIDGE_LOG_TAG,
  LYDIA_BUSINESS_HOLDS_PAYMENTS,
  LYDIA_BUSINESS_PENDING_VALIDATION,
  bridgeJoinSql,
  bridgeOfEnrolled,
  lockBridge,
  managedVendorTokenSql,
  swapBridge,
  vendorTokensHeldBy,
  type HeldBusinessRole,
  type LydiaBridgeState,
} from './lydia-account-bridge';
import { recordEnrolledBusiness } from './lydia-contract-flux';
import {
  approvedDelegateIds,
  collectsThrough,
  holdsOwnAccount,
  purchaseIdsTakenBy,
  releaseWithheldProductsOf,
  withholdOnSaleProductsOf,
} from './payment-delegation.util';
import {
  type DelegationNotice,
  LYDIA_PAYMENTS_PAUSED_TYPE,
  LydiaPaymentsNotifier,
} from './lydia-payments-notifier.service';
import { PostNotification } from '../posts/entities/post-notification.entity';
import {
  ANY_TYPE_EXCLUDED_FLAGS,
  AssociationMember,
  AssociationPermissionFlag,
  SUPER_ADMIN_EXCLUDED_FLAGS,
  typeExcludedFlags,
} from './entities/association-member.entity';
import { AssociationDocument } from './entities/association-document.entity';
import { DocumentReviewerGrant } from './entities/document-reviewer-grant.entity';
import { isPasswordProtected, parseVaultMarkers } from './vault-markers.util';
import { AssociationProduct } from './entities/association-product.entity';
import {
  AssociationCalendarEvent,
  AssociationCalendarEventKind,
  AssociationCalendarEventPresentation,
  AssociationCalendarEventStatus,
} from './entities/association-calendar-event.entity';
import {
  assertNeutralPresentationAllowed,
  EVERY_EVENT_STEWARDSHIP,
  eventStewardshipOf,
  isNeutralEvent,
  NO_EVENT_STEWARDSHIP,
  presentEventsForReader,
  type EventStewardship,
  type PresentableEventRow,
} from './event-presentation';
import { AssociationCalendarEventCoOwner } from './entities/association-calendar-event-co-owner.entity';
import { deriveCotisationTag } from './cotisation-tag.util';
import {
  RESERVED_SLUGS,
  SLUG_EXHAUSTED,
  SLUG_MAX_ATTEMPTS,
  SLUG_PATTERN,
  isSlugUniqueViolation,
  slugCandidates,
} from './association-slug.util';
import { promoCutoffFor } from '../common/promo-visibility';
import { formatUserDisplayNameFromRaw } from '../utils/user-display-name';
import {
  isDelegating,
  resolvePaymentTarget,
  fetchActivePaymentProvider,
  PAYMENTS_DISABLED_MESSAGE,
  type PaymentTarget,
  type PaymentProviderId,
} from './payment-delegation.util';
import { Post } from '../posts/entities/post.entity';
import { Form } from '../forms/entities/form.entity';
import { FORM_DRAFT, FORM_IS_DRAFT, FORM_PUBLISHED } from '../forms/form-status';
import { retireForms } from '../forms/retire-forms';
import { formsWithUnpublishedChanges } from '../forms/form-draft-revision';
import {
  AddMemberDto,
  CreateAssociationDto,
  CreateAssociationDocumentDto,
  UpdateAssociationDocumentDto,
  CreateAssociationCalendarEventDto,
  UpdateAssociationDto,
  UpdateAssociationCalendarEventDto,
} from './dto/association.dto';
import { RedisService } from '../common/redis/redis.service';
import {
  NotificationPushFailedError,
  PostNotificationsService,
  SYSTEM_ACTOR_NAME,
} from '../posts/post-notifications.service';
import { invalidatePostListCache } from '../posts/post-list-cache';
import {
  ASSOCIATIONS_UNDER_BDE_AGENDA_RIGHT_SQL,
  ASSOCIATIONS_UNDER_BDE_FLAG_SQL,
  BDE_AGENDA_RIGHT_HOLDERS_OVER_SQL,
  PLATFORM_ADMINS_SQL,
  TARGETS_AN_UNGOVERNED_SPACE_SQL,
  HOLDS_BDE_AGENDA_RIGHT_OVER_SQL,
  HOLDS_BDE_FLAG_OVER_SQL,
  holdsBdeAgendaRightOverSql,
  isBdeAssociationSql,
} from '../spaces/bde';
import {
  associationRulesReachSpaceMatchingSql,
  eventReachesSpaceMatchingSql,
  associationVisibleToViewerSql,
  eventCardShownToViewerSql,
  eventVisibleToViewerSql,
  READER_PROFILE_SQL,
  AGENDA_REACHED_SPACES_SQL,
  READER_SPACES_SQL,
  campusWideReaderCampus,
  type SpacePair,
} from '../spaces/reader-spaces';
import { AssociationAudience } from '../spaces/association-audience.entity';
import {
  institutionReachOptionsOffered,
  resolveInstitutionReachWrite,
  servedInstitutionReach,
  type InstitutionReachSpace,
} from '../spaces/institution-reach';
import { assertAudienceAllowedForType, defaultCampusRules } from '../spaces/audience-policy';
import { normaliseRules, smallestRules } from '../spaces/spaces.service';
import { writeDependencyJournal } from '../spaces/dependency-journal';
import {
  DEPENDENCY_INSTITUTION,
  DEPENDENCY_PARENT_CHOICE_REQUIRED,
  DEPENDENCY_PARENT_NOT_A_BDE,
  DEPENDENCY_PARENT_NOT_YOURS,
  DEPENDENCY_DELETE_ADMIN_ONLY,
  dependencyConflict,
  withDependencyRefusals,
} from '../spaces/dependency-rules';
import type { AudienceRuleDto } from '../spaces/dto/space.dto';
import type { FirstAdminDto } from './dto/admin-association.dto';
import { SEARCH_FOLD_PARAMS, foldSql } from './search-fold';
import {
  ADMIN_ASSOCIATION_ERROR,
  ADMIN_CATALOGUE_DEFAULT_LIMIT,
  decodeCatalogueCursor,
  encodeCatalogueCursor,
  platformAdminOnly,
} from './admin-catalogue';
import { BDES_WHERE_USER_HOLDS_SQL } from '../spaces/bde';
import {
  BDE_MODERATED_ASSOCIATION_IDS_SQL,
  BDE_MODERATED_POST_IDS_SQL,
  BDE_MODERATED_USER_IDS_SQL,
  BDE_MODERATES_COMMENT_SQL,
  BDE_MODERATES_LIVE_SQL,
  BDE_MODERATES_REPORT_SQL,
  MODERATION_OUT_OF_SCOPE,
  MODERATION_RESERVED_SQL,
  MODERATION_RESERVED_TO_PLATFORM_ADMIN,
  MODERATOR_REQUIRED,
  type ModerationTarget,
} from '../spaces/bde-moderation';
import { Space } from '../spaces/space.entity';
import type { SpaceCampus, SpaceFormation } from '../spaces/space.entity';
import { assertWithinCoOrganiserCap } from './co-organiser-cap';
import { assertAssociationImageUrl, assertNotQuestionImage } from './association-image-url';
import type {
  CoOrganiserAfterCommit,
  CoOrganiserPort,
  CoOrganiserSyncRequest,
} from './co-organisers.port';
import {
  eventWriteSide,
  partnerOrganiserOnlyRefusal,
  type EventWriteSide,
} from './event-write-side';
import {
  EVENT_REOPEN_NOTIFICATION_TYPE,
  type EventReopenReason,
  type ReopenedEvent,
} from './event-reopen';
import { UserTagService } from '../users/user-tag.service';
import { sanitizeLog } from '../common/log.utils';
import { announceOpeningToFollowers } from '../openings/opening-reminders';
import { type PublicMember, publicMemberAvatarUrl } from '../public/public-member';
import type { NotificationType } from '../push/notification-client-floor';

const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Where a new entity is put by the platform admin's create form (`POST associations/admin`): the
 * spaces it reaches - EXPLICIT, possibly none, replacing the creator-campus default - and an
 * optional first admin. Absent, `create` keeps its default placement.
 */
export interface AssociationPlacement {
  audiences: AudienceRuleDto[];
  firstAdmin?: FirstAdminDto;
}
const ALLOWED_LOGO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * WHICH LOGO OF A LIST IS BEING WRITTEN.
 *
 * A list can run two themes at once - the campaign's public one and the one it is actually called
 * - so it carries `name2` and `logoMediaId2` beside `name` and `logoMediaId`. The second slot has
 * no `logoUrl2` column on purpose: `logoUrl` exists only because it carries a `?v=` cache-buster
 * for the PRIMARY logo, which every tile in the app renders; the second is read from its media id
 * directly by the two surfaces that show it. One upload implementation, one column to choose.
 */
export type LogoSlot = 'primary' | 'second';

/** A single public document exposed to a reviewer, with its server-derived CEK. */
export interface ReviewerDocument {
  id: string;
  name: string;
  originalFilename: string | null;
  mimeType: string;
  size: number;
  mediaId: string;
  /** Hex AES-256-GCM content key derived server-side from the vault key. */
  cek: string;
  createdAt: Date;
}

/** Public documents of one association, for the cross-association reviewer page. */
export interface ReviewerDocumentGroup {
  associationId: string;
  associationName: string;
  slug: string;
  logoUrl: string | null;
  documents: ReviewerDocument[];
}

/**
 * Milliseconds for a column TypeORM may hand back as a `Date` OR as a string, so two readings of
 * the same instant compare equal. A `timestamptz` comes back as a `Date` through the driver and as
 * a string through some raw paths, and `!==` on the mixed pair is true for values that are the
 * same moment - which would demote an event nobody rescheduled.
 */
function toMillis(value: Date | string | null): number | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Refuses an entry KIND that the caller is not the authority for.
 *
 * A `break` renders as a full-day background band across the WHOLE school's calendar. It is a
 * statement about the school - "there are no courses this week" - not about an association, so
 * proposing one has no meaning and validating one is the wrong question to put to a BDE. `kind` was
 * a free field: any member holding `PROPOSE_EVENT` could publish a school-wide holiday band, and
 * both write paths accepted `dto.kind` with no check at all.
 *
 * **The gate is on the VALUE CHANGING, not on the field being SENT.** Both event modals submit
 * every field they render, so an ordinary edit resends the event's existing `kind` on every save;
 * refusing a field that was merely present would refuse every edit a non-BDE makes. `current` is
 * therefore the kind the entry already has - `event` on the create path, where there is nothing to
 * resend.
 *
 * It guards BOTH directions deliberately. Turning a BDE's holiday band back into an association
 * card rewrites the same school-wide statement, and one rule with no hole is worth more than two
 * rules with one.
 *
 * The message is never rendered: both modals map any failure to their own Paraglide string.
 */
/**
 * The tier a caller writing to an existing event was established at, by the controller's single
 * `assertMayWriteEvent`. Global admins act across associations, and so does a caller whose `isBde`
 * is set - which since WP6c step 2 means "may validate THIS event" (`mayValidateEvent`: the BDE of
 * a space the event association reaches), never "is a BDE somewhere". Everybody else was checked
 * against the association in the URL and may act only on events it owns or co-owns.
 */
export interface EventWriteTier {
  isGlobalAdmin: boolean;
  /** VALIDATE_EVENTS in a BDE governing the event's association - scoped by the controller. */
  isBde: boolean;
}

/** Whether a tier reaches events outside the association named in the URL. */
function mayCrossAsso(tier: EventWriteTier): boolean {
  return tier.isGlobalAdmin || tier.isBde;
}

function assertMayDecideKind(
  next: AssociationCalendarEventKind,
  current: AssociationCalendarEventKind,
  mayValidate: boolean | undefined
): void {
  if (next === current || mayValidate) return;
  throw new ForbiddenException('Only the BDE decides whether an entry is a school-wide break');
}

/**
 * The three ways a calendar date can be refused, CLASSIFIED AT THE THROW.
 *
 * `endsAt must be after startsAt` was rendered verbatim to a French reader: the global agenda's
 * deposit modal did `e instanceof Error ? e.message : <fallback>`, so the server's English won every
 * time and the localized half was dead code. The cure is the standing rule about never branching on
 * an error MESSAGE, applied one step earlier - the server says WHICH rule was broken, as a code, and
 * the screen chooses the sentence.
 *
 * Three codes rather than one, because they are three different mistakes and the reader can only fix
 * the one they made: a start that is not a date, an end that is not a date, and an end before its
 * start.
 */
export const CALENDAR_ERROR_CODES = {
  INVALID_START: 'CALENDAR_INVALID_START',
  INVALID_END: 'CALENDAR_INVALID_END',
  END_BEFORE_START: 'CALENDAR_END_BEFORE_START',
} as const;

/**
 * One refusal per rule, built once rather than at each of its six call sites - create and update
 * check the same three things, and six copies of a code is six chances for one to drift.
 */
function calendarDateRefusal(
  code: (typeof CALENDAR_ERROR_CODES)[keyof typeof CALENDAR_ERROR_CODES],
  message: string
): BadRequestException {
  return new BadRequestException({ code, message });
}

/** CRUD, logo management, membership, and payment-account helpers for student associations. */

/**
 * Who is asking for a list of events, which decides how far back that list goes.
 *
 * Both calendar reads are PUBLIC routes - `x-user-id` is whatever nginx forwarded and is absent for
 * an anonymous reader - so this is optional by construction, and an absent viewer gets the whole
 * window exactly as before. The limit itself is `promoCutoffFor`, shared with the posts feed.
 */
export interface CalendarViewer {
  userId?: string;
  isGlobalAdmin?: boolean;
}

/** HKDF purpose of the Business key's encryption key; bump the suffix to rotate the format. */
export const LYDIA_BUSINESS_KEY_PURPOSE = 'lydia-business-key/v1';

/**
 * What a Lydia Business private token may look like: printable ASCII, no whitespace, 8 to 256
 * characters. Its real shape is unmeasured (no validated Business's key has been read), so this only
 * keeps out what cannot be a token - a pasted sentence, a newline, a megabyte.
 */
const LYDIA_BUSINESS_KEY_RE = /^[\x21-\x7e]{8,256}$/;

/**
 * The `code` of the 409 refusing to link a second Business onto an association that has one.
 * Mirrored by core-service's `payment.controller.ts` and the frontend's `lydiaOnboardingRefusal.ts`.
 */
export const LYDIA_ACCOUNT_ALREADY_LINKED = 'LYDIA_ACCOUNT_ALREADY_LINKED';

/**
 * The `code` of the 409 refusing to record a Responsable while another person is the live one:
 * changing the Responsable to another PERSON is not offered (lot 3 changes their number only).
 */
export const LYDIA_RESPONSABLE_ALREADY_SET = 'LYDIA_RESPONSABLE_ALREADY_SET';

/**
 * The `code` of the 409 refusing ANOTHER phone number for the live Responsable while an EARLIER
 * number change still has an old number whose removal Lydia has not confirmed (lot 3): that one is
 * removed first. Also a record-mode request with another number, which changes nothing at Lydia.
 */
export const LYDIA_RESPONSABLE_PHONE_LOCKED = 'LYDIA_RESPONSABLE_PHONE_LOCKED';

/** The `code` of the 409 refusing a Responsable step while another one's outcome is not known. */
export const LYDIA_RESPONSABLE_IN_FLIGHT = 'LYDIA_RESPONSABLE_IN_FLIGHT';

/** The `code` of the 409 answered when the linked Business changed between two steps. */
export const LYDIA_BUSINESS_CHANGED = 'LYDIA_BUSINESS_CHANGED';

/**
 * SQL predicate over `associations` (unaliased, an UPDATE's target): its managers hold NO Business
 * - the ONE definition (`managedVendorTokenSql`) read as a scalar subquery, so a bridge's historical
 * account never counts as theirs and its enrolled Business does.
 */
const MANAGES_NO_BUSINESS_SQL = `(SELECT ${managedVendorTokenSql('x', 'b')}
     FROM associations x ${bridgeJoinSql('x', 'b')} WHERE x.id = associations.id) IS NULL`;

function responsableAlreadySet(): ConflictException {
  return new ConflictException({
    code: LYDIA_RESPONSABLE_ALREADY_SET,
    message: 'This association already has a Responsable',
  });
}

function responsablePhoneLocked(): ConflictException {
  return new ConflictException({
    code: LYDIA_RESPONSABLE_PHONE_LOCKED,
    message: 'An earlier number change of the Responsable is not finished',
  });
}

function lydiaBusinessChanged(): ConflictException {
  return new ConflictException({
    code: LYDIA_BUSINESS_CHANGED,
    message: 'The Lydia Business of this association changed meanwhile',
  });
}

/** HKDF purpose of a cashier phone's encryption key (migration 118); bump the suffix to rotate. */
export const LYDIA_CASHIER_PHONE_PURPOSE = 'lydia-cashier-phone/v1';

/** What a cashier phone must look like when stored: E.164, as core-service validated it. */
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Where a readiness change came from, for its log line. */
export interface LydiaReadinessRef {
  /** `shop`, `form`, `form-guest` (a refused request/do), `webhook` or `admin`. */
  path: 'shop' | 'form' | 'form-guest' | 'webhook' | 'admin';
  /** The checkout, submission or association the change names, when there is one. */
  id?: string;
}

/** What `setLydiaReadiness` did. */
export type LydiaReadinessOutcome =
  | {
      kind: 'transitioned' | 'replay';
      associationId: string;
      previousCause: LydiaReadinessCause | null;
      previousAt: Date | null;
      /**
       * Set when this transition SWITCHED a bridge to its enrolled Business (the token was the
       * pending one; lydia-account-bridge.ts): the historical account stopped collecting with it.
       */
      bridgeSwitched?: true;
    }
  | {
      /** An unsigned VALIDATED over a holder Lydia itself reported: nothing written. */
      kind: 'held-by-lydia';
      associationId: string;
      previousCause: LydiaReadinessCause | null;
      previousAt: Date | null;
    }
  | {
      /**
       * Error 5 on the Business a bridge switch made active: the historical account collects again
       * (`already`: a concurrent refusal switched it back first). The caller re-issues the SAME
       * payment once on it - the owner's decision for this bridge, never a general fallback.
       */
      kind: 'switched-back';
      associationId: string;
      already: boolean;
    }
  | { kind: 'no-holder' | 'no-holder-enrolment-in-flight' };

/** The holder of a vendor token as the readiness writer reads it, locked `FOR UPDATE`. */
interface LydiaReadinessHolder {
  id: string;
  name: string;
  ready: boolean;
  cause: LydiaReadinessCause | null;
  at: Date | string | null;
  type: Association['type'];
  paymentDelegationStatus: Association['paymentDelegationStatus'];
  paymentParentAssociationId: string | null;
}

/** What a bridge's switch back did in its transaction (`switchBackOnRefusal`). */
interface BridgeSwitchBack {
  /** The historical account's readiness, restored from the standby columns. */
  historicalReady: boolean;
  /** `switchBackCount` after this one. */
  switchBackCount: number;
  /**
   * Whether the enrolled Business had PROVEN itself (`enrolledProvenAt`, a request/do Lydia issued
   * on it) - its managers were then told "active", and are owed the counter-notice.
   */
  wasProven: boolean;
  withheld: number;
  admins: number;
  delegates: string[];
  delegatesWithheld: Map<string, number>;
}

/** The Responsable of an association's CURRENT Business, as the payments screen reads it. */
export interface LydiaResponsableView {
  userId: string;
  name: string;
  phoneEnd: string;
  /**
   * False when Lydia answered the add but its read-back did not confirm every right: the person is
   * a cashier at Lydia that the same-number resend confirms (a revocation may be owed otherwise).
   */
  confirmed: boolean;
}

/** What a Business key is bound to: this association AND this Business. */
function lydiaBusinessKeyContext(associationId: string, vendorToken: string): string {
  return `${associationId}:${vendorToken}`;
}

/**
 * The typed 403 refusing a payment-delegation acceptance by anyone but the receiver's own shop
 * managers or the platform administrator - a BDE governing the receiver included (owner, 2026-11-02).
 */
export const DELEGATION_ACCEPT_RECEIVER_ONLY = 'DELEGATION_ACCEPT_RECEIVER_ONLY';

/**
 * The typed 403 refusing a payment-delegation REJECT or REVOKE on the receiver's side by anyone but
 * its own shop managers or the platform administrator - the same rule as acceptance (owner review
 * of #2967, 2026-11-03). The list itself still cancels its own delegation through its own managers.
 */
export const DELEGATION_REVOKE_RECEIVER_ONLY = 'DELEGATION_REVOKE_RECEIVER_ONLY';

/**
 * The typed 409 refusing a payment-delegation ACCEPTANCE that would make a chain (review of #2967,
 * 2026-11-03): the receiver itself delegates its payments, or the requester already receives
 * approved delegations of its own. The request checks the same two rules, but before any lock, so
 * two crossed requests (A asks B while B asks C) both pass; the acceptance is where the chain would
 * be written, so it is checked again there, under its locks.
 */
export const DELEGATION_CHAIN_REFUSED = 'DELEGATION_CHAIN_REFUSED';

/** In which capacity a delegation was accepted - the `acceptedAs` of migration 125. */
export type DelegationAcceptor = 'member' | 'platform-admin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The association whose NAME is printed above a list (`parentName`): its G3 label when it has one
 * ("liste pour le BDS"), else its governing parent. Lists only - since WP-D1 an association has a
 * governing parent too, and the tiles and the detail page (which print `parentName` whatever the
 * type, on older builds as well) must not start printing "BDE" above every club.
 */
export function shownParentId(
  a: Pick<Association, 'type' | 'parentAssociationId' | 'displayParentAssociationId'>
): string | null {
  if (a.type !== 'list') return null;
  return a.displayParentAssociationId ?? a.parentAssociationId;
}

@Injectable()
export class AssociationsService {
  private readonly logger = new Logger(AssociationsService.name);
  constructor(
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>,
    @InjectRepository(AssociationMember)
    private readonly memberRepo: Repository<AssociationMember>,
    @InjectRepository(AssociationCalendarEvent)
    private readonly calendarRepo: Repository<AssociationCalendarEvent>,
    @InjectRepository(AssociationCalendarEventCoOwner)
    private readonly coOwnerRepo: Repository<AssociationCalendarEventCoOwner>,
    @InjectRepository(AssociationDocument)
    private readonly docRepo: Repository<AssociationDocument>,
    @InjectRepository(DocumentReviewerGrant)
    private readonly reviewerGrantRepo: Repository<DocumentReviewerGrant>,
    @InjectRepository(Post)
    private readonly postRepo: Repository<Post>,
    @InjectRepository(Form)
    private readonly formRepo: Repository<Form>,
    @InjectRepository(AssociationProduct)
    private readonly productRepo: Repository<AssociationProduct>,
    private readonly redis: RedisService,
    private readonly httpService: HttpService,
    /** Owns the type -> push-content mapping. Writing notification rows directly bypasses it, which
        is how the agenda's push stayed English; go through this. */
    private readonly notifications: PostNotificationsService,
    private readonly userTagService: UserTagService,
    private readonly lydiaNotifier: LydiaPaymentsNotifier
  ) {}

  /** Co-organisation (D39), registered at boot by `CoorganisationModule` - see `co-organisers.port`. */
  private coOrganisers: CoOrganiserPort | null = null;

  /** Called once, by the co-organisation service. A second registration is a wiring defect. */
  registerCoOrganisers(port: CoOrganiserPort): void {
    if (this.coOrganisers) throw new Error('co-organisers registered twice');
    this.coOrganisers = port;
    this.logger.log('[COORG] co-organisation registered');
  }

  private coOrganiserPort(): CoOrganiserPort {
    if (!this.coOrganisers) {
      // Not a user error: the module that implements it was not loaded, and every event write
      // naming a co-organiser would silently drop it.
      throw new Error('co-organisation is not registered (CoorganisationModule missing)');
    }
    return this.coOrganisers;
  }

  /**
   * Drops every cached feed page so the next request rebuilds it with this association's new name,
   * slug or logo. The prefix lives in `post-list-cache`, with `PostsService`'s own sweep: this one
   * was already complete and the writer's was not, which is the whole reason they now share.
   */
  private async invalidatePostListCaches(): Promise<void> {
    try {
      await invalidatePostListCache(this.redis);
    } catch (e: unknown) {
      // Non-fatal, and logged: a sweep that failed leaves pages stale for up to their TTL.
      this.logger.warn('[CACHE] feed cache sweep failed - pages stay stale until their TTL', e);
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Creates a new association (or list). The slug is DERIVED from the name (suffixed `-2`, `-3`... on
   * a collision, the unique index deciding, and likewise when its cotisation stem would collide with
   * another association's); one sent explicitly by an old client is validated and refused if taken.
   *
   * IT REACHES ITS CREATOR'S CAMPUS BY DEFAULT (audiences chantier, user 2026-10-07; it replaced
   * D36's "the creator's spaces"): in the SAME transaction as the row, ONE rule `(every formation,
   * the creator's profile campus)` is written, so it is never visible for a moment with no rule and
   * the grid at `/admin/spaces` reads it back as a ticked campus. A creator with no campus is
   * REFUSED with the typed `AUDIENCE_CREATOR_CAMPUS_REQUIRED` (decision 5) and nothing is written -
   * the campus is never guessed. An institution keeps its own rule: no default, the creating global
   * admin ticks its audience afterwards. WITH A GOVERNING PARENT (WP-D1, reform 2.5: every
   * non-admin creator's entity has one, `resolveCreateDependency`) the default is instead the spaces
   * that parent governs - so a BDE star always creates an audience it may edit (decision 7), and an
   * entity of a campus two BDEs share never starts out reaching both (closes P4).
   *
   * A PLACEMENT (the platform admin's form on `/admin/spaces`, owner 2026-11-02) replaces that
   * default with the spaces the admin chose - possibly none - and may add ONE first admin, in the
   * same transaction as the row. Without a first admin the entity has no member at all: the
   * creating admin never becomes one. Only a platform admin may pass one.
   */
  async create(
    dto: CreateAssociationDto,
    userId: string,
    isGlobalAdmin: boolean,
    placement?: AssociationPlacement
  ) {
    if (placement && !isGlobalAdmin) {
      this.logger.warn(`[create] placement refused: ${userId.slice(0, 8)} is not a platform admin`);
      throw platformAdminOnly();
    }
    if (placement) {
      // Refused before any write: an association or a list addresses a campus, never everyone.
      assertAudienceAllowedForType(dto.type ?? 'association', normaliseRules(placement.audiences));
    }
    const explicitSlug = dto.slug?.trim() ? dto.slug : null;
    if (explicitSlug !== null && !SLUG_PATTERN.test(explicitSlug)) {
      throw new BadRequestException(
        'Slug must start with a letter or digit and contain only lowercase letters, digits, and hyphens (2-50 chars)'
      );
    }
    if (explicitSlug !== null && RESERVED_SLUGS.has(explicitSlug)) {
      throw new BadRequestException('This slug is reserved');
    }
    // The logo is normally set by the upload path; a value sent here is held to the same allowlist.
    const logoUrl = dto.logoUrl?.trim() ? dto.logoUrl.trim() : null;
    if (logoUrl !== null) {
      assertAssociationImageUrl(logoUrl);
      await assertNotQuestionImage(this.assoRepo, logoUrl);
    }

    if (explicitSlug !== null) {
      // An old client's own slug: refused when taken, as before. The unique index still arbitrates
      // a race between this read and the insert.
      const existing = await this.assoRepo.findOne({ where: { slug: explicitSlug } });
      if (existing) {
        throw new BadRequestException('An association with this slug already exists');
      }
      try {
        return await this.insertAssociation(
          dto,
          explicitSlug,
          logoUrl,
          userId,
          isGlobalAdmin,
          placement
        );
      } catch (err) {
        if (!(await isSlugUniqueViolation(err, this.catalogQuery))) throw err;
        this.logger.warn(`[slug] explicit slug ${explicitSlug} was taken between check and insert`);
        throw new BadRequestException('An association with this slug already exists');
      }
    }

    // DERIVED: each candidate is its own transaction, because a unique violation aborts the one it
    // happens in. The unique index is the arbiter, so two concurrent creates of one name end on
    // `-2` and `-3` instead of a check-then-insert that both pass.
    for (const candidate of slugCandidates(dto.name)) {
      try {
        const saved = await this.insertAssociation(
          dto,
          candidate,
          logoUrl,
          userId,
          isGlobalAdmin,
          placement
        );
        this.logger.log(`[slug] derived ${candidate} from the name`);
        return saved;
      } catch (err) {
        // A candidate whose cotisation tags would coincide with another association's (`bde-2026-2027`
        // beside `bde`) is cured by the next suffix exactly as a taken one is.
        if (isCotisationStemCollision(err)) {
          this.logger.log(
            `[slug] ${candidate} collides with a cotisation stem, trying the next suffix`
          );
          continue;
        }
        if (!(await isSlugUniqueViolation(err, this.catalogQuery))) throw err;
        this.logger.log(`[slug] ${candidate} is taken, trying the next suffix`);
      }
    }
    this.logger.error(`[slug] no free slug in ${SLUG_MAX_ATTEMPTS} attempts for "${dto.name}"`);
    throw new BadRequestException({
      code: SLUG_EXHAUSTED,
      message: 'No free slug could be derived from this name',
    });
  }

  /**
   * The slug a create of `name` would take NOW: the first of the SAME `slugCandidates` that is
   * neither taken nor a cotisation-stem collision (`assertCotisationStemFree`, the check the create
   * transaction runs). A PREVIEW for the admin form - the create stays the authority, and a
   * concurrent create may still move it one suffix on. `null` when every candidate is taken.
   */
  async previewDerivedSlug(name: string): Promise<string | null> {
    // ONE read of every stem (a slug is its own base stem, so a taken slug collides too), then the
    // same predicate the create's `assertCotisationStemFree` applies - asked, never learned by
    // catching its refusal, so a preview typed letter by letter logs no collision it did not make.
    const collides = await stemCollidesElsewhere(this.assoRepo.manager, null);
    const slug = slugCandidates(name).find((candidate) => !collides(candidate)) ?? null;
    if (slug === null) this.logger.debug(`[slug] preview: no free candidate`);
    return slug;
  }

  /**
   * One page of the platform admin's catalogue (`/admin/spaces`): every entity of one kind, member
   * or not, ordered by `(name, id)` and paged by KEYSET so a page costs the same at any depth and
   * a row created meanwhile never shifts the next one. `q` keeps the names or slugs containing it,
   * ignoring case and accents (`foldSql`; `strpos`, so `%` and `_` are plain characters). Each row carries its
   * member count and its audience rules, so the grid needs no second whole-table read.
   */
  async adminCatalogue(query: {
    type: 'association' | 'list' | 'institution';
    q?: string;
    after?: string;
    limit?: number;
  }) {
    const limit = query.limit ?? ADMIN_CATALOGUE_DEFAULT_LIMIT;
    const qb = this.assoRepo
      .createQueryBuilder('a')
      .where('a.type = :catalogueType', { catalogueType: query.type })
      .orderBy('a.name', 'ASC')
      .addOrderBy('a.id', 'ASC')
      .take(limit + 1);
    const search = query.q?.trim();
    if (search) {
      // Accent- and case-insensitive on both sides: "ecole" finds "Ecole" written with its accent.
      const needle = foldSql(':catalogueQ');
      qb.andWhere(
        `(strpos(${foldSql('a.name')}, ${needle}) > 0 OR strpos(${foldSql('a.slug')}, ${needle}) > 0)`,
        { catalogueQ: search, ...SEARCH_FOLD_PARAMS }
      );
    }
    if (query.after) {
      const position = decodeCatalogueCursor(query.after);
      qb.andWhere('(a.name, a.id) > (:afterName, :afterId::uuid)', {
        afterName: position.name,
        afterId: position.id,
      });
    }
    const fetched = await qb.getMany();
    const rows = fetched.slice(0, limit);
    const next =
      fetched.length > limit
        ? encodeCatalogueCursor({ name: rows[rows.length - 1].name, id: rows[rows.length - 1].id })
        : null;
    const ids = rows.map((a) => a.id);
    const [counts, rules] = ids.length
      ? await Promise.all([
          this.assoRepo.query(
            `SELECT "associationId", COUNT(*)::int AS n FROM association_members
              WHERE "associationId" = ANY($1::uuid[]) GROUP BY "associationId"`,
            [ids]
          ) as Promise<{ associationId: string; n: number }[]>,
          this.assoRepo.manager.find(AssociationAudience, { where: { associationId: In(ids) } }),
        ])
      : [[], []];
    const countOf = new Map(counts.map((c) => [c.associationId, c.n]));
    this.logger.debug(
      `[ADMIN_CATALOGUE] ${query.type} q=${search ? 'yes' : 'no'} after=${query.after ? 'yes' : 'no'}: ${rows.length} row(s), more=${next !== null}`
    );
    return {
      rows: rows.map((a) => ({
        ...a,
        memberCount: countOf.get(a.id) ?? 0,
        audiences: rules
          .filter((r) => r.associationId === a.id)
          .map((r) => ({ formation: r.formation, campus: r.campus })),
      })),
      next,
    };
  }

  /**
   * Reads the catalog OUTSIDE the create transaction a violation has just aborted - what tells a
   * slug collision from any other unique violation (`isSlugUniqueViolation`).
   */
  private readonly catalogQuery = (sql: string, params: unknown[]) =>
    this.assoRepo.query(sql, params);

  /** One create attempt with ONE slug: the row and its default audience rule, in one transaction. */
  private insertAssociation(
    dto: CreateAssociationDto,
    slug: string,
    logoUrl: string | null,
    userId: string,
    isGlobalAdmin: boolean,
    placement?: AssociationPlacement
  ) {
    const asso = this.assoRepo.create({
      ...dto,
      slug,
      logoUrl,
      contactEmail: dto.contactEmail?.trim() ? dto.contactEmail.trim() : null,
      createdBy: userId,
    });
    // A parent the trigger refuses (a race with the check below, or a placement naming a parented
    // governor) reaches the client as the same typed 409 as every other dependency door (F6).
    return withDependencyRefusals(this.logger, `the creation of ${slug}`, () =>
      this.insertAssociationTx(asso, dto, userId, isGlobalAdmin, placement)
    );
  }

  /** The transaction of {@link insertAssociation}: the row, its parent, its default audience. */
  private insertAssociationTx(
    asso: Association,
    dto: CreateAssociationDto,
    userId: string,
    isGlobalAdmin: boolean,
    placement?: AssociationPlacement
  ) {
    return this.assoRepo.manager.transaction(async (manager) => {
      // Its base cotisation tag must never coincide with another association's tag names.
      await assertCotisationStemFree(manager, null, asso.slug);
      const dependency = await this.resolveCreateDependency(manager, dto, userId, isGlobalAdmin);
      asso.parentAssociationId = dependency.parentId;
      asso.displayParentAssociationId = dependency.labelId;
      const saved = await manager.save(asso);
      if (dependency.parentId !== null) {
        await writeDependencyJournal(
          manager,
          'entity',
          saved.id,
          null,
          dependency.parentId,
          userId,
          'create'
        );
      }
      if (placement) {
        // Only a platform admin reaches a placement (refused above otherwise).
        await this.placeNewAssociation(manager, saved, placement, { userId, isGlobalAdmin });
        return saved;
      }
      if (dto.type === 'institution') {
        // The type decides the default (D33's one mechanism): an institution addresses nobody until
        // an admin ticks the /admin/spaces grid - a global admin's own spaces are rarely the School's.
        this.logger.log(
          `[spaces] ${saved.id} is an institution: no default rule, visible to its members only`
        );
        return saved;
      }
      if (dependency.parentId !== null) {
        // The default audience derives from the parent (reform 2.5, closes P4): the spaces it
        // governs, in the grid's smallest form - never a whole campus another BDE shares.
        const governed = await manager.find(Space, {
          where: { bdeAssociationId: dependency.parentId },
        });
        const fromParent = smallestRules(governed);
        this.logger.log(
          `[spaces] ${saved.id} reaches its parent's spaces: ${fromParent.map((r) => `${r.formation ?? '*'}|${r.campus ?? '*'}`).join(', ')}`
        );
        await manager.insert(
          AssociationAudience,
          fromParent.map((r) => ({
            associationId: saved.id,
            formation: r.formation,
            campus: r.campus,
          }))
        );
        return saved;
      }
      const [profile] = (await manager.query(READER_PROFILE_SQL, [userId])) as {
        campus: string | null;
      }[];
      // Only a platform admin creates with no parent (`resolveCreateDependency` gives every
      // non-admin creator one of its BDEs). Thrown inside the transaction: the row saved above is
      // rolled back with it.
      const rules = defaultCampusRules(profile?.campus ?? null);
      this.logger.log(
        `[spaces] ${saved.id} reaches its creator's spaces: ${rules.map((r) => `${r.formation ?? '*'}|${r.campus}`).join(', ')}`
      );
      await manager.insert(
        AssociationAudience,
        rules.map((r) => ({ associationId: saved.id, formation: r.formation, campus: r.campus }))
      );
      return saved;
    });
  }

  /**
   * THE PARENT A NEW ENTITY IS CREATED UNDER (reform 2.5, B1; WP-D1), and its G3 label.
   *
   * - an institution has none; naming one is `DEPENDENCY_INSTITUTION`;
   * - a named parent that is NOT a BDE (a list made "for the BDS", as an older client still sends)
   *   becomes the display-only LABEL (G3), and the governing parent falls back to the default below;
   * - a platform admin's parent is the BDE it names, or none;
   * - a non-admin creator's parent is the BDE it names among those where it holds MANAGE_ASSO
   *   (`DEPENDENCY_PARENT_NOT_YOURS` otherwise), else its only such BDE; holding it in several and
   *   naming none is `DEPENDENCY_PARENT_CHOICE_REQUIRED`.
   * Asked inside the create transaction; migration 131's trigger judges the same row at the insert.
   */
  private async resolveCreateDependency(
    manager: EntityManager,
    dto: CreateAssociationDto,
    userId: string,
    isGlobalAdmin: boolean
  ): Promise<{ parentId: string | null; labelId: string | null }> {
    const named = dto.parentAssociationId ?? null;
    this.logger.debug(
      `[DEPENDENCY] create ${dto.type ?? 'association'} by ${userId.slice(0, 8)}: parent named ${named ?? 'none'}`
    );
    if (dto.type === 'institution') {
      if (named !== null) {
        this.logger.warn(`[DEPENDENCY] create refused: an institution given parent ${named}`);
        throw dependencyConflict(DEPENDENCY_INSTITUTION, 'An institution depends on nobody');
      }
      return { parentId: null, labelId: null };
    }
    let parentId: string | null = null;
    let labelId: string | null = null;
    if (named !== null) {
      const parent = await manager.findOne(Association, { where: { id: named } });
      if (!parent) throw new NotFoundException('Parent association not found');
      const governs = (await manager.count(Space, { where: { bdeAssociationId: named } })) > 0;
      if (parent.type === 'association' && governs) {
        parentId = named;
      } else if (parent.type === 'institution') {
        this.logger.warn(`[DEPENDENCY] create refused: institution ${named} named as parent`);
        throw dependencyConflict(DEPENDENCY_PARENT_NOT_A_BDE, "An institution is nobody's parent");
      } else {
        labelId = named;
        this.logger.log(`[DEPENDENCY] create: ${named} governs no space, kept as the label (G3)`);
      }
    }
    if (isGlobalAdmin) return { parentId, labelId };
    const mine = (
      (await manager.query(BDES_WHERE_USER_HOLDS_SQL, [
        userId,
        AssociationPermissionFlag.MANAGE_ASSO,
      ])) as { id: string }[]
    ).map((r) => r.id);
    if (parentId !== null) {
      if (!mine.includes(parentId)) {
        this.logger.warn(
          `[DEPENDENCY] create refused: ${userId.slice(0, 8)} holds no MANAGE_ASSO in ${parentId}`
        );
        throw dependencyConflict(
          DEPENDENCY_PARENT_NOT_YOURS,
          'Choose a BDE in which you hold the association management right'
        );
      }
      return { parentId, labelId };
    }
    if (mine.length === 0) {
      // The create route admits a non-admin only through MANAGE_ASSO in a BDE (the same predicate),
      // so this is a defect or a hand-made call - accused, and refused.
      this.logger.error(
        `[DEPENDENCY] create by ${userId.slice(0, 8)}: a non-admin creator holding MANAGE_ASSO in no BDE`
      );
      throw dependencyConflict(
        DEPENDENCY_PARENT_NOT_YOURS,
        'Only a BDE manager or a platform admin creates an association'
      );
    }
    if (mine.length > 1) {
      this.logger.warn(
        `[DEPENDENCY] create refused: ${userId.slice(0, 8)} manages ${mine.length} BDEs and named none`
      );
      throw dependencyConflict(
        DEPENDENCY_PARENT_CHOICE_REQUIRED,
        'Choose which of your BDEs the new entity depends on'
      );
    }
    return { parentId: mine[0], labelId };
  }

  /**
   * Writes a placement inside the create transaction: the chosen rules (none is allowed - it then
   * reaches nobody), then the first admin when one was picked. A first admin naming no account is a
   * typed 400 and rolls the row back with it, so a half-placed entity never exists.
   */
  private async placeNewAssociation(
    manager: EntityManager,
    saved: Association,
    placement: AssociationPlacement,
    granter: MemberGranter
  ): Promise<void> {
    const rules = normaliseRules(placement.audiences);
    if (rules.length > 0) {
      await manager.insert(
        AssociationAudience,
        rules.map((r) => ({ associationId: saved.id, formation: r.formation, campus: r.campus }))
      );
    }
    this.logger.log(`[spaces] ${saved.id} placed by a platform admin: ${rules.length} rule(s)`);
    const firstAdmin = placement.firstAdmin;
    if (!firstAdmin) {
      this.logger.log(`[create] ${saved.id} has no member: none was asked for`);
      return;
    }
    const known = (await manager.query(`SELECT 1 FROM users WHERE id::text = $1 LIMIT 1`, [
      firstAdmin.userId,
    ])) as unknown[];
    if (known.length === 0) {
      this.logger.warn(`[create] first admin ${firstAdmin.userId.slice(0, 8)} names no account`);
      throw new BadRequestException({
        code: ADMIN_ASSOCIATION_ERROR.FIRST_ADMIN_UNKNOWN,
        message: 'The first admin picked names no account.',
      });
    }
    await this.insertMembership(manager, saved, firstAdmin, 0, granter, 'create.firstAdmin');
    this.logger.log(`[create] ${saved.id} first admin ${firstAdmin.userId.slice(0, 8)}`);
  }

  /**
   * Inserts ONE membership row: the ONE place a member is written, whether by `addMember` or by a
   * placement's first admin. The bitmask is narrowed to what the kind may hold; the GRANTER is judged
   * here, so no caller can skip it - the institution rule (`assertInstitutionMemberWrite`) and the
   * grant ceiling (`member-flag-ceiling.ts`), then the audit line of a super-admin's excluded grant.
   * The placement passes its platform admin, whose ceiling is every flag but who is still held to
   * the institution rule. The roster never crosses the review cohort's boundary.
   */
  private async insertMembership(
    manager: EntityManager,
    association: Pick<Association, 'id' | 'type'>,
    member: { userId: string; permissions: number; role?: string },
    sortOrder: number,
    granter: MemberGranter,
    what: string
  ): Promise<AssociationMember> {
    const permissions = writablePermissions(association.type, member.permissions);
    const ctx = { associationId: association.id, what };
    assertInstitutionMemberWrite(this.logger, association.type, granter, 0, permissions, ctx);
    const standing = await this.judgeMemberFlags(granter, association.id, 0, permissions, what);
    await assertRosterStaysOnOneSide(manager, association.id, member.userId);
    const saved = await manager.save(
      manager.create(AssociationMember, {
        associationId: association.id,
        userId: member.userId,
        // No role given: the column's default, never a label this code types.
        ...(member.role === undefined ? {} : { role: member.role }),
        permissions,
        sortOrder,
      })
    );
    logSuperAdminExcludedGrant(this.logger, standing, 0, permissions, ctx);
    return saved;
  }

  /**
   * Returns associations alphabetically with a memberCount field attached to each.
   * Pass `type` to restrict to regular associations or promo lists; omit for both.
   *
   * `opts.viewerId` makes it THE DIRECTORY of that reader (D37): an association is kept when its
   * rules reach one of the reader's spaces or the reader is a member of it -
   * `associationVisibleToViewerSql`, the agenda's predicate, so the two never disagree. A global
   * admin is an ordinary reader here. No viewer is the whole catalogue (the public listing and
   * `?scope=all`). `opts.campus` / `opts.formation` keep the associations whose OWN rules reach a
   * space matching them (the association map).
   */
  async list(
    type?: 'association' | 'list' | 'institution',
    opts: {
      viewerId?: string;
      campus?: SpaceCampus | null;
      formation?: SpaceFormation | null;
    } = {}
  ) {
    const qb = this.assoRepo.createQueryBuilder('a').orderBy('a.name', 'ASC');
    if (type) qb.andWhere('a.type = :directoryType', { directoryType: type });
    if (opts.viewerId) {
      this.logger.debug(`[DIRECTORY] restricted to the spaces of ${opts.viewerId.slice(0, 8)}`);
      qb.andWhere(associationVisibleToViewerSql('a.id', ':directoryViewerId'), {
        directoryViewerId: opts.viewerId,
      });
    }
    const campus = opts.campus ?? null;
    const formation = opts.formation ?? null;
    if (campus !== null || formation !== null) {
      this.logger.debug(
        `[DIRECTORY] narrowed to rules reaching ${formation ?? '*'} x ${campus ?? '*'}`
      );
      qb.andWhere(
        associationRulesReachSpaceMatchingSql('a.id', {
          campus: campus === null ? null : ':directoryCampus',
          formation: formation === null ? null : ':directoryFormation',
        }),
        { directoryCampus: campus, directoryFormation: formation }
      );
    }
    const associations = await qb.getMany();

    // Attach member count
    const counts = await this.memberRepo
      .createQueryBuilder('m')
      .select('m.associationId', 'associationId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('m.associationId')
      .getRawMany();

    const countMap = new Map(
      counts.map((c: { associationId: string; count: string }) => [
        c.associationId,
        parseInt(c.count, 10),
      ])
    );

    const parents = await this.parentNameMap(associations.map(shownParentId));

    return associations.map((a) => {
      const shown = shownParentId(a);
      return {
        ...a,
        memberCount: countMap.get(a.id) ?? 0,
        parentName: shown ? (parents.get(shown) ?? null) : null,
      };
    });
  }

  /**
   * Resolves parent association ids to their display names in a single query.
   * Lets lists render "BDE - <list> - <year>" without an N+1 lookup.
   */
  private async parentNameMap(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map();
    const rows = await this.assoRepo.find({
      where: { id: In(unique) },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Display name of the parent `shownParentId` picked, or null when there is none. */
  private async parentName(parentId: string | null): Promise<string | null> {
    if (!parentId) return null;
    const parent = await this.assoRepo.findOne({
      where: { id: parentId },
      select: { name: true },
    });
    return parent?.name ?? null;
  }

  /** Loads one association by its UUID and appends a memberCount. Throws NotFoundException if absent. */
  async findById(id: string) {
    // `id` is a `uuid` column; a non-UUID string reaches Postgres as a syntax error rather than
    // a plain miss, which TypeORM surfaces as an uncaught 500 instead of the 404 every caller
    // expects. A malformed id and a well-formed id nothing points to are the same fact to the
    // caller, so both are reported identically.
    if (!isUUID(id)) throw new NotFoundException('Association not found');
    const asso = await this.assoRepo.findOne({ where: { id } });
    if (!asso) throw new NotFoundException('Association not found');
    const memberCount = await this.memberRepo.count({
      where: { associationId: id },
    });
    return { ...asso, memberCount, parentName: await this.parentName(shownParentId(asso)) };
  }

  /** Loads one association by its URL slug and appends a memberCount. */
  /**
   * The ids of the associations of a space ({@link OFFERED_BY_SPACE_KEY_SQL}): type `association`,
   * audience reaching the space, archived ones included - the carte's set plus the archived
   * associations of the same space. Read by the public directory a showcase filters by its space.
   */
  async offeredInSpace(space: PublicSpaceKey): Promise<Set<string>> {
    const rows: { id: string }[] = await this.assoRepo.query(OFFERED_BY_SPACE_KEY_SQL, [
      space.formation,
      space.campus,
    ]);
    this.logger.debug(
      `[DIRECTORY] ${space.formation}:${space.campus} offers ${rows.length} association(s)`
    );
    return new Set(rows.map((r) => r.id));
  }

  async findBySlug(slug: string) {
    const asso = await this.assoRepo.findOne({ where: { slug } });
    if (!asso) throw new NotFoundException('Association not found');
    const memberCount = await this.memberRepo.count({
      where: { associationId: asso.id },
    });
    return { ...asso, memberCount, parentName: await this.parentName(shownParentId(asso)) };
  }

  /** Partially updates an association (blank text fields normalised to null) and invalidates post-list caches. */
  async update(id: string, dto: UpdateAssociationDto) {
    const asso = await this.findById(id);
    // Enabling a cotisation creates a product: only an entity that may collect now (an
    // association, or a list through an approved delegate). Disabling one (or editing a stored
    // mode) stays open.
    if (dto.cotisationEnabled === true) {
      assertMayCollect(this.logger, asso, 'cotisation enable');
    }
    const patch = { ...dto } as unknown as Partial<Association>;
    // Blank clears the logo URL; anything else is held to the image URL allowlist before any write.
    if (dto.logoUrl !== undefined) {
      const logoUrl = dto.logoUrl === null ? '' : dto.logoUrl.trim();
      if (logoUrl === '') {
        patch.logoUrl = null;
      } else {
        assertAssociationImageUrl(logoUrl);
        // A logo already stored is kept as it is: only a CHANGE is held to the question-image rule.
        if (logoUrl !== asso.logoUrl) await assertNotQuestionImage(this.assoRepo, logoUrl);
        patch.logoUrl = logoUrl;
      }
    }
    if (dto.description !== undefined && dto.description.trim() === '') {
      patch.description = null;
    }
    if (dto.bioMarkdown !== undefined && dto.bioMarkdown.trim() === '') {
      patch.bioMarkdown = null;
    }
    if (dto.color !== undefined && (dto.color === null || dto.color.trim() === '')) {
      patch.color = null;
    }
    if (
      dto.contactEmail !== undefined &&
      (dto.contactEmail === null || dto.contactEmail.trim() === '')
    ) {
      patch.contactEmail = null;
    }
    // Second-theme fields (lists): blank clears them back to null.
    if (dto.name2 !== undefined && (dto.name2 === null || dto.name2.trim() === '')) {
      patch.name2 = null;
    }
    if (dto.logoMediaId2 !== undefined && (dto.logoMediaId2 === null || dto.logoMediaId2 === '')) {
      patch.logoMediaId2 = null;
    }
    // documentQuotaBytes comes in as bigint but must stay a number in TypeORM
    if (patch.documentQuotaBytes !== undefined) {
      patch.documentQuotaBytes = Number(patch.documentQuotaBytes);
    }
    // Cotisation expiry is derived server-side from the mode (dated -> 31/08 of the current
    // academic year; lifetime -> never), never chosen by the client, so it always matches the
    // granted tag (see deriveCotisationTag). Any client-sent cotisationExpiresAt is ignored.
    delete patch.cotisationExpiresAt;
    if (dto.cotisationMode !== undefined) {
      patch.cotisationExpiresAt =
        dto.cotisationMode === 'dated' ? deriveCotisationTag(asso.slug, 'dated').expiresAt : null;
    }
    if (dto.archived !== undefined || dto.cotisationMode === null) {
      // Archiving is ordered against a purchase on the association ROW: `decidePurchase` reads it
      // FOR SHARE under the buyer's lock, so this write waits for a checkout already deciding, and a
      // checkout deciding after it reads `archived` committed (docs/wiki/cotisations.md).
      // CLEARING the cotisation mode takes the same lock and counts the members-only rows under it
      // (`assertCotisationModeClearable`, 409 `COTISATION_MODE_IN_USE`), the order a members-only
      // save's `FOR SHARE` gate reads the mode in.
      await this.assoRepo.manager.transaction(async (manager) => {
        if (dto.cotisationMode === null) {
          await assertCotisationModeClearable(manager, id, this.logger);
        } else {
          await manager.findOne(Association, {
            where: { id },
            lock: { mode: 'pessimistic_write' },
          });
        }
        await manager.update(Association, id, patch);
      });
      if (dto.archived !== undefined) {
        this.logger.log(`[ASSO] association=${id.slice(0, 8)} archived=${dto.archived}`);
      }
    } else {
      await this.assoRepo.update(id, patch);
    }
    await this.invalidatePostListCaches();
    return this.findById(id);
  }

  /**
   * Inside a delete's transaction: nothing may keep naming the association being deleted on the
   * dependency axis (WP-D1, reform 2.7). Its children lose their governing parent and the spaces it
   * governed lose their governor, and a G3 label naming it is cleared - each change journaled with
   * the admin who deleted it. The columns carry no foreign key, so without this a dangling id would
   * survive the row.
   */
  private async releaseDependents(
    manager: EntityManager,
    id: string,
    actorUserId: string
  ): Promise<void> {
    // node-postgres answers an UPDATE ... RETURNING through TypeORM as [rows, count].
    const [children] = (await manager.query(
      `UPDATE associations SET "parentAssociationId" = NULL WHERE "parentAssociationId" = $1 RETURNING id`,
      [id]
    )) as [{ id: string }[], number];
    for (const child of children) {
      await writeDependencyJournal(manager, 'entity', child.id, id, null, actorUserId, 'admin');
    }
    const [spaces] = (await manager.query(
      `UPDATE spaces SET "bdeAssociationId" = NULL WHERE "bdeAssociationId" = $1 RETURNING id`,
      [id]
    )) as [{ id: string }[], number];
    for (const space of spaces) {
      await writeDependencyJournal(manager, 'space', space.id, id, null, actorUserId, 'admin');
    }
    const [labelled] = (await manager.query(
      `UPDATE associations SET "displayParentAssociationId" = NULL WHERE "displayParentAssociationId" = $1 RETURNING id`,
      [id]
    )) as [{ id: string }[], number];
    for (const entity of labelled) {
      await writeDependencyJournal(manager, 'label', entity.id, id, null, actorUserId, 'admin');
    }
    if (children.length > 0 || spaces.length > 0 || labelled.length > 0) {
      this.logger.warn(
        `[DEPENDENCY] DELETE ${id}: ${children.length} child(ren) left without a parent, ${spaces.length} space(s) without a governor, ${labelled.length} label(s) cleared`
      );
    }
  }

  /**
   * A delete CHANGES dependencies when the association governs a space or has children, and only
   * the platform admin changes a dependency (owner A4): anybody else - a BDE's MANAGE_ASSO holder,
   * whom the route admits for an ordinary association - is refused with the typed 403
   * `DEPENDENCY_DELETE_ADMIN_ONLY`. Asked inside the delete's transaction, after the row lock.
   */
  private async assertMayReleaseDependents(
    manager: EntityManager,
    id: string,
    isGlobalAdmin: boolean
  ): Promise<void> {
    if (isGlobalAdmin) return;
    const [{ governs, children }] = (await manager.query(
      `SELECT (SELECT count(*) FROM spaces WHERE "bdeAssociationId" = $1)::int AS governs,
              (SELECT count(*) FROM associations WHERE "parentAssociationId" = $1)::int AS children`,
      [id]
    )) as { governs: number; children: number }[];
    if (governs > 0 || children > 0) {
      this.logger.warn(
        `[DEPENDENCY] DELETE ${id} refused to a non-admin: governs ${governs} space(s), ${children} child(ren)`
      );
      throw new ForbiddenException({
        code: DEPENDENCY_DELETE_ADMIN_ONLY,
        message:
          'Only the platform admin deletes an association that governs a space or has children',
      });
    }
  }

  /** Permanently deletes an association and all its member records, then invalidates post-list caches. */
  /**
   * Deletes an association, everything scoped to it, and says so.
   *
   * IT HAD NO LOG AT ALL, WHICH WAS SURVIVABLE ONLY WHILE ONE PERSON COULD REACH IT. Since
   * 2026-09-10 a BDE `MANAGE_ASSO` holder may call it too, so "who removed the association" has
   * more than one possible answer and nothing recorded it: the rows are gone, the caller is not in
   * any request log this service keeps, and no other table remembers the association existed.
   *
   * The counts are read BEFORE the deletes and logged after, because they are the only measure of
   * what the call actually destroyed - `delete()` returns an affected count, but a caller reading
   * "0 members" cannot tell an empty association from a failed cascade.
   *
   * @param actorUserId The caller, from `x-user-id`. Required: the point of the line is the name.
   * @param isGlobalAdmin The platform admin: the only caller who may delete an association that
   *   governs a space or has children (`assertMayReleaseDependents`).
   */
  async remove(id: string, actorUserId: string, isGlobalAdmin: boolean) {
    const [memberCount, eventCount, formCount] = await Promise.all([
      this.memberRepo.count({ where: { associationId: id } }),
      this.calendarRepo.count({ where: { associationId: id } }),
      this.formRepo.count({ where: { associationId: id } }),
    ]);
    this.logger.warn(
      `[ASSO] DELETE ${id} by ${actorUserId || 'unknown'} - removing ${memberCount} member(s), ${eventCount} event(s) and ${formCount} form(s); this is not reversible`
    );
    // ONE TRANSACTION, FORMS INCLUDED. A form is DELETED with its association, as an event is:
    // `forms.associationId` has no foreign key, so a surviving form kept a dangling id and the
    // client rendered it as a "Personnel" form - a paid form nobody could attribute or manage any
    // more (found on dev 2026-10-07). Archiving would keep exactly that orphan; the form's own
    // delete (`FormsService.delete`) is the precedent, and so is its rule: a form holding
    // submissions is ARCHIVED rather than deleted (`retireForms`, `submissions_form_fk`), because
    // they are the payers' records. An archived form is in no list, so it cannot be shown as
    // "Personnel"; the staff reach it by id.
    // Its booking spaces go with it (their foreign key cascades, D27); their posters are class
    // `association`, which no sweep takes, so they are released once nothing cites them.
    const posters: { id: string }[] = await this.assoRepo.manager.query(
      `SELECT poster->>'mediaId' AS id FROM booking_spaces WHERE "associationId" = $1 AND poster IS NOT NULL`,
      [id]
    );
    await this.assoRepo.manager.transaction(async (manager) => {
      // THE ASSOCIATION FIRST, before anything its delete reaches: the lock order every proposal
      // write follows (`ProposalsService.lockInOrder`: associations `FOR KEY SHARE`, then the
      // subject, then the proposal). The event delete below locks proposals through migration 074's
      // trigger; taking the association only at the end held those proposals while waiting on a
      // co-organisation decision's `KEY SHARE`, which waited on them (`40P01`). `FOR UPDATE`, not
      // `FOR NO KEY UPDATE`: only the former conflicts with `KEY SHARE`. The account erasure takes
      // its associations first too (`ERASURE_ASSOCIATION_LOCK_SQL`), so the two never cross.
      await manager.query(`SELECT 1 FROM associations WHERE id = $1 FOR UPDATE`, [id]);
      this.logger.debug(`[ASSO] DELETE ${id}: association locked`);
      await this.assertMayReleaseDependents(manager, id, isGlobalAdmin);
      // Its Lydia cashier rows go with it (ON DELETE CASCADE). A LIVE one is a cashier Lydia still
      // lists on that Business, which nothing in Canari tracks afterwards: said at ERROR, never the
      // phone.
      const liveCashiers: Array<{ vendorToken: string }> = await manager.query(
        `SELECT "vendorToken" FROM lydia_cashiers WHERE "associationId" = $1 AND "removedAt" IS NULL`,
        [id]
      );
      for (const cashier of liveCashiers) {
        this.logger.error(
          `[AUDIT] [LYDIA] association ${sanitizeLog(id)} deleted with a LIVE cashier row: ` +
            `Business ${sanitizeLog(cashier.vendorToken)} - Lydia still lists that cashier`
        );
      }
      await manager.delete(AssociationCalendarEvent, { associationId: id });
      await retireForms(manager, { associationId: id });
      await manager.delete(AssociationMember, { associationId: id });
      await this.releaseDependents(manager, id, actorUserId);
      // The readers' bells on it (migration 142): `targetId` carries no foreign key, since one
      // column names a person or an association, so nothing cascades them.
      await manager.query(
        `DELETE FROM account_bells WHERE "targetKind" = 'association' AND "targetId" = $1`,
        [id]
      );
      await manager.delete(Association, id);
    });
    // Released only where no surviving space cites them, the one release rule of every poster.
    await releaseUncitedPosters(
      this.httpService,
      this.assoRepo.manager,
      this.logger,
      posters.map((p) => p.id),
      `association ${id} was deleted`
    );
    await this.invalidatePostListCaches();
    return { ok: true };
  }

  /** Validates that the Authorization header is a Bearer token and returns it verbatim for forwarding. */
  private requireBearer(authorization: string | undefined): string {
    const h = authorization?.trim();
    if (!h?.startsWith('Bearer ')) {
      throw new BadRequestException('Missing Bearer token');
    }
    return h;
  }

  /** POSTs any image file to the media-service public upload endpoint and returns the assigned mediaId. */
  async uploadPublicImage(
    file: { buffer: Buffer; mimetype: string },
    authorization: string,
    size: 'logo' | 'content' = 'logo'
  ): Promise<string> {
    return this.uploadLogoToMedia(file, authorization, size);
  }

  /**
   * POSTs an image to the media-service public upload endpoint and returns the assigned mediaId.
   * `size` is the bound it is stored at: `logo` (256 px) or `content` (1600 px, a form question's
   * image) - media-service's `PUBLIC_IMAGE_BOUNDS`.
   */
  private async uploadLogoToMedia(
    file: { buffer: Buffer; mimetype: string },
    authorization: string,
    size: 'logo' | 'content' = 'logo'
  ): Promise<string> {
    const fd = new FormData();
    fd.append('file', file.buffer, {
      filename: 'logo',
      contentType: file.mimetype,
    });
    if (size !== 'logo') fd.append('size', size);
    const url = mediaUrl('media/upload/public');
    try {
      const { data } = await firstValueFrom(
        this.httpService.post<{ mediaId: string }>(url, fd, {
          headers: {
            ...fd.getHeaders(),
            Authorization: authorization,
          },
          maxBodyLength: LOGO_MAX_BYTES + 65_536,
          maxContentLength: LOGO_MAX_BYTES + 65_536,
        })
      );
      if (!data?.mediaId) {
        throw new BadRequestException('Media service returned no mediaId');
      }
      return data.mediaId;
    } catch (err) {
      const ax = err as AxiosError<{ message?: string }>;
      const detail =
        typeof ax.response?.data === 'object' && ax.response?.data?.message
          ? ax.response.data.message
          : typeof ax.response?.data === 'string'
            ? ax.response.data
            : ax.message;
      this.logger.warn(`Logo upload to media-service failed: ${detail}`);
      throw new BadRequestException(`Logo storage failed: ${detail}`);
    }
  }

  /**
   * Tries to delete a media object; silently ignores errors (the object may already be gone).
   * Sends `x-internal-secret` so media-service accepts the server-to-server deletion: that route
   * rejects direct client calls, trusting social-service to have already enforced association-admin
   * authz on the logo/event-image/form-banner/document being replaced.
   */
  async deleteMediaBestEffort(mediaId: string, authorization: string): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.delete(mediaUrl(`media/${mediaId}`), {
          headers: {
            Authorization: authorization,
            'x-internal-secret': process.env.INTERNAL_SECRET ?? '',
          },
        })
      );
    } catch (err) {
      // non-fatal - the object may already be gone. Logged through describeHttpError because the
      // raw error carries the x-internal-secret header this call authenticated with.
      this.logger.debug(
        `Media delete best-effort failed for ${mediaId}: ${describeHttpError(err)}`
      );
    }
  }

  /** Validates the uploaded file (size ≤ 2 MB, JPEG/PNG/WebP), uploads it to the media-service, then updates the chosen logo slot and deletes the previous object if one existed. */
  async setLogoFromUpload(
    associationId: string,
    file: { buffer: Buffer; mimetype: string; size: number },
    authorization: string | undefined,
    slot: LogoSlot = 'primary'
  ) {
    await this.findById(associationId);
    const bearer = this.requireBearer(authorization);
    if (file.size > LOGO_MAX_BYTES) {
      throw new BadRequestException(`Logo must be at most ${LOGO_MAX_BYTES} bytes`);
    }
    const mime = file.mimetype?.toLowerCase() ?? '';
    if (!ALLOWED_LOGO_MIMES.has(mime)) {
      throw new BadRequestException('Logo must be JPEG, PNG, or WebP');
    }

    const previous = await this.assoRepo.findOne({
      where: { id: associationId },
      select: { id: true, logoMediaId: true, logoMediaId2: true },
    });
    const oldMediaId = (slot === 'second' ? previous?.logoMediaId2 : previous?.logoMediaId) ?? null;

    const mediaId = await this.uploadLogoToMedia(file, bearer);

    if (slot === 'second') {
      await this.assoRepo.update(associationId, { logoMediaId2: mediaId });
    } else {
      await this.assoRepo.update(associationId, { logoMediaId: mediaId });
      const asso = await this.assoRepo.findOne({ where: { id: associationId } });
      if (!asso) throw new NotFoundException('Association not found');
      const v = asso.updatedAt instanceof Date ? asso.updatedAt.getTime() : Date.now();
      // The cache-buster belongs to the column that HAS one. The second slot is read from its media
      // id, which changes on every upload and is therefore its own buster.
      const logoUrl = `/api/media/public/${mediaId}?v=${v}`;
      await this.assoRepo.update(associationId, { logoUrl });
    }

    if (oldMediaId && oldMediaId !== mediaId) {
      await this.deleteMediaBestEffort(oldMediaId, bearer);
    }

    await this.invalidatePostListCaches();
    return this.findById(associationId);
  }

  /** Removes a stored logo: clears the DB columns for the chosen slot and attempts to delete the old media object. */
  async clearStoredLogo(
    associationId: string,
    authorization: string | undefined,
    slot: LogoSlot = 'primary'
  ): Promise<Association> {
    await this.findById(associationId);
    const row = await this.assoRepo.findOne({
      where: { id: associationId },
      select: { id: true, logoMediaId: true, logoMediaId2: true },
    });
    const oldMediaId = (slot === 'second' ? row?.logoMediaId2 : row?.logoMediaId) ?? null;

    await this.assoRepo.update(
      associationId,
      slot === 'second' ? { logoMediaId2: null } : { logoMediaId: null, logoUrl: null }
    );

    const bearer = authorization?.trim();
    if (oldMediaId && bearer?.startsWith('Bearer ')) {
      await this.deleteMediaBestEffort(oldMediaId, bearer);
    }

    await this.invalidatePostListCaches();
    return this.findById(associationId);
  }

  // ── Calendar event image ─────────────────────────────────────────────────

  /** Uploads an image file for a calendar event poster, stores it via media-service, and returns the updated event. */
  async setEventImageFromUpload(
    associationId: string,
    eventId: string,
    file: { buffer: Buffer; mimetype: string; size: number },
    authorization: string | undefined,
    tier: EventWriteTier
  ) {
    await this.findById(associationId);
    const bearer = this.requireBearer(authorization);
    if (file.size > LOGO_MAX_BYTES * 4) {
      throw new BadRequestException('Event image must be at most 8 MB');
    }
    const mime = file.mimetype?.toLowerCase() ?? '';
    if (!ALLOWED_LOGO_MIMES.has(mime)) {
      throw new BadRequestException('Image must be JPEG, PNG, or WebP');
    }

    // OWNER OR CO-OWNER, through the finder every other write on an event goes through: an
    // association co-running an event holds the same edit rights, so refusing it the poster alone
    // would be a right that exists everywhere but here.
    const ev = await this.findCalendarEventForAssociation(
      eventId,
      associationId,
      mayCrossAsso(tier)
    );
    if (!ev) throw new NotFoundException('Event not found');
    const oldMediaId = ev.imageMediaId;

    const mediaId = await this.uploadLogoToMedia(file, bearer);
    const imageUrl = `/api/media/public/${mediaId}`;
    await this.calendarRepo.update(eventId, { imageMediaId: mediaId, imageUrl });

    if (oldMediaId && oldMediaId !== mediaId) {
      await this.deleteMediaBestEffort(oldMediaId, bearer);
    }

    const updated = await this.calendarRepo.findOne({ where: { id: eventId } });
    return this.serializeCalendarEvent(updated);
  }

  /** Removes the poster image from a calendar event. */
  async clearEventImage(
    associationId: string,
    eventId: string,
    authorization: string | undefined,
    tier: EventWriteTier
  ) {
    const ev = await this.findCalendarEventForAssociation(
      eventId,
      associationId,
      mayCrossAsso(tier)
    );
    if (!ev) throw new NotFoundException('Event not found');
    const oldMediaId = ev.imageMediaId;
    await this.calendarRepo.update(eventId, { imageMediaId: null, imageUrl: null });

    const bearer = authorization?.trim();
    if (oldMediaId && bearer?.startsWith('Bearer ')) {
      await this.deleteMediaBestEffort(oldMediaId, bearer);
    }

    const updated = await this.calendarRepo.findOne({ where: { id: eventId } });
    return this.serializeCalendarEvent(updated);
  }

  // ── Members ───────────────────────────────────────────────────────────────

  /**
   * Refuses (403 `REVIEW_COHORT_BOUNDARY`) a review account reading the roster of an association it
   * is not a member of (review-cohort-reach.ts). A no-op for anybody else.
   */
  async assertReviewerMayReadRoster(userId: string, associationId: string): Promise<void> {
    await assertReviewerReachesAssociation(
      this.memberRepo.manager,
      userId,
      associationId,
      'member list'
    );
  }

  /**
   * Lists all members of an association.
   * Returns `isAdmin` (permissions > 0) for public callers; the raw `permissions`
   * bitmask is included for every member when `includePermissions` is true (caller has
   * MANAGE_MEMBERS), and always for the caller's own row so the client can gate UI correctly.
   */
  async listMembers(
    associationId: string,
    opts?: { includePermissions?: boolean; callerId?: string }
  ) {
    const rows = await this.memberRepo
      .createQueryBuilder('m')
      .select(['m.id', 'm.associationId', 'm.userId', 'm.role', 'm.permissions', 'm.createdAt'])
      .addSelect('u."displayName"', 'displayName')
      .addSelect('u."firstName"', 'firstName')
      .addSelect('u."lastName"', 'lastName')
      .leftJoin('users', 'u', 'u.id = m."userId"')
      .where('m."associationId" = :associationId', { associationId })
      .orderBy('m."sortOrder"', 'ASC')
      .addOrderBy('m."createdAt"', 'ASC')
      .getRawMany();

    return rows.map((r) => {
      const permissions = Number(r.m_permissions ?? 0);
      const base = {
        id: r.m_id,
        associationId: r.m_associationId,
        userId: r.m_userId,
        role: r.m_role,
        isAdmin: permissions > 0,
        createdAt: r.m_createdAt,
        displayName: r.displayName || null,
        // The name PARTS, alongside the joined-up one. A caller that has to order a roster the way
        // a directory is read - by surname - cannot get there from `displayName`: that column is a
        // free-form name the user chose, so splitting it is a guess about which token is the
        // family name. `listMembersPublic` has exposed the same two columns since it was written.
        firstName: r.firstName || null,
        lastName: r.lastName || null,
      };
      // Always expose the caller's own bitmask so the frontend can gate by specific flag.
      if (opts?.includePermissions || r.m_userId === opts?.callerId) {
        return { ...base, permissions };
      }
      return base;
    });
  }

  /**
   * Public members list for the read-only showcase (portail-etu vitrine).
   *
   * WHAT THE SHOWCASE DRAWS (owner, 2026-11-02): the name, the role, the promo, whether they sit
   * on the board, and the photo as a URL reached through the roster row (`avatarUrl`,
   * {@link publicMemberAvatarUrl}) rather than through the account. `id` is the roster row's own
   * random id, the showcase's list key. `userId` and `createdAt` are still served while the
   * showcase moves its photos onto `avatarUrl` (`PublicMember`). Never the raw permission bitmask.
   * Ordered like the public members grid (sortOrder, then createdAt). See
   * docs/wiki/anonymous-surface.md.
   */
  async listMembersPublic(associationId: string): Promise<PublicMember[]> {
    const rows = await this.memberRepo
      .createQueryBuilder('m')
      .select(['m.id', 'm.userId', 'm.role', 'm.permissions', 'm.createdAt'])
      .addSelect('u."displayName"', 'displayName')
      .addSelect('u."firstName"', 'firstName')
      .addSelect('u."lastName"', 'lastName')
      .addSelect('u.promo', 'promo')
      .leftJoin('users', 'u', 'u.id = m."userId"')
      .where('m."associationId" = :associationId', { associationId })
      .orderBy('m."sortOrder"', 'ASC')
      .addOrderBy('m."createdAt"', 'ASC')
      .getRawMany();

    // A review account has no public identity (review-cohort.ts): never on a public roster.
    return rows
      .filter((r) => !isInReviewCohort(r.m_userId))
      .map((r) => ({
        id: r.m_id,
        userId: r.m_userId,
        role: r.m_role,
        isAdmin: Number(r.m_permissions ?? 0) > 0,
        // The same precedence every other surface uses - this line built its own, preferring
        // `displayName`, so the vitrine could name a member differently from the app.
        displayName: formatUserDisplayNameFromRaw(r as Record<string, unknown>) || null,
        firstName: r.firstName || null,
        lastName: r.lastName || null,
        promo: r.promo ?? null,
        createdAt: r.m_createdAt,
        avatarUrl: publicMemberAvatarUrl(r.m_id),
      }));
  }

  /**
   * The account behind one row of a PUBLIC roster, for the showcase's photo
   * (`GET /api/public/members/:memberId/avatar`), or `null` when the id names no row or names a
   * review account (which has no public face, review-cohort.ts). A malformed id is a miss, never a
   * 500: the id comes from the URL.
   */
  async publicMemberUserId(memberId: string): Promise<string | null> {
    if (!isUUID(memberId)) return null;
    const row = await this.memberRepo.findOne({
      where: { id: memberId },
      select: { userId: true },
    });
    if (!row || isInReviewCohort(row.userId)) {
      this.logger.debug(`[PUBLIC_AVATAR] no public roster row ${memberId.slice(0, 8)}`);
      return null;
    }
    return row.userId;
  }

  /**
   * The photo URL of each card of the published carte, keyed `assoId:userId`, for the cards that
   * are still on that association's roster - the same address the public roster hands out, so the
   * showcase reaches a carte face and a roster face the same way. A card whose person left the
   * association gets none: they are no longer on a public roster.
   */
  async publicAvatarUrlsFor(
    pairs: { associationId: string; userId: string }[]
  ): Promise<Map<string, string>> {
    const wanted = pairs.filter((p) => isUUID(p.associationId) && p.userId);
    if (wanted.length === 0) return new Map();
    const rows = await this.memberRepo.find({
      where: wanted.map((p) => ({ associationId: p.associationId, userId: p.userId })),
      select: { id: true, associationId: true, userId: true },
    });
    return new Map(
      rows
        .filter((r) => !isInReviewCohort(r.userId))
        .map((r) => [`${r.associationId}:${r.userId}`, publicMemberAvatarUrl(r.id)])
    );
  }

  /**
   * Adds a user to an association with the given role and permission bitmask. Throws if they are
   * already a member; the rights a granter may hand out and the institution rule are judged in
   * `insertMembership`, the one writer.
   */
  async addMember(dto: AddMemberDto & { associationId: string }, granter: MemberGranter) {
    const { associationId, userId } = dto;
    const target = await this.findById(associationId);

    const existing = await this.memberRepo.findOne({ where: { associationId, userId } });
    if (existing) {
      throw new BadRequestException('User is already a member');
    }

    // Append new members at the END of the ordered list (not the top): take the current
    // max sortOrder + 1. `listMembers` orders by sortOrder ASC, so without this a new
    // member (default sortOrder 0) would jump ahead of already-reordered members.
    const maxRow = await this.memberRepo
      .createQueryBuilder('m')
      .select('MAX(m."sortOrder")', 'max')
      .where('m."associationId" = :associationId', { associationId })
      .getRawOne<{ max: number | null }>();
    const sortOrder = (maxRow?.max ?? -1) + 1;

    const saved = await this.insertMembership(
      this.memberRepo.manager,
      target,
      dto,
      sortOrder,
      granter,
      'addMember'
    );
    // A member sees the association's posts whatever their spaces (D21), so a membership is a fact
    // every cached feed page of that reader depends on.
    await this.invalidatePostListCaches();
    return saved;
  }

  /** Updates `sortOrder` for each member in the list, preserving the given array order. */
  async reorderMembers(associationId: string, userIds: string[]): Promise<void> {
    await this.findById(associationId);
    await Promise.all(
      userIds.map((userId, index) =>
        this.memberRepo.update({ associationId, userId }, { sortOrder: index })
      )
    );
    this.logger.debug(`reorderMembers: ${userIds.length} members reordered in ${associationId}`);
  }

  /**
   * Updates a member's role label and/or permission bitmask. Blocks removal of all flags from the
   * last admin, unless bypassLastAdmin is true (global admin or BDE). Refuses an institution's
   * member to anyone but the platform admin, and a bitmask that changes a flag `granter` does not
   * hold - granted OR revoked (`member-flag-ceiling.ts` says why both).
   */
  async updateMemberRole(
    associationId: string,
    targetUserId: string,
    role: string | undefined,
    permissions: number | undefined,
    opts: { granter: MemberGranter; bypassLastAdmin?: boolean }
  ) {
    const membership = await this.memberRepo.findOne({
      where: { associationId, userId: targetUserId },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    const kind = await this.kindOf(associationId);
    // Judged against the stored bitmask seen through the same kind filter, so a right the SERVER
    // strips from a kind that sells nothing is never counted as the granter's change.
    const before = kind
      ? writablePermissions(kind, membership.permissions)
      : membership.permissions;
    if (permissions !== undefined && kind) permissions = writablePermissions(kind, permissions);
    assertInstitutionMemberWrite(this.logger, kind, opts.granter, before, permissions ?? before, {
      associationId,
      what: 'updateMemberRole',
    });
    let flagWrite: { before: number; standing: GranterStanding } | null = null;
    if (permissions !== undefined) {
      flagWrite = {
        before,
        standing: await this.judgeMemberFlags(
          opts.granter,
          associationId,
          before,
          permissions,
          'updateMemberRole'
        ),
      };
    }
    // Guard: block demoting a member who holds MANAGE_MEMBERS if they are the last one.
    // We check specifically for MANAGE_MEMBERS loss, not just permissions===0, because a partial
    // demotion (e.g. keeping MANAGE_PAYOUT_ACCOUNT) would bypass the old permissions===0 check
    // while still leaving the association without any member manager.
    const hadManageMembers =
      (membership.permissions & AssociationPermissionFlag.MANAGE_MEMBERS) !== 0;
    const willLoseManageMembers =
      permissions !== undefined && (permissions & AssociationPermissionFlag.MANAGE_MEMBERS) === 0;
    // A member demoting ITSELF never takes the bypass, the same rule as a leaver in `removeMember`:
    // the bypass is a BDE or the platform admin acting on someone else's row, and the last holder
    // of a club it also validates as a BDE would otherwise strip its own right and leave nobody.
    const selfDemotion = opts.granter.userId === targetUserId;
    const guarded =
      hadManageMembers && willLoseManageMembers && (selfDemotion || !opts.bypassLastAdmin);
    // ONE column update of the row judged above, never a save of it: a member write must never
    // insert a row, and a save of a stale entity re-inserts a deleted one and reverts what a
    // concurrent writer changed. CONDITIONED on the permissions the guard above judged, so 0 rows
    // means the row is not the one judged - gone, or its permissions changed since.
    const changes: Partial<Pick<AssociationMember, 'role' | 'permissions'>> = {};
    if (role !== undefined) changes.role = role;
    if (permissions !== undefined) changes.permissions = permissions;
    if (Object.keys(changes).length === 0) return membership;
    // The last-manager guard and the write it protects are ONE step under the association's lock:
    // two managers demoting each other at once would otherwise both count two and leave none.
    const updated = await this.underMemberLock(
      associationId,
      'updateMemberRole',
      async (members) => {
        if (guarded) await this.assertNotLastManagerLost(members, associationId, 'demotion');
        return members.update({ id: membership.id, permissions: membership.permissions }, changes);
      }
    );
    if (updated.affected !== 1) {
      this.logger.warn(
        `updateMemberRole: membership changed or gone since its read association=${associationId} target=${targetUserId.slice(0, 8)} affected=${updated.affected ?? 'unknown'}`
      );
      throw new ConflictException({
        code: MEMBER_CHANGED_MEANWHILE,
        message: 'This member changed meanwhile, retry.',
      });
    }
    this.logger.debug(
      `updateMemberRole: association=${associationId} target=${targetUserId.slice(0, 8)} fields=${Object.keys(changes).join(',')}`
    );
    if (flagWrite && permissions !== undefined) {
      logSuperAdminExcludedGrant(this.logger, flagWrite.standing, flagWrite.before, permissions, {
        associationId,
        what: 'updateMemberRole',
      });
    }
    return { ...membership, ...changes };
  }

  /**
   * Removes a member from the association. Blocks removal of the last admin, unless bypassLastAdmin
   * is true (global admin or BDE), and an institution's member to anyone but the platform admin or
   * the member itself. HELD TO THE GRANT CEILING like a revocation: removing a member takes away
   * every flag it holds, and a remover that could part with a member above its own rights could
   * re-add them with 0 and strip what it may not revoke. So a target holding a flag beyond the
   * remover's ceiling needs a super-admin or the platform admin. Leaving (removing oneself, which
   * `leaveAssociation` is) is judged by neither the institution rule nor the ceiling, an
   * institution included; only the last-member-manager guard applies.
   */
  async removeMember(
    associationId: string,
    targetUserId: string,
    opts: { granter: MemberGranter; bypassLastAdmin?: boolean }
  ) {
    const membership = await this.memberRepo.findOne({
      where: { associationId, userId: targetUserId },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    // LEAVING (the "Quitter" button, `leaveAssociation`), an institution included: the institution
    // rule and the ceiling judge a write on SOMEONE ELSE; removing oneself writes no right onto
    // anyone. Only the last-member-manager guard below can refuse it.
    const leaving = opts.granter.userId === targetUserId;
    if (!leaving) {
      assertInstitutionMemberWrite(
        this.logger,
        await this.kindOf(associationId),
        opts.granter,
        membership.permissions,
        0,
        { associationId, what: 'removeMember' }
      );
      await this.judgeMemberFlags(
        opts.granter,
        associationId,
        membership.permissions,
        0,
        'removeMember'
      );
    }
    // Only protect removal when the member holds MANAGE_MEMBERS - the critical flag. A LEAVER never
    // bypasses it, whatever it is elsewhere: the bypass is a BDE or the platform admin acting on
    // SOMEONE ELSE's association, and the last manager walking out through `DELETE
    // :id/members/<own id>` would otherwise leave nobody, exactly what the "Quitter" route refuses.
    const holdsManageMembers =
      (membership.permissions & AssociationPermissionFlag.MANAGE_MEMBERS) !== 0;
    const guarded = holdsManageMembers && (leaving || !opts.bypassLastAdmin);

    // CONDITIONED on the permissions judged above, as `updateMemberRole` is: a row granted more
    // since its read is not the one the ceiling judged. The guard and the delete are ONE step under
    // the association's lock: two managers leaving at once would otherwise both count two.
    const deleted = await this.underMemberLock(associationId, 'removeMember', async (members) => {
      if (guarded) await this.assertNotLastManagerLost(members, associationId, 'removal');
      return members.delete({ id: membership.id, permissions: membership.permissions });
    });
    if (deleted.affected !== 1) {
      this.logger.warn(
        `removeMember: membership changed or gone since its read association=${associationId} affected=${deleted.affected ?? 'unknown'}`
      );
      throw new ConflictException({
        code: MEMBER_CHANGED_MEANWHILE,
        message: 'This member changed meanwhile, retry.',
      });
    }
    // The reverse of `addMember`'s sweep: the posts the membership opened (D21) must leave the feed.
    await this.invalidatePostListCaches();
    return { ok: true };
  }

  /**
   * THE "QUITTER" BUTTON (owner, 2026-11-03): every member may leave an association from its page
   * without asking anyone, except its last holder of `MANAGE_MEMBERS` (`LAST_MEMBER_MANAGER`). It
   * acts on the caller's OWN row only - the target is the vouched identity, never a parameter - so
   * it is `removeMember` with the caller as both remover and removed: no ceiling, no institution
   * rule, and no BDE bypass of the last-manager guard (a leaver speaks for itself, not as a BDE).
   */
  async leaveAssociation(associationId: string, userId: string) {
    this.logger.debug(`leaveAssociation: association=${associationId} user=${userId.slice(0, 8)}`);
    return this.removeMember(associationId, userId, {
      granter: { userId, isGlobalAdmin: false },
    });
  }

  /** The three facts a granter's ceiling is computed from (`grantCeiling`). */
  private async granterStanding(
    granter: MemberGranter,
    associationId: string
  ): Promise<GranterStanding> {
    if (granter.isGlobalAdmin) {
      return { isGlobalAdmin: true, isSuperAdminOf: false, ownPermissions: 0 };
    }
    const [own, isSuperAdminOf] = await Promise.all([
      this.memberRepo.findOne({ where: { associationId, userId: granter.userId } }),
      this.isAssociationSuperAdminOf(granter.userId, associationId),
    ]);
    return { isGlobalAdmin: false, isSuperAdminOf, ownPermissions: own?.permissions ?? 0 };
  }

  /**
   * Judges a member bitmask write from `before` to `after` against `granter`'s ceiling
   * (`grantCeiling`) and returns the standing it read, so the caller can write the audit line once
   * the write has landed. The platform admin asks nothing; anyone else is read from their own row
   * and the super-admin tier.
   */
  private async judgeMemberFlags(
    granter: MemberGranter,
    associationId: string,
    before: number,
    after: number,
    what: string
  ): Promise<GranterStanding> {
    const standing = await this.granterStanding(granter, associationId);
    const ceiling = grantCeiling(standing);
    this.logger.debug(
      `[MEMBER-CEILING] ${what} association=${associationId.slice(0, 8)} admin=${standing.isGlobalAdmin} superAdmin=${standing.isSuperAdminOf} ceiling=${ceiling}`
    );
    assertWithinGrantCeiling(this.logger, ceiling, before, after, { associationId, what });
    return standing;
  }

  /**
   * Counts members holding MANAGE_MEMBERS - the flag required to manage the association.
   * Used to prevent locking an association out of member management.
   * Using `permissions > 0` was insufficient: a member with only MANAGE_PAYOUT_ACCOUNT
   * counts as non-zero but cannot unblock the association.
   */
  private async manageMembersCount(
    members: Repository<AssociationMember>,
    associationId: string
  ): Promise<number> {
    return members
      .createQueryBuilder('m')
      .where('m.associationId = :associationId', { associationId })
      .andWhere('(m.permissions & :flag) <> 0', {
        flag: AssociationPermissionFlag.MANAGE_MEMBERS,
      })
      .getCount();
  }

  /**
   * Refuses a write that would leave the association with nobody holding MANAGE_MEMBERS - removing
   * or demoting its last holder, by someone else or by leaving. Typed (`LAST_MEMBER_MANAGER`) on
   * every path, so the "Quitter" button and the roster editor say why. Logged at INFO: it is an
   * ordinary answer to an ordinary user, not a defect. MUST run inside `underMemberLock`, on the
   * repository it hands out, or the count races the write it guards.
   */
  private async assertNotLastManagerLost(
    members: Repository<AssociationMember>,
    associationId: string,
    what: 'removal' | 'demotion'
  ): Promise<void> {
    const n = await this.manageMembersCount(members, associationId);
    if (n > 1) return;
    this.logger.log(
      `[MEMBER-CEILING] ${what} refused: association=${associationId} would lose its last member manager`
    );
    throw new BadRequestException({
      code: LAST_MEMBER_MANAGER,
      message: 'Impossible de retirer le dernier administrateur de cette association',
    });
  }

  /**
   * Runs one member write in a transaction that first takes the association `FOR UPDATE` - the
   * global lock order (`remove` takes it first too, see there) - so every guard that COUNTS the
   * roster and the write it protects are serialised per association. Without it, the last-manager
   * guard was a count and a delete apart: two managers leaving at once both saw two holders, and
   * the association was left with none.
   */
  private async underMemberLock<T>(
    associationId: string,
    what: string,
    write: (members: Repository<AssociationMember>) => Promise<T>
  ): Promise<T> {
    return this.memberRepo.manager.transaction(async (manager) => {
      await manager.query(`SELECT 1 FROM associations WHERE id = $1 FOR UPDATE`, [associationId]);
      this.logger.debug(`[MEMBER-LOCK] ${what}: association ${associationId} locked`);
      return write(manager.getRepository(AssociationMember));
    });
  }

  /** Returns all associations a user belongs to, with their role and permissions bitmask attached to each item. */
  async listByUser(userId: string) {
    const memberships = await this.memberRepo.find({ where: { userId } });
    if (memberships.length === 0) return [];

    const assoIds = memberships.map((m) => m.associationId);
    // Archived associations/lists are hidden from "Mes associations".
    const associations = await this.assoRepo
      .createQueryBuilder('a')
      .where('a.id IN (:...ids)', { ids: assoIds })
      .andWhere('a.archived = false')
      .getMany();

    return associations.map((a) => {
      const m = memberships.find((mem) => mem.associationId === a.id);
      return {
        ...a,
        role: m?.role,
        permissions: m?.permissions ?? 0,
        isAdmin: (m?.permissions ?? 0) > 0,
      };
    });
  }

  // ── Calendar events ───────────────────────────────────────────────────────

  /** Coerces TypeORM raw join columns to string without `[object Object]`. */
  private rawQueryString(value: unknown, fallback = ''): string {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    return fallback;
  }

  /**
   * `FOR KEY SHARE` on the associations an event write names, in id order - the FIRST statement of
   * every event write transaction (the global lock order). `eventOfOrganiser` adds the organiser of
   * an existing event, read from its row; a creation names its organiser in `associationIds`.
   */
  private async keyShareAssociations(
    manager: EntityManager,
    associationIds: readonly string[],
    eventOfOrganiser?: string
  ): Promise<void> {
    const named = associationIds.filter((id) => UUID_RE.test(id));
    await manager.query(
      `SELECT a.id FROM associations a
        WHERE a.id = ANY($1::uuid[])
           OR a.id = (SELECT e."associationId" FROM association_calendar_events e WHERE e.id = $2)
        ORDER BY a.id FOR KEY SHARE OF a`,
      [named, eventOfOrganiser ?? null]
    );
  }

  /**
   * Runs `work` in ONE transaction that starts by locking the event, so every read-check-write
   * an event goes through here (an edit with its partner list and its form link, a validation, a
   * rejection) is serialised: the second one starts from what the first committed, never from the
   * snapshot it took before waiting. Without it an edit and a validation both load the row, both
   * save, and the later save writes back the other's stale status columns. A co-organisation
   * ACCEPTANCE is serialised with it too: it is a proposals transaction, whose handler
   * (`CoorganisationService.lockSubject`) takes this same event lock in the same order.
   *
   * THE LOCK ORDER IS THE GLOBAL ONE - associations first, then the subject (`ProposalsService
   * .lockInOrder`; `AssociationsService.remove` takes its association `FOR UPDATE` before it
   * deletes the events): the event's organiser and every association the edit names as a partner
   * (`associationIds`), `FOR KEY SHARE` in id order, then the event row `FOR NO KEY UPDATE`.
   * The reverse (event first) let an edit hold the event while its proposal insert waited on an
   * association a delete held, the delete waiting on the event.
   *
   * `NO KEY UPDATE`, not `UPDATE`: it blocks every other writer of the row but not the
   * `KEY SHARE` an insert into a table referencing the event takes through its foreign key.
   *
   * `work` gets the transaction's repository AND manager: EVERYTHING it reads or writes goes
   * through them (never a second pool connection, which would starve the pool of ten under a few
   * concurrent edits and hide a lock cycle from Postgres, durable-rules).
   */
  async withEventLock<T>(
    eventId: string,
    work: (repo: Repository<AssociationCalendarEvent>, manager: EntityManager) => Promise<T>,
    associationIds: readonly string[] = []
  ): Promise<T> {
    return this.calendarRepo.manager.transaction(async (manager) => {
      await this.keyShareAssociations(manager, associationIds, eventId);
      await manager.query(
        'SELECT id FROM association_calendar_events WHERE id = $1 FOR NO KEY UPDATE',
        [eventId]
      );
      return work(manager.getRepository(AssociationCalendarEvent), manager);
    });
  }

  /**
   * Returns the event if the caller's association is the primary owner OR an ACCEPTED co-organiser
   * (D39: a co-owner row exists only once its `coorganise` proposal was accepted, so a pending one
   * reaches nothing here). Pass `canCrossAsso = true` for BDE / global-admin callers.
   */
  async findCalendarEventForAssociation(
    eventId: string,
    associationId: string,
    canCrossAsso: boolean,
    repo: Repository<AssociationCalendarEvent> = this.calendarRepo
  ): Promise<AssociationCalendarEvent | null> {
    if (canCrossAsso) {
      return repo.findOne({ where: { id: eventId } });
    }
    return repo
      .createQueryBuilder('e')
      .where('e.id = :eventId', { eventId })
      .andWhere(
        `(e.associationId = :associationId OR EXISTS (
          SELECT 1 FROM association_calendar_event_co_owners co
          WHERE co.event_id = e.id AND co.association_id = :associationId
        ))`,
        { associationId }
      )
      .getOne();
  }

  /** Batch-loads the ACCEPTED co-organisers for a list of event IDs (2 queries total). */
  private async batchLoadCoOwners(
    eventIds: string[]
  ): Promise<Map<string, AssociationCalendarEventCoOwner[]>> {
    const map = new Map<string, AssociationCalendarEventCoOwner[]>();
    if (eventIds.length === 0) return map;
    const all = await this.coOwnerRepo.find({ where: { eventId: In(eventIds) } });
    for (const co of all) {
      const list = map.get(co.eventId) ?? [];
      list.push(co);
      map.set(co.eventId, list);
    }
    return map;
  }

  private serializeCalendarEvent(
    e: AssociationCalendarEvent,
    coOwners: AssociationCalendarEventCoOwner[] = []
  ) {
    const startsAt = e.startsAt instanceof Date ? e.startsAt : new Date(e.startsAt);
    const endsRaw = e.endsAt;
    const endsAt =
      endsRaw === null || endsRaw === undefined
        ? null
        : endsRaw instanceof Date
          ? endsRaw
          : new Date(endsRaw);
    const createdAt = e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt);
    return {
      id: e.id,
      associationId: e.associationId,
      title: e.title,
      description: e.description,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt ? endsAt.toISOString() : null,
      createdBy: e.createdBy,
      createdAt: createdAt.toISOString(),
      kind: e.kind ?? AssociationCalendarEventKind.Event,
      presentation: e.presentation ?? AssociationCalendarEventPresentation.Association,
      linkedFormId: e.linkedFormId ?? null,
      status: e.status ?? AssociationCalendarEventStatus.Pending,
      validatedAt: e.validatedAt
        ? (e.validatedAt instanceof Date ? e.validatedAt : new Date(e.validatedAt)).toISOString()
        : null,
      validatedBy: e.validatedBy ?? null,
      rejectedAt: e.rejectedAt
        ? (e.rejectedAt instanceof Date ? e.rejectedAt : new Date(e.rejectedAt)).toISOString()
        : null,
      rejectedBy: e.rejectedBy ?? null,
      rejectionReason: e.rejectionReason ?? null,
      imageUrl: e.imageUrl ?? null,
      // An institution's reach (owner, 2026-11-13), served to every reader as posts serve theirs, so
      // the event says who it is for: `null` when the event carries none.
      reach: servedInstitutionReach(e),
      coOwners: coOwners.map((co) => ({
        associationId: co.associationId,
        name: co.association?.name ?? '',
        slug: co.association?.slug ?? '',
        color: co.association?.color ?? null,
        logoUrl: co.association?.logoUrl ?? null,
      })),
    };
  }

  /** Forms under this association (optional link from calendar event editor). */
  async getCalendarLinkCandidates(associationId: string) {
    await this.findById(associationId);
    // A draft is never offered: an event cannot link one (`assertFormBelongsToAssociation`).
    const forms = await this.formRepo.find({
      where: { associationId, status: FORM_PUBLISHED },
      order: { updatedAt: 'DESC' },
      take: 50,
      select: { id: true, title: true, updatedAt: true },
    });
    return {
      forms: forms.map((f) => ({
        id: f.id,
        title: f.title,
        updatedAt: f.updatedAt instanceof Date ? f.updatedAt.toISOString() : String(f.updatedAt),
      })),
    };
  }

  /**
   * Ensures a post may reference a validated agenda event (same association).
   * Returns the event id or null when omitted.
   *
   * With `manager` (the post write's transaction, `PostsService.saveWithEventLink`) the event row is
   * read `FOR SHARE`, which conflicts with the `FOR NO KEY UPDATE` a presentation switch holds
   * (`withEventLock`): the link and the switch are serialised, so the neutral check below and the
   * switch's linked-post check can never both pass.
   */
  async resolvePostCalendarEventLink(
    associationId: string | null | undefined,
    eventId: string | null | undefined,
    manager?: EntityManager
  ): Promise<string | null> {
    if (!eventId?.trim()) return null;
    if (!associationId?.trim()) {
      throw new BadRequestException('associationId is required to link an agenda event');
    }
    const repo = manager?.getRepository(AssociationCalendarEvent) ?? this.calendarRepo;
    const ev = await repo.findOne({
      where: {
        id: eventId.trim(),
        associationId: associationId.trim(),
        status: AssociationCalendarEventStatus.Validated,
      },
      ...(manager ? { lock: { mode: 'pessimistic_read' as const } } : {}),
    });
    if (!ev) {
      throw new BadRequestException(
        'Agenda event not found, not validated yet, or belongs to another association'
      );
    }
    // A post is published in its association's name, so linking a neutral event would name the
    // owner the presentation hides (event-presentation.ts). Typed, for the composer's sentence.
    if (isNeutralEvent(ev)) {
      this.logger.debug(`[AGENDA] post link refused: ${sanitizeLog(ev.id.slice(0, 8))} is neutral`);
      assertNeutralPresentationAllowed({
        presentation: AssociationCalendarEventPresentation.Neutral,
        ownerIsBde: true,
        partnerCount: 0,
        linkedFormId: null,
        linkedByPost: true,
      });
    }
    return ev.id;
  }

  /**
   * The event a post links to, shaped like `listCalendarEvents` rather than the bare serializer -
   * the caller (opening the calendar's own detail modal from a post) needs the same
   * `AssociationCalendarFeedEvent` shape that modal already renders, association identity
   * included, not the narrower object other callers of `serializeCalendarEvent` are content with.
   */
  async findCalendarEventByLinkedPost(postId: string, viewerId: string | undefined) {
    const post = await this.postRepo.findOne({
      where: { id: postId },
      select: { id: true, linkedCalendarEventId: true },
    });
    if (!post?.linkedCalendarEventId) return null;
    const ev = await this.findShownLinkedEvent(post.linkedCalendarEventId, viewerId);
    if (!ev) return null;
    const [coOwners, ownerById] = await Promise.all([
      this.batchLoadCoOwners([ev.id]),
      this.batchLoadEventOwners([ev.associationId]),
    ]);
    const owner = ownerById.get(ev.associationId);
    return {
      ...this.serializeCalendarEvent(ev, coOwners.get(ev.id) ?? []),
      associationName: owner?.name ?? '',
      associationSlug: owner?.slug ?? '',
      associationColor: owner?.color ?? null,
      associationLogoUrl: owner?.logoUrl ?? null,
    };
  }

  /**
   * THE EVENT A POST LINKS, AS ITS READER MAY BE SHOWN IT: validated, presented in its association's
   * name, and - for an event an institution gave a reach (owner, 2026-11-13) - admitted by the
   * event's own predicate for `viewerId` (`eventCardShownToViewerSql`): "an event announced by a
   * post keeps its own visibility". An event with no reach is shown wherever its post is, as before.
   */
  private async findShownLinkedEvent(
    eventId: string,
    viewerId: string | undefined
  ): Promise<AssociationCalendarEvent | null> {
    const ev = await this.calendarRepo
      .createQueryBuilder('e')
      .where('e.id = :eventId', { eventId })
      .andWhere('e.status = :validated', { validated: AssociationCalendarEventStatus.Validated })
      .andWhere('e.presentation = :presented', {
        presented: AssociationCalendarEventPresentation.Association,
      })
      .andWhere(eventCardShownToViewerSql('e', ':cardViewerId'), {
        cardViewerId: viewerId?.trim() || null,
      })
      .getOne();
    if (!ev) {
      this.logger.debug(
        `[AGENDA] linked event ${sanitizeLog(eventId.slice(0, 8))} not shown to ${viewerId ? sanitizeLog(viewerId.slice(0, 8)) : 'an anonymous reader'}`
      );
    }
    return ev;
  }

  /** Minimal event payload for post cards (validated events the reader may be shown only). */
  async findValidatedCalendarEventSummary(eventId: string, viewerId: string | undefined) {
    const ev = await this.findShownLinkedEvent(eventId, viewerId);
    if (!ev) return null;
    const asso = await this.assoRepo.findOne({
      where: { id: ev.associationId },
      select: { slug: true },
    });
    const base = this.serializeCalendarEvent(ev);
    return { ...base, associationSlug: asso?.slug ?? '' };
  }

  /**
   * The validated event a form links to, AS THE SIGNED-IN READER MAY SEE IT: the event is kept only
   * when `eventVisibleToViewerSql` admits it (its organiser or an accepted co-organiser reaches one
   * of the reader's spaces, or the reader is a member), exactly as the reader's agenda decides; a
   * global admin reads it whole. An event outside the reader's audience answers `null`, the same
   * answer as no link at all. The route is guarded, so a reader always has an id.
   */
  async findCalendarEventByLinkedForm(formId: string, viewer: CalendarViewer) {
    const qb = this.calendarRepo
      .createQueryBuilder('e')
      .where('e."linkedFormId" = :formId', { formId })
      .andWhere('e.status = :validated', { validated: AssociationCalendarEventStatus.Validated });
    if (!viewer.isGlobalAdmin) this.restrictToViewerSpaces(qb, viewer);
    const ev = await qb.getOne();
    if (!ev) {
      this.logger.debug(`[AGENDA] form ${formId.slice(0, 8)} links no event this reader sees`);
      return null;
    }
    return this.serializeCalendarEvent(ev);
  }

  private async assertFormBelongsToAssociation(
    formId: string,
    associationId: string,
    manager?: EntityManager
  ) {
    const f = await (manager ? manager.getRepository(Form) : this.formRepo).findOne({
      where: { id: formId },
      select: { id: true, associationId: true, status: true },
    });
    if (!f) throw new BadRequestException('Linked form not found');
    if (f.associationId !== associationId) {
      throw new BadRequestException('Form must belong to this association');
    }
    // An agenda entry is read by the association's audience: a DRAFT linked to it would hand them a
    // link to a form they cannot open. Published first, linked after (`form-status.ts`).
    if (f.status === FORM_DRAFT) {
      this.logger.debug(`[AGENDA] link refused: form ${formId.slice(0, 8)} is a draft`);
      throw new BadRequestException({
        code: FORM_IS_DRAFT,
        message: 'A draft form cannot be linked to an event: publish it first.',
      });
    }
  }

  /** Ensures at most one calendar row references a given form. */
  private async detachCalendarLinksExcept(
    opts: { formId?: string | null; exceptEventId: string },
    repo: Repository<AssociationCalendarEvent> = this.calendarRepo
  ) {
    const { formId, exceptEventId } = opts;
    if (formId) {
      await repo.update({ linkedFormId: formId, id: Not(exceptEventId) }, { linkedFormId: null });
    }
  }

  private async detachLinksBeforeCreate(
    formId?: string | null,
    repo: Repository<AssociationCalendarEvent> = this.calendarRepo
  ) {
    if (formId) {
      await repo.update({ linkedFormId: formId }, { linkedFormId: null });
    }
  }

  /**
   * Lists calendar events for an association, optionally bounded by `from` / `to` ISO timestamps.
   * Includes events the association only CO-OWNS, so every row carries its OWN owner identity
   * (name / slug / colour / logo) - the same four fields the aggregated feed returns.
   */
  async listCalendarEvents(
    associationId: string,
    fromIso?: string,
    toIso?: string,
    opts?: { includePending?: boolean; includeRejected?: boolean; viewer?: CalendarViewer }
  ) {
    await this.findById(associationId);
    if (this.isAnonymousAgendaRead(associationId, opts?.viewer)) return [];
    const promoCutoff = await promoCutoffFor(
      this.calendarRepo.manager,
      opts?.viewer?.userId,
      opts?.viewer?.isGlobalAdmin
    );
    const qb = this.calendarRepo
      .createQueryBuilder('e')
      .where(
        `(e.associationId = :associationId OR EXISTS (
          SELECT 1 FROM association_calendar_event_co_owners co
          WHERE co.event_id = e.id AND co.association_id = :associationId
        ))`,
        { associationId }
      )
      .orderBy('e.startsAt', 'ASC');
    // Validated events are always visible; pending ones (greyed on calendar) only for proposers;
    // rejected ones only in the editor management view.
    const statuses: AssociationCalendarEventStatus[] = [AssociationCalendarEventStatus.Validated];
    if (opts?.includePending) statuses.push(AssociationCalendarEventStatus.Pending);
    if (opts?.includeRejected) statuses.push(AssociationCalendarEventStatus.Rejected);
    qb.andWhere('e.status IN (:...statuses)', { statuses });
    if (promoCutoff) {
      qb.andWhere('e.startsAt >= :promoCutoff::timestamptz', { promoCutoff });
    }
    this.restrictToViewerSpaces(qb, opts?.viewer);
    if (fromIso?.trim()) {
      // Include multi-day events that started before `from` but end within or after the window.
      qb.andWhere('COALESCE(e.endsAt, e.startsAt) >= :from', { from: new Date(fromIso) });
    }
    if (toIso?.trim()) {
      qb.andWhere('e.startsAt <= :to', { to: new Date(toIso) });
    }
    const rows = await qb.getMany();
    const coOwnerMap = await this.batchLoadCoOwners(rows.map((r) => r.id));
    const ownerById = await this.batchLoadEventOwners(rows.map((r) => r.associationId));
    const serialized = rows.map((e) => {
      const owner = ownerById.get(e.associationId);
      return {
        ...this.serializeCalendarEvent(e, coOwnerMap.get(e.id) ?? []),
        associationName: owner?.name ?? '',
        associationSlug: owner?.slug ?? '',
        associationColor: owner?.color ?? null,
        associationLogoUrl: owner?.logoUrl ?? null,
      };
    });
    // THIS association's own agenda: a neutral event of it is not listed to a non-steward at all.
    return this.presentEventsToViewer(serialized, opts?.viewer, associationId);
  }

  /**
   * Which of `ownerIds` (the owners of the neutral rows on a page) `viewer` may read unmasked
   * (`event-presentation.ts`): exactly the callers who may WRITE such an event
   * (`assertMayWriteEvent`), so a steward never edits an event they cannot see. A platform admin
   * every owner; otherwise `PROPOSE_EVENT` through `mayActOnAny` (the member bitmask AND the BDE
   * `MANAGE_ASSO` super-admin, the same three tiers as `mayAct`) plus the BDE agenda right (who
   * validates them); an anonymous reader none. Batched: two queries whatever the page holds.
   */
  private async eventStewardshipFor(
    viewer: CalendarViewer | undefined,
    ownerIds: string[]
  ): Promise<EventStewardship> {
    if (viewer?.isGlobalAdmin) return EVERY_EVENT_STEWARDSHIP;
    const userId = viewer?.userId?.trim();
    if (!userId) return NO_EVENT_STEWARDSHIP;
    const [proposing, validating] = await Promise.all([
      this.mayActOnAny(userId, ownerIds, AssociationPermissionFlag.PROPOSE_EVENT),
      this.associationsUnderBdeAgendaRight(userId),
    ]);
    return eventStewardshipOf([...proposing, ...validating]);
  }

  /**
   * THE ONE EXIT OF EVERY AGENDA LISTING A READER RECEIVES: neutral events masked or dropped for a
   * non-steward (`presentEventsForReader`). The stewardship costs two queries, so it is asked only
   * when the page holds a neutral event - which most never do.
   */
  private async presentEventsToViewer<T extends PresentableEventRow>(
    rows: T[],
    viewer: CalendarViewer | undefined,
    listedFor: string | null
  ): Promise<T[]> {
    const neutral = rows.filter(isNeutralEvent).length;
    if (neutral === 0) return rows;
    const owners = rows.filter(isNeutralEvent).map((r) => r.associationId);
    const presented = presentEventsForReader(rows, await this.eventStewardshipFor(viewer, owners), {
      listedFor,
    });
    this.logger.debug(
      `[AGENDA] ${neutral} neutral event(s) presented to ${viewer?.userId ? sanitizeLog(viewer.userId.slice(0, 8)) : 'an anonymous reader'} (${rows.length - presented.length} withheld)`
    );
    return presented;
  }

  /**
   * Owner identity for a set of events, keyed by association id.
   *
   * THE CALLER'S ASSOCIATION IS NOT THE EVENT'S OWNER. `listCalendarEvents` returns events the
   * association CO-OWNS as well as its own, so the caller cannot stamp itself onto every row -
   * doing so named one association twice on the same event (owner slot + co-owner slot) and the
   * calendar grid, keyed on that identity, threw `each_key_duplicate` and took the whole page
   * down. The owner travels with the event, exactly as it does on the aggregated feed.
   */
  private async batchLoadEventOwners(
    associationIds: string[]
  ): Promise<Map<string, Pick<Association, 'id' | 'name' | 'slug' | 'color' | 'logoUrl'>>> {
    const unique = [...new Set(associationIds)];
    if (unique.length === 0) return new Map();
    const owners = await this.assoRepo.find({
      where: { id: In(unique) },
      select: { id: true, name: true, slug: true, color: true, logoUrl: true },
    });
    return new Map(owners.map((a) => [a.id, a]));
  }

  /**
   * A SIGNED-IN READER'S AGENDA IS THEIR SPACES' (WP6b, D39): an event is kept when its ORGANISER
   * or one of its ACCEPTED co-organisers is visible to the reader - its rules reach one of their
   * spaces, or the reader is a member (D21) - `eventVisibleToViewerSql`, the one predicate for an
   * event. An anonymous read (the public agenda and its `.ics`, D30) passes no viewer and is left
   * whole, exactly as the promo cutoff leaves it: like that cutoff, this is relevance and not
   * confidentiality. ONE association's agenda read anonymously answers nothing at all
   * (`isAnonymousAgendaRead`, 2026-11-02): that feed's selection is signed, this route is not.
   */
  private restrictToViewerSpaces(
    qb: SelectQueryBuilder<AssociationCalendarEvent>,
    viewer: CalendarViewer | undefined
  ): void {
    const viewerId = viewer?.userId?.trim();
    if (!viewerId) return;
    this.logger.debug(`[AGENDA] restricted to the spaces of ${viewerId.slice(0, 8)}`);
    qb.andWhere(eventVisibleToViewerSql('e', ':agendaViewerId'), {
      agendaViewerId: viewerId,
    });
  }

  /**
   * WITHOUT A SESSION, ONE ASSOCIATION'S AGENDA IS EMPTY (owner, 2026-11-02): only what the student
   * portal publishes is public, and it publishes no event - whatever the association's audience,
   * an institution addressing everyone included. The answer is an EMPTY list, never a 401: the
   * public association page draws "no event", as it does for every other gated block. A signed
   * agenda link (`/calendar/feed` with a signed selection) is the one anonymous way in.
   */
  private isAnonymousAgendaRead(
    associationId: string,
    viewer: CalendarViewer | undefined
  ): boolean {
    if (viewer?.userId?.trim() || viewer?.isGlobalAdmin) return false;
    this.logger.debug(`[AGENDA] anonymous read of ${associationId.slice(0, 8)}: answers nothing`);
    return true;
  }

  /**
   * THE ANONYMOUS AGENDA PER SELECTION (D40): keeps the events reached by a space matching the
   * selected campus and/or formation (`eventReachesSpaceMatchingSql`, organiser or accepted
   * co-organiser). No selection leaves the feed whole, as before. Relevance, not confidentiality.
   */
  private restrictToSelection(
    qb: SelectQueryBuilder<AssociationCalendarEvent>,
    selection: SpaceSelection | undefined
  ): void {
    const campus = selection?.campus ?? null;
    const formation = selection?.formation ?? null;
    if (campus === null && formation === null) return;
    this.logger.debug(`[AGENDA] narrowed to spaces ${formation ?? '*'} x ${campus ?? '*'}`);
    qb.andWhere(
      eventReachesSpaceMatchingSql('e', {
        campus: campus === null ? null : ':agendaCampus',
        formation: formation === null ? null : ':agendaFormation',
      }),
      { agendaCampus: campus, agendaFormation: formation }
    );
  }

  /**
   * AN ANONYMOUS READ NEVER CARRIES A "STUDENTS" OR "STAFF" EVENT (owner, 2026-11-13; the lead's
   * "same rules as posts", review of #3460): a post whose public is students or staff never reaches
   * an anonymous reader (the link preview refuses it), and neither does an event. An association-only
   * link and a campus/formation selection feed alike are signed over the SELECTION, not a reader, and
   * are shareable, so neither names a public: both withhold such an event, whatever space it ticks.
   * A signed-in reader is judged by their own predicate. The one-event link (`signedEvent`, signed
   * for that event and handed out by a reader who saw it) is left whole, deliberately: it shares one
   * event its holder could already read, as a forwarded invitation does.
   */
  private restrictAnonymousToPublicReach(
    qb: SelectQueryBuilder<AssociationCalendarEvent>,
    opts: { viewer?: CalendarViewer; signedEvent?: boolean } | undefined
  ): void {
    if (opts?.viewer?.userId?.trim() || opts?.viewer?.isGlobalAdmin || opts?.signedEvent) return;
    this.logger.debug('[AGENDA] anonymous read: events for students or staff withheld');
    qb.andWhere(`(e."reachPublic" IS NULL OR e."reachPublic" = 'all')`);
  }

  /** Max span for aggregated calendar queries (abuse guard). */
  private static readonly CALENDAR_FEED_MAX_MS = 550 * 24 * 60 * 60 * 1000;

  /**
   * Default window for the aggregated calendar feed when `from`/`to` are omitted: 3 months back
   * to the end of the 12th month ahead. A "subscribe by URL" feed (`.ics`) is saved once by the
   * calendar app and re-polled with the exact same URL forever - requiring the caller to always
   * supply a window defeats that, since nothing ever adds one after the first save. Mirrors the
   * range the frontend itself computes for the same purpose (`icsSubscriptionRangeISO`).
   */
  private static defaultCalendarFeedRange(): { from: Date; to: Date } {
    const now = new Date();
    return {
      from: new Date(now.getFullYear(), now.getMonth() - 3, 1, 0, 0, 0, 0),
      to: new Date(now.getFullYear(), now.getMonth() + 12, 0, 23, 59, 59, 999),
    };
  }

  /**
   * Returns true if the user has the PROPOSE_EVENT flag in at least one association.
   * Used to decide whether to show the pending-events queue link.
   */
  async canViewPendingCalendarEvents(userId: string): Promise<boolean> {
    const n = await this.memberRepo
      .createQueryBuilder('m')
      .where('m.userId = :userId', { userId })
      .andWhere('(m.permissions & :flag) <> 0', {
        flag: AssociationPermissionFlag.PROPOSE_EVENT,
      })
      .getCount();
    return n > 0;
  }

  /** The user ids holding `flag` in the association - who a notice addressed to it must reach. */
  async listFlagHolders(associationId: string, flag: AssociationPermissionFlag): Promise<string[]> {
    const rows = await this.memberRepo
      .createQueryBuilder('m')
      .select('m.userId', 'userId')
      .where('m.associationId = :associationId', { associationId })
      .andWhere('(m.permissions & :flag) <> 0', { flag })
      .getRawMany<{ userId: string }>();
    return rows.map((r) => r.userId);
  }

  /** Returns true if the user is an admin (any flag) of at least one association. */
  async isMemberOfAnyAssoc(userId: string): Promise<boolean> {
    const n = await this.memberRepo
      .createQueryBuilder('m')
      .where('m.userId = :userId', { userId })
      .andWhere('m.permissions > 0')
      .getCount();
    return n > 0;
  }

  /**
   * Returns true if the user holds VALIDATE_EVENTS in the BDE of AT LEAST ONE space.
   *
   * Not a right on any event (WP6c step 2): it answers "is a validator somewhere", which opens the
   * pending queue and the greyed pending events on the agenda. Validating, rejecting and writing a
   * given event ask `mayValidateEvent` / `mayValidateEventsOf`, scoped to the event association.
   */
  async isUserBdeAdmin(userId: string): Promise<boolean> {
    const n = await this.memberRepo
      .createQueryBuilder('m')
      .innerJoin(Association, 'a', 'a.id = m.associationId')
      .where('m.userId = :userId', { userId })
      .andWhere(isBdeAssociationSql('a'))
      .andWhere('(m.permissions & :flag) <> 0', {
        flag: AssociationPermissionFlag.VALIDATE_EVENTS,
      })
      .getCount();
    return n > 0;
  }

  /**
   * THE GOVERNANCE QUESTION (WP-D2): does `userId` hold `flag` in the BDE that governs association
   * `associationId` - its parent, or itself when it is a BDE? `holdsBdeFlagOverSql` is the one
   * definition; this asks it for one pair. An association with no parent (or whose parent governs
   * no space) is governed by no BDE, so this is false and only a global admin (whom the callers
   * check first) acts on it.
   */
  async holdsBdeFlagOver(
    userId: string,
    associationId: string,
    flag: AssociationPermissionFlag
  ): Promise<boolean> {
    if (!userId || !associationId) return false;
    const rows: { holds: boolean }[] = await this.memberRepo.query(HOLDS_BDE_FLAG_OVER_SQL, [
      userId,
      associationId,
      flag,
    ]);
    const holds = rows[0]?.holds === true;
    this.logger.debug(
      `[PERM] bde scope user=${sanitizeLog(userId.slice(0, 8))} flag=${flag} assoc=${sanitizeLog(associationId.slice(0, 8))} -> ${holds}`
    );
    return holds;
  }

  /**
   * The ids of every association whose BDE grants `userId` `flag` - what the client needs to draw
   * per-association controls (the calendar's edit buttons, an association's management entry)
   * without asking once per association. A global admin is not in it: the client knows that tier.
   */
  async associationsUnderBdeFlag(
    userId: string,
    flag: AssociationPermissionFlag
  ): Promise<string[]> {
    if (!userId) return [];
    const rows: { id: string }[] = await this.memberRepo.query(ASSOCIATIONS_UNDER_BDE_FLAG_SQL, [
      userId,
      flag,
    ]);
    return rows.map((r) => r.id);
  }

  /**
   * The ids of every association whose events `userId` holds the BDE agenda right over
   * (`holdsBdeAgendaRightOverSql`) - an institution's included, unlike `associationsUnderBdeFlag`.
   */
  async associationsUnderBdeAgendaRight(userId: string): Promise<string[]> {
    if (!userId) return [];
    const rows: { id: string }[] = await this.memberRepo.query(
      ASSOCIATIONS_UNDER_BDE_AGENDA_RIGHT_SQL,
      [userId]
    );
    return rows.map((r) => r.id);
  }

  /**
   * May `userId` validate (and, through it, write, reject, deposit on, declare a break for) the
   * events of association `associationId`? A global admin always; otherwise VALIDATE_EVENTS in the
   * BDE of a space those events target (user, 2026-10-04, D23) - THE AGENDA RULE, which reaches an
   * institution's events although no BDE manages the institution (owner, 2026-11-03).
   */
  async mayValidateEventsOf(
    userId: string,
    associationId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    if (opts?.isGlobalAdmin) return true;
    if (!userId || !associationId) return false;
    const rows: { holds: boolean }[] = await this.memberRepo.query(
      HOLDS_BDE_AGENDA_RIGHT_OVER_SQL,
      [userId, associationId]
    );
    const holds = rows[0]?.holds === true;
    this.logger.debug(
      `[PERM] bde agenda scope assoc=${sanitizeLog(associationId.slice(0, 8))} -> ${holds}`
    );
    return holds;
  }

  /**
   * `mayValidateEventsOf` for the association that OWNS event `eventId` - read from the row, never
   * from the URL, which names whatever association the client routed through. A missing event is
   * false: the route that loads it answers 404 itself.
   */
  async mayValidateEvent(
    userId: string,
    eventId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    if (opts?.isGlobalAdmin) return true;
    const ev = await this.calendarRepo.findOne({
      where: { id: eventId },
      select: { id: true, associationId: true },
    });
    if (!ev) {
      this.logger.debug(`[PERM] mayValidateEvent: event ${sanitizeLog(eventId)} not found`);
      return false;
    }
    return this.mayValidateEventsOf(userId, ev.associationId);
  }

  /**
   * THE ONE RULE FOR EVERY WRITE ON AN EXISTING EVENT, routed through association `associationId`:
   * a global admin, VALIDATE_EVENTS in the BDE governing the EVENT's association (read from the row),
   * or PROPOSE_EVENT in `associationId` through `mayAct`. Which events that last tier reaches is
   * `findCalendarEventForAssociation`'s: the organiser's, or an ACCEPTED co-organiser's (D39).
   * Returns the tier, which the cross-association paths need, and the SIDE the caller writes from
   * (`eventWriteSide`, E2): a partner's text and poster are open, its date, partner list and delete
   * are not. A platform admin and a governing validator write from the organiser side, unchanged.
   */
  async assertMayWriteEvent(
    userId: string,
    isGlobalAdmin: boolean,
    associationId: string,
    eventId: string
  ): Promise<{ isGlobalAdmin: boolean; isBde: boolean; side: EventWriteSide }> {
    const isBde = isGlobalAdmin ? false : await this.mayValidateEvent(userId, eventId);
    if (!isGlobalAdmin && !isBde) {
      // Through `mayAct`, so a cross-association super-admin may act on an event in an association
      // they administer - the guard on `POST :id/events` already lets them CREATE one there.
      const hasPerm = await this.mayAct(
        userId,
        associationId,
        AssociationPermissionFlag.PROPOSE_EVENT,
        { isGlobalAdmin }
      );
      if (!hasPerm) {
        this.logger.debug(
          `[PERM] event write refused: ${sanitizeLog(userId.slice(0, 8))} via ${sanitizeLog(associationId.slice(0, 8))}`
        );
        throw new ForbiddenException('PROPOSE_EVENT flag or BDE admin required');
      }
    }
    const side = await this.writeSideOf(eventId, associationId, isGlobalAdmin || isBde);
    this.logger.debug(
      `[PERM] event write allowed: ${sanitizeLog(userId.slice(0, 8))} on ${sanitizeLog(eventId.slice(0, 8))} from the ${side} side`
    );
    return { isGlobalAdmin, isBde, side };
  }

  /**
   * The side of event `eventId` a write through `viaAssociationId` comes from, the organiser read
   * from the ROW. A missing event is the organiser side: the route that loads it answers 404 itself,
   * and a refusal here would hide that.
   */
  private async writeSideOf(
    eventId: string,
    viaAssociationId: string,
    crossTier: boolean
  ): Promise<EventWriteSide> {
    if (crossTier) return 'organiser';
    const ev = await this.calendarRepo.findOne({
      where: { id: eventId },
      select: { id: true, associationId: true },
    });
    return ev ? eventWriteSide(ev.associationId, viaAssociationId, false) : 'organiser';
  }

  /**
   * Returns true if userId holds `flag` in association `associationId`.
   *
   * The MEMBERSHIP tier only. Callers deciding whether someone may act want `mayAct`, which adds
   * the platform administrator and the cross-association super-admin above it.
   */
  async callerHasFlag(
    userId: string,
    associationId: string,
    flag: AssociationPermissionFlag
  ): Promise<boolean> {
    const m = await this.memberRepo.findOne({ where: { associationId, userId } });
    if (!m) return false;
    return (m.permissions & flag) !== 0;
  }

  /**
   * Resolves association ids to their display names, in one query.
   *
   * For labelling rows that carry an association id - a form list, say - where the name is the only
   * part a screen may show. Ids absent from the result simply have no name: the association was
   * deleted, and the caller renders the row without a label rather than failing.
   */
  async namesByIds(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await this.assoRepo
      .createQueryBuilder('a')
      .select(['a.id', 'a.name'])
      .where('a.id IN (:...ids)', { ids: unique })
      .getMany();
    return new Map(rows.map((a) => [a.id, a.name]));
  }

  /**
   * The associations where `userId` holds `flag`, as `{ id, name }`.
   *
   * Reuses `listByUser`, so it inherits its exclusion of archived associations - a form of an
   * archived association must not surface in a "what can I manage" list.
   */
  async associationsWhereUserHasFlag(
    userId: string,
    flag: AssociationPermissionFlag
  ): Promise<{ id: string; name: string }[]> {
    const mine = await this.listByUser(userId);
    return mine
      .filter((a) => (a.permissions & flag) !== 0)
      .map((a) => ({ id: a.id, name: a.name }));
  }

  /**
   * MAY `userId` EDIT A PRICE SOMEWHERE - the one predicate the payout estimate's fee schedule is
   * answered on (core-service `LydiaFeeScheduleController`, docs/wiki/lydia-contract-flux.md; owner,
   * 2026-11-14: the fees are a confidential contract term, shown to those who need them). Built from
   * the rights that guard the price editors, never a new axis:
   * - a global admin (every editor, the Cercle top-up page included);
   * - a BDE super-admin (`isAssociationSuperAdmin`): `mayAct` grants them MANAGE_PRODUCTS and
   *   MANAGE_FORMS on the associations they govern;
   * - a member holding MANAGE_PRODUCTS (the shop, the cotisation tiers) or MANAGE_FORMS (paid forms)
   *   in an association or a list - not an institution, which collects nothing (TYPE_EXCLUDED_FLAGS).
   * A form's creator is not one by being its creator: an association's form is edited by MANAGE_FORMS
   * alone (`FormsService.managesForm`, owner 2026-11-14), and a personal form is offered no price
   * (the editor asks for an association first, `FormPaymentSection`).
   */
  async mayEditAPrice(userId: string, isGlobalAdmin: boolean): Promise<boolean> {
    if (isGlobalAdmin) return true;
    if (!userId) return false;
    const priceFlags =
      AssociationPermissionFlag.MANAGE_PRODUCTS | AssociationPermissionFlag.MANAGE_FORMS;
    const mine = await this.listByUser(userId);
    if (mine.some((a) => a.type !== 'institution' && (a.permissions & priceFlags) !== 0)) {
      return true;
    }
    const may = await this.isAssociationSuperAdmin(userId);
    this.logger.debug(`[PERM] may edit a price user=${userId.slice(0, 8)}: ${may}`);
    return may;
  }

  /** Returns true if userId is a member of the given association (any role). */
  async isMember(userId: string, associationId: string): Promise<boolean> {
    const m = await this.memberRepo.findOne({ where: { associationId, userId } });
    return m !== null;
  }

  /**
   * Returns true if userId holds `flag` in ANY BDE association. For `MANAGE_ASSO` - management - an
   * institution governing a space does not count: it answers for that space's agenda and people,
   * and manages nothing (reform 2.3, `governorIsAnAssociationSql`).
   */
  async callerHasAnyBdeFlag(userId: string, flag: AssociationPermissionFlag): Promise<boolean> {
    const qb = this.memberRepo
      .createQueryBuilder('m')
      .innerJoin(Association, 'a', 'a.id = m.associationId')
      .where('m.userId = :userId', { userId })
      .andWhere(isBdeAssociationSql('a'))
      .andWhere('(m.permissions & :flag) <> 0', { flag });
    if (flag === AssociationPermissionFlag.MANAGE_ASSO) qb.andWhere(`a.type = 'association'`);
    return (await qb.getCount()) > 0;
  }

  /**
   * Returns true if userId holds `MANAGE_ASSO` in the BDE of AT LEAST ONE space.
   *
   * ONLY FOR THE ROUTES THAT NAME NO ASSOCIATION (creating one, the categories, the carte, the
   * document-reviewer grants): there is no association to scope them to. Administering a GIVEN
   * association asks `isAssociationSuperAdminOf`, scoped to that association's parent (WP-D2).
   */
  async isAssociationSuperAdmin(userId: string): Promise<boolean> {
    return this.callerHasAnyBdeFlag(userId, AssociationPermissionFlag.MANAGE_ASSO);
  }

  /**
   * Is `userId` a super-admin OF association `associationId`: `MANAGE_ASSO` in its PARENT BDE (or
   * in itself when it is a BDE) - `holdsBdeFlagOverSql`, WP-D2? Such a user administers it (members,
   * documents, forms, products, and deletion - E3) as if a full local admin, minus
   * `SUPER_ADMIN_EXCLUDED_FLAGS`. Another BDE does not, whatever spaces the audience reaches; nobody
   * but the platform admin governs an entity with no parent, or an institution.
   */
  async isAssociationSuperAdminOf(userId: string, associationId: string): Promise<boolean> {
    return this.holdsBdeFlagOver(userId, associationId, AssociationPermissionFlag.MANAGE_ASSO);
  }

  /**
   * Does `userId` moderate SOMEWHERE - a platform administrator, or a member holding `MODERATE` in
   * the BDE of at least one space?
   *
   * THE DOOR, NOT THE REACH (owner, 2026-11-02): since `MODERATE` is scoped (`spaces/bde-moderation.ts`)
   * this answers only who may open the moderation surfaces at all - the queue, the lists - and
   * classifies a refusal (out of scope vs not a moderator). Acting on ONE target asks the scoped
   * predicate of its kind: `mayModeratePost`, `mayModerateComment`, `mayModerateLive`,
   * `mayModerateReport`, `mayModerateUser` - each a composition of the ONE predicate of
   * `spaces/bde-moderation.ts`.
   */
  async isContentModerator(userId: string, opts?: { isGlobalAdmin?: boolean }): Promise<boolean> {
    if (opts?.isGlobalAdmin) return true;
    if (!userId) return false;
    return this.callerHasAnyBdeFlag(userId, AssociationPermissionFlag.MODERATE);
  }

  /**
   * Of `postIds`, those `userId` may moderate (hide, delete, pin, unmask, read the anonymous author):
   * every one for a platform admin; for a BDE `MODERATE` holder, those in the spaces it governs
   * (`BDE_MODERATED_POST_IDS_SQL`, owner 2026-11-02). ONE query for a page. Never EDIT: rewriting
   * another person's words is no moderator's power (`PostsService.assertMayManage`).
   */
  async moderatedPostIds(
    userId: string | undefined,
    postIds: string[],
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<Set<string>> {
    // Postgres answers a uuid in lowercase, so the asked ids are lowercased once: an id spelled in
    // uppercase by a client is the same post, and must not miss its own `.has()`.
    const unique = [...new Set(postIds.map((id) => id.toLowerCase()))];
    if (opts?.isGlobalAdmin) return new Set(unique);
    if (!userId || unique.length === 0) return new Set();
    const rows: { id: string }[] = await this.memberRepo.query(BDE_MODERATED_POST_IDS_SQL, [
      userId,
      unique,
    ]);
    this.logger.debug(
      `[MODERATION] scope user=${sanitizeLog(userId.slice(0, 8))} posts=${unique.length} moderated=${rows.length}`
    );
    return new Set(rows.map((r) => r.id));
  }

  /** `moderatedPostIds` asked of one post, whatever the case its id is spelled in. */
  async mayModeratePost(
    userId: string | undefined,
    postId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    const id = postId.toLowerCase();
    return (await this.moderatedPostIds(userId, [id], opts)).has(id);
  }

  /**
   * May `userId` moderate live `liveId` (cut it, hide a line of its chat)? A platform admin always;
   * a BDE `MODERATE` holder when the live is in its governed spaces - read from the live, or from its
   * cut once the row is purged (`BDE_MODERATES_LIVE_SQL`).
   */
  async mayModerateLive(
    userId: string | undefined,
    liveId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    if (opts?.isGlobalAdmin) return true;
    if (!userId) return false;
    const rows: { moderates: boolean }[] = await this.memberRepo.query(BDE_MODERATES_LIVE_SQL, [
      userId,
      liveId,
    ]);
    const moderates = rows[0]?.moderates === true;
    this.logger.debug(
      `[MODERATION] scope user=${sanitizeLog(userId.slice(0, 8))} live=${sanitizeLog(liveId.slice(0, 8))} -> ${moderates}`
    );
    return moderates;
  }

  /**
   * May `userId` act on report `reportId` (review it)? A platform admin always; a BDE `MODERATE`
   * holder when the report is about something in its governed spaces (`reportInBdeScopeSql`).
   */
  async mayModerateReport(
    userId: string | undefined,
    reportId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    if (opts?.isGlobalAdmin) return true;
    if (!userId) return false;
    const rows: { moderates: boolean }[] = await this.memberRepo.query(BDE_MODERATES_REPORT_SQL, [
      userId,
      reportId,
    ]);
    return rows[0]?.moderates === true;
  }

  /**
   * Of `userIds`, the people `userId` may moderate as people (mute, withdraw a broadcast right): all
   * for a platform admin; for a BDE `MODERATE` holder, those belonging to one of its spaces.
   */
  async moderatedUserIds(
    userId: string | undefined,
    userIds: string[],
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<Set<string>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (opts?.isGlobalAdmin) return new Set(unique);
    if (!userId || unique.length === 0) return new Set();
    const rows: { id: string }[] = await this.memberRepo.query(BDE_MODERATED_USER_IDS_SQL, [
      userId,
      unique,
    ]);
    return new Set(rows.map((r) => r.id));
  }

  /** `moderatedUserIds` asked of one person. */
  async mayModerateUser(
    userId: string | undefined,
    targetUserId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    return (await this.moderatedUserIds(userId, [targetUserId], opts)).has(targetUserId);
  }

  /**
   * May `userId` moderate (delete) comment `commentId` under post `postId`? A platform admin always; a
   * BDE `MODERATE` holder when the post is in its scope AND the comment itself is published by a
   * person or an association it moderates (`bdeModeratesCommentSql`) - never a comment in an
   * institution's or another BDE's name (owner, 2026-11-03). Its replies are not asked: each is judged
   * on its own when the delete meets it, and one the holder does not moderate stays under a
   * moderation tombstone (`posts/comment-removal.ts`, lead 2026-11-04).
   */
  async mayModerateComment(
    userId: string | undefined,
    postId: string,
    commentId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    if (opts?.isGlobalAdmin) return true;
    if (!userId) return false;
    const rows: { moderates: boolean }[] = await this.memberRepo.query(BDE_MODERATES_COMMENT_SQL, [
      userId,
      postId,
      commentId,
    ]);
    const moderates = rows[0]?.moderates === true;
    this.logger.debug(
      `[MODERATION] scope user=${sanitizeLog(userId.slice(0, 8))} comment=${sanitizeLog(commentId.slice(0, 12))} -> ${moderates}`
    );
    return moderates;
  }

  /**
   * Of `associationIds`, those whose PUBLISHED content `userId` moderates (`bdeModeratesPublisherSql`):
   * every one for a platform admin; for a BDE `MODERATE` holder, the associations its governed spaces
   * reach - never an institution, never another BDE. What `commentRights` reads for a comment in an
   * association's name; empty for an unknown caller.
   */
  async moderatedAssociationIds(
    userId: string | undefined,
    associationIds: string[],
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<Set<string>> {
    const unique = [...new Set(associationIds.filter(Boolean).map((id) => id.toLowerCase()))];
    if (opts?.isGlobalAdmin) return new Set(unique);
    if (!userId || unique.length === 0) return new Set();
    const rows: { id: string }[] = await this.memberRepo.query(BDE_MODERATED_ASSOCIATION_IDS_SQL, [
      userId,
      unique,
    ]);
    this.logger.debug(
      `[MODERATION] publishers user=${sanitizeLog(userId.slice(0, 8))} asked=${unique.length} moderated=${rows.length}`
    );
    return new Set(rows.map((r) => r.id));
  }

  /**
   * THE TYPED REFUSAL of a moderation act, classified at the throw: 403 `MODERATOR_REQUIRED` when the
   * caller moderates nowhere; 403 `MODERATION_RESERVED_TO_PLATFORM_ADMIN` when the target is published
   * in an institution's or a BDE's name (owner, 2026-11-03: only the platform admin moderates those);
   * 403 `MODERATION_OUT_OF_SCOPE` otherwise - outside the spaces the caller's BDE governs. Logged with
   * the target's kind, never its content.
   */
  async refuseModeration(userId: string | undefined, target: ModerationTarget): Promise<never> {
    const somewhere = !!userId && (await this.isContentModerator(userId));
    const reserved = somewhere && (await this.isReservedToPlatformAdmin(target));
    const code = !somewhere
      ? MODERATOR_REQUIRED
      : reserved
        ? MODERATION_RESERVED_TO_PLATFORM_ADMIN
        : MODERATION_OUT_OF_SCOPE;
    this.logger.log(
      `[MODERATION] refused user=${sanitizeLog((userId ?? '').slice(0, 8))} target=${target.kind}:${sanitizeLog(target.id)} code=${code}`
    );
    throw new ForbiddenException({
      code,
      message: !somewhere
        ? 'BDE MODERATE permission or global admin required'
        : reserved
          ? "Content in an institution's or a BDE's name is moderated by the platform admin only"
          : 'Outside the spaces your BDE governs',
    });
  }

  /** Is `target` published in an institution's or a BDE's name (`MODERATION_RESERVED_SQL`)? */
  private async isReservedToPlatformAdmin(target: ModerationTarget): Promise<boolean> {
    if (target.kind === 'user' || target.kind === 'broadcaster') return false;
    const rows: { reserved: boolean }[] = await this.memberRepo.query(MODERATION_RESERVED_SQL, [
      target.kind,
      target.id,
      target.postId ?? null,
    ]);
    return rows[0]?.reserved === true;
  }

  /**
   * THE question every association-scoped check asks: may `userId` exercise `flag` on
   * `associationId`?
   *
   * Three tiers, widest first: the platform administrator, who holds every association right
   * whether or not they are a member; the super-admin OF THIS association (`MANAGE_ASSO` in its
   * parent BDE - `isAssociationSuperAdminOf`, WP-D2), minus `SUPER_ADMIN_EXCLUDED_FLAGS`; then
   * the association's own member bitmask.
   *
   * It exists because the same question had four different answers in this codebase - the guard
   * granted the super-admin everything, two inline checks forgot them entirely, and the calendar
   * pair escalated through `VALIDATE_EVENTS` instead. A right spelled out per call site drifts per
   * call site: a BDE super-admin was refused the member bitmask by one endpoint while the endpoint
   * below it accepted their write. Every new check calls this and adds no second axis of its own.
   *
   * It answers RIGHTS, not existence: a caller acting on an association that does not exist is a
   * 404 from whoever loads it, not a 403 from here. `canPostAs` is the exception and says why.
   *
   * ABOVE the three tiers sits the entity's KIND: a flag in `TYPE_EXCLUDED_FLAGS` for that kind
   * (a list's payout account, an institution's shop and payout account) is held by NOBODY, the
   * platform administrator included - so every route that flag guards refuses with no check of its
   * own. The kind is read only for a flag some kind excludes.
   *
   * `withoutGoverningBde` drops the middle tier for the ONE act that must be the entity's own
   * people's or the platform administrator's: accepting a payment delegation on its behalf (owner,
   * 2026-11-02) - a BDE governing the receiver does not commit its Lydia account for it.
   */
  async mayAct(
    userId: string,
    associationId: string,
    flag: AssociationPermissionFlag,
    opts?: { isGlobalAdmin?: boolean; withoutGoverningBde?: boolean }
  ): Promise<boolean> {
    if ((flag & ANY_TYPE_EXCLUDED_FLAGS) !== 0) {
      const kind = await this.kindOf(associationId);
      if (kind && (typeExcludedFlags(kind) & flag) !== 0) {
        this.logger.debug(
          `[PERM] flag=${flag} held by nobody on a ${kind} (assoc=${associationId.slice(0, 8)})`
        );
        return false;
      }
    }
    if (opts?.isGlobalAdmin) return true;
    if (
      !opts?.withoutGoverningBde &&
      (flag & SUPER_ADMIN_EXCLUDED_FLAGS) === 0 &&
      (await this.isAssociationSuperAdminOf(userId, associationId))
    ) {
      this.logger.debug(
        `[PERM] super-admin granted user=${userId.slice(0, 8)} flag=${flag} assoc=${associationId.slice(0, 8)}`
      );
      return true;
    }
    return this.callerHasFlag(userId, associationId, flag);
  }

  /**
   * `mayAct` answered for MANY associations at once: the subset of `associationIds` where `userId`
   * may exercise `flag`.
   *
   * A feed page carries posts from a dozen associations and has to decide each row, so asking
   * `mayAct` per row is a dozen round trips per render. It is deliberately assembled from the same
   * three tiers rather than from a membership query alone - the exclusion set is exactly what makes
   * `POST_AS_ASSO` behave differently here from `MANAGE_MEMBERS`, and a caller re-deriving that by
   * hand is the drift `mayAct` was written to end.
   *
   * An unknown caller holds nothing: an anonymous reader gets the empty set rather than a crash.
   */
  async mayActOnAny(
    userId: string | undefined,
    associationIds: string[],
    flag: AssociationPermissionFlag,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<Set<string>> {
    let unique = [...new Set(associationIds.filter(Boolean))];
    if (unique.length === 0) return new Set();
    if ((flag & ANY_TYPE_EXCLUDED_FLAGS) !== 0) {
      // The kind's exclusion, as in `mayAct`: nobody holds the flag on a kind that excludes it.
      const kinds = await this.assoRepo.find({
        where: { id: In(unique) },
        select: { id: true, type: true },
      });
      const excluded = new Set(
        kinds.filter((k) => (typeExcludedFlags(k.type) & flag) !== 0).map((k) => k.id)
      );
      if (excluded.size > 0) {
        this.logger.debug(
          `[PERM] flag=${flag} held by nobody on ${excluded.size}/${unique.length} assocs (kind)`
        );
        unique = unique.filter((id) => !excluded.has(id));
        if (unique.length === 0) return new Set();
      }
    }
    if (opts?.isGlobalAdmin) return new Set(unique);
    if (!userId) return new Set();

    // The super-admin tier is scoped per association too: the associations among `unique` that a BDE
    // where the caller holds MANAGE_ASSO governs - never all of them because it governs some.
    const governed =
      (flag & SUPER_ADMIN_EXCLUDED_FLAGS) === 0
        ? new Set(
            await this.associationsUnderBdeFlag(userId, AssociationPermissionFlag.MANAGE_ASSO)
          )
        : new Set<string>();
    const rest = unique.filter((id) => !governed.has(id));
    const granted = new Set(unique.filter((id) => governed.has(id)));
    if (granted.size > 0) {
      this.logger.debug(
        `[PERM] super-admin granted user=${userId.slice(0, 8)} flag=${flag} on ${granted.size}/${unique.length} assocs`
      );
    }
    if (rest.length === 0) return granted;

    const rows = await this.memberRepo.find({
      where: { userId, associationId: In(rest) },
      select: { associationId: true, permissions: true },
    });
    for (const row of rows) {
      if ((row.permissions & flag) !== 0) granted.add(row.associationId);
    }
    this.logger.debug(
      `[PERM] user=${userId.slice(0, 8)} holds flag=${flag} on ${granted.size}/${unique.length} assocs`
    );
    return granted;
  }

  /**
   * Pending calendar rows the caller may see, each carrying `canValidate` - computed HERE, per
   * event, so the client never guesses which rows its validate button may sit on.
   *
   * A global admin sees and validates all. Anyone else sees the pending events of the associations
   * they are an admin of (permissions > 0), plus those of every association a BDE where they hold
   * VALIDATE_EVENTS governs (WP6c step 2: the BDE of the event association's space, never every
   * BDE) - and may validate only the latter.
   */
  async listPendingCalendarEvents(userId: string, opts?: { isGlobalAdmin?: boolean }) {
    const qb = this.calendarRepo
      .createQueryBuilder('e')
      .innerJoin(Association, 'a', 'a.id = e.associationId')
      .where('e.status = :pending', { pending: AssociationCalendarEventStatus.Pending })
      .orderBy('e.startsAt', 'ASC');

    const governs = holdsBdeAgendaRightOverSql(':pendingViewer', 'e."associationId"');
    if (!opts?.isGlobalAdmin) {
      const myMemberships = await this.memberRepo.find({
        where: { userId },
        select: { associationId: true, permissions: true },
      });
      const adminAssoIds = myMemberships
        .filter((m) => m.permissions > 0)
        .map((m) => m.associationId);
      qb.setParameters({ pendingViewer: userId });
      qb.andWhere(
        adminAssoIds.length > 0 ? `(e.associationId IN (:...adminAssoIds) OR ${governs})` : governs,
        { adminAssoIds }
      );
    }

    const rows = await qb
      .select('e.id', 'id')
      .addSelect('e.associationId', 'associationId')
      .addSelect('e.title', 'title')
      .addSelect('e.description', 'description')
      .addSelect('e.startsAt', 'startsAt')
      .addSelect('e.endsAt', 'endsAt')
      .addSelect('e.createdBy', 'createdBy')
      .addSelect('e.createdAt', 'createdAt')
      .addSelect('e.kind', 'kind')
      .addSelect('e.linkedFormId', 'linkedFormId')
      .addSelect('e.status', 'status')
      .addSelect('e.validatedAt', 'validatedAt')
      .addSelect('e.validatedBy', 'validatedBy')
      .addSelect('e.rejectedAt', 'rejectedAt')
      .addSelect('e.rejectedBy', 'rejectedBy')
      .addSelect('e.rejectionReason', 'rejectionReason')
      .addSelect('e.imageUrl', 'imageUrl')
      .addSelect('e.imageMediaId', 'imageMediaId')
      .addSelect('e.presentation', 'presentation')
      .addSelect('e.reachPublic', 'reachPublic')
      .addSelect('e.reachSpaces', 'reachSpaces')
      .addSelect('a.name', 'associationName')
      .addSelect('a.slug', 'associationSlug')
      .addSelect('a.color', 'associationColor')
      .addSelect('a.logoUrl', 'associationLogoUrl')
      .addSelect(opts?.isGlobalAdmin ? 'true' : governs, 'canValidate')
      .getRawMany();

    const serialized = rows.map((r: Record<string, unknown>) => {
      const base = this.serializeCalendarEvent({
        id: r.id as string,
        associationId: r.associationId as string,
        title: r.title as string,
        description: (r.description as string | null) ?? null,
        startsAt: r.startsAt as Date,
        endsAt: (r.endsAt as Date | null) ?? null,
        createdBy: r.createdBy as string,
        createdAt: r.createdAt as Date,
        kind: (r.kind as AssociationCalendarEventKind) ?? AssociationCalendarEventKind.Event,
        linkedFormId: (r.linkedFormId as string | null) ?? null,
        status:
          (r.status as AssociationCalendarEventStatus) ?? AssociationCalendarEventStatus.Pending,
        validatedAt: (r.validatedAt as Date | null) ?? null,
        validatedBy: (r.validatedBy as string | null) ?? null,
        rejectedAt: (r.rejectedAt as Date | null) ?? null,
        rejectedBy: (r.rejectedBy as string | null) ?? null,
        rejectionReason: (r.rejectionReason as string | null) ?? null,
        imageUrl: (r.imageUrl as string | null) ?? null,
        imageMediaId: (r.imageMediaId as string | null) ?? null,
        presentation: this.rawPresentation(r.presentation),
        reachPublic: (r.reachPublic as AssociationCalendarEvent['reachPublic']) ?? null,
        reachSpaces: (r.reachSpaces as AssociationCalendarEvent['reachSpaces']) ?? null,
      });
      return {
        ...base,
        associationName: this.rawQueryString(r.associationName),
        associationSlug: this.rawQueryString(r.associationSlug),
        associationColor: (r.associationColor as string | null) ?? null,
        associationLogoUrl: (r.associationLogoUrl as string | null) ?? null,
        // `=== true` and nothing looser: a driver answering 't' must not widen the button.
        canValidate: r.canValidate === true,
      };
    });
    // Any member with a flag sees their association's queue; only its stewards see who files a
    // neutral event.
    return this.presentEventsToViewer(
      serialized,
      { userId, isGlobalAdmin: opts?.isGlobalAdmin },
      null
    );
  }

  /** A raw `presentation` column: anything but `neutral` is the association's own presentation. */
  private rawPresentation(raw: unknown): AssociationCalendarEventPresentation {
    return raw === AssociationCalendarEventPresentation.Neutral
      ? AssociationCalendarEventPresentation.Neutral
      : AssociationCalendarEventPresentation.Association;
  }

  /**
   * Signs the agenda selection a signed-in reader asks to subscribe to (D40 amended 2026-10-06).
   * Only selections inside the reader's OWN spaces are signed - their campus, their formations, a
   * pair of both (`READER_SPACES_SQL`, the twin of `readerSpaces`); an association needs no
   * membership, only to exist. A reader with a campus and NO cursus (EMSE staff) is signed their
   * own campus alone, no formation = every formation of it (user, 2026-10-07). The returned `sig` goes into the feed URL unchanged.
   */
  async signAgendaFeedSelection(
    userId: string,
    selection: SpaceSelection,
    associationId: string | null
  ): Promise<{ sig: string }> {
    if (associationId) await this.findById(associationId);
    const spaces = (await this.assoRepo.manager.query(READER_SPACES_SQL, [userId])) as SpacePair[];
    // A reader tied to no formation (EMSE staff) has no space: they may follow their own campus
    // whole (user, 2026-10-07). Only asked when there is no space, so a student never reaches it.
    let campusWide: string | null = null;
    if (spaces.length === 0) {
      const rows = (await this.assoRepo.manager.query(READER_PROFILE_SQL, [userId])) as Array<{
        id: string;
        campus: string | null;
        cursus: unknown;
      }>;
      campusWide = rows[0] ? campusWideReaderCampus(rows[0]) : null;
    }
    if (!selectionWithinSpaces(selection, spaces, campusWide)) {
      this.logger.warn(
        `[AGENDA_SIG] refused to sign campus=${selection.campus} formation=${selection.formation} for ${userId.slice(0, 8)}: outside their spaces`
      );
      throw new ForbiddenException({
        code: AGENDA_SELECTION_FORBIDDEN,
        message: 'You can only subscribe to the agenda of your own campus and formations',
      });
    }
    return { sig: signAgendaSelection({ ...selection, associationId }) };
  }

  /**
   * The spaces the reader's agenda reaches (`AGENDA_REACHED_SPACES_SQL`), as pairs: what the
   * agenda's space filter offers. A view aid; it grants nothing.
   */
  async listAgendaReachedSpaces(userId: string): Promise<SpacePair[]> {
    const rows = (await this.assoRepo.manager.query(AGENDA_REACHED_SPACES_SQL, [
      userId,
    ])) as SpacePair[];
    this.logger.debug(`[AGENDA] ${userId.slice(0, 8)} reaches ${rows.length} space(s)`);
    return rows;
  }

  /**
   * Lists agenda events across all associations in `[from, to]` (by `startsAt`),
   * optionally restricted to one association. Public (same visibility as per-association `/events`).
   * `fromIso`/`toIso` default to `defaultCalendarFeedRange()` when omitted or blank.
   */
  async listAggregatedCalendarFeed(
    fromIso?: string,
    toIso?: string,
    associationId?: string,
    opts?: {
      includePending?: boolean;
      viewer?: CalendarViewer;
      selection?: SpaceSelection;
      /** The one-event `.ics` link, signed for that event: no public is withheld from it. */
      signedEvent?: boolean;
    }
  ) {
    const defaultRange = AssociationsService.defaultCalendarFeedRange();
    const from = fromIso?.trim() ? new Date(fromIso.trim()) : defaultRange.from;
    const to = toIso?.trim() ? new Date(toIso.trim()) : defaultRange.to;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid from or to');
    }
    if (from > to) {
      throw new BadRequestException('from must be before or equal to to');
    }
    if (to.getTime() - from.getTime() > AssociationsService.CALENDAR_FEED_MAX_MS) {
      throw new BadRequestException('Date range too large (max ~18 months)');
    }

    const aid = associationId?.trim() || null;
    if (aid) {
      await this.findById(aid);
    }

    const promoCutoff = await promoCutoffFor(
      this.calendarRepo.manager,
      opts?.viewer?.userId,
      opts?.viewer?.isGlobalAdmin
    );

    const qb = this.calendarRepo
      .createQueryBuilder('e')
      .innerJoin(Association, 'a', 'a.id = e.associationId')
      // Overlap condition: event starts before window end AND ends (or starts) within/after window.
      .where('e.startsAt <= :to AND COALESCE(e.endsAt, e.startsAt) >= :from', { from, to })
      .orderBy('e.startsAt', 'ASC');
    if (promoCutoff) {
      qb.andWhere('e.startsAt >= :promoCutoff::timestamptz', { promoCutoff });
    }
    this.restrictToViewerSpaces(qb, opts?.viewer);
    this.restrictToSelection(qb, opts?.selection);
    this.restrictAnonymousToPublicReach(qb, opts);
    // Default: validated events only. Members allowed to propose can also see pending
    // events (greyed in UI); rejected events are never shown here.
    if (opts?.includePending) {
      qb.andWhere('e.status IN (:...visibleStatuses)', {
        visibleStatuses: [
          AssociationCalendarEventStatus.Validated,
          AssociationCalendarEventStatus.Pending,
        ],
      });
    } else {
      qb.andWhere('e.status = :validated', {
        validated: AssociationCalendarEventStatus.Validated,
      });
    }
    if (aid) {
      // Include events where the association is either the primary owner or a co-owner.
      qb.andWhere(
        '(e.associationId = :aid OR EXISTS (SELECT 1 FROM association_calendar_event_co_owners co WHERE co.event_id = e.id AND co.association_id = :aid))',
        { aid }
      );
    }

    const rows = await qb
      .select('e.id', 'id')
      .addSelect('e.associationId', 'associationId')
      .addSelect('e.title', 'title')
      .addSelect('e.description', 'description')
      .addSelect('e.startsAt', 'startsAt')
      .addSelect('e.endsAt', 'endsAt')
      .addSelect('e.createdBy', 'createdBy')
      .addSelect('e.createdAt', 'createdAt')
      .addSelect('e.kind', 'kind')
      .addSelect('e.linkedFormId', 'linkedFormId')
      .addSelect('e.status', 'status')
      .addSelect('e.validatedAt', 'validatedAt')
      .addSelect('e.validatedBy', 'validatedBy')
      .addSelect('e.imageUrl', 'imageUrl')
      .addSelect('e.imageMediaId', 'imageMediaId')
      .addSelect('e.presentation', 'presentation')
      .addSelect('e.reachPublic', 'reachPublic')
      .addSelect('e.reachSpaces', 'reachSpaces')
      .addSelect('a.name', 'associationName')
      .addSelect('a.slug', 'associationSlug')
      .addSelect('a.color', 'associationColor')
      .addSelect('a.logoUrl', 'associationLogoUrl')
      .getRawMany();

    const coOwnerMap = await this.batchLoadCoOwners(
      rows.map((r: Record<string, unknown>) => r.id as string)
    );

    const serialized = rows.map((r: Record<string, unknown>) => {
      const base = this.serializeCalendarEvent(
        {
          id: r.id as string,
          associationId: r.associationId as string,
          title: r.title as string,
          description: (r.description as string | null) ?? null,
          startsAt: r.startsAt as Date,
          endsAt: (r.endsAt as Date | null) ?? null,
          createdBy: r.createdBy as string,
          createdAt: r.createdAt as Date,
          kind: (r.kind as AssociationCalendarEventKind) ?? AssociationCalendarEventKind.Event,
          linkedFormId: (r.linkedFormId as string | null) ?? null,
          status:
            (r.status as AssociationCalendarEventStatus) ??
            AssociationCalendarEventStatus.Validated,
          validatedAt: (r.validatedAt as Date | null) ?? null,
          validatedBy: (r.validatedBy as string | null) ?? null,
          rejectedAt: null,
          rejectedBy: null,
          rejectionReason: null,
          imageUrl: (r.imageUrl as string | null) ?? null,
          imageMediaId: (r.imageMediaId as string | null) ?? null,
          presentation: this.rawPresentation(r.presentation),
          reachPublic: (r.reachPublic as AssociationCalendarEvent['reachPublic']) ?? null,
          reachSpaces: (r.reachSpaces as AssociationCalendarEvent['reachSpaces']) ?? null,
        },
        coOwnerMap.get(r.id as string) ?? []
      );
      return {
        ...base,
        associationName: this.rawQueryString(r.associationName),
        associationSlug: this.rawQueryString(r.associationSlug),
        associationColor: (r.associationColor as string | null) ?? null,
        associationLogoUrl: (r.associationLogoUrl as string | null) ?? null,
      };
    });
    // The anonymous `.ics` passes no viewer and so reads every neutral event masked; a filter on one
    // association is that association's own agenda.
    return this.presentEventsToViewer(serialized, opts?.viewer, aid);
  }

  /**
   * Tells the association's proposers what a calendar manager did with their event.
   *
   * THE TYPE CARRIES THE VERB AND THE TEXT CARRIES THE TITLE - never a composed sentence. Until
   * 2026-09-09 this method wrote `Event "X" has been validated by the BDE.` straight into the
   * notification row and sent the same English string as a raw push title and body, so a French
   * member got an English notification and no translation could fix it: the sentence had already
   * been chosen by the one layer that cannot know who is reading. `push-content.ts` exists to end
   * exactly that, and going to the repository directly is how this call site escaped it.
   */
  private async notifyAssocAdminsOfEventAction(
    associationId: string,
    actorId: string,
    eventTitle: string,
    action: 'validated' | 'updated' | 'deleted' | 'rejected',
    rejectionReason?: string
  ): Promise<void> {
    // NEVER REJECTS: every caller fires it with `void` after the write it reports has committed, and
    // a rejection nobody awaits is an unhandled one - which ends the process under bun. A failure is
    // caught here and logged at WARN with its stack and the association: the contract
    // `notifyEventValidatorsOfProposal` gives the validators' notice.
    try {
      await this.notifyAssocAdminsOfEventActionOrThrow(
        associationId,
        actorId,
        eventTitle,
        action,
        rejectionReason
      );
    } catch (err) {
      this.logger.warn(
        `[notify] the proposers of asso ${sanitizeLog(associationId)} were not told an event was ${action}`,
        err instanceof Error ? err.stack : String(err)
      );
    }
  }

  /** The body of `notifyAssocAdminsOfEventAction`, which may reject; only that wrapper calls it. */
  private async notifyAssocAdminsOfEventActionOrThrow(
    associationId: string,
    actorId: string,
    eventTitle: string,
    action: 'validated' | 'updated' | 'deleted' | 'rejected',
    rejectionReason?: string
  ): Promise<void> {
    const members = await this.memberRepo.find({
      where: { associationId },
      select: { userId: true, permissions: true },
    });
    const recipientIds = members
      .filter((m) => (m.permissions & AssociationPermissionFlag.PROPOSE_EVENT) !== 0)
      .map((m) => m.userId);
    if (recipientIds.length === 0) return;

    await this.notifications.createNotifications({
      recipientIds,
      type: `event_${action}`,
      postId: associationId,
      actorId,
      // The rejection reason is the one thing a reader cannot reconstruct from the title, so it
      // travels with it rather than being dropped for the sake of a tidy column.
      text:
        action === 'rejected' && rejectionReason
          ? `${eventTitle}
${rejectionReason}`
          : eventTitle,
      pushData: { associationId, action },
    });
  }

  /**
   * THE ONE ANNOUNCEMENT OF AN EVENT RETURNING TO THE QUEUE (F7, WP-Q2) - whatever the cause.
   *
   * Two audiences, one rule: the validators concerned are told as for a proposal
   * (`notifyEventValidatorsOfProposal`), and the organiser and every accepted partner are told WITH
   * THE REASON (`notifyEventReopenedParties`). Every path that sets a validated event back to
   * `pending` calls this and nothing else, so a new path cannot forget one of the two. Best effort,
   * and always run AFTER the write has committed: a failure here is logged and loses a message, never
   * the event's state.
   */
  async announceEventReopened(
    ev: ReopenedEvent,
    reason: EventReopenReason,
    actorId: string
  ): Promise<void> {
    // NEVER REJECTS: every caller is fire-and-forget or runs after a commit that must stay a success
    // (a rejection would turn a committed acceptance into a 500, or be an unhandled rejection).
    let current: { status: AssociationCalendarEventStatus } | null;
    try {
      // RE-READ, never trusted from the write: between the commit and this notice a validator may
      // have said yes again, and "waiting for validation" would then be false.
      current = await this.calendarRepo.findOne({
        where: { id: ev.id },
        select: { id: true, status: true },
      });
    } catch (err) {
      this.logger.warn(
        `[EVENT_REOPENED] ${sanitizeLog(ev.id.slice(0, 8))} (${reason}): the status could not be re-read, not announced`,
        err instanceof Error ? err.stack : String(err)
      );
      return;
    }
    if (current?.status !== AssociationCalendarEventStatus.Pending) {
      this.logger.log(
        `[EVENT_REOPENED] ${sanitizeLog(ev.id.slice(0, 8))} (${reason}): no longer pending (${current?.status ?? 'gone'}), not announced`
      );
      return;
    }
    this.logger.log(
      `[EVENT_REOPENED] ${sanitizeLog(ev.id.slice(0, 8))} back to pending: ${reason} (by ${sanitizeLog(actorId.slice(0, 8))})`
    );
    // Validators FIRST, and the parties exclude them: somebody who is both a validator and a party
    // gets ONE notice, the validator's - the one that is actionable. A push that fails AFTER the
    // rows were saved still counts as told (typed, NotificationPushFailedError). DEGRADED CASE: when
    // the validators' notice wrote NOTHING (logged inside, the function never rejects), it returns
    // nobody, so nobody is excluded and that person is told once as a party instead - a notice with
    // the reason, but not the actionable one.
    const validatorIds: string[] = await (async () => {
      // An ACCEPTANCE is not a proposal: the acceptor must not be shown as proposing, so it has its
      // own typed notice; a date move keeps the proposal's.
      return reason === 'coorganiser_joined'
        ? this.notifyEventValidatorsOfProposal(ev.associationId, actorId, ev.title, {
            type: EVENT_REOPEN_NOTIFICATION_TYPE[reason],
            meta: { reason, audience: 'validators' },
            // 'proposed' IS THE QUEUE TARGET of the push deep link (socialDeepLink): a validator lands
            // on the validation queue, as for a proposal, never on the plain agenda.
            pushData: { associationId: ev.associationId, action: 'proposed', reason },
          })
        : this.notifyEventValidatorsOfProposal(ev.associationId, actorId, ev.title);
    })();
    try {
      await this.notifyEventReopenedParties(ev, reason, actorId, new Set(validatorIds));
    } catch (err) {
      this.logger.warn(
        `[EVENT_REOPENED] ${sanitizeLog(ev.id.slice(0, 8))} (${reason}): the parties were not told`,
        err instanceof Error ? err.stack : String(err)
      );
    }
  }

  /**
   * Tells the people an event belongs to why it left the public agenda: the `PROPOSE_EVENT` holders
   * of the organiser AND of each ACCEPTED partner (they co-own it, and the one who moved the dates or
   * accepted is rarely the only person counting on it). The notification type carries the reason
   * (`EVENT_REOPEN_NOTIFICATION_TYPE`) and so does `meta.reason`, for a client that draws its own
   * sentence. `createNotifications` drops the actor, and writes one row per person.
   */
  private async notifyEventReopenedParties(
    ev: ReopenedEvent,
    reason: EventReopenReason,
    actorId: string,
    alreadyTold: ReadonlySet<string>
  ): Promise<void> {
    const coOwners = await this.coOwnerRepo.find({ where: { eventId: ev.id } });
    const associationIds = [ev.associationId, ...coOwners.map((c) => c.associationId)];
    const members = await this.memberRepo.find({
      where: { associationId: In(associationIds) },
      select: { userId: true, permissions: true },
    });
    const recipientIds = [
      ...new Set(
        members
          .filter((m) => (m.permissions & AssociationPermissionFlag.PROPOSE_EVENT) !== 0)
          .map((m) => m.userId)
      ),
    ].filter((id) => !alreadyTold.has(id));
    const written = await this.notifications.createNotifications({
      recipientIds,
      type: EVENT_REOPEN_NOTIFICATION_TYPE[reason],
      postId: ev.associationId,
      actorId,
      text: ev.title,
      meta: { reason },
      pushData: { associationId: ev.associationId, action: 'pending', reason },
    });
    this.logger.debug(
      `[EVENT_REOPENED] ${sanitizeLog(ev.id.slice(0, 8))} (${reason}): ${written} organiser/partner notice(s) written`
    );
  }

  /**
   * Tells the calendar managers that an event is waiting for them.
   *
   * THE HALF THAT DID NOT EXIST. Every other transition on this seam notified somebody - validating,
   * updating, rejecting and deleting all reach the proposing association - and a PROPOSAL reached
   * nobody. The pending queue was a page a BDE admin had to remember to open, and *a correct
   * mechanism with no report is found by hand, a day late*. The user asked for this to be tested on
   * 2026-09-09; testing it found it absent.
   *
   * Recipients are the holders of `VALIDATE_EVENTS` in the BDE of a space the event association
   * targets - the same predicate (`holdsBdeAgendaRightOverSql`) `mayValidateEvent` uses to decide
   * who MAY validate it, so the people told are exactly the people who can act on it (WP6c step 2),
   * an institution's event included (owner, 2026-11-03). A BDE of another space is not told.
   *
   * AND THE PLATFORM ADMINS, when a targeted space has no BDE - or the association targets no space
   * at all (`TARGETS_AN_UNGOVERNED_SPACE_SQL`): for that slice of the audience they are the only
   * validators, and a proposal they are not told of waits on a page nobody opens. The warning stays
   * for the one case where nobody at all could be told.
   */
  private async notifyEventValidatorsOfProposal(
    associationId: string,
    actorId: string,
    eventTitle: string,
    notice?: {
      type: NotificationType;
      meta: Record<string, unknown>;
      pushData: Record<string, string>;
    }
  ): Promise<string[]> {
    // NEVER REJECTS, and that is the contract of this function - not of its callers: it runs after a
    // commit and is mostly fire-and-forget (`void`), where a rejection is an unhandled rejection
    // (social-service has no handler) and a notice's failure must never fail a committed write.
    // Every failure is logged at WARN with its stack; it then told NOBODY, and returns no ids.
    try {
      return await this.notifyEventValidatorsOfProposalOrThrow(
        associationId,
        actorId,
        eventTitle,
        notice
      );
    } catch (err) {
      this.logger.warn(
        `[notify] the validators of asso ${sanitizeLog(associationId)} were not told about an event waiting for validation`,
        err instanceof Error ? err.stack : String(err)
      );
      return [];
    }
  }

  /** The body of `notifyEventValidatorsOfProposal`: may throw, and is only called through it. */
  private async notifyEventValidatorsOfProposalOrThrow(
    associationId: string,
    actorId: string,
    eventTitle: string,
    notice?: {
      type: NotificationType;
      meta: Record<string, unknown>;
      pushData: Record<string, string>;
    }
  ): Promise<string[]> {
    const validators: { userId: string }[] = await this.memberRepo.query(
      BDE_AGENDA_RIGHT_HOLDERS_OVER_SQL,
      [associationId]
    );
    const [target] = (await this.memberRepo.query(TARGETS_AN_UNGOVERNED_SPACE_SQL, [
      associationId,
    ])) as { ungoverned: boolean }[];
    const admins: { userId: string }[] =
      target?.ungoverned === true ? await this.memberRepo.query(PLATFORM_ADMINS_SQL) : [];
    const recipientIds = [...new Set([...validators, ...admins].map((r) => r.userId))];
    this.logger.debug(
      `[notify] event proposed for asso ${sanitizeLog(associationId)}: ${validators.length} BDE validator(s), ${admins.length} platform admin(s) for an ungoverned space`
    );

    let written: number;
    try {
      written = await this.notifications.createNotifications({
        recipientIds,
        type: notice?.type ?? 'event_proposed',
        postId: associationId,
        actorId,
        text: eventTitle,
        ...(notice ? { meta: notice.meta } : {}),
        pushData: notice?.pushData ?? { associationId, action: 'proposed' },
      });
    } catch (err) {
      // The rows are saved and only the push failed: the validators HAVE their notice in the bell,
      // so they are still returned (a validator who is also a party must not get a second row).
      // Anything else wrote nothing and propagates, and then nobody is excluded.
      if (!(err instanceof NotificationPushFailedError)) throw err;
      this.logger.warn(
        `[notify] event waiting for validation (asso ${sanitizeLog(associationId)}): the validators' rows are saved, their push failed`,
        err.stack
      );
      written = err.recipientIds.length;
    }
    if (written === 0) {
      // Nobody at all could be told: no BDE governs a targeted space AND no platform admin exists,
      // or the only one is the proposer. The exact shape of the defect this method was written for.
      this.logger.warn(
        `[notify] event proposed for asso ${sanitizeLog(associationId)} and nobody who may validate it was told`
      );
    }
    // EVERY id told, the platform admins of an ungoverned space included: the caller's dedupe set
    // (`announceEventReopened`) must hold them, or an admin who is also a party is told twice.
    return recipientIds;
  }

  /**
   * Creates a calendar event for the association - ALWAYS `pending`, whoever asks.
   *
   * NO CREATION PATH VALIDATES (user, 2026-09-14: *"Un evenement ne doit jamais etre valide
   * automatiquement, il doit aller en pending, y compris par un admin systeme ou un admin BDE"*).
   * Until then a BDE admin or a global admin wrote `validated` here, on the spot, which made a
   * validation a property of WHO TYPED rather than a decision anybody took: the queue only ever
   * held the events of members who happened not to hold the grant, and the one screen that reviews
   * the school's agenda could not see what its own managers had put on it. Validating is now
   * exactly one thing - `validateCalendarEvent` - and it is always a separate, deliberate act.
   *
   * THE VALIDATOR GRANT STILL DECIDES TWO OTHER THINGS AND THEY ARE NOT THIS ONE: creating on
   * behalf of another association (`targetAssocId`), and declaring a `break`, the school-wide band
   * `assertMayDecideKind` reserves. Hence `isValidator` rather than `canValidate` - the holder may
   * validate, later, through the method that does it.
   */
  async createCalendarEvent(
    associationId: string,
    dto: CreateAssociationCalendarEventDto,
    userId: string,
    callerOpts?: { isGlobalAdmin?: boolean; isBde?: boolean }
  ) {
    const isValidator = callerOpts?.isGlobalAdmin || callerOpts?.isBde;
    // A global admin, or a BDE governing the TARGET (the controller scoped `isBde` to it), may
    // create on behalf of another association.
    const targetId = isValidator && dto.targetAssocId ? dto.targetAssocId : associationId;
    const owner = await this.findById(targetId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (Number.isNaN(startsAt.getTime())) {
      throw calendarDateRefusal(CALENDAR_ERROR_CODES.INVALID_START, 'Invalid startsAt');
    }
    if (endsAt && Number.isNaN(endsAt.getTime())) {
      throw calendarDateRefusal(CALENDAR_ERROR_CODES.INVALID_END, 'Invalid endsAt');
    }
    if (endsAt && endsAt < startsAt) {
      throw calendarDateRefusal(
        CALENDAR_ERROR_CODES.END_BEFORE_START,
        'endsAt must be after startsAt'
      );
    }

    const kind = dto.kind ?? AssociationCalendarEventKind.Event;
    assertMayDecideKind(kind, AssociationCalendarEventKind.Event, isValidator);
    // The cap is checked BEFORE the transaction opens: a refusal costs no connection and no lock.
    assertWithinCoOrganiserCap(
      new Set((dto.coOwnerIds ?? []).filter((id) => id !== targetId)).size
    );

    const linkedFormId = dto.linkedFormId ?? null;
    // D39: every co-organiser named here is ASKED, so a new event has no co-owner row yet - its
    // reach and its rights stay the organiser's until one accepts. The creator writes as the
    // organiser (the guard, or the BDE / global admin tier for a deposit).
    const askedCount = new Set((dto.coOwnerIds ?? []).filter((id) => id !== targetId)).size;
    // NEUTRAL (owner, 2026-11-08): the route already asked PROPOSE_EVENT on `:id` (or the deposit
    // tier on the target) - the right that files the BDE's events; the presentation adds that the
    // owner is a BDE and that nothing on the event names it. Before the transaction, like the cap.
    const presentation = dto.presentation ?? AssociationCalendarEventPresentation.Association;
    assertNeutralPresentationAllowed({
      presentation,
      ownerIsBde: owner.isBDE === true,
      partnerCount: askedCount,
      linkedFormId,
      linkedByPost: false,
    });
    // AN INSTITUTION'S REACH (owner, 2026-11-13): mandatory on an institution's event, refused on any
    // other, never wider than its audience - the posts' own decision and codes, judged on the OWNER
    // (the target of a deposit). Before the transaction, like the cap.
    const reach = await resolveInstitutionReachWrite(this.calendarRepo.manager, {
      mode: 'create',
      associationId: targetId,
      associationType: owner.type ?? null,
      raw: dto.reach,
      subject: 'event',
    });
    // ONE TRANSACTION, ONE CONNECTION: the form-link detach, the event insert and the partners'
    // proposals commit together or not at all. The event used to be saved BEFORE the sync, so a
    // failing k-th proposal left an event with no proposals behind a 500, and the caller's retry
    // created it twice. The announcements run after the commit.
    const { saved, afterCommit } = await this.calendarRepo.manager.transaction(async (manager) => {
      await this.keyShareAssociations(manager, [targetId, ...(dto.coOwnerIds ?? [])]);
      if (linkedFormId) await this.assertFormBelongsToAssociation(linkedFormId, targetId, manager);
      const repo = manager.getRepository(AssociationCalendarEvent);
      await this.detachLinksBeforeCreate(linkedFormId, repo);

      const row = repo.create({
        associationId: targetId,
        title: dto.title.trim(),
        description: dto.description?.trim() ? dto.description.trim() : null,
        startsAt,
        endsAt,
        createdBy: userId,
        kind,
        presentation,
        reachPublic: reach?.reachPublic ?? null,
        reachSpaces: reach?.reachSpaces ?? null,
        linkedFormId,
        // The three validation columns are written in ONE place, and this is not it. Spelling
        // `null` here rather than leaving them to the entity default is deliberate: a default is
        // what happens when nobody said, and this row says.
        status: AssociationCalendarEventStatus.Pending,
        validatedAt: null,
        validatedBy: null,
      });
      const saved = await repo.save(row);
      const afterCommit: CoOrganiserAfterCommit =
        askedCount > 0
          ? await this.coOrganiserPort().sync(
              {
                eventId: saved.id,
                organiserId: targetId,
                desiredIds: dto.coOwnerIds ?? [],
                actorId: userId,
                isGlobalAdmin: callerOpts?.isGlobalAdmin === true,
                organiserSide: true,
                viaAssociationId: associationId,
              },
              manager
            )
          : () => Promise.resolve();
      return { saved, afterCommit };
    });
    await afterCommit();
    const coOwners: AssociationCalendarEventCoOwner[] = [];
    this.logger.debug(
      `Event created: ${sanitizeLog(saved.id)} for asso ${sanitizeLog(targetId)} by ${sanitizeLog(userId)} (status=${sanitizeLog(saved.status)}, presentation=${sanitizeLog(saved.presentation)}, co-organisers asked=${askedCount})`
    );
    // EVERY creation is a proposal, so the calendar managers are told about every one - there is
    // no longer a branch here, because there is no longer a creation that skips the queue.
    //
    // The association the event LANDS on is told by the transition that actually publishes it
    // (`validateCalendarEvent`) or refuses it (`rejectCalendarEvent`), not from here. Announcing a
    // cross-association creation as `validated` was true only while creating and validating were
    // the same act; repeating it now would be a notification about a publication that has not
    // happened, and adding a second one at creation would make a cross-asso deposit the only event
    // in the system that notifies its owner twice.
    void this.notifyEventValidatorsOfProposal(targetId, userId, saved.title);
    return this.serializeCalendarEvent(saved, coOwners);
  }

  /**
   * Updates an existing calendar event.
   * Global admins, and a BDE governing the event association (`isBde`, scoped by the controller),
   * may update an event owned by another association.
   */
  async updateCalendarEvent(
    associationId: string,
    eventId: string,
    dto: UpdateAssociationCalendarEventDto,
    callerOpts?: { isGlobalAdmin?: boolean; isBde?: boolean; callerUserId?: string }
  ) {
    await this.findById(associationId);
    // EVERY CHECK AND EVERY WRITE UNDER THE EVENT'S LOCK: the event is read AFTER the lock is
    // taken, so a validation or an acceptance that committed first is what this edit starts from.
    const { saved, demoted, afterCommit } = await this.withEventLock(
      eventId,
      (repo, manager) =>
        this.applyCalendarEventUpdate(repo, manager, associationId, eventId, dto, callerOpts),
      dto.coOwnerIds
    );
    // The partners' proposals are announced once they are COMMITTED, with the other notices.
    await afterCommit();
    const canCrossAsso = callerOpts?.isGlobalAdmin || callerOpts?.isBde;
    const coOwners = await this.batchLoadCoOwners([saved.id]).then((m) => m.get(saved.id) ?? []);
    this.logger.debug(
      `Event updated: ${sanitizeLog(saved.id)} by ${sanitizeLog(callerOpts?.callerUserId)} (coOwners=${coOwners.length})`
    );
    // Notifications run AFTER the commit: a notice for a write that rolled back would be a lie.
    if (demoted) {
      this.logger.debug(
        `Event returned to pending after a date change: ${sanitizeLog(saved.id)} by ${sanitizeLog(callerOpts?.callerUserId)}`
      );
      // The same route a fresh proposal takes, because that is what this now is: the validators,
      // and the organiser and the partners with the reason (F7).
      void this.announceEventReopened(
        saved,
        'date_moved',
        callerOpts?.callerUserId ?? saved.createdBy
      );
    }
    // Notify asso admins when BDE modifies an event from another asso
    if (canCrossAsso && saved.associationId !== associationId && callerOpts?.callerUserId) {
      void this.notifyAssocAdminsOfEventAction(
        saved.associationId,
        callerOpts.callerUserId,
        saved.title,
        'updated'
      );
    }
    return this.serializeCalendarEvent(saved, coOwners);
  }

  /** The checks and writes of `updateCalendarEvent`, run by it inside the event's lock. */
  private async applyCalendarEventUpdate(
    repo: Repository<AssociationCalendarEvent>,
    manager: EntityManager,
    associationId: string,
    eventId: string,
    dto: UpdateAssociationCalendarEventDto,
    callerOpts?: { isGlobalAdmin?: boolean; isBde?: boolean; callerUserId?: string }
  ): Promise<{
    saved: AssociationCalendarEvent;
    demoted: boolean;
    afterCommit: CoOrganiserAfterCommit;
  }> {
    const canCrossAsso = callerOpts?.isGlobalAdmin || callerOpts?.isBde;
    const ev = await this.findCalendarEventForAssociation(
      eventId,
      associationId,
      canCrossAsso === true,
      repo
    );
    if (!ev) throw new NotFoundException('Event not found');

    // Before any mutation: a refusal must leave the entity as it was found.
    if (dto.kind !== undefined) assertMayDecideKind(dto.kind, ev.kind, canCrossAsso);

    // READ BEFORE WRITING. What returns a validated event to the queue is a date that actually
    // MOVED, never a `startsAt` that merely appeared in the DTO: both modals submit every field
    // they render, so keying off `dto.startsAt !== undefined` would demote an event whose author
    // only fixed a typo in the title.
    const wasValidated = ev.status === AssociationCalendarEventStatus.Validated;
    const previousStartsAt = toMillis(ev.startsAt);
    const previousEndsAt = toMillis(ev.endsAt);

    if (dto.title !== undefined) ev.title = dto.title.trim();
    if (dto.kind !== undefined) ev.kind = dto.kind;
    if (dto.description !== undefined) {
      ev.description = dto.description?.trim() ? dto.description.trim() : null;
    }
    if (dto.startsAt !== undefined) {
      const d = new Date(dto.startsAt);
      if (Number.isNaN(d.getTime())) {
        throw calendarDateRefusal(CALENDAR_ERROR_CODES.INVALID_START, 'Invalid startsAt');
      }
      ev.startsAt = d;
    }
    if (dto.endsAt !== undefined) {
      if (!dto.endsAt?.trim()) {
        ev.endsAt = null;
      } else {
        const end = new Date(dto.endsAt);
        if (Number.isNaN(end.getTime())) {
          throw calendarDateRefusal(CALENDAR_ERROR_CODES.INVALID_END, 'Invalid endsAt');
        }
        ev.endsAt = end;
      }
    }
    const starts = ev.startsAt instanceof Date ? ev.startsAt : new Date(ev.startsAt);
    const ends = ev.endsAt ? (ev.endsAt instanceof Date ? ev.endsAt : new Date(ev.endsAt)) : null;
    if (ends && ends < starts) {
      throw calendarDateRefusal(
        CALENDAR_ERROR_CODES.END_BEFORE_START,
        'endsAt must be after startsAt'
      );
    }

    /**
     * A VALIDATED EVENT WHOSE DATES MOVE IS A DIFFERENT EVENT, AND IT ASKS AGAIN.
     *
     * `status` was the one column this method never touched, so an association admin could have an
     * event approved for a Tuesday and then move it to the Saturday of the gala - or to another
     * hour of a room already booked - and it stayed on the public agenda with nobody told. The BDE
     * validated a date; changing the date spends a validation that was never given.
     *
     * Only the DATES do this. A title, a description, a poster or a linked form change nothing the
     * BDE reasoned about when it said yes, and demoting on those would turn every typo into a
     * queue item and teach the validators to approve without reading.
     *
     * AND IT HAS NO EXCEPTION FOR THE AUTHORITY ITSELF - user, 2026-09-14: *"Un evenement ne doit
     * jamais etre valide automatiquement, il doit aller en pending, y compris par un admin systeme
     * ou un admin BDE"*. A caller who can validate used to RE-VALIDATE IN PLACE here, on the
     * argument that they are the authority the demotion would route to. That argument re-opened by
     * a second door exactly what the creation path had just closed: a BDE admin could propose,
     * validate, then move the date, and the event stayed on the public agenda carrying a stamp
     * nobody read the new shape to earn. Pressing Validate again costs one click and is the only
     * thing that makes the stamp mean anything.
     */
    const datesMoved =
      toMillis(ev.startsAt) !== previousStartsAt || toMillis(ev.endsAt) !== previousEndsAt;
    // E2: a partner (an accepted co-organiser writing through its own association) edits the text
    // and the poster, never the date. Refused before ANY write below, and only when the date really
    // moved: both modals resubmit every field they render, so an unchanged date is not a change.
    const side = eventWriteSide(ev.associationId, associationId, canCrossAsso === true);
    if (side === 'partner' && datesMoved) {
      this.logger.debug(
        `[PERM] partner ${sanitizeLog(associationId.slice(0, 8))} refused a date change on ${sanitizeLog(ev.id.slice(0, 8))}`
      );
      throw partnerOrganiserOnlyRefusal('date');
    }
    // The form link is the organiser's too (decided with E2, D39): a CHANGE from the partner side
    // is refused; resending the value it already has is not a change.
    if (
      side === 'partner' &&
      dto.linkedFormId !== undefined &&
      (dto.linkedFormId || null) !== (ev.linkedFormId ?? null)
    ) {
      this.logger.debug(
        `[PERM] partner ${sanitizeLog(associationId.slice(0, 8))} refused a form link change on ${sanitizeLog(ev.id.slice(0, 8))}`
      );
      throw partnerOrganiserOnlyRefusal('linkedForm');
    }
    const demoted = wasValidated && datesMoved;
    if (demoted) {
      ev.status = AssociationCalendarEventStatus.Pending;
      ev.validatedAt = null;
      ev.validatedBy = null;
    }

    // The presentation is the organiser's, and a neutral event is checked as it WILL be (its partners
    // and its form link after this write) - read-only, so it sits with the refusals below.
    await this.assertEventPresentationAfterUpdate(manager, ev, dto, associationId, side);
    // The reach is the organiser's too, and is judged before any write (owner, 2026-11-13).
    await this.applyEventReachUpdate(manager, ev, dto.reach, side);

    // EVERY REFUSAL BEFORE ANY WRITE: the partner-list check (a partner changing more than its own
    // presence, the cap) is read-only and runs here, ahead of the form link's detach below, so a
    // refused request leaves the event, its form links and its partners exactly as found.
    let coOrganiserRequest: CoOrganiserSyncRequest | null = null;
    if (dto.coOwnerIds !== undefined) {
      if (!callerOpts?.callerUserId) {
        throw new ForbiddenException('A co-organiser change needs a caller');
      }
      coOrganiserRequest = {
        eventId: ev.id,
        organiserId: ev.associationId,
        desiredIds: dto.coOwnerIds,
        actorId: callerOpts.callerUserId,
        isGlobalAdmin: callerOpts.isGlobalAdmin === true,
        organiserSide: canCrossAsso === true || ev.associationId === associationId,
        viaAssociationId: associationId,
      };
      await this.coOrganiserPort().check(coOrganiserRequest, manager);
    }

    // Only an actual CHANGE of the link is a write (and is checked against the form's owner): a
    // modal resending the value it loaded changes nothing, whichever side it writes from.
    if (
      dto.linkedFormId !== undefined &&
      (dto.linkedFormId || null) !== (ev.linkedFormId ?? null)
    ) {
      if (dto.linkedFormId === null || dto.linkedFormId === '') {
        ev.linkedFormId = null;
      } else {
        await this.assertFormBelongsToAssociation(dto.linkedFormId, associationId, manager);
        await this.detachCalendarLinksExcept(
          {
            formId: dto.linkedFormId,
            exceptEventId: ev.id,
          },
          repo
        );
        ev.linkedFormId = dto.linkedFormId;
      }
    }

    // D39: the list is turned into proposals BEFORE the event is saved, so a refusal (a co-organiser
    // trying to change anything but its own presence, 403) leaves the event as it was found.
    const afterCommit: CoOrganiserAfterCommit = coOrganiserRequest
      ? await this.coOrganiserPort().sync(coOrganiserRequest, manager)
      : () => Promise.resolve();
    const saved = await repo.save(ev);
    return { saved, demoted, afterCommit };
  }

  /**
   * The reach half of `applyCalendarEventUpdate` (owner, 2026-11-13): absent leaves the stored reach
   * alone (an older client never clears it, and an event filed before the reach keeps its whole
   * audience until an edit chooses one); present replaces it, both ways, judged as at the filing -
   * on the organiser side only (E2). Nothing else moves: the status stays (an edit of the reach does
   * NOT send the event back to validation) and nobody is told - every reader path re-asks the
   * predicate, so a narrowing withdraws the event from the excluded readers at once. Sets the two
   * columns on `ev`; the caller saves.
   */
  private async applyEventReachUpdate(
    manager: EntityManager,
    ev: AssociationCalendarEvent,
    raw: unknown,
    side: EventWriteSide
  ): Promise<void> {
    if (raw === undefined) return;
    if (side === 'partner') {
      this.logger.debug(
        `[PERM] partner refused a reach change on ${sanitizeLog(ev.id.slice(0, 8))}`
      );
      throw partnerOrganiserOnlyRefusal('reach');
    }
    const [owner] = (await manager.query(`SELECT type FROM associations WHERE id = $1`, [
      ev.associationId,
    ])) as { type: string }[];
    const reach = await resolveInstitutionReachWrite(manager, {
      mode: 'edit',
      associationId: ev.associationId,
      associationType: owner?.type ?? null,
      raw,
      subject: 'event',
    });
    if (!reach) return;
    const before = servedInstitutionReach(ev);
    this.logger.log(
      `[INSTITUTION_REACH] event ${sanitizeLog(ev.id.slice(0, 8))}: reach ${before ? `${before.public}/${before.spaces.length}` : 'none'} -> ${reach.reachPublic}/${reach.reachSpaces.length} space(s), read at once by every path, nobody told`
    );
    ev.reachPublic = reach.reachPublic;
    ev.reachSpaces = reach.reachSpaces;
  }

  /**
   * The spaces an institution's event may target, for the event form (owner, 2026-11-13): the SAME
   * statement the write checks a reach against (`institutionReachOptionsOffered`, shared with the
   * composer's route). Asked of the OWNER `associationId` by whoever may file or write its events: a
   * platform admin, `PROPOSE_EVENT` on it (the route's own right), or the BDE agenda right over it
   * (a validator depositing through `targetAssocId`, or editing it) - 403 otherwise; 400
   * `institution_reach_not_offered` for an owner that is not an institution.
   */
  async listEventReachOptions(
    userId: string,
    associationId: string,
    isGlobalAdmin: boolean
  ): Promise<{ spaces: InstitutionReachSpace[] }> {
    const owner = await this.findById(associationId);
    const mayFile =
      isGlobalAdmin ||
      (await this.mayAct(userId, associationId, AssociationPermissionFlag.PROPOSE_EVENT)) ||
      (await this.mayValidateEventsOf(userId, associationId));
    if (!mayFile) {
      this.logger.debug(
        `[INSTITUTION_REACH] event options of ${sanitizeLog(associationId.slice(0, 8))}: ${sanitizeLog(userId.slice(0, 8))} files none of its events`
      );
      throw new ForbiddenException('You may not file events for this association');
    }
    return institutionReachOptionsOffered(
      this.calendarRepo.manager,
      associationId,
      owner.type ?? null,
      'event'
    );
  }

  /**
   * The presentation half of `applyCalendarEventUpdate` (`event-presentation.ts`): a partner never
   * changes it, and an event that is or becomes neutral must still be a BDE's, with no co-organiser
   * (the list this write leaves, or the accepted and pending ones it does not touch), no linked form
   * after this write, and no post linking it. Read-only; sets `ev.presentation` once it passes.
   */
  private async assertEventPresentationAfterUpdate(
    manager: EntityManager,
    ev: AssociationCalendarEvent,
    dto: UpdateAssociationCalendarEventDto,
    viaAssociationId: string,
    side: EventWriteSide
  ): Promise<void> {
    const current = ev.presentation ?? AssociationCalendarEventPresentation.Association;
    const next = dto.presentation ?? current;
    if (next !== current && side === 'partner') {
      this.logger.debug(
        `[PERM] partner ${sanitizeLog(viaAssociationId.slice(0, 8))} refused a presentation change on ${sanitizeLog(ev.id.slice(0, 8))}`
      );
      throw partnerOrganiserOnlyRefusal('presentation');
    }
    if (next !== AssociationCalendarEventPresentation.Neutral) {
      ev.presentation = next;
      return;
    }
    const [facts] = (await manager.query(
      `SELECT (SELECT ${isBdeAssociationSql('o')} FROM associations o WHERE o.id = $2)
                AS "ownerIsBde",
              (SELECT count(*)::int FROM association_calendar_event_co_owners co
                WHERE co.event_id = $1)
            + (SELECT count(*)::int FROM proposals p
                WHERE p.kind = 'coorganise' AND p."subjectId" = $1 AND p.status = 'pending')
                AS "partnerCount",
              EXISTS (SELECT 1 FROM posts WHERE posts."linkedCalendarEventId" = $1)
                AS "linkedByPost"`,
      [ev.id, ev.associationId]
    )) as { ownerIsBde: boolean | null; partnerCount: number; linkedByPost: boolean }[];
    const partnerCount =
      dto.coOwnerIds !== undefined
        ? new Set(dto.coOwnerIds.filter((id) => id !== ev.associationId)).size
        : facts.partnerCount;
    const linkedFormId =
      dto.linkedFormId !== undefined ? dto.linkedFormId || null : (ev.linkedFormId ?? null);
    // "Only a BDE files a neutral event" is asked of the TRANSITION to neutral: an event already
    // neutral stays editable by its stewards if its owner has since stopped being a BDE.
    const becomingNeutral = current !== AssociationCalendarEventPresentation.Neutral;
    assertNeutralPresentationAllowed({
      presentation: next,
      ownerIsBde: !becomingNeutral || facts.ownerIsBde === true,
      partnerCount,
      linkedFormId,
      linkedByPost: facts.linkedByPost === true,
    });
    ev.presentation = next;
  }

  /** Marks a pending calendar event as validated (visible on public agenda and feeds). */
  async validateCalendarEvent(associationId: string, eventId: string, userId: string) {
    await this.findById(associationId);
    // Under the event's lock, so a validation never overwrites an edit or an acceptance it did not see.
    const outcome = await this.withEventLock(eventId, async (repo, manager) => {
      const ev = await this.findCalendarEventForAssociation(eventId, associationId, false, repo);
      if (!ev) throw new NotFoundException('Event not found');
      if (ev.status === AssociationCalendarEventStatus.Validated) {
        return { ev, changed: false };
      }
      ev.status = AssociationCalendarEventStatus.Validated;
      ev.validatedAt = new Date();
      ev.validatedBy = userId;
      const saved = await repo.save(ev);
      await announceEventOpening(manager, saved);
      return { ev: saved, changed: true };
    });
    if (!outcome.changed) return this.serializeCalendarEvent(outcome.ev);
    const saved = outcome.ev;
    this.logger.debug(`Event validated: ${saved.id} by ${userId}`);
    // Notify asso admins that their event has been validated
    void this.notifyAssocAdminsOfEventAction(saved.associationId, userId, saved.title, 'validated');
    return this.serializeCalendarEvent(saved);
  }

  /** Rejects a pending calendar event; keeps it visible to asso admins with a reason. */
  async rejectCalendarEvent(
    associationId: string,
    eventId: string,
    userId: string,
    reason?: string
  ) {
    await this.findById(associationId);
    const outcome = await this.withEventLock(eventId, async (repo) => {
      const ev = await this.findCalendarEventForAssociation(eventId, associationId, false, repo);
      if (!ev) throw new NotFoundException('Event not found');
      if (ev.status === AssociationCalendarEventStatus.Rejected) {
        return { ev, changed: false };
      }
      ev.status = AssociationCalendarEventStatus.Rejected;
      ev.rejectedAt = new Date();
      ev.rejectedBy = userId;
      ev.rejectionReason = reason ?? null;
      return { ev: await repo.save(ev), changed: true };
    });
    if (!outcome.changed) return this.serializeCalendarEvent(outcome.ev);
    const saved = outcome.ev;
    this.logger.debug(`Event rejected: ${saved.id} by ${userId}`);
    void this.notifyAssocAdminsOfEventAction(
      saved.associationId,
      userId,
      saved.title,
      'rejected',
      reason
    );
    return this.serializeCalendarEvent(saved);
  }

  /**
   * Deletes a calendar event.
   * Global admins, and a BDE governing the event association (`isBde`, scoped by the controller),
   * may delete an event owned by another association.
   */
  async deleteCalendarEvent(
    associationId: string,
    eventId: string,
    callerOpts?: { isGlobalAdmin?: boolean; isBde?: boolean; callerUserId?: string }
  ) {
    const canCrossAsso = callerOpts?.isGlobalAdmin || callerOpts?.isBde;
    await this.findById(associationId);
    // For BDE cross-asso, find the event first to get its associationId for notifications
    if (canCrossAsso) {
      const ev = await this.calendarRepo.findOne({ where: { id: eventId } });
      if (!ev) throw new NotFoundException('Event not found');
      const targetAssocId = ev.associationId;
      const title = ev.title;
      await this.calendarRepo.delete({ id: eventId });
      this.logger.debug(
        `Event deleted: ${sanitizeLog(eventId)} by ${sanitizeLog(callerOpts?.callerUserId)}`
      );
      if (targetAssocId !== associationId && callerOpts?.callerUserId) {
        void this.notifyAssocAdminsOfEventAction(
          targetAssocId,
          callerOpts.callerUserId,
          title,
          'deleted'
        );
      }
    } else {
      const ev = await this.findCalendarEventForAssociation(eventId, associationId, false);
      if (!ev) throw new NotFoundException('Event not found');
      // E2: only the organiser deletes; a partner withdraws instead (`coOwnerIds` without itself).
      if (eventWriteSide(ev.associationId, associationId, false) === 'partner') {
        this.logger.debug(
          `[PERM] partner ${sanitizeLog(associationId.slice(0, 8))} refused deleting ${sanitizeLog(eventId.slice(0, 8))}`
        );
        throw partnerOrganiserOnlyRefusal('delete');
      }
      await this.calendarRepo.delete({ id: eventId });
      this.logger.debug(
        `Event deleted: ${sanitizeLog(eventId)} by ${sanitizeLog(callerOpts?.callerUserId)}`
      );
    }
    return { ok: true };
  }

  // ── Document vault ────────────────────────────────────────────────────────

  /**
   * Returns the hex-encoded 32-byte vault key for the association, generating
   * and persisting it on first access. The key is the HKDF input key material
   * from which per-document CEKs are derived client-side.
   */
  async getOrCreateVaultKey(associationId: string): Promise<string> {
    const asso = await this.assoRepo.findOne({
      where: { id: associationId },
      select: { id: true, documentVaultKey: true },
    });
    if (!asso) throw new NotFoundException('Association not found');
    if (asso.documentVaultKey) return asso.documentVaultKey;

    const key = randomBytes(32).toString('hex');
    await this.assoRepo.update(associationId, { documentVaultKey: key });
    this.logger.debug(`Vault key generated for association ${sanitizeLog(associationId)}`);
    return key;
  }

  /** Returns the association's vault-encrypted shared notepad ciphertext (empty if unset). */
  async getNotesCiphertext(associationId: string): Promise<string> {
    const asso = await this.assoRepo.findOne({
      where: { id: associationId },
      select: { id: true, notesCiphertext: true },
    });
    if (!asso) throw new NotFoundException('Association not found');
    return asso.notesCiphertext ?? '';
  }

  /** Persists the association's vault-encrypted shared notepad ciphertext. */
  async setNotesCiphertext(associationId: string, ciphertext: string): Promise<void> {
    await this.findById(associationId);
    await this.assoRepo.update(associationId, { notesCiphertext: ciphertext || null });
    this.logger.debug(`Vault notepad updated for association ${sanitizeLog(associationId)}`);
  }

  /** Lists documents in the vault with aggregated usage stats (no mediaId). */
  async listDocuments(associationId: string) {
    await this.findById(associationId);

    const [docs, usedRaw] = await Promise.all([
      this.docRepo.find({
        where: { associationId },
        order: { createdAt: 'DESC' },
        select: {
          id: true,
          associationId: true,
          name: true,
          description: true,
          mimeType: true,
          size: true,
          uploadedBy: true,
          visibility: true,
          originalFilename: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.docRepo
        .createQueryBuilder('d')
        .select('COALESCE(SUM(d.size), 0)', 'total')
        .where('d.associationId = :associationId', { associationId })
        .getRawOne<{ total: string }>(),
    ]);

    const asso = await this.assoRepo.findOne({
      where: { id: associationId },
      select: { documentQuotaBytes: true },
    });
    const quotaBytes = Number(asso?.documentQuotaBytes ?? 524288000);
    const usedBytes = Number(usedRaw?.total ?? 0);

    return {
      documents: docs.map((d) => ({ ...d, size: Number(d.size) })),
      usedBytes,
      quotaBytes,
    };
  }

  /**
   * Registers a new document in the vault.
   * Returns HTTP 409 if a document with the same name (case-insensitive) already exists.
   * Returns HTTP 413 if the upload would exceed the quota.
   */
  async createDocument(associationId: string, dto: CreateAssociationDocumentDto, userId: string) {
    const asso = await this.assoRepo.findOne({
      where: { id: associationId },
      select: { id: true, documentQuotaBytes: true },
    });
    if (!asso) throw new NotFoundException('Association not found');

    // Duplicate name check
    const existing = await this.docRepo
      .createQueryBuilder('d')
      .where('d.associationId = :associationId', { associationId })
      .andWhere('LOWER(d.name) = LOWER(:name)', { name: dto.name })
      .getOne();

    if (existing) {
      throw new ConflictException({
        conflict: true,
        existingDocId: existing.id,
        message: `A document named "${existing.name}" already exists in this vault`,
      });
    }

    // Quota check
    const usedRaw = await this.docRepo
      .createQueryBuilder('d')
      .select('COALESCE(SUM(d.size), 0)', 'total')
      .where('d.associationId = :associationId', { associationId })
      .getRawOne<{ total: string }>();
    const usedBytes = Number(usedRaw?.total ?? 0);
    const quotaBytes = Number(asso.documentQuotaBytes ?? 524288000);

    if (usedBytes + dto.size > quotaBytes) {
      throw new PayloadTooLargeException(
        `Upload would exceed the vault quota (${quotaBytes} bytes). Currently used: ${usedBytes} bytes.`
      );
    }

    const doc = this.docRepo.create({
      associationId,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      mediaId: dto.mediaId,
      mimeType: dto.mimeType,
      size: dto.size,
      uploadedBy: userId,
      // New documents are private until the association explicitly shares them.
      visibility: 'private',
      originalFilename: dto.originalFilename?.trim() || dto.name.trim(),
    });
    const saved = await this.docRepo.save(doc);
    this.logger.debug(
      `Vault document "${sanitizeLog(saved.name)}" (${sanitizeLog(saved.id)}) created for asso ${sanitizeLog(associationId)}`
    );
    // The row is what makes the blob durable, so the row's creation says so to the media service:
    // an installed client too old to send `association` at upload left a vault document on the
    // idle sweep, which is how one was lost on production in 2026-09. Best-effort and logged by the
    // helper - the boot backfill (`AssociationDocumentRetentionService`) re-applies it if it fails.
    await applyMediaRetentionClass(this.httpService, this.logger, [saved.mediaId], 'association');
    return { ...saved, size: Number(saved.size) };
  }

  /** Returns full document detail including mediaId (for download). Requires MANAGE_DOCUMENTS. */
  async getDocumentDetail(associationId: string, docId: string) {
    await this.findById(associationId);
    const doc = await this.docRepo.findOne({ where: { id: docId, associationId } });
    if (!doc) throw new NotFoundException('Document not found');
    return { ...doc, size: Number(doc.size) };
  }

  /** Deletes a document record and attempts to delete the media blob. */
  async deleteDocument(
    associationId: string,
    docId: string,
    authorization: string | undefined
  ): Promise<{ ok: boolean }> {
    await this.findById(associationId);
    const doc = await this.docRepo.findOne({ where: { id: docId, associationId } });
    if (!doc) throw new NotFoundException('Document not found');

    await this.docRepo.delete(docId);
    this.logger.debug(
      `Vault document "${sanitizeLog(doc.name)}" (${sanitizeLog(docId)}) deleted from asso ${sanitizeLog(associationId)}`
    );

    const bearer = authorization?.trim();
    if (bearer?.startsWith('Bearer ')) {
      await this.deleteMediaBestEffort(doc.mediaId, bearer);
    }
    return { ok: true };
  }

  /**
   * Renames a document's display name and/or changes its visibility (private/public).
   * A password-protected document can never be made public: the server lacks the password,
   * so a reviewer could not derive its CEK. Requires MANAGE_DOCUMENTS (enforced by the
   * controller guard). The UI also disables the toggle, but this is the enforcement - and it
   * was dead between 2026-07-24 and 2026-09-10, when the predicate read only the marker
   * syntax the client had stopped writing (`vault-markers.util.ts`).
   */
  async updateDocument(associationId: string, docId: string, dto: UpdateAssociationDocumentDto) {
    await this.findById(associationId);
    const doc = await this.docRepo.findOne({ where: { id: docId, associationId } });
    if (!doc) throw new NotFoundException('Document not found');

    const patch: Partial<AssociationDocument> = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Document name cannot be empty');
      const clash = await this.docRepo
        .createQueryBuilder('d')
        .where('d.associationId = :associationId', { associationId })
        .andWhere('d.id <> :docId', { docId })
        .andWhere('LOWER(d.name) = LOWER(:name)', { name })
        .getOne();
      if (clash) {
        throw new ConflictException(
          `A document named "${clash.name}" already exists in this vault`
        );
      }
      patch.name = name;
    }

    if (dto.visibility !== undefined) {
      if (dto.visibility === 'public' && isPasswordProtected(doc.description)) {
        throw new BadRequestException('A password-protected document cannot be made public');
      }
      patch.visibility = dto.visibility;
    }

    if (Object.keys(patch).length > 0) {
      await this.docRepo.update({ id: docId, associationId }, patch);
      this.logger.debug(
        `Vault document ${sanitizeLog(docId)} updated (${Object.keys(patch).join(', ')})`
      );
    }
    const updated = await this.docRepo.findOne({ where: { id: docId, associationId } });
    return { ...updated!, size: Number(updated!.size) };
  }

  // ── Document reviewers (cross-association public-document access) ────────────

  /**
   * Server-side mirror of the client's `deriveDocumentCek`: derives the 32-byte
   * AES-256-GCM content key for a non password-protected document via
   * HKDF-SHA256(vaultKey, salt=utf8(cekSalt), info="doc-vault"), returned as hex.
   * Used only for documents the association has marked public - the raw vault key
   * (which would unlock every document) is never handed to a reviewer.
   */
  private deriveDocumentCekHex(vaultKeyHex: string, cekSalt: string): string {
    const vaultKey = Buffer.from(vaultKeyHex, 'hex');
    const salt = Buffer.from(cekSalt, 'utf8');
    const info = Buffer.from('doc-vault', 'utf8');
    const derived = hkdfSync('sha256', vaultKey, salt, info, 32);
    return Buffer.from(derived).toString('hex');
  }

  /** True when the user holds a global document-reviewer grant. */
  async isDocumentReviewer(userId: string): Promise<boolean> {
    return (await this.reviewerGrantRepo.count({ where: { userId } })) > 0;
  }

  /** Lists all document-reviewer grants, newest first (admin/BDE management view). */
  async listDocumentReviewers() {
    const grants = await this.reviewerGrantRepo.find({ order: { createdAt: 'DESC' } });
    return grants.map((g) => ({
      userId: g.userId,
      grantedBy: g.grantedBy,
      createdAt: g.createdAt,
    }));
  }

  /** Grants document-reviewer access to a user (idempotent upsert). */
  async addDocumentReviewer(userId: string, grantedBy: string) {
    const target = userId.trim();
    if (!target) throw new BadRequestException('userId is required');
    const existing = await this.reviewerGrantRepo.findOne({ where: { userId: target } });
    if (existing) {
      return {
        userId: existing.userId,
        grantedBy: existing.grantedBy,
        createdAt: existing.createdAt,
      };
    }
    const grant = await this.reviewerGrantRepo.save(
      this.reviewerGrantRepo.create({ userId: target, grantedBy })
    );
    this.logger.debug(
      `Document-reviewer granted to ${sanitizeLog(target)} by ${sanitizeLog(grantedBy)}`
    );
    return { userId: grant.userId, grantedBy: grant.grantedBy, createdAt: grant.createdAt };
  }

  /** Revokes a user's document-reviewer grant. */
  async removeDocumentReviewer(userId: string): Promise<{ ok: boolean }> {
    await this.reviewerGrantRepo.delete({ userId });
    this.logger.debug(`Document-reviewer revoked from ${sanitizeLog(userId)}`);
    return { ok: true };
  }

  /**
   * Returns every association's *public* documents grouped by association, each
   * with a server-derived per-document CEK (hex) so an authorized reviewer can
   * decrypt them client-side. Private and password-protected documents are
   * excluded, and the raw vault key is never exposed.
   */
  async listReviewerDocuments() {
    const docs = await this.docRepo.find({
      where: { visibility: 'public' },
      order: { createdAt: 'DESC' },
    });
    if (docs.length === 0) return [];

    const assoIds = [...new Set(docs.map((d) => d.associationId))];
    const assos = await this.assoRepo.find({
      where: { id: In(assoIds) },
      select: { id: true, name: true, slug: true, logoUrl: true, documentVaultKey: true },
    });
    const assoById = new Map(assos.map((a) => [a.id, a]));

    const groups = new Map<string, ReviewerDocumentGroup>();

    for (const doc of docs) {
      // Every branch below withholds a document its association deliberately marked public, so
      // every one of them ACCUSES. Until 2026-09-10 they were silent `continue`s, and the whole
      // production population (3 of 3 public documents) fell through the salt branch for seven
      // weeks with an empty page as the only symptom.
      const asso = assoById.get(doc.associationId);
      if (!asso?.documentVaultKey) {
        this.logger.warn(
          `Public document ${sanitizeLog(doc.id)} withheld from reviewers: association ${sanitizeLog(doc.associationId)} has no vault key`
        );
        continue;
      }
      const { cekSalt, pwSalt } = parseVaultMarkers(doc.description);
      if (!cekSalt) {
        this.logger.warn(
          `Public document ${sanitizeLog(doc.id)} withheld from reviewers: no CEK salt marker in its description, so no key can be derived - check that the client's marker format still matches vault-markers.util.ts`
        );
        continue;
      }
      // Defensive: `updateDocument` refuses to make a password-protected document public, so
      // reaching this means a row predates that guard or was written around it.
      if (pwSalt) {
        this.logger.warn(
          `Public document ${sanitizeLog(doc.id)} withheld from reviewers: it is password-protected, so its CEK cannot be derived server-side`
        );
        continue;
      }

      if (!groups.has(asso.id)) {
        groups.set(asso.id, {
          associationId: asso.id,
          associationName: asso.name,
          slug: asso.slug,
          logoUrl: asso.logoUrl ?? null,
          documents: [],
        });
      }
      groups.get(asso.id)!.documents.push({
        id: doc.id,
        name: doc.name,
        originalFilename: doc.originalFilename ?? null,
        mimeType: doc.mimeType,
        size: Number(doc.size),
        mediaId: doc.mediaId,
        cek: this.deriveDocumentCekHex(asso.documentVaultKey, cekSalt),
        createdAt: doc.createdAt,
      });
    }

    return [...groups.values()]
      .filter((g) => g.documents.length > 0)
      .sort((a, b) => a.associationName.localeCompare(b.associationName));
  }

  // ── Forms ─────────────────────────────────────────────────────────────────

  /** Returns all forms linked to this association, newest first (for the MANAGE_FORMS tab). */
  async listFormsByAssociation(associationId: string) {
    const asso = await this.findById(associationId);
    // The WHOLE form, as the managers' list reads it (`FormsService.list`): the unified forms list
    // draws the export menu, the responses accordion and the preview link from it, so a global
    // admin's tab and a manager's `/forms` carry the same row. An archived form is in no list.
    const forms = await this.formRepo.find({
      where: { associationId, deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    const changed = await formsWithUnpublishedChanges(
      this.formRepo.manager,
      forms.map((f) => f.id)
    );
    return forms.map((form) => ({
      ...form,
      associationName: asso.name,
      hasUnpublishedChanges: changed.has(form.id),
    }));
  }

  // ── Lydia helpers ────────────────────────────────────────────────────────
  // The payout account columns: `lydiaAccountId` and `lydiaOnboardingComplete` - THE ACTIVE
  // collecting Business. A bridge's other Business lives in `lydia_account_bridges`
  // (lydia-account-bridge.ts). The historic `stripe*` pair is no longer mapped
  // (docs/wiki/stripe-archive.md).

  /**
   * Links the Business `business/create` just made to an association: its vendor_token, its
   * dashboard URL and its private token, each handed out ONCE by Lydia (core-service has already
   * had the token confirmed by Lydia's `auth/vendortoken`). The private token is stored encrypted
   * (`secret-box.ts`), bound to this association and this vendor token, never logged - the one way
   * a key is written since the paste route was retired.
   *
   * ONE transaction holding the association row's lock, and only onto an association whose
   * managers hold NO Business: a second onboarding is a typed 409 `LYDIA_ACCOUNT_ALREADY_LINKED`,
   * never a silent replacement - two concurrent onboardings cannot both win. An association whose
   * HISTORICAL account collects (a bridge, lydia-account-bridge.ts) gets the new Business as its
   * PENDING one, in the bridge row: it collects only once Lydia validates it.
   */
  async setLydiaAccountId(
    id: string,
    lydiaAccountId: unknown,
    lydiaDashboardUrl: unknown,
    businessPrivateToken: unknown
  ): Promise<void> {
    const vendorToken = typeof lydiaAccountId === 'string' ? lydiaAccountId.trim() : '';
    const key = typeof businessPrivateToken === 'string' ? businessPrivateToken.trim() : '';
    const dashboardUrl =
      typeof lydiaDashboardUrl === 'string' && lydiaDashboardUrl ? lydiaDashboardUrl : null;
    if (!vendorToken || !LYDIA_BUSINESS_KEY_RE.test(key)) {
      this.logger.warn(
        `[LYDIA] Business link refused on association ${sanitizeLog(id)}: ` +
          `${vendorToken ? 'no usable private token' : 'no vendor token'}`
      );
      throw new BadRequestException(
        'A Lydia Business link needs its vendor token and private token'
      );
    }
    if (!isSecretBoxConfigured()) {
      this.logger.error(
        `[LYDIA] Business link refused on association ${sanitizeLog(id)}: LYDIA_KEY_ENCRYPTION_SECRET is not configured`
      );
      throw new ServiceUnavailableException('Business key storage is not configured');
    }
    // Only an association holds a Business of its own: a list collects through a delegate, an
    // institution not at all. An absent row is left to the UPDATE below (404).
    const target = await this.assoRepo.findOne({ where: { id }, select: { id: true, type: true } });
    if (target) assertMayHoldOwnAccount(this.logger, id, target.type, 'Lydia account link');
    const sealed = sealSecret(
      LYDIA_BUSINESS_KEY_PURPOSE,
      lydiaBusinessKeyContext(id, vendorToken),
      key
    );
    // The association row locked, then its bridge: the order of every bridge transition.
    const linked = await this.assoRepo.manager.transaction(
      async (manager): Promise<'missing' | 'taken' | 'active' | 'pending'> => {
        const [row]: Array<{
          active: string | null;
          state: LydiaBridgeState | null;
          enrolled: string | null;
        }> = await manager.query(
          `SELECT a."lydiaAccountId" AS active, b.state, b."enrolledVendorToken" AS enrolled
             FROM associations a ${bridgeJoinSql()} WHERE a.id = $1 FOR UPDATE OF a`,
          [id]
        );
        if (!row) return 'missing';
        if (row.state === 'historical') {
          // A historical account collects: the new Business waits, PENDING, for Lydia's
          // validation (lydia-account-bridge.ts); it never collects before it.
          if (row.enrolled) return 'taken';
          await manager.query(
            `UPDATE lydia_account_bridges
                SET "enrolledVendorToken" = $2, "standbyKeyCiphertext" = $3,
                    "standbyDashboardUrl" = $4, "standbyReady" = false,
                    "standbyReadinessCause" = NULL, "standbyReadinessAt" = NULL
              WHERE "associationId" = $1 AND state = 'historical' AND "enrolledVendorToken" IS NULL`,
            [id, vendorToken, sealed, dashboardUrl]
          );
          await manager.query(
            `UPDATE associations SET "lydiaEnrolmentStartedAt" = NULL, "lydiaEnrolmentVendorToken" = NULL
              WHERE id = $1`,
            [id]
          );
          await recordEnrolledBusiness(
            (sql, params) => manager.query(sql, params),
            id,
            vendorToken
          );
          return 'pending';
        }
        if (row.active) return 'taken';
        await manager.query(
          `UPDATE associations
              SET "lydiaAccountId" = $2,
                  "lydiaDashboardUrl" = COALESCE($3, "lydiaDashboardUrl"),
                  "lydiaBusinessKeyCiphertext" = $4,
                  "lydiaEnrolmentStartedAt" = NULL,
                  "lydiaEnrolmentVendorToken" = NULL
            WHERE id = $1`,
          [id, vendorToken, dashboardUrl, sealed]
        );
        await recordEnrolledBusiness((sql, params) => manager.query(sql, params), id, vendorToken);
        return 'active';
      }
    );
    if (linked === 'missing') throw new NotFoundException('Association not found');
    if (linked === 'taken') {
      this.logger.warn(
        `[LYDIA] Business link refused on association ${sanitizeLog(id)}: a Business is already linked`
      );
      throw new ConflictException({
        code: LYDIA_ACCOUNT_ALREADY_LINKED,
        message: 'A Lydia Business is already linked to this association',
      });
    }
    if (linked === 'pending') {
      this.logger.log(
        `[AUDIT] ${LYDIA_BRIDGE_LOG_TAG} Lydia Business linked on association ${sanitizeLog(id)} as ` +
          `the PENDING Business of its bridge, its key SET at creation; the historical account ` +
          `collects until Lydia validates it`
      );
      return;
    }
    this.logger.log(
      `[AUDIT] Lydia Business linked on association ${sanitizeLog(id)}, its key SET at creation`
    );
    await this.invalidatePostListCaches();
  }

  /**
   * Which association holds `vendorToken`, whether that Business is marked ready, and its role
   * (`active`, or a bridge's `pending` / `retired` standby Business) - for the log line of Lydia's
   * UNSIGNED business webhook (core-service). A SELECT and nothing else: the webhook decides
   * nothing. Null when none holds it, or when two do (refused, not guessed).
   */
  async lydiaBusinessOfVendorToken(vendorToken: string): Promise<{
    associationId: string;
    onboardingComplete: boolean;
    role: HeldBusinessRole;
  } | null> {
    if (!vendorToken) return null;
    const rows: Array<{ id: string; ready: boolean; role: HeldBusinessRole }> =
      await this.assoRepo.query(
        `SELECT h."associationId" AS id, h.ready, h.role FROM ${HELD_BUSINESSES_SQL} h
          WHERE h."vendorToken" = $1`,
        [vendorToken]
      );
    if (rows.length !== 1) {
      if (rows.length > 1) {
        this.logger.error(
          `[LYDIA] ${rows.length} Businesses of ours hold ONE vendor token ` +
            `(${rows.map((r) => `${sanitizeLog(r.id)} ${r.role}`).join(', ')}) - a Business is one association's`
        );
      }
      return null;
    }
    return {
      associationId: rows[0].id,
      onboardingComplete: rows[0].ready === true,
      role: rows[0].role,
    };
  }

  /**
   * The payout account of an association, for its MANAGE_PAYOUT_ACCOUNT holders only (the
   * controller checks): the Business columns, the confirmed Responsable of the CURRENT Business
   * (name, the phone's last two digits and whether Lydia confirmed it, never more), the last
   * readiness change and the two in-flight markers - ONE read the payments screen draws every step
   * from.
   *
   * The Business is the one the managers MANAGE (`managedVendorTokenSql`): on a bridge whose
   * historical account collects, the enrolled Business - drawn not ready, with no readiness change,
   * while Lydia has not validated it - or none before the enrolment; the historical account is
   * never shown to them (owner, 2026-11-13). A global admin also reads `bridge`, both states.
   */
  async getPayoutAccount(
    id: string,
    opts: { isGlobalAdmin?: boolean } = {}
  ): Promise<AssociationPayoutAccount> {
    const [row]: Array<{
      active: string | null;
      activeUrl: string | null;
      activeReady: boolean;
      activeCause: LydiaReadinessCause | null;
      activeAt: Date | string | null;
      enrolmentStartedAt: Date | string | null;
      responsableStartedAt: Date | string | null;
      state: LydiaBridgeState | null;
      enrolled: string | null;
      standbyUrl: string | null;
      standbyReady: boolean | null;
      switchedAt: Date | string | null;
      switchCount: number | null;
      switchBackCount: number | null;
      reissueCount: number | null;
    }> = await this.assoRepo.query(
      `SELECT a."lydiaAccountId" AS active, a."lydiaDashboardUrl" AS "activeUrl",
              a."lydiaOnboardingComplete" AS "activeReady", a."lydiaReadinessCause" AS "activeCause",
              a."lydiaReadinessAt" AS "activeAt", a."lydiaEnrolmentStartedAt" AS "enrolmentStartedAt",
              a."lydiaResponsableStartedAt" AS "responsableStartedAt", b.state,
              b."enrolledVendorToken" AS enrolled, b."standbyDashboardUrl" AS "standbyUrl",
              b."standbyReady" AS "standbyReady", b."switchedAt" AS "switchedAt",
              b."switchCount" AS "switchCount", b."switchBackCount" AS "switchBackCount",
              b."reissueCount" AS "reissueCount"
         FROM associations a ${bridgeJoinSql()} WHERE a.id = $1`,
      [id]
    );
    if (!row) throw new NotFoundException('Association not found');
    const historicalCollects = row.state === 'historical';
    const business = historicalCollects ? row.enrolled : row.active;
    const iso = (at: Date | string | null) => (at ? new Date(at).toISOString() : null);
    const responsable = business ? await this.lydiaResponsableOf(id, business) : null;
    const cashiers = business
      ? await listLydiaCashiers((sql, params) => this.assoRepo.query(sql, params), id, business)
      : [];
    return {
      lydiaAccountId: business,
      lydiaDashboardUrl: historicalCollects ? row.standbyUrl : row.activeUrl,
      // A pending Business is not validated, whatever the historical account's state.
      lydiaOnboardingComplete: historicalCollects ? false : row.activeReady,
      responsable,
      cashiers,
      readiness:
        !historicalCollects && row.activeCause && row.activeAt
          ? { cause: row.activeCause, at: iso(row.activeAt) as string }
          : null,
      enrolmentInFlightSince: iso(row.enrolmentStartedAt),
      responsableInFlightSince: iso(row.responsableStartedAt),
      ...(opts.isGlobalAdmin && row.state
        ? {
            bridge: {
              state: row.state,
              historicalReady: historicalCollects ? row.activeReady : row.standbyReady === true,
              enrolledLinked: row.enrolled !== null,
              switchedAt: iso(row.switchedAt),
              switchCount: row.switchCount ?? 0,
              switchBackCount: row.switchBackCount ?? 0,
              reissueCount: row.reissueCount ?? 0,
            },
          }
        : {}),
    };
  }

  /**
   * THE ONE WRITER OF `lydiaOnboardingComplete` (lot 2): turns the HOLDER of `vendorToken` ready or
   * not, in ONE transaction.
   *
   * The holder's row is locked, then `UPDATE ... WHERE "lydiaOnboardingComplete" <> $ready
   * RETURNING id`: the returned row IS the transition, so idempotence comes from durable state - a
   * replayed webhook, a second refusal or a double admin click finds the flag already set and writes
   * nothing but, for a second refusal naming ANOTHER cause (5 then 2701), the cause and its date.
   * Going to false, the same transaction withholds the on-sale products of the holder and of its
   * approved delegating children (`approvedDelegateIds`, the release's own predicate):
   * `isActive=false, activationWithheld=true`, the exact inverse of the release; a product a
   * manager took off sale is not touched, so it is never released later either. The same
   * transaction writes a bell row to every global admin (`LYDIA_PAYMENTS_PAUSED_TYPE`, no push),
   * so the revert is a report a person sees, whatever the managers' switch says.
   *
   * An UNSIGNED `webhook-validated` never clears a holder Lydia itself reported (`request-refused`,
   * `request-blocked`): that is the global admin's `admin` call alone (`held-by-lydia`, a WARN).
   *
   * Going to true, the SAME transaction releases the withheld products of the holder (when it
   * collects on its own account) and of its approved delegates (`releaseWithheldProductsOf`), a
   * replay included, so a commit never leaves one withheld. Only a transition
   * logs loudly and notifies the payout managers; a replay is a debug line. No holder, or two
   * (refused, never guessed), writes nothing; no holder for the token a pending `business/create` answered (`lydiaEnrolmentVendorToken`) is
   * `no-holder-enrolment-in-flight`, which the webhook route answers 503 so Lydia retries.
   *
   * THE BRIDGE (owner, 2026-11-13; lydia-account-bridge.ts) adds two transitions, in the same
   * transaction and under the same lock (the association row, then its bridge row):
   * - `ready` for the ENROLLED Business of a bridge whose historical account collects SWITCHES it in
   *   (`swapBridge`), then runs the ordinary transition on it - so the release, the managers'
   *   "active" notice and the replay rule are the ones above, and the held-by-lydia rule is skipped
   *   for it: a later VALIDATED switches again (the owner's decision). The delegates are told only
   *   when their collecting changed (the historical account was not ready);
   * - `request-refused` (error 5) on the Business a switch made active SWITCHES BACK to the
   *   historical account (`switched-back`), with a bell row to every global admin; the caller
   *   re-issues the same payment on it once. A 2701 is the ordinary revert (a pause): routing around
   *   Lydia's block onto another account is not the bridge's to decide.
   */
  async setLydiaReadiness(
    vendorToken: string,
    ready: boolean,
    cause: LydiaReadinessCause,
    ref: LydiaReadinessRef
  ): Promise<LydiaReadinessOutcome> {
    const where = `${ref.path}${ref.id ? ` ${sanitizeLog(ref.id)}` : ''}`;
    this.logger.debug(
      `${LYDIA_READINESS_LOG_TAG} set ready=${ready} cause=${cause} asked by ${where}`
    );
    type Holder = LydiaReadinessHolder;
    type Step =
      | { kind: 'none'; inFlight: boolean }
      | { kind: 'held'; holder: Holder }
      | { kind: 'standby-refused'; associationId: string }
      | {
          kind: 'standby-held';
          associationId: string;
          cause: LydiaReadinessCause;
          at: Date | string | null;
        }
      | ({ kind: 'switched-back'; holder: Holder } & BridgeSwitchBack)
      | {
          kind: 'done';
          holder: Holder;
          transitioned: boolean;
          causeRefreshed: boolean;
          withheld: number;
          admins: number;
          /** The approved delegates, read share-locked in the readiness transaction. */
          delegates: string[];
          /** Per approved delegate, what was withheld (going not ready) or released (ready). */
          delegatesWithheld: Map<string, number>;
          delegatesReleased: Map<string, number>;
          /** Set when this transaction switched a bridge in: whether the historical was ready. */
          switched: { historicalWasReady: boolean; switchCount: number } | null;
        };
    const step: Step = await this.assoRepo.manager.transaction(async (manager): Promise<Step> => {
      const selectHolders = (): Promise<Holder[]> =>
        manager.query(
          `SELECT id, name, "lydiaOnboardingComplete" AS ready, "lydiaReadinessCause" AS cause,
                  "lydiaReadinessAt" AS at, type, "paymentDelegationStatus",
                  "paymentParentAssociationId"
             FROM associations WHERE "lydiaAccountId" = $1 FOR UPDATE`,
          [vendorToken]
        );
      let holders = await selectHolders();
      let switched: { historicalWasReady: boolean; switchCount: number } | null = null;
      if (holders.length === 0) {
        // Not an ACTIVE Business: perhaps the standby of a bridge (lydia-account-bridge.ts).
        const standby = await this.standbyReadinessStep(manager, vendorToken, ready, cause, where);
        if (standby.kind === 'switched') {
          switched = standby;
          holders = await selectHolders();
        } else if (standby.kind === 'now-active') {
          // A concurrent switch committed it into the association's columns meanwhile.
          holders = await selectHolders();
        } else if (standby.kind === 'refused') {
          return { kind: 'standby-refused', associationId: standby.associationId };
        } else if (standby.kind === 'held') {
          return {
            kind: 'standby-held',
            associationId: standby.associationId,
            cause: standby.cause,
            at: standby.at,
          };
        }
      }
      if (holders.length !== 1) {
        if (holders.length > 1) {
          this.logger.error(
            `${LYDIA_READINESS_LOG_TAG} ${holders.length} associations hold ONE vendor token ` +
              `(${holders.map((h) => sanitizeLog(h.id)).join(', ')}) - nothing written (${where})`
          );
          return { kind: 'none', inFlight: false };
        }
        // Only the token a `business/create` answered and that is not linked YET may be retried
        // (`lydiaEnrolmentVendorToken`): any other unknown token is a 200, so one stuck enrolment
        // never turns every unknown token into a retry.
        const [{ n }]: Array<{ n: number }> = await manager.query(
          `SELECT count(*)::int AS n FROM associations WHERE "lydiaEnrolmentVendorToken" = $1`,
          [vendorToken]
        );
        this.logger.warn(
          `${LYDIA_READINESS_LOG_TAG} no association holds the vendor token - nothing written ` +
            `(${where})${n > 0 ? "; it is a pending enrolment's, a retry is asked for" : ''}`
        );
        return { kind: 'none', inFlight: n > 0 };
      }
      const [holder] = holders;
      if (!ready && cause === 'request-refused') {
        const back = await this.switchBackOnRefusal(manager, holder, vendorToken, where);
        if (back) return { kind: 'switched-back', holder, ...back };
      }
      if (
        !switched &&
        ready &&
        cause === 'webhook-validated' &&
        !holder.ready &&
        (holder.cause === 'request-refused' || holder.cause === 'request-blocked')
      ) {
        return { kind: 'held', holder };
      }
      const updated: unknown[] = await manager.query(
        `UPDATE associations
            SET "lydiaOnboardingComplete" = $2, "lydiaReadinessCause" = $3, "lydiaReadinessAt" = now()
          WHERE id = $1 AND "lydiaOnboardingComplete" <> $2
          RETURNING id`,
        [holder.id, ready, cause]
      );
      // node-postgres answers an UPDATE ... RETURNING through TypeORM as [rows, count].
      const rows = Array.isArray(updated[0]) ? (updated[0] as unknown[]) : updated;
      const transitioned = rows.length > 0;
      let causeRefreshed = false;
      if (!transitioned && !ready && holder.cause !== cause) {
        // Already not ready, for another reason (5 then 2701): the cause follows Lydia's latest
        // answer, with no transition and no second notice.
        await manager.query(
          `UPDATE associations SET "lydiaReadinessCause" = $2, "lydiaReadinessAt" = now() WHERE id = $1`,
          [holder.id, cause]
        );
        causeRefreshed = true;
      }
      let withheld = 0;
      let admins = 0;
      let delegatesWithheld = new Map<string, number>();
      let delegatesReleased = new Map<string, number>();
      const delegateIds = await approvedDelegateIds(manager, holder.id);
      if (transitioned && !ready) {
        const byId = await withholdOnSaleProductsOf(manager, [holder.id, ...delegateIds]);
        withheld = [...byId.values()].reduce((sum, n) => sum + n, 0);
        delegatesWithheld = new Map([...byId].filter(([id]) => id !== holder.id));
        admins = await this.reportRevertToGlobalAdmins(manager, holder, cause, where);
      }
      if (ready) {
        // The release is the SAME transaction as the readiness (owner review of #2967): a commit
        // never leaves a product withheld. The holder's own products only when it collects on its
        // own account (it does not itself delegate); every approved delegate's, which route here.
        const selfRouted = holdsOwnAccount(holder.type) && !isDelegating(holder);
        const byId = await releaseWithheldProductsOf(manager, [
          ...(selfRouted ? [holder.id] : []),
          ...delegateIds,
        ]);
        delegatesReleased = new Map([...byId].filter(([id]) => id !== holder.id));
        const released = [...byId.values()].reduce((sum, n) => sum + n, 0);
        if (released > 0) {
          this.logger.log(
            `${LYDIA_READINESS_LOG_TAG} holder ${sanitizeLog(holder.id)} ready: ${released} ` +
              `withheld product(s) released with it (${delegatesReleased.size} delegate(s))`
          );
        }
      }
      return {
        kind: 'done',
        holder,
        transitioned,
        causeRefreshed,
        withheld,
        admins,
        delegates: delegateIds,
        delegatesWithheld,
        delegatesReleased,
        switched,
      };
    });
    if (step.kind === 'none') {
      return { kind: step.inFlight ? 'no-holder-enrolment-in-flight' : 'no-holder' };
    }
    if (step.kind === 'standby-held') {
      // Lydia's own refusal of the enrolled Business is on record: an UNSIGNED VALIDATED does not
      // clear it (the held-by-lydia rule, applied to the standby). A global admin switches by hand.
      this.logger.warn(
        `${LYDIA_BRIDGE_LOG_TAG} association ${sanitizeLog(step.associationId)}: an unsigned ` +
          `BUSINESS_VALIDATED does not switch onto its enrolled Business, which Lydia itself ` +
          `refused (${step.cause}) - nothing written (${where}); a global admin re-checks and ` +
          `validates by hand`
      );
      return {
        kind: 'held-by-lydia',
        associationId: step.associationId,
        previousCause: step.cause,
        previousAt: step.at ? new Date(step.at) : null,
      };
    }
    if (step.kind === 'standby-refused') {
      // A request decided while the enrolled Business was active, answered after a concurrent
      // error 5 switched the bridge back: the historical account collects, the payment goes there.
      return { kind: 'switched-back', associationId: step.associationId, already: true };
    }
    if (step.kind === 'switched-back') {
      await this.afterSwitchBack(step.holder, step, where);
      return { kind: 'switched-back', associationId: step.holder.id, already: false };
    }
    const { holder } = step;
    const previousAt = holder.at ? new Date(holder.at) : null;
    const previous = { associationId: holder.id, previousCause: holder.cause, previousAt };
    if (step.kind === 'held') {
      this.logger.warn(
        `${LYDIA_READINESS_LOG_TAG} holder ${sanitizeLog(holder.id)}: an unsigned BUSINESS_VALIDATED ` +
          `does not clear Lydia's own ${holder.cause} (${where}) - nothing written; a global admin ` +
          `re-checks and validates by hand`
      );
      return { kind: 'held-by-lydia', ...previous };
    }
    const {
      transitioned,
      causeRefreshed,
      withheld,
      admins,
      delegates,
      delegatesWithheld,
      delegatesReleased,
      switched,
    } = step;
    if (switched) {
      this.logger.warn(
        `${LYDIA_BRIDGE_LOG_TAG} association ${sanitizeLog(holder.id)} SWITCHED to its enrolled ` +
          `Business by ${cause} (${where}), switch #${switched.switchCount}: the historical account ` +
          `stops collecting and is kept to refund the payments it took (it was ` +
          `${switched.historicalWasReady ? 'ready' : 'NOT ready'})`
      );
    }
    // Those who collect THROUGH this holder (a list paid by delegation) collect again exactly when
    // the holder TRANSITIONS to ready - they route through it - whatever products they have (a
    // forms-only list included). A replay changes nobody's collecting, so it tells nobody; nor does
    // a bridge switch from a historical account that was collecting already.
    if (transitioned && ready && !(switched && switched.historicalWasReady)) {
      await this.tellDelegates(delegates, 'resumed', 'receiver ready', delegatesReleased);
    }
    if (!transitioned) {
      this.logger.debug(
        `${LYDIA_READINESS_LOG_TAG} holder ${sanitizeLog(holder.id)} already ready=${ready} - replay ` +
          `of ${cause} (${where})${causeRefreshed ? `, cause updated from ${holder.cause ?? 'none'}` : ', nothing written'}`
      );
      return { kind: 'replay', ...previous };
    }
    const before = `${holder.cause ?? 'nothing recorded'} at ${previousAt ? previousAt.toISOString() : 'no date'}`;
    const switchedOff = this.lydiaNotifier.enabled()
      ? ''
      : ' - managers NOT notified, LYDIA_PAYMENTS_NOTIFICATIONS_ENABLED is off';
    if (ready) {
      this.logger.warn(
        `${LYDIA_READINESS_LOG_TAG} holder ${sanitizeLog(holder.id)} marked READY by ${cause} ` +
          `(${where}); before: ${before}${switchedOff}`
      );
    } else {
      this.logger.error(
        `${LYDIA_READINESS_LOG_TAG} holder ${sanitizeLog(holder.id)} reverted: request/do answered ` +
          `error ${cause === 'request-blocked' ? '2701' : '5'} (${where}); it had been marked ready ` +
          `by ${before}; ${withheld} on-sale product(s) withheld; ${admins} global admin(s) told` +
          switchedOff
      );
    }
    await this.invalidatePostListCaches();
    if (switched) {
      // A switch is believed on an UNSIGNED webhook: the managers are told "active" once the
      // enrolled Business has PROVEN itself - the first request/do Lydia issues on it
      // (`noteLydiaRequestIssued`) - never on the switch, which a forged VALIDATED can make.
      this.logger.debug(
        `${LYDIA_BRIDGE_LOG_TAG} association ${sanitizeLog(holder.id)}: managers told "active" ` +
          `at the first request Lydia issues on the switched-to Business`
      );
    } else {
      await this.tellPayoutManagers(holder, ready ? 'active' : 'paused');
    }
    // Those who collect THROUGH this holder stop collecting with it (owner, 2026-11-02), products
    // or none - their paid forms pause too.
    if (!ready) {
      await this.tellDelegates(
        delegates,
        'receiver-not-ready',
        'receiver readiness reverted',
        delegatesWithheld
      );
    }
    return {
      kind: 'transitioned',
      ...previous,
      ...(switched ? { bridgeSwitched: true as const } : {}),
    };
  }

  /** The payout managers' Lydia notice; a failure is said, never retried (the state is committed). */
  private async tellPayoutManagers(
    holder: { id: string; name: string },
    kind: 'active' | 'paused'
  ): Promise<void> {
    try {
      const recipients = await this.listFlagHolders(
        holder.id,
        AssociationPermissionFlag.MANAGE_PAYOUT_ACCOUNT
      );
      await this.lydiaNotifier.tell({ id: holder.id, name: holder.name }, kind, recipients);
    } catch (err: unknown) {
      this.logger.error(
        `${LYDIA_READINESS_LOG_TAG} holder ${sanitizeLog(holder.id)}: the managers' notice could not ` +
          `be written: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * The readiness step for a token NO association holds as its active Business: the standby of a
   * bridge, read with the association locked first and its bridge after (the order of every bridge
   * transition). `ready` for the ENROLLED Business while the historical account collects switches it
   * in (`swapBridge`), keeping the historical account's readiness in the standby columns so a switch
   * back restores it. A refusal naming it (the enrolled Business is pending again: a request decided
   * while it was active, answered after a concurrent switch back) is `refused`: the caller re-issues
   * on the historical account, counted. Anything else is `none` and the ordinary no-holder answer.
   */
  private async standbyReadinessStep(
    manager: EntityManager,
    vendorToken: string,
    ready: boolean,
    cause: LydiaReadinessCause,
    where: string
  ): Promise<
    | { kind: 'none' }
    | { kind: 'now-active' }
    | { kind: 'refused'; associationId: string }
    | { kind: 'held'; associationId: string; cause: LydiaReadinessCause; at: Date | string | null }
    | { kind: 'switched'; historicalWasReady: boolean; switchCount: number }
  > {
    const associationId = await bridgeOfEnrolled(manager, vendorToken);
    if (!associationId) return { kind: 'none' };
    const [active]: Array<{ ready: boolean; cause: LydiaReadinessCause | null; at: Date | null }> =
      await manager.query(
        `SELECT "lydiaOnboardingComplete" AS ready, "lydiaReadinessCause" AS cause,
                "lydiaReadinessAt" AS at
           FROM associations WHERE id = $1 FOR UPDATE`,
        [associationId]
      );
    const bridge = await lockBridge(manager, associationId);
    if (!active || !bridge || bridge.enrolledVendorToken !== vendorToken) return { kind: 'none' };
    if (bridge.state === 'switched') return { kind: 'now-active' };
    if (!ready) {
      if (cause !== 'request-refused') {
        // 2701 on the enrolled Business after a switch back: recorded on it, nothing re-issued.
        await manager.query(
          `UPDATE lydia_account_bridges SET "standbyReadinessCause" = $2, "standbyReadinessAt" = now()
            WHERE "associationId" = $1`,
          [associationId, cause]
        );
        this.logger.warn(
          `${LYDIA_BRIDGE_LOG_TAG} association ${sanitizeLog(associationId)}: ${cause} on its ` +
            `enrolled Business, pending again since a switch back (${where}) - recorded on it, ` +
            `nothing re-issued`
        );
        return { kind: 'none' };
      }
      await this.countBridgeReissue(manager, associationId);
      this.logger.warn(
        `${LYDIA_BRIDGE_LOG_TAG} association ${sanitizeLog(associationId)}: error 5 on its enrolled ` +
          `Business, already switched back by a concurrent refusal (${where}) - the payment is ` +
          `re-issued on the historical account`
      );
      return { kind: 'refused', associationId };
    }
    const lydiaRefusedIt =
      bridge.standbyReadinessCause === 'request-refused' ||
      bridge.standbyReadinessCause === 'request-blocked';
    if (lydiaRefusedIt && cause !== 'admin') {
      // Lydia itself answered error 5 or 2701 for this Business (a switch back, or a block recorded
      // on it since): an unsigned VALIDATED does not overrule Lydia - otherwise a stream of forged
      // ones re-switches after every switch back. Only a global admin, who re-checked with Lydia,
      // switches it (the same rule `held-by-lydia` applies to an active Business).
      return {
        kind: 'held',
        associationId,
        cause: bridge.standbyReadinessCause as LydiaReadinessCause,
        at: bridge.standbyReadinessAt,
      };
    }
    await swapBridge(manager, bridge, 'switched', {
      ready: active.ready,
      cause: active.cause,
      at: active.at,
    });
    return {
      kind: 'switched',
      historicalWasReady: active.ready,
      switchCount: bridge.switchCount + 1,
    };
  }

  /**
   * Lydia answered error 5 for the Business a bridge switch made ACTIVE (the holder is locked by the
   * caller): switches BACK to the historical account, in the caller's transaction (the bridge row
   * locked after the association). The enrolled Business returns to the standby columns NOT ready,
   * cause `request-refused`, so the managers see it waiting for Lydia again and a later VALIDATED
   * switches again. The historical account comes back with the readiness it had at the switch: not
   * ready, the holder's and its delegates' on-sale products are withheld as a revert does. Every
   * global admin gets the revert's bell row, marked `bridge: switched-back`. Null when the holder is
   * on no bridge, or its active Business is not the bridge's enrolled one: the ordinary revert.
   */
  private async switchBackOnRefusal(
    manager: EntityManager,
    holder: LydiaReadinessHolder,
    vendorToken: string,
    where: string
  ): Promise<BridgeSwitchBack | null> {
    const bridge = await lockBridge(manager, holder.id);
    if (!bridge || bridge.state !== 'switched' || bridge.enrolledVendorToken !== vendorToken) {
      return null;
    }
    await swapBridge(manager, bridge, 'historical', {
      ready: false,
      cause: 'request-refused',
      at: null,
    });
    await this.countBridgeReissue(manager, holder.id);
    const historicalReady = bridge.standbyReady;
    const wasProven = bridge.enrolledProvenAt != null;
    const delegates = await approvedDelegateIds(manager, holder.id);
    let delegatesWithheld = new Map<string, number>();
    let withheld = 0;
    if (!historicalReady) {
      const byId = await withholdOnSaleProductsOf(manager, [holder.id, ...delegates]);
      withheld = [...byId.values()].reduce((sum, n) => sum + n, 0);
      delegatesWithheld = new Map([...byId].filter(([id]) => id !== holder.id));
    }
    const admins = await this.reportRevertToGlobalAdmins(
      manager,
      holder,
      'request-refused',
      where,
      'switched-back'
    );
    return {
      historicalReady,
      switchBackCount: bridge.switchBackCount + 1,
      wasProven,
      withheld,
      admins,
      delegates,
      delegatesWithheld,
    };
  }

  /** Counts one payment re-issued on a bridge's historical account (`reissueCount`, migration 167). */
  private async countBridgeReissue(manager: EntityManager, associationId: string): Promise<void> {
    await manager.query(
      `UPDATE lydia_account_bridges SET "reissueCount" = "reissueCount" + 1 WHERE "associationId" = $1`,
      [associationId]
    );
  }

  /**
   * What a switch back owes once committed: its ERROR line (the cause, the count, and that the
   * payment is re-issued by the owner's decision, never a fallback), and - only when the historical
   * account comes back NOT ready, so nothing collects now - the managers' pause and the delegates'
   * notice, as a revert would.
   */
  private async afterSwitchBack(
    holder: LydiaReadinessHolder,
    back: BridgeSwitchBack,
    where: string
  ): Promise<void> {
    this.logger.error(
      `${LYDIA_BRIDGE_LOG_TAG} association ${sanitizeLog(holder.id)} switched BACK to its ` +
        `historical account: request/do answered error 5 on the enrolled Business a switch had made ` +
        `active (${where}); switch back #${back.switchBackCount}; the SAME payment is re-issued on ` +
        `the historical account (the owner's decision for this bridge, 2026-11-13 - not a fallback); ` +
        `the historical account is ${back.historicalReady ? 'ready' : `NOT ready, ${back.withheld} on-sale product(s) withheld`}; ` +
        `${back.admins} global admin(s) told`
    );
    await this.invalidatePostListCaches();
    // The managers manage the ENROLLED Business: told "active" once it proved itself, they are owed
    // the counter-notice now that it waits for Lydia again; and when nothing collects at all.
    if (back.wasProven || !back.historicalReady) {
      await this.tellPayoutManagers(holder, 'paused');
    }
    if (!back.historicalReady) {
      await this.tellDelegates(
        back.delegates,
        'receiver-not-ready',
        'bridge switched back to a historical account that is not ready',
        back.delegatesWithheld
      );
    }
  }

  /**
   * The report a revert owes a PERSON: one bell row per global admin (`users.admin`), type
   * `LYDIA_PAYMENTS_PAUSED_TYPE`, written in the revert's own transaction so the state and its
   * report commit together, and never pushed. Unlike the managers' notice it is not behind
   * `LYDIA_PAYMENTS_NOTIFICATIONS_ENABLED`: the web client renders the type now, and an older native
   * build shows the neutral unknown-type row, which still names the association. Answers how many
   * admins were told; zero is said at ERROR by the caller's line. `bridge` marks a bridge's switch
   * back (`meta.bridge`), which a current client words as such - payments did not stop.
   */
  private async reportRevertToGlobalAdmins(
    manager: EntityManager,
    holder: { id: string; name: string },
    cause: LydiaReadinessCause,
    where: string,
    bridge?: 'switched-back'
  ): Promise<number> {
    const admins: Array<{ id: string }> = await manager.query(
      `SELECT id FROM users WHERE admin = true`
    );
    if (admins.length === 0) return 0;
    await manager.save(
      PostNotification,
      admins.map(({ id }) =>
        manager.create(PostNotification, {
          recipientId: id,
          type: LYDIA_PAYMENTS_PAUSED_TYPE,
          postId: holder.id,
          actorId: 'system',
          actorName: SYSTEM_ACTOR_NAME,
          associationId: null,
          associationLogoUrl: null,
          text: holder.name,
          meta: {
            cause,
            reportedBy: where,
            audience: 'global-admin',
            ...(bridge ? { bridge } : {}),
          },
        })
      )
    );
    return admins.length;
  }

  /**
   * The revert a checkout path runs when Lydia refused its `request/do` because the Business is not
   * validated (error 5) or blocked (2701): `setLydiaReadiness(vendorToken, false, ...)` on the
   * HOLDER of the vendor token the request was sent to (an approved parent's, when delegating).
   * Never throws: the payer's typed refusal is what the caller rethrows, and a failure here is an
   * ERROR line, not a second answer.
   *
   * Answers whether the caller RE-ISSUES the same payment, once, on the account that collects now:
   * true only when the refusal was error 5 on a bridge's enrolled Business and the historical
   * account collects again (`switched-back`) - the owner's decision for the bridge (2026-11-13).
   * Error 5 is answered before any request exists, so the re-issue charges nobody twice.
   */
  async revertLydiaReadinessAfterRefusal(
    vendorToken: string,
    cause: 'request-refused' | 'request-blocked',
    ref: LydiaReadinessRef
  ): Promise<boolean> {
    try {
      const outcome = await this.setLydiaReadiness(vendorToken, false, cause, ref);
      return outcome.kind === 'switched-back';
    } catch (err: unknown) {
      this.logger.error(
        `${LYDIA_READINESS_LOG_TAG} revert after ${cause} (${ref.path} ${sanitizeLog(ref.id ?? '')}) ` +
          `FAILED - the holder still reads ready: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  /**
   * The vendor token of the Business the global admin's "Valider l'onboarding" names, or null; 404
   * when the association does not exist: the one its managers manage (`managedVendorTokenSql` - on
   * a bridge whose historical account collects, the ENROLLED Business, so validating it switches
   * it in), else the active one (a bridge before its enrolment: the historical account itself).
   */
  async lydiaVendorTokenOf(id: string): Promise<string | null> {
    const [row]: Array<{ managed: string | null; active: string | null }> =
      await this.assoRepo.query(
        `SELECT ${managedVendorTokenSql()} AS managed, a."lydiaAccountId" AS active
           FROM associations a ${bridgeJoinSql()} WHERE a.id = $1`,
        [id]
      );
    if (!row) throw new NotFoundException('Association not found');
    return row.managed?.trim() || row.active?.trim() || null;
  }

  /**
   * Called after Lydia ISSUED a request on `vendorToken` (a `request/do` answered with a request):
   * the proof that a Business a bridge switch made active really is validated
   * (lydia-account-bridge.ts). The FIRST such request after a switch stamps `enrolledProvenAt` -
   * one statement, so the stamp is the idempotence - and tells the payout managers "active", the
   * notice the switch itself withheld because an unsigned VALIDATED can be forged. Any other
   * token matches no row. Never throws: the payer's request is issued, and a failure here is an
   * ERROR line, not a second answer.
   */
  async noteLydiaRequestIssued(vendorToken: string): Promise<void> {
    try {
      const updated: unknown[] = await this.assoRepo.query(
        `UPDATE lydia_account_bridges b SET "enrolledProvenAt" = now()
           FROM associations a
          WHERE b."enrolledVendorToken" = $1 AND b.state = 'switched'
            AND b."enrolledProvenAt" IS NULL AND a.id = b."associationId"
          RETURNING a.id, a.name`,
        [vendorToken]
      );
      const rows = (Array.isArray(updated[0]) ? updated[0] : updated) as Array<{
        id: string;
        name: string;
      }>;
      if (rows.length === 0) return;
      const [holder] = rows;
      this.logger.warn(
        `${LYDIA_BRIDGE_LOG_TAG} association ${sanitizeLog(holder.id)}: its switched-to Business ` +
          `PROVED itself (Lydia issued a request on it) - the payout managers are told "active"`
      );
      await this.tellPayoutManagers(holder, 'active');
    } catch (err: unknown) {
      this.logger.error(
        `${LYDIA_BRIDGE_LOG_TAG} the proof of an issued request could not be recorded: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Claims the "enrolment in flight" marker BEFORE core-service calls `business/create`: ONE
   * statement, only where no marker is set and the managers hold no Business
   * (`managedVendorTokenSql`: none linked, or a bridge's historical account collecting with no
   * enrolled Business yet), so two enrolments cannot both create a Business. Refused with the typed
   * 409 `LYDIA_BUSINESS_PENDING_VALIDATION` (a bridge's enrolled Business waits for Lydia),
   * `LYDIA_ACCOUNT_ALREADY_LINKED` (a Business is linked) or `LYDIA_ENROLMENT_IN_FLIGHT` (another
   * create's outcome is not known).
   */
  async claimLydiaEnrolment(id: string): Promise<void> {
    const result: unknown[] = await this.assoRepo.query(
      `UPDATE associations SET "lydiaEnrolmentStartedAt" = now()
        WHERE id = $1 AND "lydiaEnrolmentStartedAt" IS NULL AND ${MANAGES_NO_BUSINESS_SQL}
        RETURNING id`,
      [id]
    );
    const written = Array.isArray(result[0]) ? (result[0] as unknown[]).length : result.length;
    if (written > 0) {
      this.logger.log(`[LYDIA] enrolment claimed on association ${sanitizeLog(id)}`);
      return;
    }
    const [asso]: Array<{
      managed: string | null;
      state: LydiaBridgeState | null;
      startedAt: Date | string | null;
    }> = await this.assoRepo.query(
      `SELECT ${managedVendorTokenSql()} AS managed, b.state,
              a."lydiaEnrolmentStartedAt" AS "startedAt"
         FROM associations a ${bridgeJoinSql()} WHERE a.id = $1`,
      [id]
    );
    if (!asso) throw new NotFoundException('Association not found');
    if (asso.managed && asso.state === 'historical') {
      this.logger.warn(
        `${LYDIA_BRIDGE_LOG_TAG} enrolment refused on association ${sanitizeLog(id)}: its enrolled ` +
          `Business still waits for Lydia's validation`
      );
      throw new ConflictException({
        code: LYDIA_BUSINESS_PENDING_VALIDATION,
        message: 'The Lydia Business of this association is waiting for Lydia to validate it',
      });
    }
    if (asso.managed) {
      this.logger.warn(
        `[LYDIA] enrolment refused on association ${sanitizeLog(id)}: a Business is linked`
      );
      throw new ConflictException({
        code: LYDIA_ACCOUNT_ALREADY_LINKED,
        message: 'A Lydia Business is already linked to this association',
      });
    }
    this.logger.warn(
      `[LYDIA] enrolment refused on association ${sanitizeLog(id)}: another one is in flight since ` +
        `${asso.startedAt ? new Date(asso.startedAt).toISOString() : 'an unknown time'}`
    );
    throw new ConflictException({
      code: LYDIA_ENROLMENT_IN_FLIGHT,
      message: 'An enrolment of this association is in flight; its outcome must be checked first',
    });
  }

  /**
   * Clears the "enrolment in flight" marker: after a TYPED refusal of `business/create` (nothing
   * was created), or by a global admin who checked with Lydia that no Business was left behind.
   * Never on an unconfirmed create. Harmless when a Business is linked (the link cleared it). The
   * admin's clear also clears the Responsable step's marker (`lydiaResponsableStartedAt`): it is the
   * one hand that unblocks an enrolment whose outcome nobody knows.
   */
  async releaseLydiaEnrolment(id: string, why: 'refused' | 'admin'): Promise<void> {
    await this.assoRepo.query(
      why === 'admin'
        ? `UPDATE associations SET "lydiaEnrolmentStartedAt" = NULL, "lydiaEnrolmentVendorToken" = NULL,
                  "lydiaResponsableStartedAt" = NULL, "lydiaCashierClaimToken" = NULL
            WHERE id = $1`
        : `UPDATE associations SET "lydiaEnrolmentStartedAt" = NULL, "lydiaEnrolmentVendorToken" = NULL
            WHERE id = $1`,
      [id]
    );
    const line = `[LYDIA] enrolment marker cleared on association ${sanitizeLog(id)} (${why})`;
    this.logger.log(why === 'admin' ? `[AUDIT] ${line}, the Responsable step's too` : line);
  }

  /**
   * Records the vendor token `business/create` just answered on the association whose enrolment is
   * in flight, BEFORE its key is checked and it is linked: a `BUSINESS_VALIDATED` naming it while it
   * is not linked yet is then the ONE unknown token worth a retry (`setLydiaReadiness`). Cleared by
   * the link and by every release of the enrolment marker. Answers whether a row was written (none
   * when no enrolment is in flight there).
   */
  async recordLydiaEnrolmentVendorToken(id: string, vendorToken: string): Promise<boolean> {
    const result: unknown[] = await this.assoRepo.query(
      `UPDATE associations SET "lydiaEnrolmentVendorToken" = $2
        WHERE id = $1 AND "lydiaEnrolmentStartedAt" IS NOT NULL AND ${MANAGES_NO_BUSINESS_SQL}
        RETURNING id`,
      [id, vendorToken]
    );
    const written = Array.isArray(result[0]) ? (result[0] as unknown[]).length : result.length;
    if (written > 0) {
      this.logger.log(`[LYDIA] pending enrolment token recorded on association ${sanitizeLog(id)}`);
    } else {
      this.logger.warn(
        `[LYDIA] pending enrolment token NOT recorded on association ${sanitizeLog(id)}: no ` +
          `enrolment in flight there`
      );
    }
    return written > 0;
  }

  /**
   * The Responsable of `vendorToken`'s Business on association `id`: the live (`removedAt IS NULL`)
   * row of THAT Business, confirmed or not (`confirmed`) - a Responsable of an earlier Business is
   * not one of this one. Name and the phone's last two digits; the sealed phone is never read here.
   */
  private async lydiaResponsableOf(
    id: string,
    vendorToken: string
  ): Promise<LydiaResponsableView | null> {
    const rows: Array<Record<string, unknown>> = await this.assoRepo.query(
      `SELECT c."userId", c."phoneEnd", (c."confirmedAt" IS NOT NULL) AS confirmed,
              u."displayName", u."firstName", u."lastName"
         FROM lydia_cashiers c LEFT JOIN users u ON u.id = c."userId"
        WHERE c."associationId" = $1 AND c."vendorToken" = $2 AND c.role = 'responsable'
          AND c."removedAt" IS NULL
        LIMIT 1`,
      [id, vendorToken]
    );
    if (rows.length === 0) return null;
    const [row] = rows;
    return {
      userId: String(row.userId),
      name: formatUserDisplayNameFromRaw(row) || '',
      phoneEnd: String(row.phoneEnd),
      confirmed: row.confirmed === true,
    };
  }

  /**
   * Whether `phone` is the number sealed in `sealed` on a live Responsable row of association `id`.
   * Called INSIDE the transaction that locked that row, so the answer is about the number the
   * operation then acts on. No seal, or one that cannot be opened (a rotated or missing secret), is
   * NOT a match, said at ERROR. The phone is never logged.
   */
  private lydiaResponsablePhoneMatches(
    id: string,
    sealed: string | null,
    phone: string,
    what: 'current' | 'other' = 'current'
  ): boolean {
    if (!sealed) {
      if (what === 'current') {
        this.logger.error(
          `[LYDIA] live Responsable of ${sanitizeLog(id)} has no sealed phone - treated as another number`
        );
      }
      return false;
    }
    try {
      return openSecret(LYDIA_CASHIER_PHONE_PURPOSE, id, sealed) === phone;
    } catch (err: unknown) {
      this.logger.error(
        `[LYDIA] the live Responsable's ${what} phone of ${sanitizeLog(id)} cannot be opened - ` +
          `treated as another number: ${err instanceof Error ? err.name : String(err)}`
      );
      return false;
    }
  }

  /**
   * Refuses (409 `LYDIA_CASHIER_PHONE_IN_USE`) a Responsable number that ANOTHER live cashier row of
   * `vendorToken`'s Business holds - its current or its other number - as the cashier steps' add does:
   * one number, one row. The rows are locked by `manager`'s transaction; a seal that does not open
   * counts as holding the number, refused rather than risked. At the `claim` it is a WARN; at the
   * `record` it is an ERROR, nothing recorded. The phone is never logged.
   */
  private async assertNotAnotherCashierNumber(
    manager: EntityManager,
    id: string,
    vendorToken: string,
    phone: string,
    step: 'claim' | 'record'
  ): Promise<void> {
    const others: Array<{ phoneSealed: string | null; previousPhoneSealed: string | null }> =
      await manager.query(
        `SELECT "phoneSealed", "previousPhoneSealed" FROM lydia_cashiers
          WHERE "associationId" = $1 AND "vendorToken" = $2 AND role <> 'responsable'
            AND "removedAt" IS NULL
          ORDER BY id FOR UPDATE`,
        [id, vendorToken]
      );
    const match = numberHeldBy(
      others.flatMap((other) => [other.phoneSealed, other.previousPhoneSealed]),
      phone,
      (sealed) => {
        try {
          return openSecret(LYDIA_CASHIER_PHONE_PURPOSE, id, sealed);
        } catch (err: unknown) {
          this.logger.error(
            `[LYDIA] a cashier number of ${sanitizeLog(id)} cannot be opened - counted as ` +
              `holding this number: ${err instanceof Error ? err.name : String(err)}`
          );
          return null;
        }
      }
    );
    if (!match) return;
    if (step === 'record') {
      this.logger.error(
        `[LYDIA] Responsable record refused on ${sanitizeLog(id)}: number already held by another ` +
          `cashier row - not recorded`
      );
    } else {
      this.logger.warn(
        `[LYDIA] Responsable claim refused on ${sanitizeLog(id)}: the number is another cashier's`
      );
    }
    throw new ConflictException({
      code: LYDIA_CASHIER_PHONE_IN_USE,
      message: 'This number already is a cashier number',
    });
  }

  /**
   * What core-service checks before asking Lydia to add a Responsable, AND the claim of that step,
   * in ONE transaction that locks the association row and the live Responsable row, so the numbers
   * compared are the numbers the step then acts on. Answers the Business linked now, whether the
   * chosen person is a member, who the live Responsable is (another person is refused), and - when
   * the same person is asked again - whether `phone` is the number recorded (`phoneMatches`, the
   * sealed number opened here and compared). A different number is a NUMBER CHANGE (lot 3,
   * `numberChange`) when core asks for one (`allowNumberChange`, an add) and either no other number
   * is tracked on the row or `phone` IS that other number (switching back, or retrying a new number
   * Lydia did not confirm); a third number is refused (`LYDIA_RESPONSABLE_PHONE_LOCKED`, by core).
   * An older core never asks, so it keeps lot 2's refusal.
   *
   * Only when every check passes is the step CLAIMED (`lydia-cashier-claim.ts`: the claim and a new
   * token, answered as `claimToken`); a claim already held is the typed 409
   * `LYDIA_RESPONSABLE_IN_FLIGHT`. Released by the record, by `releaseLydiaResponsable` carrying the
   * token (a typed refusal), or by a global admin; an outcome nobody knows keeps it.
   */
  async claimLydiaResponsable(
    id: string,
    userId: string,
    phone: string,
    opts: { mode?: 'add' | 'record'; allowNumberChange?: boolean } = {}
  ): Promise<{
    vendorToken: string | null;
    member: boolean;
    currentUserId: string | null;
    phoneMatches: boolean;
    numberChange: boolean;
    claimed: boolean;
    claimToken: string | null;
  }> {
    this.logger.debug(`[LYDIA] Responsable claim asked on ${sanitizeLog(id)}`);
    if (!E164_RE.test(phone)) {
      this.logger.warn(`[LYDIA] Responsable claim refused on ${sanitizeLog(id)}: phone not E.164`);
      throw new BadRequestException('An E.164 phone is required');
    }
    const member = await this.isMember(userId, id);
    return this.assoRepo.manager.transaction(async (manager) => {
      const asso = await lockAssociation(manager, id);
      if (!asso) throw new NotFoundException('Association not found');
      const vendorToken = asso.vendorToken;
      const live: Array<{
        userId: string;
        phoneSealed: string | null;
        previousPhoneSealed: string | null;
      }> = vendorToken
        ? await manager.query(
            `SELECT "userId", "phoneSealed", "previousPhoneSealed" FROM lydia_cashiers
              WHERE "associationId" = $1 AND "vendorToken" = $2 AND role = 'responsable'
                AND "removedAt" IS NULL
              LIMIT 1 FOR UPDATE`,
            [id, vendorToken]
          )
        : [];
      const currentUserId = live[0]?.userId ?? null;
      const same = currentUserId === userId;
      const phoneMatches = same
        ? this.lydiaResponsablePhoneMatches(id, live[0].phoneSealed, phone)
        : true;
      const otherMatches =
        same && !phoneMatches
          ? this.lydiaResponsablePhoneMatches(id, live[0].previousPhoneSealed, phone, 'other')
          : false;
      // Lot 3: ANOTHER number for the live Responsable is a number change - asked only by a core
      // that knows how to finish one (`allowNumberChange`), for an add, and only while no other
      // number is tracked on the row or the number asked IS that other one.
      const numberChange =
        same &&
        !phoneMatches &&
        opts.allowNumberChange === true &&
        opts.mode === 'add' &&
        (!live[0].previousPhoneSealed || otherMatches);
      const answer = {
        vendorToken,
        member,
        currentUserId,
        phoneMatches,
        numberChange,
        claimed: false,
        claimToken: null,
      };
      if (!vendorToken || !member || (currentUserId && !same) || (!phoneMatches && !numberChange)) {
        this.logger.debug(
          `[LYDIA] Responsable step on ${sanitizeLog(id)} not claimed: business=${!!vendorToken} ` +
            `member=${member} other=${!!currentUserId && !same} ` +
            `phoneMatches=${phoneMatches} numberChange=${numberChange}`
        );
        return { ...answer, numberChange: false };
      }
      await this.assertNotAnotherCashierNumber(manager, id, vendorToken, phone, 'claim');
      if (asso.claimed) {
        this.logger.warn(
          `[LYDIA] Responsable claim refused on ${sanitizeLog(id)}: another cashier operation is in flight`
        );
        throw new ConflictException({
          code: LYDIA_RESPONSABLE_IN_FLIGHT,
          message:
            'A Responsable is being added to this association; its outcome must be known first',
        });
      }
      const claimToken = await writeClaim(manager, id);
      this.logger.log(
        `[LYDIA] Responsable step claimed on association ${sanitizeLog(id)}` +
          (numberChange
            ? otherMatches
              ? ' (switch to the other number)'
              : ' (number change)'
            : '')
      );
      return { ...answer, claimed: true, claimToken };
    });
  }

  /**
   * Releases the Responsable step's claim after a TYPED outcome core-service knows (Lydia refused,
   * or the read-back answered): nothing is left in flight at Lydia. Never on an unknown outcome.
   * Clears it only when it still carries `claimToken`; answers whether it did.
   */
  async releaseLydiaResponsable(id: string, claimToken: string): Promise<boolean> {
    const cleared = await clearClaim((s, p) => this.assoRepo.query(s, p), id, claimToken);
    if (cleared) {
      this.logger.log(
        `[LYDIA] Responsable step released on association ${sanitizeLog(id)} (refused)`
      );
    } else {
      this.logger.warn(
        `[LYDIA] Responsable step release on association ${sanitizeLog(id)} ignored: the claim ` +
          `no longer carries that token`
      );
    }
    return cleared;
  }

  /**
   * Records the Responsable core-service just added at Lydia (or found already a cashier there),
   * under the claim `claimToken` (`LYDIA_CASHIER_CLAIM_LOST` when the association's claim no longer
   * carries it). `confirmed` - an explicit boolean (`LYDIA_CASHIER_CONFIRMED_REQUIRED`) - is true when
   * Lydia's read-back showed every right. The phone is sealed at rest (`LYDIA_CASHIER_PHONE_PURPOSE`,
   * the association id as context) and only its last two digits readable. In ONE transaction, the
   * association row and the Responsable row locked, the numbers compared opened there: refused when
   * the Business linked now is not `vendorToken` (409 `LYDIA_BUSINESS_CHANGED`), or another person is
   * the live Responsable (409 `LYDIA_RESPONSABLE_ALREADY_SET`, also a concurrent insert's unique
   * violation).
   *
   * For the live Responsable (lot 3), `phone` is:
   * - its CURRENT number: a re-sent SMS, which confirms an unconfirmed row;
   * - its OTHER number (`previousPhoneSealed`): switching to it - CONFIRMED, the two numbers swap and
   *   the one left becomes the other, whose removal core asks for next (`removeOther`); NOT
   *   confirmed, nothing changes;
   * - a THIRD number while another is tracked: 409 `LYDIA_RESPONSABLE_PHONE_LOCKED`;
   * - a new number: CONFIRMED, it becomes the current one and the old one the other, to remove next
   *   (`removeOther`); NOT confirmed, the OLD number stays the live one and the new one is only
   *   tracked as the other.
   * The step's claim is cleared by the same transaction, and by every typed refusal here. The phone
   * is never logged.
   */
  async recordLydiaResponsable(
    id: string,
    input: {
      vendorToken: unknown;
      userId: unknown;
      phone: unknown;
      addedByUserId: unknown;
      confirmed: unknown;
      claimToken: unknown;
    }
  ): Promise<{ view: LydiaResponsableView; cashierId: string; removeOther: boolean }> {
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const vendorToken = text(input.vendorToken);
    const userId = text(input.userId);
    const phone = text(input.phone);
    const addedBy = text(input.addedByUserId);
    const claimToken = claimTokenOf(input.claimToken);
    if (!claimToken) {
      this.logger.warn(`[LYDIA] Responsable record refused on ${sanitizeLog(id)}: no claim token`);
      throw new BadRequestException('claimToken is required');
    }
    let confirmed: boolean;
    try {
      if (!vendorToken || !userId || !addedBy || !E164_RE.test(phone)) {
        this.logger.warn(
          `[LYDIA] Responsable record refused on ${sanitizeLog(id)}: malformed body`
        );
        throw new BadRequestException(
          'vendorToken, userId, addedByUserId and an E.164 phone are required'
        );
      }
      confirmed = confirmedOf(input.confirmed);
    } catch (err: unknown) {
      // A malformed record is a typed outcome too: its claim is released, never left stuck.
      await this.releaseLydiaResponsable(id, claimToken);
      throw err;
    }
    if (!isSecretBoxConfigured()) {
      this.logger.error(
        `[LYDIA] Responsable record refused on ${sanitizeLog(id)}: LYDIA_KEY_ENCRYPTION_SECRET is not configured`
      );
      throw new ServiceUnavailableException('Cashier phone storage is not configured');
    }
    const sealed = sealSecret(LYDIA_CASHIER_PHONE_PURPOSE, id, phone);
    const phoneEnd = phone.slice(-2);
    let outcome: { cashierId: string; removeOther: boolean; kept: string };
    try {
      outcome = await this.assoRepo.manager.transaction(async (manager) => {
        const asso = await lockAssociation(manager, id);
        if (!asso) throw new NotFoundException('Association not found');
        if (asso.claimToken !== claimToken) {
          this.logger.error(
            `[LYDIA] Responsable record refused on ${sanitizeLog(id)}: the claim no longer carries ` +
              `its token - Lydia may hold a number this record does not keep`
          );
          throw claimLost();
        }
        if (asso.vendorToken !== vendorToken) {
          this.logger.warn(
            `[LYDIA] Responsable record refused on ${sanitizeLog(id)}: the Business changed meanwhile`
          );
          throw lydiaBusinessChanged();
        }
        const live: Array<{
          id: string;
          userId: string;
          vendorToken: string;
          phoneSealed: string | null;
          phoneEnd: string | null;
          previousPhoneSealed: string | null;
          previousPhoneEnd: string | null;
        }> = await manager.query(
          `SELECT id, "userId", "vendorToken", "phoneSealed", "phoneEnd", "previousPhoneSealed",
                  "previousPhoneEnd"
             FROM lydia_cashiers
            WHERE "associationId" = $1 AND role = 'responsable' AND "removedAt" IS NULL FOR UPDATE`,
          [id]
        );
        const current = live[0];
        await this.assertNotAnotherCashierNumber(manager, id, vendorToken, phone, 'record');
        const sameBusiness = !!current && current.vendorToken === vendorToken;
        if (sameBusiness && current.userId !== userId) {
          this.logger.warn(
            `[LYDIA] Responsable record refused on ${sanitizeLog(id)}: another person is the Responsable`
          );
          throw responsableAlreadySet();
        }
        let result: { cashierId: string; removeOther: boolean; kept: string };
        if (sameBusiness) {
          const isCurrent = this.lydiaResponsablePhoneMatches(id, current.phoneSealed, phone);
          const isOther =
            !isCurrent &&
            this.lydiaResponsablePhoneMatches(id, current.previousPhoneSealed, phone, 'other');
          if (!isCurrent && !isOther && current.previousPhoneSealed) {
            this.logger.warn(
              `[LYDIA] Responsable record refused on ${sanitizeLog(id)}: a third number while ` +
                `another one is tracked`
            );
            throw responsablePhoneLocked();
          }
          if (isCurrent) {
            await manager.query(
              `UPDATE lydia_cashiers
                  SET "confirmedAt" = CASE WHEN $3 THEN now() ELSE "confirmedAt" END,
                      "addedByUserId" = $2, "addedAt" = now()
                WHERE id = $1`,
              [current.id, addedBy, confirmed]
            );
            result = { cashierId: current.id, removeOther: false, kept: 'the same number' };
          } else if (!confirmed) {
            // Lydia did not prove the asked number: the live number keeps its place and every
            // right; a NEW asked number is only TRACKED as the other number (Lydia may list it),
            // and an asked number that already is the other one stays as it was.
            if (!isOther) {
              await manager.query(
                `UPDATE lydia_cashiers
                    SET "previousPhoneSealed" = $2, "previousPhoneEnd" = $3,
                        "previousRevokeUnconfirmedAt" = NULL
                  WHERE id = $1`,
                [current.id, sealed, phoneEnd]
              );
            }
            result = {
              cashierId: current.id,
              removeOther: false,
              kept: `the number ending ${current.phoneEnd ?? '??'} (the one ending ${phoneEnd} unconfirmed)`,
            };
          } else {
            // Lydia proved the asked number (a new one, or the other one switched back to): it
            // becomes the live number; the one it replaces becomes the other, removed next.
            await manager.query(
              `UPDATE lydia_cashiers
                  SET "previousPhoneSealed" = "phoneSealed", "previousPhoneEnd" = "phoneEnd",
                      "previousRevokeUnconfirmedAt" = NULL, "revokeUnconfirmedAt" = NULL,
                      "phoneSealed" = $2, "phoneEnd" = $3, "confirmedAt" = now(),
                      "addedByUserId" = $4, "addedAt" = now()
                WHERE id = $1`,
              [current.id, sealed, phoneEnd, addedBy]
            );
            result = {
              cashierId: current.id,
              removeOther: true,
              kept: `the number ending ${phoneEnd}, the one ending ${current.phoneEnd ?? '??'} to remove`,
            };
          }
        } else {
          if (current) {
            // A row of an EARLIER Business: not a cashier of this one. Closed, its phones cleared.
            await manager.query(
              `UPDATE lydia_cashiers SET "removedAt" = now(), "phoneSealed" = NULL, "phoneEnd" = NULL,
                    "previousPhoneSealed" = NULL, "previousPhoneEnd" = NULL
                WHERE id = $1`,
              [current.id]
            );
          }
          const inserted: Array<{ id: string }> = await manager.query(
            `INSERT INTO lydia_cashiers
               ("associationId", "vendorToken", "userId", "phoneSealed", "phoneEnd", role,
                "addedByUserId", "confirmedAt")
             VALUES ($1, $2, $3, $4, $5, 'responsable', $6, CASE WHEN $7 THEN now() END)
             RETURNING id`,
            [id, vendorToken, userId, sealed, phoneEnd, addedBy, confirmed]
          );
          result = { cashierId: inserted[0].id, removeOther: false, kept: 'a new row' };
        }
        await clearClaim((s, p) => manager.query(s, p), id, claimToken);
        return result;
      });
    } catch (err: unknown) {
      if ((err as { code?: unknown })?.code === '23505') {
        // The partial unique index (one live Responsable per association) refused a concurrent
        // insert: another person was recorded first. Typed, never a bare 500.
        this.logger.warn(
          `[LYDIA] Responsable record refused on ${sanitizeLog(id)}: a concurrent record won`
        );
        await this.releaseLydiaResponsable(id, claimToken);
        throw responsableAlreadySet();
      }
      if (err instanceof ConflictException) await this.releaseLydiaResponsable(id, claimToken);
      throw err;
    }
    const audit =
      `Lydia Responsable recorded on association ${sanitizeLog(id)}: user ` +
      `${sanitizeLog(userId).slice(0, 8)}, phone ending ${phoneEnd}, by ` +
      `${sanitizeLog(addedBy).slice(0, 8)} - live: ${outcome.kept}`;
    if (confirmed) {
      this.logger.log(`[AUDIT] ${audit}`);
    } else {
      // Lydia holds this number and did not confirm its rights: a same-number resend confirms it.
      this.logger.error(`[AUDIT] ${audit} - UNCONFIRMED: added at Lydia, rights not read back`);
    }
    const view = await this.lydiaResponsableOf(id, vendorToken);
    if (!view) throw new Error('the Responsable row just written cannot be read back');
    return { view, cashierId: outcome.cashierId, removeOther: outcome.removeOther };
  }

  /**
   * Unlinks the association's Lydia Business from Canari, letting the treasurer restart
   * onboarding from scratch. Local unlink only - the Lydia Business itself is left untouched.
   */
  async clearLydiaAccount(id: string) {
    // On a bridge whose historical account collects, the Business the managers hold is the ENROLLED
    // one: that is what is unlinked, and the historical account keeps collecting, untouched.
    if (await this.clearEnrolledBusinessOfBridge(id)) return;
    // The unlink and the pause commit together: the holder's own on-sale products and its approved
    // delegates' (a list paid through it among them) are withheld exactly as a readiness revert
    // withholds them (`setLydiaReadiness`), and the same release puts them back once a Business is
    // linked and validated again - or, for a delegate, once another receiver accepts it.
    const { delegates, withheld, byId, wasReady } = await this.assoRepo.manager.transaction(
      async (manager) => {
        const holder = await this.lockAssociation(manager, id);
        await manager.update(Association, id, {
          lydiaAccountId: null,
          lydiaOnboardingComplete: false,
          lydiaDashboardUrl: null,
        });
        const delegateIds = await approvedDelegateIds(manager, id);
        const counts = await withholdOnSaleProductsOf(manager, [id, ...delegateIds]);
        return {
          delegates: delegateIds,
          withheld: [...counts.values()].reduce((sum, n) => sum + n, 0),
          byId: counts,
          // Its delegates collected through it only while its Business was validated.
          wasReady: Boolean(holder.lydiaOnboardingComplete && holder.lydiaAccountId),
        };
      }
    );
    this.logger.warn(
      `[AUDIT] Lydia Business unlinked from association ${sanitizeLog(id)}: ${withheld} on-sale ` +
        `product(s) of it and its ${delegates.length} approved delegate(s) withheld`
    );
    // The Business key belongs to the Business being unlinked: it goes with it. (Bound to the old
    // vendor token, it could not open for the next Business anyway - this is hygiene, not safety.)
    await this.assoRepo.query(
      `UPDATE associations SET "lydiaBusinessKeyCiphertext" = NULL WHERE id = $1`,
      [id]
    );
    this.logger.log(
      `[AUDIT] Lydia Business key cleared on association ${sanitizeLog(id)} (unlink)`
    );
    // The cashiers Canari recorded were cashiers of THAT Business: closed, their phone cleared
    // (retention: a phone is kept only while its holder is a cashier, migration 118).
    await this.assoRepo.query(
      `UPDATE lydia_cashiers SET "removedAt" = now(), "phoneSealed" = NULL, "phoneEnd" = NULL,
                  "previousPhoneSealed" = NULL, "previousPhoneEnd" = NULL
        WHERE "associationId" = $1 AND "removedAt" IS NULL`,
      [id]
    );
    await this.assoRepo.query(
      `UPDATE associations SET "lydiaResponsableStartedAt" = NULL, "lydiaCashierClaimToken" = NULL WHERE id = $1`,
      [id]
    );
    await this.invalidatePostListCaches();
    if (wasReady) {
      await this.tellDelegates(delegates, 'receiver-not-ready', 'receiver Lydia unlinked', byId);
    } else {
      this.logger.debug(
        `[DELEGATION] receiver ${sanitizeLog(id)} unlinked while not ready: its delegates had ` +
          `already stopped collecting, no notice`
      );
    }
  }

  /**
   * The unlink of an association on a bridge whose HISTORICAL account collects: the enrolled
   * Business is removed from the bridge (its key, dashboard URL and readiness with it) and its
   * cashier rows closed, phones cleared - the enrolment may start again. The historical account, its
   * products and its delegates are not touched: it is not the managers' Business. Nothing enrolled
   * yet: nothing to unlink, said at WARN (the historical account is removed by the documented
   * procedure, never by this button). Answers false when the association is on no such bridge -
   * the ordinary unlink runs.
   */
  private async clearEnrolledBusinessOfBridge(id: string): Promise<boolean> {
    const enrolled = await this.assoRepo.manager.transaction(
      async (manager): Promise<string | null | false> => {
        const holder = await manager.query(`SELECT id FROM associations WHERE id = $1 FOR UPDATE`, [
          id,
        ]);
        if ((holder as unknown[]).length === 0) return false;
        const bridge = await lockBridge(manager, id);
        if (!bridge || bridge.state !== 'historical') return false;
        if (!bridge.enrolledVendorToken) return null;
        // A Business that TOOK payments (collecting between a switch and a switch back) keeps its
        // key while a payment it took can still be confirmed or refunded: the unlink is refused,
        // typed, rather than leaving those rows with no key (lydia-account-bridge.ts).
        const [taken]: Array<{ n: number }> = await manager.query(
          `SELECT ((SELECT count(*) FROM product_checkouts
                     WHERE "vendorToken" = $1 AND status NOT IN ('cancelled', 'expired', 'declined'))
                 + (SELECT count(*) FROM submissions WHERE "lydiaVendorToken" = $1))::int AS n`,
          [bridge.enrolledVendorToken]
        );
        if (taken.n > 0) {
          throw new ConflictException({
            code: LYDIA_BUSINESS_HOLDS_PAYMENTS,
            message: 'This Lydia Business took payments that may still be confirmed or refunded',
          });
        }
        await manager.query(
          `UPDATE lydia_account_bridges
              SET "enrolledVendorToken" = NULL, "standbyKeyCiphertext" = NULL,
                  "standbyDashboardUrl" = NULL, "standbyReady" = false,
                  "standbyReadinessCause" = NULL, "standbyReadinessAt" = NULL
            WHERE "associationId" = $1`,
          [id]
        );
        await manager.query(
          `UPDATE lydia_cashiers SET "removedAt" = now(), "phoneSealed" = NULL, "phoneEnd" = NULL,
                      "previousPhoneSealed" = NULL, "previousPhoneEnd" = NULL
            WHERE "associationId" = $1 AND "vendorToken" = $2 AND "removedAt" IS NULL`,
          [id, bridge.enrolledVendorToken]
        );
        await manager.query(
          `UPDATE associations SET "lydiaResponsableStartedAt" = NULL, "lydiaCashierClaimToken" = NULL
            WHERE id = $1`,
          [id]
        );
        return bridge.enrolledVendorToken;
      }
    );
    if (enrolled === false) return false;
    if (enrolled === null) {
      this.logger.warn(
        `${LYDIA_BRIDGE_LOG_TAG} unlink on association ${sanitizeLog(id)}: no enrolled Business to ` +
          `unlink; its historical account collects and is not the managers' to unlink`
      );
      return true;
    }
    this.logger.warn(
      `[AUDIT] ${LYDIA_BRIDGE_LOG_TAG} the enrolled (pending) Lydia Business of association ` +
        `${sanitizeLog(id)} unlinked, its key and cashier rows cleared; the historical account ` +
        `keeps collecting`
    );
    return true;
  }

  /** Whether a Business key is stored - the ONLY thing the panel ever learns about it. */
  async isLydiaBusinessKeySet(id: string): Promise<boolean> {
    // The MANAGED Business's key: on a bridge whose historical account collects, the enrolled
    // one's - the historical account is invisible to the managers, even as a flag.
    const rows: Array<{ set: boolean }> = await this.assoRepo.query(
      `SELECT (CASE WHEN b.state = 'historical' THEN b."standbyKeyCiphertext"
                    ELSE a."lydiaBusinessKeyCiphertext" END IS NOT NULL) AS "set"
         FROM associations a ${bridgeJoinSql()} WHERE a.id = $1`,
      [id]
    );
    if (rows.length === 0) throw new NotFoundException('Association not found');
    return rows[0].set === true;
  }

  /**
   * The DECRYPTED Business private token of the Business `vendorToken` names, for core-service to
   * verify a Lydia callback, read a request's state or refund a payment with (internal route only):
   * an association's ACTIVE Business, or a bridge's standby one (`HELD_BUSINESSES_SQL`) - so a row
   * taken on a historical account is still refunded and verified with ITS key after the switch, by
   * the row's own vendor token. Null when no Business of ours holds that token with a key, when two
   * do (ambiguous: refuse rather than guess), or when the ciphertext does not open (another secret,
   * or sealed for another vendor token). THROWS a 503 when the server has no encryption secret: a
   * configuration failure is not a verdict about the callback. The value is never logged, never
   * cached.
   */
  async lydiaCallbackKey(vendorToken: string): Promise<string | null> {
    if (!vendorToken) return null;
    const rows: Array<{ id: string; sealed: string }> = await this.assoRepo.query(
      `SELECT h."associationId" AS id, h.sealed FROM ${HELD_BUSINESSES_SQL} h
        WHERE h."vendorToken" = $1 AND h.sealed IS NOT NULL`,
      [vendorToken]
    );
    if (rows.length === 0) {
      this.logger.debug('[LYDIA] callback key: no association holds a key for that vendor token');
      return null;
    }
    if (rows.length > 1) {
      this.logger.error(
        `[LYDIA] callback key: ${rows.length} associations hold a key for ONE vendor token ` +
          `(${rows.map((r) => sanitizeLog(r.id)).join(', ')}) - refused, a Business is one association`
      );
      return null;
    }
    const [row] = rows;
    try {
      return openSecret(
        LYDIA_BUSINESS_KEY_PURPOSE,
        lydiaBusinessKeyContext(row.id, vendorToken),
        row.sealed
      );
    } catch (err: unknown) {
      if (err instanceof SecretBoxUnavailableError) {
        // A CONFIGURATION failure, not a verdict about this key: thrown so the internal route
        // answers 5xx and core-service a 503 Lydia may retry, never the 400 of a bad signature.
        this.logger.error(
          `[LYDIA] callback key of association ${sanitizeLog(row.id)} cannot be opened: ` +
            `LYDIA_KEY_ENCRYPTION_SECRET is not configured`
        );
        throw new ServiceUnavailableException('Business key storage is not configured');
      }
      this.logger.error(
        `[LYDIA] callback key of association ${sanitizeLog(row.id)} does not open ` +
          `(${err instanceof Error ? err.name : 'unknown'}) - its callbacks are refused until a manager re-enters it`
      );
      return null;
    }
  }

  /**
   * Reads the platform's currently active payment provider from core-service. Exposed for callers
   * (e.g. FormsService) that need it outside of resolvePaymentTarget - such as deciding whether to
   * pass Lydia's order_ref-shaped idempotency key on a form with no associated club.
   */
  async getActivePaymentProvider(): Promise<PaymentProviderId> {
    return fetchActivePaymentProvider(this.httpService);
  }

  /**
   * Resolves where an association's payments route, honoring an approved parent delegation AND
   * the platform's currently active provider (the Lydia account id lives in its own column - see
   * payment-delegation.util.ts). Loads the parent only when the association delegates (approved).
   * Central resolver used by every payment path so delegation and provider selection are applied
   * uniformly. Lets a failure to reach core-service propagate - never guesses the active provider.
   */
  async resolvePaymentTarget(asso: Association): Promise<PaymentTarget> {
    const [provider, parent] = await Promise.all([
      this.getActivePaymentProvider(),
      isDelegating(asso)
        ? this.assoRepo.findOne({ where: { id: asso.paymentParentAssociationId } })
        : Promise.resolve(null),
    ]);
    return resolvePaymentTarget(asso, parent, provider);
  }

  /**
   * Whether `associationId` may collect online NOW: it may collect at all (`mayCollect` - a list
   * only through an approved delegate) AND the account its payments route to is ready
   * (`withPaymentsReady`). False for an absent row. What a paid form's PAUSE is read from: a form
   * of an entity that cannot collect now is served `paymentsPaused` - derived on every read, so it
   * pauses the moment a delegation is revoked or a receiver loses its Lydia account, and resumes
   * the moment a new delegation is accepted, with no state of its own to drift.
   */
  async collectsNow(associationId: string): Promise<boolean> {
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) return false;
    if (!mayCollect(asso)) {
      this.logger.debug(
        `[COLLECT] ${associationId.slice(0, 8)} may not collect now (${asso.type})`
      );
      return false;
    }
    const [row] = await this.withPaymentsReady([asso]);
    return row.paymentsReady;
  }

  /**
   * Attaches `paymentsReady` to each row: whether its payments can be taken NOW, through its own
   * Lydia account or the account of the association it delegates to (APPROVED), judged on the
   * accounts alone - `resolvePaymentTarget` with the provider the accounts belong to. Whether the
   * platform has payments switched off is the client's other read (`payments/provider`), so a
   * member read never waits on core-service. The delegation receivers are loaded in ONE query for
   * the whole page (G4: the client used to read the row's OWN `lydiaOnboardingComplete`, so a
   * delegating association or list was told "payments not configured" while the server accepted).
   */
  async withPaymentsReady<T extends Association>(
    rows: T[]
  ): Promise<Array<T & { paymentsReady: boolean }>> {
    const parentIds = [
      ...new Set(rows.filter((r) => isDelegating(r)).map((r) => r.paymentParentAssociationId)),
    ];
    const parents = parentIds.length
      ? await this.assoRepo.find({
          where: { id: In(parentIds) },
          select: {
            id: true,
            lydiaAccountId: true,
            lydiaOnboardingComplete: true,
            lydiaReadinessCause: true,
          },
        })
      : [];
    const byId = new Map(parents.map((p) => [p.id, p]));
    return rows.map((row) => {
      const parent = isDelegating(row) ? (byId.get(row.paymentParentAssociationId) ?? null) : null;
      return {
        ...row,
        paymentsReady: resolvePaymentTarget(row, parent as Association | null, 'lydia').ready,
      };
    });
  }

  /**
   * Returns the connect-style account id (Lydia's `vendor_token`) an association's
   * payments route to, or null if none. Follows an approved parent delegation to the parent's account.
   */
  async getPaymentAccountId(id: string): Promise<string | null> {
    const asso = await this.assoRepo.findOne({ where: { id } });
    if (!asso) return null;
    return (await this.resolvePaymentTarget(asso)).connectAccountId;
  }

  /**
   * What `mayCollect` reads of an association - its kind and its delegation - or `null` when it does
   * not exist: the forms' price guard.
   */
  async collectionSubjectOf(associationId: string): Promise<CollectionSubject | null> {
    return this.assoRepo.findOne({
      where: { id: associationId },
      select: {
        id: true,
        type: true,
        paymentDelegationStatus: true,
        paymentParentAssociationId: true,
      },
    });
  }

  /** The kind of an association (`null` when it does not exist) - what the kind-excluded flags read. */
  async kindOf(associationId: string): Promise<Association['type'] | null> {
    const row = await this.assoRepo.findOne({
      where: { id: associationId },
      select: { id: true, type: true },
    });
    return row?.type ?? null;
  }

  /**
   * Whether `associationId` can take an online payment NOW, the question `assertPaymentsReady`
   * answers by throwing, answered as a boolean: its own or its approved delegate's account is ready
   * AND the platform's provider is on. False for an absent row. What a draft form's publication
   * reads, so its refusal is the form's ONE typed code whatever the cause underneath.
   */
  async canTakePaymentsNow(associationId: string): Promise<boolean> {
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) return false;
    const target = await this.resolvePaymentTarget(asso);
    if (!target.ready) {
      this.logger.log(
        `[PAYMENTS] association ${sanitizeLog(associationId)} cannot take payments now: ` +
          `provider=${target.provider} delegated=${target.delegated} cause=${target.readinessCause ?? 'none'}`
      );
    }
    return target.ready;
  }

  /**
   * Ensures payments can be taken (own account onboarded, or an approved parent's account ready)
   * before accepting paid forms/purchases.
   * @throws BadRequestException when neither the association nor its approved parent can receive payments
   */
  async assertPaymentsReady(associationId: string): Promise<void> {
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) {
      throw new NotFoundException('Association not found');
    }
    const target = await this.resolvePaymentTarget(asso);
    if (target.ready) return;
    if (target.provider === 'disabled') {
      throw new BadRequestException(PAYMENTS_DISABLED_MESSAGE);
    }
    this.logger.warn(
      `[PAYMENTS] association ${sanitizeLog(associationId)} cannot take payments: ` +
        `delegated=${target.delegated} linked=${!!target.connectAccountId} cause=${target.readinessCause ?? 'none'}`
    );
    throw paymentsNotReady(target.readinessCause, target.delegated);
  }

  // ── Payment delegation (parent-association payment routing) ─────────────────

  /**
   * Returns this association's payment-delegation state for its own management UI: the chosen
   * parent (if any), the lifecycle status, and whether that parent can currently receive payments.
   */
  async getPaymentDelegation(associationId: string): Promise<{
    status: 'pending' | 'approved' | null;
    parentAssociationId: string | null;
    parentName: string | null;
    parentReady: boolean;
  }> {
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) throw new NotFoundException('Association not found');
    if (!asso.paymentParentAssociationId || !asso.paymentDelegationStatus) {
      return { status: null, parentAssociationId: null, parentName: null, parentReady: false };
    }
    const parent = await this.assoRepo.findOne({
      where: { id: asso.paymentParentAssociationId },
    });
    return {
      status: asso.paymentDelegationStatus,
      parentAssociationId: asso.paymentParentAssociationId,
      parentName: parent?.name ?? null,
      parentReady: !!parent?.lydiaOnboardingComplete && !!parent?.lydiaAccountId,
    };
  }

  /**
   * Requests payment delegation from `associationId` to `parentAssociationId`, setting status
   * `pending` until the parent approves. Rejects self-delegation, unknown parents, delegation
   * chains (a parent that itself delegates), and requesters that are themselves a parent to
   * other associations.
   *
   * Open to an association and to a LIST - for a list it is the only way to collect
   * (`collection-policy.ts`); refused to an institution. The receiver must be a kind that holds a
   * Lydia account of its own (an association): any association that accepts, not necessarily the
   * list's BDE (owner, 2026-11-02). A new request over an APPROVED one moves the link back to
   * `pending`, so the child stops collecting until the new receiver accepts: its on-sale products
   * are withheld in the same transaction when its own account cannot take over.
   */
  async requestPaymentDelegation(associationId: string, parentAssociationId: string) {
    this.logger.debug(
      `[DELEGATION] request assoc=${associationId.slice(0, 8)} -> parent=${parentAssociationId.slice(0, 8)}`
    );
    if (associationId === parentAssociationId) {
      throw new BadRequestException('An association cannot delegate payments to itself');
    }
    const [asso, parent] = await Promise.all([
      this.assoRepo.findOne({ where: { id: associationId } }),
      this.assoRepo.findOne({ where: { id: parentAssociationId } }),
    ]);
    if (!asso) throw new NotFoundException('Association not found');
    if (!parent) throw new NotFoundException('Parent association not found');
    assertMayRequestDelegation(this.logger, associationId, asso.type);
    assertMayHoldOwnAccount(
      this.logger,
      parentAssociationId,
      parent.type,
      'payment delegation request (receiver)'
    );

    // No chains: the parent must not itself route its payments to a further association.
    if (parent.paymentParentAssociationId) {
      throw new BadRequestException(
        'The chosen parent association itself delegates its payments and cannot be a parent'
      );
    }
    // The requester must not already be receiving delegated payments from other associations.
    const childCount = await this.assoRepo.count({
      where: { paymentParentAssociationId: associationId },
    });
    if (childCount > 0) {
      throw new BadRequestException(
        'This association already receives delegated payments from others and cannot delegate its own'
      );
    }

    const withheld = await this.assoRepo.manager.transaction(async (manager) => {
      const child = await this.lockAssociation(manager, associationId);
      const wasApproved = isDelegating(child);
      await manager.update(Association, associationId, {
        paymentParentAssociationId: parentAssociationId,
        paymentDelegationStatus: 'pending',
      });
      return wasApproved ? this.withholdIfStranded(manager, child, 'delegation re-requested') : 0;
    });
    if (withheld > 0) await this.invalidatePostListCaches();
    return this.getPaymentDelegation(associationId);
  }

  /**
   * Clears this association's payment delegation (the association cancels a pending/approved
   * link). Cancelling an APPROVED one stops its collecting: its on-sale products are withheld in the
   * same transaction when its own account cannot take over. No notice - its own managers did it.
   */
  async cancelPaymentDelegation(associationId: string) {
    const withheld = await this.assoRepo.manager.transaction(async (manager) => {
      const child = await this.lockAssociation(manager, associationId);
      const wasApproved = isDelegating(child);
      await manager.update(Association, associationId, {
        paymentParentAssociationId: null,
        paymentDelegationStatus: null,
      });
      return wasApproved ? this.withholdIfStranded(manager, child, 'delegation cancelled') : 0;
    });
    await this.invalidatePostListCaches();
    this.logger.log(
      `[DELEGATION] cancelled assoc=${associationId.slice(0, 8)}, ${withheld} product(s) withheld`
    );
    return { status: null, parentAssociationId: null, parentName: null, parentReady: false };
  }

  /**
   * Lists associations that requested or were granted delegation to `parentAssociationId`
   * (the parent's approval queue plus its active children).
   */
  async listDelegatedChildren(
    parentAssociationId: string
  ): Promise<
    Array<{ associationId: string; name: string; slug: string; status: 'pending' | 'approved' }>
  > {
    const children = await this.assoRepo.find({
      where: { paymentParentAssociationId: parentAssociationId },
      order: { name: 'ASC' },
    });
    return children
      .filter(
        (c) => c.paymentDelegationStatus === 'pending' || c.paymentDelegationStatus === 'approved'
      )
      .map((c) => ({
        associationId: c.id,
        name: c.name,
        slug: c.slug,
        status: c.paymentDelegationStatus,
      }));
  }

  /**
   * Approves a pending delegation request from `childId` to `parentAssociationId`. Requires the
   * parent to have completed its own payment account onboarding, since it becomes the receiver.
   *
   * WHO MAY ACCEPT (owner, 2026-11-02): the receiver's OWN `MANAGE_PRODUCTS` holders and the
   * platform administrator - never a BDE governing the receiver, whose Lydia account it is not
   * (`mayAct(..., { withoutGoverningBde: true })`); anyone else is `DELEGATION_ACCEPT_RECEIVER_ONLY`.
   * The acceptance is RECORDED in the same transaction that writes `approved`
   * (`payment_delegation_acceptances`, migration 125): who, in which capacity, when - and whether
   * the accepter governed the receiver as a BDE super-admin at that moment
   * (`accepterGoverningSuperAdmin`): a super-admin may grant itself `MANAGE_PRODUCTS` on the
   * receiver and accept as a `member`, and the member row keeps no provenance of that grant, so the
   * record carries the standing instead (owner review of #2967, 2026-11-03).
   *
   * The child's withheld products go back on sale in the SAME transaction
   * (`releaseWithheldProductsOf`): the receiver is proven ready under its lock, so a commit never
   * leaves them withheld; its shop managers are told when something was released.
   *
   * The receiver row is share-locked while its readiness is read, so a Lydia revert
   * (`setLydiaReadiness`, which locks it FOR UPDATE) either precedes the read - and the approval is
   * refused - or follows the commit, and then withholds this new delegate too.
   *
   * NO CHAIN IS EVER APPROVED (`DELEGATION_CHAIN_REFUSED`, review of #2967): under the same locks,
   * the receiver must not itself delegate, and the requester must hold no approved delegate of its
   * own. The request's checks run before any lock, so crossed requests both pass them; these do
   * not. Two crossed acceptances (A->B and B->C) meet on B's row - the first takes it FOR SHARE as
   * the receiver, the second FOR UPDATE as the requester - so the later one reads what the earlier
   * committed and refuses.
   */
  async approvePaymentDelegation(
    parentAssociationId: string,
    childId: string,
    actor: { userId: string; isGlobalAdmin: boolean }
  ) {
    const acceptedAs = await this.receiverActorRole(actor, parentAssociationId);
    if (!acceptedAs) {
      this.logger.warn(
        `[DELEGATION] acceptance refused: user ${actor.userId.slice(0, 8)} is neither a shop manager ` +
          `of receiver ${parentAssociationId.slice(0, 8)} nor the platform administrator`
      );
      throw new ForbiddenException({
        code: DELEGATION_ACCEPT_RECEIVER_ONLY,
        message: "Only the receiving association's own managers may accept a payment delegation",
      });
    }
    const governing = await this.isAssociationSuperAdminOf(actor.userId, parentAssociationId);
    if (governing && acceptedAs === 'member') {
      this.logger.warn(
        `[DELEGATION] acceptance by ${actor.userId.slice(0, 8)} as a member of receiver ` +
          `${parentAssociationId.slice(0, 8)} who ALSO governs it as a BDE super-admin - recorded`
      );
    }
    const { released, resumed } = await this.assoRepo.manager.transaction(async (manager) => {
      const parent = await manager.findOne(Association, {
        where: { id: parentAssociationId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!parent) throw new NotFoundException('Parent association not found');
      const child = await this.lockAssociation(manager, childId);
      assertMayHoldOwnAccount(
        this.logger,
        parentAssociationId,
        parent.type,
        'payment delegation approval (receiver)'
      );
      assertMayRequestDelegation(this.logger, childId, child.type);
      if (
        child.paymentParentAssociationId !== parentAssociationId ||
        child.paymentDelegationStatus !== 'pending'
      ) {
        this.logger.debug(
          `[DELEGATION] approval refused: no pending request from ${childId.slice(0, 8)} to ` +
            `${parentAssociationId.slice(0, 8)} (status=${child.paymentDelegationStatus ?? 'none'})`
        );
        throw new BadRequestException('No pending delegation request from this association');
      }
      await this.assertNoDelegationChain(manager, parent, childId);
      if (!parent.lydiaOnboardingComplete || !parent.lydiaAccountId) {
        this.logger.debug(
          `[DELEGATION] approval refused: receiver ${parentAssociationId.slice(0, 8)} is not ready`
        );
        throw new BadRequestException(
          'Complete your payment account onboarding before accepting delegated payments'
        );
      }
      // A pending child collects only on an account of its own (never a list); approved, it
      // collects through the receiver, proven ready above.
      const collectedBefore = collectsThrough(child, null);
      await manager.update(Association, childId, { paymentDelegationStatus: 'approved' });
      await manager.query(
        `INSERT INTO payment_delegation_acceptances
           ("childAssociationId", "parentAssociationId", "acceptedByUserId", "acceptedAs",
            "accepterGoverningSuperAdmin")
         VALUES ($1, $2, $3, $4, $5)`,
        [childId, parentAssociationId, actor.userId, acceptedAs, governing]
      );
      return {
        released: (await releaseWithheldProductsOf(manager, [childId])).get(childId) ?? 0,
        resumed:
          !collectedBefore &&
          collectsThrough({ ...child, paymentDelegationStatus: 'approved' }, parent),
      };
    });
    await this.invalidatePostListCaches();
    this.logger.log(
      `[AUDIT] payment delegation ACCEPTED: receiver=${parentAssociationId.slice(0, 8)} ` +
        `child=${childId.slice(0, 8)} by user ${actor.userId.slice(0, 8)} as ${acceptedAs}` +
        `${governing ? ' (governing super-admin)' : ''}; ${released} withheld product(s) released`
    );
    if (resumed) {
      await this.tellDelegates(
        [childId],
        'resumed',
        'delegation accepted',
        new Map([[childId, released]])
      );
    }
    return { associationId: childId, status: 'approved' as const, released };
  }

  /**
   * Rejects a pending request or revokes an approved delegation from `childId`, clearing its link.
   *
   * Revoking an APPROVED one PAUSES the child's collecting (owner, 2026-11-02): its on-sale
   * products are withheld in the same transaction (`activationWithheld`, the flag the release reads
   * back) when its own account cannot take over - always for a list - and its shop managers are
   * told (`tellDelegates`) when something was actually withheld. A new accepted delegation
   * releases them.
   *
   * WHO MAY (owner review of #2967, 2026-11-03): the same as acceptance - the receiver's OWN shop
   * managers and the platform administrator, never a BDE governing the receiver; anyone else is
   * `DELEGATION_REVOKE_RECEIVER_ONLY`. The child cancels its own link through
   * `cancelPaymentDelegation`, behind its own managers.
   */
  async rejectPaymentDelegation(
    parentAssociationId: string,
    childId: string,
    actor: { userId: string; isGlobalAdmin: boolean }
  ) {
    const role = await this.receiverActorRole(actor, parentAssociationId);
    if (!role) {
      this.logger.warn(
        `[DELEGATION] reject/revoke refused: user ${actor.userId.slice(0, 8)} is neither a shop ` +
          `manager of receiver ${parentAssociationId.slice(0, 8)} nor the platform administrator`
      );
      throw new ForbiddenException({
        code: DELEGATION_REVOKE_RECEIVER_ONLY,
        message: "Only the receiving association's own managers may refuse or end a delegation",
      });
    }
    const { wasApproved, withheld, stopped } = await this.assoRepo.manager.transaction(
      async (manager) => {
        const child = await this.lockAssociation(manager, childId);
        if (child.paymentParentAssociationId !== parentAssociationId) {
          throw new BadRequestException('This association does not delegate payments to you');
        }
        const approved = isDelegating(child);
        const parent = approved
          ? await manager.findOne(Association, { where: { id: parentAssociationId } })
          : null;
        // Whether it collected before (through the receiver) and still does after (on its own
        // account only): the notice follows THAT, forms included, never a product count.
        const collectedBefore = collectsThrough(child, parent);
        const unlinked = {
          ...child,
          paymentParentAssociationId: null,
          paymentDelegationStatus: null,
        };
        await manager.update(Association, childId, {
          paymentParentAssociationId: null,
          paymentDelegationStatus: null,
        });
        return {
          wasApproved: approved,
          withheld: approved
            ? await this.withholdIfStranded(manager, child, 'delegation revoked')
            : 0,
          stopped: collectedBefore && !collectsThrough(unlinked as Association, null),
        };
      }
    );
    await this.invalidatePostListCaches();
    this.logger.log(
      `[DELEGATION] ${wasApproved ? 'revoked' : 'rejected'} parent=${parentAssociationId.slice(0, 8)} ` +
        `child=${childId.slice(0, 8)} by ${actor.userId.slice(0, 8)} as ${role}, ` +
        `${withheld} product(s) withheld`
    );
    if (stopped) {
      await this.tellDelegates(
        [childId],
        'revoked',
        'delegation revoked',
        new Map([[childId, withheld]])
      );
    } else {
      this.logger.debug(
        `[DELEGATION] ${childId.slice(0, 8)} did not stop collecting (a pending request, its own ` +
          `account, or a receiver already not ready) - no notice`
      );
    }
    return { associationId: childId, status: null };
  }

  /**
   * In which capacity `actor` acts for the RECEIVER of a delegation: `member` when its OWN bitmask
   * holds `MANAGE_PRODUCTS` there (the governing BDE's tier dropped), `platform-admin`, or null.
   * The one rule acceptance, reject and revoke share.
   */
  private async receiverActorRole(
    actor: { userId: string; isGlobalAdmin: boolean },
    receiverId: string
  ): Promise<DelegationAcceptor | null> {
    const asMember = await this.mayAct(
      actor.userId,
      receiverId,
      AssociationPermissionFlag.MANAGE_PRODUCTS,
      { withoutGoverningBde: true }
    );
    if (asMember) return 'member';
    return actor.isGlobalAdmin ? 'platform-admin' : null;
  }

  /** Loads and locks (FOR UPDATE) one association row inside `manager`'s transaction; 404 when absent. */
  /**
   * Refuses an acceptance that would write a delegation chain: `parent` (read under the
   * acceptance's lock) itself routes its payments elsewhere, pending or approved - the same rule
   * the request applies - or `childId` (locked FOR UPDATE by the caller) already receives an
   * APPROVED delegation. A pending request to the child is left alone: approving it later meets the
   * first rule, since the child's own link is then set.
   */
  private async assertNoDelegationChain(
    manager: EntityManager,
    parent: Association,
    childId: string
  ): Promise<void> {
    const parentDelegates = !!parent.paymentParentAssociationId;
    const childReceives = parentDelegates
      ? 0
      : await manager.count(Association, {
          where: { paymentParentAssociationId: childId, paymentDelegationStatus: 'approved' },
        });
    if (!parentDelegates && childReceives === 0) return;
    this.logger.warn(
      `[DELEGATION] acceptance refused, it would make a chain: receiver ${parent.id.slice(0, 8)} ` +
        (parentDelegates
          ? `itself delegates to ${parent.paymentParentAssociationId!.slice(0, 8)} ` +
            `(${parent.paymentDelegationStatus ?? 'none'})`
          : `- requester ${childId.slice(0, 8)} already receives ${childReceives} approved delegation(s)`)
    );
    throw new ConflictException({
      code: DELEGATION_CHAIN_REFUSED,
      message: parentDelegates
        ? 'The receiving association itself delegates its payments and cannot receive a delegation'
        : 'The requesting association already receives delegated payments and cannot delegate its own',
    });
  }

  private async lockAssociation(manager: EntityManager, id: string): Promise<Association> {
    const row = await manager.findOne(Association, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!row) throw new NotFoundException('Association not found');
    return row;
  }

  /**
   * Withholds the on-sale products of `child`, which has just lost the delegation it collected
   * through, unless its OWN Lydia account can take over (an association with a validated Business
   * of its own; never a list). `isActive=false, activationWithheld=true` - the exact inverse of the
   * release (`ProductsService.releaseWithheldProducts`), so a product a manager took off sale is
   * never touched and never released later. Runs in the caller's transaction, the row locked.
   */
  private async withholdIfStranded(
    manager: EntityManager,
    child: Association,
    why: string
  ): Promise<number> {
    if (holdsOwnAccount(child.type) && child.lydiaOnboardingComplete && child.lydiaAccountId) {
      this.logger.debug(
        `[DELEGATION] ${why}: ${child.id.slice(0, 8)} keeps selling on its own Lydia account`
      );
      return 0;
    }
    const withheld = (await withholdOnSaleProductsOf(manager, [child.id])).get(child.id) ?? 0;
    this.logger.warn(
      `[DELEGATION] ${why}: ${child.type} ${child.id.slice(0, 8)} can no longer collect - ` +
        `${withheld} on-sale product(s) withheld`
    );
    return withheld;
  }

  /**
   * Tells the shop managers (`MANAGE_PRODUCTS`, their OWN bitmask) of each entity in `ids` that it
   * STOPPED collecting, or collects again (`LydiaPaymentsNotifier.tellDelegation`, its own types,
   * not behind the Lydia switch). The caller passes exactly the entities whose collecting changed -
   * derived from the delegation and the receiver's readiness before and after, so a forms-only list
   * is told like one with products (owner review of #2967), and an entity whose collecting did not
   * change (its own account, a replay) is not passed. `products` only feeds the log line. One `try`
   * per entity: a notice that cannot be written is said at ERROR and never undoes the committed
   * state.
   */
  private async tellDelegates(
    ids: readonly string[],
    notice: DelegationNotice,
    why: string,
    products: ReadonlyMap<string, number> = new Map()
  ): Promise<void> {
    for (const id of ids) {
      const count = products.get(id) ?? 0;
      try {
        const asso = await this.assoRepo.findOne({
          where: { id },
          select: { id: true, name: true },
        });
        if (!asso) {
          this.logger.warn(`[DELEGATION] ${why}: ${id.slice(0, 8)} is gone, nobody to tell`);
          continue;
        }
        const recipients = await this.listFlagHolders(
          id,
          AssociationPermissionFlag.MANAGE_PRODUCTS
        );
        const told = await this.lydiaNotifier.tellDelegation(asso, notice, recipients);
        this.logger.log(
          `[DELEGATION] ${why}: ${id.slice(0, 8)} ${notice} (${count} product(s)), ` +
            `${told}/${recipients.length} manager(s) told`
        );
      } catch (err: unknown) {
        this.logger.error(
          `[DELEGATION] ${why}: the managers of ${id.slice(0, 8)} could not be told: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /**
   * What of `childId`'s accounting `parentId` may read: ALL of it while the delegation to it is
   * approved (`onlyRecordIds: null`), and after it ended - revoked, cancelled, moved to another
   * receiver - the payments ITS Business took (`purchaseIdsTakenBy`), which it still holds and
   * still refunds (owner review of #2967, 2026-11-03). 403 when it holds none of them.
   */
  async childAccountingScope(
    parentId: string,
    childId: string
  ): Promise<{ onlyRecordIds: string[] | null }> {
    const child = await this.assoRepo.findOne({ where: { id: childId } });
    if (!child) throw new NotFoundException('Association not found');
    if (child.paymentParentAssociationId === parentId && isDelegating(child)) {
      return { onlyRecordIds: null };
    }
    // Every Business the former receiver holds - a bridge's historical account included, which
    // still holds (and refunds) what it took (lydia-account-bridge.ts).
    const businesses = await vendorTokensHeldBy(
      (sql, p) => this.assoRepo.manager.query(sql, p),
      parentId
    );
    const taken: string[] = [];
    for (const business of businesses) {
      taken.push(...(await purchaseIdsTakenBy(this.assoRepo.manager, childId, business)));
    }
    if (taken.length === 0) {
      this.logger.debug(
        `[DELEGATION] accounting of ${childId.slice(0, 8)} refused to ${parentId.slice(0, 8)}: ` +
          'no approved delegation and no payment its Business took'
      );
      throw new ForbiddenException('This association does not delegate its payments to you');
    }
    this.logger.debug(
      `[DELEGATION] accounting of ${childId.slice(0, 8)} read by former receiver ` +
        `${parentId.slice(0, 8)}: the ${taken.length} payment(s) its Business took`
    );
    return { onlyRecordIds: taken };
  }

  // ── Post authorship check ─────────────────────────────────────────────────

  /**
   * Returns true if the user may publish in the association's name.
   *
   * The one right that also asks whether the association EXISTS: the answer decides whether a post
   * row may name this id, and a post naming a deleted association is a row nothing can render.
   * `POST_AS_ASSO` is in `SUPER_ADMIN_EXCLUDED_FLAGS`, so a BDE super-admin does not borrow another
   * association's voice.
   */
  async canPostAs(
    userId: string,
    associationId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    if (!(await this.mayAct(userId, associationId, AssociationPermissionFlag.POST_AS_ASSO, opts))) {
      return false;
    }
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    return !!asso;
  }

  /**
   * Why NOBODY may manage the payout account of `associationId` because of its kind - a list
   * (`LIST_NO_OWN_LYDIA_ACCOUNT`: it collects through a delegate) or an institution
   * (`ASSOCIATION_KIND_DOES_NOT_SELL`) - or null when its kind holds one. What the
   * `manage-permission` route answers next to `ok: false`, so core-service and the client read a
   * typed reason instead of a missing right.
   */
  async payoutAccountRefusal(associationId: string): Promise<string | null> {
    const kind = await this.kindOf(associationId);
    if (!kind) return null;
    switch (collectionModeOf(kind)) {
      case 'own-account':
        return null;
      case 'delegate-only':
        return LIST_NO_OWN_LYDIA_ACCOUNT;
      case 'never':
        return ASSOCIATION_KIND_DOES_NOT_SELL;
    }
  }

  /**
   * Returns true if the user may manage the payout account of the association.
   *
   * `MANAGE_PAYOUT_ACCOUNT` is in `SUPER_ADMIN_EXCLUDED_FLAGS`: it points payouts at a bank
   * account, so it stays with the association's own people and the platform administrator.
   *
   * Existence is checked for the same reason as `canPostAs`: core-service asks this before opening
   * a Connect account against the id, so a yes on an association nobody has must not be returned.
   *
   * A LIST (and an institution) holds no Lydia account of its own: `mayAct` answers false for the
   * flag on that kind for every tier (`TYPE_EXCLUDED_FLAGS`), so no Business is ever created at
   * Lydia for it (G5); the route says why with `payoutAccountRefusal`.
   */
  async canManagePayoutAccount(
    userId: string,
    associationId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    const flag = AssociationPermissionFlag.MANAGE_PAYOUT_ACCOUNT;
    if (!(await this.mayAct(userId, associationId, flag, opts))) return false;
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    return !!asso;
  }
}

/**
 * An agenda event "opens" when it is VALIDATED (engagement WP-4, decision 5d): its association's
 * followers who see it are told, once - a re-validation after an edit finds their rows and writes
 * nothing. Not for an event with a registration form (the FORM's opening is the shotgun, and its
 * publication tells the followers), not for a break (the school's band, nobody's event), and not
 * for a NEUTRAL event, which must not be announced under its BDE's name (owner, 2026-11-08; lead
 * decision L27: not announced at all). The member who filed it is not told of it.
 */
async function announceEventOpening(
  manager: EntityManager,
  ev: Pick<
    AssociationCalendarEvent,
    'id' | 'associationId' | 'kind' | 'presentation' | 'linkedFormId' | 'createdBy'
  >
): Promise<void> {
  if (
    ev.kind !== AssociationCalendarEventKind.Event ||
    ev.presentation === AssociationCalendarEventPresentation.Neutral ||
    ev.linkedFormId
  ) {
    return;
  }
  await announceOpeningToFollowers(manager, {
    kind: 'event',
    targetId: ev.id,
    associationId: ev.associationId,
    opensAt: null,
    actorId: ev.createdBy,
  });
}
