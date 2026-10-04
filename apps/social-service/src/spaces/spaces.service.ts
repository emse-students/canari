import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Association } from '../associations/entities/association.entity';
import { AssociationAudience } from './association-audience.entity';
import type { AudienceRuleDto } from './dto/space.dto';
import { Space } from './space.entity';
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
    private readonly dataSource: DataSource
  ) {}

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
   * is not one); the same association may be the BDE of several spaces.
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
    await this.spaces.update({ id: spaceId }, { bdeAssociationId: associationId });
  }

  /** The audience rules of an association. */
  async getAudiences(associationId: string): Promise<AudienceRule[]> {
    await this.requireAssociation(associationId);
    const rows = await this.audiences.find({ where: { associationId } });
    return rows.map((r) => ({ formation: r.formation, campus: r.campus }));
  }

  /** Replaces the audience rules of an association, atomically. At least one rule is required. */
  async setAudiences(associationId: string, submitted: AudienceRuleDto[]): Promise<AudienceRule[]> {
    await this.requireAssociation(associationId);
    const rules = normaliseRules(submitted);
    if (rules.length === 0) throw new BadRequestException('At least one rule is required');
    this.logger.log(`[spaces] audiences of ${associationId}: ${rules.length} rule(s)`);
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(AssociationAudience, { associationId });
      await manager.insert(
        AssociationAudience,
        rules.map((r) => ({ associationId, formation: r.formation, campus: r.campus }))
      );
    });
    return rules;
  }

  private async requireAssociation(id: string): Promise<void> {
    const found = await this.associations.exists({ where: { id } });
    if (!found) throw new NotFoundException('Association not found');
  }
}
