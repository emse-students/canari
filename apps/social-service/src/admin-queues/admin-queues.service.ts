import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ContentReport } from '../moderation/entities/content-report.entity';
import { AssociationsService } from '../associations/associations.service';
import {
  NotificationPushFailedError,
  PostNotificationsService,
  SYSTEM_ACTOR_ID,
  SYSTEM_ACTOR_NAME,
} from '../posts/post-notifications.service';
import { reportInBdeScopeSql } from '../spaces/bde-moderation';
import { holdsBdeAgendaRightOverSql } from '../spaces/bde';
import { AdminQueueSignal, type AdminQueueChange } from './admin-queue-signal.service';
import {
  ADMIN_ALUMNI_DUPLICATES_TARGET,
  ADMIN_MODERATION_TARGET,
  ADMIN_PROFILE_CORRECTIONS_TARGET,
} from '../push/push-target';
import {
  LOCK_REPORT_SUBJECT_SQL,
  REPORT_ALREADY_ANNOUNCED_SQL,
  alumniDuplicatePendingSql,
  calendarEventPendingSql,
  profileCorrectionPendingSql,
  reportPendingSql,
} from './admin-queue-sql';

/**
 * The admin queues a pending count is kept for, named by the key of their entry in the client's
 * admin registry (`frontend/src/lib/admin/adminSections.ts`), so a count lands on its row by name.
 */
export const ADMIN_QUEUE_KEYS = [
  'agenda',
  'moderation',
  'profile-corrections',
  'alumni-duplicates',
] as const;

/** One of {@link ADMIN_QUEUE_KEYS}. */
export type AdminQueueKey = (typeof ADMIN_QUEUE_KEYS)[number];

/**
 * The pending items of each queue the caller may ACT on. A queue the caller cannot open is ABSENT,
 * never zero: the client draws a badge only for a row it lists, and an absent key says nothing about
 * a queue the caller has no right to know the size of.
 */
export type AdminQueueCounts = Partial<Record<AdminQueueKey, number>>;

/** The queues whose new items are told to every global admin (owner, 2026-11-18; 2026-11-26). */
type AnnouncedQueue = 'profile-corrections' | 'moderation' | 'alumni-duplicates';

const ANNOUNCED: Readonly<
  Record<
    AnnouncedQueue,
    { type: 'admin_profile_correction' | 'admin_report' | 'admin_alumni_duplicate'; target: string }
  >
> = {
  'alumni-duplicates': { type: 'admin_alumni_duplicate', target: ADMIN_ALUMNI_DUPLICATES_TARGET },
  'profile-corrections': {
    type: 'admin_profile_correction',
    target: ADMIN_PROFILE_CORRECTIONS_TARGET,
  },
  moderation: { type: 'admin_report', target: ADMIN_MODERATION_TARGET },
};

/**
 * THE ADMIN QUEUES' ONE MECHANISM (owner, 2026-11-18): how many items wait in each queue the caller
 * may act on, and the notice every global admin is given when a new one arrives.
 *
 * COUNTS COME FROM THE QUEUES' OWN ROWS, at every read: no counter is kept, so a badge is right after
 * a reload, on another device, and the moment another admin handles an item. The scope of a queue is
 * the scope its page and its actions already apply - `reportInBdeScopeSql` for a BDE or institution
 * moderator, `holdsBdeAgendaRightOverSql` for an event validator (each event's `canValidate`), the
 * platform administrator alone for the profile corrections and the Alumni duplicates - so a count never exceeds what the same
 * caller is shown and allowed to handle.
 *
 * THE NOTICE CLEARS BY ITSELF: its bell row is shown only while its reader is a global admin and the
 * item still waits (`BELL_ROW_GATE`), so one admin's answer takes it off every admin's bell. A push
 * already delivered to a device cannot be recalled; it opens the queue, which no longer lists it.
 * docs/wiki/frontend/modules/admin.md, "Pending counts and the admin notices".
 */
@Injectable()
export class AdminQueuesService {
  private readonly logger = new Logger(AdminQueuesService.name);

  constructor(
    @InjectRepository(ContentReport) private readonly reports: Repository<ContentReport>,
    private readonly associations: AssociationsService,
    private readonly notifications: PostNotificationsService,
    private readonly signal: AdminQueueSignal
  ) {}

  /**
   * An item entered or left a queue: the accounts that may act on it refetch their counts
   * (`AdminQueueSignal`). For the routes that hold this service; a service that moves an item
   * itself injects the signal. Never throws.
   */
  async queueChanged(change: AdminQueueChange): Promise<void> {
    await this.signal.changed(change);
  }

  /**
   * The caller's pending counts, ONE statement over the queues their tiers open: a global admin all
   * four; otherwise the reports if they moderate somewhere (`isContentModerator`, the queue's own
   * door) and the agenda if they validate events somewhere (`isUserBdeAdmin`, the agenda queue's
   * door) - each counted within the reach their page applies.
   */
  async pendingCounts(userId: string, isGlobalAdmin: boolean): Promise<AdminQueueCounts> {
    const [moderates, validates] = isGlobalAdmin
      ? [true, true]
      : await Promise.all([
          this.associations.isContentModerator(userId, { isGlobalAdmin: false }),
          this.associations.isUserBdeAdmin(userId),
        ]);
    const columns: string[] = [];
    if (isGlobalAdmin) {
      columns.push(`(SELECT count(*)::int FROM profile_correction_requests pcr
          WHERE ${profileCorrectionPendingSql('pcr')}) AS "profile-corrections"`);
      columns.push(`(SELECT count(*)::int FROM alumni_duplicate_flags adf
          WHERE ${alumniDuplicatePendingSql('adf')}) AS "alumni-duplicates"`);
    }
    if (moderates) {
      columns.push(`(SELECT count(*)::int FROM content_reports r WHERE ${reportPendingSql('r')}
          AND ($2::boolean OR ${reportInBdeScopeSql('r', '$1::varchar')})) AS moderation`);
    }
    if (validates) {
      columns.push(`(SELECT count(*)::int FROM association_calendar_events e
          WHERE ${calendarEventPendingSql('e')}
          AND ($2::boolean OR ${holdsBdeAgendaRightOverSql('$1::varchar', 'e."associationId"')})) AS agenda`);
    }
    if (columns.length === 0) {
      this.logger.debug(`[ADMIN_QUEUES] ${userId.slice(0, 8)} opens no admin queue: no counts`);
      return {};
    }
    const rows: Record<string, unknown>[] = await this.reports.manager.query(
      `SELECT ${columns.join(',\n  ')}`,
      [userId, isGlobalAdmin]
    );
    const counts: AdminQueueCounts = {};
    for (const key of ADMIN_QUEUE_KEYS) {
      const value = rows[0]?.[key];
      if (typeof value === 'number') counts[key] = value;
    }
    this.logger.debug(
      `[ADMIN_QUEUES] counts for ${userId.slice(0, 8)} admin=${isGlobalAdmin}: ${JSON.stringify(counts)}`
    );
    return counts;
  }

  /**
   * A profile correction was filed (core-service, `ProfileCorrectionService.create`): every global
   * admin but the person who asked is told. Throws on a failed write: the internal caller logs it.
   */
  async announceProfileCorrection(requestId: string, requesterId: string): Promise<number> {
    try {
      return await this.announce('profile-corrections', requestId, requesterId);
    } finally {
      await this.signal.changed({ queue: 'profile-corrections' });
    }
  }

  /**
   * Core-service found Alumni duplicates that wait for an attachment (`AlumniDuplicateQueue`, a
   * sign-in's one or a reading's backlog - ONCE per duplicate, never again): EVERY global admin is
   * told - no one asked for it, so no one is excluded - by ONE push and ONE bell row for the whole
   * batch, however many it holds (a backlog found at once is not a flood in every admin's bell). The
   * row is keyed on the batch's first duplicate, lists the batch in its `meta` and stays while ANY
   * of them still waits (`BELL_ROW_GATE`); the live count carries the rest.
   *
   * IDEMPOTENT ON `batchId` (`alumni_duplicate_announcements`): a batch already told is not told
   * again, so an answer lost on the way never rings the admins' phones twice. The ledger row is
   * written AFTER the notice, so a crash in between tells again rather than never. Throws on a failed
   * write: the internal caller keeps the notice owed and tells again at its next reading.
   * Answers how many admins have the bell row (0 for a replay).
   */
  async announceAlumniDuplicates(
    duplicateUuids: readonly string[],
    batchId: string
  ): Promise<{ told: number; replayed: boolean }> {
    this.logger.log(
      `[ADMIN_QUEUES] ${duplicateUuids.length} Alumni duplicate(s) to announce (batch ${batchId.slice(0, 8)})`
    );
    try {
      const known = (await this.reports.manager.query(
        `SELECT 1 FROM alumni_duplicate_announcements WHERE "batchId" = $1`,
        [batchId]
      )) as unknown[];
      if (known.length > 0) {
        this.logger.warn(
          `[ADMIN_QUEUES] Alumni batch ${batchId.slice(0, 8)} was already told: not told again (a lost answer was replayed)`
        );
        return { told: 0, replayed: true };
      }
      const told = await this.announce('alumni-duplicates', duplicateUuids[0], null, {
        duplicateUuids: [...duplicateUuids],
      });
      await this.reports.manager.query(
        `INSERT INTO alumni_duplicate_announcements ("batchId") VALUES ($1) ON CONFLICT DO NOTHING`,
        [batchId]
      );
      return { told, replayed: false };
    } finally {
      await this.signal.changed({ queue: 'alumni-duplicates' });
    }
  }

  /**
   * A report was filed: every global admin but its reporter is told - UNLESS a notice about its
   * subject is still on their bells (`REPORT_ALREADY_ANNOUNCED_SQL`), so five reports on one post are
   * one notice, while a subject that waited before the notices existed, or whose announcement
   * failed, is announced by its next report. The read and the write run under the subject's advisory
   * lock, so two reports filed at once write one notice. Never throws: the report is saved and
   * answered whatever this does; a failure is logged at ERROR, because an admin who is not told is
   * the very defect this notice exists to end.
   */
  async announceReport(report: Pick<ContentReport, 'id' | 'reporterId'>): Promise<void> {
    try {
      await this.reports.manager.transaction(async (tx) => {
        await tx.query(LOCK_REPORT_SUBJECT_SQL, [report.id]);
        const rows: { covered: boolean }[] = await tx.query(REPORT_ALREADY_ANNOUNCED_SQL, [
          report.id,
        ]);
        if (rows[0]?.covered === true) {
          this.logger.log(
            `[ADMIN_QUEUES] report ${report.id.slice(0, 8)}: its subject's notice is still owed, no new one`
          );
          return;
        }
        await this.announce('moderation', report.id, report.reporterId);
      });
    } catch (err) {
      this.logger.error(
        `[ADMIN_QUEUES] report ${report.id.slice(0, 8)} was NOT announced to the admins: ${String(err)}`
      );
    }
    // Announced or not, the moderation queue grew: whoever may act on it recounts. Not awaited: the
    // reporter's answer does not wait on who else is told (`changed` never throws; it logs).
    void this.signal.changed({ queue: 'moderation', reportIds: [report.id] });
  }

  /**
   * The notice of a new item in `queue`, to every global admin (`users.admin`) but `excludeId` - the
   * person who filed it, never told of their own request (null: nobody asked, all are told). The PLATFORM is the actor and the row
   * carries no text: who asked and what they wrote are the queue's to show (the content-free push,
   * `adminProfileCorrectionContent`). Answers how many admins have the bell row; none is said at
   * WARN, since an item nobody is told about waits unseen. Rows written and only the push failed is
   * caught by its TYPE and said at ERROR as exactly that - the admins are told, on their bells.
   */
  private async announce(
    queue: AnnouncedQueue,
    itemId: string,
    excludeId: string | null,
    meta?: Record<string, unknown>
  ): Promise<number> {
    const { type, target } = ANNOUNCED[queue];
    const admins: { id: string }[] = await this.reports.manager.query(
      `SELECT id FROM users WHERE admin = true AND id IS DISTINCT FROM $1`,
      [excludeId]
    );
    if (admins.length === 0) {
      this.logger.warn(`[ADMIN_QUEUES] ${type} ${itemId.slice(0, 8)}: no global admin to tell`);
      return 0;
    }
    let told: number;
    try {
      told = await this.notifications.createNotifications({
        recipientIds: admins.map((a) => a.id),
        type,
        postId: itemId,
        actorId: SYSTEM_ACTOR_ID,
        actorName: SYSTEM_ACTOR_NAME,
        text: '',
        pushData: { target },
        meta,
      });
    } catch (err) {
      if (!(err instanceof NotificationPushFailedError)) throw err;
      this.logger.error(
        `[ADMIN_QUEUES] ${type} ${itemId.slice(0, 8)}: bell rows written for ${err.recipientIds.length} admin(s), their PUSH failed: ${String(err.cause)}`
      );
      return err.recipientIds.length;
    }
    this.logger.log(
      `[ADMIN_QUEUES] ${type} ${itemId.slice(0, 8)} told to ${told} of ${admins.length} admin(s)`
    );
    return told;
  }
}
