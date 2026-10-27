import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';
import { FormReminder } from './entities/form-reminder.entity';
import { PushService } from '../push/push.service';
import { formOpeningSoonContent, formOpenContent } from '../push/push-content';
import { PostNotificationsService, SYSTEM_ACTOR_NAME } from '../posts/post-notifications.service';
import { FormsService } from './forms.service';
import { LydiaReconciliationService } from './lydia-reconciliation.service';

/** Retention durations for unbounded-growth data tables. */
const GC_NOTIFICATION_DAYS = 90;
const GC_REMINDER_DAYS = 30;
const GC_USER_TAG_GRACE_DAYS = 30;
const GC_WEBHOOK_DELIVERY_DAYS = 30;
const GC_CONTENT_REPORT_DAYS = 90;

@Injectable()
export class FormReminderScheduler {
  private readonly logger = new Logger(FormReminderScheduler.name);

  constructor(
    @InjectRepository(FormReminder)
    private readonly reminderRepo: Repository<FormReminder>,
    private readonly push: PushService,
    private readonly notifications: PostNotificationsService,
    private readonly formsService: FormsService,
    private readonly reconciliation: LydiaReconciliationService
  ) {}

  @Cron('* * * * *')
  async checkReminders() {
    const now = new Date();
    const fiveMinFromNow = new Date(now.getTime() + 5 * 60_000);

    // 5-minute advance warning
    const toNotify5min = await this.reminderRepo.find({
      where: {
        notified5min: false,
        opensAt: Between(now, fiveMinFromNow),
      },
    });
    for (const r of toNotify5min) {
      const content = formOpeningSoonContent();
      try {
        // Mark as notified BEFORE sending to avoid duplicate notifications if the process
        // crashes between the push and the flag update.  Worst case: the notification is
        // silently lost; acceptable vs spamming the user on every cron tick.
        if (!(await this.claim(r.id, 'notified5min'))) continue;
        await this.push.notifyContent(r.userId, content, {
          type: 'form_reminder',
          formId: r.formId,
        });
        // In-app bell notification: postId holds the formId for deep linking.
        // skipPush: the FCM push was already sent above with the exact wording.
        await this.notifications.createNotification({
          recipientId: r.userId,
          type: 'form_reminder',
          postId: r.formId,
          actorId: 'system',
          actorName: SYSTEM_ACTOR_NAME,
          text: content.legacyBody,
          skipPush: true,
        });
        this.logger.log(
          `[REMINDER] 5min sent: userId=${r.userId.slice(0, 8)} formId=${r.formId.slice(0, 8)}`
        );
      } catch (e: unknown) {
        this.logger.warn(`[REMINDER] 5min notify failed for ${r.id}`, e);
      }
    }

    // Notify at open time
    const toNotifyOpen = await this.reminderRepo.find({
      where: {
        notifiedOnOpen: false,
        opensAt: LessThanOrEqual(now),
      },
    });
    for (const r of toNotifyOpen) {
      const content = formOpenContent();
      try {
        // Mark as notified BEFORE sending to avoid duplicate notifications (same rationale as above).
        if (!(await this.claim(r.id, 'notifiedOnOpen'))) continue;
        await this.push.notifyContent(r.userId, content, {
          type: 'form_reminder',
          formId: r.formId,
        });
        // In-app bell notification. skipPush: the FCM push was already sent above.
        await this.notifications.createNotification({
          recipientId: r.userId,
          type: 'form_reminder',
          postId: r.formId,
          actorId: 'system',
          actorName: SYSTEM_ACTOR_NAME,
          text: content.legacyBody,
          skipPush: true,
        });
        this.logger.log(
          `[REMINDER] open sent: userId=${r.userId.slice(0, 8)} formId=${r.formId.slice(0, 8)}`
        );
      } catch (e: unknown) {
        this.logger.warn(`[REMINDER] open notify failed for ${r.id}`, e);
      }
    }

    if (toNotify5min.length + toNotifyOpen.length > 0) {
      this.logger.log(`[REMINDER] sent: 5min=${toNotify5min.length} open=${toNotifyOpen.length}`);
    }
  }

  /**
   * Stamps one reminder flag IF it is still unset, and says whether this run is the one that set it.
   *
   * THE STAMP IS THE CLAIM, so a second process sending the same reminder is impossible rather than
   * unlikely. Two copies of this service DO run at once: a release starts the new replica beside the
   * old one and retires the old one only once the new one is healthy, and a minute boundary inside
   * that overlap fires this cron in both (docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to).
   * An unconditional `update` let both read the row as unsent, both stamp it, both push - the member
   * was told twice. The conditional one matches in exactly one of them.
   */
  private async claim(id: string, flag: 'notified5min' | 'notifiedOnOpen'): Promise<boolean> {
    const result = await this.reminderRepo.update({ id, [flag]: false }, { [flag]: true });
    if (result.affected) return true;
    this.logger.log(`[REMINDER] ${flag} for ${id.slice(0, 8)} already claimed by another run`);
    return false;
  }

  /** Hourly cron - expires unvalidated cash submissions past their deadline. */
  @Cron('0 * * * *')
  async expireStaleCashPayments() {
    try {
      const count = await this.formsService.expireStalecashPayments();
      if (count > 0) {
        this.logger.log(`[CASH] Expired ${count} stale cash payment(s)`);
      }
    } catch (e) {
      this.logger.warn('[CASH] Error expiring stale cash payments', e);
    }
  }

  /** Set while `expireStalePendingPayments` runs, so a slow run is not overlapped by the next tick. */
  private expiringPendingPayments = false;

  /**
   * Every 5 minutes - reads at Lydia the online answers whose request has ended (the Lydia
   * reconciliation, `LydiaReconciliationService.sweepFormPayments`), THEN marks those left
   * `pending` past the hold as `expired`.
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
      // Its own `try`: a sweep that could not even select its rows must not stop the expiry.
      try {
        await this.reconciliation.sweepFormPayments();
      } catch (e) {
        this.logger.error('[RECONCILE] form sweep failed before reading any row', e);
      }
      try {
        await this.formsService.expireStalePendingPayments();
      } catch (e) {
        this.logger.warn('[PENDING] Error expiring stale online payments', e);
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

  /** Daily at 03:15 - deletes form reminders where both notifications were sent and the opening was more than 30 days ago. */
  @Cron('15 3 * * *')
  async purgeDeliveredFormReminders() {
    try {
      const res: { rowCount?: number } = await this.reminderRepo.manager.query(
        `DELETE FROM form_reminders
         WHERE "notifiedOnOpen" = true
           AND "opensAt" < NOW() - make_interval(days => $1)`,
        [GC_REMINDER_DAYS]
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0)
        this.logger.log(
          `[GC] form_reminders: ${deleted} deleted (older than ${GC_REMINDER_DAYS} days)`
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
