import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * That one account has seen one announcement. Nothing else.
 *
 * The key is (announcement, user) rather than (announcement, device) BY DESIGN: the user asked for
 * once per account, on whichever device gets there first. That also makes the state server-side by
 * construction, which is the point - local state is wiped by a reinstall, and an announcement that
 * reappears after one is worse than none.
 *
 * **This row answers exactly one question**, and it must not be borrowed for a second: not "is the
 * account current", not "has it been notified". Two questions that differ only in lifetime sharing
 * one row is how a durable-state trigger gets silenced.
 */
@Entity('platform_announcement_seen')
export class PlatformAnnouncementSeen {
  @PrimaryColumn({ name: 'announcement_id', type: 'uuid' })
  announcementId!: string;

  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @CreateDateColumn({ name: 'seen_at', type: 'timestamptz' })
  seenAt!: Date;
}
