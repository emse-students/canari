import {
  Injectable,
  OnApplicationBootstrap,
  NotFoundException,
  ForbiddenException,
  Logger,
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isUniqueViolation } from '../common/pg-errors';
import { isUnsafeObjectKey } from '../common/object-keys';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, And, LessThan, MoreThanOrEqual, type EntityManager } from 'typeorm';
import * as crypto from 'crypto';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';
import { sanitizeLog } from '../common/log.utils';
import { isBlockedBetween } from '../common/user-blocks';
import { DELIVERY_TIMEOUT_MS, deliveryUrl } from '../internal/service-urls';
import { fetchUserDeviceCount } from '../internal/delivery.client';
import {
  cancelDistributionDeparture,
  channelScope,
  createDistributionGroup,
  deleteDistributionGroup,
  evictFromDistributionGroup,
  publishDistributionGroupInfo,
  readDistributionGroup,
  workspaceScope,
  type DistributionGroupRef,
  type DistributionScope,
} from './distribution-group.client';
import {
  READ_OUTCOME_SQL,
  COMMUNITY_REMOVAL_LOCK_SQL,
  DELETE_GROUP_DEPARTURES_SQL,
  RECORD_CANCELLED_SQL,
  RECORD_DEPARTED_SQL,
} from './distribution-departures';

import {
  actorMayGrantRole,
  CHANNEL_PERMISSIONS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_MODERATOR_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  INVITE_ROLE_NOT_GRANTABLE,
  permissionsCover,
  PIN_REQUIRES_MODERATION,
  REMOVAL_EXCEEDS_ACTOR,
  ROLE_CHANGE_EXCEEDS_ACTOR,
  roleGrantsChannelManagement,
  roleGrantsModeration,
  roleGrantsRoleManagement,
  writePolicyAllows,
} from './permissions';
import { narrowAdmissionVoucher } from './admission-voucher';

import {
  CreateChannelDto,
  CreateRoleDto,
  CreateWorkspaceDto,
  ChannelLeaveDto,
  ChannelInviteDto,
  ChannelUpdateRoleDto,
  SendChannelMessageDto,
  type ChannelNotificationLevel,
  type ChannelPollMeta,
  type ServedChannelPollMeta,
  type ChannelWritePolicy,
  type HistoryVisibility,
  type WorkspaceInviteDto,
} from './dto/channel.dto';

/** One person to cut off one key-distribution group, in a departure. */
interface DepartureCut {
  scope: DistributionScope;
  userId: string;
}

/**
 * Why someone leaves a key-distribution group - the `reason` every departure line carries, so a log
 * reader can tell a kick from an access edit. A closed list: a misspelt reason is a compile error,
 * never a line no search finds.
 */
type DepartureReason =
  | 'left'
  | 'kicked'
  | 'account_deleted'
  | 'access_updated'
  | 'left_channel'
  | 'removed_from_channel'
  | 'invite_withdrawn';

/** A cut whose first eviction began a departure on chat-delivery, with the name it answered. */
interface BegunDeparture extends DepartureCut {
  groupId: string;
  departure: number;
}

/** Manages workspaces, channels, roles, members and encrypted messages. */
/**
 * How many session ids one liveness query may carry.
 *
 * A bound rather than a page: a device holding more sessions than this asks in several requests,
 * because a SILENTLY truncated answer would read as "the rest are dead" and delete live seeds.
 */
export const MAX_LIVE_SESSION_QUERY = 500;

/**
 * The largest seed frame a message may carry, in base64 characters.
 *
 * A seed frame is ~280 bytes of MLS private message (~380 in base64), estimated from RFC 9420
 * framing (channel-encryption section 19). The cap is a bound on what one sender can make every
 * recipient's push carry, not a measurement: several times the real size, and far under the 4 KB
 * a push can hold at all.
 */
export const MAX_SEED_FRAME_CHARS = 2048;

/** Standard base64, padded - what `toBase64` on the client writes and nothing else. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** An Ed25519 signature is 64 bytes, which padded base64 spells in exactly 88 characters. */
const SIGNATURE_BASE64_CHARS = 88;

/**
 * 410 code: a send repeating a message that was deleted after its first send landed (migration 090's
 * tombstone). The client forgets the send instead of offering it again.
 */
export const CHANNEL_MESSAGE_DELETED = 'CHANNEL_MESSAGE_DELETED';

/**
 * The transaction-scoped advisory lock on ONE client id (author, salon, client id), as SQL over the
 * three expressions that spell it - parameters on the send, the row's columns on the delete. Both
 * writers take it, so a delete can never fall between a send's tombstone check and its insert: the
 * send checks and inserts under it, the delete writes its tombstone and drops the row under it, and
 * whichever comes second reads what the first committed. The ONE spelling of the key, so the two
 * sides cannot hash different strings.
 */
export function clientIdLockSql(author: string, channel: string, clientId: string): string {
  return `pg_advisory_xact_lock(hashtextextended(${author}::text || ':' || ${channel}::uuid::text || ':' || ${clientId}::text, 0))`;
}

/** A client message id is what `crypto.randomUUID()` mints: a canonical UUID, either case. */
const CLIENT_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 400 code: a salon row carrying no Graine v2 signature (channel-encryption section 21.8).
 *
 * Every client `minClientVersion` admits (`1.0.3`, the G2-5 writer) signs every row it posts, so an
 * unsigned one is a modified client minting v1 or a process unlocked before the floor rose. Exported
 * so the tests name the refusal by its code, never by its sentence.
 */
export const CHANNEL_SIGNATURE_REQUIRED = 'CHANNEL_SIGNATURE_REQUIRED';

/**
 * 409 code: an access-list rewrite refused because the salon's access is no longer at the revision
 * it was computed from - the caller's `baseAccessRevision`, or the row read before the lock it is
 * saved under. Nothing was written and nobody was cut off; the body's `current` is the access as it
 * stands, and the edit may be made again against it.
 */
export const CHANNEL_ACCESS_CHANGED = 'CHANNEL_ACCESS_CHANGED';

/**
 * 409 code: an access-list rewrite refused because someone it ADDS is no longer a member of the
 * community - asked under the community's removal lock, so a kick or a departure that committed
 * while the rewrite waited is seen. Nothing was written; the body's `current` is the access as it
 * stands. Not retryable as sent: the same list names the same non-member.
 */
export const CHANNEL_GRANTEE_NOT_MEMBER = 'CHANNEL_GRANTEE_NOT_MEMBER';

/**
 * A salon's access as the settings panel reads and edits it, revision included - the one shape the
 * access read, a successful rewrite and a {@link CHANNEL_ACCESS_CHANGED} refusal all answer with.
 */
export function channelAccessState(channel: Channel) {
  return {
    channelId: channel.id,
    isPrivate: channel.isPrivate,
    allowedUsers: channel.allowedUsers || [],
    writePolicy: channel.writePolicy ?? 'everyone',
    accessRevision: channel.accessRevision,
  };
}

/**
 * 409 code: a departure that could not complete this time - its name was settled `cancelled` by the
 * drain, or a private salon was granted since its first read. The person is still a member and a
 * new departure may simply be tried again.
 */
export const DEPARTURE_SUPERSEDED = 'DEPARTURE_SUPERSEDED';

/** How many departures {@link ChannelService.removeFromWorkspace} tries before surfacing the race. */
const DEPARTURE_ATTEMPTS = 3;

/** Whether `err` is a {@link DEPARTURE_SUPERSEDED} refusal - read from its code, never its prose. */
function isDepartureSuperseded(err: unknown): boolean {
  return (
    err instanceof ConflictException &&
    (err.getResponse() as { code?: unknown }).code === DEPARTURE_SUPERSEDED
  );
}

/**
 * THE one rule for who may READ a channel, with no database in it.
 *
 *  - a public channel is readable by every community member;
 *  - a private one by the users listed in `allowedUsers`. That is the whole rule.
 *
 * It is pure because the same rule has to be evaluated two ways and must not be able to answer
 * differently: once for ONE actor on a guarded route ({@link ChannelService.canAccessChannel}) and
 * once for EVERY member when an audience is being built
 * ({@link ChannelService.channelAudience}).
 *
 * The rule had three separate implementations and the audience was not one of them: every channel
 * event was addressed to the whole community, so a private salon's ciphertext was pushed live to
 * members who could not open the channel. Sharing this function is what makes that unrepeatable -
 * `docs/wiki/protocols/channel-encryption.md` §11.
 *
 * **AN ADMIN NO LONGER READS A PRIVATE SALON THEY HAVE NOT JOINED** - the user's decision of
 * 2026-08-19, and the third argument this function used to take is gone with it. Ambient access
 * cost nothing while the seed was the community's; under a group per private salon it would make
 * every promotion to admin a commit on EVERY private salon. An admin still SEES that such a salon
 * exists and may add themselves to it in one act, which costs one commit at that moment and
 * nothing afterwards - and it means a private salon's members can finally see who reads it, which
 * ambient access made impossible.
 */
export function channelIsReadableBy(
  channel: Pick<Channel, 'isPrivate' | 'allowedUsers'>,
  userId: string
): boolean {
  if (!channel.isPrivate) return true;
  return (channel.allowedUsers || []).includes(userId.trim().toLowerCase());
}

/**
 * The name of the salon every community is born with. It carries the accent: it is shown as typed,
 * like any other salon name.
 */
export const DEFAULT_CHANNEL_NAME = 'g\u00e9n\u00e9ral';

/** Longest salon name, counted in characters a person sees (code points), not UTF-16 units. */
export const MAX_CHANNEL_NAME_LENGTH = 80;

/**
 * A salon name is a DISPLAY name: stored exactly as typed (case, accents, emoji, spaces), and never
 * an identifier - routing and every reference use the channel id. Only what would break a row of
 * the sidebar is refused: nothing once trimmed, too long, or a control character.
 */
export function validateChannelName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new BadRequestException('Channel name cannot be empty');
  if (Array.from(name).length > MAX_CHANNEL_NAME_LENGTH)
    throw new BadRequestException(
      `Channel name too long (max ${MAX_CHANNEL_NAME_LENGTH} characters)`
    );
  if (/\p{Cc}/u.test(name))
    throw new BadRequestException('Channel name cannot contain control characters');
  return name;
}

/** The community's own order: the arranged position, then age, then id so it is total. */
export function sortChannels<T extends Pick<Channel, 'id' | 'sortOrder' | 'createdAt'>>(
  channels: T[]
): T[] {
  return [...channels].sort(
    (a, b) =>
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      a.id.localeCompare(b.id)
  );
}

/**
 * The instant unread counting starts for a salon the member has no mark in. See
 * {@link ChannelService.listUnreadCounts}. A date, not a flag: it never needs to move again.
 */
export const UNREAD_TRACKED_SINCE_MS = Date.UTC(2026, 9, 8);

/** What the outbox entry of a salon row keeps for its push (migration 093). */
export interface ChannelFanoutPayload {
  mentionedUserIds?: string[];
  seedFrame?: string;
  seedGroupId?: string;
}

@Injectable()
export class ChannelService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChannelService.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';

  /** Normalises a French or English role label to one of three canonical values: admin, moderator, or member. */
  private normalizeRoleLabelToCanonical(name?: string | null): 'admin' | 'moderator' | 'member' {
    const normalized = String(name || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (
      normalized === 'administrateur' ||
      normalized === 'administrator' ||
      normalized === 'admin'
    ) {
      return 'admin';
    }
    if (normalized === 'moderateur' || normalized === 'moderator') {
      return 'moderator';
    }
    return 'member';
  }

  /** Maps any role name input to the canonical display name stored in the workspace roles table. */
  private mapRoleInputToWorkspaceRoleName(name?: string | null): string {
    const normalized = String(name || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (!normalized || normalized === 'member' || normalized === 'membre') return 'Membre';
    if (
      normalized === 'admin' ||
      normalized === 'administrateur' ||
      normalized === 'administrator'
    ) {
      return 'Administrateur';
    }
    if (normalized === 'moderator' || normalized === 'moderateur' || normalized === 'modérateur') {
      return 'Modérateur';
    }
    return name?.trim() || 'Membre';
  }

  /**
   * Returns true if the calling user holds a specific workspace-level permission
   * (derived from their role memberships). An admin (workspace.manage) implicitly
   * holds every permission, so this returns true for any permission an admin is checked for.
   */
  private async memberHasWorkspacePermission(
    workspaceId: string,
    userId: string,
    permission: string
  ): Promise<boolean> {
    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member?.roleIds?.length) return false;
    const roles = await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    return roles.some(
      (r) =>
        r.permissions.includes(permission) ||
        r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)
    );
  }

  /**
   * Whether ONE actor may read `channel`. {@link channelIsReadableBy}, and nothing else.
   *
   * It used to spend a permission query so an admin could fall through to every private salon.
   * That fallback went with the per-salon distribution group (see the rule's own header), which
   * makes this both stricter and cheaper: no database at all.
   *
   * Reading/joining is independent of who may write (see canWriteToChannel).
   */
  private canAccessChannel(channel: Channel, _member: ChannelMember, userId?: string): boolean {
    if (!channel.isPrivate) return true;
    if (!userId) return false;
    return channelIsReadableBy(channel, userId.trim().toLowerCase());
  }

  /**
   * WHO A CHANNEL EVENT MAY BE ADDRESSED TO - the accessible subset of the community, never the
   * community.
   *
   * Every event a channel emits used to go to `getWorkspaceMemberIds`, which answers a question
   * about the CONTAINER. For a private salon that handed its ciphertext, its typing, its pins and
   * its poll tallies to members the server would refuse to serve it over REST - and since the
   * Graine seed travels on the community's distribution group, those members held the key as well.
   * An audience is derived from ACCESS or it is not an access control.
   *
   * One `find` for the roles and one for the members, whatever the size of the roster, so this is
   * usable on the send path. A public channel skips the role load entirely.
   *
   * @returns the user ids that may read `channel`. Never includes a non-member.
   */
  private async channelAudience(channel: Channel): Promise<string[]> {
    const members = await this.memberRepo.find({ where: { workspaceId: channel.workspaceId } });
    if (!channel.isPrivate) return members.map((m) => m.userId);
    // ONE query now, not two: the role load existed only to find the admins who read every private
    // salon ambiently, and there are none. `allowedUsers` is the roster, and it is also exactly the
    // roster of this salon's distribution group - which is what makes the two impossible to drift.
    return members.filter((m) => channelIsReadableBy(channel, m.userId)).map((m) => m.userId);
  }

  /**
   * Whether `userId` may post in `channel`, per its writePolicy:
   *  - `everyone` (default) → any member (access is checked separately);
   *  - `admins_moderators` → roles carrying channel.moderate or workspace.manage;
   *  - `admins` → roles carrying workspace.manage.
   */
  private async canWriteToChannel(channel: Channel, userId: string): Promise<boolean> {
    const policy: ChannelWritePolicy = channel.writePolicy ?? 'everyone';
    if (policy === 'everyone') return true;
    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member?.roleIds?.length) return false;
    const roles = await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    // THE RULE IS IN `writePolicyAllows` AND NOWHERE ELSE - the listing decides the same thing for
    // the same viewer and must reach the same answer. What is resolved here is only who the viewer
    // IS, which is the part that costs a query.
    //
    // `roleGrantsModeration` rather than a second list of keys: this branch used to check
    // `channel.moderate` and `workspace.manage` and to omit `channel.manage`, which the listing's
    // own `viewerCanModerate` has always counted - so a role holding only `channel.manage` was a
    // moderator everywhere except here.
    return writePolicyAllows(policy, {
      canManage: roles.some((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)),
      canModerate: roles.some((r) => roleGrantsModeration(r.permissions)),
    });
  }

  /**
   * Who, among `userIds`, may write in `channel` - the same decision {@link canWriteToChannel}
   * enforces and the workspace listing answers, computed for a whole audience at once.
   *
   * TWO QUERIES WHATEVER THE AUDIENCE'S SIZE, because the roles are a property of the workspace and
   * not of the reader: resolving them per user would be one round trip per member of a community
   * every time an administrator saves the access panel.
   *
   * A user the workspace has no member row for gets `false` under a restricted policy - they hold
   * no roles, which is what the policy asks about. Under `everyone` nobody is asked at all.
   */
  private async writeDecisionsFor(
    channel: Channel,
    userIds: string[]
  ): Promise<Map<string, boolean>> {
    const policy: ChannelWritePolicy = channel.writePolicy ?? 'everyone';
    const decisions = new Map<string, boolean>();
    if (policy === 'everyone') {
      for (const id of userIds) decisions.set(id, true);
      return decisions;
    }

    const members = await this.memberRepo.find({ where: { workspaceId: channel.workspaceId } });
    const roles = await this.roleRepo.find({ where: { workspaceId: channel.workspaceId } });
    const manageRoleIds = new Set(
      roles
        .filter((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))
        .map((r) => r.id)
    );
    const moderateRoleIds = new Set(
      roles.filter((r) => roleGrantsModeration(r.permissions)).map((r) => r.id)
    );
    const byUser = new Map(members.map((m) => [m.userId.trim().toLowerCase(), m]));

    for (const id of userIds) {
      const roleIds = byUser.get(id.trim().toLowerCase())?.roleIds ?? [];
      decisions.set(
        id,
        writePolicyAllows(policy, {
          canManage: roleIds.some((r) => manageRoleIds.has(r)),
          canModerate: roleIds.some((r) => moderateRoleIds.has(r)),
        })
      );
    }
    return decisions;
  }

  /**
   * Whether `member` may act on OTHER members' messages in their workspace - the concrete
   * meaning of the `channel.moderate` permission advertised in the role matrix ("pin any message,
   * delete other members' ones"). MANAGE_CHANNEL and MANAGE_WORKSPACE subsume it.
   *
   * Every moderation entry point (pin, delete, close poll) routes through here so the matrix
   * and the enforcement can never drift apart.
   */
  private async memberCanModerateMessages(member: ChannelMember): Promise<boolean> {
    if (!member.roleIds?.length) return false;
    const roles = await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    return roles.some((r) => roleGrantsModeration(r.permissions));
  }

  // ================= THE GOVERNANCE POSTCONDITION =================
  //
  // Every community operation used to check what the ACTOR may do, and never what the community
  // would be LEFT AS. That is one absent postcondition seen from five sides - leaving, being
  // kicked, being demoted, joining by link, and having one's account deleted - so guarding any of
  // them alone leaves the hole open. Measured on prod 2026-08-17: 15 of 29 communities had exactly
  // one admin and 5 had no members at all.
  //
  // The invariant, enforced server-side as a REFUSAL wherever a refusal is possible:
  //   a community has at least one admin, or it has no members.
  // No repair route exists to put a broken community back, deliberately: making the state
  // unreachable is strictly better than shipping a destructive button that restores it.

  /**
   * The user ids holding an admin role in this workspace, where "admin" means MANAGE_WORKSPACE -
   * the permission that can grant every other one back, and therefore the only one whose
   * disappearance a community cannot recover from on its own.
   *
   * Reads roles then members rather than joining: `channel_members.roleIds` is a `simple-array`
   * text column, so there is no indexable join to make here anyway.
   */
  private async listWorkspaceAdminIds(workspaceId: string): Promise<string[]> {
    const roles = await this.roleRepo.find({ where: { workspaceId } });
    const adminRoleIds = new Set(
      roles
        .filter((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))
        .map((r) => r.id)
    );
    if (adminRoleIds.size === 0) return [];
    const members = await this.memberRepo.find({ where: { workspaceId } });
    return members
      .filter((m) => (m.roleIds ?? []).some((id) => adminRoleIds.has(id)))
      .map((m) => m.userId);
  }

  /**
   * Refuses to remove `targetUserId` when that would leave the community with members and no
   * admin. Shared by leaving and being kicked, which are the same removal seen from two ends.
   *
   * The LAST member leaving is not this case and is allowed: a community with nobody in it is
   * deleted outright rather than left ungoverned - see {@link hardDeleteWorkspace}.
   */
  private async assertRemovalKeepsAnAdmin(
    workspaceId: string,
    targetUserId: string
  ): Promise<void> {
    const adminIds = await this.listWorkspaceAdminIds(workspaceId);
    if (adminIds.length !== 1 || adminIds[0] !== targetUserId) return;

    const memberIds = await this.getWorkspaceMemberIds(workspaceId);
    if (memberIds.every((id) => id === targetUserId)) return;

    this.logger.warn(
      `[WORKSPACE] refused removal of the last admin workspace=${workspaceId} target=${targetUserId.slice(0, 8)} members=${memberIds.length}`
    );
    throw new BadRequestException({
      code: 'WORKSPACE_WOULD_HAVE_NO_ADMIN',
      message: 'The community would be left with no administrator.',
    });
  }

  /**
   * Runs `work` in ONE transaction that first takes the community's removal lock
   * ({@link COMMUNITY_REMOVAL_LOCK_SQL}, transaction-scoped), so every removal and every private
   * creation in one community is serialised, and a permission checked inside `work` against rows
   * read `FOR SHARE` still holds when `work` writes. No call to another service belongs in `work`.
   */
  private withCommunityRemovalLock<T>(
    workspaceId: string,
    work: (m: EntityManager) => Promise<T>
  ): Promise<T> {
    return this.memberRepo.manager.transaction(async (m) => {
      await m.query(COMMUNITY_REMOVAL_LOCK_SQL, [workspaceId]);
      this.logger.debug(`[WORKSPACE] removal lock held workspace=${workspaceId}`);
      return work(m);
    });
  }

  /**
   * THE ONE WAY ANYONE LEAVES A KEY-DISTRIBUTION GROUP - a community's or a private salon's, by
   * leaving, being kicked or removed, losing access, or having their account erased. Every departure
   * in this file comes through here, so the next one cannot forget a step.
   *
   * 1. FIRST EVICTION, BEFORE THE ROSTER WRITE, AND ALLOWED TO ABORT THE DEPARTURE. The two halves
   *    of a departure are not symmetric: this one is immediate and needs nobody online, while
   *    removing their MLS leaf is a commit only a remaining member's device can produce. If this
   *    failed and the roster write went through anyway, the leaver would go on being routed every
   *    seed frame with no row left anywhere to say they should not be. Failing here leaves them a
   *    member and the departure retryable. chat-delivery records the departure as IN PROGRESS
   *    (no seat is written for them meanwhile) and answers its NAME.
   * 2. THE ROSTER WRITE AND THE NAMES, IN ONE TRANSACTION. `rosterWrite` removes the roster rows,
   *    and each departure's name is recorded `departed` beside it (`distribution_departures`) - so
   *    the record exists exactly when the roster write committed. If chat-delivery's drain already
   *    decided that name `cancelled`, the record is refused and the whole departure rolls back:
   *    the person stays a member, and a retry begins a new departure.
   * 3. SECOND EVICTION, AFTER THE COMMIT, naming the departure it settles. Between 1 and 3 the
   *    entitlement still answers `true` (the leaver is on the roster until 2 commits), so the first
   *    eviction alone cannot exclude a seat claimed in that gap; the second one cuts it. It cannot
   *    abort anything - the roster write is done - so a failure is logged at error, and
   *    chat-delivery's hourly drain asks {@link decideDistributionDeparture} how it ended.
   *
   * ABANDONED, IT IS SETTLED AT ONCE. When a later first eviction or the transaction fails, every
   * departure already begun is decided `cancelled` here ({@link decideDistributionDeparture}) and
   * chat-delivery is told, so the person - still a member - is not held seatless until the drain.
   * The original error is rethrown; a step that fails here is logged and left to the drain.
   *
   * AN UNNAMED FIRST EVICTION (a chat-delivery build that does not name departures, during a
   * rolling deploy) is logged and followed, after the roster write, by a plain eviction - the
   * cut-twice shape that build understands.
   *
   * THE COMMUNITY'S REMOVAL LOCK OPENS THE TRANSACTION ({@link COMMUNITY_REMOVAL_LOCK_SQL}), so a
   * caller may re-check a permission inside `rosterWrite` against writes serialised on the same
   * community. A refusal thrown there is an abandoned departure like any other: the transaction
   * rolls back (no `departed` record, no roster change) and the departure is settled `cancelled`.
   * The first evictions stay before the transaction, so no HTTP call runs under the lock.
   *
   * channel-encryption, "WP-21, and the gate it had nowhere to live".
   *
   * @param cuts the groups and people to cut, one entry per person per scope
   * @param workspaceId the community the departure belongs to, whose removal lock the roster write
   *   holds
   * @param rosterWrite the roster change, written through the transaction's manager, under the lock
   */
  private async departDistributionGroups(
    cuts: DepartureCut[],
    reason: DepartureReason,
    workspaceId: string,
    rosterWrite: (m: EntityManager) => Promise<void>
  ): Promise<void> {
    const begun: BegunDeparture[] = [];
    const unnamed: DepartureCut[] = [];
    try {
      for (const cut of cuts) {
        const first = await evictFromDistributionGroup(this.internalSecret, cut.scope, cut.userId);
        if (!first.evicted) {
          // NOT the same line as a cut that found nothing, and the difference is the whole report: a
          // scope with no distribution group has no key distribution to stop, while three zeros
          // under the line below would read as one that was cut clean. A community warns, because on
          // a post-Graine community it means the group is missing and every seed frame is unrouted.
          const line =
            `[KEY_DISTRIBUTION] no distribution group to cut scope=${cut.scope.kind}:${cut.scope.id} ` +
            `user=${cut.userId.slice(0, 8)} reason=${reason}`;
          if (cut.scope.kind === 'workspace')
            this.logger.warn(`${line} - pre-Graine community, or its group is gone`);
          else this.logger.log(line);
          continue;
        }
        // ALL THREE COUNTS, EACH UNDER ITS OWN NAME: rows are what a reconnect reads, the Redis set
        // is what a live fanout reads, and the queue is what an offline device collects next.
        this.logger.log(
          `[KEY_DISTRIBUTION] key distribution cut scope=${cut.scope.kind}:${cut.scope.id} ` +
            `user=${cut.userId.slice(0, 8)} reason=${reason} memberships=${first.memberships} ` +
            `routes=${first.routes} queued=${first.queued} departure=${first.begun?.departure ?? 'none'}`
        );
        if (first.begun) begun.push({ ...cut, ...first.begun });
        else {
          this.logger.warn(
            `[KEY_DISTRIBUTION] first eviction named NO departure scope=${cut.scope.kind}:${cut.scope.id} ` +
              `user=${cut.userId.slice(0, 8)} reason=${reason} - an older chat-delivery; a plain ` +
              `eviction follows the roster write`
          );
          unnamed.push(cut);
        }
      }

      await this.withCommunityRemovalLock(workspaceId, async (m) => {
        for (const b of begun) {
          const recorded = (await m.query(RECORD_DEPARTED_SQL, [
            b.groupId,
            b.userId,
            b.departure,
          ])) as unknown[];
          if (recorded.length === 0) {
            this.logger.warn(
              `[KEY_DISTRIBUTION] departure CANCELLED before its roster write scope=${b.scope.kind}:${b.scope.id} ` +
                `user=${b.userId.slice(0, 8)} departure=${b.departure} reason=${reason} - rolled back, retryable`
            );
            throw new ConflictException({
              code: DEPARTURE_SUPERSEDED,
              message: 'The departure could not be completed, retry.',
            });
          }
        }
        await rosterWrite(m);
      });
    } catch (e) {
      this.logger.warn(
        `[KEY_DISTRIBUTION] departure ABANDONED reason=${reason} begun=${begun.length}: ` +
          `${e instanceof Error ? e.message : String(e)} - settling what it began`
      );
      await this.settleAbandonedDepartures(begun, reason);
      throw e;
    }

    for (const cut of unnamed) {
      try {
        const second = await evictFromDistributionGroup(this.internalSecret, cut.scope, cut.userId);
        this.logger.log(
          `[KEY_DISTRIBUTION] second eviction (unnamed) scope=${cut.scope.kind}:${cut.scope.id} ` +
            `user=${cut.userId.slice(0, 8)} reason=${reason} evicted=${second.evicted} ` +
            `departure=${second.begun?.departure ?? 'none'}`
        );
      } catch (e) {
        this.logger.error(
          `[KEY_DISTRIBUTION] second eviction (unnamed) FAILED scope=${cut.scope.kind}:${cut.scope.id} ` +
            `user=${cut.userId.slice(0, 8)} reason=${reason}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    for (const b of begun) {
      try {
        const second = await evictFromDistributionGroup(
          this.internalSecret,
          b.scope,
          b.userId,
          b.departure
        );
        this.logger.log(
          `[KEY_DISTRIBUTION] second eviction scope=${b.scope.kind}:${b.scope.id} user=${b.userId.slice(0, 8)} ` +
            `reason=${reason} departure=${b.departure} evicted=${second.evicted} ` +
            `memberships=${second.memberships} routes=${second.routes}`
        );
      } catch (e) {
        this.logger.error(
          `[KEY_DISTRIBUTION] second eviction FAILED scope=${b.scope.kind}:${b.scope.id} ` +
            `user=${b.userId.slice(0, 8)} reason=${reason} departure=${b.departure}: ` +
            `${e instanceof Error ? e.message : String(e)} - the departure stays in progress on ` +
            `chat-delivery until its hourly drain asks how it ended`
        );
      }
    }
  }

  /**
   * Settles the departures an abandoned {@link departDistributionGroups} had begun: each is decided
   * ({@link decideDistributionDeparture}) and chat-delivery is told - `cancelled` settles it with
   * nothing evicted, `departed` (a roster write that did commit before the error) gets its second
   * eviction. Each step is caught and logged on its own; one left unsettled is the drain's.
   */
  private async settleAbandonedDepartures(
    begun: BegunDeparture[],
    reason: DepartureReason
  ): Promise<void> {
    for (const b of begun) {
      const where =
        `scope=${b.scope.kind}:${b.scope.id} user=${b.userId.slice(0, 8)} ` +
        `departure=${b.departure} reason=${reason}`;
      try {
        const outcome = await this.decideDistributionDeparture(b.groupId, b.userId, b.departure);
        const settled =
          outcome === 'cancelled'
            ? await cancelDistributionDeparture(this.internalSecret, b.scope, b.userId, b.departure)
            : (
                await evictFromDistributionGroup(
                  this.internalSecret,
                  b.scope,
                  b.userId,
                  b.departure
                )
              ).evicted;
        this.logger.log(
          `[KEY_DISTRIBUTION] abandoned departure settled ${where} outcome=${outcome} settled=${settled}`
        );
      } catch (e) {
        this.logger.error(
          `[KEY_DISTRIBUTION] abandoned departure NOT settled ${where}: ` +
            `${e instanceof Error ? e.message : String(e)} - chat-delivery's hourly drain settles it`
        );
      }
    }
  }

  /**
   * How the departure `departure` of `userId` from chat-delivery's group `groupId` ended - asked by
   * chat-delivery's hourly drain for a departure whose second eviction never arrived, and by an
   * abandoned departure ({@link settleAbandonedDepartures}).
   *
   * IT DECIDES AS IT ANSWERS. When the roster write has not recorded the departure, this records it
   * `cancelled`, and the shared primary key then refuses the roster write's record, rolling the
   * departure back ({@link departDistributionGroups}). So the answer is final, never "not yet". Two
   * statements, not one: the insert waits for a roster write in flight to commit or roll back, and
   * only a statement started AFTER that wait sees its row.
   *
   * A PERSON NO LONGER ENTITLED, WITH NOTHING RECORDED, IS ANSWERED `departed` AND NOTHING IS
   * WRITTEN. Their roster rows are gone - by another departure, by the group's scope ending, or by an
   * account erasure - so no roster write can restore them under this name, and cutting their seats
   * is right whatever ended it. Recording nothing is what keeps an erased account's id out of this
   * table after its erasure deleted its rows. A roster write still in flight leaves the person
   * visible as entitled, so it takes the recording path and waits for it.
   */
  async decideDistributionDeparture(
    groupId: string,
    userId: string,
    departure: number
  ): Promise<'departed' | 'cancelled'> {
    const manager = this.memberRepo.manager;
    if (!(await this.isEntitledToDistributionGroupId(groupId, userId))) {
      const recorded = (await manager.query(READ_OUTCOME_SQL, [
        groupId,
        userId,
        departure,
      ])) as Array<{
        outcome: 'departed' | 'cancelled';
      }>;
      const outcome = recorded[0]?.outcome ?? 'departed';
      this.logger.log(
        `[KEY_DISTRIBUTION] departure outcome group=${groupId} user=${userId.slice(0, 8)} departure=${departure} ` +
          `outcome=${outcome} entitled=false recorded=${recorded.length > 0}`
      );
      return outcome;
    }
    await manager.query(RECORD_CANCELLED_SQL, [groupId, userId, departure]);
    const rows = (await manager.query(READ_OUTCOME_SQL, [groupId, userId, departure])) as Array<{
      outcome: 'departed' | 'cancelled';
    }>;
    const outcome = rows[0]?.outcome;
    if (outcome !== 'departed' && outcome !== 'cancelled') {
      this.logger.error(
        `[KEY_DISTRIBUTION] departure outcome UNREADABLE group=${groupId} user=${userId.slice(0, 8)} departure=${departure}`
      );
      throw new ServiceUnavailableException('The departure outcome could not be read.');
    }
    this.logger.log(
      `[KEY_DISTRIBUTION] departure outcome group=${groupId} user=${userId.slice(0, 8)} departure=${departure} outcome=${outcome}`
    );
    return outcome;
  }

  /** The cut of a salon's own group: none for a public salon, or one that has no group. */
  private channelCuts(channel: Channel, userIds: readonly string[]): DepartureCut[] {
    if (!channel.isPrivate || !channel.distributionGroupId) return [];
    return userIds.map((userId) => ({ scope: channelScope(channel.id), userId }));
  }

  /**
   * Gives a PRIVATE salon its own distribution group, or returns the one it already has.
   *
   * BEFORE THE ROW IS CALLED PRIVATE, AND ALLOWED TO ABORT THAT. A salon marked private whose group
   * could not be created is a salon whose seeds have nowhere to go: the client would fall back to
   * nothing, or worse, to the community's group - which is the sharing this whole scope exists to
   * end. Failing here leaves the salon as it was, which is the only state that stays reconcilable
   * (the same rule `createWorkspace` and `hardDeleteWorkspace` already follow).
   *
   * THE PRECONDITION IS THE CALLER'S INTENT, NEVER THE ROW. `channel.isPrivate` is what the salon
   * still IS, and on the public -> private path that is `false` right up to the save this mint has
   * to happen before - so a guard reading the row refused every salon that was becoming private,
   * which is one of the two paths that reaches here. The fact was known at the call site all along;
   * it is passed rather than re-derived from a row that answers a different question.
   *
   * Idempotent on the delivery side through a partial unique index, so a retry costs nothing.
   */
  private async ensureChannelDistributionGroup(
    channel: Channel,
    willBePrivate: boolean
  ): Promise<string> {
    if (!willBePrivate) {
      throw new Error(`ensureChannelDistributionGroup called for public channel ${channel.id}`);
    }
    const groupId = await createDistributionGroup(this.internalSecret, channelScope(channel.id));
    if (channel.distributionGroupId !== groupId) {
      channel.distributionGroupId = groupId;
      // THE ONE COLUMN, never `save(channel)`: the copy was read outside any lock, and a save writes
      // back every column it differs on - a concurrent flip's `isPrivate` and allowlist included.
      await this.channelRepo.update({ id: channel.id }, { distributionGroupId: groupId });
    }
    this.logger.log(`[CHANNEL_GRAINE] group ready channel=${channel.id} group=${groupId}`);
    return groupId;
  }

  /**
   * Tombstones a salon's own distribution group, when it stops being private or stops existing.
   *
   * Best-effort ON PURPOSE, unlike every other call in this file, and the asymmetry is the point: a
   * group left behind distributes seeds to a roster nobody consults any more, which is inert, while
   * refusing the archive over it would leave a salon nobody can delete. The line below is what
   * makes the leftover findable - the standing rule is that a swallowed branch logs.
   */
  private async retireChannelDistributionGroup(channel: Channel, reason: string): Promise<void> {
    if (!channel.distributionGroupId) return;
    const groupId = channel.distributionGroupId;
    try {
      await deleteDistributionGroup(this.internalSecret, channelScope(channel.id));
      channel.distributionGroupId = null;
      // The one column, for the reason `ensureChannelDistributionGroup` gives.
      await this.channelRepo.update({ id: channel.id }, { distributionGroupId: null });
      await this.memberRepo.manager.query(DELETE_GROUP_DEPARTURES_SQL, [[groupId]]);
      this.logger.log(
        `[CHANNEL_GRAINE] group retired channel=${channel.id} group=${groupId} reason=${reason}`
      );
    } catch (e) {
      this.logger.error(
        `[CHANNEL_GRAINE] could NOT retire channel=${channel.id} group=${groupId} reason=${reason}: ` +
          `${e instanceof Error ? e.message : String(e)} - the group outlives its salon and must be reaped by hand`
      );
    }
  }

  /**
   * Announces a salon to the people a save just let in, so the grant routes them as well as name them.
   *
   * THE COUNTERPART {@link updateChannelAccess} NEVER HAD. That method computes who a save DROPS and
   * cuts them off one line later, and had no symmetric act for the people it ADDS - so entitlement
   * and routing were two events, one of which nobody ever sent. Every other grant in this file
   * publishes exactly this, immediately after the row changes, and for exactly this reason: the
   * client registers the salon on receipt and, when it is private, enters its distribution group
   * there and then. Without it a grant was a database row and nothing else until the recipient's
   * next full load.
   *
   * `invitedBy` and `joinedBy` ARE DELIBERATELY ABSENT. A receiving client writes an "X added Y"
   * system message into the transcript when both are present, and this is a settings-panel roster
   * edit rather than an invitation - carrying them would have written one line per member into the
   * transcript of a salon nobody had joined.
   */
  private async announceChannelAccessGranted(channel: Channel, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const workspace = await this.workspaceRepo.findOne({ where: { id: channel.workspaceId } });
    await this.redis.publishChannelEvent(
      'channel.member.joined',
      {
        channelId: channel.id,
        channelName: channel.name,
        workspaceId: channel.workspaceId,
        workspaceSlug: workspace?.slug,
        workspaceName: workspace?.name,
        visibility: channel.isPrivate ? 'private' : 'public',
      },
      userIds
    );
    this.logger.log(
      `[CHANNEL] access granted channel=${channel.id} private=${channel.isPrivate} ` +
        `announced=${userIds.length}`
    );
  }

  /**
   * The private salons of a community that name `userId` - what a departure from the community must
   * take them out of, roster and routing both.
   *
   * The community's own cut says nothing about these: each private salon has its own group and its
   * own routing rows, so a departure that only cut the community's would leave the leaver routed
   * every seed of every private salon they were in.
   *
   * THE ROSTER GOES TOO ({@link stripFromChannels}), and that is not tidiness. `allowedUsers` is the
   * authorization, so a leaver still named there would have private access restored the moment they
   * rejoined the community - and `reconcileDistributionGroupRoster` diffs the MLS tree against
   * exactly this list, so their leaf would be re-authorised at every reconciliation. The count is
   * logged even at zero - a sweep that reports nothing is a sweep nobody can tell ran.
   */
  private async heldPrivateChannels(
    workspaceId: string,
    userId: string,
    reason: DepartureReason
  ): Promise<Channel[]> {
    const normalised = userId.trim().toLowerCase();
    const privateChannels = await this.channelRepo.find({
      where: { workspaceId, isPrivate: true },
    });
    const held = privateChannels.filter((c) => (c.allowedUsers || []).includes(normalised));
    this.logger.log(
      `[CHANNEL_GRAINE] private salons to cut workspace=${workspaceId} user=${userId.slice(0, 8)} ` +
        `reason=${reason} salons=${held.length}/${privateChannels.length}`
    );
    return held;
  }

  /**
   * Adds `userId` to a PRIVATE salon's `allowedUsers`, on the row re-read `FOR UPDATE` in its own
   * transaction - never by saving a copy read earlier, which would write back an allowlist a
   * concurrent removal had already changed (the removed member restored with no seat).
   *
   * THE GRANTEE IS RE-CHECKED UNDER THE SAME TRANSACTION: their membership row (and, given
   * `requiredPermission`, the roles it names) is read with a shared row lock, so a kick or a
   * demotion that committed since the caller's reads refuses the grant, and one still in flight waits
   * for it. A kick's roster write re-reads the community's private salons under its lock
   * ({@link removeFromWorkspace}), so a grant committed before it is seen there.
   *
   * @returns `granted` with the row as written, or why nothing was granted: the salon is `gone`,
   *   is `public` now, or the grantee is `not_member` / `not_allowed` any more
   */
  private async grantPrivateChannelAccess(
    channelId: string,
    userId: string,
    requiredPermission?: string
  ): Promise<
    | { outcome: 'granted'; channel: Channel }
    | { outcome: 'gone' | 'public' | 'not_member' | 'not_allowed' }
  > {
    const normalised = userId.trim().toLowerCase();
    const result = await this.memberRepo.manager.transaction(async (m) => {
      const locked = await m.getRepository(Channel).findOne({
        where: { id: channelId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) return { outcome: 'gone' as const };
      if (!locked.isPrivate) return { outcome: 'public' as const };
      const member = await m.getRepository(ChannelMember).findOne({
        where: { workspaceId: locked.workspaceId, userId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!member) return { outcome: 'not_member' as const };
      if (
        requiredPermission &&
        !(await this.permissionsOfMember(member, m)).includes(requiredPermission)
      ) {
        return { outcome: 'not_allowed' as const };
      }
      const allowed = locked.allowedUsers || [];
      if (!allowed.includes(normalised)) {
        locked.allowedUsers = [...allowed, normalised];
        // A NEW REVISION: a settings panel holding the list without this grantee must not save it.
        locked.accessRevision += 1;
        await m
          .getRepository(Channel)
          .update(
            { id: channelId },
            { allowedUsers: locked.allowedUsers, accessRevision: locked.accessRevision }
          );
      }
      return { outcome: 'granted' as const, channel: locked };
    });
    if (result.outcome !== 'granted') {
      this.logger.warn(
        `[CHANNEL] grant refused channel=${channelId} user=${userId.slice(0, 8)} outcome=${result.outcome}`
      );
    }
    return result;
  }

  /**
   * Removes `userId` from each salon's `allowedUsers`, through the departure's transaction `m`.
   *
   * EACH ROW IS RE-READ `FOR UPDATE` before it is written. `channels` was read before the lock, and
   * saving that copy would write back an allowlist another request changed meanwhile - an add
   * granted in between would be lost. The caller's copy is brought up to date, since it goes on to
   * name the salon's audience.
   */
  private async stripFromChannels(
    m: EntityManager,
    channels: Channel[],
    userId: string
  ): Promise<void> {
    const normalised = userId.trim().toLowerCase();
    for (const channel of channels) {
      const locked = await m.getRepository(Channel).findOne({
        where: { id: channel.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) {
        this.logger.warn(
          `[CHANNEL] salon gone before its roster write channel=${channel.id} user=${userId.slice(0, 8)}`
        );
        continue;
      }
      const before = locked.allowedUsers || [];
      locked.allowedUsers = before.filter((u) => u !== normalised);
      // A NEW REVISION when the list changed: a settings panel still showing this user must not
      // rewrite a list that no longer names them as if nothing had happened. Unchanged, it stays.
      if (locked.allowedUsers.length !== before.length) locked.accessRevision += 1;
      await m.getRepository(Channel).save(locked);
      // THE WHOLE ACCESS FROM THE LOCKED ROW, never half of it: a caller answering this copy (the
      // per-member DELETE) would otherwise pair this revision with a visibility read before the lock.
      channel.isPrivate = locked.isPrivate;
      channel.writePolicy = locked.writePolicy;
      channel.allowedUsers = locked.allowedUsers;
      channel.accessRevision = locked.accessRevision;
    }
  }

  /**
   * Takes `userId` out of a community: its key group, every private salon naming them (roster and
   * group), and their membership row - one departure ({@link departDistributionGroups}). Shared by
   * leaving, being kicked and an account erasure, which are the same removal seen from three ends.
   *
   * A {@link DEPARTURE_SUPERSEDED} race is retried here, up to {@link DEPARTURE_ATTEMPTS} departures,
   * each reading the salons again; only a race that outlasts them reaches the caller.
   *
   * @param guard a check re-run under the community removal lock before the roster write (a kick's
   *   removal bound); a refusal there abandons the departure
   */
  private async removeFromWorkspace(
    workspaceId: string,
    userId: string,
    reason: DepartureReason,
    guard?: (m: EntityManager) => Promise<void>
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.departFromWorkspace(workspaceId, userId, reason, guard);
        return;
      } catch (e) {
        if (!isDepartureSuperseded(e) || attempt >= DEPARTURE_ATTEMPTS) throw e;
        this.logger.warn(
          `[KEY_DISTRIBUTION] departure superseded, retrying workspace=${workspaceId} ` +
            `user=${userId.slice(0, 8)} reason=${reason} attempt=${attempt}/${DEPARTURE_ATTEMPTS}`
        );
      }
    }
  }

  /** One attempt of {@link removeFromWorkspace}: the salons read now, then one departure. */
  private async departFromWorkspace(
    workspaceId: string,
    userId: string,
    reason: DepartureReason,
    guard?: (m: EntityManager) => Promise<void>
  ): Promise<void> {
    const held = await this.heldPrivateChannels(workspaceId, userId, reason);
    const cuts: DepartureCut[] = [
      { scope: workspaceScope(workspaceId), userId },
      ...held.flatMap((c) => this.channelCuts(c, [userId])),
    ];
    await this.departDistributionGroups(cuts, reason, workspaceId, async (m) => {
      if (guard) await guard(m);
      // THE PRIVATE SALONS ARE READ AGAIN, ROW-LOCKED. `held` and its cuts came from a read before
      // the lock; a grant committed since (`grantPrivateChannelAccess`) names the user on a salon
      // whose group this departure never cut, and the strip below would leave them on its roster
      // with no membership. Refused whole and retryable; a grant still in flight waits for this
      // transaction and then finds no membership.
      const normalised = userId.trim().toLowerCase();
      const heldIds = new Set(held.map((c) => c.id));
      const late = (
        await m.getRepository(Channel).find({
          where: { workspaceId, isPrivate: true },
          // ONE LOCK ORDER for salon rows, by id: a departure locking several must not cross another.
          order: { id: 'ASC' },
          lock: { mode: 'pessimistic_write' },
        })
      ).filter((c) => (c.allowedUsers || []).includes(normalised) && !heldIds.has(c.id));
      if (late.length > 0) {
        this.logger.warn(
          `[KEY_DISTRIBUTION] departure SUPERSEDED - granted a private salon since its read ` +
            `workspace=${workspaceId} user=${userId.slice(0, 8)} reason=${reason} salons=${late.length}`
        );
        throw new ConflictException({
          code: DEPARTURE_SUPERSEDED,
          message: 'The departure could not be completed, retry.',
        });
      }
      await this.stripFromChannels(m, held, userId);
      await m.getRepository(ChannelMember).delete({ workspaceId, userId });
    });
  }

  /**
   * Deletes a community and everything under it, for real, in one transaction.
   *
   * There is not ONE foreign key on `channel_workspaces` or `channels`, so nothing cascades and
   * every dependent table has to be named here in dependency order or it becomes orphan rows -
   * which is exactly what the 2026-08-17 purge had to do by hand.
   *
   * Every way a community ends comes through here: the last member leaving, the last member being
   * kicked, an account deletion that empties it, and - since 2026-08-18 - an admin deleting it
   * outright. One ending, one code path, so a table added to the list below is added for all four.
   * Attached media are left to the retention sweep, which collects them within its window once
   * nothing accesses them again.
   */
  private async hardDeleteWorkspace(workspaceId: string, reason: string): Promise<void> {
    const channels = await this.channelRepo.find({
      where: { workspaceId },
      select: { id: true, isPrivate: true, distributionGroupId: true },
    });
    const channelIds = channels.map((c) => c.id);

    // BEFORE the transaction, and allowed to abort it. The distribution group lives in another
    // service, so it cannot join the transaction; doing it afterwards as best-effort would turn a
    // failed call into an orphan group nothing names any more - the very shape of row the
    // 2026-08-17 purge had to find by hand. Failing here leaves the community intact and the whole
    // deletion retryable, which is the only outcome that stays reconcilable.
    await deleteDistributionGroup(this.internalSecret, workspaceScope(workspaceId));

    // EVERY PRIVATE SALON HAS ITS OWN, and the community's deletion says nothing about them. The
    // enumeration is here rather than a cascade because there is not one foreign key on `channels`
    // either - the same reason the transaction below names every table by hand.
    const privateGroups = channels.filter((c) => c.isPrivate && c.distributionGroupId);
    for (const channel of privateGroups) {
      await deleteDistributionGroup(this.internalSecret, channelScope(channel.id));
    }

    const workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
      select: { id: true, distributionGroupId: true },
    });
    const groupIds = [
      workspace?.distributionGroupId,
      ...channels.map((c) => c.distributionGroupId),
    ].filter((g): g is string => !!g);

    await this.workspaceRepo.manager.transaction(async (mgr) => {
      if (groupIds.length > 0) await mgr.query(DELETE_GROUP_DEPARTURES_SQL, [groupIds]);
      await mgr.delete(ChannelMessage, { workspaceId });
      // SALON ROWS BEFORE MEMBERSHIP ROWS, the order a private-salon grant locks them in
      // (`grantPrivateChannelAccess`): the reverse is a deadlock cycle, and losing it here would
      // abort a deletion whose distribution groups are already gone.
      await mgr.delete(Channel, { workspaceId });
      await mgr.delete(ChannelMember, { workspaceId });
      await mgr.delete(ChannelRole, { workspaceId });
      await mgr.delete(WorkspaceInvite, { workspaceId });
      await mgr.delete(Workspace, { id: workspaceId });
    });

    this.logger.log(
      `[WORKSPACE] hard delete workspace=${workspaceId} channels=${channelIds.length} ` +
        `privateGroups=${privateGroups.length} reason=${reason}`
    );
  }

  /**
   * Takes an erased account out of every community it is in, repairing each one BEFORE removing it.
   * Called by the internal account-erasure route, which core-service's durable queue retries until
   * it succeeds.
   *
   * THE ORDER IS WHAT MAKES THE RETRY WORK. This used to delete every membership row first and
   * repair afterwards from a list captured in memory, swallowing a failed repair - so a community
   * whose repair failed was left without an admin, or empty, and the retry found no membership left
   * to point at it. Now, per community: the community is repaired AS IF the account were already
   * gone, and only then does the account leave it - through {@link removeFromWorkspace}, the same
   * departure every other path takes, the community's key group and its private salons included. A
   * failure at any step leaves the row, so the next attempt starts that community over; a repair
   * that already happened is a no-op the second time. A repair that deleted the community leaves
   * nothing to leave. Failures are collected and THROWN after every community has been tried, so
   * one stuck community neither strands the others nor reports success.
   *
   * This is the one path where the postcondition cannot be a refusal - the account is being
   * deleted and there is nothing left to refuse - so it is the one place a repair exists, and it
   * is deterministic rather than a heuristic:
   *  - no members left: the community is deleted, exactly as if the last member had left;
   *  - members but no admin: the highest-priority remaining role holder is promoted, ties broken by
   *    the lowest user id. Deleting other people's community because one person deleted their
   *    account would be far worse, and leaving it ungoverned is the state everything else here
   *    exists to prevent.
   *
   * The private salons are cut by name because `allowedUsers` is a separate list from the
   * membership rows, and `reconcileDistributionGroupRoster` reads exactly that list, so a deleted
   * account left in it keeps an MLS leaf authorised forever.
   *
   * @returns the number of communities the account was taken out of.
   * @throws ServiceUnavailableException `ERASURE_WORKSPACE_REPAIR_FAILED` (503) when any failure was
   *   transport, 5xx or database: the queue classes it TRANSIENT and retries quietly.
   * @throws ConflictException `ERASURE_WORKSPACE_REPAIR_FAILED` (409) when every failure was a
   *   logical refusal: the queue classes it PERMANENT, so a human is told at once.
   */
  async removeAccountFromWorkspaces(deletedUserId: string): Promise<number> {
    const workspaceIds = [
      ...new Set(
        (
          await this.memberRepo.find({
            where: { userId: deletedUserId },
            select: { workspaceId: true },
          })
        ).map((m) => m.workspaceId)
      ),
    ];
    const failed: string[] = [];
    let transient = false;
    for (const workspaceId of workspaceIds) {
      try {
        const deleted = await this.repairOneWorkspaceAfterAccountDeletion(
          workspaceId,
          deletedUserId
        );
        if (!deleted) await this.removeFromWorkspace(workspaceId, deletedUserId, 'account_deleted');
      } catch (err) {
        failed.push(workspaceId);
        transient ||= isTransientFailure(err);
        this.logger.error(
          `[WORKSPACE] account removal failed workspace=${workspaceId} ` +
            `user=${deletedUserId.slice(0, 8)} - left for the erasure retry: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (failed.length > 0) {
      const body = {
        code: 'ERASURE_WORKSPACE_REPAIR_FAILED',
        message: `account removal incomplete: ${failed.length}/${workspaceIds.length} communities failed`,
        failedWorkspaces: failed,
      };
      // 503 when ANY failure was infrastructure (chat-delivery down, a database blip): the queue
      // retries it as transient. 409 only when every failure was a refusal no retry is expected to fix.
      if (transient) throw new ServiceUnavailableException(body);
      throw new ConflictException(body);
    }
    return workspaceIds.length;
  }

  /**
   * Tells each salon that a pin is gone because its message was erased with its author's account.
   * Every member's client keeps the pin set it loaded and updates it only from `channel.pin`, so
   * without this a phantom pin stays in the banner until the salon is reopened.
   *
   * After the erasure's transaction, so a pin is never announced gone while the row could still be
   * rolled back. A live notification, not state: a salon that cannot be told is logged, and its
   * members read the truth at the next open. Each salon in its own `try`.
   */
  async announceErasedPins(pins: Array<{ id: string; channelId: string }>): Promise<number> {
    let announced = 0;
    for (const { id, channelId } of pins) {
      try {
        const channel = await this.channelRepo.findOne({ where: { id: channelId } });
        if (!channel) continue;
        const audience = await this.channelAudience(channel);
        await this.redis.publishChannelEvent(
          'channel.pin',
          { channelId, messageId: id, pinned: false },
          audience
        );
        announced += 1;
      } catch (err) {
        this.logger.warn(
          `[CHANNEL] erased pin not announced channel=${channelId} message=${id} - its members ` +
            `see it gone at the next open: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return announced;
  }

  /**
   * Repairs one community for the departure of `leavingUserId`, whose membership row still exists
   * and is treated as gone. Idempotent: a community that already has another admin is left alone.
   *
   * @returns true when the repair deleted the community outright (nobody else was in it), so there
   *   is nothing left for the account to leave.
   */
  private async repairOneWorkspaceAfterAccountDeletion(
    workspaceId: string,
    leavingUserId: string
  ): Promise<boolean> {
    const members = (await this.memberRepo.find({ where: { workspaceId } })).filter(
      (m) => m.userId !== leavingUserId
    );
    if (members.length === 0) {
      await this.hardDeleteWorkspace(workspaceId, 'account_deletion_left_no_members');
      return true;
    }

    const adminIds = (await this.listWorkspaceAdminIds(workspaceId)).filter(
      (id) => id !== leavingUserId
    );
    if (adminIds.length > 0) return false;

    const roles = await this.roleRepo.find({ where: { workspaceId } });
    const adminRole = roles
      .filter((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))
      .sort((a, b) => b.priority - a.priority)[0];
    if (!adminRole) {
      // Nothing to promote anyone INTO. Reported rather than swallowed: a community whose roles no
      // longer include MANAGE_WORKSPACE is a data fault this route cannot fix by itself.
      this.logger.error(
        `[WORKSPACE] cannot promote a successor workspace=${workspaceId} - no role carries MANAGE_WORKSPACE`
      );
      return false;
    }

    // RANK FIRST, then what the roles grant, then the user id. Priority keeps a Moderateur above a
    // custom role; `createRole` places every custom role just above the base role, so among those
    // ties the number of distinct permissions held decides, and the user id leaves nothing to chance.
    const byId = new Map(roles.map((r) => [r.id, r]));
    const powerOf = (m: ChannelMember): number =>
      new Set((m.roleIds ?? []).flatMap((id) => byId.get(id)?.permissions ?? [])).size;
    const rankOf = (m: ChannelMember): number =>
      Math.max(0, ...(m.roleIds ?? []).map((id) => byId.get(id)?.priority ?? 0));
    const successor = members
      .slice()
      .sort(
        (a, b) =>
          rankOf(b) - rankOf(a) || powerOf(b) - powerOf(a) || a.userId.localeCompare(b.userId)
      )[0];

    successor.roleIds = [adminRole.id];
    await this.memberRepo.save(successor);
    this.logger.warn(
      `[WORKSPACE] promoted a successor admin workspace=${workspaceId} user=${successor.userId.slice(0, 8)} role="${adminRole.name}" members=${members.length} reason=account_deletion`
    );
    return false;
  }

  constructor(
    @InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>,
    @InjectRepository(Channel) private readonly channelRepo: Repository<Channel>,
    @InjectRepository(ChannelRole) private readonly roleRepo: Repository<ChannelRole>,
    @InjectRepository(ChannelMember) private readonly memberRepo: Repository<ChannelMember>,
    @InjectRepository(ChannelMessage) private readonly messageRepo: Repository<ChannelMessage>,
    @InjectRepository(WorkspaceInvite)
    private readonly inviteRepo: Repository<WorkspaceInvite>,
    private readonly redis: RedisService
  ) {}

  // ================= INVITES (shareable community links) =================

  /** True when the actor holds a workspace permission allowing invite-link creation. */
  private async actorCanInvite(workspaceId: string, actorUserId: string): Promise<boolean> {
    const member = await this.memberRepo.findOne({ where: { workspaceId, userId: actorUserId } });
    if (!member?.roleIds?.length) return false;
    const roles = await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    return roles.some(
      (r) =>
        r.permissions.includes(CHANNEL_PERMISSIONS.INVITE_MEMBERS) ||
        r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)
    );
  }

  /** Whether an invite is still usable (not revoked/expired/exhausted). */
  private inviteIsValid(invite: WorkspaceInvite): boolean {
    if (invite.revoked) return false;
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return false;
    if (invite.maxUses != null && invite.uses >= invite.maxUses) return false;
    return true;
  }

  /**
   * The community's base role - its lowest-priority role, "Membre" - which is what joining grants.
   * THE ONLY definition: an invite link grants it, and an invitation may grant it whoever sent it.
   */
  private baseMemberRole(roles: readonly ChannelRole[]): ChannelRole | null {
    return roles.slice().sort((a, b) => a.priority - b.priority)[0] ?? null;
  }

  /** Revokes a set of invites in one statement, saying how many and why. */
  private async revokeInvites(invites: WorkspaceInvite[], reason: string): Promise<void> {
    if (invites.length === 0) return;
    await this.inviteRepo.update({ id: In(invites.map((i) => i.id)) }, { revoked: true });
    this.logger.log(`[INVITE] revoked count=${invites.length} reason=${reason}`);
  }

  /** The shape of an invite the UI needs: the token plus the bounds it was minted with. */
  private toInviteDto(invite: WorkspaceInvite): WorkspaceInviteDto {
    return {
      token: invite.token,
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
      maxUses: invite.maxUses,
      uses: invite.uses,
    };
  }

  /**
   * Returns THE community's invite link, minting one if it has none.
   * Requires the actor to hold INVITE_USERS or MANAGE_WORKSPACE in the workspace.
   *
   * There used to be no "the". This documented itself as "creates (or returns)" and only ever
   * created, while the UI called it on every click - so one member minted 3 valid tokens for the
   * same community in 59 seconds, of which one was ever used. Revoking the link you shared revoked
   * nothing, because the other two still worked and nobody knew they existed. A community now has
   * at most ONE live invite, which makes "the link" an object a human can reason about.
   *
   * `rotate` is the only way to get a new token: it revokes whatever is live and mints its
   * replacement. Without it the existing link is returned unchanged, bounds included, so opening
   * the panel never silently invalidates what somebody already shared.
   *
   * `expiresAt` and `maxUses` were honoured by {@link inviteIsValid} all along and simply never
   * surfaced - all 10 live invites on prod carried NULL for both, so every link ever shared was
   * eternal and unlimited.
   */
  async createWorkspaceInvite(
    workspaceId: string,
    actorUserId: string,
    opts?: { expiresAt?: string | null; maxUses?: number | null; rotate?: boolean }
  ): Promise<WorkspaceInviteDto> {
    const workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');
    if (!(await this.actorCanInvite(workspaceId, actorUserId))) {
      throw new ForbiddenException('Missing INVITE_USERS permission');
    }

    const live = (await this.inviteRepo.find({ where: { workspaceId, revoked: false } }))
      .filter((i) => this.inviteIsValid(i))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (!opts?.rotate && live.length > 0) {
      // Several may still be live from before this rule. The most recent is the one a human most
      // plausibly shared last; the rest are revoked so the singular becomes true again.
      await this.revokeInvites(live.slice(1), 'superseded_by_newest');
      return this.toInviteDto(live[0]);
    }

    await this.revokeInvites(live, 'rotated');

    const expiresAt = this.parseInviteExpiry(opts?.expiresAt);
    const maxUses = this.parseInviteMaxUses(opts?.maxUses);
    const saved = await this.inviteRepo.save(
      this.inviteRepo.create({
        workspaceId,
        token: crypto.randomBytes(18).toString('base64url'),
        createdBy: actorUserId,
        expiresAt,
        maxUses,
        uses: 0,
        revoked: false,
      })
    );
    this.logger.log(
      `[INVITE] created workspace=${workspaceId} by=${actorUserId.slice(0, 8)} expiresAt=${expiresAt?.toISOString() ?? 'never'} maxUses=${maxUses ?? 'unlimited'} replaced=${live.length}`
    );
    return this.toInviteDto(saved);
  }

  /**
   * Validates an expiry sent by a client. A date the server cannot parse, or one already in the
   * past, is refused rather than stored: `inviteIsValid` would treat an unparseable Date as expired
   * and the caller would be handed a token that is dead on arrival, with nothing saying why.
   */
  private parseInviteExpiry(raw?: string | null): Date | null {
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException({
        code: 'INVITE_EXPIRY_INVALID',
        message: 'expiresAt is not a valid date',
      });
    }
    if (parsed.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'INVITE_EXPIRY_IN_THE_PAST',
        message: 'expiresAt is already in the past',
      });
    }
    return parsed;
  }

  /** Validates a use cap. Zero or negative would mint a link nobody can ever use. */
  private parseInviteMaxUses(raw?: number | null): number | null {
    if (raw === undefined || raw === null) return null;
    if (!Number.isInteger(raw) || raw < 1) {
      throw new BadRequestException({
        code: 'INVITE_MAX_USES_INVALID',
        message: 'maxUses must be a positive integer',
      });
    }
    return raw;
  }

  /** Public-ish preview of an invite (community name/image) shown before the user joins. */
  async getWorkspaceInvitePreview(token: string): Promise<{
    valid: boolean;
    workspaceName: string | null;
    workspaceSlug: string | null;
    imageMediaId: string | null;
  }> {
    const invite = await this.inviteRepo.findOne({ where: { token } });
    if (!invite || !this.inviteIsValid(invite)) {
      return { valid: false, workspaceName: null, workspaceSlug: null, imageMediaId: null };
    }
    const ws = await this.workspaceRepo.findOne({
      where: { id: invite.workspaceId },
    });
    if (!ws) return { valid: false, workspaceName: null, workspaceSlug: null, imageMediaId: null };
    return {
      valid: true,
      workspaceName: ws.name,
      workspaceSlug: ws.slug,
      imageMediaId: ws.imageMediaId,
    };
  }

  /**
   * Joins the caller into the invite's community: adds a workspace member with the base role.
   * The client obtains its seeds from the distribution group and the members who answer, once it
   * loads the workspace (the server holds no channel key).
   *
   * `admissionVoucher` is the proof the joiner built from the link's fragment (channel-encryption
   * section 25): what lets a member hand them the community's past. It is stored on the membership
   * row, and on the row a member ALREADY has when they follow a newer link - that is how somebody
   * who joined through a link without a fragment is given a proof afterwards. A link without one
   * still admits; it just gives no past.
   */
  async acceptWorkspaceInvite(
    token: string,
    userId: string,
    rawVoucher?: unknown
  ): Promise<{ workspaceSlug: string; alreadyMember: boolean }> {
    const admissionVoucher = narrowAdmissionVoucher(rawVoucher);
    const invite = await this.inviteRepo.findOne({ where: { token } });
    if (!invite || !this.inviteIsValid(invite)) {
      throw new NotFoundException('Invalid or expired invitation.');
    }
    // Links outlive the community they point at: an invite to a deleted community must not
    // resurrect it for the joiner.
    const ws = await this.workspaceRepo.findOne({
      where: { id: invite.workspaceId },
    });
    if (!ws) throw new NotFoundException('Workspace not found');

    // A link outlives the membership that minted it. Joining a community nobody belongs to any more
    // would produce the one state nothing can repair from inside - members, and no admin among
    // them - out of a forwarded URL. Leaving now deletes such a community outright, but account
    // deletion still removes membership rows directly (`internal.controller`), so this is a live
    // guard rather than a leftover.
    const memberIdsBeforeJoin = await this.getWorkspaceMemberIds(ws.id);
    if (memberIdsBeforeJoin.length === 0) {
      this.logger.warn(`[INVITE] refused - workspace=${ws.id} has no members left`);
      throw new NotFoundException({
        code: 'WORKSPACE_HAS_NO_MEMBERS',
        message: 'This community no longer exists.',
      });
    }

    const existing = await this.memberRepo.findOne({
      where: { workspaceId: ws.id, userId },
    });
    if (existing) {
      // The joiner's OWN proof, so a newer one replaces an older one: it is about nobody else.
      if (admissionVoucher) {
        await this.memberRepo.update({ id: existing.id }, { admissionVoucher });
        this.logger.log(
          `[INVITE] admission voucher stored for an existing member workspace=${ws.id} user=${userId.slice(0, 8)}`
        );
      }
      return { workspaceSlug: ws.slug, alreadyMember: true };
    }

    const roles = await this.roleRepo.find({ where: { workspaceId: ws.id } });
    const baseRole = this.baseMemberRole(roles);

    // COUNTING THE USE IS WHAT ADMITS, in ONE statement that carries the bound. The read above is a
    // preview only; the bound is decided here. The conditional UPDATE takes the invite's row lock, so a concurrent
    // accept waits for this one and then re-evaluates the WHERE against the committed count - and
    // the member is written in the same transaction, so a refused claim leaves nobody behind.
    const claimed = await this.inviteRepo.manager.transaction(async (tx) => {
      const [won]: [{ id: string }[], number] = await tx.query(
        `UPDATE workspace_invites
            SET uses = uses + 1
          WHERE id = $1
            AND revoked = false
            AND ("expiresAt" IS NULL OR "expiresAt" >= now())
            AND ("maxUses" IS NULL OR uses < "maxUses")
      RETURNING id`,
        [invite.id]
      );
      if (won.length === 0) return false;
      const members = tx.getRepository(ChannelMember);
      await members.save(
        members.create({
          workspaceId: ws.id,
          userId,
          roleIds: baseRole ? [baseRole.id] : [],
          admissionVoucher,
        })
      );
      return true;
    });
    if (!claimed) {
      this.logger.warn(
        `[INVITE] refused - claim matched no row (exhausted, revoked or expired meanwhile) workspace=${ws.id} user=${userId.slice(0, 8)}`
      );
      throw new NotFoundException('Invalid or expired invitation.');
    }

    // Notify connected clients (the joining user's devices + existing members) to refresh.
    const repChannel = await this.channelRepo.findOne({
      where: { workspaceId: ws.id, isPrivate: false },
    });
    if (repChannel) {
      const memberIds = await this.getWorkspaceMemberIds(ws.id);
      await this.redis.publishChannelEvent(
        'channel.member.joined',
        {
          channelId: repChannel.id,
          channelName: repChannel.name,
          workspaceId: ws.id,
          workspaceSlug: ws.slug,
          workspaceName: ws.name,
          visibility: 'public',
          roleName: baseRole?.name ?? 'Membre',
          joinedBy: userId,
        },
        memberIds
      );
    }
    this.logger.log(
      `[INVITE] accepted workspace=${ws.id} user=${userId.slice(0, 8)} voucher=${admissionVoucher ? 'yes' : 'no'}`
    );
    return { workspaceSlug: ws.slug, alreadyMember: false };
  }

  /**
   * Get all user IDs in a workspace for event broadcasting.
   */
  private async getWorkspaceMemberIds(workspaceId: string): Promise<string[]> {
    const members = await this.memberRepo.find({ where: { workspaceId } });
    return members.map((m) => m.userId);
  }

  /**
   * Of the Graine sessions a device holds, which ones this server still has messages for.
   *
   * THE SEEDS' RETENTION WINDOW IS THIS ONE, DERIVED - never a second clock on the device. A seed
   * whose messages are gone is the keys to something that no longer exists: unbounded, and pure
   * liability. But a device cannot know when a message was deleted, and giving it its own one-year
   * timer would be a second copy of a number that lives here - which is precisely the shape that
   * drifts, and would strip the seed of a PINNED message the sweep deliberately kept.
   *
   * Answers only about ids the caller submitted, and only from the communities it belongs to. A
   * session id is opaque and unique across senders, so the reply reveals nothing the caller did not
   * already hold: it learns whether ITS OWN seed is still worth keeping, and nothing about anyone
   * else's. An id the caller does not belong to is simply absent from the answer, indistinguishable
   * from one that has expired - there is no membership oracle here.
   *
   * @param userId the asking account, from `x-user-id`
   * @param sessionIds sessions the device holds; anything beyond {@link MAX_LIVE_SESSION_QUERY} is
   *   refused rather than silently truncated, since a truncated answer reads as "these are dead"
   * @returns the subset still named by at least one stored message
   */
  async liveGraineSessions(userId: string, sessionIds: string[]): Promise<string[]> {
    if (sessionIds.length === 0) return [];
    if (sessionIds.length > MAX_LIVE_SESSION_QUERY) {
      throw new BadRequestException(
        `At most ${MAX_LIVE_SESSION_QUERY} session ids per request, got ${sessionIds.length}`
      );
    }

    const memberships = await this.memberRepo.find({
      where: { userId },
      select: { workspaceId: true },
    });
    if (memberships.length === 0) return [];
    const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))];

    const rows: { senderSessionId: string }[] = await this.messageRepo
      .createQueryBuilder('m')
      .select('DISTINCT m."senderSessionId"', 'senderSessionId')
      .where('m."senderSessionId" IN (:...sessionIds)', { sessionIds })
      .andWhere('m."workspaceId" IN (:...workspaceIds)', { workspaceIds })
      .getRawMany();

    const live = rows.map((r) => r.senderSessionId);
    this.logger.debug(
      `[GRAINE] liveGraineSessions user=${userId.slice(0, 8)} asked=${sessionIds.length} live=${live.length}`
    );
    return live;
  }

  // ================= WORKSPACES =================

  /** Creates a workspace with default Administrateur/Modérateur/Membre roles, adds the creator as admin, and creates a public default salon (`DEFAULT_CHANNEL_NAME`). */
  /**
   * Returns a workspace slug guaranteed free of collisions with existing communities.
   * Communities may share a display name, but `channel_workspaces.slug`
   * has a unique constraint and is used for URL lookups, so a numeric suffix (`-2`, `-3`, …)
   * is appended when the requested slug is already taken.
   */
  private async ensureUniqueWorkspaceSlug(requested: string): Promise<string> {
    const base = requested.trim();
    if (!base) throw new BadRequestException('Slug de communaute invalide.');

    let candidate = base;
    for (let suffix = 2; ; suffix++) {
      const existing = await this.workspaceRepo.findOne({ where: { slug: candidate } });
      if (!existing) return candidate;
      candidate = `${base}-${suffix}`;
    }
  }

  async createWorkspace(input: CreateWorkspaceDto) {
    const slug = await this.ensureUniqueWorkspaceSlug(input.slug);
    this.logger.log(
      `[WORKSPACE] create name="${input.name}" slug="${slug}" (requested="${input.slug}") by=${input.createdBy.slice(0, 8)}`
    );
    const ws = this.workspaceRepo.create({
      name: input.name,
      slug,
      createdBy: input.createdBy,
    });
    const savedWs = await this.workspaceRepo.save(ws);

    // THE DISTRIBUTION GROUP IS CREATED WITH THE COMMUNITY, NOT ON FIRST USE. A community whose
    // seeds have nowhere to travel is a community whose salons cannot be encrypted, so this is not
    // a decoration that may degrade: it fails the creation. The row is unwound first, because a
    // half-created community would hold its slug hostage while being unusable, and the migration
    // to Graine is a clean cut - there is no population of older communities to be gentle with.
    try {
      savedWs.distributionGroupId = await createDistributionGroup(
        this.internalSecret,
        workspaceScope(savedWs.id)
      );
      await this.workspaceRepo.save(savedWs);
    } catch (e) {
      await this.workspaceRepo.delete({ id: savedWs.id });
      this.logger.error(
        `[WORKSPACE] create ROLLED BACK workspace=${savedWs.id} slug="${slug}" - no distribution group: ${e instanceof Error ? e.message : String(e)}`
      );
      throw e;
    }
    this.logger.log(
      `[WORKSPACE] distribution group workspace=${savedWs.id} group=${savedWs.distributionGroupId}`
    );

    const adminRole = this.roleRepo.create({
      workspaceId: savedWs.id,
      name: 'Administrateur',
      priority: 100,
      permissions: DEFAULT_ADMIN_PERMISSIONS as string[],
    });
    const savedAdminRole = await this.roleRepo.save(adminRole);

    const moderatorRole = this.roleRepo.create({
      workspaceId: savedWs.id,
      name: 'Modérateur',
      priority: 50,
      permissions: DEFAULT_MODERATOR_PERMISSIONS as string[],
    });
    await this.roleRepo.save(moderatorRole);

    const memberRole = this.roleRepo.create({
      workspaceId: savedWs.id,
      name: 'Membre',
      priority: 10,
      permissions: DEFAULT_MEMBER_PERMISSIONS as string[],
    });
    await this.roleRepo.save(memberRole);

    const adminMember = this.memberRepo.create({
      workspaceId: savedWs.id,
      userId: input.createdBy,
      roleIds: [savedAdminRole.id],
    });
    await this.memberRepo.save(adminMember);

    const generalChannel = this.channelRepo.create({
      workspaceId: savedWs.id,
      name: DEFAULT_CHANNEL_NAME,
      isPrivate: false,
      sortOrder: 0,
    });
    await this.channelRepo.save(generalChannel);

    // THE CREATOR'S STANDING IS DERIVED FROM THE ROLE JUST SEEDED, through the same predicates the
    // listing uses - never written out as literals. This answer used to name `viewerCanManage` and
    // `viewerCanManageChannels` and omit `viewerCanModerate`, so the client took the creator for a
    // plain member until the next listing: no "Epingler" and no close on another member's poll in
    // the community they had just made, until a reload (Mi 9T reading of `v1.2.6-alpha.1`).
    const creatorPermissions = savedAdminRole.permissions;
    const standing = {
      viewerCanManage: creatorPermissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE),
      viewerCanModerate: roleGrantsModeration(creatorPermissions),
      viewerCanManageChannels: roleGrantsChannelManagement(creatorPermissions),
    };
    this.logger.log(
      `[WORKSPACE] creator standing workspace=${savedWs.id} manage=${standing.viewerCanManage} moderate=${standing.viewerCanModerate} manageChannels=${standing.viewerCanManageChannels}`
    );
    return { ...savedWs, ...standing };
  }

  /**
   * Establishes that `userId` belongs to a live community, and returns it.
   *
   * The single gate in front of everything Graine: the GroupInfo it guards IS the capability to
   * enter the distribution group and read every seed on it, so this decides who may hold one. It
   * lives here because `channel_workspace_members` lives here - chat-delivery cannot answer this
   * question about a table it does not own, and would have had to ask anyway.
   */
  private async assertWorkspaceMember(workspaceId: string, userId: string): Promise<Workspace> {
    const workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    if (!(await this.isWorkspaceMember(workspaceId, userId))) {
      this.logger.warn(
        `[DISTRIBUTION_GROUP] refused workspace=${workspaceId} user=${userId.slice(0, 8)} - not a member`
      );
      throw new ForbiddenException('Not a member of this workspace');
    }
    return workspace;
  }

  /** The membership half of {@link assertWorkspaceMember}, shared with {@link isDistributionGroupEntitled}. */
  private async isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    return !!(await this.memberRepo.findOne({ where: { workspaceId, userId } }));
  }

  /** The access half of {@link assertChannelReader}, shared with {@link isDistributionGroupEntitled}. */
  private async isChannelReader(channel: Channel, userId: string): Promise<boolean> {
    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    return !!member && this.canAccessChannel(channel, member, userId);
  }

  /**
   * Whether `userId` may hold a device in the key-distribution group of a scope - the question
   * chat-delivery asks before it accepts an external commit to that group (WP-KEYGROUP-JOIN-GATE).
   *
   * The SAME predicates as the routes that serve the group's GroupInfo, which IS the capability to
   * external-join: a community's group admits its members ({@link getDistributionGroupForMember}),
   * a private salon's its readers ({@link getChannelDistributionGroupForMember}). So a commit is
   * accepted exactly when the base it was built on could have been served to its author. A scope
   * that no longer exists, or a salon that is no longer private, entitles nobody.
   */
  /**
   * {@link isDistributionGroupEntitled} for chat-delivery's group id: the community or private salon
   * holding that group, and none - so nobody entitled - when no scope holds it any more.
   */
  private async isEntitledToDistributionGroupId(groupId: string, userId: string): Promise<boolean> {
    const normalised = userId.trim().toLowerCase();
    const workspace = await this.workspaceRepo.findOne({
      where: { distributionGroupId: groupId },
      select: { id: true },
    });
    if (workspace) return this.isDistributionGroupEntitled('workspace', workspace.id, normalised);
    const channel = await this.channelRepo.findOne({
      where: { distributionGroupId: groupId },
      select: { id: true },
    });
    if (channel) return this.isDistributionGroupEntitled('channel', channel.id, normalised);
    return false;
  }

  async isDistributionGroupEntitled(
    kind: 'workspace' | 'channel',
    scopeId: string,
    userId: string
  ): Promise<boolean> {
    return (await this.distributionGroupEntitlement(kind, scopeId, userId)).entitled;
  }

  /**
   * {@link isDistributionGroupEntitled} with the CAUSE of a refusal, so the caller can say why an
   * answer flipped to false rather than only that it did.
   */
  async distributionGroupEntitlement(
    kind: 'workspace' | 'channel',
    scopeId: string,
    userId: string
  ): Promise<{ entitled: true } | { entitled: false; cause: string }> {
    if (kind === 'workspace') {
      const workspace = await this.workspaceRepo.findOne({
        where: { id: scopeId },
        select: { id: true },
      });
      if (!workspace) return { entitled: false, cause: 'no such community' };
      return (await this.isWorkspaceMember(scopeId, userId))
        ? { entitled: true }
        : { entitled: false, cause: 'not a member of the community' };
    }
    const channel = await this.channelRepo.findOne({ where: { id: scopeId } });
    if (!channel) return { entitled: false, cause: 'no such salon' };
    if (!channel.isPrivate) return { entitled: false, cause: 'the salon is not private' };
    return (await this.isChannelReader(channel, userId))
      ? { entitled: true }
      : { entitled: false, cause: 'not a reader of the salon' };
  }

  /**
   * Hands a community member its distribution group and the latest GroupInfo published on it, so
   * the client can external-join and start receiving channel seeds.
   *
   * `groupInfo: null` means nobody has initialised the MLS group yet - the FIRST caller to see it
   * is the one that creates it and publishes back through
   * {@link publishDistributionGroupInfoForMember}. That is a state the client must be able to act
   * on, which is why it is a null field and not an error.
   */
  async getDistributionGroupForMember(
    workspaceId: string,
    userId: string
  ): Promise<DistributionGroupRef> {
    await this.assertWorkspaceMember(workspaceId, userId);

    const ref = await readDistributionGroup(
      this.internalSecret,
      workspaceScope(workspaceId),
      userId
    );
    if (!ref) {
      // Every community created since WP-21 has one, and the clean cut leaves no older population.
      // So this is not a state to repair silently: it is a community that cannot carry seeds, and
      // saying so is what makes it findable.
      this.logger.error(
        `[DISTRIBUTION_GROUP] workspace=${workspaceId} has NO distribution group - salons in it cannot be encrypted`
      );
      throw new NotFoundException({
        code: 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP',
        message: 'This community has no key distribution group.',
      });
    }

    this.logger.log(
      `[DISTRIBUTION_GROUP] served workspace=${workspaceId} user=${userId.slice(0, 8)} group=${ref.groupId} published=${ref.groupInfo !== null} base=${ref.baseEpoch ?? 'none'} active=${ref.activeEpoch} devices=${ref.memberDevices?.length ?? '?'}`
    );
    return ref;
  }

  /**
   * Publishes a member's freshly committed GroupInfo for the community's distribution group.
   * Monotonic on the delivery side, so a late refresh can never regress the served base epoch.
   */
  async publishDistributionGroupInfoForMember(
    workspaceId: string,
    userId: string,
    groupInfo: string,
    baseEpoch: number,
    deviceId: string
  ): Promise<{ stored: boolean; publisherActive: boolean }> {
    await this.assertWorkspaceMember(workspaceId, userId);

    const result = await publishDistributionGroupInfo(
      this.internalSecret,
      workspaceScope(workspaceId),
      groupInfo,
      baseEpoch,
      { userId, deviceId }
    );
    this.logger.log(
      `[DISTRIBUTION_GROUP] published workspace=${workspaceId} user=${userId.slice(0, 8)} epoch=${baseEpoch} stored=${result.stored} publisherActive=${result.publisherActive}`
    );
    if (!result.publisherActive) {
      // ACCUSES, because this device may be the only one that can serve this group's first Welcome.
      this.logger.warn(
        `[DISTRIBUTION_GROUP] publisher NOT routable workspace=${workspaceId} user=${userId.slice(0, 8)} device=${deviceId.slice(0, 12)}`
      );
    }
    return result;
  }

  /**
   * The channel a caller may read, or a refusal - the gate in front of every salon-scoped seed
   * route.
   *
   * PRIVATE ONLY, and asking about a public salon is refused rather than answered with the
   * community's group. A public salon's audience IS the community, so it carries no group of its
   * own; answering with the community's would let a client believe a per-salon roster exists where
   * none does, which is precisely the confusion this scope was added to end. The refusal is a 400,
   * not a 403: nothing about the caller is wrong.
   */
  /**
   * The channel, once `userId` has been shown to be allowed to READ it.
   *
   * The question every Graine route asks first, and it is asked of the channel rather than of the
   * community: being in the community is not being in a private salon, and the two used to be the
   * same query.
   */
  private async assertChannelReader(channelId: string, userId: string): Promise<Channel> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    if (!(await this.isChannelReader(channel, userId))) {
      this.logger.warn(
        `[CHANNEL_GRAINE] refused channel=${channelId} user=${userId.slice(0, 8)} - no access`
      );
      throw new ForbiddenException('No access to this channel');
    }
    return channel;
  }

  private async assertPrivateChannelReader(channelId: string, userId: string): Promise<Channel> {
    const channel = await this.assertChannelReader(channelId, userId);

    if (!channel.isPrivate) {
      throw new BadRequestException({
        code: 'CHANNEL_HAS_NO_DISTRIBUTION_GROUP',
        message: 'A public salon uses the community distribution group.',
      });
    }
    return channel;
  }

  /**
   * Hands a private salon's reader its OWN distribution group and the latest GroupInfo on it.
   *
   * The salon-scoped twin of {@link getDistributionGroupForMember}, and the reason the roster is
   * finite: only the people in `allowedUsers` - plus the admins who have explicitly joined - ever
   * see this GroupInfo, and the GroupInfo IS the capability to external-join. An admin who has not
   * joined is refused here exactly like anyone else, which is what stops `workspace.manage` from
   * being a standing key to every private salon.
   */
  async getChannelDistributionGroupForMember(
    channelId: string,
    userId: string
  ): Promise<DistributionGroupRef> {
    await this.assertPrivateChannelReader(channelId, userId);

    const ref = await readDistributionGroup(this.internalSecret, channelScope(channelId), userId);
    if (!ref) {
      // Every private salon is given one at birth and cannot be created without it, so this is not
      // a state to repair silently: it is a salon that cannot carry seeds.
      this.logger.error(
        `[CHANNEL_GRAINE] channel=${channelId} is private with NO distribution group - it cannot be encrypted`
      );
      throw new NotFoundException({
        code: 'CHANNEL_HAS_NO_DISTRIBUTION_GROUP',
        message: 'This salon has no key distribution group.',
      });
    }

    this.logger.log(
      `[CHANNEL_GRAINE] served channel=${channelId} user=${userId.slice(0, 8)} group=${ref.groupId} published=${ref.groupInfo !== null} base=${ref.baseEpoch ?? 'none'} active=${ref.activeEpoch} devices=${ref.memberDevices?.length ?? '?'}`
    );
    return ref;
  }

  /**
   * The lowest message index of each named session that `forUserId` arrived in time to read.
   *
   * **THE PART OF `historyVisibility` NO CLIENT CAN COMPUTE.** A community set to `joined` promises
   * that nothing said before a member arrived is readable by them, and the seed layer enforces it
   * where a seed leaves a device. But a Graine session can SPAN an arrival: rotation is decided by
   * the SENDER when it notices the distribution group's epoch has moved, and a join is an external
   * commit, so the sender learns of it late and seals a few more messages under the session it
   * already had. Withholding that whole session costs the newcomer messages sent AFTER they
   * arrived; handing it over whole gives them the ones sent before. Only a floor can express the
   * difference, and `firstIndex` is exactly the field that carries one.
   *
   * **The floor is computed HERE because only here are both halves authoritative.** The arrival is
   * this server's own `channel_members.createdAt` and the message dates are its own `createdAt`, so
   * the comparison is between two values written by ONE clock - where a client comparing a
   * server-stamped arrival with a peer's device-stamped mint time is sharp only to that peer's clock
   * skew. And because the answer is derived from stored rows rather than from any caller's opinion,
   * every device that asks gets the same number for the same state: neither the member answering nor
   * the member asking supplies anything the result depends on.
   *
   * The caller must be able to READ the channel; `forUserId` must be a member of its community. A
   * session with no message at or after the arrival is absent from the result, which means withhold
   * it entirely - the distinction between "nothing to give" and "give from index k" is the whole
   * point, so it is carried as presence rather than as a zero.
   *
   * @param channelId Channel the sessions belong to.
   * @param callerId Who is asking - a reader of the channel, i.e. the member about to hand a seed over.
   * @param forUserId Whose arrival draws the floor.
   * @param sessionIds Sessions the repair request named.
   * @returns `sessionId -> lowest readable index`, omitting sessions with nothing readable.
   */
  async getGraineHistoryFloors(
    channelId: string,
    callerId: string,
    forUserId: string,
    sessionIds: string[]
  ): Promise<Record<string, number>> {
    const channel = await this.assertChannelReader(channelId, callerId);

    const arrival = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: forUserId },
      select: { createdAt: true },
    });
    if (!arrival) {
      // Not a member, so there is no arrival to measure from and nothing they may be handed. Said
      // as a refusal rather than as an empty result: the caller must fail closed, and an empty
      // object is what a community with no matching messages also looks like.
      throw new ForbiddenException('That user is not a member of this community');
    }
    if (sessionIds.length === 0) return {};

    const rows: { sessionId: string; floor: string }[] = await this.messageRepo
      .createQueryBuilder('m')
      .select('m."senderSessionId"', 'sessionId')
      .addSelect('MIN(m."messageIndex")', 'floor')
      .where('m."channelId" = :channelId', { channelId })
      .andWhere('m."senderSessionId" IN (:...sessionIds)', { sessionIds })
      // A row with no index answers no key derivation, so it can never be the floor of anything.
      .andWhere('m."messageIndex" IS NOT NULL')
      .andWhere('m."createdAt" >= :arrival', { arrival: arrival.createdAt })
      .groupBy('m."senderSessionId"')
      .getRawMany();

    const floors: Record<string, number> = {};
    for (const row of rows) floors[row.sessionId] = Number(row.floor);
    this.logger.log(
      `[CHANNEL_GRAINE] floors channel=${channelId} for=${forUserId.slice(0, 8)} ` +
        `asked=${sessionIds.length} readable=${rows.length}`
    );
    return floors;
  }

  /** Publishes a reader's freshly committed GroupInfo for a private salon's distribution group. */
  async publishChannelDistributionGroupInfoForMember(
    channelId: string,
    userId: string,
    groupInfo: string,
    baseEpoch: number,
    deviceId: string
  ): Promise<{ stored: boolean; publisherActive: boolean }> {
    await this.assertPrivateChannelReader(channelId, userId);

    const result = await publishDistributionGroupInfo(
      this.internalSecret,
      channelScope(channelId),
      groupInfo,
      baseEpoch,
      { userId, deviceId }
    );
    this.logger.log(
      `[CHANNEL_GRAINE] published channel=${channelId} user=${userId.slice(0, 8)} epoch=${baseEpoch} stored=${result.stored} publisherActive=${result.publisherActive}`
    );
    if (!result.publisherActive) {
      this.logger.warn(
        `[CHANNEL_GRAINE] publisher NOT routable channel=${channelId} user=${userId.slice(0, 8)} device=${deviceId.slice(0, 12)}`
      );
    }
    return result;
  }

  /**
   * Puts an administrator into a private salon they can see but cannot read, ON PURPOSE and BY
   * NAME.
   *
   * WHY THIS EXISTS AT ALL. `workspace.manage` used to be a silent bypass: an admin could read
   * every private salon and appeared in none of their rosters. That made the roster infinite - it
   * was `allowedUsers` plus whoever happened to hold an admin role at the time - and an infinite
   * roster cannot be an MLS group, because every seed would have to be sealed to a set that
   * changes without anyone touching the salon. Making the join EXPLICIT is what makes the set
   * finite and the guarantee cryptographic rather than server-enforced.
   *
   * NO SYSTEM MESSAGE, on the user's decision of 2026-08-19: the admin shows up in the member list
   * and that is the whole disclosure. A message in the transcript would be a permanent record of a
   * moderation act in a conversation the moderator is there to read, which is a different product
   * decision from the one being made here.
   *
   * Idempotent: an admin already in the roster gets the same answer and no second event.
   */
  async joinPrivateChannelAsAdmin(channelId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    if (!channel.isPrivate) {
      throw new BadRequestException({
        code: 'CHANNEL_IS_PUBLIC',
        message: 'A public salon is already readable by every member.',
      });
    }

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');

    const roles = member.roleIds?.length
      ? await this.roleRepo.find({ where: { id: In(member.roleIds) } })
      : [];
    if (!roles.some((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))) {
      this.logger.warn(
        `[CHANNEL_GRAINE] refused admin join channel=${channelId} user=${actorUserId.slice(0, 8)} - no MANAGE_WORKSPACE`
      );
      throw new ForbiddenException('Missing MANAGE_WORKSPACE permission');
    }

    const normalized = actorUserId.trim().toLowerCase();
    if ((channel.allowedUsers || []).includes(normalized)) {
      return { success: true, alreadyMember: true };
    }

    // GRANTED BEFORE ANNOUNCED, like every other grant here: the audience is derived from
    // `allowedUsers`, so the joiner would otherwise be the one person the event misses.
    // The membership and MANAGE_WORKSPACE are asked again under the grant's row locks: an admin
    // kicked or demoted since the reads above is refused there.
    const granted = await this.grantPrivateChannelAccess(
      channelId,
      actorUserId,
      CHANNEL_PERMISSIONS.MANAGE_WORKSPACE
    );
    if (granted.outcome === 'gone') throw new NotFoundException('Channel not found');
    if (granted.outcome === 'public') {
      throw new BadRequestException({
        code: 'CHANNEL_IS_PUBLIC',
        message: 'A public salon is already readable by every member.',
      });
    }
    if (granted.outcome === 'not_member') {
      throw new ForbiddenException('Not a member of this workspace');
    }
    if (granted.outcome !== 'granted') {
      throw new ForbiddenException('Missing MANAGE_WORKSPACE permission');
    }
    channel.allowedUsers = granted.channel.allowedUsers;

    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.member.joined',
      {
        channelId,
        channelName: channel.name,
        workspaceId: channel.workspaceId,
        visibility: 'private',
        roleName: 'Administrateur',
        joinedBy: actorUserId,
        invitedBy: actorUserId,
      },
      audience
    );

    this.logger.log(
      `[CHANNEL_GRAINE] admin joined channel=${channelId} user=${actorUserId.slice(0, 8)} roster=${channel.allowedUsers.length}`
    );
    return { success: true, alreadyMember: false };
  }

  /**
   * Loads a workspace by its URL slug together with the channels the caller may read, its
   * members, and its roles. `viewerCanManage` / `viewerCanModerate` are computed server-side so
   * the frontend can gate admin controls without deriving permissions itself.
   *
   * Members only: a slug is public knowledge (every invite link and its preview hands one out),
   * so it must not be enough to read a community's roster or channel list from the outside.
   */
  async getWorkspaceBySlug(slug: string, userId: string) {
    // A deleted community is a 404 on its own slug because there is no row, not because a
    // filter hides one. It was the other way round until deletion became real.
    const ws = await this.workspaceRepo.findOne({ where: { slug } });
    if (!ws) throw new NotFoundException('Workspace not found');

    const normalizedUserId = (userId ?? '').trim().toLowerCase();
    const members = await this.memberRepo.find({ where: { workspaceId: ws.id } });
    const viewerMember = members.find((m) => m.userId.trim().toLowerCase() === normalizedUserId);
    if (!viewerMember) throw new ForbiddenException('Not a member of this workspace');

    const roles = await this.roleRepo.find({ where: { workspaceId: ws.id } });

    const allChannels = sortChannels(
      await this.channelRepo.find({ where: { workspaceId: ws.id } })
    );
    // RESOLVED BEFORE THE CHANNEL LOOP, because it now decides what goes IN it. An admin has no
    // access to a private salon they have not joined, so without this they would not see it exists
    // and could never join it - a capability nobody can reach is not a capability.
    let viewerCanManage = false;
    let viewerCanModerate = false;
    let viewerCanManageChannels = false;
    if (viewerMember.roleIds?.length) {
      const manageRoleIds = new Set(
        roles
          .filter((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))
          .map((r) => r.id)
      );
      const moderateRoleIds = new Set(
        roles.filter((r) => roleGrantsModeration(r.permissions)).map((r) => r.id)
      );
      viewerCanManage = viewerMember.roleIds.some((id) => manageRoleIds.has(id));
      viewerCanModerate = viewerMember.roleIds.some((id) => moderateRoleIds.has(id));
      const held = new Set(viewerMember.roleIds);
      viewerCanManageChannels = roles.some(
        (r) => held.has(r.id) && roleGrantsChannelManagement(r.permissions)
      );
    }

    const channels: Array<{
      id: string;
      workspaceId: string;
      name: string;
      visibility: 'public' | 'private';
      writePolicy: ChannelWritePolicy;
      viewerHasAccess: boolean;
      viewerCanWrite: boolean;
    }> = [];
    for (const ch of allChannels) {
      const hasAccess = this.canAccessChannel(ch, viewerMember, normalizedUserId);
      // An admin is shown a private salon they have not joined - its NAME and nothing else. No
      // message, no roster, no seed: every one of those goes through `canAccessChannel`, which
      // still says no. This row exists so the join is reachable, and it is the only thing that
      // leaks - a salon's existence, to someone who could add themselves to it in one click
      // anyway.
      if (!hasAccess && !viewerCanManage) continue;
      // Projected field by field, never the entity: a channel row carries columns no caller needs,
      // and serializing the entity handed every one of them to the client.
      channels.push({
        id: ch.id,
        workspaceId: ch.workspaceId,
        name: ch.name,
        visibility: ch.isPrivate ? 'private' : 'public',
        writePolicy: ch.writePolicy ?? 'everyone',
        viewerHasAccess: hasAccess,
        // ANSWERED HERE BECAUSE IT IS ALREADY KNOWN HERE. `writePolicy` alone does not tell a
        // client whether IT may write - that needs the viewer's roles, which this listing has just
        // resolved for the workspace. Sending the policy and letting each client re-derive the rest
        // would be a second copy of the rule, and the client holds no roles to derive it from.
        viewerCanWrite: writePolicyAllows(ch.writePolicy ?? 'everyone', {
          canManage: viewerCanManage,
          canModerate: viewerCanModerate,
        }),
      });
    }

    return {
      workspace: { ...ws, viewerCanManage, viewerCanModerate, viewerCanManageChannels },
      channels,
      members,
      roles,
    };
  }

  /** Returns all workspaces the user belongs to (derived from their ChannelMember records). */
  async listWorkspacesForUser(userId: string) {
    const memberships = await this.memberRepo.find({ where: { userId } });
    if (memberships.length === 0) return [];

    const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))];
    // A DELETED COMMUNITY LEAVES NO ROW IN ANY OF THESE TABLES, membership included, so an id
    // that resolves to nothing is the ordinary shape of one that is gone rather than a filtered
    // tombstone. This comment said the opposite until 2026-08-20 - it was written for the soft
    // delete and outlived it by two days, which is how a stale comment lies: it named a mechanism
    // (`archived`) that `hardDeleteWorkspace` had already made incapable of removing anything.
    const workspaces = await this.workspaceRepo.find({ where: { id: In(workspaceIds) } });

    // Derive per-workspace management rights server-side so the client can gate admin
    // controls (e.g. "change image", invite) without deriving permissions itself. We
    // batch-load every role referenced across the user's memberships to avoid an N+1
    // query, then flag each workspace where a held role carries MANAGE_WORKSPACE.
    const allRoleIds = [...new Set(memberships.flatMap((m) => m.roleIds ?? []))];
    const roles = allRoleIds.length
      ? await this.roleRepo.find({ where: { id: In(allRoleIds) } })
      : [];
    const manageRoleIds = new Set(
      roles
        .filter((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE))
        .map((r) => r.id)
    );
    // Moderation is a separate, weaker grant: it lets the client offer "delete this message"
    // on someone else's message without having to probe the API for a 403.
    const moderateRoleIds = new Set(
      roles.filter((r) => roleGrantsModeration(r.permissions)).map((r) => r.id)
    );
    const manageChannelsRoleIds = new Set(
      roles.filter((r) => roleGrantsChannelManagement(r.permissions)).map((r) => r.id)
    );
    const canManageByWorkspace = new Map<string, boolean>();
    const canModerateByWorkspace = new Map<string, boolean>();
    const canManageChannelsByWorkspace = new Map<string, boolean>();
    for (const membership of memberships) {
      const canManage = (membership.roleIds ?? []).some((id) => manageRoleIds.has(id));
      const canModerate = (membership.roleIds ?? []).some((id) => moderateRoleIds.has(id));
      const canManageChannels = (membership.roleIds ?? []).some((id) =>
        manageChannelsRoleIds.has(id)
      );
      canManageChannelsByWorkspace.set(
        membership.workspaceId,
        (canManageChannelsByWorkspace.get(membership.workspaceId) ?? false) || canManageChannels
      );
      // A user may hold several membership rows for the same workspace; any one row
      // bearing a MANAGE_WORKSPACE role is enough to manage it.
      canManageByWorkspace.set(
        membership.workspaceId,
        (canManageByWorkspace.get(membership.workspaceId) ?? false) || canManage
      );
      canModerateByWorkspace.set(
        membership.workspaceId,
        (canModerateByWorkspace.get(membership.workspaceId) ?? false) || canModerate
      );
    }

    // Personal display order: pick the lowest sortOrder across a user's membership rows
    // for a workspace (normally just one row per workspace, given the unique index).
    const sortOrderByWorkspace = new Map<string, number>();
    for (const membership of memberships) {
      const current = sortOrderByWorkspace.get(membership.workspaceId);
      if (current === undefined || membership.sortOrder < current) {
        sortOrderByWorkspace.set(membership.workspaceId, membership.sortOrder);
      }
    }

    return workspaces
      .map((w) => ({
        ...w,
        id: w.id,
        viewerCanManage: canManageByWorkspace.get(w.id) ?? false,
        viewerCanModerate: canModerateByWorkspace.get(w.id) ?? false,
        viewerCanManageChannels: canManageChannelsByWorkspace.get(w.id) ?? false,
      }))
      .sort(
        (a, b) => (sortOrderByWorkspace.get(a.id) ?? 0) - (sortOrderByWorkspace.get(b.id) ?? 0)
      );
  }

  /**
   * Persists the calling user's personal top-to-bottom order for their communities.
   * Ids absent from `orderedIds` keep their previous sortOrder (sort after the reordered ones).
   */
  async reorderWorkspacesForUser(userId: string, orderedIds: string[]): Promise<void> {
    this.logger.debug(`reorder ${orderedIds.length} workspaces for user=${userId}`);
    await Promise.all(
      orderedIds.map((workspaceId, index) =>
        this.memberRepo.update({ userId, workspaceId }, { sortOrder: index })
      )
    );
  }

  /** The sortOrder a salon created now takes: one past the community's current last. */
  private async nextChannelSortOrder(workspaceId: string): Promise<number> {
    const last = await this.channelRepo.maximum('sortOrder', { workspaceId });
    return last === null ? 0 : last + 1;
  }

  /**
   * Persists the order of a community's salons, SHARED by every member (unlike the personal order of
   * the community rail).
   *
   * PERMISSION: `memberCanManageChannels` - the one that already gates creating, renaming and
   * deleting a salon. Arranging the list is governance of the same object, so it must not be
   * weaker (any member rearranging everyone's sidebar) nor stronger (MANAGE_WORKSPACE alone would
   * lock out a role that may already delete the salons).
   *
   * `orderedIds` is the actor's VISIBLE list in its new order. A private salon the actor cannot see
   * is not in it and must not move relative to the others, so the visible ids are written back into
   * the slots the visible salons occupied and the hidden ones keep theirs. Every id must name a
   * salon of THIS community the actor may see, or the whole request is refused: a partial apply
   * would persist an order nobody drew.
   *
   * Announced as `workspace.updated { channelsReordered }` to the community, with NO ids: each
   * client re-reads its own filtered list, so a private salon's existence leaks to nobody.
   */
  async reorderChannels(
    workspaceId: string,
    actorUserId: string,
    orderedIds: string[]
  ): Promise<{ success: true; workspaceId: string; orderedIds: string[] }> {
    this.logger.debug(
      `[CHANNEL_ORDER] reorder workspace=${workspaceId} count=${orderedIds?.length} by=${actorUserId.slice(0, 8)}`
    );
    if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) {
      throw new BadRequestException('orderedIds must be a list of channel ids');
    }
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new BadRequestException('orderedIds contains a duplicate');
    }
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');
    if (!(await this.memberCanManageChannels(actorMember)))
      throw new ForbiddenException('Missing MANAGE_CHANNEL permission');

    const viewerCanManage = await this.memberHasWorkspaceManage(actorMember);
    const all = sortChannels(await this.channelRepo.find({ where: { workspaceId } }));
    const visible = new Set(
      all
        .filter((c) => viewerCanManage || this.canAccessChannel(c, actorMember, actorUserId))
        .map((c) => c.id)
    );
    const unknown = orderedIds.filter((id) => !visible.has(id));
    if (unknown.length > 0) {
      this.logger.warn(
        `[CHANNEL_ORDER] refused workspace=${workspaceId}: ${unknown.length} id(s) not visible salons of it`
      );
      throw new BadRequestException('orderedIds names a salon that is not in this community');
    }

    const named = new Set(orderedIds);
    const queue = [...orderedIds];
    const final = all.map((c) => (named.has(c.id) ? queue.shift()! : c.id));
    await this.channelRepo.manager.transaction(async (mgr) => {
      for (const [index, id] of final.entries()) {
        await mgr.update(Channel, { id, workspaceId }, { sortOrder: index });
      }
    });

    const workspaceMemberIds = await this.getWorkspaceMemberIds(workspaceId);
    await this.redis.publishChannelEvent(
      'workspace.updated',
      { workspaceId, channelsReordered: true },
      workspaceMemberIds
    );
    return { success: true, workspaceId, orderedIds };
  }

  // ================= ROLES =================

  /**
   * Creates a new workspace role. The actor manages roles, and the role grants nothing the actor
   * does not hold (`actorMayGrantRole`): creating a role is granting what it carries.
   */
  async createRole(input: CreateRoleDto & { actorUserId: string }) {
    const actorPermissions = await this.assertActorManagesRoles(
      input.workspaceId,
      input.actorUserId
    );
    if (!actorMayGrantRole(actorPermissions, input.permissions ?? [])) {
      this.refuseRoleChangeBeyondActor('create', input.workspaceId, input.actorUserId);
    }

    // THE RANK IS THE SERVER'S, and the body's `priority` is not read: the lowest role is what
    // joining grants (`baseMemberRole`) and the highest decides who is promoted when a community
    // loses its last administrator, so neither end is a caller's to choose. A new role ranks just
    // above the base role. The column has no default, so it is always set here.
    const base = this.baseMemberRole(
      await this.roleRepo.find({ where: { workspaceId: input.workspaceId } })
    );
    const priority = (base?.priority ?? 0) + 1;

    const role = this.roleRepo.create({
      workspaceId: input.workspaceId,
      name: input.name,
      priority,
      permissions: input.permissions,
    });
    this.logger.log(
      `[ROLE] created workspace=${input.workspaceId} priority=${priority} perms=${(input.permissions ?? []).length} by=${input.actorUserId.slice(0, 8)}`
    );
    return this.roleRepo.save(role);
  }

  // ================= CHANNELS =================

  /**
   * Creates a channel inside a workspace. A private one is listed to its creator alone, so it is
   * refused (`REMOVAL_EXCEEDS_ACTOR`) when a member it leaves off holds more than the creator.
   */
  async createChannel(input: CreateChannelDto) {
    // Check actor has permission to manage channels in this workspace
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: input.workspaceId, userId: input.actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    if (!(await this.memberCanManageChannels(actorMember)))
      throw new ForbiddenException('Missing MANAGE_CHANNEL permission');

    const channelName = validateChannelName(input.name);

    const isPrivate = input.visibility === 'private';
    const creator = input.actorUserId.trim().toLowerCase();

    const channel = this.channelRepo.create({
      workspaceId: input.workspaceId,
      name: channelName,
      isPrivate,
      allowedUsers: isPrivate ? [creator] : [],
      // LAST in the community's order: a new salon never lands between two the bureau arranged.
      sortOrder: await this.nextChannelSortOrder(input.workspaceId),
    });
    // A PRIVATE SALON IS HIDDEN FROM EVERY MEMBER BUT ITS CREATOR, the same removal a salon made
    // private is (`updateChannelAccess`), so it faces the same bound under the same lock: nobody it
    // leaves off may hold more than the creator (user, 2026-10-24: only high ranks make a salon
    // private when an admin exists).
    const savedChannel = isPrivate
      ? await this.withCommunityRemovalLock(input.workspaceId, async (m) => {
          const leftOff = (
            await m.getRepository(ChannelMember).find({ where: { workspaceId: input.workspaceId } })
          )
            .map((member) => member.userId)
            .filter((u) => u.trim().toLowerCase() !== creator);
          await this.assertActorMayRemoveMembers(
            input.workspaceId,
            input.actorUserId,
            leftOff,
            'skip',
            m
          );
          return m.getRepository(Channel).save(channel);
        })
      : await this.channelRepo.save(channel);

    if (isPrivate) {
      // UNWOUND ON FAILURE, exactly as `createWorkspace` unwinds a community whose distribution
      // group could not be minted. A salon marked private with no group of its own is a salon whose
      // seeds have nowhere to go, and the row would sit there looking usable.
      try {
        await this.ensureChannelDistributionGroup(savedChannel, true);
      } catch (e) {
        await this.channelRepo.delete({ id: savedChannel.id });
        this.logger.error(
          `[CHANNEL_GRAINE] private salon unwound channel=${savedChannel.id} - no distribution group: ` +
            `${e instanceof Error ? e.message : String(e)}`
        );
        throw e;
      }
    }

    // A CREATION IS A GRANT, AND EVERY OTHER GRANT HERE ANNOUNCES ITSELF. The three paths that put
    // a user into `allowedUsers` - an accepted invite, an admin join, an added member - each publish
    // this event to `channelAudience`, and each does it AFTER the grant so the newly-admitted person
    // is inside the audience rather than the one person it misses. Creation was the only grant that
    // told nobody, including the creator's own other devices.
    //
    // The consequence was not cosmetic. The only ways into a private salon's distribution group are
    // a full workspace load - post-login, the `online` event, or a deep link - and this event, so a
    // second device already running joined nothing and could not decrypt a word of the salon until
    // it was relaunched. COMM-25 measured it on 2026-08-21: the phone joined the group of all three
    // private salons that existed when it loaded its workspaces, and never heard about the one
    // created nine seconds later. A public salon has the same hole with no MLS consequence - it
    // simply did not appear for anybody until their next load.
    //
    // The audience is derived from access, so a private salon reaches its `allowedUsers` (here, the
    // creator alone, on every device they hold) and a public one reaches the whole community.
    const workspace = await this.workspaceRepo.findOne({ where: { id: savedChannel.workspaceId } });
    const audience = await this.channelAudience(savedChannel);
    await this.redis.publishChannelEvent(
      'channel.member.joined',
      {
        channelId: savedChannel.id,
        channelName: savedChannel.name,
        workspaceId: savedChannel.workspaceId,
        workspaceSlug: workspace?.slug,
        workspaceName: workspace?.name,
        visibility: savedChannel.isPrivate ? 'private' : 'public',
        joinedBy: input.actorUserId,
      },
      audience
    );

    return {
      id: savedChannel.id,
      workspaceId: savedChannel.workspaceId,
      name: savedChannel.name,
      visibility: savedChannel.isPrivate ? 'private' : 'public',
    };
  }

  /** Updates the workspace's cover image and broadcasts a workspace.updated event to all members. */
  async updateWorkspaceImage(workspaceId: string, actorUserId: string, mediaId: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mediaId)) {
      throw new ForbiddenException('Invalid mediaId format');
    }

    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE));
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_WORKSPACE permission');

    workspace.imageMediaId = mediaId;
    await this.workspaceRepo.save(workspace);

    const workspaceMemberIds = await this.getWorkspaceMemberIds(workspaceId);
    await this.redis.publishChannelEvent(
      'workspace.updated',
      { workspaceId, imageMediaId: mediaId },
      workspaceMemberIds
    );

    return { success: true, workspaceId, imageMediaId: mediaId };
  }

  /**
   * Sets what the community lets a newcomer read, and tells every member.
   *
   * **The server cannot enforce this and does not pretend to.** It holds no seed; the rule is
   * applied by whichever member answers a joiner's history request, which is why the value has to
   * be readable by every device rather than kept as one admin's local preference. Broadcasting it
   * is not a nicety either: a member still holding `shared` in memory would keep handing the past
   * over after an admin had closed it.
   */
  async updateWorkspaceHistoryVisibility(
    workspaceId: string,
    actorUserId: string,
    historyVisibility: HistoryVisibility
  ) {
    if (historyVisibility !== 'shared' && historyVisibility !== 'joined') {
      throw new BadRequestException({
        code: 'HISTORY_VISIBILITY_INVALID',
        message: `historyVisibility must be 'shared' or 'joined'`,
      });
    }

    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('Workspace not found');
    if (
      !(await this.memberHasWorkspacePermission(
        workspaceId,
        actorUserId,
        CHANNEL_PERMISSIONS.MANAGE_WORKSPACE
      ))
    ) {
      throw new ForbiddenException('Missing MANAGE_WORKSPACE permission');
    }

    workspace.historyVisibility = historyVisibility;
    await this.workspaceRepo.save(workspace);
    // Logged at info: it changes what every future joiner may read, it is rare, and it is the only
    // trace of who opened or closed a community's past.
    this.logger.log(
      `[WORKSPACE] historyVisibility=${historyVisibility} workspace=${workspaceId} by=${actorUserId.slice(0, 8)}`
    );

    const workspaceMemberIds = await this.getWorkspaceMemberIds(workspaceId);
    await this.redis.publishChannelEvent(
      'workspace.updated',
      { workspaceId, historyVisibility },
      workspaceMemberIds
    );

    return { success: true, workspaceId, historyVisibility };
  }

  /**
   * Removes the user from the workspace and broadcasts a member-kicked event so other clients clean
   * up their UI.
   *
   * Both halves of the governance postcondition apply here: the last admin is refused until they
   * hand the role over, and the last member leaving takes the community with them.
   */
  async leaveWorkspace(workspaceId: string, userId: string) {
    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member) throw new NotFoundException('Not a member of this workspace');

    await this.assertRemovalKeepsAnAdmin(workspaceId, userId);

    await this.removeFromWorkspace(workspaceId, userId, 'left');

    const remainingMemberIds = await this.getWorkspaceMemberIds(workspaceId);
    // Published before any deletion: the event is what tells the leaver's own devices to drop the
    // community, and its audience is passed explicitly rather than resolved from rows that may be
    // about to disappear.
    await this.redis.publishChannelEvent(
      'channel.member.kicked',
      { workspaceId, kickedUserId: userId, kickedBy: userId },
      [...remainingMemberIds, userId]
    );

    if (remainingMemberIds.length === 0) {
      await this.hardDeleteWorkspace(workspaceId, 'last_member_left');
    }

    return { success: true };
  }

  /**
   * Deletes an entire community, for real, and broadcasts `workspace.deleted` so every member's
   * client drops it from the sidebar and purges its channels locally.
   *
   * Admin-only on purpose: unlike a kick or a channel archive, this acts on everyone at once, so
   * MANAGE_CHANNEL is deliberately NOT enough - only MANAGE_WORKSPACE.
   *
   * It used to archive instead, which kept a mistake recoverable "with two UPDATEs". That stopped
   * being true with Graine: an archived community's messages are ciphertext whose seeds no client
   * keeps, so the rows would survive as something nobody can read, invisible to every screen and
   * impossible to delete afterwards - the exact orphan shape the 2026-08-17 purge had to find by
   * hand. Recoverability that only recovers unreadable rows is not recoverability.
   *
   * `confirmationName` MUST equal the community's name, and it is checked HERE rather than only in
   * the dialog. Not defence in depth for its own sake: the fleet still holds clients built when
   * this call archived, whose confirmation was worded for a reversible action. Turning the server
   * irreversible without a new argument would make those clients destroy a community behind a
   * warning that no longer describes what happens. Requiring an argument they do not send makes
   * them fail closed, which is the only safe way for this change to meet an old client.
   */
  async deleteWorkspace(workspaceId: string, actorUserId: string, confirmationName: string) {
    const workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = roles.some((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE));
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_WORKSPACE permission');

    // Checked after the permission checks on purpose: a non-admin must not be able to probe
    // whether a name matches. Trimmed on both sides because a copied name carries whitespace;
    // otherwise exact, since the whole point is having read what is about to be destroyed.
    if (confirmationName.trim() !== workspace.name.trim()) {
      this.logger.warn(
        `[WORKSPACE] delete refused, name mismatch workspace=${workspaceId} by=${actorUserId.slice(0, 8)}`
      );
      throw new BadRequestException({
        code: 'WORKSPACE_CONFIRMATION_MISMATCH',
        message: 'The confirmation does not match the community name.',
      });
    }

    // Snapshot the audience BEFORE deleting: the event has to reach every member, and the
    // membership rows the broadcast resolves against are about to be gone.
    const memberIds = await this.getWorkspaceMemberIds(workspaceId);
    const slug = workspace.slug;

    await this.hardDeleteWorkspace(workspaceId, 'admin_deleted');

    await this.redis.publishChannelEvent(
      'workspace.deleted',
      { workspaceId, deletedBy: actorUserId },
      memberIds
    );

    this.logger.log(
      `[WORKSPACE] delete workspace=${workspaceId} slug="${slug}" by=${actorUserId.slice(0, 8)} members=${memberIds.length}`
    );
    return { success: true, workspaceId };
  }

  /** Renames a channel (lowercased) and broadcasts a channel.updated event so connected clients update their sidebar. */
  async renameChannel(channelId: string, actorUserId: string, newName: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    if (!(await this.memberCanManageChannels(actorMember)))
      throw new ForbiddenException('Missing MANAGE_CHANNEL permission');

    const trimmedName = validateChannelName(newName);

    channel.name = trimmedName;
    // The one column: a save of this unlocked copy would write back its visibility and allowlist.
    await this.channelRepo.update({ id: channelId }, { name: trimmedName });

    // The new NAME of a private salon is not the community's business.
    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.updated',
      { channelId, name: channel.name, workspaceId: channel.workspaceId },
      audience
    );

    return { success: true, channelId, name: channel.name };
  }

  /** Returns the channel's current access settings plus the workspace's available roles. */
  async getChannelAccess(channelId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');
    // `allowedUsers` IS the private salon's roster. Being in the community was enough to read it,
    // which handed its membership to people who cannot open the salon - the same question
    // `listChannelMembers` already asks one method away.
    //
    // BUT THE READ MUST NOT BE STRICTER THAN THE WRITE IT PRECEDES. `updateChannelAccess` guards on
    // MANAGE_CHANNEL, so a manager may already REWRITE this list and put themselves on it; refusing
    // them the read protects nothing it does not already hand over, and it removed the only recovery
    // the 2026-08-19 decision promised ("an admin sees it exists and may add themselves in one
    // act"). Measured as COMM-23's original failure: flipping a public salon private submits the
    // panel's allowlist, which for a public salon is EMPTY, and from then on `loadChannelAccess`
    // throws, `accessLoaded` stays false and the access tab renders its error box ALONE - no
    // visibility toggle, no allowlist, no add control, so the promised act had no gesture behind it.
    //
    // This does NOT restore the ambient admin fall-through that went with the per-salon distribution
    // group (see `canAccessChannel`). That one answered "may I read this salon" - its messages, its
    // roster on every listing, its seeds - for every private salon in the community. This answers
    // "may I read the SETTINGS I am already allowed to write", on one channel, from the one panel
    // that writes them.
    const readable = this.canAccessChannel(channel, member, actorUserId);
    const mayManage = readable || (await this.memberCanManageChannels(member));
    if (!mayManage) {
      throw new ForbiddenException('Not allowed to access this channel');
    }
    if (!readable) {
      // The recovery path, and the only line that says it was taken. Rare by construction: a manager
      // who is on the allowlist is `readable` and never spends the permission query.
      this.logger.log(
        `[CHANNEL_ACCESS] settings served to manager ${actorUserId} outside the allowlist of ${channelId}`
      );
    }

    return channelAccessState(channel);
  }

  /**
   * Updates the channel's visibility, allowed-user list, and write policy. Requires MANAGE_CHANNEL
   * permission.
   *
   * @param baseAccessRevision the {@link Channel.accessRevision} the caller's list was read at. A
   *   rewrite of any other revision is refused whole with `409 CHANNEL_ACCESS_CHANGED`, carrying the
   *   current access: the caller's list predates a write it never saw, and diffing it against the row
   *   would read whoever that write granted as a removal. `undefined` is a client older than the
   *   revision (docs/wiki/legacy-compatibility.md): {@link baselessAllowList} reads its request as
   *   the one gesture it can be, so it drops nobody and grants at most the name it appended.
   */
  async updateChannelAccess(
    channelId: string,
    actorUserId: string,
    isPrivate: boolean,
    allowedUserIds: string[],
    writePolicy?: ChannelWritePolicy,
    baseAccessRevision?: number
  ) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    if (!(await this.memberCanManageChannels(actorMember)))
      throw new ForbiddenException('Missing MANAGE_CHANNEL permission');

    // A STALE BASE IS REFUSED BEFORE ANYTHING IS COMPUTED FROM IT - no group minted, no eviction
    // begun. Asked again under the lock below, where it is authoritative.
    if (baseAccessRevision !== undefined && baseAccessRevision !== channel.accessRevision) {
      this.refuseStaleAccessRewrite(channel, actorUserId, baseAccessRevision);
    }

    // WHO LOSES ACCESS, COMPUTED BEFORE THE ROW CHANGES. After the save the old roster is gone, and
    // a member dropped from a private salon would keep being routed its seeds with nothing left
    // anywhere to say they should not be.
    const wasPrivate = channel.isPrivate;
    const previousAllowed = new Set(channel.allowedUsers || []);
    const requested = isPrivate ? allowedUserIds.map((u) => u.trim().toLowerCase()) : [];
    const nextAllowed =
      baseAccessRevision === undefined
        ? this.baselessAllowList(channel, actorUserId, isPrivate, requested, writePolicy)
        : requested;
    // MAKING A SALON PRIVATE GRANTS WHOEVER DID IT, the rule `createChannel` already applies to a
    // salon created private. The panel offers its allowlist only once the SERVER holds the salon
    // private (members are granted one at a time, at once), so the flip always arrives with an empty
    // list - and an empty private salon is one nobody can open, its maker included, which is the
    // state `chat_no_allowed_members_warning` names. COMM-23 granted the owner by hand for this.
    const actorNormalised = actorUserId.trim().toLowerCase();
    if (isPrivate && !wasPrivate && !nextAllowed.includes(actorNormalised)) {
      this.logger.log(
        `[CHANNEL_ACCESS] made private by ${actorUserId.slice(0, 8)}, granting them channel=${channelId}`
      );
      nextAllowed.push(actorNormalised);
    }
    // ONLY WHILE IT STAYS PRIVATE. A salon going public loses its group entirely a few lines below,
    // and that retirement supersedes every per-user cut - evicting people who are about to regain
    // access as ordinary community members would be work with no reader.
    const dropped =
      wasPrivate && isPrivate ? [...previousAllowed].filter((u) => !nextAllowed.includes(u)) : [];

    // EVERYONE WHO LOSES SIGHT OF THE SALON IS REMOVED FROM IT, and faces the removal bound - not
    // only a private allowlist's diff. Going private takes the salon from every member left off the
    // list, so the population is the audience before (the allowlist, or the whole community while
    // public) minus the audience after; going public takes it from nobody. So a member holding only
    // `channel.manage` cannot make a salon private while it leaves off someone who outranks them
    // (user, 2026-10-24: only high ranks make a salon private when an admin exists).
    const losingSight = (communityMemberIds: readonly string[]): string[] =>
      isPrivate
        ? (wasPrivate ? [...previousAllowed] : communityMemberIds).filter(
            (u) => !nextAllowed.includes(u.trim().toLowerCase())
          )
        : [];
    // Answered BEFORE any call to chat-delivery (the group minted below, the first evictions), so a
    // refused rewrite mints and cuts nothing; asked again under the lock before the save.
    await this.assertActorMayRemoveMembers(
      channel.workspaceId,
      actorUserId,
      losingSight(wasPrivate ? [] : await this.getWorkspaceMemberIds(channel.workspaceId)),
      'skip'
    );

    // BEFORE THE SAVE, and allowed to abort it - the same asymmetry as a community departure. Going
    // private without a group would leave the salon's seeds nowhere to go; the people this save
    // drops leave the salon's group as one departure, the save being its roster write.
    // `dropped` is non-empty only while the salon stays private, so its group is the one cut.
    const mintedGroup = isPrivate && !wasPrivate;
    if (mintedGroup) await this.ensureChannelDistributionGroup(channel, isPrivate);
    try {
      await this.departDistributionGroups(
        this.channelCuts(channel, dropped),
        'access_updated',
        channel.workspaceId,
        async (m) => {
          // THE ROW IS RE-READ `FOR UPDATE` UNDER THE LOCK. `dropped` and the first evictions came
          // from the copy read above, at the caller's base revision; if any access write committed
          // since, they name the wrong people, and saving this list would erase that write. Refused
          // whole and retryable: the departure is abandoned, so nobody is cut off.
          const locked = await m.getRepository(Channel).findOne({
            where: { id: channelId },
            lock: { mode: 'pessimistic_write' },
          });
          if (!locked) throw new NotFoundException('Channel not found');
          if (locked.accessRevision !== channel.accessRevision) {
            this.refuseStaleAccessRewrite(locked, actorUserId, channel.accessRevision);
          }
          // WHOEVER THIS SAVE ADDS IS STILL A MEMBER, asked here and nowhere earlier. A kick that
          // committed while this waited on the removal lock cut no salon when it read none naming
          // its target, so the revision above did not move - and without this the save would put a
          // non-member on the allowlist, restored the day they rejoin. Every name of a salon
          // becoming private is an addition (`gained` below says why); an entry the row already
          // holds is not, so a list that outlived a membership stays editable.
          const lockedAllowed = new Set(locked.isPrivate ? locked.allowedUsers || [] : []);
          await this.assertGranteesAreMembers(
            m,
            locked,
            actorUserId,
            nextAllowed.filter((u) => !lockedAllowed.has(u))
          );
          const communityMemberIds = wasPrivate
            ? []
            : (
                await m.getRepository(ChannelMember).find({
                  where: { workspaceId: channel.workspaceId },
                })
              ).map((member) => member.userId);
          await this.assertActorMayRemoveMembers(
            channel.workspaceId,
            actorUserId,
            losingSight(communityMemberIds),
            'skip',
            m
          );
          locked.isPrivate = isPrivate;
          locked.allowedUsers = nextAllowed;
          if (writePolicy) {
            locked.writePolicy = writePolicy;
          }
          locked.accessRevision += 1;
          await m.getRepository(Channel).save(locked);
          channel.accessRevision = locked.accessRevision;
        }
      );
    } catch (e) {
      // THE GROUP MINTED ABOVE IS LEFT, NOT RETIRED. While the salon stays public it is inert, and
      // the next flip gets it back (the mint is idempotent). Retiring it from here would be a call
      // outside the lock, and a concurrent flip that did commit may be using the very same group.
      if (mintedGroup) {
        this.logger.warn(
          `[CHANNEL_GRAINE] privacy refused, minted group kept channel=${channelId} ` +
            `group=${channel.distributionGroupId} by=${actorUserId.slice(0, 8)}`
        );
      }
      throw e;
    }
    channel.isPrivate = isPrivate;
    channel.allowedUsers = nextAllowed;
    if (writePolicy) {
      channel.writePolicy = writePolicy;
    }

    // AFTER the save, and best-effort: the salon is public now, so its own group distributes to a
    // roster nothing consults - inert if it survives, and refusing the change over it would be
    // worse. The community's group takes over from here.
    if (!isPrivate && wasPrivate) await this.retireChannelDistributionGroup(channel, 'made_public');

    // WHO THIS SAVE LET IN. Not simply the roster's diff: three populations have to hear about it,
    // for two different reasons, and only the first of them is a diff at all.
    //
    //  - private -> private: the users named now and not before. They gain sight of the salon AND a
    //    group to enter.
    //  - public -> private: EVERY user named now. They could all see the salon already, so in access
    //    terms nothing was gained - but the group is BRAND NEW (`ensureChannelDistributionGroup`
    //    minted it above) and not one of them is on it. `previousAllowed` is evidence about who
    //    could SEE the salon and never about who is on a group that did not exist, so diffing
    //    against it here would answer a question nobody asked. COMM-23 measured the omission: one
    //    delivery row and epoch 0, against two rows and epoch 1 on the create path.
    //  - private -> public: everyone in the community who could not see it before. There is no group
    //    to enter - the community's own carries a public salon's seeds and they are all on that
    //    already - but the salon is absent from their screen entirely, because `channel.updated`
    //    maps over the rows a client already holds and creates none.
    const audience = await this.channelAudience(channel);
    const gained = isPrivate
      ? wasPrivate
        ? nextAllowed.filter((u) => !previousAllowed.has(u))
        : nextAllowed
      : wasPrivate
        ? audience.filter((u) => !previousAllowed.has(u))
        : [];
    await this.announceChannelAccessGranted(channel, gained);

    // THE RULE CHANGED FOR PEOPLE WHO ARE ALREADY LOOKING AT THE SALON, and until 2026-08-20 they
    // learned of it only on their next full load: COMM-7 found a member still holding a composer in
    // a salon that had just been reserved for administrators, typing into it and collecting a 403.
    // The server refusing correctly is half a rule - the other half is the person being told.
    //
    // THE DECISION TRAVELS, NEVER THE POLICY, so the audience is SPLIT BY THE ANSWER and each half
    // is sent its own: one payload cannot carry a per-viewer verdict, and a client holds none of the
    // roles it would need to derive one. Two publishes at most, whatever the community's size.
    const decisions = await this.writeDecisionsFor(channel, audience);
    for (const mayWrite of [true, false]) {
      const half = audience.filter((u) => (decisions.get(u) ?? true) === mayWrite);
      if (half.length === 0) continue;
      await this.redis.publishChannelEvent(
        'channel.updated',
        {
          channelId,
          workspaceId: channel.workspaceId,
          isPrivate: channel.isPrivate,
          viewerCanWrite: mayWrite,
        },
        half
      );
    }
    this.logger.log(
      `[CHANNEL] access updated channel=${channelId} private=${channel.isPrivate} ` +
        `writePolicy=${channel.writePolicy ?? 'everyone'} audience=${audience.length} ` +
        `mayWrite=${[...decisions.values()].filter(Boolean).length} ` +
        `revision=${channel.accessRevision} base=${baseAccessRevision ?? 'none'}`
    );

    return { ok: true, ...channelAccessState(channel) };
  }

  /**
   * What a rewrite with NO base (a client older than the access revision, see
   * docs/wiki/legacy-compatibility.md) may do, read from the only panel such a client can run.
   *
   * Every client the `1.0.3` floor admits runs the panel of 2026-09-28 (`v0.18.29`), whose three
   * gestures are known exactly, and its list is the one it read when the tab opened - so the list is
   * EVIDENCE OF NOTHING but the one name it appended:
   *  - Add: `(isPrivate as read, list + pick)`, no write policy - the pick is the LAST element;
   *  - the visibility toggle: `(!isPrivate as read, list)`, no write policy - going private, the list
   *    of a public salon, which that panel always holds empty;
   *  - the write policy: `(isPrivate as read, list, policy)`.
   *
   * So, refused `409 CHANNEL_ACCESS_CHANGED` when the request flips the visibility in a way no fresh
   * gesture would: with a write policy (a policy save never flips), or going private with a list
   * (the toggle sends none) - both are a panel that read the other visibility. Otherwise a salon that
   * stays private gains at most the appended pick, and nobody is dropped: an absence from a stale
   * list is not a removal (its trash is the per-member DELETE), and a name present in it is not a
   * grant (it may have been revoked since).
   */
  private baselessAllowList(
    channel: Channel,
    actorUserId: string,
    isPrivate: boolean,
    requested: string[],
    writePolicy: ChannelWritePolicy | undefined
  ): string[] {
    const previous = channel.allowedUsers || [];
    if (
      isPrivate !== channel.isPrivate &&
      (writePolicy !== undefined || (isPrivate && requested.length > 0))
    ) {
      this.refuseStaleAccessRewrite(channel, actorUserId, 'none');
    }
    if (!isPrivate) return [];
    if (!channel.isPrivate) return []; // going private, with the empty list the toggle sends
    const pick = writePolicy === undefined ? requested[requested.length - 1] : undefined;
    const next = pick && !previous.includes(pick) ? [...previous, pick] : [...previous];
    const ignored =
      requested.filter((u) => !next.includes(u)).length +
      previous.filter((u) => !requested.includes(u)).length;
    if (ignored > 0) {
      this.logger.warn(
        `[CHANNEL_ACCESS] baseless rewrite (client older than the access revision) - ${ignored} ` +
          `name(s) of its list ignored, granted=${pick && next.length > previous.length ? 1 : 0} ` +
          `channel=${channel.id} by=${actorUserId.slice(0, 8)} revision=${channel.accessRevision}`
      );
    }
    return next;
  }

  /**
   * Refuses an access rewrite computed at `base` while the salon is at another revision: the typed
   * `409 CHANNEL_ACCESS_CHANGED`, carrying the CURRENT access so the caller can show it at once.
   */
  private refuseStaleAccessRewrite(
    current: Channel,
    actorUserId: string,
    base: number | 'none'
  ): never {
    this.logger.warn(
      `[CHANNEL_ACCESS] refused - the salon changed since it was read channel=${current.id} ` +
        `by=${actorUserId.slice(0, 8)} base=${base} current=${current.accessRevision}`
    );
    throw new ConflictException({
      code: CHANNEL_ACCESS_CHANGED,
      message: 'The salon access changed meanwhile, retry.',
      current: channelAccessState(current),
    });
  }

  /**
   * Refuses an access rewrite that ADDS someone who is not a member of the salon's community: the
   * typed `409 CHANNEL_GRANTEE_NOT_MEMBER`, carrying the current access.
   *
   * RUN UNDER THE COMMUNITY'S REMOVAL LOCK, through its transaction `m`, which is what makes it a
   * check and not a preview: every departure's roster write (a kick, leaving, an erasure) holds that
   * lock, so one that committed while the rewrite waited is seen here, and the membership rows read
   * are share-locked until the save commits - the same lock `grantPrivateChannelAccess` takes on its
   * one grantee. The community's rows are read whole and matched case-blind, as
   * {@link assertActorMayRemoveMembers} reads them, because an allowlist entry is lowercased and a
   * membership row keeps its id as written.
   */
  private async assertGranteesAreMembers(
    m: EntityManager,
    locked: Channel,
    actorUserId: string,
    granteeIds: readonly string[]
  ): Promise<void> {
    if (granteeIds.length === 0) return;
    const rows = await m.getRepository(ChannelMember).find({
      where: { workspaceId: locked.workspaceId },
      lock: { mode: 'pessimistic_read' },
    });
    const members = new Set(rows.map((r) => r.userId.trim().toLowerCase()));
    const absent = granteeIds.filter((u) => !members.has(u.trim().toLowerCase()));
    if (absent.length === 0) return;
    this.logger.warn(
      `[CHANNEL_ACCESS] refused - the rewrite grants ${absent.length} non-member(s) ` +
        `channel=${locked.id} by=${actorUserId.slice(0, 8)} ` +
        `first=${absent[0].slice(0, 8)} revision=${locked.accessRevision}`
    );
    throw new ConflictException({
      code: CHANNEL_GRANTEE_NOT_MEMBER,
      message: 'Someone this list grants is no longer a member of the community.',
      current: channelAccessState(locked),
    });
  }

  /**
   * Deletes a salon, for real - its row, its messages and its key-distribution group.
   *
   * IT USED TO ARCHIVE, which was the community's own defect one scope down. `archived = true` hid
   * the salon from every listing while the same call destroyed the group holding its seeds, so a
   * private salon's messages survived as ciphertext no client on earth could open: invisible to
   * every screen, unreachable by every route, and removable only by deleting the whole community.
   * Nothing could bring it back either - there is no un-archive anywhere in this service, and never
   * was. The reasoning is {@link deleteWorkspace}'s, unchanged one level down: recoverability that
   * only recovers unreadable rows is not recoverability.
   *
   * NO CONFIRMATION ARGUMENT, and the asymmetry with `deleteWorkspace` is a measurement rather than
   * an oversight. That call needed one because the fleet held clients whose dialog described a
   * REVERSIBLE action, and making the server irreversible behind that wording would have destroyed
   * a community behind a warning that no longer described it. This dialog has read "Supprimer
   * definitivement le canal #x ?" since 2026-06-16, which is the first version of the string that
   * ever shipped: every client in the field already promises exactly what this now does, so there
   * is nothing to fail closed against and an argument would only break them for no gain.
   *
   * MANAGE_CHANNEL is enough here where the community demands MANAGE_WORKSPACE. A salon is one room
   * and governing rooms is what that permission IS; deleting a community acts on everyone at once.
   */
  async deleteChannel(channelId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    if (!(await this.memberCanManageChannels(actorMember)))
      throw new ForbiddenException('Missing MANAGE_CHANNEL permission');

    // Snapshot the audience BEFORE anything goes. `channelAudience` reads the salon's own roster off
    // the row this is about to delete, so afterwards there is nobody left to address the event to -
    // the same reason `deleteWorkspace` takes its member ids first.
    const audience = await this.channelAudience(channel);
    const workspaceId = channel.workspaceId;

    // BEFORE the transaction, and allowed to ABORT it - the one line separating this from the
    // archive it replaces. `retireChannelDistributionGroup` swallows its failure deliberately: there
    // the salon survives, so a group outliving its retirement is inert and refusing the change would
    // be worse. Here the row is about to be gone, and a group nothing names any more is exactly the
    // orphan the 2026-08-17 purge had to find by hand. Failing here leaves the salon whole and the
    // deletion retryable, which is the only outcome that stays reconcilable.
    if (channel.distributionGroupId) {
      await deleteDistributionGroup(this.internalSecret, channelScope(channel.id));
    }

    // Named by hand for the reason `hardDeleteWorkspace` gives: there is not one foreign key on
    // `channels`, so nothing cascades and nothing would complain if a table were forgotten.
    // `channel_messages` is the only one keyed by channel - checked, not assumed.
    await this.channelRepo.manager.transaction(async (mgr) => {
      await mgr.delete(ChannelMessage, { channelId });
      await mgr.delete(Channel, { id: channelId });
    });

    await this.redis.publishChannelEvent('channel.deleted', { channelId, workspaceId }, audience);

    this.logger.log(
      `[CHANNEL] delete channel=${channelId} workspace=${workspaceId} ` +
        `private=${channel.isPrivate} group=${channel.distributionGroupId ?? 'none'} ` +
        `by=${actorUserId.slice(0, 8)} audience=${audience.length}`
    );

    return { success: true };
  }

  /**
   * Lists the channels a user may see in a workspace.
   *
   * MAY SEE, not may read, and the two stopped being the same thing on 2026-08-19: an
   * administrator is shown a private salon they have not joined - its name, its `viewerHasAccess:
   * false`, and nothing else. Every other route still refuses them its messages, its roster and its
   * seeds, because all of those go through `canAccessChannel`, which says no until they join.
   *
   * The row exists so the join is REACHABLE. Without it, making the admin bypass explicit would
   * have made private salons invisible to the only people who can moderate them - and what leaks
   * is a salon's existence, to someone who can add themselves to it in one click anyway.
   *
   * The same projection as `getWorkspaceBySlug` and deliberately so: two lists of the same channels
   * differing in one field is a client that renders a salon one way through the sidebar and another
   * through the community page.
   */
  async listChannelsForUser(workspaceId: string, userId: string) {
    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member) throw new ForbiddenException('Not a member of this workspace');

    const viewerCanManage = await this.memberHasWorkspaceManage(member);
    const channels = sortChannels(await this.channelRepo.find({ where: { workspaceId } }));
    const visible: Array<{
      id: string;
      workspaceId: string;
      name: string;
      visibility: 'public' | 'private';
      viewerHasAccess: boolean;
    }> = [];
    for (const channel of channels) {
      const hasAccess = this.canAccessChannel(channel, member, userId);
      if (!hasAccess && !viewerCanManage) continue;
      visible.push({
        id: channel.id,
        workspaceId: channel.workspaceId,
        name: channel.name,
        visibility: channel.isPrivate ? 'private' : 'public',
        viewerHasAccess: hasAccess,
      });
    }
    return visible;
  }

  /** True when the member holds a role carrying MANAGE_WORKSPACE. */
  private async memberHasWorkspaceManage(member: ChannelMember): Promise<boolean> {
    if (!member.roleIds?.length) return false;
    const roles = await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    return roles.some((r) => r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE));
  }

  /**
   * Whether the member may govern the salons of their workspace - {@link roleGrantsChannelManagement}
   * over the roles they hold. Every salon-governing write refuses on it, and the listings send it.
   */
  private async memberCanManageChannels(member: ChannelMember): Promise<boolean> {
    if (!member.roleIds?.length) return false;
    const roles = await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    return roles.some((r) => roleGrantsChannelManagement(r.permissions));
  }

  /**
   * Whether the user has an active MLS device registered in chat-delivery.
   *
   * FAILS CLOSED, since 2026-08-19. It used to answer `true` on a non-2xx AND on any thrown error
   * AND on an unset secret, so the day its URL was missing the `/api` prefix it was a constant
   * `true` - a guard nobody had, for as long as nobody looked. Now it answers only what a genuine
   * 200 said, and anything else throws out of `fetchUserDeviceCount`.
   *
   * @throws ServiceUnavailableException when the question could not be asked
   */
  private async userHasMlsDevices(userId: string): Promise<boolean> {
    return (await fetchUserDeviceCount(this.internalSecret, userId)) > 0;
  }

  /**
   * The role an invitation may grant its invitee, or a refusal - never a silent downgrade, because
   * a member invited as something other than what was asked would be a grant nobody chose.
   *
   * Inviting is `member.invite` (or `channel.manage`); granting a role is role management. So the
   * invitation grants the community's base role - what an invite link grants - unless the request
   * names another role AND `actorMayGrantRole` lets this actor hand it out, the same right the
   * role-management endpoints require, bounded by what the actor holds. No role named means the
   * base role. A named role the community does not have grants nothing, as it always has.
   *
   * @throws ForbiddenException `INVITE_ROLE_NOT_GRANTABLE` when the actor may not grant that role
   */
  private async resolveInviteGrantedRole(
    workspaceId: string,
    actorUserId: string,
    actorRoles: readonly ChannelRole[],
    requestedName: string | undefined
  ): Promise<ChannelRole | null> {
    const roles = await this.roleRepo.find({ where: { workspaceId } });
    const base = this.baseMemberRole(roles);
    if (!requestedName) return base;
    const wanted = this.mapRoleInputToWorkspaceRoleName(requestedName);
    // "Membre" is how every client up to the current stable names the ordinary invitation, so it
    // means the base role even in a community whose lowest role is called something else. Matching
    // a role literally named Membre first waits for `minClientVersion` (see backlog).
    if (wanted === 'Membre' || wanted === base?.name) return base;
    const role = roles.find((r) => r.name === wanted) ?? null;
    if (!role || role.id === base?.id) return role;

    const actorPermissions = [...new Set(actorRoles.flatMap((r) => r.permissions))];
    if (actorMayGrantRole(actorPermissions, role.permissions)) {
      this.logger.debug(
        `[INVITE] grant of role=${role.name} allowed workspace=${workspaceId} by=${actorUserId.slice(0, 8)}`
      );
      return role;
    }
    this.logger.warn(
      `[INVITE] refused - role=${role.name} not grantable by actor workspace=${workspaceId} by=${actorUserId.slice(0, 8)}`
    );
    throw new ForbiddenException({
      code: INVITE_ROLE_NOT_GRANTABLE,
      message: 'This invitation cannot grant that role.',
    });
  }

  /**
   * Invites a user to a channel: makes them a member of the community if they are not one yet, and
   * for a private channel adds them to `allowedUsers`.
   *
   * It hands back NO key material, and cannot: a channel message is sealed under a Graine session
   * whose seed only its sender's devices hold. What the invitee reads of the past is decided by
   * `historyVisibility` and answered by another member over the distribution group, never here.
   */
  async inviteToChannel(channelId: string, input: ChannelInviteDto) {
    const admissionVoucher = narrowAdmissionVoucher(input.admissionVoucher);
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const workspace = await this.workspaceRepo.findOne({ where: { id: channel.workspaceId } });

    // Check if actor has permission to invite
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    const actorRoles =
      actorMember.roleIds?.length > 0
        ? await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } })
        : [];
    const hasPerm = actorRoles.some(
      (r) =>
        r.permissions.includes(CHANNEL_PERMISSIONS.INVITE_MEMBERS) ||
        r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
        r.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL)
    );
    if (!hasPerm) throw new ForbiddenException('Missing INVITE_USERS permission');

    // Decided before anything is asked of another service: the role is in the request already.
    const grantedRole = await this.resolveInviteGrantedRole(
      channel.workspaceId,
      input.actorUserId,
      actorRoles,
      input.roleName
    );

    // A block closes this door too, and INSIDE A SHARED COMMUNITY as much as outside it. Almost
    // every salon invitation is issued from a community both people belong to, so exempting that
    // case would have left the block applying to nothing a salon could do.
    //
    // The refusal is neutral on purpose: it says the person cannot be invited, never who blocked
    // whom. It carries a `code` rather than a sentence, like the device refusal below - a client
    // that had to read the wording to tell these two apart would break the day it is reworded.
    if (await isBlockedBetween(this.channelRepo.manager, input.actorUserId, input.targetUserId)) {
      this.logger.log(
        `[INVITE] refused, block between actor=${sanitizeLog(input.actorUserId)} target=${sanitizeLog(input.targetUserId)}`
      );
      throw new ForbiddenException({
        code: 'USER_BLOCKED',
        message: 'This person cannot be added.',
      });
    }

    // Reject early if the invitee has no MLS device - the key DM could never be delivered.
    //
    // TWO OUTCOMES, TWO ANSWERS. This throws `ServiceUnavailableException` when it could not ask,
    // which is deliberately NOT this branch: "this person has not installed Canari" is advice about
    // them, and "the key service cannot be reached" is a retry about us. Rounding the second into
    // the first is what the old fail-open version did in reverse, and it told the inviter their
    // invitation had gone through.
    const hasDevices = await this.userHasMlsDevices(input.targetUserId);
    if (!hasDevices) {
      throw new BadRequestException({
        code: 'USER_HAS_NO_DEVICE',
        message: `User ${input.targetUserId} has not yet set up Canari on any device.`,
      });
    }

    // Add target user as member if not already
    let targetMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.targetUserId },
    });

    const isNewMember = !targetMember;

    if (!targetMember) {
      targetMember = this.memberRepo.create({
        workspaceId: channel.workspaceId,
        userId: input.targetUserId,
        roleIds: grantedRole ? [grantedRole.id] : [],
        // The inviting device's signed admission (channel-encryption section 25). Only on a row
        // this call creates: an existing member's proof is theirs, and a salon invitation of a
        // member already in is not an admission to the community.
        admissionVoucher,
      });
      await this.memberRepo.save(targetMember);
      this.logger.log(
        `[INVITE] member added workspace=${channel.workspaceId} user=${input.targetUserId.slice(0, 8)} voucher=${admissionVoucher ? 'yes' : 'no'}`
      );
    }

    if (isNewMember) {
      // ACCESS IS GRANTED BEFORE IT IS ANNOUNCED, and the order is the whole point: the audience of
      // the announcement is derived from `allowedUsers`, so granting afterwards would address the
      // invitation to everyone EXCEPT the person invited. For private channels with user-based
      // access this is the only row change left, so the save belongs to this branch alone.
      if (channel.isPrivate) {
        const granted = await this.grantPrivateChannelAccess(channelId, input.targetUserId);
        // GONE: no event at all - announcing it would hand the private salon's name to the whole
        // community as a public one. The membership this call created is taken back through the one
        // departure path (its admission voucher goes with the row), so nothing is left half-made.
        if (granted.outcome === 'gone') {
          await this.removeFromWorkspace(
            channel.workspaceId,
            input.targetUserId,
            'invite_withdrawn'
          );
          throw new NotFoundException('Channel not found');
        }
        // Removed since their row was written: nobody to announce to, and nothing granted.
        if (granted.outcome === 'not_member') {
          throw new ConflictException({
            code: CHANNEL_ACCESS_CHANGED,
            message: 'The salon access changed meanwhile, retry.',
          });
        }
        // Made public meanwhile: the community membership above is the whole grant.
        if (granted.outcome === 'public') channel.isPrivate = false;
        else if (granted.outcome === 'granted') channel.allowedUsers = granted.channel.allowedUsers;
      }

      // Publish event to notify the invited user and connected clients
      const audience = await this.channelAudience(channel);
      await this.redis.publishChannelEvent(
        'channel.member.joined',
        {
          channelId,
          channelName: channel.name,
          workspaceId: channel.workspaceId,
          workspaceSlug: workspace?.slug,
          workspaceName: workspace?.name,
          visibility: channel.isPrivate ? 'private' : 'public',
          roleName: grantedRole?.name ?? this.mapRoleInputToWorkspaceRoleName(input.roleName),
          joinedBy: input.targetUserId,
          invitedBy: input.actorUserId,
        },
        audience
      );
    }

    return {
      success: true,
      userId: input.targetUserId,
      alreadyMember: !isNewMember,
    };
  }

  /**
   * Removes the calling user from a PRIVATE channel.
   *
   * Only a private channel can be left, because only a private channel holds per-user access
   * (`allowedUsers`). A public one is readable by every member of the community and has no row
   * naming the leaver, so there is nothing here to remove and the honest answer is a refusal:
   * this used to delete their COMMUNITY membership instead, which put them outside a community
   * their client still displayed - and every workspace-scoped call, "leave the community"
   * included, then answered 404. Leaving a community is `leaveWorkspace`, and a channel-scoped
   * operation may not stand in for it. See `removeMemberFromChannel` for the same rule applied to
   * the admin-side removal.
   */
  async leaveChannel(channelId: string, input: ChannelLeaveDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.userId },
    });
    if (!member) throw new NotFoundException('Member not found');

    if (!channel.isPrivate) {
      this.logger.debug(
        `[CHANNEL] refused leave of public channel=${channelId} by=${input.userId.slice(0, 8)}`
      );
      throw new BadRequestException(
        'A public channel is readable by every member of the community and cannot be left on its own. Leave the community instead.'
      );
    }

    // One departure, the same as a community's: once `allowedUsers` no longer names them, nothing
    // left anywhere would ever go looking for their routing rows again.
    //
    // Access is the only thing this revokes. Nothing here rotates a key: a channel message is
    // sealed under a Graine session, and what shuts the leaver out is the senders minting a fresh
    // session on the next send - which they do because a departure is what rotates a Graine.
    await this.departDistributionGroups(
      this.channelCuts(channel, [input.userId]),
      'left_channel',
      channel.workspaceId,
      (m) => this.stripFromChannels(m, [channel], input.userId)
    );

    return { success: true };
  }

  /**
   * The actor's right to remove each of `targetUserIds` from this workspace or one of its salons -
   * refused here, never returned. THE ONE GATE of every removal: `kickFromWorkspace`,
   * `removeMemberFromChannel`, every member an access-list rewrite takes the salon from
   * (`updateChannelAccess`), and every member a private salon's creation leaves off
   * (`createChannel`) - so no path can disagree about who may remove whom.
   *
   * The actor holds `member.kick`, `channel.manage` or `workspace.manage`, and each target's roles
   * grant nothing the actor does not hold (`permissionsCover`, the bound every role change asks): an
   * actor may not take away more than they hold. A target who is not a member is refused as not
   * found when `absentTarget` is `'refuse'` (a removal NAMING someone), and has nothing to compare
   * when it is `'skip'` (an allowlist entry that outlived its membership).
   *
   * GIVEN `m`, the transaction of {@link withCommunityRemovalLock}, the actor's and every target's
   * membership and role rows are read with a SHARED ROW LOCK: a role change writing any of them waits
   * for the removal to commit, so what was compared is what holds when the removal is saved. Without
   * `m` it is the early answer a removal gives before it calls chat-delivery, asked again under the
   * lock.
   *
   * @throws ForbiddenException `REMOVAL_EXCEEDS_ACTOR` when a target holds more than the actor
   */
  private async assertActorMayRemoveMembers(
    workspaceId: string,
    actorUserId: string,
    targetUserIds: readonly string[],
    absentTarget: 'refuse' | 'skip',
    m?: EntityManager
  ): Promise<void> {
    const members = m ? m.getRepository(ChannelMember) : this.memberRepo;
    const lock = m ? { lock: { mode: 'pessimistic_read' as const } } : {};
    const actorMember = await members.findOne({
      where: { workspaceId, userId: actorUserId },
      ...lock,
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    const actorPermissions = await this.permissionsOfMember(actorMember, m);
    const hasPerm =
      actorPermissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE) ||
      actorPermissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL) ||
      actorPermissions.includes(CHANNEL_PERMISSIONS.KICK_MEMBERS);
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_CHANNEL or KICK_MEMBERS permission');

    if (targetUserIds.length === 0) return;
    // TWO QUERIES WHATEVER THE NUMBER OF TARGETS: the community's membership rows, then the roles
    // they name - a salon made private compares the whole community. Matched case-blind, because an
    // allowlist entry is lowercased and a membership row keeps its id as written.
    const rows = await members.find({ where: { workspaceId }, ...lock });
    const memberOf = new Map(rows.map((r) => [r.userId.trim().toLowerCase(), r]));
    const roleIds = [
      ...new Set(targetUserIds.flatMap((u) => memberOf.get(u.trim().toLowerCase())?.roleIds ?? [])),
    ];
    const roles = roleIds.length
      ? m
        ? await m.getRepository(ChannelRole).find({ where: { id: In(roleIds) }, ...lock })
        : await this.roleRepo.find({ where: { id: In(roleIds) } })
      : [];
    const grantsOf = new Map(roles.map((r) => [r.id, r.permissions]));

    for (const targetUserId of targetUserIds) {
      const targetMember = memberOf.get(targetUserId.trim().toLowerCase());
      if (!targetMember) {
        if (absentTarget === 'refuse') {
          throw new NotFoundException('Target member not found in workspace');
        }
        this.logger.debug(
          `[WORKSPACE] removal of a non-member, nothing to compare workspace=${workspaceId} target=${targetUserId.slice(0, 8)}`
        );
        continue;
      }
      const targetPermissions = [
        ...new Set((targetMember.roleIds ?? []).flatMap((id) => grantsOf.get(id) ?? [])),
      ];
      if (!permissionsCover(actorPermissions, targetPermissions)) {
        this.logger.warn(
          `[WORKSPACE] refused removal - target holds more than the actor workspace=${workspaceId} target=${targetUserId.slice(0, 8)} by=${actorUserId.slice(0, 8)} locked=${m !== undefined}`
        );
        throw new ForbiddenException({
          code: REMOVAL_EXCEEDS_ACTOR,
          message: 'This member holds permissions you do not have.',
        });
      }
    }
  }

  /**
   * What a member's roles grant, as one de-duplicated list (empty for a member with no role). Given
   * a transaction, the role rows are read with a shared row lock, held until it ends.
   */
  private async permissionsOfMember(member: ChannelMember, m?: EntityManager): Promise<string[]> {
    if (!member.roleIds?.length) return [];
    const roles = m
      ? await m.getRepository(ChannelRole).find({
          where: { id: In(member.roleIds) },
          lock: { mode: 'pessimistic_read' },
        })
      : await this.roleRepo.find({ where: { id: In(member.roleIds) } });
    return [...new Set(roles.flatMap((r) => r.permissions))];
  }

  /**
   * Kicks a member from the workspace entirely (removes from all channels). Requires
   * MANAGE_WORKSPACE, MANAGE_CHANNEL or KICK_MEMBERS, bounded by `assertActorMayRemoveMembers`.
   */
  async kickFromWorkspace(workspaceId: string, targetUserId: string, actorUserId: string) {
    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException('Workspace not found');

    // Answered BEFORE the departure calls chat-delivery, so a refused kick cuts nobody off; the
    // bound is asked again under the removal lock, against row-locked roles, before the save.
    await this.assertActorMayRemoveMembers(workspaceId, actorUserId, [targetUserId], 'refuse');

    // The actor's permission was checked; the TARGET's roles never were, so KICK_MEMBERS alone
    // used to remove the sole Administrateur.
    await this.assertRemovalKeepsAnAdmin(workspaceId, targetUserId);

    await this.removeFromWorkspace(workspaceId, targetUserId, 'kicked', (m) =>
      this.assertActorMayRemoveMembers(workspaceId, actorUserId, [targetUserId], 'refuse', m)
    );

    // Notify the kicked user and remaining workspace members
    const remainingMemberIds = await this.getWorkspaceMemberIds(workspaceId);
    const notifyIds = [...new Set([...remainingMemberIds, targetUserId])];
    await this.redis.publishChannelEvent(
      'channel.member.kicked',
      {
        workspaceId,
        kickedUserId: targetUserId,
        kickedBy: actorUserId,
      },
      notifyIds
    );

    this.logger.log(
      `[WORKSPACE] kick workspace=${workspaceId} target=${targetUserId.slice(0, 8)} by=${actorUserId.slice(0, 8)}`
    );

    // An admin removing themselves as the last member is the same disappearance as leaving, and
    // gets the same answer rather than a community nobody belongs to.
    if (remainingMemberIds.length === 0) {
      await this.hardDeleteWorkspace(workspaceId, 'last_member_kicked');
    }

    return { success: true };
  }

  /**
   * Replaces a workspace member's roleIds with the single specified role (removes all existing
   * roles). Roles are a workspace-level concept, so this is keyed by workspaceId directly.
   * Requires the actor to manage roles, and bounds them by what they hold (`actorMayGrantRole`):
   * the new role grants nothing they lack, and the target's CURRENT roles do not either - changing
   * a member who holds more than the actor would be taking away what the actor could never give.
   * The actor themselves is a target like any other, so nobody can promote themselves past it.
   */
  async updateWorkspaceMemberRole(
    workspaceId: string,
    targetUserId: string,
    roleName: string,
    actorUserId: string
  ) {
    const actorPermissions = await this.assertActorManagesRoles(workspaceId, actorUserId);

    const targetMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: targetUserId },
    });
    if (!targetMember) throw new NotFoundException('Target member not found');

    const role = await this.roleRepo.findOne({
      where: {
        workspaceId,
        name: this.mapRoleInputToWorkspaceRoleName(roleName),
      },
    });
    if (!role) throw new NotFoundException('Role not found');

    const targetPermissions = await this.permissionsOfMember(targetMember);
    if (
      !actorMayGrantRole(actorPermissions, role.permissions) ||
      !actorMayGrantRole(actorPermissions, targetPermissions)
    ) {
      this.refuseRoleChangeBeyondActor(`assign role=${role.name}`, workspaceId, actorUserId);
    }

    // A demotion is an exit from the admin set, so it faces the same postcondition as a departure.
    // MANAGE_ROLES alone used to be enough to strip the last Administrateur - including oneself -
    // after which nothing inside the community could grant the role back. There is always at least
    // one member here (the target), so the "no members" escape never applies.
    if (!role.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)) {
      const adminIds = await this.listWorkspaceAdminIds(workspaceId);
      if (adminIds.length === 1 && adminIds[0] === targetUserId) {
        this.logger.warn(
          `[WORKSPACE] refused demotion of the last admin workspace=${workspaceId} target=${targetUserId.slice(0, 8)} by=${actorUserId.slice(0, 8)}`
        );
        throw new BadRequestException({
          code: 'WORKSPACE_WOULD_HAVE_NO_ADMIN',
          message: 'The community would be left with no administrator.',
        });
      }
    }

    // Replace all existing roles with the single specified role.
    targetMember.roleIds = [role.id];
    await this.memberRepo.save(targetMember);

    this.logger.log(
      `[WORKSPACE] role set workspace=${workspaceId} target=${targetUserId.slice(0, 8)} role="${role.name}" by=${actorUserId.slice(0, 8)}`
    );

    // TOLD TO THE PERSON IT IS ABOUT, and only to them.
    //
    // Measured on production 2026-08-20 (COMM-5): a role change reached the other device NEVER -
    // the promoted member could not moderate, and, the direction that matters, a DEMOTED
    // administrator went on being offered every control they had just lost for as long as their tab
    // stayed open. Nothing was breakable, because the server re-checks each of those actions; what
    // the person got was a screen full of buttons that now fail with no explanation.
    //
    // THE PERMISSIONS TRAVEL WITH THE EVENT rather than being fetched back. The client caches three
    // permission-derived flags (`viewerCanManage`, `viewerCanManageChannels`, `viewerCanModerate` -
    // the third was missing until 2026-10-05, so a demoted moderator kept being offered pin and
    // delete on other members' messages), each DERIVED FROM THIS
    // ROLE, which is known here - so handing it over is the discriminator carried to where the
    // decision is made, instead of a round trip that can fail, race a load already in flight, or
    // arrive after the user has clicked. The whole permission list is sent, not just the one flag,
    // so the day the client caches a second one there is nothing to change on this side.
    //
    // Best-effort and logged: a member who misses this is exactly where they were before it
    // existed - correct on their next load - so a failed publish must not undo a role change that
    // has already been written.
    try {
      await this.redis.publishChannelEvent(
        'workspace.role.changed',
        {
          workspaceId,
          userId: targetUserId,
          roleName: role.name,
          permissions: role.permissions,
          canManage: role.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE),
          canManageChannels: roleGrantsChannelManagement(role.permissions),
          canModerate: roleGrantsModeration(role.permissions),
          changedBy: actorUserId,
        },
        [targetUserId]
      );
    } catch (e) {
      this.logger.warn(
        `[WORKSPACE] role set but not announced workspace=${workspaceId} target=${targetUserId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    return { success: true };
  }

  /** Channel-scoped shim for {@link updateWorkspaceMemberRole}, kept for the legacy channel-members route. */
  async updateMemberRole(channelId: string, input: ChannelUpdateRoleDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    return this.updateWorkspaceMemberRole(
      channel.workspaceId,
      input.targetUserId,
      input.roleName,
      input.actorUserId
    );
  }

  /** Removes a user from a specific channel without removing them from the workspace.
   *  For a private channel, removes them from allowedUsers and cuts them off from the channel's key
   *  distribution; a public channel has no per-user roster to edit (the user is still a workspace member and can re-join if invited again).
   *  Requires MANAGE_WORKSPACE, MANAGE_CHANNEL or KICK_MEMBERS, bounded by
   *  `assertActorMayRemoveMembers`. */
  async removeMemberFromChannel(channelId: string, targetUserId: string, actorUserId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    await this.assertActorMayRemoveMembers(
      channel.workspaceId,
      actorUserId,
      [targetUserId],
      'refuse'
    );

    // Remove from private channel's allowedUsers list
    if (channel.isPrivate) {
      // One departure: the cut goes first and may abort the removal, because after the save there
      // is no row left naming this person for the salon. The bound is asked again under the lock.
      await this.departDistributionGroups(
        this.channelCuts(channel, [targetUserId]),
        'removed_from_channel',
        channel.workspaceId,
        async (m) => {
          await this.assertActorMayRemoveMembers(
            channel.workspaceId,
            actorUserId,
            [targetUserId],
            'refuse',
            m
          );
          await this.stripFromChannels(m, [channel], targetUserId);
        }
      );
    }

    // Notify the removed user and everyone who can still see the salon. `allowedUsers` was
    // stripped just above, so the target is no longer in the audience and is added back by name -
    // losing access is the one event its subject must receive.
    const audience = await this.channelAudience(channel);
    const notifyIds = [...new Set([...audience, targetUserId])];
    await this.redis.publishChannelEvent(
      'channel.member.removed',
      {
        channelId,
        channelName: channel.name,
        workspaceId: channel.workspaceId,
        removedUserId: targetUserId,
        removedBy: actorUserId,
        // See kickMember: only a private channel is actually lost by the target.
        isPrivate: channel.isPrivate,
      },
      notifyIds
    );

    // No key is rotated here, and none can be: the seed that opens this channel's messages lives on
    // the sending devices. Removing someone from the community makes them ineligible for the
    // distribution group, and every sender mints a fresh session on the next send.
    //
    // THE ACCESS AS THE STRIP LEFT IT, revision included: the settings panel adopts it as its new
    // base only when it is the very next revision after its own (nobody else wrote in between), and
    // reads the access again otherwise.
    return { success: true, ...channelAccessState(channel) };
  }

  // ================= CHANNEL MEMBERS =================

  /**
   * Lists members with their highest-priority role normalized to admin/moderator/member.
   *
   * `scope: 'channel'` (default) answers "who is in THIS channel": for a private channel that is
   * its allowed users plus the workspace admins, not the whole community. `scope: 'workspace'` is
   * the community roster - what the settings panel needs, since the picker that grants access to a
   * private channel must be able to offer people who are not in it yet.
   */
  async listChannelMembers(
    channelId: string,
    actorUserId: string,
    scope: 'channel' | 'workspace' = 'channel',
    withPresence = false
  ) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');
    if (scope === 'channel' && !this.canAccessChannel(channel, actorMember, actorUserId)) {
      throw new ForbiddenException('Not allowed to read this channel');
    }

    const members = await this.memberRepo.find({ where: { workspaceId: channel.workspaceId } });
    const roles = await this.roleRepo.find({ where: { workspaceId: channel.workspaceId } });
    const roleMap = new Map(roles.map((r) => [r.id, r]));

    // A private channel has its own roster: returning the workspace's listed people who cannot
    // read the channel at all. Mirrors canAccessChannel (explicit allowedUsers, plus anyone
    // holding workspace.manage) but resolved from the roles already loaded above, so scoping the
    // list costs no extra query.
    const allowedUsers = new Set((channel.allowedUsers || []).map((u) => u.trim().toLowerCase()));
    const belongsToChannel = (member: ChannelMember): boolean => {
      if (scope === 'workspace' || !channel.isPrivate) return true;
      if (allowedUsers.has(member.userId.trim().toLowerCase())) return true;
      return (member.roleIds || []).some((roleId) =>
        roleMap.get(roleId)?.permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)
      );
    };

    const rows = members.filter(belongsToChannel).map((m) => {
      const memberRoles = (m.roleIds || []).map((rid) => roleMap.get(rid)).filter(Boolean);
      const highestRole = memberRoles.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
      return {
        id: m.id,
        userId: m.userId,
        role: this.normalizeRoleLabelToCanonical(highestRole?.name),
        joinedAt: m.createdAt,
      };
    });
    return withPresence ? this.withPresence(rows) : rows;
  }

  /**
   * Marks each roster row with whether that member has a device online RIGHT NOW.
   *
   * Asked for by the Graine repair election and nothing else, hence opt-in: a seed request is a
   * transport frame, dropped for a member with no device online, so electing an offline member is
   * a request nobody ever answers - on production 2026-09-24 every request of a returning member
   * went to one, and the salon stayed blank (`docs/wiki/protocols/channel-encryption.md`, WP-33).
   * The member lists the UI draws do not pay a keyspace scan for a fact they never show.
   */
  private async withPresence<T extends { userId: string }>(
    rows: T[]
  ): Promise<(T & { online: boolean; onlineDevices: string[] })[]> {
    const online = await this.redis.onlineDevicesByUser(rows.map((r) => r.userId));
    this.logger.debug(`[ROSTER] presence read: ${online.size}/${rows.length} member(s) online`);
    // `onlineDevices` since 1.2.5: the requester names ONE answering device of the member it elects
    // (channel-encryption section 23). A client predating it reads `online` only, which is unchanged.
    return rows.map((r) => {
      const devices = online.get(r.userId.trim().toLowerCase()) ?? [];
      return { ...r, online: devices.length > 0, onlineDevices: devices };
    });
  }

  /**
   * The community's roster, keyed by the COMMUNITY.
   *
   * `listChannelMembers(..., 'workspace')` answers the same question through a channel id, which
   * every caller that has one should keep using. This one exists for the caller that has none: a
   * device that has just joined a community's Graine distribution group and needs to name who to
   * ask for history, before any salon has been opened. Reaching for an arbitrary channel to get a
   * community's roster is the kind of indirection that breaks the first time the list is empty.
   */
  /**
   * The community's roster. Beside each member's role and arrival it carries the two facts a
   * member's device needs to decide whether that member's admission is proven (channel-encryption
   * section 25): the signed `admissionVoucher` stored with the membership, and whether they created
   * the community - the one member nobody else admitted.
   */
  async listWorkspaceMembers(workspaceId: string, actorUserId: string, withPresence = false) {
    const workspace = await this.assertWorkspaceMember(workspaceId, actorUserId);
    const creator = String(workspace.createdBy ?? '').toLowerCase();

    const members = await this.memberRepo.find({ where: { workspaceId } });
    const roles = await this.roleRepo.find({ where: { workspaceId } });
    const roleMap = new Map(roles.map((r) => [r.id, r]));

    const rows = members.map((m) => {
      const memberRoles = (m.roleIds || []).map((rid) => roleMap.get(rid)).filter(Boolean);
      const highestRole = memberRoles.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
      return {
        id: m.id,
        userId: m.userId,
        role: this.normalizeRoleLabelToCanonical(highestRole?.name),
        joinedAt: m.createdAt,
        isCreator: creator !== '' && m.userId.toLowerCase() === creator,
        admissionVoucher: m.admissionVoucher ?? null,
      };
    });
    return withPresence ? this.withPresence(rows) : rows;
  }

  // ================= MESSAGES =================

  /**
   * WHETHER A POLL IS OVER, decided with the clock that wrote the deadline.
   *
   * `endsAt` is an instant on THIS clock, so this is the only side entitled to compare it. Every
   * consumer asks here - the vote refusal, the close refusal, the opportunistic auto-unpin, and what
   * a client is served - so a poll cannot be closed for one of them and open for another.
   */
  private pollIsOver(meta: Pick<ChannelPollMeta, 'endsAt'>): boolean {
    return !!meta.endsAt && new Date(meta.endsAt).getTime() <= Date.now();
  }

  /**
   * A poll as a client is told it: {@link ServedChannelPollMeta}, stamped with {@link pollIsOver}.
   *
   * Every route that hands a poll out goes through here, because the alternative is a client
   * re-deriving closedness from `endsAt` against its own clock - which is the defect this stamp
   * exists to remove (see the DTO for what that cost).
   */
  private servedPoll(meta: ChannelPollMeta | null | undefined): ServedChannelPollMeta | null {
    if (!meta) return null;
    return { ...meta, closed: this.pollIsOver(meta) };
  }

  /**
   * Validates a poll descriptor and returns the initial server-side poll state.
   * Rejects fewer than 2 options, duplicate IDs, or a deadline already in the past.
   */
  private buildPollMeta(input: NonNullable<SendChannelMessageDto['poll']>): ChannelPollMeta {
    const optionIds = Array.isArray(input.optionIds) ? input.optionIds : [];
    if (optionIds.length < 2) {
      throw new BadRequestException('A poll needs at least 2 options');
    }
    if (new Set(optionIds).size !== optionIds.length) {
      throw new BadRequestException('Poll option IDs must be unique');
    }
    let endsAt: string | null = null;
    if (input.endsAt) {
      const ts = new Date(input.endsAt).getTime();
      if (Number.isNaN(ts)) throw new BadRequestException('Invalid poll endsAt');
      if (ts <= Date.now()) throw new BadRequestException('Poll deadline must be in the future');
      endsAt = new Date(ts).toISOString();
    }
    return {
      optionIds,
      multipleChoice: input.multipleChoice === true,
      endsAt,
      votesByUser: {},
    };
  }

  /**
   * Persists a client-encrypted message, then publishes the ciphertext to every workspace member
   * over Redis. The server validates that the row NAMES a Graine session and an index - never that
   * it can open it, which it cannot.
   */
  async sendMessage(channelId: string, input: SendChannelMessageDto) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId: input.senderId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');
    if (!this.canAccessChannel(channel, member, input.senderId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }
    // Read access is not enough: the channel's writePolicy may restrict posting
    // (e.g. an announcements channel where only admins/moderators can write).
    if (!(await this.canWriteToChannel(channel, input.senderId))) {
      throw new ForbiddenException('Not allowed to post in this channel');
    }
    // A message names the Graine session that opens it, and which key of that session. The server
    // holds no seed and can supply neither, so a message missing one is a message NOBODY can ever
    // read - it is refused here rather than stored as an unreadable row that looks like history.
    //
    // There is no "stale" refusal any more, and that is the point: `STALE_CHANNEL_KEY_VERSION`
    // existed because the server derived the key and knew which epoch was current. It knows
    // nothing about a Graine session but its name, so a sender can never be behind it.
    if (typeof input.senderSessionId !== 'string' || input.senderSessionId.length === 0) {
      throw new BadRequestException({
        code: 'CHANNEL_SESSION_REQUIRED',
        message: 'senderSessionId is required for channel messages',
      });
    }
    if (!Number.isInteger(input.messageIndex) || input.messageIndex < 0) {
      throw new BadRequestException({
        code: 'CHANNEL_MESSAGE_INDEX_REQUIRED',
        message: 'messageIndex must be a non-negative integer',
      });
    }

    await this.assertSeedFrame(channel, input);
    this.assertSigned(channel.id, input);

    // A SEND REPEATED AFTER A LOST ANSWER IS ANSWERED WITH THE ROW IT ALREADY MADE (WP-OFF-3). The
    // client's queue re-posts a message whose first POST got no answer, and only this side knows
    // whether that POST landed: the id its author minted (and sealed inside the ciphertext) names the
    // row, so the repeat writes nothing, publishes nothing and pushes nobody. A repeat of a DELETED
    // message is refused at the insert itself, under the client id's lock (`saveUnderUnusedKey`).
    const clientMessageId = this.readClientMessageId(channel.id, input);
    if (clientMessageId) {
      const stored = await this.findByClientMessageId(channelId, input.senderId, clientMessageId);
      if (stored) {
        // A repeat drains the row's own outbox entry at once: if the process that wrote it died
        // before handing its broadcast off, this is the first moment anyone can finish the job.
        this.drainFanoutInBackground(stored.id);
        return stored;
      }
    }

    // A poll is just an encrypted message carrying a label-free descriptor: we
    // store its option IDs/deadline server-side (for tallying + auto-pin) while
    // the question and labels stay in the ciphertext. Auto-pinned so it stays
    // reachable via the channel's pin list instead of drowning in the feed - but ONLY when the
    // author may pin: a pin shows on every member's screen, so it is moderation for every message
    // and a member's poll must not reach the pin list by a side door (user, 2026-10-05). The
    // client is never asked: the same grant `setMessagePinned` reads decides here.
    const pollMeta = input.poll ? this.buildPollMeta(input.poll) : null;
    const autoPin = pollMeta !== null && (await this.memberCanModerateMessages(member));
    if (pollMeta && !autoPin) {
      this.logger.log(
        `[POLL] not auto-pinned channel=${channelId} user=${input.senderId.slice(0, 8)}: no moderation grant`
      );
    }

    const msg = this.messageRepo.create({
      // Never use a client-supplied ID as the DB primary key - the server
      // always generates a fresh UUID to prevent IDOR / row-overwrite attacks.
      workspaceId: channel.workspaceId,
      channelId,
      authorId: input.senderId,
      content: input.ciphertext,
      nonce: input.nonce,
      senderSessionId: input.senderSessionId,
      messageIndex: input.messageIndex,
      signature: input.signature ?? null,
      clientMessageId,
      silent: input.silent === true,
      metadata: pollMeta ? { poll: pollMeta } : {},
      pinned: autoPin,
    });

    const saved = await this.saveUnderUnusedKey(msg, input, this.fanoutPayloadOf(input));
    // Two repeats racing: the other one wrote the row, this one is answered with it.
    if (saved.replayed) {
      this.drainFanoutInBackground(saved.row.id);
      return saved.row;
    }
    const savedMsg = saved.row;
    if (pollMeta) {
      this.logger.log(
        `[POLL] created channel=${channelId} message=${savedMsg.id} options=${pollMeta.optionIds.length} endsAt=${pollMeta.endsAt ?? 'none'}`
      );
    }

    // The broadcast and the push run after the answer is ready - never block the HTTP response on
    // them - and from the row's OUTBOX entry (migration 093), written in the send's transaction: a
    // process killed from here on leaves the entry behind, and the next boot (or a repeat of this
    // send) finishes the job.
    this.fanoutInBackground(channel, savedMsg, this.fanoutPayloadOf(input));

    return savedMsg;
  }

  /**
   * What a push needs that the stored row does not carry: the sender's cleartext mentions and the
   * seed frame (an MLS private message, opaque here) riding the push. Kept in the outbox entry so a
   * fan-out finished after a crash rings the same phones with the same payload.
   */
  private fanoutPayloadOf(input: SendChannelMessageDto): ChannelFanoutPayload {
    return {
      ...(input.mentionedUserIds?.length ? { mentionedUserIds: input.mentionedUserIds } : {}),
      ...(input.seedFrame && input.seedGroupId
        ? { seedFrame: input.seedFrame, seedGroupId: input.seedGroupId }
        : {}),
    };
  }

  /**
   * Every fan-out running in THIS process, by message id. It answers two questions by proof rather
   * than by a clock: `settleFanouts` (what must finish before a replaced replica exits - a normal
   * deploy is the commonest process death there is) and `drainFanout` (an entry whose fan-out is
   * running here is not drained a second time). It cannot see another replica's fan-outs: a claim
   * across replicas is out of scope, and a duplicate there is settled downstream (see
   * {@link runFanout}).
   */
  private readonly fanoutsInFlight = new Map<string, Promise<void>>();

  /** Starts `work` as THE fan-out of `messageId`, visible to {@link settleFanouts} until it ends. */
  private trackFanout(messageId: string, work: () => Promise<void>): Promise<void> {
    const running = work().finally(() => this.fanoutsInFlight.delete(messageId));
    this.fanoutsInFlight.set(messageId, running);
    return running;
  }

  /**
   * Resolves once every fan-out running in this process has ended, successfully or not. The SIGTERM
   * path awaits it before the process exits (`drainOnSigterm`): a replaced replica's last requests
   * were answered BEFORE their broadcast and push ran, and exiting first would leave their entries
   * for a boot that may be days away. Bounded by nothing of its own: the shutdown mechanism's
   * existing stop timeout is the bound.
   */
  async settleFanouts(): Promise<void> {
    while (this.fanoutsInFlight.size > 0) {
      this.logger.log(
        `[CHANNEL_FANOUT] waiting for ${this.fanoutsInFlight.size} fan-out(s) before exit`
      );
      await Promise.allSettled(this.fanoutsInFlight.values());
    }
  }

  /** Runs {@link runFanout} off the request path; a failure is logged and leaves the entry for the drain. */
  private fanoutInBackground(
    channel: Channel,
    row: ChannelMessage,
    payload: ChannelFanoutPayload
  ): void {
    this.trackFanout(row.id, () => this.runFanout(channel, row, payload)).catch((err) =>
      this.logger.error(
        `[CHANNEL_FANOUT] channel=${channel.id} message=${row.id} failed, the entry stays for the next drain: ${String(err)}`
      )
    );
  }

  /**
   * The two things a stored salon row owes the world - the live `channel.message.created` frame to
   * the people who may READ the salon, and the push to the members who should be rung - then the
   * deletion of its outbox entry, but ONLY when both were handed off. The frame carries the
   * ciphertext inline, so a private channel's audience is not its community's.
   *
   * A SILENT row rings nobody: a reaction that pushed would make every heart a notification, and a
   * community where that happens is a community people mute. The author is still told, by the
   * client, through the same targeted push a DM reaction uses.
   *
   * The two run independently (a refused push never stops the frame) and each failure is logged by
   * branch. A kept entry is drained at the next boot, which can repeat a half that DID succeed:
   * clients settle a duplicate frame by message id and Android settles a duplicate push by its
   * `createdAt`.
   */
  private async runFanout(
    channel: Channel,
    row: ChannelMessage,
    payload: ChannelFanoutPayload
  ): Promise<void> {
    const pollMeta = (row.metadata as { poll?: ChannelPollMeta } | null)?.poll ?? null;
    const published = this.channelAudience(channel).then((audience) =>
      this.redis.publishChannelEvent(
        'channel.message.created',
        {
          channelId: channel.id,
          messageId: row.id,
          senderId: row.authorId,
          ciphertext: row.content,
          nonce: row.nonce,
          senderSessionId: row.senderSessionId,
          messageIndex: row.messageIndex,
          signature: row.signature,
          createdAt: row.createdAt,
          silent: row.silent,
          // Poll descriptor (no labels) so peers render the card live without refetch.
          poll: this.servedPoll(pollMeta),
          pinned: row.pinned,
        },
        audience
      )
    );
    const pushed = row.silent
      ? Promise.resolve()
      : this.notifyChannelRecipients(channel, row, {
          senderId: row.authorId,
          ciphertext: row.content,
          nonce: row.nonce,
          senderSessionId: row.senderSessionId ?? '',
          messageIndex: row.messageIndex ?? 0,
          ...(row.signature ? { signature: row.signature } : {}),
          ...payload,
        } as SendChannelMessageDto);
    const [frame, push] = await Promise.allSettled([published, pushed]);
    if (frame.status === 'rejected') {
      this.logger.error(
        `Failed to publish channel message event: channel=${channel.id} message=${row.id}: ${frame.reason}`
      );
    }
    if (push.status === 'rejected') {
      this.logger.error(
        `[CHANNEL_PUSH] fan-out failed channel=${channel.id} message=${row.id}: ${push.reason}`
      );
    }
    if (frame.status === 'rejected' || push.status === 'rejected') return;
    try {
      await this.messageRepo.query(`DELETE FROM channel_message_fanout WHERE "messageId" = $1`, [
        row.id,
      ]);
    } catch (err) {
      this.logger.error(
        `[CHANNEL_FANOUT] channel=${channel.id} message=${row.id} handed off but its entry could not be deleted - the next drain repeats it: ${String(err)}`
      );
    }
  }

  /**
   * Finishes the fan-out of ONE stored row whose outbox entry is still there; false when there is
   * none (the ordinary answer to a repeat of a send that completed).
   */
  private async drainFanout(messageId: string): Promise<boolean> {
    if (this.fanoutsInFlight.has(messageId)) {
      this.logger.log(
        `[CHANNEL_FANOUT] message=${messageId.slice(0, 8)} is being fanned out here - not drained`
      );
      return false;
    }
    const entries: { payload: ChannelFanoutPayload }[] = await this.messageRepo.query(
      `SELECT payload FROM channel_message_fanout WHERE "messageId" = $1`,
      [messageId]
    );
    if (entries.length === 0) return false;
    const row = await this.messageRepo.findOne({ where: { id: messageId } });
    const channel = row ? await this.channelRepo.findOne({ where: { id: row.channelId } }) : null;
    if (!row || !channel) {
      // The entry cascades with its message, so this is a race with a delete: nothing to announce.
      this.logger.warn(
        `[CHANNEL_FANOUT] message=${messageId} has an entry but no row or channel - dropped`
      );
      await this.messageRepo.query(`DELETE FROM channel_message_fanout WHERE "messageId" = $1`, [
        messageId,
      ]);
      return false;
    }
    // Checked again here: the awaits above are where a send's own fan-out can have started.
    if (this.fanoutsInFlight.has(messageId)) return false;
    this.logger.log(
      `[CHANNEL_FANOUT] finishing the fan-out of message=${messageId.slice(0, 8)} channel=${channel.id} - its writer never handed it off`
    );
    await this.trackFanout(messageId, () => this.runFanout(channel, row, entries[0].payload ?? {}));
    return true;
  }

  /** A repeat's drain: never blocks the answer, logs what it cannot do. */
  private drainFanoutInBackground(messageId: string): void {
    this.drainFanout(messageId).catch((err) =>
      this.logger.error(`[CHANNEL_FANOUT] drain of message=${messageId} failed: ${String(err)}`)
    );
  }

  /**
   * Every entry still in the outbox, once each, in order. A crash is the only thing that leaves one
   * behind, so at boot the table is ordinarily empty; an entry whose fan-out fails again stays for
   * the next boot rather than being retried in a loop. A rolling deploy can drain an entry its old
   * replica is still handing off: the duplicate frame and push are settled downstream.
   */
  async drainPendingFanouts(): Promise<number> {
    const entries: { messageId: string }[] = await this.messageRepo.query(
      `SELECT "messageId" FROM channel_message_fanout ORDER BY "createdAt"`
    );
    if (entries.length > 0) {
      this.logger.warn(`[CHANNEL_FANOUT] ${entries.length} entries left by a process that died`);
    }
    let finished = 0;
    for (const { messageId } of entries) {
      try {
        if (await this.drainFanout(messageId)) finished += 1;
      } catch (err) {
        this.logger.error(`[CHANNEL_FANOUT] drain of message=${messageId} failed: ${String(err)}`);
      }
    }
    return finished;
  }

  /** Boot: finish the fan-outs a dead process left, without holding the boot. */
  onApplicationBootstrap(): void {
    // Not a precondition of serving, so a failure is said once at ERROR and the next boot repeats it.
    // The table comes from migration 093, applied before any service starts; CI's boot job and local
    // stacks build it from the entity.
    this.drainPendingFanouts().catch((err) =>
      this.logger.error(
        `[CHANNEL_FANOUT] boot drain failed, retried at the next boot: ${String(err)}`
      )
    );
  }

  /**
   * Accepts a salon row ONLY when it carries a well-formed Graine v2 signature (channel-encryption
   * section 21.8). An ALLOWLIST of one shape: a signature of 88 base64 characters. Everything else -
   * absent, null, the wrong length, not base64, not a string - is refused before anything is stored.
   *
   * The server still cannot VERIFY it (it holds no key); that stays the reader's job. What changed
   * is that it may now REQUIRE it: since `minClientVersion` reached `1.0.3` (2026-10-11) every
   * admitted client signs every row it posts - text, poll, reaction, edit, system notice, all through
   * the one `sealChannelMessage`, which throws before the POST when it holds no signing secret. And
   * this route has no other caller: DMs, commits, Welcomes and seed frames are MLS on
   * chat-delivery, and no native path (notification reply, push handler) posts a salon row. So an
   * unsigned row here is never honest, and it is refused at ERROR, a line that accuses.
   *
   * It closes the forgery v1 left open on the write side: a modified client minting an unsigned
   * row under a v1 session another member still holds (21.7, "what it does NOT close").
   */
  private assertSigned(channelId: string, input: SendChannelMessageDto): void {
    const { signature } = input;
    if (signature === undefined || signature === null) {
      this.logger.error(
        `[CHANNEL_SIGNATURE] REFUSED unsigned row channel=${channelId} sender=${input.senderId.slice(0, 8)} ` +
          `session=${input.senderSessionId.slice(0, 8)} index=${input.messageIndex} silent=${input.silent === true} ` +
          `- every client admitted since minClientVersion 1.0.3 signs: a modified client, or a process unlocked before the floor rose`
      );
      throw new BadRequestException({
        code: CHANNEL_SIGNATURE_REQUIRED,
        message: 'signature is required: every salon row is a Graine v2 row',
      });
    }
    if (
      typeof signature !== 'string' ||
      signature.length !== SIGNATURE_BASE64_CHARS ||
      !BASE64.test(signature)
    ) {
      this.logger.warn(
        `[CHANNEL_SIGNATURE] refused channel=${channelId} sender=${input.senderId.slice(0, 8)} ` +
          `signature=${typeof signature === 'string' ? `${signature.length}ch` : typeof signature}`
      );
      throw new BadRequestException({
        code: 'CHANNEL_SIGNATURE_INVALID',
        message: `signature is a 64-byte Ed25519 signature, base64 in ${SIGNATURE_BASE64_CHARS} characters`,
      });
    }
  }

  /**
   * Saves a message, refusing a second row under a message key already used (migration 065).
   *
   * Every honest sender makes this impossible by construction - an index is reserved per
   * (channel, sender) under a lock, and a restored session always rotates - so a refusal here names
   * a replay of a stored ciphertext or a sender that sealed twice under one key. It is logged at
   * ERROR for that reason, and answered with a code rather than a 500 so the sender can say which.
   */
  private async saveUnderUnusedKey(
    msg: ChannelMessage,
    input: SendChannelMessageDto,
    fanout: ChannelFanoutPayload
  ): Promise<{ row: ChannelMessage; replayed: boolean }> {
    try {
      const row = await this.saveUnlessDeleted(msg, msg.clientMessageId, fanout);
      return { row, replayed: false };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // THE OTHER UNIQUE INDEX (migration 090): a repeat of this message landed between the lookup in
      // `sendMessage` and this insert. Read from the ROW, never from the constraint's name in the
      // driver's message: a row under this author's client id IS the answer.
      if (msg.clientMessageId) {
        const stored = await this.findByClientMessageId(
          msg.channelId,
          msg.authorId,
          msg.clientMessageId
        );
        if (stored) return { row: stored, replayed: true };
      }
      this.logger.error(
        `[CHANNEL_KEY_REUSED] refused channel=${msg.channelId} sender=${input.senderId.slice(0, 8)} ` +
          `session=${input.senderSessionId.slice(0, 8)} index=${input.messageIndex} - a replay or a key sealed twice`
      );
      throw new ConflictException({
        code: 'CHANNEL_MESSAGE_KEY_REUSED',
        message: 'a message under this session and index already exists',
      });
    }
  }

  /**
   * The client id a send carries (`messageId`, the UUID its author sealed inside the ciphertext), or
   * null when it carries none - a silent row, a system notice. Every shipped client mints it with
   * `crypto.randomUUID()`, so anything that is not a UUID is refused rather than stored: a value the
   * idempotence key cannot trust would make two different messages one.
   */
  private readClientMessageId(channelId: string, input: SendChannelMessageDto): string | null {
    const { messageId } = input;
    if (messageId === undefined || messageId === null) return null;
    if (typeof messageId !== 'string' || !CLIENT_MESSAGE_ID.test(messageId)) {
      this.logger.warn(
        `[CHANNEL_SEND] refused channel=${channelId} sender=${input.senderId.slice(0, 8)}: ` +
          `messageId is not a UUID (${typeof messageId === 'string' ? `${messageId.length}ch` : typeof messageId})`
      );
      throw new BadRequestException({
        code: 'CHANNEL_CLIENT_MESSAGE_ID_INVALID',
        message: 'messageId is the UUID the client minted for this message',
      });
    }
    return messageId.toLowerCase();
  }

  /**
   * The row this author already wrote in this salon under `clientMessageId`, or null. A hit is a
   * repeated send (its first answer was lost), logged because it is the only trace the repeat leaves.
   */
  private async findByClientMessageId(
    channelId: string,
    authorId: string,
    clientMessageId: string
  ): Promise<ChannelMessage | null> {
    const stored = await this.messageRepo.findOne({
      where: { channelId, authorId, clientMessageId },
    });
    if (stored) {
      this.logger.log(
        `[CHANNEL_SEND] repeat of client message ${clientMessageId.slice(0, 8)} channel=${channelId} ` +
          `sender=${authorId.slice(0, 8)} answered with its stored row ${stored.id.slice(0, 8)} - nothing written`
      );
      // The column is `select: false`, so the read did not bring it: the answer carries it anyway,
      // because the ECHO is how a client learns this server answers a repeat with its row.
      stored.clientMessageId = clientMessageId;
    }
    return stored ?? null;
  }

  /**
   * Inserts a message AND its fan-out outbox entry (migration 093) in one transaction. A message
   * that carries a client id is refused first, if that id names a message this author's salon
   * has DELETED (migration 090's tombstone). A delete drops the row, so the lookup in `sendMessage`
   * finds nothing for a repeat that arrives after it - a first POST whose answer was lost, its app
   * killed, the message removed by a moderator or by its author on another device - and without this
   * the repeat would post it again: a moderation removal undone with no one touching anything.
   *
   * The check and the insert run in ONE transaction under {@link clientIdLockSql}, which
   * `deleteChannelMessage` takes too: a check made before the lock could pass, a delete commit, and
   * the insert re-post the row it just removed.
   *
   * @throws GoneException `CHANNEL_MESSAGE_DELETED` (410): the client forgets the send.
   */
  private saveUnlessDeleted(
    msg: ChannelMessage,
    clientMessageId: string | null,
    fanout: ChannelFanoutPayload
  ): Promise<ChannelMessage> {
    return this.messageRepo.manager.transaction(async (tx) => {
      if (clientMessageId) {
        const params = [msg.authorId, msg.channelId, clientMessageId];
        await tx.query(`SELECT ${clientIdLockSql('$1', '$2', '$3')}`, params);
        // A new statement after the lock: READ COMMITTED reads what a delete holding it committed.
        const tombstones: unknown[] = await tx.query(
          `SELECT 1 FROM channel_message_client_tombstones
            WHERE "authorId" = $1 AND "channelId" = $2 AND "clientMessageId" = $3`,
          params
        );
        if (tombstones.length > 0)
          this.refuseDeletedRepeat(msg.channelId, msg.authorId, clientMessageId);
      }
      const saved = await tx.getRepository(ChannelMessage).save(msg);
      // THE OUTBOX ENTRY COMMITS WITH THE ROW (migration 093): a process that dies after this
      // transaction leaves both, and the fan-out it never made is found and finished at boot.
      await tx.query(
        `INSERT INTO channel_message_fanout ("messageId", payload) VALUES ($1, $2::jsonb)`,
        [saved.id, JSON.stringify(fanout)]
      );
      return saved;
    });
  }

  /** Logs and refuses a repeat whose client id met its tombstone (see `saveUnlessDeleted`). */
  private refuseDeletedRepeat(channelId: string, authorId: string, clientMessageId: string): never {
    this.logger.warn(
      `[CHANNEL_SEND] repeat of DELETED client message ${clientMessageId.slice(0, 8)} channel=${channelId} ` +
        `sender=${authorId.slice(0, 8)} refused - the message was removed after its first send landed`
    );
    throw new GoneException({
      code: CHANNEL_MESSAGE_DELETED,
      message: 'this message was deleted: a repeat of it is not posted again',
    });
  }

  /**
   * Checks the seed frame a message carries (channel-encryption section 19), which the server
   * passes to the recipients' pushes and NEVER stores.
   *
   * The frame is an MLS private message on a key group, opaque here; what the server CAN check is
   * the one claim it knows the answer to: that `seedGroupId` is this salon's key group - the
   * private salon's own, the community's otherwise, the same rule as the client's
   * `scopeForChannel`. A mismatch is a sender whose idea of the salon is stale (a salon made
   * private since), and its seed went to an audience that is no longer the salon's: refusing is
   * what makes that visible instead of forwarding it.
   *
   * Absent on a silent message and on a sender older than section 19; both halves or neither.
   */
  private async assertSeedFrame(channel: Channel, input: SendChannelMessageDto): Promise<void> {
    const { seedFrame, seedGroupId } = input;
    if (seedFrame === undefined && seedGroupId === undefined) return;
    if (
      typeof seedFrame !== 'string' ||
      typeof seedGroupId !== 'string' ||
      seedFrame.length === 0 ||
      seedFrame.length > MAX_SEED_FRAME_CHARS ||
      !BASE64.test(seedFrame)
    ) {
      this.logger.warn(
        `[CHANNEL_SEED] refused channel=${channel.id} sender=${input.senderId.slice(0, 8)} ` +
          `frame=${typeof seedFrame === 'string' ? `${seedFrame.length}ch` : typeof seedFrame} ` +
          `group=${typeof seedGroupId}`
      );
      throw new BadRequestException({
        code: 'CHANNEL_SEED_FRAME_INVALID',
        message: `seedFrame and seedGroupId travel together; seedFrame is base64 of at most ${MAX_SEED_FRAME_CHARS} characters`,
      });
    }
    const expected = channel.isPrivate
      ? channel.distributionGroupId
      : ((
          await this.workspaceRepo.findOne({
            where: { id: channel.workspaceId },
            select: { id: true, distributionGroupId: true },
          })
        )?.distributionGroupId ?? null);
    if (seedGroupId !== expected) {
      this.logger.warn(
        `[CHANNEL_SEED] refused channel=${channel.id} sender=${input.senderId.slice(0, 8)} ` +
          `group=${seedGroupId} expected=${expected ?? 'none'} private=${channel.isPrivate}`
      );
      throw new BadRequestException({
        code: 'CHANNEL_SEED_FRAME_GROUP_MISMATCH',
        message: 'seedGroupId is not the key group of this channel',
      });
    }
  }

  /**
   * Sends a push notification for a new channel message to every workspace member who should
   * receive one, according to their per-channel notification level:
   *  - `none`  -> never;
   *  - `mentions` -> only if the member is in `input.mentionedUserIds`;
   *  - `all` (default) -> always.
   * The sender is always skipped, as are members who cannot access the channel. The server holds
   * no channel key (migration 041 dropped the server-side derivation) and never decrypts here: the ciphertext travels inline so the device decrypts
   * it locally (Google/FCM never sees the plaintext), mirroring the MLS DM push path.
   *
   * `mentioned` is computed per recipient and is the ONE fact only this side knows: the MLS path
   * has to scan the decrypted text for `@[<uuid>]` because the server cannot read it, whereas a
   * channel message carries a cleartext `mentionedUserIds` from the sender. So the device is TOLD
   * rather than left to infer - which is also the only answer that survives a push whose ciphertext
   * was too large to inline, where there is no text to scan.
   */
  private async notifyChannelRecipients(
    channel: Channel,
    message: ChannelMessage,
    input: SendChannelMessageDto
  ): Promise<void> {
    if (!this.internalSecret) {
      this.logger.warn('[CHANNEL_PUSH] INTERNAL_SECRET not set - channel push disabled');
      return;
    }

    const members = await this.memberRepo.find({ where: { workspaceId: channel.workspaceId } });
    const mentioned = new Set((input.mentionedUserIds ?? []).map((id) => id.trim().toLowerCase()));

    // THE CIPHERTEXT AND ITS SEED FRAME RIDE TOGETHER OR NOT AT ALL, and chat-delivery decides
    // which, per device, on the payload it actually sends (`withInlineGroup`). This used to be a
    // fixed `ciphertext <= 3000` guessed about everything else in the payload. Not inlined, the
    // notification degrades to the generic body until the app fetches the channel.
    const inline: Record<string, string> = {
      ciphertext: input.ciphertext,
      // The v2 signature is part of what opens the row natively (channel-encryption 21.5), so it
      // travels with the ciphertext or not at all - a v2 row inlined without it is refused.
      ...(input.signature ? { signature: input.signature } : {}),
      ...(input.seedFrame && input.seedGroupId
        ? { seedFrame: input.seedFrame, seedGroupId: input.seedGroupId }
        : {}),
    };

    // Same audience as the live event, from the same function - a push that reached somebody the
    // WebSocket frame did not would be the leak this scoping exists to close, arriving by another
    // door. It also replaces one permission query PER MEMBER with the two `channelAudience` does.
    const audience = new Set(await this.channelAudience(channel));

    // WHY EACH MEMBER WAS DROPPED, counted as it happens. The four reasons mean four different
    // things and the totals are the only way to tell them apart from outside - see the log below.
    const dropped = { sender: 0, outsideAudience: 0, levelNone: 0, notMentioned: 0 };
    const recipients: ChannelMember[] = [];
    for (const member of members) {
      if (member.userId === input.senderId) {
        dropped.sender += 1;
        continue;
      }
      if (!audience.has(member.userId)) {
        dropped.outsideAudience += 1;
        continue;
      }
      const level: ChannelNotificationLevel = member.notifLevels?.[channel.id] ?? 'all';
      if (level === 'none') {
        dropped.levelNone += 1;
        continue;
      }
      if (level === 'mentions' && !mentioned.has(member.userId.trim().toLowerCase())) {
        dropped.notMentioned += 1;
        continue;
      }
      recipients.push(member);
    }

    if (recipients.length === 0) {
      // A FAN-OUT THAT CHOSE NOBODY LOOKED EXACTLY LIKE A FAN-OUT THAT NEVER RAN, and from outside
      // this process those are the two halves of every "I was not notified" report. The only line
      // this path could emit was `recipients=N`, printed after this early return, so silence meant
      // both. It cost a campaign row a wrong verdict on 2026-09-05: a mention that named the SENDER
      // was skipped here - correctly - and read as the `mentions` level being broken.
      //
      // The counts are the evidence, because zero recipients is ORDINARY in three of four shapes: a
      // message in a channel one member reads, everyone at `none`, or a mention naming nobody who
      // subscribes that way. `outsideAudience` is the one that is not - a member of the workspace
      // the channel's own audience refuses is a permission or a scoping fault - so it is what a
      // reader looks for first, and it is only visible because it is counted separately.
      this.logger.log(
        `[CHANNEL_PUSH] channel=${channel.id} message=${message.id} recipients=0 of ` +
          `${members.length} member(s) - sender=${dropped.sender} ` +
          `outsideAudience=${dropped.outsideAudience} levelNone=${dropped.levelNone} ` +
          `notMentioned=${dropped.notMentioned} mentioned=${mentioned.size}`
      );
      return;
    }
    this.logger.log(
      `[CHANNEL_PUSH] channel=${channel.id} message=${message.id} recipients=${recipients.length} ` +
        `seedFrame=${input.seedFrame ? `${input.seedFrame.length}ch` : 'none'}`
    );

    // The community NAME, resolved here because nothing downstream can: `workspaceId` is a uuid and
    // no native surface holds a workspace mirror the way `channel_keys.json` mirrors the keys.
    const workspace = await this.workspaceRepo.findOne({ where: { id: channel.workspaceId } });
    if (!workspace) {
      // A channel whose workspace row is gone is a data-integrity fault, not a normal path. The
      // notification degrades to the salon alone rather than being dropped, and this line is the
      // only thing that says the community was lost rather than never asked for.
      this.logger.error(
        `[CHANNEL_PUSH] workspace=${channel.workspaceId} not found for channel=${channel.id} - title degrades to the salon alone`
      );
    }
    const workspaceName = workspace?.name ?? '';

    // EVERY FIELD HERE IS READ BY A CLIENT. Three others used to travel with it and were read by
    // none of the three (measured 2026-08-15), so they were dropped rather than left to look like a
    // contract:
    //  - `workspaceId` was a uuid nobody could render; `workspaceName` replaces it because it is
    //    what the title actually needs.
    //  - `messageId` cannot repeat what the MLS path does with it. That path writes
    //    `fcm_message_cache.ndjson` so a background-decrypted message is already in the local store
    //    at open; a channel message is DELIBERATELY never persisted locally (`useMessaging` skips
    //    the DB save for a `channel_` conversation - channels are server-authoritative and refetched
    //    over HTTP), so the cache has nowhere to inject.
    // Fewer bytes on the wire also buys headroom under the same 4 KB cap the ciphertext competes for.
    //
    // `createdAt` CAME BACK ON 2026-09-22, FOR A READER THAT DID NOT EXIST WHEN IT WAS DROPPED. It
    // was removed with `messageId` above as something no client could use. Since 2026-09-18 Android
    // has ONE notification builder with TWO triggers - this push and the socket frame - and it
    // recognises one message by its instant, so a payload without one made a salon message that
    // arrived BOTH ways show its line twice. The socket half reads
    // `channel.message.created`'s own `createdAt` (`channelEventHandler`), so this is not a second
    // clock: both triggers carry THE SAME STORED COLUMN, to the millisecond, which is why the
    // comparison is exact and needs no tolerance.
    const data: Record<string, string> = {
      type: 'channel',
      channelId: channel.id,
      channelName: channel.name,
      workspaceName,
      createdAt: String(message.createdAt.getTime()),
      // The session and the index, because they are what derives the key now. `keyVersion` used to
      // sit here and named an epoch the server derived; nothing on any device can do anything with
      // it any more, so it is gone rather than left looking like a contract.
      senderSessionId: input.senderSessionId,
      messageIndex: String(input.messageIndex),
      nonce: input.nonce,
      senderId: input.senderId,
    };

    const title = this.buildChannelPushTitle(workspaceName, channel.name);
    await Promise.all(
      recipients.map((member) =>
        this.sendInternalPush(
          member.userId,
          title,
          {
            ...data,
            mentioned: mentioned.has(member.userId.trim().toLowerCase()) ? 'true' : 'false',
          },
          inline
        )
      )
    );
  }

  /**
   * Signals - and stores nothing - that `userId` has read `channelId`, as a silent `channel_read` push to that
   * user's own devices so any device still showing the channel's notification clears it (cross-device
   * read-state sync). The reading device ignores it (foreground guard); sibling devices in the
   * background cancel the notification. Access-controlled: the caller must be able to see the channel.
   */
  async markChannelRead(channelId: string, userId: string): Promise<void> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }
    if (!this.internalSecret) return;
    await this.sendInternalPush(userId, channel.name, {
      type: 'channel_read',
      channelId: channel.id,
      workspaceId: channel.workspaceId,
      senderId: userId,
    });
  }

  /**
   * Raises how far `userId` has read `channelId` to `at`, and tells the salon's readers when it moved.
   *
   * THE SALON'S READ RECEIPT, which it never had: a DM's travels over MLS as a watermark, and a salon
   * has no MLS group, so a sender was shown "Envoyé" for ever. Same shape as the DM one - one instant
   * per reader, merged as max - so the client renders both through the same code.
   *
   * `at` is a message's server `createdAt` (a salon message's timestamp on every client IS that), and
   * it is BOUNDED BY THE SALON'S NEWEST MESSAGE rather than trusted: a merge that only rises cannot
   * take back a value in the future, which would show every later message read by this member.
   *
   * ONE STATEMENT, and its `WHERE` carries the comparison: two devices of one member advancing at
   * once cannot lower the mark, and the row count says whether it moved - which decides whether
   * anybody is told. Distinct from {@link markChannelRead}, which dismisses this account's own
   * notifications and answers a different question at a different moment.
   *
   * @returns the stored instant, or `null` when nothing moved.
   */
  async advanceChannelReadMark(
    channelId: string,
    userId: string,
    at: number,
    serverAt?: number
  ): Promise<{ at: number } | null> {
    if (!Number.isSafeInteger(at) || at <= 0) {
      throw new BadRequestException('at must be a positive integer (epoch ms)');
    }
    // THE READER'S INSTANT AND THE SERVER'S CAN BE TWO CLOCKS. A client before 2026-10-12 sent as
    // `at` the AUTHOR's `sentAt` of the newest message read, earlier than the row's `createdAt` when
    // the author's clock lags and LATER when it leads (the bound below then fires); a current client
    // dates every salon row by its `createdAt`, so `at` is on this clock. A mark below the newest
    // `createdAt` leaves that message "newer than the mark" for the server for good, which
    // `listUnreadCounts` would count as unread right after the reader had read it. The client therefore adds the row's own `createdAt`
    // when it knows it, and the mark takes the later of the two. It can only RAISE the mark, and the
    // bound below still caps it at the salon's newest message.
    const wanted =
      Number.isSafeInteger(serverAt) && (serverAt as number) > 0
        ? Math.max(at, serverAt as number)
        : at;
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const newest = await this.messageRepo.findOne({
      where: { channelId },
      order: { createdAt: 'DESC' },
    });
    if (!newest) {
      this.logger.debug(`[CHANNEL_READ] nothing to read channel=${channelId}`);
      return null;
    }
    const bounded = Math.min(wanted, newest.createdAt.getTime());
    if (bounded < wanted) {
      this.logger.warn(
        `[CHANNEL_READ] mark past the newest message bounded channel=${channelId} user=${userId.slice(0, 8)} asked=${wanted} kept=${bounded}`
      );
    }

    const result = await this.memberRepo
      .createQueryBuilder()
      .update(ChannelMember)
      .set({
        readMarks: () =>
          `jsonb_set("readMarks", ARRAY[CAST(:channelId AS text)], to_jsonb(CAST(:at AS bigint)), true)`,
      })
      .where('id = :memberId', { memberId: member.id })
      .andWhere(
        `COALESCE(("readMarks" ->> CAST(:channelId AS text))::bigint, 0) < CAST(:at AS bigint)`
      )
      .setParameters({ channelId, at: bounded })
      .execute();
    if (!result.affected) return null;

    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.read',
      { channelId, workspaceId: channel.workspaceId, userId, at: bounded },
      audience
    );
    this.logger.debug(
      `[CHANNEL_READ] advanced channel=${channelId} user=${userId.slice(0, 8)} at=${bounded} audience=${audience.length}`
    );
    return { at: bounded };
  }

  /**
   * Every reader's mark on `channelId`, for the client to hydrate on each history load - the live
   * `channel.read` events only carry what moved while it was connected.
   *
   * Restricted to members who can read the salon NOW: a mark left by someone taken off a private
   * salon's allowlist says nothing about this salon any more, and it is that person's business.
   */
  async listChannelReadMarks(channelId: string, userId: string): Promise<Record<string, number>> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    const members = await this.memberRepo.find({ where: { workspaceId: channel.workspaceId } });
    const viewer = members.find((m) => m.userId === userId);
    if (!viewer || !this.canAccessChannel(channel, viewer, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }
    const marks: Record<string, number> = {};
    for (const m of members) {
      const at = Number(m.readMarks?.[channelId]);
      if (!Number.isFinite(at) || at <= 0) continue;
      if (!this.canAccessChannel(channel, m, m.userId)) continue;
      marks[m.userId.toLowerCase()] = at;
    }
    return marks;
  }

  /**
   * How many messages each of the caller's salons holds that the caller has not read - the durable
   * answer the client's live counter cannot give.
   *
   * THE CLIENT'S COUNT IS A TALLY OF WHAT ARRIVED WHILE IT WAS LISTENING. A salon's messages are
   * never stored on the device and the count is never persisted, so a reload, a cold start, a phone
   * that was asleep or a socket that was down all left every badge at zero while the server's read
   * mark said otherwise - measured 2026-10-08 with ten communities (docs/wiki/frontend/modules/chat.md,
   * "Unread counts of salons"). The server holds both halves of the question: the reader's mark per
   * salon (`readMarks`) and the rows.
   *
   * A message counts when it is not silent (reactions, edits and control frames are silent), was not
   * written by the caller, and is newer than the caller's mark - or, with no mark, newer than the
   * caller's membership of the community, so a newcomer is not handed the history as unread. Only
   * salons the caller may read are counted: the same `canAccessChannel` every other read goes through.
   *
   * NOTHING BEFORE {@link UNREAD_TRACKED_SINCE_MS} IS COUNTED. A mark exists only for a salon the
   * member opened since 2026-09-29, so without a floor the first answer would call a salon's whole
   * history unread for every member and every salon read before marks existed. Seeding marks to fix
   * that was refused: a mark is also the "Lu par" receipt other people see, and a baseline would
   * claim the member had read what they had not.
   *
   * A MUTED SALON COUNTS NOTHING (2026-10-18). `notifLevels[channel] = 'none'` is the member's own
   * "do not bother me with this salon", and a badge on it contradicted that. `mentions` still counts:
   * the row is encrypted, so the server cannot tell which rows mention the caller. The muted ids are
   * returned beside the counts so a client's LIVE tally can stay silent for them too - the server's
   * zero alone would be re-raised by the next message that arrives while the app is open.
   *
   * A MEMBERSHIP NOTICE COUNTS NOTHING because the client now sends it `silent` (the row is opaque
   * here, so the sender must say so). Notices written before that stay counted until the salon is
   * opened, which the read mark now reaches.
   *
   * @returns `asOf`, the server clock the counts were taken at, `counts` keyed by channel id,
   *          absent when the count is zero, and `muted`, the readable salons at level `none`.
   */
  async listUnreadCounts(
    userId: string
  ): Promise<{ asOf: number; counts: Record<string, number>; muted: string[] }> {
    const members = await this.memberRepo.find({ where: { userId } });
    if (members.length === 0) return { asOf: Date.now(), counts: {}, muted: [] };
    const memberOf = new Map(members.map((m) => [m.workspaceId, m]));
    const channels = await this.channelRepo.find({
      where: { workspaceId: In([...memberOf.keys()]) },
    });
    const readable = channels.filter((c) => {
      const member = memberOf.get(c.workspaceId);
      return !!member && this.canAccessChannel(c, member, userId);
    });
    if (readable.length === 0) return { asOf: Date.now(), counts: {}, muted: [] };
    const muted: string[] = [];
    const countable: string[] = [];
    for (const c of readable) {
      if (memberOf.get(c.workspaceId)?.notifLevels?.[c.id] === 'none') muted.push(c.id);
      else countable.push(c.id);
    }
    if (countable.length === 0) return { asOf: Date.now(), counts: {}, muted };

    // asOf is taken HERE, right before the count, not at the top of the method: the client adds
    // every live message newer than it, so each millisecond between the two is a window in which a
    // message is counted by both sides.
    const asOf = Date.now();
    const rows: { channelId: string; n: string }[] = await this.messageRepo.query(
      `SELECT ch.id AS "channelId", u.n AS n
         FROM channel_members cm
         JOIN channels ch ON ch."workspaceId" = cm."workspaceId" AND ch.id = ANY($2::uuid[])
        -- The instant after which a message counts, per salon: the later of the member's mark, the
        -- member's private "cleared" mark (migration 082, "Marquer tout comme lu"), the member's
        -- arrival and the tracking floor.
        CROSS JOIN LATERAL (
          SELECT GREATEST(
                   COALESCE((cm."readMarks" ->> ch.id::text)::bigint, 0),
                   COALESCE((cm."clearedMarks" ->> ch.id::text)::bigint, 0),
                   floor(extract(epoch from cm."createdAt") * 1000)::bigint,
                   $3::bigint
                 ) AS since
        ) b
        CROSS JOIN LATERAL (
          SELECT COUNT(*) AS n
            FROM channel_messages m
           WHERE m."channelId" = ch.id
             AND m.silent = false
             AND m."authorId" <> $1
             -- Sargable pre-filter on migration 079's index: without it every row of the salon was
             -- read to be thrown away (300 ms on 1.5M rows, 6 ms with it). A superset of the exact
             -- test below, so it never contradicts it.
             AND m."createdAt" >= (to_timestamp(b.since / 1000.0) AT TIME ZONE 'UTC')
             -- Whole milliseconds on both sides: a mark is a JS instant (truncated), createdAt keeps
             -- microseconds, and comparing them raw counted the very message just read.
             AND floor(extract(epoch from m."createdAt") * 1000) > b.since
        ) u
        WHERE cm."userId" = $1 AND u.n > 0`,
      [userId, countable, UNREAD_TRACKED_SINCE_MS]
    );
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.channelId] = Number(r.n);
    this.logger.debug(
      `[UNREAD] user=${userId.slice(0, 8)} salons=${countable.length} unread=${Object.keys(counts).length} muted=${muted.length}`
    );
    return { asOf, counts, muted };
  }

  /**
   * "Marquer tout comme lu" on a community: empties the unread count of every salon of
   * `workspaceId` the caller may read, up to `upTo`, in ONE statement - and tells nobody but the
   * caller's own devices.
   *
   * NOT THE READ MARK. `readMarks` is also the "Lu par" receipt the salon's other members see, and a
   * member who clears a badge from a menu has not read anything; the same reasoning refused seeding
   * marks for {@link listUnreadCounts}. So this raises `clearedMarks` (migration 082), a private
   * floor `listUnreadCounts` adds to what it skips, and `channel.read` is never published.
   *
   * `upTo` is the newest instant the caller's screen had counted (the server clock: a row's
   * `createdAt`, or the `asOf` of the last count it was given). Each salon's mark is BOUNDED by the
   * salon's newest row, so a mark can never cover a message that did not exist yet, and by `upTo`, so
   * a message that landed after the badge the user cleared stays unread. Only ever raised: the merge
   * takes the greater of the stored value and the new one inside the `SET`, against the row as it is
   * when the update applies, so two devices clearing at once cannot lower it.
   *
   * @returns `at` per salon whose mark moved (absent when nothing moved), for the caller's log.
   */
  async clearWorkspaceUnread(
    workspaceId: string,
    userId: string,
    upTo: number
  ): Promise<{ cleared: Record<string, number> }> {
    if (!Number.isSafeInteger(upTo) || upTo <= 0) {
      throw new BadRequestException('upTo must be a positive integer (epoch ms)');
    }
    const member = await this.memberRepo.findOne({ where: { workspaceId, userId } });
    if (!member) throw new ForbiddenException('Not a member of this community');
    const channels = await this.channelRepo.find({ where: { workspaceId } });
    const readable = channels.filter((c) => this.canAccessChannel(c, member, userId));
    if (readable.length === 0) {
      this.logger.debug(
        `[CHANNEL_CLEAR] nothing to clear workspace=${workspaceId} user=${userId.slice(0, 8)} salons=0`
      );
      return { cleared: {} };
    }

    // `prev` is read in the same statement, before the update, for the answer only: which salons
    // moved decides who is told, never what is stored. The stored value is the GREATEST computed
    // against `cm` - the row being updated - so it cannot fall whatever ran concurrently.
    // TypeORM answers an UPDATE as `[rows, rowCount]`, not as the rows.
    const [rows]: [{ prev: Record<string, number> | null; next: Record<string, number> | null }[]] =
      await this.messageRepo.query(
        `WITH newest AS (
           SELECT c.id::text AS cid,
                  (SELECT floor(extract(epoch from max(m."createdAt")) * 1000)::bigint
                     FROM channel_messages m
                    WHERE m."channelId" = c.id) AS at
             FROM unnest($2::uuid[]) AS c(id)
         ), bound AS (
           -- LEAST ignores a NULL, so an EMPTY salon must be dropped here, not left to LEAST:
           -- otherwise its mark became upTo itself, the client's word, and an upTo in the future hid
           -- every message the salon would receive until then (measured on Postgres, 2026-10-13).
           SELECT cid, LEAST($3::bigint, at) AS at FROM newest WHERE at IS NOT NULL
         ), old AS (
           SELECT "clearedMarks" AS prev FROM channel_members WHERE id = $1
         )
         UPDATE channel_members cm
            SET "clearedMarks" = cm."clearedMarks" || COALESCE((
                  SELECT jsonb_object_agg(
                           b.cid,
                           GREATEST(b.at, COALESCE((cm."clearedMarks" ->> b.cid)::bigint, 0))
                         )
                    FROM bound b
                ), '{}'::jsonb)
           FROM old
          WHERE cm.id = $1
      RETURNING old.prev AS prev, cm."clearedMarks" AS next`,
        [member.id, readable.map((c) => c.id), upTo]
      );
    const prev = rows[0]?.prev ?? {};
    const next = rows[0]?.next ?? {};
    const cleared: Record<string, number> = {};
    for (const c of readable) {
      const at = Number(next[c.id]);
      if (Number.isFinite(at) && at > Number(prev[c.id] ?? 0)) cleared[c.id] = at;
    }
    const moved = Object.keys(cleared);
    this.logger.debug(
      `[CHANNEL_CLEAR] workspace=${workspaceId} user=${userId.slice(0, 8)} upTo=${upTo} salons=${readable.length} moved=${moved.length}`
    );
    if (moved.length === 0) return { cleared };

    // THE CALLER'S OWN DEVICES ONLY: the other members learn nothing, which is the point of the
    // separate mark. One event for the whole community; each device re-reads its counts.
    await this.redis.publishChannelEvent(
      'channel.unread.cleared',
      { workspaceId, userId, cleared },
      [userId]
    );
    // The banners those salons left on the caller's phones go with the badge, exactly as opening
    // the salon dismisses them (`markChannelRead`). One silent push per salon that moved, sent by
    // this service rather than asked for by the client salon by salon.
    // `sendInternalPush` never throws: a refusal or a transport failure is its own warning.
    if (this.internalSecret) {
      const byId = new Map(readable.map((c) => [c.id, c]));
      await Promise.all(
        moved.map((channelId) =>
          this.sendInternalPush(userId, byId.get(channelId)?.name ?? '', {
            type: 'channel_read',
            channelId,
            workspaceId,
            senderId: userId,
          })
        )
      );
    }
    return { cleared };
  }

  /**
   * The title of a salon notification: `<Communaute> - #<salon>`.
   *
   * FOUR SURFACES SPELL THIS FORMAT, one per process that can put the banner on a screen: this one
   * (the APNs alert title, which is what an iPhone shows when the Notification Service Extension
   * cannot run), the Kotlin FCM service, that extension, and the app-alive `canari_push.mm`. No
   * compiler spans them, so `channelPushFields.test.ts` asserts the separator on all four.
   *
   * The community DEGRADES away rather than erroring: an unnamed workspace still yields `#<salon>`,
   * which is exactly what the title was before this field existed.
   */
  private buildChannelPushTitle(workspaceName: string, channelName: string): string {
    return workspaceName ? `${workspaceName} - #${channelName}` : `#${channelName}`;
  }

  /**
   * Posts a single user's push to chat-delivery's internal endpoint (where Firebase Admin lives).
   * Best-effort: a failed push must never surface to the message sender.
   *
   * `inline` is a group chat-delivery inlines whole or not at all, per device.
   */
  private async sendInternalPush(
    userId: string,
    title: string,
    data: Record<string, string>,
    inline?: Record<string, string>
  ): Promise<void> {
    try {
      const res = await fetch(deliveryUrl('internal/push/notify'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.internalSecret,
        },
        // body left empty: the device composes the visible text after decrypting the ciphertext.
        body: JSON.stringify({ userId, title, body: '', data, ...(inline ? { inline } : {}) }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`[CHANNEL_PUSH] notify HTTP ${res.status} for user=${userId}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      this.logger.warn(`[CHANNEL_PUSH] notify failed for user=${userId}: ${msg}`);
    }
  }

  /**
   * Sets the calling member's notification level for one channel. Validates that the user is a
   * workspace member and can access the channel. Storing `all` keeps the map explicit (it is the
   * default when absent, but an explicit entry lets the client show the chosen value).
   */
  async setNotificationLevel(
    channelId: string,
    userId: string,
    level: ChannelNotificationLevel
  ): Promise<{ channelId: string; level: ChannelNotificationLevel }> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');
    if (!this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    // Use the DB-canonical `channel.id` (loaded above) rather than the raw request
    // param as the map key, so a remote-controlled value never becomes an object
    // property name (remote property injection, CWE-250/915).
    member.notifLevels = { ...member.notifLevels, [channel.id]: level };
    await this.memberRepo.save(member);
    this.logger.log(`[CHANNEL_PUSH] level set channel=${channelId} user=${userId} level=${level}`);
    return { channelId, level };
  }

  /** Returns the calling member's notification level for one channel (`all` when never set). */
  async getNotificationLevel(
    channelId: string,
    userId: string
  ): Promise<{ channelId: string; level: ChannelNotificationLevel }> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member) throw new ForbiddenException('Not a member of this workspace');

    const level: ChannelNotificationLevel = member.notifLevels?.[channel.id] ?? 'all';
    return { channelId, level };
  }

  /**
   * Broadcasts an ephemeral typing signal to the channel's workspace members.
   * Not persisted and best-effort: a failure to publish is non-critical.
   */
  async publishTyping(channelId: string, userId: string, isTyping: boolean): Promise<void> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    // THE SENDER IS NOT TOLD ABOUT THEIR OWN TYPING: the client dropped that frame on arrival (115
    // frames back for 112 POSTs in one web console, 2026-10-18), so it was transport and a console
    // line for nothing. The audience is a list of USER ids, so this also spares the sender's other
    // devices - which have no use for it either, a typing indicator names someone ELSE.
    const audience = (await this.channelAudience(channel)).filter((id) => id !== userId);
    await this.redis.publishChannelEvent(
      'channel.typing',
      { channelId, userId, state: isTyping ? 'start' : 'stop' },
      audience
    );
  }

  /** Pins/unpins a channel message and broadcasts a `channel.pin` event to workspace members. */
  async setMessagePinned(
    channelId: string,
    messageId: string,
    userId: string,
    pinned: boolean
  ): Promise<void> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const msg = await this.messageRepo.findOne({ where: { id: messageId, channelId } });
    if (!msg) throw new NotFoundException('Message not found');

    // A pin shows on every member's screen, so pinning is moderation for EVERY message, the
    // author's own included (user, 2026-10-05) - otherwise any member could fill the salon's pin
    // list. Unpinning is the same act and the same rule.
    if (!(await this.memberCanModerateMessages(member))) {
      this.logger.warn(
        `[PIN] refused channel=${channelId} message=${messageId} user=${userId.slice(0, 8)} pinned=${pinned} own=${msg.authorId === userId}: no moderation grant`
      );
      throw new ForbiddenException({
        code: PIN_REQUIRES_MODERATION,
        message: 'Missing channel.moderate permission to pin a message',
      });
    }
    this.logger.log(
      `[PIN] channel=${channelId} message=${messageId} user=${userId.slice(0, 8)} pinned=${pinned}`
    );

    if (msg.pinned !== pinned) {
      msg.pinned = pinned;
      await this.messageRepo.save(msg);
    }

    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent('channel.pin', { channelId, messageId, pinned }, audience);
  }

  /**
   * Records a vote on a channel poll. Clears the caller's previous selection then
   * stores the new one in `metadata.poll.votesByUser` (empty array = retract vote).
   * A pessimistic write lock serialises concurrent voters on the same row.
   * Rejects votes on a closed poll or on options outside the poll.
   */
  async votePoll(
    channelId: string,
    messageId: string,
    userId: string,
    optionIds: string[]
  ): Promise<ServedChannelPollMeta> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const selected = Array.isArray(optionIds) ? [...new Set(optionIds)] : [];

    let poll!: ChannelPollMeta;
    await this.messageRepo.manager.transaction(async (manager) => {
      const msg = await manager
        .createQueryBuilder(ChannelMessage, 'm')
        .where('m.id = :messageId AND m.channelId = :channelId', { messageId, channelId })
        .setLock('pessimistic_write')
        .getOne();
      if (!msg) throw new NotFoundException('Message not found');

      const meta = (msg.metadata as { poll?: ChannelPollMeta } | null)?.poll;
      if (!meta) throw new BadRequestException('This message is not a poll');

      if (this.pollIsOver(meta)) {
        throw new ForbiddenException('This poll is closed');
      }
      const unknown = selected.filter((id) => !meta.optionIds.includes(id));
      if (unknown.length > 0) {
        throw new BadRequestException('Vote references unknown option(s)');
      }
      if (!meta.multipleChoice && selected.length > 1) {
        throw new BadRequestException('This poll is single-choice');
      }

      // Null-prototype map prevents prototype pollution via a crafted userId key.
      if (!meta.votesByUser || Object.getPrototypeOf(meta.votesByUser) !== null) {
        meta.votesByUser = Object.assign(Object.create(null), meta.votesByUser);
      }
      // Security: mitigates CodeQL alerts #2477/#2476 - reject dangerous property keys
      if (isUnsafeObjectKey(userId)) {
        throw new BadRequestException('Invalid user identifier');
      }
      if (selected.length === 0) {
        delete meta.votesByUser[userId];
      } else {
        meta.votesByUser[userId] = selected;
      }

      msg.metadata = { ...msg.metadata, poll: meta };
      await manager.save(msg);
      poll = meta;
    });

    this.logger.log(
      `[POLL] vote channel=${channelId} message=${messageId} user=${userId.slice(0, 8)} options=${selected.length}`
    );

    // Broadcast the updated tally so every member's card refreshes live. The same value the caller
    // gets back, so no member can be told a different poll from the voter.
    const served = this.servedPoll(poll)!;
    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.poll.vote',
      { channelId, messageId, poll: served },
      audience
    );

    return served;
  }

  /**
   * Closes a poll immediately by forcing its deadline to now, then unpins it.
   * The poll author can always close their own poll; any other member needs a
   * moderation/management permission. Rejects a non-poll message or an already-closed poll.
   */
  async closePoll(
    channelId: string,
    messageId: string,
    userId: string
  ): Promise<ServedChannelPollMeta> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    let poll!: ChannelPollMeta;
    await this.messageRepo.manager.transaction(async (manager) => {
      const msg = await manager
        .createQueryBuilder(ChannelMessage, 'm')
        .where('m.id = :messageId AND m.channelId = :channelId', { messageId, channelId })
        .setLock('pessimistic_write')
        .getOne();
      if (!msg) throw new NotFoundException('Message not found');

      const meta = (msg.metadata as { poll?: ChannelPollMeta } | null)?.poll;
      if (!meta) throw new BadRequestException('This message is not a poll');

      // Non-authors must hold a moderation permission to close someone else's poll.
      if (msg.authorId !== userId && !(await this.memberCanModerateMessages(member))) {
        throw new ForbiddenException('Only the poll author or a moderator can close this poll');
      }

      if (this.pollIsOver(meta)) {
        throw new BadRequestException('This poll is already closed');
      }

      meta.endsAt = new Date().toISOString();
      msg.metadata = { ...msg.metadata, poll: meta };
      msg.pinned = false;
      await manager.save(msg);
      poll = meta;
    });

    this.logger.log(
      `[POLL] closed channel=${channelId} message=${messageId} by=${userId.slice(0, 8)}`
    );

    // Refresh every member's card (now shows as closed) and clear the pinned banner. `closed` is
    // what makes this frame READABLE as a closure: the deadline alone left the peer comparing a
    // server instant to its own clock, and losing.
    const served = this.servedPoll(poll)!;
    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.poll.vote',
      { channelId, messageId, poll: served },
      audience
    );
    await this.redis.publishChannelEvent(
      'channel.pin',
      { channelId, messageId, pinned: false },
      audience
    );

    return served;
  }

  /**
   * Deletes a message from a channel. The author may always delete their own; deleting someone
   * else's requires `channel.moderate` (or the permissions that subsume it) - this is the
   * "delete other members' messages" half of the moderation permission.
   *
   * The row is dropped outright rather than tombstoned: the content is a ciphertext the server
   * cannot read, so there is nothing to preserve for a "deleted message" placeholder, and DM
   * deletion behaves the same way.
   */
  async deleteChannelMessage(channelId: string, messageId: string, userId: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const msg = await this.messageRepo.findOne({ where: { id: messageId, channelId } });
    if (!msg) throw new NotFoundException('Message not found');

    if (msg.authorId !== userId && !(await this.memberCanModerateMessages(member))) {
      throw new ForbiddenException('Missing channel.moderate permission to delete this message');
    }

    // ITS CLIENT ID OUTLIVES IT (migration 090): the tombstone and the delete commit together, under
    // the client id's lock (`clientIdLockSql`) that a send takes around its tombstone check and its
    // insert - so no instant exists where a repeat of this message finds neither the row nor its
    // tombstone and posts it again. A row with no client id (older than 090, a system notice) has
    // nothing a repeat could name: it takes no lock and writes no tombstone.
    //
    // THE ROW IS LOCKED FIRST, and that is what keeps a tombstone from outliving an account erasure.
    // The erasure deletes the author's messages, then its tombstones, in one transaction that takes
    // no client-id lock. Without the row lock, a delete arriving while that transaction is open read
    // the still-committed row, wrote its tombstone (invisible to the erasure's statement), then
    // waited on the erasure's row lock and committed AFTER it - an erased account's id left behind.
    // `FOR UPDATE` waits for the erasure instead and then finds no row, so the INSERT ... SELECT
    // below writes nothing; and when the delete locks first, the erasure's DELETE waits for it and
    // its tombstone statement, a later snapshot, sees and removes the committed tombstone.
    // LOCK ORDER: the message row, then the client id's advisory lock. A send takes the advisory
    // lock alone and inserts a NEW row (a duplicate is refused at once, never waited on: the unique
    // check does not wait on a row lock), and the erasure takes row locks alone - no cycle.
    const removed = await this.messageRepo.manager.transaction(async (tx) => {
      const locked: unknown[] = await tx.query(
        `SELECT 1 FROM channel_messages WHERE id = $1 AND "channelId" = $2 FOR UPDATE`,
        [messageId, channelId]
      );
      if (locked.length === 0) return false;
      await tx.query(
        `SELECT ${clientIdLockSql('"authorId"', '"channelId"', '"clientMessageId"')}
           FROM channel_messages
          WHERE id = $1 AND "channelId" = $2 AND "clientMessageId" IS NOT NULL`,
        [messageId, channelId]
      );
      await tx.query(
        `INSERT INTO channel_message_client_tombstones ("authorId", "channelId", "clientMessageId")
         SELECT "authorId", "channelId", "clientMessageId" FROM channel_messages
          WHERE id = $1 AND "channelId" = $2 AND "clientMessageId" IS NOT NULL
         ON CONFLICT DO NOTHING`,
        [messageId, channelId]
      );
      await tx.getRepository(ChannelMessage).delete({ id: messageId, channelId });
      return true;
    });
    if (!removed) {
      // Read above, gone once its lock was granted: an account erasure or another delete removed it
      // meanwhile. Nothing was written; the frame below still tells the salon it is gone.
      this.logger.log(
        `[CHANNEL] message ${messageId} channel=${channelId} was removed concurrently - no tombstone written`
      );
    }

    const audience = await this.channelAudience(channel);
    await this.redis.publishChannelEvent(
      'channel.message.deleted',
      { channelId, messageId, deletedBy: userId },
      audience
    );

    this.logger.log(
      `[CHANNEL] message deleted channel=${channelId} message=${messageId} by=${userId.slice(0, 8)}${
        msg.authorId === userId ? '' : ' (moderation)'
      }`
    );
    return { success: true, channelId, messageId };
  }

  /** Returns the IDs of the pinned messages in a channel. Access-controlled by canAccessChannel. */
  async listPinnedMessageIds(channelId: string, userId: string): Promise<string[]> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const rows = await this.messageRepo.find({
      where: { channelId, pinned: true },
      select: { id: true },
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Returns up to 200 messages from a channel in reverse chronological order (newest first).
   * Access-controlled by canAccessChannel. When `before` (ISO timestamp) is provided, only
   * messages strictly older than it are returned (keyset pagination): callers page back through
   * history by passing the oldest `createdAt` of the previous page, until an empty page is
   * returned. Used for older-message loading and full-text search over the whole channel.
   */
  async listMessages(channelId: string, userId: string, limit = 50, before?: string) {
    const channel = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('Channel not found');

    const member = await this.memberRepo.findOne({
      where: { workspaceId: channel.workspaceId, userId },
    });
    if (!member || !this.canAccessChannel(channel, member, userId)) {
      throw new ForbiddenException('Not allowed to access this channel');
    }

    const safeLimit = Math.min(Math.max(1, limit), 200);
    const beforeDate = before ? new Date(before) : null;
    const hasValidCursor = beforeDate !== null && !Number.isNaN(beforeDate.getTime());

    // THE PAGE IS FILLED WITH BODIES, AND THE SILENT ROWS INSIDE IT COME ALONG.
    //
    // A reaction is a row now, so a plain `take: limit` would let a burst of them push real
    // messages out of the page - a channel that quietly shows less history the more people react
    // to it, with nothing anywhere saying so. So the limit counts non-silent rows, and every
    // silent row newer than the oldest of them is added: bounded by the same window, and complete
    // for every message the page actually shows.
    const bodies = await this.messageRepo.find({
      where: {
        channelId,
        silent: false,
        ...(hasValidCursor ? { createdAt: LessThan(beforeDate) } : {}),
      },
      order: { createdAt: 'DESC' },
      take: safeLimit,
    });
    const oldestInPage = bodies[bodies.length - 1]?.createdAt ?? null;
    // A SHORT PAGE IS THE END OF THE HISTORY: fewer bodies than asked means no older body exists, so
    // no later page will ever be asked for what lies below the oldest one. A membership notice
    // written before a salon's first body (the join that precedes the first word) would otherwise
    // be in no page at all - so the lower bound goes and only the cursor bounds the silent rows.
    const historyExhausted = bodies.length > 0 && bodies.length < safeLimit;
    if (historyExhausted) {
      this.logger.debug(
        `[HISTORY] channel=${channelId} short page (${bodies.length}/${safeLimit}): silent rows below the oldest body included`
      );
    }
    // NO BODY AT ALL: A salon whose only rows are membership notices (sent silent since 2026-10-18,
    // so they ring and count nothing) would otherwise show an empty history. Bounded by the page
    // limit, and by the cursor like everything else.
    const silentRows =
      bodies.length === 0
        ? await this.messageRepo.find({
            where: {
              channelId,
              silent: true,
              ...(hasValidCursor ? { createdAt: LessThan(beforeDate) } : {}),
            },
            order: { createdAt: 'DESC' },
            take: safeLimit,
          })
        : await this.messageRepo.find({
            where: {
              channelId,
              silent: true,
              ...(historyExhausted
                ? hasValidCursor
                  ? { createdAt: LessThan(beforeDate) }
                  : {}
                : {
                    createdAt: hasValidCursor
                      ? And(MoreThanOrEqual(oldestInPage), LessThan(beforeDate))
                      : MoreThanOrEqual(oldestInPage),
                  }),
            },
            order: { createdAt: 'DESC' },
          });
    const msgs = [...bodies, ...silentRows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );

    // Lazily auto-unpin polls past their deadline so closed polls stop cluttering
    // the pin list (no scheduler: this runs opportunistically on channel open).
    const expiredPollIds = msgs
      .filter((m) => {
        const poll = (m.metadata as { poll?: ChannelPollMeta } | null)?.poll;
        return m.pinned && !!poll && this.pollIsOver(poll);
      })
      .map((m) => m.id);
    if (expiredPollIds.length > 0) {
      await this.messageRepo.update({ id: In(expiredPollIds) }, { pinned: false });
      for (const m of msgs) if (expiredPollIds.includes(m.id)) m.pinned = false;
      this.logger.log(
        `[POLL] auto-unpinned ${expiredPollIds.length} closed poll(s) in channel=${channelId}`
      );
    }

    return msgs.map((m) => ({
      id: m.id,
      channelId: m.channelId,
      senderId: m.authorId,
      ciphertext: m.content,
      nonce: m.nonce ?? null,
      senderSessionId: m.senderSessionId ?? null,
      messageIndex: m.messageIndex ?? null,
      signature: m.signature ?? null,
      replyTo: m.replyTo ?? null,
      createdAt: m.createdAt,
      pinned: m.pinned,
      // Poll state (label-free) so the client can render results on load.
      poll: this.servedPoll((m.metadata as { poll?: ChannelPollMeta } | null)?.poll),
      silent: m.silent,
    }));
  }

  // ================= ROLE BASE PERMISSIONS =================

  /** Fetches a role's base permissions at the workspace level. */
  async getRoleBasePermissions(roleId: string, actorUserId: string) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');

    // Verify the actor has MANAGE_ROLES or MANAGE_WORKSPACE
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId: role.workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    let hasPerm = false;
    if (actorMember.roleIds?.length > 0) {
      const actorRoles = await this.roleRepo.find({ where: { id: In(actorMember.roleIds) } });
      hasPerm = actorRoles.some((r) => roleGrantsRoleManagement(r.permissions));
    }
    if (!hasPerm) throw new ForbiddenException('Missing MANAGE_ROLES permission');

    return {
      roleId: role.id,
      roleName: role.name,
      permissions: role.permissions,
    };
  }

  /**
   * The actor's right to manage this workspace's roles - refused here, never returned - and, when
   * they have it, the permissions they hold (the union over their roles), which is what bounds
   * every role change they make (`actorMayGrantRole`).
   *
   * THE ONE GATE of every role-management write - creating a role, assigning one, editing what one
   * grants - so they can never disagree about who may do it, which is the drift
   * `writePolicyAllows` was extracted to end one feature over.
   */
  private async assertActorManagesRoles(
    workspaceId: string,
    actorUserId: string
  ): Promise<string[]> {
    const actorMember = await this.memberRepo.findOne({
      where: { workspaceId, userId: actorUserId },
    });
    if (!actorMember) throw new ForbiddenException('Not a member of this workspace');

    const permissions = await this.permissionsOfMember(actorMember);
    if (!roleGrantsRoleManagement(permissions)) {
      throw new ForbiddenException('Missing MANAGE_ROLES permission');
    }
    return permissions;
  }

  /**
   * Refuses a role change that would grant, or touch, more than the actor holds. Logged at warn
   * with what was attempted, and typed, so a client maps it from the code and never the prose.
   */
  private refuseRoleChangeBeyondActor(
    what: string,
    workspaceId: string,
    actorUserId: string
  ): never {
    this.logger.warn(
      `[ROLE] refused ${what} - beyond the actor's own permissions workspace=${workspaceId} by=${actorUserId.slice(0, 8)}`
    );
    throw new ForbiddenException({
      code: ROLE_CHANGE_EXCEEDS_ACTOR,
      message: 'This role change goes beyond your own permissions.',
    });
  }

  /**
   * Tells the community what a role now grants, so no open grid keeps showing what it used to.
   *
   * A ROLE'S PERMISSIONS ARE NOT PRIVATE WITHIN THE COMMUNITY - the workspace listing already hands
   * every member the full `roles` array - so the audience is the membership rather than the
   * administrators, and this discloses nothing a member could not already read.
   */
  private async announceRolePermissions(role: ChannelRole): Promise<void> {
    const members = await this.memberRepo.find({ where: { workspaceId: role.workspaceId } });
    await this.redis.publishChannelEvent(
      'workspace.role.permissions',
      { workspaceId: role.workspaceId, roleId: role.id, permissions: role.permissions },
      members.map((m) => m.userId)
    );
    await this.announceStandingToHolders(role, members);
  }

  /**
   * Tells each HOLDER of an edited role what they may now do - the same `workspace.role.changed`
   * an assignment sends, because from where they stand it is the same event.
   *
   * `workspace.role.permissions` redraws the grid and nothing else: the client caches its OWN
   * standing as decisions (`viewerCanManage`, `viewerCanManageChannels`, `viewerCanModerate`), never
   * re-derived from the grid. So granting `channel.manage` to Moderateur left every moderator without
   * the salon controls, and revoking it left them offered controls that now fail, until their next
   * full load.
   *
   * The audience is SPLIT BY THE ANSWER, one publish per distinct verdict (eight at most), because one
   * payload cannot carry a per-viewer answer and a publish per holder would be one per member for
   * Membre. A holder's other roles count, so the verdict is over everything they hold. Best-effort
   * and logged, like the assignment's: the permissions are already written.
   */
  private async announceStandingToHolders(
    role: ChannelRole,
    members: ChannelMember[]
  ): Promise<void> {
    const holders = members.filter((m) => m.roleIds?.includes(role.id));
    if (holders.length === 0) return;
    try {
      const roles = await this.roleRepo.find({ where: { workspaceId: role.workspaceId } });
      const byId = new Map(roles.map((r) => [r.id, r]));
      byId.set(role.id, role);
      const byVerdict = new Map<
        string,
        { canManage: boolean; canManageChannels: boolean; canModerate: boolean; to: string[] }
      >();
      for (const holder of holders) {
        const held = (holder.roleIds ?? []).flatMap((id) => byId.get(id)?.permissions ?? []);
        const canManage = held.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE);
        const canManageChannels = roleGrantsChannelManagement(held);
        const canModerate = roleGrantsModeration(held);
        const key = `${canManage}:${canManageChannels}:${canModerate}`;
        const group = byVerdict.get(key) ?? { canManage, canManageChannels, canModerate, to: [] };
        group.to.push(holder.userId);
        byVerdict.set(key, group);
      }
      for (const { canManage, canManageChannels, canModerate, to } of byVerdict.values()) {
        await this.redis.publishChannelEvent(
          'workspace.role.changed',
          {
            workspaceId: role.workspaceId,
            roleName: role.name,
            permissions: role.permissions,
            canManage,
            canManageChannels,
            canModerate,
          },
          to
        );
      }
      this.logger.log(
        `[ROLE] standing announced role=${role.id} holders=${holders.length} verdicts=${byVerdict.size}`
      );
    } catch (e) {
      this.logger.warn(
        `[ROLE] permissions saved but holders not told role=${role.id} holders=${holders.length}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /**
   * Grants or revokes ONE permission on a role, applied to the row as it stands.
   *
   * WHY IT IS A DELTA AND NOT A WHOLE LIST (the whole-list PUT is gone since `minClientVersion`
   * 1.2.7). Clicking a cell in the permission grid IS a delta -
   * "grant this one key" - and it was being sent as the role's entire list, computed from whatever
   * the browser happened to be holding. Two administrators toggling two DIFFERENT permissions of one
   * role at the same moment therefore did not race: the second write carried a list built before the
   * first one landed and simply erased it. COMM-20 measured it on production on 2026-08-20 - the
   * second administrator's grid went on showing a permission the server had dropped AND one it had
   * never stored, indefinitely, with nothing to say so.
   *
   * **TWO EDITS THAT COMMUTE MUST BE SENT AS THE OPERATIONS THEY ARE.** Expressed as a delta there
   * is nothing to merge and nothing to lose: each write reads the current row and changes one key.
   * A whole-list write with optimistic concurrency would have been the other answer, and a worse
   * one - it turns two compatible edits into a conflict somebody has to resolve by hand.
   *
   * **AND THE DELTA IS APPLIED UNDER A ROW LOCK, because a delta computed in application memory is
   * the same lost update one layer down.** COMM-20 measured that too, on 2026-08-20, against the
   * first fix: the wire carried one key, both requests still read the same row before either wrote,
   * and the second still erased the first. See the transaction below.
   */
  async setRoleBasePermission(roleId: string, actorUserId: string, key: string, granted: boolean) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    const actorPermissions = await this.assertActorManagesRoles(role.workspaceId, actorUserId);

    const validPermissions = Object.values(CHANNEL_PERMISSIONS) as string[];
    if (!validPermissions.includes(key)) {
      throw new BadRequestException(`Invalid permission: ${key}`);
    }

    // THE DELTA IS APPLIED WHERE THE ROW LIVES, NOT WHERE THIS PROCESS HAPPENS TO HOLD A COPY.
    //
    // Sending one key instead of the whole list moved the lost update off the wire; it did not
    // remove it. Read-modify-write in application memory is the same defect one layer down: two
    // requests arriving together each read `["channel.moderate", ...]`, each compute their own next
    // list from it, and each write the whole row - so the second erases the first exactly as the
    // browser used to. MEASURED ON PRODUCTION 2026-08-20, by COMM-20, against the fix for COMM-20.
    //
    // The lock is what serialises them, and it is taken by the DATABASE on the row itself: nothing
    // here waits, retries or compares versions, and two nodes behind the load balancer are as safe
    // as two requests on one. The critical section holds one SELECT and one UPDATE of a single row;
    // the authorisation above and the announcement below are deliberately outside it.
    const saved = await this.roleRepo.manager.transaction(async (em) => {
      const locked = await em.findOne(ChannelRole, {
        where: { id: roleId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) throw new NotFoundException('Role not found');

      // BOUNDED BY THE ACTOR, read on the LOCKED row so a concurrent grant cannot slip a role past
      // the check: the role must grant nothing the actor lacks (their own role included), and a
      // granted key must be one the actor holds.
      const current = locked.permissions ?? [];
      if (
        !actorMayGrantRole(actorPermissions, current) ||
        (granted && !actorMayGrantRole(actorPermissions, [key]))
      ) {
        this.refuseRoleChangeBeyondActor(
          `${granted ? 'grant' : 'revoke'} ${key} on role=${roleId}`,
          role.workspaceId,
          actorUserId
        );
      }
      locked.permissions = granted
        ? [...new Set([...current, key])]
        : current.filter((p) => p !== key);
      return em.save(ChannelRole, locked);
    });

    this.logger.log(
      `[ROLE] ${granted ? 'granted' : 'revoked'} ${key} role=${roleId} ` +
        `by=${actorUserId.slice(0, 8)} perms=${saved.permissions.length}`
    );
    await this.announceRolePermissions(saved);

    return { roleId: saved.id, roleName: saved.name, permissions: saved.permissions };
  }
}

/**
 * Whether a failure is infrastructure (a service down or slow, a database error, a 5xx) rather than
 * a refusal or a defect: an HTTP exception below 500 and a TypeError / RangeError / ReferenceError are
 * logical (the caller logs every failure at error level), everything else may pass by itself.
 */
export function isTransientFailure(err: unknown): boolean {
  // A departure race that outlasted its inline retries is still a race: the next attempt may pass.
  if (isDepartureSuperseded(err)) return true;
  if (err instanceof HttpException) return err.getStatus() >= 500;
  // A programming error is deterministic: no retry fixes it, so it must not hide as a quiet 503.
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) {
    return false;
  }
  return true;
}
