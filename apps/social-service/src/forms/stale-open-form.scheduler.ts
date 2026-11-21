import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PostNotificationsService, SYSTEM_ACTOR_NAME } from '../posts/post-notifications.service';
import { Form } from './entities/form.entity';
import { FormOrganiserAlertService } from './organiser-alert.service';
import {
  claimStaleOpenForms,
  releaseStaleOpenClaim,
  type ClaimedStaleForm,
} from './stale-open-forms';

/** The bell row's type (floor `1.8.0`, `notification-client-floor.ts`). */
export const FORM_STALE_OPEN_TYPE = 'form_stale_open';

/** Who the row names as its actor: nobody acted on the manager, the platform asks. */
const SYSTEM_ACTOR_ID = 'system';

const TAG = '[STALE-OPEN]';

/** What one sweep did, returned for the specs and summarised in the log. */
export interface StaleOpenSweepReport {
  /** Forms the question was claimed for. */
  asked: number;
  /** Notice rows written, over every recipient. */
  told: number;
  /** Forms whose notice failed and whose claim was put back for the next sweep. */
  released: number;
}

/**
 * THE DAILY SWEEP THAT ASKS A FORM'S MANAGERS ONCE WHETHER TO CLOSE IT (owner, 2026-11-21;
 * `stale-open-forms.ts` holds the predicate and the memory). The app's own scheduled-job mechanism -
 * a `@Cron` of the service, like every other sweep here - so no workflow is added.
 *
 * CHARTER, PRINCIPLE 3 (your attention is not for sale): ONE bell row per manager per question, no
 * push, no counter, nothing re-sent on a timer; only the form's owner and the holders of
 * `MANAGE_FORMS` hear it, and it clears for all of them the moment one of them answers.
 *
 * AT MOST ONCE comes from the claim (a conditional `UPDATE` on `forms."staleAskedAt"`), never from the
 * clock this fires on: a restart at 09:30, two replicas and a manual re-run all find nothing the
 * second time. A notice that cannot be WRITTEN releases its claim, so a failed write is retried
 * tomorrow rather than counted as asked.
 */
@Injectable()
export class StaleOpenFormScheduler {
  private readonly logger = new Logger(StaleOpenFormScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(Form) private readonly formRepo: Repository<Form>,
    private readonly alerts: FormOrganiserAlertService,
    private readonly notifications: PostNotificationsService
  ) {}

  /** Daily at 09:30 - after the night's jobs, in the morning managers open the app. */
  @Cron('30 9 * * *')
  async askStaleOpenForms(): Promise<void> {
    if (this.running) {
      this.logger.warn(`${TAG} the previous sweep is still going - this tick is skipped`);
      return;
    }
    this.running = true;
    try {
      await this.sweep();
    } catch (e) {
      this.logger.error(`${TAG} sweep failed before it could claim any form`, e);
    } finally {
      this.running = false;
    }
  }

  /**
   * The whole sweep, separated so a spec can call it without a scheduler.
   *
   * @param at The instant to judge at; omitted, the database's `now()` (the clock `updatedAt` and the
   *   answers' `createdAt` were written by).
   */
  async sweep(at?: Date): Promise<StaleOpenSweepReport> {
    const manager = this.formRepo.manager;
    const now = at ?? (await this.databaseNow());
    const claimed = await claimStaleOpenForms(manager, now);
    const report: StaleOpenSweepReport = { asked: claimed.length, told: 0, released: 0 };
    for (const form of claimed) {
      // Its own `try`: one form's failure never costs another its question.
      try {
        report.told += await this.tell(form);
      } catch (e) {
        report.released += 1;
        this.logger.warn(`${TAG} notice for form ${form.id.slice(0, 8)} failed: ${String(e)}`);
        await releaseStaleOpenClaim(manager, form, now);
      }
    }
    if (claimed.length > 0) {
      this.logger.log(
        `${TAG} asked=${report.asked} notices=${report.told} released=${report.released}`
      );
    }
    return report;
  }

  /** Writes the bell row for the form's owner and managers; THROWS when the rows were not written. */
  private async tell(form: ClaimedStaleForm): Promise<number> {
    const recipients = await this.alerts.recipientsOf(form);
    const written = await this.notifications.createNotifications({
      recipientIds: recipients,
      type: FORM_STALE_OPEN_TYPE,
      postId: form.id,
      actorId: SYSTEM_ACTOR_ID,
      actorName: SYSTEM_ACTOR_NAME,
      text: form.title ?? '',
      // The bell only: a form nobody answers is never urgent enough to ring a phone (principle 3).
      skipPush: true,
    });
    this.logger.log(`${TAG} form ${form.id.slice(0, 8)}: told ${written} manager(s)`);
    return written;
  }

  /** PostgreSQL's clock, read once for the whole sweep. */
  private async databaseNow(): Promise<Date> {
    const [{ now }] = (await this.formRepo.query(`SELECT now() AS now`)) as Array<{
      now: Date | string;
    }>;
    return new Date(now);
  }
}
