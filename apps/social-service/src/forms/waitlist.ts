import { LessThanOrEqual, type EntityManager } from 'typeorm';
import type { Logger } from '@nestjs/common';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { cashReminderDueAt } from './cash-reminder';
import { seatHoldingWhere } from './seat-hold';

/**
 * THE WAITING LIST OF A LIMITED FORM (owner, 2026-11-23; docs/wiki/frontend/modules/forms.md, "A
 * waiting list on a limited form"; the four choices in docs/wiki/decisions/owner-decisions-of-2026-11-23.md).
 *
 * - **Opt-in** (`forms.waitlistEnabled`, off by default): with it on, a member's answer given once
 *   every place is taken is stored `waiting` instead of refused `FORM_FULL`.
 * - **A freed place promotes the first in line, at once**: no offer, no deadline, no timer. The
 *   promotion runs under the form's seat lock (`lockFormSeats`), the lock every capacity decision
 *   takes, and it is decided from the rows alone: free places = capacity - seats held, and the first
 *   that many waiting answers, by `waitlistOrder`, become registrations. Run twice, the second finds
 *   no free place or no one waiting - idempotent from durable state, never from a clock.
 * - **A new answer never takes a freed place ahead of the queue**: `submit` and a payment resume
 *   promote FIRST, under the same lock, and count the seats after.
 * - **A waiting answer holds no seat** (`seatHoldingWhere` never names `waiting`); it is an answer of
 *   its person (`answerHoldingWhere`), so nobody is twice on the list.
 */

/** The status of an answer on the waiting list. */
export const WAITING = 'waiting';

/**
 * The status of a waiting ONLINE answer promoted on a paid form: registered, its seat held for the
 * online hold counted from the promotion (`livePaymentDueWhere`), paid through the payment resume.
 */
export const PAYMENT_DUE = 'payment_due';

/**
 * What freed the place a promotion fills, named in every log line so a promotion is traceable to its
 * event. `sweep` is the five-minute job finding a free place nothing promoted: a missed event,
 * logged at WARN when it promotes anyone.
 */
export type WaitlistTrigger =
  | 'submit'
  | 'resume'
  | 'member-cancel'
  | 'manager-cancel'
  | 'provider-release'
  | 'unissued-release'
  | 'manager-delete'
  | 'cash-cancel'
  | 'cash-expiry'
  | 'online-expiry'
  | 'refund'
  | 'form-edit'
  | 'by-hand'
  | 'sweep';

/** The form fields the waiting list reads. */
export type WaitlistForm = Pick<
  Form,
  'waitlistEnabled' | 'maxSubmissions' | 'anonymous' | 'allowMultipleSubmissions'
>;

/**
 * Whether a form takes waiting answers: the switch on, AND a limited form (`maxSubmissions`), AND a
 * named one (an anonymous answer names nobody to promote or tell), AND a single-answer one (a rank
 * is a person's place, and a form taking several answers has no "the person's answer"). The editor
 * offers the switch only there; a stored switch on a form that stops qualifying is simply inert, so
 * no save is ever refused for it.
 */
export function waitlistApplies(form: WaitlistForm): boolean {
  return (
    form.waitlistEnabled === true &&
    !!form.maxSubmissions &&
    form.anonymous !== true &&
    form.allowMultipleSubmissions !== true
  );
}

/** One answer a promotion registered: who to tell, and what it became. */
export interface PromotedAnswer {
  submissionId: string;
  userId: string | null;
  formId: string;
  status: 'free' | 'pending_cash' | typeof PAYMENT_DUE;
}

/**
 * The status a waiting answer takes when promoted, from the answer itself: free when it owes
 * nothing, `pending_cash` when its person chose cash (the cash window and its one reminder start
 * then, as for an answer given in cash), else `payment_due` (the online hold starts then).
 */
export function promotedStatusOf(
  row: Pick<Submission, 'totalPaid' | 'paymentMethod'>
): PromotedAnswer['status'] {
  if (!(row.totalPaid > 0)) return 'free';
  return row.paymentMethod === 'cash' ? 'pending_cash' : PAYMENT_DUE;
}

/**
 * REGISTERS ONE WAITING ANSWER - the step both the automatic promotion and a manager's promotion by
 * hand take. THE CALLER HOLDS THE FORM'S SEAT LOCK in this READ COMMITTED transaction (`lockFormSeats`)
 * and the row's own lock. The write names `waiting` in its WHERE and must move exactly one row: any
 * other count means the row changed under a lock that forbids it, and throws.
 *
 * Exactly what a fresh answer of the same kind gets: a cash answer its window (`cashPaymentExpiryDays`)
 * and the due date of its one reminder (`cash-reminder.ts`), written as `submit` writes them; an
 * online one its hold, restarted on the database clock (`paymentRequestedAt = now()`).
 */
export async function promoteWaitingRow(
  manager: EntityManager,
  row: Submission,
  form: Pick<Form, 'cashPaymentExpiryDays'>
): Promise<PromotedAnswer> {
  const status = promotedStatusOf(row);
  const base = { paymentStatus: status, promotedAt: () => 'now()' } as const;
  let patch: Record<string, unknown>;
  if (status === 'pending_cash') {
    const now = new Date();
    const cashExpiresAt =
      form.cashPaymentExpiryDays != null
        ? new Date(now.getTime() + form.cashPaymentExpiryDays * 24 * 60 * 60 * 1000)
        : null;
    patch = {
      ...base,
      cashExpiresAt,
      cashReminderDueAt: cashExpiresAt && row.userId ? cashReminderDueAt(cashExpiresAt, now) : null,
      cashReminderNotifiedAt: null,
    };
  } else if (status === PAYMENT_DUE) {
    patch = { ...base, paymentRequestedAt: () => 'now()' };
  } else {
    patch = { ...base };
  }
  const result = await manager.update(Submission, { id: row.id, paymentStatus: WAITING }, patch);
  if (result.affected !== 1) {
    throw new Error(
      `waiting answer ${row.id} could not be promoted: ${result.affected ?? 'no'} row(s) moved under the form lock`
    );
  }
  return { submissionId: row.id, userId: row.userId, formId: row.formId, status };
}

/**
 * PROMOTES AS MANY WAITING ANSWERS AS THE FORM HAS FREE PLACES, first in line first. THE CALLER
 * HOLDS THE FORM'S SEAT LOCK in this READ COMMITTED transaction (`lockFormSeats`), so the count and
 * the promotions are one step no other capacity decision interleaves with: two places freed at once
 * promote two people, and a concurrent submit counts after them.
 *
 * Reads the form again under the lock (its capacity may have moved since the caller read it), never
 * an archived form's answers, and nothing when nobody waits. A form with no capacity left (the
 * limit cleared) promotes everyone waiting. Returns what it promoted, for the caller to tell AFTER
 * its commit (`FormWaitlistNoticeService`): a notice is never sent about a promotion that rolled back.
 */
export async function promoteFromWaitlist(
  manager: EntityManager,
  formId: string,
  trigger: WaitlistTrigger,
  logger: Pick<Logger, 'log' | 'debug' | 'warn'>
): Promise<PromotedAnswer[]> {
  const waitingCount = await manager.count(Submission, {
    where: { formId, paymentStatus: WAITING },
  });
  if (waitingCount === 0) return [];
  const form = await manager.findOne(Form, {
    where: { id: formId },
    select: { id: true, maxSubmissions: true, cashPaymentExpiryDays: true, deletedAt: true },
  });
  if (!form || form.deletedAt) {
    logger.debug(
      `[WAITLIST] ${trigger}: form ${formId.slice(0, 8)} is gone or archived - nobody promoted`
    );
    return [];
  }
  let free = waitingCount;
  if (form.maxSubmissions) {
    const held = await manager.count(Submission, { where: seatHoldingWhere(formId) });
    free = Math.max(0, form.maxSubmissions - held);
    if (free === 0) {
      logger.debug(
        `[WAITLIST] ${trigger}: form ${formId.slice(0, 8)} full (${held}/${form.maxSubmissions}), ${waitingCount} waiting`
      );
      return [];
    }
  }
  const first = await manager.find(Submission, {
    where: { formId, paymentStatus: WAITING },
    order: { waitlistOrder: 'ASC' },
    take: free,
    lock: { mode: 'pessimistic_write' },
  });
  const promoted: PromotedAnswer[] = [];
  for (const row of first) promoted.push(await promoteWaitingRow(manager, row, form));
  const line =
    `[WAITLIST] ${trigger}: form ${formId.slice(0, 8)} promoted ${promoted.length} of ` +
    `${waitingCount} waiting (${promoted.map((p) => `${p.submissionId.slice(0, 8)}->${p.status}`).join(', ')})`;
  // The sweep promoting anyone means an event that freed a place did not promote: accused.
  if (trigger === 'sweep') logger.warn(`${line} - no event promoted for this place`);
  else logger.log(line);
  return promoted;
}

/**
 * The arrival order the next waiting answer of a form takes: one more than the form's highest, read
 * under the form's seat lock (the caller holds it), so two arrivals never share an order. A string:
 * the column is a `bigint`, which the driver hands back as text.
 */
export async function nextWaitlistOrder(manager: EntityManager, formId: string): Promise<string> {
  const [{ next }] = (await manager.query(
    `SELECT (COALESCE(MAX("waitlistOrder"), 0) + 1)::text AS next FROM submissions WHERE "formId" = $1`,
    [formId]
  )) as Array<{ next: string }>;
  return next;
}

/**
 * A waiting answer's place in line, 1 for the first: how many answers of its form still wait with
 * an order at or before its own. Counted from the rows, so leaving the list or a promotion moves
 * everyone behind up without any write.
 */
export async function waitlistRank(
  manager: EntityManager,
  row: Pick<Submission, 'formId' | 'waitlistOrder'>
): Promise<number> {
  if (row.waitlistOrder === null) {
    throw new Error(`waiting answer on form ${row.formId} carries no waitlistOrder`);
  }
  return manager.count(Submission, {
    where: {
      formId: row.formId,
      paymentStatus: WAITING,
      waitlistOrder: LessThanOrEqual(row.waitlistOrder),
    },
  });
}

/**
 * A manager's list with the waiting answers SEPARATE: every other answer first, in the order given,
 * then the waiting ones in arrival order - the responses list and the export both show them apart,
 * never mixed with the registrations they do not count toward.
 */
export function waitingLast<T extends { paymentStatus: string; waitlistOrder: string | null }>(
  rows: readonly T[]
): T[] {
  const waiting = rows
    .filter((row) => row.paymentStatus === WAITING)
    .sort((a, b) => {
      const x = BigInt(a.waitlistOrder ?? '0');
      const y = BigInt(b.waitlistOrder ?? '0');
      return x < y ? -1 : x > y ? 1 : 0;
    });
  return [...rows.filter((row) => row.paymentStatus !== WAITING), ...waiting];
}
