import { Entity, PrimaryColumn, Column, Unique, Index } from 'typeorm';

/**
 * Denylist of devices that have been explicitly revoked by their owner.
 * Once a device is recorded here the server refuses to enqueue new messages for it,
 * preventing a stolen or lost device from receiving future group traffic. The primary
 * key is set by the caller (rather than auto-generated) so that revocation can be
 * idempotent - re-revoking the same device ID refreshes the record rather than duplicating it.
 *
 * A revocation lapses after `DEVICE_REVOCATION_TTL_MS`; ask
 * {@link activeRevocationWhere} rather than testing for the row's mere existence.
 */
@Entity()
@Unique(['userId', 'deviceId'])
export class RevokedDevice {
  /** Caller-supplied stable identifier for this revocation record (UUID v4). */
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  /** User who owns (and revoked) the device. */
  @Index()
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** Opaque device identifier that has been revoked. */
  @Column()
  deviceId: string;

  /**
   * When the device was LAST revoked, and therefore when its ban window starts.
   *
   * Written explicitly rather than by `@CreateDateColumn`, which only ever fires on insert: a
   * device re-revoked after being un-revoked must restart its window, and a create-date would have
   * kept the first revocation's date for ever - so a second, deliberate revocation could be born
   * already expired. The column shape is unchanged (`TIMESTAMP NOT NULL DEFAULT now()`), so this is
   * a change of who writes it, not a migration.
   */
  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  revokedAt: Date;
}
