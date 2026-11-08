import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * The durable record that a member's birthday of one Paris calendar date was announced to their
 * followers (migration 148). The notifier claims it with `INSERT ... ON CONFLICT DO NOTHING` in the
 * transaction that writes the notifications, so the claim and the rows commit together or not at
 * all, and a re-run, a second replica or a restart within the day announces nothing twice.
 */
@Entity('birthday_notices')
export class BirthdayNotice {
  /** The member whose birthday it is. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  /** The Paris calendar date it was celebrated on (28 February for a 29th in a common year). */
  @PrimaryColumn({ type: 'date' })
  celebratedOn: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
