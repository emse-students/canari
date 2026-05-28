import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

/**
 * Lifecycle state of a single device's membership in an MLS group.
 *
 * - `pending`          - The group admin knows about this device but has not yet sent a Welcome.
 * - `welcome_sent`     - An MLS Welcome message has been enqueued for the device.
 * - `welcome_received` - The device has acknowledged the Welcome and joined the MLS epoch.
 * - `stale`            - The device was removed from the group or its key package expired.
 */
export type DeviceGroupStatus =
  | 'pending'
  | 'welcome_sent'
  | 'welcome_received'
  | 'stale';

/**
 * Tracks whether a specific device (identified by userId + deviceId) is a member
 * of a particular MLS group and how far along the onboarding handshake has progressed.
 * One row exists per (deviceId, groupId) pair; the status field drives the sync engine
 * state machine that delivers Welcome and Commit messages to newly added devices.
 */
@Entity('dm_device_group_memberships')
@Unique(['deviceId', 'groupId'])
@Index(['userId', 'groupId'])
@Index(['groupId', 'status'])
export class DeviceGroupMembership {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Owner of the device - used for bulk queries across all devices of one user. */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** Opaque client-generated device identifier. */
  @Column()
  deviceId: string;

  /** The MLS group this membership record refers to. */
  @Column({ type: 'uuid' })
  groupId: string;

  /**
   * Current onboarding state of this device within the group.
   * Allowed values: `pending` | `welcome_sent` | `welcome_received` | `stale`.
   */
  @Column({
    type: 'enum',
    enum: ['pending', 'welcome_sent', 'welcome_received', 'stale'],
    default: 'pending',
  })
  status: DeviceGroupStatus;

  /** The highest MLS epoch number this device has successfully processed; used to
   *  detect devices that have fallen behind and need a re-sync. */
  @Column({ type: 'int', default: 0 })
  lastEpochSeen: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
