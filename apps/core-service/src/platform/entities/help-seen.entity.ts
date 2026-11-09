import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * That one account has seen one first-time help (a guided tour or a hint). Nothing else.
 *
 * Keyed by (account, help) and not by device, so a tour finished on the phone is not shown again on
 * the laptop - the owner's decision of 2026-11-02, and the reason this is a table rather than local
 * state, which a reinstall wipes. `help_id` is one of `HELP_IDS` (refused otherwise at the route), so
 * an account holds at most one row per help the client can declare.
 *
 * **This row answers exactly one question**, as `platform_announcement_seen` does: it is never read
 * as "the account is new" or "the account is active".
 */
@Entity('help_seen')
export class HelpSeen {
  /** The account, as `users.id` spells it (a `varchar(255)`, not always a UUID). */
  @PrimaryColumn({ name: 'user_id', type: 'varchar', length: 255 })
  userId!: string;

  @PrimaryColumn({ name: 'help_id', type: 'varchar', length: 64 })
  helpId!: string;

  @CreateDateColumn({ name: 'seen_at', type: 'timestamptz' })
  seenAt!: Date;
}
