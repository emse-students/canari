import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Association } from './association.entity';

/**
 * THE ONE SPELLING OF A SUBSCRIPTION'S SELECTION as a key: `campus|formation|associationId`, `-` for
 * a side left out. The unique key is (`userId`, this), so uniqueness needs no NULL semantics and holds
 * the same on a schema TypeORM `synchronize` built and on one migration 173 built. Written by
 * `AssociationsService.subscribeAgenda`, and by nothing else.
 */
export function agendaSelectionKey(sel: {
  campus: string | null;
  formation: string | null;
  associationId: string | null;
}): string {
  return `${sel.campus ?? '-'}|${sel.formation ?? '-'}|${sel.associationId ?? '-'}`;
}

/**
 * ONE HOLDER'S AGENDA SUBSCRIPTION (migration 173, owner 2026-11-14 "Respecter les publics").
 *
 * The link a calendar app polls names this row (`<id>.<HMAC of the id>`, `agenda-signature.ts`), and
 * the feed it opens is the signed-in agenda of `userId` narrowed to the selection below - so the link
 * never serves more than its holder sees today. Deleting the holder's rows revokes every link they
 * handed out; the account erasure deletes them too; deleting the association deletes its rows.
 * Every constraint below is the migration's, declared here too so a `synchronize`d schema has it.
 */
@Entity('agenda_subscriptions')
@Unique('UQ_agenda_subscriptions_selection', ['userId', 'selectionKey'])
@Index('IDX_agenda_subscriptions_association', ['associationId'])
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

  /** One association's agenda, or null. */
  @Column({ type: 'uuid', nullable: true })
  associationId: string | null;

  @ManyToOne(() => Association, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({
    name: 'associationId',
    foreignKeyConstraintName: 'FK_agenda_subscriptions_association',
  })
  association?: Association | null;

  /** {@link agendaSelectionKey} of the three columns above: the second half of the unique key. */
  @Column({ type: 'varchar', length: 96 })
  selectionKey: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
