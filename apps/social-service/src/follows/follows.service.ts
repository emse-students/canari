import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { AssociationFollow } from './entities/association-follow.entity';
import { UserFollow } from './entities/user-follow.entity';
import { Association } from '../associations/entities/association.entity';
import { FOLLOW_ACCEPTED, FOLLOW_PENDING, type FollowStatus } from './follow-status';

/** How a follows log line names an account: its first 8 characters, never a whole account id. */
const short = (id: string): string => id.slice(0, 8);

/** Manages follows for both associations and users. */
@Injectable()
export class FollowsService {
  private readonly logger = new Logger(FollowsService.name);

  constructor(
    @InjectRepository(AssociationFollow)
    private readonly followRepo: Repository<AssociationFollow>,
    @InjectRepository(UserFollow)
    private readonly userFollowRepo: Repository<UserFollow>,
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>
  ) {}

  // ── Association follows ───────────────────────────────────────────────────

  /** Follows an association. Silently ignores duplicate follows (idempotent). Throws if the association does not exist. */
  async followAssociation(followerUserId: string, associationId: string): Promise<{ ok: boolean }> {
    const exists = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!exists) {
      throw new NotFoundException('Association not found');
    }
    const already = await this.followRepo.findOne({ where: { followerUserId, associationId } });
    if (!already) {
      const row = this.followRepo.create({ followerUserId, associationId });
      await this.followRepo.save(row);
    }
    return { ok: true };
  }

  /** Removes a follow relationship. Throws NotFoundException if no such relationship exists. */
  async unfollowAssociation(
    followerUserId: string,
    associationId: string
  ): Promise<{ ok: boolean }> {
    const res = await this.followRepo.delete({ followerUserId, associationId });
    if (!res.affected) {
      throw new NotFoundException('Follow relationship not found');
    }
    return { ok: true };
  }

  /** Returns the IDs of all associations followed by the user. Used by PostsService to build the "followed" feed. */
  async getFollowedAssociationIdsForUser(followerUserId: string): Promise<string[]> {
    const rows = await this.followRepo.find({
      where: { followerUserId },
      select: { associationId: true },
    });
    return rows.map((r) => r.associationId);
  }

  /** Returns true if the user currently follows the given association. */
  async isFollowing(followerUserId: string, associationId: string): Promise<boolean> {
    const n = await this.followRepo.count({ where: { followerUserId, associationId } });
    return n > 0;
  }

  /** Returns lightweight summary rows (id, name, slug, logoUrl) for all associations the user follows. */
  async listFollowedAssociations(
    followerUserId: string
  ): Promise<Pick<Association, 'id' | 'name' | 'slug' | 'logoUrl'>[]> {
    const ids = await this.getFollowedAssociationIdsForUser(followerUserId);
    if (ids.length === 0) return [];
    const assos = await this.assoRepo.findBy({ id: In(ids) });
    return assos.map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      logoUrl: a.logoUrl,
    }));
  }

  // ── User follows ──────────────────────────────────────────────────────────
  //
  // Every personal account is private (user, 2026-10-25, Q1): a follow of a PERSON is a request
  // (`pending`) until that person accepts it. Only an `accepted` row is a follow - the Suivis feed,
  // the announce sweep and the live push count nothing else (WP-F1).

  /**
   * Asks to follow a user: writes a `pending` request, which the followed person answers.
   * Idempotent - a second ask writes nothing and answers the status the row already has, so asking
   * again never turns an accepted follow back into a request.
   */
  async followUser(
    followerUserId: string,
    followedUserId: string
  ): Promise<{ ok: boolean; status: FollowStatus }> {
    this.logger.debug(`[FOLLOW] ${short(followerUserId)} asks to follow ${short(followedUserId)}`);
    const already = await this.userFollowRepo.findOne({
      where: { followerUserId, followedUserId },
    });
    if (already) {
      this.logger.debug(`[FOLLOW] ${short(followerUserId)} already ${already.status}: unchanged`);
      return { ok: true, status: already.status };
    }
    const row = this.userFollowRepo.create({
      followerUserId,
      followedUserId,
      status: FOLLOW_PENDING,
    });
    await this.userFollowRepo.save(row);
    this.logger.log(
      `[FOLLOW] ${short(followerUserId)} -> ${short(followedUserId)}: request recorded, pending`
    );
    return { ok: true, status: FOLLOW_PENDING };
  }

  /**
   * Unfollows a user, or withdraws a request not answered yet: the row goes whatever its status.
   * Throws NotFoundException if there is neither.
   */
  async unfollowUser(followerUserId: string, followedUserId: string): Promise<{ ok: boolean }> {
    const res = await this.userFollowRepo.delete({ followerUserId, followedUserId });
    if (!res.affected) {
      this.logger.debug(
        `[FOLLOW] ${short(followerUserId)} unfollow of ${short(followedUserId)}: no row`
      );
      throw new NotFoundException('Follow relationship not found');
    }
    this.logger.debug(`[FOLLOW] ${short(followerUserId)} left ${short(followedUserId)}`);
    return { ok: true };
  }

  /**
   * Where the viewer stands with the given user: `accepted` (a follow), `pending` (a request not
   * answered yet) or `null` (neither).
   */
  async userFollowStatus(
    followerUserId: string,
    followedUserId: string
  ): Promise<FollowStatus | null> {
    const row = await this.userFollowRepo.findOne({
      where: { followerUserId, followedUserId },
    });
    return row?.status ?? null;
  }

  /**
   * Returns the IDs of the users the given user FOLLOWS - accepted rows only, a pending request is
   * not a follow. Used by PostsService to build the "followed" feed.
   */
  async getFollowedUserIdsForUser(followerUserId: string): Promise<string[]> {
    const rows = await this.userFollowRepo.find({
      where: { followerUserId, status: FOLLOW_ACCEPTED },
      select: { followedUserId: true },
    });
    return rows.map((r) => r.followedUserId);
  }
}
