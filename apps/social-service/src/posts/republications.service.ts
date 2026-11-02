import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type EntityManager } from 'typeorm';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { RedisService } from '../common/redis/redis.service';
import { previewOf } from '../push/push-content';
import {
  NEWLY_REACHED_BY_REPUBLICATION_SQL,
  newlyReachedByPersonalRepublicationSql,
  postVisibleToViewerSql,
} from '../spaces/reader-spaces';
import {
  ProposalsService,
  type AfterCommit,
  type AssociationProposal,
  type ProposalKindHandler,
} from '../proposals/proposals.service';
import { PostRepublication } from './entities/post-republication.entity';
import { PostNotificationsService } from './post-notifications.service';
import { invalidatePostListCache } from './post-list-cache';
import { lockPostRow, REPUBLISHING_ASSOCIATION_TYPES } from './republication-sql';
import { isExpiredReel, type PostKind } from './reel.constants';

/** The columns of a post a republication decides on. */
export interface PostRow {
  id: string;
  authorId: string;
  associationId: string | null;
  anonymous: boolean;
  hiddenByModeration: boolean;
  scheduledAt: Date | null;
  kind: PostKind;
  expiresAt: Date | null;
  markdown: string | null;
}

/**
 * Whether a post is withheld from everyone but its author - hidden by moderation, not yet
 * published, or an expired reel. Such a post is a 404 to whoever asks to republish it.
 */
export function isWithheldPost(post: PostRow): boolean {
  const unpublished = !!post.scheduledAt && new Date(post.scheduledAt).getTime() > Date.now();
  return post.hiddenByModeration || unpublished || isExpiredReel(post);
}

/** An association as a republication needs it. */
export interface AssociationRow {
  id: string;
  name: string;
  type: string;
  logoUrl: string | null;
  logoMediaId: string | null;
}

/**
 * REPUBLICATION (D38, decided by the user on 2026-10-04, docs/wiki/profiles-and-access.md).
 *
 * A post reaches the audience of its association plus the audience of every association that
 * republishes it, like a LinkedIn repost; the original cannot forbid it. A PERSONAL post is never
 * republished through THIS class: only its author's consent republishes it (D38b,
 * `PersonalRepublicationsService`, which reuses `writeRepublication`). Two ways in, one row
 * (`post_republications`):
 * - PULL, immediate: whoever may publish in association X's name (`POST_AS_ASSO`) republishes, as
 *   X, a post they can SEE. X's own voice is X's own consent.
 * - PUSH, a proposal: whoever may publish in the post's association's name SENDS it to another
 *   association, which accepts or refuses - X speaks only when X's publishers say so. The proposal
 *   machinery is generic (`proposals/`); this class is its `repost` kind.
 *
 * WHO IS TOLD: only the readers who see the post for the FIRST time because of the republication,
 * computed on state under the post row's lock (`writeRepublication`), never on a clock.
 */
@Injectable()
export class RepublicationsService implements OnModuleInit, ProposalKindHandler {
  private readonly logger = new Logger(RepublicationsService.name);
  readonly kind = 'repost' as const;
  readonly senderFlag = AssociationPermissionFlag.POST_AS_ASSO;
  readonly acceptorFlag = AssociationPermissionFlag.POST_AS_ASSO;

  constructor(
    @InjectRepository(PostRepublication) private readonly repo: Repository<PostRepublication>,
    private readonly associations: AssociationsService,
    private readonly notifications: PostNotificationsService,
    private readonly redis: RedisService,
    private readonly proposals: ProposalsService
  ) {}

  onModuleInit(): void {
    this.proposals.register(this);
  }

  /**
   * PULL: `actorId` republishes `postId` as `associationId`, immediately. 403 without the right to
   * publish in its name; 404 for a post the actor cannot see; 409 when it is already republished
   * there. A proposal pending for the same pair is settled as accepted - the receiver just said yes.
   */
  async republish(
    postId: string,
    associationId: string,
    actorId: string,
    isGlobalAdmin: boolean
  ): Promise<{ postId: string; associationId: string; newlyReached: number }> {
    const post = await this.loadRepublishable(postId);
    await this.assertTarget(post, associationId);
    if (!(await this.associations.canPostAs(actorId, associationId, { isGlobalAdmin }))) {
      this.logger.debug(
        `[REPOST] ${actorId.slice(0, 8)} may not publish as ${associationId.slice(0, 8)}`
      );
      throw new ForbiddenException('You may not publish in this association name');
    }
    await this.assertVisibleTo(postId, actorId);
    let newlyReached = 0;
    const after = await this.repo.manager.transaction(async (manager) => {
      const applied = await this.writeRepublication(manager, post, associationId, actorId);
      newlyReached = applied.newlyReached;
      return applied.after;
    });
    await after();
    return { postId, associationId, newlyReached };
  }

  /**
   * A republication is withdrawn, by one of TWO parties:
   * - the republishing association ITSELF (the right to publish in its name, D38);
   * - the AUTHOR of a PERSONAL post, any republication of it, at any time (D38b): their consent
   *   was what made it, and it stays theirs to take back.
   *
   * For a personal post the request that made it moves in the same transaction, and WHO withdrew
   * decides how: the author's withdrawal is recorded as a REFUSAL, which stands - the association
   * cannot ask again for that post; the association's own withdrawal frees its place
   * (`withdrawn`), so it may ask again and the author decides again. The author is read first, so
   * an author who is also an officer of the association withdraws as the author.
   */
  async unrepublish(
    postId: string,
    associationId: string,
    actorId: string,
    isGlobalAdmin: boolean
  ): Promise<{ ok: true }> {
    const post = await this.loadPostRow(postId);
    const byAuthor = !!post && !post.associationId && post.authorId === actorId;
    const flag = AssociationPermissionFlag.POST_AS_ASSO;
    if (
      !byAuthor &&
      !(await this.associations.mayAct(actorId, associationId, flag, { isGlobalAdmin }))
    ) {
      this.logger.debug(
        `[REPOST] ${actorId.slice(0, 8)} may not withdraw ${associationId.slice(0, 8)}'s republication`
      );
      throw new ForbiddenException('You may not publish in this association name');
    }
    await this.repo.manager.transaction(async (manager) => {
      // The post first, then the proposal it closes below: see `lockPostRow`.
      await lockPostRow(manager, postId);
      const removed: unknown = await manager.query(
        `DELETE FROM post_republications WHERE "postId" = $1 AND "associationId" = $2`,
        [postId, associationId]
      );
      const count = Array.isArray(removed) && typeof removed[1] === 'number' ? removed[1] : 0;
      if (count === 0) throw new NotFoundException('Republication not found');
      if (post && !post.associationId) {
        await manager.query(
          `UPDATE proposals SET status = $4, "decidedBy" = $3, "decidedAt" = now()
            WHERE kind = 'repost-personal' AND "subjectId" = $1 AND "fromAssociationId" = $2
              AND status = 'accepted'`,
          [postId, associationId, actorId, byAuthor ? 'refused' : 'withdrawn']
        );
      }
    });
    this.logger.log(
      `[REPOST] republication of ${postId.slice(0, 8)} by ${associationId.slice(0, 8)} withdrawn ` +
        `by ${byAuthor ? 'its author' : 'the association'} (${actorId.slice(0, 8)})`
    );
    await this.dropFeedCache();
    return { ok: true };
  }

  /** PUSH: the post's own publishers send it to another association, which decides. */
  propose(postId: string, toAssociationId: string, actorId: string, isGlobalAdmin: boolean) {
    return this.proposals.propose('repost', postId, toAssociationId, actorId, isGlobalAdmin);
  }

  // ── The `repost` proposal kind ─────────────────────────────────────────────────────────────────

  async resolveSender(postId: string, toAssociationId: string): Promise<string> {
    const post = await this.loadRepublishable(postId);
    await this.assertTarget(post, toAssociationId);
    const existing: unknown[] = await this.repo.manager.query(
      `SELECT 1 FROM post_republications WHERE "postId" = $1 AND "associationId" = $2`,
      [postId, toAssociationId]
    );
    if (existing.length > 0) {
      throw new ConflictException('This association has already republished this post');
    }
    // `loadRepublishable` refused a personal post, so the publisher is an association.
    return post.associationId as string;
  }

  async apply(
    manager: EntityManager,
    proposal: AssociationProposal,
    actorId: string
  ): Promise<AfterCommit> {
    // The post may have changed since it was proposed (a reel expiring): judged again, now.
    const post = await this.loadRepublishable(proposal.subjectId, manager);
    const applied = await this.writeRepublication(manager, post, proposal.toAssociationId, actorId);
    return applied.after;
  }

  async announce(proposal: AssociationProposal, acceptorIds: string[]): Promise<void> {
    const [from, post] = await Promise.all([
      this.loadAssociation(proposal.fromAssociationId),
      this.loadPostRow(proposal.subjectId),
    ]);
    if (!from || !post) {
      this.logger.warn(
        `[REPOST] proposal ${proposal.id} cannot be announced: its association or post is gone`
      );
      return;
    }
    // `postId` CARRIES THE RECEIVING ASSOCIATION, as the agenda's notifications carry theirs: what
    // the acceptor must open is that association's queue - the post itself may be outside their
    // spaces, which is the reason it was proposed to them at all.
    const count = await this.notifications.createNotifications({
      recipientIds: acceptorIds,
      type: 'repost_proposed',
      postId: proposal.toAssociationId,
      actorId: proposal.proposedBy,
      actorName: from.name,
      associationId: from.id,
      associationLogoUrl: from.logoUrl,
      associationLogoMediaId: from.logoMediaId,
      text: previewOf(post.markdown ?? ''),
      // The tap opens the receiving association's queue, not the feed.
      pushData: { queueAssociationId: proposal.toAssociationId },
    });
    this.logger.log(`[REPOST] proposal ${proposal.id.slice(0, 8)} announced to ${count}`);
  }

  /** The post first, then the proposal: see `lockPostRow`. */
  lockSubject(manager: EntityManager, postId: string): Promise<void> {
    return lockPostRow(manager, postId);
  }

  async describe(postIds: string[]): Promise<Map<string, Record<string, unknown>>> {
    if (postIds.length === 0) return new Map();
    const rows: {
      id: string;
      markdown: string | null;
      createdAt: Date;
      associationName: string | null;
    }[] = await this.repo.manager.query(
      `SELECT p.id, p.markdown, p."publishedAt" AS "createdAt", a.name AS "associationName"
         FROM posts p LEFT JOIN associations a ON a.id = p."associationId"
        WHERE p.id = ANY($1::uuid[])`,
      [postIds]
    );
    return new Map(
      rows.map((r) => [
        r.id,
        {
          preview: previewOf(r.markdown ?? ''),
          createdAt: r.createdAt,
          associationName: r.associationName,
        },
      ])
    );
  }

  // ── The one write ──────────────────────────────────────────────────────────────────────────────

  /**
   * Writes the republication and decides who to tell, inside the caller's transaction.
   *
   * THE POST ROW IS LOCKED FIRST, and that lock is what makes the notification exact. The announce
   * sweeper (`PostAnnounceScheduler`) stamps `feedNotifiedAt` and reads its recipients under the
   * same lock: a post not announced yet will be announced to everyone who sees it by then, this
   * republication's readers included, so it is told nothing here; an announced one is told to the
   * readers who see it for the first time - `NEWLY_REACHED_BY_REPUBLICATION_SQL`, asked BEFORE the
   * row exists. The idempotence is the primary key: a second republication of the pair is a 409.
   *
   * A PERSONAL post (D38b) is announced to its author's FOLLOWERS only, never to everyone who sees
   * it, so "the sweep will tell them" holds for the followers alone: before the first announce, the
   * readers newly reached who do NOT follow the author are told here, and the sweep tells the
   * followers; after it, every newly reached reader is told here. Either way, never a reader on the
   * other side of a block with the author (`newlyReachedByPersonalRepublicationSql`).
   */
  async writeRepublication(
    manager: EntityManager,
    post: PostRow,
    associationId: string,
    actorId: string
  ): Promise<{ newlyReached: number; after: AfterCommit }> {
    const locked: { feedNotifiedAt: Date | null }[] = await manager.query(
      `SELECT "feedNotifiedAt" FROM posts WHERE id = $1 FOR UPDATE`,
      [post.id]
    );
    if (locked.length === 0) throw new NotFoundException('Post not found');
    const announced = locked[0].feedNotifiedAt !== null;
    const personal = !post.associationId;
    let newly: { id: string }[] = [];
    if (personal) {
      newly = await manager.query(newlyReachedByPersonalRepublicationSql(announced), [
        post.id,
        associationId,
      ]);
    } else if (announced) {
      newly = await manager.query(NEWLY_REACHED_BY_REPUBLICATION_SQL, [post.id, associationId]);
    }
    const inserted: unknown[] = await manager.query(
      `INSERT INTO post_republications ("postId", "associationId", "republishedBy")
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING "postId"`,
      [post.id, associationId, actorId]
    );
    if (inserted.length === 0) {
      this.logger.debug(
        `[REPOST] ${post.id.slice(0, 8)} already republished by ${associationId.slice(0, 8)}`
      );
      throw new ConflictException('This association has already republished this post');
    }
    await manager.query(
      `UPDATE proposals SET status = 'accepted', "decidedBy" = $3, "decidedAt" = now()
        WHERE kind = 'repost' AND "subjectId" = $1 AND "toAssociationId" = $2 AND status = 'pending'`,
      [post.id, associationId, actorId]
    );
    const recipientIds = newly.map((r) => r.id);
    this.logger.log(
      `[REPOST] ${post.id.slice(0, 8)} republished by ${associationId.slice(0, 8)} ` +
        `(actor ${actorId.slice(0, 8)}, personal=${personal}, announced=${announced}, ` +
        `newly reached=${recipientIds.length})`
    );
    return {
      newlyReached: recipientIds.length,
      after: async () => {
        await this.dropFeedCache();
        await this.tellNewlyReached(post, associationId, actorId, recipientIds);
      },
    };
  }

  /** "X a relaye une publication": to the readers the republication reached first. Best effort. */
  private async tellNewlyReached(
    post: PostRow,
    associationId: string,
    actorId: string,
    recipientIds: string[]
  ): Promise<void> {
    if (recipientIds.length === 0) return;
    try {
      const republisher = await this.loadAssociation(associationId);
      if (!republisher) {
        this.logger.warn(`[REPOST] ${associationId} vanished before its readers were told`);
        return;
      }
      await this.notifications.createNotifications({
        recipientIds,
        type: 'association_repost',
        postId: post.id,
        actorId,
        actorName: republisher.name,
        associationId: republisher.id,
        associationLogoUrl: republisher.logoUrl,
        associationLogoMediaId: republisher.logoMediaId,
        text: previewOf(post.markdown ?? ''),
        pushData: { postId: post.id },
      });
    } catch (e: unknown) {
      // The republication is committed; what a failure loses is the notification, and this line is
      // all that loss leaves.
      this.logger.warn(`[REPOST] ${post.id} republished but its new readers were not told`, e);
    }
  }

  // ── Reads and refusals ─────────────────────────────────────────────────────────────────────────

  /** The post's deciding columns, or null when it does not exist. */
  async loadPostRow(postId: string, manager?: EntityManager): Promise<PostRow | null> {
    const rows: PostRow[] = await (manager ?? this.repo.manager).query(
      `SELECT id, "authorId", "associationId", COALESCE(anonymous, false) AS anonymous,
              "hiddenByModeration", "scheduledAt", kind, "expiresAt", markdown
         FROM posts WHERE id = $1`,
      [postId]
    );
    return rows[0] ?? null;
  }

  /**
   * The post, refused when it may not be republished here: gone, hidden, not yet published or an
   * expired reel is a 404 (for whoever asks, it does not exist); a PERSONAL post is a 400 on these
   * routes - it is republished only by its author's consent (D38b,
   * `PersonalRepublicationsService`), never by an association acting alone.
   */
  private async loadRepublishable(postId: string, manager?: EntityManager): Promise<PostRow> {
    const post = await this.loadPostRow(postId, manager);
    if (!post || isWithheldPost(post)) {
      this.logger.debug(`[REPOST] ${postId.slice(0, 8)} is not republishable (absent or withheld)`);
      throw new NotFoundException('Post not found');
    }
    if (!post.associationId) {
      this.logger.debug(`[REPOST] ${postId.slice(0, 8)} refused: a personal post`);
      throw new BadRequestException('A personal post is republished only with its author consent');
    }
    return post;
  }

  async loadAssociation(id: string): Promise<AssociationRow | null> {
    const rows: AssociationRow[] = await this.repo.manager.query(
      `SELECT id, name, type, "logoUrl", "logoMediaId" FROM associations WHERE id = $1`,
      [id]
    );
    return rows[0] ?? null;
  }

  /** The receiving association: it exists, it is a kind that republishes, it is not the post's own. */
  private async assertTarget(post: PostRow, associationId: string): Promise<void> {
    if (associationId === post.associationId) {
      throw new BadRequestException('A post is already in its own association');
    }
    const target = await this.loadAssociation(associationId);
    if (!target) throw new NotFoundException('Association not found');
    if (!REPUBLISHING_ASSOCIATION_TYPES.includes(target.type)) {
      this.logger.debug(`[REPOST] ${associationId.slice(0, 8)} refused: type ${target.type}`);
      throw new BadRequestException('Only an association republishes a post');
    }
  }

  /**
   * The pull path's "a post one's association already sees": the actor can open it - the same
   * predicate as reading it by its id (`PostsService.assertVisible`), so a global admin acting in an
   * association's name may republish what they can open.
   *
   * GRANT-FREE (`readGrants: false`): a nominative read grant opens a post to READ, never to
   * republish it - publishing goes through an institution (user, 2026-10-07).
   */
  async assertVisibleTo(postId: string, actorId: string): Promise<void> {
    const rows: { visible: boolean }[] = await this.repo.manager.query(
      `SELECT ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: true, readGrants: false, memberReposts: false })} AS visible
         FROM posts WHERE posts.id = $1`,
      [postId, actorId]
    );
    if (rows[0]?.visible !== true) {
      this.logger.debug(`[REPOST] ${postId.slice(0, 8)} not visible to ${actorId.slice(0, 8)}`);
      throw new NotFoundException('Post not found');
    }
  }

  private async dropFeedCache(): Promise<void> {
    try {
      await invalidatePostListCache(this.redis);
    } catch (e: unknown) {
      this.logger.warn('[CACHE] feed cache sweep failed after a republication', e);
    }
  }
}
