import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** Immutable audit record for a completed purchase (form submission or boutique product). */
@Entity('purchase_records')
export class PurchaseRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  userId: string;

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
  paymentMethod: 'stripe' | 'cash';

  @Column({ length: 30 })
  status: 'paid' | 'pending_cash' | 'cancelled' | 'expired';

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
