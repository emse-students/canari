import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SYSTEM_ACTOR_NAME } from '../posts/post-notifications.service';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { recipientsWithCategoryOn } from '../push/notification-category';
import { Form } from './entities/form.entity';
import { claimStaleOpenForm, dueStaleOpenFormIds, staleOpenRecipients } from './stale-open-forms';

/** The bell row's type (floor `1.8.0`, `notification-client-floor.ts`). */
export const FORM_STALE_OPEN_TYPE = 'form_stale_open';

/** Who the row names as its actor: nobody acted on the manager, the platform asks. */
const SYSTEM_ACTOR_ID = 'system';

/** The sweep's zone: the managers' morning, whatever the process's own clock reads. */
export const STALE_OPEN_SWEEP_TIME_ZONE = 'Europe/Paris';

const TAG = '[STALE-OPEN]';

/** What one sweep did, returned for the specs and summarised in the log. */
export interface StaleOpenSweepReport {
  /** Forms the question was claimed for. */
  asked: number;
  /** Notice rows written, over every recipient. */
  told: number;
  /** Forms whose transaction failed: nothing was claimed or written, the next sweep finds them due. */
  failed: number;
}

/**
 * THE DAILY SWEEP THAT ASKS A FORM'S MANAGERS ONCE WHETHER TO CLOSE IT (owner, 2026-11-21;
 * `stale-open-forms.ts` holds the predicate and the memory). The app's own scheduled-job mechanism -
 * a `@Cron` of the service, like every other sweep here - so no workflow is added.
 *
 * CHARTER, PRINCIPLE 3 (your attention is not for sale): ONE bell row per manager per question, no
 * push, no counter, nothing re-sent on a timer; only the holders of `MANAGE_FORMS` of an
 * association's form (the owner of a personal one) hear it, and it clears for all of them the moment
 * one of them answers.
 *
 * AT MOST ONCE comes from the claim (a conditional `UPDATE` on `forms."staleAskedAt"`), never from the
 * clock this fires on: a restart at 09:30, two replicas and a manual re-run all find nothing the
 * second time. AT LEAST ONCE comes from the transaction: the claim and the bell rows of a form
 * commit together (as `BirthdayNotifier` does), so a notice that cannot be written, or a process
 * dying between the two, leaves the form unclaimed and it is asked at the next sweep.
 */
@Injectable()
export class StaleOpenFormScheduler {
  private readonly logger = new Logger(StaleOpenFormScheduler.name);
  private running = false;

  constructor(@InjectRepository(Form) private readonly formRepo: Repository<Form>) {}

  /** Daily at 09:30 Paris time - after the night's jobs, when managers open the app. */
  @Cron('30 9 * * *', { timeZone: STALE_OPEN_SWEEP_TIME_ZONE })
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
    const now = at ?? (await this.databaseNow());
    const due = await dueStaleOpenFormIds(this.formRepo.manager, now);
    const report: StaleOpenSweepReport = { asked: 0, told: 0, failed: 0 };
    for (const formId of due) {
      // Its own `try`: one form's failure never costs another its question.
      try {
        const told = await this.askOne(formId, now);
        if (told === null) continue;
        report.asked += 1;
        report.told += told;
      } catch (e) {
        report.failed += 1;
        this.logger.error(
          `${TAG} form ${formId.slice(0, 8)} not asked (nothing claimed, retried at the next sweep): ${String(e)}`
        );
      }
    }
    if (due.length > 0) {
      this.logger.log(
        `${TAG} due=${due.length} asked=${report.asked} notices=${report.told} failed=${report.failed}`
      );
    }
    return report;
  }

  /**
   * Claims one form and writes its managers' bell rows in ONE transaction. Answers how many rows were
   * written, or `null` when the form was no longer due or another replica held it. The rows carry the
   * claim's instant (`meta.askedAt`): the bell shows a row only while it names the form's CURRENT
   * `staleAskedAt`, so the rows of an earlier question never come back with a later one.
   */
  private async askOne(formId: string, at: Date): Promise<number | null> {
    return this.formRepo.manager.transaction(async (m) => {
      const form = await claimStaleOpenForm(m, formId, at);
      if (!form) return null;
      const recipients = await recipientsWithCategoryOn(
        m,
        FORM_STALE_OPEN_TYPE,
        await staleOpenRecipients(m, form)
      );
      if (recipients.length > 0) {
        await m.save(
          PostNotification,
          recipients.map((recipientId) =>
            m.create(PostNotification, {
              recipientId,
              type: FORM_STALE_OPEN_TYPE,
              postId: form.id,
              actorId: SYSTEM_ACTOR_ID,
              actorName: SYSTEM_ACTOR_NAME,
              text: form.title ?? '',
              // The bell only (no push): a form nobody answers is never urgent enough to ring a phone.
              meta: { askedAt: at.toISOString() },
            })
          )
        );
      }
      // A claimed form nobody hears about is a swallowed outcome: the question is stamped asked and no
      // bell row exists, so the form stays open and unasked-about until an answer re-arms it.
      if (recipients.length === 0) {
        this.logger.warn(
          `${TAG} form ${form.id.slice(0, 8)}: claimed but told 0 manager(s) (no MANAGE_FORMS holder left)`
        );
      } else {
        this.logger.log(`${TAG} form ${form.id.slice(0, 8)}: told ${recipients.length} manager(s)`);
      }
      return recipients.length;
    });
  }

  /** PostgreSQL's clock, read once for the whole sweep. */
  private async databaseNow(): Promise<Date> {
    const [{ now }] = (await this.formRepo.query(`SELECT now() AS now`)) as Array<{
      now: Date | string;
    }>;
    return new Date(now);
  }
}
