import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { EntityManager, In, type QueryRunner, Repository } from 'typeorm';
import { coreUrl } from '../../internal/service-urls';
import { internalCoreRequestConfig } from '../../internal/core-request';
import { lockBuyerTiers } from '../../users/buyer-tier-lock';
import { lockFormSeats } from '../../forms/seat-hold';
import {
  LISTED_PURCHASE_STATUSES,
  PurchaseRecord,
  RECEIVED_PURCHASE_STATUSES,
} from '../../users/entities/purchase-record.entity';
import { AssociationsService } from '../associations.service';
import { approvedDelegateIds } from '../payment-delegation.util';
import { productOrderRef } from '../product-checkout';
import { LydiaRefund, type RefundKind } from './lydia-refund.entity';
import { LydiaRefundNotifier } from './lydia-refund-notifier.service';
import {
  CORE_REFUND_CODES,
  LYDIA_REFUND_EXCEEDS_PAID,
  LYDIA_REFUND_IN_FLIGHT,
  LYDIA_REFUND_INVALID,
  LYDIA_REFUND_NOT_PENDING,
  LYDIA_REFUND_NOT_REFUNDABLE,
  type NotRefundableReason,
  type RefundSideEffect,
  type RefundWithdrawal,
} from './refund-codes';

/** How long social waits on core's refund route: over core's own 60 s bound on Lydia. */
export const CORE_REFUND_TIMEOUT_MS = 90_000;

/**
 * The session-level advisory lock a refund call holds from BEFORE its `pending` row commits until its
 * outcome is written (`refund`). A crashed process loses its connection and with it the lock, so a
 * `pending` row with no outcome whose lock is FREE is proven abandoned - no call is in flight for it
 * on any replica - and `sweepAbandoned` marks it `no-answer`. No clock decides it.
 */
export const REFUND_CALL_LOCK_KEY = `hashtextextended('lydia-refund-call:' || $1::text, 0)`;

/**
 * THE TERMINATION BOUND of a refund call: no call can still run once this long has passed since its
 * `calledAt` (stamped, on the database clock, just before core is asked). It is the bound
 * `askLydia` itself enforces on core (`CORE_REFUND_TIMEOUT_MS`, axios `timeout`), which is over core's
 * own bound on Lydia (`LYDIA_CALL_TIMEOUT_MS`, 60 s, core's `postForm`). `sweepAbandoned` sweeps only
 * past it: a free lock alone is no proof, since a connection lost while its process lives frees the
 * lock with the call still running.
 */
export const REFUND_CALL_BOUND_MS = CORE_REFUND_TIMEOUT_MS;

/** What a refund Lydia confirmed but Canari failed to record is marked (`markUnrecorded`). */
export const REFUNDED_UNRECORDED = 'refunded-unrecorded';

/** The longest reason a manager may type; the column's width. */
export const REFUND_REASON_MAX_LENGTH = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a refund asks: total, or partial with an amount; a reason; the dialog's one-time key. */
export interface RefundInput {
  kind: RefundKind;
  amountCents?: number;
  reason: string;
  idempotencyKey: string;
}

/** A refund as a manager's screen reads it - no Business, no order_ref, no account id. */
export interface RefundView {
  id: string;
  purchaseRecordId: string;
  kind: RefundKind;
  amountCents: number;
  reason: string;
  /** Where the refund stands (`RefundViewState`). */
  state: RefundViewState;
  /** The typed code of a refusal, so the screen words it; null otherwise. */
  refusal: string | null;
  /**
   * Lydia's own answer when it arrived AFTER the refund was settled and CONTRADICTS how it was
   * settled (`refunded` on a refund settled as not refunded, `refused` on one settled as refunded):
   * a manager must look at Lydia's statement again. Null otherwise.
   */
  lateAnswer: 'refunded' | 'refused' | null;
  sideEffect: string | null;
  requestedAt: string;
  answeredAt: string | null;
  resolvedAt: string | null;
}

/**
 * Where a refund stands, as a manager's screen words it:
 * - `refunded`: Lydia confirmed (or a manager declared so after checking Lydia);
 * - `refused`: nothing was refunded;
 * - `in-progress`: Lydia is being asked right now - nothing to check yet;
 * - `unconfirmed`: Lydia never answered - a manager checks Lydia before any new refund;
 * - `unrecorded`: Lydia confirmed, but Canari failed to record it - a manager records it.
 */
export type RefundViewState = 'refunded' | 'refused' | 'in-progress' | 'unconfirmed' | 'unrecorded';

/** One line of the statement: a payment received, or a confirmed refund (a negative amount). */
export interface StatementLine {
  /** `YYYY-MM-DD`. */
  date: string;
  operation: 'payment' | 'refund-total' | 'refund-partial';
  item: string;
  method: 'cash' | 'online';
  amountCents: number;
  /** The refund's reason, as the manager typed it; null for a payment. */
  reason: string | null;
}

/** The association's statement: its lines, oldest payments first then refunds, and the totals. */
export interface AssociationStatement {
  lines: StatementLine[];
  receivedCents: number;
  refundedCents: number;
}

/** Per payment of the association's list: whether a refund is offered, and where it stands. */
export interface RefundStanding {
  purchaseRecordId: string;
  refundable: boolean;
  reason: NotRefundableReason | null;
  /** What a TOTAL refund withdraws; null when the payment is not refundable. */
  withdrawal: RefundWithdrawal | null;
  paidCents: number;
  refundedCents: number;
  /** The refund not settled yet, which blocks the next one, and where it stands; null when none. */
  openRefund: { id: string; state: 'in-progress' | 'unconfirmed' | 'unrecorded' } | null;
}

/** The Lydia transaction a payment was, and what a total refund of it would withdraw. */
type Target =
  | {
      ok: true;
      orderRef: string;
      vendorToken: string;
      withdrawal: RefundWithdrawal;
      submissionId: string | null;
      formId: string | null;
    }
  | { ok: false; reason: NotRefundableReason };

/** The outcome of the refund call, as the row records it. */
type CallOutcome =
  | { status: 'confirmed'; outcome: 'refunded' }
  | { status: 'refused'; outcome: string }
  | { status: 'pending'; outcome: 'no-answer' };

/**
 * LYDIA REFUNDS FROM CANARI (enrolment chantier lot 4, docs/wiki/frontend/modules/payments.md
 * "Refunds from Canari"). Asked by a `MANAGE_PAYOUT_ACCOUNT` holder of the association whose Lydia
 * Business took the payment, never through the Lydia console.
 *
 * IDEMPOTENCE FROM DURABLE STATE. A refund is a `lydia_refunds` row written `pending` BEFORE core asks
 * Lydia, under the payment's row lock, unique per (payment, client key) - a resent click finds its own
 * row and calls nothing. AT MOST ONE `pending` per payment: a second refund is `LYDIA_REFUND_IN_FLIGHT`.
 * The sum of `pending` and `confirmed` refunds never exceeds the amount paid, decided under that lock.
 *
 * AN UNKNOWN OUTCOME IS NEVER RETRIED BLIND. Lydia's `transaction/refund` carries no idempotency key,
 * and Lydia offers Canari no read of a refund. So a refund Lydia did not answer stays `pending`
 * (`LYDIA_REFUND_UNCONFIRMED`), and the RE-CHECK is a manager reading Lydia's own statement (the
 * Lydia Pro app) and declaring what they see (`resolve`): only then can a new refund be asked. While
 * the call is still running (no outcome yet, its call lock held) nothing may be declared at all.
 *
 * A TOTAL refund withdraws what the payment bought (`withdraw`); a PARTIAL one withdraws nothing -
 * and partial refunds that add up to the whole payment withdraw nothing either.
 */
@Injectable()
export class RefundsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @InjectRepository(LydiaRefund) private readonly refundRepo: Repository<LydiaRefund>,
    private readonly associations: AssociationsService,
    private readonly notifier: LydiaRefundNotifier
  ) {}

  /** Refuses anyone but a MANAGE_PAYOUT_ACCOUNT holder of the association (403). */
  async assertPayoutManager(userId: string, associationId: string, isGlobalAdmin: boolean) {
    const allowed = await this.associations.canManagePayoutAccount(userId, associationId, {
      isGlobalAdmin,
    });
    if (!allowed) {
      this.logger.debug(`[LYDIA-REFUND] refused: not a payout manager of ${associationId}`);
      throw new ForbiddenException('MANAGE_PAYOUT_ACCOUNT permission required');
    }
  }

  /**
   * The refund standing of every payment the association's purchases list, and its refunds - what
   * the purchases screen draws its "Refund" buttons and states from. One read per table, not per row.
   */
  async describe(
    associationId: string
  ): Promise<{ standings: RefundStanding[]; refunds: RefundView[] }> {
    const manager = this.refundRepo.manager;
    // A process that died mid-call left its row with no outcome: proven abandoned, it reads as
    // unconfirmed now rather than "in progress" until the next boot.
    await this.sweepAbandoned();
    const business = await this.businessOf(manager, associationId);
    const records = await manager.find(PurchaseRecord, {
      where: { associationId, status: In(LISTED_PURCHASE_STATUSES) },
      order: { paidAt: 'DESC' },
    });
    const ids = records.map((r) => r.id);
    const refunds = ids.length
      ? await manager.find(LydiaRefund, {
          where: { purchaseRecordId: In(ids) },
          order: { requestedAt: 'DESC' },
        })
      : [];
    const targets = await this.targetsOf(manager, records);
    const standings: RefundStanding[] = [];
    for (const record of records) {
      const target = targets.get(record.id) as Target;
      const mine = refunds.filter((r) => r.purchaseRecordId === record.id);
      const reason = refusalOf(target, business);
      standings.push({
        purchaseRecordId: record.id,
        refundable: reason === null,
        reason,
        withdrawal: target.ok && reason === null ? target.withdrawal : null,
        paidCents: record.amountCents,
        refundedCents: mine
          .filter((r) => r.status === 'confirmed')
          .reduce((sum, r) => sum + r.amountCents, 0),
        openRefund: openRefundOf(mine),
      });
    }
    this.logger.debug(
      `[LYDIA-REFUND] association ${associationId.slice(0, 8)}: ${standings.length} payment(s), ` +
        `${standings.filter((s) => s.refundable).length} refundable, ${refunds.length} refund(s)`
    );
    return { standings, refunds: refunds.map(toView) };
  }

  /**
   * Refunds a payment, total or partial. In order: the input is checked; ONE transaction makes the
   * claim (`claim`: a replay answers its own row and calls nothing) and takes the call lock; core
   * asks Lydia; the outcome is written (`record`). Throws the typed refusals of `refund-codes.ts`;
   * an unknown outcome is the 504 `LYDIA_REFUND_UNCONFIRMED`, the row kept pending. A refund Lydia
   * confirmed that Canari failed to record answers its view, `unrecorded`.
   */
  async refund(
    associationId: string,
    purchaseRecordId: string,
    actorId: string,
    input: RefundInput
  ): Promise<RefundView> {
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (
      (input?.kind !== 'total' && input?.kind !== 'partial') ||
      !reason ||
      reason.length > REFUND_REASON_MAX_LENGTH ||
      typeof input.idempotencyKey !== 'string' ||
      !UUID_RE.test(input.idempotencyKey) ||
      (input.kind === 'partial' &&
        (typeof input.amountCents !== 'number' ||
          !Number.isSafeInteger(input.amountCents) ||
          input.amountCents <= 0))
    ) {
      this.logger.warn(`[LYDIA-REFUND] refused: invalid request on ${purchaseRecordId}`);
      throw new BadRequestException({
        code: LYDIA_REFUND_INVALID,
        message: 'A refund needs a kind, a reason and, when partial, a positive amount in cents',
      });
    }
    // ONE connection carries the whole refund - the claim, the call stamp, the outcome and its
    // fallback mark - so a refund never waits on a second pool connection while holding this one. The
    // call lock taken INSIDE the claim's transaction (session level, so it outlives the commit) is
    // held on it until the outcome is written.
    const runner = this.refundRepo.manager.connection.createQueryRunner();
    await runner.connect();
    let locked: string | null = null;
    try {
      let claim: { replay: LydiaRefund } | { row: LydiaRefund };
      await runner.startTransaction();
      try {
        claim = await this.claim(
          runner.manager,
          associationId,
          purchaseRecordId,
          actorId,
          input,
          reason
        );
        if ('row' in claim) {
          await runner.query(`SELECT pg_advisory_lock(${REFUND_CALL_LOCK_KEY})`, [claim.row.id]);
          locked = claim.row.id;
        }
        await runner.commitTransaction();
      } catch (err: unknown) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        throw err;
      }
      if ('replay' in claim) {
        // The SAME request again: its row answers, whatever state it is in - the screen reads `state`.
        this.logger.log(
          `[LYDIA-REFUND] ${claim.replay.id}: the same request again (${viewStateOf(claim.replay)}) - nothing sent`
        );
        return toView(claim.replay);
      }
      // The start of the call, on the DATABASE clock and on this connection: what the sweep's
      // termination bound counts from. If it cannot be written, nothing is sent.
      await runner.query(`UPDATE lydia_refunds SET "calledAt" = now() WHERE id = $1`, [
        claim.row.id,
      ]);
      const outcome = await this.askLydia(claim.row);
      return answerOf(await this.record(runner.manager, claim.row, outcome));
    } finally {
      const unlocked = locked ? await this.unlockCall(runner, locked) : true;
      if (unlocked) {
        await runner.release();
      } else {
        // A connection whose lock could not be released is DESTROYED, never handed back to the
        // pool still holding it (pg-pool discards a client released with an error).
        await (
          runner as unknown as { releasePostgresConnection(err: Error): Promise<void> }
        ).releasePostgresConnection(new Error('lydia refund call lock not released'));
      }
    }
  }

  /**
   * The claim of `refund`, inside its transaction: locks the payment's record, checks it is the
   * association's own payment or an approved delegate's (its Business is the one refunded), answers
   * this key's own row as a replay, refuses while another refund is not settled, decides
   * refundability and the sum cap, and writes the `pending` row.
   */
  private async claim(
    manager: EntityManager,
    associationId: string,
    purchaseRecordId: string,
    actorId: string,
    input: RefundInput,
    reason: string
  ): Promise<{ replay: LydiaRefund } | { row: LydiaRefund }> {
    const record = await manager.findOne(PurchaseRecord, {
      where: { id: purchaseRecordId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!record) {
      this.logger.warn(`[LYDIA-REFUND] refused: payment ${purchaseRecordId} not found`);
      throw new NotFoundException('Payment not found');
    }
    // EXPLICIT OWNERSHIP, not only a matching Business: the payment is this association's, or one of
    // an association whose payments this one's Business serves by an APPROVED delegation.
    if (
      record.associationId !== associationId &&
      !(await approvedDelegateIds(manager, associationId)).includes(record.associationId)
    ) {
      this.logger.warn(
        `[LYDIA-REFUND] refused: payment ${purchaseRecordId} is neither ${associationId}'s nor an ` +
          'approved delegate of it'
      );
      throw new NotFoundException('Payment not found');
    }
    const own = await manager.findOne(LydiaRefund, {
      where: { purchaseRecordId, idempotencyKey: input.idempotencyKey },
    });
    if (own) return { replay: own };
    const pending = await manager.findOne(LydiaRefund, {
      where: { purchaseRecordId, status: 'pending' },
    });
    if (pending) {
      this.logger.warn(
        `[LYDIA-REFUND] refused on payment ${purchaseRecordId}: refund ${pending.id} is not settled ` +
          `(${viewStateOf(pending)})`
      );
      throw new ConflictException({
        code: LYDIA_REFUND_IN_FLIGHT,
        message: 'Another refund of this payment is not settled',
      });
    }
    const target = await this.targetOf(manager, record);
    const business = await this.businessOf(manager, associationId);
    const refusal = refusalOf(target, business);
    if (refusal || !target.ok) {
      this.logger.warn(
        `[LYDIA-REFUND] refused on payment ${purchaseRecordId}: not refundable (${refusal})`
      );
      throw new ConflictException({
        code: LYDIA_REFUND_NOT_REFUNDABLE,
        reason: refusal,
        message: 'This payment cannot be refunded from Canari',
      });
    }
    const { sum } = (await manager
      .createQueryBuilder(LydiaRefund, 'r')
      .select('COALESCE(SUM(r."amountCents"), 0)::int', 'sum')
      .where('r."purchaseRecordId" = :id', { id: purchaseRecordId })
      .andWhere(`r.status IN ('pending', 'confirmed')`)
      .getRawOne<{ sum: number }>()) ?? { sum: 0 };
    // A TOTAL refund is the whole payment, with nothing refunded before: it is what withdraws.
    const amountCents = input.kind === 'total' ? record.amountCents : (input.amountCents ?? 0);
    if ((input.kind === 'total' && sum > 0) || sum + amountCents > record.amountCents) {
      this.logger.warn(
        `[LYDIA-REFUND] refused on payment ${purchaseRecordId}: ${amountCents} cents over ` +
          `${sum} already refunded exceeds the ${record.amountCents} paid`
      );
      throw new ConflictException({
        code: LYDIA_REFUND_EXCEEDS_PAID,
        message: 'The refunds would exceed the amount paid',
        remainingCents: Math.max(0, record.amountCents - sum),
      });
    }
    const row = await manager.save(
      manager.create(LydiaRefund, {
        purchaseRecordId,
        associationId,
        vendorToken: target.vendorToken,
        orderRef: target.orderRef,
        kind: input.kind,
        amountCents,
        reason,
        idempotencyKey: input.idempotencyKey,
        status: 'pending',
        requestedByUserId: actorId,
      })
    );
    this.logger.log(
      `[LYDIA-REFUND] ${row.id}: ${input.kind} refund of ${amountCents} cents on payment ` +
        `${purchaseRecordId} asked by ${actorId.slice(0, 8)} - written pending before Lydia is asked`
    );
    return { row };
  }

  /**
   * THE RE-CHECK of a refund Lydia never confirmed: a manager who read Lydia's own statement declares
   * whether the money went back (`refunded: true` - confirmed, and a total one withdraws now) or not
   * (refused, and a new refund may be asked). Audited: who, when, and `declared-...` as the outcome.
   * Asked ONLY of a refund whose call is over without an answer (`no-answer`): one still being asked
   * is `LYDIA_REFUND_IN_FLIGHT`, since declaring it not refunded would let a second refund overtake
   * a first that may still succeed. A refund Lydia confirmed but Canari failed to record
   * (`refunded-unrecorded`) may only be recorded (`refunded: true`), keeping Lydia's own answer.
   */
  async resolve(
    associationId: string,
    refundId: string,
    actorId: string,
    refunded: unknown
  ): Promise<RefundView> {
    // A declaration is a boolean or nothing: a missing body or `"true"` read as "not refunded" would
    // free the payment for a second refund on a typo.
    if (typeof refunded !== 'boolean') {
      this.logger.warn(`[LYDIA-REFUND] ${refundId}: check refused, refunded is not a boolean`);
      throw new BadRequestException({
        code: LYDIA_REFUND_INVALID,
        message: 'A check needs refunded: true or false',
      });
    }
    // A process that died mid-call left its row with no outcome: proven abandoned, it is checkable.
    await this.sweepAbandoned();
    const row = await this.refundRepo.findOne({ where: { id: refundId, associationId } });
    if (!row) {
      this.logger.warn(
        `[LYDIA-REFUND] check refused: refund ${refundId} not found for ${associationId}`
      );
      throw new NotFoundException('Refund not found');
    }
    if (row.status !== 'pending') {
      this.logger.warn(`[LYDIA-REFUND] ${refundId}: settle refused, it is already ${row.status}`);
      throw new ConflictException({
        code: LYDIA_REFUND_NOT_PENDING,
        message: 'This refund is no longer unconfirmed',
      });
    }
    if (row.outcome === null) {
      this.logger.warn(`[LYDIA-REFUND] ${refundId}: settle refused, Lydia is still being asked`);
      throw new ConflictException({
        code: LYDIA_REFUND_IN_FLIGHT,
        message: 'Lydia is still being asked about this refund',
      });
    }
    if (row.outcome === REFUNDED_UNRECORDED && !refunded) {
      this.logger.warn(
        `[LYDIA-REFUND] ${refundId}: settle refused, Lydia confirmed it - it can only be recorded`
      );
      throw new ConflictException({
        code: LYDIA_REFUND_NOT_PENDING,
        message: 'Lydia confirmed this refund',
      });
    }
    this.logger.log(
      `[LYDIA-REFUND] ${refundId}: ${actorId.slice(0, 8)} declares refunded=${refunded} ` +
        `(was ${row.outcome})`
    );
    const settled = await this.settle(
      this.refundRepo.manager,
      refundId,
      refunded
        ? { status: 'confirmed', outcome: 'refunded' }
        : { status: 'refused', outcome: 'declared-not-refunded' },
      actorId
    );
    if (settled.status === 'pending') {
      throw new ConflictException({
        code: LYDIA_REFUND_NOT_PENDING,
        message: 'This refund is no longer unconfirmed',
      });
    }
    return toView(settled);
  }

  /**
   * Asks core to refund. Classified on core's STATUS and typed code, never a message: a 409 is a
   * refusal Lydia answered (nothing refunded); a 400, 403 or 503 `PAYMENT_SERVICE_NOT_READY` means
   * core sent nothing; anything else - a 504, a 5xx, no answer at all - may have refunded.
   */
  private async askLydia(row: LydiaRefund): Promise<CallOutcome> {
    let answer: unknown;
    try {
      const res = await axios.post(
        coreUrl('payments/refund'),
        { vendorToken: row.vendorToken, orderRef: row.orderRef, amountCents: row.amountCents },
        { ...internalCoreRequestConfig(), timeout: CORE_REFUND_TIMEOUT_MS }
      );
      answer = res?.data;
    } catch (err: unknown) {
      const response = (err as { response?: { status?: unknown; data?: unknown } }).response;
      const status = typeof response?.status === 'number' ? response.status : null;
      const code =
        response?.data && typeof response.data === 'object'
          ? (response.data as { code?: unknown }).code
          : undefined;
      if (status === 409) {
        const typed = typeof code === 'string' && code ? code : CORE_REFUND_CODES.rejected;
        this.logger.warn(`[LYDIA-REFUND] ${row.id}: refused (${typed}) - nothing refunded`);
        return { status: 'refused', outcome: typed };
      }
      if (
        status === 400 ||
        status === 403 ||
        (status === 503 && code === 'PAYMENT_SERVICE_NOT_READY')
      ) {
        this.logger.error(`[LYDIA-REFUND] ${row.id}: core sent nothing (HTTP ${status})`);
        return { status: 'refused', outcome: 'not-sent' };
      }
      this.logger.error(
        `[LYDIA-REFUND] ${row.id}: no usable answer (${status ?? 'no response'}) - Lydia MAY have ` +
          'refunded; kept pending until a manager checks Lydia'
      );
      return { status: 'pending', outcome: 'no-answer' };
    }
    // A 2xx is a refund ONLY when core says so: any other body is an answer nobody can read.
    if (!answer || typeof answer !== 'object' || (answer as { ok?: unknown }).ok !== true) {
      this.logger.error(
        `[LYDIA-REFUND] ${row.id}: core answered 2xx without ok=true - Lydia MAY have refunded; ` +
          'kept pending until a manager checks Lydia'
      );
      return { status: 'pending', outcome: 'no-answer' };
    }
    return { status: 'confirmed', outcome: 'refunded' };
  }

  /**
   * Writes the outcome of the call `refund` made (`settle`). When Lydia CONFIRMED and the write
   * fails, the money is gone and Canari does not say so: the row is marked `refunded-unrecorded` in a
   * transaction of its own (`markUnrecorded`), which blocks every new refund of the payment and shows
   * managers a refund to record. Any other failed write rethrows: the row keeps no outcome, and once
   * the call lock is released `sweepAbandoned` makes it a refund to check.
   */
  private async record(
    manager: EntityManager,
    row: LydiaRefund,
    outcome: CallOutcome
  ): Promise<LydiaRefund> {
    try {
      return await this.settle(manager, row.id, outcome, null);
    } catch (err: unknown) {
      if (outcome.status !== 'confirmed') {
        this.logger.error(
          `[LYDIA-REFUND] ${row.id}: recording the ${outcome.outcome} answer failed: ${errorText(err)}`
        );
        throw err;
      }
      this.logger.error(
        `[LYDIA-REFUND] ${row.id}: Lydia refunded, recording failed: ${errorText(err)} - marked ` +
          `${REFUNDED_UNRECORDED}, every new refund of payment ${row.purchaseRecordId} is blocked`
      );
      return this.markUnrecorded(manager, row);
    }
  }

  /** `record`'s mark of a refund Lydia confirmed that Canari failed to record. */
  private async markUnrecorded(manager: EntityManager, row: LydiaRefund): Promise<LydiaRefund> {
    const answeredAt = new Date();
    try {
      await manager.update(
        LydiaRefund,
        { id: row.id, status: 'pending' },
        { outcome: REFUNDED_UNRECORDED, answeredAt }
      );
    } catch (err: unknown) {
      this.logger.error(
        `[LYDIA-REFUND] ${row.id}: Lydia refunded and marking it unrecorded failed too: ` +
          `${errorText(err)} - it will read as a refund to check against Lydia`
      );
      throw err;
    }
    return { ...row, outcome: REFUNDED_UNRECORDED, answeredAt };
  }

  /**
   * Releases `refund`'s call lock: true when released, false when the query failed (the caller
   * then destroys the connection). A failure is logged, never thrown over the refund's answer.
   */
  private async unlockCall(runner: QueryRunner, refundId: string): Promise<boolean> {
    try {
      const [row] = (await runner.query(
        `SELECT pg_advisory_unlock(${REFUND_CALL_LOCK_KEY}) AS freed`,
        [refundId]
      )) as { freed: boolean }[];
      if (!row?.freed) {
        this.logger.error(`[LYDIA-REFUND] ${refundId}: the call lock was not held at release`);
      }
      return true;
    } catch (err: unknown) {
      this.logger.error(
        `[LYDIA-REFUND] ${refundId}: releasing the call lock failed: ${errorText(err)} - the ` +
          'connection is destroyed, not returned to the pool'
      );
      return false;
    }
  }

  /**
   * THE SWEEP OF ABANDONED CALLS. A `pending` row with no outcome is a call in flight - or one whose
   * process died, or lost its connection, before writing anything. Two facts together prove it over:
   * its call lock (`REFUND_CALL_LOCK_KEY`) is FREE - no live connection holds it, on this replica or
   * the other one a deploy runs beside it - AND its call started (`calledAt`, the database clock)
   * more than `REFUND_CALL_BOUND_MS` ago, or never started at all (no `calledAt`: nothing was sent).
   * The lock alone is not enough: a connection lost while its process lives frees it with the call
   * still running, and that call can no longer write its answer anyway (its connection is the one
   * that died) - past the bound it has ended. Each such row is marked `no-answer` - Lydia MAY have
   * refunded - so a manager can check it. Run at boot, and before the refunds are read or checked.
   */
  async sweepAbandoned(): Promise<number> {
    const manager = this.refundRepo.manager;
    const open = (await manager.query(
      `SELECT id FROM lydia_refunds WHERE status = 'pending' AND "outcome" IS NULL AND ${CALL_OVER_SQL}`,
      [REFUND_CALL_BOUND_MS]
    )) as { id: string }[];
    let swept = 0;
    for (const { id } of open) {
      try {
        const marked = await manager.transaction(async (tx) => {
          const [lock] = (await tx.query(
            `SELECT pg_try_advisory_xact_lock(${REFUND_CALL_LOCK_KEY}) AS free`,
            [id]
          )) as { free: boolean }[];
          if (!lock?.free) return false;
          const rows: unknown[] = await tx.query(
            `UPDATE lydia_refunds SET "outcome" = 'no-answer'
              WHERE id = $1 AND status = 'pending' AND "outcome" IS NULL AND ${CALL_OVER_SQL.replace('$1', '$2')}
              RETURNING id`,
            [id, REFUND_CALL_BOUND_MS]
          );
          return (Array.isArray(rows[0]) ? (rows[0] as unknown[]) : rows).length > 0;
        });
        if (marked) {
          swept++;
          this.logger.error(
            `[LYDIA-REFUND] ${id}: its call was abandoned (no process holds it) - marked no-answer, ` +
              'Lydia MAY have refunded; a manager checks Lydia'
          );
        }
      } catch (err: unknown) {
        this.logger.error(`[LYDIA-REFUND] ${id}: sweeping it failed: ${errorText(err)}`);
      }
    }
    if (open.length) {
      this.logger.debug(`[LYDIA-REFUND] sweep: ${swept} of ${open.length} open call(s) abandoned`);
    }
    return swept;
  }

  /**
   * How many refunds Lydia answered LATE in contradiction of how they were settled
   * (`CONTRADICTED_SQL`): read by the hourly report (`PaidNotGrantedScheduler`). Nothing closes
   * them: each stays counted, because a refund settled against Lydia's own answer stays wrong until
   * someone looks at Lydia's statement and acts outside Canari.
   */
  async countContradicted(): Promise<number> {
    const [row] = (await this.refundRepo.manager.query(
      `SELECT count(*)::int AS n FROM lydia_refunds WHERE ${CONTRADICTED_SQL}`
    )) as { n: number }[];
    return row?.n ?? 0;
  }

  /** The sweep at boot: a call this process was making when it died is abandoned now. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.sweepAbandoned();
    } catch (err: unknown) {
      this.logger.error(`[LYDIA-REFUND] the boot sweep failed: ${errorText(err)}`);
    }
  }

  /**
   * Writes a refund's outcome, ONCE: under the row's lock and only while it is `pending`. A confirmed
   * TOTAL refund withdraws in the same transaction (`withdraw`). The payer is told after the commit.
   * `resolvedBy` names the manager of a declaration; null for Lydia's own answer.
   */
  private async settle(
    on: EntityManager,
    refundId: string,
    outcome: CallOutcome,
    resolvedBy: string | null
  ): Promise<LydiaRefund> {
    const result = await on.transaction('READ COMMITTED', async (manager) => {
      const head = await manager.findOne(LydiaRefund, { where: { id: refundId } });
      if (!head) throw new NotFoundException('Refund not found');
      const record = await manager.findOne(PurchaseRecord, {
        where: { id: head.purchaseRecordId },
      });
      // The buyer's tier lock FIRST, as every tier path takes it, then the rows.
      if (outcome.status === 'confirmed' && head.kind === 'total' && record?.userId) {
        await lockBuyerTiers(manager, record.associationId, record.userId);
      }
      const row = await manager.findOne(LydiaRefund, {
        where: { id: refundId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row || row.status !== 'pending') {
        // A LATE ANSWER: Lydia's own word arriving after the row was settled (by a manager's
        // declaration, typically). Never dropped: logged, and kept on the row beside the first.
        if (row && !resolvedBy && outcome.status !== 'pending') {
          this.logger.error(
            `[LYDIA-REFUND] ${row.id}: Lydia answered ${outcome.outcome} AFTER the refund was ` +
              `settled as ${row.status} (${row.outcome}) - kept as its late outcome`
          );
          await manager.update(LydiaRefund, { id: row.id }, { lateOutcome: outcome.outcome });
          return { row: { ...row, lateOutcome: outcome.outcome }, changed: false };
        }
        return { row: row ?? head, changed: false };
      }
      if (outcome.status === 'pending') {
        await manager.update(LydiaRefund, { id: row.id }, { outcome: outcome.outcome });
        return { row: { ...row, outcome: outcome.outcome }, changed: false };
      }
      const now = new Date();
      const patch: Partial<LydiaRefund> = {
        status: outcome.status,
        // Recording a refund Lydia confirmed keeps Lydia's own answer, beside the manager's name.
        outcome: resolvedBy
          ? row.outcome === REFUNDED_UNRECORDED
            ? 'refunded'
            : outcome.status === 'confirmed'
              ? 'declared-refunded'
              : 'declared-not-refunded'
          : outcome.outcome,
        ...(resolvedBy ? { resolvedByUserId: resolvedBy, resolvedAt: now } : { answeredAt: now }),
      };
      if (outcome.status === 'confirmed' && row.kind === 'total') {
        patch.sideEffect = await this.withdraw(manager, row);
      }
      await manager.update(LydiaRefund, { id: row.id }, patch);
      this.logger.log(
        `[AUDIT] [LYDIA-REFUND] ${row.id}: ${row.kind} refund of ${row.amountCents} cents on ` +
          `payment ${row.purchaseRecordId} ${patch.status} (${patch.outcome})` +
          (patch.sideEffect ? `, ${patch.sideEffect}` : '') +
          (resolvedBy ? ` - declared by ${resolvedBy.slice(0, 8)}` : '')
      );
      return { row: { ...row, ...patch } as LydiaRefund, changed: true, payerId: record?.userId };
    });
    if (result.changed && result.row.status === 'confirmed') {
      const name = await this.associationName(on, result.row.associationId);
      await this.notifier.tell({ id: result.row.associationId, name }, result.payerId ?? null);
    }
    return result.row;
  }

  /**
   * WHAT A CONFIRMED TOTAL REFUND WITHDRAWS, inside `settle`'s transaction (the buyer's tier lock
   * already held). The record becomes `refunded` - it no longer counts as a purchase - except when
   * the product is gone and what it was cannot be told (`unidentified`: nothing is touched). A Cercle
   * top-up gives the money back only: its balance at the Cercle is NOT debited (the manager is told).
   * A membership's tier is revoked only when the tag is THIS payment's delivery; a form answer's seat
   * is freed (`refunded`, out of every seat count) and its tier revoked by the same rule.
   */
  private async withdraw(manager: EntityManager, refund: LydiaRefund): Promise<RefundSideEffect> {
    const record = await manager.findOne(PurchaseRecord, {
      where: { id: refund.purchaseRecordId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!record || !RECEIVED_PURCHASE_STATUSES.includes(record.status)) {
      this.logger.warn(`[LYDIA-REFUND] ${refund.id}: payment no longer held - nothing withdrawn`);
      return 'not-applied-already-withdrawn';
    }
    const target = await this.targetOf(manager, record);
    const withdrawal: RefundWithdrawal = target.ok ? target.withdrawal : 'unidentified';
    // The payment no longer counts as one, whatever it bought: it was refunded in full.
    await manager.update(PurchaseRecord, { id: record.id }, { status: 'refunded' });
    if (withdrawal === 'unidentified') {
      this.logger.error(
        `[LYDIA-REFUND] ${refund.id}: product of payment ${record.id} is gone - what it bought ` +
          'cannot be told (a Cercle top-up or not), so no tier or seat is touched; the payment is refunded'
      );
      return 'not-applied-unidentified';
    }
    if (withdrawal === 'topup') {
      this.logger.warn(
        `[LYDIA-REFUND] ${refund.id}: a Cercle top-up refunded - the balance at the Cercle is NOT debited`
      );
      return 'topup-balance-unchanged';
    }
    if (withdrawal === 'shop') return 'purchase-refunded';
    if (withdrawal === 'membership') {
      const revoked = await this.revokeDelivery(manager, record, {
        key: 'paymentIntentId',
        value: record.stripePaymentIntentId,
      });
      return revoked ? 'cotisation-revoked' : 'cotisation-not-held';
    }
    // A form answer: its seat, then its tier.
    const submissionId = target.ok ? target.submissionId : null;
    const formId = target.ok ? target.formId : null;
    if (submissionId && formId) {
      await lockFormSeats(manager, formId);
      await manager.query(
        `UPDATE submissions SET "paymentStatus" = 'refunded'
          WHERE id = $1 AND "paymentStatus" IN ('paid', 'paid_over_capacity')`,
        [submissionId]
      );
    }
    if (withdrawal === 'form') return 'seat-freed';
    const revoked = await this.revokeDelivery(manager, record, {
      key: 'submissionId',
      value: submissionId,
    });
    return revoked ? 'seat-freed-cotisation-revoked' : 'seat-freed-cotisation-not-held';
  }

  /**
   * Deletes the buyer's tag of `record.associationId` that is THIS payment's delivery - its metadata
   * names the payment (`paymentIntentId`, a boutique grant) or the answer (`submissionId`, a form's) -
   * and nothing else: a tier renewed by a later payment names that one, and stays.
   */
  private async revokeDelivery(
    manager: EntityManager,
    record: PurchaseRecord,
    by: { key: 'paymentIntentId' | 'submissionId'; value: string | null }
  ): Promise<boolean> {
    if (!record.userId || !by.value) return false;
    const rows: unknown[] = await manager.query(
      `DELETE FROM user_tags WHERE "userId" = $1 AND "issuingAssocId" = $2
         AND metadata ->> '${by.key}' = $3 RETURNING id`,
      [record.userId, record.associationId, by.value]
    );
    const deleted = Array.isArray(rows[0]) ? (rows[0] as unknown[]).length : rows.length;
    this.logger.log(
      `[LYDIA-REFUND] payment ${record.id}: ${deleted} tier tag(s) delivered by it revoked`
    );
    return deleted > 0;
  }

  /** `targetsOf` for one record. */
  private async targetOf(manager: EntityManager, record: PurchaseRecord): Promise<Target> {
    return (await this.targetsOf(manager, [record])).get(record.id) as Target;
  }

  /**
   * Which Lydia transaction each record was, and what a total refund withdraws - or why it cannot
   * be refunded. A boutique payment through its settled attempt (`product_checkouts`); a form payment
   * through its answer's order_ref (migration 120). Three reads whatever the number of records;
   * read-only, the caller holds any lock it needs.
   */
  private async targetsOf(
    manager: EntityManager,
    records: readonly PurchaseRecord[]
  ): Promise<Map<string, Target>> {
    const out = new Map<string, Target>();
    const productIds: string[] = [];
    const answerIds: string[] = [];
    for (const record of records) {
      if (record.paymentMethod !== 'online')
        out.set(record.id, { ok: false, reason: 'not-online' });
      else if (!RECEIVED_PURCHASE_STATUSES.includes(record.status)) {
        out.set(record.id, { ok: false, reason: 'not-received' });
      } else if (record.source === 'product') productIds.push(record.id);
      else if (record.submissionId) answerIds.push(record.submissionId);
      else out.set(record.id, { ok: false, reason: 'untraceable' });
    }
    const checkouts = productIds.length
      ? ((await manager.query(
          `SELECT c.id, c."productId", c."vendorToken", c."purchaseRecordId", p.type
             FROM product_checkouts c LEFT JOIN association_products p ON p.id = c."productId"
            WHERE c."purchaseRecordId" = ANY($1::uuid[]) AND c.status = 'paid'`,
          [productIds]
        )) as {
          id: string;
          productId: string;
          vendorToken: string;
          purchaseRecordId: string;
          type: string | null;
        }[])
      : [];
    const answers = answerIds.length
      ? ((await manager.query(
          `SELECT s.id, s."lydiaOrderRef", s."lydiaVendorToken", s."formId", f."grantsCotisation"
             FROM submissions s JOIN forms f ON f.id = s."formId" WHERE s.id = ANY($1::uuid[])`,
          [answerIds]
        )) as {
          id: string;
          lydiaOrderRef: string | null;
          lydiaVendorToken: string | null;
          formId: string;
          grantsCotisation: boolean;
        }[])
      : [];
    for (const record of records) {
      if (out.has(record.id)) continue;
      if (record.source === 'product') {
        const checkout = checkouts.find((c) => c.purchaseRecordId === record.id);
        if (!checkout?.vendorToken) {
          out.set(record.id, { ok: false, reason: 'untraceable' });
          continue;
        }
        // The ONE test the top-up dispatch itself uses (`ProductsService.dispatchTopUp`): the
        // product's type. A product deleted since is `unidentified` - never guessed to be or not be
        // a top-up.
        const withdrawal: RefundWithdrawal =
          checkout.type === null
            ? 'unidentified'
            : checkout.type === 'balance_topup'
              ? 'topup'
              : checkout.type === 'membership'
                ? 'membership'
                : 'shop';
        out.set(record.id, {
          ok: true,
          orderRef: productOrderRef(checkout.productId, checkout.id),
          vendorToken: checkout.vendorToken,
          withdrawal,
          submissionId: null,
          formId: null,
        });
        continue;
      }
      const answer = answers.find((a) => a.id === record.submissionId);
      if (!answer?.lydiaOrderRef || !answer.lydiaVendorToken) {
        out.set(record.id, { ok: false, reason: 'untraceable' });
        continue;
      }
      out.set(record.id, {
        ok: true,
        orderRef: answer.lydiaOrderRef,
        vendorToken: answer.lydiaVendorToken,
        withdrawal: answer.grantsCotisation ? 'form-membership' : 'form',
        submissionId: answer.id,
        formId: answer.formId,
      });
    }
    return out;
  }

  /** The Lydia Business the association holds now (its `vendor_token`), or null. */
  private async businessOf(manager: EntityManager, associationId: string): Promise<string | null> {
    const [row] = (await manager.query(`SELECT "lydiaAccountId" FROM associations WHERE id = $1`, [
      associationId,
    ])) as { lydiaAccountId: string | null }[];
    if (!row) throw new NotFoundException('Association not found');
    return row.lydiaAccountId?.trim() || null;
  }

  private async associationName(on: EntityManager, associationId: string): Promise<string> {
    const [row] = (await on.query(`SELECT name FROM associations WHERE id = $1`, [
      associationId,
    ])) as { name: string }[];
    return row?.name ?? '';
  }

  /**
   * The association's statement from Canari's own records - every payment listed and every refund
   * confirmed, oldest first, with the totals - as DATA. The client writes the spreadsheet file in its
   * own words (`statementCsv`, frontend `refundWording.ts`): this service has no language, and a
   * file built from words the request carried would echo request text back. Names no payer: an
   * accounting statement needs amounts and dates, not people.
   */
  async statement(associationId: string): Promise<AssociationStatement> {
    const manager = this.refundRepo.manager;
    const records = await manager.find(PurchaseRecord, {
      where: { associationId, status: In(LISTED_PURCHASE_STATUSES) },
      order: { paidAt: 'ASC' },
    });
    // A refund sits on the statement of the association whose PAYMENT it gives back, beside that
    // payment - never on the parent's that asked it for a delegate: the parent's statement lists none
    // of its delegates' payments, so the line would name nothing and the balance would go negative.
    const refunds = records.length
      ? await manager.find(LydiaRefund, {
          where: { purchaseRecordId: In(records.map((r) => r.id)), status: 'confirmed' },
          order: { requestedAt: 'ASC' },
        })
      : [];
    const byId = new Map(records.map((r) => [r.id, r]));
    const lines: StatementLine[] = [];
    let receivedCents = 0;
    let refundedCents = 0;
    for (const r of records) {
      receivedCents += r.amountCents;
      lines.push({
        date: isoDate(r.paidAt),
        operation: 'payment',
        item: r.productName,
        method: r.paymentMethod === 'cash' ? 'cash' : 'online',
        amountCents: r.amountCents,
        reason: null,
      });
    }
    for (const f of refunds) {
      refundedCents += f.amountCents;
      lines.push({
        date: isoDate(f.answeredAt ?? f.resolvedAt ?? f.requestedAt),
        operation: f.kind === 'total' ? 'refund-total' : 'refund-partial',
        item: (byId.get(f.purchaseRecordId) as PurchaseRecord).productName,
        method: 'online',
        amountCents: -f.amountCents,
        reason: f.reason,
      });
    }
    this.logger.log(
      `[LYDIA-REFUND] statement of ${associationId.slice(0, 8)}: ${records.length} payment(s), ` +
        `${refunds.length} refund(s)`
    );
    return { lines, receivedCents, refundedCents };
  }
}

/**
 * Why a payment may NOT be refunded by the association holding `business`, or null when it may: the
 * payment's own reason, else `other-business` when its Lydia Business is not the one held now.
 */
function refusalOf(target: Target, business: string | null): NotRefundableReason | null {
  if ('reason' in target) return target.reason;
  return target.vendorToken === business ? null : 'other-business';
}

/**
 * What `refund` answers for a settled call: the view when refunded (or confirmed by Lydia and not
 * recorded - the screen reads `state`), else the typed refusal carrying the view.
 */
function answerOf(settled: LydiaRefund): RefundView {
  if (settled.status === 'pending' && settled.outcome !== REFUNDED_UNRECORDED) {
    throw new GatewayTimeoutException({
      code: CORE_REFUND_CODES.unconfirmed,
      refund: toView(settled),
      message: 'Lydia did not confirm the refund; it is checked before any new one',
    });
  }
  if (settled.status === 'refused' && settled.outcome === 'not-sent') {
    throw new ServiceUnavailableException({
      code: 'PAYMENT_SERVICE_NOT_READY',
      refund: toView(settled),
      message: 'The refund could not be sent; nothing was refunded',
    });
  }
  if (settled.status === 'refused') {
    throw new ConflictException({
      code: settled.outcome,
      refund: toView(settled),
      message: 'Lydia refused the refund; nothing was refunded',
    });
  }
  return toView(settled);
}

/** An error's message for a log line; never its stack, never a request body. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toView(row: LydiaRefund): RefundView {
  return {
    id: row.id,
    purchaseRecordId: row.purchaseRecordId,
    kind: row.kind,
    amountCents: row.amountCents,
    reason: row.reason,
    state: viewStateOf(row),
    refusal: row.status === 'refused' ? row.outcome : null,
    lateAnswer: lateAnswerOf(row),
    sideEffect: row.sideEffect ?? null,
    requestedAt: new Date(row.requestedAt).toISOString(),
    answeredAt: row.answeredAt ? new Date(row.answeredAt).toISOString() : null,
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
  };
}

/**
 * Lydia's late answer when it contradicts how the refund was settled (`RefundView.lateAnswer`); the
 * SQL twin is `CONTRADICTED_SQL`, which the hourly report counts.
 */
export function lateAnswerOf(
  row: Pick<LydiaRefund, 'status' | 'lateOutcome'>
): 'refunded' | 'refused' | null {
  if (!row.lateOutcome) return null;
  const late = row.lateOutcome === 'refunded' ? 'refunded' : 'refused';
  return (late === 'refunded') === (row.status === 'confirmed') ? null : late;
}

/** A call whose start is past the bound `$1` (ms) on the database clock, or that never started. */
const CALL_OVER_SQL = `("calledAt" IS NULL OR "calledAt" < now() - make_interval(secs => $1::double precision / 1000))`;

/** The refunds whose late Lydia answer contradicts their settlement (`lateAnswerOf`, in SQL). */
export const CONTRADICTED_SQL = `"lateOutcome" IS NOT NULL
  AND (("lateOutcome" = 'refunded') <> (status = 'confirmed'))`;

/** Where a refund row stands, as a screen words it (`RefundViewState`). */
export function viewStateOf(row: Pick<LydiaRefund, 'status' | 'outcome'>): RefundViewState {
  if (row.status === 'confirmed') return 'refunded';
  if (row.status === 'refused') return 'refused';
  if (row.outcome === REFUNDED_UNRECORDED) return 'unrecorded';
  // No outcome yet: the call is in flight (or its process died and `sweepAbandoned` has not run).
  return row.outcome === null ? 'in-progress' : 'unconfirmed';
}

/** The payment's refund not settled yet (at most one, `lydia_refunds_one_pending`), or null. */
function openRefundOf(refunds: readonly LydiaRefund[]): RefundStanding['openRefund'] {
  const open = refunds.find((r) => r.status === 'pending');
  if (!open) return null;
  const state = viewStateOf(open);
  return {
    id: open.id,
    state: state === 'refunded' || state === 'refused' ? 'unconfirmed' : state,
  };
}

function isoDate(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}
