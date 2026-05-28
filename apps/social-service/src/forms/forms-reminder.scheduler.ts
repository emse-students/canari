import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';
import { FormReminder } from './entities/form-reminder.entity';
import { PushService } from '../push/push.service';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { FormsService } from './forms.service';

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
        await this.reminderRepo.update(r.id, { notified5min: true });
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
        await this.reminderRepo.update(r.id, { notifiedOnOpen: true });
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
}
