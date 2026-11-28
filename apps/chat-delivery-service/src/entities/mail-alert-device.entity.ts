import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * One device of an account that wants the empty mail push (migration 059, mail lot 5). Its row dies
 * with the device's push registration (foreign key, ON DELETE CASCADE): no device without a push
 * token is ever kept subscribed.
 */
@Entity({ name: 'mail_alert_device' })
export class MailAlertDevice {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  @PrimaryColumn({ type: 'varchar' })
  deviceId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
