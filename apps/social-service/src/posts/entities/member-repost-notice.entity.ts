import { Entity, PrimaryColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * THE DURABLE "HAVE I ALREADY TOLD THEM" OF A MEMBER REPOST (migration 123, WP-F6).
 *
 * One row per (post, recipient), written in the repost's own transaction the first time that reader
 * is told about that post through a repost, and never deleted but with the post or the recipient's
 * account. The newly-reached set is read from visibility, which an "Annuler" undoes, so without this
 * repost -> take back -> repost would announce the same post to the same readers once per loop. Not a
 * repost, and read by nothing but that decision.
 */
@Entity('member_repost_notices')
@Index('IDX_member_repost_notices_recipient', ['recipientId'])
export class MemberRepostNotice {
  @PrimaryColumn({ type: 'uuid' })
  postId: string;

  /** The reader told. No foreign key: `users` is core-service's table. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  recipientId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
