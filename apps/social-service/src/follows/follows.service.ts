import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { AssociationFollow } from './entities/association-follow.entity';
import { Association } from '../associations/entities/association.entity';

/** Manages association follows: follow, unfollow, and listing for the "followed" post feed. */
@Injectable()
export class FollowsService {
  constructor(
    @InjectRepository(AssociationFollow)
    private readonly followRepo: Repository<AssociationFollow>,
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>
  ) {}

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
}
