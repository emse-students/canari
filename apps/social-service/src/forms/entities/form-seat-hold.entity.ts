import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A signed-in person's hold on one seat of a capped form ("Reserver ma place", migration 186).
 *
 * One row per account and form. It counts as a taken seat, for everyone BUT its holder, while it is
 * younger than `SEAT_HOLD_SECONDS` (`seat-hold.ts`); the submit deletes it in the transaction that
 * stores the answer. Never written for a guest (no account to hold for) or on an anonymous form.
 */
@Entity('form_seat_holds')
export class FormSeatHold {
  @PrimaryColumn({ type: 'uuid' })
  formId: string;

  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  /** When the hold was taken or last restarted, on the database clock. */
  @Column({ type: 'timestamptz', default: () => 'clock_timestamp()' })
  heldAt: Date;
}
