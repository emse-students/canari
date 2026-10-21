import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { ContentReport } from '../../moderation/entities/content-report.entity';

/**
 * A REPORTED LIVE CHAT LINE, KEPT FOR STAFF (WP-L8b, migration 099; owner, 2026-10-20, reversing
 * C2 for a reported line). Written in the transaction that files the `live_chat` report.
 *
 * - `text` is the PLAINTEXT the reporter handed over, which the server opened the sealed line with
 *   the live key to CHECK - the key itself is not kept, and goes with the live row.
 * - No foreign key to `lives`: the line survives the live's cascade. The foreign key to
 *   `content_reports` cascades: a deleted report takes its line.
 * - Kept until the report is handled, and never past `LIVE_CHAT_REPORT_MAX_KEEP_MS` from `keptAt`
 *   - both erased by the live sweep, one rule on durable state.
 * - `signature` (the content, `keptAt` included), `authorSignature` and `reporterSignature` (the
 *   report with one account each) are HMAC-SHA256 under the key `keyId` names
 *   (`live-report-signature.ts`), so a row altered in the database is told apart from what the
 *   server recorded.
 * - The AUTHOR's erasure anonymises `authorId` and leaves the line until handled or the bound
 *   (owner, 2026-10-20); the author signature alone then reads `erased`.
 */
@Entity('live_chat_reported_lines')
@Index('live_chat_reported_lines_kept_at_idx', ['keptAt'])
@Index('live_chat_reported_lines_author_idx', ['authorId'])
export class LiveChatReportedLine {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'live_chat_reported_lines_pkey' })
  reportId: string;

  /** Foreign key `live_chat_reported_lines_report_fk`: the line goes with its report. */
  @ManyToOne(() => ContentReport, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reportId', foreignKeyConstraintName: 'live_chat_reported_lines_report_fk' })
  report?: ContentReport;

  @Column({ type: 'uuid' })
  liveId: string;

  @Column({ type: 'uuid' })
  messageId: string;

  /** The message's sequence number on its live when it was reported. */
  @Column({ type: 'integer' })
  seq: number;

  /** The author - a 64-char hex user id; anonymised by the author's erasure. */
  @Column({ type: 'varchar', length: 255 })
  authorId: string;

  @Column({ type: 'uuid' })
  clientId: string;

  /** SHA-256 (hex) of the sealed bytes the text was checked against; the ciphertext is not kept. */
  @Column({ type: 'varchar', length: 64 })
  sealedSha256: string;

  /**
   * The line's plaintext as the reporter handed it over and the server checked it, as its UTF-8
   * BYTES: a PostgreSQL `text` cannot hold U+0000, which a sealed line may carry. The signature is
   * over the decoded string, unchanged.
   */
  @Column({ type: 'bytea' })
  text: Buffer;

  @Column({ type: 'timestamptz' })
  messageCreatedAt: Date;

  /** Written by the report's transaction (the database clock, to the millisecond) and signed. */
  @CreateDateColumn({ type: 'timestamptz' })
  keptAt: Date;

  @Column({ type: 'varchar', length: 16 })
  keyId: string;

  @Column({ type: 'varchar', length: 64 })
  signature: string;

  @Column({ type: 'varchar', length: 64 })
  authorSignature: string;

  @Column({ type: 'varchar', length: 64 })
  reporterSignature: string;
}
