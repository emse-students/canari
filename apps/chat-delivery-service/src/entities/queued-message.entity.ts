import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * A server-side envelope holding an MLS message that has not yet been
 * delivered to the target device. Messages are enqueued when the recipient
 * is offline and dequeued (deleted) once successfully delivered over
 * WebSocket or retrieved via the polling endpoint.
 */
@Entity('queued_message')
@Index(['recipientId', 'deviceId'])
export class QueuedMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** User ID of the intended recipient. */
  @Column({ type: 'varchar', length: 255 })
  recipientId: string;

  /** Device ID of the intended recipient — messages are device-addressed in MLS. */
  @Column()
  deviceId: string;

  /** Base64-encoded serialised MLS PrivateMessage or PublicMessage protobuf blob. */
  @Column({ nullable: true })
  proto?: string;

  /** True when this envelope carries an MLS Welcome message (initial group join). */
  @Column({ nullable: true })
  isWelcome?: boolean;

  /** True when this envelope carries an MLS Commit message (epoch transition). */
  @Column({ nullable: true })
  isCommit?: boolean;

  /** User ID of the device that produced this message. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  senderId?: string;

  /** Device ID of the sender, used for deduplication and sync attribution. */
  @Column({ nullable: true })
  senderDeviceId?: string;

  /** MLS group this message belongs to; null for out-of-band control messages. */
  @Column({ type: 'uuid', nullable: true })
  groupId?: string;

  /** Application-level message type tag (e.g. "text", "reaction", "edit"). */
  @Column({ nullable: true })
  type?: string;

  /** Encrypted message payload; interpretation depends on `type`. */
  @Column({ nullable: true })
  content?: string;

  /** Base64-encoded MLS RatchetTree, sent alongside Welcome messages so the
   *  new member can reconstruct the group state without a full sync. */
  @Column({ nullable: true })
  ratchetTree?: string;

  @CreateDateColumn()
  createdAt: Date;
}
