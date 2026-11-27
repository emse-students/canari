import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { socialUrl } from '../internal/service-urls';

/** How long a call to social-service may take: the badge and the notice are not worth a wait. */
const SOCIAL_TIMEOUT_MS = 5_000;

/**
 * The most duplicates one announcement carries - social-service refuses more
 * (`MAX_FOUND`, `internal-alumni-duplicates.controller.ts`), so a backlog goes out in batches.
 */
export const ALUMNI_FOUND_BATCH = 200;

/** What {@link AlumniDuplicateQueue.flag} did with a duplicate. */
export type FlagOutcome = 'created' | 'reopened' | 'known' | 'failed';

/**
 * THE ALUMNI DUPLICATES AS AN ADMIN QUEUE (owner, 2026-11-26): the memory of which duplicates the
 * admins were told about, and the calls that put them in the ONE admin-queue mechanism of
 * social-service (`AdminQueuesService`) - a push and a bell row to the global admins, a live badge.
 *
 * WHAT "PENDING" IS is not decided here. A duplicate waits while it is flagged, not resolved, and no
 * merge of it stands - marked or completed (`alumniDuplicatePendingSql`, social-service): the count,
 * the bell gate and the announcement all read that one definition, over this table and
 * `alumni_merges`. Marking a duplicate for a merge therefore clears it for every admin by itself;
 * this service only tells the badges ({@link changed}).
 *
 * WHAT IS FLAGGED: only a duplicate an admin can act on - an Alumni-created account with a candidate
 * to attach to (`AlumniMergeService.listDuplicates`, the lead's reading of D55, 2026-11-27). An
 * alumnus nobody on the CAS side matches is not a duplicate and is never flagged or announced.
 * "Pas un doublon" ({@link dismiss}) is the admin's TERMINAL answer for one that looks like one and
 * is not: durable (`dismissedAt`), never cleared, so no later reading and no later sign-in flags it
 * again.
 *
 * FOUND BY READING, SO TOLD WHEN FOUND. A duplicate lives at MiConnect; Canari finds it when it reads
 * it - at the sign-in that creates the duplicate's Canari account (`AlumniMergeService.flagNewAccount`,
 * its own notice) and whenever the admin page is read ({@link reconcile}). A notice is ONCE per
 * duplicate (charter principle 3, "your attention is not for sale": admins only, never a repeat) and
 * is durable: `announcedAt` is written only AFTER social accepted it, so a refused or failed call is
 * tried again at the next reading and is never lost for good - nor repeated once it landed. A reading
 * that finds several tells them in batches ({@link ALUMNI_FOUND_BATCH}), one push and ONE bell row
 * each, never one row per duplicate: a backlog found at once is a push and a badge, not a flood in
 * every admin's bell.
 */
@Injectable()
export class AlumniDuplicateQueue {
  private readonly logger = new Logger(AlumniDuplicateQueue.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';

  constructor(private readonly dataSource: DataSource) {}

  /**
   * The database's clock: a reading's start is compared to `flaggedAt`, which the database writes,
   * so both come from ONE clock (an application server's clock may be skewed against it).
   */
  async databaseNow(): Promise<Date> {
    const [{ t }] = (await this.dataSource.query(`SELECT now() AS t`)) as { t: Date }[];
    return new Date(t);
  }

  /** Which of `uuids` an admin answered "Pas un doublon" for: they are never listed nor flagged. */
  async dismissedAmong(uuids: readonly string[]): Promise<Set<string>> {
    if (uuids.length === 0) return new Set();
    const rows = (await this.dataSource.query(
      `SELECT "duplicateUuid"::text AS uuid FROM alumni_duplicate_flags
        WHERE "dismissedAt" IS NOT NULL AND "duplicateUuid" = ANY($1::uuid[])`,
      [[...uuids]]
    )) as { uuid: string }[];
    return new Set(rows.map((r) => r.uuid));
  }

  /**
   * "Pas un doublon": the admins' TERMINAL answer. The row is written if the duplicate was never
   * flagged, resolved either way, and `dismissedAt` is set once and never cleared - {@link flag}
   * and {@link reconcile} leave it alone for good. Throws on a failed write (the admin acted and
   * must be told it did not land); the badges are told only after it did.
   */
  async dismiss(duplicateUuid: string): Promise<void> {
    this.logger.log(`[ALUMNI_QUEUE] dismissing duplicate ${duplicateUuid.slice(0, 8)}`);
    await this.dataSource.query(
      `INSERT INTO alumni_duplicate_flags ("duplicateUuid", "resolvedAt", "dismissedAt")
       VALUES ($1, now(), now())
       ON CONFLICT ("duplicateUuid") DO UPDATE
         SET "dismissedAt" = COALESCE(alumni_duplicate_flags."dismissedAt", now()),
             "resolvedAt" = COALESCE(alumni_duplicate_flags."resolvedAt", now())`,
      [duplicateUuid]
    );
    await this.changed();
  }

  /**
   * The page was read, the reading having BEGUN at `readStartedAt` (the DATABASE's clock,
   * {@link databaseNow}): `matched` are the duplicates it listed. Each is flagged ({@link flag}, no
   * notice of its own); the flags still waiting that the reading no longer lists - and no merge of
   * stands - are resolved, but ONLY those flagged BEFORE the reading began: a duplicate a sign-in
   * flagged while the reading ran is not in what it saw, and is not for it to resolve. Then every
   * notice still owed is told ({@link announceOwed}), or just a recount of the badges. NEVER THROWS:
   * the page is answered whatever this does, and each failure is logged at error.
   */
  async reconcile(matched: readonly string[], readStartedAt: Date): Promise<void> {
    this.logger.log(
      `[ALUMNI_QUEUE] reconciling ${matched.length} listed duplicate(s) with the flags (reading begun ${readStartedAt.toISOString()})`
    );
    let reopened = 0;
    for (const uuid of matched) {
      if ((await this.flag(uuid, false)) === 'reopened') reopened += 1;
    }
    let resolved = 0;
    try {
      // The merge clause mirrors `alumniDuplicatePendingSql` (social-service admin-queue-sql.ts),
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
          `[ALUMNI_QUEUE] ${n} flagged duplicate(s) gone or no longer a candidate: resolved`
        );
      }
    } catch (err) {
      this.logger.error(
        `[ALUMNI_QUEUE] the flags were NOT reconciled with the page: ${String(err)}`
      );
    }
    const told = await this.announceOwed();
    if (told === 0 && (resolved > 0 || reopened > 0)) await this.changed();
  }

  /**
   * `duplicateUuid` is a duplicate an admin can act on: flags it. A NEW flag is told to the admins
   * at once when `announce` (the sign-in's own notice) and is otherwise left to {@link reconcile}'s
   * {@link announceOwed}. A flag that was resolved and is found again waits again with NO new notice
   * (it was told once), EXCEPT one dismissed: that is terminal and never waits again. Never throws.
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
        if (announce) await this.announceBatches([duplicateUuid]);
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

  /** Clears the resolution of `duplicateUuid` unless it was dismissed; true when it WAS resolved. */
  private async reopen(duplicateUuid: string): Promise<boolean> {
    const [{ n }] = (await this.dataSource.query(
      `WITH r AS (UPDATE alumni_duplicate_flags SET "resolvedAt" = NULL
        WHERE "duplicateUuid" = $1 AND "resolvedAt" IS NOT NULL AND "dismissedAt" IS NULL
        RETURNING 1)
       SELECT count(*)::int AS n FROM r`,
      [duplicateUuid]
    )) as { n: number }[];
    return n === 1;
  }

  /**
   * An item left the queue or came back to it (a duplicate marked for a merge, a mark withdrawn, one
   * dismissed): the admins' badges recount. No notice. Never throws; a badge that does not move is
   * said at error.
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
   * Tells the admins of every flag still waiting whose notice was never confirmed (`announcedAt` is
   * null): the ones this reading just flagged AND the ones an earlier refused or failed call left.
   * Answers how many batches social accepted (each signals the badges itself).
   */
  private async announceOwed(): Promise<number> {
    let owed: string[];
    try {
      owed = (
        (await this.dataSource.query(
          `SELECT f."duplicateUuid"::text AS uuid FROM alumni_duplicate_flags f
            WHERE f."announcedAt" IS NULL AND f."resolvedAt" IS NULL
              AND NOT EXISTS (SELECT 1 FROM alumni_merges m
                WHERE m."duplicateUuid" = f."duplicateUuid"::text AND m."cancelledAt" IS NULL)
            ORDER BY f."flaggedAt"`
        )) as { uuid: string }[]
      ).map((r) => r.uuid);
    } catch (err) {
      this.logger.error(`[ALUMNI_QUEUE] the notices owed were NOT read: ${String(err)}`);
      return 0;
    }
    if (owed.length === 0) return 0;
    this.logger.log(`[ALUMNI_QUEUE] ${owed.length} duplicate notice(s) owed`);
    return this.announceBatches(owed);
  }

  /**
   * The ONE notice of what a finding flagged, in batches of {@link ALUMNI_FOUND_BATCH}: each batch is
   * a push and one bell row (social-service decides). `announcedAt` is written only after social
   * accepted the batch; a failing batch is logged at error and does NOT stop the others - its flags
   * keep `announcedAt` null and the next reading tells again. Answers how many batches landed.
   */
  private async announceBatches(duplicateUuids: readonly string[]): Promise<number> {
    let landed = 0;
    for (let at = 0; at < duplicateUuids.length; at += ALUMNI_FOUND_BATCH) {
      const batch = duplicateUuids.slice(at, at + ALUMNI_FOUND_BATCH);
      this.logger.log(`[ALUMNI_QUEUE] telling the admins of ${batch.length} new duplicate(s)`);
      try {
        await axios.post(
          socialUrl('internal/notifications/alumni-duplicates-found'),
          { duplicateUuids: batch },
          { headers: { 'X-Internal-Secret': this.internalSecret }, timeout: SOCIAL_TIMEOUT_MS }
        );
      } catch (err) {
        this.logger.error(
          `[ALUMNI_QUEUE] ${batch.length} new duplicate(s): the announcement to the admins was NOT confirmed (social refused, failed or outran the timeout), it is tried again at the next reading: ${String(err)}`
        );
        continue;
      }
      landed += 1;
      try {
        await this.dataSource.query(
          `UPDATE alumni_duplicate_flags SET "announcedAt" = now()
            WHERE "duplicateUuid" = ANY($1::uuid[]) AND "announcedAt" IS NULL`,
          [batch]
        );
      } catch (err) {
        this.logger.error(
          `[ALUMNI_QUEUE] ${batch.length} duplicate(s) were announced but NOT recorded as announced - the next reading will tell them AGAIN: ${String(err)}`
        );
      }
    }
    return landed;
  }
}
