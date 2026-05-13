import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

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

  /** Optional association-authored post shown alongside this agenda entry. */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  linkedPostId: string | null;

  /** Optional association form (e.g. signup) tied to this date. */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  linkedFormId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
