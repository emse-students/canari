import type { ProductGridLine } from '../product-grid-contract';
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
@Index('submissions_guest_visitor_idx', ['formId', 'guestVisitorKey'], {
  where: '"guestVisitorKey" IS NOT NULL',
})
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
   * The priced lines of the answer's product grids AS CHARGED (migration 137): per ordered cell, the
   * row and column labels, the category, the unit price and the quantity - so an export says what
   * was charged even after the creator renames a row or moves a price. Written by `submit` (and
   * rewritten with the answer on a retry that reuses the row); null on an answer with no grid.
   */
  @Column({ type: 'jsonb', nullable: true })
  lines: ProductGridLine[] | null;

  /**
   * Lifecycle status of the payment.
   * - `free` - no payment required
   * - `pending` - online checkout pending; holds a seat only for `PENDING_PAYMENT_HOLD_SECONDS`
   *   after `createdAt` (`seat-hold.ts`)
   * - `pending_cash` - awaiting physical cash validation by an admin
   * - `paid` - paid (online or cash validated)
   * - `paid_over_capacity` - an online payment that landed after its seat was released, on a full
   *   form: the money is in, no seat was given, the organiser refunds it
   * - `refunded` - paid, then refunded IN FULL through Canari (migration 120): the seat is free
   *   again and a late confirmation of that payment is a replay (`SETTLED_PAYMENT_STATUSES`)
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

  /**
   * The order_ref of the CURRENT Lydia request (migration 120), written when it is issued: what a
   * refund of this answer's payment is sent with. NULL before 120 - such a payment cannot be refunded
   * from Canari. `select: false`: no read of a submission carries it unless it asks by name.
   */
  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  lydiaOrderRef: string | null;

  /** The Lydia Business the CURRENT request was issued to (migration 120), same rules. */
  @Column({ type: 'varchar', length: 256, nullable: true, select: false })
  lydiaVendorToken: string | null;

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

  /**
   * Set once the form's managers were told this payment landed `paid_over_capacity` (migration
   * 102), same rule: claimed before the notification is written, released if writing it failed.
   */
  @Column({ type: 'timestamptz', nullable: true })
  organiserNotifiedAt: Date | null;

  /**
   * The SHA-256 of a paying guest's receipt (migration 104, `guest-receipt.ts`): the proof the guest
   * return page shows instead of a session. Null on every other row. `select: false`, so no read of
   * a submission carries it unless it asks for it by name - and nothing does: it is only matched.
   */
  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  @Index('submissions_guest_receipt_hash_uniq', {
    unique: true,
    where: '"guestReceiptHash" IS NOT NULL',
  })
  guestReceiptHash: string | null;

  /**
   * Who is WAITING on a guest's paid answer (migration 105, `guest-visitor.ts`): a keyed hash of the
   * form and the visitor's address, counted against the per-visitor ceiling. Set only while the
   * answer is `pending` or `pending_cash`, and cleared by `forgetSettledGuestVisitors` once it is not.
   * `select: false`: no read of a submission carries it.
   */
  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  guestVisitorKey: string | null;

  /**
   * What a guest typed when the PUBLIC form asked for it (migration 138, `guest-identity.ts`): a
   * last name, a first name, an e-mail - each null unless the form asked it. Never a member's: a
   * member is never asked. When the form asks for the e-mail it is also the address Lydia's request
   * went to; when it does not, that address is not stored (PP2).
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  guestLastName: string | null;

  /** See `guestLastName`. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  guestFirstName: string | null;

  /** See `guestLastName`. */
  @Column({ type: 'varchar', length: 254, nullable: true })
  guestEmail: string | null;

  /**
   * When the respondent last changed this answer (migration 166, `FormsService.editAnswer`); NULL
   * for an answer never changed. Not `updatedAt`, which every payment status move rewrites: the
   * managers read this one as "modifiee le".
   */
  @Column({ type: 'timestamptz', nullable: true })
  editedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
