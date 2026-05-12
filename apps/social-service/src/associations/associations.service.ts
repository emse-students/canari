import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import FormData from 'form-data';
import { AxiosError } from 'axios';
import { Association } from './entities/association.entity';
import { AssociationMember, AssociationPermission } from './entities/association-member.entity';
import { CreateAssociationDto, UpdateAssociationDto } from './dto/association.dto';
import { RedisService } from '../common/redis/redis.service';

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_LOGO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** CRUD, logo management, membership, and Stripe helpers for student associations. */
@Injectable()
export class AssociationsService {
  private readonly logger = new Logger(AssociationsService.name);
  private readonly mediaBaseUrl = (
    process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3011'
  ).replace(/\/+$/, '');

  constructor(
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>,
    @InjectRepository(AssociationMember)
    private readonly memberRepo: Repository<AssociationMember>,
    private readonly redis: RedisService,
    private readonly httpService: HttpService
  ) {}

  /** Deletes all `posts:list:v2:*` Redis keys so the next request rebuilds the feed with updated association data. */
  private async invalidatePostListCaches(): Promise<void> {
    try {
      await this.redis.deleteByPattern('posts:list:v2:*');
    } catch {
      /* non-fatal */
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /** Creates a new association. Throws if the slug is already taken. */
  async create(dto: CreateAssociationDto, userId: string) {
    const existing = await this.assoRepo.findOne({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new BadRequestException('An association with this slug already exists');
    }

    const asso = this.assoRepo.create({ ...dto, createdBy: userId });
    const saved = await this.assoRepo.save(asso);

    return saved;
  }

  /** Returns all associations alphabetically with a memberCount field attached to each. */
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

    const countMap = new Map(
      counts.map((c: { associationId: string; count: string }) => [
        c.associationId,
        parseInt(c.count, 10),
      ])
    );

    return associations.map((a) => ({
      ...a,
      memberCount: countMap.get(a.id) ?? 0,
    }));
  }

  /** Loads one association by its UUID and appends a memberCount. Throws NotFoundException if absent. */
  async findById(id: string) {
    const asso = await this.assoRepo.findOne({ where: { id } });
    if (!asso) throw new NotFoundException('Association not found');
    const memberCount = await this.memberRepo.count({
      where: { associationId: id },
    });
    return { ...asso, memberCount };
  }

  /** Loads one association by its URL slug and appends a memberCount. */
  async findBySlug(slug: string) {
    const asso = await this.assoRepo.findOne({ where: { slug } });
    if (!asso) throw new NotFoundException('Association not found');
    const memberCount = await this.memberRepo.count({
      where: { associationId: asso.id },
    });
    return { ...asso, memberCount };
  }

  /** Partially updates an association (blank bioMarkdown is normalised to null) and invalidates post-list caches. */
  async update(id: string, dto: UpdateAssociationDto) {
    await this.findById(id);
    const patch = { ...dto } as Partial<Association>;
    if (dto.bioMarkdown !== undefined && dto.bioMarkdown.trim() === '') {
      patch.bioMarkdown = null;
    }
    await this.assoRepo.update(id, patch);
    await this.invalidatePostListCaches();
    return this.findById(id);
  }

  /** Permanently deletes an association and all its member records, then invalidates post-list caches. */
  async remove(id: string) {
    await this.memberRepo.delete({ associationId: id });
    await this.assoRepo.delete(id);
    await this.invalidatePostListCaches();
    return { ok: true };
  }

  /** Validates that the Authorization header is a Bearer token and returns it verbatim for forwarding. */
  private requireBearer(authorization: string | undefined): string {
    const h = authorization?.trim();
    if (!h?.startsWith('Bearer ')) {
      throw new BadRequestException('Missing Bearer token');
    }
    return h;
  }

  /** POSTs a logo file to the media-service public upload endpoint and returns the assigned mediaId. */
  private async uploadLogoToMedia(
    file: { buffer: Buffer; mimetype: string },
    authorization: string
  ): Promise<string> {
    const fd = new FormData();
    fd.append('file', file.buffer, {
      filename: 'logo',
      contentType: file.mimetype,
    });
    const url = `${this.mediaBaseUrl}/api/media/upload/public`;
    try {
      const { data } = await firstValueFrom(
        this.httpService.post<{ mediaId: string }>(url, fd, {
          headers: {
            ...fd.getHeaders(),
            Authorization: authorization,
          },
          maxBodyLength: LOGO_MAX_BYTES + 65_536,
          maxContentLength: LOGO_MAX_BYTES + 65_536,
        })
      );
      if (!data?.mediaId) {
        throw new BadRequestException('Media service returned no mediaId');
      }
      return data.mediaId;
    } catch (err) {
      const ax = err as AxiosError<{ message?: string }>;
      const detail =
        typeof ax.response?.data === 'object' && ax.response?.data?.message
          ? ax.response.data.message
          : typeof ax.response?.data === 'string'
            ? ax.response.data
            : ax.message;
      this.logger.warn(`Logo upload to media-service failed: ${detail}`);
      throw new BadRequestException(`Logo storage failed: ${detail}`);
    }
  }

  /** Tries to delete a media object; silently ignores errors (the object may already be gone). */
  private async deleteMediaBestEffort(mediaId: string, authorization: string): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.delete(`${this.mediaBaseUrl}/api/media/${mediaId}`, {
          headers: { Authorization: authorization },
        })
      );
    } catch {
      /* non-fatal — object may already be gone */
    }
  }

  /** Validates the uploaded file (size ≤ 2 MB, JPEG/PNG/WebP), uploads it to the media-service, then updates logoMediaId/logoUrl and deletes the previous logo if one existed. */
  async setLogoFromUpload(
    associationId: string,
    file: { buffer: Buffer; mimetype: string; size: number },
    authorization: string | undefined
  ) {
    await this.findById(associationId);
    const bearer = this.requireBearer(authorization);
    if (file.size > LOGO_MAX_BYTES) {
      throw new BadRequestException(`Logo must be at most ${LOGO_MAX_BYTES} bytes`);
    }
    const mime = file.mimetype?.toLowerCase() ?? '';
    if (!ALLOWED_LOGO_MIMES.has(mime)) {
      throw new BadRequestException('Logo must be JPEG, PNG, or WebP');
    }

    const previous = await this.assoRepo.findOne({
      where: { id: associationId },
      select: ['id', 'logoMediaId'],
    });
    const oldMediaId = previous?.logoMediaId ?? null;

    const mediaId = await this.uploadLogoToMedia(file, bearer);

    await this.assoRepo.update(associationId, { logoMediaId: mediaId });
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) throw new NotFoundException('Association not found');
    const v = asso.updatedAt instanceof Date ? asso.updatedAt.getTime() : Date.now();
    const logoUrl = `/api/media/public/${mediaId}?v=${v}`;
    await this.assoRepo.update(associationId, { logoUrl });

    if (oldMediaId && oldMediaId !== mediaId) {
      await this.deleteMediaBestEffort(oldMediaId, bearer);
    }

    await this.invalidatePostListCaches();
    return this.findById(associationId);
  }

  /** Removes the association's stored logo: clears the DB columns and attempts to delete the old media object. */
  async clearStoredLogo(
    associationId: string,
    authorization: string | undefined
  ): Promise<Association> {
    await this.findById(associationId);
    const row = await this.assoRepo.findOne({
      where: { id: associationId },
      select: ['id', 'logoMediaId'],
    });
    const oldMediaId = row?.logoMediaId ?? null;

    await this.assoRepo.update(associationId, {
      logoMediaId: null,
      logoUrl: null,
    });

    const bearer = authorization?.trim();
    if (oldMediaId && bearer?.startsWith('Bearer ')) {
      await this.deleteMediaBestEffort(oldMediaId, bearer);
    }

    await this.invalidatePostListCaches();
    return this.findById(associationId);
  }

  // ── Members ───────────────────────────────────────────────────────────────

  /** Lists all members of an association with their user displayName joined from the users table. */
  async listMembers(associationId: string) {
    return this.memberRepo
      .createQueryBuilder('m')
      .select(['m.id', 'm.associationId', 'm.userId', 'm.role', 'm.permission', 'm.createdAt'])
      .addSelect('u."displayName"', 'displayName')
      .leftJoin('users', 'u', 'u.id = m."userId"')
      .where('m."associationId" = :associationId', { associationId })
      .orderBy('m."createdAt"', 'ASC')
      .getRawMany()
      .then((rows) =>
        rows.map((r) => ({
          id: r.m_id,
          associationId: r.m_associationId,
          userId: r.m_userId,
          role: r.m_role,
          permission: Number(r.m_permission) as AssociationPermission,
          createdAt: r.m_createdAt,
          displayName: r.displayName || null,
        }))
      );
  }

  /** Adds a user to an association with the given role and permission level. Throws if they are already a member. */
  async addMember(
    associationId: string,
    userId: string,
    role: string,
    permission: AssociationPermission
  ) {
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
      permission,
    });
    return this.memberRepo.save(membership);
  }

  /** Updates a member's role label and/or permission level. Blocks demotion of the last admin. */
  async updateMemberRole(
    associationId: string,
    targetUserId: string,
    role?: string,
    permission?: AssociationPermission
  ) {
    const membership = await this.memberRepo.findOne({
      where: { associationId, userId: targetUserId },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    if (
      permission !== undefined &&
      membership.permission >= AssociationPermission.Admin &&
      permission < AssociationPermission.Admin
    ) {
      await this.assertNotLastAdminDemotion(associationId);
    }
    if (role !== undefined) membership.role = role;
    if (permission !== undefined) membership.permission = permission;
    return this.memberRepo.save(membership);
  }

  /** Removes a member from the association. Blocks removal of the last admin. */
  async removeMember(associationId: string, targetUserId: string) {
    const membership = await this.memberRepo.findOne({
      where: { associationId, userId: targetUserId },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    if (membership.permission >= AssociationPermission.Admin) {
      await this.assertNotLastAdminRemoval(associationId);
    }

    await this.memberRepo.delete(membership.id);
    return { ok: true };
  }

  /** Counts members whose permission is ≥ Admin. Used by the last-admin guard. */
  private async adminMemberCount(associationId: string): Promise<number> {
    return this.memberRepo.count({
      where: { associationId, permission: AssociationPermission.Admin },
    });
  }

  /** Block removing the only admin-capable member. */
  private async assertNotLastAdminRemoval(associationId: string): Promise<void> {
    const n = await this.adminMemberCount(associationId);
    if (n <= 1) {
      throw new BadRequestException('Cannot remove the last administrator of this association');
    }
  }

  /** Block demoting the only admin to member. */
  private async assertNotLastAdminDemotion(associationId: string): Promise<void> {
    const n = await this.adminMemberCount(associationId);
    if (n <= 1) {
      throw new BadRequestException('Cannot demote the last administrator of this association');
    }
  }

  /** Returns all associations a user belongs to, with their role/permission attached to each item. */
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

    return associations.map((a) => {
      const m = memberships.find((mem) => mem.associationId === a.id);
      return {
        ...a,
        role: m?.role,
        permission: m?.permission,
      };
    });
  }

  // ── Stripe helpers ────────────────────────────────────────────────────────

  /** Stores the Stripe connected-account ID for an association and invalidates post-list caches. */
  async setStripeAccountId(id: string, stripeAccountId: string) {
    const asso = await this.findById(id);
    await this.assoRepo.update(id, { stripeAccountId });
    await this.invalidatePostListCaches();
    return { ...asso, stripeAccountId };
  }

  /** Flips stripeOnboardingComplete to true after the Stripe Connect onboarding webhook confirms the account is ready. */
  async markStripeOnboardingComplete(id: string) {
    await this.assoRepo.update(id, { stripeOnboardingComplete: true });
    await this.invalidatePostListCaches();
  }

  /** Returns the Stripe connected-account ID for an association, or null if none is set. */
  async getStripeAccountId(id: string): Promise<string | null> {
    const asso = await this.assoRepo.findOne({ where: { id } });
    return asso?.stripeAccountId ?? null;
  }

  // ── Post authorship check ─────────────────────────────────────────────────

  /** Returns true if the user has Admin-level permission in the association (or is a global admin). Used before creating a post on behalf of an association. */
  async canPostAs(
    userId: string,
    associationId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    if (opts?.isGlobalAdmin) {
      const asso = await this.assoRepo.findOne({ where: { id: associationId } });
      return !!asso;
    }
    const membership = await this.memberRepo.findOne({
      where: { associationId, userId },
    });
    if (!membership) return false;
    return membership.permission >= AssociationPermission.Admin;
  }
}
