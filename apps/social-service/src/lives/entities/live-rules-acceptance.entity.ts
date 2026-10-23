import { Check, Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * A member's acceptance of the rules shown before a live (L11, migration 097): the version they
 * accepted and when. A start is refused `LIVE_RULES_NOT_ACCEPTED` while this is absent or older than
 * `LIVE_RULES_VERSION`. One row per account, raised when the rules change; the erasure deletes it.
 */
@Entity('live_rules_acceptances')
@Check('live_rules_acceptances_version', `"rulesVersion" >= 1`)
export class LiveRulesAcceptance {
  @PrimaryColumn({
    type: 'varchar',
    length: 255,
    primaryKeyConstraintName: 'live_rules_acceptances_pkey',
  })
  userId: string;

  @Column({ type: 'integer' })
  rulesVersion: number;

  @CreateDateColumn({ type: 'timestamptz' })
  acceptedAt: Date;
}
