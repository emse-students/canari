import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Inject,
  UseGuards,
  Headers,
  ForbiddenException,
  BadRequestException,
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
import { readPendingMembershipFacts } from '../utils/pending-membership-facts';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import {
  sanitizeQueryValue,
  sanitizeOptionalQueryValue,
  assertCallerOwnsUserId,
} from '../utils/sanitize';
import { RETENTION_WINDOW_MS } from '../retention.constants';
import { resolveUserDisplayNamesBatch } from '../utils/display-name';
import { isBlockedBetween } from '../utils/user-blocks';
import {
  ensureGroupMember,
  endGroupMembership,
  exclusionWindows,
  partingKey,
  type ExclusionWindow,
} from '../utils/group-membership';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';

/**
 * The most groups `POST /api/mls/group-rosters` answers in one request.
 *
 * MIRRORED BY `GROUP_ROSTERS_MAX_GROUPS` in `frontend/src/lib/mls-client/mlsDeliveryApi.ts`, which
 * chunks by it: a client must not learn a limit by being refused (the lesson of the history batch,
 * whose cap went unnoticed while every catch-up was refused). The production account the request
 * was sized on held 89 groups.
 */
export const GROUP_ROSTERS_MAX_GROUPS = 200;

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
   *  - it is already a member of the group - covers invites, welcome_request re-adds, and the
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
   */
  private async assertCallerMayMutateMembership(
    safeGroupId: string,
    targetUserId: string,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    allowCreationBootstrap: boolean
  ): Promise<void> {
    if (headerGlobalAdmin === 'true') return;
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (!caller) return;

    const callerMemberships = await this.groupMemberRepo.count({
      where: { groupId: safeGroupId, userId: caller },
    });
    if (callerMemberships > 0) return;

    // Group-creation bootstrap: the creator adds its own userId while the group is still empty.
    if (allowCreationBootstrap && caller === targetUserId) {
      const memberCount = await this.groupMemberRepo.count({
        where: { groupId: safeGroupId },
      });
      if (memberCount === 0) return;
    }

    throw new ForbiddenException('Caller is not authorized to modify this group membership');
  }

  /**
   * Authorizes a roster read on `safeGroupId`. The caller (nginx-injected, HMAC-bound `x-user-id`)
   * must be a platform global admin or an existing member of the group. Blocks roster enumeration
   * by non-members (audit S5): the user list and active-device list are group metadata that leak
   * social graph / device topology. Freshly-invited joiners are registered as members BEFORE their
   * Welcome, so recovery/re-invite reads still pass. No-op when `x-user-id` is absent (legacy
   * deployments without INTERNAL_SHARED_SECRET), matching `assertCallerOwnsUserId`.
   */
  private async assertCallerIsGroupMember(
    safeGroupId: string,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined
  ): Promise<void> {
    if (headerGlobalAdmin === 'true') return;
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (!caller) return;
    const callerMemberships = await this.groupMemberRepo.count({
      where: { groupId: safeGroupId, userId: caller },
    });
    if (callerMemberships > 0) return;
    throw new ForbiddenException('Caller is not a member of this group');
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
      activeGroups.map((g) => g.id)
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
   */
  private async readDeviceMemberships(
    userId: string,
    deviceId: string | undefined,
    groupIds: string[]
  ): Promise<
    Map<
      string,
      {
        status: 'pending' | 'active';
        welcomeQueued: boolean;
        addInFlight: boolean;
        admitted: boolean;
      }
    >
  > {
    const out = new Map<
      string,
      {
        status: 'pending' | 'active';
        welcomeQueued: boolean;
        addInFlight: boolean;
        admitted: boolean;
      }
    >();
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
      });
    }
    const stranded = [...out.entries()].filter(
      ([, v]) => v.status === 'pending' && !v.welcomeQueued && !v.addInFlight && !v.admitted
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
  /** Adds a member to a group and registers their device-group membership as pending. */
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
        code: 'KEY_DISTRIBUTION_GROUP',
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
        code: 'USER_BLOCKED',
        message: 'This person cannot be added.',
      });
    }

    this.logger.log(`[ADD_MEMBER][${traceId}] START group=${safeGroupId} user=${safeUserId}`);

    // Atomic upsert: INSERT ... ON CONFLICT DO UPDATE avoids the findOne+save race.
    // Window aligned with retention: a still-recoverable device (last seen < 90 days)
    // must receive a pending membership even if idle for > 30 days.
    const cutoff = new Date(Date.now() - RETENTION_WINDOW_MS);
    const userDevices = await this.keyPackageRepo.find({
      where: { userId: safeUserId, createdAt: MoreThanOrEqual(cutoff) },
    });

    await this.dataSource.transaction(async (manager) => {
      // Enrol at the user level, leaving an existing enrolment untouched - the same call the
      // invitation-link join makes, so the two writers of this table cannot disagree about what a
      // second call means. Until 2026-09-16 this one rewrote `joinedAt` on every call, which is why
      // no row of a 31-member production group carried that group's own creation minute.
      await ensureGroupMember(manager, safeGroupId, safeUserId);

      // Upsert DeviceGroupMembership for each active device: no-op if already present.
      for (const device of userDevices) {
        await manager
          .createQueryBuilder()
          .insert()
          .into(DeviceGroupMembership)
          .values({
            userId: safeUserId,
            deviceId: device.deviceId,
            groupId: safeGroupId,
            status: 'pending',
          })
          .orIgnore()
          .execute();
      }
    });

    // NB: NOT added to group:members Redis here - devices enter the routing
    // set only when their Welcome is sent (sendWelcome sets status to active).
    this.logger.log(
      `[ADD_MEMBER][${traceId}] DONE group=${safeGroupId} user=${safeUserId} devices=${userDevices.length}`
    );
    return { status: 'added' };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId/user-members')
  /** Returns user-level membership from dm_group_members (no device-status filter). */
  async getGroupUserMembers(
    @Param('groupId') groupId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    await this.assertCallerIsGroupMember(safeGroupId, headerUserId, headerGlobalAdmin);
    const rows = await this.groupMemberRepo.find({
      where: { groupId: safeGroupId },
      select: { userId: true },
    });
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const nameMap = await resolveUserDisplayNamesBatch(this.dataSource.manager, userIds);
    this.logger.log(`[GET_USER_MEMBERS] group=${safeGroupId} count=${rows.length}`);
    return rows.map((r) => ({
      userId: r.userId,
      displayName: nameMap.get(r.userId) ?? null,
    }));
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
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/group-rosters')
  async getGroupRosters(
    @Body() body: { groupIds?: unknown } | undefined,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{ rosters: Record<string, string[]>; refused: string[] }> {
    const requested = body?.groupIds;
    if (!Array.isArray(requested)) {
      throw new BadRequestException('groupIds must be an array');
    }
    if (requested.length > GROUP_ROSTERS_MAX_GROUPS) {
      throw new BadRequestException(`At most ${GROUP_ROSTERS_MAX_GROUPS} groups per request`);
    }
    const groupIds = [...new Set(requested.map((g) => sanitizeQueryValue(g, 'groupId')))];
    if (groupIds.length === 0) return { rosters: {}, refused: [] };

    const rows = await this.groupMemberRepo.find({
      where: { groupId: In(groupIds) },
      select: { groupId: true, userId: true },
    });
    const byGroup = new Map<string, Set<string>>();
    for (const row of rows) {
      const members = byGroup.get(row.groupId) ?? new Set<string>();
      members.add(row.userId);
      byGroup.set(row.groupId, members);
    }

    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    const unrestricted = headerGlobalAdmin === 'true';
    const rosters: Record<string, string[]> = {};
    const refused: string[] = [];
    for (const groupId of groupIds) {
      const members = byGroup.get(groupId) ?? new Set<string>();
      if (!unrestricted && (!caller || !members.has(caller))) {
        refused.push(groupId);
        continue;
      }
      rosters[groupId] = [...members];
    }
    this.logger.log(
      `[GROUP_ROSTERS] asked=${groupIds.length} answered=${groupIds.length - refused.length} refused=${refused.length} rows=${rows.length}`
    );
    return { rosters, refused };
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
      false
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

    // Remove all per-device memberships for this user in the group: from here on no application
    // frame is queued for them, and no frame they send is accepted.
    const deviceMembershipDelete = await this.deviceGroupRepo.delete({
      groupId: safeGroupId,
      userId: safeUserId,
    });

    // The live row goes and the membership interval closes in ONE transaction: the interval is what
    // makes this removal hold against a later re-add (user, 2026-10-14), so a removal that deleted
    // the row and not the interval would be a removal a re-add silently undoes.
    const ended = await this.dataSource.transaction((manager) =>
      endGroupMembership(manager, safeGroupId, safeUserId)
    );
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
      `[REMOVE_MEMBER] group=${safeGroupId} user=${safeUserId} redisRemoved=${toRemove.length} deviceMembershipsDeleted=${deviceMembershipDelete.affected ?? 0} intervalClosed=${ended.closed}`
    );
    return { status: 'removed' };
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
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId/exclusions')
  async getGroupExclusions(
    @Param('groupId') groupId: string,
    @Headers('x-user-id') headerUserId?: string
  ): Promise<{ exclusions: Record<string, ExclusionWindow[]> }> {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    const members = await this.groupMemberRepo.find({
      where: { groupId: safeGroupId },
      select: { userId: true, joinedAt: true },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    if (!caller || !memberIds.has(caller)) {
      this.logger.warn(
        `[GROUP_EXCLUSIONS] REFUSED group=${safeGroupId} caller=${caller ? caller.slice(0, 8) : 'unidentified'} - not a current member`
      );
      throw new ForbiddenException('Caller is not a member of this group');
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
    const admittedRows = await this.deviceGroupRepo
      .createQueryBuilder('d')
      .select('d.userId', 'userId')
      .distinct(true)
      .where('d.groupId = :groupId', { groupId: safeGroupId })
      .getRawMany<{ userId: string }>();
    const counted = new Set([...memberIds, ...admittedRows.map((r) => r.userId)]);

    const intervals = await this.dataSource.manager.find(GroupMembershipInterval, {
      where: { groupId: safeGroupId, userId: In([...counted]) },
      select: { userId: true, joinedAt: true, leftAt: true },
    });
    const byUser = new Map<string, GroupMembershipInterval[]>();
    for (const row of intervals) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }

    // Members outside every open interval - see the docstring. Repaired before the answer is built,
    // so the answer already carries the window between their last close and their arrival.
    const unopened = members.filter((m) => !(byUser.get(m.userId) ?? []).some((r) => !r.leftAt));
    if (unopened.length > 0) {
      await this.dataSource.manager
        .createQueryBuilder()
        .insert()
        .into(GroupMembershipInterval)
        .values(
          unopened.map((m) => ({
            groupId: safeGroupId,
            userId: m.userId,
            joinedAt: m.joinedAt,
            leftAt: null,
          }))
        )
        .orIgnore()
        .execute();
      for (const m of unopened) {
        const list = byUser.get(m.userId) ?? [];
        list.push({
          userId: m.userId,
          joinedAt: m.joinedAt,
          leftAt: null,
        } as GroupMembershipInterval);
        byUser.set(m.userId, list);
      }
      this.logger.error(
        `[GROUP_EXCLUSIONS] group=${safeGroupId.slice(0, 8)} opened ${unopened.length} missing interval(s) - member(s) enrolled by pre-030 code; a window they were out for before that is not recorded`
      );
    }

    const exclusions: Record<string, ExclusionWindow[]> = {};
    for (const userId of counted) {
      const windows = exclusionWindows(byUser.get(userId) ?? []);
      if (windows.length > 0) exclusions[userId] = windows;
    }
    return { exclusions };
  }
}
