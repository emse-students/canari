import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
}

/** Role history row enriched with association display fields. */
export interface UserRoleHistoryRow {
  id: string;
  userId: string;
  associationId: string;
  associationName: string;
  associationSlug: string;
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

  /** Updates a role history entry owned by the user. */
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
    if (dto.roleTitle !== undefined) entry.roleTitle = dto.roleTitle.trim();
    if (dto.associationId !== undefined) entry.associationId = dto.associationId;
    if (dto.startYear !== undefined) entry.startYear = dto.startYear;
    if (dto.endYear !== undefined) entry.endYear = dto.endYear;
    if (dto.sortOrder !== undefined) entry.sortOrder = dto.sortOrder;

    await this.roleHistoryRepo.save(entry);
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
      select: ['userId'],
    });
    return rows.map((r) => r.userId);
  }

  private async assertAssociationExists(associationId: string): Promise<void> {
    const exists = await this.assoRepo.exist({ where: { id: associationId } });
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
