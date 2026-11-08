import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * Every kind of thing a report can name - the ONE list the DTO, the service and this column share.
 * `nickname` (2026-11-08) is one VERSION of a community nickname: `contentId` is
 * `<member row id>@<set-at ms>` (`nicknameReportSubject`), its setter in `reportedUserId`, read by the
 * server from the membership row (docs/wiki/moderation-and-blocking.md).
 */
export const REPORT_CONTENT_TYPES = [
  'post',
  'comment',
  'user',
  'live',
  'live_chat',
  'nickname',
] as const;

/** One of {@link REPORT_CONTENT_TYPES}. */
export type ReportContentType = (typeof REPORT_CONTENT_TYPES)[number];

/**
 * A content report submitted by a user flagging a post, a comment, or a person. ONE per reporter
 * per thing, held by a partial unique index (migration 099) that leaves out the erasure's
 * tombstone, so two erased reporters of one thing do not collide.
 */
@Entity('content_reports')
@Index('content_reports_reporter_content_uniq', ['reporterId', 'contentId'], {
  unique: true,
  where: `"reporterId" <> '[deleted]'`,
})
export class ContentReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  reporterId: string;

  /**
   * What was reported. `user` carries the reported account's id in {@link contentId}; `live` a live's
   * id (WP-L8), its broadcaster in {@link reportedUserId}, set by the server from the live row;
   * `live_chat` one line of a live's chat (WP-L8b): the message's id, its author in
   * {@link reportedUserId}, and the line itself kept apart in `live_chat_reported_lines` until the
   * report is handled.
   *
   * There was a `message` case here until 2026-08-27, declared in three places and produced by
   * nobody. It could not have worked: message bodies are MLS ciphertext, so the server has nothing
   * to show a moderator - `contentPreview` was hard-coded null for it. A branch that names a
   * capability the product does not have reads, to the next person, as a capability it has.
   */
  // The type is NAMED: a union alias reflects as `Object`, which TypeORM refuses at start-up.
  @Column({ type: 'varchar', length: 30 })
  contentType: ReportContentType;

  @Column()
  @Index()
  contentId: string;

  /** Reason category: spam, harassment, inappropriate, other. */
  @Column({ length: 50 })
  reason: string;

  @Column({ type: 'text', nullable: true })
  details: string | null;

  @Column({ length: 20, default: 'pending' })
  status: 'pending' | 'reviewed' | 'dismissed';

  @Column({ nullable: true })
  reviewedBy: string | null;

  /** When the report was reviewed/dismissed. Used to auto-purge handled reports after a delay. */
  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  /** The user ID of the content's author, stored at report time to enable quick moderation actions. Null for association posts. Equal to `contentId` when the report targets a person. */
  @Column({ nullable: true })
  reportedUserId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
