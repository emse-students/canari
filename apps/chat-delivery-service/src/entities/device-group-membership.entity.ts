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
 * - `pending` : the device has not yet processed a Welcome for this group.
 * - `active`  : the device has processed its Welcome and is in sync.
 */
export type DeviceGroupStatus = 'pending' | 'active';

/**
 * Tracks one device's membership in one MLS group. One row per (deviceId, groupId) pair.
 *
 * This table has three distinct roles:
 *
 * 1. **Routing cache source** - `messaging.service` queries `status='active'` rows to
 *    repopulate the Redis `group:members:{groupId}` set when the cache is empty (service
 *    restart, TTL expiry). The gateway reads that Redis set to forward messages and
 *    `welcome_request` frames to online devices.
 *
 * 2. **Invitation state machine** - A row is created as `pending` by `addGroupMember`
 *    for every active device of a user. It transitions to `active` when `sendWelcome`
 *    confirms the device processed its Welcome packet. `invitations.controller` exposes
 *    the pending list to clients and drives the pending→active transition.
 *
 * 3. **Device lifecycle cleanup** - When a device is deleted, ALL its rows here are
 *    removed, which removes it from every group's routing set. This is intentional, but
 *    it means a group can end up with zero `active` entries even though users still
 *    belong to it via `dm_group_members` (user-level). Do NOT use this table as the
 *    authoritative source for "who is a member" - use `dm_group_members` for that.
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

  /** Current membership state: `pending` until the device processes its Welcome, then `active`. */
  @Column({
    type: 'enum',
    enum: ['pending', 'active'],
    default: 'pending',
  })
  status: DeviceGroupStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
