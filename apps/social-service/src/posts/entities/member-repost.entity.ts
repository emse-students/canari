import { Entity, PrimaryColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * One PERSON republishing one post to their own accepted followers (WP-F6, migration 121). The post
 * then reaches those followers too - `memberRepostReachesUserSql` reads these rows. The pair is the
 * key, so the same person cannot repost the same post twice.
 */
@Entity('member_reposts')
@Index('IDX_member_reposts_reposter', ['reposterId'])
export class MemberRepost {
  @PrimaryColumn({ type: 'uuid' })
  postId: string;

  /** The member who reposted. No foreign key: `users` is core-service's table. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  reposterId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  repostedAt: Date;
}
