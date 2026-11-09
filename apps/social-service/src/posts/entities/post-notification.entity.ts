import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** TypeORM entity representing a notification triggered by a comment or reply on a post. */
@Entity('post_notifications')
// The bell's page walks a reader's rows newest first and stops with the page (migration 126,
// `bellPageQuery`). Declared under the migration's NAME so a `TYPEORM_SYNCHRONIZE=1` boot keeps it
// rather than dropping an index it does not know. The decorator cannot say DESC (TypeORM has no
// per-column order on `@Index`) and synchronize compares an index by name and columns, not order,
// so it leaves the migration's DESC index as it is; on a schema synchronize builds itself the index
// is ASC, which PostgreSQL scans BACKWARD for `ORDER BY "createdAt" DESC` - the same plan.
@Index('IDX_post_notifications_recipient_created', ['recipientId', 'createdAt'])
export class PostNotification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  recipientId: string;

  @Column()
  type: string; // 'comment' | 'reply' | 'reaction' | 'mention' | 'form_reminder'

  @Column()
  postId: string;

  @Column()
  actorId: string;

  @Column({ nullable: true })
  actorName: string;

  /**
   * Set only for `type === 'association_post'`. `actorId` on this row is the PUBLISHING MEMBER,
   * not the association - see `PostAnnounceScheduler.announceAssociationPost`'s own docblock for
   * why - so the association's own identity has nowhere else to live on this row.
   */
  @Column({ nullable: true })
  associationId: string | null;

  /** Denormalized alongside `actorName`, same staleness tradeoff: a later logo change does not
   *  retroactively rewrite an old notification's picture. */
  @Column({ nullable: true })
  associationLogoUrl: string | null;

  @Column()
  text: string;

  /**
   * Structured facts of a notice that a client draws in its own locale; NULL for every row written
   * before migration 117 and every type that carries none. A booking notice holds
   * `{ place, startsAt, timeZone, word }` (`BookingNoticeMeta`); `text` keeps the word, else the
   * place, for older clients, and is never parsed.
   */
  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, unknown> | null;

  /**
   * The comment this row is ABOUT, set by every row a comment writes (`comment`, `reply`, and a
   * `mention` in a comment); NULL otherwise, and on every row written before migration 132. It is
   * how the bell tells a comment's mention from a post's (`commentBorneNotificationSql`).
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  commentId: string | null;

  @Column({ default: false })
  read: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
