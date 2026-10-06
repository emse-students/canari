import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';
import type { ProfileSnapshot } from '../miconnect-profile';

/**
 * One applied edit of a person's MiConnect profile: who changed what, and when (D9).
 *
 * Written in the same transaction as the `users` row it describes, AFTER authentik accepted the
 * edit - so a row here means both sources were written. No foreign key: `users.id` is the OIDC
 * subject, and deleting an account must neither be blocked by nor erase what an admin did to it.
 * See migration `009_profile_changes.sql`.
 */
@Entity('profile_changes')
export class ProfileChange {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The person whose profile changed. */
  @Column({ type: 'varchar', length: 255 })
  @Index()
  userId!: string;

  /** The global admin who made the change. */
  @Column({ type: 'varchar', length: 255 })
  actorId!: string;

  /** What authentik held when the edit was read; null when it held no profile at all. */
  @Column({ type: 'jsonb', nullable: true })
  before!: ProfileSnapshot | null;

  /** What was written. */
  @Column({ type: 'jsonb' })
  after!: ProfileSnapshot;

  /** The correction request this edit answered, when a person asked for it (WP4b). */
  @Column({ type: 'uuid', nullable: true })
  requestId!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at!: Date;
}
