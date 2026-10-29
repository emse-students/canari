import type { AudienceCondition } from '../../pricing/audience';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Association } from '../../associations/entities/association.entity';

/** How a space cuts time: windows cut into steps, or an explicit list of slots (D3). */
export type BookingSlotMode = 'step' | 'slots';

/** Whether other bookers see who booked, or only that a slot is taken (D9). */
export type BookingNameVisibility = 'names' | 'occupied';

/** Listed on the Reservations page for its audience, or reached by link only (D31). */
export type BookingDiscoverability = 'listed' | 'link';

/**
 * A space's poster as the client uploaded it (`MediaService.encryptAndUpload`): the media id, the
 * per-file key and IV in hex, the type and the display size. The server never decrypts it.
 */
export interface SpacePoster {
  type: 'image';
  mediaId: string;
  key: string;
  iv: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}

/** The period of the per-person duration ceiling (D17). */
export type BookingQuotaPeriod = 'day' | 'week';

/**
 * A bookable space - the music room, the alumni interviews (migration 087, WP-B1 of
 * docs/wiki/bookings-chantier.md).
 *
 * It owns its resources and, through them, every rule, block and booking: deleting a space deletes
 * all of it, history included (D27). Its owner is a person (`associationId` NULL) or an association,
 * list or institution (D2). Every setting the decisions name is a column here so the organiser
 * screens (WP-B4) add no schema; nothing reads this table before WP-B2.
 */
@Entity('booking_spaces')
@Check('booking_spaces_slot_mode', `"slotMode" IN ('step', 'slots')`)
@Check(
  'booking_spaces_step_shape',
  `("slotMode" = 'step' AND COALESCE("stepMinutes", 0) > 0 AND COALESCE("maxSteps", 0) >= 1) OR ("slotMode" = 'slots' AND "stepMinutes" IS NULL AND "maxSteps" IS NULL)`
)
@Check(
  'booking_spaces_slot_minutes',
  `"slotMinutes" IS NULL OR ("slotMode" = 'slots' AND "slotMinutes" BETWEEN 15 AND 120)`
)
@Check('booking_spaces_name_visibility', `"nameVisibility" IN ('names', 'occupied')`)
@Check('booking_spaces_discoverability', `discoverability IN ('listed', 'link')`)
@Check(
  'booking_spaces_window',
  `("minNoticeMinutes" IS NULL OR "minNoticeMinutes" >= 0) AND ("horizonDays" IS NULL OR "horizonDays" >= 1)`
)
@Check(
  'booking_spaces_quotas',
  `("maxActiveBookings" IS NULL OR "maxActiveBookings" >= 1) AND (("maxMinutesPerPeriod" IS NULL) = ("quotaPeriod" IS NULL)) AND ("maxMinutesPerPeriod" IS NULL OR "maxMinutesPerPeriod" >= 1) AND ("quotaPeriod" IS NULL OR "quotaPeriod" IN ('day', 'week'))`
)
@Check('booking_spaces_participant_withdraw_min', `"participantWithdrawMinMinutes" >= 0`)
@Check('booking_spaces_max_people', `"maxPeople" IS NULL OR "maxPeople" >= 1`)
@Check('booking_spaces_retention_days', `"retentionDays" BETWEEN 1 AND 30`)
@Check(
  'booking_spaces_reminder_range',
  `"reminderMinutes" IS NULL OR "reminderMinutes" BETWEEN 5 AND 10080`
)
export class BookingSpace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The account that created the space; for a personal space, its owner. */
  @Column({ type: 'varchar', length: 255 })
  @Index('booking_spaces_owner_idx')
  ownerId: string;

  /** The owning association, list or institution; NULL for a personal space. */
  @Column({ type: 'uuid', nullable: true })
  @Index('booking_spaces_association_idx')
  associationId: string | null;

  /** Foreign key `booking_spaces_association_fk`: a deleted association takes its spaces along. */
  @ManyToOne(() => Association, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'associationId', foreignKeyConstraintName: 'booking_spaces_association_fk' })
  association?: Association | null;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** The ONE zone of the space: rules are local wall times in it, bookings UTC instants (D25). */
  @Column({ type: 'varchar', length: 64, default: 'Europe/Paris' })
  timeZone: string;

  /** 'step': a rule is a window cut into steps; 'slots': each rule IS one slot (D3). */
  @Column({ type: 'varchar', length: 8, default: 'step' })
  slotMode: BookingSlotMode;

  @Column({ type: 'int', nullable: true })
  stepMinutes: number | null;

  /** At most this many consecutive steps in one booking. */
  @Column({ type: 'int', nullable: true })
  maxSteps: number | null;

  /**
   * How long one fixed slot of a 'slots' space lasts (migration 116): the length the painter opens
   * new slots with. NULL on every 'step' space, and on a 'slots' space created before 116 - that one
   * keeps inferring its length from its lines.
   */
  @Column({ type: 'int', nullable: true })
  slotMinutes: number | null;

  @Column({ type: 'varchar', length: 8, default: 'occupied' })
  nameVisibility: BookingNameVisibility;

  @Column({ type: 'varchar', length: 8, default: 'listed' })
  discoverability: BookingDiscoverability;

  /** The forms' audience predicate; NULL means every signed-in account (D6). */
  @Column('jsonb', { nullable: true })
  audience: AudienceCondition | null;

  /** The forms' question items asked at booking time (D7). */
  @Column('jsonb', { default: [] })
  items: unknown[];

  /** Returned only to a booking's people, while the booking is live (D32). */
  @Column({ type: 'text', nullable: true })
  privateInfo: string | null;

  /** Booking window (D26): no booking before this instant. */
  @Column({ type: 'timestamptz', nullable: true })
  opensAt: Date | null;

  @Column({ type: 'int', nullable: true })
  minNoticeMinutes: number | null;

  @Column({ type: 'int', nullable: true })
  horizonDays: number | null;

  /** Per-person ceiling of simultaneous coming bookings (D17). */
  @Column({ type: 'int', nullable: true })
  maxActiveBookings: number | null;

  /** Per-person ceiling of booked minutes per `quotaPeriod` (D17); both set or both NULL. */
  @Column({ type: 'int', nullable: true })
  maxMinutesPerPeriod: number | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  quotaPeriod: BookingQuotaPeriod | null;

  /**
   * A PARTICIPANT may withdraw until this many minutes before the start; 0 = until the start (D5,
   * decided by the user 2026-10-17, migration 088). The holder and the organiser are never delayed.
   */
  @Column({ type: 'int', default: 0 })
  participantWithdrawMinMinutes: number;

  /** People in one booking, the holder included; NULL = no ceiling (D4, D33). */
  @Column({ type: 'int', nullable: true })
  maxPeople: number | null;

  /** Answers and files are purged this many days after the slot's end, 1 to 30 (D23). */
  @Column({ type: 'int', default: 7 })
  retentionDays: number;

  /**
   * The DEFAULT reminder delay before a slot, in minutes, copied onto each person of a new booking
   * (WP-N, D53, Q-R1, migration 115); each person may change their own. NULL = no reminder.
   */
  @Column({ type: 'int', nullable: true, default: 60 })
  reminderMinutes: number | null;

  /**
   * The poster (D35, migration 092): a media reference ENCRYPTED BY THE CLIENT, its key in this
   * row, as a post's image - the media service holds ciphertext only. NULL: none.
   */
  @Column('jsonb', { nullable: true })
  poster: SpacePoster | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
