import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { EntityManager, In, Repository } from 'typeorm';
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
import type { StatementLabels } from './statement-labels';

/** The byte-order mark a spreadsheet needs to read the statement as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** How long social waits on core's refund route: over core's own 60 s bound on Lydia. */
export const CORE_REFUND_TIMEOUT_MS = 90_000;

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
  /** `refunded` (confirmed), `refused` (nothing refunded), `unconfirmed` (Lydia never answered). */
  state: 'refunded' | 'refused' | 'unconfirmed';
  /** The typed code of a refusal, so the screen words it; null otherwise. */
  refusal: string | null;
  sideEffect: string | null;
  requestedAt: string;
  answeredAt: string | null;
  resolvedAt: string | null;
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
  /** The id of the refund still unconfirmed, which blocks the next one; null when none. */
  unconfirmedRefundId: string | null;
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
 * and Lydia offers Canari NO read of a refund: `transaction/refunds` needs a registered Lydia user
 * (measured on homologation 2026-10-31: error 2223 "unknown user" for a phone, 105 for a cashier added
 * by Canari) and `request/state` says nothing of refunds. So a refund Lydia did not answer stays
 * `pending` (`LYDIA_REFUND_UNCONFIRMED`), and the RE-CHECK is a manager reading Lydia's own statement
 * (the Lydia Pro app) and declaring what they see (`resolve`): only then can a new refund be asked.
 *
 * A TOTAL refund withdraws what the payment bought (`withdraw`); a PARTIAL one withdraws nothing.
 */
@Injectable()
export class RefundsService {
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
        unconfirmedRefundId: mine.find((r) => r.status === 'pending')?.id ?? null,
      });
    }
    this.logger.debug(
      `[LYDIA-REFUND] association ${associationId.slice(0, 8)}: ${standings.length} payment(s), ` +
        `${standings.filter((s) => s.refundable).length} refundable, ${refunds.length} refund(s)`
    );
    return { standings, refunds: refunds.map(toView) };
  }

  /**
   * Refunds a payment, total or partial. In order: the input is checked; ONE transaction locks the
   * payment's record, finds this key's own row (a replay answers it and calls nothing), refuses while
   * another refund is unconfirmed, decides refundability and the sum cap, and writes the `pending`
   * row; core asks Lydia; the outcome is written (`settle`). Throws the typed refusals of
   * `refund-codes.ts`; an unknown outcome is the 504 `LYDIA_REFUND_UNCONFIRMED`, the row kept pending.
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
    const claim = await this.refundRepo.manager.transaction(async (manager) => {
      const record = await manager.findOne(PurchaseRecord, {
        where: { id: purchaseRecordId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!record) throw new NotFoundException('Payment not found');
      const own = await manager.findOne(LydiaRefund, {
        where: { purchaseRecordId, idempotencyKey: input.idempotencyKey },
      });
      if (own) return { replay: own };
      const pending = await manager.findOne(LydiaRefund, {
        where: { purchaseRecordId, status: 'pending' },
      });
      if (pending) {
        this.logger.warn(
          `[LYDIA-REFUND] refused on payment ${purchaseRecordId}: refund ${pending.id} is unconfirmed`
        );
        throw new ConflictException({
          code: LYDIA_REFUND_IN_FLIGHT,
          message: 'Another refund of this payment is still unconfirmed',
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
    });
    if ('replay' in claim) {
      this.logger.log(
        `[LYDIA-REFUND] ${claim.replay.id}: the same request again (${claim.replay.status}) - nothing sent`
      );
      return toView(claim.replay);
    }

    const outcome = await this.askLydia(claim.row);
    const settled = await this.settle(claim.row.id, outcome, null);
    if (settled.status === 'pending') {
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

  /**
   * THE RE-CHECK of a refund Lydia never confirmed: a manager who read Lydia's own statement declares
   * whether the money went back (`refunded: true` - confirmed, and a total one withdraws now) or not
   * (refused, and a new refund may be asked). Audited: who, when, and `declared-...` as the outcome.
   */
  async resolve(
    associationId: string,
    refundId: string,
    actorId: string,
    refunded: boolean
  ): Promise<RefundView> {
    const row = await this.refundRepo.findOne({ where: { id: refundId, associationId } });
    if (!row) throw new NotFoundException('Refund not found');
    if (row.status !== 'pending') {
      this.logger.warn(`[LYDIA-REFUND] ${refundId}: settle refused, it is already ${row.status}`);
      throw new ConflictException({
        code: LYDIA_REFUND_NOT_PENDING,
        message: 'This refund is no longer unconfirmed',
      });
    }
    const settled = await this.settle(
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
    try {
      await axios.post(
        coreUrl('payments/refund'),
        { vendorToken: row.vendorToken, orderRef: row.orderRef, amountCents: row.amountCents },
        { ...internalCoreRequestConfig(), timeout: CORE_REFUND_TIMEOUT_MS }
      );
      return { status: 'confirmed', outcome: 'refunded' };
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
  }

  /**
   * Writes a refund's outcome, ONCE: under the row's lock and only while it is `pending`. A confirmed
   * TOTAL refund withdraws in the same transaction (`withdraw`). The payer is told after the commit.
   * `resolvedBy` names the manager of a declaration; null for Lydia's own answer.
   */
  private async settle(
    refundId: string,
    outcome: CallOutcome,
    resolvedBy: string | null
  ): Promise<LydiaRefund> {
    const result = await this.refundRepo.manager.transaction('READ COMMITTED', async (manager) => {
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
      if (!row || row.status !== 'pending') return { row: row ?? head, changed: false };
      if (outcome.status === 'pending') {
        await manager.update(LydiaRefund, { id: row.id }, { outcome: outcome.outcome });
        return { row: { ...row, outcome: outcome.outcome }, changed: false };
      }
      const now = new Date();
      const patch: Partial<LydiaRefund> = {
        status: outcome.status,
        outcome: resolvedBy
          ? outcome.status === 'confirmed'
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
      const name = await this.associationName(result.row.associationId);
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
    if (withdrawal === 'unidentified') {
      this.logger.error(
        `[LYDIA-REFUND] ${refund.id}: product of payment ${record.id} is gone - what it bought ` +
          'cannot be told (a Cercle top-up or not), so NOTHING is withdrawn; the money went back'
      );
      return 'not-applied-unidentified';
    }
    await manager.update(PurchaseRecord, { id: record.id }, { status: 'refunded' });
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
          orderRef: `product:${checkout.productId}:${checkout.id}`,
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

  private async associationName(associationId: string): Promise<string> {
    const [row] = (await this.refundRepo.manager.query(
      `SELECT name FROM associations WHERE id = $1`,
      [associationId]
    )) as { name: string }[];
    return row?.name ?? '';
  }

  /**
   * The association's statement from Canari's own records - payments received and refunds
   * confirmed, with their totals - as CSV (`;`, UTF-8 with a BOM, for a spreadsheet). Every word is
   * the client's (`labels`, `statement-labels.ts`). Names no payer: an accounting statement needs
   * amounts and dates, not people. Text cells a spreadsheet would read as a formula are neutralised.
   */
  async statementCsv(associationId: string, labels: StatementLabels): Promise<string> {
    const manager = this.refundRepo.manager;
    const records = await manager.find(PurchaseRecord, {
      where: { associationId, status: In(LISTED_PURCHASE_STATUSES) },
      order: { paidAt: 'ASC' },
    });
    const refunds = await manager.find(LydiaRefund, {
      where: { associationId, status: 'confirmed' },
      order: { requestedAt: 'ASC' },
    });
    const byId = new Map(records.map((r) => [r.id, r]));
    const lines: string[][] = [
      [labels.date, labels.operation, labels.item, labels.method, labels.amount, labels.reason],
    ];
    let received = 0;
    let refunded = 0;
    for (const r of records) {
      received += r.amountCents;
      lines.push([
        isoDate(r.paidAt),
        labels.payment,
        r.productName,
        r.paymentMethod === 'cash' ? labels.cash : labels.online,
        euros(r.amountCents),
        '',
      ]);
    }
    for (const f of refunds) {
      refunded += f.amountCents;
      lines.push([
        isoDate(f.answeredAt ?? f.resolvedAt ?? f.requestedAt),
        f.kind === 'total' ? labels.refundTotal : labels.refundPartial,
        byId.get(f.purchaseRecordId)?.productName ?? '',
        labels.online,
        euros(-f.amountCents),
        f.reason,
      ]);
    }
    lines.push([]);
    lines.push(['', labels.totalReceived, '', '', euros(received), '']);
    lines.push(['', labels.totalRefunded, '', '', euros(-refunded), '']);
    lines.push(['', labels.balance, '', '', euros(received - refunded), '']);
    const csv = BOM + lines.map((cells) => cells.map(csvCell).join(';')).join('\r\n') + '\r\n';
    this.logger.log(
      `[LYDIA-REFUND] statement of ${associationId.slice(0, 8)}: ${records.length} payment(s), ` +
        `${refunds.length} refund(s)`
    );
    return csv;
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

function toView(row: LydiaRefund): RefundView {
  return {
    id: row.id,
    purchaseRecordId: row.purchaseRecordId,
    kind: row.kind,
    amountCents: row.amountCents,
    reason: row.reason,
    state:
      row.status === 'confirmed'
        ? 'refunded'
        : row.status === 'refused'
          ? 'refused'
          : 'unconfirmed',
    refusal: row.status === 'refused' ? row.outcome : null,
    sideEffect: row.sideEffect ?? null,
    requestedAt: new Date(row.requestedAt).toISOString(),
    answeredAt: row.answeredAt ? new Date(row.answeredAt).toISOString() : null,
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
  };
}

function isoDate(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

/** Cents as a French decimal (`12,50`, `-3,00`): what a spreadsheet in French reads as a number. */
function euros(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/**
 * One CSV cell: quoted when it carries `;`, a quote or a line break; a TEXT cell starting with a
 * character a spreadsheet reads as a formula (`= + - @`, tab, carriage return) is prefixed with `'`.
 * Amounts come from `euros` and are never neutralised (a refund is a negative number).
 */
export function csvCell(value: string): string {
  const numeric = /^-?\d+,\d{2}$/.test(value);
  const safe = !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
