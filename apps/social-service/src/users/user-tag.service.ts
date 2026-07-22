import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { UserTag } from './entities/user-tag.entity';
import { CotisationMode, deriveCotisationTag } from '../associations/cotisation-tag.util';

/** Data required to grant or renew a membership tag. */
export interface GrantTagData {
  userId: string;
  tagName: string;
  issuingAssocId?: string | null;
  grantedBy: string;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

/** One row of an association's active cotisant roster, enriched with shared-`users`-table fields. */
export interface CotisantRosterItem {
  /** `user_tags` primary key - used to revoke the cotisant from the roster. */
  tagId: string;
  userId: string;
  tagName: string;
  grantedAt: Date;
  expiresAt: Date | null;
  firstName: string | null;
  lastName: string | null;
  promo: number | null;
}

/** Paginated result of `UserTagService.listCotisants`. */
export interface CotisantRosterPage {
  items: CotisantRosterItem[];
  total: number;
  hasMore: boolean;
}

/** Raw row shape returned by the roster/export SQL (both use the same columns). */
interface RawCotisantRow {
  id: string;
  userId: string;
  tagName: string;
  grantedAt: Date | string;
  expiresAt: Date | string | null;
  firstName: string | null;
  lastName: string | null;
  promo: number | null;
}

const DEFAULT_ROSTER_LIMIT = 50;
const MAX_ROSTER_LIMIT = 200;

/** Maps a raw SQL row to a `CotisantRosterItem`, normalizing date fields. */
function toRosterItem(row: RawCotisantRow): CotisantRosterItem {
  return {
    tagId: row.id,
    userId: row.userId,
    tagName: row.tagName,
    grantedAt: row.grantedAt instanceof Date ? row.grantedAt : new Date(row.grantedAt),
    expiresAt: row.expiresAt
      ? row.expiresAt instanceof Date
        ? row.expiresAt
        : new Date(row.expiresAt)
      : null,
    firstName: row.firstName,
    lastName: row.lastName,
    promo: row.promo,
  };
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
   * Pass `manager` to run within an existing transaction (e.g. alongside a sibling-tier revoke).
   */
  async grantOrRenew(data: GrantTagData, manager?: EntityManager): Promise<UserTag> {
    const repo = manager ? manager.getRepository(UserTag) : this.repo;
    const existing = await repo.findOne({
      where: { userId: data.userId, tagName: data.tagName },
    });
    if (existing) {
      existing.expiresAt = data.expiresAt !== undefined ? data.expiresAt : existing.expiresAt;
      if (data.metadata) existing.metadata = { ...existing.metadata, ...data.metadata };
      const saved = await repo.save(existing);
      this.logger.log(
        `[UserTag] Renewed ${data.tagName} for ${data.userId} (expiresAt=${saved.expiresAt?.toISOString() ?? 'never'})`
      );
      return saved;
    }
    const tag = repo.create({
      userId: data.userId,
      tagName: data.tagName,
      issuingAssocId: data.issuingAssocId ?? null,
      grantedBy: data.grantedBy,
      expiresAt: data.expiresAt ?? null,
      metadata: data.metadata ?? {},
    });
    const saved = await repo.save(tag);
    this.logger.log(`[UserTag] Granted ${data.tagName} to ${data.userId} by ${data.grantedBy}`);
    return saved;
  }

  /**
   * Deletes a user's tag by name (rather than by primary key like `revoke`) - used for XOR
   * sibling-tier enforcement, where the tag id isn't known ahead of time. No-op if not held.
   * Pass `manager` to run within an existing transaction.
   */
  async revokeByName(userId: string, tagName: string, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(UserTag) : this.repo;
    const res = await repo.delete({ userId, tagName });
    if (res.affected) {
      this.logger.log(`[UserTag] Revoked ${tagName} for ${userId} (sibling-tier switch)`);
    }
  }

  /**
   * Grants (or renews) the association's canonical cotisation tag to a user - the manual
   * "add a cotisant" action (D10: tag only, no payment recorded). The tag name and expiry are
   * derived server-side from the association's slug and validity mode (see `deriveCotisationTag`),
   * so the frontend never needs to know the tag convention.
   */
  async grantCotisant(assocId: string, userId: string, grantedBy: string): Promise<UserTag> {
    const rows: { slug: string; cotisationMode: CotisationMode | null }[] =
      await this.repo.manager.query(
        `SELECT slug, "cotisationMode" FROM associations WHERE id = $1`,
        [assocId]
      );
    const asso = rows[0];
    if (!asso) throw new NotFoundException('Association not found');
    if (!asso.cotisationMode) {
      throw new BadRequestException('Cotisation is not enabled for this association');
    }
    const { tagName, expiresAt } = deriveCotisationTag(asso.slug, asso.cotisationMode);
    this.logger.debug(
      `[UserTag] grantCotisant assoc=${assocId} user=${userId.slice(0, 8)} tag=${tagName}`
    );
    return this.grantOrRenew({ userId, tagName, issuingAssocId: assocId, grantedBy, expiresAt });
  }

  /** Returns true when the user has an active (non-expired) tag with the given name. */
  async hasActiveTag(userId: string, tagName: string): Promise<boolean> {
    const tag = await this.repo.findOne({ where: { userId, tagName } });
    if (!tag) return false;
    if (!tag.expiresAt) return true;
    return tag.expiresAt > new Date();
  }

  /**
   * Returns the user's active (non-expired) tag row with the given name, or null if absent or
   * expired. Like `hasActiveTag` but also surfaces `expiresAt` - used where a caller needs the
   * expiry itself, not just a yes/no (e.g. the Cercle inbound cotisant-status check).
   */
  async getActiveTag(userId: string, tagName: string): Promise<UserTag | null> {
    const tag = await this.repo.findOne({ where: { userId, tagName } });
    if (!tag) return null;
    if (tag.expiresAt && tag.expiresAt <= new Date()) return null;
    return tag;
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

  /** Distinct tag names ever issued by an association (including expired). */
  async listDistinctNamesForAssoc(assocId: string): Promise<string[]> {
    const rows = await this.repo
      .createQueryBuilder('t')
      .select('DISTINCT t.tagName', 'tagName')
      .where('t.issuingAssocId = :assocId', { assocId })
      .orderBy('t.tagName', 'ASC')
      .getRawMany<{ tagName: string }>();
    return rows.map((r) => r.tagName).filter(Boolean);
  }

  /**
   * Returns a search+offset-paginated page of the association's active cotisant roster
   * (D9: active tags only, i.e. `expiresAt IS NULL OR expiresAt > NOW()`), enriched with
   * `firstName`/`lastName`/`promo` from the shared `users` table.
   * Sorted `promo ASC NULLS LAST, lastName ASC, firstName ASC` so cotisants without a promo
   * (externals, staff) land in a "Sans promo" block at the end.
   */
  async listCotisants(
    assocId: string,
    opts: { search?: string; offset?: number; limit?: number } = {}
  ): Promise<CotisantRosterPage> {
    const search = opts.search?.trim() || null;
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const limit = Math.min(
      Math.max(1, Math.trunc(opts.limit ?? DEFAULT_ROSTER_LIMIT)),
      MAX_ROSTER_LIMIT
    );
    this.logger.debug(
      `[UserTag] listCotisants assoc=${assocId} search=${search ?? '-'} offset=${offset} limit=${limit}`
    );

    // $1=assocId, $2=search (nullable), $3=limit, $4=offset - parameterized, no string concatenation of user input.
    const searchClause = `AND ($2::text IS NULL OR u."firstName" ILIKE '%' || $2 || '%' OR u."lastName" ILIKE '%' || $2 || '%')`;
    const baseFrom = `FROM user_tags t
       INNER JOIN users u ON u.id = t."userId"
       WHERE t."issuingAssocId" = $1
         AND (t."expiresAt" IS NULL OR t."expiresAt" > NOW())
         ${searchClause}`;

    const countRows: { count: string }[] = await this.repo.manager.query(
      `SELECT COUNT(*)::text AS count ${baseFrom}`,
      [assocId, search]
    );
    const total = Number(countRows[0]?.count ?? 0);

    const rows: RawCotisantRow[] = await this.repo.manager.query(
      `SELECT t.id AS "id", t."userId" AS "userId", t."tagName" AS "tagName", t."createdAt" AS "grantedAt",
              t."expiresAt" AS "expiresAt", u."firstName" AS "firstName", u."lastName" AS "lastName",
              u.promo AS "promo"
       ${baseFrom}
       ORDER BY u.promo ASC NULLS LAST, u."lastName" ASC, u."firstName" ASC
       LIMIT $3 OFFSET $4`,
      [assocId, search, limit, offset]
    );

    const items = rows.map(toRosterItem);
    const hasMore = offset + items.length < total;
    this.logger.debug(
      `[UserTag] listCotisants assoc=${assocId} returned ${items.length}/${total} (hasMore=${hasMore})`
    );
    return { items, total, hasMore };
  }

  /**
   * Builds an XLSX export of the association's full active cotisant roster (no pagination),
   * same active-only filter and sort as `listCotisants`. Columns (D8): Nom, Prenom, Promo,
   * Cotisation, Date, Echeance - no email (PII, per the rework plan).
   */
  async exportCotisants(assocId: string): Promise<{ buffer: Buffer; title: string }> {
    this.logger.debug(`[UserTag] exportCotisants assoc=${assocId}`);

    const nameRows: { name: string }[] = await this.repo.manager.query(
      `SELECT name FROM associations WHERE id = $1`,
      [assocId]
    );
    const assocName = nameRows[0]?.name ?? 'cotisants';

    const rows: RawCotisantRow[] = await this.repo.manager.query(
      `SELECT t.id AS "id", t."userId" AS "userId", t."tagName" AS "tagName", t."createdAt" AS "grantedAt",
              t."expiresAt" AS "expiresAt", u."firstName" AS "firstName", u."lastName" AS "lastName",
              u.promo AS "promo"
       FROM user_tags t
       INNER JOIN users u ON u.id = t."userId"
       WHERE t."issuingAssocId" = $1
         AND (t."expiresAt" IS NULL OR t."expiresAt" > NOW())
       ORDER BY u.promo ASC NULLS LAST, u."lastName" ASC, u."firstName" ASC`,
      [assocId]
    );
    const items = rows.map(toRosterItem);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Cotisants');
    sheet.columns = [
      { header: 'Nom', key: 'lastName', width: 20 },
      { header: 'Prénom', key: 'firstName', width: 20 },
      { header: 'Promo', key: 'promo', width: 10 },
      { header: 'Cotisation', key: 'tagName', width: 30 },
      { header: 'Date', key: 'grantedAt', width: 14, style: { numFmt: 'dd/mm/yyyy' } },
      { header: 'Échéance', key: 'expiresAt', width: 14, style: { numFmt: 'dd/mm/yyyy' } },
    ];

    items.forEach((item) => {
      sheet.addRow({
        lastName: item.lastName ?? '',
        firstName: item.firstName ?? '',
        promo: item.promo ?? '',
        tagName: item.tagName,
        grantedAt: item.grantedAt,
        expiresAt: item.expiresAt ?? '',
      });
    });

    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer, title: `cotisants_${assocName}` };
  }
}
