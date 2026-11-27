import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { socialUrl } from '../internal/service-urls';

/** How long a call to social-service may take: the badge and the notice are not worth a wait. */
const SOCIAL_TIMEOUT_MS = 5_000;

/** What {@link AlumniDuplicateQueue.flag} did with a duplicate. */
export type FlagOutcome = 'created' | 'reopened' | 'known' | 'failed';

/**
 * THE ALUMNI DUPLICATES AS AN ADMIN QUEUE (owner, 2026-11-26): the memory of which duplicates the
 * admins were told about, and the calls that put them in the ONE admin-queue mechanism of
 * social-service (`AdminQueuesService`) - a push and a bell row to every global admin, a live badge.
 *
 * WHAT "PENDING" IS is not decided here. A duplicate waits while it is flagged, not resolved, and no
 * merge of it stands - marked or completed (`alumniDuplicatePendingSql`, social-service): the count,
 * the bell gate and the announcement all read that one definition, over this table and
 * `alumni_merges`. Marking a duplicate for a merge therefore clears it for every admin by itself;
 * this service only tells the badges ({@link changed}). When MiConnect completes the merge nothing is
 * announced: the item has been gone since the mark, and the completion resolves the flag
 * (`COMPLETE_MERGE_SQL`).
 *
 * ONLY WHAT THE MARK ACCEPTS IS FLAGGED: callers pass duplicates `autoMergeRefusal` accepts, never a
 * homonym or another case the admins have no action for yet.
 *
 * FOUND BY READING, SO TOLD WHEN FOUND. A duplicate lives at MiConnect; Canari finds it when it reads
 * it - at the sign-in that creates the duplicate's Canari account (`AlumniMergeService.flagNewAccount`,
 * which keeps its own push) and whenever the admin page is read ({@link reconcile}). The first
 * finding writes the row; a row that exists is never announced again (charter principle 3, "your
 * attention is not for sale": admins only, once per duplicate). A page reading that finds SEVERAL
 * sends ONE push for all of them, never a burst. A duplicate that signs in nowhere in Canari and that
 * no admin reads is found at the next reading; a push at the moment MiConnect creates it is a
 * MiConnect-side event, not built here.
 */
@Injectable()
export class AlumniDuplicateQueue {
  private readonly logger = new Logger(AlumniDuplicateQueue.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';

  constructor(private readonly dataSource: DataSource) {}

  /**
   * The page was read, the reading having BEGUN at `readStartedAt`: `matched` are the duplicates it
   * listed that the mark accepts. Each is flagged ({@link flag}, no push of its own); the flags still
   * waiting that the reading no longer lists - and no merge of stands - are resolved, but ONLY those
   * flagged BEFORE the reading began: a duplicate a sign-in flagged while the reading ran is not in
   * what it saw, and is not for it to resolve. Then the admins are told once, whatever the count:
   * one push for every duplicate this reading flagged, or just a recount of the badges. NEVER
   * THROWS: the page is answered whatever this does, and each failure is logged at error.
   */
  async reconcile(matched: readonly string[], readStartedAt: Date): Promise<void> {
    this.logger.log(
      `[ALUMNI_QUEUE] reconciling ${matched.length} listed duplicate(s) with the flags (reading begun ${readStartedAt.toISOString()})`
    );
    const created: string[] = [];
    let reopened = 0;
    for (const uuid of matched) {
      const outcome = await this.flag(uuid, false);
      if (outcome === 'created') created.push(uuid);
      if (outcome === 'reopened') reopened += 1;
    }
    let resolved = 0;
    try {
      // The merge clause mirrors \`alumniDuplicatePendingSql\` (social-service admin-queue-sql.ts),
      // more cautiously: ANY non-cancelled merge row keeps a flag, a requested one included.
      const [{ n }] = (await this.dataSource.query(
        `WITH r AS (UPDATE alumni_duplicate_flags f SET "resolvedAt" = now()
          WHERE f."resolvedAt" IS NULL AND f."flaggedAt" < $2
            AND NOT (f."duplicateUuid" = ANY($1::uuid[]))
            AND NOT EXISTS (SELECT 1 FROM alumni_merges m
              WHERE m."duplicateUuid" = f."duplicateUuid"::text AND m."cancelledAt" IS NULL)
          RETURNING 1) SELECT count(*)::int AS n FROM r`,
        [[...matched], readStartedAt]
      )) as { n: number }[];
      resolved = n;
      if (n > 0) {
        this.logger.log(
          `[ALUMNI_QUEUE] ${n} flagged duplicate(s) gone or no longer matching: resolved`
        );
      }
    } catch (err) {
      this.logger.error(
        `[ALUMNI_QUEUE] the flags were NOT reconciled with the page: ${String(err)}`
      );
    }
    if (created.length > 0) {
      await this.announceMany(created);
    } else if (resolved > 0 || reopened > 0) {
      await this.changed();
    }
  }

  /**
   * \`duplicateUuid\` is a duplicate the mark accepts: flags it. A NEW flag is told to the admins at
   * once when \`announce\` (the sign-in's own push) and is otherwise left to the caller to tell
   * ({@link reconcile} tells a reading's flags together). A flag that was resolved and is found again
   * waits again with NO notice (the push is once per duplicate, and its bell row follows the item's
   * own state). Never throws.
   */
  async flag(duplicateUuid: string, announce = true): Promise<FlagOutcome> {
    const tag = duplicateUuid.slice(0, 8);
    this.logger.debug(`[ALUMNI_QUEUE] flagging duplicate ${tag} (announce=${announce})`);
    try {
      const inserted = (await this.dataSource.query(
        `INSERT INTO alumni_duplicate_flags ("duplicateUuid") VALUES ($1)
         ON CONFLICT ("duplicateUuid") DO NOTHING RETURNING "duplicateUuid"`,
        [duplicateUuid]
      )) as unknown[];
      if (inserted.length === 1) {
        this.logger.log(`[ALUMNI_QUEUE] duplicate ${tag} flagged`);
        if (announce) await this.announceMany([duplicateUuid]);
        return 'created';
      }
      if (await this.reopen(duplicateUuid)) {
        this.logger.log(`[ALUMNI_QUEUE] duplicate ${tag} found again: waits again, no new notice`);
        if (announce) await this.changed();
        return 'reopened';
      }
      return 'known';
    } catch (err) {
      this.logger.error(`[ALUMNI_QUEUE] duplicate ${tag} was NOT flagged: ${String(err)}`);
      return 'failed';
    }
  }

  /** Clears the resolution of \`duplicateUuid\`; true when it WAS resolved. */
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
    this.logger.debug('[ALUMNI_QUEUE] telling the admins the queue changed');
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
   * The ONE notice of what a finding flagged: a bell row for each duplicate and ONE push for all of
   * them (social-service decides which row carries it). The flags are already durable and counted
   * whatever happens here, so a failure is logged at error and never undone - but an admin not told
   * is the defect this notice ends (the contract of \`ProfileCorrectionService.announceFiled\`).
   */
  private async announceMany(duplicateUuids: readonly string[]): Promise<void> {
    this.logger.log(
      `[ALUMNI_QUEUE] telling the admins of ${duplicateUuids.length} new duplicate(s)`
    );
    try {
      await axios.post(
        socialUrl('internal/notifications/alumni-duplicates-found'),
        { duplicateUuids },
        { headers: { 'X-Internal-Secret': this.internalSecret }, timeout: SOCIAL_TIMEOUT_MS }
      );
    } catch (err) {
      this.logger.error(
        `[ALUMNI_QUEUE] ${duplicateUuids.length} new duplicate(s): the announcement to the admins was NOT confirmed (social refused, failed or outran the timeout): ${String(err)}`
      );
    }
  }
}
