import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

export enum AssociationCalendarEventStatus {
  Pending = 'pending',
  Validated = 'validated',
  Rejected = 'rejected',
}

/**
 * Visual kind of a calendar entry.
 * - `event`: a normal event, shown as a card occupying an event slot.
 * - `break`: a no-course / vacation / holiday period, shown as a full-day background band behind
 *   events and NOT occupying an event slot. Purely graphical; other associations' events still run
 *   on those days.
 */
export enum AssociationCalendarEventKind {
  Event = 'event',
  Break = 'break',
}

/** Scheduled event displayed on an association public page (meetings, deadlines, etc.). */
@Entity('association_calendar_events')
export class AssociationCalendarEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  associationId: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endsAt: Date | null;

  @Column({ type: 'varchar', length: 255 })
  createdBy: string;

  /** Visual kind: normal `event` (card) or `break` (full-day background band). */
  @Column({ type: 'varchar', length: 16, default: AssociationCalendarEventKind.Event })
  kind: AssociationCalendarEventKind;

  @Column({
    type: 'varchar',
    length: 16,
    default: AssociationCalendarEventStatus.Validated,
  })
  @Index()
  status: AssociationCalendarEventStatus;

  @Column({ type: 'timestamptz', nullable: true })
  validatedAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  validatedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  rejectedAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  rejectedBy: string | null;

  /** Optional message from the BDE explaining the rejection. */
  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  /** Optional association form (e.g. signup) tied to this date. */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  linkedFormId: string | null;

  /** Public URL of the event poster/banner image (served via media-service). */
  @Column({ type: 'varchar', length: 500, nullable: true })
  imageUrl: string | null;

  /** Internal media-service ID for the poster image (used for cleanup on update). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  imageMediaId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
