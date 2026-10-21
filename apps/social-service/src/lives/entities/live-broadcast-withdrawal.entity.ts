import { Check, Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { LiveCutReason } from '../live.constants';

/**
 * THE RIGHT TO BROADCAST, WITHDRAWN BY STAFF (WP-L8b, migration 099; the owner's ladder of
 * 2026-10-20: the 3rd abuse, "decided by staff"). One row per account: while it exists, every start
 * is refused 403 `LIVE_BROADCAST_WITHDRAWN`. Never written automatically - a moderator writes it once
 * the account has `LIVE_WITHDRAWAL_FROM_CUTS` cuts on record, and deletes it to lift it. No clock
 * ends it. The erasure of the account deletes it; the erasure of the moderator anonymises them.
 */
@Entity('live_broadcast_withdrawals')
@Check(
  'live_broadcast_withdrawals_reason',
  `reason IN ('spam', 'harassment', 'inappropriate', 'other')`
)
export class LiveBroadcastWithdrawal {
  /** The account whose right is withdrawn - a 64-char hex user id. */
  @PrimaryColumn({
    type: 'varchar',
    length: 255,
    primaryKeyConstraintName: 'live_broadcast_withdrawals_pkey',
  })
  userId: string;

  /** The moderator who decided. The erasure of THAT account anonymises it: the decision stays. */
  @Column({ type: 'varchar', length: 255 })
  reviewerId: string;

  /** A reason CODE (the cut's list), worded by the client. */
  @Column({ type: 'varchar', length: 32 })
  reason: LiveCutReason;

  /** The moderator's own note, at most `LIVE_CUT_DETAILS_MAX` characters; never shown to the member. */
  @Column({ type: 'text', nullable: true })
  details: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  withdrawnAt: Date;
}
