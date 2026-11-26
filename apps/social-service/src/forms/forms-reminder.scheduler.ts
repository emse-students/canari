import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OpeningReminder } from '../openings/entities/opening-reminder.entity';
import {
  DUE_HEADS_UP_SQL,
  DUE_OPENINGS_SQL,
  PURGE_STALE_OPENINGS_SQL,
  type DueOpening,
  type OpeningKind,
} from '../openings/opening-reminders';
import { pruneEngagementPushDays } from '../posts/engagement-push-cap';
import { PushService } from '../push/push.service';
import {
  formOpeningSoonContent,
  formOpenContent,
  type FormReminderSubject,
} from '../push/push-content';
import { BOOKINGS_TARGET } from '../push/push-target';
import {
  PostNotificationsService,
  pushIconOf,
  SYSTEM_ACTOR_ID,
  SYSTEM_ACTOR_NAME,
} from '../posts/post-notifications.service';
import { FormsService } from './forms.service';
import { LydiaReconciliationService } from './lydia-reconciliation.service';
import { FormWaitlistNoticeService } from './waitlist-notice.service';
import type { NotificationType } from '../push/notification-client-floor';
import type { DueCashReminder } from './cash-reminder';

/** The bell type of the one notice before a cash hold expires (`cash-reminder.ts`). */
export const FORM_CASH_EXPIRING_TYPE = 'form_cash_expiring';

/** Retention durations for unbounded-growth data tables. */
const GC_NOTIFICATION_DAYS = 90;
const GC_REMINDER_DAYS = 30;
const GC_USER_TAG_GRACE_DAYS = 30;
const GC_WEBHOOK_DELIVERY_DAYS = 30;
const GC_CONTENT_REPORT_DAYS = 90;

/** The in-app type of an opening, per kind - what the bell draws and where it leads. */
const OPENING_NOTIFICATION_TYPE: Readonly<Record<OpeningKind, NotificationType>> = {
  form: 'form_reminder',
  booking: 'booking_open',
  event: 'event_open',
};

/** One heads-up row, as `DUE_HEADS_UP_SQL` reads it. */
interface DueHeadsUp extends FormReminderFacts {
  id: string;
  kind: OpeningKind;
  targetId: string;
  userId: string;
  /** The form is published and its association not archived; false = gone for good, told nothing. */
  targetLive: boolean;
}

/** What a form reminder names, from the row's statement: the ONE source of the push and the bell row. */
interface FormReminderFacts {
  associationId: string | null;
  associationName: string | null;
  associationLogoUrl: string | null;
  associationLogoMediaId: string | null;
  targetName: string | null;
}

/**
 * The form reminder's push subject: the association (actor and, when its logo id is usable, the
 * picture) and the form's title - the SAME facts `formReminderActor` writes on the bell row, so the
 * lock screen can never say less than the bell (reading of 2026-11-23: the push read "Formulaire
 * ouvert !" with no picture while the row was right). A personal form has no association and no
 * picture, never a member's face (`pushIconOf`).
 */
function formReminderSubject(r: FormReminderFacts): FormReminderSubject {
  return {
    formTitle: r.targetName,
    associationName: r.associationName,
    icon: pushIconOf({
      actorId: SYSTEM_ACTOR_ID,
      associationId: r.associationId,
      associationLogoMediaId: r.associationLogoMediaId,
    }),
  };
}

@Injectable()
export class FormReminderScheduler {
  private readonly logger = new Logger(FormReminderScheduler.name);

  constructor(
    @InjectRepository(OpeningReminder)
    private readonly reminderRepo: Repository<OpeningReminder>,
    private readonly push: PushService,
    private readonly notifications: PostNotificationsService,
    private readonly formsService: FormsService,
    private readonly reconciliation: LydiaReconciliationService,
    // Always injected by Nest; a spec of the other jobs may leave it out (its absence is an ERROR).
    private readonly waitlistNotice?: FormWaitlistNoticeService
  ) {}

  /**
   * Every minute: the OPENING REMINDERS due (engagement WP-4, `openings/opening-reminders.ts`) - the
   * five-minute heads-up of an asked form, then every opening that has come, whatever its kind and
   * whoever caused its row. Each row is CLAIMED before it is sent (`claim`), so one row is one push.
   * Never capped (decision 11: a shotgun opening is outside the daily cap).
   */
  @Cron('* * * * *')
  async checkReminders() {
    const now = new Date();
    const manager = this.reminderRepo.manager;

    const headsUp = (await manager.query(DUE_HEADS_UP_SQL, [now])) as DueHeadsUp[];
    for (const r of headsUp) {
      const content = formOpeningSoonContent(formReminderSubject(r));
      try {
        // Mark as notified BEFORE sending to avoid duplicate notifications if the process
        // crashes between the push and the flag update.  Worst case: the notification is
        // silently lost; acceptable vs spamming the user on every cron tick.
        if (!(await this.claim(r.id, 'notified5min'))) continue;
        if (!r.targetLive) {
          this.logger.log(
            `[REMINDER] 5min not sent: userId=${r.userId.slice(0, 8)} formId=${r.targetId.slice(0, 8)} - the form is gone or its association archived`
          );
          continue;
        }
        await this.push.notifyContent(r.userId, content, {
          type: 'form_reminder',
          formId: r.targetId,
        });
        // In-app bell notification: postId holds the formId for deep linking.
        // skipPush: the FCM push was already sent above with the exact wording.
        await this.notifications.createNotification({
          recipientId: r.userId,
          type: 'form_reminder',
          postId: r.targetId,
          ...this.formReminderActor(r),
          text: content.legacyBody,
          skipPush: true,
        });
        this.logger.log(
          `[REMINDER] 5min sent: userId=${r.userId.slice(0, 8)} formId=${r.targetId.slice(0, 8)}`
        );
      } catch (e: unknown) {
        this.logger.warn(`[REMINDER] 5min notify failed for ${r.id}`, e);
      }
    }

    const openings = (await manager.query(DUE_OPENINGS_SQL, [now])) as DueOpening[];
    for (const r of openings) {
      try {
        // Mark as notified BEFORE sending to avoid duplicate notifications (same rationale as above).
        if (!(await this.claim(r.id, 'notifiedOnOpen'))) continue;
        await this.sendOpening(r);
      } catch (e: unknown) {
        this.logger.warn(`[REMINDER] open notify failed for ${r.id}`, e);
      }
    }

    if (headsUp.length + openings.length > 0) {
      this.logger.log(`[REMINDER] sent: 5min=${headsUp.length} open=${openings.length}`);
    }
  }

  /**
   * Tells ONE claimed row that its target opened. A target that is gone for good (a deleted form,
   * space or event, an archived association) is told nothing - one merely not live yet is never
   * selected (`DUE_OPENINGS_SQL`). A follower who no longer follows or sees the association, or a
   * booking space with an audience, is told nothing either (`stillOwed`). A follower's row whose
   * bell on the association is reduced gets the in-app row and no push (L26).
   */
  private async sendOpening(r: DueOpening): Promise<void> {
    const who = `userId=${r.userId.slice(0, 8)} ${r.kind}=${r.targetId.slice(0, 8)} origin=${r.origin}`;
    if (!r.targetLive) {
      this.logger.log(`[REMINDER] open not sent: ${who} - the target is gone or archived`);
      return;
    }
    if (!r.stillOwed) {
      this.logger.log(
        `[REMINDER] open not sent: ${who} - no longer follows or sees the association, or the target has an audience`
      );
      return;
    }
    const withhold = r.bellWithholds;
    if (r.kind === 'form') {
      const content = formOpenContent(formReminderSubject(r));
      if (!withhold) {
        await this.push.notifyContent(r.userId, content, {
          type: 'form_reminder',
          formId: r.targetId,
        });
      }
      // In-app bell notification. skipPush: the FCM push was already sent above, or withheld.
      await this.notifications.createNotification({
        recipientId: r.userId,
        type: 'form_reminder',
        postId: r.targetId,
        ...this.formReminderActor(r),
        text: content.legacyBody,
        skipPush: true,
      });
    } else {
      // A booking space or an event: the association names the row and the push (its followers
      // are the only rows of these kinds), the place or the title is the text. A link-only space
      // is never named on a lock screen (Q-R5): its rows are not written, and this guards it.
      await this.notifications.createNotification({
        recipientId: r.userId,
        type: OPENING_NOTIFICATION_TYPE[r.kind],
        postId: r.targetId,
        actorId: SYSTEM_ACTOR_ID,
        actorName: r.associationName || SYSTEM_ACTOR_NAME,
        ...(r.associationId && {
          associationId: r.associationId,
          associationLogoUrl: r.associationLogoUrl,
          associationLogoMediaId: r.associationLogoMediaId,
        }),
        text: r.linkOnly ? '' : (r.targetName ?? ''),
        // A booking opens Reservations; an event the agenda (`action`, read by `socialDeepLink`).
        pushData: r.kind === 'booking' ? { target: BOOKINGS_TARGET } : { action: 'opened' },
        skipPush: withhold,
      });
    }
    this.logger.log(
      `[REMINDER] open sent: ${who}${withhold ? ' (push withheld by the bell)' : ''}`
    );
  }

  /**
   * The actor of a form reminder's bell row: the association that runs the form, with its logo (owner,
   * 2026-11-17), else the generic system actor for a personal form.
   */
  private formReminderActor(
    r: Pick<FormReminderFacts, 'associationId' | 'associationName' | 'associationLogoUrl'>
  ) {
    return {
      actorId: SYSTEM_ACTOR_ID,
      actorName: r.associationName || SYSTEM_ACTOR_NAME,
      ...(r.associationId && {
        associationId: r.associationId,
        associationLogoUrl: r.associationLogoUrl,
      }),
    };
  }

  /**
   * Stamps one reminder flag IF it is still unset, and says whether this run is the one that set it.
   *
   * THE STAMP IS THE CLAIM, so a second process sending the same reminder is impossible rather than
   * unlikely. Two copies of this service DO run at once: a release starts the new replica beside the
   * old one and retires the old one only once the new one is healthy, and a minute boundary inside
   * that overlap fires this cron in both (docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to).
   * An unconditional `update` let both read the row as unsent, both stamp it, both push - the member
   * was told twice. The conditional one matches in exactly one of them. An image older than WP-4,
   * still claiming `form_reminders`, is ordered against this one by migration 152's trigger.
   */
  private async claim(id: string, flag: 'notified5min' | 'notifiedOnOpen'): Promise<boolean> {
    const result = await this.reminderRepo.update({ id, [flag]: false }, { [flag]: true });
    if (result.affected) return true;
    this.logger.log(`[REMINDER] ${flag} for ${id.slice(0, 8)} already claimed by another run`);
    return false;
  }

  /**
   * Hourly cron - tells each member ONCE that their cash hold is about to expire
   * (`cash-reminder.ts`), then expires unvalidated cash submissions past their deadline. The notice
   * runs first, on the same tick and the same clock, so an answer due and not yet expired is told
   * before the run that expires it.
   */
  @Cron('0 * * * *')
  async expireStaleCashPayments() {
    await this.remindExpiringCashPayments();
    try {
      const count = await this.formsService.expireStalecashPayments();
      if (count > 0) {
        this.logger.log(`[CASH] Expired ${count} stale cash payment(s)`);
      }
    } catch (e) {
      this.logger.warn('[CASH] Error expiring stale cash payments', e);
    }
  }

  /**
   * One bell row per answer whose cash hold is about to expire: CLAIMED on the row first
   * (`claimCashReminder`), written, and RELEASED when writing it failed so the next run retries -
   * one notice, never two. A try per row: one failure never costs the others theirs. No push
   * (`cash-reminder.ts`); the row opens the form, where the answer and its deadline are.
   */
  async remindExpiringCashPayments(): Promise<void> {
    let due: DueCashReminder[];
    try {
      due = await this.formsService.dueCashReminders();
    } catch (e: unknown) {
      this.logger.warn('[CASH] could not read the cash reminders due', e);
      return;
    }
    let told = 0;
    for (const r of due) {
      try {
        if (!(await this.formsService.claimCashReminder(r.submissionId))) continue;
      } catch (e: unknown) {
        this.logger.warn(`[CASH] reminder claim failed for ${r.submissionId}`, e);
        continue;
      }
      try {
        await this.notifications.createNotification({
          recipientId: r.userId,
          type: FORM_CASH_EXPIRING_TYPE,
          postId: r.formId,
          ...this.formReminderActor(r),
          text: r.formTitle ?? '',
          skipPush: true,
        });
        told++;
        this.logger.log(
          `[CASH] reminder sent: userId=${r.userId.slice(0, 8)} submission=${r.submissionId.slice(0, 8)}`
        );
      } catch (e: unknown) {
        this.logger.error(
          `[CASH] reminder NOT written for ${r.submissionId} - released for the next run`,
          e
        );
        await this.formsService
          .releaseCashReminder(r.submissionId)
          .catch((err: unknown) =>
            this.logger.error(
              `[CASH] reminder release failed for ${r.submissionId}: the member will not be told`,
              err
            )
          );
      }
    }
    if (due.length > 0) this.logger.log(`[CASH] reminders: ${told} sent of ${due.length} due`);
  }

  /** Set while `expireStalePendingPayments` runs, so a slow run is not overlapped by the next tick. */
  private expiringPendingPayments = false;

  /**
   * Every 5 minutes - reads at Lydia the online answers whose request has ended (the Lydia
   * reconciliation, `LydiaReconciliationService.sweepFormPayments`), THEN marks those left
   * `pending` past the hold as `expired` - both by ONE hold cutoff read at the start of the tick.
   *
   * THE ORDER IS THE POINT: the hold ends when the request does, so a row becomes due for the read
   * in the very tick that would expire it - and once `expired` it is never read again. Read first, a
   * payment whose callback was lost is recorded; what the read could not settle (Lydia unreachable,
   * no key, an answer that does not verify) is then expired as before.
   *
   * NOT LOAD-BEARING FOR CAPACITY: the seat is released by the row's own age in every count, so a
   * late or missed run only delays the word the manager reads. The flag stops this process
   * overlapping itself; the `UPDATE`'s own `WHERE` is what makes any repeat a no-op.
   */
  @Cron('*/5 * * * *')
  async expireStalePendingPayments() {
    if (this.expiringPendingPayments) {
      this.logger.debug('[PENDING] previous expiry run still in progress - this tick skipped');
      return;
    }
    this.expiringPendingPayments = true;
    try {
      // ONE cutoff for the read and the expiry: with a clock each, a row whose hold ended between
      // the two would be expired without the read.
      let cutoff: Date | null = null;
      try {
        cutoff = await this.formsService.pendingHoldCutoff();
      } catch (e) {
        this.logger.warn(
          '[PENDING] Error reading the hold cutoff - no read, no expiry this tick',
          e
        );
      }
      if (cutoff) {
        // Its own `try`: a sweep that could not even select its rows must not stop the expiry.
        try {
          await this.reconciliation.sweepFormPayments(cutoff);
        } catch (e) {
          this.logger.error('[RECONCILE] form sweep failed before reading any row', e);
        }
        try {
          await this.formsService.expireStalePendingPayments(cutoff);
        } catch (e) {
          this.logger.warn('[PENDING] Error expiring stale online payments', e);
        }
      }
      // The seat holds past their ten minutes ("Reserver ma place"): deleted, and the waiting list
      // promoted into the places they freed. Not load-bearing for capacity (every count reads the
      // hold's age). Its own `try`.
      try {
        await this.formsService.expireLapsedSeatHolds();
      } catch (e) {
        this.logger.error('[HOLD] lapsed seat holds could not be expired', e);
      }
      // THE WAITING LIST'S NOTICES OWED (`waitlist.ts`): a NOTICE, never a promotion, is retried here
      // - every event that frees a place promotes in its own transaction, and tells right after its
      // commit; this tells a promotion whose notice could not be written then. Its own `try`.
      if (this.waitlistNotice) {
        try {
          await this.waitlistNotice.tellPending();
        } catch (e) {
          this.logger.error('[WAITLIST] promotion notices owed could not be read', e);
        }
      } else {
        this.logger.error('[WAITLIST] no notifier wired: promotion notices owed are not told');
      }
      // A promotion that converted a `paid_over_capacity` answer owes what its payment buys; every
      // promoter runs it after its commit (`afterCommit`), so this is the durable retry of one a
      // stopped process never ran (`FormsService.fulfilConvertedPromotions`, WARN). Its own `try`.
      try {
        await this.formsService.fulfilConvertedPromotions();
      } catch (e) {
        this.logger.error('[WAITLIST] converted promotions owed could not be read', e);
      }
      // Its own `try`: a failed expiry must not keep a visitor key the rows no longer need, and a
      // failed forget must not hide an expiry that worked. AFTER the expiry, so the rows it just
      // moved out of `pending` lose their key in the same tick.
      try {
        await this.formsService.forgetSettledGuestVisitors();
      } catch (e) {
        this.logger.warn('[PENDING] Error clearing settled guest visitor keys', e);
      }
    } finally {
      this.expiringPendingPayments = false;
    }
  }

  /** Daily at 03:00 - deletes post notifications older than 90 days. */
  @Cron('0 3 * * *')
  async purgeOldPostNotifications() {
    try {
      const res: { rowCount?: number } = await this.reminderRepo.manager.query(
        `DELETE FROM post_notifications WHERE "createdAt" < NOW() - make_interval(days => $1)`,
        [GC_NOTIFICATION_DAYS]
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0)
        this.logger.log(
          `[GC] post_notifications: ${deleted} deleted (older than ${GC_NOTIFICATION_DAYS} days)`
        );
    } catch (e) {
      this.logger.warn('[GC] purgeOldPostNotifications failed', e);
    }
  }

  /** Daily at 03:05 - deletes the engagement push counters older than a week (engagement WP-8), and the weekly trend counters older than two. */
  @Cron('5 3 * * *')
  async purgeEngagementPushDays() {
    try {
      const deleted = await pruneEngagementPushDays(this.reminderRepo.manager);
      if (deleted > 0)
        this.logger.log(`[GC] engagement_push_days, campus_trend_weeks: ${deleted} deleted`);
    } catch (e) {
      this.logger.warn('[GC] purgeEngagementPushDays failed', e);
    }
  }

  /** Daily at 03:15 - deletes opening reminders told of their opening more than 30 days ago. */
  @Cron('15 3 * * *')
  async purgeDeliveredFormReminders() {
    try {
      const [counts] = (await this.reminderRepo.manager.query(PURGE_STALE_OPENINGS_SQL, [
        GC_REMINDER_DAYS,
      ])) as { told: number; untold: number }[];
      if (counts && counts.told + counts.untold > 0)
        this.logger.log(
          `[GC] opening_reminders older than ${GC_REMINDER_DAYS} days deleted: told=${counts.told} never-told=${counts.untold}`
        );
    } catch (e) {
      this.logger.warn('[GC] purgeDeliveredFormReminders failed', e);
    }
  }

  /**
   * Daily at 03:30 - deletes expired member tags older than 30 days.
   * The 30-day grace period allows handling renewal disputes.
   */
  @Cron('30 3 * * *')
  async purgeExpiredUserTags() {
    try {
      const res: { rowCount?: number } = await this.reminderRepo.manager.query(
        `DELETE FROM user_tags
         WHERE "expiresAt" IS NOT NULL
           AND "expiresAt" < NOW() - make_interval(days => $1)`,
        [GC_USER_TAG_GRACE_DAYS]
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0)
        this.logger.log(
          `[GC] user_tags: ${deleted} deleted (expired > ${GC_USER_TAG_GRACE_DAYS} days ago)`
        );
    } catch (e) {
      this.logger.warn('[GC] purgeExpiredUserTags failed', e);
    }
  }

  /**
   * Weekly (Sunday 04:00) - deletes successfully delivered webhooks after 30 days.
   * Failed deliveries are kept for manual retry.
   */
  @Cron('0 4 * * 0')
  async purgeDeliveredWebhooks() {
    try {
      const res: { rowCount?: number } = await this.reminderRepo.manager.query(
        `DELETE FROM webhook_deliveries
         WHERE status = 'delivered'
           AND "createdAt" < NOW() - make_interval(days => $1)`,
        [GC_WEBHOOK_DELIVERY_DAYS]
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0)
        this.logger.log(
          `[GC] webhook_deliveries: ${deleted} deleted (older than ${GC_WEBHOOK_DELIVERY_DAYS} days)`
        );
    } catch (e) {
      this.logger.warn('[GC] purgeDeliveredWebhooks failed', e);
    }
  }

  /**
   * Weekly (Sunday 04:30) - deletes resolved content reports (reviewed/dismissed)
   * GC_CONTENT_REPORT_DAYS after they were HANDLED. Pending reports are kept indefinitely.
   *
   * THE ONLY RETENTION `content_reports` HAS, since 2026-08-27. It had three, and they disagreed:
   * a lazy 7-day purge fired from `ModerationService.listAllReports` on every moderator page load,
   * this cron said one year, and `internal.controller`'s docblock claimed the rows were kept for
   * legal obligation. The lazy one always won, so this cron had never deleted anything - a
   * mechanism can be correct and still be dead if something upstream empties its population first.
   *
   * The clock is `reviewedAt`, not `createdAt`: the policy is "90 days after a moderator answered",
   * and keying it on filing would purge an old report the day after it was finally handled.
   * COALESCE covers rows handled before `reviewedAt` existed.
   */
  @Cron('30 4 * * 0')
  async purgeResolvedContentReports() {
    try {
      const res: { rowCount?: number } = await this.reminderRepo.manager.query(
        `DELETE FROM content_reports
         WHERE status IN ('reviewed', 'dismissed')
           AND COALESCE("reviewedAt", "createdAt") < NOW() - make_interval(days => $1)`,
        [GC_CONTENT_REPORT_DAYS]
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0)
        this.logger.log(
          `[GC] content_reports: ${deleted} deleted (handled more than ${GC_CONTENT_REPORT_DAYS} days ago)`
        );
    } catch (e) {
      this.logger.warn('[GC] purgeResolvedContentReports failed', e);
    }
  }
}
