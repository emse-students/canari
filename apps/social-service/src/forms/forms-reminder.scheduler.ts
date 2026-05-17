import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';
import { FormReminder } from './entities/form-reminder.entity';
import { PushService } from '../push/push.service';

@Injectable()
export class FormReminderScheduler {
  private readonly logger = new Logger(FormReminderScheduler.name);

  constructor(
    @InjectRepository(FormReminder)
    private readonly reminderRepo: Repository<FormReminder>,
    private readonly push: PushService,
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
      try {
        await this.push.notify(
          r.userId,
          '⏰ Formulaire bientôt disponible',
          'Un formulaire que vous suivez ouvre dans 5 minutes !',
          { type: 'form_reminder', formId: r.formId },
        );
        await this.reminderRepo.update(r.id, { notified5min: true });
      } catch (e) {
        this.logger.warn(`[REMINDER] 5min notify failed for ${r.id}: ${String(e)}`);
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
      try {
        await this.push.notify(
          r.userId,
          '🟢 Formulaire maintenant ouvert !',
          'Le formulaire est disponible — dépêchez-vous, les places sont limitées !',
          { type: 'form_reminder', formId: r.formId },
        );
        await this.reminderRepo.update(r.id, { notifiedOnOpen: true });
      } catch (e) {
        this.logger.warn(`[REMINDER] open notify failed for ${r.id}: ${String(e)}`);
      }
    }

    if (toNotify5min.length + toNotifyOpen.length > 0) {
      this.logger.log(
        `[REMINDER] sent: 5min=${toNotify5min.length} open=${toNotifyOpen.length}`,
      );
    }
  }
}
