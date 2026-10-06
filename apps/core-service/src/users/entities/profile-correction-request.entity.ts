import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

/** Where a correction request stands. `pending` is the open state; `applying` is an admin's claim held while authentik is written, so
 * a second admin cannot answer the same request (it still occupies the person's one open slot). */
export type CorrectionStatus = 'pending' | 'applying' | 'applied' | 'refused';

/**
 * A person's request that an admin correct their MiConnect profile (D10).
 *
 * At most ONE is `pending` or `applying` per person (a partial unique index, migration `010`); resolving it frees
 * the slot. No foreign key: `users.id` is the OIDC subject and account deletion must not be blocked.
 */
@Entity('profile_correction_requests')
export class ProfileCorrectionRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The person asking. */
  @Column({ type: 'varchar', length: 255 })
  userId!: string;

  /** What they say is wrong, in their own words. Free text, shown only to admins. */
  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: CorrectionStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  /** The admin who applied or refused it. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  resolvedBy!: string | null;

  /** Why it was refused; optional on a refusal, absent on an applied request. */
  @Column({ type: 'text', nullable: true })
  resolutionNote!: string | null;
}
