import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

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
 * Whether a call in this conversation may ring this member - THE rule, read by the ring fan-out.
 *
 * An explicit choice (`callsAllowed` true/false) wins whatever the level. A member who never chose
 * (NULL - every row an older client ever touched) is rung unless the conversation is at `none`: a
 * conversation muted to silence does not start ringing because somebody pressed call, and a member
 * who wants calls there says so once. The client applies the same rule to its own copy
 * (`notifications/callPermission.ts`); docs/wiki/frontend/modules/calls.md says why this default.
 */
export function callsAllowedFor(
  notifLevel: GroupNotificationLevel | undefined,
  callsAllowed: boolean | null | undefined
): boolean {
  if (typeof callsAllowed === 'boolean') return callsAllowed;
  return notifLevel !== 'none';
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
// The viewer lookup of every presence poll and `getUserGroups` filter on userId alone, which the
// unique (groupId, userId) cannot serve. Named as migration 031 names it, so dev's synchronize and
// production carry the same index.
@Index('IDX_dm_group_members_user', ['userId'])
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
   * Whether a call in this conversation may ring THIS member: true, false, or NULL for "never
   * chose", which {@link callsAllowedFor} resolves against {@link notifLevel}. Its own setting rather
   * than a fourth level, because whether a conversation may RING is a different question from how
   * loud its messages are. Applied by the server at the ring fan-out (`CallsService.ringGroup`) and
   * by the client at the in-app invite. Migration 032.
   */
  @Column({ type: 'boolean', nullable: true, default: null })
  callsAllowed: boolean | null;

  /**
   * Whether this seat still WAITS FOR A MEMBER'S ADMISSION: written `true` by the invitation-link
   * acceptance, whose seat no member chose, and cleared by the first accepted commit that admits one
   * of the person's devices - a member's Add. Every other writer leaves `false`.
   *
   * While it holds, the seat is a request, not a membership: the person may not read the
   * external-join base nor commit (`MessagingService.mayJoinByExternalCommit`), and their device is
   * told to wait for a member (`GET mls/device-memberships`). Without it the joiner served itself an
   * external commit around the member's Add / Decline (docs/wiki/protocols/mls-protocol.md, "Who
   * admits a new person"). Migration 038.
   */
  @Column({ type: 'boolean', default: false })
  awaitingAdmission: boolean;

  /**
   * Whether the ONE push that tells the admitted members "X wants to join" was already claimed for
   * THIS ask. The ask's identity is this row's id (a withdrawn seat is deleted and a new link writes
   * a new row, so a fresh ask after a Decline starts at `false`). Claimed by a conditional UPDATE
   * (`MessagingService.notifyJoinAsk`), so two replicas, a retried request or a re-follow of the
   * link send it once: durable state, never a timer. Meaningless once the seat is admitted.
   * Migration 043.
   */
  @Column({ type: 'boolean', default: false })
  joinAskNotified: boolean;

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
