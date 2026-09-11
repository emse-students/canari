import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { LegacyCotisation } from './entities/legacy-cotisation.entity';
import { UserTagService } from './user-tag.service';
import { normalizeMatchKey } from './legacy-cotisation.util';

/** Identity a signing-in user is matched on. Supplied by core-service, which owns the `users` table. */
export interface ClaimantIdentity {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  promo: number | null;
}

/** What one claim attempt did, so the caller can log it and the admin screen can count it. */
export interface ClaimOutcome {
  /** Tags actually granted by this attempt. */
  granted: number;
  /** Rows closed without granting because the user already held that association's cotisation. */
  alreadyHeld: number;
  /** Rows left pending because the grant threw - retried on the next sign-in. */
  failed: number;
  /** Rows matching this identity that ANOTHER account already claimed. Always a person to check. */
  conflicts: number;
}

const EMPTY: ClaimOutcome = { granted: 0, alreadyHeld: 0, failed: 0, conflicts: 0 };

/** Which slice of the staging table the admin screen is asking for. */
export type LegacyCotisationStatus = 'all' | 'pending' | 'claimed' | 'collisions';

/** One staging row as the admin screen shows it, joined to the account that claimed it. */
export interface LegacyCotisationAdminItem {
  id: string;
  /** What the source said, verbatim - accents intact, unlike `matchKey`. */
  sourceLabel: string;
  /** The normalized key the claim actually matches on, shown because it is what a diagnosis needs. */
  matchKey: string;
  associationId: string;
  associationName: string | null;
  variantKey: string | null;
  sourceBatch: string;
  claimedByUserId: string | null;
  claimedAt: Date | null;
  /** Branch that closed the row: `granted`, or `already-held` when Canari already knew better. */
  disposition: string | null;
  claimantFirstName: string | null;
  claimantLastName: string | null;
  claimantPromo: number | null;
  /**
   * Rows sharing this row's `(matchKey, associationId)`. Anything above 1 is a homonym in the same
   * promo or a duplicated source row, and the claim cannot tell those apart - a human must.
   */
  keyRowCount: number;
  createdAt: Date;
}

/** One page of the staging table, plus the estate-wide tallies the tabs are labelled with. */
export interface LegacyCotisationAdminPage {
  items: LegacyCotisationAdminItem[];
  /** Rows matching the CURRENT status and search, which is what pagination walks. */
  total: number;
  hasMore: boolean;
  /** Tallies over the WHOLE table, never the filtered slice - they are the headline, not the page. */
  counts: { pending: number; claimed: number; collisions: number };
}

const DEFAULT_ADMIN_LIMIT = 50;
const MAX_ADMIN_LIMIT = 200;

/** Raw row shape returned by the admin listing SQL. */
interface RawAdminRow {
  id: string;
  sourceLabel: string;
  matchKey: string;
  associationId: string;
  associationName: string | null;
  variantKey: string | null;
  sourceBatch: string;
  claimedByUserId: string | null;
  claimedAt: Date | string | null;
  disposition: string | null;
  claimantFirstName: string | null;
  claimantLastName: string | null;
  claimantPromo: number | null;
  keyRowCount: string;
  createdAt: Date | string;
}

/** Maps a raw admin row, normalizing the date and bigint columns the driver hands back as strings. */
function toAdminItem(row: RawAdminRow): LegacyCotisationAdminItem {
  return {
    id: row.id,
    sourceLabel: row.sourceLabel,
    matchKey: row.matchKey,
    associationId: row.associationId,
    associationName: row.associationName,
    variantKey: row.variantKey,
    sourceBatch: row.sourceBatch,
    claimedByUserId: row.claimedByUserId,
    claimedAt: row.claimedAt ? new Date(row.claimedAt) : null,
    disposition: row.disposition,
    claimantFirstName: row.claimantFirstName,
    claimantLastName: row.claimantLastName,
    claimantPromo: row.claimantPromo,
    keyRowCount: Number(row.keyRowCount),
    createdAt: new Date(row.createdAt),
  };
}

/**
 * Grants the cotisations a legacy estate recorded for someone who had no Canari account at the
 * time, the moment that person signs in and is recognized.
 *
 * Called on EVERY sign-in, not only the first. The claim terminates because the staging row carries
 * `claimedByUserId`, not because the account is new: keyed on first login it would strand everyone
 * who signed in before their association's list was loaded, and a grant that failed at that one
 * instant could never be retried. Against the indexed `matchKey`, a user with nothing waiting costs
 * one lookup that returns no rows.
 */
@Injectable()
export class LegacyCotisationService {
  private readonly logger = new Logger(LegacyCotisationService.name);

  constructor(
    @InjectRepository(LegacyCotisation)
    private readonly repo: Repository<LegacyCotisation>,
    private readonly userTagService: UserTagService
  ) {}

  /**
   * Claims every legacy cotisation waiting for this identity.
   *
   * Never throws: a cotisation that cannot be granted must not cost somebody their sign-in. Each
   * row is caught on its own so one bad association cannot swallow the rows behind it, and a row
   * left pending by a failure is simply retried the next time the user signs in.
   */
  async claimFor(identity: ClaimantIdentity): Promise<ClaimOutcome> {
    const matchKey = normalizeMatchKey(identity.lastName, identity.firstName, identity.promo);
    if (!matchKey) {
      // Not an error: most accounts have no legacy dues, and Authentik does not always carry a
      // promo. Logged because it is also the only reason a real cotisant would silently get nothing.
      this.logger.debug(
        `[legacy] no match key for user=${identity.userId.slice(0, 8)} (promo=${identity.promo ?? 'none'})`
      );
      return EMPTY;
    }

    // One query answers both questions: what is waiting, and whether somebody else already took it.
    const rows = await this.repo.find({ where: { matchKey } });
    if (rows.length === 0) return EMPTY;

    const pending = rows.filter((r) => r.claimedByUserId === null);
    const takenByOthers = rows.filter(
      (r) => r.claimedByUserId !== null && r.claimedByUserId !== identity.userId
    );

    const outcome: ClaimOutcome = { ...EMPTY, conflicts: takenByOthers.length };
    for (const row of takenByOthers) {
      // Two people normalize to one key: a real homonym in the same promo, or a duplicated source
      // row. Either way a human must look, and nothing here may guess which account should hold it.
      this.logger.warn(
        `[legacy] CONFLICT: "${row.sourceLabel}" (batch=${row.sourceBatch}) was already claimed by ` +
          `${row.claimedByUserId?.slice(0, 8)}, and ${identity.userId.slice(0, 8)} matches the same key`
      );
    }

    for (const row of pending) {
      try {
        // A cotisation bought in Canari outranks anything a legacy list says. Without this the XOR
        // in `grantCotisant` would revoke the tier they paid for and hand them the legacy one -
        // and with 200 BDE and 234 Cercle tags already held across 395 accounts, that is the
        // ordinary case here, not an edge one.
        if (await this.userTagService.holdsAnyCotisation(identity.userId, row.associationId)) {
          await this.close(row, identity.userId, 'already-held');
          outcome.alreadyHeld++;
          continue;
        }

        // Granted BEFORE the row is closed, deliberately. `grantOrRenew` upserts on
        // `(userId, tagName)`, so a crash between the two costs a repeated grant on the next
        // sign-in; closing first would cost the cotisation outright.
        await this.userTagService.grantCotisant(
          row.associationId,
          identity.userId,
          'system:legacy-import',
          row.variantKey,
          { legacy: { batch: row.sourceBatch, sourceLabel: row.sourceLabel, ...row.metadata } }
        );
        await this.close(row, identity.userId, 'granted');
        outcome.granted++;
        this.logger.log(
          `[legacy] granted ${row.variantKey ?? 'base'} of assoc=${row.associationId} to ` +
            `${identity.userId.slice(0, 8)} from "${row.sourceLabel}" (batch=${row.sourceBatch})`
        );
      } catch (err) {
        outcome.failed++;
        this.logger.error(
          `[legacy] FAILED to claim "${row.sourceLabel}" (batch=${row.sourceBatch}, ` +
            `assoc=${row.associationId}) for ${identity.userId.slice(0, 8)}: ${String(err)} - ` +
            `row left pending, retried on next sign-in`
        );
      }
    }

    return outcome;
  }

  /**
   * Returns a page of the staging table for the admin screen, with the estate-wide tallies.
   *
   * Read-only, and deliberately the ONLY window onto this mechanism: a claim that grants nothing
   * leaves no trace a user can see, so without this screen the one way to answer "why do I not have
   * my tag" is to read the service logs. The row carries `matchKey` alongside `sourceLabel` because
   * the answer is almost always the difference between the two.
   */
  async listForAdmin(
    opts: { status?: LegacyCotisationStatus; search?: string; offset?: number; limit?: number } = {}
  ): Promise<LegacyCotisationAdminPage> {
    const status: LegacyCotisationStatus = opts.status ?? 'all';
    const search = opts.search?.trim() || null;
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const limit = Math.min(
      Math.max(1, Math.trunc(opts.limit ?? DEFAULT_ADMIN_LIMIT)),
      MAX_ADMIN_LIMIT
    );
    this.logger.debug(
      `[legacy] listForAdmin status=${status} search=${search ?? '-'} offset=${offset} limit=${limit}`
    );

    // The window count is what makes a collision visible at all: the pending-only unique index lets
    // a second row exist for a key once the first is claimed, which is exactly the homonym case.
    const counted = `SELECT lc.*, COUNT(*) OVER (PARTITION BY lc."matchKey", lc."associationId") AS "keyRowCount"
                     FROM legacy_cotisations lc`;

    // $1=search (nullable), $2=status - parameterized, no string concatenation of user input.
    // Search spans both spellings: `sourceLabel` keeps the accents a human types, `matchKey` is
    // stripped of them, so an accent-free query still finds the row.
    const baseFrom = `FROM (${counted}) r
       LEFT JOIN users u ON u.id = r."claimedByUserId"
       LEFT JOIN associations a ON a.id = r."associationId"
       WHERE ($1::text IS NULL OR r."sourceLabel" ILIKE '%' || $1 || '%' OR r."matchKey" ILIKE '%' || $1 || '%')
         AND ($2::text = 'all'
           OR ($2 = 'pending' AND r."claimedByUserId" IS NULL)
           OR ($2 = 'claimed' AND r."claimedByUserId" IS NOT NULL)
           OR ($2 = 'collisions' AND r."keyRowCount" > 1))`;

    // Colliding rows are only readable next to each other, so that tab groups by key; every other
    // tab leads with the most recent claim, then falls back to the source's own spelling.
    const orderBy =
      status === 'collisions'
        ? `ORDER BY r."matchKey" ASC, r."associationId" ASC, r."claimedAt" ASC NULLS LAST`
        : `ORDER BY r."claimedAt" DESC NULLS LAST, r."sourceLabel" ASC`;

    const [countRows, rows, tallyRows] = await Promise.all([
      this.repo.manager.query(`SELECT COUNT(*)::text AS count ${baseFrom}`, [
        search,
        status,
      ]) as Promise<{ count: string }[]>,
      this.repo.manager.query(
        `SELECT r.id AS "id", r."sourceLabel" AS "sourceLabel", r."matchKey" AS "matchKey",
                r."associationId" AS "associationId", a.name AS "associationName",
                r."variantKey" AS "variantKey", r."sourceBatch" AS "sourceBatch",
                r."claimedByUserId" AS "claimedByUserId", r."claimedAt" AS "claimedAt",
                r.metadata->>'disposition' AS "disposition",
                u."firstName" AS "claimantFirstName", u."lastName" AS "claimantLastName",
                u.promo AS "claimantPromo", r."keyRowCount"::text AS "keyRowCount",
                r."createdAt" AS "createdAt"
         ${baseFrom}
         ${orderBy}
         LIMIT $3 OFFSET $4`,
        [search, status, limit, offset]
      ) as Promise<RawAdminRow[]>,
      this.repo.manager.query(
        `SELECT COUNT(*) FILTER (WHERE "claimedByUserId" IS NULL)::text AS pending,
                COUNT(*) FILTER (WHERE "claimedByUserId" IS NOT NULL)::text AS claimed,
                COUNT(*) FILTER (WHERE "keyRowCount" > 1)::text AS collisions
         FROM (${counted}) c`
      ) as Promise<{ pending: string; claimed: string; collisions: string }[]>,
    ]);

    const total = Number(countRows[0]?.count ?? 0);
    const items = rows.map((row) => toAdminItem(row));
    const hasMore = offset + items.length < total;
    this.logger.debug(
      `[legacy] listForAdmin returned ${items.length}/${total} (hasMore=${hasMore})`
    );
    return {
      items,
      total,
      hasMore,
      counts: {
        pending: Number(tallyRows[0]?.pending ?? 0),
        claimed: Number(tallyRows[0]?.claimed ?? 0),
        collisions: Number(tallyRows[0]?.collisions ?? 0),
      },
    };
  }

  /** Stamps the row as claimed, recording which branch closed it. */
  private async close(
    row: LegacyCotisation,
    userId: string,
    disposition: 'granted' | 'already-held'
  ): Promise<void> {
    await this.repo.update(
      { id: row.id, claimedByUserId: IsNull() },
      {
        claimedByUserId: userId,
        claimedAt: new Date(),
        metadata: { ...row.metadata, disposition },
      }
    );
  }
}
