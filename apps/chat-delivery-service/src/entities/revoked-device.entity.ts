import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Unique,
  Index,
} from 'typeorm';

/**
 * Permanent denylist of devices that have been explicitly revoked by their owner.
 * Once a device is recorded here the server refuses to enqueue new messages for it,
 * preventing a stolen or lost device from receiving future group traffic. The primary
 * key is set by the caller (rather than auto-generated) so that revocation can be
 * idempotent - re-revoking the same device ID is a no-op.
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

  @CreateDateColumn()
  revokedAt: Date;
}
