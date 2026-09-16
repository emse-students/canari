import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Unique } from 'typeorm';

/**
 * Records the user-level membership of a person in an MLS group, independently
 * of which devices that user currently has enrolled. A user has exactly one row
 * here per group, while they may have many `DeviceGroupMembership` rows (one per device).
 *
 * This table is the authoritative source for three things:
 *
 * 1. **"Who belongs to this group?"** - used by recovery to determine which users may be
 *    re-invited (welcome_request). Unlike `dm_device_group_memberships`, this table is NOT
 *    affected by device lifecycle events (fresh-start, delete). A user remains a member here
 *    until they explicitly leave or are removed.
 *
 * 2. **Group listing** - `getUserGroups` queries this table to enumerate all groups
 *    a user belongs to.
 *
 * 3. **Authorization** - `sendMessage` and history endpoints verify the requesting
 *    user has a row here before allowing access to the group.
 *
 * Lifecycle: hard-delete. When a user leaves or is removed, the row is deleted
 * (not soft-deleted). `removeGroupMember` deletes both this row and all the user's
 * `DeviceGroupMembership` rows atomically.
 */
@Entity('dm_group_members')
@Unique(['groupId', 'userId'])
export class GroupMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Group this membership belongs to. */
  @Column({ type: 'uuid' })
  groupId: string;

  /** User who is a member of the group. */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** Permission level: `admin` can add/remove members; `member` can only send messages. */
  @Column({ type: 'enum', enum: ['admin', 'member'], default: 'member' })
  role: 'admin' | 'member';

  /**
   * When this membership was CREATED, and never anything else.
   *
   * It is not refreshed. Both writers go through `ensureGroupMember`, which says nothing on
   * conflict, so a second enrolment of somebody already here changes no byte of this row. A member
   * who is removed and comes back is a NEW row, because removal hard-deletes - so "arrived again,
   * later" is expressed, while "asked again" is not.
   *
   * It was refreshed until 2026-09-16, and the cost was a wrong reading rather than a wrong
   * behaviour: nothing in the service has ever read this column, so the only reader is a person at
   * a `psql` prompt - and one of them read an adder as having joined five minutes after committing
   * adds, when what had happened was that inviting somebody moved the inviter's own arrival.
   */
  @CreateDateColumn()
  joinedAt: Date;
}
