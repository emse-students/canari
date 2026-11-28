import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * The account's ONE live mail alert token, as its SHA-256 (migration 059, mail lot 5;
 * docs/wiki/mail-client-transport.md#as-built---lot-5). The token is the local part of the opaque
 * address the account's own Zimbra alert is pointed at; the token itself is never stored.
 */
@Entity({ name: 'mail_alert_token' })
export class MailAlertToken {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  /** Lower-case hex SHA-256 of the token; unique, the hook's lookup key. */
  @Column({ type: 'char', length: 64, unique: true })
  tokenHash: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
