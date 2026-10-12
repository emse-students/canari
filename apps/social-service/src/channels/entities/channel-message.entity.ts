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
// The unread count reads each salon's rows newer than a mark (migration 079).
@Index('IDX_channel_messages_channel_created', ['channelId', 'createdAt'])
// The two access paths the 365-day retention window needs, both PARTIAL and both named to match
// migration 043 - `synchronize` is on outside production, so an entity that did not declare them
// would leave dev without the indexes prod has. The purge only ever targets unpinned rows, and a
// row with no Graine session answers no device's `liveGraineSessions` question, so in each case the
// excluded rows are exactly the ones the query can never want.
@Index('IDX_channel_messages_retention', ['createdAt'], { where: 'pinned = false' })
@Index('IDX_channel_messages_sender_session', ['senderSessionId'], {
  where: '"senderSessionId" IS NOT NULL',
})
// Graine v2 (migration 065): a second row under one message key is a replay or a key reused, never a
// message - refused at the door so no reader has to guess which of the two is real.
@Index('UQ_channel_messages_session_index', ['senderSessionId', 'messageIndex'], {
  unique: true,
  where: '"senderSessionId" IS NOT NULL',
})
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

  /**
   * Graine v2: the session key's Ed25519 signature over the header, nonce and ciphertext, base64.
   *
   * Stored and relayed, never verified: the server holds no key and cannot tell a v2 session from a
   * v1 one - the version travels with the seed, over MLS. Null on a v1 row, which is what the v1
   * reader's removal condition counts (channel-encryption section 21).
   */
  @Column({ type: 'varchar', length: 88, nullable: true })
  signature: string | null;

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
