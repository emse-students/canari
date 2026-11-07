import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * What a push sent through `MessagingService.sendPushToUser` would have carried, kept for ONE device
 * while that device was sent only a content-free wake naming this row's id (migration 046; content-
 * free push WP-W3, docs/wiki/protocols/content-free-push.md section 3.2).
 *
 * The device fetches it by id (`GET /mls/push/wake?envelopeId=`), under its own PushSecret: the row
 * is found by `(id, userId, deviceId)`, so a secret opens only its own envelopes. Serving does not
 * delete - it stamps `servedAt` and counts (`servedCount`), and the same map is answered again to a
 * repeat fetch, so a response lost on the way is never turned into a `gone`.
 *
 * It dies by a proof, never a clock (`utils/push-envelope.ts`): its device's `push_token` row is
 * deleted (the migration's foreign key, `ON DELETE CASCADE` - not declared here, so a schema built by
 * `synchronize` for local development has no cascade), the device registers again (an app start),
 * or the per-device cap evicts it.
 */
@Entity('push_envelope')
@Index('IDX_push_envelope_device', ['userId', 'deviceId', 'createdAt'])
export class PushEnvelope {
  /** Random uuid, the `envelopeId` of the wake. It names nobody and nothing. */
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  /** The account whose device was woken. */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** The woken device (with `userId`, the push registration this row dies with). */
  @Column({ type: 'varchar' })
  deviceId: string;

  /** The push's title, body, data map and inline group (`EnvelopeContent`), as the full push had them. */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  /** Whether the push draws nothing - silent envelopes are evicted first at the cap. */
  @Column({ type: 'boolean' })
  silent: boolean;

  /** Envelopes of one device sharing a key collapse to the newest (a salon's `channel_read`). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  collapseKey: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** When the device last fetched it; null while it has never been served. */
  @Column({ type: 'timestamptz', nullable: true })
  servedAt: Date | null;

  /** How many times it was served - above one, a response the device did not keep. */
  @Column({ type: 'integer', default: 0 })
  servedCount: number;
}
