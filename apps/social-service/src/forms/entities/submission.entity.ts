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

  /** Foreign key `submissions_form_fk` ON DELETE RESTRICT (migration 081): see `retireForms`. */
  @Column({ type: 'uuid' })
  @Index()
  formId: string;

  /** NULL on an anonymous form (`Form.anonymous`): the answer has no author by design. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index()
  userId: string | null;

  @Column({ nullable: true })
  email: string;

  @Column('jsonb', { default: {} })
  answers: Record<string, any>;

  @Column({ default: 0 })
  totalPaid: number;

  /**
   * Lifecycle status of the payment.
   * - `free` - no payment required
   * - `pending` - online checkout pending; holds a seat only for `PENDING_PAYMENT_HOLD_SECONDS`
   *   after `createdAt` (`seat-hold.ts`)
   * - `pending_cash` - awaiting physical cash validation by an admin
   * - `paid` - paid (online or cash validated)
   * - `paid_over_capacity` - an online payment that landed after its seat was released, on a full
   *   form: the money is in, no seat was given, the organiser refunds it
   * - `cancelled` - cancelled / abandoned
   * - `expired` - cash payment window elapsed without validation, or an online `pending` past the
   *   hold (`paymentMethod` tells the two apart: `cash` or null)
   *
   * A plain varchar with no CHECK constraint, so a new state needs no migration.
   */
  @Column({ default: 'free' })
  paymentStatus: string;

  /** `cash` once the submitter chose it; null otherwise (`stripe` on rows written before the processor left). */
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
