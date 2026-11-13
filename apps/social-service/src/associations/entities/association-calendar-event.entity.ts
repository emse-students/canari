import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';
import type { InstitutionReachPublic, InstitutionReachSpace } from '../../spaces/institution-reach';

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

/**
 * WHO A READER IS TOLD AN EVENT IS FROM (owner, 2026-11-08; docs/wiki/frontend/modules/calendar.md,
 * "Neutral campus events").
 * - `association`: the owning association's name, logo and page, as every event always had.
 * - `neutral`: the generic label "Campus" and nothing else. The OWNER is still the BDE that filed it
 *   - it keeps edit rights, validation, deletion, audience and notices - but no API field a reader
 *   outside the BDE's agenda managers receives names it (`event-presentation.ts`). Only a BDE may
 *   file one.
 */
export enum AssociationCalendarEventPresentation {
  Association = 'association',
  Neutral = 'neutral',
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

  /**
   * `neutral` hides the owning BDE from every reader who does not manage its agenda (migration 144).
   * The default is the old behaviour, so a release that never names the column writes what it did.
   */
  @Column({
    type: 'varchar',
    length: 16,
    default: AssociationCalendarEventPresentation.Association,
  })
  presentation: AssociationCalendarEventPresentation;

  /**
   * THE REACH AN INSTITUTION CHOSE FOR THIS EVENT (owner, 2026-11-13; migration 165), the posts'
   * column of migration 162 in the same shape: the public in the ticked spaces - 'all', 'students'
   * or 'staff'. NULL on every event that is not an institution's, and on an institution event filed
   * before the reach existed (read as its whole audience, everyone). Set with {@link reachSpaces},
   * never alone (a CHECK says so); read by `institutionReachAdmitsUserSql` in `eventVisibleToUserSql`.
   */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  reachPublic: InstitutionReachPublic | null;

  /**
   * The spaces an institution's event targets, inside the institution's audience (migration 165): a
   * jsonb array of `{formation, campus}` pairs, NULL exactly when {@link reachPublic} is.
   */
  @Column({ type: 'jsonb', nullable: true, default: null })
  reachSpaces: InstitutionReachSpace[] | null;

  /** Visual kind: normal `event` (card) or `break` (full-day background band). */
  @Column({ type: 'varchar', length: 16, default: AssociationCalendarEventKind.Event })
  kind: AssociationCalendarEventKind;

  /**
   * THE DEFAULT IS THE UNSAFE HALF OF THE RULE, SO IT IS `pending` - migration 060.
   *
   * `createCalendarEvent` names this column on every insert, so the default decides nothing today.
   * That is exactly why it mattered: a column whose default says `validated` publishes any future
   * insert that forgets to name it, silently and school-wide, and the rule is that no event is ever
   * validated without somebody deciding it (user, 2026-09-14). A default is what happens when
   * nobody said - and when nobody said, an event is waiting.
   */
  @Column({
    type: 'varchar',
    length: 16,
    default: AssociationCalendarEventStatus.Pending,
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
