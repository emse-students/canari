import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { formsWithDueHeldAnswers, releaseHeldAnswers } from './anonymous-answer-batches';

const TAG = '[FORMS_ANON_RELEASE]';

/**
 * Delivers the anonymous answers due WITHOUT anybody acting - a form whose end date came, whose
 * opening moved later, that is full or archived (`formsWithDueHeldAnswers` says which, and each line
 * says why) - and a full batch still waiting, which a submit's own release had not moved yet.
 *
 * Finding a full batch is NOT evidence of a failure, so it is not logged as one: the sweep reads the
 * due forms outside the form's lock, and a submit that committed a moment before may be about to
 * release that very batch (whichever takes the lock first moves it; the other finds nothing). A
 * release that did fail was already accused where it failed - at ERROR, by the submit, the close or
 * the read that ran it (`FormsService`) - and a process killed between a submit's commit and its
 * release is accused by its own crash. The line here says what was found and what moved.
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
    for (const { formId, reason, held } of due) {
      const form = formId.slice(0, 8);
      // No accusation here, even for a full batch: see the class comment.
      this.logger.log(`${TAG} form ${form}: ${held} answer(s) found waiting (${reason})`);
      try {
        released += await releaseHeldAnswers(this.dataSource.manager, formId);
      } catch (e) {
        this.logger.error(`${TAG} release failed for form ${form}; kept for the next run`, e);
      }
    }
    this.logger.log(`${TAG} ${released} answer(s) released over ${due.length} form(s)`);
    return released;
  }
}
