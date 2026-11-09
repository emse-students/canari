import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * THE OLD STORE of "Me prévenir", copied into `opening_reminders` by the held migration 152
 * (engagement WP-4) and read and written by no code since: the erasure still deletes from it, and an
 * image older than WP-4 still writes it during a rolling deploy - 152's trigger mirrors that write.
 * Mapped until its held drop, so a `synchronize`d database (local) still has the table.
 */
@Entity('form_reminders')
@Index(['formId', 'userId'], { unique: true })
export class FormReminder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  formId: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  userId: string;

  @Column({ type: 'timestamptz' })
  opensAt: Date;

  @Column({ default: false })
  notified5min: boolean;

  @Column({ default: false })
  notifiedOnOpen: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
