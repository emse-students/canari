import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Inject,
  UseGuards,
  Headers,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  GoneException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual, DataSource, In } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { GroupMember } from '../entities/group-member.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { RevokedDeviceGroup } from '../entities/revoked-device-group.entity';
import { activeRevocationWhere } from '../utils/revocation';
import { readPendingMembershipFacts } from '../utils/pending-membership-facts';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { Throttle } from '@nestjs/throttler';
import {
  canonicalUserId,
  sanitizeQueryValue,
  sanitizeOptionalQueryValue,
  parseLeafIdentity,
  assertCallerOwnsUserId,
  type LeafIdentity,
} from '../utils/sanitize';
import { RETENTION_WINDOW_MS } from '../retention.constants';
import { resolveUserDisplayNamesBatch } from '../utils/display-name';
import { isBlockedBetween } from '../utils/user-blocks';
import {
  bumpSeatGeneration,
  readSeatGeneration,
  recordSeatEviction,
  withSeatLock,
} from '../utils/seat-eviction';
import {
  endDeviceMemberships,
  endGroupMembership,
  exclusionWindows,
  openMissingIntervals,
  stretchStart,
  partingKey,
  withdrawAwaitingSeat,
  writePendingSeats,
  assertCallerActsOnGroup,
  callerSeatStanding,
  refuseAwaitingSeat,
  withheldWindows,
  type AwaitingSeatWithdrawal,
  type ExclusionWindow,
} from '../utils/group-membership';
import { cutUserId } from '../utils/log-repeat';
import { announceJoinAskSettled } from '../utils/join-ask-announce';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { RefusalCode, refusalBody } from '../utils/refusal-codes';

/**
 * The most groups `POST /api/mls/group-rosters` answers in one request.
 *
 * MIRRORED BY `GROUP_ROSTERS_MAX_GROUPS` in `frontend/src/lib/mls-client/mlsDeliveryApi.ts`, which
 * chunks by it: a client must not learn a limit by being refused (the lesson of the history batch,
 * whose cap went unnoticed while every catch-up was refused). The production account the request
 * was sized on held 89 groups.
 */
export const GROUP_ROSTERS_MAX_GROUPS = 200;

/**
 * The most leaf identities `POST /api/mls/groups/:groupId/revoked-leaves` answers in one request -
 * a whole key group's tree in one read. MIRRORED BY `REVOKED_LEAVES_MAX_IDENTITIES` in
 * `frontend/src/lib/mls-client/mlsDeliveryApi.ts`, which chunks by it.
 */
export const REVOKED_LEAVES_MAX_IDENTITIES = 1000;

/**
 * Revoked-leaf questions one user may ask per minute. The client asks at most once per key group a
 * device holds per roster pass, and again only when that group's leaves changed
 * (`rosterReconcile.ts`): a session start asks once per held key group - one per community and one
 * per private salon held. Sized for an account in hundreds of them, since a refused question removes
 * no revoked device that pass (it is not recorded, and the next pass asks again); a loop asking
 * about arbitrary pairs is still bounded to a few per second.
 */
export const REVOKED_LEAVES_LIMIT_PER_MINUTE = 600;

/** One device's seat in one group, with the facts that say which kind of `pending` it is. */
interface DeviceSeatFacts {
  status: 'pending' | 'active';
  welcomeQueued: boolean;
  addInFlight: boolean;
  admitted: boolean;
  /** The user's seat awaits a member's admission (an invitation link's - migration 038). */
  awaitingAdmission: boolean;
}

/** One row of `GET mls/groups/:groupId/user-members`. */
export interface UserMemberRow {
  userId: string;
  displayName: string | null;
  awaitingAdmission: boolean;
  askId: string | null;
}

/** Group membership management: add/remove members, list members, list user groups. */
@Controller()
export class MembersController {
  private readonly logger = new Logger(MembersController.name);

  constructor(
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(UserDismissedGroup)
    private dismissedRepo: Repository<UserDismissedGroup>,
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(MlsGroupInfo)
    private groupInfoRepo: Repository<MlsGroupInfo>,
    @InjectRepository(QueuedMessage)
    private queuedMessageRepo: Repository<QueuedMessage>,
    @InjectRepository(RevokedDevice)
    private revokedDeviceRepo: Repository<RevokedDevice>,
    @InjectRepository(RevokedDeviceGroup)
    private revokedDeviceGroupRepo: Repository<RevokedDeviceGroup>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly dataSource: DataSource
  ) {}

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
  }

  /**
   * Authorizes an add/remove membership mutation on `safeGroupId`. The caller (nginx-injected,
   * HMAC-bound `x-user-id`) is allowed only when one of the following holds:
   *  - it is a platform global admin (`x-global-admin: true`);
   *  - it is already an ADMITTED member of the group - covers invites, welcome_request re-adds, and the
   *    inviter/joiner backfill paths, which all run as an existing member (the inviter registers
   *    an invitee BEFORE sending the Welcome, so the invitee is a member by the time it self-heals);
   *  - (add only) the group has no members yet AND the caller is adding itself - the group-creation
   *    bootstrap, where the creator registers its own userId first before anyone else exists.
   *
   * Blocks the self-join escalation (audit S1): a non-member cannot insert itself into a populated
   * group's `dm_group_members` and then external-join via the served GroupInfo, nor remove others
   * from a group it does not belong to (audit S5). When `x-user-id` is absent (deployments without
   * INTERNAL_SHARED_SECRET), the check is a no-op to preserve legacy behavior, matching
   * `assertCallerOwnsUserId`.
   *
   * A SEAT STILL AWAITING A MEMBER'S ADMISSION IS NOT A MEMBERSHIP HERE ({@link callerSeatStanding}):
   * counted as one, a person waiting on an invitation link enrolled an accomplice whose seat read as
   * not awaiting, and who then entered by external commit with no member's Add. It may only LEAVE
   * (`allowSelfLeave`, the removal of its own seat); anything else is the 409 `awaiting_admission`.
   */
  private async assertCallerMayMutateMembership(
    safeGroupId: string,
    targetUserId: string,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    allowCreationBootstrap: boolean,
    allowSelfLeave = false
  ): Promise<void> {
    if (headerGlobalAdmin === 'true') return;
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (!caller) return;

    const standing = await callerSeatStanding(this.groupMemberRepo, safeGroupId, caller);
    if (standing === 'admitted') return;
    if (standing === 'awaiting') {
      if (allowSelfLeave && caller === targetUserId) return;
      throw refuseAwaitingSeat(
        this.logger,
        'MEMBERSHIP',
        safeGroupId,
        caller,
        ` target=${cutUserId(targetUserId)}`
      );
    }

    // Group-creation bootstrap: the creator adds its own userId while the group is still empty.
    if (
      allowCreationBootstrap &&
      (await this.isCreationBootstrap(safeGroupId, caller, targetUserId))
    )
      return;

    throw new ForbiddenException(
      refusalBody(
        RefusalCode.MEMBERSHIP_NOT_ALLOWED,
        'Caller is not authorized to modify this group membership'
      )
    );
  }

  /**
   * The group-creation bootstrap: the group's CREATOR (`Group.createdBy`, the authenticated caller of
   * `POST mls/groups`) registers ITSELF into a group whose roster is still empty, before anyone else
   * exists. The one enrolment the member-add route still writes.
   *
   * The creation bootstrap enrols the group's recorded creator (`createdBy`) and nobody else; a
   * group with no recorded creator is bootstrapped by nobody (migration 042). Compared in canonical
   * form ({@link canonicalUserId}).
   *
   * UNLOCKED, SO IT ONLY ROUTES. What decides is the re-read under the seat lock taken exclusive
   * (`writePendingSeats(..., 'creator')`), which checks the creator and the empty roster again.
   */
  private async isCreationBootstrap(
    safeGroupId: string,
    caller: string | undefined,
    targetUserId: string
  ): Promise<boolean> {
    if (!caller || caller !== targetUserId) return false;
    if ((await this.groupMemberRepo.count({ where: { groupId: safeGroupId } })) > 0) return false;
    const group = await this.groupRepo.findOne({
      where: { id: safeGroupId },
      select: { id: true, createdBy: true },
    });
    if (group?.createdBy && group.createdBy === canonicalUserId(caller)) return true;
    this.logger.warn(
      `[ADD_MEMBER] bootstrap REFUSED group=${safeGroupId} caller=${cutUserId(caller)} ` +
        `creator=${group?.createdBy ? cutUserId(group.createdBy) : 'none'} - an empty roster is ` +
        `enrolled into by its creator alone; nothing written`
    );
    return false;
  }

  /**
   * Authorizes a roster read on `safeGroupId`. The caller (nginx-injected, HMAC-bound `x-user-id`)
   * must be a platform global admin or an existing member of the group. Blocks roster enumeration
   * by non-members (audit S5): the user list and active-device list are group metadata that leak
   * social graph / device topology. Freshly-invited joiners are registered as members BEFORE their
   * Welcome, so recovery/re-invite reads still pass. No-op when `x-user-id` is absent (legacy
   * deployments without INTERNAL_SHARED_SECRET), matching `assertCallerOwnsUserId`.
   *
   * A seat still awaiting a member's admission reads no roster: it is answered the 409
   * `awaiting_admission` ({@link callerSeatStanding}), never the 403 its client would retire on.
   */
  private async assertCallerIsGroupMember(
    safeGroupId: string,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined
  ): Promise<void> {
    if (headerGlobalAdmin === 'true') return;
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (!caller) return;
    const standing = await callerSeatStanding(this.groupMemberRepo, safeGroupId, caller);
    if (standing === 'admitted') return;
    if (standing === 'awaiting') {
      throw refuseAwaitingSeat(this.logger, 'ROSTER_READ', safeGroupId, caller);
    }
    throw new ForbiddenException(
      refusalBody(RefusalCode.NOT_A_MEMBER, 'Caller is not a member of this group')
    );
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/users/:userId/groups')
  /**
   * Lists all groups a user belongs to, ordered by last update (most recent first).
   * The client relies on this order to seed the conversation list before local DB is ready.
   *
   * **This is the ONE place a client learns which groups exist**, and therefore the one place a
   * group can be hidden from every conversation surface at once: discovery, lifecycle
   * classification, sync eligibility, the sidebar, badges and `initializeConnection` are all fed
   * from this single answer. A Graine key-distribution group - a community's OR a private
   * salon's - is excluded here and nowhere else: it carries seeds, never a message, and the client
   * reaches it deliberately through the Graine layer rather than by finding it in a list of
   * conversations. BOTH scope columns are tested. Testing only the community one left a private
   * salon's group able to appear as a conversation the day anything wrote it a membership row,
   * which is precisely the day the warning below is supposed to fire instead.
   *
   * Excluding it at each consumer instead would be a rule every future consumer has to remember,
   * which is the shape of rule the next call site does not (see `docs/wiki/durable-rules.md`).
   */
  async getUserGroups(
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
    @Headers('x-canari-device') headerDeviceId?: string
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      "Cannot list another user's groups"
    );
    const memberships = await this.groupMemberRepo.find({
      where: { userId: safeUserId },
    });
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];
    if (groupIds.length === 0) {
      this.logger.log(`[USER_GROUPS] user=${safeUserId} groups=0`);
      return [];
    }
    const groups = await this.groupRepo.find({ where: { id: In(groupIds) } });
    // Partitioned rather than filtered in SQL so the count below names ONE cause. A `WHERE
    // distributionWorkspaceId IS NULL` would make the number of hidden rows a subtraction, and a
    // subtraction cannot tell a distribution group from a membership pointing at a row that is
    // simply gone - two situations needing opposite responses.
    const isDistribution = (g: Group) => !!g.distributionWorkspaceId || !!g.distributionChannelId;
    const distribution = groups.filter(isDistribution);
    const activeGroups = groups
      .filter((g) => !isDistribution(g) && !g.deletedAt)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (distribution.length > 0) {
      // Not expected: the distribution group is joined by external commit and holds no membership
      // rows, so reaching this line means something wrote one. Logged loudly because the exclusion
      // above is what keeps it out of the sidebar, and the exclusion working is not the same as
      // nothing being wrong.
      this.logger.warn(
        `[USER_GROUPS] user=${safeUserId} holds ${distribution.length} membership row(s) on a ` +
          `distribution group, which should have none: ${distribution.map((g) => g.id).join(',')}`
      );
    }
    this.logger.log(
      `[USER_GROUPS] user=${safeUserId} groups=${activeGroups.length} ids=${activeGroups.map((g) => g.id).join(',')}`
    );
    // THE TWO EPOCHS, SO A HOLDER CAN SEE THAT THE PUBLISHED EXTERNAL-JOIN BASE IS BEHIND.
    //
    // Nothing but a member's own publish mints a base, and that publish is a follow-up to a commit:
    // when it is lost - a closed tab, an offline moment, a refused request - the group's epoch has
    // advanced and the published base stays where it was. The epoch gate accepts `baseEpoch ==
    // activeEpoch` and nothing else, so from that moment EVERY device without local MLS state is
    // refused, every time, and only another commit into that group would ever fix it. Measured on
    // production 2026-09-04: four of the forty-three groups holding a base were stale, every one by
    // exactly ONE epoch, two of them since 2026-08-30 with three devices sitting `pending` on them.
    //
    // WHY HERE AND NOT IN A REPAIR ENDPOINT OF ITS OWN. This is the one call every device makes on
    // every connection, and a device that HOLDS the tree is the only thing that can mint a base. So
    // the fact travels on the read the repairer already performs: no timer, no queue, no second copy
    // of the state - the two columns ARE the durable record of "a republish is owed", they are
    // authoritative, and they answer exactly that question. `republishBaseIfStale` on the client is
    // the other half.
    //
    // `baseEpoch: null` means no base has ever been published, which is NOT staleness: a joiner
    // asks a member for a Welcome then, and a holder has nothing to repair.
    const bases = await this.groupInfoRepo.find({
      select: { groupId: true, baseEpoch: true },
      where: { groupId: In(activeGroups.map((g) => g.id)) },
    });
    const baseOf = new Map(bases.map((b) => [b.groupId, b.baseEpoch]));
    // THIS DEVICE'S OWN SEAT IN EACH GROUP, so a device that only ever READS can learn it was given
    // a roster seat nobody honoured. `recoverRosterDisagreement` closes that case for a device that
    // tries to SEND (the refusal is its proof); a silent reader produces no evidence at all, yet
    // every frame the group makes is sealed to a tree its leaf is absent from. The fact is already
    // authoritative server-side, and this is the one read every device makes on every connection,
    // so it needs no timer and no new trigger. ADDITIVE: the device is the caller's own
    // `X-Canari-Device` (self-asserted, only ever used to read ITS OWN rows of the caller's own
    // user), and without it - an older client - the field is `null` for every row, which a client
    // reads as "the server did not say", never as "nothing owed".
    const deviceMembershipOf = await this.readDeviceMemberships(
      safeUserId,
      headerDeviceId,
      activeGroups.map((g) => g.id),
      new Set(memberships.filter((m) => m.awaitingAdmission === true).map((m) => m.groupId))
    );
    // THE INSTANT THE GROUP CAME INTO EXISTENCE, because a client cannot derive it and keeps
    // asking other members for a past that never existed.
    //
    // The scrollback exists to reach BELOW a device's retention window - ninety days in a browser -
    // by asking a member who kept more. A group created INSIDE that window has nothing below it,
    // and everything inside it belongs to the reconciliation on connect, not to the scrollback. The
    // client could not tell the two apart: its oldest held message is always strictly AFTER the
    // group was created, so "I hold the first message" and "I am missing the past" look identical
    // from the messages alone. A brand-new conversation therefore asked, found nobody online to
    // answer - on a first contact the only other member is the person who just wrote - and told the
    // reader no device could supply older messages, which was the first thing they saw of a new
    // correspondent. Reproduced on an Android handset 2026-09-21 on a group two minutes old.
    //
    // `@CreateDateColumn`, so it exists for every row ever written and never moves.
    return activeGroups.map((g) => ({
      groupId: g.id,
      name: g.name,
      isGroup: g.isGroup,
      imageMediaId: g.imageMediaId ?? null,
      deletedAt: g.deletedAt ?? null,
      createdAt: g.createdAt ?? null,
      activeEpoch: g.activeEpoch,
      baseEpoch: baseOf.get(g.id) ?? null,
      deviceMembership: deviceMembershipOf.get(g.id) ?? null,
    }));
  }

  /**
   * This device's membership row per group, each carrying the two facts that say which kind of
   * `pending` it is (the one partition is {@link readPendingMembershipFacts}). Empty without a
   * device header, and a group the device has no row for is simply absent from the map.
   *
   * @param awaitingGroups the groups where the user's seat awaits a member's admission
   *   (`GroupMember.awaitingAdmission`, read off the roster rows the caller already holds): such a
   *   seat is an ask a member answers, never a stranded one.
   */
  private async readDeviceMemberships(
    userId: string,
    deviceId: string | undefined,
    groupIds: string[],
    awaitingGroups: ReadonlySet<string>
  ): Promise<Map<string, DeviceSeatFacts>> {
    const out = new Map<string, DeviceSeatFacts>();
    if (!deviceId || groupIds.length === 0) return out;
    const safeDeviceId = sanitizeOptionalQueryValue(deviceId, 'x-canari-device');
    if (!safeDeviceId) return out;
    const rows = await this.deviceGroupRepo.find({
      where: { userId, deviceId: safeDeviceId, groupId: In(groupIds) },
    });
    const pending = rows.filter((r) => r.status === 'pending').map((r) => r.groupId);
    const { welcomed, locked } = await readPendingMembershipFacts(
      this.queuedMessageRepo,
      this.redis,
      safeDeviceId,
      pending,
      this.logger
    );
    for (const r of rows) {
      out.set(r.groupId, {
        status: r.status,
        welcomeQueued: welcomed.has(r.groupId),
        addInFlight: locked.has(r.groupId),
        // A commit admitted this device at an epoch and its Welcome is owed (`admittedAtEpoch` is
        // cleared by every transition): the window between the commit and the Welcome, which the
        // add lock does not cover on every path.
        admitted: r.admittedAtEpoch !== null && r.admittedAtEpoch !== undefined,
        // An ACTIVE row is in the tree whatever the roster flag says, so it never reads as awaiting.
        awaitingAdmission: r.status !== 'active' && awaitingGroups.has(r.groupId),
      });
    }
    const stranded = [...out.entries()].filter(
      ([, v]) =>
        v.status === 'pending' &&
        !v.welcomeQueued &&
        !v.addInFlight &&
        !v.admitted &&
        !v.awaitingAdmission
    ).length;
    if (stranded > 0) {
      this.logger.log(
        `[USER_GROUPS] user=${userId} device=${safeDeviceId} stranded=${stranded} (pending, no Welcome queued, no add in flight, not admitted)`
      );
    }
    return out;
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/users/:userId/dismissed-groups')
  /**
   * Lists the group IDs this user has voluntarily dismissed (manual delete/leave). The client's
   * discovery purges any local conversation in this set on ALL the user's devices, instead of
   * showing the "deleted" banner reserved for peer-deletions/exclusions.
   */
  async getDismissedGroups(
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<string[]> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      "Cannot read another user's dismissed groups"
    );
    const rows = await this.dismissedRepo.find({
      where: { userId: safeUserId },
    });
    return rows.map((r) => r.groupId);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/users/:userId/dismissed-groups')
  /** Marks a group as dismissed by this user (idempotent). Propagates the local delete/leave to the user's other devices. */
  async dismissGroup(
    @Param('userId') userId: string,
    @Body() body: { groupId: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{ status: string }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot dismiss a group for another user'
    );
    const safeGroupId = sanitizeQueryValue(body?.groupId ?? '', 'groupId');
    // Idempotent: ON CONFLICT DO NOTHING via unique constraint (userId, groupId).
    const ins = await this.dismissedRepo
      .createQueryBuilder()
      .insert()
      .values({ userId: safeUserId, groupId: safeGroupId })
      .orIgnore()
      .execute();
    // WHAT ACTUALLY HAPPENED, not what was asked for. TypeORM appends RETURNING on Postgres, so
    // `raw` holds one row when the insert landed and none when the unique constraint ignored it.
    // Without this the line is identical whether a dismissal was recorded or already existed, and
    // a reader counting dismissals in a window counts requests instead.
    const recorded = Array.isArray(ins.raw) ? ins.raw.length : 0;
    this.logger.log(`[DISMISS] user=${safeUserId} group=${safeGroupId} recorded=${recorded}`);
    return { status: 'dismissed' };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/users/:userId/dismissed-groups/:groupId')
  /** Un-dismisses a group (called when the user is re-added via a fresh Welcome - they want it back). */
  async undismissGroup(
    @Param('userId') userId: string,
    @Param('groupId') groupId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{ status: string }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot un-dismiss a group for another user'
    );
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const del = await this.dismissedRepo.delete({
      userId: safeUserId,
      groupId: safeGroupId,
    });
    // ZERO IS THE ORDINARY CASE AND HAD TO BE VISIBLE. This endpoint means "ensure this group is not
    // dismissed", so every Welcome calls it whether or not a dismissal exists - and a dismissal is
    // per USER while the call is per DEVICE, so one re-add on a two-device account produces two
    // requests and at most one lift. Until 2026-08-21 both said the same sentence, and a READ-10
    // window on production showed two `[UNDISMISS]` lines one second apart for a group nobody had
    // ever dismissed: two events reported, zero events occurred, both promoted to `notable` for a
    // human to read. The count is what separates the lift from the no-op.
    const lifted = del.affected ?? 0;
    this.logger.log(`[UNDISMISS] user=${safeUserId} group=${safeGroupId} lifted=${lifted}`);
    return { status: 'undismissed' };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups/:groupId/members')
  /**
   * Writes the pending device seats of a person ALREADY ADMITTED to the group - by the accepted
   * commit that added them - and enrols nobody else but a new group's creator into its empty roster.
   * A person no accepted commit admitted is answered `409 MEMBER_NOT_ADMITTED` (see the body).
   */
  async addGroupMember(
    @Param('groupId') groupId: string,
    @Body() body: { userId: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const traceId = this.makeTraceId('add-member');
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    // A GRAINE KEY-DISTRIBUTION GROUP IS NEVER POPULATED HERE, and letting one through was a
    // self-join. Its roster is community (or salon) membership, held by social-service, and its
    // devices enter by external commit - so it carries ZERO `dm_group_members` rows by construction,
    // which is exactly what the creation bootstrap below reads as "an empty group its creator is
    // registering into". Anybody who knew the id (a member removed from the community, say) could
    // therefore add themselves, pass `getGroupInfo` on the row just written, and external-join the
    // group that carries every salon seed. Audited 2026-09-27; production held no such row.
    const group = await this.groupRepo.findOne({ where: { id: safeGroupId } });
    if (group?.distributionWorkspaceId || group?.distributionChannelId) {
      this.logger.warn(
        `[ADD_MEMBER] REFUSED key-distribution group=${safeGroupId} user=${safeUserId.slice(0, 8)}`
      );
      throw new ForbiddenException({
        code: RefusalCode.KEY_DISTRIBUTION_GROUP,
        message:
          'A key-distribution group is joined through its community, not through this route.',
      });
    }
    await this.assertCallerMayMutateMembership(
      safeGroupId,
      safeUserId,
      headerUserId,
      headerGlobalAdmin,
      true // allow the group-creation bootstrap (creator registers itself into an empty group)
    );
    // THE ONE PLACE A BLOCK ACTUALLY STOPS SOMETHING. Hiding a person from the user search stops
    // nobody who already knows a uuid, and both paths the block is meant to close - opening a 1-to-1
    // and pulling somebody into a group - end HERE: without a `GroupMember` row the target's devices
    // never receive a pending membership, so no Welcome is ever built for them.
    //
    // It is scoped to ADDING A NEW MEMBER, which leaves existing groups untouched as decided. A
    // member's later devices enter through `registerDevice`, which fans the user's existing groups
    // out on its own and never comes through here - so healing a shared group keeps working across
    // a block, and that is the intent.
    //
    // The message is neutral: it says the person cannot be added, never who blocked whom.
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (caller && (await isBlockedBetween(this.dataSource.manager, caller, safeUserId))) {
      this.logger.log(
        `[ADD_MEMBER][${traceId}] REFUSED block between caller=${caller} target=${safeUserId}`
      );
      throw new ForbiddenException({
        code: RefusalCode.USER_BLOCKED,
        message: 'This person cannot be added.',
      });
    }

    this.logger.log(`[ADD_MEMBER][${traceId}] START group=${safeGroupId} user=${safeUserId}`);

    // Window aligned with retention: a still-recoverable device (last seen < 90 days)
    // must receive a pending membership even if idle for > 30 days.
    const cutoff = new Date(Date.now() - RETENTION_WINDOW_MS);
    const userDevices = await this.keyPackageRepo.find({
      where: { userId: safeUserId, createdAt: MoreThanOrEqual(cutoff) },
    });

    // THIS ROUTE ENROLS NOBODY BUT A GROUP'S CREATOR (ADM-3, 2026-10-25). The person a member's Add
    // admits is enrolled by the ACCEPTED COMMIT, in the transaction that accepts it
    // (`MessagingService.enrolAdmittedPeople`), which refuses a person whose Decline or departure
    // came after the Add was decided. This route used to enrol whoever it was named, with no seat
    // lock and no departure read: the adding member's client called it right after its accept, so a
    // Decline that the gate had just honoured was undone in the same second, and the Welcome that
    // followed found a seat. A person an accepted commit admitted is on the roster, ADMITTED, by the
    // time any client reads the accept; anyone else - absent, or still awaiting a member - was not
    // admitted, and the answer is the typed 409 `MEMBER_NOT_ADMITTED` with nothing written. Read
    // under the group's seat lock (`writePendingSeats`), the lock a Decline and a removal take, so
    // either is wholly before the read or waits for this transaction.
    if (!(await this.isCreationBootstrap(safeGroupId, caller, safeUserId))) {
      const outcome = await writePendingSeats(
        this.dataSource.manager,
        safeGroupId,
        safeUserId,
        userDevices.map((d) => d.deviceId),
        false,
        { requireAdmitted: true }
      );
      if (outcome === 'group_gone') {
        this.logger.warn(`[ADD_MEMBER][${traceId}] REFUSED group_gone group=${safeGroupId}`);
        throw new GoneException({ error: 'group_deleted', groupId: safeGroupId });
      }
      if (outcome !== 'written') {
        this.logger.warn(
          `[ADD_MEMBER][${traceId}] REFUSED not_admitted group=${safeGroupId} ` +
            `user=${cutUserId(safeUserId)} reason=${outcome === 'not_on_roster' ? 'no_seat' : 'awaiting_admission'} ` +
            `caller=${caller ? cutUserId(caller) : 'none'} - no accepted commit admitted them; nothing written`
        );
        throw new ConflictException(
          refusalBody(
            RefusalCode.MEMBER_NOT_ADMITTED,
            'No accepted commit admitted this person; this route enrols nobody.'
          )
        );
      }
      this.logger.log(
        `[ADD_MEMBER][${traceId}] DONE group=${safeGroupId} user=${safeUserId} devices=${userDevices.length} - already admitted, device seats written`
      );
      return { status: 'added' };
    }

    // THE CREATOR, into a group whose roster is still empty: the one enrolment written here, through
    // the one pending-seat writer (`writePendingSeats`), so under the group's seat lock, against the
    // group row re-read under it, and each device row only beside its key package read `FOR SHARE`
    // there - an account being erased gets no row its erasure could no longer find. The roster row
    // is written as `ensureGroupMember` writes it, an existing enrolment left untouched.
    const created = await writePendingSeats(
      this.dataSource.manager,
      safeGroupId,
      safeUserId,
      userDevices.map((d) => d.deviceId),
      'creator'
    );
    if (created === 'group_gone') {
      this.logger.warn(
        `[ADD_MEMBER][${traceId}] REFUSED group_gone group=${safeGroupId} - the creator's group ended before its enrolment`
      );
      throw new GoneException({ error: 'group_deleted', groupId: safeGroupId });
    }
    // The creator and "empty roster" reads above are unlocked; the ones that decide are the re-reads
    // under the seat lock. Someone else is on the roster, or the recorded creator is not this caller
    // (its id erased since): no accepted commit admitted them either - the same typed 409 as any
    // other person this route enrols nobody for.
    if (created === 'roster_taken' || created === 'not_creator') {
      this.logger.warn(
        `[ADD_MEMBER][${traceId}] REFUSED not_admitted group=${safeGroupId} user=${cutUserId(safeUserId)} ` +
          `reason=${created} - the creator's enrolment found the roster taken or another creator; nothing written`
      );
      throw new ConflictException(
        refusalBody(
          RefusalCode.MEMBER_NOT_ADMITTED,
          'No accepted commit admitted this person; this route enrols nobody.'
        )
      );
    }

    // NB: NOT added to group:members Redis here - devices enter the routing
    // set only when their Welcome is sent (sendWelcome sets status to active).
    this.logger.log(
      `[ADD_MEMBER][${traceId}] DONE group=${safeGroupId} user=${safeUserId} devices=${userDevices.length} - the creator, enrolled`
    );
    return { status: 'added' };
  }

  /**
   * Returns user-level membership from dm_group_members (no device-status filter).
   *
   * WITH `?withSeatGeneration=1`, the answer is `{ seatGeneration, members }`: the same rows, and
   * the group's seat generation (`dm_groups."seatGeneration"`, moved under the seat lock by every
   * removal and every member's Decline) READ BEFORE THEM. A member's invitation records it with its
   * roster baseline and its Add carries it (`ValidateCommitBody.invitationSeatGeneration`): the
   * commit gate refuses a person whose departure was recorded at a later generation - a Decline or
   * a removal the member had not seen when they decided. Read first, so a departure committed
   * between the two reads is later than the number AND absent from the rows: the Add is refused,
   * never wrongly admitted. Without the parameter the answer is the bare array every older client
   * reads.
   */
  async getGroupUserMembers(
    groupId: string,
    headerUserId?: string,
    headerGlobalAdmin?: string
  ): Promise<UserMemberRow[]>;
  async getGroupUserMembers(
    groupId: string,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    withSeatGeneration: '1'
  ): Promise<{ seatGeneration: number; members: UserMemberRow[] }>;
  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId/user-members')
  async getGroupUserMembers(
    @Param('groupId') groupId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
    @Query('withSeatGeneration') withSeatGeneration?: string
  ): Promise<UserMemberRow[] | { seatGeneration: number; members: UserMemberRow[] }> {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    await this.assertCallerIsGroupMember(safeGroupId, headerUserId, headerGlobalAdmin);
    const seatGeneration =
      withSeatGeneration === '1'
        ? await readSeatGeneration(this.dataSource.manager, safeGroupId)
        : null;
    const rows = await this.groupMemberRepo.find({
      where: { groupId: safeGroupId },
      select: { id: true, userId: true, awaitingAdmission: true },
    });
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const nameMap = await resolveUserDisplayNamesBatch(this.dataSource.manager, userIds);
    this.logger.log(
      `[GET_USER_MEMBERS] group=${safeGroupId} count=${rows.length}` +
        (seatGeneration === null ? '' : ` seatGeneration=${seatGeneration}`)
    );
    const members = rows.map<UserMemberRow>((r) => ({
      userId: r.userId,
      displayName: nameMap.get(r.userId) ?? null,
      // An invitation link's ask no member has answered: the one roster row a member is asked about,
      // with its identity - the seat's id - which every member's screen settles the ask by.
      awaitingAdmission: r.awaitingAdmission === true,
      askId: r.awaitingAdmission === true ? r.id : null,
    }));
    return seatGeneration === null ? members : { seatGeneration, members };
  }

  /**
   * The user-level rosters of many groups in ONE request - what `GET .../user-members` answers for
   * one group, minus the display names nobody reading a roster in bulk asks for.
   *
   * **WHY IT EXISTS.** The connection sync compares every held conversation's tree with its roster
   * (`removeStrayLeaves`, client side) and read the roster one group at a time: 81 sequential
   * `GET user-members` per connection, 5.0 s, on the 2026-10-12 production console. The answer is
   * the same rows; only the round trips were the cost.
   *
   * **THE SAME AUTHORIZATION AS THE SINGLE READ, PER GROUP.** A caller is answered for a group only
   * when it holds a row in that group's roster, or is a global admin. Every other group - one the
   * caller is not in, or one that does not exist - is listed in `refused` rather than failing the
   * whole request:
   * the single read's 403 per group, carried as a FACT the client reads by group, so it never has
   * to learn it by asking again.
   *
   * **NO CALLER IS NOT A WILDCARD HERE.** `assertCallerIsGroupMember` lets an absent `x-user-id`
   * through for deployments that predate the internal token; `HeaderAuthGuard` now refuses those
   * before any handler runs, so that branch is unreachable - and a branch that would hand EVERY
   * roster to a caller nobody identified is not copied into a route that reads many at once.
   *
   * **OLD CLIENTS ARE UNTOUCHED**: `GET mls/groups/:groupId/user-members` stays, and is still what
   * every other caller (membership guards, peer resolution) reads.
   *
   * A path of its own (`mls/group-rosters`) rather than one under `mls/groups/`, so it can never be
   * matched by a `mls/groups/:groupId/...` route.
   *
   * **`revoked`: THE REVOKED DEVICES OF EACH ANSWERED ROSTER, as `userId:deviceId`.** Revoking a
   * device purges its routing, and its LEAF stays in every tree until a member commits a Remove -
   * which only a member can do, and only for a leaf it KNOWS is revoked. So the same read that tells
   * the client which users left tells it which devices of the remaining users are revoked, under the
   * one active-revocation rule (`activeRevocationWhere`). Never for a refused group. A client that
   * predates the field ignores it.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/group-rosters')
  async getGroupRosters(
    @Body() body: { groupIds?: unknown } | undefined,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{
    rosters: Record<string, string[]>;
    refused: string[];
    revoked: Record<string, string[]>;
    awaiting: Record<string, string[]>;
  }> {
    const requested = body?.groupIds;
    if (!Array.isArray(requested)) {
      throw new BadRequestException('groupIds must be an array');
    }
    if (requested.length > GROUP_ROSTERS_MAX_GROUPS) {
      throw new BadRequestException(`At most ${GROUP_ROSTERS_MAX_GROUPS} groups per request`);
    }
    const groupIds = [...new Set(requested.map((g) => sanitizeQueryValue(g, 'groupId')))];
    if (groupIds.length === 0) return { rosters: {}, refused: [], revoked: {}, awaiting: {} };

    const rows = await this.groupMemberRepo.find({
      where: { groupId: In(groupIds) },
      select: { groupId: true, userId: true, awaitingAdmission: true },
    });
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    // A caller whose own seat still awaits a member's admission is answered as the single read
    // answers it - not a member - so it is listed in `refused` ({@link callerSeatStanding}).
    const callerAwaits = new Set(
      rows.filter((r) => r.userId === caller && r.awaitingAdmission).map((r) => r.groupId)
    );
    const byGroup = new Map<string, Set<string>>();
    for (const row of rows) {
      const members = byGroup.get(row.groupId) ?? new Set<string>();
      members.add(row.userId);
      byGroup.set(row.groupId, members);
    }

    const unrestricted = headerGlobalAdmin === 'true';
    const rosters: Record<string, string[]> = {};
    const refused: string[] = [];
    for (const groupId of groupIds) {
      const members = byGroup.get(groupId) ?? new Set<string>();
      if (!unrestricted && (!caller || !members.has(caller) || callerAwaits.has(groupId))) {
        refused.push(groupId);
        continue;
      }
      rosters[groupId] = [...members];
    }

    // ONE query over every answered roster's users; nothing is asked for a refused group.
    const answeredUsers = [...new Set(Object.values(rosters).flat())];
    const revokedRows =
      answeredUsers.length === 0
        ? []
        : await this.revokedDeviceRepo.find({
            where: activeRevocationWhere({ userId: In(answeredUsers) }),
            select: { userId: true, deviceId: true },
          });
    const revokedByUser = new Map<string, string[]>();
    for (const row of revokedRows) {
      const devices = revokedByUser.get(row.userId) ?? [];
      devices.push(`${row.userId}:${row.deviceId}`);
      revokedByUser.set(row.userId, devices);
    }
    const revoked: Record<string, string[]> = {};
    let revokedNamed = 0;
    for (const [groupId, userIds] of Object.entries(rosters)) {
      const identities = userIds.flatMap((u) => revokedByUser.get(u) ?? []);
      if (identities.length === 0) continue;
      revoked[groupId] = identities;
      revokedNamed += identities.length;
    }

    // THE PEOPLE OF EACH ANSWERED ROSTER WHOSE SEAT STILL AWAITS A MEMBER'S ADMISSION. Such a person
    // holds no leaf by right: the accepted commit that admits them lifts the flag in the transaction
    // that accepts it, so a leaf of theirs is one no commit admitted - an Add built before a Decline
    // (ADM-3), or a removed member's leaf that outlived the removal before they asked again. The
    // stray sweep reads them as off the roster (`strayLeaves.ts`). A client that predates the field
    // ignores it.
    const awaiting: Record<string, string[]> = {};
    for (const row of rows) {
      if (row.awaitingAdmission !== true || !rosters[row.groupId]) continue;
      (awaiting[row.groupId] ??= []).push(row.userId);
    }

    this.logger.log(
      `[GROUP_ROSTERS] asked=${groupIds.length} answered=${groupIds.length - refused.length} refused=${refused.length} rows=${rows.length} revoked=${revokedNamed}`
    );
    return { rosters, refused, revoked, awaiting };
  }

  /**
   * Which of the given leaf identities (`userId:deviceId`) of `groupId`'s tree belong to a device
   * under an ACTIVE revocation - answered for a KEY-DISTRIBUTION group as much as a conversation.
   *
   * **WHY IT EXISTS.** `POST mls/group-rosters` names the revoked devices of each answered roster,
   * but a key group has no user roster here (its roster is social-service's) and is never answered
   * there - so a revoked device of a community member kept its leaf in every community and salon key
   * group for good, even across reloads. The client's key-group roster pass reads its TREE, asks
   * this, and removes exactly what is named (`rosterReconcile.ts`).
   *
   * **AN ALLOWLIST, ASKED BY A MEMBER, ABOUT MEMBERS.** The caller must be an admitted member of the
   * group (`assertCallerActsOnGroup`: an active device row for a key group, a seat for a
   * conversation), AND each identity asked is answered only when it is bound to THIS group - its
   * user holds a device row in it, of any status, or a seat in it, or that exact device is recorded
   * as having held the key group when its revocation purged its rows (`dm_revoked_device_groups`,
   * {@link RevokedDeviceGroup}: in a key group the device rows were the user's only binding, and the
   * purge deletes them). Anybody else's pair is answered "not revoked" whatever the truth, so a
   * member of one group cannot read the revocations of people outside it.
   * The answer adds only "this one is revoked", under the one active-revocation rule
   * (`activeRevocationWhere`), and the route is throttled per user
   * ({@link REVOKED_LEAVES_LIMIT_PER_MINUTE}). The user half is
   * compared without case, the device half exact - the canonical identity Rust binds - and each
   * identity is answered AS SENT, so the client matches its own leaf string. An identity that is not
   * a leaf identity (`libs/contracts/leaf-identity.cases.json`) is skipped and counted, never a
   * refusal of the batch; a body that is not a list, or over the cap, is still a 400.
   */
  @UseGuards(HeaderAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: REVOKED_LEAVES_LIMIT_PER_MINUTE, ttl: 60_000 } })
  @Post('mls/groups/:groupId/revoked-leaves')
  async getRevokedLeaves(
    @Param('groupId') groupId: string,
    @Body() body: { identities?: unknown } | undefined,
    @Headers('x-user-id') headerUserId?: string
  ): Promise<{ revoked: string[] }> {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const requested = body?.identities;
    if (!Array.isArray(requested)) {
      throw new BadRequestException('identities must be an array');
    }
    if (requested.length > REVOKED_LEAVES_MAX_IDENTITIES) {
      throw new BadRequestException(
        `At most ${REVOKED_LEAVES_MAX_IDENTITIES} identities per request`
      );
    }
    const caller = sanitizeQueryValue(headerUserId ?? '', 'x-user-id');
    await assertCallerActsOnGroup(
      { groups: this.groupRepo, seats: this.groupMemberRepo, devices: this.deviceGroupRepo },
      this.logger,
      'REVOKED_LEAVES',
      safeGroupId,
      caller
    );

    // `userId:deviceId`, exactly one colon, each half under its own rule - never the generic 128
    // bound on the whole, which every real identity exceeds ({@link parseLeafIdentity}). A MALFORMED
    // ONE IS SKIPPED, NEVER A REFUSAL OF THE BATCH: a leaf identity is whatever a credential in the
    // tree says, so one crafted credential would otherwise block the answer about every other leaf
    // of the group, for every member. Counted in the line below, never printed.
    const leaves = new Map<string, LeafIdentity>();
    let malformed = 0;
    for (const value of requested) {
      const leaf = parseLeafIdentity(value);
      if (leaf === null) malformed++;
      else leaves.set(leaf.identity, leaf);
    }
    const pairs = [...leaves.values()].map(({ identity, userId, deviceId }) => ({
      identity,
      sentUser: userId,
      user: userId.toLowerCase(),
      device: deviceId,
    }));
    // A current client filters what this skips (`isAddressableLeafIdentity`), so a skipped one
    // accuses a credential or an old client - said at warn, with the count alone.
    const say = (line: string, converged: boolean): void => {
      if (malformed > 0)
        this.logger.warn(`${line} malformed=${malformed} - skipped, never answered`);
      else if (converged) this.logger.debug(line);
      else this.logger.log(line);
    };
    if (pairs.length === 0) {
      if (malformed > 0) {
        say(`[REVOKED_LEAVES] group=${safeGroupId} caller=${cutUserId(caller)} asked=0`, true);
      }
      return { revoked: [] };
    }

    // The user half both as sent and lowercased: the column holds whichever casing was written.
    const asked = [...new Set(pairs.flatMap((p) => [p.user, p.sentUser]))];
    // BOUND TO THIS GROUP: only users with a device row or a seat in it are answered at all - or
    // the exact device a revocation recorded as having held it ({@link RevokedDeviceGroup}).
    const [deviceRows, seatRows, revokedHeldRows] = await Promise.all([
      this.deviceGroupRepo.find({
        where: { groupId: safeGroupId, userId: In(asked) },
        select: { userId: true },
      }),
      this.groupMemberRepo.find({
        where: { groupId: safeGroupId, userId: In(asked) },
        select: { userId: true },
      }),
      this.revokedDeviceGroupRepo.find({
        where: { groupId: safeGroupId, userId: In(asked) },
        select: { userId: true, deviceId: true },
      }),
    ]);
    const bound = new Set([...deviceRows, ...seatRows].map((r) => r.userId.toLowerCase()));
    const heldWhenRevoked = new Set(
      revokedHeldRows.map((r) => `${r.userId.toLowerCase()}:${r.deviceId}`)
    );
    const inGroup = pairs.filter(
      (p) => bound.has(p.user) || heldWhenRevoked.has(`${p.user}:${p.device}`)
    );
    if (inGroup.length === 0) {
      // Not converged: no leaf asked about is bound to this group, so nothing here can be answered -
      // said at log level.
      say(
        `[REVOKED_LEAVES] group=${safeGroupId} caller=${cutUserId(caller)} asked=${pairs.length} outside=${pairs.length} revoked=0`,
        false
      );
      return { revoked: [] };
    }
    const users = [...new Set(inGroup.flatMap((p) => [p.user, p.sentUser]))];
    const rows = await this.revokedDeviceRepo.find({
      where: activeRevocationWhere({ userId: In(users) }),
      select: { userId: true, deviceId: true },
    });
    const banned = new Set(rows.map((r) => `${r.userId.toLowerCase()}:${r.deviceId}`));
    const revoked = inGroup
      .filter((p) => banned.has(`${p.user}:${p.device}`))
      .map((p) => p.identity);

    // A CONVERGED ANSWER IS DEBUG (the noise rule): every pass of every member of every key group
    // asks, and "all bound, none revoked" is the ordinary answer. A revoked or an unbound leaf is
    // what a reader needs, and stays at log level.
    const outside = pairs.length - inGroup.length;
    const line = `[REVOKED_LEAVES] group=${safeGroupId} caller=${cutUserId(caller)} asked=${pairs.length} outside=${outside} revoked=${revoked.length}`;
    say(line, revoked.length === 0 && outside === 0);
    return { revoked };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId/members')
  /**
   * Returns one `{ userId, deviceId }` entry per **active device** in `groupId`.
   * Sourced from `dm_device_group_memberships WHERE status = 'active'`.
   *
   * Use this endpoint for:
   * - MLS tree occupancy / stale-leaf detection (device-level identity required)
   * - Repopulating the Redis `group:members:` routing cache after a cache miss
   *
   * Do NOT use this to determine which users may be re-invited on recovery.
   * A group can have zero active device entries even though users still belong to it
   * (e.g. after a device fresh-start clears all DeviceGroupMembership rows). Use
   * `GET mls/groups/:groupId/user-members` (dm_group_members) for that purpose.
   */
  async getGroupMembers(
    @Param('groupId') groupId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    await this.assertCallerIsGroupMember(safeGroupId, headerUserId, headerGlobalAdmin);
    const rows = await this.deviceGroupRepo.find({
      where: { groupId: safeGroupId, status: 'active' as const },
      select: { userId: true, deviceId: true },
    });
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const nameMap = await resolveUserDisplayNamesBatch(this.dataSource.manager, userIds);
    this.logger.log(`[GET_MEMBERS] group=${safeGroupId} count=${rows.length}`);
    return rows.map((r) => ({
      userId: r.userId,
      deviceId: r.deviceId,
      displayName: nameMap.get(r.userId) ?? null,
    }));
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/groups/:groupId/members/:userId')
  /** Removes a user from a group server-side (deletes their GroupMember record). */
  async removeGroupMember(
    @Param('groupId') groupId: string,
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    // Only an existing member/admin of the group may remove a user (audit S5): mirrors the MLS
    // remove-commit semantics (removes are issued by members) and blocks the delivery-level DoS
    // where a non-member kicks anyone. Self-leave passes (the caller is a member). No creation
    // bootstrap on removal (a group is never emptied by adding-self), hence allowCreationBootstrap=false.
    await this.assertCallerMayMutateMembership(
      safeGroupId,
      safeUserId,
      headerUserId,
      headerGlobalAdmin,
      false,
      true // self-leave: a seat still awaiting a member may withdraw itself
    );

    // A REMOVAL BY SOMEBODY ELSE IS RECORDED HERE BEFORE ITS MLS COMMIT, and the commit is fanned out
    // from the device rows deleted just below - so the removed person's devices are named PARTING
    // first (`partingKey`): the commit declaring their removal is queued to them too. A self-leave
    // makes no commit, and gets no entry.
    //
    // WRITTEN BEFORE THE DELETE, because the rows it is derived from are gone after it: written
    // after, a crash in between lost it silently, and a retry found no rows to derive it from
    // (fourth review of #1878). Redis cannot join the Postgres transaction, so the order is what
    // makes it crash-safe. An entry for a removal that then fails is HARMLESS, and that is what
    // allows this order: it names devices that are still members, which the fan-out reaches as
    // members and never twice, and only a commit declaring this person's removal consumes it.
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (caller && caller !== safeUserId) {
      const partingDevices = await this.deviceGroupRepo.find({
        where: { groupId: safeGroupId, userId: safeUserId },
        select: { userId: true, deviceId: true },
      });
      if (partingDevices.length > 0) {
        const fields = partingDevices.flatMap((d) => [`${d.userId}:${d.deviceId}`, caller]);
        await this.redis
          .hset(partingKey(safeGroupId), ...fields)
          .catch((e: unknown) =>
            this.logger.warn(
              `[REMOVE_MEMBER] group=${safeGroupId.slice(0, 8)} user=${safeUserId.slice(0, 8)} parting devices NOT recorded - the removal commit will not reach them: ${String(e)}`
            )
          );
      }
    }

    // ONE TRANSACTION UNDER THE GROUP'S SEAT LOCK: the device rows, the Welcomes still queued for
    // them, the live row and the open interval go, and the eviction is RECORDED. Without the device
    // rows no application frame is queued for them and no frame they send is accepted; the interval
    // is what makes this removal hold against a later re-add (user, 2026-10-14); a Welcome left
    // behind would let the removed person enter the epoch it was built for
    // ({@link endDeviceMemberships}) - a self-leave makes no commit that would undo it; and the
    // eviction record keeps an external commit whose roster check ran before this removal from
    // writing its committer's seat after it (`utils/seat-eviction.ts`).
    //
    // THE ONE ORDER OF `utils/seat-eviction.ts`: the seat lock, the roster row, the queued
    // Welcomes, the device rows, the eviction record. `addGroupMember` writes device seats under the
    // same lock, shared, against a re-read of an ADMITTED roster row (`writePendingSeats`), so it is
    // wholly before this removal or finds no row. A Welcome store re-checks the seat
    // under the seat lock (`validateCommit`, `sendWelcome`), so a store racing this removal either
    // commits first and is deleted here, or finds no seat.
    const { devices, ended, generation, endedAsk } = await withSeatLock(
      this.dataSource.manager,
      safeGroupId,
      async (manager) => {
        // A seat still awaiting a member is an open ASK: its removal ends it, and every member's
        // screen must learn so. Read under the seat lock, before the row goes.
        const seat = await manager.getRepository(GroupMember).findOne({
          where: { groupId: safeGroupId, userId: safeUserId },
          select: { id: true, awaitingAdmission: true },
        });
        await bumpSeatGeneration(manager, safeGroupId);
        const closed = await endGroupMembership(manager, safeGroupId, safeUserId);
        const gone = await endDeviceMemberships(
          manager,
          { userId: safeUserId, groupId: safeGroupId },
          'welcomes'
        );
        const gen = await recordSeatEviction(manager, safeGroupId, safeUserId, false);
        return {
          devices: gone,
          ended: closed,
          generation: gen,
          endedAsk: seat?.awaitingAdmission === true && closed.deleted > 0 ? seat.id : null,
        };
      }
    );
    if (endedAsk !== null) {
      // The person withdrew their own ask, or a member removed it: committed, so it leaves every
      // online member's screen now. Started, not awaited.
      announceJoinAskSettled(
        this.dataSource.manager,
        this.redis,
        safeGroupId,
        [{ userId: safeUserId, askId: endedAsk }],
        caller === safeUserId ? 'withdrawn' : 'declined',
        caller ?? ''
      );
    }
    if (ended.deleted > 0 && ended.closed === 0) {
      // A member with no open interval: enrolled by a writer running pre-030 code during the deploy
      // that applied the migration. Their exclusion window starts nowhere, so a re-add will NOT
      // withhold what is sent from now on - which is exactly the loss this line exists to show.
      this.logger.error(
        `[REMOVE_MEMBER] group=${safeGroupId} user=${safeUserId} had NO open membership interval - this removal is not recorded as an exclusion`
      );
    }

    // Remove all devices of this user from the Redis set
    const members = await this.redis.smembers(`group:members:${safeGroupId}`);
    const toRemove = members.filter((m) => m.startsWith(`${safeUserId}:`));
    if (toRemove.length > 0) {
      await this.redis.srem(`group:members:${safeGroupId}`, ...toRemove);
    }

    this.logger.log(
      `[REMOVE_MEMBER] group=${safeGroupId} user=${safeUserId} redisRemoved=${toRemove.length} deviceMembershipsDeleted=${devices.memberships} intervalClosed=${ended.closed} queuedWelcomesDropped=${devices.queued} evictionGeneration=${generation}`
    );
    return { status: 'removed' };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups/:groupId/join-requests/:userId/decline')
  /**
   * A MEMBER DECLINES A PERSON WHO ASKED TO JOIN BY INVITATION LINK - never the removal above.
   *
   * The ask is the seat `awaitingAdmission`; the Decline withdraws it ({@link withdrawAwaitingSeat})
   * under the group's seat lock, ONLY while it still awaits a member. A member's Add lifts the flag
   * in its commit's transaction under the same lock, so an Add that came first (another member,
   * whose epoch this device has not processed yet) is answered `already-admitted` and nothing is
   * touched - the generic removal deleted that admitted person's seat and left their leaf with none.
   * No exclusion interval is recorded - the person was never in - but the Decline moves the group's
   * seat generation and records it, so an Add built before it enrols nobody after it (review of
   * #2419: `departed_since_base` at the commit gate).
   *
   * Every outcome is an ANSWER (200, `outcome`), so the client reads a type, never a status
   * sentence. The caller must be an ADMITTED member - a seat still awaiting a member decides nothing.
   */
  async declineJoinRequest(
    @Param('groupId') groupId: string,
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string
  ): Promise<{ outcome: AwaitingSeatWithdrawal }> {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    const standing = caller
      ? await callerSeatStanding(this.groupMemberRepo, safeGroupId, caller)
      : null;
    // A caller whose own seat still waits is a pending member, not a stranger: the 409 its client
    // reads as "wait", never the 403 it would retire the conversation on (its own ask included).
    if (caller && standing === 'awaiting') {
      throw refuseAwaitingSeat(
        this.logger,
        'JOIN_DECLINE',
        safeGroupId,
        caller,
        ` target=${cutUserId(safeUserId)}`
      );
    }
    if (!caller || standing !== 'admitted' || caller === safeUserId) {
      this.logger.warn(
        `[JOIN_DECLINE] REJECT group=${safeGroupId} caller=${caller ?? 'none'} target=${safeUserId} - not an admitted member, or their own ask`
      );
      throw new ForbiddenException(
        refusalBody(RefusalCode.NOT_A_MEMBER, 'Caller may not answer this ask')
      );
    }
    const { outcome, askId } = await withSeatLock(this.dataSource.manager, safeGroupId, (m) =>
      withdrawAwaitingSeat(m, safeGroupId, safeUserId, 'declined')
    );
    this.logger.log(
      `[JOIN_DECLINE] group=${safeGroupId} caller=${caller} target=${safeUserId} outcome=${outcome}`
    );
    // Committed: every other online member's ask settles on it now, not at its next sweep - started,
    // not awaited, so this answer does not wait on it.
    if (outcome === 'withdrawn' && askId !== null) {
      announceJoinAskSettled(
        this.dataSource.manager,
        this.redis,
        safeGroupId,
        [{ userId: safeUserId, askId }],
        'declined',
        caller
      );
    }
    return { outcome };
  }

  /**
   * The windows during which each CURRENT member of `groupId` was out of it - what a member
   * answering a history request must withhold (user, 2026-10-14: a Remove holds against a later
   * re-add).
   *
   * **EVERY CURRENT MEMBER, NOT ONLY THE ASKER.** A `history_bundle` is an MLS group broadcast: every
   * member decrypts it, whoever it is addressed to. Withholding a window from the asker alone would
   * hand it to a re-admitted member reading somebody else's answer, so the answering client
   * withholds the union of everybody's windows. Members with no window are omitted.
   *
   * **CURRENT MEMBERS ONLY MAY ASK**, and no branch lets anybody else through: no global-admin
   * bypass, and no unidentified caller (the legacy no-op of `assertCallerIsGroupMember` is not
   * copied). The answer names who was removed and when, which is group metadata only a member may
   * hold - and only a member answers history anyway.
   *
   * Times are server milliseconds from this service's clock, the clock that stamps
   * `queued_message.createdAt` - the `serverTimestamp` the client compares them with.
   *
   * **A CURRENT MEMBER WITH NO OPEN INTERVAL IS REPAIRED HERE, ONCE.** It can only be somebody
   * enrolled by a container still running pre-030 code while the migration was applied. The repair
   * opens the interval from the member row's own `joinedAt` - exactly what the migration's backfill
   * does - so the ERROR line that reports it fires on the call that heals it and never again, rather
   * than on every read for ever. It writes nothing for anybody already consistent.
   *
   * No line per answer: the decision this route feeds is made, and logged, by the client
   * (`[HISTORY_ENTITLEMENT]`). Only a refusal and a repair are events here.
   *
   * **TWO FIELDS** (user, 2026-10-21: a new member of a group conversation reads nothing from before
   * their arrival). `exclusions` is every counted person's gaps, the union a broadcast answer is
   * filtered on. `withheld` adds the span before arrival to ONE person's gaps ({@link
   * withheldWindows}), and it is read one person at a time: by the inviter for the invitee of a
   * history push (`?for=`), and by a receiver for itself. The span cannot join the union - it would
   * withhold everything older than the newest member, from everyone.
   *
   * **`withheld` names the caller and the `for` person only**, never the whole roster: nobody else's
   * arrival is needed. Each of them gets an entry when counted, an EMPTY one included, so a missing
   * key always means "not counted" and the client refuses to send on it rather than reading it as
   * "nothing withheld".
   *
   * **`for` answers only for a person with a device ADDED SINCE THE CALLER ARRIVED** - a device row
   * in this group created at or after the start of the caller's CURRENT interval (its recorded
   * admission when earlier; `for` compared case-insensitively). Not the caller's first arrival: a
   * member who left and came back did not witness what was added while they were out. That
   * is who an inviter's push is for: a newcomer, or a new device of a member of any age. It is a
   * DURABLE fact, never a status: the invitee's row turns `active` the moment its Welcome is
   * processed, possibly while the push is still reading its windows chunk by chunk, and a status
   * predicate then starved the push it was written for. The caller witnessed that add, so the
   * arrival it reads is one the group showed it. Anybody else has no entry: a member cannot read the
   * arrival of somebody whose devices all predate their own.
   *
   * **`addressedAnswers: true`** says this server routes an addressed history answer on a
   * conversation (step A, docs/wiki/protocols/history-answer-addressing.md). It rides this route
   * because every answerer reads it per chunk anyway: a client running ahead of an older server sees
   * the field missing and keeps the broadcast answer, rather than learning it by a refused send.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId/exclusions')
  async getGroupExclusions(
    @Param('groupId') groupId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Query('for') forUserId?: string
  ): Promise<{
    exclusions: Record<string, ExclusionWindow[]>;
    withheld: Record<string, ExclusionWindow[]>;
    addressedAnswers: true;
  }> {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    const forUser = sanitizeOptionalQueryValue(forUserId, 'for');
    // Every seat is COUNTED below, a waiting one included (a wider withholding, never a narrower
    // one); only an ADMITTED seat may ASK - a waiting one is a pending member, answered the 409.
    const standing = caller
      ? await callerSeatStanding(this.groupMemberRepo, safeGroupId, caller)
      : null;
    if (caller && standing === 'awaiting') {
      throw refuseAwaitingSeat(this.logger, 'GROUP_EXCLUSIONS', safeGroupId, caller);
    }
    const members = await this.groupMemberRepo.find({
      where: { groupId: safeGroupId },
      select: { userId: true, joinedAt: true },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    if (!caller || standing !== 'admitted') {
      this.logger.warn(
        `[GROUP_EXCLUSIONS] REFUSED group=${safeGroupId} caller=${caller ? caller.slice(0, 8) : 'unidentified'} - not a current member`
      );
      throw new ForbiddenException(
        refusalBody(RefusalCode.NOT_A_MEMBER, 'Caller is not a member of this group')
      );
    }

    // WHOSE WINDOWS COUNT: every roster member, AND every person holding a device row in the group,
    // WHATEVER ITS STATUS. The status enum is `pending | active` and both mean a device the tree
    // admitted: a re-add records the person's devices `pending` in the transaction that accepts the
    // commit (`ValidateCommitBody.admits`) - BEFORE their roster row exists, the enrolment following
    // the Welcome. In between they can open every frame sealed at the new epoch, so a roster-only
    // answer would hand them their own window. Their intervals then end closed, so the window reads as
    // open-ended until the enrolment closes it - wider, never narrower. Authorisation above stays
    // roster-only.
    //
    // DISTINCT users, not device rows: the answerer re-reads this route once per bundle CHUNK, and
    // what it costs is three indexed reads on `groupId` - the same order as the chunk's own send,
    // which inserts one queued row per recipient device.
    //
    // The earliest row per person is also the evidence `withheldWindows` reads for their arrival, and
    // the latest is what `for` is decided on.
    const admittedRows = await this.deviceGroupRepo
      .createQueryBuilder('d')
      .select('d.userId', 'userId')
      .addSelect('MIN(d.createdAt)', 'firstDeviceAt')
      .addSelect('MAX(d.createdAt)', 'lastDeviceAt')
      .where('d.groupId = :groupId', { groupId: safeGroupId })
      .groupBy('d.userId')
      .getRawMany<{
        userId: string;
        firstDeviceAt: Date | string | null;
        lastDeviceAt: Date | string | null;
      }>();
    const counted = new Set([...memberIds, ...admittedRows.map((r) => r.userId)]);
    const asDate = (v: Date | string | null): Date | null => (v ? new Date(v) : null);
    const firstDeviceAt = new Map(admittedRows.map((r) => [r.userId, asDate(r.firstDeviceAt)]));
    const lastDeviceAt = new Map(admittedRows.map((r) => [r.userId, asDate(r.lastDeviceAt)]));

    const readByUser = async () => {
      const rows = await this.dataSource.manager.find(GroupMembershipInterval, {
        where: { groupId: safeGroupId, userId: In([...counted]) },
        select: { userId: true, joinedAt: true, leftAt: true, admittedAt: true },
      });
      const grouped = new Map<string, GroupMembershipInterval[]>();
      for (const row of rows) {
        const list = grouped.get(row.userId) ?? [];
        list.push(row);
        grouped.set(row.userId, list);
      }
      return grouped;
    };
    let byUser = await readByUser();

    // Members outside every open interval - see the docstring. Repaired before the answer is built,
    // so the answer already carries the window between their last close and their arrival.
    const unopened = members
      .filter((m) => !(byUser.get(m.userId) ?? []).some((r) => r.leftAt === null))
      .map((m) => m.userId);
    if (unopened.length > 0) {
      const opened = await openMissingIntervals(this.dataSource.manager, safeGroupId, unopened);
      if (opened.length > 0) {
        this.logger.error(
          `[GROUP_EXCLUSIONS] group=${safeGroupId.slice(0, 8)} opened ${opened.length} missing interval(s) - member(s) enrolled by pre-030 code or by an interrupted enrolment; a window they were out for before that is not recorded`
        );
      }
      // Re-read rather than patch: a concurrent repair may have opened one instead, and a removal
      // may have closed it since - the table is the only answer to both.
      byUser = await readByUser();
    }

    // A group conversation withholds what precedes a person's arrival; a 1:1 does not (see
    // `withheldWindows`). A key group never reaches this route's consumers, and is read as a 1:1.
    const group = await this.groupRepo.findOne({
      where: { id: safeGroupId },
      select: {
        isGroup: true,
        distributionWorkspaceId: true,
        distributionChannelId: true,
        createdAt: true,
      },
    });
    if (!group) {
      // A roster with no group row: answered as a 1:1 (gaps only), which withholds nothing before
      // an arrival - so it is said, not swallowed.
      this.logger.warn(
        `[EXCLUSIONS] group=${safeGroupId} has members but NO group row - answered as a 1:1`
      );
    }
    const beforeFirstArrival =
      group?.isGroup === true && !group.distributionWorkspaceId && !group.distributionChannelId;

    const exclusions: Record<string, ExclusionWindow[]> = {};
    for (const userId of counted) {
      const windows = exclusionWindows(byUser.get(userId) ?? []);
      if (windows.length > 0) exclusions[userId] = windows;
    }
    const withheld: Record<string, ExclusionWindow[]> = {};
    // The caller's arrival for `for` is the start of their CURRENT stretch - the open interval, from
    // its recorded admission when one preceded the enrolment. Not their first arrival: a caller who
    // left and came back did not witness what was added while they were out. No open interval
    // answers `for` for nobody - including a caller with device rows but no open interval (admitted,
    // not yet enrolled): `for` answers nobody until their enrolment opens one, the safe direction.
    const current = (byUser.get(caller) ?? []).find((r) => r.leftAt === null);
    const callerArrival = current ? stretchStart(current) : Infinity;
    const forCounted = forUser
      ? [...counted].find(
          (u) =>
            u.toLowerCase() === forUser.toLowerCase() &&
            (lastDeviceAt.get(u)?.getTime() ?? -Infinity) >= callerArrival
        )
      : undefined;
    for (const userId of new Set([caller, ...(forCounted ? [forCounted] : [])])) {
      if (!counted.has(userId)) continue;
      // The group's own instant: the person who arrived with it has nothing before them to withhold.
      withheld[userId] = withheldWindows(
        byUser.get(userId) ?? [],
        beforeFirstArrival,
        firstDeviceAt.get(userId) ?? null,
        group?.createdAt ?? null
      );
    }
    return { exclusions, withheld, addressedAnswers: true };
  }
}
