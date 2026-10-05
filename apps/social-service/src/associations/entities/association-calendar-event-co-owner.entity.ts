import { Entity, Column, PrimaryGeneratedColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { Association } from './association.entity';

/**
 * An ACCEPTED co-organiser of a calendar event (D39, migration 074).
 *
 * A row exists only once the association's publishers accepted the `coorganise` proposal - the
 * pending and refused ones live in `proposals` and nowhere here - so everything that reads this
 * table reads consent: the co-organiser's rights on the event (edit, poster, delete, like the
 * organiser) and the event's reach (`eventVisibleToUserSql`, the union of the organiser's audience
 * and each co-organiser's). One row per (event, association); an event deletion removes its rows
 * through the trigger of migration 074.
 */
@Entity('association_calendar_event_co_owners')
@Index('UQ_calendar_event_co_owner', ['eventId', 'associationId'], { unique: true })
export class AssociationCalendarEventCoOwner {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The event. No foreign key: migration 074's trigger removes the rows of a deleted event. */
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
