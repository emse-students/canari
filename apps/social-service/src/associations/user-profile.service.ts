import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AssociationMember } from './entities/association-member.entity';
import { Association } from './entities/association.entity';
import { AssociationRoleHistory } from './entities/association-role-history.entity';
import { CreateRoleHistoryDto, UpdateRoleHistoryDto } from './dto/user-profile.dto';

/** Public membership row for profile pages. */
export interface UserMembershipRow {
  associationId: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  role: string;
  isAdmin: boolean;
  /** 'association' or 'list' - lets the client hide finished campaign lists. */
  type: 'association' | 'list' | 'institution';
  /** Lists only: campaign year; null for associations. */
  promo: number | null;
}

/** Role history row enriched with association display fields. */
export interface UserRoleHistoryRow {
  id: string;
  userId: string;
  associationId: string;
  associationName: string;
  associationSlug: string;
  associationLogoUrl: string | null;
  roleTitle: string;
  startYear: number | null;
  endYear: number | null;
  sortOrder: number;
  createdAt: string;
}

/** Loads association memberships and past roles for user profile pages. */
@Injectable()
export class UserProfileService {
  private readonly logger = new Logger(UserProfileService.name);

  constructor(
    @InjectRepository(AssociationMember)
    private readonly memberRepo: Repository<AssociationMember>,
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>,
    @InjectRepository(AssociationRoleHistory)
    private readonly roleHistoryRepo: Repository<AssociationRoleHistory>
  ) {}

  /** Returns current association memberships for a user (public). */
  async listMemberships(userId: string): Promise<UserMembershipRow[]> {
    const memberships = await this.memberRepo.find({
      where: { userId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    if (memberships.length === 0) return [];

    const assoIds = memberships.map((m) => m.associationId);
    const associations = await this.assoRepo
      .createQueryBuilder('a')
      .where('a.id IN (:...ids)', { ids: assoIds })
      .getMany();
    const assoById = new Map(associations.map((a) => [a.id, a]));

    return memberships
      .map((m) => {
        const a = assoById.get(m.associationId);
        if (!a) return null;
        return {
          associationId: a.id,
          name: a.name,
          slug: a.slug,
          logoUrl: a.logoUrl ?? null,
          role: m.role,
          isAdmin: (m.permissions ?? 0) > 0,
          type: a.type,
          promo: a.promo ?? null,
        };
      })
      .filter((row): row is UserMembershipRow => row != null);
  }

  /** Returns role history entries for a user, newest periods first. */
  async listRoleHistory(userId: string): Promise<UserRoleHistoryRow[]> {
    const rows = await this.roleHistoryRepo.find({
      where: { userId },
      order: { sortOrder: 'ASC', startYear: 'DESC', createdAt: 'DESC' },
    });
    if (rows.length === 0) return [];

    const assoIds = [...new Set(rows.map((r) => r.associationId))];
    const associations = await this.assoRepo
      .createQueryBuilder('a')
      .where('a.id IN (:...ids)', { ids: assoIds })
      .getMany();
    const assoById = new Map(associations.map((a) => [a.id, a]));

    return rows.map((r) => {
      const a = assoById.get(r.associationId);
      return {
        id: r.id,
        userId: r.userId,
        associationId: r.associationId,
        associationName: a?.name ?? 'Association',
        associationSlug: a?.slug ?? '',
        associationLogoUrl: a?.logoUrl ?? null,
        roleTitle: r.roleTitle,
        startYear: r.startYear,
        endYear: r.endYear,
        sortOrder: r.sortOrder,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  /** Creates a role history entry for the authenticated user. */
  async createRoleHistory(userId: string, dto: CreateRoleHistoryDto): Promise<UserRoleHistoryRow> {
    this.assertYearRange(dto.startYear, dto.endYear);
    await this.assertAssociationExists(dto.associationId);

    const saved = await this.roleHistoryRepo.save(
      this.roleHistoryRepo.create({
        userId,
        associationId: dto.associationId,
        roleTitle: dto.roleTitle.trim(),
        startYear: dto.startYear ?? null,
        endYear: dto.endYear ?? null,
        sortOrder: dto.sortOrder ?? 0,
      })
    );
    this.logger.log(
      `[UserProfile] role history created user=${userId.slice(0, 8)} asso=${dto.associationId.slice(0, 8)}`
    );
    const match = (await this.listRoleHistory(userId)).find((r) => r.id === saved.id);
    if (!match) throw new NotFoundException('Role history entry not found after create');
    return match;
  }

  /**
   * Updates a role history entry owned by the user.
   *
   * The columns the edit names, as ONE `UPDATE` keyed by the entry AND its owner AND, when the edit
   * sets one year only, the other year as the range check read it - never a save of the entry read:
   * a save writes back every column another edit changed since the read, and re-inserts an entry
   * deleted since. 0 rows: the entry is gone or no longer the caller's (404), or another edit moved
   * the judged year first (409, so a range checked against a stale year is never written).
   */
  async updateRoleHistory(
    userId: string,
    entryId: string,
    dto: UpdateRoleHistoryDto
  ): Promise<UserRoleHistoryRow> {
    const entry = await this.roleHistoryRepo.findOne({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('Role history entry not found');
    if (entry.userId !== userId) throw new ForbiddenException();

    const startYear = dto.startYear !== undefined ? dto.startYear : entry.startYear;
    const endYear = dto.endYear !== undefined ? dto.endYear : entry.endYear;
    this.assertYearRange(startYear, endYear);

    if (dto.associationId) await this.assertAssociationExists(dto.associationId);
    const changes: QueryDeepPartialEntity<AssociationRoleHistory> = {};
    if (dto.roleTitle !== undefined) changes.roleTitle = dto.roleTitle.trim();
    if (dto.associationId !== undefined) changes.associationId = dto.associationId;
    if (dto.startYear !== undefined) changes.startYear = dto.startYear;
    if (dto.endYear !== undefined) changes.endYear = dto.endYear;
    if (dto.sortOrder !== undefined) changes.sortOrder = dto.sortOrder;

    if (Object.keys(changes).length > 0) {
      // A stored year bounds the write only when the range check JUDGED it: the request sets the
      // other year and leaves this one as read. A title-only edit judged nothing, and an edit setting
      // both years replaces both, so neither can be broken by a year moved meanwhile.
      const where: FindOptionsWhere<AssociationRoleHistory> = { id: entryId, userId };
      if (dto.startYear === undefined && dto.endYear !== undefined) {
        where.startYear = entry.startYear ?? IsNull();
      }
      if (dto.endYear === undefined && dto.startYear !== undefined) {
        where.endYear = entry.endYear ?? IsNull();
      }
      const updated = await this.roleHistoryRepo.update(where, changes);
      if (updated.affected !== 1) {
        const now = await this.roleHistoryRepo.findOne({ where: { id: entryId } });
        if (!now || now.userId !== userId) {
          this.logger.warn(
            `[UserProfile] role history update refused: id=${entryId.slice(0, 8)} gone since its read`
          );
          throw new NotFoundException('Role history entry not found');
        }
        this.logger.warn(
          `[UserProfile] role history update refused: id=${entryId.slice(0, 8)} judged year changed since its read`
        );
        throw new ConflictException('Role history entry changed meanwhile - reload and retry');
      }
      this.logger.log(
        `[UserProfile] role history updated id=${entryId.slice(0, 8)} fields=${Object.keys(changes).join(',')}`
      );
    }
    const match = (await this.listRoleHistory(userId)).find((r) => r.id === entryId);
    if (!match) throw new NotFoundException('Role history entry not found after update');
    return match;
  }

  /** Deletes a role history entry owned by the user. */
  async deleteRoleHistory(userId: string, entryId: string): Promise<void> {
    const entry = await this.roleHistoryRepo.findOne({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('Role history entry not found');
    if (entry.userId !== userId) throw new ForbiddenException();
    await this.roleHistoryRepo.remove(entry);
    this.logger.log(`[UserProfile] role history deleted id=${entryId.slice(0, 8)}`);
  }

  /** Returns user IDs of all members of an association (internal directory filter). */
  async listMemberUserIds(associationId: string): Promise<string[]> {
    const rows = await this.memberRepo.find({
      where: { associationId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  private async assertAssociationExists(associationId: string): Promise<void> {
    const exists = await this.assoRepo.exists({ where: { id: associationId } });
    if (!exists) throw new NotFoundException('Association not found');
  }

  private assertYearRange(
    startYear: number | null | undefined,
    endYear: number | null | undefined
  ): void {
    if (startYear != null && endYear != null && startYear > endYear) {
      throw new BadRequestException('startYear must be ≤ endYear');
    }
  }
}
