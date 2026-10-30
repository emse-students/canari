import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { lockBuyerTiers } from './buyer-tier-lock';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, In } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { UserTag } from './entities/user-tag.entity';
import {
  CotisationMode,
  deriveCotisationTag,
  tierVariantKeys,
} from '../associations/cotisation-tag.util';
import {
  orphanTierTags,
  pickHeldTier,
  tierRelation,
  type OrphanTierTag,
  type RankedTier,
  type TierRelation,
} from '../associations/tier-pricing';

/**
 * Refusal code of a raw tag grant whose name is not one of the granting association's own
 * cotisation tier tags (`UserTagService.grantTagForAssociation`): a 403 carrying `{ code, message }`.
 */
export const TAG_NOT_ISSUER_TIER = 'TAG_NOT_ISSUER_TIER';

/** Refusal code of `TagHeldByAnotherIssuerError`. */
export const TAG_HELD_BY_ANOTHER_ISSUER = 'TAG_HELD_BY_ANOTHER_ISSUER';

/**
 * Thrown by `grantOrRenew` when the user already holds a row of that tag NAME issued by another
 * association (or by none): a grant never takes over or renews a row it did not issue, since every
 * tier-holding read counts only the issuer's own rows. A 409 carrying `{ code, message }`; a payment
 * path catches it by TYPE and records the payment as paid but not granted.
 */
export class TagHeldByAnotherIssuerError extends ConflictException {
  constructor(tagName: string) {
    super({
      code: TAG_HELD_BY_ANOTHER_ISSUER,
      message: `The user already holds "${tagName}" issued by another association`,
    });
  }
}

/**
 * The key of a tag AS ISSUED: its name and the association that issued it. Tier-holding reads that
 * match many tags in memory compare on this, never on the name alone, so a tag counts only for the
 * association that issued it.
 */
export function issuedTagKey(issuingAssocId: string | null, tagName: string): string {
  return `${issuingAssocId ?? ''}\u0000${tagName}`;
}

/** Whether a tag row exists and has not expired (`expiresAt` null meaning permanent). */
function isActive(tag: UserTag | null): tag is UserTag {
  if (!tag) return false;
  return !tag.expiresAt || tag.expiresAt > new Date();
}

/** Data required to grant or renew a membership tag. */
export interface GrantTagData {
  userId: string;
  tagName: string;
  issuingAssocId?: string | null;
  grantedBy: string;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

/**
 * The refusal of a ranked grant whose payer holds, under the tier lock, a tier the paid form is
 * reserved to people WITHOUT (`notCotisation`, owner 2026-10-30): granting would take a second
 * cotisation's price from a holder. The caller records the payment `paid_not_granted`.
 */
export const EXCLUDED_TIER_HELD = 'EXCLUDED_TIER_HELD';

/**
 * The tiers a paid grant must find NOT held (a form's `notCotisation`): `anyTier` for any tier of
 * the association, a deleted tier's tag included (as `unless-holding-any` counts it), else the
 * listed keys, `null` being the base tier.
 */
export interface ExcludedTiers {
  anyTier?: boolean;
  variantKeys?: (string | null)[];
}

/**
 * What a RANKED tier grant (`grantCotisantIfARise`, a paid form's grant) did: granted - for `none`
 * or `higher` - or refused: `held` (the very tier is held already - renewing it would take its price
 * twice; the form's submit refuses the same case as `FORM_TIER_ALREADY_HELD`, and this is that rule
 * judged again under the lock, when the money lands), `lower` / `unranked` (not a rise, so a paid
 * grant never swaps out a dearer tier by the XOR), `EXCLUDED_TIER_HELD` (a tier the form excludes is
 * held), or `TAG_HELD_BY_ANOTHER_ISSUER`. A boutique settlement never grants a tier already held
 * either (`settlementVerdict`); the one exception here is the held tag that IS this answer's own
 * delivery (its `metadata.submissionId`), answered `granted` without writing - a replay, not a renewal.
 */
export type RankedGrantOutcome =
  | { granted: UserTag }
  | { refused: TierRelation | typeof TAG_HELD_BY_ANOTHER_ISSUER | typeof EXCLUDED_TIER_HELD };

/** How `grantCotisantLocked` treats a tier the user may already hold. */
type GrantRule = 'manual' | 'unless-holding-any' | 'only-a-rise';

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
   * Creates the tag or, if `(userId, tagName)` already exists AS ISSUED BY THE SAME ASSOCIATION,
   * updates `expiresAt` (when given) and merges `metadata`, without changing `grantedBy`.
   * Pass `manager` to run within an existing transaction (e.g. alongside a sibling-tier revoke).
   *
   * ONE STATEMENT, `INSERT ... ON CONFLICT ("userId", "tagName") DO UPDATE`, never a read then a
   * write: there is no copy of the row to go stale, two first grants cannot both insert, two renewals
   * keep both their metadata keys (`||` merges in SQL), and a tag revoked concurrently is either
   * still there to renew or gone and granted anew - each a serial order, never the revoked row
   * written back. The unique index on the pair is the entity's `@Unique`.
   *
   * The update never crosses issuers: its `WHERE` keeps a row issued by another association (or by
   * none) untouched, the statement then returns no row, and that is thrown as
   * `TagHeldByAnotherIssuerError` - a grant that tier-holding reads would not count is never
   * reported as granted. No SQL error is raised, so a caller may catch it and go on in the same
   * transaction.
   */
  async grantOrRenew(data: GrantTagData, manager?: EntityManager): Promise<UserTag> {
    const repo = manager ? manager.getRepository(UserTag) : this.repo;
    const rows = (await repo.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy", "expiresAt", metadata)
       VALUES ($1, $2, $3, $4, $5, CAST($6 AS jsonb))
       ON CONFLICT ("userId", "tagName") DO UPDATE SET
         "expiresAt" = CASE WHEN CAST($7 AS boolean) THEN EXCLUDED."expiresAt" ELSE user_tags."expiresAt" END,
         metadata = user_tags.metadata || EXCLUDED.metadata
       WHERE user_tags."issuingAssocId" IS NOT DISTINCT FROM EXCLUDED."issuingAssocId"
       RETURNING *, (xmax = 0) AS inserted`,
      [
        data.userId,
        data.tagName,
        data.issuingAssocId ?? null,
        data.grantedBy,
        data.expiresAt ?? null,
        JSON.stringify(data.metadata ?? {}),
        data.expiresAt !== undefined,
      ]
    )) as Array<UserTag & { inserted: boolean }>;
    const row = rows[0];
    if (!row) {
      this.logger.error(
        `[UserTag] grant of ${data.tagName} to ${data.userId} by assoc=${data.issuingAssocId ?? 'none'} ` +
          'NOT written: the user holds that name under another issuer'
      );
      throw new TagHeldByAnotherIssuerError(data.tagName);
    }
    const { inserted, ...columns } = row;
    const tag = repo.create(columns);
    if (inserted) {
      this.logger.log(`[UserTag] Granted ${data.tagName} to ${data.userId} by ${data.grantedBy}`);
    } else {
      this.logger.log(
        `[UserTag] Renewed ${data.tagName} for ${data.userId} (expiresAt=${tag.expiresAt?.toISOString() ?? 'never'})`
      );
    }
    return tag;
  }

  /**
   * Deletes a user's tag by name (rather than by primary key like `revoke`) - used for XOR
   * sibling-tier enforcement, where the tag id isn't known ahead of time. No-op if not held.
   * Scoped to `issuingAssocId` like `revoke`: an association's tier switch deletes only the rows it
   * issued. Pass `manager` to run within an existing transaction.
   */
  async revokeByName(
    userId: string,
    tagName: string,
    issuingAssocId: string,
    manager?: EntityManager
  ): Promise<void> {
    const repo = manager ? manager.getRepository(UserTag) : this.repo;
    const res = await repo.delete({ userId, tagName, issuingAssocId });
    if (res.affected) {
      this.logger.log(
        `[UserTag] Revoked ${tagName} for ${userId} (sibling-tier switch, assoc=${issuingAssocId})`
      );
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
    if (tiers.length >= 2) {
      for (const tier of tiers) {
        if (tier.variantKey === keepVariantKey) continue;
        await this.revokeByName(userId, tier.tagName, assocId, manager);
      }
    }
    // A tag of a tier that no longer exists is a sibling like any other: it is the tier the user
    // held, and the tier just granted replaces it. Scoped to the rows this association issued.
    for (const orphan of await this.heldOrphanTierTags(userId, assocId, tiers, manager)) {
      await this.revokeByName(userId, orphan.tagName, assocId, manager);
      this.logger.warn(
        `[UserTag] Revoked ${orphan.tagName} for ${userId}: its tier no longer exists in ` +
          `assoc=${assocId.slice(0, 8)}, replaced by tier ${keepVariantKey ?? 'base'}`
      );
    }
  }

  /**
   * The ACTIVE tags `assocId` issued to the user for a cotisation tier it no longer has
   * (`orphanTierTags`): what a holder keeps when a tier product was deleted before deleting one
   * was refused while held. Ranking reads them as a held tier with no price (`unranked`), and the
   * sibling XOR revokes them, so a deleted tier never turns its holders into people who hold
   * nothing. `tiers` is the association's current catalogue (`listCotisationTiers`). Empty when the
   * association has no cotisation mode. Read through `manager` when given, so a caller under the
   * buyer's tier lock reads on its own connection.
   */
  async heldOrphanTierTags(
    userId: string,
    assocId: string,
    tiers: readonly { variantKey: string | null }[],
    manager?: EntityManager
  ): Promise<OrphanTierTag[]> {
    return (await this.heldOrphanTierTagsOf([userId], assocId, tiers, manager)).get(userId) ?? [];
  }

  /**
   * `heldOrphanTierTags` for many users in one query, by user id (a user holding none is absent):
   * what a listing of many buyers reads - the purchases list and its closing - so the count of
   * queries does not grow with the rows.
   */
  async heldOrphanTierTagsOf(
    userIds: readonly string[],
    assocId: string,
    tiers: readonly { variantKey: string | null }[],
    manager?: EntityManager
  ): Promise<Map<string, OrphanTierTag[]>> {
    const byUser = new Map<string, OrphanTierTag[]>();
    if (userIds.length === 0) return byUser;
    const runner = manager ?? this.repo.manager;
    const rows: { slug: string; cotisationMode: CotisationMode | null }[] = await runner.query(
      `SELECT slug, "cotisationMode" FROM associations WHERE id = $1`,
      [assocId]
    );
    const asso = rows[0];
    if (!asso?.cotisationMode) return byUser;
    const root = `cotisant:${asso.slug}`;
    const held: { userId: string; tagName: string }[] = await runner.query(
      `SELECT "userId", "tagName" FROM user_tags
        WHERE "userId" = ANY($1) AND "issuingAssocId" = $2
          AND ("expiresAt" IS NULL OR "expiresAt" > now())
          AND ("tagName" = $3 OR starts_with("tagName", $4))`,
      [[...userIds], assocId, root, `${root}-`]
    );
    const keys = tierVariantKeys([...tiers]);
    for (const userId of new Set(held.map((t) => t.userId))) {
      const orphans = orphanTierTags(
        held.filter((t) => t.userId === userId).map((t) => t.tagName),
        asso.slug,
        keys
      );
      if (orphans.length === 0) continue;
      // Counted every hour by `countOrphanTierTags` (the PaidNotGranted report); per request it
      // is a decision input, not news.
      this.logger.debug(
        `[UserTag] user=${userId.slice(0, 8)} holds ${orphans.length} tag(s) of a deleted tier ` +
          `of assoc=${assocId.slice(0, 8)}`
      );
      byUser.set(userId, orphans);
    }
    return byUser;
  }

  /**
   * Every ACTIVE orphan tier tag on the estate (`orphanTierTags`, per issuing association with a
   * cotisation mode), as ONE count for the hourly report: three reads whatever the number of
   * associations, and no user data in the answer.
   */
  async countOrphanTierTags(): Promise<number> {
    const runner = this.repo.manager;
    const [rows, products]: [
      { associationId: string; slug: string; tagName: string }[],
      { associationId: string; variantKey: string | null }[],
    ] = await Promise.all([
      runner.query(
        `SELECT a.id AS "associationId", a.slug AS slug, t."tagName" AS "tagName"
           FROM user_tags t JOIN associations a ON a.id = t."issuingAssocId"
          WHERE a."cotisationMode" IS NOT NULL
            AND (t."expiresAt" IS NULL OR t."expiresAt" > now())
            AND (t."tagName" = 'cotisant:' || a.slug OR starts_with(t."tagName", 'cotisant:' || a.slug || '-'))`
      ),
      runner.query(
        `SELECT "associationId", "variantKey" FROM association_products WHERE type = 'membership'`
      ),
    ]);
    const byAssoc = new Map<string, { slug: string; tagNames: string[] }>();
    for (const r of rows) {
      const entry = byAssoc.get(r.associationId) ?? { slug: r.slug, tagNames: [] };
      entry.tagNames.push(r.tagName);
      byAssoc.set(r.associationId, entry);
    }
    let count = 0;
    for (const [associationId, { slug, tagNames }] of byAssoc) {
      const keys = tierVariantKeys(products.filter((p) => p.associationId === associationId));
      // One orphan per ROW: the same name held by two people is two holders to repair.
      const orphanNames = new Set(orphanTierTags(tagNames, slug, keys).map((o) => o.tagName));
      count += tagNames.filter((n) => orphanNames.has(n)).length;
    }
    return count;
  }

  /**
   * How many users hold, ACTIVE, a tag of tier `variantKey` of association `assocId` (slug `slug`):
   * the tier's tag stem (`cotisant:<slug>` or `cotisant:<slug>-<variant>`), alone or with an
   * academic-year suffix - every tag `linkedTierKey` reads as that tier, in either mode and any
   * year. Counted on the rows THIS association issued only, the rows every tier read counts
   * (`hasActiveTag`) and the only ones its managers can see on their roster and revoke
   * (`revokeByName`): another association's row, or a row no association issued, is held for nobody
   * here, so it never blocks the delete and its number is never told. What refuses deleting a tier
   * people still hold (`ProductsService.delete`);
   * read through `manager`, under the association's EXCLUSIVE tier lock, so no grant of that tier
   * commits between the count and the delete.
   */
  async countActiveTierHolders(
    assocId: string,
    slug: string,
    variantKey: string | null,
    manager: EntityManager
  ): Promise<number> {
    const stem = deriveCotisationTag(slug, 'lifetime', new Date(), variantKey).tagName;
    const rows: { n: number }[] = await manager.query(
      `SELECT count(DISTINCT "userId")::int AS n FROM user_tags
        WHERE "issuingAssocId" = $4
          AND ("expiresAt" IS NULL OR "expiresAt" > now())
          AND ("tagName" = $1
               OR (starts_with("tagName", $2) AND substr("tagName", $3) ~ '^[0-9]{4}-[0-9]{4}$'))`,
      [stem, `${stem}-`, stem.length + 2, assocId]
    );
    const n = rows[0]?.n ?? 0;
    this.logger.debug(`[UserTag] tier ${stem} has ${n} active holder(s)`);
    return n;
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
    const outcome = await this.grantCotisantLocked(
      assocId,
      userId,
      grantedBy,
      { variantKey },
      metadata,
      'manual'
    );
    if (!outcome || !('granted' in outcome)) {
      throw new Error('grantCotisant: a manual grant is never skipped nor refused');
    }
    return outcome.granted;
  }

  /**
   * `grantCotisant` for a PAID grant that is not a manager's decision (a form that grants a tier):
   * judged under the buyer's tier lock, so a shop settlement committed meanwhile is seen. Refuses a
   * held tier of `excluded` (the form's `notCotisation`), then ranks (`rankTier`, on the tiers'
   * product prices) and grants only `none` or `higher`: `held` would renew the tier and take its
   * price twice, `lower` and `unranked` would let the XOR replace a dearer tier. A refusal grants
   * nothing and changes nothing; the caller records the payment as paid but not granted.
   */
  async grantCotisantIfARise(
    assocId: string,
    userId: string,
    grantedBy: string,
    variantKey: string | null,
    metadata: Record<string, unknown>,
    excluded: ExcludedTiers | null = null
  ): Promise<RankedGrantOutcome> {
    const outcome = await this.grantCotisantLocked(
      assocId,
      userId,
      grantedBy,
      { variantKey },
      metadata,
      'only-a-rise',
      undefined,
      excluded
    );
    if (!outcome) throw new Error('grantCotisantIfARise: a ranked grant is never skipped');
    return outcome;
  }

  /**
   * `grantCotisant`, except that it grants NOTHING (and answers null) when the user already holds
   * any tier of the association, the tag of a DELETED tier included (`heldOrphanTierTags`: only a
   * manager may swap one out) - asked UNDER the buyer's tier lock, so a tier paid for at the same
   * moment is seen and kept instead of being swapped out by the XOR. The legacy claim's path: a
   * cotisation bought in Canari outranks anything a legacy list says.
   */
  async grantCotisantUnlessHeld(
    assocId: string,
    userId: string,
    grantedBy: string,
    variantKey: string | null,
    metadata: Record<string, unknown>
  ): Promise<UserTag | null> {
    const outcome = await this.grantCotisantLocked(
      assocId,
      userId,
      grantedBy,
      { variantKey },
      metadata,
      'unless-holding-any'
    );
    return outcome && 'granted' in outcome ? outcome.granted : null;
  }

  /**
   * The admin's "grant a tag" endpoint, in the name of `assocId`. A tag grant is scoped to the
   * association that grants it: the name must be one of `assocId`'s OWN cotisation tier tags for the
   * current academic year (its catalogue, `listCotisationTiers`), or it is refused
   * `403 TAG_NOT_ISSUER_TIER`. The tier it names is then granted exactly like the roster's manual
   * add (`grantCotisant`): under the buyer's tier lock, read after it, with the sibling-tier XOR, and
   * unranked since it is a manager's decision. `data.expiresAt`, when given, replaces the derived
   * expiry.
   */
  async grantTagForAssociation(assocId: string, data: GrantTagData): Promise<UserTag> {
    const outcome = await this.grantCotisantLocked(
      assocId,
      data.userId,
      data.grantedBy,
      { tagName: data.tagName },
      data.metadata ?? {},
      'manual',
      data.expiresAt ?? undefined
    );
    if (!outcome || !('granted' in outcome)) {
      throw new Error('grantTagForAssociation: a manual grant is never skipped nor refused');
    }
    return outcome.granted;
  }

  /**
   * The body of `grantCotisant`, `grantCotisantUnlessHeld`, `grantCotisantIfARise` and
   * `grantTagForAssociation`. EVERYTHING it reads - the association, its tiers, the tag to derive,
   * what the user holds - is read through the transaction's `manager` AFTER the buyer's tier lock,
   * so a retag or a grant committed while it waited is what it sees. Null: skipped because a tier is
   * held (`unless-holding-any`). `tier` names the tier by key, or by the tag it grants (the raw
   * grant), which must then be one of the association's own tier tags.
   */
  private async grantCotisantLocked(
    assocId: string,
    userId: string,
    grantedBy: string,
    tier: { variantKey: string | null } | { tagName: string },
    metadata: Record<string, unknown>,
    rule: GrantRule,
    expiresAtOverride?: Date,
    excluded: ExcludedTiers | null = null
  ): Promise<RankedGrantOutcome | null> {
    return this.repo.manager.transaction((manager) =>
      this.grantCotisantIn(
        manager,
        assocId,
        userId,
        grantedBy,
        tier,
        metadata,
        rule,
        expiresAtOverride,
        excluded
      )
    );
  }

  /**
   * `grantCotisant` - the manager's grant, NOT ranked - inside the CALLER's transaction: the closing
   * of a payment paid for and not granted (`ProductsService.closePaidNotGranted`) grants the tier and
   * writes its closing row in one commit, after its own ranked verdict. Takes the buyer's tier lock on
   * `manager` itself; a caller that already holds it on the same transaction simply holds it twice
   * (advisory locks stack within one session, and both are released by the one commit or rollback).
   */
  async grantCotisantWithin(
    manager: EntityManager,
    assocId: string,
    userId: string,
    grantedBy: string,
    variantKey: string | null,
    metadata: Record<string, unknown>
  ): Promise<UserTag> {
    const outcome = await this.grantCotisantIn(
      manager,
      assocId,
      userId,
      grantedBy,
      { variantKey },
      metadata,
      'manual'
    );
    if (!outcome || !('granted' in outcome)) {
      throw new Error('grantCotisantWithin: a manual grant is never skipped nor refused');
    }
    return outcome.granted;
  }

  /** The body of `grantCotisantLocked`, on the transaction `manager` belongs to. */
  private async grantCotisantIn(
    manager: EntityManager,
    assocId: string,
    userId: string,
    grantedBy: string,
    tier: { variantKey: string | null } | { tagName: string },
    metadata: Record<string, unknown>,
    rule: GrantRule,
    expiresAtOverride?: Date,
    excluded: ExcludedTiers | null = null
  ): Promise<RankedGrantOutcome | null> {
    await lockBuyerTiers(manager, assocId, userId);
    const rows: { slug: string; cotisationMode: CotisationMode | null }[] = await manager.query(
      `SELECT slug, "cotisationMode" FROM associations WHERE id = $1`,
      [assocId]
    );
    const asso = rows[0];
    if (!asso) throw new NotFoundException('Association not found');
    const tiers = asso.cotisationMode ? await this.listCotisationTiers(assocId, { manager }) : [];
    let variantKey: string | null;
    if ('tagName' in tier) {
      const named = tiers.find((t) => t.tagName === tier.tagName);
      if (!named) {
        this.logger.warn(
          `[UserTag] raw grant of "${tier.tagName}" refused for assoc=${assocId.slice(0, 8)}: ` +
            'not one of its cotisation tier tags'
        );
        throw new ForbiddenException({
          code: TAG_NOT_ISSUER_TIER,
          message: "The tag is not one of the granting association's cotisation tiers",
        });
      }
      variantKey = named.variantKey;
    } else {
      variantKey = tier.variantKey;
    }
    if (!asso.cotisationMode) {
      throw new BadRequestException('Cotisation is not enabled for this association');
    }

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

    const derived = deriveCotisationTag(asso.slug, asso.cotisationMode, new Date(), variantKey);
    const tagName = derived.tagName;
    const expiresAt = expiresAtOverride ?? derived.expiresAt;
    this.logger.debug(
      `[UserTag] grantCotisant assoc=${assocId} user=${userId.slice(0, 8)} tier=${variantKey ?? 'base'} tag=${tagName} rule=${rule}`
    );
    // A tag of a DELETED tier counts as holding one here: granting would run the sibling XOR and
    // delete it - possibly a dearer PAID tier, the only record of what the holder paid - on a
    // claim no manager made. The claim neither grants nor swaps; a manager's explicit grant is
    // what replaces an orphan.
    if (
      rule === 'unless-holding-any' &&
      ((await this.heldVariantKeys(userId, assocId, tiers, manager)).length > 0 ||
        (await this.heldOrphanTierTags(userId, assocId, tiers, manager)).length > 0)
    ) {
      this.logger.debug(
        `[UserTag] grantCotisant skipped: user=${userId.slice(0, 8)} already holds a tier of assoc=${assocId}, a deleted one included`
      );
      return null;
    }
    if (rule === 'only-a-rise') {
      if (excluded && (await this.holdsExcludedTier(userId, assocId, tiers, excluded, manager))) {
        this.logger.error(
          `[UserTag] paid grant of tier ${variantKey ?? 'base'} of assoc=${assocId.slice(0, 8)} ` +
            `refused for user=${userId.slice(0, 8)}: ${EXCLUDED_TIER_HELD} - a tier the form is for ` +
            'people without was already held when the payment landed; nothing granted, a refund is owed'
        );
        return { refused: EXCLUDED_TIER_HELD };
      }
      const relation = await this.rankTier(assocId, userId, variantKey, tiers, manager);
      if (relation === 'held') {
        // The held tag is this very answer's delivery (a replay whose claim was released after the
        // grant committed): already delivered, nothing written. Any other holder would pay twice.
        const own = await manager
          .getRepository(UserTag)
          .findOne({ where: { userId, tagName, issuingAssocId: assocId } });
        const answer = metadata.submissionId;
        if (own && answer != null && own.metadata?.submissionId === answer) {
          this.logger.debug(
            `[UserTag] paid grant of tier ${variantKey ?? 'base'}: already delivered by answer ` +
              `${String(answer).slice(0, 8)} - nothing written`
          );
          return { granted: own };
        }
        this.logger.error(
          `[UserTag] paid grant of tier ${variantKey ?? 'base'} of assoc=${assocId.slice(0, 8)} ` +
            `refused for user=${userId.slice(0, 8)}: already held when the payment landed - nothing ` +
            'renewed, a refund is owed'
        );
        return { refused: relation };
      }
      if (relation === 'lower' || relation === 'unranked') {
        this.logger.error(
          `[UserTag] paid grant of tier ${variantKey ?? 'base'} of assoc=${assocId.slice(0, 8)} ` +
            `refused for user=${userId.slice(0, 8)}: ${relation} against the tier held - nothing granted`
        );
        return { refused: relation };
      }
    }
    let tag: UserTag;
    try {
      tag = await this.grantOrRenew(
        { userId, tagName, issuingAssocId: assocId, grantedBy, expiresAt, metadata },
        manager
      );
    } catch (e) {
      // A paid grant answers the refusal, so its caller records paid but not granted; the
      // manager's paths let the typed 409 through.
      if (rule === 'only-a-rise' && e instanceof TagHeldByAnotherIssuerError) {
        return { refused: TAG_HELD_BY_ANOTHER_ISSUER };
      }
      throw e;
    }
    await this.revokeSiblingTierTags(assocId, userId, variantKey, manager);
    return { granted: tag };
  }

  /**
   * Whether the user holds a tier of `excluded`, read through `manager` under the buyer's tier lock.
   * `anyTier` counts a deleted tier's tag too, as `unless-holding-any` does.
   */
  private async holdsExcludedTier(
    userId: string,
    assocId: string,
    tiers: CotisationTierInfo[],
    excluded: ExcludedTiers,
    manager: EntityManager
  ): Promise<boolean> {
    const held = await this.heldVariantKeys(userId, assocId, tiers, manager);
    if (excluded.anyTier) {
      return (
        held.length > 0 ||
        (await this.heldOrphanTierTags(userId, assocId, tiers, manager)).length > 0
      );
    }
    const keys = excluded.variantKeys ?? [];
    return held.some((k) => keys.includes(k));
  }

  /**
   * Where tier `variantKey` of `assocId` stands against what the user holds NOW, for a caller that
   * must refuse a non-rise BEFORE it opens a payment (a paid form that grants a tier): the same
   * `rankTier` decision the ranked grant takes, read outside any lock. It is a pre-check, not the
   * verdict - the grant re-ranks under the buyer's tier lock when the money lands. `none` when the
   * association has no cotisation. `tiers`, when the caller already read the catalogue
   * (`listCotisationTiers`, the same unlocked read), is used instead of reading it again.
   */
  async rankCotisationTier(
    assocId: string,
    userId: string,
    variantKey: string | null,
    tiers?: CotisationTierInfo[]
  ): Promise<TierRelation> {
    const manager = this.repo.manager;
    const catalogue = tiers ?? (await this.listCotisationTiers(assocId, { manager }));
    if (catalogue.length === 0) return 'none';
    return this.rankTier(assocId, userId, variantKey, catalogue, manager);
  }

  /**
   * Where tier `variantKey` stands against what the user holds, read through `manager` under the
   * buyer's tier lock, on the tiers' PRODUCT prices: ranked against the ONE tier `pickHeldTier`
   * picks, the tier a checkout ranks against too. A settlement does not rank: it grants on the tier
   * its checkout froze (`settlementVerdict`). A target with no product is `unranked`; a paid form
   * refuses that case earlier, as a tier that no longer exists (`FORM_TIER_NOT_SOLD`). Unlike
   * `tierRelationOf` (the checkout's), a target the user holds
   * BESIDE a dearer (or unrankable) tier - two legacy tags - is NOT `held`: renewing it would run the
   * sibling XOR and revoke the tier ranked above it, so it answers `lower` / `unranked` and is
   * refused. `held` is only the top tier itself.
   */
  private async rankTier(
    assocId: string,
    userId: string,
    variantKey: string | null,
    tiers: CotisationTierInfo[],
    manager: EntityManager
  ): Promise<TierRelation> {
    const priced: RankedTier[] = await manager.query(
      `SELECT "variantKey", "amountCents", "priceMatrix" FROM association_products
        WHERE "associationId" = $1 AND type = 'membership'`,
      [assocId]
    );
    const heldKeys = await this.heldVariantKeys(userId, assocId, tiers, manager);
    const orphans = await this.heldOrphanTierTags(userId, assocId, tiers, manager);
    const product = (key: string | null) => priced.find((t) => t.variantKey === key) ?? null;
    const target = product(variantKey);
    // A held tag of a deleted tier is a held tier with no product, so no price: `pickHeldTier`
    // ranks against it first, and anything else is `unranked`.
    const held = pickHeldTier([
      ...heldKeys.map((k) => ({ variantKey: k, product: product(k) })),
      ...orphans.map((o) => ({ variantKey: o.variantKey, product: null })),
    ]);
    const relation = target ? tierRelation(target, held) : 'unranked';
    this.logger.debug(
      `[UserTag] tier rank: assoc=${assocId.slice(0, 8)} user=${userId.slice(0, 8)} ` +
        `tier=${variantKey ?? 'base'} held=${held ? (held.variantKey ?? 'base') : 'none'} relation=${relation}`
    );
    return relation;
  }

  /**
   * Whether the user holds ANY of `assocId`'s cotisation tiers.
   *
   * This is the "is a member" question - the one a member price asks, since a discount for
   * cotisants means all of them.
   */
  async holdsAnyCotisation(
    userId: string,
    assocId: string,
    manager?: EntityManager
  ): Promise<boolean> {
    return this.holdsOneOfTiers(userId, assocId, null, true, manager);
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
   * Whether the user holds `assocId`'s tier `variantKey` AS THE DELIVERY of form answer
   * `submissionId`: its active tag names that answer in `metadata.submissionId`, which a paid form's
   * grant writes. The durable answer a replayed purchase record reads - a tier merely held (bought
   * elsewhere, so the grant refused to renew it) is not this answer's, and its refund stays owed.
   */
  async holdsTierDeliveredBy(
    userId: string,
    assocId: string,
    variantKey: string | null,
    submissionId: string
  ): Promise<boolean> {
    const tier = (await this.listCotisationTiers(assocId)).find((t) => t.variantKey === variantKey);
    if (!tier) return false;
    const tag = await this.repo.findOne({
      where: { userId, tagName: tier.tagName, issuingAssocId: assocId },
    });
    const delivered = isActive(tag) && tag.metadata?.submissionId === submissionId;
    this.logger.debug(
      `[UserTag] tier ${variantKey ?? 'base'} of assoc=${assocId.slice(0, 8)} delivered by answer ` +
        `${submissionId.slice(0, 8)}: ${delivered}`
    );
    return delivered;
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
    anyTier: boolean,
    manager?: EntityManager
  ): Promise<boolean> {
    const tiers = await this.listCotisationTiers(assocId, { manager });
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
    return (await this.heldVariantKeys(userId, assocId, wanted, manager)).length > 0;
  }

  /**
   * Every cotisation tier of `assocId` the user currently holds, by `variantKey` (`null` being the
   * base tier). Empty when they hold none, and when the association sells none.
   *
   * The list, not a yes/no, because a form's pricing grid asks WHICH tier somebody is on - a
   * cotisant "avec alcool" and a cotisant "sans alcool" land in different cells, and asking one
   * boolean question per bucket would re-derive the same tags once per column.
   */
  async listHeldCotisationTiers(
    userId: string,
    assocId: string,
    manager?: EntityManager
  ): Promise<(string | null)[]> {
    const tiers = await this.listCotisationTiers(assocId, { manager });
    if (tiers.length === 0) {
      this.logger.debug(
        `[UserTag] listHeldCotisationTiers assoc=${assocId.slice(0, 8)} has no cotisation tier - none`
      );
      return [];
    }
    return this.heldVariantKeys(userId, assocId, tiers, manager);
  }

  /**
   * {@link listHeldCotisationTiers} for MANY associations at once, in three queries whatever their
   * number: the associations' modes, their membership products, and the user's active tags. A list
   * of spaces judged on cotisation conditions (the bookings' Reservations page) asks this once
   * rather than once per association. Same answer per association: the variant keys held, `null`
   * being the base tier, and nothing for an association that sells no cotisation. A tag counts for
   * an association only when that association issued it (`issuedTagKey`).
   */
  async heldCotisationTiersByAssociation(
    userId: string,
    assocIds: readonly string[]
  ): Promise<Map<string, (string | null)[]>> {
    const ids = [...new Set(assocIds)];
    const held = new Map<string, (string | null)[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return held;
    const runner = this.repo.manager;
    const [assos, products, active]: [
      { id: string; slug: string; cotisationMode: CotisationMode | null }[],
      { associationId: string; variantKey: string | null }[],
      { tagName: string; issuingAssocId: string }[],
    ] = await Promise.all([
      runner.query(`SELECT id, slug, "cotisationMode" FROM associations WHERE id = ANY($1)`, [ids]),
      runner.query(
        `SELECT "associationId", "variantKey" FROM association_products
          WHERE "associationId" = ANY($1) AND type = 'membership'`,
        [ids]
      ),
      runner.query(
        `SELECT "tagName", "issuingAssocId" FROM user_tags
          WHERE "userId" = $1 AND "issuingAssocId" = ANY($2)
            AND ("expiresAt" IS NULL OR "expiresAt" > now())`,
        [userId, ids]
      ),
    ]);
    const activeKeys = new Set(active.map((t) => issuedTagKey(t.issuingAssocId, t.tagName)));
    const now = new Date();
    for (const asso of assos) {
      if (!asso.cotisationMode) continue;
      const mode = asso.cotisationMode;
      const keys = held.get(asso.id) ?? [];
      for (const p of products.filter((x) => x.associationId === asso.id)) {
        const { tagName } = deriveCotisationTag(asso.slug, mode, now, p.variantKey);
        if (activeKeys.has(issuedTagKey(asso.id, tagName)) && !keys.includes(p.variantKey)) {
          keys.push(p.variantKey);
        }
      }
      held.set(asso.id, keys);
    }
    this.logger.debug(`[UserTag] held tiers read for ${ids.length} associations in one pass`);
    return held;
  }

  /**
   * Which of `assocId`'s given tiers the user has an active tag for, counting only tags `assocId`
   * issued. The one place a tier list becomes a membership answer, so `holdsOneOfTiers` and
   * `listHeldCotisationTiers` cannot disagree.
   */
  private async heldVariantKeys(
    userId: string,
    assocId: string,
    tiers: CotisationTierInfo[],
    manager?: EntityManager
  ): Promise<(string | null)[]> {
    const held: (string | null)[] = [];
    for (const tier of tiers) {
      if (await this.hasActiveTag(userId, tier.tagName, assocId, manager)) {
        held.push(tier.variantKey);
      }
    }
    return held;
  }

  /**
   * Returns true when the user has an active (non-expired) tag with the given name ISSUED BY
   * `issuingAssocId` - the tier-holding question, which only the tier's own association answers.
   * Pass `manager` inside a transaction (under the buyer's tier lock), so the read uses ITS
   * connection.
   */
  async hasActiveTag(
    userId: string,
    tagName: string,
    issuingAssocId: string,
    manager?: EntityManager
  ): Promise<boolean> {
    const repo = manager ? manager.getRepository(UserTag) : this.repo;
    return isActive(await repo.findOne({ where: { userId, tagName, issuingAssocId } }));
  }

  /**
   * Returns true when the user has an active tag with the given name, whoever issued it. Only for a
   * gate that names tags freely across associations (a product's `requiredTags`); a tier-holding
   * read uses `hasActiveTag`, which counts only the tier's own association's rows.
   */
  async hasActiveTagFromAnyIssuer(
    userId: string,
    tagName: string,
    manager?: EntityManager
  ): Promise<boolean> {
    const repo = manager ? manager.getRepository(UserTag) : this.repo;
    return isActive(await repo.findOne({ where: { userId, tagName } }));
  }

  /**
   * Returns the user's active (non-expired) tag row with the given name issued by
   * `issuingAssocId`, or null if absent or expired. Like `hasActiveTag` but also surfaces
   * `expiresAt` - used where a caller needs the expiry itself, not just a yes/no (e.g. the Cercle
   * inbound cotisant-status check).
   */
  async getActiveTag(
    userId: string,
    tagName: string,
    issuingAssocId: string
  ): Promise<UserTag | null> {
    const tag = await this.repo.findOne({ where: { userId, tagName, issuingAssocId } });
    return isActive(tag) ? tag : null;
  }

  /**
   * The ACTIVE rows, issued by `issuingAssocId`, of any of `tagNames` held by any of `userIds` - in
   * ONE query, for a reader deciding over many buyers at once (the closing of a payment paid for and
   * not granted, and the purchases list's advice on it). Reads through `manager`, after its locks.
   */
  async activeTagsOf(
    userIds: string[],
    tagNames: string[],
    issuingAssocId: string,
    manager: EntityManager
  ): Promise<UserTag[]> {
    if (userIds.length === 0 || tagNames.length === 0) return [];
    const rows = await manager.getRepository(UserTag).find({
      where: { userId: In(userIds), tagName: In(tagNames), issuingAssocId },
    });
    return rows.filter(isActive);
  }

  /**
   * Stamps tag `tagId` as the DELIVERY of purchase record `purchaseRecordId` (metadata key
   * `purchaseRecordId`), when a payment paid for and not granted is closed because the tier it bought
   * is already held as its delivery. Touches nothing else - no expiry, no grantor - so it is not a
   * renewal. Writes only a tag no record has stamped yet: false when one already has (one delivery
   * closes at most one payment), and the caller refuses.
   */
  async stampDelivery(
    tagId: string,
    purchaseRecordId: string,
    manager: EntityManager
  ): Promise<boolean> {
    const rows: unknown[] = await manager.query(
      `UPDATE user_tags SET metadata = metadata || jsonb_build_object('purchaseRecordId', $2::text)
        WHERE id = $1 AND metadata -> 'purchaseRecordId' IS NULL
        RETURNING id`,
      [tagId, purchaseRecordId]
    );
    // node-postgres answers an UPDATE ... RETURNING through TypeORM as [rows, count].
    const written = Array.isArray(rows[0]) ? (rows[0] as unknown[]).length : rows.length;
    if (written === 0) {
      this.logger.warn(
        `[UserTag] tag ${tagId.slice(0, 8)} NOT stamped for purchase=${purchaseRecordId.slice(0, 8)}: ` +
          'it is already the delivery of another payment'
      );
      return false;
    }
    this.logger.log(
      `[UserTag] tag ${tagId.slice(0, 8)} stamped as the delivery of purchase=${purchaseRecordId.slice(0, 8)}`
    );
    return true;
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
    await this.repo.manager.transaction(async (manager) => {
      // The holder is known only from the row, so it is read first; the delete then runs under
      // the holder's tier lock, never between a checkout's rank and its attempt row.
      const tag = await manager.findOne(UserTag, { where: { id: tagId, issuingAssocId } });
      if (!tag) throw new NotFoundException('Tag not found');
      await lockBuyerTiers(manager, issuingAssocId, tag.userId);
      const res = await manager.delete(UserTag, { id: tagId, issuingAssocId });
      if (!res.affected) throw new NotFoundException('Tag not found');
    });
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
