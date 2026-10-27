import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';
import { FOLLOW_PENDING, type FollowStatus } from '../follow-status';

/**
 * TypeORM entity recording that a user follows - or asks to follow - another user.
 *
 * A row is a FOLLOW only once `status` is `accepted` (migration 112, WP-F1): every personal account
 * is private, so a new row is a `pending` request. The column defaults to `pending` so a writer that
 * forgets it fails closed.
 */
@Entity('user_follows')
@Unique(['followerUserId', 'followedUserId'])
@Check('CHK_user_follows_status', `"status" IN ('pending', 'accepted')`)
@Index('IDX_user_follows_pending_followed', ['followedUserId'], { where: `"status" = 'pending'` })
export class UserFollow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  followerUserId: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  followedUserId: string;

  @Column({ type: 'varchar', length: 16, default: FOLLOW_PENDING })
  status: FollowStatus;

  @CreateDateColumn()
  createdAt: Date;
}
