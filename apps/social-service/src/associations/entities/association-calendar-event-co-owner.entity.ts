import { Entity, Column, PrimaryGeneratedColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { Association } from './association.entity';

/**
 * Join record linking an additional association to a calendar event as co-owner.
 * Co-owners have the same edit / validate / delete rights as the primary association.
 */
@Entity('association_calendar_event_co_owners')
export class AssociationCalendarEventCoOwner {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** FK to `association_calendar_events.id` — cascade-deleted when the event is removed. */
  @Column({ type: 'uuid', name: 'event_id' })
  @Index()
  eventId: string;

  @Column({ type: 'uuid', name: 'association_id' })
  @Index()
  associationId: string;

  /**
   * Eagerly loaded so `serializeCalendarEvent` always has the association name / color
   * without an extra query.
   */
  @ManyToOne(() => Association, { onDelete: 'CASCADE', eager: true })
  @JoinColumn({ name: 'association_id' })
  association: Association;
}
