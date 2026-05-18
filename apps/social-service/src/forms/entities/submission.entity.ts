import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** TypeORM entity representing a user's submission to a form, including payment status. */
@Entity('submissions')
@Index(['formId', 'userId'])
export class Submission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  formId: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  userId: string;

  @Column({ nullable: true })
  email: string;

  @Column('jsonb', { default: {} })
  answers: Record<string, any>;

  @Column({ default: 0 })
  totalPaid: number;

  /**
   * Lifecycle status of the payment.
   * - `free` — no payment required
   * - `pending` — Stripe checkout pending
   * - `pending_cash` — awaiting physical cash validation by an admin
   * - `paid` — paid (Stripe or cash validated)
   * - `cancelled` — cancelled / abandoned
   * - `expired` — cash payment window elapsed without validation
   */
  @Column({ default: 'free' })
  paymentStatus: string;

  /** `stripe` or `cash` — set when the user chooses a payment method at submission time. */
  @Column({ nullable: true })
  paymentMethod: string | null;

  @Column({ nullable: true })
  stripeSessionId: string;

  /** When a cash payment expires if not validated (computed from form.cashPaymentExpiryDays). */
  @Column({ type: 'timestamptz', nullable: true })
  cashExpiresAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
