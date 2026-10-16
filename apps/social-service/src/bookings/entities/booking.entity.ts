import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Exclusion,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BookingResource } from './booking-resource.entity';

/** The name of the constraint that refuses a second live booking on the same resource and instant. */
export const BOOKINGS_NO_OVERLAP = 'bookings_live_no_overlap';

/**
 * Its definition, written ONCE: the entity declares it (so a development database built by
 * `synchronize` holds it) and `booking.entity.spec.ts` requires migration 087 to carry the same text.
 * Half-open ranges, `=` on the resource through `btree_gist`, live rows only.
 */
export const BOOKINGS_NO_OVERLAP_EXPRESSION = `USING gist ("resourceId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&) WHERE ("cancelledAt" IS NULL)`;

/**
 * One occurrence booked on one resource (D28, migration 087).
 *
 * LIVE means `cancelledAt` IS NULL, and PostgreSQL holds one live booking per resource and instant
 * (D12, D33): a concurrent second insert fails with SQLSTATE 23P01 (`isExclusionViolation`), never
 * on a client check. A cancellation keeps the row, and who cancelled, as history (D15), and frees
 * the range. Names are snapshots taken at booking time, so a deleted account leaves its name.
 */
@Entity('bookings')
@Exclusion(BOOKINGS_NO_OVERLAP, BOOKINGS_NO_OVERLAP_EXPRESSION)
@Index('bookings_holder_idx', ['holderId', 'startsAt'])
@Check('bookings_order', `"startsAt" < "endsAt"`)
@Check('bookings_cancellation_pair', `("cancelledAt" IS NULL) = ("cancelledById" IS NULL)`)
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  resourceId: string;

  /** Foreign key `bookings_resource_fk`: a deleted resource or space takes its bookings (D27). */
  @ManyToOne(() => BookingResource, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'resourceId', foreignKeyConstraintName: 'bookings_resource_fk' })
  resource?: BookingResource;

  @Column({ type: 'varchar', length: 255 })
  holderId: string;

  @Column({ type: 'varchar', length: 255 })
  holderName: string;

  /** The holder, or the organiser who booked on their behalf (D20). */
  @Column({ type: 'varchar', length: 255 })
  bookedById: string;

  /** Start of the half-open UTC range `[startsAt, endsAt)` (D25). */
  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz' })
  endsAt: Date;

  /** The forms-shaped answers (D7); NULL once purged (D18). */
  @Column('jsonb', { nullable: true })
  answers: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  answersPurgedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  cancelledById: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
