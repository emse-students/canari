import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserTag } from './entities/user-tag.entity';

/** Data required to grant or renew a membership tag. */
export interface GrantTagData {
  userId: string;
  tagName: string;
  issuingAssocId?: string | null;
  grantedBy: string;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

/**
 * Service for managing user cotisation/membership tags.
 * The key operation is `grantOrRenew`: idempotent upsert on `(userId, tagName)` that
 * extends `expiresAt` when the tag already exists instead of creating a duplicate.
 */
@Injectable()
export class UserTagService {
  private readonly logger = new Logger(UserTagService.name);

  constructor(@InjectRepository(UserTag) private readonly repo: Repository<UserTag>) {}

  /**
   * Creates the tag or, if `(userId, tagName)` already exists, updates `expiresAt`
   * (and metadata) without changing `issuingAssocId` or `grantedBy`.
   */
  async grantOrRenew(data: GrantTagData): Promise<UserTag> {
    const existing = await this.repo.findOne({
      where: { userId: data.userId, tagName: data.tagName },
    });
    if (existing) {
      existing.expiresAt = data.expiresAt !== undefined ? data.expiresAt : existing.expiresAt;
      if (data.metadata) existing.metadata = { ...existing.metadata, ...data.metadata };
      const saved = await this.repo.save(existing);
      this.logger.log(`[UserTag] Renewed ${data.tagName} for ${data.userId} (expiresAt=${saved.expiresAt?.toISOString() ?? 'never'})`);
      return saved;
    }
    const tag = this.repo.create({
      userId: data.userId,
      tagName: data.tagName,
      issuingAssocId: data.issuingAssocId ?? null,
      grantedBy: data.grantedBy,
      expiresAt: data.expiresAt ?? null,
      metadata: data.metadata ?? {},
    });
    const saved = await this.repo.save(tag);
    this.logger.log(`[UserTag] Granted ${data.tagName} to ${data.userId} by ${data.grantedBy}`);
    return saved;
  }

  /** Revokes (deletes) a tag by its primary key. Throws 404 if not found. */
  async revoke(tagId: string): Promise<void> {
    const res = await this.repo.delete({ id: tagId });
    if (!res.affected) throw new NotFoundException('Tag not found');
    this.logger.log(`[UserTag] Revoked tag ${tagId}`);
  }

  /**
   * Returns all active tags issued by the given association (expiresAt null or in the future).
   * Used in the association admin panel ("Cotisants" tab).
   */
  async listByAssoc(assocId: string): Promise<UserTag[]> {
    return this.repo
      .createQueryBuilder('t')
      .where('t.issuingAssocId = :assocId', { assocId })
      .andWhere('(t.expiresAt IS NULL OR t.expiresAt > NOW())')
      .orderBy('t.createdAt', 'DESC')
      .getMany();
  }

  /**
   * Returns active tags for a given user, optionally filtered to tags issued by specific associations.
   * When `issuerAssocIds` is provided, only tags from those associations are returned.
   */
  async listByUser(userId: string, issuerAssocIds?: string[]): Promise<UserTag[]> {
    const qb = this.repo
      .createQueryBuilder('t')
      .where('t.userId = :userId', { userId })
      .andWhere('(t.expiresAt IS NULL OR t.expiresAt > NOW())');
    if (issuerAssocIds && issuerAssocIds.length > 0) {
      qb.andWhere('t.issuingAssocId IN (:...issuerAssocIds)', { issuerAssocIds });
    }
    return qb.orderBy('t.createdAt', 'DESC').getMany();
  }
}
