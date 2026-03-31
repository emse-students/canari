import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Association } from './entities/association.entity';
import { AssociationMember, type AssociationRole } from './entities/association-member.entity';
import { CreateAssociationDto, UpdateAssociationDto } from './dto/association.dto';
import { ROLE_HIERARCHY } from './guards/association-role.guard';

@Injectable()
export class AssociationsService {
  constructor(
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>,
    @InjectRepository(AssociationMember)
    private readonly memberRepo: Repository<AssociationMember>
  ) {}

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(dto: CreateAssociationDto, userId: string) {
    const existing = await this.assoRepo.findOne({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new BadRequestException('An association with this slug already exists');
    }

    const asso = this.assoRepo.create({ ...dto, createdBy: userId });
    const saved = await this.assoRepo.save(asso);

    // Creator becomes owner
    const membership = this.memberRepo.create({
      associationId: saved.id,
      userId,
      role: 'owner',
    });
    await this.memberRepo.save(membership);

    return saved;
  }

  async list() {
    const associations = await this.assoRepo.find({
      order: { name: 'ASC' },
    });

    // Attach member count
    const counts = await this.memberRepo
      .createQueryBuilder('m')
      .select('m.associationId', 'associationId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('m.associationId')
      .getRawMany();

    const countMap = new Map(counts.map((c) => [c.associationId, parseInt(c.count, 10)]));

    return associations.map((a) => ({
      ...a,
      memberCount: countMap.get(a.id) ?? 0,
    }));
  }

  async findById(id: string) {
    const asso = await this.assoRepo.findOne({ where: { id } });
    if (!asso) throw new NotFoundException('Association not found');
    const memberCount = await this.memberRepo.count({
      where: { associationId: id },
    });
    return { ...asso, memberCount };
  }

  async findBySlug(slug: string) {
    const asso = await this.assoRepo.findOne({ where: { slug } });
    if (!asso) throw new NotFoundException('Association not found');
    const memberCount = await this.memberRepo.count({
      where: { associationId: asso.id },
    });
    return { ...asso, memberCount };
  }

  async update(id: string, dto: UpdateAssociationDto) {
    const asso = await this.findById(id);
    Object.assign(asso, dto);
    return this.assoRepo.save(asso);
  }

  async remove(id: string) {
    await this.memberRepo.delete({ associationId: id });
    await this.assoRepo.delete(id);
    return { ok: true };
  }

  // ── Members ───────────────────────────────────────────────────────────────

  async listMembers(associationId: string) {
    return this.memberRepo.find({
      where: { associationId },
      order: { createdAt: 'ASC' },
    });
  }

  async addMember(associationId: string, userId: string, role: AssociationRole = 'member') {
    // Ensure association exists
    await this.findById(associationId);

    const existing = await this.memberRepo.findOne({
      where: { associationId, userId },
    });
    if (existing) {
      throw new BadRequestException('User is already a member');
    }

    const membership = this.memberRepo.create({
      associationId,
      userId,
      role,
    });
    return this.memberRepo.save(membership);
  }

  async updateMemberRole(associationId: string, targetUserId: string, newRole: AssociationRole) {
    const membership = await this.memberRepo.findOne({
      where: { associationId, userId: targetUserId },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    membership.role = newRole;
    return this.memberRepo.save(membership);
  }

  async removeMember(associationId: string, targetUserId: string, _callerUserId: string) {
    const membership = await this.memberRepo.findOne({
      where: { associationId, userId: targetUserId },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }

    await this.memberRepo.delete(membership.id);
    return { ok: true };
  }

  async listByUser(userId: string) {
    const memberships = await this.memberRepo.find({
      where: { userId },
    });
    if (memberships.length === 0) return [];

    const assoIds = memberships.map((m) => m.associationId);
    const associations = await this.assoRepo
      .createQueryBuilder('a')
      .where('a.id IN (:...ids)', { ids: assoIds })
      .getMany();

    return associations.map((a) => ({
      ...a,
      role: memberships.find((m) => m.associationId === a.id)?.role,
    }));
  }

  // ── Stripe helpers ────────────────────────────────────────────────────────

  async setStripeAccountId(id: string, stripeAccountId: string) {
    const asso = await this.findById(id);
    await this.assoRepo.update(id, { stripeAccountId });
    return { ...asso, stripeAccountId };
  }

  async markStripeOnboardingComplete(id: string) {
    await this.assoRepo.update(id, { stripeOnboardingComplete: true });
  }

  async getStripeAccountId(id: string): Promise<string | null> {
    const asso = await this.assoRepo.findOne({ where: { id } });
    return asso?.stripeAccountId ?? null;
  }

  // ── Post authorship check ─────────────────────────────────────────────────

  async canPostAs(userId: string, associationId: string): Promise<boolean> {
    const membership = await this.memberRepo.findOne({
      where: { associationId, userId },
    });
    if (!membership) return false;
    return ROLE_HIERARCHY[membership.role] >= ROLE_HIERARCHY['admin'];
  }
}
