import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Whether a refund gives back the whole payment (and withdraws what it bought) or part of it. */
export type RefundKind = 'total' | 'partial';

/**
 * Where a refund stands. `pending`: written BEFORE Lydia was asked, and still so while Lydia's answer
 * is unknown - it blocks every other refund of that payment until a manager settles it. `confirmed`:
 * Lydia answered that it refunded (or a manager declared so after checking Lydia). `refused`: Lydia
 * answered a refusal, nothing was sent, or a manager declared that it did not go through.
 */
export type RefundStatus = 'pending' | 'confirmed' | 'refused';

/**
 * One refund asked through Canari (migration 120) - the durable state that makes a refund
 * idempotent, and its audit. See `RefundsService` and docs/wiki/frontend/modules/payments.md.
 */
@Entity('lydia_refunds')
@Index('lydia_refunds_one_per_key', ['purchaseRecordId', 'idempotencyKey'], { unique: true })
@Index('lydia_refunds_one_pending', ['purchaseRecordId'], {
  unique: true,
  where: `status = 'pending'`,
})
export class LydiaRefund {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The payment refunded: a `purchase_records` row (never deleted). */
  @Column({ type: 'uuid' })
  purchaseRecordId: string;

  /** The association whose Business took the payment and whose manager asked for the refund. */
  @Index('lydia_refunds_association')
  @Column({ type: 'uuid' })
  associationId: string;

  /** The Lydia Business the refund was sent to (a snapshot). Never answered to a browser. */
  @Column({ type: 'varchar', length: 256 })
  vendorToken: string;

  /** The order_ref of the refunded transaction (a snapshot). Never answered to a browser. */
  @Column({ type: 'varchar', length: 128 })
  orderRef: string;

  @Column({ type: 'varchar', length: 8 })
  kind: RefundKind;

  @Column({ type: 'int' })
  amountCents: number;

  /** The manager's own words: why the payment is refunded. */
  @Column({ type: 'varchar', length: 500 })
  reason: string;

  /** Chosen by the client once per dialog: a resent click is the same refund, never a second one. */
  @Column({ type: 'uuid' })
  idempotencyKey: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: RefundStatus;

  /**
   * What Lydia answered, for the audit: `refunded`, a typed refusal code, `no-answer` (Lydia may have
   * refunded), `not-sent`, or `declared-refunded` / `declared-not-refunded` when a manager settled an
   * unconfirmed one, or `refunded-unrecorded` when Lydia confirmed and Canari failed to record it (the
   * row stays `pending`, blocking every new refund, until a manager records it). NULL while the call
   * is running.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  outcome: string | null;

  /**
   * Lydia's own answer when it arrived AFTER the refund was settled (by a manager's declaration,
   * typically): `refunded` or a refusal code. Null otherwise. Kept beside `outcome`, never over it, so
   * a declaration Lydia contradicts is visible.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  lateOutcome: string | null;

  /**
   * When the call to Lydia started, on the database clock (written just before core is asked): what
   * the sweep's termination bound counts from (`REFUND_CALL_BOUND_MS`). Null when nothing was sent.
   */
  @Column({ type: 'timestamptz', nullable: true })
  calledAt: Date | null;

  /** What a confirmed TOTAL refund withdrew (`RefundSideEffect`); null otherwise. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  sideEffect: string | null;

  @Column({ type: 'varchar', length: 255 })
  requestedByUserId: string;

  /** The database's clock (`DEFAULT now()`), never a client's. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  requestedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  answeredAt: Date | null;

  /** The manager who settled a refund Lydia never confirmed, after checking Lydia. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  resolvedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;
}
