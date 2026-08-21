import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Headers,
  BadRequestException,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { PushToken } from '../entities/push-token.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { Group } from '../entities/group.entity';
import { GroupMember } from '../entities/group-member.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { resolveGroupInvitePreview } from '../utils/group-invite';
import { MessagingService } from '../services/messaging.service';
import { RETENTION_WINDOW_MS } from '../retention.constants';

/**
 * Internal-only endpoints - called by other services via Docker-internal networking.
 * NOT exposed through Nginx.
 * Auth: X-Internal-Secret header matched against INTERNAL_SECRET env var.
 */
@Controller('internal')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);
  private readonly secret = process.env.INTERNAL_SECRET ?? '';

  constructor(
    @InjectRepository(PushToken)
    private readonly pushTokenRepo: Repository<PushToken>,
    @InjectRepository(KeyPackage)
    private readonly keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(OneTimeKeyPackage)
    private readonly otpRepo: Repository<OneTimeKeyPackage>,
    @InjectRepository(Group)
    private readonly groupRepo: Repository<Group>,
    @InjectRepository(GroupMember)
    private readonly groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(DeviceGroupMembership)
    private readonly deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(QueuedMessage)
    private readonly queuedMessageRepo: Repository<QueuedMessage>,
    @InjectRepository(PinVerifier)
    private readonly pinVerifierRepo: Repository<PinVerifier>,
    @InjectRepository(RevokedDevice)
    private readonly revokedDeviceRepo: Repository<RevokedDevice>,
    @InjectRepository(GroupInvite)
    private readonly groupInviteRepo: Repository<GroupInvite>,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
    private readonly messagingService: MessagingService
  ) {}

  /**
   * Refuses anything that is not a service-to-service call. Constant-time, and an unset
   * INTERNAL_SECRET matches nothing - so a misconfigured deployment fails closed.
   */
  private assertInternalSecret(headerSecret: string | undefined): void {
    const expected = Buffer.from(this.secret);
    const received = Buffer.from(headerSecret ?? '');
    if (
      expected.length === 0 ||
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException();
    }
  }

  /**
   * Session-free group invite preview, called by the web SSR process when it renders the Open
   * Graph head of `/g/join/:token`. The user-facing route is behind `HeaderAuthGuard` and an
   * unfurler has no session; both call one `resolveGroupInvitePreview`, so what a shared invite
   * link discloses is decided in a single place.
   */
  @Get('group-invites/:token')
  async groupInvitePreview(
    @Param('token') token: string,
    @Headers('x-internal-secret') headerSecret?: string
  ) {
    this.assertInternalSecret(headerSecret);
    this.logger.debug(`internal group invite preview token=${token.slice(0, 8)}`);
    return resolveGroupInvitePreview(this.groupInviteRepo, this.groupRepo, token);
  }

  /**
   * The one entry point every other service uses to push to a user (community channel messages
   * and their silent `channel_read` frames from `channel.service.ts`, posts and form reminders
   * from `push.service.ts`).
   *
   * IT DELEGATES RATHER THAN SENDING. It used to hold its own `getMessaging().send()` loop -
   * token lookup, invalid-token cleanup and all - which was the same send as
   * {@link MessagingService.sendPushToUser} MINUS the `apns` block. That difference is not a
   * detail: FCM turns a message with no `apns` block into a data-only push, which iOS never
   * surfaces and which never triggers the Notification Service Extension. So EVERY push this
   * endpoint carried - every salon message, every post, every form reminder, every cross-device
   * read frame - was silently dropped on the floor by every iPhone, while the same payload
   * notified Android correctly and the endpoint reported `sent`.
   *
   * Two copies of a send are two contracts, and only one of them was maintained.
   */
  @Post('push/notify')
  async notifyUser(
    @Headers('x-internal-secret') headerSecret: string,
    @Body()
    body: {
      userId: string;
      title: string;
      body: string;
      data?: Record<string, string>;
    }
  ) {
    this.assertInternalSecret(headerSecret);

    const { userId, title, body: notifBody, data = {} } = body;
    if (!userId || !title) {
      this.logger.warn(
        `[INTERNAL_PUSH] refused: userId=${userId ? 'set' : 'missing'} title=${title ? 'set' : 'missing'}`
      );
      return { sent: 0, failed: 0 };
    }

    const result = await this.messagingService.sendPushToUser(userId, title, notifBody, data);
    this.logger.log(
      `[INTERNAL_PUSH] type=${data.type ?? 'none'} user=${userId} sent=${result.sent} failed=${result.failed}`
    );
    return result;
  }

  /**
   * How many usable MLS devices a user has, for a service deciding whether a key DM could ever
   * reach them.
   *
   * THIS EXISTS BECAUSE A SERVICE MAY NOT CALL A USER ROUTE. `GET mls/devices/:userId` answers the
   * same question and sits behind `HeaderAuthGuard`, which wants `x-user-logged-in` and a
   * per-minute HMAC that only Nginx mints - headers a Docker-network call between two containers
   * does not have and must not forge. Social-service asked it anyway with nothing but
   * `X-Internal-Secret`, so the route answered 401 to every direct invitation, and the caller
   * turned that into a 503 the inviter read as "the key service is down". Which credential a route
   * accepts is part of its contract; a call that carries the wrong one is not a permission problem
   * to widen but a route that was never addressed to this caller.
   *
   * A COUNT, NOT THE DEVICES. The caller only ever compares against zero, and the user route hands
   * back every key package - material an internal caller has no use for and should not receive to
   * answer a yes-or-no question.
   *
   * THE SAME RETENTION WINDOW AS THE USER ROUTE, and it is not a detail: a device outside it is
   * dropped from new-group invites, so counting it would say a key DM can be delivered to someone
   * no group will ever add.
   */
  @Get('mls/devices/:userId/count')
  async userDeviceCount(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('userId') userId: string
  ): Promise<{ count: number }> {
    this.assertInternalSecret(headerSecret);
    const cutoff = new Date(Date.now() - RETENTION_WINDOW_MS);
    const count = await this.keyPackageRepo.count({
      where: { userId, createdAt: MoreThanOrEqual(cutoff) },
    });
    this.logger.log(`[INTERNAL_MLS_DEVICES] user=${userId.slice(0, 8)} count=${count}`);
    return { count };
  }

  /**
   * Creates - or returns, unchanged - a Graine key-distribution group for one scope.
   *
   * TWO SCOPES, ONE PATH. A community's group and a private salon's group are the same object with
   * a different roster: seeds only, never a conversation, entered by external commit, no
   * `dm_group_members` row and no `DeviceGroupMembership`. Those absences are load-bearing - see the
   * WP-20 audit in `docs/wiki/protocols/channel-encryption.md`, whose whole enumeration rests on
   * them - and duplicating this family per scope would double a surface that has been audited once.
   *
   * WHY THE ID AND NOT A NAME: each scope column carries a partial unique index, so "exactly one
   * distribution group per community" and "per private salon" are facts the DATABASE holds. A
   * second concurrent creation loses the insert instead of producing two groups each owning half
   * the seeds - which is why the conflict is re-read rather than reported.
   *
   * A PUBLIC SALON GETS NONE, and asking for one is a caller bug rather than a no-op: its audience
   * IS the community, so the community's group is already the right roster and a second group would
   * be the same set of people at a higher commit rate. Social-service is the only caller and it
   * gates on `isPrivate`; this route cannot check that itself, because it does not own `channels`.
   *
   * The MLS group itself is NOT created here and cannot be: the server holds no MLS state and can
   * derive none. This is the row; a client initialises the group and publishes its GroupInfo
   * through {@link publishDistributionGroupInfo}.
   */
  @Post('mls/distribution-groups')
  async createDistributionGroup(
    @Headers('x-internal-secret') headerSecret: string,
    @Body() body: { scope?: string; scopeId?: string }
  ): Promise<{ groupId: string; created: boolean }> {
    this.assertInternalSecret(headerSecret);
    const scope = this.assertDistributionScope(body?.scope);
    const scopeId = (body?.scopeId ?? '').trim();
    if (!scopeId) throw new BadRequestException('scopeId is required');
    const where = this.distributionWhere(scope, scopeId);
    const label = `${scope}:${scopeId}`;

    const existing = await this.groupRepo.findOne({ where });
    if (existing) {
      this.logger.log(`[DISTRIBUTION_GROUP] reuse scope=${label} group=${existing.id}`);
      return { groupId: existing.id, created: false };
    }

    try {
      const created = await this.groupRepo.save(this.groupRepo.create({ isGroup: true, ...where }));
      this.logger.log(`[DISTRIBUTION_GROUP] created scope=${label} group=${created.id}`);
      return { groupId: created.id, created: true };
    } catch (e) {
      // The unique index fired: another request created it between the SELECT and the INSERT. The
      // winner's row is the answer, so re-read rather than surfacing a conflict the caller cannot
      // act on. Anything else is a real failure and must propagate.
      const raced = await this.groupRepo.findOne({ where });
      if (!raced) throw e;
      this.logger.warn(
        `[DISTRIBUTION_GROUP] concurrent creation scope=${label} group=${raced.id} - the index held`
      );
      return { groupId: raced.id, created: false };
    }
  }

  /**
   * The scope's distribution group and the latest GroupInfo published on it, so a caller that has
   * already established the reader's right to it can hand a client what it needs to external-join.
   *
   * `groupInfo` is null until the first client has initialised the MLS group - a real state, not an
   * error: the community or salon exists and nobody has opened it yet.
   *
   * `memberDevices` answers ONE question and it is the client's only way to ask it: which of THIS
   * USER's devices does the group actually hold a membership row for. A client cannot work that out
   * for itself - it knows only that it once joined - and the two can disagree permanently. A revoke
   * deletes the leaver's rows here IMMEDIATELY (see `evictFromDistributionGroup`) while the MLS half,
   * removing their leaf, is committed later by a REMAINING member; the commit is therefore published
   * to a group the leaver is already unrouted from, so the leaver never learns of it and keeps a live
   * local group for a group it is no longer in. Re-granted, it then believes it is already a member,
   * never re-joins, and never gets its rows back - it is entitled and unreachable, for good. Answered
   * only when `userId` is given, because every other caller of this route is asking a different
   * question and should not pay for a query it will not read.
   */
  @Get('mls/distribution-groups/:scope/:scopeId')
  async getDistributionGroup(
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Headers('x-internal-secret') headerSecret: string,
    @Query('userId') userId?: string
  ): Promise<{
    groupId: string;
    groupInfo: string | null;
    baseEpoch: number | null;
    memberDevices?: string[];
  } | null> {
    this.assertInternalSecret(headerSecret);
    const where = this.distributionWhere(this.assertDistributionScope(scope), scopeId);
    const label = `${scope}:${scopeId}`;

    const group = await this.groupRepo.findOne({ where });
    if (!group) {
      this.logger.warn(`[DISTRIBUTION_GROUP] absent scope=${label}`);
      return null;
    }

    const info = await this.messagingService.readGroupInfo(group.id);

    // PENDING COUNTS. The question is "has this device's join been RECORDED", not "is it in sync":
    // a row in either state means the join happened and the fan-out will reach it, while NO row
    // means nothing here will ever deliver to it again. Treating `pending` as absent would send a
    // device that had just joined straight back through an external join it does not need.
    const asked = String(userId ?? '')
      .trim()
      .toLowerCase();
    const memberDevices = asked
      ? (
          await this.deviceGroupRepo.find({
            where: { groupId: group.id, userId: asked },
            select: { deviceId: true },
          })
        ).map((row) => row.deviceId)
      : undefined;

    this.logger.log(
      `[DISTRIBUTION_GROUP] read scope=${label} group=${group.id} published=${!!info}` +
        (asked ? ` user=${asked.slice(0, 8)} devices=${memberDevices?.length ?? 0}` : '')
    );
    return {
      groupId: group.id,
      groupInfo: info?.groupInfo ?? null,
      baseEpoch: info?.baseEpoch ?? null,
      ...(memberDevices ? { memberDevices } : {}),
    };
  }

  /**
   * Publishes the GroupInfo of a distribution group, after its committer's own service has
   * established that they belong to the scope's roster.
   *
   * The public route (`POST /mls/group-info/:groupId`) cannot serve this: it gates on a
   * `dm_group_members` row, and a distribution group has none by construction. The monotonic rule
   * is not duplicated here - both routes land on the same `putGroupInfo`.
   */
  @Post('mls/distribution-groups/:scope/:scopeId/group-info')
  async publishDistributionGroupInfo(
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Headers('x-internal-secret') headerSecret: string,
    @Body() body: { groupInfo?: string; baseEpoch?: number; userId?: string; deviceId?: string }
  ): Promise<{ stored: boolean }> {
    this.assertInternalSecret(headerSecret);
    if (typeof body?.groupInfo !== 'string' || !Number.isFinite(body?.baseEpoch)) {
      throw new BadRequestException('groupInfo (base64) and baseEpoch are required');
    }
    if (!body?.userId || !body?.deviceId) {
      throw new BadRequestException('userId and deviceId are required');
    }
    const where = this.distributionWhere(this.assertDistributionScope(scope), scopeId);
    const label = `${scope}:${scopeId}`;

    const group = await this.groupRepo.findOne({ where });
    if (!group) {
      throw new BadRequestException(`No distribution group for ${label}`);
    }

    const result = await this.messagingService.putGroupInfo(
      group.id,
      body.groupInfo,
      body.baseEpoch as number
    );

    // THE PUBLISHER JOINS THE DELIVERY ROSTER HERE, and this is the only place it can.
    //
    // A distribution group's roster is written by the commit fan-out, where the activating device
    // is the commit SENDER - so the device that CREATES the MLS group, which sends no commit, was
    // in no group's roster and received NOTHING on the group it had just made: not the next
    // member's external-join commit (so its epoch never moved, and every seed it sealed after that
    // was a past-epoch frame the new member could not read), and not their request for the missing
    // seed either (so the repair had nobody to answer it). A private salon with two members did not
    // work at all. Found on production 2026-08-20 by watching a real second member join one.
    //
    // Unconditional and idempotent: a device that external-joined already has its row, and the
    // upsert underneath makes a repeat free. `redeliverMissed: false` for the same reason the
    // external-join path passes it - the device holds the group at the CURRENT epoch, so there is
    // nothing earlier it could decrypt and a replay would be undecryptable frames and blank pushes.
    await this.messagingService.activateDeviceMembership(body.userId, body.deviceId, group.id, {
      redeliverMissed: false,
    });

    this.logger.log(
      `[DISTRIBUTION_GROUP] group-info scope=${label} group=${group.id} epoch=${body.baseEpoch} ` +
        `stored=${result.stored} publisher=${body.userId.slice(0, 8)}:${body.deviceId.slice(0, 12)}`
    );
    return result;
  }

  /**
   * Cuts one user off a distribution group, the moment they stop belonging to its roster.
   *
   * THE HALF OF A DEPARTURE THAT NEEDS NOBODY ONLINE. Removing their leaf from the MLS tree is a
   * commit, and only a member's device can produce one - so it happens whenever a remaining member
   * next loads the community or salon. Until then, nothing in the tree stops the delivery service
   * handing the leaver every seed frame sent on the group, because routing reads these rows and not
   * the tree. This is what makes the revocation immediate and server-enforced; the commit that
   * follows is what makes it cryptographic.
   *
   * Three stores, all keyed by the group, and none of them can stand in for the others: the
   * membership rows are what a reconnect reads, the Redis set is what a live fanout reads, and the
   * queue holds frames already sealed for a device that was offline. Leaving the queue would mean
   * handing the past over on the leaver's next connection.
   *
   * Idempotent by construction - every step is a delete keyed on the pair - so the caller may
   * repeat it, and a scope with no distribution group answers `{ evicted: false }` rather than
   * failing a departure that has otherwise completed.
   */
  @Delete('mls/distribution-groups/:scope/:scopeId/members/:userId')
  async evictFromDistributionGroup(
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Param('userId') userId: string,
    @Headers('x-internal-secret') headerSecret: string
  ): Promise<{ evicted: boolean; memberships: number; queued: number; routes: number }> {
    this.assertInternalSecret(headerSecret);
    const where = this.distributionWhere(this.assertDistributionScope(scope), scopeId);
    const label = `${scope}:${scopeId}`;

    const group = await this.groupRepo.findOne({ where });
    if (!group) {
      // A community created before Graine, a public salon, or a group already reaped. Not an error:
      // there is no key distribution to be cut off from.
      this.logger.log(
        `[DISTRIBUTION_GROUP] evict scope=${label} user=${userId.slice(0, 8)} - no group`
      );
      return { evicted: false, memberships: 0, queued: 0, routes: 0 };
    }

    const memberships = await this.deviceGroupRepo.delete({ groupId: group.id, userId });
    const queued = await this.queuedMessageRepo.delete({ groupId: group.id, recipientId: userId });

    const routed = await this.redis.smembers(`group:members:${group.id}`);
    const toRemove = routed.filter((m) => m.startsWith(`${userId}:`));
    if (toRemove.length > 0) {
      await this.redis.srem(`group:members:${group.id}`, ...toRemove);
    }

    this.logger.log(
      `[DISTRIBUTION_GROUP] evict scope=${label} group=${group.id} user=${userId.slice(0, 8)} ` +
        `memberships=${memberships.affected ?? 0} queued=${queued.affected ?? 0} routes=${toRemove.length}`
    );
    return {
      evicted: true,
      memberships: memberships.affected ?? 0,
      queued: queued.affected ?? 0,
      routes: toRemove.length,
    };
  }

  /**
   * Tombstones the distribution group of a scope that is going away - a community being deleted, or
   * a private salon deleted or turned public. Deliberately the same soft delete every other group
   * dies of, so `cleanupSoftDeletedGroups` reaps it on the same schedule and no second lifecycle
   * exists.
   */
  @Delete('mls/distribution-groups/:scope/:scopeId')
  async deleteDistributionGroup(
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Headers('x-internal-secret') headerSecret: string
  ): Promise<{ deleted: boolean }> {
    this.assertInternalSecret(headerSecret);
    const where = this.distributionWhere(this.assertDistributionScope(scope), scopeId);
    const label = `${scope}:${scopeId}`;

    const group = await this.groupRepo.findOne({ where });
    if (!group) {
      // Not an error: a community created before Graine, a public salon, or a group already reaped.
      this.logger.log(`[DISTRIBUTION_GROUP] delete scope=${label} - nothing to delete`);
      return { deleted: false };
    }

    // THE SCOPE IS RELEASED WITH THE SAME WRITE, and that is what makes a salon re-privatisable.
    // The scope columns carry a partial unique index that does NOT exclude tombstones, and
    // `deletedAt` is a plain column rather than a `@DeleteDateColumn`, so a tombstone left holding
    // its scope is found by the reuse read above: turning a salon public and private again handed
    // it back the group it had just retired, tombstone and all - a group `cleanupSoftDeletedGroups`
    // is counting down to reap. Clearing the scope makes the row an ordinary dead group, reaped on
    // the same schedule, and leaves the scope genuinely unoccupied.
    await this.groupRepo.update(
      { id: group.id },
      { deletedAt: new Date(), distributionWorkspaceId: null, distributionChannelId: null }
    );
    this.logger.log(
      `[DISTRIBUTION_GROUP] deleted scope=${label} group=${group.id} - scope released`
    );
    return { deleted: true };
  }

  /**
   * The `where` clause selecting one scope's distribution group.
   *
   * Written once because five routes need it and because the two columns are mutually exclusive by
   * a database CHECK (migration 018) - a clause built per call site is a clause that will one day
   * name both.
   */
  private distributionWhere(
    scope: 'workspace' | 'channel',
    scopeId: string
  ): { distributionWorkspaceId: string } | { distributionChannelId: string } {
    return scope === 'workspace'
      ? { distributionWorkspaceId: scopeId }
      : { distributionChannelId: scopeId };
  }

  /**
   * Rejects a scope this service has no column for, rather than silently selecting the community
   * one - which would serve a private salon's caller the community's group, i.e. exactly the
   * sharing this scope was added to end.
   */
  private assertDistributionScope(scope: string | undefined): 'workspace' | 'channel' {
    if (scope !== 'workspace' && scope !== 'channel') {
      throw new BadRequestException(`scope must be 'workspace' or 'channel', got '${scope ?? ''}'`);
    }
    return scope;
  }

  /**
   * Deletes all MLS/device/conversation data for the given user.
   *
   * - 1-on-1 DMs (isGroup=false): group is fully deleted (soft-delete + hard-delete all data).
   * - Multi-member groups (isGroup=true): user is removed from the group; the group itself
   *   and other members' data are preserved.
   * - Redis group:members sets are cleaned for both cases.
   * - History streams (history:{groupId}) are deleted only for DMs.
   *
   * Called by core-service during account deletion - not exposed through Nginx.
   */
  @Delete('users/:userId')
  async deleteUserData(
    @Param('userId') userId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    this.assertInternalSecret(headerSecret);

    this.logger.log(`[INTERNAL_DELETE] starting user=${userId}`);

    // Resolve all groups this user belongs to before deleting membership rows
    const memberships = await this.groupMemberRepo.find({ where: { userId } });
    const groupIds = memberships.map((m) => m.groupId);

    if (groupIds.length > 0) {
      const groups = await this.groupRepo.findBy({ id: In(groupIds) });

      const dmGroups = groups.filter((g) => !g.isGroup);
      const multiGroups = groups.filter((g) => g.isGroup);

      // ── DMs: delete the entire group ─────────────────────────────────────
      await Promise.all(
        dmGroups.map(async (g) => {
          // Soft-delete the group row (tombstone so devices can detect deletion)
          await this.groupRepo.update({ id: g.id }, { deletedAt: new Date() });
          // Hard-delete all operational data for the DM
          await Promise.all([
            this.groupMemberRepo.delete({ groupId: g.id }),
            this.deviceGroupRepo.delete({ groupId: g.id }),
            this.queuedMessageRepo.delete({ groupId: g.id }),
            this.redis.del(`group:members:${g.id}`),
            this.redis.del(`history:${g.id}`),
          ]);
          this.logger.log(`[INTERNAL_DELETE] DM deleted groupId=${g.id}`);
        })
      );

      // ── Multi-member groups: remove user from Redis membership sets ───────
      const deviceIds = await this.keyPackageRepo
        .find({ where: { userId }, select: { deviceId: true } })
        .then((kps) => kps.map((kp) => kp.deviceId));

      await Promise.all(
        multiGroups.map(async (g) => {
          if (deviceIds.length > 0) {
            const members = deviceIds.map((d) => `${userId}:${d}`);
            await this.redis.srem(`group:members:${g.id}`, ...members);
          }
          this.logger.log(`[INTERNAL_DELETE] removed from group groupId=${g.id}`);
        })
      );
    }

    // ── User's own records ────────────────────────────────────────────────
    await Promise.all([
      this.keyPackageRepo.delete({ userId }),
      this.otpRepo.delete({ userId }),
      // DM groupMember rows already deleted above; this cleans multi-group rows
      this.groupMemberRepo.delete({ userId }),
      this.deviceGroupRepo.delete({ userId }),
      this.queuedMessageRepo.delete({ recipientId: userId }),
      this.pushTokenRepo.delete({ userId }),
      this.pinVerifierRepo.delete({ userId }),
      this.revokedDeviceRepo.delete({ userId }),
    ]);

    this.logger.log(`[INTERNAL_DELETE] done user=${userId}`);
    return { ok: true };
  }
}
