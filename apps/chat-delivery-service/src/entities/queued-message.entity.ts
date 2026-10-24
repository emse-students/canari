import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { QueuedPayload } from './queued-payload.entity';

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

  /** Device ID of the intended recipient - messages are device-addressed in MLS. */
  @Column()
  deviceId: string;

  /**
   * Base64-encoded serialised MLS PrivateMessage or PublicMessage protobuf blob. NULL in storage
   * when {@link payloadId} is set; every reader materialises it through
   * `materializeDeliveries` before handing the row to a device.
   */
  @Column({ nullable: true })
  proto?: string;

  /**
   * The shared ciphertext this delivery record points at (`queued_payload`), set on a key-group
   * fan-out so one frame is stored once and not once per seat. NULL on every other row, and on
   * every row written before migration 034 - those carry `proto` inline and are read as before.
   * Storage-only: removed from the row before it leaves the service. The index is PARTIAL, as
   * migration 034 builds it: only the shared records are ever looked up by payload.
   */
  @Index('IDX_queued_message_payloadId', { where: '"payloadId" IS NOT NULL' })
  @Column({ type: 'uuid', nullable: true })
  payloadId?: string | null;

  /**
   * The payload itself, JOINED in the same statement that reads the record so the pair is one
   * snapshot: a separate read could find the payload collected after the record was acknowledged.
   * Read-only on this side - the writer sets {@link payloadId}. No foreign key, like every other
   * column joining this service's tables (`createForeignKeyConstraints: false`, migration 034).
   */
  @ManyToOne(() => QueuedPayload, { nullable: true, createForeignKeyConstraints: false })
  @JoinColumn({ name: 'payloadId' })
  payload?: QueuedPayload | null;

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

  /**
   * True when the sender ADDRESSED this frame to this device rather than to the whole group
   * (`recipientDevices`). MLS still encrypts it for every member, so the receiver needs the routing
   * fact to refuse anything but a solicited history answer (migration 035,
   * docs/wiki/protocols/history-answer-addressing.md, rules 4-5).
   */
  @Column({ type: 'boolean', default: false })
  addressed: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
