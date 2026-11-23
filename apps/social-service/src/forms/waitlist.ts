import { LessThanOrEqual, type EntityManager } from 'typeorm';
import type { Logger } from '@nestjs/common';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { cashReminderDueAt } from './cash-reminder';
import { seatHoldingWhere } from './seat-hold';
import { acceptsCash, acceptsOnline } from './payment-offer';

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
 * event. There is no sweep: every event that frees a place promotes in its own transaction, under the
 * form's seat lock, so a place is never free with someone waiting once that event has committed.
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
  | 'by-hand';

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
  status: 'free' | 'pending_cash' | typeof PAYMENT_DUE | 'paid';
}

/**
 * What a waiting answer becomes when its turn comes. `paidRowId` names the SAME PERSON's
 * `paid_over_capacity` answer on the form, when they have one: a late payment that landed on an old
 * answer while this one waited (`markPaid`, decision of 2026-11-23 recorded in forms.md). Their
 * turn then converts THAT answer to `paid` - the money already landed, so nothing is charged twice
 * and no `payment_due` is opened - and the waiting answer is deleted.
 */
export interface PromotionPlan {
  status: PromotedAnswer['status'];
  paidRowId: string | null;
}

/**
 * Reads what `row`, a waiting answer, becomes (`PromotionPlan`), locking the same person's
 * `paid_over_capacity` answer when there is one. THE CALLER HOLDS THE FORM'S SEAT LOCK.
 */
export async function planPromotion(
  manager: EntityManager,
  row: Pick<Submission, 'formId' | 'userId' | 'totalPaid' | 'paymentMethod'>
): Promise<PromotionPlan> {
  const paid = row.userId
    ? await manager.findOne(Submission, {
        where: { formId: row.formId, userId: row.userId, paymentStatus: 'paid_over_capacity' },
        select: { id: true },
        order: { createdAt: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      })
    : null;
  if (paid) return { status: 'paid', paidRowId: paid.id };
  return { status: promotedStatusOf(row), paidRowId: null };
}

/**
 * The status a waiting answer takes when promoted, from the answer itself: free when it owes
 * nothing, `pending_cash` when its person chose cash (the cash window and its one reminder start
 * then, as for an answer given in cash), else `payment_due` (the online hold starts then).
 */
export function promotedStatusOf(
  row: Pick<Submission, 'totalPaid' | 'paymentMethod'>
): Exclude<PromotedAnswer['status'], 'paid'> {
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
 *
 * A plan naming a `paid_over_capacity` answer (`planPromotion`) converts THAT answer to `paid`
 * instead, and deletes the waiting one - each write must move exactly one row, under the same rule.
 * The caller runs what a landed payment buys after its commit (`FormsService.tellPromoted`).
 */
export async function promoteWaitingRow(
  manager: EntityManager,
  row: Submission,
  form: Pick<Form, 'cashPaymentExpiryDays'>,
  plan: PromotionPlan
): Promise<PromotedAnswer> {
  if (plan.paidRowId) {
    const converted = await manager.update(
      Submission,
      { id: plan.paidRowId, paymentStatus: 'paid_over_capacity' },
      { paymentStatus: 'paid', promotedAt: () => 'now()' }
    );
    const left = await manager.delete(Submission, { id: row.id, paymentStatus: WAITING });
    if (converted.affected !== 1 || left.affected !== 1) {
      throw new Error(
        `waiting answer ${row.id} could not convert ${plan.paidRowId}: ${converted.affected ?? 'no'} ` +
          `converted, ${left.affected ?? 'no'} deleted under the form lock`
      );
    }
    return { submissionId: plan.paidRowId, userId: row.userId, formId: row.formId, status: 'paid' };
  }
  const status = plan.status;
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
 * Whether an edit moving a form's capacity from `before` to `after` FREES places: a limit raised, or
 * cleared (no limit, `null` or 0, takes everyone). A form that had no limit had no line to promote.
 */
export function capacityFreed(
  before: number | null | undefined,
  after: number | null | undefined
): boolean {
  if (!before) return false;
  return !after || after > before;
}

/** The payment modes of a form a promotion reads, to know whether the promotee can pay. */
export type WaitlistPaymentModes = Pick<Form, 'allowOnlinePayment' | 'allowCashPayment'>;

/**
 * Whether the form's association can collect an ONLINE payment now (`collectsNow`: its own or its
 * approved delegate's Lydia account ready, the entity allowed to collect), asked lazily and only
 * for an online promotee. A personal form collects through the platform: always true there.
 */
export type OnlineCollects = (associationId: string | null) => Promise<boolean>;

/** The one `OnlineCollects` every promoting service passes: `collectsNow`, true for a personal form. */
export function onlineCollectsThrough(associations: {
  collectsNow(associationId: string): Promise<boolean>;
}): OnlineCollects {
  return (associationId) =>
    associationId ? associations.collectsNow(associationId) : Promise.resolve(true);
}

/**
 * Whether a promotee of `status` has a way to pay on this form NOW: an online promotee needs online
 * payment offered by the editor AND an association that can collect it (`onlineCollects`: an
 * account paused, revoked or never set up makes `payment_due` unpayable - the resume is refused -
 * so promoting into it would only hand the place on, one person per hold, until the line is
 * empty), a cash one needs cash accepted (`pending_cash` is validated by a manager taking cash). A
 * free one owes nothing. False is THE FROZEN LIST: the first in line cannot become a registration
 * it could pay.
 */
export async function promotionPayable(
  status: PromotedAnswer['status'],
  form: WaitlistPaymentModes & Pick<Form, 'associationId'>,
  onlineCollects: OnlineCollects
): Promise<boolean> {
  if (status === PAYMENT_DUE) {
    return acceptsOnline(form) && (await onlineCollects(form.associationId ?? null));
  }
  if (status === 'pending_cash') return acceptsCash(form);
  return true;
}

/**
 * PROMOTES AS MANY WAITING ANSWERS AS THE FORM HAS FREE PLACES, first in line first. THE CALLER
 * HOLDS THE FORM'S SEAT LOCK in this READ COMMITTED transaction (`lockFormSeats`), so the count and
 * the promotions are one step no other capacity decision interleaves with: two places freed at once
 * promote two people, and a concurrent submit counts after them. Every event that frees a place
 * calls it in the transaction that frees it, so a failure here rolls the freeing back with it.
 *
 * Reads the form again under the lock (its capacity may have moved since the caller read it), never
 * an archived form's answers, and nothing when nobody waits. A form with no capacity left (the
 * limit cleared) promotes everyone waiting. Returns what it promoted, for the caller to tell AFTER
 * its commit (`FormWaitlistNoticeService`): a notice is never sent about a promotion that rolled back.
 *
 * THE FROZEN LIST: when the next in line would owe a payment the form cannot take now (online
 * switched off, or an association that cannot collect online, for an online promotee; cash switched
 * off for a cash one: `promotionPayable`), promotion STOPS there - nobody behind is promoted past
 * them, since the line is never reordered (owner, 2026-11-23). Logged at WARN; the manager sees it
 * on the list (the same rule, in the client's `waitlistFrozen`). It lifts at the next promotion
 * that finds the mode payable again: any save of the published form promotes while someone waits
 * (`FormsService.update`), so turning the mode back on lifts it in that save; an account made ready
 * again lifts it at the form's next save, freed place or submit, or a promotion by hand.
 */
export async function promoteFromWaitlist(
  manager: EntityManager,
  formId: string,
  trigger: WaitlistTrigger,
  logger: Pick<Logger, 'log' | 'debug' | 'warn'>,
  onlineCollects: OnlineCollects
): Promise<PromotedAnswer[]> {
  const waitingCount = await manager.count(Submission, {
    where: { formId, paymentStatus: WAITING },
  });
  if (waitingCount === 0) return [];
  const form = await manager.findOne(Form, {
    where: { id: formId },
    select: {
      id: true,
      maxSubmissions: true,
      cashPaymentExpiryDays: true,
      deletedAt: true,
      associationId: true,
      allowOnlinePayment: true,
      allowCashPayment: true,
    },
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
  for (const row of first) {
    const plan = await planPromotion(manager, row);
    const status = plan.status;
    if (!(await promotionPayable(status, form, onlineCollects))) {
      logger.warn(
        `[WAITLIST] ${trigger}: form ${formId.slice(0, 8)} list FROZEN at ${row.id.slice(0, 8)}: ` +
          `it would be ${status}, and the form can take no ${status === PAYMENT_DUE ? 'online' : 'cash'} ` +
          `payment now - nobody behind it is promoted past it until that payment mode is payable ` +
          `again or a manager removes it`
      );
      break;
    }
    promoted.push(await promoteWaitingRow(manager, row, form, plan));
  }
  if (promoted.length > 0) {
    logger.log(
      `[WAITLIST] ${trigger}: form ${formId.slice(0, 8)} promoted ${promoted.length} of ` +
        `${waitingCount} waiting (${promoted.map((p) => `${p.submissionId.slice(0, 8)}->${p.status}`).join(', ')})`
    );
  }
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
