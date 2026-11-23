import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PostNotificationsService,
  pushIconOf,
  SYSTEM_ACTOR_ID,
  SYSTEM_ACTOR_NAME,
} from '../posts/post-notifications.service';
import { PushService } from '../push/push.service';
import { formWaitlistPromotedContent } from '../push/push-content';
import { Submission } from './entities/submission.entity';

/** The bell type of a promotion from the waiting list; the push's `contentKey` is the same word. */
export const FORM_WAITLIST_PROMOTED_TYPE = 'form_waitlist_promoted';

/** The statuses a promoted answer may still be in when it is told: still a registration. */
const REGISTERED_STATUSES = ['free', 'pending_cash', 'payment_due', 'pending', 'paid'];

/** What one notice names, read in one statement: the answer, its form and its association. */
interface PromotionFacts {
  submissionId: string;
  userId: string;
  formId: string;
  formTitle: string | null;
  associationId: string | null;
  associationName: string | null;
  associationLogoUrl: string | null;
  associationLogoMediaId: string | null;
}

/**
 * TELLS A MEMBER, ONCE, THAT THEIR WAITING ANSWER BECAME A REGISTRATION (owner, 2026-11-23). The
 * waiting list's ONE notice - moving up in rank tells nobody (principle 3, "Votre attention n'est
 * pas à vendre"): one bell row and one push, on the form channel the form reminders use, naming the
 * association (its logo the picture) and the form's title.
 *
 * AT MOST ONCE, FROM THE ROW: `promotionNotifiedAt` is CLAIMED by a conditional `UPDATE` exactly one
 * caller wins, and only while the answer is still a registration; a failed write RELEASES it at
 * ERROR, and the five-minute sweep (`tellPending`) retries every promoted answer whose claim is
 * free. The promotion itself never depends on this: the place is taken in the promotion's own
 * transaction, and a notice that cannot be written loses no place.
 */
@Injectable()
export class FormWaitlistNoticeService {
  private readonly logger = new Logger(FormWaitlistNoticeService.name);

  constructor(
    @InjectRepository(Submission) private readonly submissionRepo: Repository<Submission>,
    private readonly notifications: PostNotificationsService,
    private readonly push: PushService
  ) {}

  /**
   * Tells each answer in `submissionIds` once (a try per answer: one failure never costs the others
   * theirs). Never throws: every failure is logged with the answer it concerns.
   */
  async tell(submissionIds: readonly string[]): Promise<void> {
    for (const submissionId of submissionIds) {
      try {
        await this.tellOne(submissionId);
      } catch (e: unknown) {
        this.logger.error(
          `[WAITLIST] promotion notice for ${submissionId.slice(0, 8)} failed before its claim`,
          e
        );
      }
    }
  }

  /**
   * THE SWEEP: every promoted answer still a registration whose notice was never claimed or was
   * released - a write that failed, a process stopped between the promotion's commit and its notice,
   * or a promotion made where no notifier runs (a refund, in the associations module). Each is
   * claimed as usual, so a notice being sent right now is not sent twice.
   */
  async tellPending(): Promise<number> {
    const rows = (await this.submissionRepo.query(
      `SELECT id FROM submissions
        WHERE "promotedAt" IS NOT NULL AND "promotionNotifiedAt" IS NULL
          AND "userId" IS NOT NULL AND "paymentStatus" = ANY($1::text[])`,
      [REGISTERED_STATUSES]
    )) as Array<{ id: string }>;
    if (rows.length === 0) return 0;
    this.logger.log(`[WAITLIST] ${rows.length} promotion notice(s) owed - telling`);
    await this.tell(rows.map((row) => row.id));
    return rows.length;
  }

  private async tellOne(submissionId: string): Promise<void> {
    if (!(await this.claim(submissionId))) return;
    let facts: PromotionFacts | undefined;
    let content: ReturnType<typeof formWaitlistPromotedContent>;
    try {
      facts = await this.factsOf(submissionId);
      if (!facts) {
        // Claimed while still a registration, so the row exists: only a delete in between lands here.
        this.logger.log(
          `[WAITLIST] ${submissionId.slice(0, 8)} gone after its claim - nobody told`
        );
        return;
      }
      const subject = {
        formTitle: facts.formTitle,
        associationName: facts.associationName,
        icon: pushIconOf({
          actorId: SYSTEM_ACTOR_ID,
          associationId: facts.associationId,
          associationLogoMediaId: facts.associationLogoMediaId,
        }),
      };
      content = formWaitlistPromotedContent(subject);
      await this.notifications.createNotification({
        recipientId: facts.userId,
        type: FORM_WAITLIST_PROMOTED_TYPE,
        postId: facts.formId,
        actorId: SYSTEM_ACTOR_ID,
        actorName: facts.associationName || SYSTEM_ACTOR_NAME,
        ...(facts.associationId && {
          associationId: facts.associationId,
          associationLogoUrl: facts.associationLogoUrl,
        }),
        text: facts.formTitle ?? '',
        // The push is sent below on the form channel, with the association's logo.
        skipPush: true,
      });
    } catch (e: unknown) {
      this.logger.error(
        `[WAITLIST] promotion notice for ${submissionId.slice(0, 8)} NOT written - released for the next sweep`,
        e
      );
      await this.release(submissionId);
      return;
    }
    this.logger.log(
      `[WAITLIST] promotion told: userId=${facts.userId.slice(0, 8)} submission=${submissionId.slice(0, 8)}`
    );
    // A push only fails a push: the bell row is what the claim covers, and re-sending the whole
    // notice to retry the push would write a second row.
    const recipient = facts.userId;
    this.push
      .notifyContent(recipient, content, { type: 'form_reminder', formId: facts.formId })
      .catch((e: unknown) =>
        this.logger.warn(
          `[WAITLIST] promotion push failed for ${recipient.slice(0, 8)}: ${String(e)}`
        )
      );
  }

  /** Stamps the claim IF free and the answer is still a registration; true for the one winner. */
  private async claim(submissionId: string): Promise<boolean> {
    const result = await this.submissionRepo
      .createQueryBuilder()
      .update()
      .set({ promotionNotifiedAt: () => 'now()' })
      .where('id = :id', { id: submissionId })
      .andWhere('"promotedAt" IS NOT NULL')
      .andWhere('"promotionNotifiedAt" IS NULL')
      .andWhere('"userId" IS NOT NULL')
      .andWhere('"paymentStatus" IN (:...statuses)', { statuses: REGISTERED_STATUSES })
      .execute();
    if (result.affected) return true;
    this.logger.log(
      `[WAITLIST] promotion notice for ${submissionId.slice(0, 8)} not claimed: already told, or no longer a registration`
    );
    return false;
  }

  private async release(submissionId: string): Promise<void> {
    try {
      await this.submissionRepo.update(submissionId, { promotionNotifiedAt: null });
    } catch (e: unknown) {
      this.logger.error(
        `[WAITLIST] promotion notice release failed for ${submissionId.slice(0, 8)}: the member will not be told`,
        e
      );
    }
  }

  private async factsOf(submissionId: string): Promise<PromotionFacts | undefined> {
    const rows = (await this.submissionRepo.query(
      `SELECT s.id AS "submissionId", s."userId", s."formId", f.title AS "formTitle",
              f."associationId", a.name AS "associationName", a."logoUrl" AS "associationLogoUrl",
              a."logoMediaId" AS "associationLogoMediaId"
         FROM submissions s
         JOIN forms f ON f.id = s."formId"
         LEFT JOIN associations a ON a.id = f."associationId"
        WHERE s.id = $1 AND s."userId" IS NOT NULL`,
      [submissionId]
    )) as PromotionFacts[];
    return rows[0];
  }
}
