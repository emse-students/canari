import {
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Headers,
  Logger,
  Post as HttpPost,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FOLLOW_REQUEST_NOTIFICATION } from '../follows/follow-requests.service';
import { In, Repository } from 'typeorm';
import { assertInternalSecret } from './internal-secret.util';
import { sanitizeLog } from '../common/log.utils';
import { Post as PostEntity } from '../posts/entities/post.entity';
import { Association } from '../associations/entities/association.entity';
import { AssociationMember } from '../associations/entities/association-member.entity';
import { AssociationRoleHistory } from '../associations/entities/association-role-history.entity';
import { UserFollow } from '../follows/entities/user-follow.entity';
import { short } from '../follows/follows.service';
import { ChannelService } from '../channels/channel.service';
import { RedisService } from '../common/redis/redis.service';
import { invalidatePostListCache } from '../posts/post-list-cache';
import { PostMediaRetentionService } from '../posts/post-media-retention.service';
import { type ErasureDb, eraseSocialRows, keptPostMediaIds } from './account-erasure';
import type { EntityManager } from 'typeorm';

/**
 * Internal-only user data deletion endpoint - called by core-service during account deletion.
 * NOT exposed through Nginx: only reachable via Docker-internal networking.
 * Auth: X-Internal-Secret header matched against INTERNAL_SECRET env var.
 */
@Controller('internal')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);

  constructor(
    @InjectRepository(PostEntity)
    private readonly postRepo: Repository<PostEntity>,
    @InjectRepository(Association)
    private readonly assocRepo: Repository<Association>,
    @InjectRepository(AssociationMember)
    private readonly assocMemberRepo: Repository<AssociationMember>,
    @InjectRepository(AssociationRoleHistory)
    private readonly roleHistoryRepo: Repository<AssociationRoleHistory>,
    @InjectRepository(UserFollow)
    private readonly userFollowRepo: Repository<UserFollow>,
    private readonly channelService: ChannelService,
    private readonly redis: RedisService,
    private readonly postMediaRetention: PostMediaRetentionService
  ) {}

  /**
   * Throws the cached feed pages away, for every reader.
   *
   * Called by core-service when a block is placed OR LIFTED, and the second half is why this is a
   * route of its own rather than a line inside `severFollowsBetween`: lifting a block restores no
   * follow, so the only other internal call a block makes does not fire then. Without it the feed
   * a reader sees for up to the 30-second TTL is the one computed before their own decision - they
   * block somebody, open the feed, and the posts are still there. A control that appears not to
   * have worked is one people press again.
   *
   * It drops the WHOLE keyspace rather than the two readers' own pages, because a key carries the
   * viewer AND the promo filter AND the formation filter AND the page size AND the offset: the
   * pages belonging to one reader cannot be named without enumerating that product, which is the
   * mistake `post-list-cache`'s own docblock records. Blocks are rare and the keyspace is a few
   * hundred entries.
   */
  @HttpPost('posts/list-cache/invalidate')
  async invalidateFeedCache(@Headers('x-internal-secret') headerSecret: string) {
    assertInternalSecret(headerSecret);
    const dropped = await invalidatePostListCache(this.redis);
    this.logger.log(`[INTERNAL_FEED_CACHE_DROP] keys=${dropped}`);
    return { ok: true, dropped };
  }

  /**
   * Drops every follow relationship between two accounts, in BOTH directions.
   *
   * Called by core-service when one of them blocks the other: staying subscribed to somebody you
   * have just blocked is a state nobody asked for, and follows live here while blocks live there.
   *
   * A follow REQUEST is a row here too (WP-F2), so it goes the same way, and so does its
   * `follow_request` bell row in either direction: a request that no longer exists is not left
   * in the other person's notifications. An acceptance's bell row is history and stays.
   *
   * Idempotent - two people who never followed each other are a valid, silent zero. The count is
   * logged either way, because a sweep that reports nothing is a sweep nobody can tell ran.
   */
  @Delete('follows/between/:userA/:userB')
  async severFollowsBetween(
    @Param('userA') userA: string,
    @Param('userB') userB: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    assertInternalSecret(headerSecret);
    const [forward, backward] = await Promise.all([
      this.userFollowRepo.delete({ followerUserId: userA, followedUserId: userB }),
      this.userFollowRepo.delete({ followerUserId: userB, followedUserId: userA }),
    ]);
    const removed = (forward.affected ?? 0) + (backward.affected ?? 0);
    const bell: unknown = await this.userFollowRepo.query(
      `DELETE FROM post_notifications
        WHERE type = $3
          AND (("recipientId" = $1 AND "actorId" = $2) OR ("recipientId" = $2 AND "actorId" = $1))`,
      [userA, userB, FOLLOW_REQUEST_NOTIFICATION]
    );
    // TypeORM's Postgres driver answers a DELETE with `[rows, rowCount]`.
    const bellRows = Array.isArray(bell) && typeof bell[1] === 'number' ? bell[1] : 0;
    this.logger.log(
      `[INTERNAL_SEVER_FOLLOWS] a=${short(userA)} b=${short(userB)} removed=${removed} requestNotices=${bellRows}`
    );
    return { ok: true, removed };
  }

  /**
   * The payment-account state of an association, for core-service.
   *
   * `GET /api/associations/:id` answers 401 to a caller with no `X-User-Id` since 2026-08-05 (it
   * became "logged-in callers only"), and core-service's connect-status, dashboard-link and Lydia
   * validation all read it server to server - so all three said "Association not found" for ever.
   * Internal secret, never nginx identity, and ONLY the two payment fields: no other column of the
   * association leaves through here.
   */
  @Get('associations/:associationId/payment-account')
  async getPaymentAccount(
    @Param('associationId') associationId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    assertInternalSecret(headerSecret);
    const asso = await this.assocRepo.findOne({
      where: { id: associationId },
      select: {
        id: true,
        lydiaAccountId: true,
        lydiaOnboardingComplete: true,
      },
    });
    if (!asso) {
      this.logger.warn(`[INTERNAL_PAYMENT_ACCOUNT] unknown association ${associationId}`);
      throw new NotFoundException('Association not found');
    }
    return {
      lydiaAccountId: asso.lydiaAccountId,
      lydiaOnboardingComplete: asso.lydiaOnboardingComplete,
    };
  }

  /** Returns member user IDs for an association (core-service directory filter). */
  @Get('associations/:associationId/member-user-ids')
  async listMemberUserIds(
    @Param('associationId') associationId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    assertInternalSecret(headerSecret);
    const rows = await this.assocMemberRepo.find({
      where: { associationId },
      select: { userId: true },
    });
    return { userIds: rows.map((r) => r.userId) };
  }

  /**
   * Associations of a user for external profile display (e.g. Sky parrainage app):
   * `current` = memberships in active associations, `former` = memberships in
   * archived associations plus past role-history entries (CV). Read-only projection.
   */
  @Get('users/:userId/associations')
  async listUserAssociations(
    @Param('userId') userId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    assertInternalSecret(headerSecret);

    const members = await this.assocMemberRepo.find({ where: { userId } });
    const history = await this.roleHistoryRepo.find({
      where: { userId },
      order: { sortOrder: 'ASC' },
    });

    // Resolve association names/logos for both memberships and history in one query.
    const ids = Array.from(
      new Set([...members.map((m) => m.associationId), ...history.map((h) => h.associationId)])
    );
    const assocs = ids.length ? await this.assocRepo.find({ where: { id: In(ids) } }) : [];
    const byId = new Map(assocs.map((a) => [a.id, a]));

    const current: {
      name: string;
      slug: string;
      role: string;
      logoUrl: string | null;
    }[] = [];
    const former: {
      name: string;
      role: string;
      logoUrl: string | null;
      startYear: number | null;
      endYear: number | null;
    }[] = [];

    for (const m of members) {
      const a = byId.get(m.associationId);
      if (!a) continue;
      if (a.archived) {
        former.push({
          name: a.name,
          role: m.role,
          logoUrl: a.logoUrl,
          startYear: null,
          endYear: null,
        });
      } else {
        current.push({ name: a.name, slug: a.slug, role: m.role, logoUrl: a.logoUrl });
      }
    }

    for (const h of history) {
      const a = byId.get(h.associationId);
      former.push({
        name: a?.name ?? 'Association',
        role: h.roleTitle,
        logoUrl: a?.logoUrl ?? null,
        startYear: h.startYear,
        endYear: h.endYear,
      });
    }

    return { current, former };
  }

  /**
   * Deletes or anonymises all social data for the given user - the social half of an account
   * erasure, called by core-service's durable erasure queue until it answers 2xx, then once more
   * after every token the account held has expired.
   *
   * Three steps, each idempotent:
   *  1. the account leaves every community, each one repaired before the row goes
   *     (`ChannelService.removeAccountFromWorkspaces` - it throws when a community could not be
   *     processed, so the queue retries rather than closing the job);
   *  2. the media of the posts it published AS an association - which stay - are re-classed so
   *     media-service's part keeps them (it throws on failure, so the queue retries);
   *  3. ONE transaction runs `eraseSocialRows`: every statement, and the scrub of what the account
   *     left inside other people's posts (comments, likes, reactions, poll votes) - all or nothing,
   *     so a failure leaves nothing half-done that a retry could miss;
   *  4. the salons whose pinned message was erased are told, and the cached feed pages are dropped,
   *     so a deleted post does not linger for a TTL.
   *
   * What each column gets, and why, is {@link ACCOUNT_ERASURE_COVERAGE}, asserted against the
   * schema. "Preserved" for an anonymised row means the ROW survives the account, not forever: a
   * handled content report is still deleted 90 days after a moderator answered it.
   */
  @Delete('users/:userId')
  async deleteUserData(
    @Param('userId') userId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    assertInternalSecret(headerSecret);
    const who = userId.slice(0, 8);
    this.logger.log(`[INTERNAL_DELETE] starting social data for user=${who}`);

    const workspaces = await this.channelService.removeAccountFromWorkspaces(userId);

    // The association posts stay; their media must be out of the class media's part deletes
    // BEFORE that part runs (core runs it after this one completes). A failure throws: retried.
    const keptMedia = await keptPostMediaIds(erasureDb(this.postRepo.manager), userId);
    await this.postMediaRetention.keepForAssociation(keptMedia);

    const result = await this.postRepo.manager.transaction((manager) =>
      eraseSocialRows(erasureDb(manager), userId)
    );

    for (const cashier of result.liveCashiersErased) {
      // Lydia still holds this person as a cashier of that Business; Canari no longer tracks it.
      this.logger.error(
        `[AUDIT] [LYDIA] account erasure of user=${who} deleted a LIVE cashier row: association ` +
          `${sanitizeLog(cashier.associationId)}, Business ${sanitizeLog(cashier.vendorToken)} - ` +
          `Lydia still lists that cashier`
      );
    }
    const pins = await this.channelService.announceErasedPins(result.pinsRemoved);
    const dropped = await invalidatePostListCache(this.redis);

    this.logger.log(
      `[INTERNAL_DELETE] done social data for user=${who} workspaces=${workspaces} ` +
        `associationMediaKept=${keptMedia.length} pinsAnnounced=${pins}/${result.pinsRemoved.length} ` +
        `postsScrubbed=${result.postsScrubbed} feedKeysDropped=${dropped} ` +
        `rows=${JSON.stringify(result.counts)}`
    );
    return { ok: true };
  }
}

/** The erasure's database port over a TypeORM manager, whose raw `query` answers a write `[rows, count]`. */
function erasureDb(manager: EntityManager): ErasureDb {
  return {
    write: async (sql, params) => ((await manager.query(sql, params)) as [unknown, number])[1],
    read: async <T>(sql: string, params: unknown[]) => (await manager.query(sql, params)) as T[],
  };
}
