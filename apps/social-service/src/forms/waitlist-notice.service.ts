import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  pushIconOf,
  SYSTEM_ACTOR_ID,
  SYSTEM_ACTOR_NAME,
} from '../posts/post-notifications.service';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { PushService } from '../push/push.service';
import {
  formWaitlistPromotedContent,
  formWaitlistPromotedPaymentDueContent,
} from '../push/push-content';
import { recipientsWithCategoryOn } from '../push/notification-category';
import { Submission } from './entities/submission.entity';
import { PAYMENT_DUE } from './waitlist';

/** The bell type of a promotion from the waiting list; the push's `contentKey` is the same word. */
export const FORM_WAITLIST_PROMOTED_TYPE = 'form_waitlist_promoted';

/**
 * The bell type of a promotion on a paid ONLINE form (`payment_due`): the place is held for the
 * payment, for the online hold, and goes to the next in line if it is not paid - a sentence of its
 * own, where the plain promotion says "registered". The push's `contentKey` is the same word.
 */
export const FORM_WAITLIST_PROMOTED_PAYMENT_DUE_TYPE = 'form_waitlist_promoted_payment_due';

/** The statuses a promoted answer may still be in when it is told: still a registration. */
const REGISTERED_STATUSES = ['free', 'pending_cash', PAYMENT_DUE, 'pending', 'paid'];

/** What one notice names, read in the claim's statement: the answer, its form and its association. */
interface PromotionFacts {
  submissionId: string;
  userId: string;
  formId: string;
  paymentStatus: string;
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
 * association (its logo the picture) and the form's title. An answer promoted owing an online
 * payment (`payment_due`) is told that its place is HELD for that payment, with its own type.
 *
 * AT MOST ONCE, FROM THE ROW, AND NEVER LOST: the claim (`promotionNotifiedAt`, a conditional
 * `UPDATE` exactly one caller wins, only while the answer is still a registration) and the bell row
 * are written in ONE transaction - a crash or a failed write between them rolls both back, so the
 * claim stays free and the five-minute `tellPending` tells it. The push follows the commit; a failed
 * push costs only the push. The promotion itself never depends on this: the place is taken in the
 * promotion's own transaction, and a notice that cannot be written loses no place.
 */
@Injectable()
export class FormWaitlistNoticeService {
  private readonly logger = new Logger(FormWaitlistNoticeService.name);

  constructor(
    @InjectRepository(Submission) private readonly submissionRepo: Repository<Submission>,
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
          `[WAITLIST] promotion notice for ${submissionId.slice(0, 8)} NOT written - its claim stays free for the next run`,
          e
        );
      }
    }
  }

  /**
   * THE RETRY OF A NOTICE, NEVER OF A PROMOTION: every promoted answer still a registration whose
   * notice was never claimed - a write that failed, or a process stopped between the promotion's
   * commit and its notice. Each is claimed as usual, so a notice being sent right now is not sent
   * twice. Run by the five-minute form job; finding any is logged at WARN, since every promotion
   * tells its people itself right after its commit.
   */
  async tellPending(): Promise<number> {
    const rows = (await this.submissionRepo.query(
      `SELECT id FROM submissions
        WHERE "promotedAt" IS NOT NULL AND "promotionNotifiedAt" IS NULL
          AND "userId" IS NOT NULL AND "paymentStatus" = ANY($1::text[])`,
      [REGISTERED_STATUSES]
    )) as Array<{ id: string }>;
    if (rows.length === 0) return 0;
    this.logger.warn(
      `[WAITLIST] ${rows.length} promotion notice(s) owed after their promotion committed - telling now`
    );
    await this.tell(rows.map((row) => row.id));
    return rows.length;
  }

  /** The claim and the bell row in one transaction, then the push. Throws on a failed write. */
  private async tellOne(submissionId: string): Promise<void> {
    const told = await this.submissionRepo.manager.transaction(async (m) => {
      const [claimed] = (await m.query(
        `UPDATE submissions SET "promotionNotifiedAt" = now()
          WHERE id = $1 AND "promotedAt" IS NOT NULL AND "promotionNotifiedAt" IS NULL
            AND "userId" IS NOT NULL AND "paymentStatus" = ANY($2::text[])
          RETURNING id`,
        [submissionId, REGISTERED_STATUSES]
      )) as [unknown[], number];
      if (claimed.length === 0) return null;
      const [facts] = (await m.query(
        `SELECT s.id AS "submissionId", s."userId", s."formId", s."paymentStatus",
                f.title AS "formTitle", f."associationId", a.name AS "associationName",
                a."logoUrl" AS "associationLogoUrl", a."logoMediaId" AS "associationLogoMediaId"
           FROM submissions s
           JOIN forms f ON f.id = s."formId"
           LEFT JOIN associations a ON a.id = f."associationId"
          WHERE s.id = $1`,
        [submissionId]
      )) as PromotionFacts[];
      const type =
        facts.paymentStatus === PAYMENT_DUE
          ? FORM_WAITLIST_PROMOTED_PAYMENT_DUE_TYPE
          : FORM_WAITLIST_PROMOTED_TYPE;
      // The reader's own answer: always written (`BELL_ROW_GATE` 'reader'), read through the gate
      // like every bell row so a future gate on it is honoured here too.
      const [recipient] = await recipientsWithCategoryOn(m, type, [facts.userId]);
      if (recipient) {
        await m.save(
          PostNotification,
          m.create(PostNotification, {
            recipientId: facts.userId,
            type,
            postId: facts.formId,
            actorId: SYSTEM_ACTOR_ID,
            actorName: facts.associationName || SYSTEM_ACTOR_NAME,
            associationId: facts.associationId ?? null,
            associationLogoUrl: facts.associationId ? facts.associationLogoUrl : null,
            text: facts.formTitle ?? '',
          })
        );
      }
      return { facts, type };
    });
    if (!told) {
      this.logger.log(
        `[WAITLIST] promotion notice for ${submissionId.slice(0, 8)} not claimed: already told, or no longer a registration`
      );
      return;
    }
    const { facts, type } = told;
    this.logger.log(
      `[WAITLIST] promotion told (${type}): userId=${facts.userId.slice(0, 8)} submission=${submissionId.slice(0, 8)}`
    );
    const subject = {
      formTitle: facts.formTitle,
      associationName: facts.associationName,
      icon: pushIconOf({
        actorId: SYSTEM_ACTOR_ID,
        associationId: facts.associationId,
        associationLogoMediaId: facts.associationLogoMediaId,
      }),
    };
    const content =
      type === FORM_WAITLIST_PROMOTED_PAYMENT_DUE_TYPE
        ? formWaitlistPromotedPaymentDueContent(subject)
        : formWaitlistPromotedContent(subject);
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
}
