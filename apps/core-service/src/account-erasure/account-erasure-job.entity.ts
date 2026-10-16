import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One downstream service's part of one account erasure: the durable queue AND the journal
 * (migration 012). `AccountErasureService` owns every write; this class exists so the table is
 * registered (and created by `synchronize` outside production).
 *
 * A pending row carries the account id in `subjectId` - the OIDC subject, authentik's opaque
 * `hashed_user_id` - because the call is made with it and the sign-in refusal looks it up. A
 * completed row carries `sha256:<digest>` instead, plus its timestamps: the journal says that and
 * when an erasure finished, never who it was. Nothing nominative is stored here at any point.
 */
@Entity('account_erasure_jobs')
@Index('UQ_account_erasure_pending', ['subjectId', 'service'], {
  unique: true,
  where: '"completedAt" IS NULL',
})
export class AccountErasureJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  subjectId!: string;

  @Column({ type: 'varchar', length: 32 })
  service!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  requestedAt!: Date;

  /** When the last access token issued before the deactivation expires: the final pass is due then. */
  @Column({ type: 'timestamptz' })
  credentialsExpireAt!: Date;

  /** Failed attempts so far; a success does not count. */
  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null;

  /** The last failure as a status or an error code (`describeFailure`), cleared on success. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  /** `transient` or `permanent` (`classifyFailure`), cleared on success. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  lastFailureKind!: 'transient' | 'permanent' | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  /** Set only by an operator closing a stuck job by hand: what was done and why. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  resolution!: string | null;
}
