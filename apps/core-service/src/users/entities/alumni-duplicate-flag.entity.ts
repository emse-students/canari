import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * An Alumni duplicate an admin was told about (migration 031): ONE row per MiConnect uuid, written
 * the first time a reading finds it matching an existing account. `AlumniDuplicateQueue` owns every
 * write, in raw SQL; this class exists so the table is built by `synchronize` outside production,
 * where social-service's count and bell gate read it. No name, no e-mail: the uuid names an account
 * MiConnect owns.
 */
@Entity('alumni_duplicate_flags')
export class AlumniDuplicateFlag {
  @PrimaryColumn('uuid')
  duplicateUuid!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  flaggedAt!: Date;

  /** A later reading found the duplicate gone or no longer matching; null while it waits. */
  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  /** "Pas un doublon": terminal, the account is never flagged again; null otherwise. */
  @Column({ type: 'timestamptz', nullable: true })
  dismissedAt!: Date | null;

  /** Set only after the admins were told; null while a notice is still owed. */
  @Column({ type: 'timestamptz', nullable: true })
  announcedAt!: Date | null;
}
