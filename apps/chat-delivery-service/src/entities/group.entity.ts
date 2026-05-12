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

  /** True for multi-member group chats; false for 1-to-1 direct messages. */
  @Column({ default: false })
  isGroup: boolean;

  /** Monotonically increasing counter incremented on each manual key rotation,
   *  allowing clients to distinguish key rotation epochs from normal commits. */
  @Column({ default: 1 })
  keyVersion: number;

  /** Current MLS epoch number for this group; incremented by every Commit message.
   *  Devices with a lower `lastEpochSeen` need to catch up before they can decrypt. */
  @Column({ default: 0 })
  activeEpoch: number;

  /** JSONB snapshot of the most recent key-rotation Commit payload, kept so that
   *  devices coming online after the rotation can reconstruct the new epoch state. */
  @Column({ type: 'jsonb', nullable: true })
  latestKeyRotationPayload: any;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
