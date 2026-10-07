import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Which notification categories an ACCOUNT has switched off - one row per account, absent for every
 * account that never touched the setting.
 *
 * Per account and not per device, so the choice follows the user; stored HERE because this service
 * is where every push is sent from (`MessagingService.sendPushToUser` and `sendFcmForQueued`), and
 * a preference read from any other store would be one more network hop in front of every push.
 * It stores the DISABLED set: an account with no row, and a category added later, are both ON.
 * The per-salon level (`channel_members.notifLevels`, social-service) is a different question - how
 * loud ONE salon is - and is decided there before a push is ever handed to this service.
 */
@Entity()
export class NotificationPreference {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  /** Ids from `NOTIFICATION_CATEGORIES` that must not notify this account. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  disabledCategories: string[];

  @UpdateDateColumn()
  updatedAt: Date;
}
