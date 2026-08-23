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
  /** Tier product name (e.g. "Avec alcool") for multi-tier associations; null for the base tier. */
  tier: string | null;
}

/** One cotisation tier of an association, resolved to the tag it grants. */
export interface CotisationTierInfo {
  /** Named tier key (e.g. `"avec-alcool"`), or null for the base, un-suffixed tier. */
  variantKey: string | null;
  /** Membership product display name, e.g. `"Avec alcool"`. */
  name: string;
  /** Tag this tier grants for the CURRENT academic year (see `deriveCotisationTag`). */
  tagName: string;
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

/** Maps a raw SQL row to a `CotisantRosterItem`, normalizing date fields and attaching the tier label. */
function toRosterItem(row: RawCotisantRow, tierByTagName: Map<string, string>): CotisantRosterItem {
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
    tier: tierByTagName.get(row.tagName) ?? null,
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
   * Lists an association's cotisation tiers (its `membership` products), each resolved to the tag
   * it currently grants. Returns an empty list when the association has no cotisation mode.
   * The single source of truth for "which tiers exist", shared by the roster labels, the manual
   * grant's tier validation, and the XOR sibling revoke.
   *
   * Covers EVERY membership product, on sale or not: `isActive` says whether a tier can be bought
   * in the boutique right now, never whether it exists. A tier goes inactive on its own (a
   * seasonal forfait) or because the association has no Stripe account yet - and in both cases its
   * cotisants still hold its tag, so hiding it here would make them invisible to the roster, to
   * the manual grant's validation, and to the XOR revoke that must drop the sibling tag.
   */
  async listCotisationTiers(
    assocId: string,
    opts: { manager?: EntityManager } = {}
  ): Promise<CotisationTierInfo[]> {
    const runner = opts.manager ?? this.repo.manager;
    const assoRows: { slug: string; cotisationMode: CotisationMode | null }[] = await runner.query(
      `SELECT slug, "cotisationMode" FROM associations WHERE id = $1`,
      [assocId]
    );
    const asso = assoRows[0];
    if (!asso?.cotisationMode) return [];
    const cotisationMode = asso.cotisationMode;

    const products: { name: string; variantKey: string | null }[] = await runner.query(
      `SELECT name, "variantKey" FROM association_products
       WHERE "associationId" = $1 AND type = 'membership'
       ORDER BY "variantKey" ASC NULLS FIRST`,
      [assocId]
    );
    const now = new Date();
    return products.map((p) => ({
      variantKey: p.variantKey,
      name: p.name,
      tagName: deriveCotisationTag(asso.slug, cotisationMode, now, p.variantKey).tagName,
    }));
  }

  /**
   * XOR enforcement for multi-tier cotisations: revokes the user's tags for every tier of the
   * association OTHER than `keepVariantKey`, so a cotisant holds exactly one tier at a time.
   * A no-op for single-tier associations and for associations without a cotisation mode.
   *
   * The base tier participates like any other: an association that kept its auto-provisioned base
   * product alongside named tiers must not leave a buyer holding both, because the base tag
   * answers `tier: null` and would shadow the named one downstream.
   *
   * Pass `manager` to run inside the granting transaction, so a tier switch is atomic.
   */
  async revokeSiblingTierTags(
    assocId: string,
    userId: string,
    keepVariantKey: string | null,
    manager?: EntityManager
  ): Promise<void> {
    const tiers = await this.listCotisationTiers(assocId, { manager });
    if (tiers.length < 2) return;
    for (const tier of tiers) {
      if (tier.variantKey === keepVariantKey) continue;
      await this.revokeByName(userId, tier.tagName, manager);
    }
  }

  /**
   * Grants (or renews) one of the association's cotisation tiers to a user - the manual
   * "add a cotisant" action (D10: tag only, no payment recorded). The tag name and expiry are
   * derived server-side from the association's slug, validity mode and the chosen tier (see
   * `deriveCotisationTag`), so the frontend never needs to know the tag convention.
   *
   * `variantKey` names the tier and MUST match one of the association's membership products (on
   * sale or not); omit it for a single-tier association. The grant and the sibling-tier revoke share
   * one transaction, so a manual add can never leave a user holding two tiers at once - the same
   * XOR rule a paid purchase goes through.
   */
  async grantCotisant(
    assocId: string,
    userId: string,
    grantedBy: string,
    variantKey: string | null = null,
    metadata: Record<string, unknown> = {}
  ): Promise<UserTag> {
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

    const tiers = await this.listCotisationTiers(assocId);
    // Validate the tier against the association's own catalogue. An arbitrary variantKey would
    // mint a tag that no product grants and no gate checks - a cotisant nobody can see.
    if (variantKey !== null && !tiers.some((t) => t.variantKey === variantKey)) {
      throw new BadRequestException(`Unknown cotisation tier "${variantKey}"`);
    }
    // The same trap in reverse: an association that dropped its base tier in favour of named ones
    // has no un-suffixed tag, so defaulting to the base would grant a tag matching nothing.
    if (variantKey === null && tiers.length > 0 && !tiers.some((t) => t.variantKey === null)) {
      throw new BadRequestException('This association has no base tier - a tier must be chosen');
    }

    const { tagName, expiresAt } = deriveCotisationTag(
      asso.slug,
      asso.cotisationMode,
      new Date(),
      variantKey
    );
    this.logger.debug(
      `[UserTag] grantCotisant assoc=${assocId} user=${userId.slice(0, 8)} tier=${variantKey ?? 'base'} tag=${tagName}`
    );
    return this.repo.manager.transaction(async (manager) => {
      const tag = await this.grantOrRenew(
        { userId, tagName, issuingAssocId: assocId, grantedBy, expiresAt, metadata },
        manager
      );
      await this.revokeSiblingTierTags(assocId, userId, variantKey, manager);
      return tag;
    });
  }

  /**
   * Whether the user holds ANY of `assocId`'s cotisation tiers.
   *
   * This is the "is a member" question - the one a member price asks, since a discount for
   * cotisants means all of them.
   */
  async holdsAnyCotisation(userId: string, assocId: string): Promise<boolean> {
    return this.holdsOneOfTiers(userId, assocId, null, true);
  }

  /**
   * Whether the user holds `assocId`'s cotisation at one SPECIFIC tier; `null` is the base tier,
   * exactly as everywhere else in this service.
   *
   * Kept separate from `holdsAnyCotisation` rather than folded into one parameter: the two are
   * different questions, the caller always knows which it is asking, and any sentinel value
   * expressing "any" inside a `string` parameter is a type that cannot be trusted - a tier could
   * be named it.
   */
  async holdsCotisationTier(
    userId: string,
    assocId: string,
    variantKey: string | null
  ): Promise<boolean> {
    return this.holdsOneOfTiers(userId, assocId, variantKey, false);
  }

  /**
   * The one implementation behind both questions above.
   *
   * Derives the tier tags through `listCotisationTiers`, so the answer follows the association's
   * current slug, mode and academic year - a tag is never read from a stored literal. Returns false
   * when cotisations are not enabled, and when `variantKey` names a tier the association does not
   * (or no longer) sell: an unknown tier grants nothing, so it must not qualify anyone.
   */
  private async holdsOneOfTiers(
    userId: string,
    assocId: string,
    variantKey: string | null,
    anyTier: boolean
  ): Promise<boolean> {
    const tiers = await this.listCotisationTiers(assocId);
    if (tiers.length === 0) {
      this.logger.debug(
        `[UserTag] holdsCotisation assoc=${assocId.slice(0, 8)} has no cotisation tier - false`
      );
      return false;
    }
    const wanted = anyTier ? tiers : tiers.filter((t) => t.variantKey === variantKey);
    if (wanted.length === 0) {
      this.logger.warn(
        `[UserTag] holdsCotisation assoc=${assocId.slice(0, 8)} was asked for tier ` +
          `"${variantKey}", which this association does not sell - nobody qualifies. A form or ` +
          'product still names a tier that was renamed or deleted.'
      );
      return false;
    }
    return (await this.heldVariantKeys(userId, wanted)).length > 0;
  }

  /**
   * Every cotisation tier of `assocId` the user currently holds, by `variantKey` (`null` being the
   * base tier). Empty when they hold none, and when the association sells none.
   *
   * The list, not a yes/no, because a form's pricing grid asks WHICH tier somebody is on - a
   * cotisant "avec alcool" and a cotisant "sans alcool" land in different cells, and asking one
   * boolean question per bucket would re-derive the same tags once per column.
   */
  async listHeldCotisationTiers(userId: string, assocId: string): Promise<(string | null)[]> {
    const tiers = await this.listCotisationTiers(assocId);
    if (tiers.length === 0) {
      this.logger.debug(
        `[UserTag] listHeldCotisationTiers assoc=${assocId.slice(0, 8)} has no cotisation tier - none`
      );
      return [];
    }
    return this.heldVariantKeys(userId, tiers);
  }

  /**
   * Which of the given tiers the user has an active tag for. The one place a tier list becomes a
   * membership answer, so `holdsOneOfTiers` and `listHeldCotisationTiers` cannot disagree.
   */
  private async heldVariantKeys(
    userId: string,
    tiers: CotisationTierInfo[]
  ): Promise<(string | null)[]> {
    const held: (string | null)[] = [];
    for (const tier of tiers) {
      if (await this.hasActiveTag(userId, tier.tagName)) held.push(tier.variantKey);
    }
    return held;
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

  /**
   * Revokes (deletes) a tag by its primary key, scoped to the association that issued it.
   * Throws 404 when no such tag belongs to that association.
   *
   * The scope is the authorization, not a filter: MANAGE_MEMBERS is granted per association, so
   * deleting on the id alone would let an admin of ANY association revoke a tag issued by ANY
   * other one - the caller's `:id` must constrain the row it reaches.
   */
  async revoke(tagId: string, issuingAssocId: string): Promise<void> {
    const res = await this.repo.delete({ id: tagId, issuingAssocId });
    if (!res.affected) throw new NotFoundException('Tag not found');
    this.logger.log(`[UserTag] Revoked tag ${tagId} (assoc=${issuingAssocId})`);
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

  /**
   * Maps each active tiered membership product's derived tag name to its display name (e.g.
   * `cotisant:cercle-avec-alcool-2026-2027` -> `"Avec alcool"`), for multi-tier associations only.
   * The base tier (`variantKey: null`) is intentionally left unmapped so its roster/export rows
   * show a blank tier column - only named tiers need a label.
   */
  private async buildTierLabelMap(assocId: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const tier of await this.listCotisationTiers(assocId)) {
      if (!tier.variantKey) continue;
      map.set(tier.tagName, tier.name);
    }
    return map;
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

    const [countRows, rows, tierMap] = await Promise.all([
      this.repo.manager.query(`SELECT COUNT(*)::text AS count ${baseFrom}`, [
        assocId,
        search,
      ]) as Promise<{ count: string }[]>,
      this.repo.manager.query(
        `SELECT t.id AS "id", t."userId" AS "userId", t."tagName" AS "tagName", t."createdAt" AS "grantedAt",
                t."expiresAt" AS "expiresAt", u."firstName" AS "firstName", u."lastName" AS "lastName",
                u.promo AS "promo"
         ${baseFrom}
         ORDER BY u.promo ASC NULLS LAST, u."lastName" ASC, u."firstName" ASC
         LIMIT $3 OFFSET $4`,
        [assocId, search, limit, offset]
      ) as Promise<RawCotisantRow[]>,
      this.buildTierLabelMap(assocId),
    ]);
    const total = Number(countRows[0]?.count ?? 0);

    const items = rows.map((row) => toRosterItem(row, tierMap));
    const hasMore = offset + items.length < total;
    this.logger.debug(
      `[UserTag] listCotisants assoc=${assocId} returned ${items.length}/${total} (hasMore=${hasMore})`
    );
    return { items, total, hasMore };
  }

  /**
   * Builds an XLSX export of the association's full active cotisant roster (no pagination),
   * same active-only filter and sort as `listCotisants`. Columns (D8, WP-COT-6): Nom, Prenom,
   * Promo, Cotisation, Forfait, Date, Echeance - no email (PII, per the rework plan).
   */
  async exportCotisants(assocId: string): Promise<{ buffer: Buffer; title: string }> {
    this.logger.debug(`[UserTag] exportCotisants assoc=${assocId}`);

    const [nameRows, rows, tierMap] = await Promise.all([
      this.repo.manager.query(`SELECT name FROM associations WHERE id = $1`, [assocId]) as Promise<
        { name: string }[]
      >,
      this.repo.manager.query(
        `SELECT t.id AS "id", t."userId" AS "userId", t."tagName" AS "tagName", t."createdAt" AS "grantedAt",
                t."expiresAt" AS "expiresAt", u."firstName" AS "firstName", u."lastName" AS "lastName",
                u.promo AS "promo"
         FROM user_tags t
         INNER JOIN users u ON u.id = t."userId"
         WHERE t."issuingAssocId" = $1
           AND (t."expiresAt" IS NULL OR t."expiresAt" > NOW())
         ORDER BY u.promo ASC NULLS LAST, u."lastName" ASC, u."firstName" ASC`,
        [assocId]
      ) as Promise<RawCotisantRow[]>,
      this.buildTierLabelMap(assocId),
    ]);
    const assocName = nameRows[0]?.name ?? 'cotisants';
    const items = rows.map((row) => toRosterItem(row, tierMap));

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Cotisants');
    sheet.columns = [
      { header: 'Nom', key: 'lastName', width: 20 },
      { header: 'Prénom', key: 'firstName', width: 20 },
      { header: 'Promo', key: 'promo', width: 10 },
      { header: 'Cotisation', key: 'tagName', width: 30 },
      { header: 'Forfait', key: 'tier', width: 20 },
      { header: 'Date', key: 'grantedAt', width: 14, style: { numFmt: 'dd/mm/yyyy' } },
      { header: 'Échéance', key: 'expiresAt', width: 14, style: { numFmt: 'dd/mm/yyyy' } },
    ];

    items.forEach((item) => {
      sheet.addRow({
        lastName: item.lastName ?? '',
        firstName: item.firstName ?? '',
        promo: item.promo ?? '',
        tagName: item.tagName,
        tier: item.tier ?? '',
        grantedAt: item.grantedAt,
        expiresAt: item.expiresAt ?? '',
      });
    });

    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer, title: `cotisants_${assocName}` };
  }
}
