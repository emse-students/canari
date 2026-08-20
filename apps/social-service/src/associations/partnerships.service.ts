import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { PartnershipCard, PartnershipClaimMode } from './entities/partnership-card.entity';
import { PartnershipCode } from './entities/partnership-code.entity';
import { Association } from './entities/association.entity';
import { ProductsService } from './products.service';
import { AssociationsService } from './associations.service';
import {
  AddPartnershipCodesDto,
  CreatePartnershipCardDto,
  UpdatePartnershipCardDto,
} from './dto/partnership.dto';

/** Postgres error code for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

/** Same limits as the association logo upload (`AssociationsService.setLogoFromUpload`). */
const ICON_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_ICON_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** A partnership card annotated with the requesting user's cotisation status, for gating/labeling. */
export type PartnershipCardView = PartnershipCard & { viewerIsCotisant: boolean };

/** A partnership card as the manage view sees it: claim-pool stock alongside the card itself. */
export type ManagedPartnershipCard = PartnershipCard & { claimedCount: number; totalCodes: number };

/** What a student receives on a successful claim - shape depends on the card's `claimMode`. */
export interface PartnershipClaimResult {
  mode: PartnershipClaimMode;
  code?: string;
  staticText?: string;
}

/** A claimed code as the admin claims view sees it, with the claimant's display name. */
export interface PartnershipClaimRow {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  code: string;
  claimedAt: string;
}

/**
 * CRUD for association partnership cards and the concurrency-safe claiming of their codes.
 *
 * `code_pool` claiming has two guarantees to keep under concurrent requests: a student never
 * gets a code twice for the same card (idempotent revisit), and two students never get the same
 * code. See `claimPoolCode` for how the partial unique index on `(cardId, claimedByUserId)`
 * (migration 047) and `FOR UPDATE SKIP LOCKED` combine to provide both.
 */
@Injectable()
export class PartnershipsService {
  private readonly logger = new Logger(PartnershipsService.name);

  constructor(
    @InjectRepository(PartnershipCard)
    private readonly cardRepo: Repository<PartnershipCard>,
    @InjectRepository(PartnershipCode)
    private readonly codeRepo: Repository<PartnershipCode>,
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>,
    private readonly productsService: ProductsService,
    private readonly associationsService: AssociationsService
  ) {}

  // ── Student-facing reads ─────────────────────────────────────────────────

  /** Active partnership cards for one association, shown on its own page. */
  async listActiveByAssoc(associationId: string, userId: string): Promise<PartnershipCardView[]> {
    const cards = await this.cardRepo.find({
      where: { associationId, isActive: true },
      order: { createdAt: 'ASC' },
    });
    return this.annotateViewerCotisant(cards, userId);
  }

  /** Active partnership cards across every association, shown on the shop page. */
  async listAllActive(userId: string): Promise<PartnershipCardView[]> {
    const cards = await this.cardRepo.find({
      where: { isActive: true },
      order: { associationId: 'ASC', createdAt: 'ASC' },
    });
    return this.annotateViewerCotisant(cards, userId);
  }

  /**
   * Strips `sharedCode` before a card leaves the service on a listing route: revealing it is what
   * `claimCard` is FOR, gated on `membersOnly` there. Returning it here would let anyone read a
   * `shared_code` card's code straight off the list response, bypassing that gate entirely -
   * the same shape of leak `toSafeProduct`/`toSafeAssociation` close for other secrets.
   */
  private toStudentCard<T extends PartnershipCard>(card: T): T {
    return { ...card, sharedCode: null };
  }

  /** Annotates each card with whether `userId` is a cotisant of its owning association. */
  private async annotateViewerCotisant(
    cards: PartnershipCard[],
    userId: string
  ): Promise<PartnershipCardView[]> {
    const assocIds = [...new Set(cards.map((c) => c.associationId))];
    if (assocIds.length === 0) return [];
    const assos = await this.assoRepo.find({ where: { id: In(assocIds) } });
    const entries = await Promise.all(
      assos.map(async (a) => [a.id, await this.productsService.isBuyerCotisant(a, userId)] as const)
    );
    const cotisantByAssoc = new Map(entries);
    return cards.map((c) => ({
      ...this.toStudentCard(c),
      viewerIsCotisant: cotisantByAssoc.get(c.associationId) ?? false,
    }));
  }

  // ── Admin CRUD ────────────────────────────────────────────────────────────

  /** All cards for an association including inactive ones, with claim-pool stock counts. Requires MANAGE_PARTNERSHIPS. */
  async listAllForManage(associationId: string): Promise<ManagedPartnershipCard[]> {
    const cards = await this.cardRepo.find({
      where: { associationId },
      order: { createdAt: 'ASC' },
    });
    const codePoolIds = cards.filter((c) => c.claimMode === 'code_pool').map((c) => c.id);
    const counts = new Map<string, { claimed: number; total: number }>();
    if (codePoolIds.length > 0) {
      const rows: { cardId: string; claimed: string; total: string }[] =
        await this.codeRepo.manager.query(
          `SELECT "cardId",
                COUNT(*) FILTER (WHERE "claimedByUserId" IS NOT NULL) AS claimed,
                COUNT(*) AS total
         FROM partnership_codes
         WHERE "cardId" = ANY($1)
         GROUP BY "cardId"`,
          [codePoolIds]
        );
      rows.forEach((r) =>
        counts.set(r.cardId, { claimed: Number(r.claimed), total: Number(r.total) })
      );
    }
    return cards.map((c) => ({
      ...c,
      claimedCount: counts.get(c.id)?.claimed ?? 0,
      totalCodes: counts.get(c.id)?.total ?? 0,
    }));
  }

  /** Creates a partnership card. Requires MANAGE_PARTNERSHIPS. */
  async create(associationId: string, dto: CreatePartnershipCardDto): Promise<PartnershipCard> {
    this.assertModeShape(dto.claimMode, dto);
    this.logger.debug(
      `[PARTNERSHIP] create card: association=${associationId.slice(0, 8)} mode=${dto.claimMode}`
    );
    const card = this.cardRepo.create({
      associationId,
      title: dto.title,
      description: dto.description ?? null,
      link: dto.link ?? null,
      claimMode: dto.claimMode,
      sharedCode: dto.claimMode === 'shared_code' ? (dto.sharedCode ?? null) : null,
      staticText: dto.claimMode === 'text' ? (dto.staticText ?? null) : null,
      membersOnly: dto.membersOnly ?? false,
    });
    return this.cardRepo.save(card);
  }

  /** Updates a partnership card's mutable fields. `claimMode` cannot change - see the DTO's doc comment. Requires MANAGE_PARTNERSHIPS. */
  async update(
    associationId: string,
    cardId: string,
    dto: UpdatePartnershipCardDto
  ): Promise<PartnershipCard> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, associationId } });
    if (!card) throw new NotFoundException('Partnership not found');
    this.assertUpdateModeShape(card.claimMode, dto);
    Object.assign(card, dto);
    return this.cardRepo.save(card);
  }

  /** Deletes a partnership card. Its codes cascade-delete (FK, migration 047). Requires MANAGE_PARTNERSHIPS. */
  async delete(associationId: string, cardId: string): Promise<void> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, associationId } });
    if (!card) throw new NotFoundException('Partnership not found');
    await this.cardRepo.remove(card);
  }

  /**
   * Uploads a decorative icon for a partnership card (e.g. the partner brand's logo), replacing
   * any existing one. Same validation and media-service delegation as
   * `AssociationsService.setLogoFromUpload`.
   */
  async setCardIcon(
    associationId: string,
    cardId: string,
    file: { buffer: Buffer; mimetype: string; size: number },
    authorization: string | undefined
  ): Promise<PartnershipCard> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, associationId } });
    if (!card) throw new NotFoundException('Partnership not found');
    if (!authorization?.startsWith('Bearer ')) {
      throw new BadRequestException('Missing authorization header');
    }
    if (file.size > ICON_MAX_BYTES) {
      throw new BadRequestException(`Icon must be at most ${ICON_MAX_BYTES} bytes`);
    }
    if (!ALLOWED_ICON_MIMES.has(file.mimetype?.toLowerCase() ?? '')) {
      throw new BadRequestException('Icon must be JPEG, PNG, or WebP');
    }

    const oldMediaId = card.iconMediaId;
    const mediaId = await this.associationsService.uploadPublicImage(file, authorization);
    card.iconMediaId = mediaId;
    card.iconUrl = `/api/media/public/${mediaId}?v=${Date.now()}`;
    const saved = await this.cardRepo.save(card);

    if (oldMediaId && oldMediaId !== mediaId) {
      await this.associationsService.deleteMediaBestEffort(oldMediaId, authorization);
    }
    return saved;
  }

  /** Removes a partnership card's decorative icon, reverting it to the Handshake fallback. */
  async clearCardIcon(
    associationId: string,
    cardId: string,
    authorization: string | undefined
  ): Promise<PartnershipCard> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, associationId } });
    if (!card) throw new NotFoundException('Partnership not found');
    const oldMediaId = card.iconMediaId;
    card.iconMediaId = null;
    card.iconUrl = null;
    const saved = await this.cardRepo.save(card);

    if (oldMediaId && authorization?.startsWith('Bearer ')) {
      await this.associationsService.deleteMediaBestEffort(oldMediaId, authorization);
    }
    return saved;
  }

  /**
   * Rejects a mode/field mismatch `@ValidateIf` can't express on its own: `@ValidateIf` skips
   * validating a field entirely when its condition is false, so e.g. a `text` DTO that also
   * carries `sharedCode` would otherwise pass DTO validation silently.
   */
  private assertModeShape(
    claimMode: PartnershipClaimMode,
    fields: { sharedCode?: string; staticText?: string }
  ): void {
    if (claimMode !== 'shared_code' && fields.sharedCode) {
      throw new BadRequestException('sharedCode may only be set on a shared_code partnership');
    }
    if (claimMode !== 'text' && fields.staticText) {
      throw new BadRequestException('staticText may only be set on a text partnership');
    }
    if (claimMode === 'shared_code' && !fields.sharedCode) {
      throw new BadRequestException('sharedCode is required for shared_code mode');
    }
    if (claimMode === 'text' && !fields.staticText) {
      throw new BadRequestException('staticText is required for text mode');
    }
  }

  /** Same check as `assertModeShape`, but against an EXISTING card's mode - only touched fields are validated. */
  private assertUpdateModeShape(
    claimMode: PartnershipClaimMode,
    dto: UpdatePartnershipCardDto
  ): void {
    if (dto.sharedCode !== undefined && claimMode !== 'shared_code') {
      throw new BadRequestException('sharedCode may only be set on a shared_code partnership');
    }
    if (dto.staticText !== undefined && claimMode !== 'text') {
      throw new BadRequestException('staticText may only be set on a text partnership');
    }
  }

  // ── Codes ────────────────────────────────────────────────────────────────

  /** Adds codes to a `code_pool` card's stock, skipping any already present. Requires MANAGE_PARTNERSHIPS. */
  async addCodes(
    associationId: string,
    cardId: string,
    dto: AddPartnershipCodesDto
  ): Promise<{ added: number; totalCodes: number }> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, associationId } });
    if (!card) throw new NotFoundException('Partnership not found');
    if (card.claimMode !== 'code_pool') {
      throw new BadRequestException('Codes can only be added to a code_pool partnership');
    }

    const existing = await this.codeRepo.find({ where: { cardId }, select: { code: true } });
    const existingCodes = new Set(existing.map((c) => c.code));
    const seen = new Set<string>();
    const toInsert: string[] = [];
    for (const raw of dto.codes) {
      const code = raw.trim();
      if (!code || existingCodes.has(code) || seen.has(code)) continue;
      seen.add(code);
      toInsert.push(code);
    }

    if (toInsert.length > 0) {
      await this.codeRepo.save(toInsert.map((code) => this.codeRepo.create({ cardId, code })));
      this.logger.log(
        `[PARTNERSHIP] added ${toInsert.length} code(s) to card=${cardId.slice(0, 8)}, ${dto.codes.length - toInsert.length} skipped as duplicates`
      );
    }

    return { added: toInsert.length, totalCodes: existingCodes.size + toInsert.length };
  }

  /** Lists claimed codes for a `code_pool` card with claimant display names. Requires MANAGE_PARTNERSHIPS. */
  async listClaims(associationId: string, cardId: string): Promise<PartnershipClaimRow[]> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, associationId } });
    if (!card) throw new NotFoundException('Partnership not found');

    const claims = await this.codeRepo.find({
      where: { cardId, claimedByUserId: Not(IsNull()) },
      order: { claimedAt: 'ASC' },
    });
    if (claims.length === 0) return [];

    const userIds = [...new Set(claims.map((c) => c.claimedByUserId as string))];
    const rows: { id: string; firstName: string | null; lastName: string | null }[] =
      await this.codeRepo.manager.query(
        `SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1)`,
        [userIds]
      );
    const names = new Map(rows.map((r) => [r.id, r]));

    return claims.map((c) => ({
      userId: c.claimedByUserId as string,
      firstName: names.get(c.claimedByUserId as string)?.firstName ?? null,
      lastName: names.get(c.claimedByUserId as string)?.lastName ?? null,
      code: c.code,
      claimedAt: (c.claimedAt as Date).toISOString(),
    }));
  }

  // ── Claiming ──────────────────────────────────────────────────────────────

  /** Claims a partnership card for a student: any logged-in user, gated only on `membersOnly`. */
  async claimCard(cardId: string, userId: string): Promise<PartnershipClaimResult> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, isActive: true } });
    if (!card) throw new NotFoundException('Partnership not found');

    if (card.membersOnly) {
      const asso = await this.assoRepo.findOne({ where: { id: card.associationId } });
      if (!asso) throw new NotFoundException('Association not found');
      const isCotisant = await this.productsService.isBuyerCotisant(asso, userId);
      this.logger.debug(
        `[PARTNERSHIP] claim gate: card=${cardId.slice(0, 8)} user=${userId.slice(0, 8)} isCotisant=${isCotisant}`
      );
      if (!isCotisant) {
        throw new ForbiddenException("This partnership is reserved to the association's cotisants");
      }
    }

    if (card.claimMode === 'shared_code') {
      return { mode: 'shared_code', code: card.sharedCode ?? undefined };
    }
    if (card.claimMode === 'text') {
      return { mode: 'text', staticText: card.staticText ?? undefined };
    }
    return this.claimPoolCode(cardId, userId);
  }

  /**
   * Assigns a student their code for a `code_pool` card, idempotently.
   *
   * 1. If this student already holds a code for this card, return it unchanged - a revisit must
   *    never consume a second one.
   * 2. Otherwise, inside a transaction: lock and take the oldest unclaimed row with
   *    `FOR UPDATE SKIP LOCKED` (so concurrent claimants never block on each other or receive the
   *    same row) and mark it claimed.
   * 3. The partial unique index on `(cardId, claimedByUserId)` (migration 047) is the second,
   *    cheaper guarantee: it catches the narrow race where the SAME user's two concurrent
   *    first-visits both pass step 1 before either commits step 2, each locking a DIFFERENT
   *    unclaimed row - one of the two UPDATEs then violates the index, and on that conflict we
   *    re-read step 1's result rather than erroring, since by then the other request has committed
   *    the row this user should see.
   */
  private async claimPoolCode(cardId: string, userId: string): Promise<PartnershipClaimResult> {
    const existing = await this.findClaimedCode(cardId, userId);
    if (existing) return { mode: 'code_pool', code: existing.code };

    try {
      const code = await this.codeRepo.manager.transaction(async (manager) => {
        const locked: { id: string }[] = await manager.query(
          `SELECT id FROM partnership_codes
           WHERE "cardId" = $1 AND "claimedByUserId" IS NULL
           ORDER BY "createdAt" ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
          [cardId]
        );
        const row = locked[0];
        if (!row) throw new BadRequestException('No codes left for this partnership');

        const updated: { code: string }[] = await manager.query(
          `UPDATE partnership_codes
           SET "claimedByUserId" = $1, "claimedAt" = now()
           WHERE id = $2
           RETURNING code`,
          [userId, row.id]
        );
        return updated[0].code;
      });
      this.logger.log(
        `[PARTNERSHIP] claimed: card=${cardId.slice(0, 8)} user=${userId.slice(0, 8)}`
      );
      return { mode: 'code_pool', code };
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        const afterRace = await this.findClaimedCode(cardId, userId);
        if (afterRace) return { mode: 'code_pool', code: afterRace.code };
      }
      throw err;
    }
  }

  private async findClaimedCode(cardId: string, userId: string): Promise<PartnershipCode | null> {
    return this.codeRepo.findOne({ where: { cardId, claimedByUserId: userId } });
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === UNIQUE_VIOLATION
    );
  }
}
