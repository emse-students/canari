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

  /**
   * When a member reset this row by KICKING the device's leaf out of the MLS tree, or `null` when
   * the row's `pending` state has any other origin.
   *
   * IT IS NOT A SECOND `updatedAt`, AND THAT DISTINCTION IS THE WHOLE POINT. `updatedAt` answers
   * "when did this row last change" - it moves for every write, so inferring a kick from it would
   * read an invitation, a Welcome queue and a demotion as the same event. This column answers
   * exactly one question: *is this row waiting on a re-add that a kick promised?*
   *
   * WHAT IT SEPARATES. A `pending` row with no queued Welcome has two opposite causes with identical
   * footprints: a device `addMembersBulk` skipped for an invalid KeyPackage (never in the tree - the
   * fix is in the inviter), and a device whose stale leaf was removed and whose re-add then threw
   * (it WAS in the tree - the fix is wherever the Add failed, and nothing reported it, the failure
   * being swallowed on a phone). `reportStrandedDeviceMemberships` could name the population and not
   * the cause; this is the evidence it was missing.
   *
   * WRITTEN BY THE EVENTS THAT CHANGE THE ANSWER, and by nothing else. Set by the two kick endpoints
   * (`kickStaleDevice`, `kickStaleUser`), the only things that reset a live membership. Cleared when
   * a Welcome is queued for the device - the proof the re-add landed - and by either path that marks
   * it `active`. NOT cleared by a demotion to `pending`, which is a step towards cleanup and
   * promises no Add.
   */
  @Column({ type: 'timestamptz', nullable: true })
  kickedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
