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
 * 2. **Invitation state machine** - `status` HAS EXACTLY TWO WRITERS, ONE PER DIRECTION, AND EACH
 *    OWNS THE SIDE OF THE REDIS ROUTING SET THAT MATCHES IT: `activateDeviceMembership` writes
 *    `active` and the `sadd`, `deactivateDeviceMembership` writes `pending` and the `srem`. Both
 *    sentences were here as assertions and BOTH WERE FALSE until 2026-09-13. Two other paths wrote
 *    `active` - the foreground status endpoint, which wrote no routing set at all, and group
 *    creation, which asked for no addressability. Four wrote `pending`, and two of those four
 *    called no `srem`, so a demoted device stayed reachable and ELECTABLE to answer a
 *    `welcome_request` for a group it could no longer open - for the fourteen days it takes the
 *    stale-pending cron to delete the row, because nothing reconciles an extra entry away. The
 *    tables of what each set disagreed on are on the two methods themselves.
 *
 *    Two paths still INSERT a `pending` row and are not demotions: `registerDevice` and
 *    `addGroupMember` enrol a device that has never been in this group's tree, so there is nothing
 *    to remove from a routing set it was never in, and `orIgnore` leaves an existing `active` row
 *    alone. `sendWelcome` likewise only guarantees the row exists and clears `kickedAt`; it does
 *    not promote, and it must never demote - it wrote `'pending'` unconditionally until 2026-09-12,
 *    which knocked already-active devices out of the fan-out. `invitations.controller` exposes the
 *    pending list to clients.
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
   * WRITTEN BY THE EVENTS THAT CHANGE THE ANSWER, and by nothing else. It reaches this column
   * through `deactivateDeviceMembership`'s `removedFromTreeAt`, which every demotion must answer:
   * an instant from the two kick endpoints (`kickStaleDevice`, `kickStaleUser`), the only things
   * that reset a live membership, and `null` from the cron and the self-reported demotion, neither
   * of which removed anything. `null` LEAVES THE COLUMN AS IT STANDS rather than clearing it - a
   * demotion is a step towards cleanup and promises no Add, so a row demoted after a kick is still
   * a row a kick left behind. Cleared when a Welcome is queued for the device - the proof the
   * re-add landed - and by the one path that marks it `active`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  kickedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
