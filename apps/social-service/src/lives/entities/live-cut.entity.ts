import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { LiveCutReason, LiveEndReason } from '../live.constants';

/**
 * A live STAFF CUT (WP-L8, migration 097; docs/wiki/services/lives.md, "Moderation") - the live
 * equivalent of a moderator deleting a post (D6). One row per cut live.
 *
 * IT OUTLIVES THE LIVE ROW ON PURPOSE (no foreign key): the live is deleted at its end (no replay,
 * L3), and this row is then what answers a viewer or the broadcaster `410 LIVE_ENDED` (with the
 * live's own end reason, `cut` when the cut ended it), the record of the decision (who, when, which reason code), and the count of a
 * broadcaster's earlier cuts a moderator reads. No strike policy reads it yet (the user's decision).
 * `broadcasterId` and `associationId` repeat the live's so the rule of a post can be asked of this
 * row once the live's is gone. Deleted past `LIVE_CUT_RETENTION_MS` by the live sweep.
 */
@Entity('live_cuts')
@Index('live_cuts_broadcaster_idx', ['broadcasterId', 'cutAt'])
@Index('live_cuts_cut_at_idx', ['cutAt'])
@Check('live_cuts_reason', `reason IN ('spam', 'harassment', 'inappropriate', 'other')`)
@Check(
  'live_cuts_live_end_reason',
  `"liveEndReason" IN ('broadcaster', 'dropped', 'max_duration', 'cut')`
)
export class LiveCut {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'live_cuts_pkey' })
  liveId: string;

  /** The member who broadcast - a 64-char hex user id. The erasure of that account deletes the row. */
  @Column({ type: 'varchar', length: 255 })
  broadcasterId: string;

  /** The association the live spoke for, or NULL for the member's own. */
  @Column({ type: 'uuid', nullable: true })
  associationId: string | null;

  /** The moderator who cut. The erasure of THAT account anonymises it: the decision stays. */
  @Column({ type: 'varchar', length: 255 })
  reviewerId: string;

  @Column({ type: 'varchar', length: 32 })
  reason: LiveCutReason;

  /** The moderator's own note, at most `LIVE_CUT_DETAILS_MAX` characters; never shown to the broadcaster. */
  @Column({ type: 'text', nullable: true })
  details: string | null;

  @Column({ type: 'timestamptz' })
  liveStartedAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  cutAt: Date;

  /** When the live ended: the cut's own time when the cut ended it, else its earlier end. */
  @Column({ type: 'timestamptz' })
  liveEndedAt: Date;

  /**
   * How the live ended, so the `410` after the purge says what the `410` before it said: `cut` when
   * this cut ended it, else the reason it had already ended with (a cut of an ended live rewrites
   * nothing). Never `erased`: an erased broadcaster's live is not cut.
   */
  @Column({ type: 'varchar', length: 32 })
  liveEndReason: Exclude<LiveEndReason, 'erased'>;
}
