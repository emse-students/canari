import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ONE HOLDER'S AGENDA SUBSCRIPTION (migration 170, owner 2026-11-14 "Respecter les publics").
 *
 * The link a calendar app polls names this row (`<id>.<HMAC of the id>`, `agenda-subscription.ts`),
 * and the feed it opens is the signed-in agenda of `userId` narrowed to the selection below - so the
 * link never serves more than its holder sees today. Deleting the holder's rows revokes every link
 * they handed out; the account erasure deletes them too. The unique index (NULLs equal) is the
 * migration's: one row per holder and selection, so asking twice gives the same link.
 */
@Entity('agenda_subscriptions')
export class AgendaSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The holder's account id (an OIDC subject digest, never a uuid). */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** The selected campus (D6), or null for "any". */
  @Column({ type: 'varchar', length: 32, nullable: true })
  campus: string | null;

  /** The selected formation (D4), or null for "any". */
  @Column({ type: 'varchar', length: 16, nullable: true })
  formation: string | null;

  /** One association's agenda, or null. ON DELETE CASCADE in the migration. */
  @Column({ type: 'uuid', nullable: true })
  associationId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
