import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Server-side metadata for an MLS group (either a 1-to-1 direct message or a
 * multi-member group chat). This record acts as the authoritative source of truth
 * for the group's current MLS epoch and key rotation state. The actual message
 * history and encrypted payloads are stored elsewhere; this table tracks only
 * the structural/crypto metadata needed to coordinate device membership.
 */
@Entity('dm_groups')
export class Group {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Display name for group chats; null for direct messages. */
  @Column({ nullable: true })
  name?: string;

  /** Media-service ID of the group avatar (raw/public blob, like channel images).
   *  Null for direct messages and for groups without a custom photo. */
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  imageMediaId?: string | null;

  /** True for multi-member group chats; false for 1-to-1 direct messages. */
  @Column({ default: false })
  isGroup: boolean;

  /** Monotonically increasing counter incremented on each manual key rotation,
   *  allowing clients to distinguish key rotation epochs from normal commits. */
  @Column({ default: 1 })
  keyVersion: number;

  /** Current MLS epoch number for this group; incremented by every Commit message.
   *  Used by `validateCommit` to gate commits against the expected base epoch. */
  @Column({ default: 0 })
  activeEpoch: number;

  /** JSONB snapshot of the most recent key-rotation Commit payload, kept so that
   *  devices coming online after the rotation can reconstruct the new epoch state. */
  @Column({ type: 'jsonb', nullable: true })
  latestKeyRotationPayload: any;

  /** UUID of the replacement group; null means this group is still active.
   *  Set atomically (first writer wins) when a device detects an irrecoverable MLS failure. */
  @Column({ type: 'uuid', nullable: true, default: null })
  successorId?: string | null;

  /** Device id that won the successor CAS and triggered this reboot. Diagnostic only:
   *  lets us attribute a reboot to the device that initiated it. Set together with
   *  `successorId` and never updated afterwards. */
  @Column({ type: 'text', nullable: true, default: null })
  successorClaimedByDeviceId?: string | null;

  /** Soft-delete timestamp. Null = active. Set on explicit deletion or when a successor is claimed.
   *  The row is intentionally kept as a tombstone so devices can detect the transition. */
  @Column({ type: 'timestamp', nullable: true, default: null })
  deletedAt?: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
