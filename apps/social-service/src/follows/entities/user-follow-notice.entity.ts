import { Entity, CreateDateColumn, Index, PrimaryColumn, Check } from 'typeorm';

/** What a {@link UserFollowNotice} records was notified: a request, or its acceptance. */
export type FollowNoticeKind = 'request' | 'accepted';

/**
 * THE DURABLE "HAVE I ALREADY TOLD THEM" OF A FOLLOW REQUEST (migration 114, WP-F2).
 *
 * One row per (asker, person asked, kind), written the first time that notice is sent and never
 * deleted but with an account. A request row is deleted by a withdraw, a refusal or a removal, so
 * the row itself cannot remember that the person was already told; without this, ask -> withdraw ->
 * ask would push the same person once per loop. Not a follow, and read by nothing but that decision.
 */
@Entity('user_follow_notices')
@Check('CHK_user_follow_notices_kind', `"kind" IN ('request', 'accepted')`)
@Index('IDX_user_follow_notices_followed', ['followedUserId'])
export class UserFollowNotice {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  followerUserId: string;

  @PrimaryColumn({ type: 'varchar', length: 255 })
  followedUserId: string;

  @PrimaryColumn({ type: 'varchar', length: 16 })
  kind: FollowNoticeKind;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
