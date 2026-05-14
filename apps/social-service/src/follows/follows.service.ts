import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { AssociationFollow } from './entities/association-follow.entity';
import { UserFollow } from './entities/user-follow.entity';
import { Association } from '../associations/entities/association.entity';

/** Manages follows for both associations and users. */
@Injectable()
export class FollowsService {
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
  async unfollowAssociation(followerUserId: string, associationId: string): Promise<{ ok: boolean }> {
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
      select: ['associationId'],
    });
    return rows.map((r) => r.associationId);
  }

  /** Returns true if the user currently follows the given association. */
  async isFollowing(followerUserId: string, associationId: string): Promise<boolean> {
    const n = await this.followRepo.count({ where: { followerUserId, associationId } });
    return n > 0;
  }

  /** Returns lightweight summary rows (id, name, slug, logoUrl) for all associations the user follows. */
  async listFollowedAssociations(followerUserId: string): Promise<
    Pick<Association, 'id' | 'name' | 'slug' | 'logoUrl'>[]
  > {
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

  /** Follows a user. Idempotent — silently ignores duplicate follows. */
  async followUser(followerUserId: string, followedUserId: string): Promise<{ ok: boolean }> {
    const already = await this.userFollowRepo.findOne({ where: { followerUserId, followedUserId } });
    if (!already) {
      const row = this.userFollowRepo.create({ followerUserId, followedUserId });
      await this.userFollowRepo.save(row);
    }
    return { ok: true };
  }

  /** Unfollows a user. Throws NotFoundException if no such relationship exists. */
  async unfollowUser(followerUserId: string, followedUserId: string): Promise<{ ok: boolean }> {
    const res = await this.userFollowRepo.delete({ followerUserId, followedUserId });
    if (!res.affected) {
      throw new NotFoundException('Follow relationship not found');
    }
    return { ok: true };
  }

  /** Returns true if the viewer follows the given user. */
  async isFollowingUser(followerUserId: string, followedUserId: string): Promise<boolean> {
    const n = await this.userFollowRepo.count({ where: { followerUserId, followedUserId } });
    return n > 0;
  }

  /** Returns the IDs of all users followed by the given user. Used by PostsService to build the "followed" feed. */
  async getFollowedUserIdsForUser(followerUserId: string): Promise<string[]> {
    const rows = await this.userFollowRepo.find({
      where: { followerUserId },
      select: ['followedUserId'],
    });
    return rows.map((r) => r.followedUserId);
  }
}
