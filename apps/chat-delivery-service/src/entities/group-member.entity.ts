import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Unique } from 'typeorm';

/** A member's notification level for one conversation - the salon's three levels. */
export type GroupNotificationLevel = 'all' | 'mentions' | 'none';

/** Every {@link GroupNotificationLevel}, for validating what a client sends. */
export const GROUP_NOTIFICATION_LEVELS: readonly GroupNotificationLevel[] = [
  'all',
  'mentions',
  'none',
];

/** A group id as `dm_group_members.groupId` stores it: a uuid. */
export type GroupUuid = string & { readonly __groupUuid: unique symbol };

const GROUP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` can name a row of `dm_group_members` at all. A salon push carries
 * `groupId = channel_<id>`, which Postgres refuses on a uuid column (22P02): asking first is the
 * fact, a refused query is not.
 */
export function isGroupUuid(value: unknown): value is GroupUuid {
  return typeof value === 'string' && GROUP_UUID_RE.test(value);
}

/** Whether `value` is a {@link GroupNotificationLevel}. */
export function isGroupNotificationLevel(value: unknown): value is GroupNotificationLevel {
  return (GROUP_NOTIFICATION_LEVELS as readonly unknown[]).includes(value);
}

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
 * `DeviceGroupMembership` rows atomically. What the hard delete forgets - that the person WAS a
 * member, and when they left - is kept in `GroupMembershipInterval`, which the same removal closes.
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
   * How loud this conversation is for THIS member: `all` (default), `mentions`, `none`.
   *
   * The salon level (`channel_members.notifLevels`, social-service) for a private conversation, kept
   * on the membership row for the same reasons: per account, so it follows the member to every
   * device and survives a reinstall, and it ends with the membership. `none` is applied by the
   * server (the frame is sent silent); `mentions` cannot be, because the server never sees who a
   * ciphertext mentions - it travels in the push and the DEVICE decides after decrypting
   * (`buildPushDataFields`, docs/wiki/services/chat-delivery.md). Migration 029.
   */
  @Column({ type: 'varchar', length: 16, default: 'all' })
  notifLevel: GroupNotificationLevel;

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
