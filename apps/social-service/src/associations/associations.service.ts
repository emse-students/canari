import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { In, Not, Repository } from 'typeorm';
import { randomBytes, hkdfSync } from 'crypto';
import { firstValueFrom } from 'rxjs';
import FormData from 'form-data';
import { AxiosError } from 'axios';
import { Association } from './entities/association.entity';
import {
  AssociationMember,
  AssociationPermissionFlag,
  SUPER_ADMIN_EXCLUDED_FLAGS,
} from './entities/association-member.entity';
import { AssociationDocument } from './entities/association-document.entity';
import { DocumentReviewerGrant } from './entities/document-reviewer-grant.entity';
import { AssociationProduct } from './entities/association-product.entity';
import {
  AssociationCalendarEvent,
  AssociationCalendarEventKind,
  AssociationCalendarEventStatus,
} from './entities/association-calendar-event.entity';
import { AssociationCalendarEventCoOwner } from './entities/association-calendar-event-co-owner.entity';
import { deriveCotisationTag } from './cotisation-tag.util';
import {
  isDelegating,
  resolvePaymentTarget,
  fetchActivePaymentProvider,
  type PaymentTarget,
  type PaymentProviderId,
} from './payment-delegation.util';
import { Post } from '../posts/entities/post.entity';
import { Form } from '../forms/entities/form.entity';
import {
  AddMemberDto,
  CreateAssociationDto,
  CreateAssociationDocumentDto,
  UpdateAssociationDocumentDto,
  CreateAssociationCalendarEventDto,
  UpdateAssociationDto,
  UpdateAssociationCalendarEventDto,
} from './dto/association.dto';
import { RedisService } from '../common/redis/redis.service';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { PushService } from '../push/push.service';
import { UserTagService } from '../users/user-tag.service';
import { sanitizeLog } from '../common/log.utils';

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_LOGO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** A single public document exposed to a reviewer, with its server-derived CEK. */
export interface ReviewerDocument {
  id: string;
  name: string;
  originalFilename: string | null;
  mimeType: string;
  size: number;
  mediaId: string;
  /** Hex AES-256-GCM content key derived server-side from the vault key. */
  cek: string;
  createdAt: Date;
}

/** Public documents of one association, for the cross-association reviewer page. */
export interface ReviewerDocumentGroup {
  associationId: string;
  associationName: string;
  slug: string;
  logoUrl: string | null;
  documents: ReviewerDocument[];
}

/** CRUD, logo management, membership, and Stripe helpers for student associations. */
@Injectable()
export class AssociationsService {
  private readonly logger = new Logger(AssociationsService.name);
  private readonly mediaBaseUrl = (
    process.env.MEDIA_SERVICE_URL ?? 'http://media-service:3011'
  ).replace(/\/+$/, '');
  private readonly paymentBaseUrl = (
    process.env.PAYMENT_SERVICE_URL ?? 'http://core-service:3012'
  ).replace(/\/+$/, '');

  constructor(
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>,
    @InjectRepository(AssociationMember)
    private readonly memberRepo: Repository<AssociationMember>,
    @InjectRepository(AssociationCalendarEvent)
    private readonly calendarRepo: Repository<AssociationCalendarEvent>,
    @InjectRepository(AssociationCalendarEventCoOwner)
    private readonly coOwnerRepo: Repository<AssociationCalendarEventCoOwner>,
    @InjectRepository(AssociationDocument)
    private readonly docRepo: Repository<AssociationDocument>,
    @InjectRepository(DocumentReviewerGrant)
    private readonly reviewerGrantRepo: Repository<DocumentReviewerGrant>,
    @InjectRepository(Post)
    private readonly postRepo: Repository<Post>,
    @InjectRepository(Form)
    private readonly formRepo: Repository<Form>,
    @InjectRepository(PostNotification)
    private readonly notifRepo: Repository<PostNotification>,
    @InjectRepository(AssociationProduct)
    private readonly productRepo: Repository<AssociationProduct>,
    private readonly redis: RedisService,
    private readonly httpService: HttpService,
    private readonly push: PushService,
    private readonly userTagService: UserTagService
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

  /** Creates a new association. Throws if the slug is already taken or has an invalid format. */
  async create(dto: CreateAssociationDto, userId: string) {
    if (!/^[a-z0-9][a-z0-9-]{1,49}$/.test(dto.slug)) {
      throw new BadRequestException(
        'Slug must start with a letter or digit and contain only lowercase letters, digits, and hyphens (2-50 chars)'
      );
    }

    const existing = await this.assoRepo.findOne({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new BadRequestException('An association with this slug already exists');
    }

    const asso = this.assoRepo.create({
      ...dto,
      contactEmail: dto.contactEmail?.trim() ? dto.contactEmail.trim() : null,
      createdBy: userId,
    });
    const saved = await this.assoRepo.save(asso);

    return saved;
  }

  /**
   * Returns associations alphabetically with a memberCount field attached to each.
   * Pass `type` to restrict to regular associations or promo lists; omit for both.
   */
  async list(type?: 'association' | 'list') {
    const associations = await this.assoRepo.find({
      where: type ? { type } : {},
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

    const parents = await this.parentNameMap(associations.map((a) => a.parentAssociationId));

    return associations.map((a) => ({
      ...a,
      memberCount: countMap.get(a.id) ?? 0,
      parentName: a.parentAssociationId ? (parents.get(a.parentAssociationId) ?? null) : null,
    }));
  }

  /**
   * Resolves parent association ids to their display names in a single query.
   * Lets lists render "BDE - <list> - <year>" without an N+1 lookup.
   */
  private async parentNameMap(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map();
    const rows = await this.assoRepo.find({
      where: { id: In(unique) },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Display name of a list's parent association, or null when it has none. */
  private async parentName(parentId: string | null): Promise<string | null> {
    if (!parentId) return null;
    const parent = await this.assoRepo.findOne({
      where: { id: parentId },
      select: { name: true },
    });
    return parent?.name ?? null;
  }

  /** Loads one association by its UUID and appends a memberCount. Throws NotFoundException if absent. */
  async findById(id: string) {
    // `id` is a `uuid` column; a non-UUID string reaches Postgres as a syntax error rather than
    // a plain miss, which TypeORM surfaces as an uncaught 500 instead of the 404 every caller
    // expects. A malformed id and a well-formed id nothing points to are the same fact to the
    // caller, so both are reported identically.
    if (!isUUID(id)) throw new NotFoundException('Association not found');
    const asso = await this.assoRepo.findOne({ where: { id } });
    if (!asso) throw new NotFoundException('Association not found');
    const memberCount = await this.memberRepo.count({
      where: { associationId: id },
    });
    return { ...asso, memberCount, parentName: await this.parentName(asso.parentAssociationId) };
  }

  /** Loads one association by its URL slug and appends a memberCount. */
  async findBySlug(slug: string) {
    const asso = await this.assoRepo.findOne({ where: { slug } });
    if (!asso) throw new NotFoundException('Association not found');
    const memberCount = await this.memberRepo.count({
      where: { associationId: asso.id },
    });
    return { ...asso, memberCount, parentName: await this.parentName(asso.parentAssociationId) };
  }

  /** Partially updates an association (blank text fields normalised to null) and invalidates post-list caches. */
  async update(id: string, dto: UpdateAssociationDto) {
    const asso = await this.findById(id);
    const patch = { ...dto } as unknown as Partial<Association>;
    if (dto.description !== undefined && dto.description.trim() === '') {
      patch.description = null;
    }
    if (dto.bioMarkdown !== undefined && dto.bioMarkdown.trim() === '') {
      patch.bioMarkdown = null;
    }
    if (dto.color !== undefined && (dto.color === null || dto.color.trim() === '')) {
      patch.color = null;
    }
    // Blank category id clears the association's thematic category back to null.
    if (dto.categoryId !== undefined && (dto.categoryId === null || dto.categoryId === '')) {
      patch.categoryId = null;
    }
    if (
      dto.contactEmail !== undefined &&
      (dto.contactEmail === null || dto.contactEmail.trim() === '')
    ) {
      patch.contactEmail = null;
    }
    // Second-theme fields (lists): blank clears them back to null.
    if (dto.name2 !== undefined && (dto.name2 === null || dto.name2.trim() === '')) {
      patch.name2 = null;
    }
    if (dto.logoMediaId2 !== undefined && (dto.logoMediaId2 === null || dto.logoMediaId2 === '')) {
      patch.logoMediaId2 = null;
    }
    // documentQuotaBytes comes in as bigint but must stay a number in TypeORM
    if (patch.documentQuotaBytes !== undefined) {
      patch.documentQuotaBytes = Number(patch.documentQuotaBytes);
    }
    // Cotisation expiry is derived server-side from the mode (dated -> 31/08 of the current
    // academic year; lifetime -> never), never chosen by the client, so it always matches the
    // granted tag (see deriveCotisationTag). Any client-sent cotisationExpiresAt is ignored.
    delete patch.cotisationExpiresAt;
    if (dto.cotisationMode !== undefined) {
      patch.cotisationExpiresAt =
        dto.cotisationMode === 'dated' ? deriveCotisationTag(asso.slug, 'dated').expiresAt : null;
    }
    await this.assoRepo.update(id, patch);
    await this.invalidatePostListCaches();
    return this.findById(id);
  }

  /** Permanently deletes an association and all its member records, then invalidates post-list caches. */
  async remove(id: string) {
    await this.calendarRepo.delete({ associationId: id });
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

  /** POSTs any image file to the media-service public upload endpoint and returns the assigned mediaId. */
  async uploadPublicImage(
    file: { buffer: Buffer; mimetype: string },
    authorization: string
  ): Promise<string> {
    return this.uploadLogoToMedia(file, authorization);
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

  /**
   * Tries to delete a media object; silently ignores errors (the object may already be gone).
   * Sends `x-internal-secret` so media-service accepts the server-to-server deletion: that route
   * rejects direct client calls, trusting social-service to have already enforced association-admin
   * authz on the logo/event-image/form-banner/document being replaced.
   */
  async deleteMediaBestEffort(mediaId: string, authorization: string): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.delete(`${this.mediaBaseUrl}/api/media/${mediaId}`, {
          headers: {
            Authorization: authorization,
            'x-internal-secret': process.env.INTERNAL_SECRET ?? '',
          },
        })
      );
    } catch {
      /* non-fatal - object may already be gone */
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
      select: { id: true, logoMediaId: true },
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
      select: { id: true, logoMediaId: true },
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

  // ── Calendar event image ─────────────────────────────────────────────────

  /** Uploads an image file for a calendar event poster, stores it via media-service, and returns the updated event. */
  async setEventImageFromUpload(
    associationId: string,
    eventId: string,
    file: { buffer: Buffer; mimetype: string; size: number },
    authorization: string | undefined
  ) {
    await this.findById(associationId);
    const bearer = this.requireBearer(authorization);
    if (file.size > LOGO_MAX_BYTES * 4) {
      throw new BadRequestException('Event image must be at most 8 MB');
    }
    const mime = file.mimetype?.toLowerCase() ?? '';
    if (!ALLOWED_LOGO_MIMES.has(mime)) {
      throw new BadRequestException('Image must be JPEG, PNG, or WebP');
    }

    const ev = await this.calendarRepo.findOne({ where: { id: eventId, associationId } });
    if (!ev) throw new NotFoundException('Event not found');
    const oldMediaId = ev.imageMediaId;

    const mediaId = await this.uploadLogoToMedia(file, bearer);
    const imageUrl = `/api/media/public/${mediaId}`;
    await this.calendarRepo.update(eventId, { imageMediaId: mediaId, imageUrl });

    if (oldMediaId && oldMediaId !== mediaId) {
      await this.deleteMediaBestEffort(oldMediaId, bearer);
    }

    const updated = await this.calendarRepo.findOne({ where: { id: eventId } });
    return this.serializeCalendarEvent(updated);
  }

  /** Removes the poster image from a calendar event. */
  async clearEventImage(associationId: string, eventId: string, authorization: string | undefined) {
    const ev = await this.calendarRepo.findOne({ where: { id: eventId, associationId } });
    if (!ev) throw new NotFoundException('Event not found');
    const oldMediaId = ev.imageMediaId;
    await this.calendarRepo.update(eventId, { imageMediaId: null, imageUrl: null });

    const bearer = authorization?.trim();
    if (oldMediaId && bearer?.startsWith('Bearer ')) {
      await this.deleteMediaBestEffort(oldMediaId, bearer);
    }

    const updated = await this.calendarRepo.findOne({ where: { id: eventId } });
    return this.serializeCalendarEvent(updated);
  }

  // ── Members ───────────────────────────────────────────────────────────────

  /**
   * Lists all members of an association.
   * Returns `isAdmin` (permissions > 0) for public callers; the raw `permissions`
   * bitmask is included for every member when `includePermissions` is true (caller has
   * MANAGE_MEMBERS), and always for the caller's own row so the client can gate UI correctly.
   */
  async listMembers(
    associationId: string,
    opts?: { includePermissions?: boolean; callerId?: string }
  ) {
    const rows = await this.memberRepo
      .createQueryBuilder('m')
      .select(['m.id', 'm.associationId', 'm.userId', 'm.role', 'm.permissions', 'm.createdAt'])
      .addSelect('u."displayName"', 'displayName')
      .addSelect('u."firstName"', 'firstName')
      .addSelect('u."lastName"', 'lastName')
      .leftJoin('users', 'u', 'u.id = m."userId"')
      .where('m."associationId" = :associationId', { associationId })
      .orderBy('m."sortOrder"', 'ASC')
      .addOrderBy('m."createdAt"', 'ASC')
      .getRawMany();

    return rows.map((r) => {
      const permissions = Number(r.m_permissions ?? 0);
      const base = {
        id: r.m_id,
        associationId: r.m_associationId,
        userId: r.m_userId,
        role: r.m_role,
        isAdmin: permissions > 0,
        createdAt: r.m_createdAt,
        displayName: r.displayName || null,
        // The name PARTS, alongside the joined-up one. A caller that has to order a roster the way
        // a directory is read - by surname - cannot get there from `displayName`: that column is a
        // free-form name the user chose, so splitting it is a guess about which token is the
        // family name. `listMembersPublic` has exposed the same two columns since it was written.
        firstName: r.firstName || null,
        lastName: r.lastName || null,
      };
      // Always expose the caller's own bitmask so the frontend can gate by specific flag.
      if (opts?.includePermissions || r.m_userId === opts?.callerId) {
        return { ...base, permissions };
      }
      return base;
    });
  }

  /**
   * Public members list for the read-only showcase (portail-etu vitrine).
   * Never exposes the raw permission bitmask - only a coarse `isAdmin` flag -
   * and joins the users mirror for display name and promo. Ordered like the
   * public members grid (sortOrder, then createdAt).
   */
  async listMembersPublic(associationId: string) {
    const rows = await this.memberRepo
      .createQueryBuilder('m')
      .select(['m.id', 'm.userId', 'm.role', 'm.permissions', 'm.createdAt'])
      .addSelect('u."displayName"', 'displayName')
      .addSelect('u."firstName"', 'firstName')
      .addSelect('u."lastName"', 'lastName')
      .addSelect('u.promo', 'promo')
      .leftJoin('users', 'u', 'u.id = m."userId"')
      .where('m."associationId" = :associationId', { associationId })
      .orderBy('m."sortOrder"', 'ASC')
      .addOrderBy('m."createdAt"', 'ASC')
      .getRawMany();

    return rows.map((r) => ({
      id: r.m_id,
      userId: r.m_userId,
      role: r.m_role,
      isAdmin: Number(r.m_permissions ?? 0) > 0,
      displayName: r.displayName || [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
      firstName: r.firstName || null,
      lastName: r.lastName || null,
      promo: r.promo ?? null,
      createdAt: r.m_createdAt,
    }));
  }

  /** Adds a user to an association with the given role and permission bitmask. Throws if they are already a member. */
  async addMember(dto: AddMemberDto & { associationId: string }) {
    const { associationId, userId, role, permissions } = dto;
    await this.findById(associationId);

    const existing = await this.memberRepo.findOne({ where: { associationId, userId } });
    if (existing) {
      throw new BadRequestException('User is already a member');
    }

    // Append new members at the END of the ordered list (not the top): take the current
    // max sortOrder + 1. `listMembers` orders by sortOrder ASC, so without this a new
    // member (default sortOrder 0) would jump ahead of already-reordered members.
    const maxRow = await this.memberRepo
      .createQueryBuilder('m')
      .select('MAX(m."sortOrder")', 'max')
      .where('m."associationId" = :associationId', { associationId })
      .getRawOne<{ max: number | null }>();
    const sortOrder = (maxRow?.max ?? -1) + 1;

    const membership = this.memberRepo.create({
      associationId,
      userId,
      role,
      permissions,
      sortOrder,
    });
    return this.memberRepo.save(membership);
  }

  /** Updates `sortOrder` for each member in the list, preserving the given array order. */
  async reorderMembers(associationId: string, userIds: string[]): Promise<void> {
    await this.findById(associationId);
    await Promise.all(
      userIds.map((userId, index) =>
        this.memberRepo.update({ associationId, userId }, { sortOrder: index })
      )
    );
    this.logger.debug(`reorderMembers: ${userIds.length} members reordered in ${associationId}`);
  }

  /** Updates a member's role label and/or permission bitmask. Blocks removal of all flags from the last admin, unless bypassLastAdmin is true (global admin or BDE). */
  async updateMemberRole(
    associationId: string,
    targetUserId: string,
    role?: string,
    permissions?: number,
    opts?: { bypassLastAdmin?: boolean }
  ) {
    const membership = await this.memberRepo.findOne({
      where: { associationId, userId: targetUserId },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    // Guard: block demoting a member who holds MANAGE_MEMBERS if they are the last one.
    // We check specifically for MANAGE_MEMBERS loss, not just permissions===0, because a partial
    // demotion (e.g. keeping MANAGE_STRIPE_CONNECT) would bypass the old permissions===0 check
    // while still leaving the association without any member manager.
    const hadManageMembers =
      (membership.permissions & AssociationPermissionFlag.MANAGE_MEMBERS) !== 0;
    const willLoseManageMembers =
      permissions !== undefined && (permissions & AssociationPermissionFlag.MANAGE_MEMBERS) === 0;
    if (hadManageMembers && willLoseManageMembers && !opts?.bypassLastAdmin) {
      await this.assertNotLastAdminDemotion(associationId);
    }
    if (role !== undefined) membership.role = role;
    if (permissions !== undefined) membership.permissions = permissions;
    return this.memberRepo.save(membership);
  }

  /** Removes a member from the association. Blocks removal of the last admin, unless bypassLastAdmin is true (global admin or BDE). */
  async removeMember(
    associationId: string,
    targetUserId: string,
    opts?: { bypassLastAdmin?: boolean }
  ) {
    const membership = await this.memberRepo.findOne({
      where: { associationId, userId: targetUserId },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    // Only protect removal when the member holds MANAGE_MEMBERS - the critical flag.
    const holdsManageMembers =
      (membership.permissions & AssociationPermissionFlag.MANAGE_MEMBERS) !== 0;
    if (holdsManageMembers && !opts?.bypassLastAdmin) {
      await this.assertNotLastAdminRemoval(associationId);
    }

    await this.memberRepo.delete(membership.id);
    return { ok: true };
  }

  /**
   * Counts members holding MANAGE_MEMBERS - the flag required to manage the association.
   * Used to prevent locking an association out of member management.
   * Using `permissions > 0` was insufficient: a member with only MANAGE_STRIPE_CONNECT
   * counts as non-zero but cannot unblock the association.
   */
  private async manageMembersCount(associationId: string): Promise<number> {
    return this.memberRepo
      .createQueryBuilder('m')
      .where('m.associationId = :associationId', { associationId })
      .andWhere('(m.permissions & :flag) <> 0', {
        flag: AssociationPermissionFlag.MANAGE_MEMBERS,
      })
      .getCount();
  }

  /** Block removing the only member with MANAGE_MEMBERS. */
  private async assertNotLastAdminRemoval(associationId: string): Promise<void> {
    const n = await this.manageMembersCount(associationId);
    if (n <= 1) {
      throw new BadRequestException(
        'Impossible de retirer le dernier administrateur de cette association'
      );
    }
  }

  /** Block demoting the only MANAGE_MEMBERS admin to a bitmask that loses that flag. */
  private async assertNotLastAdminDemotion(associationId: string): Promise<void> {
    const n = await this.manageMembersCount(associationId);
    if (n <= 1) {
      throw new BadRequestException('Cannot demote the last administrator of this association.');
    }
  }

  /** Returns all associations a user belongs to, with their role and permissions bitmask attached to each item. */
  async listByUser(userId: string) {
    const memberships = await this.memberRepo.find({ where: { userId } });
    if (memberships.length === 0) return [];

    const assoIds = memberships.map((m) => m.associationId);
    // Archived associations/lists are hidden from "Mes associations".
    const associations = await this.assoRepo
      .createQueryBuilder('a')
      .where('a.id IN (:...ids)', { ids: assoIds })
      .andWhere('a.archived = false')
      .getMany();

    return associations.map((a) => {
      const m = memberships.find((mem) => mem.associationId === a.id);
      return {
        ...a,
        role: m?.role,
        permissions: m?.permissions ?? 0,
        isAdmin: (m?.permissions ?? 0) > 0,
      };
    });
  }

  // ── Calendar events ───────────────────────────────────────────────────────

  /** Coerces TypeORM raw join columns to string without `[object Object]`. */
  private rawQueryString(value: unknown, fallback = ''): string {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    return fallback;
  }

  /**
   * Returns the event if the caller's association is the primary owner OR a co-owner.
   * Pass `canCrossAsso = true` for BDE / global-admin callers (no ownership check).
   */
  private async findCalendarEventForAssociation(
    eventId: string,
    associationId: string,
    canCrossAsso: boolean
  ): Promise<AssociationCalendarEvent | null> {
    if (canCrossAsso) {
      return this.calendarRepo.findOne({ where: { id: eventId } });
    }
    return this.calendarRepo
      .createQueryBuilder('e')
      .where('e.id = :eventId', { eventId })
      .andWhere(
        `(e.associationId = :associationId OR EXISTS (
          SELECT 1 FROM association_calendar_event_co_owners co
          WHERE co.event_id = e.id AND co.association_id = :associationId
        ))`,
        { associationId }
      )
      .getOne();
  }

  /** Replaces the full co-owner list for an event atomically. */
  private async syncCoOwners(
    eventId: string,
    primaryAssociationId: string,
    coOwnerIds: string[]
  ): Promise<AssociationCalendarEventCoOwner[]> {
    await this.coOwnerRepo.delete({ eventId });
    const validIds = [...new Set(coOwnerIds)].filter((id) => id !== primaryAssociationId);
    if (validIds.length === 0) return [];
    const rows = validIds.map((id) => this.coOwnerRepo.create({ eventId, associationId: id }));
    return this.coOwnerRepo.save(rows);
  }

  /** Batch-loads co-owners for a list of event IDs (2 queries total). */
  private async batchLoadCoOwners(
    eventIds: string[]
  ): Promise<Map<string, AssociationCalendarEventCoOwner[]>> {
    const map = new Map<string, AssociationCalendarEventCoOwner[]>();
    if (eventIds.length === 0) return map;
    const all = await this.coOwnerRepo.find({ where: { eventId: In(eventIds) } });
    for (const co of all) {
      const list = map.get(co.eventId) ?? [];
      list.push(co);
      map.set(co.eventId, list);
    }
    return map;
  }

  private serializeCalendarEvent(
    e: AssociationCalendarEvent,
    coOwners: AssociationCalendarEventCoOwner[] = []
  ) {
    const startsAt = e.startsAt instanceof Date ? e.startsAt : new Date(e.startsAt);
    const endsRaw = e.endsAt;
    const endsAt =
      endsRaw === null || endsRaw === undefined
        ? null
        : endsRaw instanceof Date
          ? endsRaw
          : new Date(endsRaw);
    const createdAt = e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt);
    return {
      id: e.id,
      associationId: e.associationId,
      title: e.title,
      description: e.description,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt ? endsAt.toISOString() : null,
      createdBy: e.createdBy,
      createdAt: createdAt.toISOString(),
      kind: e.kind ?? AssociationCalendarEventKind.Event,
      linkedFormId: e.linkedFormId ?? null,
      status: e.status ?? AssociationCalendarEventStatus.Pending,
      validatedAt: e.validatedAt
        ? (e.validatedAt instanceof Date ? e.validatedAt : new Date(e.validatedAt)).toISOString()
        : null,
      validatedBy: e.validatedBy ?? null,
      rejectedAt: e.rejectedAt
        ? (e.rejectedAt instanceof Date ? e.rejectedAt : new Date(e.rejectedAt)).toISOString()
        : null,
      rejectedBy: e.rejectedBy ?? null,
      rejectionReason: e.rejectionReason ?? null,
      imageUrl: e.imageUrl ?? null,
      coOwners: coOwners.map((co) => ({
        associationId: co.associationId,
        name: co.association?.name ?? '',
        slug: co.association?.slug ?? '',
        color: co.association?.color ?? null,
        logoUrl: co.association?.logoUrl ?? null,
      })),
    };
  }

  /** Forms under this association (optional link from calendar event editor). */
  async getCalendarLinkCandidates(associationId: string) {
    await this.findById(associationId);
    const forms = await this.formRepo.find({
      where: { associationId },
      order: { updatedAt: 'DESC' },
      take: 50,
      select: { id: true, title: true, updatedAt: true },
    });
    return {
      forms: forms.map((f) => ({
        id: f.id,
        title: f.title,
        updatedAt: f.updatedAt instanceof Date ? f.updatedAt.toISOString() : String(f.updatedAt),
      })),
    };
  }

  /**
   * Ensures a post may reference a validated agenda event (same association).
   * Returns the event id or null when omitted.
   */
  async resolvePostCalendarEventLink(
    associationId: string | null | undefined,
    eventId: string | null | undefined
  ): Promise<string | null> {
    if (!eventId?.trim()) return null;
    if (!associationId?.trim()) {
      throw new BadRequestException('associationId is required to link an agenda event');
    }
    const ev = await this.calendarRepo.findOne({
      where: {
        id: eventId.trim(),
        associationId: associationId.trim(),
        status: AssociationCalendarEventStatus.Validated,
      },
    });
    if (!ev) {
      throw new BadRequestException(
        'Agenda event not found, not validated yet, or belongs to another association'
      );
    }
    return ev.id;
  }

  async findCalendarEventByLinkedPost(postId: string) {
    const post = await this.postRepo.findOne({
      where: { id: postId },
      select: { id: true, linkedCalendarEventId: true },
    });
    if (!post?.linkedCalendarEventId) return null;
    const ev = await this.calendarRepo.findOne({
      where: {
        id: post.linkedCalendarEventId,
        status: AssociationCalendarEventStatus.Validated,
      },
    });
    return ev ? this.serializeCalendarEvent(ev) : null;
  }

  /** Minimal event payload for post cards (validated events only). */
  async findValidatedCalendarEventSummary(eventId: string) {
    const ev = await this.calendarRepo.findOne({
      where: { id: eventId, status: AssociationCalendarEventStatus.Validated },
    });
    if (!ev) return null;
    const asso = await this.assoRepo.findOne({
      where: { id: ev.associationId },
      select: { slug: true },
    });
    const base = this.serializeCalendarEvent(ev);
    return { ...base, associationSlug: asso?.slug ?? '' };
  }

  async findCalendarEventByLinkedForm(formId: string) {
    const ev = await this.calendarRepo.findOne({
      where: { linkedFormId: formId, status: AssociationCalendarEventStatus.Validated },
    });
    return ev ? this.serializeCalendarEvent(ev) : null;
  }

  private async assertFormBelongsToAssociation(formId: string, associationId: string) {
    const f = await this.formRepo.findOne({
      where: { id: formId },
      select: { id: true, associationId: true },
    });
    if (!f) throw new BadRequestException('Linked form not found');
    if (f.associationId !== associationId) {
      throw new BadRequestException('Form must belong to this association');
    }
  }

  /** Ensures at most one calendar row references a given form. */
  private async detachCalendarLinksExcept(opts: { formId?: string | null; exceptEventId: string }) {
    const { formId, exceptEventId } = opts;
    if (formId) {
      await this.calendarRepo.update(
        { linkedFormId: formId, id: Not(exceptEventId) },
        { linkedFormId: null }
      );
    }
  }

  private async detachLinksBeforeCreate(formId?: string | null) {
    if (formId) {
      await this.calendarRepo.update({ linkedFormId: formId }, { linkedFormId: null });
    }
  }

  /** Lists calendar events for an association, optionally bounded by `from` / `to` ISO timestamps. */
  async listCalendarEvents(
    associationId: string,
    fromIso?: string,
    toIso?: string,
    opts?: { includePending?: boolean; includeRejected?: boolean }
  ) {
    await this.findById(associationId);
    const qb = this.calendarRepo
      .createQueryBuilder('e')
      .where(
        `(e.associationId = :associationId OR EXISTS (
          SELECT 1 FROM association_calendar_event_co_owners co
          WHERE co.event_id = e.id AND co.association_id = :associationId
        ))`,
        { associationId }
      )
      .orderBy('e.startsAt', 'ASC');
    // Validated events are always visible; pending ones (greyed on calendar) only for proposers;
    // rejected ones only in the editor management view.
    const statuses: AssociationCalendarEventStatus[] = [AssociationCalendarEventStatus.Validated];
    if (opts?.includePending) statuses.push(AssociationCalendarEventStatus.Pending);
    if (opts?.includeRejected) statuses.push(AssociationCalendarEventStatus.Rejected);
    qb.andWhere('e.status IN (:...statuses)', { statuses });
    if (fromIso?.trim()) {
      // Include multi-day events that started before `from` but end within or after the window.
      qb.andWhere('COALESCE(e.endsAt, e.startsAt) >= :from', { from: new Date(fromIso) });
    }
    if (toIso?.trim()) {
      qb.andWhere('e.startsAt <= :to', { to: new Date(toIso) });
    }
    const rows = await qb.getMany();
    const coOwnerMap = await this.batchLoadCoOwners(rows.map((r) => r.id));
    return rows.map((e) => this.serializeCalendarEvent(e, coOwnerMap.get(e.id) ?? []));
  }

  /** Max span for aggregated calendar queries (abuse guard). */
  private static readonly CALENDAR_FEED_MAX_MS = 550 * 24 * 60 * 60 * 1000;

  /**
   * Default window for the aggregated calendar feed when `from`/`to` are omitted: 3 months back
   * to the end of the 12th month ahead. A "subscribe by URL" feed (`.ics`) is saved once by the
   * calendar app and re-polled with the exact same URL forever - requiring the caller to always
   * supply a window defeats that, since nothing ever adds one after the first save. Mirrors the
   * range the frontend itself computes for the same purpose (`icsSubscriptionRangeISO`).
   */
  private static defaultCalendarFeedRange(): { from: Date; to: Date } {
    const now = new Date();
    return {
      from: new Date(now.getFullYear(), now.getMonth() - 3, 1, 0, 0, 0, 0),
      to: new Date(now.getFullYear(), now.getMonth() + 12, 0, 23, 59, 59, 999),
    };
  }

  /**
   * Returns true if the user has the PROPOSE_EVENT flag in at least one association.
   * Used to decide whether to show the pending-events queue link.
   */
  async canViewPendingCalendarEvents(userId: string): Promise<boolean> {
    const n = await this.memberRepo
      .createQueryBuilder('m')
      .where('m.userId = :userId', { userId })
      .andWhere('(m.permissions & :flag) <> 0', {
        flag: AssociationPermissionFlag.PROPOSE_EVENT,
      })
      .getCount();
    return n > 0;
  }

  /** Returns true if the user is an admin (any flag) of at least one association. */
  async isMemberOfAnyAssoc(userId: string): Promise<boolean> {
    const n = await this.memberRepo
      .createQueryBuilder('m')
      .where('m.userId = :userId', { userId })
      .andWhere('m.permissions > 0')
      .getCount();
    return n > 0;
  }

  /** Returns true if the user holds VALIDATE_EVENTS in a BDE association. */
  async isUserBdeAdmin(userId: string): Promise<boolean> {
    const n = await this.memberRepo
      .createQueryBuilder('m')
      .innerJoin(Association, 'a', 'a.id = m.associationId')
      .where('m.userId = :userId', { userId })
      .andWhere('a.isBDE = true')
      .andWhere('(m.permissions & :flag) <> 0', {
        flag: AssociationPermissionFlag.VALIDATE_EVENTS,
      })
      .getCount();
    return n > 0;
  }

  /**
   * Returns true if userId holds `flag` in association `associationId`.
   *
   * The MEMBERSHIP tier only. Callers deciding whether someone may act want `mayAct`, which adds
   * the platform administrator and the cross-association super-admin above it.
   */
  async callerHasFlag(
    userId: string,
    associationId: string,
    flag: AssociationPermissionFlag
  ): Promise<boolean> {
    const m = await this.memberRepo.findOne({ where: { associationId, userId } });
    if (!m) return false;
    return (m.permissions & flag) !== 0;
  }

  /**
   * Resolves association ids to their display names, in one query.
   *
   * For labelling rows that carry an association id - a form list, say - where the name is the only
   * part a screen may show. Ids absent from the result simply have no name: the association was
   * deleted, and the caller renders the row without a label rather than failing.
   */
  async namesByIds(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await this.assoRepo
      .createQueryBuilder('a')
      .select(['a.id', 'a.name'])
      .where('a.id IN (:...ids)', { ids: unique })
      .getMany();
    return new Map(rows.map((a) => [a.id, a.name]));
  }

  /**
   * The associations where `userId` holds `flag`, as `{ id, name }`.
   *
   * Reuses `listByUser`, so it inherits its exclusion of archived associations - a form of an
   * archived association must not surface in a "what can I manage" list.
   */
  async associationsWhereUserHasFlag(
    userId: string,
    flag: AssociationPermissionFlag
  ): Promise<{ id: string; name: string }[]> {
    const mine = await this.listByUser(userId);
    return mine
      .filter((a) => (a.permissions & flag) !== 0)
      .map((a) => ({ id: a.id, name: a.name }));
  }

  /** Returns true if userId is a member of the given association (any role). */
  async isMember(userId: string, associationId: string): Promise<boolean> {
    const m = await this.memberRepo.findOne({ where: { associationId, userId } });
    return m !== null;
  }

  /** Returns true if userId holds `flag` in ANY BDE association. */
  async callerHasAnyBdeFlag(userId: string, flag: AssociationPermissionFlag): Promise<boolean> {
    const n = await this.memberRepo
      .createQueryBuilder('m')
      .innerJoin(Association, 'a', 'a.id = m.associationId')
      .where('m.userId = :userId', { userId })
      .andWhere('a.isBDE = true')
      .andWhere('(m.permissions & :flag) <> 0', { flag })
      .getCount();
    return n > 0;
  }

  /**
   * Returns true if userId is a cross-association super-admin: a member of a BDE
   * association holding `MANAGE_ASSO`. Such a user may administer any association
   * (members, documents, forms, products) as if a full local admin, mirroring the
   * `X-Global-Admin` escape hatch.
   */
  async isAssociationSuperAdmin(userId: string): Promise<boolean> {
    return this.callerHasAnyBdeFlag(userId, AssociationPermissionFlag.MANAGE_ASSO);
  }

  /**
   * May `userId` moderate CONTENT anywhere on the platform - a platform administrator, or a BDE
   * member holding `MODERATE`?
   *
   * Not association-scoped, so `mayAct` cannot express it: the question is "does the BDE curate the
   * whole feed", the same shape as `isUserBdeAdmin` for the calendar. It is here rather than inside
   * one controller because two surfaces ask it - the moderation endpoints, and the edit / delete /
   * pin controls on a post - and the second was previously written as `isGlobalAdmin` alone, which
   * is how a BDE holding `MODERATE` ended up unable to touch a post it was entitled to moderate.
   */
  async isContentModerator(userId: string, opts?: { isGlobalAdmin?: boolean }): Promise<boolean> {
    if (opts?.isGlobalAdmin) return true;
    if (!userId) return false;
    return this.callerHasAnyBdeFlag(userId, AssociationPermissionFlag.MODERATE);
  }

  /**
   * THE question every association-scoped check asks: may `userId` exercise `flag` on
   * `associationId`?
   *
   * Three tiers, widest first: the platform administrator, who holds every association right
   * whether or not they are a member; the cross-association super-admin (`MANAGE_ASSO` in a BDE),
   * minus `SUPER_ADMIN_EXCLUDED_FLAGS`; then the association's own member bitmask.
   *
   * It exists because the same question had four different answers in this codebase - the guard
   * granted the super-admin everything, two inline checks forgot them entirely, and the calendar
   * pair escalated through `VALIDATE_EVENTS` instead. A right spelled out per call site drifts per
   * call site: a BDE super-admin was refused the member bitmask by one endpoint while the endpoint
   * below it accepted their write. Every new check calls this and adds no second axis of its own.
   *
   * It answers RIGHTS, not existence: a caller acting on an association that does not exist is a
   * 404 from whoever loads it, not a 403 from here. `canPostAs` is the exception and says why.
   */
  async mayAct(
    userId: string,
    associationId: string,
    flag: AssociationPermissionFlag,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    if (opts?.isGlobalAdmin) return true;
    if ((flag & SUPER_ADMIN_EXCLUDED_FLAGS) === 0 && (await this.isAssociationSuperAdmin(userId))) {
      this.logger.debug(
        `[PERM] super-admin ${userId.slice(0, 8)} granted flag=${flag} on assoc=${associationId.slice(0, 8)}`
      );
      return true;
    }
    return this.callerHasFlag(userId, associationId, flag);
  }

  /**
   * `mayAct` answered for MANY associations at once: the subset of `associationIds` where `userId`
   * may exercise `flag`.
   *
   * A feed page carries posts from a dozen associations and has to decide each row, so asking
   * `mayAct` per row is a dozen round trips per render. It is deliberately assembled from the same
   * three tiers rather than from a membership query alone - the exclusion set is exactly what makes
   * `POST_AS_ASSO` behave differently here from `MANAGE_MEMBERS`, and a caller re-deriving that by
   * hand is the drift `mayAct` was written to end.
   *
   * An unknown caller holds nothing: an anonymous reader gets the empty set rather than a crash.
   */
  async mayActOnAny(
    userId: string | undefined,
    associationIds: string[],
    flag: AssociationPermissionFlag,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<Set<string>> {
    const unique = [...new Set(associationIds.filter(Boolean))];
    if (unique.length === 0) return new Set();
    if (opts?.isGlobalAdmin) return new Set(unique);
    if (!userId) return new Set();

    if ((flag & SUPER_ADMIN_EXCLUDED_FLAGS) === 0 && (await this.isAssociationSuperAdmin(userId))) {
      this.logger.debug(
        `[PERM] super-admin ${userId.slice(0, 8)} granted flag=${flag} on ${unique.length} assocs`
      );
      return new Set(unique);
    }

    const rows = await this.memberRepo.find({
      where: { userId, associationId: In(unique) },
      select: { associationId: true, permissions: true },
    });
    const granted = new Set(
      rows.filter((row) => (row.permissions & flag) !== 0).map((row) => row.associationId)
    );
    this.logger.debug(
      `[PERM] ${userId.slice(0, 8)} holds flag=${flag} on ${granted.size}/${unique.length} assocs`
    );
    return granted;
  }

  /**
   * Pending calendar rows the caller may see (global admin / BDE admin: all; else own assos).
   * Any member of an association (permissions > 0) sees pending events of their own asso.
   */
  async listPendingCalendarEvents(userId: string, opts?: { isGlobalAdmin?: boolean }) {
    const qb = this.calendarRepo
      .createQueryBuilder('e')
      .innerJoin(Association, 'a', 'a.id = e.associationId')
      .where('e.status = :pending', { pending: AssociationCalendarEventStatus.Pending })
      .orderBy('e.startsAt', 'ASC');

    if (!opts?.isGlobalAdmin) {
      // BDE admins (VALIDATE_EVENTS) see all pending events
      const isBde = await this.isUserBdeAdmin(userId);
      if (!isBde) {
        // Regular asso admins (any flag) see only their own asso's pending events
        const myMemberships = await this.memberRepo.find({
          where: { userId },
          select: { associationId: true, permissions: true },
        });
        const adminAssoIds = myMemberships
          .filter((m) => m.permissions > 0)
          .map((m) => m.associationId);
        if (adminAssoIds.length === 0) {
          return [];
        }
        qb.andWhere('e.associationId IN (:...adminAssoIds)', { adminAssoIds });
      }
    }

    const rows = await qb
      .select('e.id', 'id')
      .addSelect('e.associationId', 'associationId')
      .addSelect('e.title', 'title')
      .addSelect('e.description', 'description')
      .addSelect('e.startsAt', 'startsAt')
      .addSelect('e.endsAt', 'endsAt')
      .addSelect('e.createdBy', 'createdBy')
      .addSelect('e.createdAt', 'createdAt')
      .addSelect('e.kind', 'kind')
      .addSelect('e.linkedFormId', 'linkedFormId')
      .addSelect('e.status', 'status')
      .addSelect('e.validatedAt', 'validatedAt')
      .addSelect('e.validatedBy', 'validatedBy')
      .addSelect('e.rejectedAt', 'rejectedAt')
      .addSelect('e.rejectedBy', 'rejectedBy')
      .addSelect('e.rejectionReason', 'rejectionReason')
      .addSelect('e.imageUrl', 'imageUrl')
      .addSelect('e.imageMediaId', 'imageMediaId')
      .addSelect('a.name', 'associationName')
      .addSelect('a.slug', 'associationSlug')
      .addSelect('a.color', 'associationColor')
      .addSelect('a.logoUrl', 'associationLogoUrl')
      .getRawMany();

    return rows.map((r: Record<string, unknown>) => {
      const base = this.serializeCalendarEvent({
        id: r.id as string,
        associationId: r.associationId as string,
        title: r.title as string,
        description: (r.description as string | null) ?? null,
        startsAt: r.startsAt as Date,
        endsAt: (r.endsAt as Date | null) ?? null,
        createdBy: r.createdBy as string,
        createdAt: r.createdAt as Date,
        kind: (r.kind as AssociationCalendarEventKind) ?? AssociationCalendarEventKind.Event,
        linkedFormId: (r.linkedFormId as string | null) ?? null,
        status:
          (r.status as AssociationCalendarEventStatus) ?? AssociationCalendarEventStatus.Pending,
        validatedAt: (r.validatedAt as Date | null) ?? null,
        validatedBy: (r.validatedBy as string | null) ?? null,
        rejectedAt: (r.rejectedAt as Date | null) ?? null,
        rejectedBy: (r.rejectedBy as string | null) ?? null,
        rejectionReason: (r.rejectionReason as string | null) ?? null,
        imageUrl: (r.imageUrl as string | null) ?? null,
        imageMediaId: (r.imageMediaId as string | null) ?? null,
      });
      return {
        ...base,
        associationName: this.rawQueryString(r.associationName),
        associationSlug: this.rawQueryString(r.associationSlug),
        associationColor: (r.associationColor as string | null) ?? null,
        associationLogoUrl: (r.associationLogoUrl as string | null) ?? null,
      };
    });
  }

  /**
   * Lists agenda events across all associations in `[from, to]` (by `startsAt`),
   * optionally restricted to one association. Public (same visibility as per-association `/events`).
   * `fromIso`/`toIso` default to `defaultCalendarFeedRange()` when omitted or blank.
   */
  async listAggregatedCalendarFeed(
    fromIso?: string,
    toIso?: string,
    associationId?: string,
    opts?: { includePending?: boolean }
  ) {
    const defaultRange = AssociationsService.defaultCalendarFeedRange();
    const from = fromIso?.trim() ? new Date(fromIso.trim()) : defaultRange.from;
    const to = toIso?.trim() ? new Date(toIso.trim()) : defaultRange.to;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid from or to');
    }
    if (from > to) {
      throw new BadRequestException('from must be before or equal to to');
    }
    if (to.getTime() - from.getTime() > AssociationsService.CALENDAR_FEED_MAX_MS) {
      throw new BadRequestException('Date range too large (max ~18 months)');
    }

    const aid = associationId?.trim() || null;
    if (aid) {
      await this.findById(aid);
    }

    const qb = this.calendarRepo
      .createQueryBuilder('e')
      .innerJoin(Association, 'a', 'a.id = e.associationId')
      // Overlap condition: event starts before window end AND ends (or starts) within/after window.
      .where('e.startsAt <= :to AND COALESCE(e.endsAt, e.startsAt) >= :from', { from, to })
      .orderBy('e.startsAt', 'ASC');
    // Default: validated events only. Members allowed to propose can also see pending
    // events (greyed in UI); rejected events are never shown here.
    if (opts?.includePending) {
      qb.andWhere('e.status IN (:...visibleStatuses)', {
        visibleStatuses: [
          AssociationCalendarEventStatus.Validated,
          AssociationCalendarEventStatus.Pending,
        ],
      });
    } else {
      qb.andWhere('e.status = :validated', {
        validated: AssociationCalendarEventStatus.Validated,
      });
    }
    if (aid) {
      // Include events where the association is either the primary owner or a co-owner.
      qb.andWhere(
        '(e.associationId = :aid OR EXISTS (SELECT 1 FROM association_calendar_event_co_owners co WHERE co.event_id = e.id AND co.association_id = :aid))',
        { aid }
      );
    }

    const rows = await qb
      .select('e.id', 'id')
      .addSelect('e.associationId', 'associationId')
      .addSelect('e.title', 'title')
      .addSelect('e.description', 'description')
      .addSelect('e.startsAt', 'startsAt')
      .addSelect('e.endsAt', 'endsAt')
      .addSelect('e.createdBy', 'createdBy')
      .addSelect('e.createdAt', 'createdAt')
      .addSelect('e.kind', 'kind')
      .addSelect('e.linkedFormId', 'linkedFormId')
      .addSelect('e.status', 'status')
      .addSelect('e.validatedAt', 'validatedAt')
      .addSelect('e.validatedBy', 'validatedBy')
      .addSelect('e.imageUrl', 'imageUrl')
      .addSelect('e.imageMediaId', 'imageMediaId')
      .addSelect('a.name', 'associationName')
      .addSelect('a.slug', 'associationSlug')
      .addSelect('a.color', 'associationColor')
      .addSelect('a.logoUrl', 'associationLogoUrl')
      .getRawMany();

    const coOwnerMap = await this.batchLoadCoOwners(
      rows.map((r: Record<string, unknown>) => r.id as string)
    );

    return rows.map((r: Record<string, unknown>) => {
      const base = this.serializeCalendarEvent(
        {
          id: r.id as string,
          associationId: r.associationId as string,
          title: r.title as string,
          description: (r.description as string | null) ?? null,
          startsAt: r.startsAt as Date,
          endsAt: (r.endsAt as Date | null) ?? null,
          createdBy: r.createdBy as string,
          createdAt: r.createdAt as Date,
          kind: (r.kind as AssociationCalendarEventKind) ?? AssociationCalendarEventKind.Event,
          linkedFormId: (r.linkedFormId as string | null) ?? null,
          status:
            (r.status as AssociationCalendarEventStatus) ??
            AssociationCalendarEventStatus.Validated,
          validatedAt: (r.validatedAt as Date | null) ?? null,
          validatedBy: (r.validatedBy as string | null) ?? null,
          rejectedAt: null,
          rejectedBy: null,
          rejectionReason: null,
          imageUrl: (r.imageUrl as string | null) ?? null,
          imageMediaId: (r.imageMediaId as string | null) ?? null,
        },
        coOwnerMap.get(r.id as string) ?? []
      );
      return {
        ...base,
        associationName: this.rawQueryString(r.associationName),
        associationSlug: this.rawQueryString(r.associationSlug),
        associationColor: (r.associationColor as string | null) ?? null,
        associationLogoUrl: (r.associationLogoUrl as string | null) ?? null,
      };
    });
  }

  /**
   * Sends in-app + push notifications to all members with PROPOSE_EVENT flag in an association.
   * Used when a BDE admin validates, modifies, or deletes an event on behalf of another asso.
   */
  private async notifyAssocAdminsOfEventAction(
    associationId: string,
    actorId: string,
    eventTitle: string,
    action: 'validated' | 'updated' | 'deleted' | 'rejected',
    rejectionReason?: string
  ): Promise<void> {
    const members = await this.memberRepo.find({
      where: { associationId },
      select: { userId: true, permissions: true },
    });
    const proposers = members.filter(
      (m) => (m.permissions & AssociationPermissionFlag.PROPOSE_EVENT) !== 0
    );
    if (proposers.length === 0) return;

    const actionLabel =
      action === 'validated'
        ? 'validated'
        : action === 'updated'
          ? 'updated'
          : action === 'rejected'
            ? 'rejected'
            : 'deleted';
    const reasonSuffix =
      action === 'rejected' && rejectionReason ? ` Reason: ${rejectionReason}` : '';
    const text = `Event "${eventTitle}" has been ${actionLabel} by the BDE.${reasonSuffix}`;

    const targets = proposers.filter((m) => m.userId !== actorId);
    if (targets.length === 0) return;

    // Batch-insert all in-app notifications in one round trip instead of one per member.
    const notifs = targets.map((m) =>
      this.notifRepo.create({
        recipientId: m.userId,
        type: 'event_action',
        postId: associationId, // closest available context ID
        actorId,
        text,
        read: false,
      })
    );
    await this.notifRepo.save(notifs);

    // Push notifications are fire-and-forget - failures do not block the response.
    void Promise.all(
      targets.map((m) =>
        this.push
          .notify(m.userId, 'Association event', text, {
            type: 'event_action',
            associationId,
            action,
          })
          .catch((e) => this.logger.warn(`[notify] push failed for ${m.userId}: ${String(e)}`))
      )
    );
  }

  /**
   * Creates a calendar event for the association.
   * BDE admins and global admins: event is immediately validated + may target another association.
   */
  async createCalendarEvent(
    associationId: string,
    dto: CreateAssociationCalendarEventDto,
    userId: string,
    callerOpts?: { isGlobalAdmin?: boolean; isBde?: boolean }
  ) {
    const canValidate = callerOpts?.isGlobalAdmin || callerOpts?.isBde;
    // BDE / global admin may create on behalf of another association
    const targetId = canValidate && dto.targetAssocId ? dto.targetAssocId : associationId;
    await this.findById(targetId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException('Invalid startsAt');
    }
    if (endsAt && Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException('Invalid endsAt');
    }
    if (endsAt && endsAt < startsAt) {
      throw new BadRequestException('endsAt must be after startsAt');
    }

    const linkedFormId = dto.linkedFormId ?? null;
    if (linkedFormId) await this.assertFormBelongsToAssociation(linkedFormId, targetId);
    await this.detachLinksBeforeCreate(linkedFormId);

    const now = new Date();
    const row = this.calendarRepo.create({
      associationId: targetId,
      title: dto.title.trim(),
      description: dto.description?.trim() ? dto.description.trim() : null,
      startsAt,
      endsAt,
      createdBy: userId,
      kind: dto.kind ?? AssociationCalendarEventKind.Event,
      linkedFormId,
      status: canValidate
        ? AssociationCalendarEventStatus.Validated
        : AssociationCalendarEventStatus.Pending,
      validatedAt: canValidate ? now : null,
      validatedBy: canValidate ? userId : null,
    });
    const saved = await this.calendarRepo.save(row);
    const coOwners = await this.syncCoOwners(saved.id, targetId, dto.coOwnerIds ?? []);
    this.logger.debug(
      `Event created: ${sanitizeLog(saved.id)} for asso ${sanitizeLog(targetId)} by ${sanitizeLog(userId)} (status=${sanitizeLog(saved.status)}, coOwners=${coOwners.length})`
    );
    // Notify asso admins when BDE creates an event on their behalf
    if (canValidate && targetId !== associationId) {
      void this.notifyAssocAdminsOfEventAction(targetId, userId, saved.title, 'validated');
    }
    return this.serializeCalendarEvent(saved, coOwners);
  }

  /**
   * Updates an existing calendar event.
   * BDE admins and global admins may update events from any association.
   */
  async updateCalendarEvent(
    associationId: string,
    eventId: string,
    dto: UpdateAssociationCalendarEventDto,
    callerOpts?: { isGlobalAdmin?: boolean; isBde?: boolean; callerUserId?: string }
  ) {
    const canCrossAsso = callerOpts?.isGlobalAdmin || callerOpts?.isBde;
    await this.findById(associationId);
    const ev = await this.findCalendarEventForAssociation(eventId, associationId, canCrossAsso);
    if (!ev) throw new NotFoundException('Event not found');

    if (dto.title !== undefined) ev.title = dto.title.trim();
    if (dto.kind !== undefined) ev.kind = dto.kind;
    if (dto.description !== undefined) {
      ev.description = dto.description?.trim() ? dto.description.trim() : null;
    }
    if (dto.startsAt !== undefined) {
      const d = new Date(dto.startsAt);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid startsAt');
      ev.startsAt = d;
    }
    if (dto.endsAt !== undefined) {
      if (!dto.endsAt?.trim()) {
        ev.endsAt = null;
      } else {
        const end = new Date(dto.endsAt);
        if (Number.isNaN(end.getTime())) throw new BadRequestException('Invalid endsAt');
        ev.endsAt = end;
      }
    }
    const starts = ev.startsAt instanceof Date ? ev.startsAt : new Date(ev.startsAt);
    const ends = ev.endsAt ? (ev.endsAt instanceof Date ? ev.endsAt : new Date(ev.endsAt)) : null;
    if (ends && ends < starts) {
      throw new BadRequestException('endsAt must be after startsAt');
    }

    if (dto.linkedFormId !== undefined) {
      if (dto.linkedFormId === null || dto.linkedFormId === '') {
        ev.linkedFormId = null;
      } else {
        await this.assertFormBelongsToAssociation(dto.linkedFormId, associationId);
        await this.detachCalendarLinksExcept({
          formId: dto.linkedFormId,
          exceptEventId: ev.id,
        });
        ev.linkedFormId = dto.linkedFormId;
      }
    }

    const saved = await this.calendarRepo.save(ev);
    const coOwners =
      dto.coOwnerIds !== undefined
        ? await this.syncCoOwners(saved.id, saved.associationId, dto.coOwnerIds)
        : await this.batchLoadCoOwners([saved.id]).then((m) => m.get(saved.id) ?? []);
    this.logger.debug(
      `Event updated: ${sanitizeLog(saved.id)} by ${sanitizeLog(callerOpts?.callerUserId)} (coOwners=${coOwners.length})`
    );
    // Notify asso admins when BDE modifies an event from another asso
    if (canCrossAsso && ev.associationId !== associationId && callerOpts?.callerUserId) {
      void this.notifyAssocAdminsOfEventAction(
        ev.associationId,
        callerOpts.callerUserId,
        saved.title,
        'updated'
      );
    }
    return this.serializeCalendarEvent(saved, coOwners);
  }

  /** Marks a pending calendar event as validated (visible on public agenda and feeds). */
  async validateCalendarEvent(associationId: string, eventId: string, userId: string) {
    await this.findById(associationId);
    const ev = await this.findCalendarEventForAssociation(eventId, associationId, false);
    if (!ev) throw new NotFoundException('Event not found');
    if (ev.status === AssociationCalendarEventStatus.Validated) {
      return this.serializeCalendarEvent(ev);
    }
    ev.status = AssociationCalendarEventStatus.Validated;
    ev.validatedAt = new Date();
    ev.validatedBy = userId;
    const saved = await this.calendarRepo.save(ev);
    this.logger.debug(`Event validated: ${saved.id} by ${userId}`);
    // Notify asso admins that their event has been validated
    void this.notifyAssocAdminsOfEventAction(ev.associationId, userId, ev.title, 'validated');
    return this.serializeCalendarEvent(saved);
  }

  /** Rejects a pending calendar event; keeps it visible to asso admins with a reason. */
  async rejectCalendarEvent(
    associationId: string,
    eventId: string,
    userId: string,
    reason?: string
  ) {
    await this.findById(associationId);
    const ev = await this.findCalendarEventForAssociation(eventId, associationId, false);
    if (!ev) throw new NotFoundException('Event not found');
    if (ev.status === AssociationCalendarEventStatus.Rejected) {
      return this.serializeCalendarEvent(ev);
    }
    ev.status = AssociationCalendarEventStatus.Rejected;
    ev.rejectedAt = new Date();
    ev.rejectedBy = userId;
    ev.rejectionReason = reason ?? null;
    const saved = await this.calendarRepo.save(ev);
    this.logger.debug(`Event rejected: ${saved.id} by ${userId}`);
    void this.notifyAssocAdminsOfEventAction(
      ev.associationId,
      userId,
      ev.title,
      'rejected',
      reason
    );
    return this.serializeCalendarEvent(saved);
  }

  /**
   * Deletes a calendar event.
   * BDE admins and global admins may delete events from any association.
   */
  async deleteCalendarEvent(
    associationId: string,
    eventId: string,
    callerOpts?: { isGlobalAdmin?: boolean; isBde?: boolean; callerUserId?: string }
  ) {
    const canCrossAsso = callerOpts?.isGlobalAdmin || callerOpts?.isBde;
    await this.findById(associationId);
    // For BDE cross-asso, find the event first to get its associationId for notifications
    if (canCrossAsso) {
      const ev = await this.calendarRepo.findOne({ where: { id: eventId } });
      if (!ev) throw new NotFoundException('Event not found');
      const targetAssocId = ev.associationId;
      const title = ev.title;
      await this.calendarRepo.delete({ id: eventId });
      this.logger.debug(
        `Event deleted: ${sanitizeLog(eventId)} by ${sanitizeLog(callerOpts?.callerUserId)}`
      );
      if (targetAssocId !== associationId && callerOpts?.callerUserId) {
        void this.notifyAssocAdminsOfEventAction(
          targetAssocId,
          callerOpts.callerUserId,
          title,
          'deleted'
        );
      }
    } else {
      const ev = await this.findCalendarEventForAssociation(eventId, associationId, false);
      if (!ev) throw new NotFoundException('Event not found');
      await this.calendarRepo.delete({ id: eventId });
      this.logger.debug(
        `Event deleted: ${sanitizeLog(eventId)} by ${sanitizeLog(callerOpts?.callerUserId)}`
      );
    }
    return { ok: true };
  }

  // ── Document vault ────────────────────────────────────────────────────────

  /**
   * Returns the hex-encoded 32-byte vault key for the association, generating
   * and persisting it on first access. The key is the HKDF input key material
   * from which per-document CEKs are derived client-side.
   */
  async getOrCreateVaultKey(associationId: string): Promise<string> {
    const asso = await this.assoRepo.findOne({
      where: { id: associationId },
      select: { id: true, documentVaultKey: true },
    });
    if (!asso) throw new NotFoundException('Association not found');
    if (asso.documentVaultKey) return asso.documentVaultKey;

    const key = randomBytes(32).toString('hex');
    await this.assoRepo.update(associationId, { documentVaultKey: key });
    this.logger.debug(`Vault key generated for association ${sanitizeLog(associationId)}`);
    return key;
  }

  /** Returns the association's vault-encrypted shared notepad ciphertext (empty if unset). */
  async getNotesCiphertext(associationId: string): Promise<string> {
    const asso = await this.assoRepo.findOne({
      where: { id: associationId },
      select: { id: true, notesCiphertext: true },
    });
    if (!asso) throw new NotFoundException('Association not found');
    return asso.notesCiphertext ?? '';
  }

  /** Persists the association's vault-encrypted shared notepad ciphertext. */
  async setNotesCiphertext(associationId: string, ciphertext: string): Promise<void> {
    await this.findById(associationId);
    await this.assoRepo.update(associationId, { notesCiphertext: ciphertext || null });
    this.logger.debug(`Vault notepad updated for association ${sanitizeLog(associationId)}`);
  }

  /** Lists documents in the vault with aggregated usage stats (no mediaId). */
  async listDocuments(associationId: string) {
    await this.findById(associationId);

    const [docs, usedRaw] = await Promise.all([
      this.docRepo.find({
        where: { associationId },
        order: { createdAt: 'DESC' },
        select: {
          id: true,
          associationId: true,
          name: true,
          description: true,
          mimeType: true,
          size: true,
          uploadedBy: true,
          visibility: true,
          originalFilename: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.docRepo
        .createQueryBuilder('d')
        .select('COALESCE(SUM(d.size), 0)', 'total')
        .where('d.associationId = :associationId', { associationId })
        .getRawOne<{ total: string }>(),
    ]);

    const asso = await this.assoRepo.findOne({
      where: { id: associationId },
      select: { documentQuotaBytes: true },
    });
    const quotaBytes = Number(asso?.documentQuotaBytes ?? 524288000);
    const usedBytes = Number(usedRaw?.total ?? 0);

    return {
      documents: docs.map((d) => ({ ...d, size: Number(d.size) })),
      usedBytes,
      quotaBytes,
    };
  }

  /**
   * Registers a new document in the vault.
   * Returns HTTP 409 if a document with the same name (case-insensitive) already exists.
   * Returns HTTP 413 if the upload would exceed the quota.
   */
  async createDocument(associationId: string, dto: CreateAssociationDocumentDto, userId: string) {
    const asso = await this.assoRepo.findOne({
      where: { id: associationId },
      select: { id: true, documentQuotaBytes: true },
    });
    if (!asso) throw new NotFoundException('Association not found');

    // Duplicate name check
    const existing = await this.docRepo
      .createQueryBuilder('d')
      .where('d.associationId = :associationId', { associationId })
      .andWhere('LOWER(d.name) = LOWER(:name)', { name: dto.name })
      .getOne();

    if (existing) {
      throw new ConflictException({
        conflict: true,
        existingDocId: existing.id,
        message: `A document named "${existing.name}" already exists in this vault`,
      });
    }

    // Quota check
    const usedRaw = await this.docRepo
      .createQueryBuilder('d')
      .select('COALESCE(SUM(d.size), 0)', 'total')
      .where('d.associationId = :associationId', { associationId })
      .getRawOne<{ total: string }>();
    const usedBytes = Number(usedRaw?.total ?? 0);
    const quotaBytes = Number(asso.documentQuotaBytes ?? 524288000);

    if (usedBytes + dto.size > quotaBytes) {
      throw new PayloadTooLargeException(
        `Upload would exceed the vault quota (${quotaBytes} bytes). Currently used: ${usedBytes} bytes.`
      );
    }

    const doc = this.docRepo.create({
      associationId,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      mediaId: dto.mediaId,
      mimeType: dto.mimeType,
      size: dto.size,
      uploadedBy: userId,
      // New documents are private until the association explicitly shares them.
      visibility: 'private',
      originalFilename: dto.originalFilename?.trim() || dto.name.trim(),
    });
    const saved = await this.docRepo.save(doc);
    this.logger.debug(
      `Vault document "${sanitizeLog(saved.name)}" (${sanitizeLog(saved.id)}) created for asso ${sanitizeLog(associationId)}`
    );
    return { ...saved, size: Number(saved.size) };
  }

  /** Returns full document detail including mediaId (for download). Requires MANAGE_DOCUMENTS. */
  async getDocumentDetail(associationId: string, docId: string) {
    await this.findById(associationId);
    const doc = await this.docRepo.findOne({ where: { id: docId, associationId } });
    if (!doc) throw new NotFoundException('Document not found');
    return { ...doc, size: Number(doc.size) };
  }

  /** Deletes a document record and attempts to delete the media blob. */
  async deleteDocument(
    associationId: string,
    docId: string,
    authorization: string | undefined
  ): Promise<{ ok: boolean }> {
    await this.findById(associationId);
    const doc = await this.docRepo.findOne({ where: { id: docId, associationId } });
    if (!doc) throw new NotFoundException('Document not found');

    await this.docRepo.delete(docId);
    this.logger.debug(
      `Vault document "${sanitizeLog(doc.name)}" (${sanitizeLog(docId)}) deleted from asso ${sanitizeLog(associationId)}`
    );

    const bearer = authorization?.trim();
    if (bearer?.startsWith('Bearer ')) {
      await this.deleteMediaBestEffort(doc.mediaId, bearer);
    }
    return { ok: true };
  }

  /**
   * Renames a document's display name and/or changes its visibility (private/public).
   * A password-protected document (has a `[pw:…]` marker) can never be made public:
   * the server lacks the password, so a reviewer could not derive its CEK. Requires
   * MANAGE_DOCUMENTS (enforced by the controller guard).
   */
  async updateDocument(associationId: string, docId: string, dto: UpdateAssociationDocumentDto) {
    await this.findById(associationId);
    const doc = await this.docRepo.findOne({ where: { id: docId, associationId } });
    if (!doc) throw new NotFoundException('Document not found');

    const patch: Partial<AssociationDocument> = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Document name cannot be empty');
      const clash = await this.docRepo
        .createQueryBuilder('d')
        .where('d.associationId = :associationId', { associationId })
        .andWhere('d.id <> :docId', { docId })
        .andWhere('LOWER(d.name) = LOWER(:name)', { name })
        .getOne();
      if (clash) {
        throw new ConflictException(
          `A document named "${clash.name}" already exists in this vault`
        );
      }
      patch.name = name;
    }

    if (dto.visibility !== undefined) {
      if (dto.visibility === 'public' && this.hasPasswordMarker(doc.description)) {
        throw new BadRequestException('A password-protected document cannot be made public');
      }
      patch.visibility = dto.visibility;
    }

    if (Object.keys(patch).length > 0) {
      await this.docRepo.update({ id: docId, associationId }, patch);
      this.logger.debug(
        `Vault document ${sanitizeLog(docId)} updated (${Object.keys(patch).join(', ')})`
      );
    }
    const updated = await this.docRepo.findOne({ where: { id: docId, associationId } });
    return { ...updated!, size: Number(updated!.size) };
  }

  // ── Document reviewers (cross-association public-document access) ────────────

  /** True when a `[pw:<hex>]` password-protection marker is present. */
  private hasPasswordMarker(description: string | null): boolean {
    return /\[pw:[0-9a-f]+\]/.test(description ?? '');
  }

  /** Extracts the CEK salt from a leading `[s:<salt>]` marker, or null when absent. */
  private parseCekSalt(description: string | null): string | null {
    return description?.match(/^\[s:([^\]]+)\]/)?.[1] ?? null;
  }

  /**
   * Server-side mirror of the client's `deriveDocumentCek`: derives the 32-byte
   * AES-256-GCM content key for a non password-protected document via
   * HKDF-SHA256(vaultKey, salt=utf8(cekSalt), info="doc-vault"), returned as hex.
   * Used only for documents the association has marked public - the raw vault key
   * (which would unlock every document) is never handed to a reviewer.
   */
  private deriveDocumentCekHex(vaultKeyHex: string, cekSalt: string): string {
    const vaultKey = Buffer.from(vaultKeyHex, 'hex');
    const salt = Buffer.from(cekSalt, 'utf8');
    const info = Buffer.from('doc-vault', 'utf8');
    const derived = hkdfSync('sha256', vaultKey, salt, info, 32);
    return Buffer.from(derived).toString('hex');
  }

  /** True when the user holds a global document-reviewer grant. */
  async isDocumentReviewer(userId: string): Promise<boolean> {
    return (await this.reviewerGrantRepo.count({ where: { userId } })) > 0;
  }

  /** Lists all document-reviewer grants, newest first (admin/BDE management view). */
  async listDocumentReviewers() {
    const grants = await this.reviewerGrantRepo.find({ order: { createdAt: 'DESC' } });
    return grants.map((g) => ({
      userId: g.userId,
      grantedBy: g.grantedBy,
      createdAt: g.createdAt,
    }));
  }

  /** Grants document-reviewer access to a user (idempotent upsert). */
  async addDocumentReviewer(userId: string, grantedBy: string) {
    const target = userId.trim();
    if (!target) throw new BadRequestException('userId is required');
    const existing = await this.reviewerGrantRepo.findOne({ where: { userId: target } });
    if (existing) {
      return {
        userId: existing.userId,
        grantedBy: existing.grantedBy,
        createdAt: existing.createdAt,
      };
    }
    const grant = await this.reviewerGrantRepo.save(
      this.reviewerGrantRepo.create({ userId: target, grantedBy })
    );
    this.logger.debug(
      `Document-reviewer granted to ${sanitizeLog(target)} by ${sanitizeLog(grantedBy)}`
    );
    return { userId: grant.userId, grantedBy: grant.grantedBy, createdAt: grant.createdAt };
  }

  /** Revokes a user's document-reviewer grant. */
  async removeDocumentReviewer(userId: string): Promise<{ ok: boolean }> {
    await this.reviewerGrantRepo.delete({ userId });
    this.logger.debug(`Document-reviewer revoked from ${sanitizeLog(userId)}`);
    return { ok: true };
  }

  /**
   * Returns every association's *public* documents grouped by association, each
   * with a server-derived per-document CEK (hex) so an authorized reviewer can
   * decrypt them client-side. Private and password-protected documents are
   * excluded, and the raw vault key is never exposed.
   */
  async listReviewerDocuments() {
    const docs = await this.docRepo.find({
      where: { visibility: 'public' },
      order: { createdAt: 'DESC' },
    });
    if (docs.length === 0) return [];

    const assoIds = [...new Set(docs.map((d) => d.associationId))];
    const assos = await this.assoRepo.find({
      where: { id: In(assoIds) },
      select: { id: true, name: true, slug: true, logoUrl: true, documentVaultKey: true },
    });
    const assoById = new Map(assos.map((a) => [a.id, a]));

    const groups = new Map<string, ReviewerDocumentGroup>();

    for (const doc of docs) {
      const asso = assoById.get(doc.associationId);
      if (!asso?.documentVaultKey) continue;
      const cekSalt = this.parseCekSalt(doc.description);
      // Defensive: a public doc should never be password-protected, but skip if so.
      if (!cekSalt || this.hasPasswordMarker(doc.description)) continue;

      if (!groups.has(asso.id)) {
        groups.set(asso.id, {
          associationId: asso.id,
          associationName: asso.name,
          slug: asso.slug,
          logoUrl: asso.logoUrl ?? null,
          documents: [],
        });
      }
      groups.get(asso.id)!.documents.push({
        id: doc.id,
        name: doc.name,
        originalFilename: doc.originalFilename ?? null,
        mimeType: doc.mimeType,
        size: Number(doc.size),
        mediaId: doc.mediaId,
        cek: this.deriveDocumentCekHex(asso.documentVaultKey, cekSalt),
        createdAt: doc.createdAt,
      });
    }

    return [...groups.values()]
      .filter((g) => g.documents.length > 0)
      .sort((a, b) => a.associationName.localeCompare(b.associationName));
  }

  // ── Forms ─────────────────────────────────────────────────────────────────

  /** Returns all forms linked to this association, newest first (for the MANAGE_FORMS tab). */
  async listFormsByAssociation(associationId: string) {
    await this.findById(associationId);
    return this.formRepo.find({
      where: { associationId },
      order: { createdAt: 'DESC' },
      select: {
        id: true,
        title: true,
        description: true,
        basePrice: true,
        currency: true,
        allowCashPayment: true,
        createdAt: true,
      },
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

  /**
   * Unlinks the association's Stripe Connect account from Canari, letting the treasurer restart
   * onboarding from scratch. Local unlink only - the Stripe account itself (its dashboard, bank
   * details, any balance) is left untouched.
   */
  async clearStripeAccount(id: string) {
    await this.assoRepo.update(id, { stripeAccountId: null, stripeOnboardingComplete: false });
    await this.invalidatePostListCaches();
  }

  // ── Lydia helpers ────────────────────────────────────────────────────────
  // Own columns, independent from the Stripe ones above - an association keeps both links
  // regardless of which provider is currently active platform-wide (WP-LYDIA coexistence).

  /** Stores the Lydia Business vendor_token for an association and invalidates post-list caches. */
  async setLydiaAccountId(id: string, lydiaAccountId: string) {
    const asso = await this.findById(id);
    await this.assoRepo.update(id, { lydiaAccountId });
    await this.invalidatePostListCaches();
    return { ...asso, lydiaAccountId };
  }

  /** Flips lydiaOnboardingComplete to true once the Lydia Business is confirmed ready. */
  async markLydiaOnboardingComplete(id: string) {
    await this.assoRepo.update(id, { lydiaOnboardingComplete: true });
    await this.invalidatePostListCaches();
  }

  /**
   * Unlinks the association's Lydia Business from Canari, letting the treasurer restart
   * onboarding from scratch. Local unlink only - the Lydia Business itself is left untouched.
   */
  async clearLydiaAccount(id: string) {
    await this.assoRepo.update(id, { lydiaAccountId: null, lydiaOnboardingComplete: false });
    await this.invalidatePostListCaches();
  }

  /**
   * Reads the platform's currently active payment provider from core-service. Exposed for callers
   * (e.g. FormsService) that need it outside of resolvePaymentTarget - such as deciding whether to
   * pass Lydia's order_ref-shaped idempotency key on a form with no associated club.
   */
  async getActivePaymentProvider(): Promise<PaymentProviderId> {
    return fetchActivePaymentProvider(this.httpService, this.paymentBaseUrl);
  }

  /**
   * Resolves where an association's payments route, honoring an approved parent delegation AND
   * the platform's currently active provider (Stripe/Lydia keep independent account ids - see
   * payment-delegation.util.ts). Loads the parent only when the association delegates (approved).
   * Central resolver used by every payment path so delegation and provider selection are applied
   * uniformly. Lets a failure to reach core-service propagate - never guesses the active provider.
   */
  async resolvePaymentTarget(asso: Association): Promise<PaymentTarget> {
    const [provider, parent] = await Promise.all([
      this.getActivePaymentProvider(),
      isDelegating(asso)
        ? this.assoRepo.findOne({ where: { id: asso.paymentParentAssociationId } })
        : Promise.resolve(null),
    ]);
    return resolvePaymentTarget(asso, parent, provider);
  }

  /**
   * Returns the connect-style account id (Stripe or Lydia, whichever is active) an association's
   * payments route to, or null if none. Follows an approved parent delegation to the parent's account.
   */
  async getPaymentAccountId(id: string): Promise<string | null> {
    const asso = await this.assoRepo.findOne({ where: { id } });
    if (!asso) return null;
    return (await this.resolvePaymentTarget(asso)).connectAccountId;
  }

  /**
   * Ensures payments can be taken (own account onboarded, or an approved parent's account ready)
   * before accepting paid forms/purchases.
   * @throws BadRequestException when neither the association nor its approved parent can receive payments
   */
  async assertPaymentsReady(associationId: string): Promise<void> {
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) {
      throw new NotFoundException('Association not found');
    }
    const target = await this.resolvePaymentTarget(asso);
    if (target.ready) return;
    if (target.delegated) {
      throw new BadRequestException(
        'The parent association this club delegates payments to has not completed onboarding to receive payments.'
      );
    }
    if (!target.connectAccountId) {
      throw new BadRequestException('No payment account linked to this association.');
    }
    throw new BadRequestException(
      'This association has not yet completed onboarding to receive payments.'
    );
  }

  // ── Payment delegation (parent-association Stripe routing) ─────────────────

  /**
   * Returns this association's payment-delegation state for its own management UI: the chosen
   * parent (if any), the lifecycle status, and whether that parent can currently receive payments.
   */
  async getPaymentDelegation(associationId: string): Promise<{
    status: 'pending' | 'approved' | null;
    parentAssociationId: string | null;
    parentName: string | null;
    parentReady: boolean;
  }> {
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) throw new NotFoundException('Association not found');
    if (!asso.paymentParentAssociationId || !asso.paymentDelegationStatus) {
      return { status: null, parentAssociationId: null, parentName: null, parentReady: false };
    }
    const parent = await this.assoRepo.findOne({
      where: { id: asso.paymentParentAssociationId },
    });
    return {
      status: asso.paymentDelegationStatus,
      parentAssociationId: asso.paymentParentAssociationId,
      parentName: parent?.name ?? null,
      parentReady: !!parent?.stripeOnboardingComplete && !!parent?.stripeAccountId,
    };
  }

  /**
   * Requests payment delegation from `associationId` to `parentAssociationId`, setting status
   * `pending` until the parent approves. Rejects self-delegation, unknown parents, delegation
   * chains (a parent that itself delegates), and requesters that are themselves a parent to
   * other associations.
   */
  async requestPaymentDelegation(associationId: string, parentAssociationId: string) {
    this.logger.debug(
      `[DELEGATION] request assoc=${associationId.slice(0, 8)} -> parent=${parentAssociationId.slice(0, 8)}`
    );
    if (associationId === parentAssociationId) {
      throw new BadRequestException('An association cannot delegate payments to itself');
    }
    const [asso, parent] = await Promise.all([
      this.assoRepo.findOne({ where: { id: associationId } }),
      this.assoRepo.findOne({ where: { id: parentAssociationId } }),
    ]);
    if (!asso) throw new NotFoundException('Association not found');
    if (!parent) throw new NotFoundException('Parent association not found');

    // No chains: the parent must not itself route its payments to a further association.
    if (parent.paymentParentAssociationId) {
      throw new BadRequestException(
        'The chosen parent association itself delegates its payments and cannot be a parent'
      );
    }
    // The requester must not already be receiving delegated payments from other associations.
    const childCount = await this.assoRepo.count({
      where: { paymentParentAssociationId: associationId },
    });
    if (childCount > 0) {
      throw new BadRequestException(
        'This association already receives delegated payments from others and cannot delegate its own'
      );
    }

    await this.assoRepo.update(associationId, {
      paymentParentAssociationId: parentAssociationId,
      paymentDelegationStatus: 'pending',
    });
    return this.getPaymentDelegation(associationId);
  }

  /** Clears this association's payment delegation (the association cancels a pending/approved link). */
  async cancelPaymentDelegation(associationId: string) {
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) throw new NotFoundException('Association not found');
    await this.assoRepo.update(associationId, {
      paymentParentAssociationId: null,
      paymentDelegationStatus: null,
    });
    await this.invalidatePostListCaches();
    this.logger.log(`[DELEGATION] cancelled assoc=${associationId.slice(0, 8)}`);
    return { status: null, parentAssociationId: null, parentName: null, parentReady: false };
  }

  /**
   * Lists associations that requested or were granted delegation to `parentAssociationId`
   * (the parent's approval queue plus its active children).
   */
  async listDelegatedChildren(
    parentAssociationId: string
  ): Promise<
    Array<{ associationId: string; name: string; slug: string; status: 'pending' | 'approved' }>
  > {
    const children = await this.assoRepo.find({
      where: { paymentParentAssociationId: parentAssociationId },
      order: { name: 'ASC' },
    });
    return children
      .filter(
        (c) => c.paymentDelegationStatus === 'pending' || c.paymentDelegationStatus === 'approved'
      )
      .map((c) => ({
        associationId: c.id,
        name: c.name,
        slug: c.slug,
        status: c.paymentDelegationStatus,
      }));
  }

  /**
   * Approves a pending delegation request from `childId` to `parentAssociationId`. Requires the
   * parent to have completed its own Stripe Connect onboarding, since it becomes the receiver.
   */
  async approvePaymentDelegation(parentAssociationId: string, childId: string) {
    const [parent, child] = await Promise.all([
      this.assoRepo.findOne({ where: { id: parentAssociationId } }),
      this.assoRepo.findOne({ where: { id: childId } }),
    ]);
    if (!parent) throw new NotFoundException('Parent association not found');
    if (!child) throw new NotFoundException('Association not found');
    if (
      child.paymentParentAssociationId !== parentAssociationId ||
      child.paymentDelegationStatus !== 'pending'
    ) {
      throw new BadRequestException('No pending delegation request from this association');
    }
    if (!parent.stripeOnboardingComplete || !parent.stripeAccountId) {
      throw new BadRequestException(
        'Complete your Stripe Connect onboarding before accepting delegated payments'
      );
    }
    await this.assoRepo.update(childId, { paymentDelegationStatus: 'approved' });
    await this.invalidatePostListCaches();
    this.logger.log(
      `[DELEGATION] approved parent=${parentAssociationId.slice(0, 8)} child=${childId.slice(0, 8)}`
    );
    return { associationId: childId, status: 'approved' as const };
  }

  /** Rejects a pending request or revokes an approved delegation from `childId`, clearing its link. */
  async rejectPaymentDelegation(parentAssociationId: string, childId: string) {
    const child = await this.assoRepo.findOne({ where: { id: childId } });
    if (!child) throw new NotFoundException('Association not found');
    if (child.paymentParentAssociationId !== parentAssociationId) {
      throw new BadRequestException('This association does not delegate payments to you');
    }
    await this.assoRepo.update(childId, {
      paymentParentAssociationId: null,
      paymentDelegationStatus: null,
    });
    await this.invalidatePostListCaches();
    this.logger.log(
      `[DELEGATION] rejected parent=${parentAssociationId.slice(0, 8)} child=${childId.slice(0, 8)}`
    );
    return { associationId: childId, status: null };
  }

  /**
   * Ensures `parentId` is the approved payment-delegation parent of `childId`, gating a parent's
   * read access to a delegated child's accounting. Returns the child association.
   * @throws ForbiddenException when there is no approved delegation from the child to this parent
   */
  async assertIsApprovedParentOf(parentId: string, childId: string): Promise<Association> {
    const child = await this.assoRepo.findOne({ where: { id: childId } });
    if (!child) throw new NotFoundException('Association not found');
    if (
      child.paymentParentAssociationId !== parentId ||
      child.paymentDelegationStatus !== 'approved'
    ) {
      throw new ForbiddenException('This association does not delegate its payments to you');
    }
    return child;
  }

  // ── Post authorship check ─────────────────────────────────────────────────

  /**
   * Returns true if the user may publish in the association's name.
   *
   * The one right that also asks whether the association EXISTS: the answer decides whether a post
   * row may name this id, and a post naming a deleted association is a row nothing can render.
   * `POST_AS_ASSO` is in `SUPER_ADMIN_EXCLUDED_FLAGS`, so a BDE super-admin does not borrow another
   * association's voice.
   */
  async canPostAs(
    userId: string,
    associationId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    if (!(await this.mayAct(userId, associationId, AssociationPermissionFlag.POST_AS_ASSO, opts))) {
      return false;
    }
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    return !!asso;
  }

  /**
   * Returns true if the user may manage Stripe Connect for the association.
   *
   * `MANAGE_STRIPE_CONNECT` is in `SUPER_ADMIN_EXCLUDED_FLAGS`: it points payouts at a bank
   * account, so it stays with the association's own people and the platform administrator.
   *
   * Existence is checked for the same reason as `canPostAs`: core-service asks this before opening
   * a Connect account against the id, so a yes on an association nobody has must not be returned.
   */
  async canManageStripeConnect(
    userId: string,
    associationId: string,
    opts?: { isGlobalAdmin?: boolean }
  ): Promise<boolean> {
    const flag = AssociationPermissionFlag.MANAGE_STRIPE_CONNECT;
    if (!(await this.mayAct(userId, associationId, flag, opts))) return false;
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    return !!asso;
  }
}
