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
  HttpCode,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThanOrEqual, Repository } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { PushToken } from '../entities/push-token.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { Group } from '../entities/group.entity';
import { GroupMember } from '../entities/group-member.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { DeviceSignatureKey } from '../entities/device-signature-key.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { DELETED_ACCOUNT } from '../utils/account-erasure-coverage';
import { resolveGroupInvitePreview } from '../utils/group-invite';
import { ADMITTED_SEAT } from '../utils/group-membership';
import { sanitizeIdentityValue, sanitizeQueryValue } from '../utils/sanitize';
import { parseSessionId } from '../utils/session-id';
import {
  markErasedDms,
  purgeErasedDmKeys,
  removeRoutesOfUser,
  tombstoneGroups,
  totalGroupOwnedRows,
} from '../utils/group-purge';
import { MessagingService, type ActivationOutcome } from '../services/messaging.service';
import { isEntitledToDistributionGroup } from '../internal/distribution-entitlement';
import { RETENTION_WINDOW_MS } from '../retention.constants';
import { parsePresenceAudienceBody } from '../utils/presence-audience';

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
    @InjectRepository(GroupMembershipInterval)
    private readonly membershipIntervalRepo: Repository<GroupMembershipInterval>,
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
   *
   * `inline` is the group of fields that ride together or not at all (a salon message's ciphertext
   * and its seed frame), sized per device by `sendPushToUser`. A caller that sends none keeps
   * sending everything in `data`, exactly as before.
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
      inline?: Record<string, string>;
    }
  ) {
    this.assertInternalSecret(headerSecret);

    const { userId, title, body: notifBody, data = {}, inline = {} } = body;
    if (!userId || !title) {
      this.logger.warn(
        `[INTERNAL_PUSH] refused: userId=${userId ? 'set' : 'missing'} title=${title ? 'set' : 'missing'}`
      );
      return { sent: 0, failed: 0 };
    }

    const result = await this.messagingService.sendPushToUser(
      userId,
      title,
      notifBody,
      data,
      inline
    );
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
   * Which session a device's push registration is bound to - the first half of the compare-and-
   * delete core-service's outbox (`SessionPushEndService`) runs when a session that named this
   * device ends. core-service reads the binding HERE, then decides whether that session is still
   * live, then deletes only if the row still names what it read: a liveness check taken before the
   * read could miss a session that signed in and registered in between.
   */
  @Get('push/users/:userId/devices/:deviceId')
  async readDevicePushBinding(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('userId') userIdRaw: string,
    @Param('deviceId') deviceIdRaw: string
  ): Promise<{ registered: boolean; sessionId: string | null }> {
    this.assertInternalSecret(headerSecret);
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const deviceId = sanitizeQueryValue(deviceIdRaw, 'deviceId');
    const row = await this.pushTokenRepo.findOne({
      where: { userId, deviceId },
      select: { id: true, sessionId: true },
    });
    this.logger.debug(
      `[PUSH_SESSION_END] binding read user=${userId.slice(0, 8)} device=${deviceId} ` +
        `registered=${!!row} session=${row?.sessionId?.slice(0, 8) ?? 'none'}`
    );
    return { registered: !!row, sessionId: row?.sessionId ?? null };
  }

  /**
   * Ends the push registrations an ended SESSION leaves behind - called by core-service's outbox
   * (`SessionPushEndService`) for every session it deletes deliberately: the logout, an owner
   * revoking a device, "sign out everywhere else", and a refresh-token replay.
   *
   * THE SERVER HALF OF "A SIGN-OUT ENDS THE DEVICE'S PUSH REGISTRATION". The device deletes its own
   * token too (`push_registration.rs`), and each half stands alone: this one holds for a device that
   * is offline, uninstalled or never runs its sign-out, the device's for a call that never arrives
   * here. Deleting the row removes the destination AND the push secret on it, so the background
   * paths authenticated by that secret (`refresh-token`, `fetch-proto`, ...) are refused from here on
   * - `refresh-token` only ever UPDATES a row, so it cannot bring one back.
   *
   * Two deletes, each exact:
   * - BY SESSION, always: the row `sessionId` registered (migration 037), whichever device it is on -
   *   a session that registered before it ever named its device is covered too. A re-sign-in's
   *   registration rewrote the row with its own session and is never reached.
   * - THE DEVICE'S STALE ROW, when `device` and `ifBoundTo` are given: the row of that device, only
   *   if it is still bound to exactly what core-service read through `readDevicePushBinding` and
   *   judged not live (`none` = NULL, a row written before rows named a session). A registration
   *   written since the read changed the binding, so the compare fails and nothing goes.
   *
   * Idempotent: an answer of `removed: 0` is the ordinary second call, and a success. 2xx only when
   * the deletes ran, so the caller's retry stops on the truth; a 400 is an address no retry can fix.
   */
  @Delete('push/users/:userId/sessions/:sessionId')
  async endSessionPushRegistration(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('userId') userIdRaw: string,
    @Param('sessionId') sessionIdRaw: string,
    @Query('device') deviceRaw: string | undefined,
    @Query('ifBoundTo') ifBoundToRaw: string | undefined
  ): Promise<{ removed: number }> {
    this.assertInternalSecret(headerSecret);
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const sessionId = parseSessionId(sessionIdRaw, 'sessionId');
    if (!sessionId) throw new BadRequestException('sessionId is required');
    const deviceId = deviceRaw === undefined ? null : sanitizeQueryValue(deviceRaw, 'device');
    if ((deviceId === null) !== (ifBoundToRaw === undefined)) {
      throw new BadRequestException('device and ifBoundTo go together');
    }
    const ifBoundTo =
      ifBoundToRaw === undefined || ifBoundToRaw === 'none'
        ? null
        : parseSessionId(ifBoundToRaw, 'ifBoundTo');

    const bySession = await this.pushTokenRepo.delete({ userId, sessionId });
    let stale = 0;
    if (deviceId !== null) {
      const res = await this.pushTokenRepo.delete({
        userId,
        deviceId,
        sessionId: ifBoundTo === null ? IsNull() : ifBoundTo,
      });
      stale = res.affected ?? 0;
    }
    const removed = (bySession.affected ?? 0) + stale;
    this.logger.log(
      `[PUSH_SESSION_END] user=${userId.slice(0, 8)} session=${sessionId.slice(0, 8)} ` +
        `device=${deviceId ?? 'unnamed'} ifBoundTo=${ifBoundToRaw ?? 'n/a'} ` +
        `removedBySession=${bySession.affected ?? 0} removedStale=${stale}`
    );
    return { removed };
  }

  /**
   * Which of `userIds` share at least one live conversation (DM or group) with `viewerId` - half of
   * the presence audience the gateway enforces on `GET /api/presence` (WP-PRESENCE, decided by the
   * user 2026-10-18). The other half, the communities, is social-service's
   * `POST /internal/presence/shared-communities`; each service answers about the tables it owns.
   *
   * `dm_group_members` is the authority (a row per person per conversation, hard-deleted on leave),
   * so a key-distribution group - which has no such row - can never widen the audience. Only an
   * ADMITTED seat counts, on either side ({@link ADMITTED_SEAT}). A tombstoned
   * conversation (`deletedAt` set) no longer counts: its members stopped sharing it.
   *
   * Answers the SUBSET, lowercased like every stored id. The viewer is never in it: "may I see
   * myself" is the gateway's decision, not a membership question.
   *
   * The viewer lookup (`WHERE "userId" = viewer`) rides `IDX_dm_group_members_user` (migration
   * 031); the unique (`groupId`, `userId`) cannot serve it.
   */
  @Post('presence/shared-conversations')
  @HttpCode(200)
  async presenceSharedConversations(
    @Headers('x-internal-secret') headerSecret: string,
    @Body() body: { viewerId?: unknown; userIds?: unknown }
  ): Promise<{ userIds: string[] }> {
    this.assertInternalSecret(headerSecret);
    const { viewerId, userIds } = parsePresenceAudienceBody(body);
    const targets = userIds.filter((id) => id !== viewerId);
    if (targets.length === 0) return { userIds: [] };

    // ADMITTED SEATS ONLY, BOTH WAYS (review of #2358, F1): a seat an invitation link wrote, that no
    // member has admitted yet, shares nothing - its holder may not see the members' presence, nor
    // they its holder's, until a member's Add lets them in.
    const viewerRows = await this.groupMemberRepo.find({
      where: { userId: viewerId, ...ADMITTED_SEAT },
      select: { groupId: true },
    });
    const viewerGroupIds = [...new Set(viewerRows.map((r) => r.groupId))];
    if (viewerGroupIds.length === 0) {
      this.logger.debug(`[PRESENCE_AUDIENCE] viewer=${viewerId.slice(0, 8)} has no conversation`);
      return { userIds: [] };
    }
    const liveGroups = await this.groupRepo.find({
      where: { id: In(viewerGroupIds), deletedAt: IsNull() },
      select: { id: true },
    });
    if (liveGroups.length === 0) return { userIds: [] };
    const shared = await this.groupMemberRepo.find({
      where: { groupId: In(liveGroups.map((g) => g.id)), userId: In(targets), ...ADMITTED_SEAT },
      select: { userId: true },
    });
    const visible = new Set(shared.map((r) => r.userId));
    const answer = targets.filter((id) => visible.has(id));
    this.logger.debug(
      `[PRESENCE_AUDIENCE] viewer=${viewerId.slice(0, 8)} asked=${targets.length} shared=${answer.length}`
    );
    return { userIds: answer };
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
    activeEpoch: number;
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

    // `published` ALONE WAS A LIE THE CLIENT ACTED ON. It answered "is there a base", never "is
    // that base usable", and a base behind `activeEpoch` is refused by the commit gate every time
    // (see {@link MessagingService.readGroupInfo}). Both epochs travel to the client so it can tell
    // the two apart instead of discovering it through a rejected commit.
    this.logger.log(
      `[DISTRIBUTION_GROUP] read scope=${label} group=${group.id} published=${!!info}` +
        ` base=${info?.baseEpoch ?? 'none'} active=${group.activeEpoch}` +
        (asked ? ` user=${asked.slice(0, 8)} devices=${memberDevices?.length ?? 0}` : '')
    );
    return {
      groupId: group.id,
      groupInfo: info?.groupInfo ?? null,
      baseEpoch: info?.baseEpoch ?? null,
      activeEpoch: group.activeEpoch,
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
  ): Promise<{ stored: boolean; publisherActive: boolean }> {
    this.assertInternalSecret(headerSecret);
    if (typeof body?.groupInfo !== 'string' || !Number.isFinite(body?.baseEpoch)) {
      throw new BadRequestException('groupInfo (base64) and baseEpoch are required');
    }
    if (!body?.userId || !body?.deviceId) {
      throw new BadRequestException('userId and deviceId are required');
    }
    // STORED AS A MEMBERSHIP BELOW, so they are sanitized as identities rather than checked for
    // truthiness. This door handed both fields to the one writer untouched - not even the shape
    // allowlist every other door applies.
    const publisherUserId = sanitizeIdentityValue(body.userId, 'userId');
    const publisherDeviceId = sanitizeIdentityValue(body.deviceId, 'deviceId');
    const kind = this.assertDistributionScope(scope);
    const where = this.distributionWhere(kind, scopeId);
    const label = `${scope}:${scopeId}`;

    const group = await this.groupRepo.findOne({ where });
    if (!group) {
      throw new BadRequestException(`No distribution group for ${label}`);
    }

    // THE PUBLISHER'S SEAT IS WRITTEN AGAINST A CLAIM, like an external committer's: the claim is
    // read first, then the entitlement is asked here - after the claim, never under a lock - and the
    // seat is written under the seat lock only if no eviction overtook the claim. Social-service's
    // own check came before this request, so it cannot stand in for one made after the claim.
    // Unanswered is a retryable 503 before anything is stored, the gate's rule.
    const claim = await this.messagingService.claimSeat(group.id, publisherUserId);
    const entitled = await isEntitledToDistributionGroup(
      { kind, id: scopeId },
      publisherUserId,
      `publish-${group.id}`
    );

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
    // upsert underneath makes a repeat free.
    //
    // THE REFUSAL IS CARRIED, NOT THROWN AND NOT DROPPED. The GroupInfo is already stored above, so
    // a 400 here would report a failure that did not happen and invite a retry of work that
    // succeeded. But dropping it is what this door did, and the refusal matters more here than at
    // most doors: the publisher is the only device that can serve this group's first Welcome, so
    // one the writer will not route to leaves the group with nobody to answer - the 2026-08-20
    // defect above, reached by a different road. So it goes back in the answer, the way this
    // endpoint's siblings carry their counts, and `tag` puts this door's name on the warn line.
    const outcome: ActivationOutcome = entitled
      ? await this.messagingService.activateDeviceMembership(
          publisherUserId,
          publisherDeviceId,
          group.id,
          { tag: 'DISTRIBUTION_PUBLISHER', authority: 'distribution_publisher', claim }
        )
      : { ok: false, reason: 'not_on_roster' };
    if (!entitled) {
      this.logger.warn(
        `[DISTRIBUTION_PUBLISHER] REFUSED group=${group.id} ` +
          `device=${publisherUserId.slice(0, 8)}:${publisherDeviceId.slice(0, 12)} reason=not_entitled`
      );
    }

    this.logger.log(
      `[DISTRIBUTION_GROUP] group-info scope=${label} group=${group.id} epoch=${body.baseEpoch} ` +
        `stored=${result.stored} publisherActive=${outcome.ok}` +
        `${outcome.ok ? '' : ` (${outcome.reason})`} ` +
        `publisher=${publisherUserId.slice(0, 8)}:${publisherDeviceId.slice(0, 12)}`
    );
    return { ...result, publisherActive: outcome.ok };
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
   *
   * THE EVICTION IS RECORDED (`dm_seat_evictions`, {@link recordSeatEviction}) under the group's
   * seat lock, so a seat claimed before it is never written after it. Social-service calls this
   * twice per departure: before its roster write (`phase` absent), which BEGINS a departure and
   * answers its name (`groupId` + `departure`) for social-service to record in the roster write's
   * transaction; and after it (`phase=after_roster_write&departure=<name>`), which settles that
   * departure. A second call that never arrives is settled by
   * {@link MessagingService.drainOwedSeatEvictions}, which asks social-service for the outcome of
   * that name.
   */
  @Delete('mls/distribution-groups/:scope/:scopeId/members/:userId')
  async evictFromDistributionGroup(
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Param('userId') userId: string,
    @Headers('x-internal-secret') headerSecret: string,
    @Query('phase') phase?: string,
    @Query('departure') departureParam?: string
  ): Promise<{
    evicted: boolean;
    memberships: number;
    queued: number;
    routes: number;
    groupId?: string;
    departure?: number;
  }> {
    this.assertInternalSecret(headerSecret);
    const where = this.distributionWhere(this.assertDistributionScope(scope), scopeId);
    const label = `${scope}:${scopeId}`;
    if (phase !== undefined && phase !== 'after_roster_write') {
      throw new BadRequestException('phase must be absent or after_roster_write');
    }
    const departureSettled = phase === 'after_roster_write';
    const settles = Number(departureParam);
    const named = departureParam !== undefined && Number.isInteger(settles) && settles >= 1;
    if (departureSettled ? !named : departureParam !== undefined) {
      throw new BadRequestException(
        'departure (a positive integer) is required with phase=after_roster_write, and only with it'
      );
    }

    const group = await this.groupRepo.findOne({ where });
    if (!group) {
      // A community created before Graine, a public salon, or a group already reaped. Not an error:
      // there is no key distribution to be cut off from.
      this.logger.log(
        `[DISTRIBUTION_GROUP] evict scope=${label} user=${userId.slice(0, 8)} - no group`
      );
      return { evicted: false, memberships: 0, queued: 0, routes: 0 };
    }

    // UNDER THE SEAT LOCK, so a seat activation for this user runs wholly before this (and its row
    // is deleted here) or wholly after (and finds its claim overtaken). See `utils/seat-eviction.ts`.
    const { memberships, queued, toRemove, generation, settled } =
      await this.messagingService.evictSeats(
        group.id,
        userId,
        departureSettled ? { settles } : 'begin'
      );

    this.logger.log(
      `[DISTRIBUTION_GROUP] evict scope=${label} group=${group.id} user=${userId.slice(0, 8)} ` +
        (departureSettled
          ? `phase=after_roster_write departure=${settles} settled=${settled} `
          : `phase=before_roster_write departure=${generation} `) +
        `generation=${generation} memberships=${memberships} queued=${queued} routes=${toRemove}`
    );
    return {
      evicted: true,
      memberships,
      queued,
      routes: toRemove,
      ...(departureSettled ? {} : { groupId: group.id, departure: generation }),
    };
  }

  /**
   * Settles a departure social-service abandoned before its roster write committed - recorded
   * `cancelled` there, so it can never commit under that name
   * ({@link MessagingService.settleCancelledDeparture}). Social-service calls this from the error
   * path of the departure; the hourly drain settles any it could not reach.
   */
  @Post('mls/distribution-groups/:scope/:scopeId/members/:userId/departures/:departure/cancel')
  async cancelDistributionDeparture(
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Param('userId') userId: string,
    @Param('departure') departureParam: string,
    @Headers('x-internal-secret') headerSecret: string
  ): Promise<{ settled: boolean }> {
    this.assertInternalSecret(headerSecret);
    const where = this.distributionWhere(this.assertDistributionScope(scope), scopeId);
    const departure = Number(departureParam);
    if (!Number.isInteger(departure) || departure < 1) {
      throw new BadRequestException('departure must be a positive integer');
    }
    const group = await this.groupRepo.findOne({ where });
    if (!group) {
      this.logger.log(
        `[DISTRIBUTION_GROUP] cancel departure scope=${scope}:${scopeId} user=${userId.slice(0, 8)} ` +
          `departure=${departure} - no group`
      );
      return { settled: false };
    }
    const settled = await this.messagingService.settleCancelledDeparture(
      group.id,
      userId,
      departure
    );
    return { settled };
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

    // A GROUP THAT ENDS HERE ENDS THE SAME WAY IT ENDS EVERYWHERE ELSE - {@link tombstoneGroups} -
    // and this route's one difference travels as a flag rather than as a second implementation.
    // This route used to write the tombstone alone, sweeping nothing: no members, no device
    // memberships, no queued frames, no Redis keys, permanent until the 90-day reaper because the
    // orphan sweep only finds groups with NO row. Measured on prod 2026-08-21: seven
    // `queued_message` rows for W1's own device, addressed to a community distribution group
    // tombstoned five hours earlier and redelivered on every connection since, each one a frame the
    // device can neither decrypt nor ACK.
    //
    // THE SCOPE IS RELEASED WITH THE SAME WRITE, and that is what makes a salon re-privatisable: the
    // scope columns carry a partial unique index that does NOT exclude tombstones, so a tombstone
    // left holding its scope is found by the reuse read above, handing a re-privatised salon back
    // the group it had just retired.
    const counts = await tombstoneGroups(this.groupRepo.manager, this.redis, [group.id], {
      releaseDistributionScope: true,
    });
    this.logger.log(
      `[DISTRIBUTION_GROUP] deleted scope=${label} group=${group.id} - scope released, ` +
        `${totalGroupOwnedRows(counts)} row(s) purged: ${JSON.stringify(counts)}`
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
   * Deletes all MLS/device/conversation data for the given user - the chat-delivery half of an
   * account erasure, driven by core-service's durable erasure queue (`account-erasure.service.ts`).
   *
   * IDEMPOTENT, BECAUSE THE QUEUE RETRIES IT UNTIL IT ANSWERS 2xx AND RUNS IT AGAIN ONCE EVERY TOKEN
   * THE ACCOUNT HELD HAS EXPIRED. Nothing here reads a row a previous run deleted in order to find
   * what else to delete: the Redis routing sets are cleaned by PREFIX from every group the account
   * is still recorded in, never from a device list read off the key packages (which an interrupted
   * first run had already deleted, so the retry used to clean nothing).
   *
   * - 1-on-1 DMs (isGroup=false): group is fully deleted (soft-delete + hard-delete all data).
   * - Multi-member groups (isGroup=true): user is removed from the group; the group itself
   *   and other members' data are preserved.
   * - Queued APPLICATION messages the account sent are deleted; queued handshake frames (commits,
   *   Welcomes) are not, because they are the other members' protocol state and leave the queue
   *   when delivered - deleting a pending commit would fork the group for its recipient.
   *
   * What is covered, table by table, is `ACCOUNT_ERASURE_COVERAGE` and its spec.
   *
   * Called by core-service during account deletion - not exposed through Nginx.
   */
  @Delete('users/:userId')
  async deleteUserData(
    @Param('userId') userId: string,
    @Headers('x-internal-secret') headerSecret: string
  ) {
    this.assertInternalSecret(headerSecret);

    const who = userId.slice(0, 8);
    this.logger.log(`[INTERNAL_DELETE] starting user=${who}`);
    const manager = this.groupRepo.manager;

    // THE KEY PACKAGES GO FIRST, AND ALONE. Every writer that admits a device into a group reads its
    // key package `FOR SHARE` under the group's seat lock (`heldKeyPackages`), so this delete waits
    // for every such writer holding one, and a writer after it finds none and writes nothing: the
    // discovery below reads every row they wrote. ONE KNOWN EXCEPTION (`heldKeyPackages` names it):
    // the demotion, which only updates a row that exists. What this does NOT stop is the account itself
    // bringing a key package back - every (re)connection republishes it (`register-device`), and
    // nothing refuses a token issued before the deletion for up to an hour. That is why the run
    // ends with a sweep (below), and why termination is the FINAL PASS's, never this ordering's:
    // core calls this route once more after every token the account held expired
    // (`credentialsExpireAt`), and in that pass nothing can republish, so this delete holds.
    // Nothing is deleted by reading something an earlier step deleted, so a run interrupted at any
    // point leaves every row it had not cut still there for the retry.
    const keyPackages = await manager.getRepository(KeyPackage).delete({ userId });

    // Every group the account is still recorded in, through EITHER membership table - a Graine
    // distribution group carries device memberships and no `dm_group_members` row - or through an
    // eviction row: an account mid-departure holds no seat, and its row is about to go, so only
    // the group's own generation, moved by the cut below, still refuses a claim it took before.
    const [memberships, deviceMemberships, evictions] = await Promise.all([
      this.groupMemberRepo.find({ where: { userId } }),
      this.deviceGroupRepo.find({ where: { userId }, select: { groupId: true } }),
      this.groupRepo.manager.query(`SELECT "groupId" FROM dm_seat_evictions WHERE "userId" = $1`, [
        userId,
      ]) as Promise<Array<{ groupId: string }>>,
    ]);
    const groupIds = [
      ...new Set([...memberships, ...deviceMemberships, ...evictions].map((m) => m.groupId)),
    ];

    if (groupIds.length > 0) {
      const groups = await this.groupRepo.findBy({ id: In(groupIds) });

      const dmGroups = groups.filter((g) => !g.isGroup);
      const multiGroups = groups.filter((g) => g.isGroup);

      // ── DMs: delete the entire group ─────────────────────────────────────
      // ONE UNIT OF WORK FOR EVERY DM AT ONCE, through {@link tombstoneGroups}. This branch used to
      // name three tables by hand and left `mls_commit_log`, `mls_group_info`, `group_invites` and
      // `user_dismissed_groups` behind; the tombstone rows survive on purpose, so the orphan sweep -
      // which only finds groups with no row - could never collect them. Batched rather than one
      // transaction per DM: `Promise.all` over transactions opens N connections to do what one
      // statement per table does. The tombstones are what let the OTHER party's device detect the
      // deletion rather than infer it, and that party's dismissal markers are their own fact.
      if (dmGroups.length > 0) {
        const dmIds = dmGroups.map((g) => g.id);
        // NAMED FIRST, in the account's erasure marker: the tombstone deletes every row that names
        // these DMs for the account and commits before their Redis keys go, so a run that dies in
        // between leaves keys only the marker still names ({@link purgeErasedDmKeys}, below).
        await markErasedDms(this.redis, userId, dmIds);
        const counts = await tombstoneGroups(this.groupRepo.manager, this.redis, dmIds);
        this.logger.log(
          `[INTERNAL_DELETE] ${dmIds.length} DM(s) deleted, ` +
            `${totalGroupOwnedRows(counts)} row(s) purged: ${JSON.stringify(counts)} - ` +
            dmIds.join(', ')
        );
      }

      // ── Every other group: every seat of this account, per group, UNDER ITS SEAT LOCK ──
      // The group's seat generation moves, then the queue, the device rows and the routes (by
      // prefix) go together ({@link MessagingService.eraseSeats}): a claim or a route read taken
      // before this waits for it, then is refused or finds no row - so a retry never leaves one.
      // A group with no `dm_groups` row any more (an orphan the sweep has not reached) is cut the
      // same way: its device rows are what name it, so they go with its routes, never before them.
      const tombstoned = new Set(dmGroups.map((g) => g.id));
      const cut = groupIds.filter((id) => !tombstoned.has(id));
      let routes = 0;
      for (const groupId of cut) {
        routes += (await this.messagingService.eraseSeats(groupId, userId)).toRemove;
      }
      this.logger.log(
        `[INTERNAL_DELETE] removed from ${multiGroups.length} group(s) ` +
          `(+${cut.length - multiGroups.length} with no group row) user=${who} routes=${routes}`
      );
    }

    // ── The roster goes before the sweep ──
    // A device registration writes `pending` seats only where its owner is ON the roster
    // (`writePendingSeats`), so once these rows are gone a republished key package re-seats nothing
    // by itself. Every group they named was cut above (a DM's went with its tombstone), so a run
    // stopped after this leaves no group that only a roster row still named uncut: its generation
    // already moved. An invite accepted meanwhile writes its own roster row, which the final pass's
    // discovery reads.
    await this.groupMemberRepo.delete({ userId });

    // ── The sweep: what a key package republished during this run let in ──
    // A device that reconnected since the first delete (a token still valid, so never in the final
    // pass) brought its key package back, and a writer may have admitted it into a group, routes
    // included. Its key package goes AGAIN - waiting, as the first delete did, for every writer
    // holding it - and every group a device row names NOW is cut through the same seat-locked
    // eviction as above ({@link MessagingService.eraseSeats}), rows and routes together. A key
    // package republished after THIS delete is the final pass's: that pass starts once no token can
    // act as the account, so no republish can follow it.
    const lateKeyPackages = await manager.getRepository(KeyPackage).delete({ userId });
    const lateRows = await this.deviceGroupRepo.find({
      where: { userId },
      select: { groupId: true },
    });
    const lateGroups = [...new Set(lateRows.map((r) => r.groupId))];
    let lateRoutes = 0;
    for (const groupId of lateGroups) {
      lateRoutes += (await this.messagingService.eraseSeats(groupId, userId)).toRemove;
    }
    if ((lateKeyPackages.affected ?? 0) > 0 || lateGroups.length > 0) {
      this.logger.warn(
        `[INTERNAL_DELETE] user=${who} republished ${lateKeyPackages.affected ?? 0} key package(s) ` +
          `during the erasure; ${lateGroups.length} group(s) cut again, routes=${lateRoutes} - ` +
          `a device still holding a valid token; the final pass is what this cannot outrun`
      );
    }

    // ── Every route of the account, wherever it still stands ──
    // Read off the routing sets themselves, not off a row: a run that died after a 1:1 DM's
    // tombstone committed and before its Redis keys went left a route no row names, which this
    // retry's discovery cannot reach. A seat admitted after the sweep's read loses its route here
    // too; its row stays for the final pass, and a route restored from it meanwhile
    // (`restoreRoutes`) is that pass's to cut.
    const strayRoutes = await removeRoutesOfUser(this.redis, userId);
    if (strayRoutes.routes > 0) {
      this.logger.warn(
        `[INTERNAL_DELETE] user=${who} ${strayRoutes.routes} route(s) in ${strayRoutes.sets} set(s) ` +
          `outlived the cuts above and were removed by prefix - a run interrupted after a tombstone, ` +
          `or a seat admitted after the sweep's read`
      );
    } else {
      this.logger.log(`[INTERNAL_DELETE] user=${who} no route left in any routing set`);
    }

    // ── Every Redis key of the DMs this erasure tombstoned, this run's or an interrupted one's ──
    // Named by the account's erasure marker, never by a row: on a retry after a run died between a
    // DM's tombstone and its keys, no row names that DM any more. The marker goes last.
    const markedDms = await purgeErasedDmKeys(this.redis, userId);
    this.logger.log(
      `[INTERNAL_DELETE] user=${who} Redis keys of ${markedDms} tombstoned DM(s) deleted, marker cleared`
    );

    // ── User's own records ────────────────────────────────────────────────
    // Everything still queued FOR the account, a frame with no group included. NO DEVICE ROW IS
    // DELETED HERE: only `eraseSeats` deletes one, under the seat lock, with its queue and its route.
    // A row of a seat admitted after the sweep's read is left standing for the final pass's
    // discovery (its route went with the prefix sweep above), which cuts it with any route restored
    // from it meanwhile. The one row that
    // can follow THAT pass is the demotion's (`deactivateDeviceMembership`, the stale-device cron
    // among its callers, the one writer that inserts without reading the key package): `pending`,
    // its route removed by the demotion itself, and naming a device with no key package, which
    // `cleanupStaleDevices` collects.
    const queuedFor = await this.queuedMessageRepo.delete({ recipientId: userId });
    const leftRows = await this.deviceGroupRepo.count({ where: { userId } });
    if (leftRows > 0) {
      this.logger.warn(
        `[INTERNAL_DELETE] ${leftRows} device row(s) of user=${who} written after the sweep's read, ` +
          `left for the final pass to cut - a device re-admitted or demoted meanwhile`
      );
    }
    const [, sentQueued] = (await manager.query(
      `DELETE FROM queued_message
        WHERE "senderId" = $1 AND "isCommit" IS NOT TRUE AND "isWelcome" IS NOT TRUE`,
      [userId]
    )) as [unknown[], number];
    await Promise.all([
      this.otpRepo.delete({ userId }),
      // The account's membership history goes with it: nothing will ever answer for this person.
      this.membershipIntervalRepo.delete({ userId }),
      this.pushTokenRepo.delete({ userId }),
      this.pinVerifierRepo.delete({ userId }),
      this.revokedDeviceRepo.delete({ userId }),
      manager.delete(DeviceSignatureKey, { userId }),
      manager.delete(NotificationPreference, { userId }),
      manager.delete(UserDismissedGroup, { userId }),
      // The account's eviction records: what refuses a claim it took before this erasure is the
      // group's generation the cut above moved, never these rows (`utils/seat-eviction.ts`).
      manager.query(`DELETE FROM dm_seat_evictions WHERE "userId" = $1`, [userId]),
      // An invite link the account minted keeps working for the group; only the name goes.
      this.groupInviteRepo.update({ createdBy: userId }, { createdBy: DELETED_ACCOUNT }),
    ]);

    this.logger.log(
      `[INTERNAL_DELETE] done user=${who} sentQueued=${sentQueued} ` +
        `deviceRowsLeft=${leftRows} queuedFor=${queuedFor.affected ?? 0} ` +
        `keyPackages=${keyPackages.affected ?? 0} lateKeyPackages=${lateKeyPackages.affected ?? 0}`
    );
    return { ok: true };
  }
}
