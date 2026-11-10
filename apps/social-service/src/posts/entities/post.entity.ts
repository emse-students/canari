import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import type { StoredPostKind } from '../reel.constants';
import type { InstitutionReachPublic, InstitutionReachSpace } from '../institution-reach';

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

  /**
   * `update: false`: a `save(post)` never writes it back. Every write of a comment goes through
   * `writeComments` (`comment-write.ts`), under the post row's lock - a reaction, an edit of the post
   * or a hide that loaded the row before a comment landed would otherwise store the stale array and
   * lose that comment.
   */
  @Column({ type: 'jsonb', default: [], update: false })
  comments: any[];

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

  /**
   * The AUTHOR's per-post override of their member-repost consent (WP-F6, migration 121): NULL
   * follows their account setting (`user_repost_settings`, ON by default), true or false overrides
   * it for this post. Read only for a personal post - an entity post is reposted without consent.
   * Served to the author alone (`repostConsent`), never spread onto a reader's card.
   */
  @Column({ type: 'boolean', nullable: true, default: null })
  allowReposts: boolean | null;

  /**
   * "Entre étudiants" (owner, 2026-11-04; migration 133): read only by students (an account with a
   * cursus) and the members of the publishing association, whatever the path - the gate is
   * `studentsOnlyAdmitsUserSql`, one conjunct of `postVisibleToUserSql`. Offered on an association
   * or list post only (`STUDENTS_ONLY_ASSOCIATION_TYPES`), set at publication and changed afterwards
   * by whoever may edit the post, both ways. Served to every reader, so the card can say so.
   */
  @Column({ type: 'boolean', default: false })
  studentsOnly: boolean;

  /**
   * THE REACH AN INSTITUTION CHOSE FOR THIS POST (owner, 2026-11-10; migration 162): the public in
   * the ticked spaces - 'all', 'students' (an account with a cursus) or 'staff' (no cursus). NULL on
   * every post that is not an institution's, and on an institution post written before the reach
   * existed (read as its whole audience, everyone). Set with {@link reachSpaces}, never alone (a
   * CHECK says so); read by `institutionReachAdmitsUserSql`, a conjunct of `postVisibleToUserSql`.
   */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  reachPublic: InstitutionReachPublic | null;

  /**
   * The spaces an institution's post targets, inside the institution's audience (migration 162): a
   * jsonb array of `{formation, campus}` pairs, NULL exactly when {@link reachPublic} is. Read by
   * containment in the predicate, so a value that is not such an array reaches nobody.
   */
  @Column({ type: 'jsonb', nullable: true, default: null })
  reachSpaces: InstitutionReachSpace[] | null;

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
   * `'post'` for every row that predates CanaReels, `'reel'` for a short video that expires,
   * `'replay'` for a finished live kept three days (migration 156). Fixed at creation. The columns
   * of each kind are one fact (`posts_kind_shape`): a reel has a `durationMs` and an `expiresAt`, a
   * replay those and a `liveId`, a post none of them.
   */
  @Column({ type: 'varchar', length: 16, default: 'post' })
  kind: StoredPostKind;

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

  /**
   * The live a `kind = 'replay'` post shows (migration 156), null on every other kind. The live's
   * purge waits for this row to be gone; the unique index makes one replay per live.
   */
  @Column({ type: 'uuid', nullable: true, default: null })
  liveId: string | null;

  @CreateDateColumn()
  @Index()
  createdAt: Date;

  /**
   * THE instant this post became visible, and the ONE key the feed orders by and the card
   * displays: `scheduledAt` for a scheduled post, the creation time for an immediate one.
   * `createdAt` is when the author pressed the button, which for a scheduled post is hours before
   * anyone could see it. Written only through `publicationTime` (migration 077 backfills it).
   */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  publishedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
