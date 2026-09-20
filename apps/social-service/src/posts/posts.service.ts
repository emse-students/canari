/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import {
  PostNotificationsService,
  ANONYMOUS_NOTIFICATION_ACTOR_ID,
  ANONYMOUS_NOTIFICATION_ACTOR_NAME,
} from './post-notifications.service';
import { POST_LIST_CACHE_PREFIX, invalidatePostListCache } from './post-list-cache';
import { promoCutoffFor } from '../common/promo-visibility';

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
}

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
}

/** Core post service: creation, listing (with Redis cache), search, scheduling, and moderation. */
@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);
  private static readonly LIST_CACHE_TTL = 30; // seconds

  /**
   * Verification service account (Google/Apple app review). Its authored posts are hidden
   * from the feed for everyone except global admins and the account itself. Configurable via
   * the SERVICE_ACCOUNT_USER_ID env var (GitHub-secret backed). Only a hex user id is accepted
   * so it can be safely inlined into raw SQL; anything else disables the restriction.
   */
  private readonly serviceAccountId = (() => {
    const raw = process.env.SERVICE_ACCOUNT_USER_ID?.trim() ?? '';
    return /^[a-f0-9]{1,128}$/i.test(raw) ? raw : '';
  })();

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
    private readonly notifications: PostNotificationsService
  ) {}

  private listPostsCacheKey(
    feed: string,
    viewerUserId: string | undefined,
    promo: number | undefined,
    formation: string | undefined,
    limit: number,
    offset: number
  ) {
    return `${POST_LIST_CACHE_PREFIX}${feed}:${viewerUserId ?? 'anon'}:${promo ?? '-'}:${formation ?? '-'}:${limit}:${offset}`;
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
  };

  /**
   * Builds the per-reader context for a batch of rows: two queries for a whole page, whatever its
   * length, and none at all for a reader whose answer is already known.
   *
   * A global administrator short-circuits both - `viewerCapabilities` grants them every control
   * before it looks at either field.
   */
  private async viewerContext(
    rows: { associationId?: string | null }[],
    viewerId: string | undefined,
    isGlobalAdmin: boolean
  ): Promise<PostViewerContext> {
    if (!viewerId) return PostsService.EMPTY_VIEWER;
    if (isGlobalAdmin) {
      return {
        viewerId,
        isGlobalAdmin: true,
        isModerator: true,
        managedAssociationIds: new Set(),
      };
    }
    const associationIds = rows.map((row) => row.associationId).filter((id): id is string => !!id);
    const [managedAssociationIds, isModerator] = await Promise.all([
      this.associationsService.mayActOnAny(
        viewerId,
        associationIds,
        AssociationPermissionFlag.POST_AS_ASSO
      ),
      this.associationsService.isContentModerator(viewerId),
    ]);
    return { viewerId, isGlobalAdmin: false, isModerator, managedAssociationIds };
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
    post: { authorId?: string | null; associationId?: string | null; anonymous?: boolean },
    viewer: PostViewerContext
  ): PostCapabilities {
    const isPublisher = this.viewerIsPublisher(post, viewer);
    const isModeratorTier = viewer.isGlobalAdmin || viewer.isModerator;
    return {
      canManage: isModeratorTier || isPublisher,
      canPin: isModeratorTier,
      canReport: !!viewer.viewerId && !isPublisher,
      canUnmaskAnonymous: !!post.anonymous && isModeratorTier,
    };
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
    if (!p.associationId) {
      const out: any = { ...p, ...capabilities };
      if (this.mustHideAnonymousAuthor(p, viewer)) {
        delete out.authorId;
        delete out.authorDisplayName;
        delete out.authorFirstName;
        delete out.authorLastName;
      }
      return out;
    }
    const out: any = { ...p, ...capabilities };
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
    Object.assign(raw, this.viewerCapabilities(post, viewer));
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
  async createPost(data: any, isGlobalAdmin: boolean) {
    if (data.linkedCalendarEventId) {
      data.linkedCalendarEventId = await this.associationsService.resolvePostCalendarEventLink(
        data.associationId,
        data.linkedCalendarEventId
      );
    }
    if (Array.isArray(data.polls)) {
      data.polls = data.polls.map((poll: any) => ({
        ...poll,
        id: poll.id || crypto.randomUUID(),
        multipleChoice: poll.multipleChoice ?? false,
        votesByUser: poll.votesByUser ?? {},
        options: (poll.options || []).map((opt: any) => ({
          ...opt,
          id: opt.id || crypto.randomUUID(),
          votes: Array.isArray(opt.votes) ? opt.votes : [],
        })),
      }));
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

    const post = this.postRepo.create(data);
    const saved = await this.postRepo.save(post);
    await this.invalidateListCache();
    const entity = Array.isArray(saved) ? saved[0] : saved;

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
              text: markdown.slice(0, 60),
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
    const selectBody = `posts.id,
         posts."authorId", posts.anonymous, posts.markdown, posts."createdAt", posts."updatedAt",
         posts.mentions, posts.links, posts."attachedFormId", posts."associationId",
         posts."linkedCalendarEventId",
         posts.images, posts.polls, posts.forms, posts.reactions, posts.pinned, posts."scheduledAt",
         (jsonb_array_length(COALESCE(posts.comments, '[]'::jsonb))::integer) AS "commentCount",
         (
           SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
           FROM (
             SELECT elem, ord
             FROM jsonb_array_elements(COALESCE(posts.comments, '[]'::jsonb))
               WITH ORDINALITY AS t(elem, ord)
             ORDER BY ord DESC LIMIT 20
           ) sub
         ) AS comments,
         assoc.id AS "assocJoinId", assoc.name AS "assocName", assoc.slug AS "assocSlug", assoc."logoUrl" AS "assocLogoUrl"`;

    const rawPosts: any[] = await this.postRepo.manager.query(
      `SELECT ${selectBody}
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE (posts.markdown ILIKE $3 OR assoc.name ILIKE $3)
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
       ORDER BY posts.pinned DESC, posts."createdAt" DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset, `%${term}%`]
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

    const viewerCtx = await this.viewerContext(
      rawPosts,
      viewer?.viewerUserId,
      viewer?.isAdmin === true
    );
    const linkedEvents = await this.batchLoadLinkedCalendarEvents(rawPosts);

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
   * Returns paginated posts for one of three feeds:
   * - "all": every post, pinned first
   * - "followed": posts from associations and users the viewer follows
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
  }) {
    const { feed, viewerUserId, isAdmin, promo, formation } = params;
    const limit = Number(params.limit);
    const offset = Number(params.offset);
    const cacheKey = this.listPostsCacheKey(feed, viewerUserId, promo, formation, limit, offset);

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

    // SQL fragment added to every query when a promo cutoff applies.
    // The parameter index is computed per-query below.
    const promoSql = (idx: number) =>
      promoCutoff
        ? `AND COALESCE(posts."scheduledAt", posts."createdAt") >= $${idx}::timestamptz`
        : '';

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

    const selectBody = `posts.id,
         posts."authorId", posts.anonymous, posts.markdown, posts."createdAt", posts."updatedAt",
         posts.mentions, posts.links, posts."attachedFormId", posts."associationId",
         posts."linkedCalendarEventId",
         posts.images, posts.polls, posts.forms, posts.reactions, posts.pinned, posts."scheduledAt",
         (jsonb_array_length(COALESCE(posts.comments, '[]'::jsonb))::integer) AS "commentCount",
         (
           SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
           FROM (
             SELECT elem, ord
             FROM jsonb_array_elements(COALESCE(posts.comments, '[]'::jsonb))
               WITH ORDINALITY AS t(elem, ord)
             ORDER BY ord DESC LIMIT 20
           ) sub
         ) AS comments,
         assoc.id AS "assocJoinId", assoc.name AS "assocName", assoc.slug AS "assocSlug", assoc."logoUrl" AS "assocLogoUrl"`;

    let rawPosts: any[];
    const promoParam = promo === undefined ? null : promo;
    const formationParam = formation === undefined || formation === '' ? null : formation;

    // Non-admin viewers cannot see posts hidden by moderation.
    const hiddenFilter = isAdmin ? '' : `AND NOT COALESCE(posts."hiddenByModeration", false)`;

    // The verification service account is invisible in the feed to everyone except global
    // admins and the account itself. serviceAccountId is validated as hex, so inlining is safe.
    const canSeeServiceAccount = isAdmin || viewerUserId === this.serviceAccountId;
    const serviceAccountFilter =
      !this.serviceAccountId || canSeeServiceAccount
        ? ''
        : `AND posts."authorId" <> '${this.serviceAccountId}'`;

    if (feed === 'associations') {
      // $1=limit, $2=offset, $3=promoCutoff (optional)
      rawPosts = await this.postRepo.manager.query(
        `SELECT ${selectBody}
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE posts."associationId" IS NOT NULL
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         ${hiddenFilter}
         ${serviceAccountFilter}
         ${promoSql(3)}
       ORDER BY posts.pinned DESC, posts."createdAt" DESC
       LIMIT $1 OFFSET $2`,
        [limit, offset, ...(promoCutoff ? [promoCutoff] : [])]
      );
    } else if (feed === 'all') {
      // $1=limit, $2=offset, $3=promoCutoff (optional)
      rawPosts = await this.postRepo.manager.query(
        `SELECT ${selectBody}
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         ${hiddenFilter}
         ${serviceAccountFilter}
         ${promoSql(3)}
       ORDER BY posts.pinned DESC, posts."createdAt" DESC
       LIMIT $1 OFFSET $2`,
        [limit, offset, ...(promoCutoff ? [promoCutoff] : [])]
      );
    } else if (feed === 'followed') {
      // $1=limit, $2=offset, $3=followedAssocIds, $4=followedUserIds, $5=promoCutoff (optional)
      rawPosts = await this.postRepo.manager.query(
        `SELECT ${selectBody}
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE (
         (posts."associationId" IS NOT NULL AND posts."associationId" = ANY($3::uuid[]))
         -- Never an anonymous post: appearing in THIS feed at all already says "written by
         -- someone in the small, known set you follow" - a leak no amount of masking the
         -- author's name removes, because the leak is membership, not the name.
         OR (posts."associationId" IS NULL AND posts."authorId" = ANY($4::text[])
             AND NOT posts.anonymous)
       )
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         ${hiddenFilter}
         ${serviceAccountFilter}
         ${promoSql(5)}
       ORDER BY posts.pinned DESC, posts."createdAt" DESC
       LIMIT $1 OFFSET $2`,
        [limit, offset, followedAssocIds, followedUserIds, ...(promoCutoff ? [promoCutoff] : [])]
      );
    } else {
      // $1=limit, $2=offset, $3=promoParam, $4=formationParam, $5=promoCutoff (optional)
      rawPosts = await this.postRepo.manager.query(
        `SELECT ${selectBody}
       FROM posts
       INNER JOIN users u ON u.id = posts."authorId"
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE posts."associationId" IS NULL
         AND ($3::integer IS NULL OR u.promo = $3::integer)
         AND ($4::text IS NULL OR u.formation ILIKE ('%' || $4::text || '%'))
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
         ${hiddenFilter}
         ${serviceAccountFilter}
         ${promoSql(5)}
       ORDER BY posts.pinned DESC, posts."createdAt" DESC
       LIMIT $1 OFFSET $2`,
        [limit, offset, promoParam, formationParam, ...(promoCutoff ? [promoCutoff] : [])]
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

    const viewerCtx = await this.viewerContext(rawPosts, viewerUserId, isAdmin === true);
    const linkedEvents = await this.batchLoadLinkedCalendarEvents(rawPosts);

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
      await this.postRepo.save(post);
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
    const rows: any[] = await this.postRepo.manager.query(
      `SELECT posts.id, posts."authorId", posts.anonymous, posts.markdown, posts."createdAt",
              posts."associationId", posts."linkedCalendarEventId", posts."hiddenByModeration",
              assoc.id AS "assocJoinId", assoc.name AS "assocName", assoc.slug AS "assocSlug",
              assoc."logoUrl" AS "assocLogoUrl"
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE posts."linkedCalendarEventId" = $1
         AND NOT COALESCE(posts."hiddenByModeration", false)
       ORDER BY posts."createdAt" DESC
       LIMIT 1`,
      [eventId]
    );
    const post = rows[0];
    if (!post) return null;
    const viewerCtx = await this.viewerContext([post], viewerId, isGlobalAdmin);
    return this.stripBigIntForJson(this.shapeListRow(post, viewerCtx));
  }

  async getById(
    id: string,
    opts?: { allowHidden?: boolean; viewerId?: string; isGlobalAdmin?: boolean }
  ) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException('Post not found');
    if (post.hiddenByModeration && !opts?.allowHidden) {
      throw new ForbiddenException('Post not available');
    }
    // Every listPosts query carries `scheduledAt IS NULL OR scheduledAt <= NOW()`; this read did
    // not, so a post queued for a future date was already served by id - and a link preview or an
    // unfurled share would have published it before its own publication date. Its author and a
    // global admin still reach it, so scheduling a post does not hide it from the person who wrote
    // it. Answers "not found" rather than "forbidden" to everyone else: the existence of an
    // unpublished post is itself the thing to hide.
    const publishesLater = !!post.scheduledAt && post.scheduledAt.getTime() > Date.now();
    const viewerOwnsIt = !!opts?.viewerId && post.authorId === opts.viewerId;
    if (publishesLater && !viewerOwnsIt && !opts?.allowHidden) {
      this.logger.debug(`getById ${id} withheld: scheduled for ${post.scheduledAt?.toISOString()}`);
      throw new NotFoundException('Post not found');
    }
    const shaped = await this.toPublicPostFromEntity(
      post,
      await this.viewerContext([post], opts?.viewerId, opts?.isGlobalAdmin === true)
    );
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

    post.markdown = data.markdown;

    if (data.media !== undefined) {
      post.media = data.media;
    } else if (data.images !== undefined) {
      post.media = data.images;
    }

    if (data.polls !== undefined) {
      post.polls = data.polls.map((poll: any) => ({
        ...poll,
        id: poll.id || crypto.randomUUID(),
        multipleChoice: poll.multipleChoice ?? false,
        votesByUser: poll.votesByUser ?? {},
        options: (poll.options || []).map((opt: any) => ({
          ...opt,
          id: opt.id || crypto.randomUUID(),
          votes: Array.isArray(opt.votes) ? opt.votes : [],
        })),
      }));
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

    if ('scheduledAt' in data)
      post.scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;

    const mentionedIds = post.markdown
      ? this.notifications
          .resolveMentionedUserIds(post.markdown)
          .filter((id) => id !== post.authorId)
      : [];
    post.mentions = mentionedIds;

    const saved = await this.postRepo.save(post);
    await this.invalidateListCache();
    return this.toPublicPostFromEntity(
      saved,
      await this.viewerContext([saved], userId, isGlobalAdmin)
    );
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
    await this.postRepo.remove(post);
    return { ok: true };
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
