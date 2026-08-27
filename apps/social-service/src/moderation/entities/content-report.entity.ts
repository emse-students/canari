import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** A content report submitted by a user flagging a post, a comment, or a person. */
@Entity('content_reports')
export class ContentReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  reporterId: string;

  /**
   * What was reported. `user` carries the reported account's id in {@link contentId}.
   *
   * There was a `message` case here until 2026-08-27, declared in three places and produced by
   * nobody. It could not have worked: message bodies are MLS ciphertext, so the server has nothing
   * to show a moderator - `contentPreview` was hard-coded null for it. A branch that names a
   * capability the product does not have reads, to the next person, as a capability it has.
   */
  @Column({ length: 30 })
  contentType: 'post' | 'comment' | 'user';

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
