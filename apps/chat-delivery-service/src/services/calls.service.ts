import {
  Injectable,
  Logger,
  ForbiddenException,
  ServiceUnavailableException,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { GroupMember } from '../entities/group-member.entity';
import { PushToken } from '../entities/push-token.entity';
import * as jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';
import { getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { ApnsVoipService } from './apns-voip.service';
import { resolveUserDisplayName } from '../utils/display-name';

/** ICE server entry returned to WebRTC clients. */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Response shape for `GET /api/calls/ice-servers`. */
export interface IceServersResponse {
  iceServers: IceServerConfig[];
}

/** Response shape for `POST /api/calls/initiate`. */
export interface InitiateCallResponse {
  /** UUID identifying the WebRTC room in call-service. */
  roomId: string;
  /** Short-lived JWT (5 min) proving this user is allowed to join `roomId`. */
  roomToken: string;
}

/** Stored in Redis while a user device is actively in a call. */
export interface UserCallPresence {
  deviceId: string;
  callId?: string;
  groupId?: string;
  updatedAt: number;
}

/** Response shape for `GET /api/calls/sibling-status`. */
export interface SiblingCallStatusResponse {
  active: boolean;
  deviceId?: string;
  callId?: string;
  groupId?: string;
}

const USER_CALL_PRESENCE_TTL_SEC = 2 * 60 * 60;
/** Retain the monthly TURN-usage counter ~45 days so a slow month rollover never loses it early. */
const TURN_USAGE_TTL_SEC = 45 * 24 * 60 * 60;
/** Hard cap on counted call duration so a stale presence record can't inflate the estimate. */
const MAX_COUNTED_CALL_SEC = 4 * 60 * 60;

function userCallPresenceKey(userId: string): string {
  return `call:user_active:${userId}`;
}

/** Monthly bucket (e.g. `turn:usage:2026-06`) accumulating estimated relayed megabytes. */
function monthlyTurnUsageKey(now: Date = new Date()): string {
  return `turn:usage:${now.toISOString().slice(0, 7)}`;
}

/**
 * Mints short-lived TURN credentials via Cloudflare Calls.
 * Returns HTTP 503 when Cloudflare credentials are not configured.
 */
@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    @InjectRepository(GroupMember)
    private readonly groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(PushToken)
    private readonly pushTokenRepo: Repository<PushToken>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly apnsVoip: ApnsVoipService
  ) {}

  /**
   * Verifies group membership, generates a UUID room ID, and returns a signed
   * room access token (TTL 5 min). The token must be sent to call-service in the
   * `Join` message to prove the user is authorized for this room.
   */
  async initiateCall(userId: string, groupId: string): Promise<InitiateCallResponse> {
    this.logger.debug(`[calls] initiateCall user=${userId} group=${groupId}`);

    const membership = await this.groupMemberRepo.findOne({
      where: { groupId, userId },
    });
    if (!membership) {
      this.logger.warn(`[calls] user ${userId} is not a member of group ${groupId}`);
      throw new ForbiddenException('Not a member of this group');
    }

    const roomSecret = process.env.CALL_ROOM_SECRET?.trim();
    if (!roomSecret) {
      this.logger.error('[calls] CALL_ROOM_SECRET is not set - cannot issue room tokens');
      throw new ServiceUnavailableException('Call room tokens are not configured on this server');
    }

    const roomId = uuidv4();
    const roomToken = jwt.sign({ room_id: roomId, sub: userId, group_id: groupId }, roomSecret, {
      expiresIn: '5m',
      algorithm: 'HS256',
    });

    this.logger.debug(`[calls] Issued room token for user=${userId} room=${roomId}`);
    return { roomId, roomToken };
  }

  /**
   * Issues a room access token for an existing room ID (used by call recipients).
   * Verifies group membership before signing the token.
   */
  async requestRoomToken(
    userId: string,
    groupId: string,
    roomId: string
  ): Promise<{ roomToken: string }> {
    this.logger.debug(`[calls] requestRoomToken user=${userId} group=${groupId} room=${roomId}`);

    const membership = await this.groupMemberRepo.findOne({
      where: { groupId, userId },
    });
    if (!membership) {
      this.logger.warn(`[calls] user ${userId} is not a member of group ${groupId}`);
      throw new ForbiddenException('Not a member of this group');
    }

    const roomSecret = process.env.CALL_ROOM_SECRET?.trim();
    if (!roomSecret) {
      throw new ServiceUnavailableException('Call room tokens are not configured on this server');
    }

    const roomToken = jwt.sign({ room_id: roomId, sub: userId, group_id: groupId }, roomSecret, {
      expiresIn: '5m',
      algorithm: 'HS256',
    });

    this.logger.debug(`[calls] Issued join token for user=${userId} room=${roomId}`);
    return { roomToken };
  }

  /**
   * Returns ICE server configuration for an authenticated group member.
   * Requires a valid `callId` so credentials are scoped per call session.
   */
  async getIceServers(
    userId: string,
    groupId: string,
    callId: string
  ): Promise<IceServersResponse> {
    this.logger.debug(`[ICE] getIceServers user=${userId} group=${groupId} call=${callId}`);

    const membership = await this.groupMemberRepo.findOne({
      where: { groupId, userId },
    });

    if (!membership) {
      this.logger.warn(`[ICE] user ${userId} is not a member of group ${groupId}`);
      throw new ForbiddenException('Not a member of this group');
    }

    const cloudflareToken = process.env.CLOUDFLARE_CALLS_API_TOKEN?.trim();
    const turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();

    if (!cloudflareToken || !turnKeyId) {
      this.logger.error(
        '[ICE] Cloudflare TURN is not configured (CLOUDFLARE_CALLS_API_TOKEN and CLOUDFLARE_TURN_KEY_ID required)'
      );
      throw new ServiceUnavailableException('WebRTC TURN is not configured on this server');
    }

    // Refuse new TURN credentials once the monthly relay budget is reached, so we
    // never exceed Cloudflare's free tier and incur overage. All call media is
    // relay-only (the SFU has no public media path), so every call counts.
    const budgetMb = this.turnBudgetGb() * 1000;
    const usedMb = await this.getMonthlyTurnUsageMb();
    if (usedMb >= budgetMb) {
      this.logger.error(
        `[ICE] Monthly TURN budget reached (${usedMb.toFixed(0)}/${budgetMb} MB) - refusing credentials`
      );
      throw new ServiceUnavailableException(
        'Monthly call quota reached on this server. Try again next month.'
      );
    }

    return this.fetchCloudflareIceServers(turnKeyId, cloudflareToken);
  }

  /** Monthly TURN relay budget in GB (Cloudflare free tier is ~1000 GB; default leaves a margin). */
  private turnBudgetGb(): number {
    const v = parseInt(process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB || '950', 10);
    return Number.isFinite(v) && v > 0 ? v : 950;
  }

  /** Conservative per-device relay bitrate (kbps, up+down) used to estimate usage. */
  private relayKbpsPerDevice(): number {
    const v = parseInt(process.env.CALL_RELAY_KBPS_PER_DEVICE || '3000', 10);
    return Number.isFinite(v) && v > 0 ? v : 3000;
  }

  /** Estimated relayed MB accumulated this month (0 when unset). */
  private async getMonthlyTurnUsageMb(): Promise<number> {
    const raw = await this.redis.get(monthlyTurnUsageKey());
    const v = raw ? parseFloat(raw) : 0;
    return Number.isFinite(v) ? v : 0;
  }

  /**
   * Adds a call's estimated relayed traffic to the monthly counter. Estimated from
   * the device's call duration × a conservative per-device bitrate (we can't read
   * Cloudflare's exact byte count, so we overestimate to stay safely under budget).
   */
  private async accumulateTurnUsage(callStartMs: number): Promise<void> {
    if (!callStartMs) return;
    const durationSec = Math.min(
      Math.max(0, (Date.now() - callStartMs) / 1000),
      MAX_COUNTED_CALL_SEC
    );
    if (durationSec < 1) return;
    const mb = (this.relayKbpsPerDevice() * durationSec) / 8000;
    const key = monthlyTurnUsageKey();
    await this.redis.incrbyfloat(key, mb);
    await this.redis.expire(key, TURN_USAGE_TTL_SEC);
    this.logger.debug(`[ICE] TURN usage +${mb.toFixed(1)} MB (call ${Math.round(durationSec)}s)`);
  }

  /**
   * Records whether this device is currently in an active call (Redis, per user).
   * Used so sibling devices can warn the user on app open.
   */
  async reportCallPresence(
    userId: string,
    deviceId: string,
    body: { active: boolean; callId?: string; groupId?: string }
  ): Promise<{ ok: true }> {
    if (!deviceId?.trim()) {
      throw new BadRequestException('deviceId is required');
    }

    const key = userCallPresenceKey(userId);

    if (!body.active) {
      const raw = await this.redis.get(key);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as UserCallPresence;
          if (parsed.deviceId === deviceId) {
            await this.accumulateTurnUsage(parsed.updatedAt);
            await this.redis.del(key);
            this.logger.debug(`[calls] cleared presence for user=${userId} device=${deviceId}`);
          }
        } catch {
          await this.redis.del(key);
        }
      }
      return { ok: true };
    }

    const payload: UserCallPresence = {
      deviceId,
      callId: body.callId,
      groupId: body.groupId,
      updatedAt: Date.now(),
    };
    await this.redis.set(key, JSON.stringify(payload), 'EX', USER_CALL_PRESENCE_TTL_SEC);
    this.logger.debug(
      `[calls] presence active user=${userId} device=${deviceId} call=${body.callId ?? '?'}`
    );
    return { ok: true };
  }

  /**
   * Returns whether another device of the same user is currently in a call.
   */
  async getSiblingCallStatus(userId: string, deviceId: string): Promise<SiblingCallStatusResponse> {
    if (!deviceId?.trim()) {
      throw new BadRequestException('deviceId is required');
    }

    const raw = await this.redis.get(userCallPresenceKey(userId));
    if (!raw) return { active: false };

    try {
      const parsed = JSON.parse(raw) as UserCallPresence;
      if (!parsed.deviceId || parsed.deviceId === deviceId) {
        return { active: false };
      }
      return {
        active: true,
        deviceId: parsed.deviceId,
        callId: parsed.callId,
        groupId: parsed.groupId,
      };
    } catch {
      return { active: false };
    }
  }

  /** Calls Cloudflare Realtime TURN API to generate short-lived credentials. */
  private async fetchCloudflareIceServers(
    turnKeyId: string,
    apiToken: string
  ): Promise<IceServersResponse> {
    const ttl = parseInt(process.env.CLOUDFLARE_TURN_TTL_SECONDS || '7200', 10);
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${turnKeyId}/credentials/generate-ice-servers`;

    this.logger.debug(`[ICE] Requesting Cloudflare TURN credentials (ttl=${ttl})`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `[ICE] Cloudflare TURN API error status=${response.status} body=${body.slice(0, 200)}`
      );
      throw new ServiceUnavailableException('Failed to generate TURN credentials');
    }

    const data = (await response.json()) as { iceServers?: IceServerConfig[] };
    const iceServers = this.filterIceServers(data.iceServers ?? []);

    if (iceServers.length === 0) {
      this.logger.error('[ICE] Cloudflare returned no usable ICE servers');
      throw new ServiceUnavailableException('No ICE servers available');
    }

    this.logger.debug(`[ICE] Cloudflare returned ${iceServers.length} ICE server(s)`);
    return { iceServers };
  }

  // --- Incoming-call ring fan-out (WP-XP-5 priority notifications) ----------
  //
  // The server cannot read MLS ciphertexts, so it cannot tell a call invite from a
  // regular message. The CALLER's client therefore triggers the ring explicitly with a
  // minimal cleartext payload (callId/groupId/caller display name - the same metadata
  // level as the senderName/groupName already present on every message push). The MLS
  // CallMsg protos themselves are sent silent; visible ringing on killed devices comes
  // exclusively from this fan-out.

  /**
   * Rings every OTHER member of the group about an incoming call:
   *  - Android tokens -> high-priority FCM data push `type=call_ring` (native CallStyle
   *    notification, instant - no MLS decrypt on the ring path).
   *  - iOS tokens WITH a voipToken -> direct APNs VoIP push (CallKit full-screen ring).
   *  - iOS tokens WITHOUT a voipToken (pre-WP-XP-5 builds) -> regular FCM alert push so
   *    the callee at least sees a banner.
   * Best-effort per device; failures never abort the fan-out.
   */
  async ringGroup(
    callerId: string,
    groupId: string,
    callId: string,
    hasVideo: boolean
  ): Promise<{ rang: number }> {
    this.logger.debug(`[ring] ringGroup caller=${callerId} group=${groupId} call=${callId}`);
    await this.assertMembership(callerId, groupId, 'ring');

    const members = await this.groupMemberRepo.find({ where: { groupId }, select: { userId: true } });
    const calleeIds = [...new Set(members.map((m) => m.userId))].filter((id) => id !== callerId);
    if (calleeIds.length === 0) return { rang: 0 };

    const callerName = await resolveUserDisplayName(this.groupMemberRepo.manager, callerId);
    const groupName = await this.resolveGroupName(groupId);
    const tokens = await this.pushTokenRepo.find({ where: { userId: In(calleeIds) } });

    const dataFields: Record<string, string> = {
      type: 'call_ring',
      groupId,
      callId,
      callerId,
      // senderName/groupName aliases keep pre-WP-XP-5 Android builds showing a generic
      // "message from X" notification instead of nothing (they ignore unknown types).
      callerName,
      senderName: callerName,
      groupName,
      hasVideo: hasVideo ? 'true' : 'false',
    };

    let rang = 0;
    for (const pt of tokens) {
      const delivered =
        pt.platform === 'ios' && pt.voipToken
          ? await this.ringIosVoip(pt, dataFields)
          : await this.ringViaFcm(pt, dataFields, callerName, groupName);
      if (delivered) rang++;
    }
    this.logger.log(`[ring] call=${callId} group=${groupId} rang=${rang}/${tokens.length} devices`);
    return { rang };
  }

  /**
   * Stops the ring on every member device (caller cancelled, someone answered, or the
   * call ended). Sent to ALL members including the sender's own user so sibling devices
   * stop ringing too; the device that is already in the call ignores its own callId.
   */
  async endRing(
    userId: string,
    groupId: string,
    callId: string,
    reason: 'cancelled' | 'answered' | 'ended'
  ): Promise<{ notified: number }> {
    this.logger.debug(`[ring] endRing user=${userId} group=${groupId} call=${callId} reason=${reason}`);
    await this.assertMembership(userId, groupId, 'ring-end');

    const members = await this.groupMemberRepo.find({ where: { groupId }, select: { userId: true } });
    const memberIds = [...new Set(members.map((m) => m.userId))];
    if (memberIds.length === 0) return { notified: 0 };
    const tokens = await this.pushTokenRepo.find({ where: { userId: In(memberIds) } });

    const dataFields: Record<string, string> = {
      type: 'call_ring_end',
      groupId,
      callId,
      reason,
    };

    let notified = 0;
    for (const pt of tokens) {
      // Ring-end is a pure state signal: background/data push on both platforms. An iOS
      // device ringing via CallKit was just launched by the VoIP push, so its running
      // process receives this and reports the call ended; a missed delivery is covered
      // by the local 60s ring timeout on every platform.
      if (getApps().length === 0) break;
      try {
        await getMessaging().send({
          token: pt.token,
          data: dataFields,
          android: { priority: 'high', ttl: 60_000 },
          apns: {
            payload: { aps: { 'content-available': 1 }, ...dataFields },
            headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
          },
        });
        notified++;
      } catch (e) {
        await this.dropTokenIfGone(pt, e, 'ring-end');
      }
    }
    this.logger.log(`[ring] ring-end call=${callId} notified=${notified}/${tokens.length}`);
    return { notified };
  }

  /** Membership guard shared by the ring endpoints. */
  private async assertMembership(userId: string, groupId: string, scope: string): Promise<void> {
    const membership = await this.groupMemberRepo.findOne({ where: { groupId, userId } });
    if (!membership) {
      this.logger.warn(`[${scope}] user ${userId} is not a member of group ${groupId}`);
      throw new ForbiddenException('Not a member of this group');
    }
  }

  /** Group display name ('' for DMs, matching the message-push convention). */
  private async resolveGroupName(groupId: string): Promise<string> {
    try {
      const rows: { name: string | null; isGroup: boolean }[] =
        await this.groupMemberRepo.manager.query(
          `SELECT "name", "isGroup" FROM dm_groups WHERE id = $1 LIMIT 1`,
          [groupId]
        );
      return rows[0]?.isGroup ? (rows[0]?.name ?? '') : '';
    } catch {
      return '';
    }
  }

  /** Direct APNs VoIP push -> CallKit ring. Clears the voipToken on APNs 410. */
  private async ringIosVoip(pt: PushToken, dataFields: Record<string, string>): Promise<boolean> {
    const result = await this.apnsVoip.sendVoipPush(pt.voipToken as string, dataFields);
    if (result === 'gone') {
      await this.pushTokenRepo.update({ id: pt.id }, { voipToken: null });
      this.logger.warn(`[ring] cleared expired voipToken user=${pt.userId} device=${pt.deviceId}`);
      return false;
    }
    return result;
  }

  /**
   * FCM ring delivery: Android gets the data payload (native CallStyle notification);
   * legacy iOS (no voipToken) gets a visible alert banner built by FCM's APNs relay.
   */
  private async ringViaFcm(
    pt: PushToken,
    dataFields: Record<string, string>,
    callerName: string,
    groupName: string
  ): Promise<boolean> {
    if (getApps().length === 0) return false;
    try {
      await getMessaging().send({
        token: pt.token,
        data: dataFields,
        android: { priority: 'high', ttl: 60_000 },
        apns: {
          payload: {
            aps: {
              alert: {
                title: callerName || 'Canari',
                body: groupName ? `\u{1f4de} Appel entrant - ${groupName}` : '\u{1f4de} Appel entrant',
              },
              sound: 'default',
              'mutable-content': 1,
            },
            ...dataFields,
          },
          headers: { 'apns-push-type': 'alert', 'apns-priority': '10' },
        },
      });
      return true;
    } catch (e) {
      await this.dropTokenIfGone(pt, e, 'ring');
      return false;
    }
  }

  /** Deletes the push token row on terminal FCM errors (unregistered/invalid). */
  private async dropTokenIfGone(pt: PushToken, e: unknown, scope: string): Promise<void> {
    const msg = String(e);
    if (msg.includes('registration-token-not-registered') || msg.includes('invalid-argument')) {
      await this.pushTokenRepo.delete({ id: pt.id });
      this.logger.warn(`[${scope}] deleted invalid push token user=${pt.userId} device=${pt.deviceId}`);
    } else {
      this.logger.warn(`[${scope}] FCM failed user=${pt.userId} device=${pt.deviceId} err=${msg}`);
    }
  }

  /**
   * Filters out TURN URLs on port 53 (blocked by browsers per Cloudflare docs).
   */
  private filterIceServers(servers: IceServerConfig[]): IceServerConfig[] {
    return servers
      .map((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        const filtered = urls.filter((u) => !/:53(\?|$)/.test(u));
        if (filtered.length === 0) return null;
        return {
          ...server,
          urls: filtered.length === 1 ? filtered[0] : filtered,
        };
      })
      .filter((s): s is IceServerConfig => s !== null);
  }
}
