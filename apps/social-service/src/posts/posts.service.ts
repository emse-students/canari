/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';

/** Core post service: creation, listing (with Redis cache), search, scheduling, and moderation. */
@Injectable()
export class PostsService {
  private static readonly LIST_CACHE_TTL = 30; // seconds

  /** PostgreSQL BIGINT fields break JSON.stringify — convert to Number. */
  private stripBigIntForJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? Number(v) : v))) as T;
  }

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly redis: RedisService,
    private readonly followsService: FollowsService
  ) {}

  private listPostsCacheKey(
    feed: string,
    viewerUserId: string | undefined,
    promo: number | undefined,
    formation: string | undefined,
    limit: number,
    offset: number
  ) {
    return `posts:list:v2:${feed}:${viewerUserId ?? 'anon'}:${promo ?? '-'}:${formation ?? '-'}:${limit}:${offset}`;
  }

  /** Deletes the most-common list cache keys so the next request gets fresh data. */
  private async invalidateListCache() {
    await this.redis.del(
      this.listPostsCacheKey('all', undefined, undefined, undefined, 10, 0),
      this.listPostsCacheKey('all', undefined, undefined, undefined, 20, 0),
      this.listPostsCacheKey('all', undefined, undefined, undefined, 30, 0),
      this.listPostsCacheKey('all', undefined, undefined, undefined, 50, 0)
    );
  }

  /** Strip publisher identity and attach association display for API responses. */
  private shapeListRow(p: any): any {
    if (!p.associationId) {
      return p;
    }
    const out: any = { ...p };
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

  /** Anonymize association-authored posts loaded as TypeORM entities. */
  private async toPublicPostFromEntity(post: Post): Promise<Record<string, unknown>> {
    const raw: any = { ...(post as any) };
    if (!raw.associationId) {
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
    return raw;
  }

  /**
   * Creates a new post. Normalises polls and event buttons (assigns UUIDs, default values),
   * saves to DB, invalidates the Redis list cache, and returns the public-shaped entity.
   */
  async createPost(data: any) {
    if (Array.isArray(data.eventButtons)) {
      data.eventButtons = data.eventButtons.map((btn: any) => ({
        ...btn,
        id: btn.id || crypto.randomUUID(),
        registrants: btn.registrants ?? [],
      }));
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
    const post = this.postRepo.create(data);
    const saved = await this.postRepo.save(post);
    await this.invalidateListCache();
    const entity = Array.isArray(saved) ? saved[0] : saved;
    return this.toPublicPostFromEntity(entity);
  }

  /** Full-text search across post markdown and association names. Excludes future-scheduled posts. */
  async searchPosts(q: string, limit = 20, offset = 0): Promise<any[]> {
    const term = q.trim();
    if (!term) return [];
    const selectBody = `posts.id,
         posts."authorId", posts.markdown, posts."createdAt", posts."updatedAt",
         posts.mentions, posts.links, posts."attachedFormId", posts."associationId", posts."paymentAssociationId",
         posts.images, posts.polls, posts."eventButtons", posts.forms, posts.reactions, posts.pinned, posts."scheduledAt",
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

    const authorIds = [...new Set(
      rawPosts.filter((p: any) => !p.associationId && p.authorId).map((p: any) => p.authorId),
    )] as string[];

    let nameMap: Record<string, { displayName: string | null; firstName: string | null; lastName: string | null }> = {};
    if (authorIds.length > 0) {
      const rows: { id: string; displayName: string | null; firstName: string | null; lastName: string | null }[] =
        await this.postRepo.manager.query(
          `SELECT id, "displayName", "firstName", "lastName" FROM users WHERE id = ANY($1)`,
          [authorIds]
        );
      nameMap = Object.fromEntries(rows.map((r) => [r.id, { displayName: r.displayName, firstName: r.firstName, lastName: r.lastName }]));
    }

    const result = rawPosts.map((p: any) => {
      let row = p;
      if (!p.associationId && p.authorId) {
        const info = nameMap[p.authorId] ?? { displayName: null, firstName: null, lastName: null };
        row = { ...p, authorDisplayName: info.displayName, authorFirstName: info.firstName, authorLastName: info.lastName };
      }
      return this.shapeListRow(row);
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
    feed: 'all' | 'followed' | 'custom';
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
      // Redis miss or error — fall through to DB
    }

    // Promo-based date gate: non-admin viewers cannot see posts published before
    // August 1st of their promo year.
    let promoCutoff: string | null = null;
    if (!isAdmin && viewerUserId) {
      try {
        const rows: { promo: number | null }[] = await this.postRepo.manager.query(
          `SELECT promo FROM users WHERE id = $1 LIMIT 1`,
          [viewerUserId]
        );
        const viewerPromo = rows[0]?.promo ?? null;
        if (viewerPromo != null) {
          promoCutoff = `${viewerPromo}-08-01`;
        }
      } catch { /* non-fatal */ }
    }

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
        this.followsService.getFollowedAssociationIdsForUser(viewerUserId!),
        this.followsService.getFollowedUserIdsForUser(viewerUserId!),
      ]);
      if (followedAssocIds.length === 0 && followedUserIds.length === 0) {
        return [];
      }
    }

    const selectBody = `posts.id,
         posts."authorId", posts.markdown, posts."createdAt", posts."updatedAt",
         posts.mentions, posts.links, posts."attachedFormId", posts."associationId", posts."paymentAssociationId",
         posts.images, posts.polls, posts."eventButtons", posts.forms, posts.reactions, posts.pinned, posts."scheduledAt",
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

    if (feed === 'all') {
      // $1=limit, $2=offset, $3=promoCutoff (optional)
      rawPosts = await this.postRepo.manager.query(
        `SELECT ${selectBody}
       FROM posts
       LEFT JOIN associations assoc ON assoc.id = posts."associationId"
       WHERE (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
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
         OR (posts."associationId" IS NULL AND posts."authorId" = ANY($4::text[]))
       )
         AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())
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
      if (Array.isArray(post.eventButtons)) {
        for (const btn of post.eventButtons) {
          if (!Array.isArray(btn.registrants)) btn.registrants = [];
        }
      }
    }

    const authorIds = [
      ...new Set(
        rawPosts.filter((p: any) => !p.associationId && p.authorId).map((p: any) => p.authorId)
      ),
    ] as string[];

    let nameMap: Record<string, { displayName: string | null; firstName: string | null; lastName: string | null }> = {};
    if (authorIds.length > 0) {
      const rows: { id: string; displayName: string | null; firstName: string | null; lastName: string | null }[] =
        await this.postRepo.manager.query(
          `SELECT id, "displayName", "firstName", "lastName" FROM users WHERE id = ANY($1)`,
          [authorIds]
        );
      nameMap = Object.fromEntries(
        rows.map((r) => [r.id, { displayName: r.displayName, firstName: r.firstName, lastName: r.lastName }])
      );
    }

    const result = rawPosts.map((p: any) => {
      let row = p;
      if (!p.associationId && p.authorId) {
        const authorInfo = nameMap[p.authorId] ?? { displayName: null, firstName: null, lastName: null };
        row = {
          ...p,
          authorDisplayName: authorInfo.displayName,
          authorFirstName: authorInfo.firstName,
          authorLastName: authorInfo.lastName,
        };
      }
      return this.shapeListRow(row);
    });

    const safe = this.stripBigIntForJson(result);

    try {
      await this.redis.setex(cacheKey, PostsService.LIST_CACHE_TTL, JSON.stringify(safe));
    } catch {
      // Non-fatal
    }

    return safe;
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
  async getById(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) throw new NotFoundException('Post not found');
    return this.toPublicPostFromEntity(post);
  }

  /** Updates a post's markdown content. Only the original author may edit. */
  async updatePost(postId: string, userId: string, markdown: string) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    if (post.authorId !== userId) throw new UnauthorizedException('Not your post');
    post.markdown = markdown;
    const saved = await this.postRepo.save(post);
    return this.toPublicPostFromEntity(saved);
  }

  /** Permanently deletes a post. Authors can delete their own; global admins can delete any. */
  async deletePost(postId: string, userId: string, isAdmin: boolean) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    if (!isAdmin && post.authorId !== userId) throw new UnauthorizedException('Not your post');
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

  /** Records a user's report on a post. Silently ignores duplicate reports from the same user. */
  async reportPost(postId: string, userId: string, reason: string) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    const reports = Array.isArray(post.reports) ? post.reports : [];
    if (reports.some((r: any) => r.userId === userId)) {
      return { ok: true, alreadyReported: true };
    }
    post.reports = [...reports, { userId, reason, createdAt: new Date().toISOString() }];
    await this.postRepo.save(post);
    return { ok: true };
  }
}
