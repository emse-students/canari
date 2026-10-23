import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Live } from './live.entity';

/**
 * One message of a live's chat (WP-L6, migration 098; docs/wiki/services/lives.md "Live chat").
 *
 * `sealed` is CIPHERTEXT under the live key (C12) - the server never reads a message. A hidden
 * message has it ERASED (`sealed = NULL`, `hiddenAt` set: the CHECK ties the two) and a NEW `seq`,
 * so every viewer's next poll carries the tombstone (C14). The row goes with its live (C2).
 */
@Entity('live_chat_messages')
@Index('live_chat_messages_seq', ['liveId', 'seq'], { unique: true })
@Index('live_chat_messages_client', ['liveId', 'authorId', 'clientId'], { unique: true })
@Index('live_chat_messages_author_idx', ['authorId', 'createdAt'])
@Check('live_chat_messages_hidden', `("hiddenAt" IS NULL) = (sealed IS NOT NULL)`)
export class LiveChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  liveId: string;

  /** Foreign key `live_chat_messages_live_fk`: the chat goes with its live. */
  @ManyToOne(() => Live, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'liveId', foreignKeyConstraintName: 'live_chat_messages_live_fk' })
  live?: Live;

  /** From `lives.chatSeq`, under the live's row lock (C4); reassigned by a hide. */
  @Column({ type: 'integer' })
  seq: number;

  /** The author - a 64-char hex user id, never a uuid. */
  @Column({ type: 'varchar', length: 255 })
  authorId: string;

  /** The client's idempotence key (C5), also bound into the seal's AAD (C12). */
  @Column({ type: 'uuid' })
  clientId: string;

  /** `iv + ciphertext + tag` under the live key; NULL once hidden. */
  @Column({ type: 'bytea', nullable: true })
  sealed: Buffer | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  hiddenAt: Date | null;
}
