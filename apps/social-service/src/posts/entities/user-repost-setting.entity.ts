import { Entity, Column, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * A person's account-wide consent to member reposts of their personal posts (WP-F6, migration 121,
 * owner 2026-11-01: "Autoriser mes abonnes a republier mes posts", ON by default). NO ROW MEANS THE
 * DEFAULT - ON; a row exists only once the person chose. A post's own `allowReposts` overrides it.
 */
@Entity('user_repost_settings')
export class UserRepostSetting {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  @Column({ type: 'boolean', default: true })
  allowReposts: boolean;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
