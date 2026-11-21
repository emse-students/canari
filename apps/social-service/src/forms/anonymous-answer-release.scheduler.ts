import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { formsWithDueHeldAnswers, releaseHeldAnswers } from './anonymous-answer-batches';

const TAG = '[FORMS_ANON_RELEASE]';

/**
 * Delivers the anonymous answers of a form that stopped taking answers WITHOUT anybody acting - an
 * end date that came, an opening moved later - so they do not wait for the organiser to open the
 * responses (which releases them too, `FormsService.getSubmissions`), and a full batch whose
 * release right after its submit failed.
 *
 * The clock only decides when the predicate is LOOKED AT; what is due is a fact of the rows
 * (`formsWithDueHeldAnswers`), judged again under the form's lock by `releaseHeldAnswers`.
 * Idempotent: a second run finds nothing. One form's failure is logged and the others still run.
 */
@Injectable()
export class AnonymousAnswerReleaseScheduler {
  private readonly logger = new Logger(AnonymousAnswerReleaseScheduler.name);
  private running = false;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Hourly, at :17 - off the minutes the other jobs use. */
  @Cron('17 * * * *')
  async releaseDue(): Promise<void> {
    if (this.running) {
      this.logger.warn(`${TAG} the previous run is still going - this tick is skipped`);
      return;
    }
    this.running = true;
    try {
      await this.releaseOnce();
    } catch (e) {
      this.logger.error(`${TAG} run failed before it could look at the due forms`, e);
    } finally {
      this.running = false;
    }
  }

  /** The whole run, apart from the scheduler, for the test. Answers how many answers moved. */
  async releaseOnce(): Promise<number> {
    const due = await formsWithDueHeldAnswers(this.dataSource.manager);
    if (due.length === 0) {
      this.logger.debug(`${TAG} no form has answers due`);
      return 0;
    }
    let released = 0;
    for (const formId of due) {
      try {
        released += await releaseHeldAnswers(this.dataSource.manager, formId);
      } catch (e) {
        this.logger.error(
          `${TAG} release failed for form ${formId.slice(0, 8)}; kept for the next run`,
          e
        );
      }
    }
    this.logger.log(`${TAG} ${released} answer(s) released over ${due.length} form(s)`);
    return released;
  }
}
