import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** TypeORM entity representing a Canari post with optional polls, reactions, comments, and media. */
@Entity('posts')
export class Post {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  authorId: string;

  @Column('text')
  markdown: string;

  @Column('simple-array', { default: '' })
  mentions: string[];

  @Column('jsonb', { default: [] })
  links: any[];

  @Column({ type: 'uuid', nullable: true })
  attachedFormId: string;

  @Column('jsonb', { name: 'images', default: [] })
  media: any[];

  @Column('jsonb', { default: [] })
  polls: any[];

  @Column('jsonb', { default: [] })
  forms: any[];

  @Column({ type: 'uuid', nullable: true })
  @Index()
  associationId: string;

  /** Validated association agenda event this post relates to (compte-rendu, annonce, etc.). */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  linkedCalendarEventId: string | null;

  @Column('jsonb', { default: {} })
  reactions: Record<string, string>; // userId -> reactionType

  @Column('jsonb', { default: [] })
  comments: any[];

  @Column({ type: 'boolean', default: false })
  pinned: boolean;

  /** Set to true when the post is auto-hidden after reaching the report threshold. Moderators review and restore or delete. */
  @Column({ type: 'boolean', default: false })
  hiddenByModeration: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  scheduledAt: Date | null;

  /**
   * When this post was announced to its audience, and NULL means it has not been.
   *
   * Read and written only by `PostAnnounceScheduler`. It is durable state and not a clock: the
   * sweeper stamps it BEFORE it pushes, so a crash mid-batch loses a notification rather than
   * repeating one on every tick. Migration 058 backfills every row that predates it, because an
   * empty column would read as "the whole archive is unannounced".
   */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  feedNotifiedAt: Date | null;

  @CreateDateColumn()
  @Index()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
