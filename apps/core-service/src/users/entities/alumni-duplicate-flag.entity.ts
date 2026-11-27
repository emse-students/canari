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
}
