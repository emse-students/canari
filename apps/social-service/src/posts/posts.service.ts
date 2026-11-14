/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { assertWithinPostAttachmentCap } from './post-attachment-cap';
import {
  memberRepostContext,
  EMPTY_MEMBER_REPOST_CONTEXT,
  type MemberRepostContext,
  type Reposter,
} from './member-repost-card';
import type { RepostConsent } from './member-reposts.service';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Post } from './entities/post.entity';
import { isUnsafeObjectKey } from '../common/object-keys';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { PostNotificationsService } from './post-notifications.service';
import {
  PostMediaRetentionService,
  commentMediaIds,
  commentMediaOwners,
  postMediaIds,
} from './post-media-retention.service';
import {
  DAY_MS,
  REEL_EXPIRY_WARNING_DAYS,
  REEL_RETENTION_DAYS,
  isExpiredPost,
  type PostKind,
} from './reel.constants';
import { assertReelEditShape } from './reel-rules';
import type { ReelPurgeReason } from '../internal/reel-media';
import { singleMediaModeOf, singleMediaSql, type SingleMediaMode } from './full-screen-post-sql';
import { publicationTime } from './publication-time';
import { clientIdVerdict } from './post-client-id';
import { violatesUniqueColumns } from '../common/pg-errors';
import {
  invalidatePostListCache,
  postListCacheKey,
  readPostListPage,
  writePostListPage,
} from './post-list-cache';
import { STUDENTS_ONLY_NOT_OFFERED, assertStudentsOnlyOffered } from './students-only';
import {
  INSTITUTION_REACH_CODES,
  foldServedReach,
  institutionReachOptionsOffered,
  resolveInstitutionReachWrite,
  servedInstitutionReach,
  type InstitutionReachSpace,
} from '../spaces/institution-reach';
import { promoCutoffFor } from '../common/promo-visibility';
import { blockedAuthorSql, blockedUserIdsFor } from '../common/blocked-user-ids';
import { SUGGESTED_POSTS_MAX, suggestedPostIds } from './suggested-posts';
import { readPostOpenVerdict } from './post-openable';
import { readReplayRowFacts, type ReplayRowFacts } from '../lives/replay-row-facts';
import { pageComments, type CommentOrder } from './comment-page';
import { CommentIdentityService } from './comment-identity';
import { isAnonymousPoll, servePolls } from './anonymous-poll';
import {
  inAssociationsFeedSql,
  republishedFeedAtSql,
  followedFeedSql,
  forYouFollowedSql,
} from './republished-feed-sql';
import { listKind, type ListPostsParams } from './list-feed';
import { engagedAccountsSql } from './engagement-sql';
import {
  FOR_YOU_WINDOW_DAYS,
  FOR_YOU_WINDOW_MAX,
  forYouBandSql,
  forYouInstantTextSql,
  forYouScoreSql,
  forYouSlice,
  forYouSnapshotOf,
  readRankedSnapshot,
  writeRankedSnapshot,
  forYouCursorOf,
  parseForYouCursor,
  RANKING_GONE,
  RANKING_PAGE_INVALID,
  RANKING_UNAVAILABLE,
  type ForYouRankedRow,
  type RankedSnapshot,
} from './for-you-feed';

/** Binds one value as the next placeholder of a query being built, and returns its `$n`. */
type Bind = (value: unknown) => string;

/** A query's placeholders, numbered in the order the SQL text binds them. */
function sqlBinder(): { bind: Bind; params: unknown[] } {
  const params: unknown[] = [];
  return {
    params,
    bind: (value) => {
      params.push(value);
      return `$${params.length}`;
    },
  };
}

/** The number of a `$n` placeholder. */
function placeholderIndex(placeholder: string): number {
  return Number(placeholder.slice(1));
}

/**
 * A list ranked by `forYouScoreSql` with a snapshot (`for-you-feed.ts`): Pour toi, and the CanaReels
 * viewer asked `ranked`.
 */
interface RankedArm {
  /** Names the list in the snapshot's key and the logs. */
  list: string;
  /**
   * The joins after `FROM posts LEFT JOIN associations assoc`, the admission, the placement, as of
   * `asOf` (a `timestamptz` SQL expression: the ranking's instant).
   */
  candidates: (bind: Bind, asOf: string) => { join: string; admitted: string; at: string };
  /** Every filter a served row passes, on every page. */
  filters: (bind: Bind) => string;
  /** The reader's blocked accounts, for the select's comment filter. */
  blockedIds: string[];
  /** Posts merged into the window from outside the candidates (Pour toi's suggestions). */
  suggestedIds: () => Promise<string[]>;
  /** Pour toi: the bands (`forYouBandSql`) come before the score; CanaReels has none. */
  banded: boolean;
}
import {
  commentsWithheldFromViewerSql,
  postVisibleToViewerSql,
  readInFeedAudience,
  reviewCohortAuthorFilterSql,
  type PostAccessIntent,
} from '../spaces/reader-spaces';
import { POST_EDIT_PUBLISHER_ONLY, bdeModeratesContentSql } from '../spaces/bde-moderation';
import { sameSideOfReviewCohort } from '../review-cohort';
import { PINNED_FOR_VIEWER_IDS_SQL, pinnedForViewerSql, type PinSpace } from './space-pins';
import { SpacePinsService } from './space-pins.service';
import { SCHEDULED_EDIT_CANDIDATES_SQL, SCHEDULED_EDIT_LIMIT } from './scheduled-edit';
import { assertFormNotDraft } from '../forms/form-status';
import {
  commentsWithheldPostIds,
  ownEntryOnly,
  withheldReactions,
  withholdCommentsAndPeople,
} from './comments-withheld';
import {
  PERSONAL_REPUBLISHING_ASSOCIATION_TYPES,
  REPUBLISHING_ASSOCIATION_TYPES,
  dropRepublicationsOf,
  republishersOf,
  type Republisher,
} from './republication-sql';

/**
 * Who is reading, and what they already hold - resolved once per request and carried into every
 * shaping helper, so each row can be stamped with what that reader may do to it.
 */
interface PostViewerContext {
  /** The reader, when there is one. An anonymous reader manages nothing. */
  viewerId: string | undefined;
  /** Platform administrator: manages every post, member or not. */
  isGlobalAdmin: boolean;
  /**
   * Ids, among the batch, of the posts the reader moderates as a BDE `MODERATE` holder - those in
   * the spaces its BDE governs (owner, 2026-11-02; `AssociationsService.moderatedPostIds`). Empty for
   * a global admin, who moderates every post (`isGlobalAdmin` decides that).
   */
  moderatedIds: Set<string>;
  /** Associations where the reader holds `POST_AS_ASSO`, hence may manage what was said in their name. */
  managedAssociationIds: Set<string>;
  /**
   * Every association, of a kind that republishes, in whose name the reader may publish - the
   * associations they could republish a post AS (D38). Empty for a global admin, who may republish
   * as any (`isGlobalAdmin` decides that).
   */
  republishAsIds: Set<string>;
  /**
   * Ids, among the batch, of the posts the reader can see WITHOUT a nominative read grant - the
   * predicate every write a grant never opened (a vote, a republication) enforces. A grant-only
   * post is absent. Unused for a global admin, who sees every post by its id.
   */
  grantFreeIds: Set<string>;
  /**
   * Of `grantFreeIds`, those the reader sees FIRST-HAND - leaving member reposts out too
   * (`memberReposts: false`): what a republication enforces, so an association is never the second
   * step of a chain that began with a member's repost (WP-F6, Opus review 2026-11-01). A vote keeps
   * `grantFreeIds`: a repost opens a post to every reader-side act a follow opens.
   */
  firstHandIds: Set<string>;
  /**
   * D38b: the associations the reader may ask an author IN THE NAME OF - `POST_AS_ASSO` HELD (a
   * global admin included: the tier grants nothing here), of the kind that may ask, not archived.
   */
  personalRepublishAsIds: Set<string>;
  /**
   * D38b: ids, among the batch, of the personal posts the server would let this reader ask about -
   * `PersonalRepublicationsService.resolveRecipient`'s own refusals, read in ONE query.
   */
  requestablePersonalIds: Set<string>;
  /** D38b: per post, the standing requests of the reader's associations (any status but withdrawn). */
  personalRequests: Map<string, StandingPersonalRequest[]>;
  /** WP-F6: what the page's cards say and offer about member reposts (`memberRepostContext`). */
  memberReposts: MemberRepostContext;
  /**
   * WP-PIN: ids, among the batch, of the posts SHOWN pinned in one of the reader's pin spaces (their
   * own and their read grants' cells, `pinnedForViewerSql`) - the served `pinned`.
   */
  pinnedIds: Set<string>;
  /** WP-PIN: per post, the spaces where the reader may pin it, with the pin's state there. */
  pinSpaces: Map<string, PinSpace[]>;
  /**
   * Ids, among the batch, of the posts whose comments and people are WITHHELD from this reader: a
   * named reader whose only door is the read grant, switch "voit les commentaires" off (owner,
   * 2026-11-04) - `commentsWithheldPostIds`, the one predicate. Served as `canSeeComments: false`.
   */
  commentsWithheldIds: Set<string>;
}

/** A request one of the reader's associations made for a personal post and that still stands (D38b). */
interface StandingPersonalRequest {
  associationId: string;
  /** Named on the card ("Demande envoyee au nom de X"). */
  associationName: string;
  proposalId: string;
  status: 'pending' | 'accepted' | 'refused';
}

/** What the card is told of one: the accepted ones are already in `republishedBy`. */
type PersonalRepublicationRequestState = StandingPersonalRequest & {
  status: 'pending' | 'refused';
};

/**
 * What one reader may do with one post, decided by the server and rendered as-is by the client.
 *
 * One field per control, because the controls do not share a rule: a moderator deletes and pins a
 * post they did not publish and may still report it, but never edits it; the association's own
 * officer edits and deletes but pins nothing and has nobody to report themselves to.
 */
interface PostCapabilities {
  /** The bin (and, for an older client, the pencil too - which is why `canEdit` was added beside it). */
  canManage: boolean;
  /**
   * The pencil: the post's AUTHOR alone (its publisher - for an association's post, whoever speaks
   * for it). Never a BDE moderator, never the platform admin (owner, 2026-11-02: "tout sauf changer
   * l'integrite du post"), so it can be false where `canManage` is true.
   */
  canEdit: boolean;
  /**
   * The pin (WP-PIN): a PROMOTION per space, not moderation - true when `pinSpaces` is not empty, i.e.
   * the reader governs (platform admin, or `MODERATE` in its BDE) a space where the post is visible.
   */
  canPin: boolean;
  /** WP-PIN: the spaces the pin menu lists, each `shown`, `pending` ("en attente") or not pinned. */
  pinSpaces: PinSpace[];
  /** WP-PIN: shown pinned in one of the READER's spaces (their own, or a read grant's cell). */
  pinned: boolean;
  /** The flag. Withheld only from the post's own publisher - reporting yourself means nothing. */
  canReport: boolean;
  /** Clears an anonymous post's flag, revealing its author. The moderation tier (`viewerModerates`). */
  canUnmaskAnonymous: boolean;
  /**
   * "Republier" (D38): an association post, and the reader may publish as at least one OTHER
   * association that has not republished it yet. The server checks the chosen one again.
   */
  canRepublish: boolean;
  /** "Proposer a une association": an association post its reader may publish in the name of. */
  canProposeRepublication: boolean;
  /**
   * The republishers (ids among `republishedBy`) whose republication this reader may withdraw - an
   * association removes its OWN (D38), so these are the ones the reader may publish as; and the
   * AUTHOR of a personal post removes ANY republication of it (D38b).
   */
  canUnrepublishAs: string[];
  /**
   * "Demander a republier" (D38b): a personal, non-anonymous post by somebody else,
   * seen without a grant, no block either way with its author, and at least one association of the
   * reader's (`POST_AS_ASSO` held, of the kind that may ask) neither carrying it nor having asked.
   */
  canRequestRepublication: boolean;
  /**
   * The requests the reader's associations made for this personal post that still stand and are
   * not yet a republication (D38b): `pending` draws "Demande envoyee" and its withdrawal, `refused`
   * removes that association from the choices. Empty on any other post.
   */
  republicationRequests: PersonalRepublicationRequestState[];
  /**
   * The poll options may be voted: the reader sees the post by a right other than a read grant
   * (a grant opens read, react and comment, never a vote - `assertVisible` 'VOTE').
   */
  canVote: boolean;
  /**
   * The comments (the button, the count, the thread) and the lists of people on this post (who
   * reacted, who voted what) are shown to this reader. False only for a named reader whose ONLY door
   * is a read grant, switch "voit les commentaires" off (owner, 2026-11-04): their row then carries
   * no `comments` and no `commentCount`, its reactions are their own plus `otherReactionCounts`, and
   * its polls are tallies (`withholdCommentsAndPeople`).
   */
  canSeeComments: boolean;
  /** WP-F6 "Republier pour mes abonnes": the reader may repost it now (the write's own rules). */
  canRepost: boolean;
  /** WP-F6: the reader reposted it, so the card offers to take it back. */
  repostedByMe: boolean;
  /** WP-F6: the people the reader FOLLOWS who reposted it, oldest first - "Republie par Y". */
  repostedBy: Reposter[];
  /**
   * WP-F6: on the reader's OWN personal, non-anonymous post only, its repost consent (the post's
   * override and what applies); absent on every other card.
   */
  repostConsent?: RepostConsent;
  /**
   * WP-F6: beside `repostConsent`, on the reader's OWN personal post only, how many people its
   * author is shown as having reposted it ("Republie par N personnes", the list behind it).
   */
  repostCount?: number;
}

/** Core post service: creation, listing (with Redis cache), search, scheduling, and moderation. */
@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);
  private static readonly LIST_CACHE_TTL = 30; // seconds

  /** PostgreSQL BIGINT fields break JSON.stringify - convert to Number. */
  private stripBigIntForJson<T>(value: T): T {
    return JSON.parse(
      JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? Number(v) : v))
    ) as T;
  }

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly redis: RedisService,
    private readonly followsService: FollowsService,
    private readonly associationsService: AssociationsService,
    private readonly notifications: PostNotificationsService,
    private readonly mediaRetention: PostMediaRetentionService
  ) {}

  private commentIdentityService?: CommentIdentityService;
  private spacePinsService?: SpacePinsService;

  /**
   * The per-space pins (WP-PIN), for the page context only - the writes go through the controller's
   * injected instance. Built from what this service holds, like `commentIdentity`, so the specs that
   * construct this service by hand are not all re-wired; the service is stateless.
   */
  private get spacePins(): SpacePinsService {
    return (this.spacePinsService ??= new SpacePinsService(this.postRepo, this.redis));
  }

  /**
   * Who a comment speaks as and what each reader sees of it. Built from the two dependencies this
   * service already holds, so the fourteen specs that construct it by hand are not all re-wired.
   */
  private get commentIdentity(): CommentIdentityService {
    return (this.commentIdentityService ??= new CommentIdentityService(
      this.associationsService,
      this.postRepo
    ));
  }

  private listPostsCacheKey(
    feed: string,
    viewerUserId: string | undefined,
    promo: number | undefined,
    formation: string | undefined,
    limit: number,
    offset: number,
    kind: PostKind | undefined,
    singleMedia: SingleMediaMode | undefined,
    withReplays: boolean,
    ranked: boolean,
    asOf: string | undefined,
    cursor?: string
  ) {
    return postListCacheKey({
      ranked,
      asOf,
      cursor,
      feed,
      viewerUserId,
      promo,
      formation,
      limit,
      offset,
      kind,
      singleMedia,
      withReplays,
    });
  }

  /**
   * Excludes a row whose time is up - a reel past its month, a replay past its three days - in EVERY
   * read that serves posts, and a LIVE REPLAY from every read that has not said it can draw one.
   *
   * The worker deletes an expired row at its next hourly tick, and one whose blob will not delete
   * waits longer; neither may ever be on screen. So the rule that a row is dead past `expiresAt`
   * is a clause of the query, not a thing the worker's timing makes true. A post has a NULL
   * `expiresAt` and the first branch keeps it. A replay is served only where the client asked for
   * one (`withReplays`, the feed and the CanaReels list): search, the linked event, every other list
   * leave it out, so an installed build never draws one wrong (docs/wiki/live-replays.md).
   */
  private liveReelFilterSql(withReplays = false): string {
    return `AND (posts."expiresAt" IS NULL OR posts."expiresAt" > NOW())${
      withReplays
        ? ''
        : `
         AND posts.kind <> 'replay'`
    }`;
  }

  /**
   * THE REMOVED VIEWER (docs/wiki/live-replays.md section 4): a replay is never listed to a viewer
   * its broadcaster removed from the live - the list's statement of `readPostOpenVerdict`'s term.
   * `viewer` is the arm's placeholder for the reader's id. Empty without replays in the page.
   */
  private replayNotRemovedSql(withReplays: boolean, viewer: string): string {
    if (!withReplays) return '';
    return `AND (posts.kind <> 'replay' OR NOT EXISTS (SELECT 1 FROM live_removed_viewers rv
           WHERE rv."liveId" = posts."liveId" AND rv."viewerId" = ${viewer}))`;
  }

  /**
   * The `kind` the caller restricted the page to; ABSENT MEANS BOTH. The value is matched against
   * the two literals rather than interpolated, so nothing a client sends reaches the SQL text.
   */
  private kindFilterSql(kind: PostKind | undefined, singleMedia?: SingleMediaMode): string {
    // A replay is drawn full screen like a reel: it is in the CanaReels list when the page asked for
    // replays at all (`liveReelFilterSql` drops it otherwise).
    if (kind === 'reel' && singleMedia) {
      return `AND (posts.kind IN ('reel', 'replay') OR (posts.kind = 'post' AND ${singleMediaSql(singleMedia)}))`;
    }
    if (kind === 'reel') return `AND posts.kind IN ('reel', 'replay')`;
    if (kind === 'post') return `AND posts.kind = 'post'`;
    return '';
  }

  /**
   * A list page's order. THE CANAREELS LIST (`kind=reel`) IS NEWEST FIRST AND NOTHING ELSE (lead's
   * decision, 2026-10-19): a pin is a feed concept, and a pinned reel or photo post heading the
   * full-screen list would greet every reader with the same page. Every other list keeps its pinned
   * posts first - pinned FOR THIS READER, in one of their spaces (WP-PIN, `pinnedForViewerSql`):
   * `viewer` is the SQL placeholder holding their id, NULL for nobody. THE ORDER IS TOTAL: `id` breaks a tie of `publishedAt` (scheduled posts published
   * at the same instant), so an `OFFSET` page can neither repeat nor skip a row.
   *
   * `at` is the instant a row is placed at: its `publishedAt`, except in the Associations feed,
   * and "Suivis", where a carried post sits at its latest counted republication
   * (`republishedFeedAtSql`).
   */
  private listOrderSql(
    kind: PostKind | undefined,
    viewer: string,
    at = 'posts."publishedAt"'
  ): string {
    return kind === 'reel'
      ? `ORDER BY ${at} DESC, posts.id DESC`
      : `ORDER BY ${pinnedForViewerSql('posts', viewer)} DESC, ${at} DESC, posts.id DESC`;
  }

  /**
   * Throws the whole feed cache away, for every reader.
   *
   * It used to delete eight literal keys, and every one of them named the ANONYMOUS reader at
   * offset 0 - so a signed-in reader's page, whose key carries their own id, survived every create,
   * delete, pin and moderation hide until the 30-second TTL expired. `AssociationsService` already
   * swept the whole prefix for a branding change; the service that WRITES the posts covered less of
   * its own cache than the one that merely renames things in it. Both go through
   * `invalidatePostListCache` now, which is the only thing that knows the prefix.
   */
  private async invalidateListCache() {
    try {
      await invalidatePostListCache(this.redis);
    } catch (e: unknown) {
      // A SWALLOWED BRANCH LOGS: a sweep that failed leaves a deleted post on screen for up to the
      // TTL, and that is exactly the symptom nobody can attribute without this line.
      this.logger.warn(
        `[CACHE] feed cache invalidation failed - if the generation did not move, pages stay stale for up to ${PostsService.LIST_CACHE_TTL}s`,
        e
      );
    }
  }

  /** The reader who holds nothing: nobody is logged in, so no control is drawn and none is owed. */
  private static readonly EMPTY_VIEWER: PostViewerContext = {
    viewerId: undefined,
    isGlobalAdmin: false,
    moderatedIds: new Set(),
    managedAssociationIds: new Set(),
    republishAsIds: new Set(),
    grantFreeIds: new Set(),
    firstHandIds: new Set(),
    personalRepublishAsIds: new Set(),
    requestablePersonalIds: new Set(),
    personalRequests: new Map(),
    memberReposts: EMPTY_MEMBER_REPOST_CONTEXT,
    pinnedIds: new Set(),
    pinSpaces: new Map(),
    commentsWithheldIds: new Set(),
  };

  /**
   * Builds the per-reader context for a batch of rows: two queries for a whole page, whatever its
   * length, and none at all for a reader whose answer is already known.
   *
   * A global administrator short-circuits both - `viewerCapabilities` grants them every control
   * before it looks at either field. The D38b fields are the exception, read for an administrator
   * too: asking an author is a right the administrator tier does not grant, so they need their own
   * memberships like anybody else.
   */
  private async viewerContext(
    rows: { id?: string; associationId?: string | null }[],
    viewerId: string | undefined,
    isGlobalAdmin: boolean
  ): Promise<PostViewerContext> {
    if (!viewerId) return PostsService.EMPTY_VIEWER;
    const postIds = rows.map((row) => row.id).filter((id): id is string => !!id);
    const personalIds = rows
      .filter((row) => row.id && !row.associationId)
      .map((row) => row.id as string);
    if (isGlobalAdmin) {
      // Read only when the page holds a personal post: nothing else of an administrator's needs it.
      const memberships =
        personalIds.length > 0
          ? await this.republishAsOf(viewerId)
          : { all: new Set<string>(), personal: new Set<string>() };
      const adminAssociationIds = rows
        .map((row) => row.associationId)
        .filter((id): id is string => !!id);
      return {
        memberReposts: await memberRepostContext(this.postRepo.manager, postIds, viewerId),
        ...(await this.pinContext(postIds, viewerId, true)),
        // Nothing is withheld from an administrator: the predicate's `adminSeesAll` arm opens every
        // post to them without a grant, so asking it would cost a query to learn an empty set.
        commentsWithheldIds: new Set(),
        viewerId,
        isGlobalAdmin: true,
        moderatedIds: new Set(),
        // Their OWN memberships, not the admin tier: the pencil is the author's alone, and an admin
        // is the author of an association's post only by holding POST_AS_ASSO there (2026-11-02).
        managedAssociationIds:
          adminAssociationIds.length > 0
            ? await this.associationsService.mayActOnAny(
                viewerId,
                adminAssociationIds,
                AssociationPermissionFlag.POST_AS_ASSO
              )
            : new Set<string>(),
        republishAsIds: new Set(),
        grantFreeIds: new Set(),
        firstHandIds: new Set(),
        ...(await this.personalRequestContext(personalIds, viewerId, memberships.personal)),
      };
    }
    const associationIds = rows.map((row) => row.associationId).filter((id): id is string => !!id);
    const [managedAssociationIds, moderatedIds, memberships, grantFree, memberReposts, pins] =
      await Promise.all([
        this.associationsService.mayActOnAny(
          viewerId,
          associationIds,
          AssociationPermissionFlag.POST_AS_ASSO
        ),
        this.associationsService.moderatedPostIds(viewerId, postIds),
        this.republishAsOf(viewerId),
        this.grantFreeVisibleIds(postIds, viewerId),
        memberRepostContext(this.postRepo.manager, postIds, viewerId),
        this.pinContext(postIds, viewerId, false),
      ]);
    // Only a post the reader does NOT see without a grant can have its comments withheld (the
    // predicate's own last term), so the predicate is asked of those alone: none on an ordinary
    // reader's page, and no query for it at all.
    const commentsWithheldIds = await commentsWithheldPostIds(
      this.postRepo.manager,
      postIds.filter((id) => !grantFree.grantFreeIds.has(id)),
      viewerId
    );
    return {
      memberReposts,
      ...pins,
      viewerId,
      isGlobalAdmin: false,
      moderatedIds,
      managedAssociationIds,
      republishAsIds: memberships.all,
      grantFreeIds: grantFree.grantFreeIds,
      firstHandIds: grantFree.firstHandIds,
      commentsWithheldIds,
      ...(await this.personalRequestContext(personalIds, viewerId, memberships.personal)),
    };
  }

  /**
   * WP-PIN, for a page: which posts are pinned for this reader, and where the reader may pin each.
   * Two queries for the page, read with the same rank the feed sorts by (`space-pins.ts`).
   */
  private async pinContext(
    postIds: string[],
    viewerId: string,
    isGlobalAdmin: boolean
  ): Promise<Pick<PostViewerContext, 'pinnedIds' | 'pinSpaces'>> {
    if (postIds.length === 0) return { pinnedIds: new Set(), pinSpaces: new Map() };
    const [pinnedRows, pinSpaces] = await Promise.all([
      this.postRepo.manager.query(PINNED_FOR_VIEWER_IDS_SQL, [
        postIds,
        viewerId,
      ]) as Promise<unknown>,
      this.spacePins.pinSpacesFor(postIds, { userId: viewerId, isGlobalAdmin }),
    ]);
    const pinnedIds = new Set(
      Array.isArray(pinnedRows) ? (pinnedRows as { id: string }[]).map((r) => r.id) : []
    );
    return { pinnedIds, pinSpaces };
  }

  /**
   * Of `postIds`, those `viewerId` sees WITHOUT a read grant - ONE query for a page, through the
   * same `postVisibleToViewerSql` (`readGrants: false`) that `assertVisible(.., 'VOTE')` and the
   * republication path enforce, so a control is offered exactly when its write is accepted.
   */
  private async grantFreeVisibleIds(
    postIds: string[],
    viewerId: string
  ): Promise<{ grantFreeIds: Set<string>; firstHandIds: Set<string> }> {
    const grantFreeIds = new Set<string>();
    const firstHandIds = new Set<string>();
    if (postIds.length === 0) return { grantFreeIds, firstHandIds };
    const rows: unknown = await this.postRepo.manager.query(
      `SELECT posts.id,
              ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: true, readGrants: false, memberReposts: false })} AS "firstHand"
         FROM posts WHERE posts.id = ANY($1::uuid[])
         AND ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: true, readGrants: false })}`,
      [postIds, viewerId]
    );
    for (const r of Array.isArray(rows) ? (rows as { id: string; firstHand: boolean }[]) : []) {
      grantFreeIds.add(r.id);
      if (r.firstHand === true) firstHandIds.add(r.id);
    }
    return { grantFreeIds, firstHandIds };
  }

  /**
   * The associations `viewerId` could republish a post AS: membership rows holding `POST_AS_ASSO`,
   * of a type that republishes (`all`, D38), and among them those that may ASK an author (D38b:
   * `personal` - its own kind allowlist, which names the same kinds since 2026-11-02, and not
   * archived). Membership alone is exact here because
   * `POST_AS_ASSO` is in `SUPER_ADMIN_EXCLUDED_FLAGS` - no BDE tier borrows another association's
   * voice. ONE query for both.
   */
  private async republishAsOf(
    viewerId: string
  ): Promise<{ all: Set<string>; personal: Set<string> }> {
    const rows: unknown = await this.postRepo.manager.query(
      `SELECT am."associationId", a.type, COALESCE(a.archived, false) AS archived
         FROM association_members am
         JOIN associations a ON a.id = am."associationId"
        WHERE am."userId" = $1 AND (am.permissions & $2) <> 0 AND a.type = ANY($3::text[])`,
      [viewerId, AssociationPermissionFlag.POST_AS_ASSO, REPUBLISHING_ASSOCIATION_TYPES]
    );
    const list = Array.isArray(rows)
      ? (rows as { associationId: string; type?: string; archived?: boolean }[])
      : [];
    return {
      all: new Set(list.map((r) => r.associationId)),
      personal: new Set(
        list
          .filter(
            (r) =>
              !!r.type && PERSONAL_REPUBLISHING_ASSOCIATION_TYPES.includes(r.type) && !r.archived
          )
          .map((r) => r.associationId)
      ),
    };
  }

  /**
   * D38b, for a page: which personal posts the reader may ask about, and what their associations
   * already asked. Two queries, and none for a reader who speaks for no association that may ask or
   * a page with no personal post.
   *
   * The requestable set is `PersonalRepublicationsService.resolveRecipient`'s refusals as ONE
   * predicate - not withheld, personal, not anonymous, not the reader's, seen without a grant and
   * without the administrator's by-id reach, no block either way - so the menu entry is offered
   * exactly when the request would be accepted (the caps aside, which only a write can count).
   */
  private async personalRequestContext(
    personalIds: string[],
    viewerId: string,
    personalRepublishAsIds: Set<string>
  ): Promise<
    Pick<
      PostViewerContext,
      'personalRepublishAsIds' | 'requestablePersonalIds' | 'personalRequests'
    >
  > {
    const none = {
      personalRepublishAsIds,
      requestablePersonalIds: new Set<string>(),
      personalRequests: new Map<string, StandingPersonalRequest[]>(),
    };
    if (personalIds.length === 0 || personalRepublishAsIds.size === 0) return none;
    const [requestable, standing]: unknown[] = await Promise.all([
      this.postRepo.manager.query(
        `SELECT posts.id AS "requestableId" FROM posts
          WHERE posts.id = ANY($1::uuid[]) AND posts."associationId" IS NULL
            AND NOT COALESCE(posts.anonymous, false) AND posts."authorId" <> $2
            AND NOT posts."hiddenByModeration"
            AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= now())
            AND (posts."expiresAt" IS NULL OR posts."expiresAt" > now())
            AND posts.kind <> 'replay'
            AND ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: false, readGrants: false, memberReposts: false })}
            AND NOT EXISTS (SELECT 1 FROM user_blocks req_block
              WHERE (req_block."blockerId" = $2 AND req_block."blockedId" = posts."authorId")
                 OR (req_block."blockerId" = posts."authorId" AND req_block."blockedId" = $2))`,
        [personalIds, viewerId]
      ),
      this.postRepo.manager.query(
        `SELECT p."subjectId", p."fromAssociationId", p.id, p.status, a.name AS "associationName"
           FROM proposals p JOIN associations a ON a.id = p."fromAssociationId"
          WHERE p.kind = 'repost-personal' AND p.status <> 'withdrawn'
            AND p."subjectId" = ANY($1::uuid[]) AND p."fromAssociationId" = ANY($2::uuid[])`,
        [personalIds, [...personalRepublishAsIds]]
      ),
    ]);
    const requestablePersonalIds = new Set(
      Array.isArray(requestable)
        ? (requestable as { requestableId: string }[]).map((r) => r.requestableId)
        : []
    );
    const personalRequests = new Map<string, StandingPersonalRequest[]>();
    const standingRows = Array.isArray(standing)
      ? (standing as {
          subjectId: string;
          fromAssociationId: string;
          associationName: string;
          id: string;
          status: StandingPersonalRequest['status'];
        }[])
      : [];
    for (const row of standingRows) {
      const list = personalRequests.get(row.subjectId) ?? [];
      list.push({
        associationId: row.fromAssociationId,
        associationName: row.associationName,
        proposalId: row.id,
        status: row.status,
      });
      personalRequests.set(row.subjectId, list);
    }
    return { personalRepublishAsIds, requestablePersonalIds, personalRequests };
  }

  /**
   * Stamps `republishedBy` ("Republie par X, Y") onto each post of a page, in ONE query, BEFORE the
   * rows are shaped - `canRepublish` reads it to leave out the associations that already did. A
   * PERSONAL post is stamped too since D38b: its author may have let associations carry it.
   */
  private async attachRepublishers(
    rows: { id: string; associationId?: string | null; republishedBy?: Republisher[] }[]
  ): Promise<void> {
    const byPost = await republishersOf(
      this.postRepo.manager,
      rows.map((r) => r.id)
    );
    for (const row of rows) row.republishedBy = byPost.get(row.id) ?? [];
  }

  /**
   * Is this reader the post's PUBLISHER - the one whose name is on it?
   *
   * The two kinds of post answer to two different owners, and conflating them is the bug this
   * replaced:
   * - a PERSONAL post belongs to whoever wrote it, and to nobody else;
   * - a post in an association's name belongs to the ASSOCIATION. Whoever may speak in its name may
   *   correct what was said, and authorship grants nothing extra - an officer who lost the right to
   *   speak for the association has no business editing what it said. That right is `POST_AS_ASSO`
   *   and nothing wider: a BDE super-admin is deliberately excluded from it
   *   (`SUPER_ADMIN_EXCLUDED_FLAGS`), speaking for an association being an identity rather than a
   *   right over its data. Everyone who ever published such a post held that flag at the time -
   *   `canPostAs` is the same predicate - so this takes nothing from anyone still entitled to it.
   */
  private viewerIsPublisher(
    post: { authorId?: string | null; associationId?: string | null },
    viewer: PostViewerContext
  ): boolean {
    if (!viewer.viewerId) return false;
    if (post.associationId) return viewer.managedAssociationIds.has(post.associationId);
    return !!post.authorId && post.authorId === viewer.viewerId;
  }

  /** The reader moderates this post: a platform admin, or a BDE whose governed spaces hold it. */
  private viewerModerates(post: { id?: string }, viewer: PostViewerContext): boolean {
    return viewer.isGlobalAdmin || (!!post.id && viewer.moderatedIds.has(post.id));
  }

  /**
   * What this reader may do with this post - the answer behind every control on the card, and
   * behind the guards that accept the matching write.
   *
   * These are SERVED FIELDS rather than client-side comparisons because a post published in an
   * association's name has its `authorId` stripped from every response on purpose - that anonymity
   * is the feature - so no client can tell its own post from anyone else's, nor the association's
   * officers from strangers. It had to ask the only party that still knows.
   *
   * Three tiers reach a post, and they do not overlap tidily: the platform administrator holds
   * everything; a BDE `MODERATE` holder moderates the posts of the spaces its BDE governs, so it may
   * delete, pin and unmask what it did not publish - never EDIT it (owner, 2026-11-02) - while
   * remaining entitled to report it like any other reader; the publisher corrects and withdraws its
   * own words and pins nothing.
   */
  private viewerCapabilities(
    post: {
      id?: string;
      authorId?: string | null;
      associationId?: string | null;
      anonymous?: boolean;
      republishedBy?: Republisher[];
    },
    viewer: PostViewerContext
  ): PostCapabilities {
    const isPublisher = this.viewerIsPublisher(post, viewer);
    const isModeratorTier = this.viewerModerates(post, viewer);
    const pinSpaces = (post.id && viewer.pinSpaces.get(post.id)) || [];
    return {
      canManage: isModeratorTier || isPublisher,
      canEdit: isPublisher,
      canPin: pinSpaces.length > 0,
      pinSpaces,
      pinned: !!post.id && viewer.pinnedIds.has(post.id),
      canReport: !!viewer.viewerId && !isPublisher,
      canUnmaskAnonymous: !!post.anonymous && isModeratorTier,
      canRepublish: this.viewerMayRepublish(post, viewer),
      canProposeRepublication:
        !!viewer.viewerId && !!post.associationId && (viewer.isGlobalAdmin || isPublisher),
      canUnrepublishAs: this.viewerMayUnrepublishAs(post, viewer),
      canVote:
        !!viewer.viewerId && (viewer.isGlobalAdmin || this.viewerSeesWithoutGrant(post, viewer)),
      canSeeComments: !post.id || !viewer.commentsWithheldIds.has(post.id),
      canRequestRepublication: this.viewerMayRequestRepublication(post, viewer),
      republicationRequests: post.id
        ? (viewer.personalRequests.get(post.id) ?? []).filter(
            (r): r is PersonalRepublicationRequestState => r.status !== 'accepted'
          )
        : [],
      ...this.memberRepostFields(post.id, viewer),
    };
  }

  /** WP-F6: the card's member-repost fields, read from the page's context. */
  private memberRepostFields(
    postId: string | undefined,
    viewer: PostViewerContext
  ): Pick<
    PostCapabilities,
    'canRepost' | 'repostedByMe' | 'repostedBy' | 'repostConsent' | 'repostCount'
  > {
    const ctx = viewer.memberReposts;
    if (!viewer.viewerId || !postId) {
      return { canRepost: false, repostedByMe: false, repostedBy: [] };
    }
    const consent = ctx.consent.get(postId);
    return {
      canRepost: ctx.repostable.has(postId),
      repostedByMe: ctx.mine.has(postId),
      repostedBy: ctx.reposters.get(postId) ?? [],
      ...(consent
        ? { repostConsent: consent, repostCount: ctx.reposterCount.get(postId) ?? 0 }
        : {}),
    };
  }

  /**
   * `canUnrepublishAs`: an association withdraws its OWN republication (D38) - the ones the reader
   * publishes as, or all for a global admin - and the AUTHOR of a personal post withdraws any (D38b).
   */
  private viewerMayUnrepublishAs(
    post: {
      authorId?: string | null;
      associationId?: string | null;
      republishedBy?: Republisher[];
    },
    viewer: PostViewerContext
  ): string[] {
    if (!viewer.viewerId) return [];
    const ids = (post.republishedBy ?? []).map((r) => r.id);
    if (!post.associationId && post.authorId === viewer.viewerId) return ids;
    return ids.filter((id) => viewer.isGlobalAdmin || viewer.republishAsIds.has(id));
  }

  /** `canRequestRepublication`: see `PostCapabilities` (D38b). */
  private viewerMayRequestRepublication(
    post: { id?: string; republishedBy?: Republisher[] },
    viewer: PostViewerContext
  ): boolean {
    if (!viewer.viewerId || !post.id || !viewer.requestablePersonalIds.has(post.id)) return false;
    const taken = new Set([
      ...(post.republishedBy ?? []).map((r) => r.id),
      ...(viewer.personalRequests.get(post.id) ?? []).map((r) => r.associationId),
    ]);
    return [...viewer.personalRepublishAsIds].some((id) => !taken.has(id));
  }

  /** The post is in the reader's grant-free set: the rule a vote and a republication enforce. */
  private viewerSeesWithoutGrant(post: { id?: string }, viewer: PostViewerContext): boolean {
    return !!post.id && viewer.grantFreeIds.has(post.id);
  }

  /** `canRepublish`: see `PostCapabilities`. A personal post is never republished AT ONCE (D38b asks its author). */
  private viewerMayRepublish(
    post: { id?: string; associationId?: string | null; republishedBy?: Republisher[] },
    viewer: PostViewerContext
  ): boolean {
    if (!viewer.viewerId || !post.associationId) return false;
    if (viewer.isGlobalAdmin) return true;
    // A grant opens a post to read only, and a member's repost is not a door an association
    // republishes through (no chain): either is a 404 (`RepublicationsService`).
    if (!post.id || !viewer.firstHandIds.has(post.id)) return false;
    const already = new Set((post.republishedBy ?? []).map((r) => r.id));
    return [...viewer.republishAsIds].some((id) => id !== post.associationId && !already.has(id));
  }

  /**
   * Whether THIS viewer must have `authorId` withheld on a post marked `anonymous`.
   *
   * A moderator, a platform admin, and the post's OWN author all see past the flag (a user
   * request, 2026-09-17: *"il faut aussi qu'un moderateur sache qu'un poste a ete publie en
   * anonyme, meme s'il peut voir le nom du posteur - pareil pour le posteur lui-meme quand il voit
   * son post"*) - same shape as `listMembers`'s `permissions` vs `isAdmin` (the row's own owner
   * gets the raw field too, not just an admin). `anonymous` itself is never stripped for anyone,
   * so the client can still show it was published anonymously to whichever of these three receives
   * the real `authorId`.
   */
  private mustHideAnonymousAuthor(
    post: { id?: string; anonymous?: boolean; authorId?: string | null },
    viewer: PostViewerContext
  ) {
    if (!post.anonymous) return false;
    if (this.viewerModerates(post, viewer)) return false;
    return !viewer.viewerId || viewer.viewerId !== post.authorId;
  }

  /** Strip publisher identity and attach association display for API responses. */
  private shapeListRow(p: any, viewer: PostViewerContext): any {
    const capabilities = this.viewerCapabilities(p, viewer);
    const polls = servePolls(p.polls, viewer.viewerId);
    if (!p.associationId) {
      const out: any = { ...p, ...capabilities, ...(p.polls !== undefined ? { polls } : {}) };
      foldServedReach(out);
      if (!capabilities.canSeeComments) withholdCommentsAndPeople(out, viewer.viewerId);
      if (this.mustHideAnonymousAuthor(p, viewer)) {
        delete out.authorId;
        delete out.authorDisplayName;
        delete out.authorFirstName;
        delete out.authorLastName;
      }
      return out;
    }
    const out: any = { ...p, ...capabilities, ...(p.polls !== undefined ? { polls } : {}) };
    foldServedReach(out);
    if (!capabilities.canSeeComments) withholdCommentsAndPeople(out, viewer.viewerId);
    delete out.authorId;
    delete out.authorDisplayName;
    delete out.authorFirstName;
    delete out.authorLastName;
    if (out.assocJoinId) {
      out.association = {
        id: out.assocJoinId,
        name: out.assocName,
        slug: out.assocSlug,
        logoUrl: out.assocLogoUrl,
        type: out.assocType,
      };
    }
    delete out.assocJoinId;
    delete out.assocName;
    delete out.assocSlug;
    delete out.assocLogoUrl;
    delete out.assocType;
    return out;
  }

  /** Anonymize association-authored and flagged-anonymous posts loaded as TypeORM entities. */
  private async toPublicPostFromEntity(
    post: Post,
    viewer: PostViewerContext
  ): Promise<Record<string, unknown>> {
    const raw: any = { ...(post as any) };
    // WP-F6: the author's per-post consent is served to the author alone, as `repostConsent`.
    delete raw.allowReposts;
    foldServedReach(raw);
    // Backward compatibility: expose both `media` (canonical) and `images` (legacy clients).
    if (Array.isArray(raw.media)) {
      raw.images = raw.media;
    }
    await this.attachRepublishers([raw]);
    // BEFORE the author is withheld below: `byPostAuthor` is computed from it.
    if (Array.isArray(raw.comments)) {
      raw.comments = await this.commentIdentity.serve(raw.comments, raw, {
        viewerId: viewer.viewerId,
        isGlobalAdmin: viewer.isGlobalAdmin,
        isModerator: this.viewerModerates(raw, viewer),
      });
    }
    Object.assign(raw, this.viewerCapabilities(raw, viewer));
    if (raw.polls !== undefined) raw.polls = servePolls(raw.polls, viewer.viewerId);
    if (raw.canSeeComments === false) withholdCommentsAndPeople(raw, viewer.viewerId);
    if (!raw.associationId) {
      if (this.mustHideAnonymousAuthor(post, viewer)) {
        delete raw.authorId;
      }
      return raw;
    }
    delete raw.authorId;
    const rows: { id: string; name: string; slug: string; logoUrl: string | null; type: string }[] =
      await this.postRepo.manager.query(
        `SELECT id, name, slug, "logoUrl", type FROM associations WHERE id = $1`,
        [raw.associationId]
      );
    if (rows[0]) {
      raw.association = {
        id: rows[0].id,
        name: rows[0].name,
        slug: rows[0].slug,
        logoUrl: rows[0].logoUrl,
        type: rows[0].type,
      };
    }
    if (raw.linkedCalendarEventId) {
      raw.linkedCalendarEvent = await this.associationsService.findValidatedCalendarEventSummary(
        raw.linkedCalendarEventId as string,
        viewer.viewerId
      );
    }
    return raw;
  }

  /**
   * Creates a new post. Normalises polls (assigns UUIDs, default values),
   * saves to DB, invalidates the Redis list cache, and returns the public-shaped entity.
   *
   * `isGlobalAdmin` IS A PARAMETER BECAUSE IT WAS A HARDCODED `false`, AND THAT WAS THE DEFECT.
   * The controller consults it to ALLOW the write - `canPostAs(..., { isGlobalAdmin })` is how a
   * platform admin publishes in an association's name at all - and then this method stamped the
   * response for a reader it had decided was not one. A global admin therefore received their own
   * brand-new post with `canManage: false`: no pencil, no bin, on the card they had just made,
   * until something refetched the feed through a path that DID pass the flag. One request, one
   * identity, answered two ways. Reported by the user on 2026-09-17, who guessed the cause in the
   * asking: *"J'ai cree un post mais je ne pouvais pas le supprimer (je suis admin ?)"*.
   */

  /**
   * THE ONE PLACE A POLL BECOMES A STORED POLL - and the one that decides what an edit KEEPS.
   *
   * The create and the update path each carried this map, letter for letter. That is how a new
   * field reaches one path and not the other, and it is why `maxSelections` and `endsAt` are
   * spelled here once rather than twice.
   *
   * AND AN EDIT USED TO ERASE EVERY VOTE. The edit form sends the poll's id under a comment saying
   * it is there "to preserve vote history"; it preserved the id and nothing else. The tallies live
   * in `option.votes` and `votesByUser`, the update rebuilt each poll from the payload alone, and
   * `whitelist: true` strips any tally a client tries to send back - so correcting one word of a
   * question reset the poll to zero, silently, with the id intact to prove nothing had been lost.
   *
   * Votes are carried over from the STORED poll and matched BY OPTION ID: an option the editor
   * deleted takes its votes with it, one they kept keeps them, and a relabelled option keeps them
   * too, because the id is what a vote was cast against. `votesByUser` is then DERIVED from what
   * survived rather than copied alongside it - two stored copies of one tally is how they come to
   * disagree, and only one of them is what the options display.
   *
   * @param incoming The polls as the client sent them, already validated.
   * @param existing The polls currently stored on the post, empty on creation.
   * @returns The polls to store.
   */
  private normalizePolls(incoming: any[], existing: any[] = []): any[] {
    return incoming.map((poll: any) => {
      const previous = existing.find((p: any) => p?.id && p.id === poll.id);
      // ANONYMITY IS THE STORED POLL'S, NEVER THE REQUEST'S: an edit that flipped it would promise
      // anonymity to votes already recorded with a name, or strip the name from votes whose casters
      // were told it was kept.
      const anonymous = previous ? isAnonymousPoll(previous) : poll.anonymous === true;
      if (anonymous) {
        const options = (poll.options || []).map((opt: any) => {
          const id = opt.id || crypto.randomUUID();
          const previousVotes = previous?.options?.find((o: any) => o.id === id)?.votes;
          return { ...opt, id, votes: typeof previousVotes === 'number' ? previousVotes : 0 };
        });
        return {
          ...poll,
          id: poll.id || crypto.randomUUID(),
          anonymous: true,
          multipleChoice: poll.multipleChoice ?? false,
          maxSelections: poll.maxSelections ?? null,
          endsAt: poll.endsAt ?? null,
          voters: Array.isArray(previous?.voters) ? [...previous.voters] : [],
          votesByUser: {},
          options,
        };
      }
      const options = (poll.options || []).map((opt: any) => {
        const id = opt.id || crypto.randomUUID();
        const previousVotes = previous?.options?.find((o: any) => o.id === id)?.votes;
        return { ...opt, id, votes: Array.isArray(previousVotes) ? [...previousVotes] : [] };
      });
      // A user id is an arbitrary string, so it is accumulated in a `Map`, which has no property
      // names to shadow and needs no null prototype to say so. `Object.fromEntries` then defines
      // own data properties, which is what the column stores and what every client reads.
      //
      // The SKIP is the other half: these ids were stored by a `votePoll` that has refused this
      // shape only since 2026-09-23, so a poll written before it can still carry one, and
      // rebuilding the map is where it would be handed on to every reader.
      const votesByUser = new Map<string, string[]>();
      for (const opt of options) {
        for (const userId of opt.votes as string[]) {
          if (isUnsafeObjectKey(userId)) continue;
          const cast = votesByUser.get(userId);
          if (cast) cast.push(opt.id);
          else votesByUser.set(userId, [opt.id]);
        }
      }
      return {
        ...poll,
        id: poll.id || crypto.randomUUID(),
        // Spelled out so a request saying `true` cannot ride in on the spread above.
        anonymous: false,
        multipleChoice: poll.multipleChoice ?? false,
        // A cap that no longer fits the votes already cast is not rewritten: those votes are
        // history, and the cap only ever decides what the NEXT voter may do.
        maxSelections: poll.maxSelections ?? null,
        endsAt: poll.endsAt ?? null,
        votesByUser: Object.fromEntries(votesByUser),
        options,
      };
    });
  }

  /**
   * Proves, through the media service, that every blob a reel cites is the author's own.
   *
   * Not optional hygiene: the later purge deletes what the row names, and an id is not a secret. A
   * `refused` id (not theirs, unknown, already deleted, or a pending upload past its window) is a `400`; the media service being
   * unreachable is a `503` - a reel is never stored on trust, and never silently without a check.
   */
  private async claimReelBlob(authorId: string, mediaIds: string[]): Promise<void> {
    let refused: string[];
    try {
      ({ refused } = await this.mediaRetention.claimReelFor(authorId, mediaIds));
    } catch (e) {
      this.logger.warn(
        `[REEL] claim could not be confirmed for author ${authorId.slice(0, 8)}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      throw new ServiceUnavailableException('The reel video could not be verified, try again');
    }
    if (refused.length > 0) {
      this.logger.warn(
        `[REEL] ${authorId.slice(0, 8)} cited ${refused.length} blob(s) that are not theirs, gone, or a pending upload past its window`
      );
      // The pending window is the MEDIA service's (MEDIA_PENDING_REEL_TTL_MS), so it is not spelled
      // here: a duration written in this sentence is one env change away from a lie.
      throw new BadRequestException(
        "a reel's video must be a file you uploaded yourself that still exists - an unclaimed upload ('reel-pending') expires after the media service's pending window, upload it again"
      );
    }
  }

  /** Whether `userId` may use the feed at all - the gate's question, for `GET /posts/audience`. */
  async isInFeedAudience(userId: string): Promise<boolean> {
    // No line per read: the answer IS the response body, and a refusal is already logged once by
    // `FeedAudienceGuard` where the decision that has a consequence is made.
    return readInFeedAudience(this.postRepo.manager, userId);
  }

  /**
   * Refuses a post `viewerId` may not open, by its id - THE SAME GATE AS `getById`
   * (`assertOpenable`, which is `readPostOpenVerdict`), so a reaction, a comment, a comment like or
   * the comment page is refused on every post the read refuses: outside the audience, a block
   * either way with the author, scheduled later, an expired reel (all 404), and hidden by moderation
   * (403, as the read). 404 and not 403 for "not visible": for that reader the post does not exist,
   * and saying "forbidden" would confirm the id. An absent viewer, or an absent post, sees nothing.
   *
   * THE INTENT IS EXPLICIT because a nominative read grant (WP7) opens a post to READ, REACT and
   * COMMENT only: `'READ_OR_REACT'` counts the grant, `'VOTE'` does not (a vote was never granted,
   * user 2026-10-07: read + react/comment). `'COMMENT'` counts it too, but refuses a named reader
   * whose only door is the grant with "voit les commentaires" off (owner, 2026-11-04). A caller must
   * say which one it is.
   *
   * @param opts.allowHidden a platform admin doing platform work (as `getById`'s flag). A write
   *   route never passes it: a hidden post takes no reaction, comment or like, an admin's included.
   * @returns the post and the reader's blocks, which the caller would otherwise read a second time.
   */
  async assertVisible(
    postId: string,
    viewerId: string | undefined,
    intent: PostAccessIntent,
    opts: { allowHidden?: boolean } = {}
  ): Promise<{ post: Post; blockedIds: string[] }> {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) {
      this.logger.debug(`${intent} ${postId} withheld: no such post`);
      throw new NotFoundException('Post not found');
    }
    const blockedIds = await this.assertOpenable(post, { ...opts, viewerId }, intent);
    return { post, blockedIds };
  }

  async createPost(data: any, isGlobalAdmin: boolean) {
    // A RESEND OF A QUEUED POST IS ONE POST (`post-client-id.ts`): the client minted the id, so a
    // row already holding it is this author's earlier request whose answer was lost. Answered
    // before anything is claimed or announced, so a replay claims no reel blob twice.
    const clientId: string | undefined = typeof data.id === 'string' ? data.id : undefined;
    if (clientId) {
      const replayed = await this.replayClientId(clientId, data.authorId, isGlobalAdmin);
      if (replayed) return replayed;
    }
    // "Entre étudiants": OFF unless asked, and refused (typed) where it is not offered.
    data.studentsOnly = data.studentsOnly === true;
    if (data.studentsOnly) {
      assertStudentsOnlyOffered(true, await this.associationTypeOf(data.associationId ?? null));
      this.logger.debug('[STUDENTS_ONLY] a post published for students only');
    }
    // An institution's reach (owner, 2026-11-10): its spaces and its public, chosen at EVERY post -
    // refused, typed, when missing on an institution's post or present on any other.
    const reach = await resolveInstitutionReachWrite(this.postRepo.manager, {
      mode: 'create',
      associationId: data.associationId ?? null,
      associationType: await this.associationTypeOf(data.associationId ?? null),
      raw: data.reach,
    });
    delete data.reach;
    data.reachPublic = reach?.reachPublic ?? null;
    data.reachSpaces = reach?.reachSpaces ?? null;
    // The event link is resolved where the row is written (`saveWithEventLink`), under the event's
    // lock - never here, where a presentation switch could land between the check and the insert.
    // A post is read by its audience: a DRAFT form attached to it would show them a form they cannot
    // open (`form-status.ts`). Published first, attached after.
    await assertFormNotDraft(this.postRepo.manager, data.attachedFormId, 'a post');
    if (Array.isArray(data.polls)) {
      data.polls = this.normalizePolls(data.polls);
    }
    // Extract mentions before saving so we can populate post.mentions
    const markdown: string = typeof data.markdown === 'string' ? data.markdown : '';
    const authorId: string = typeof data.authorId === 'string' ? data.authorId : '';
    // A mention never crosses the review cohort's boundary: it is neither stored nor notified.
    const mentionedIds = markdown
      ? this.notifications
          .resolveMentionedUserIds(markdown)
          .filter((id) => id !== authorId && sameSideOfReviewCohort(authorId, id))
      : [];
    if (mentionedIds.length > 0) {
      data.mentions = mentionedIds;
    }

    // Normalize media field: accept `media` (new) or `images` (legacy) from the client.
    if (Array.isArray(data.media)) {
      // already normalized
    } else if (Array.isArray(data.images)) {
      data.media = data.images;
    }
    delete data.images;
    // The cap on a post's attachments (typed 400); a reel carries its one video and never reaches it.
    assertWithinPostAttachmentCap(Array.isArray(data.media) ? data.media.length : 0);

    // THE KIND IS DECIDED HERE AND NOWHERE ELSE. The controller has already refused a malformed
    // reel (`assertCreateKindShape`); this stamps the three columns that stand or fall together and
    // proves the blob is the author's.
    let reelMediaIds: string[] = [];
    if (data.kind === 'reel') {
      reelMediaIds = postMediaIds({ media: data.media });
      await this.claimReelBlob(authorId, reelMediaIds);
      data.expiresAt = new Date(Date.now() + REEL_RETENTION_DAYS * DAY_MS);
    } else {
      data.kind = 'post';
      delete data.durationMs;
      // Every picture is the author's own upload: a delete of this post releases the blobs it names.
      await this.mediaRetention.assertOwnMedia(
        authorId,
        postMediaIds({ media: data.media }),
        'post'
      );
    }

    const post = this.postRepo.create(data) as unknown as Post;
    post.publishedAt = publicationTime(post.scheduledAt, new Date());
    let entity: Post;
    try {
      // A client id is INSERTED, never saved: `save` would turn into an UPDATE of a row that
      // appeared under that id since the check above, and a create must never overwrite a post.
      entity = await this.saveWithEventLink(post, true, (repo) =>
        clientId ? this.insertWithClientId(repo, post, clientId) : repo.save(post)
      );
    } catch (e) {
      // Two requests of one queued post raced past the check: the primary key took the first, and
      // this one is the replay it would have been a moment later. ITS reel claim is the row's that
      // won, so it is NOT handed back - the replay answers that row, which still shows the reel.
      if (
        clientId &&
        (await violatesUniqueColumns(e, ['id'], (q, p) => this.postRepo.query(q, p)))
      ) {
        const replayed = await this.replayClientId(clientId, data.authorId, isGlobalAdmin);
        if (replayed) return replayed;
      }
      // The blob was claimed for a reel that now will not exist. Hand it back to the idle clock so
      // it is not an exempt object nothing will ever reap - best-effort and logged by `release`.
      if (reelMediaIds.length > 0) await this.mediaRetention.release(reelMediaIds);
      throw e;
    }
    // A withdrawal that wrote the id's tombstone while this insert was on its way: the row must
    // not survive it. Read AFTER the insert committed, so either the withdrawal saw this row (and
    // deletes it) or this read sees its tombstone - never neither (`withdrawPost`).
    if (clientId && (await this.isDeletedPostId(clientId))) {
      this.logger.warn(
        `[POST-CREATE] post ${clientId.slice(0, 8)} withdrawn while it was created: removed again`
      );
      await this.postRepo.delete({ id: clientId });
      await this.mediaRetention.release(postMediaIds({ media: data.media }));
      throw new GoneException('This post was deleted');
    }
    await this.invalidateListCache();

    // The mentions are STORED here and told by `PostAnnounceScheduler` alone, under its one-shot
    // `feedNotifiedAt` claim, when the post is first published - at once (within a sweep) for a post
    // published now, at its date for a scheduled one. One teller, so no edit can tell them twice or
    // lose them (`notifyPostMentions`).
    if (mentionedIds.length > 0) {
      this.logger.debug(
        `[MENTION] post ${entity.id.slice(0, 8)}: ${mentionedIds.length} mention(s) left to its announcement`
      );
    }

    // The response goes back to the publisher, so it is stamped for them - an association post is
    // resolved through the flag like any other, never assumed from authorship, and a platform
    // admin is one here for the same reason they were one at the gate that let the write through.
    return this.toPublicPostFromEntity(
      entity,
      await this.viewerContext([entity], authorId || undefined, isGlobalAdmin)
    );
  }

  /**
   * The row an earlier request of the same queued post wrote under `clientId`, stamped for its
   * author as a create's answer is - or `null` when there is none and the create goes ahead.
   *
   * @throws ConflictException when the id is another author's post (`clientIdVerdict`).
   */
  private async replayClientId(clientId: string, authorId: string, isGlobalAdmin: boolean) {
    const existing = await this.postRepo.findOne({ where: { id: clientId } });
    const deleted = !existing && (await this.isDeletedPostId(clientId));
    if (deleted) {
      this.logger.warn(
        `[POST-CREATE] post ${clientId.slice(0, 8)} refused: that id belongs to a deleted post`
      );
    }
    if (clientIdVerdict(existing, deleted, authorId) === 'create') return null;
    this.logger.log(`[POST-CREATE] post ${clientId.slice(0, 8)} sent again: answered from its row`);
    return this.toPublicPostFromEntity(
      existing!,
      await this.viewerContext([existing!], authorId || undefined, isGlobalAdmin)
    );
  }

  /** Whether a post that held `postId` was deleted (`deleted_post_ids`, migration 135). */
  private async isDeletedPostId(postId: string): Promise<boolean> {
    const rows: unknown[] = await this.postRepo.query(
      'SELECT 1 FROM deleted_post_ids WHERE id = $1',
      [postId]
    );
    return rows.length > 0;
  }

  /**
   * THE AUTHOR TAKES BACK A POST THEY QUEUED, whether or not its create ever landed: the publish
   * queue's Delete (`posts.md#the-background-publish-queue`).
   *
   * Writes the id's tombstone FIRST, then deletes the row if there is one. A create of that id still
   * on its way either is seen here (and deleted) or sees the tombstone after its own insert (and
   * removes itself, `createPost`) - so the post never exists once this answered. Then the media the
   * queue uploaded for it (`mediaIds`) are deleted, except any a live row cites
   * (`deleteWithdrawnMedia`).
   *
   * ONLY EVER THE CALLER'S OWN POST, admin or not: the author is checked before the tombstone and
   * again on the row it would delete. Another author's post found on the second read (it was
   * created between the two) is left, and the tombstone this call wrote is taken back.
   *
   * @returns `deleted: true` when a row was removed, `false` when there was none (never created, or
   *          already gone) - both mean the post does not exist and never will.
   * @throws ConflictException when the id is another author's post.
   */
  async withdrawPost(postId: string, userId: string, mediaIds: string[] = []) {
    const before = await this.postRepo.findOne({ where: { id: postId } });
    if (before && before.authorId !== userId) {
      throw new ConflictException("This post id is another author's");
    }
    await this.postRepo.query(
      'INSERT INTO deleted_post_ids (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [postId]
    );
    const row = await this.postRepo.findOne({ where: { id: postId } });
    if (row && row.authorId !== userId) {
      // Created by another author between the two reads: their post stays, and so must its id.
      await this.postRepo.query('DELETE FROM deleted_post_ids WHERE id = $1', [postId]);
      this.logger.warn(
        `[POST-WITHDRAW] post ${postId.slice(0, 8)}: another author's row appeared - left, tombstone taken back`
      );
      throw new ConflictException("This post id is another author's");
    }
    // The ids the queue names are NOT released to the idle window first: released, they would no
    // longer be `archive`, media-service would refuse to delete them, and they would wait out the
    // sweep. `deleteWithdrawnMedia` deletes them now unless a live row cites them.
    //
    // HELD BACK means owed: an id held back and then NOT deleted (refused, missing from the answer,
    // or media-service unreachable) is released after all, or it would stay `archive` - exempt from
    // every sweep - for ever: a crafted request, or an app uninstalled between two attempts, would
    // otherwise strand it. Only the deleted row's own media can be held back (`deletePost` filters
    // its own list), so nothing another post holds is ever released here.
    const heldBack = row && row.kind !== 'reel' ? this.heldBackMedia(row, mediaIds) : [];
    if (row) await this.deletePost(postId, userId, false, { keep: mediaIds });
    let media: Awaited<ReturnType<PostMediaRetentionService['deleteWithdrawnMedia']>>;
    try {
      media = await this.mediaRetention.deleteWithdrawnMedia(userId, mediaIds);
    } catch (e) {
      if (heldBack.length > 0) {
        this.logger.warn(
          `[POST-WITHDRAW] post ${postId.slice(0, 8)}: media delete failed - ${heldBack.length} held-back media released to the idle window`
        );
        await this.mediaRetention.release(heldBack);
      }
      throw e;
    }
    const notTaken = new Set(media.notTaken);
    const stranded = heldBack.filter((id) => notTaken.has(id));
    if (stranded.length > 0) {
      this.logger.warn(
        `[POST-WITHDRAW] post ${postId.slice(0, 8)}: ${stranded.length} held-back media not deleted - released to the idle window`
      );
      await this.mediaRetention.release(stranded);
    }
    this.logger.log(
      `[POST-WITHDRAW] post ${postId.slice(0, 8)}: ${row ? 'deleted' : 'no row'}, the id is retired; media ${media.deleted} deleted, ${media.absent} gone, ${media.cited} cited, ${media.refused} refused`
    );
    return { ok: true, deleted: !!row };
  }

  /** The ids of `row`'s own media (its attachments and its comments') that `named` holds back. */
  private heldBackMedia(row: Post, named: string[]): string[] {
    const wanted = new Set(named);
    return [...postMediaIds(row), ...commentMediaIds(row.comments)].filter((id) => wanted.has(id));
  }

  /** INSERTs `post` under the client's id and reads back the row with its database defaults. */
  private async insertWithClientId(
    repo: Repository<Post>,
    post: Post,
    clientId: string
  ): Promise<Post> {
    post.id = clientId;
    await repo.insert(post);
    return repo.findOneOrFail({ where: { id: clientId } });
  }

  /**
   * Writes `post` through `write`, and when `linking` (the write SETS or CHANGES the link) and it
   * names an agenda event, resolves that link INSIDE the write's transaction under the event row's
   * `FOR SHARE` lock (`resolvePostCalendarEventLink`). An unchanged link is not re-checked: it is
   * already committed, so a presentation switch's linked-post check sees it, and an edit of the text
   * of a post whose event was since rejected or deleted stays possible.
   *
   * The presentation switch holds the same row `FOR NO KEY UPDATE` (`withEventLock`) while it asks
   * whether a post links the event, and the two locks conflict: either the post commits first and
   * the switch sees it (refused, `CALENDAR_NEUTRAL_LINKED_POST`), or the switch commits first and
   * the link reads the neutral row (refused, the same code). A check made before the transaction
   * left a window where both passed - a race that heals is still a defect.
   *
   * It locks the EVENT before writing the POST, which is safe only because `posts` holds no
   * foreign key to `associations` or to `association_calendar_events`, so the write takes no other
   * lock on them. Adding such a key must revisit the lock order documented on `withEventLock`.
   */
  private async saveWithEventLink(
    post: Post,
    linking: boolean,
    write: (repo: Repository<Post>) => Promise<Post>
  ): Promise<Post> {
    if (!linking || !post.linkedCalendarEventId) return write(this.postRepo);
    return this.postRepo.manager.transaction(async (manager) => {
      post.linkedCalendarEventId = await this.associationsService.resolvePostCalendarEventLink(
        post.associationId,
        post.linkedCalendarEventId,
        manager
      );
      return write(manager.getRepository(Post));
    });
  }

  /**
   * Batches the distinct `linkedCalendarEventId`s off a page of rows into one summary per event -
   * `listPosts` and `searchPosts` both need it, and a summary per DISTINCT event rather than per
   * row is what keeps a page of "same event, many posts" from repeating the same lookup.
   */
  private async batchLoadLinkedCalendarEvents(
    rows: { linkedCalendarEventId?: string | null }[],
    viewerId: string | undefined
  ): Promise<Map<string, Record<string, unknown>>> {
    const eventIds = [
      ...new Set(rows.map((r) => r.linkedCalendarEventId).filter((id): id is string => !!id)),
    ];
    if (eventIds.length === 0) return new Map();
    const summaries = await Promise.all(
      // The event keeps its OWN visibility (an institution's reach, owner 2026-11-13).
      eventIds.map((id) => this.associationsService.findValidatedCalendarEventSummary(id, viewerId))
    );
    const map = new Map<string, Record<string, unknown>>();
    eventIds.forEach((id, i) => {
      const summary = summaries[i];
      if (summary) map.set(id, summary);
    });
    return map;
  }

  /** Full-text search across post markdown and association names. Excludes future-scheduled posts. */
  async searchPosts(
    q: string,
    limit = 20,
    offset = 0,
    viewer?: { viewerUserId?: string; isAdmin?: boolean }
  ): Promise<any[]> {
    const term = q.trim();
    if (!term) return [];
    const isAdmin = viewer?.isAdmin === true;

    // A SEARCH RESULT RENDERS THE SAME CARD AS A FEED ROW, so it owes the same three exclusions.
    // It carried NONE of them: a post auto-hidden by the report threshold, which `listPosts` drops
    // from every feed, was reachable by anyone who typed a word of it - and so was the store-review
    // service account's. Whatever a feed refuses to show, a search over the same table refuses too.
    //
    // AND THE PROMO CUTOFF IS ONE OF THEM, which the first pass missed (user, 2026-08-23: "la
    // recherche desactive les filtres ?"): a search reached posts from before the viewer's arrival
    // that the feed stops at. It is a relevance limit, not a confidentiality one
    // (`promo-visibility.ts`), so this is consistency with the feed rather than a leak closed.
    const promoCutoff = await promoCutoffFor(this.postRepo.manager, viewer?.viewerUserId, isAdmin);
    const blockedIds = await blockedUserIdsFor(this.postRepo.manager, viewer?.viewerUserId);
    const params: unknown[] = [limit, offset, `%${term}%`];
    const promoSql = promoCutoff
      ? `AND posts."publishedAt" >= $${params.push(promoCutoff)}::timestamptz`
      : '';
    const bp = blockedIds.length > 0 ? params.push(blockedIds) : null;
    const viewerParam = params.push(viewer?.viewerUserId ?? null);

    const rawPosts: any[] = await this.postRepo.manager.query(
      `SELECT ${this.postSelectBody(bp)}
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE (posts.markdown ILIKE $3 OR assoc.name ILIKE $3)
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         ${promoSql}
         ${this.hiddenFilterSql(isAdmin)}
         ${this.liveReelFilterSql()}
         ${reviewCohortAuthorFilterSql(isAdmin, viewer?.viewerUserId)}
         ${this.blockedAuthorSql(bp)}
         AND ${postVisibleToViewerSql('posts', `$${viewerParam}`)}
       ORDER BY ${pinnedForViewerSql('posts', `$${viewerParam}`)} DESC, posts."publishedAt" DESC, posts.id DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    for (const post of rawPosts) {
      if (typeof post.mentions === 'string') {
        post.mentions = post.mentions ? post.mentions.split(',').filter(Boolean) : [];
      } else {
        post.mentions = post.mentions ?? [];
      }
      post.commentCount = Number(post.commentCount) || 0;
    }

    const authorIds = [
      ...new Set(
        rawPosts.filter((p: any) => !p.associationId && p.authorId).map((p: any) => p.authorId)
      ),
    ] as string[];

    let nameMap: Record<
      string,
      { displayName: string | null; firstName: string | null; lastName: string | null }
    > = {};
    if (authorIds.length > 0) {
      const rows: {
        id: string;
        displayName: string | null;
        firstName: string | null;
        lastName: string | null;
      }[] = await this.postRepo.manager.query(
        `SELECT id, "displayName", "firstName", "lastName" FROM users WHERE id = ANY($1)`,
        [authorIds]
      );
      nameMap = Object.fromEntries(
        rows.map((r) => [
          r.id,
          { displayName: r.displayName, firstName: r.firstName, lastName: r.lastName },
        ])
      );
    }

    await this.attachRepublishers(rawPosts);
    const viewerCtx = await this.viewerContext(rawPosts, viewer?.viewerUserId, isAdmin);
    const linkedEvents = await this.batchLoadLinkedCalendarEvents(rawPosts, viewerCtx.viewerId);

    await this.commentIdentity.serveRows(rawPosts, {
      viewerId: viewer?.viewerUserId,
      isGlobalAdmin: viewerCtx.isGlobalAdmin,
      moderatedPostIds: viewerCtx.moderatedIds,
    });

    const result = rawPosts.map((p: any) => {
      let row = p;
      if (!p.associationId && p.authorId) {
        const info = nameMap[p.authorId] ?? { displayName: null, firstName: null, lastName: null };
        row = {
          ...p,
          authorDisplayName: info.displayName,
          authorFirstName: info.firstName,
          authorLastName: info.lastName,
        };
      }
      if (row.linkedCalendarEventId) {
        row = { ...row, linkedCalendarEvent: linkedEvents.get(row.linkedCalendarEventId) ?? null };
      }
      return this.shapeListRow(row, viewerCtx);
    });

    return this.stripBigIntForJson(result);
  }

  /**
   * The column list every feed and search query selects, shaped for ONE viewer.
   *
   * `blockedParam` is the 1-based placeholder holding the accounts hidden from that viewer, or null
   * when there are none - in which case not a clause of this is emitted and the query is the one
   * that ran before blocking touched the feed at all.
   *
   * THE COMMENT WINDOW AND THE COMMENT COUNT ARE BOTH FILTERED HERE, IN SQL, because they answer
   * two different questions: the window is the last 20 rows, the count is the TOTAL. Filtering the
   * rows in JS after the fact could only correct the window, and would leave the count promising
   * comments the viewer is never going to be shown.
   *
   * A comment IS filtered on its author, EXCEPT an anonymous one or one written as an association:
   * filtering those on `userId` would make a block a de-anonymisation probe, exactly as it would
   * for a post (see `blockedAuthorSql`).
   */
  private postSelectBody(blockedParam: number | null): string {
    // A moderation tombstone is always shown (it names nobody: `commentShownDespiteBlocks`), and
    // never COUNTED - the count says how many comments there are, and a tombstone is not one.
    const shown =
      blockedParam === null
        ? 'TRUE'
        : `(COALESCE(elem->>'userId', '') <> ALL($${blockedParam}::text[])
             OR elem->>'anonymous' = 'true' OR COALESCE(elem->>'associationId', '') <> ''
             OR elem->>'removedByModeration' = 'true')`;
    const visibleComment = blockedParam === null ? '' : `WHERE ${shown}`;
    const commentCount = `(SELECT COUNT(*)::integer
             FROM jsonb_array_elements(COALESCE(posts.comments, '[]'::jsonb)) AS elem
             WHERE ${shown} AND COALESCE(elem->>'removedByModeration', '') <> 'true')`;
    return `posts.id,
         posts."authorId", posts.anonymous, posts.markdown, posts."createdAt", posts."publishedAt", posts."updatedAt",
         posts.mentions, posts.links, posts."attachedFormId", posts."associationId",
         posts."linkedCalendarEventId",
         posts.images, posts.polls, posts.forms, posts.reactions, posts."scheduledAt",
         posts.kind, posts."durationMs", posts."expiresAt", posts."liveId", posts."studentsOnly",
         posts."reachPublic", posts."reachSpaces",
         ${commentCount} AS "commentCount",
         (
           SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
           FROM (
             SELECT elem, ord
             FROM jsonb_array_elements(COALESCE(posts.comments, '[]'::jsonb))
               WITH ORDINALITY AS t(elem, ord)
             ${visibleComment}
             ORDER BY ord DESC LIMIT 20
           ) sub
         ) AS comments,
         assoc.id AS "assocJoinId", assoc.name AS "assocName", assoc.slug AS "assocSlug", assoc."logoUrl" AS "assocLogoUrl",
         assoc.type AS "assocType"`;
  }

  /** Moderation-hidden posts are invisible to every reader but a platform admin. */
  private hiddenFilterSql(isAdmin: boolean): string {
    return isAdmin ? '' : `AND NOT COALESCE(posts."hiddenByModeration", false)`;
  }

  /**
   * The clause that keeps a blocked account's posts out of one viewer's feed - the shared
   * `blockedAuthorSql` (`common/blocked-user-ids.ts`), whose note says why an association post and
   * an anonymous one are exempt. It is applied to the `followed` feed too, where severing the two
   * follows has usually removed these posts already - `UserBlocksService.severFollows` is a
   * cross-service call that is BEST-EFFORT by design and logs rather than fails, so "usually" is
   * exactly what it is.
   */
  private blockedAuthorSql(blockedParam: number | null): string {
    return blockedAuthorSql(blockedParam);
  }

  /**
   * Returns paginated posts for one of four feeds, or the CanaReels viewer's list:
   * - "associations": what associations publish or republish, a carried post at its latest
   *   republication (`republished-feed-sql.ts`)
   * - "all": every post, pinned first - filtered by SPACES: an accepted follower's reach across
   *   spaces (WP-F5) and a member repost (WP-F6) are not in it (decision 5)
   * - "followed": posts from associations and users the viewer follows, and what a followed
   *   association republished, placed at that republication - a followed person's post whatever
   *   their space (WP-F5)
   * - "custom": personal posts filtered by promo year and/or formation
   * - "reels": NOT a tab - the CanaReels viewer (`list-feed.ts`): every reel the reader may see,
   *   always `kind: 'reel'`, newest first by `publishedAt`
   *
   * Non-admin viewers with a promo year set cannot see posts published before
   * August 1st of their promo year.
   * Results are cached in Redis for 30 s. Future-scheduled posts are always excluded.
   */
  async listPosts(params: ListPostsParams) {
    const { feed, viewerUserId, isAdmin, promo, formation } = params;
    const kind = listKind(params);
    const singleMedia = kind === 'reel' ? singleMediaModeOf(params) : undefined;
    const limit = Number(params.limit);
    const offset = Number(params.offset);
    const cacheKey = this.listPostsCacheKey(
      feed,
      viewerUserId,
      promo,
      formation,
      limit,
      offset,
      kind,
      singleMedia,
      params.withReplays === true,
      feed === 'reels' && params.ranked === true,
      params.asOf,
      params.cursor
    );

    // The stamp is read BEFORE the page is computed, so a page computed across an invalidation is
    // stored under the generation it started in and never served (`readPostListPage`). No stamp
    // (Redis unreachable) means no page is stored either.
    // A RANKED FIRST PAGE IS NEVER CACHED: writing its snapshot IS the request. A cached one would
    // name a snapshot the trim may already have pushed out (`RANKED_SNAPSHOTS_KEPT`), and the
    // client's re-rank after a 410 would be handed that dead ranking again.
    const rankedFirstPage =
      !params.asOf && (feed === 'foryou' || (feed === 'reels' && params.ranked === true));
    let stamp: string | null = null;
    let cachedPage: unknown = undefined;
    if (rankedFirstPage) {
      this.logger.debug(`[RANKED] ${feed} first page: ranked now, never read from the list cache`);
    } else {
      try {
        const cached = (await Promise.race([
          readPostListPage(this.redis, cacheKey, viewerUserId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 100)),
        ])) as { page: unknown; stamp: string };
        stamp = cached.stamp;
        cachedPage = cached.page;
      } catch {
        // Redis miss or error - fall through to DB
      }
    }
    // OUTSIDE the cache's try: only a Redis failure falls through to the database, never a failure
    // of what is served on top of the page. The stored page is what this method returned before,
    // parsed: as untyped as JSON.parse was.
    if (cachedPage !== undefined) return await this.withReplayRowFacts(cachedPage as any);

    const rawPosts = await this.listPostRows(params);
    const safe = await this.decorateListRows(rawPosts, viewerUserId, isAdmin === true);

    if (stamp !== null && !rankedFirstPage) {
      try {
        await writePostListPage(this.redis, cacheKey, stamp, safe, PostsService.LIST_CACHE_TTL);
      } catch {
        // Non-fatal
      }
    }

    // AFTER the page is stored: a replay's cover key and the server's clock are read per serve.
    return await this.withReplayRowFacts(safe);
  }

  /**
   * THE VIEWER'S SUGGESTED POSTS (engagement WP-7, decision 8), decorated like every feed row: the
   * ids come from `suggestedPostIds` (the space rule, the feed's block filter, popularity - its note
   * holds every rule), the rows from the feed's own select, in that order. Not cached: one read per
   * Mon espace opening, bounded at {@link SUGGESTED_POSTS_MAX}.
   */
  async listSuggestedPosts(viewerUserId: string, isAdmin: boolean): Promise<any> {
    const ids = await suggestedPostIds(
      this.postRepo.manager,
      viewerUserId,
      isAdmin,
      SUGGESTED_POSTS_MAX
    );
    this.logger.debug(`[SUGGESTED_POSTS] ${viewerUserId.slice(0, 8)} ${ids.length} post(s)`);
    if (ids.length === 0) return [];
    const blockedIds = await blockedUserIdsFor(this.postRepo.manager, viewerUserId);
    const bp = blockedIds.length > 0 ? 2 : null;
    const rows: any[] = await this.postRepo.manager.query(
      `SELECT ${this.postSelectBody(bp)}
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE posts.id = ANY($1::uuid[])`,
      [ids, ...(blockedIds.length > 0 ? [blockedIds] : [])]
    );
    const rank = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    return this.decorateListRows(rows, viewerUserId, isAdmin);
  }

  /**
   * A page of raw list rows made into what the client draws: mentions parsed, the authors' names,
   * the republishers, the viewer's context, the comment identities, the linked events, then
   * `shapeListRow` - the decoration of every feed page, and of the suggested posts (WP-7), which are
   * feed rows like any other.
   */
  private async decorateListRows(
    rawPosts: any[],
    viewerUserId: string | undefined,
    isAdmin: boolean
  ): Promise<any> {
    for (const post of rawPosts) {
      if (typeof post.mentions === 'string') {
        post.mentions = post.mentions ? post.mentions.split(',').filter(Boolean) : [];
      } else {
        post.mentions = post.mentions ?? [];
      }
      post.commentCount = Number(post.commentCount) || 0;
    }

    const authorIds = [
      ...new Set(
        rawPosts.filter((p: any) => !p.associationId && p.authorId).map((p: any) => p.authorId)
      ),
    ] as string[];

    let nameMap: Record<
      string,
      { displayName: string | null; firstName: string | null; lastName: string | null }
    > = {};
    if (authorIds.length > 0) {
      const rows: {
        id: string;
        displayName: string | null;
        firstName: string | null;
        lastName: string | null;
      }[] = await this.postRepo.manager.query(
        `SELECT id, "displayName", "firstName", "lastName" FROM users WHERE id = ANY($1)`,
        [authorIds]
      );
      nameMap = Object.fromEntries(
        rows.map((r) => [
          r.id,
          { displayName: r.displayName, firstName: r.firstName, lastName: r.lastName },
        ])
      );
    }

    await this.attachRepublishers(rawPosts);
    const viewerCtx = await this.viewerContext(rawPosts, viewerUserId, isAdmin);
    const linkedEvents = await this.batchLoadLinkedCalendarEvents(rawPosts, viewerCtx.viewerId);

    await this.commentIdentity.serveRows(rawPosts, {
      viewerId: viewerUserId,
      isGlobalAdmin: viewerCtx.isGlobalAdmin,
      moderatedPostIds: viewerCtx.moderatedIds,
    });

    const result = rawPosts.map((p: any) => {
      let row = p;
      if (!p.associationId && p.authorId) {
        const authorInfo = nameMap[p.authorId] ?? {
          displayName: null,
          firstName: null,
          lastName: null,
        };
        row = {
          ...p,
          authorDisplayName: authorInfo.displayName,
          authorFirstName: authorInfo.firstName,
          authorLastName: authorInfo.lastName,
        };
      }
      if (row.linkedCalendarEventId) {
        row = { ...row, linkedCalendarEvent: linkedEvents.get(row.linkedCalendarEventId) ?? null };
      }
      return this.shapeListRow(row, viewerCtx);
    });

    return this.stripBigIntForJson(result);
  }

  /**
   * A LIVE REPLAY'S ROW, AS SERVED (docs/wiki/live-replays.md, WP-R4): its live's last preview as the
   * cover (`poster`, `posterKey`) and the database's clock (`serverNow`) beside its `expiresAt`, so
   * the feed card draws the time left without the phone's clock (`readReplayRowFacts`). Added at
   * serve time on the cached and the computed page alike, never stored with the page. A page with no
   * replay - every page while `live_replays_mode` is off - reads nothing and is returned as it is.
   * A read that fails is logged at ERROR and the rows go out without the facts - never a 500.
   */
  private async withReplayRowFacts<T>(page: T): Promise<T> {
    if (!Array.isArray(page)) return page;
    const liveIds = page
      .filter((p: any) => p?.kind === 'replay' && typeof p.liveId === 'string')
      .map((p: any) => p.liveId as string);
    if (liveIds.length === 0) return page;
    let facts: Map<string, ReplayRowFacts>;
    try {
      facts = await readReplayRowFacts(this.postRepo.manager, liveIds);
    } catch (e) {
      // A MISSING COVER NEVER FAILS THE FEED: the rows go out with no cover and no server clock
      // (the card then draws neither), and the cause is named here.
      this.logger.error(
        `[LIVE_REPLAY] ${liveIds.length} replay row(s) served without cover or clock: ${e instanceof Error ? e.message : String(e)}`
      );
      return page;
    }
    return page.map((p: any) => {
      const f = p?.kind === 'replay' ? facts.get(p.liveId) : undefined;
      if (p?.kind === 'replay' && !f) {
        this.logger.warn(`[LIVE_REPLAY] row ${p.id} served without its facts (live ${p.liveId})`);
      }
      return f ? { ...p, ...f } : p;
    }) as T;
  }

  /**
   * The rows of one list page, undecorated: the one query of the requested arm, its filters and its
   * order. Split from `listPosts` so the set each arm returns is compared on PostgreSQL
   * (`reels-list.integration.spec.ts`) without the decoration's own reads.
   */
  private async listPostRows(params: ListPostsParams): Promise<any[]> {
    const { feed, viewerUserId, isAdmin, promo, formation } = params;
    const kind = listKind(params);
    const singleMedia = kind === 'reel' ? singleMediaModeOf(params) : undefined;
    const limit = Number(params.limit);
    const offset = Number(params.offset);

    // Promo-based date gate: a viewer cannot see posts published before the August their own
    // promo opens on. SHARED WITH THE AGENDA since 2026-09-20 - the rule, and why it is a
    // relevance limit rather than a confidentiality one, is in `promo-visibility.ts`.
    const promoCutoff = await promoCutoffFor(this.postRepo.manager, viewerUserId, isAdmin);

    // Read AFTER the cache and never before it: the cache key already names the viewer, so a hit
    // needs none of this and a miss pays one indexed lookup bounded at 200 rows. A block therefore
    // reaches the feed at the end of that 30 s window rather than on the next request, which is
    // the cache's own staleness and not a second mechanism.
    const blockedIds = await blockedUserIdsFor(this.postRepo.manager, viewerUserId);
    const blockedParams = blockedIds.length > 0 ? [blockedIds] : [];

    // The blocked-accounts array is appended LAST to every arm's parameters, so its placeholder is
    // whichever index that arm leaves free - and null when there is nobody to hide, which emits no
    // clause at all and leaves the query byte-identical to the one that ran before.
    const blockedAt = (next: number) => (blockedIds.length > 0 ? next : null);

    // SQL fragment added to every query when a promo cutoff applies.
    // The parameter index is computed per-query below.
    const promoSql = (idx: number) =>
      promoCutoff ? `AND posts."publishedAt" >= $${idx}::timestamptz` : '';

    let followedAssocIds: string[] | undefined;
    let followedUserIds: string[] | undefined;
    if (feed === 'followed' || feed === 'foryou') {
      [followedAssocIds, followedUserIds] = await Promise.all([
        this.followsService.getFollowedAssociationIdsForUser(viewerUserId),
        this.followsService.getFollowedUserIdsForUser(viewerUserId),
      ]);
      // Pour toi is not empty without a follow: it still holds the suggested posts.
      if (feed === 'followed' && followedAssocIds.length === 0 && followedUserIds.length === 0) {
        return [];
      }
    }

    let rawPosts: any[];
    const promoParam = promo === undefined ? null : promo;
    const formationParam = formation === undefined || formation === '' ? null : formation;

    const hiddenFilter = this.hiddenFilterSql(isAdmin === true);
    // A dead reel is excluded in EVERY arm, and `kind` (absent = both) narrows every arm alike.
    const withReplays = params.withReplays === true;
    const reelFilters = `${this.liveReelFilterSql(withReplays)}\n         ${this.kindFilterSql(kind, singleMedia)}`;
    const serviceAccountFilter = reviewCohortAuthorFilterSql(isAdmin === true, viewerUserId);
    // WHICH POSTS THIS READER MAY SEE (WP6b), in every arm. The viewer goes LAST, after the optional
    // promo cutoff and blocked list (`tail`), so its placeholder is the next free index of each arm.
    const tail = [...(promoCutoff ? [promoCutoff] : []), ...blockedParams];
    const viewerParam = viewerUserId ?? null;
    const visibleAt = (index: number) =>
      `AND ${postVisibleToViewerSql('posts', `$${index}`)} ${this.replayNotRemovedSql(withReplays, `$${index}`)}`;
    // "Tout" and the promo/formation browse are feeds of SPACES (decision 5 of the follow requests,
    // user 2026-10-25): what an accepted follower reads across spaces (WP-F5) appears in Suivis,
    // never in these two - the predicate without its follower disjunct.
    const spaceVisibleAt = (index: number) =>
      `AND ${postVisibleToViewerSql('posts', `$${index}`, { followers: false })} ${this.replayNotRemovedSql(withReplays, `$${index}`)}`;
    // "Associations" lists what associations publish and republish; a MEMBER repost is a person's
    // reach, and appears in Suivis only (WP-F6) - an entity post a reader sees only because someone
    // they follow reposted it is not in this feed.
    const associationsVisibleAt = (index: number) =>
      `AND ${postVisibleToViewerSql('posts', `$${index}`, { memberReposts: false })} ${this.replayNotRemovedSql(withReplays, `$${index}`)}`;

    if (feed === 'foryou' || (feed === 'reels' && params.ranked === true)) {
      // THE RANKED LISTS (`for-you-feed.ts`): every filter of the arms above, bound per query.
      const filters = (bind: Bind) => {
        const viewer = bind(viewerParam);
        const blocked = blockedIds.length > 0 ? placeholderIndex(bind(blockedIds)) : null;
        const cutoff = promoCutoff
          ? `AND posts."publishedAt" >= ${bind(promoCutoff)}::timestamptz`
          : '';
        return `${hiddenFilter}
         ${reelFilters}
         ${serviceAccountFilter}
         ${this.blockedAuthorSql(blocked)}
         ${cutoff}
         AND ${postVisibleToViewerSql('posts', viewer)} ${this.replayNotRemovedSql(withReplays, viewer)}`;
      };
      // Everything that changes the candidates names the snapshot: two lists never share one.
      const rankedList = `${feed}:${kind ?? '-'}${singleMedia ? `+${singleMedia}` : ''}${withReplays ? '+replays' : ''}`;
      const arm: RankedArm =
        feed === 'foryou'
          ? {
              // Pour toi: what PEOPLE the reader follows write or repost (owner, 2026-11-10).
              list: rankedList,
              candidates: (bind, asOf) =>
                forYouFollowedSql(bind(followedUserIds ?? []), bind(viewerParam), asOf),
              filters,
              blockedIds,
              suggestedIds: () =>
                suggestedPostIds(
                  this.postRepo.manager,
                  viewerUserId,
                  isAdmin === true,
                  SUGGESTED_POSTS_MAX,
                  { peopleOnly: true }
                ),
              banded: true,
            }
          : {
              // CanaReels: every reel the reader may see (the `reels` arm's set), ranked.
              list: rankedList,
              candidates: () => ({ join: '', admitted: 'TRUE', at: 'posts."publishedAt"' }),
              filters,
              blockedIds,
              suggestedIds: () => Promise.resolve([]),
              banded: false,
            };
      return this.listRankedRows(params, arm);
    }

    if (feed === 'associations') {
      // $1=limit, $2=offset, $3=promoCutoff (optional), $4=blockedIds (optional)
      // What associations publish AND republish (`republished-feed-sql.ts`): a member's post an
      // association carries is in it, so `blockedAuthorSql` applies as in every other arm - it
      // exempts association and anonymous posts by itself.
      const bp = blockedAt(promoCutoff ? 4 : 3);
      rawPosts = await this.postRepo.manager.query(
        `SELECT ${this.postSelectBody(bp)}
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE ${inAssociationsFeedSql(`$${3 + tail.length}`)}
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         ${hiddenFilter}
         ${reelFilters}
         ${serviceAccountFilter}
         ${this.blockedAuthorSql(bp)}
         ${promoSql(3)}
         ${associationsVisibleAt(3 + tail.length)}
       ${this.listOrderSql(kind, `$${3 + tail.length}`, republishedFeedAtSql(`$${3 + tail.length}`))}
       LIMIT $1 OFFSET $2`,
        [limit, offset, ...tail, viewerParam]
      );
    } else if (feed === 'all' || feed === 'reels') {
      // $1=limit, $2=offset, $3=promoCutoff (optional), $4=blockedIds (optional)
      // ONE query for "Mon espace" and the CanaReels viewer, differing in the predicate only: the
      // viewer is every reel the reader may see (`list-feed.ts`), so it asks the WHOLE predicate -
      // the follower and member-repost doors included, which the tab leaves to Suivis (decision 5).
      // Every other clause - hidden, live reel, review cohort, blocks, schedule, promo cutoff - is
      // the one every arm applies. A row is one post, so a reel reached through a follow AND a
      // repost is listed once, at its `publishedAt`.
      const bp = blockedAt(promoCutoff ? 4 : 3);
      const allVisibleAt = feed === 'reels' ? visibleAt : spaceVisibleAt;
      this.logger.debug(
        `list ${feed}: ${feed === 'reels' ? 'the whole visibility predicate' : 'filtered by spaces'}`
      );
      rawPosts = await this.postRepo.manager.query(
        `SELECT ${this.postSelectBody(bp)}
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         ${hiddenFilter}
         ${reelFilters}
         ${serviceAccountFilter}
         ${this.blockedAuthorSql(bp)}
         ${promoSql(3)}
         ${allVisibleAt(3 + tail.length)}
       ${this.listOrderSql(kind, `$${3 + tail.length}`)}
       LIMIT $1 OFFSET $2`,
        [limit, offset, ...tail, viewerParam]
      );
    } else if (feed === 'followed') {
      // $1=limit, $2=offset, $3=followedAssocIds, $4=followedUserIds, $5=promoCutoff (optional),
      // $6=blockedIds (optional)
      const bp = blockedAt(promoCutoff ? 6 : 5);
      const followed = followedFeedSql('$3', '$4', `$${5 + tail.length}`);
      rawPosts = await this.postRepo.manager.query(
        `SELECT ${this.postSelectBody(bp)}
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       ${followed.join}
       WHERE ${followed.admitted}
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         ${hiddenFilter}
         ${reelFilters}
         ${serviceAccountFilter}
         ${this.blockedAuthorSql(bp)}
         ${promoSql(5)}
         ${visibleAt(5 + tail.length)}
       ${this.listOrderSql(kind, `$${5 + tail.length}`, followed.at)}
       LIMIT $1 OFFSET $2`,
        [limit, offset, followedAssocIds, followedUserIds, ...tail, viewerParam]
      );
    } else {
      // $1=limit, $2=offset, $3=promoParam, $4=formationParam, $5=promoCutoff (optional),
      // $6=blockedIds (optional)
      const bp = blockedAt(promoCutoff ? 6 : 5);
      rawPosts = await this.postRepo.manager.query(
        `SELECT ${this.postSelectBody(bp)}
       FROM posts
       INNER JOIN users u ON u.id = posts."authorId"
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE posts."associationId" IS NULL
         AND ($3::integer IS NULL OR u.promo = $3::integer)
         AND ($4::text IS NULL OR u.formation ILIKE ('%' || $4::text || '%'))
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         ${hiddenFilter}
         ${reelFilters}
         ${serviceAccountFilter}
         ${this.blockedAuthorSql(bp)}
         ${promoSql(5)}
         ${spaceVisibleAt(5 + tail.length)}
       ${this.listOrderSql(kind, `$${5 + tail.length}`)}
       LIMIT $1 OFFSET $2`,
        [limit, offset, promoParam, formationParam, ...tail, viewerParam]
      );
    }

    return rawPosts;
  }

  /**
   * ONE PAGE OF A RANKED LIST - Pour toi, or the CanaReels viewer asked `ranked` (`for-you-feed.ts`
   * holds the design): without `asOf`, the window is ranked now, kept as a snapshot and its first
   * slice served; with it, a slice of that snapshot, then of the tail below `cursor`. Every row
   * carries `feedAsOf`, `feedPosition`, for a suggestion `feedSuggested`, for a tail row
   * `feedCursor`.
   *
   * The arm's filters apply to every row served, on every page: a post deleted, hidden, blocked or
   * no longer readable since the ranking is not served, and takes no position from the rows after
   * it. A snapshot that is gone is a 410, a Redis that does not answer a 503 - never an empty page.
   */
  private async listRankedRows(params: ListPostsParams, arm: RankedArm): Promise<any[]> {
    const viewerKey = params.viewerUserId ?? 'anon';
    const limit = Number(params.limit);
    const offset = Number(params.offset);
    const manager = this.postRepo.manager;

    if (!params.asOf && (offset > 0 || params.cursor)) {
      // A later page names its ranking: one asked without is a client that mixed two shapes of
      // one list (a first page in the older shape, then a ranked one) - refused, never re-ranked.
      this.logger.warn(
        `[RANKED] ${arm.list}: a page at offset ${offset} without the asOf of its ranking - refused`
      );
      throw new BadRequestException({
        code: RANKING_PAGE_INVALID,
        message: 'A later page of a ranked list names the asOf of its first page',
      });
    }

    let snapshot: RankedSnapshot | null;
    if (params.asOf) {
      try {
        snapshot = await readRankedSnapshot(this.redis, arm.list, viewerKey, params.asOf);
      } catch (e) {
        this.logger.error(
          `[RANKED] ${arm.list}: the ranking of ${params.asOf} could not be read - 503: ${e instanceof Error ? e.message : String(e)}`
        );
        throw new ServiceUnavailableException({
          code: RANKING_UNAVAILABLE,
          message: 'The ranking could not be read',
        });
      }
      if (!snapshot) {
        // Expected after RANKED_SNAPSHOT_TTL_SECONDS without a page, or once RANKED_SNAPSHOTS_KEPT
        // newer rankings pushed it out: the client ranks anew.
        this.logger.log(
          `[RANKED] ${arm.list}: the ranking of ${params.asOf} is gone (offset ${offset}) - 410`
        );
        throw new GoneException({ code: RANKING_GONE, message: 'The ranking is gone' });
      }
    } else {
      snapshot = await this.rankWindow(arm);
      try {
        const dropped = await writeRankedSnapshot(this.redis, arm.list, viewerKey, snapshot);
        if (dropped > 0) {
          this.logger.debug(
            `[RANKED] ${arm.list} ${viewerKey.slice(0, 8)}: ${dropped} older ranking(s) dropped`
          );
        }
      } catch (e) {
        // Never a first page whose page 2 would have nothing to be a slice of.
        this.logger.error(
          `[RANKED] ${arm.list}: the ranking of ${snapshot.asOf} could not be kept - 503: ${e instanceof Error ? e.message : String(e)}`
        );
        throw new ServiceUnavailableException({
          code: RANKING_UNAVAILABLE,
          message: 'The ranking could not be kept',
        });
      }
    }
    const kept = snapshot;
    const { asOf } = kept;
    if (params.cursor ? offset < kept.ids.length : offset > kept.ids.length) {
      // A cursor names a tail row, so it follows the window; past the window, the tail is read
      // below the cursor and never from an offset (which a withdrawn row would shift).
      this.logger.warn(
        `[RANKED] ${arm.list}: offset ${offset} ${params.cursor ? 'with' : 'without'} a tail cursor, window of ${kept.ids.length} - refused`
      );
      throw new BadRequestException({
        code: RANKING_PAGE_INVALID,
        message: 'A tail page names the cursor of the last tail row, and only past the window',
      });
    }

    const out: any[] = [];
    let tailLimit: number | null = limit;
    if (offset < kept.ids.length) {
      // The slice, in two reads: which of the ids left still pass the filters (ids only), then the
      // full rows of the first `limit` of those - never the full rows of the whole window left.
      const remaining = kept.ids.slice(offset);
      const passing = await (async () => {
        const { bind, params: values } = sqlBinder();
        const rows: { id: string }[] = await manager.query(
          `SELECT posts.id::text AS id
         FROM posts
         LEFT JOIN associations assoc ON assoc.id = posts."associationId"
         WHERE posts.id = ANY(${bind(remaining)}::uuid[])
           AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
           ${arm.filters(bind)}`,
          values
        );
        return new Set(rows.map((r) => r.id));
      })();
      const slice = forYouSlice({ ids: kept.ids, offset, limit, served: passing });
      tailLimit = slice.tail;
      if (slice.picks.length > 0) {
        const { bind, params: values } = sqlBinder();
        const bp = arm.blockedIds.length > 0 ? placeholderIndex(bind(arm.blockedIds)) : null;
        const rows: any[] = await manager.query(
          `SELECT ${this.postSelectBody(bp)}
         FROM posts
         LEFT JOIN associations assoc ON assoc.id = posts."associationId"
         WHERE posts.id = ANY(${bind(slice.picks.map((p) => p.id))}::uuid[])
           AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
           ${arm.filters(bind)}`,
          values
        );
        const byId = new Map(rows.map((r) => [String(r.id), r]));
        const suggested = new Set(kept.suggested);
        for (const { id, position } of slice.picks) {
          const row = byId.get(id);
          if (!row) continue; // withdrawn between the two reads: it takes no place
          out.push({
            ...row,
            feedAsOf: asOf,
            feedPosition: position,
            ...(suggested.has(id) ? { feedSuggested: true } : {}),
          });
        }
      }
    }

    if (tailLimit !== null) {
      // THE TAIL: the candidates placed below the window's boundary - or below the last tail row
      // served (`cursor`, a keyset) - newest first, as of the ranking (reposts after `asOf` do not
      // count), never a post of the snapshot.
      const below = params.cursor ? parseForYouCursor(params.cursor) : kept.tailBefore;
      const firstPosition = params.cursor ? offset : kept.ids.length;
      const { bind, params: values } = sqlBinder();
      const bp = arm.blockedIds.length > 0 ? placeholderIndex(bind(arm.blockedIds)) : null;
      const asOfSql = `${bind(asOf)}::timestamptz`;
      const c = arm.candidates(bind, asOfSql);
      const rows: any[] = await manager.query(
        `SELECT ${this.postSelectBody(bp)}, ${forYouInstantTextSql(c.at)} AS "rankedAt"
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       ${c.join}
       WHERE ${c.admitted}
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         AND posts."publishedAt" <= ${asOfSql}
         AND (${c.at}, posts.id) < (${bind(below.at)}::timestamptz, ${bind(below.id)}::uuid)
         AND posts.id <> ALL(${bind(kept.ids)}::uuid[])
         ${arm.filters(bind)}
       ORDER BY ${c.at} DESC, posts.id DESC
       LIMIT ${bind(tailLimit)}`,
        values
      );
      rows.forEach(({ rankedAt, ...row }, i) =>
        out.push({
          ...row,
          feedAsOf: asOf,
          feedPosition: firstPosition + i,
          feedCursor: forYouCursorOf(rankedAt, String(row.id)),
        })
      );
    }
    this.logger.debug(
      `[RANKED] ${arm.list} ${viewerKey.slice(0, 8)} as of ${asOf}: offset ${offset}${params.cursor ? ' (tail cursor)' : ''}, ${out.length} row(s), window ${kept.ids.length} (${kept.suggested.length} suggested)`
    );
    return out;
  }

  /**
   * How many candidates a ranked window holds at most ({@link FOR_YOU_WINDOW_MAX}). A field so an
   * integration spec can prove the cut and the tail below it with a handful of rows.
   */
  rankedWindowMax = FOR_YOU_WINDOW_MAX;

  /**
   * RANKS A LIST NOW: the arm's candidates placed in the window, and the arm's suggestions (Pour
   * toi's, WP-7's rules unchanged), ordered by ONE score (`forYouScoreSql`) with no quota (owner,
   * 2026-11-10) - in Pour toi, within its bands (`forYouBandSql`: the followed posts of the last 48 h,
   * then the suggestions, then the rest) - as a snapshot. ONE ROW PER POST: the candidates are one
   * row per post (the repost lateral aggregates), and a post both a candidate and a suggestion is the
   * candidate.
   */
  private async rankWindow(arm: RankedArm): Promise<RankedSnapshot> {
    const manager = this.postRepo.manager;
    const windowMax = this.rankedWindowMax;
    const [clock]: { asOf: string; windowStart: string }[] = await manager.query(
      `SELECT ${forYouInstantTextSql('now()')} AS "asOf",
              ${forYouInstantTextSql(`now() - make_interval(days => ${FOR_YOU_WINDOW_DAYS})`)} AS "windowStart"`
    );
    const suggestedIds = await arm.suggestedIds();
    const { bind, params: values } = sqlBinder();
    const asOf = `${bind(clock.asOf)}::timestamptz`;
    const c = arm.candidates(bind, asOf);
    const engaged = engagedAccountsSql('posts');
    const ranked: ForYouRankedRow[] = await manager.query(
      `WITH fw AS (
         SELECT posts.id, ${c.at} AS at, ${engaged} AS engaged
           FROM posts
           LEFT JOIN associations assoc ON assoc.id = posts."associationId"
           ${c.join}
          WHERE ${c.admitted}
            AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= ${asOf})
            AND posts."publishedAt" <= ${asOf}
            AND ${c.at} >= ${asOf} - make_interval(days => ${FOR_YOU_WINDOW_DAYS})
            ${arm.filters(bind)}
          ORDER BY at DESC, posts.id DESC
          LIMIT ${bind(windowMax)}
       ), sg AS (
         SELECT posts.id, posts."publishedAt" AS at, ${engaged} AS engaged
           FROM posts
          WHERE posts.id = ANY(${bind(suggestedIds)}::uuid[]) AND posts.id NOT IN (SELECT fw.id FROM fw)
       ), ranked AS (
         SELECT id, at, engaged, false AS suggested FROM fw
         UNION ALL
         SELECT id, at, engaged, true AS suggested FROM sg
       )
       SELECT ranked.id::text AS id, ${forYouInstantTextSql('ranked.at')} AS at, ranked.suggested
         FROM ranked
        ORDER BY ${arm.banded ? `${forYouBandSql('ranked.suggested', 'ranked.at', asOf)},` : ''}
                 ${forYouScoreSql('ranked.engaged', 'ranked.at', asOf)} DESC, ranked.at DESC, ranked.id DESC`,
      values
    );
    return forYouSnapshotOf(clock.asOf, clock.windowStart, ranked, windowMax);
  }

  /**
   * Returns the posts currently hidden by moderation, with their pending report count, within the
   * caller's scope (owner, 2026-11-02): every one for a platform admin, those of its governed spaces
   * for a BDE `MODERATE` holder (`bdeModeratesContentSql`). The caller is a moderator already.
   */
  async getHiddenPosts(scope: { userId: string; isGlobalAdmin: boolean }): Promise<any[]> {
    return this.postRepo.manager.query(
      `SELECT p.id, p."authorId", p.markdown, p."createdAt", p."associationId",
              (SELECT COUNT(*)::int FROM content_reports cr
               WHERE cr."contentId" = p.id::text AND cr.status = 'pending') AS "pendingReportCount"
       FROM posts p
       WHERE p."hiddenByModeration" = true
         AND ($2::boolean OR ${bdeModeratesContentSql('$1', 'p."associationId"', 'p."authorId"')})
       ORDER BY p."createdAt" DESC
       LIMIT 200`,
      [scope.userId ?? '', scope.isGlobalAdmin]
    );
  }

  /** Hides a post from public feeds pending moderator review. Admin only. */
  async hidePostByModeration(postId: string): Promise<{ ok: boolean }> {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    if (!post.hiddenByModeration) {
      post.hiddenByModeration = true;
      await this.postRepo.manager.transaction(async (manager) => {
        await manager.save(post);
        // D38: a hidden post loses every republication and pending repost proposal.
        const dropped = await dropRepublicationsOf(manager, postId);
        this.logger.log(
          `[MODERATION] post ${postId} hidden: ${dropped.republications} republication(s), ` +
            `${dropped.proposals} pending proposal(s) removed`
        );
      });
      await this.invalidateListCache();
    }
    return { ok: true };
  }

  /** Restores a moderation-hidden post back to the public feed. Admin only. */
  async unhidePost(postId: string): Promise<{ ok: boolean }> {
    await this.postRepo.manager.query(
      `UPDATE posts SET "hiddenByModeration" = false WHERE id = $1`,
      [postId]
    );
    await this.invalidateListCache();
    return { ok: true };
  }

  /** Clears the anonymous flag, revealing the post's author again. One-directional: an author who
   *  did not choose anonymity at creation has no route back into it later. */
  async clearAnonymousFlag(postId: string): Promise<{ ok: boolean }> {
    await this.postRepo.manager.query(`UPDATE posts SET anonymous = false WHERE id = $1`, [postId]);
    await this.invalidateListCache();
    return { ok: true };
  }

  /**
   * The future-scheduled posts THIS CALLER MAY EDIT, soonest first, each as the whole card the feed
   * draws (`serveToReader`) - what the top of `/posts` shows an editor until the post is due
   * (owner, 2026-11-13). Nobody else is ever handed one: the feed's audience predicate is untouched
   * and a scheduled post is still invisible to every reader.
   *
   * WHO MAY EDIT is `isPublisherOf` - the very predicate `assertMayEdit` (so `updatePost`) applies:
   * the author of a personal post, or whoever holds `POST_AS_ASSO` in the association a post speaks
   * for (authorship grants an officer nothing there). The SQL only narrows to candidates (own
   * personal posts, every association post); `isPublisherOf` decides, once per association.
   */
  async getScheduledPostsIMayEdit(userId: string): Promise<Record<string, any>[]> {
    if (!userId) return [];
    const candidates: { id: string; authorId: string | null; associationId: string | null }[] =
      await this.postRepo.manager.query(SCHEDULED_EDIT_CANDIDATES_SQL, [userId]);
    const verdictByAssociation = new Map<string, boolean>();
    const editable: string[] = [];
    for (const c of candidates) {
      if (editable.length >= SCHEDULED_EDIT_LIMIT) break;
      let ok: boolean;
      if (c.associationId) {
        if (!verdictByAssociation.has(c.associationId)) {
          verdictByAssociation.set(c.associationId, await this.isPublisherOf(c as Post, userId));
        }
        ok = verdictByAssociation.get(c.associationId) === true;
      } else {
        ok = await this.isPublisherOf(c as Post, userId);
      }
      if (ok) editable.push(c.id);
    }
    this.logger.debug(
      `[SCHEDULED] ${userId.slice(0, 8)}: ${candidates.length} candidate(s), ${editable.length} editable`
    );
    if (editable.length === 0) return [];
    const posts = await this.postRepo.find({ where: { id: In(editable) } });
    const order = new Map(editable.map((id, i) => [id, i]));
    posts.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const out: Record<string, any>[] = [];
    for (const post of posts) {
      out.push(await this.serveToReader(post, { viewerId: userId }));
    }
    return out;
  }

  /** Loads a single post by ID and returns the public-shaped version (association identity applied). */
  /**
   * The most recent post linking to this calendar event, if any and if this viewer may see it -
   * the reverse of `linkedCalendarEventId`, which lives on the post, never on the event.
   *
   * Reported by a user: linking an event on a post only ever showed the event ON the post; the
   * event's own card showed nothing back. There is no `linkedPostId` column to read the other way
   * because a post always names its event, never the reverse, so this asks the table that holds
   * the fact rather than inventing a second, invertible copy of it that could drift from the
   * first. `linkedCalendarEventId` is only ever set together with an `associationId`
   * (`resolvePostCalendarEventLink` requires one), so the row this finds is always an association
   * post - `mustHideAnonymousAuthor` never applies to it, but `shapeListRow` still runs, for the
   * same moderation-hidden and capability fields every other read path carries.
   *
   * ONLY AN EVENT PRESENTED IN ITS ASSOCIATION'S NAME (`event-presentation.ts`): a post card names
   * its association, so the post of a neutral event would name the owner the presentation hides.
   * The link write and the presentation switch exclude each other (`saveWithEventLink`), so no
   * post links a neutral event; this join is the read's own statement of the same rule.
   *
   * ONLY A PUBLISHED POST (audience audit, 2026-11-14): a post scheduled for later is not served,
   * its author included - an event card is a public surface, and the by-id gate hides an
   * unpublished post's very existence (`readPostOpenVerdict`, term 4). Without the term, every
   * reader of the association read a scheduled post here before its hour.
   */
  async findPostLinkedToCalendarEvent(
    eventId: string,
    viewerId: string | undefined,
    isGlobalAdmin: boolean
  ): Promise<Record<string, unknown> | null> {
    // The same card as a feed row, so the same block rule and the same two exemptions.
    const blockedIds = await blockedUserIdsFor(this.postRepo.manager, viewerId);
    const bp = blockedIds.length > 0 ? 2 : null;
    const rows: any[] = await this.postRepo.manager.query(
      `SELECT posts.id, posts."authorId", posts.anonymous, posts.markdown, posts."createdAt",
              posts."associationId", posts."linkedCalendarEventId", posts."hiddenByModeration",
              posts."studentsOnly", posts."reachPublic", posts."reachSpaces",
              assoc.id AS "assocJoinId", assoc.name AS "assocName", assoc.slug AS "assocSlug",
              assoc."logoUrl" AS "assocLogoUrl", assoc.type AS "assocType"
       FROM posts
       JOIN association_calendar_events linked_ev
         ON linked_ev.id = posts."linkedCalendarEventId" AND linked_ev.presentation = 'association'
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE posts."linkedCalendarEventId" = $1
         AND NOT COALESCE(posts."hiddenByModeration", false)
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         ${this.liveReelFilterSql()}
         ${this.blockedAuthorSql(bp)}
         AND ${postVisibleToViewerSql('posts', `$${blockedIds.length > 0 ? 3 : 2}`)}
       ORDER BY posts."publishedAt" DESC, posts.id DESC
       LIMIT 1`,
      [eventId, ...(blockedIds.length > 0 ? [blockedIds] : []), viewerId ?? null]
    );
    const post = rows[0];
    if (!post) return null;
    await this.attachRepublishers([post]);
    const viewerCtx = await this.viewerContext([post], viewerId, isGlobalAdmin);
    await this.commentIdentity.serveRows([post], {
      viewerId,
      isGlobalAdmin: viewerCtx.isGlobalAdmin,
      moderatedPostIds: viewerCtx.moderatedIds,
    });
    return this.stripBigIntForJson(this.shapeListRow(post, viewerCtx));
  }

  async getById(
    id: string,
    opts?: {
      allowHidden?: boolean;
      viewerId?: string;
      isGlobalAdmin?: boolean;
      /** The client draws a live replay; without it a replay is the 404 of a missing post. */
      withReplays?: boolean;
    }
  ) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException('Post not found');
    if (post.kind === 'replay' && opts?.withReplays !== true) {
      this.logger.debug(
        `[VISIBILITY] ${id} is a replay, withheld from a client that cannot draw one`
      );
      throw new NotFoundException('Post not found');
    }
    const blockedIds = await this.assertOpenable(post, opts ?? {}, 'READ_OR_REACT');
    return this.serveToReader(
      post,
      { viewerId: opts?.viewerId, isGlobalAdmin: opts?.isGlobalAdmin === true },
      blockedIds
    );
  }

  /**
   * EVERY REFUSAL A READER MEETS ON ONE POST, BY ID - `readPostOpenVerdict`, the ONE predicate
   * `getById`, the vote route (`assertMayVote`) and every write route (`assertVisible`) go through,
   * so nothing is written to a post the read would refuse. Returns the reader's blocks, which the
   * serving that follows needs anyway.
   *
   * @param intent `'VOTE'` asks the grant-free audience, as a vote requires.
   * @throws NotFoundException for an expired reel, a post outside the reader's audience, a post
   *   scheduled later (not the reader's), or one whose author and reader are blocked either way.
   * @throws ForbiddenException for a post hidden by moderation.
   */
  private async assertOpenable(
    post: Post,
    opts: { allowHidden?: boolean; viewerId?: string },
    intent: PostAccessIntent
  ): Promise<string[]> {
    const verdict = await readPostOpenVerdict(this.postRepo.manager, post, opts, intent);
    if (verdict.refusal === null) return verdict.blockedIds;
    this.logger.debug(
      `[VISIBILITY] ${intent} ${post.id} withheld from ${opts.viewerId?.slice(0, 8)}: ${verdict.why}`
    );
    // The 403 only ever follows a passed audience term, so it confirms nothing to an outsider.
    if (verdict.refusal === 'hidden') throw new ForbiddenException('Post not available');
    throw new NotFoundException('Post not found');
  }

  /**
   * THE REACTIONS A REACTION ROUTE ANSWERS WITH, as this reader may see them. The add and the removal
   * answer with the post's reactions, and the stored map is `userId -> type`: who reacted. A reader
   * who may open the post with its people gets it whole; a named reader from whom they are withheld
   * (`commentsWithheldFromViewerSql`, owner 2026-11-04) gets their own entry and
   * `otherReactionCounts`; a reader who cannot open the post at all - the removal is not gated, it
   * adds nothing - gets their own entry only, so an id lifted from a link never lists its reactors.
   */
  async serveReactionsTo(
    postId: string,
    viewerId: string,
    answer: { ok: boolean; reactions: Record<string, string> }
  ): Promise<{
    ok: boolean;
    reactions: Record<string, string>;
    otherReactionCounts?: Record<string, number>;
  }> {
    const rows: { visible: boolean; withheld: boolean }[] = await this.postRepo.manager.query(
      `SELECT ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: true })} AS visible,
              ${commentsWithheldFromViewerSql('posts', '$2')} AS withheld
         FROM posts WHERE posts.id = $1`,
      [postId, viewerId]
    );
    const ownOnly = ownEntryOnly(
      viewerId,
      answer.reactions?.[viewerId],
      (v): v is string => typeof v === 'string'
    );
    if (rows[0]?.visible !== true) {
      this.logger.debug(`[REACTION] ${postId.slice(0, 8)}: answered with the reader's own only`);
      return { ok: answer.ok, reactions: ownOnly };
    }
    if (rows[0].withheld === true) {
      return { ok: answer.ok, ...withheldReactions(answer.reactions, viewerId) };
    }
    return answer;
  }

  /**
   * Refuses a vote on a post its voter could not open (`assertOpenable` with the vote's audience).
   * Never `allowHidden`: a moderation-hidden post takes no votes, a platform admin's included.
   */
  async assertMayVote(postId: string, viewerId: string): Promise<void> {
    await this.assertVisible(postId, viewerId, 'VOTE');
  }

  /**
   * ONE WHOLE POST AS ONE READER MAY SEE IT - the shaping every route that answers with a single
   * post row goes through, so none of them hands out the stored row.
   *
   * The stored row carries what the served one withholds per reader (`toPublicPostFromEntity`,
   * `CommentIdentityService.serve`), so a route answering with the entity it just wrote would skip
   * all of it. This is `getById`'s shaping, unchanged, made reachable by the routes that write a
   * post and answer with it. It does NOT check visibility: the caller has already done that (a
   * write route through `assertVisible`, `getById` through its own checks).
   *
   * @param blockedIds the reader's blocks when the caller already read them; read here otherwise.
   */
  async serveToReader(
    post: Post,
    reader: { viewerId?: string; isGlobalAdmin?: boolean },
    blockedIds?: string[]
  ): Promise<Record<string, any>> {
    const blocked = blockedIds ?? (await blockedUserIdsFor(this.postRepo.manager, reader.viewerId));
    this.logger.debug(
      `serveToReader ${post.id}: reader ${reader.viewerId ? 'known' : 'none'}, ${blocked.length} blocked`
    );
    const shaped: Record<string, any> = await this.toPublicPostFromEntity(
      post,
      await this.viewerContext([post], reader.viewerId, reader.isGlobalAdmin === true)
    );
    // The entity path carries the WHOLE comment array rather than a window and a count, so unlike
    // the feed queries it is filtered here, exactly and in one place.
    if (blocked.length > 0 && Array.isArray(shaped.comments)) {
      shaped.comments = shaped.comments.filter(
        (c: { userId?: string; anonymous?: boolean; association?: unknown }) =>
          !blocked.includes(c?.userId ?? '') || c.anonymous === true || !!c.association
      );
    }
    // Attach author name fields (same source as listPosts - local users table).
    if (!shaped.associationId && shaped.authorId) {
      const rows: {
        displayName: string | null;
        firstName: string | null;
        lastName: string | null;
      }[] = await this.postRepo.manager.query(
        `SELECT "displayName", "firstName", "lastName" FROM users WHERE id = $1`,
        [shaped.authorId]
      );
      if (rows[0]) {
        shaped.authorDisplayName = rows[0].displayName;
        shaped.authorFirstName = rows[0].firstName;
        shaped.authorLastName = rows[0].lastName;
      }
    }
    // A live replay's cover and the server's clock, as on a list row.
    if (shaped.kind === 'replay') return (await this.withReplayRowFacts([shaped]))[0];
    return shaped;
  }

  /**
   * One page of a post's comments as WHOLE THREADS (`pageComments`), for the comment sheet.
   *
   * Visibility is `getById`'s: a post this reader may not open is a 404 here too, so the comment
   * route is no side door around the audience or the block rules. Blocked accounts are dropped
   * the way `getById` drops them from the full array.
   */
  async listComments(
    postId: string,
    viewerId: string | undefined,
    opts: { cursor?: number; limit?: number; order?: CommentOrder; isGlobalAdmin?: boolean }
  ) {
    // `getById`'s gate, `allowHidden` included: a platform admin reads a hidden post's comments as
    // they read the post itself.
    // `'COMMENT'`: a named reader from whom the comments are withheld gets the 404 of a missing post.
    const { post, blockedIds } = await this.assertVisible(postId, viewerId, 'COMMENT', {
      allowHidden: opts.isGlobalAdmin === true,
    });
    const page = pageComments((post.comments ?? []) as any[], { ...opts, blockedIds });
    const isGlobalAdmin = opts.isGlobalAdmin === true;
    page.comments = (await this.commentIdentity.serve(page.comments, post, {
      viewerId,
      isGlobalAdmin,
    })) as any[];
    this.logger.debug(
      `listComments ${postId}: ${page.comments.length} rows, cursor=${String(opts.cursor)} hasMore=${page.hasMore}`
    );
    return page;
  }

  /** Updates a post's content. Its author alone: see `assertMayEdit`. */
  async updatePost(
    postId: string,
    userId: string,
    data: {
      markdown: string;
      media?: any[];
      images?: any[];
      polls?: any[];
      attachedFormId?: string | null;
      linkedCalendarEventId?: string | null;
      scheduledAt?: string | null;
      studentsOnly?: boolean;
      reach?: unknown;
    },
    isGlobalAdmin = false
  ) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    await this.assertMayEdit(post, userId, isGlobalAdmin);
    await this.applyStudentsOnly(post, data.studentsOnly);
    await this.applyInstitutionReach(post, data.reach);

    // A reel - and a live replay, whose shape the server wrote (docs/wiki/live-replays.md) - is
    // edited by its caption alone; a post's text-or-media rule is the DTO's.
    if (post.kind === 'reel' || post.kind === 'replay') {
      if (isExpiredPost(post)) throw new NotFoundException('Post not found');
      assertReelEditShape(data);
      post.markdown = data.markdown;
      const saved = await this.postRepo.save(post);
      await this.invalidateListCache();
      return this.serveToReader(saved, { viewerId: userId, isGlobalAdmin });
    }
    post.markdown = data.markdown;

    // `media` wins over the legacy `images`; a null `media` now falls through to `images` (it used to
    // write null) and, with neither, leaves the stored attachments alone.
    const nextMedia = data.media ?? data.images;
    if (nextMedia !== undefined) {
      assertWithinPostAttachmentCap(nextMedia.length);
      // Only what THIS edit adds is the editor's to prove: the edit form sends back the media the
      // post already carries, and those were checked when they were added.
      const already = new Set(postMediaIds(post));
      const added = postMediaIds({ media: nextMedia }).filter((id) => !already.has(id));
      await this.mediaRetention.assertOwnMedia(userId, added, 'post');
      post.media = nextMedia;
    }

    if (data.polls !== undefined) {
      post.polls = this.normalizePolls(data.polls, post.polls ?? []);
    }

    if ('attachedFormId' in data) {
      if (data.attachedFormId !== post.attachedFormId) {
        await assertFormNotDraft(this.postRepo.manager, data.attachedFormId, 'a post');
      }
      post.attachedFormId = data.attachedFormId ?? null;
    }

    // Resolved by `saveWithEventLink` under the event's lock, where the row is written - and only
    // when the link is set or CHANGED: the edit form sends the current link with every edit.
    const linkedBefore = post.linkedCalendarEventId ?? null;
    let linking = false;
    if ('linkedCalendarEventId' in data) {
      const next = data.linkedCalendarEventId?.trim() || null;
      linking = next !== null && next !== linkedBefore;
      post.linkedCalendarEventId = linking ? data.linkedCalendarEventId : next;
    }

    if ('scheduledAt' in data) {
      // A post already visible and un-scheduled keeps the instant it appeared; every other change
      // re-derives it, so the order key never disagrees with the visibility predicate.
      const wasVisible = !post.scheduledAt || post.scheduledAt.getTime() <= Date.now();
      post.scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
      if (post.scheduledAt || !wasVisible) {
        post.publishedAt = publicationTime(post.scheduledAt, new Date());
      }
    }

    // Stored only: the announce sweep tells them, once, when it first publishes the post - so an
    // edit of the schedule, or of the text, never tells anyone (`notifyPostMentions`).
    const mentionedIds = post.markdown
      ? this.notifications
          .resolveMentionedUserIds(post.markdown)
          .filter((id) => id !== post.authorId && sameSideOfReviewCohort(post.authorId, id))
      : [];
    post.mentions = mentionedIds;

    const saved = await this.saveWithEventLink(post, linking, (repo) => repo.save(post));
    await this.invalidateListCache();
    return this.serveToReader(saved, { viewerId: userId, isGlobalAdmin });
  }

  /**
   * The type of association `associationId` (`association`, `list`, `institution`), or `null` for a
   * personal post (no id) or an id no row has - which the switch reads as "not offered".
   */
  private async associationTypeOf(associationId: string | null): Promise<string | null> {
    if (!associationId) return null;
    const rows: { type: string }[] = await this.postRepo.manager.query(
      `SELECT type FROM associations WHERE id = $1`,
      [associationId]
    );
    return rows[0]?.type ?? null;
  }

  /**
   * Changes the "Entre étudiants" switch of `post` when an edit names it (owner, 2026-11-04,
   * decision 5: both ways, at any time). Turning it on is refused, typed, where it is not offered;
   * turning it off never is. The caller saves the row and drops every cached feed page
   * (`invalidateListCache`), so the change reaches every path on the next read: the predicate reads
   * the row, and nothing else holds the audience.
   *
   * Notifications already delivered stay as they are: the bell re-asks the predicate at every read
   * (`bellRowShownSql`), so closing hides the rows from the readers it withdraws and reopening shows
   * them again, with nothing deleted; a push already on a phone cannot be recalled, and opening it
   * answers the 404 of a post not seen. Reopening tells nobody new (the post was announced once).
   */
  private async applyStudentsOnly(post: Post, next: boolean | undefined): Promise<void> {
    if (next === undefined || next === post.studentsOnly) return;
    if (post.kind === 'replay' && next) {
      // A live replay has exactly its live's audience (owner, 2026-11-09, D8): the switch is not
      // offered on it, whatever the association's type.
      this.logger.warn(`[STUDENTS_ONLY] refused on live replay ${post.id.slice(0, 8)} (D8)`);
      throw new BadRequestException({
        code: STUDENTS_ONLY_NOT_OFFERED,
        message: 'A live replay keeps the audience of its live.',
      });
    }
    assertStudentsOnlyOffered(next, await this.associationTypeOf(post.associationId ?? null));
    this.logger.log(
      `[STUDENTS_ONLY] post ${post.id.slice(0, 8)}: switch turned ${next ? 'ON - withdrawn from readers outside students and members' : 'OFF - given back to its audience'}`
    );
    post.studentsOnly = next;
  }

  /**
   * Changes an institution post's REACH when an edit names it (owner, 2026-11-10: editable after
   * publishing, both ways). Narrowing withdraws the post from the readers it leaves out at once,
   * widening gives it back - the predicate reads the row, and the caller drops every cached feed page.
   * No notification is sent: the post was announced once, and a bell row already delivered is
   * re-asked against the predicate at every read (`bellRowShownSql`), as for the students-only switch.
   * Absent leaves the stored reach alone (an institution post written before the reach keeps its
   * whole audience until an edit chooses one). A live replay keeps its live's audience (D8).
   */
  private async applyInstitutionReach(post: Post, raw: unknown): Promise<void> {
    if (raw === undefined) return;
    if (post.kind === 'replay') {
      this.logger.warn(`[INSTITUTION_REACH] refused on live replay ${post.id.slice(0, 8)} (D8)`);
      throw new BadRequestException({
        code: INSTITUTION_REACH_CODES.notOffered,
        message: 'A live replay keeps the audience of its live.',
      });
    }
    const reach = await resolveInstitutionReachWrite(this.postRepo.manager, {
      mode: 'edit',
      associationId: post.associationId ?? null,
      associationType: await this.associationTypeOf(post.associationId ?? null),
      raw,
    });
    if (!reach) return;
    const before = servedInstitutionReach(post);
    this.logger.log(
      `[INSTITUTION_REACH] post ${post.id.slice(0, 8)}: reach ${before ? `${before.public}/${before.spaces.length}` : 'none'} -> ${reach.reachPublic}/${reach.reachSpaces.length} space(s), read at once by every path`
    );
    post.reachPublic = reach.reachPublic;
    post.reachSpaces = reach.reachSpaces;
  }

  /**
   * The spaces `userId` may target when publishing as institution `associationId` - the composer's
   * reach options (owner, 2026-11-10), the SAME statement the write checks a reach against. Refused
   * like the publish itself: 403 for a caller who may not post as it, 400
   * `institution_reach_not_offered` for an entity that is not an institution.
   */
  async listInstitutionReachOptions(
    associationId: string,
    userId: string,
    isGlobalAdmin: boolean
  ): Promise<{ spaces: InstitutionReachSpace[] }> {
    const canPost = await this.associationsService.canPostAs(userId, associationId, {
      isGlobalAdmin,
    });
    if (!canPost) {
      this.logger.debug(
        `[INSTITUTION_REACH] options of ${associationId.slice(0, 8)}: not a publisher`
      );
      throw new ForbiddenException('You may not publish as this association');
    }
    // The not-offered refusal and the statement are the shared module's, which the event form's
    // options route asks too (owner, 2026-11-13: one model with posts).
    return institutionReachOptionsOffered(
      this.postRepo.manager,
      associationId,
      await this.associationTypeOf(associationId),
      'post'
    );
  }

  /**
   * Is `userId` the post's PUBLISHER - its author, or for a post in an association's name an officer
   * holding `POST_AS_ASSO` there (`viewerIsPublisher`'s server half)? `mayAct` WITHOUT the global
   * admin tier: being the platform admin publishes nothing, and `POST_AS_ASSO` is excluded from the
   * BDE super-admin tier (`SUPER_ADMIN_EXCLUDED_FLAGS`), so this is the member bitmask alone.
   */
  private async isPublisherOf(post: Post, userId: string): Promise<boolean> {
    if (!userId) return false;
    return post.associationId
      ? this.associationsService.mayAct(
          userId,
          post.associationId,
          AssociationPermissionFlag.POST_AS_ASSO
        )
      : post.authorId === userId;
  }

  /**
   * A POST'S INTEGRITY: ONLY ITS AUTHOR CHANGES ITS TEXT (owner, 2026-11-02). Nobody else edits it -
   * not a BDE moderator, NOT THE PLATFORM ADMIN: moderation hides, deletes, pins and unmasks, and
   * never puts words in someone's mouth. "Author" is the publisher (`isPublisherOf`): for a post in an
   * association's name, the association, i.e. whoever speaks for it.
   *
   * Anyone else - a moderator, the platform admin, any other reader - is refused 403
   * `POST_EDIT_PUBLISHER_ONLY`: a 403 and never a 401, which may log a user out (review of #2953).
   */
  private async assertMayEdit(post: Post, userId: string, isGlobalAdmin: boolean): Promise<void> {
    if (await this.isPublisherOf(post, userId)) return;
    this.logger.log(
      `[PERM] edit of post ${post.id} refused to ${userId ? userId.slice(0, 8) : 'anonymous'} (admin=${isGlobalAdmin}): the author alone edits`
    );
    throw new ForbiddenException({
      code: POST_EDIT_PUBLISHER_ONLY,
      message: "Only a post's author may change its text",
    });
  }

  /**
   * Refuses the DELETE to whoever may not take this post down - the server half of `canManage`, so
   * a visible bin and an accepted delete cannot disagree: its publisher, a platform admin, or a BDE
   * `MODERATE` holder whose governed spaces hold it (`mayModeratePost`, owner 2026-11-02). Anyone
   * else is a typed 403 (`refuseModeration`: `MODERATION_OUT_OF_SCOPE` or `MODERATOR_REQUIRED`).
   *
   * @returns in which capacity the caller acts: `publisher` (the post's author, or its association's
   *   officer) or `moderator` (a content moderator or a global admin acting on someone else's post) -
   *   what a reel's delete tells the media service (reels-in-chat 15.4: a moderator's purge erases a
   *   file the take also sent to conversations; the author's releases the post's hold alone).
   */
  private async assertMayManage(
    post: Post,
    userId: string,
    isGlobalAdmin: boolean
  ): Promise<'publisher' | 'moderator'> {
    if (isGlobalAdmin) return post.authorId === userId ? 'publisher' : 'moderator';
    if (!userId) throw new UnauthorizedException('Not your post');
    if (await this.isPublisherOf(post, userId)) return 'publisher';
    if (await this.associationsService.mayModeratePost(userId, post.id)) return 'moderator';
    this.logger.debug(
      `[PERM] ${userId.slice(0, 8)} refused management of post ${post.id} (assoc=${post.associationId ?? 'none'})`
    );
    return this.associationsService.refuseModeration(userId, { kind: 'post', id: post.id });
  }

  /** Permanently deletes a post. See `assertMayManage` for who may. */
  async deletePost(
    postId: string,
    userId: string,
    isAdmin: boolean,
    opts: {
      /** Ids the caller deletes itself (a withdrawal): not released to the idle window here. */
      keep?: string[];
    } = {}
  ) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const capacity = await this.assertMayManage(post, userId, isAdmin);
    // Read before the row goes: its media ids are only in the row.
    const orphanedMedia = [...postMediaIds(post), ...commentMediaIds(post.comments)];
    await this.postRepo.remove(post);
    // After the delete has committed, and never gating it. The post is gone either way; the worst
    // a failure here costs is objects kept past the moment they stopped being referenced, which
    // the next `release` or a manual sweep still reaches.
    if (post.kind === 'reel') {
      await this.discardReelBlobs(
        post,
        orphanedMedia,
        capacity === 'moderator' ? 'moderation' : 'author'
      );
    } else {
      const kept = new Set(opts.keep ?? []);
      await this.mediaRetention.release(orphanedMedia.filter((id) => !kept.has(id)));
    }
    return { ok: true };
  }

  /**
   * The blobs of a reel that was just deleted by hand: deleted NOW, as the worker would at expiry,
   * because a reel's storage is the whole reason it expires. `reason` says by whom: the publisher's
   * delete (`author`) releases the post's hold, so a file the take also sent to conversations stays
   * for them until its 30 days (D-postdelete); a moderator's (`moderation`) erases it everywhere
   * (reels-in-chat 15.4).
   *
   * Whatever is not confirmed gone (`failed`, or an unreachable media service) falls back to the
   * idle clock through `release` - the row no longer exists, so the worker will never come back for
   * it, and an object left in class `reel` would be exempt from the sweep for ever. `refused` is a
   * blob that was not the uploader's: left alone on purpose and logged.
   */
  private async discardReelBlobs(
    post: Post,
    allMediaIds: string[],
    reason: Extract<ReelPurgeReason, 'author' | 'moderation'>
  ): Promise<void> {
    const items = [
      ...postMediaIds(post).map((mediaId) => ({ mediaId, ownerId: post.authorId })),
      ...commentMediaOwners(post.comments),
    ];
    this.logger.log(
      `[REEL] delete of ${post.id} by its ${reason === 'author' ? 'publisher' : 'moderator'}: ${items.length} blob(s), reason ${reason}`
    );
    try {
      const results = await this.mediaRetention.purgeReelBlobs(items, reason);
      const notGone = items
        .filter(({ mediaId }) => (results[mediaId] ?? 'failed') === 'failed')
        .map(({ mediaId }) => mediaId);
      if (notGone.length > 0) {
        this.logger.warn(
          `[REEL] delete of ${post.id}: ${notGone.length} blob(s) not deleted, released to the idle clock`
        );
        await this.mediaRetention.release(notGone);
      }
    } catch (e) {
      this.logger.warn(
        `[REEL] delete of ${post.id}: the media service was unreachable (${
          e instanceof Error ? e.message : String(e)
        }), blobs released to the idle clock`
      );
      await this.mediaRetention.release(allMediaIds);
    }
  }

  /**
   * The caller's OWN live reels, soonest expiry first, with the signal that tells the client which
   * ones to offer "save to the gallery" for (decision C6).
   *
   * `serverNow` travels with the answer so a phone with a skewed clock draws the right countdown,
   * and `expiringSoon` is decided HERE from the server's clock, so the one definition of "about to
   * expire" is `REEL_EXPIRY_WARNING_DAYS` and not a number each client chose. The row carries the
   * media key and IV - which is why this is the author's route and no one else's: it is what a
   * client needs to decrypt and save the video before the worker deletes it. Association and
   * anonymous reels are included, they are the caller's. A reel past its expiry is not listed.
   */
  async getMyReels(userId: string) {
    // ONE clock for both questions: the database's. `expiringSoon` and the row filter are computed
    // by it, so `serverNow` must be too, or a reel could read "soon" against a different instant.
    const [{ now }]: Array<{ now: Date }> =
      await this.postRepo.manager.query(`SELECT NOW() AS now`);
    const reels: Array<Record<string, unknown>> = await this.postRepo.manager.query(
      `SELECT id, "createdAt", "expiresAt", "durationMs", markdown, images AS media,
              (("expiresAt" - $3::timestamptz) <= make_interval(days => $2)) AS "expiringSoon"
         FROM posts
        WHERE "authorId" = $1 AND kind = 'reel' AND "expiresAt" > $3::timestamptz
        ORDER BY "expiresAt" ASC`,
      [userId, REEL_EXPIRY_WARNING_DAYS, now]
    );
    return {
      serverNow: new Date(now).toISOString(),
      warningWindowDays: REEL_EXPIRY_WARNING_DAYS,
      reels,
    };
  }
}
