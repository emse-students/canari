import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Association } from '../associations/entities/association.entity';
import { RedisService } from '../common/redis/redis.service';
import { invalidatePostListCache } from '../posts/post-list-cache';
import { AssociationAudience } from './association-audience.entity';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import {
  assertAudienceAllowedForType,
  assertBdeMayReadAudience,
  assertBdeMayWriteAudience,
} from './audience-policy';
import { BDE_GOVERNED_CAMPUSES_SQL } from './bde';
import type { AudienceRuleDto } from './dto/space.dto';
import { Space, SPACE_CAMPUSES, SPACE_FORMATIONS } from './space.entity';
import type { SpaceCampus, SpaceFormation } from './space.entity';

/** A space as the admin page shows it. */
export interface SpaceView {
  id: string;
  formation: SpaceFormation;
  campus: SpaceCampus;
  openedAt: Date;
  bde: { id: string; name: string } | null;
}

/** One audience rule of one association, as the admin grid reads them all at once. */
export interface AssociationRule extends AudienceRule {
  associationId: string;
}

/** A normalised audience rule: `null` is "any". */
export interface AudienceRule {
  formation: SpaceFormation | null;
  campus: SpaceCampus | null;
}

/** Whether a rule reaches a space: each side matches when it is "any" or equal. */
export function ruleReachesSpace(
  rule: AudienceRule,
  space: Pick<Space, 'formation' | 'campus'>
): boolean {
  return (
    (rule.formation === null || rule.formation === space.formation) &&
    (rule.campus === null || rule.campus === space.campus)
  );
}

/**
 * Normalises submitted rules: absent becomes `null`, duplicates collapse (the table's unique index
 * would otherwise refuse the whole batch for a harmless repeat).
 */
export function normaliseRules(rules: AudienceRuleDto[]): AudienceRule[] {
  const seen = new Map<string, AudienceRule>();
  for (const r of rules) {
    const rule: AudienceRule = { formation: r.formation ?? null, campus: r.campus ?? null };
    seen.set(`${rule.formation ?? '*'}|${rule.campus ?? '*'}`, rule);
  }
  return [...seen.values()];
}

/**
 * The SMALLEST rule set reaching exactly `pairs`: everyone when every pair is in, a campus rule
 * when a whole campus is in, a pair rule otherwise - the server twin of the admin grid's `toRules`
 * (`frontend/src/lib/associations/audienceRules.ts`), so a default written here reads back in the
 * grid exactly as if an admin had ticked it. Every pair of D4 x D6 exists (D17 relaxed), so the
 * constants are the universe. Pairs outside it are ignored.
 */
export function smallestRules(
  pairs: readonly Pick<Space, 'formation' | 'campus'>[]
): AudienceRule[] {
  const has = (formation: SpaceFormation, campus: SpaceCampus) =>
    pairs.some((p) => p.formation === formation && p.campus === campus);
  const wholeCampus = (campus: SpaceCampus) => SPACE_FORMATIONS.every((f) => has(f, campus));
  if (SPACE_CAMPUSES.every(wholeCampus)) return [{ formation: null, campus: null }];
  const rules: AudienceRule[] = [];
  for (const campus of SPACE_CAMPUSES) {
    if (wholeCampus(campus)) {
      rules.push({ formation: null, campus });
      continue;
    }
    for (const formation of SPACE_FORMATIONS) {
      if (has(formation, campus)) rules.push({ formation, campus });
    }
  }
  return normaliseRules(rules);
}

/**
 * Spaces (WP6d, docs/wiki/profiles-and-access.md): designating the BDE of each pair (D22) and
 * editing who an association addresses (D19). Every pair exists from the migration on - none is
 * opened or closed. Global-admin operations, guarded by the controller.
 */
@Injectable()
export class SpacesService {
  private readonly logger = new Logger(SpacesService.name);

  constructor(
    @InjectRepository(Space) private readonly spaces: Repository<Space>,
    @InjectRepository(Association) private readonly associations: Repository<Association>,
    @InjectRepository(AssociationAudience)
    private readonly audiences: Repository<AssociationAudience>,
    private readonly dataSource: DataSource,
    private readonly redis: RedisService
  ) {}

  /**
   * Drops every cached feed page: who an association reaches decides which posts each reader gets
   * (WP6b), and the list cache is keyed per reader, so a rule change is a change to every page.
   */
  private async invalidateFeedCache(): Promise<void> {
    try {
      const dropped = await invalidatePostListCache(this.redis);
      this.logger.debug(`[spaces] feed cache dropped: ${dropped} key(s)`);
    } catch (e: unknown) {
      this.logger.warn('[spaces] feed cache sweep failed - pages stay stale until their TTL', e);
    }
  }

  /** Lists every space with its BDE. */
  async list(): Promise<SpaceView[]> {
    const spaces = await this.spaces.find({ order: { campus: 'ASC', formation: 'ASC' } });
    const bdeIds = [...new Set(spaces.map((s) => s.bdeAssociationId))].filter(
      (id): id is string => !!id
    );
    const bdes = bdeIds.length
      ? await this.associations.find({
          where: { id: In(bdeIds) },
          select: { id: true, name: true },
        })
      : [];
    return spaces.map((space) => {
      const bde = bdes.find((a) => a.id === space.bdeAssociationId);
      return {
        id: space.id,
        formation: space.formation,
        campus: space.campus,
        openedAt: space.openedAt,
        bde: bde ? { id: bde.id, name: bde.name } : null,
      };
    });
  }

  /** The audience rules of EVERY association, in one read: the grid needs them all to draw itself. */
  async listAudiences(): Promise<AssociationRule[]> {
    const rows = await this.audiences.find();
    return rows.map((r) => ({
      associationId: r.associationId,
      formation: r.formation,
      campus: r.campus,
    }));
  }

  /**
   * Designates the BDE of a space, or clears it with `null`. The BDE must be an association (a list
   * is not one); the same association may be the BDE of several spaces. A BDE always reaches the
   * space it governs (user, 2026-10-04), so designating one adds the rule for that pair when its
   * rules do not already cover it - in the SAME transaction, so the two never disagree.
   */
  async setBde(spaceId: string, associationId: string | null): Promise<void> {
    const space = await this.spaces.findOne({ where: { id: spaceId } });
    if (!space) throw new NotFoundException('Space not found');
    if (associationId !== null) {
      const association = await this.associations.findOne({ where: { id: associationId } });
      if (!association) throw new NotFoundException('Association not found');
      if (association.type !== 'association') {
        throw new BadRequestException('Only an association can be the BDE of a space');
      }
    }
    this.logger.log(`[spaces] BDE of ${spaceId} -> ${associationId ?? 'none'}`);
    await this.dataSource.transaction(async (manager) => {
      await manager.update(Space, { id: spaceId }, { bdeAssociationId: associationId });
      if (associationId === null) return;
      const rules = await manager.find(AssociationAudience, { where: { associationId } });
      if (!rules.some((r) => ruleReachesSpace(r, space))) {
        this.logger.log(
          `[spaces] ${associationId} now reaches ${space.formation} x ${space.campus}`
        );
        await manager.insert(AssociationAudience, {
          associationId,
          formation: space.formation,
          campus: space.campus,
        });
      }
    });
    await this.invalidateFeedCache();
  }

  /**
   * The audience rules of an association, for a global admin or - bounded to the campuses it
   * governs, never an institution - a BDE star (user, 2026-10-08).
   */
  async getAudiencesFor(
    associationId: string,
    actor: { userId: string; isGlobalAdmin: boolean }
  ): Promise<AudienceRule[]> {
    const association = await this.requireAssociation(associationId);
    const current = await this.getAudiences(associationId);
    if (!actor.isGlobalAdmin) {
      const governed = await this.bdeGovernedCampuses(actor.userId);
      assertBdeMayReadAudience(association.type, governed, current);
    }
    return current;
  }

  /** The audience rules of an association. */
  async getAudiences(associationId: string): Promise<AudienceRule[]> {
    await this.requireAssociation(associationId);
    const rows = await this.audiences.find({ where: { associationId } });
    return rows.map((r) => ({ formation: r.formation, campus: r.campus }));
  }

  /**
   * Replaces the audience rules of an association, atomically. An empty set is allowed: the
   * association then reaches nobody. The one thing that cannot be taken away is a pair it governs
   * as BDE - those are added back, so "a BDE reaches its space" holds whatever is submitted.
   *
   * THE POLICY RUNS HERE, ON EVERY WRITE (WP-A, user 2026-10-07): an `everyone` rule is refused on
   * anything but an institution (decision 6), and a caller who is not a global admin must be a BDE
   * star writing inside its own campus (decision 7). Visibility is computed from the CURRENT rules at
   * read time, so a change applies to past posts too and nothing is frozen on a post (decision 4).
   */
  async setAudiences(
    associationId: string,
    submitted: AudienceRuleDto[],
    actor: { userId: string; isGlobalAdmin: boolean }
  ): Promise<AudienceRule[]> {
    const association = await this.requireAssociation(associationId);
    const rules = normaliseRules(submitted);
    assertAudienceAllowedForType(association.type, rules);
    if (!actor.isGlobalAdmin) {
      const governed = await this.bdeGovernedCampuses(actor.userId);
      const current = await this.getAudiences(associationId);
      assertBdeMayWriteAudience(association.type, governed, current, rules);
    }
    this.logger.log(
      `[spaces] audiences of ${associationId} by ${actor.userId.slice(0, 8)}${actor.isGlobalAdmin ? ' (admin)' : ' (BDE)'}: ${rules.length} rule(s)`
    );
    const stored = await this.dataSource.transaction(async (manager) => {
      const governed = await manager.find(Space, { where: { bdeAssociationId: associationId } });
      for (const space of governed) {
        if (!rules.some((r) => ruleReachesSpace(r, space))) {
          rules.push({ formation: space.formation, campus: space.campus });
        }
      }
      await manager.delete(AssociationAudience, { associationId });
      if (rules.length > 0) {
        await manager.insert(
          AssociationAudience,
          rules.map((r) => ({ associationId, formation: r.formation, campus: r.campus }))
        );
      }
      return rules;
    });
    await this.invalidateFeedCache();
    return stored;
  }

  /** The campuses whose BDE `userId` holds MANAGE_ASSO in: the borders of a BDE star's powers. */
  private async bdeGovernedCampuses(userId: string): Promise<string[]> {
    const rows: { campus: string }[] = await this.dataSource.query(BDE_GOVERNED_CAMPUSES_SQL, [
      userId,
      AssociationPermissionFlag.MANAGE_ASSO,
    ]);
    return rows.map((r) => r.campus);
  }

  private async requireAssociation(id: string): Promise<Association> {
    const found = await this.associations.findOne({ where: { id } });
    if (!found) throw new NotFoundException('Association not found');
    return found;
  }
}
