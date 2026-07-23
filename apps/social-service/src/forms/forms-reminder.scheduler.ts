import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';
import { FormReminder } from './entities/form-reminder.entity';
import { PushService } from '../push/push.service';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { FormsService } from './forms.service';

/** Retention durations for unbounded-growth data tables. */
const GC_NOTIFICATION_DAYS = 90;
const GC_REMINDER_DAYS = 30;
const GC_USER_TAG_GRACE_DAYS = 30;
const GC_WEBHOOK_DELIVERY_DAYS = 30;
const GC_CONTENT_REPORT_DAYS = 365;

@Injectable()
export class FormReminderScheduler {
  private readonly logger = new Logger(FormReminderScheduler.name);

  constructor(
    @InjectRepository(FormReminder)
    private readonly reminderRepo: Repository<FormReminder>,
    private readonly push: PushService,
    private readonly notifications: PostNotificationsService,
    private readonly formsService: FormsService
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
      const title = 'Form opening soon';
      const body = 'A form you are watching opens in 5 minutes!';
      try {
        // Mark as notified BEFORE sending to avoid duplicate notifications if the process
        // crashes between the push and the flag update.  Worst case: the notification is
        // silently lost; acceptable vs spamming the user on every cron tick.
        await this.reminderRepo.update(r.id, { notified5min: true });
        await this.push.notify(r.userId, title, body, { type: 'form_reminder', formId: r.formId });
        // In-app bell notification: postId holds the formId for deep linking.
        // skipPush: the FCM push was already sent above with the exact wording.
        await this.notifications.createNotification({
          recipientId: r.userId,
          type: 'form_reminder',
          postId: r.formId,
          actorId: 'system',
          actorName: 'Canari',
          text: body,
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
      const title = 'Form now open!';
      const body = 'The form is available - hurry, spots are limited!';
      try {
        // Mark as notified BEFORE sending to avoid duplicate notifications (same rationale as above).
        await this.reminderRepo.update(r.id, { notifiedOnOpen: true });
        await this.push.notify(r.userId, title, body, { type: 'form_reminder', formId: r.formId });
        // In-app bell notification. skipPush: the FCM push was already sent above.
        await this.notifications.createNotification({
          recipientId: r.userId,
          type: 'form_reminder',
          postId: r.formId,
          actorId: 'system',
          actorName: 'Canari',
          text: body,
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
   * older than one year. Pending reports are kept indefinitely.
   */
  @Cron('30 4 * * 0')
  async purgeResolvedContentReports() {
    try {
      const res: { rowCount?: number } = await this.reminderRepo.manager.query(
        `DELETE FROM content_reports
         WHERE status IN ('reviewed', 'dismissed')
           AND "createdAt" < NOW() - make_interval(days => $1)`,
        [GC_CONTENT_REPORT_DAYS]
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0)
        this.logger.log(
          `[GC] content_reports: ${deleted} deleted (older than ${GC_CONTENT_REPORT_DAYS} days)`
        );
    } catch (e) {
      this.logger.warn('[GC] purgeResolvedContentReports failed', e);
    }
  }
}
