import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * How a purchase was paid. `online` is the current value for a card/Lydia payment; `stripe` is the
 * value of every row written before the processor left (docs/wiki/stripe-archive.md) - data at rest,
 * read as `online`, never written again.
 */
export type PurchasePaymentMethod = 'online' | 'stripe' | 'cash';

/**
 * Where a purchase stands. `paid_not_granted` is money taken for something NOT delivered: a
 * boutique cotisation tier the settlement did not grant (no longer a rise over the tier held, or
 * held under another issuer - docs/wiki/cotisations.md "Rising to a higher tier"), a product
 * deleted or a buyer account erased before the payment landed, or a paid form that grants a tier
 * and did not grant it (refused as not a rise, paid with no seat, or not held when recorded). A
 * form that grants no tier is recorded `paid` even when it was paid with no seat. A refund or a
 * manual grant is owed. It is money received, so the association's purchases list it beside
 * `paid`; it never counts as having bought the product. Stored in the existing varchar column,
 * which carries no CHECK. `refunded`: money received and then given back IN FULL through Canari (a
 * confirmed TOTAL refund in `lydia_refunds`, migration 120) - what it bought was withdrawn, so it no
 * longer counts as a purchase, and the association's purchases still list it.
 */
export type PurchaseStatus =
  | 'paid'
  | 'paid_not_granted'
  | 'pending_cash'
  | 'cancelled'
  | 'expired'
  | 'refunded';

/** The statuses of money actually received and kept. */
export const RECEIVED_PURCHASE_STATUSES: PurchaseStatus[] = ['paid', 'paid_not_granted'];

/** What the association's purchases list shows: money received, kept or refunded in full since. */
export const LISTED_PURCHASE_STATUSES: PurchaseStatus[] = [
  ...RECEIVED_PURCHASE_STATUSES,
  'refunded',
];

/**
 * The status of money received, from whether what it paid for was delivered: `paid`, or
 * `paid_not_granted` - the durable marker a refund or a manual grant is owed on. ONE decision for
 * every path that records a payment (a boutique settlement, a form's fulfilment).
 */
export function receivedStatus(delivered: boolean): 'paid' | 'paid_not_granted' {
  return delivered ? 'paid' : 'paid_not_granted';
}

/** Immutable audit record for a completed purchase (form submission or boutique product). */
@Entity('purchase_records')
export class PurchaseRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * The buyer's account, or NULL for a GUEST's payment on a public form (migration 103): a guest
   * has no account, and the row is still the association's accounting trace of the money.
   */
  @Column({ type: 'varchar', nullable: true })
  @Index()
  userId: string | null;

  /** Whether this purchase originated from a form or a boutique product. */
  @Column({ length: 30 })
  source: 'form' | 'product';

  @Column({ type: 'uuid', nullable: true })
  formId: string | null;

  @Column({ type: 'uuid', nullable: true })
  productId: string | null;

  /**
   * The form answer this record was written for (migration 120): how a form payment is traced to its
   * Lydia request, for a refund. NULL on boutique rows and on every row written before 120.
   */
  @Column({ type: 'uuid', nullable: true })
  submissionId: string | null;

  @Column({ type: 'int' })
  amountCents: number;

  @Column({ length: 30 })
  paymentMethod: PurchasePaymentMethod;

  @Column({ length: 30 })
  status: PurchaseStatus;

  @Column({ nullable: true })
  stripePaymentIntentId: string | null;

  @Column({ type: 'uuid' })
  associationId: string;

  /** Snapshot of the product or form title at time of purchase. */
  @Column({ length: 200 })
  productName: string;

  @CreateDateColumn()
  paidAt: Date;
}
