import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';
import { FormReminder } from './entities/form-reminder.entity';
import { PushService } from '../push/push.service';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { FormsService } from './forms.service';

/** Durées de rétention pour les données à croissance illimitée. */
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
      const title = '⏰ Formulaire bientôt disponible';
      const body = 'Un formulaire que vous suivez ouvre dans 5 minutes !';
      try {
        // Mark as notified BEFORE sending to avoid duplicate notifications if the process
        // crashes between the push and the flag update.  Worst case: the notification is
        // silently lost; acceptable vs spamming the user on every cron tick.
        await this.reminderRepo.update(r.id, { notified5min: true });
        await this.push.notify(r.userId, title, body, { type: 'form_reminder', formId: r.formId });
        // Notification in-app dans la cloche : postId contient le formId pour le deep link
        await this.notifications.createNotification({
          recipientId: r.userId,
          type: 'form_reminder',
          postId: r.formId,
          actorId: 'system',
          actorName: 'Canari',
          text: body,
        });
        this.logger.log(
          `[REMINDER] 5min notifié: userId=${r.userId.slice(0, 8)} formId=${r.formId.slice(0, 8)}`
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
      const title = '🟢 Formulaire maintenant ouvert !';
      const body = 'Le formulaire est disponible - dépêchez-vous, les places sont limitées !';
      try {
        // Mark as notified BEFORE sending to avoid duplicate notifications (same rationale as above).
        await this.reminderRepo.update(r.id, { notifiedOnOpen: true });
        await this.push.notify(r.userId, title, body, { type: 'form_reminder', formId: r.formId });
        // Notification in-app dans la cloche
        await this.notifications.createNotification({
          recipientId: r.userId,
          type: 'form_reminder',
          postId: r.formId,
          actorId: 'system',
          actorName: 'Canari',
          text: body,
        });
        this.logger.log(
          `[REMINDER] ouverture notifiée: userId=${r.userId.slice(0, 8)} formId=${r.formId.slice(0, 8)}`
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

  /**
   * Daily at 03:00 - supprime les notifications de posts de plus de 90 jours.
   * Rétention choisie par analogie avec les réseaux sociaux grand public (Instagram, Twitter).
   */
  @Cron('0 3 * * *')
  async purgeOldPostNotifications() {
    try {
      const res: { rowCount?: number } = await this.reminderRepo.manager.query(
        `DELETE FROM post_notifications WHERE "createdAt" < NOW() - INTERVAL '${GC_NOTIFICATION_DAYS} days'`
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0)
        this.logger.log(
          `[GC] post_notifications: ${deleted} supprimée(s) > ${GC_NOTIFICATION_DAYS}j`
        );
    } catch (e) {
      this.logger.warn('[GC] purgeOldPostNotifications failed', e);
    }
  }

  /**
   * Daily at 03:15 - supprime les rappels de formulaires dont les deux notifications
   * ont été envoyées et dont l'ouverture remonte à plus de 30 jours.
   */
  @Cron('15 3 * * *')
  async purgeDeliveredFormReminders() {
    try {
      const res: { rowCount?: number } = await this.reminderRepo.manager.query(
        `DELETE FROM form_reminders
         WHERE "notifiedOnOpen" = true
           AND "opensAt" < NOW() - INTERVAL '${GC_REMINDER_DAYS} days'`
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0)
        this.logger.log(`[GC] form_reminders: ${deleted} supprimée(s) > ${GC_REMINDER_DAYS}j`);
    } catch (e) {
      this.logger.warn('[GC] purgeDeliveredFormReminders failed', e);
    }
  }

  /**
   * Daily at 03:30 - supprime les tags d'adhérent expirés depuis plus de 30 jours.
   * La grâce de 30 jours permet de traiter les litiges de renouvellement.
   */
  @Cron('30 3 * * *')
  async purgeExpiredUserTags() {
    try {
      const res: { rowCount?: number } = await this.reminderRepo.manager.query(
        `DELETE FROM user_tags
         WHERE "expiresAt" IS NOT NULL
           AND "expiresAt" < NOW() - INTERVAL '${GC_USER_TAG_GRACE_DAYS} days'`
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0)
        this.logger.log(
          `[GC] user_tags: ${deleted} supprimée(s) (expirés > ${GC_USER_TAG_GRACE_DAYS}j)`
        );
    } catch (e) {
      this.logger.warn('[GC] purgeExpiredUserTags failed', e);
    }
  }

  /**
   * Weekly (Sunday 04:00) - supprime les webhook deliveries livrées avec succès
   * après 30 jours. Les échouées sont conservées pour retry manuel.
   */
  @Cron('0 4 * * 0')
  async purgeDeliveredWebhooks() {
    try {
      const res: { rowCount?: number } = await this.reminderRepo.manager.query(
        `DELETE FROM webhook_deliveries
         WHERE status = 'delivered'
           AND "createdAt" < NOW() - INTERVAL '${GC_WEBHOOK_DELIVERY_DAYS} days'`
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0)
        this.logger.log(
          `[GC] webhook_deliveries: ${deleted} supprimée(s) > ${GC_WEBHOOK_DELIVERY_DAYS}j`
        );
    } catch (e) {
      this.logger.warn('[GC] purgeDeliveredWebhooks failed', e);
    }
  }

  /**
   * Weekly (Sunday 04:30) - archive les signalements traités (reviewed/dismissed)
   * de plus d'un an. Les signalements "pending" sont conservés indéfiniment.
   */
  @Cron('30 4 * * 0')
  async purgeResolvedContentReports() {
    try {
      const res: { rowCount?: number } = await this.reminderRepo.manager.query(
        `DELETE FROM content_reports
         WHERE status IN ('reviewed', 'dismissed')
           AND "createdAt" < NOW() - INTERVAL '${GC_CONTENT_REPORT_DAYS} days'`
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0)
        this.logger.log(
          `[GC] content_reports: ${deleted} supprimée(s) > ${GC_CONTENT_REPORT_DAYS}j`
        );
    } catch (e) {
      this.logger.warn('[GC] purgeResolvedContentReports failed', e);
    }
  }
}
