/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import {
  BadRequestException,
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
import { Repository } from 'typeorm';
import { Post } from './entities/post.entity';
import { isUnsafeObjectKey } from '../common/object-keys';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import {
  PostNotificationsService,
  ANONYMOUS_NOTIFICATION_ACTOR_ID,
  ANONYMOUS_NOTIFICATION_ACTOR_NAME,
} from './post-notifications.service';
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
  isExpiredReel,
  type PostKind,
} from './reel.constants';
import { assertReelEditShape } from './reel-rules';
import { SINGLE_PHOTO_POST_SQL } from './single-photo-sql';
import { publicationTime } from './publication-time';
import { POST_LIST_CACHE_PREFIX, invalidatePostListCache } from './post-list-cache';
import { promoCutoffFor } from '../common/promo-visibility';
import { blockedUserIdsFor } from '../common/blocked-user-ids';
import { pageComments, type CommentOrder } from './comment-page';
import { CommentIdentityService } from './comment-identity';
import { previewOf } from '../push/push-content';
import { isAnonymousPoll, servePolls } from './anonymous-poll';
import {
  inAssociationsFeedSql,
  republishedFeedAtSql,
  republishedForViewerSql,
} from './republished-feed-sql';
import {
  postVisibleToViewerSql,
  readInFeedAudience,
  type PostAccessIntent,
} from '../spaces/reader-spaces';
import { inReviewCohortSql, isInReviewCohort } from '../review-cohort';
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
  /** BDE `MODERATE` holder: curates the whole feed, whoever published what. */
  isModerator: boolean;
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
 * One field per control, because the controls do not share a rule: a moderator edits, deletes and
 * pins a post they did not publish and may still report it, while the association's own officer
 * edits and deletes but pins nothing and has nobody to report themselves to.
 */
interface PostCapabilities {
  /** The pencil and the bin. */
  canManage: boolean;
  /** The pin. Moderation of the feed's shape, not of one post's content. */
  canPin: boolean;
  /** The flag. Withheld only from the post's own publisher - reporting yourself means nothing. */
  canReport: boolean;
  /** Clears an anonymous post's flag, revealing its author. Same tier as `canPin`. */
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
   * "Republier au nom d'une association" (D38b): a personal, non-anonymous post by somebody else,
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
    singlePhotos: boolean
  ) {
    return `${POST_LIST_CACHE_PREFIX}${feed}:${viewerUserId ?? 'anon'}:${promo ?? '-'}:${formation ?? '-'}:${limit}:${offset}:${kind ?? '-'}${singlePhotos ? '+photos' : ''}`;
  }

  /**
   * Excludes a reel whose month is up, in EVERY read that serves posts.
   *
   * The worker deletes an expired reel at its next hourly tick, and one whose blob will not delete
   * waits longer; neither may ever be on screen. So the rule that a reel is dead past `expiresAt`
   * is a clause of the query, not a thing the worker's timing makes true. A post has a NULL
   * `expiresAt` and the first branch keeps it.
   */
  private liveReelFilterSql(): string {
    return `AND (posts.kind <> 'reel' OR posts."expiresAt" > NOW())`;
  }

  /**
   * The `kind` the caller restricted the page to; ABSENT MEANS BOTH. The value is matched against
   * the two literals rather than interpolated, so nothing a client sends reaches the SQL text.
   */
  private kindFilterSql(kind: PostKind | undefined, singlePhotos = false): string {
    if (kind === 'reel' && singlePhotos) {
      return `AND (posts.kind = 'reel' OR (posts.kind = 'post' AND ${SINGLE_PHOTO_POST_SQL}))`;
    }
    if (kind === 'reel') return `AND posts.kind = 'reel'`;
    if (kind === 'post') return `AND posts.kind = 'post'`;
    return '';
  }

  /**
   * A list page's order. THE CANAREELS LIST (`kind=reel`) IS NEWEST FIRST AND NOTHING ELSE (lead's
   * decision, 2026-10-19): a pin is a feed concept, and a pinned reel or photo post heading the
   * full-screen list would greet every reader with the same page. Every other list keeps its pinned
   * posts first. THE ORDER IS TOTAL: `id` breaks a tie of `publishedAt` (scheduled posts published
   * at the same instant), so an `OFFSET` page can neither repeat nor skip a row.
   *
   * `at` is the instant a row is placed at: its `publishedAt`, except in the Associations feed,
   * and "Suivis", where a carried post sits at its latest counted republication
   * (`republishedFeedAtSql`).
   */
  private listOrderSql(kind: PostKind | undefined, at = 'posts."publishedAt"'): string {
    return kind === 'reel'
      ? `ORDER BY ${at} DESC, posts.id DESC`
      : `ORDER BY posts.pinned DESC, ${at} DESC, posts.id DESC`;
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
        `[CACHE] feed cache sweep failed - pages stay stale for up to ${PostsService.LIST_CACHE_TTL}s`,
        e
      );
    }
  }

  /** The reader who holds nothing: nobody is logged in, so no control is drawn and none is owed. */
  private static readonly EMPTY_VIEWER: PostViewerContext = {
    viewerId: undefined,
    isGlobalAdmin: false,
    isModerator: false,
    managedAssociationIds: new Set(),
    republishAsIds: new Set(),
    grantFreeIds: new Set(),
    personalRepublishAsIds: new Set(),
    requestablePersonalIds: new Set(),
    personalRequests: new Map(),
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
      return {
        viewerId,
        isGlobalAdmin: true,
        isModerator: true,
        managedAssociationIds: new Set(),
        republishAsIds: new Set(),
        grantFreeIds: new Set(),
        ...(await this.personalRequestContext(personalIds, viewerId, memberships.personal)),
      };
    }
    const associationIds = rows.map((row) => row.associationId).filter((id): id is string => !!id);
    const [managedAssociationIds, isModerator, memberships, grantFreeIds] = await Promise.all([
      this.associationsService.mayActOnAny(
        viewerId,
        associationIds,
        AssociationPermissionFlag.POST_AS_ASSO
      ),
      this.associationsService.isContentModerator(viewerId),
      this.republishAsOf(viewerId),
      this.grantFreeVisibleIds(postIds, viewerId),
    ]);
    return {
      viewerId,
      isGlobalAdmin: false,
      isModerator,
      managedAssociationIds,
      republishAsIds: memberships.all,
      grantFreeIds,
      ...(await this.personalRequestContext(personalIds, viewerId, memberships.personal)),
    };
  }

  /**
   * Of `postIds`, those `viewerId` sees WITHOUT a read grant - ONE query for a page, through the
   * same `postVisibleToViewerSql` (`readGrants: false`) that `assertVisible(.., 'VOTE')` and the
   * republication path enforce, so a control is offered exactly when its write is accepted.
   */
  private async grantFreeVisibleIds(postIds: string[], viewerId: string): Promise<Set<string>> {
    if (postIds.length === 0) return new Set();
    const rows: unknown = await this.postRepo.manager.query(
      `SELECT posts.id FROM posts WHERE posts.id = ANY($1::uuid[])
         AND ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: true, readGrants: false })}`,
      [postIds, viewerId]
    );
    return new Set(Array.isArray(rows) ? rows.map((r: { id: string }) => r.id) : []);
  }

  /**
   * The associations `viewerId` could republish a post AS: membership rows holding `POST_AS_ASSO`,
   * of a type that republishes (`all`, D38), and among them those that may ASK an author (D38b:
   * `personal` - the narrower kind allowlist, not archived). Membership alone is exact here because
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
            AND NOT (posts.kind = 'reel' AND posts."expiresAt" IS NOT NULL AND posts."expiresAt" <= now())
            AND ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: false, readGrants: false })}
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
   * everything; a BDE `MODERATE` holder curates the feed, so it may edit, delete and pin what it
   * did not publish, while remaining entitled to report it like any other reader; the publisher
   * corrects and withdraws its own words and pins nothing.
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
    const isModeratorTier = viewer.isGlobalAdmin || viewer.isModerator;
    return {
      canManage: isModeratorTier || isPublisher,
      canPin: isModeratorTier,
      canReport: !!viewer.viewerId && !isPublisher,
      canUnmaskAnonymous: !!post.anonymous && isModeratorTier,
      canRepublish: this.viewerMayRepublish(post, viewer),
      canProposeRepublication:
        !!viewer.viewerId && !!post.associationId && (viewer.isGlobalAdmin || isPublisher),
      canUnrepublishAs: this.viewerMayUnrepublishAs(post, viewer),
      canVote:
        !!viewer.viewerId && (viewer.isGlobalAdmin || this.viewerSeesWithoutGrant(post, viewer)),
      canRequestRepublication: this.viewerMayRequestRepublication(post, viewer),
      republicationRequests: post.id
        ? (viewer.personalRequests.get(post.id) ?? []).filter(
            (r): r is PersonalRepublicationRequestState => r.status !== 'accepted'
          )
        : [],
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
    // A grant opens a post to read only: republishing it is a 404 (`RepublicationsService`).
    if (!this.viewerSeesWithoutGrant(post, viewer)) return false;
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
    post: { anonymous?: boolean; authorId?: string | null },
    viewer: PostViewerContext
  ) {
    if (!post.anonymous) return false;
    if (viewer.isGlobalAdmin || viewer.isModerator) return false;
    return !viewer.viewerId || viewer.viewerId !== post.authorId;
  }

  /** Strip publisher identity and attach association display for API responses. */
  private shapeListRow(p: any, viewer: PostViewerContext): any {
    const capabilities = this.viewerCapabilities(p, viewer);
    const polls = servePolls(p.polls, viewer.viewerId);
    if (!p.associationId) {
      const out: any = { ...p, ...capabilities, ...(p.polls !== undefined ? { polls } : {}) };
      if (this.mustHideAnonymousAuthor(p, viewer)) {
        delete out.authorId;
        delete out.authorDisplayName;
        delete out.authorFirstName;
        delete out.authorLastName;
      }
      return out;
    }
    const out: any = { ...p, ...capabilities, ...(p.polls !== undefined ? { polls } : {}) };
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
      };
    }
    delete out.assocJoinId;
    delete out.assocName;
    delete out.assocSlug;
    delete out.assocLogoUrl;
    return out;
  }

  /** Anonymize association-authored and flagged-anonymous posts loaded as TypeORM entities. */
  private async toPublicPostFromEntity(
    post: Post,
    viewer: PostViewerContext
  ): Promise<Record<string, unknown>> {
    const raw: any = { ...(post as any) };
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
        isModerator: viewer.isModerator,
      });
    }
    Object.assign(raw, this.viewerCapabilities(raw, viewer));
    if (raw.polls !== undefined) raw.polls = servePolls(raw.polls, viewer.viewerId);
    if (!raw.associationId) {
      if (this.mustHideAnonymousAuthor(post, viewer)) {
        delete raw.authorId;
      }
      return raw;
    }
    delete raw.authorId;
    const rows: { id: string; name: string; slug: string; logoUrl: string | null }[] =
      await this.postRepo.manager.query(
        `SELECT id, name, slug, "logoUrl" FROM associations WHERE id = $1`,
        [raw.associationId]
      );
    if (rows[0]) {
      raw.association = {
        id: rows[0].id,
        name: rows[0].name,
        slug: rows[0].slug,
        logoUrl: rows[0].logoUrl,
      };
    }
    if (raw.linkedCalendarEventId) {
      raw.linkedCalendarEvent = await this.associationsService.findValidatedCalendarEventSummary(
        raw.linkedCalendarEventId as string
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
   * Refuses with 404 a post `viewerId` may not see (WP6b decision 3) - `postVisibleToViewerSql`,
   * asked of one row. 404 and not 403: for that reader the post does not exist, and saying
   * "forbidden" would confirm the id. An absent viewer, or an absent post, sees nothing. A global
   * admin may open any post BY ITS ID (a report or moderation link) but is not shown it by browsing.
   *
   * THE INTENT IS EXPLICIT because a nominative read grant (WP7) opens a post to READ, REACT and
   * COMMENT only: `'READ_OR_REACT'` counts the grant, `'VOTE'` does not (a vote was never granted,
   * user 2026-10-07: read + react/comment). A caller must say which one it is.
   */
  async assertVisible(
    postId: string,
    viewerId: string | undefined,
    intent: PostAccessIntent
  ): Promise<void> {
    const rows: { visible: boolean }[] = await this.postRepo.manager.query(
      `SELECT ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: true, readGrants: intent === 'READ_OR_REACT' })} AS visible FROM posts WHERE posts.id = $1`,
      [postId, viewerId ?? null]
    );
    if (rows[0]?.visible !== true) {
      this.logger.debug(`[VISIBILITY] post ${postId} withheld from ${viewerId?.slice(0, 8)}`);
      throw new NotFoundException('Post not found');
    }
  }

  async createPost(data: any, isGlobalAdmin: boolean) {
    if (data.linkedCalendarEventId) {
      data.linkedCalendarEventId = await this.associationsService.resolvePostCalendarEventLink(
        data.associationId,
        data.linkedCalendarEventId
      );
    }
    if (Array.isArray(data.polls)) {
      data.polls = this.normalizePolls(data.polls);
    }
    // Extract mentions before saving so we can populate post.mentions
    const markdown: string = typeof data.markdown === 'string' ? data.markdown : '';
    const authorId: string = typeof data.authorId === 'string' ? data.authorId : '';
    const mentionedIds = markdown
      ? this.notifications.resolveMentionedUserIds(markdown).filter((id) => id !== authorId)
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
    }

    const post = this.postRepo.create(data) as unknown as Post;
    post.publishedAt = publicationTime(post.scheduledAt, new Date());
    let entity: Post;
    try {
      entity = await this.postRepo.save(post);
    } catch (e) {
      // The blob was claimed for a reel that now will not exist. Hand it back to the idle clock so
      // it is not an exempt object nothing will ever reap - best-effort and logged by `release`.
      if (reelMediaIds.length > 0) await this.mediaRetention.release(reelMediaIds);
      throw e;
    }
    await this.invalidateListCache();

    // Fire-and-forget mention notifications
    if (mentionedIds.length > 0 && entity.id) {
      void (async () => {
        try {
          // A mention notification never went through `mustHideAnonymousAuthor` at all - it is
          // written once, at creation, onto a row nothing re-shapes per reader (see the constants'
          // own docblock). An anonymous post that mentions someone stays anonymous to them too.
          const actorId = data.anonymous ? ANONYMOUS_NOTIFICATION_ACTOR_ID : authorId;
          const actorName = data.anonymous
            ? ANONYMOUS_NOTIFICATION_ACTOR_NAME
            : await this.notifications.resolveActorName(authorId);
          for (const recipientId of mentionedIds) {
            // createNotification also sends the FCM push (type 'social').
            await this.notifications.createNotification({
              recipientId,
              type: 'mention',
              postId: entity.id,
              actorId,
              text: previewOf(markdown),
              actorName,
            });
          }
        } catch {
          /* non-fatal */
        }
      })();
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
   * Batches the distinct `linkedCalendarEventId`s off a page of rows into one summary per event -
   * `listPosts` and `searchPosts` both need it, and a summary per DISTINCT event rather than per
   * row is what keeps a page of "same event, many posts" from repeating the same lookup.
   */
  private async batchLoadLinkedCalendarEvents(
    rows: { linkedCalendarEventId?: string | null }[]
  ): Promise<Map<string, Record<string, unknown>>> {
    const eventIds = [
      ...new Set(rows.map((r) => r.linkedCalendarEventId).filter((id): id is string => !!id)),
    ];
    if (eventIds.length === 0) return new Map();
    const summaries = await Promise.all(
      eventIds.map((id) => this.associationsService.findValidatedCalendarEventSummary(id))
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
         ${this.serviceAccountFilterSql(isAdmin, viewer?.viewerUserId)}
         ${this.blockedAuthorSql(bp)}
         AND ${postVisibleToViewerSql('posts', `$${viewerParam}`)}
       ORDER BY posts.pinned DESC, posts."publishedAt" DESC, posts.id DESC
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
    const linkedEvents = await this.batchLoadLinkedCalendarEvents(rawPosts);

    await this.commentIdentity.serveRows(rawPosts, {
      viewerId: viewer?.viewerUserId,
      isGlobalAdmin: viewerCtx.isGlobalAdmin,
      isModerator: viewerCtx.isModerator,
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
    const visibleComment =
      blockedParam === null
        ? ''
        : `WHERE (COALESCE(elem->>'userId', '') <> ALL($${blockedParam}::text[])
             OR elem->>'anonymous' = 'true' OR COALESCE(elem->>'associationId', '') <> '')`;
    const commentCount =
      blockedParam === null
        ? `(jsonb_array_length(COALESCE(posts.comments, '[]'::jsonb))::integer)`
        : `(SELECT COUNT(*)::integer
             FROM jsonb_array_elements(COALESCE(posts.comments, '[]'::jsonb)) AS elem
             ${visibleComment})`;
    return `posts.id,
         posts."authorId", posts.anonymous, posts.markdown, posts."createdAt", posts."publishedAt", posts."updatedAt",
         posts.mentions, posts.links, posts."attachedFormId", posts."associationId",
         posts."linkedCalendarEventId",
         posts.images, posts.polls, posts.forms, posts.reactions, posts.pinned, posts."scheduledAt",
         posts.kind, posts."durationMs", posts."expiresAt",
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
         assoc.id AS "assocJoinId", assoc.name AS "assocName", assoc.slug AS "assocSlug", assoc."logoUrl" AS "assocLogoUrl"`;
  }

  /** Moderation-hidden posts are invisible to every reader but a platform admin. */
  private hiddenFilterSql(isAdmin: boolean): string {
    return isAdmin ? '' : `AND NOT COALESCE(posts."hiddenByModeration", false)`;
  }

  /**
   * A review account's posts are invisible to every reader outside the cohort but a platform admin
   * (`review-cohort.ts`). The visibility predicate already keeps them apart - the cohort is a space
   * of its own - and this clause states it again on the author, so a post a review account writes
   * AS an association it somehow joined still never reaches a member's feed or search.
   */
  private serviceAccountFilterSql(isAdmin: boolean, viewerId: string | undefined): string {
    if (isAdmin || isInReviewCohort(viewerId)) return '';
    const authorInCohort = inReviewCohortSql('posts."authorId"');
    return authorInCohort === 'false' ? '' : `AND NOT ${authorInCohort}`;
  }

  /**
   * The clause that keeps a blocked account's posts out of one viewer's feed.
   *
   * IT COVERS ONLY A POST WHOSE AUTHOR THAT VIEWER COULD ALREADY SEE, and the exemption is the
   * whole point rather than an oversight. An association post hides its publisher from everyone
   * unconditionally, an anonymous one from everyone but a moderator; filtering either on `authorId`
   * would turn a block into a DE-ANONYMISATION ORACLE - block a suspect, watch whether the post
   * leaves the feed, unblock. Nobody is notified of a block, no administrator sees one and lifting
   * it costs a click, so that probe would be repeatable until it named the author of every
   * anonymous post on the platform. `listPosts`'s `followed` arm already excludes anonymous posts
   * for the neighbouring reason: presence in a feed is itself an answer about authorship.
   *
   * It is applied to the `followed` feed too, where severing the two follows has usually removed
   * these posts already - `UserBlocksService.severFollows` is a cross-service call that is
   * BEST-EFFORT by design and logs rather than fails, so "usually" is exactly what it is.
   */
  private blockedAuthorSql(blockedParam: number | null): string {
    if (blockedParam === null) return '';
    return `AND (
           posts."associationId" IS NOT NULL
           OR COALESCE(posts.anonymous, false)
           OR posts."authorId" <> ALL($${blockedParam}::text[])
         )`;
  }

  /**
   * Returns paginated posts for one of four feeds:
   * - "associations": what associations publish or republish, a carried post at its latest
   *   republication (`republished-feed-sql.ts`)
   * - "all": every post, pinned first
   * - "followed": posts from associations and users the viewer follows, and what a followed
   *   association republished, placed at that republication
   * - "custom": personal posts filtered by promo year and/or formation
   *
   * Non-admin viewers with a promo year set cannot see posts published before
   * August 1st of their promo year.
   * Results are cached in Redis for 30 s. Future-scheduled posts are always excluded.
   */
  async listPosts(params: {
    limit: number;
    offset: number;
    feed: 'all' | 'followed' | 'custom' | 'associations';
    viewerUserId?: string;
    isAdmin?: boolean;
    promo?: number;
    formation?: string;
    /** Restricts the page to one kind; absent means posts AND reels. */
    kind?: PostKind;
    /** With `kind: 'reel'`, the posts whose only content is ONE picture come too (`single-photo-sql.ts`). */
    singlePhotos?: boolean;
  }) {
    const { feed, viewerUserId, isAdmin, promo, formation, kind } = params;
    const singlePhotos = params.singlePhotos === true && kind === 'reel';
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
      singlePhotos
    );

    try {
      const cached = await Promise.race([
        this.redis.get(cacheKey),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 100)),
      ]);
      if (cached) return JSON.parse(cached as string);
    } catch {
      // Redis miss or error - fall through to DB
    }

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
    if (feed === 'followed') {
      [followedAssocIds, followedUserIds] = await Promise.all([
        this.followsService.getFollowedAssociationIdsForUser(viewerUserId),
        this.followsService.getFollowedUserIdsForUser(viewerUserId),
      ]);
      if (followedAssocIds.length === 0 && followedUserIds.length === 0) {
        return [];
      }
    }

    let rawPosts: any[];
    const promoParam = promo === undefined ? null : promo;
    const formationParam = formation === undefined || formation === '' ? null : formation;

    const hiddenFilter = this.hiddenFilterSql(isAdmin === true);
    // A dead reel is excluded in EVERY arm, and `kind` (absent = both) narrows every arm alike.
    const reelFilters = `${this.liveReelFilterSql()}\n         ${this.kindFilterSql(kind, singlePhotos)}`;
    const serviceAccountFilter = this.serviceAccountFilterSql(isAdmin === true, viewerUserId);
    // WHICH POSTS THIS READER MAY SEE (WP6b), in every arm. The viewer goes LAST, after the optional
    // promo cutoff and blocked list (`tail`), so its placeholder is the next free index of each arm.
    const tail = [...(promoCutoff ? [promoCutoff] : []), ...blockedParams];
    const viewerParam = viewerUserId ?? null;
    const visibleAt = (index: number) => `AND ${postVisibleToViewerSql('posts', `$${index}`)}`;

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
         ${visibleAt(3 + tail.length)}
       ${this.listOrderSql(kind, republishedFeedAtSql(`$${3 + tail.length}`))}
       LIMIT $1 OFFSET $2`,
        [limit, offset, ...tail, viewerParam]
      );
    } else if (feed === 'all') {
      // $1=limit, $2=offset, $3=promoCutoff (optional), $4=blockedIds (optional)
      const bp = blockedAt(promoCutoff ? 4 : 3);
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
         ${visibleAt(3 + tail.length)}
       ${this.listOrderSql(kind)}
       LIMIT $1 OFFSET $2`,
        [limit, offset, ...tail, viewerParam]
      );
    } else if (feed === 'followed') {
      // $1=limit, $2=offset, $3=followedAssocIds, $4=followedUserIds, $5=promoCutoff (optional),
      // $6=blockedIds (optional)
      const bp = blockedAt(promoCutoff ? 6 : 5);
      rawPosts = await this.postRepo.manager.query(
        `SELECT ${this.postSelectBody(bp)}
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE (
         (posts."associationId" IS NOT NULL AND posts."associationId" = ANY($3::uuid[]))
         -- Never an anonymous post: appearing in THIS feed at all already says "written by
         -- someone in the small, known set you follow" - a leak no amount of masking the
         -- author's name removes, because the leak is membership, not the name.
         OR (posts."associationId" IS NULL AND posts."authorId" = ANY($4::text[])
             AND NOT posts.anonymous)
         -- What a followed association REPUBLISHED (republished-feed-sql.ts), never anonymous.
         OR (NOT COALESCE(posts.anonymous, false)
             AND ${republishedForViewerSql(`$${5 + tail.length}`, '$3')})
       )
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         ${hiddenFilter}
         ${reelFilters}
         ${serviceAccountFilter}
         ${this.blockedAuthorSql(bp)}
         ${promoSql(5)}
         ${visibleAt(5 + tail.length)}
       ${this.listOrderSql(kind, republishedFeedAtSql(`$${5 + tail.length}`, '$3'))}
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
         ${visibleAt(5 + tail.length)}
       ${this.listOrderSql(kind)}
       LIMIT $1 OFFSET $2`,
        [limit, offset, promoParam, formationParam, ...tail, viewerParam]
      );
    }

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
    const viewerCtx = await this.viewerContext(rawPosts, viewerUserId, isAdmin === true);
    const linkedEvents = await this.batchLoadLinkedCalendarEvents(rawPosts);

    await this.commentIdentity.serveRows(rawPosts, {
      viewerId: viewerUserId,
      isGlobalAdmin: viewerCtx.isGlobalAdmin,
      isModerator: viewerCtx.isModerator,
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

    const safe = this.stripBigIntForJson(result);

    try {
      await this.redis.setex(cacheKey, PostsService.LIST_CACHE_TTL, JSON.stringify(safe));
    } catch {
      // Non-fatal
    }

    return safe;
  }

  /**
   * Returns all posts currently hidden by moderation, with their pending report count.
   * Admin only.
   */
  async getHiddenPosts(): Promise<any[]> {
    return this.postRepo.manager.query(
      `SELECT p.id, p."authorId", p.markdown, p."createdAt", p."associationId",
              (SELECT COUNT(*)::int FROM content_reports cr
               WHERE cr."contentId" = p.id::text AND cr.status = 'pending') AS "pendingReportCount"
       FROM posts p
       WHERE p."hiddenByModeration" = true
       ORDER BY p."createdAt" DESC
       LIMIT 200`
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

  /** Returns the author's own future-scheduled posts (max 20), ordered by scheduled date. */
  async getMyScheduledPosts(userId: string) {
    const rows: any[] = await this.postRepo.manager.query(
      `SELECT id, markdown, "scheduledAt", "createdAt"
       FROM posts
       WHERE "authorId" = $1
         AND "scheduledAt" IS NOT NULL
         AND "scheduledAt" > NOW()
       ORDER BY "scheduledAt" ASC
       LIMIT 20`,
      [userId]
    );
    return rows;
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
              assoc.id AS "assocJoinId", assoc.name AS "assocName", assoc.slug AS "assocSlug",
              assoc."logoUrl" AS "assocLogoUrl"
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE posts."linkedCalendarEventId" = $1
         AND NOT COALESCE(posts."hiddenByModeration", false)
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
      isModerator: viewerCtx.isModerator,
    });
    return this.stripBigIntForJson(this.shapeListRow(post, viewerCtx));
  }

  async getById(
    id: string,
    opts?: { allowHidden?: boolean; viewerId?: string; isGlobalAdmin?: boolean }
  ) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException('Post not found');
    const blockedIds = await this.assertOpenable(post, opts ?? {}, 'READ_OR_REACT');
    return this.serveToReader(
      post,
      { viewerId: opts?.viewerId, isGlobalAdmin: opts?.isGlobalAdmin === true },
      blockedIds
    );
  }

  /**
   * EVERY REFUSAL A READER MEETS ON ONE POST, BY ID - the ONE gate `getById` and the vote route
   * (`assertMayVote`) go through, so a vote is refused on every post the read would refuse.
   * Returns the reader's blocks, which the serving that follows needs anyway.
   *
   * @param intent `'VOTE'` asks the grant-free audience (`assertVisible`), as a vote requires.
   * @throws NotFoundException for an expired reel, a post outside the reader's audience, a post
   *   scheduled later (not the reader's), or one whose author and reader are blocked either way.
   * @throws ForbiddenException for a post hidden by moderation.
   */
  private async assertOpenable(
    post: Post,
    opts: { allowHidden?: boolean; viewerId?: string },
    intent: PostAccessIntent
  ): Promise<string[]> {
    // A reel past its month is gone for everyone, a moderator and the author included: the worker
    // has only not reached it yet, and what it will delete is not worth opening.
    if (isExpiredReel(post)) {
      this.logger.debug(`${intent} ${post.id} withheld: reel expired at ${String(post.expiresAt)}`);
      throw new NotFoundException('Post not found');
    }
    // A POST THIS READER MAY NOT SEE (WP6b) IS ONE THAT DOES NOT EXIST for them: 404, and BEFORE the
    // moderation check, whose 403 would otherwise confirm the id to someone outside its audience.
    await this.assertVisible(post.id, opts.viewerId, intent);
    if (post.hiddenByModeration && !opts.allowHidden) {
      throw new ForbiddenException('Post not available');
    }
    // Every listPosts query carries `scheduledAt IS NULL OR scheduledAt <= NOW()`; this read did
    // not, so a post queued for a future date was already served by id - and a link preview or an
    // unfurled share would have published it before its own publication date. Its author and a
    // global admin still reach it, so scheduling a post does not hide it from the person who wrote
    // it. Answers "not found" rather than "forbidden" to everyone else: the existence of an
    // unpublished post is itself the thing to hide.
    const publishesLater = !!post.scheduledAt && post.scheduledAt.getTime() > Date.now();
    const viewerOwnsIt = !!opts.viewerId && post.authorId === opts.viewerId;
    if (publishesLater && !viewerOwnsIt && !opts.allowHidden) {
      this.logger.debug(
        `${intent} ${post.id} withheld: scheduled for ${post.scheduledAt?.toISOString()}`
      );
      throw new NotFoundException('Post not found');
    }
    // A BLOCK REACHES THIS READ TOO, or the feed filter would be a curtain with a link around it:
    // this is what "load all comments" and every notification link call. 404 rather than 403, and
    // rather than a message naming a block - the blocked party learns their posts stopped reaching
    // one reader, which is what a symmetric block means, but never that this particular read was
    // refused on purpose. The exemptions are `blockedAuthorSql`'s, for the reason given there,
    // plus `allowHidden`: that flag already means "a platform admin, doing platform work", and it
    // is the same one that lets them open a moderation-hidden post the feed refuses them. Their
    // FEED still honours their own block - hiding a reported post from the moderator who has to
    // read it is the trap this avoids, and it is the same split `hiddenByModeration` already makes.
    const blockedIds = await blockedUserIdsFor(this.postRepo.manager, opts.viewerId);
    if (
      !post.associationId &&
      !post.anonymous &&
      blockedIds.includes(post.authorId) &&
      !opts.allowHidden
    ) {
      this.logger.debug(
        `${intent} ${post.id} withheld: a block stands between the reader and its author`
      );
      throw new NotFoundException('Post not found');
    }
    return blockedIds;
  }

  /**
   * Refuses a vote on a post its voter could not open (`assertOpenable` with the vote's audience).
   * Never `allowHidden`: a moderation-hidden post takes no votes, a platform admin's included.
   */
  async assertMayVote(postId: string, viewerId: string): Promise<void> {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    await this.assertOpenable(post, { viewerId }, 'VOTE');
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
    await this.assertVisible(postId, viewerId, 'READ_OR_REACT');
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post || isExpiredReel(post)) throw new NotFoundException('Post not found');
    const blockedIds = await blockedUserIdsFor(this.postRepo.manager, viewerId);
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

  /** Updates a post's content. See `assertMayManage` for who may. */
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
    },
    isGlobalAdmin = false
  ) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    await this.assertMayManage(post, userId, isGlobalAdmin);

    // A reel is edited by its caption alone; a post's text-or-media rule is the DTO's.
    if (post.kind === 'reel') {
      if (isExpiredReel(post)) throw new NotFoundException('Post not found');
      assertReelEditShape(data);
      post.markdown = data.markdown;
      const saved = await this.postRepo.save(post);
      await this.invalidateListCache();
      return this.serveToReader(saved, { viewerId: userId, isGlobalAdmin });
    }
    post.markdown = data.markdown;

    if (data.media !== undefined) {
      post.media = data.media;
    } else if (data.images !== undefined) {
      post.media = data.images;
    }

    if (data.polls !== undefined) {
      post.polls = this.normalizePolls(data.polls, post.polls ?? []);
    }

    if ('attachedFormId' in data) post.attachedFormId = data.attachedFormId ?? null;

    if ('linkedCalendarEventId' in data) {
      if (data.linkedCalendarEventId && post.associationId) {
        post.linkedCalendarEventId = await this.associationsService.resolvePostCalendarEventLink(
          post.associationId,
          data.linkedCalendarEventId
        );
      } else {
        post.linkedCalendarEventId = data.linkedCalendarEventId ?? null;
      }
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

    const mentionedIds = post.markdown
      ? this.notifications
          .resolveMentionedUserIds(post.markdown)
          .filter((id) => id !== post.authorId)
      : [];
    post.mentions = mentionedIds;

    const saved = await this.postRepo.save(post);
    await this.invalidateListCache();
    return this.serveToReader(saved, { viewerId: userId, isGlobalAdmin });
  }

  /**
   * Refuses the write to whoever may not manage this post - the server half of the very predicate
   * the pencil is drawn from, so a visible control and an accepted write cannot disagree.
   *
   * `mayAct` rather than its batch form: one post, one association.
   */
  private async assertMayManage(post: Post, userId: string, isGlobalAdmin: boolean): Promise<void> {
    if (isGlobalAdmin) return;
    if (!userId) throw new UnauthorizedException('Not your post');
    const isPublisher = post.associationId
      ? await this.associationsService.mayAct(
          userId,
          post.associationId,
          AssociationPermissionFlag.POST_AS_ASSO
        )
      : post.authorId === userId;
    const allowed = isPublisher || (await this.associationsService.isContentModerator(userId));
    if (!allowed) {
      this.logger.debug(
        `[PERM] ${userId?.slice(0, 8)} refused management of post ${post.id} (assoc=${post.associationId ?? 'none'})`
      );
      throw new UnauthorizedException('Not your post');
    }
  }

  /** Permanently deletes a post. See `assertMayManage` for who may. */
  async deletePost(postId: string, userId: string, isAdmin: boolean) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    await this.assertMayManage(post, userId, isAdmin);
    // Read before the row goes: its media ids are only in the row.
    const orphanedMedia = [...postMediaIds(post), ...commentMediaIds(post.comments)];
    await this.postRepo.remove(post);
    // After the delete has committed, and never gating it. The post is gone either way; the worst
    // a failure here costs is objects kept past the moment they stopped being referenced, which
    // the next `release` or a manual sweep still reaches.
    if (post.kind === 'reel') {
      await this.discardReelBlobs(post, orphanedMedia);
    } else {
      await this.mediaRetention.release(orphanedMedia);
    }
    return { ok: true };
  }

  /**
   * The blobs of a reel that was just deleted by hand: deleted NOW, as the worker would at expiry,
   * because a reel's storage is the whole reason it expires.
   *
   * Whatever is not confirmed gone (`failed`, or an unreachable media service) falls back to the
   * idle clock through `release` - the row no longer exists, so the worker will never come back for
   * it, and an object left in class `reel` would be exempt from the sweep for ever. `refused` is a
   * blob that was not the uploader's: left alone on purpose and logged.
   */
  private async discardReelBlobs(post: Post, allMediaIds: string[]): Promise<void> {
    const items = [
      ...postMediaIds(post).map((mediaId) => ({ mediaId, ownerId: post.authorId })),
      ...commentMediaOwners(post.comments),
    ];
    try {
      const results = await this.mediaRetention.purgeReelBlobs(items);
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

  /** Pins or unpins a post (global admin only). Pinned posts always sort first in feeds. */
  async setPinned(postId: string, pinned: boolean) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    post.pinned = pinned;
    await this.postRepo.save(post);
    await this.invalidateListCache();
    return { ok: true, pinned };
  }
}
