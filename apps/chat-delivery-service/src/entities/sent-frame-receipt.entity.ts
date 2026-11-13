import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

/**
 * The record that ONE application frame, named by its sender's `messageId`, was accepted into a
 * group - one row per `(groupId, senderId, senderDeviceId, messageId)` (migration 048).
 *
 * WHY IT EXISTS: a sender that never read its answer sends the same message again under the same
 * id - a native background send reads a late answer as a failure (`readTimeout`), keeps the entry in
 * `outbox_pending.ndjson` and drains it again. Each resend is a fresh MLS ciphertext, so the server
 * cannot tell it from a new message by its bytes; it CAN by the id the sender names beside it. The
 * row is written in the transaction that queues the frame's copies, so a second send of the id finds
 * it and queues nothing, appends nothing to the history stream and pushes nobody - it is answered
 * with this row's `receivedAt`, the instant every recipient's copy already carries. Durable state,
 * never a clock: whatever the client retries, one id is one message on every receiver.
 *
 * Bounded by the retention window (`cleanupExpiredQueuedMessages`), the age past which the queued
 * copies are gone too. Deleted with the group (`GROUP_OWNED_TABLES`) and with the account.
 */
@Entity('dm_sent_frame_receipt')
@Index('IDX_dm_sent_frame_receipt_receivedAt', ['receivedAt'])
@Index('IDX_dm_sent_frame_receipt_senderId', ['senderId'])
export class SentFrameReceipt {
  /** The group the frame was sent into. */
  @PrimaryColumn({ type: 'uuid' })
  groupId: string;

  /** The authenticated author. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  senderId: string;

  /** The author's device that sealed it. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  senderDeviceId: string;

  /** The id the sender named the frame by - the plaintext's `messageId`. */
  @PrimaryColumn({ type: 'varchar', length: 128 })
  messageId: string;

  /** The server's receive time of the first accepted copy, the answer every resend is given. */
  @Column({ type: 'timestamptz' })
  receivedAt: Date;
}
