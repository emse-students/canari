import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { socialUrl } from '../internal/service-urls';

/** How long a call to social-service may take: the badge and the notice are not worth a wait. */
const SOCIAL_TIMEOUT_MS = 5_000;

/**
 * THE ALUMNI DUPLICATES AS AN ADMIN QUEUE (owner, 2026-11-26): the memory of which duplicates the
 * admins were told about, and the two calls that put them in the ONE admin-queue mechanism of
 * social-service (`AdminQueuesService`) - a push and a bell row to every global admin, a live badge.
 *
 * WHAT "PENDING" IS is not decided here. A duplicate waits while it is flagged, not resolved, and no
 * merge of it stands (`alumniDuplicatePendingSql`, social-service): the count, the bell gate and the
 * announcement all read that one definition, over this table and `alumni_merges`. Marking a duplicate
 * for a merge therefore clears it for every admin by itself; this service only tells the badges
 * ({@link changed}). When MiConnect completes the merge nothing is announced: the item has been gone
 * since the mark.
 *
 * FOUND BY READING, SO TOLD WHEN FOUND. A duplicate lives at MiConnect; Canari finds it when it reads
 * it - at the sign-in that creates the duplicate's Canari account (`AlumniMergeService.flagNewAccount`)
 * and whenever the admin page is read ({@link reconcile}, which also converges the table on what the
 * page lists). The first finding writes the row and is the ONE push; a row that exists is never
 * announced again (charter principle 3, "your attention is not for sale": admins only, once per
 * duplicate). A duplicate that signs in nowhere in Canari and that no admin reads is found at the next
 * reading; a push at the moment MiConnect creates it is a MiConnect-side event, not built here.
 */
@Injectable()
export class AlumniDuplicateQueue {
  private readonly logger = new Logger(AlumniDuplicateQueue.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';

  constructor(private readonly dataSource: DataSource) {}

  /**
   * The page was read: `matched` are the duplicates it lists with an account they match. Each is
   * flagged ({@link flag}), and every flag still waiting that the reading no longer lists - and no
   * merge of stands - is resolved. NEVER THROWS: the page is answered whatever this does, and each
   * failure is logged at error, because a count that no reading corrects is the defect this ends.
   */
  async reconcile(matched: readonly string[]): Promise<void> {
    for (const uuid of matched) {
      await this.flag(uuid);
    }
    try {
      // The merge clause is `alumniDuplicatePendingSql` (social-service admin-queue-sql.ts): a flag a
      // merge stands for is never resolved here, whatever the page lists.
      const [{ n }] = (await this.dataSource.query(
        `WITH r AS (UPDATE alumni_duplicate_flags f SET "resolvedAt" = now()
          WHERE f."resolvedAt" IS NULL AND NOT (f."duplicateUuid" = ANY($1::uuid[]))
            AND NOT EXISTS (SELECT 1 FROM alumni_merges m
              WHERE m."duplicateUuid" = f."duplicateUuid"::text AND m."cancelledAt" IS NULL)
          RETURNING 1) SELECT count(*)::int AS n FROM r`,
        [[...matched]]
      )) as { n: number }[];
      if (n > 0) {
        this.logger.log(
          `[ALUMNI_QUEUE] ${n} flagged duplicate(s) gone or no longer matching: resolved`
        );
        await this.changed();
      }
    } catch (err) {
      this.logger.error(
        `[ALUMNI_QUEUE] the flags were NOT reconciled with the page: ${String(err)}`
      );
    }
  }

  /**
   * `duplicateUuid` matches an existing account: flags it, and tells the admins ONCE, at the first
   * finding. A flag that was resolved and matches again waits again with NO new notice (the push is
   * once per duplicate, and its bell row follows the item's own state). Never throws.
   */
  async flag(duplicateUuid: string): Promise<void> {
    const tag = duplicateUuid.slice(0, 8);
    try {
      const inserted = (await this.dataSource.query(
        `INSERT INTO alumni_duplicate_flags ("duplicateUuid") VALUES ($1)
         ON CONFLICT ("duplicateUuid") DO NOTHING RETURNING "duplicateUuid"`,
        [duplicateUuid]
      )) as unknown[];
      if (inserted.length === 1) {
        this.logger.log(`[ALUMNI_QUEUE] duplicate ${tag} flagged: telling the admins`);
        await this.announce(duplicateUuid);
        return;
      }
      const reopened = await this.reopen(duplicateUuid);
      if (reopened) {
        this.logger.log(
          `[ALUMNI_QUEUE] duplicate ${tag} matches again: waits again, no new notice`
        );
        await this.changed();
      }
    } catch (err) {
      this.logger.error(`[ALUMNI_QUEUE] duplicate ${tag} was NOT flagged: ${String(err)}`);
    }
  }

  /** Clears the resolution of `duplicateUuid`; true when it WAS resolved. */
  private async reopen(duplicateUuid: string): Promise<boolean> {
    const [{ n }] = (await this.dataSource.query(
      `WITH r AS (UPDATE alumni_duplicate_flags SET "resolvedAt" = NULL
        WHERE "duplicateUuid" = $1 AND "resolvedAt" IS NOT NULL RETURNING 1)
       SELECT count(*)::int AS n FROM r`,
      [duplicateUuid]
    )) as { n: number }[];
    return n === 1;
  }

  /**
   * An item left the queue or came back to it (a duplicate marked for a merge, a mark withdrawn):
   * the admins' badges recount. No notice. Never throws; a badge that does not move is said at error.
   */
  async changed(): Promise<void> {
    try {
      await axios.post(
        socialUrl('internal/notifications/alumni-duplicates-changed'),
        {},
        { headers: { 'X-Internal-Secret': this.internalSecret }, timeout: SOCIAL_TIMEOUT_MS }
      );
    } catch (err) {
      this.logger.error(
        `[ALUMNI_QUEUE] the admins' badges were NOT told the queue changed: ${String(err)}`
      );
    }
  }

  /**
   * The ONE notice of a duplicate. The flag is already durable and counted whatever happens here, so
   * a failure is logged at error and never undone - but an admin not told is the defect this notice
   * ends (the contract of `ProfileCorrectionService.announceFiled`).
   */
  private async announce(duplicateUuid: string): Promise<void> {
    try {
      await axios.post(
        socialUrl('internal/notifications/alumni-duplicate-flagged'),
        { duplicateUuid },
        { headers: { 'X-Internal-Secret': this.internalSecret }, timeout: SOCIAL_TIMEOUT_MS }
      );
    } catch (err) {
      this.logger.error(
        `[ALUMNI_QUEUE] duplicate ${duplicateUuid.slice(0, 8)}: its announcement to the admins was NOT confirmed (social refused, failed or outran the timeout): ${String(err)}`
      );
    }
  }
}
