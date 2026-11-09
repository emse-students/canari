import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { Association } from '../associations/entities/association.entity';
import { RedisService } from '../common/redis/redis.service';
import { invalidatePostListCache } from '../posts/post-list-cache';
import { AssociationAudience } from './association-audience.entity';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import {
  assertAudienceAllowedForType,
  assertBdeMayReadAudience,
  assertBdeMayWriteAudience,
  ruleInsideGovernedSpaces,
  type SpaceStanding,
} from './audience-policy';
import {
  BDE_SPACE_STANDINGS_SQL,
  ENTITY_GOVERNOR_SPACE_STANDINGS_SQL,
  HOLDS_BDE_FLAG_OVER_SQL,
} from './bde';
import {
  DEPENDENCY_CHILD_IS_A_BDE,
  DEPENDENCY_LABEL_INVALID,
  SPACE_GOVERNOR_TYPE,
  dependencyConflict,
  dependencyMismatches,
  dependencyRefusal,
  withDependencyRefusals,
} from './dependency-rules';
import type { DependencyMismatch } from './dependency-rules';
import { writeDependencyJournal } from './dependency-journal';
import type { AudienceRuleDto } from './dto/space.dto';

/**
 * The member rows of association `$1` held by users who hold flag `$3` (MANAGE_ASSO) in association
 * `$2` - its FORMER parent. Answers `userId`, `permissions`. Read once a parent changes
 * (`SpacesService.warnFormerParentSeats`), to name what the change did not revoke.
 */
export const FORMER_PARENT_SEATS_SQL = `SELECT seat."userId", seat.permissions
  FROM association_members seat
  WHERE seat."associationId" = $1
    AND EXISTS (SELECT 1 FROM association_members officer
      WHERE officer."associationId" = $2 AND officer."userId" = seat."userId"
        AND (officer.permissions & $3) <> 0)
  ORDER BY seat."userId"`;
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

/** One entity on the Dependencies panel: its governing parent, its G3 label, and what is off. */
export interface DependencyEntityView {
  id: string;
  name: string;
  slug: string;
  type: 'association' | 'list' | 'institution';
  archived: boolean;
  parentAssociationId: string | null;
  displayParentAssociationId: string | null;
  /** Governs at least one space: a BDE when of type `association` (2.2). */
  governs: boolean;
  mismatches: DependencyMismatch[];
}

/** Who made a dependency change: the platform admin's user id, journaled with it (2.7). */
export interface DependencyActor {
  userId: string;
}

/** A normalised audience rule: `null` is "any". */
export interface AudienceRule {
  formation: SpaceFormation | null;
  campus: SpaceCampus | null;
}

/**
 * A rule as its reader may act on it: `editable` is false for a BDE star when the rule exceeds the
 * spaces it governs ("Lire tout, modifier dans ses espaces", owner 2026-11-03) - the editor shows it
 * read-only and sends it back unchanged. Always true for the platform admin.
 */
export interface AudienceRuleView extends AudienceRule {
  editable: boolean;
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

  /**
   * Designates the GOVERNOR of a space, or clears it with `null` (D22; reform 2.3). The governor is
   * an association (a BDE) or, since WP-D1, an INSTITUTION (owner D3: a formation with no BDE placed
   * under the School answers for its agenda through the School's VALIDATE_EVENTS holders); a list is
   * never one. An association that HAS a governing parent cannot govern (2.2,
   * `DEPENDENCY_CHILD_IS_A_BDE`; migration 131 enforces it too).
   *
   * DECOUPLED FROM THE AUDIENCE (reform 2.5, "no silent change", closes P2): designating a governor no
   * longer adds an audience rule - the two panels show a mismatch instead. Each change writes a
   * `dependency_journal` line in its own transaction (2.7). Removing the last space of a BDE that has
   * children is allowed (a redesignation must stay possible) and logged at WARN: those children then
   * depend on an association that governs nothing, which the panel lists.
   */
  async setBde(
    spaceId: string,
    associationId: string | null,
    actor: DependencyActor
  ): Promise<void> {
    this.logger.debug(`[DEPENDENCY] governor of space ${spaceId} -> ${associationId ?? 'none'}`);
    const space = await this.spaces.findOne({ where: { id: spaceId } });
    if (!space) throw new NotFoundException('Space not found');
    if (associationId !== null) {
      const association = await this.associations.findOne({ where: { id: associationId } });
      if (!association) throw new NotFoundException('Association not found');
      if (association.type === 'list') {
        this.logger.warn(`[DEPENDENCY] governor refused: ${associationId} is a list`);
        throw new BadRequestException({
          code: SPACE_GOVERNOR_TYPE,
          message: 'A space is governed by an association or an institution, never a list',
        });
      }
      if (association.parentAssociationId !== null) {
        this.logger.warn(
          `[DEPENDENCY] governor refused: ${associationId} depends on ${association.parentAssociationId}`
        );
        throw dependencyConflict(
          DEPENDENCY_CHILD_IS_A_BDE,
          'An association that depends on a BDE cannot govern a space'
        );
      }
    }
    const previous = space.bdeAssociationId;
    if (previous === associationId) {
      this.logger.debug(`[DEPENDENCY] governor of ${spaceId} unchanged`);
      return;
    }
    await this.mappingTriggerRefusals(() =>
      this.dataSource.transaction(async (manager) => {
        await manager.update(Space, { id: spaceId }, { bdeAssociationId: associationId });
        await this.journal(manager, 'space', spaceId, previous, associationId, actor);
      })
    );
    this.logger.log(
      `[DEPENDENCY] governor of ${space.formation} x ${space.campus}: ${previous ?? 'none'} -> ${associationId ?? 'none'} by ${actor.userId.slice(0, 8)}`
    );
    if (previous !== null) await this.warnIfChildrenOrphaned(previous);
    await this.invalidateFeedCache();
  }

  /**
   * Sets the GOVERNING PARENT of an association or a list (reform 2.2, 2.7; platform admin only,
   * guarded by the controller), and optionally its G3 display label (`undefined` leaves the label as
   * it is). The rules are asked first (`dependencyRefusal`) so a refusal is a typed 409; a trigger
   * refusal from a racing write maps to the same code. A parent change writes a `dependency_journal`
   * line in the same transaction; an unchanged value writes nothing. A PRIVILEGE CHANGE since WP-D2:
   * the parent IS the governor (MANAGE_ASSO in its parent BDE, or itself when a BDE -
   * `holdsBdeFlagOverSql`), so the new parent's officers gain the super-admin tier, moderation and
   * deletion of the child, and the former parent's lose them - while member rows the former
   * parent's officers wrote for themselves stay, and are named at WARN (`warnFormerParentSeats`).
   */
  async setParent(
    associationId: string,
    parentId: string | null,
    actor: DependencyActor,
    displayParentId?: string | null
  ): Promise<void> {
    this.logger.debug(
      `[DEPENDENCY] parent of ${associationId} -> ${parentId ?? 'none'}${displayParentId === undefined ? '' : ` label=${displayParentId ?? 'none'}`}`
    );
    const child = await this.requireAssociation(associationId);
    // Unchanged first: an older client resending the parent it read, or a label-only edit, is not a
    // dependency write - judging it would refuse a row for a state it did not create (F4).
    const parentChanges = child.parentAssociationId !== parentId;
    const labelChanges =
      displayParentId !== undefined && child.displayParentAssociationId !== displayParentId;
    if (!parentChanges && !labelChanges) {
      this.logger.debug(`[DEPENDENCY] parent of ${associationId} unchanged`);
      return;
    }
    if (parentChanges) {
      const parent =
        parentId === null ? null : await this.associations.findOne({ where: { id: parentId } });
      if (parentId !== null && !parent) {
        throw new NotFoundException('Parent association not found');
      }
      const governing = await this.governingIds([child.id, ...(parent ? [parent.id] : [])]);
      const refusal = dependencyRefusal(
        { type: child.type, governs: governing.has(child.id) },
        parent ? { type: parent.type, governs: governing.has(parent.id) } : null
      );
      if (refusal !== null) {
        this.logger.warn(
          `[DEPENDENCY] parent of ${associationId} -> ${parentId} refused: ${refusal}`
        );
        throw dependencyConflict(refusal, 'This dependency is not allowed');
      }
    }
    if (labelChanges && displayParentId !== null && displayParentId !== undefined) {
      const label = await this.associations.findOne({ where: { id: displayParentId } });
      if (!label || label.type === 'institution' || label.id === child.id) {
        this.logger.warn(`[DEPENDENCY] label of ${associationId} -> ${displayParentId} refused`);
        throw new BadRequestException({
          code: DEPENDENCY_LABEL_INVALID,
          message: 'A label names another association or list',
        });
      }
    }
    await this.mappingTriggerRefusals(() =>
      this.dataSource.transaction(async (manager) => {
        await manager.update(
          Association,
          { id: associationId },
          {
            ...(parentChanges ? { parentAssociationId: parentId } : {}),
            ...(labelChanges ? { displayParentAssociationId: displayParentId } : {}),
          }
        );
        if (parentChanges) {
          await this.journal(
            manager,
            'entity',
            associationId,
            child.parentAssociationId,
            parentId,
            actor
          );
        }
        if (labelChanges) {
          await this.journal(
            manager,
            'label',
            associationId,
            child.displayParentAssociationId,
            displayParentId ?? null,
            actor
          );
        }
      })
    );
    this.logger.log(
      `[DEPENDENCY] ${associationId}: parent ${child.parentAssociationId ?? 'none'} -> ${parentId ?? 'none'}${labelChanges ? `, label -> ${displayParentId ?? 'none'}` : ''} by ${actor.userId.slice(0, 8)}`
    );
    if (parentChanges && child.parentAssociationId !== null) {
      await this.warnFormerParentSeats(associationId, child.parentAssociationId);
    }
  }

  /**
   * A parent change moves governance, but not the member rows the FORMER parent's officers may have
   * written for themselves in the child while they governed it (a super-admin seats itself
   * uncapped, `member-flag-ceiling.ts`). Revoking them is a decision, not a side effect of a
   * dependency write - so they are NAMED at WARN for the platform admin to review, never removed.
   * The same was true under the reach rule; WP-D2 makes the moment observable.
   */
  private async warnFormerParentSeats(childId: string, formerParentId: string): Promise<void> {
    const seats = (await this.dataSource.query(FORMER_PARENT_SEATS_SQL, [
      childId,
      formerParentId,
      AssociationPermissionFlag.MANAGE_ASSO,
    ])) as { userId: string; permissions: number }[];
    if (seats.length === 0) {
      this.logger.debug(`[DEPENDENCY] ${childId}: no member row of the former parent's officers`);
      return;
    }
    this.logger.warn(
      `[DEPENDENCY] ${childId} left parent ${formerParentId}: ${seats.length} member row(s) held by its MANAGE_ASSO holders stay - review them: ` +
        seats.map((s) => `${s.userId.slice(0, 8)}=${s.permissions}`).join(', ')
    );
  }

  /**
   * Every association, list and institution with its governing parent, its label and its
   * MISMATCHES, for the Dependencies panel (reform 2.1, 2.5). Mismatches are information, never a
   * refusal (`dependencyMismatches`).
   */
  async listDependencies(): Promise<DependencyEntityView[]> {
    const [entities, spaces, rules] = await Promise.all([
      this.associations.find({
        select: {
          id: true,
          name: true,
          slug: true,
          type: true,
          archived: true,
          parentAssociationId: true,
          displayParentAssociationId: true,
        },
        order: { name: 'ASC', id: 'ASC' },
      }),
      this.spaces.find(),
      this.audiences.find(),
    ]);
    const known = new Set(entities.map((e) => e.id));
    const governed = (id: string) => spaces.filter((space) => space.bdeAssociationId === id);
    const reached = (id: string) => {
      const own = rules.filter((r) => r.associationId === id);
      return spaces.filter((space) => own.some((r) => ruleReachesSpace(r, space)));
    };
    const views = entities.map((e) => ({
      id: e.id,
      name: e.name,
      slug: e.slug,
      type: e.type,
      archived: e.archived,
      parentAssociationId: e.parentAssociationId,
      displayParentAssociationId: e.displayParentAssociationId,
      governs: governed(e.id).length > 0,
      mismatches:
        e.parentAssociationId === null
          ? []
          : dependencyMismatches(
              known.has(e.parentAssociationId),
              governed(e.parentAssociationId).map((space) => space.id),
              reached(e.id).map((space) => space.id)
            ),
    }));
    this.logger.debug(
      `[DEPENDENCY] panel: ${views.length} entities, ${views.filter((v) => v.parentAssociationId).length} with a parent, ${views.filter((v) => v.mismatches.length > 0).length} mismatched`
    );
    return views;
  }

  /** The ids, among `ids`, that govern at least one space. */
  private async governingIds(ids: string[]): Promise<Set<string>> {
    const rows = await this.spaces.find({
      where: { bdeAssociationId: In(ids) },
      select: { bdeAssociationId: true },
    });
    return new Set(rows.map((r) => r.bdeAssociationId).filter((x): x is string => x !== null));
  }

  /** Appends one `dependency_journal` line (2.7), inside the caller's transaction. */
  private async journal(
    manager: EntityManager,
    kind: 'entity' | 'space' | 'label',
    subjectId: string,
    from: string | null,
    to: string | null,
    actor: DependencyActor
  ): Promise<void> {
    await writeDependencyJournal(manager, kind, subjectId, from, to, actor.userId, 'admin');
  }

  /**
   * Runs a dependency write and turns a refusal of migration 131's triggers - a write that raced
   * the service's own check - into the same typed 409, logged; any other error passes through.
   */
  private mappingTriggerRefusals<T>(write: () => Promise<T>): Promise<T> {
    return withDependencyRefusals(this.logger, 'a dependency write', write);
  }

  /** WARN when `formerGovernorId` governs no space any more while entities still depend on it. */
  private async warnIfChildrenOrphaned(formerGovernorId: string): Promise<void> {
    const stillGoverns = await this.spaces.count({ where: { bdeAssociationId: formerGovernorId } });
    if (stillGoverns > 0) return;
    const children = await this.associations.count({
      where: { parentAssociationId: formerGovernorId },
    });
    if (children > 0) {
      this.logger.warn(
        `[DEPENDENCY] ${formerGovernorId} governs no space any more and ${children} entities depend on it: shown as a mismatch until the platform admin redesignates`
      );
    }
  }

  /**
   * The audience rules of an association, for a global admin, a BDE star of its campus or its
   * parent, never on an institution ("Lire tout", owner 2026-11-03). Each rule says whether its
   * reader may change it: only the entity's PARENT may (WP-D2), and only inside the parent's spaces.
   */
  async getAudiencesFor(
    associationId: string,
    actor: { userId: string; isGlobalAdmin: boolean }
  ): Promise<AudienceRuleView[]> {
    const association = await this.requireAssociation(associationId);
    const current = await this.getAudiences(associationId);
    if (actor.isGlobalAdmin) return current.map((r) => ({ ...r, editable: true }));
    const { readerSpaces, governorSpaces, governs } = await this.starBounds(
      actor.userId,
      associationId
    );
    this.judged('read', associationId, () =>
      assertBdeMayReadAudience(association.type, readerSpaces, current, governs)
    );
    const view = current.map((r) => ({
      ...r,
      editable: governs && ruleInsideGovernedSpaces(r, governorSpaces),
    }));
    this.logger.debug(
      `[spaces] audiences of ${associationId} read by a BDE star (${governs ? 'its parent' : 'not its parent'}): ${view.filter((r) => !r.editable).length}/${view.length} rule(s) read-only`
    );
    return view;
  }

  /** The audience rules of an association. */
  async getAudiences(associationId: string): Promise<AudienceRule[]> {
    await this.requireAssociation(associationId);
    const rows = await this.audiences.find({ where: { associationId } });
    return rows.map((r) => ({ formation: r.formation, campus: r.campus }));
  }

  /**
   * Replaces the audience rules of an association, atomically. An empty set is allowed: the
   * association then reaches nobody. DECOUPLED FROM GOVERNANCE (reform 2.5, WP-D1): the spaces it
   * governs are no longer added back - what is submitted is what is stored, and a governor not
   * reaching its own space is a mismatch the panels show, never a silent write.
   *
   * THE POLICY RUNS HERE, ON EVERY WRITE (WP-A, user 2026-10-07): an `everyone` rule is refused on
   * anything but an institution (decision 6), and a caller who is not a global admin must be a BDE
   * star that governs the entity and adds or removes rules inside its own spaces only (decision 7,
   * owner 2026-11-03). Visibility is computed from the CURRENT rules at
   * read time, so a change applies to past posts too and nothing is frozen on a post (decision 4).
   *
   * It answers what it stored IN THE READ'S SHAPE (each rule with `editable` for this writer), so the
   * editor renders the write's own result and never needs a second read that could fail after the
   * write has landed.
   */
  async setAudiences(
    associationId: string,
    submitted: AudienceRuleDto[],
    actor: { userId: string; isGlobalAdmin: boolean }
  ): Promise<AudienceRuleView[]> {
    const association = await this.requireAssociation(associationId);
    const rules = normaliseRules(submitted);
    this.judged('write', associationId, () =>
      assertAudienceAllowedForType(association.type, rules)
    );
    let governedBy: SpaceStanding[] | null = null;
    if (!actor.isGlobalAdmin) {
      const current = await this.getAudiences(associationId);
      // Being its parent already is what stops a star taking an entity over by adding its own space.
      const { readerSpaces, governorSpaces, governs } = await this.starBounds(
        actor.userId,
        associationId
      );
      governedBy = governorSpaces;
      this.judged('write', associationId, () =>
        assertBdeMayWriteAudience(
          association.type,
          readerSpaces,
          governorSpaces,
          governs,
          current,
          rules
        )
      );
    }
    this.logger.log(
      `[spaces] audiences of ${associationId} by ${actor.userId.slice(0, 8)}${actor.isGlobalAdmin ? ' (admin)' : ' (BDE)'}: ${rules.length} rule(s)`
    );
    const stored = await this.dataSource.transaction(async (manager) => {
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
    const bound = governedBy;
    return stored.map((r) => ({
      ...r,
      editable: bound === null || ruleInsideGovernedSpaces(r, bound),
    }));
  }

  /**
   * Runs one audience policy check and, when it refuses, logs the refusal at WARN with its typed
   * code before it reaches the caller - the editor never offers a refused write, so one arriving is
   * an older client or a hand-made request, and a refusal with no server line is found by hand.
   */
  private judged(what: 'read' | 'write', associationId: string, check: () => void): void {
    try {
      check();
    } catch (e) {
      const response = (e as { getResponse?: () => unknown }).getResponse?.();
      const code =
        response && typeof response === 'object' && 'code' in response
          ? String((response as { code: unknown }).code)
          : 'untyped';
      this.logger.warn(`[AUDIENCE] ${what} refused: association=${associationId} code=${code}`);
      throw e;
    }
  }

  /**
   * The three facts a BDE star's audience powers over association `associationId` are judged on,
   * all at MANAGE_ASSO:
   * - `readerSpaces`: every opened space, governed when ANY BDE where `userId` holds the flag
   *   governs it - the READ bound ("Lire tout": its campus);
   * - `governs`: `userId` governs the entity - MANAGE_ASSO in its PARENT (`holdsBdeFlagOverSql`,
   *   WP-D2), never through reach;
   * - `governorSpaces`: every opened space, governed when the entity's own governing BDE governs it
   *   and `userId` holds the flag there - the WRITE bound (G8, D1), per space.
   */
  private async starBounds(
    userId: string,
    associationId: string
  ): Promise<{
    readerSpaces: SpaceStanding[];
    governorSpaces: SpaceStanding[];
    governs: boolean;
  }> {
    const flag = AssociationPermissionFlag.MANAGE_ASSO;
    const [readerSpaces, governorSpaces, holds] = await Promise.all([
      this.dataSource.query(BDE_SPACE_STANDINGS_SQL, [userId, flag]) as Promise<SpaceStanding[]>,
      this.dataSource.query(ENTITY_GOVERNOR_SPACE_STANDINGS_SQL, [
        associationId,
        userId,
        flag,
      ]) as Promise<SpaceStanding[]>,
      this.dataSource.query(HOLDS_BDE_FLAG_OVER_SQL, [userId, associationId, flag]) as Promise<
        { holds: boolean }[]
      >,
    ]);
    const governs = holds[0]?.holds === true;
    this.logger.debug(
      `[spaces] BDE star standing over ${associationId}: reads ${readerSpaces.filter((r) => r.governed).length}/${readerSpaces.length} spaces, ` +
        `${governs ? `parent, writes ${governorSpaces.filter((r) => r.governed).length}` : 'not its parent, writes none'}`
    );
    return { readerSpaces, governorSpaces, governs };
  }

  private async requireAssociation(id: string): Promise<Association> {
    const found = await this.associations.findOne({ where: { id } });
    if (!found) throw new NotFoundException('Association not found');
    return found;
  }
}
