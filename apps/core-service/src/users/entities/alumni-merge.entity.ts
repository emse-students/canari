import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { AlumniHoldings } from '../alumni-merge.service';

/**
 * One Alumni merge an admin asked for (D48): the trace and the durable state of "Rattacher"
 * (migrations 028 and 029). `AlumniMergeService` owns every read and write, in raw SQL; this class
 * exists so the table is registered and built by `synchronize` outside production - the account
 * erasure deletes from it (`CORE_ERASURE_STATEMENTS`), and a stack without the SQL migrations would
 * otherwise fail every erasure on a missing table.
 *
 * Its state is read from the timestamps: requested, marked (`markedAt`), completed (`completedAt`:
 * MiConnect merged it at the duplicate's sign-in), cancelled (`cancelledAt`, with `completedAt` set
 * too: closed). One OPEN row (`completedAt` null) per duplicate. No foreign keys: `users.id` is the
 * OIDC subject.
 */
@Entity('alumni_merges')
@Index('UQ_alumni_merges_pending', ['duplicateUuid'], {
  unique: true,
  where: '"completedAt" IS NULL',
})
export class AlumniMerge {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The global admin who asked for it; `[deleted]` once that admin's account is erased. */
  @Column({ type: 'varchar', length: 255 })
  actorId!: string;

  @Column({ type: 'varchar', length: 36 })
  duplicateUuid!: string;

  @Column({ type: 'varchar', length: 150 })
  duplicateUsername!: string;

  /** The account the duplicate belongs with, by MiConnect uuid; its erasure deletes the row. */
  @Index('IDX_alumni_merges_target_uuid')
  @Column({ type: 'varchar', length: 36 })
  targetUuid!: string;

  /** The target's Canari account when it had one at the time; its erasure deletes the row. */
  @Index('IDX_alumni_merges_target')
  @Column({ type: 'varchar', length: 255, nullable: true })
  targetUserId!: string | null;

  /** What the duplicate's Canari account held when the admin confirmed. */
  @Column({ type: 'jsonb' })
  held!: AlumniHoldings;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  requestedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  markedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  cancelledBy!: string | null;
}
