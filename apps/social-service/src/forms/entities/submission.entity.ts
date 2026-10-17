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

  /** The CURRENT payment request's session id (Lydia's `request_uuid`, which `request/state` reads). */
  @Column({ type: 'varchar', nullable: true })
  stripeSessionId: string | null;

  /**
   * The CURRENT payment request's provider id (Lydia's NUMERIC `request_id`, migration 084): the one
   * its callbacks and its cancel call carry. A cancel callback naming another id is about a request
   * this row no longer uses, and is ignored. Null until the provider answered, or on older rows.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  paymentRequestId: string | null;

  /**
   * The id the confirmation that SETTLED this row carried (migration 084): the callback's numeric
   * `request_id`, or the uuid when the payer's return confirmed it (`confirmPayment`). `markPaid` writes it once, on the transition, so a
   * later confirmation naming another request can be accused with the evidence beside it.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  paymentSettledBy: string | null;

  /** When a cash payment expires if not validated (computed from form.cashPaymentExpiryDays). */
  @Column({ type: 'timestamptz', nullable: true })
  cashExpiresAt: Date | null;

  /**
   * When the CURRENT payment request was issued (migration 084): the seat hold of an online
   * `pending` row is counted from it (`seat-hold.ts`). Equal to `createdAt` until `submit` reuses
   * the row for a new request, which sets it to the database's `now()` again.
   */
  @Column({ type: 'timestamp', default: () => 'now()' })
  paymentRequestedAt: Date;

  /**
   * Set once the cotisation this payment buys was granted, or found not to be configured
   * (migration 084). A replayed payment grants again only while it is NULL.
   */
  @Column({ type: 'timestamptz', nullable: true })
  cotisationGrantedAt: Date | null;

  /** Set once this payment's purchase record was written (migration 084), same rule. */
  @Column({ type: 'timestamptz', nullable: true })
  purchaseRecordedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
