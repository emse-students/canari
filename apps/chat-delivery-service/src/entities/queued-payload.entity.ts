import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * ONE CIPHERTEXT, STORED ONCE, FOR EVERY DEVICE A KEY-GROUP FRAME IS QUEUED TO.
 *
 * A community key group fans one frame out to every seat, and each `queued_message` row used to
 * carry its own copy of the same ciphertext: 31 copies per payload on average, 883 MB of a 1.5 GB
 * queue on production (`dm-vs-community-encryption`, 2026-10-21). The per-device row is still the
 * DELIVERY RECORD - its id is what a device ACKs, what a push names, what the pull pages over - but
 * it now points here (`QueuedMessage.payloadId`) instead of holding the bytes.
 *
 * A payload has no lifetime of its own. It is written in the same transaction as every record that
 * will ever reference it, and is collected by {@link collectUnreferencedPayloads} once no record
 * does: its reference set only ever shrinks, so "nothing references it now" is a proof that nothing
 * ever will. See `docs/wiki/services/chat-delivery.md`.
 */
@Entity('queued_payload')
export class QueuedPayload {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * The group the frame was sent to. Every record referencing this payload names the same group,
   * which is what lets `deleteGroupOwnedRows` take the payloads with the records.
   */
  @Index('IDX_queued_payload_groupId')
  @Column({ type: 'uuid' })
  groupId: string;

  /** Base64-encoded MLS ciphertext, identical for every record that references it. */
  @Column({ type: 'text' })
  proto: string;

  /** The send's receive instant - the same `createdAt` every record of the fan-out carries. */
  @CreateDateColumn()
  createdAt: Date;
}
