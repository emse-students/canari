import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** A content report submitted by a user flagging a post, comment, or message. */
@Entity('content_reports')
export class ContentReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  reporterId: string;

  /** What type of content was reported. */
  @Column({ length: 30 })
  contentType: 'post' | 'comment' | 'message';

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

  /** The user ID of the content's author, stored at report time to enable quick moderation actions. Null for association posts or messages. */
  @Column({ nullable: true })
  reportedUserId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
