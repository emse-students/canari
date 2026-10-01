import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import type { PostKind } from '../reel.constants';

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

  /**
   * Fixed at creation, mutually exclusive with `associationId` (enforced server-side in
   * `PostsController.createPost`, never trusted from the client). Strips `authorId` from every
   * reader except a content moderator or platform admin - see `PostsService.viewerCapabilities`.
   * Cleared only by a moderator (`PostsService.clearAnonymousFlag`), never by the author via edit.
   */
  @Column({ type: 'boolean', default: false })
  anonymous: boolean;

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

  /**
   * `'post'` for every row that predates CanaReels, `'reel'` for a short video that expires.
   * Fixed at creation. The three reel columns are one fact (migration 069's CHECK): a reel has a
   * `durationMs` and an `expiresAt`, a post has neither.
   */
  @Column({ type: 'varchar', length: 16, default: 'post' })
  kind: PostKind;

  /** The length the CLIENT declared for a reel, 1..`REEL_MAX_DURATION_MS`; null on a post. Never verified server-side - the video is ciphertext. */
  @Column({ type: 'integer', nullable: true, default: null })
  durationMs: number | null;

  /**
   * When `ReelRetentionScheduler` deletes this reel: `createdAt` + `REEL_RETENTION_DAYS`, set ONCE
   * at creation. Null on a post. A reel past it is invisible to every read before the worker has
   * reached it.
   */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  expiresAt: Date | null;

  @CreateDateColumn()
  @Index()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
