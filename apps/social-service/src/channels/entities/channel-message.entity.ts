import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

/** TypeORM entity storing an encrypted message posted in a channel. */
@Entity('channel_messages')
@Index(['channelId'])
export class ChannelMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  workspaceId: string;

  @Column({ type: 'uuid' })
  channelId: string;

  @Column({ type: 'varchar', length: 255 })
  authorId: string;

  @Column('text')
  content: string;

  @Column({ nullable: true })
  nonce: string;

  /**
   * Epoch of the server-derived channel key this message was sealed under.
   *
   * @deprecated Written by nothing since WP-31: a channel message is sealed under a Graine session
   * the server holds no seed for. Kept only until WP-51 drops it along with `channels.masterSecret`.
   */
  @Column({ type: 'int', nullable: true })
  keyVersion: number;

  /**
   * The Graine session whose seed opens this message, as its SENDER named it.
   *
   * Opaque to the server, and unique across senders by construction - no two senders ever write the
   * same session namespace, so this needs no scoping to the channel to be unambiguous.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  senderSessionId: string | null;

  /**
   * Which message key of that session, since the key is HKDF(seed, sessionId, index).
   *
   * Stored beside the ciphertext rather than inside it for the obvious reason: it is needed to
   * derive the key that would open it. Gaps are normal - an index is reserved before the send and
   * stays reserved if the send fails.
   */
  @Column({ type: 'int', nullable: true })
  messageIndex: number | null;

  @Column({ type: 'uuid', nullable: true })
  replyTo: string;

  @Column('jsonb', { default: [] })
  attachments: any[];

  /**
   * True for a row that must never ring a phone - a reaction, today.
   *
   * The ONE thing the server legitimately needs to know about a body it cannot read. It says
   * nothing about what the row contains: not which emoji, not on what, not by whom. It also keeps
   * a burst of reactions from pushing older messages out of a page - see {@link listMessages}.
   */
  @Column({ type: 'boolean', default: false })
  silent: boolean;

  @Column('jsonb', { default: {} })
  metadata: any;

  /** Whether this message is pinned in its channel. */
  @Column({ type: 'boolean', default: false })
  pinned: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
