import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * How a purchase was paid. `online` is the current value for a card/Lydia payment; `stripe` is the
 * value of every row written before the processor left (docs/wiki/stripe-archive.md) - data at rest,
 * read as `online`, never written again.
 */
export type PurchasePaymentMethod = 'online' | 'stripe' | 'cash';

/**
 * Where a purchase stands. `paid_not_granted` is money taken for a cotisation tier that was NOT
 * granted, because at settlement it was no longer a rise over the tier the buyer held
 * (docs/wiki/cotisations.md "Rising to a higher tier"): a refund or a manual grant is owed. It is
 * money received, so the association's purchases list it beside `paid`; it never counts as having
 * bought the product. Stored in the existing varchar column, which carries no CHECK.
 */
export type PurchaseStatus = 'paid' | 'paid_not_granted' | 'pending_cash' | 'cancelled' | 'expired';

/** The statuses of money actually received: what the association's purchases list. */
export const RECEIVED_PURCHASE_STATUSES: PurchaseStatus[] = ['paid', 'paid_not_granted'];

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
