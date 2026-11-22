import { Entity, PrimaryColumn, Column } from 'typeorm';

/**
 * One daily counter of the push chain (migration 054; `utils/push-delivery-records.ts`): how many
 * pushes of one `kind` to one `platform` came to one `outcome` on one UTC `day`, a failure broken
 * down by the provider's `code`. Written only by an upsert that adds a batch's counts - never a row
 * per send - and read by the lead's queries in docs/wiki/services/chat-delivery.md ("Push delivery
 * records"). It names no account and no device.
 */
@Entity('push_delivery_daily')
export class PushDeliveryDaily {
  /** The UTC day the batch was recorded on (the database's clock). */
  @PrimaryColumn({ type: 'date' })
  day: string;

  /** The send path: `PushDeliveryKind`. */
  @PrimaryColumn({ type: 'varchar', length: 16 })
  kind: string;

  /** `android` or `ios`. */
  @PrimaryColumn({ type: 'varchar', length: 16 })
  platform: string;

  /** `attempted`, `accepted`, `failed` or `pruned` (`PushDeliveryOutcome`). */
  @PrimaryColumn({ type: 'varchar', length: 16 })
  outcome: string;

  /** The provider's code of a `failed` row; empty for every other outcome. */
  @PrimaryColumn({ type: 'varchar', length: 96, default: '' })
  code: string;

  /** Pushes counted under this key that day. A bigint, read as a string by the driver. */
  @Column({ type: 'bigint', default: 0 })
  count: string;
}
