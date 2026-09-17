import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** TypeORM entity representing a notification triggered by a comment or reply on a post. */
@Entity('post_notifications')
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

  @Column({ default: false })
  read: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
