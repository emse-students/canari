import {
  Injectable,
  Logger,
  ForbiddenException,
  ServiceUnavailableException,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GroupMember } from '../entities/group-member.entity';
import * as jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';

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
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  /**
   * Verifies group membership, generates a UUID room ID, and returns a signed
   * room access token (TTL 5 min). The token must be sent to call-service in the
   * `Join` message to prove the user is authorized for this room.
   */
  async initiateCall(
    userId: string,
    groupId: string,
  ): Promise<InitiateCallResponse> {
    this.logger.debug(`[calls] initiateCall user=${userId} group=${groupId}`);

    const membership = await this.groupMemberRepo.findOne({
      where: { groupId, userId },
    });
    if (!membership) {
      this.logger.warn(
        `[calls] user ${userId} is not a member of group ${groupId}`,
      );
      throw new ForbiddenException('Not a member of this group');
    }

    const roomSecret = process.env.CALL_ROOM_SECRET?.trim();
    if (!roomSecret) {
      this.logger.error(
        '[calls] CALL_ROOM_SECRET is not set - cannot issue room tokens',
      );
      throw new ServiceUnavailableException(
        'Call room tokens are not configured on this server',
      );
    }

    const roomId = uuidv4();
    const roomToken = jwt.sign(
      { room_id: roomId, sub: userId, group_id: groupId },
      roomSecret,
      { expiresIn: '5m', algorithm: 'HS256' },
    );

    this.logger.debug(
      `[calls] Issued room token for user=${userId} room=${roomId}`,
    );
    return { roomId, roomToken };
  }

  /**
   * Issues a room access token for an existing room ID (used by call recipients).
   * Verifies group membership before signing the token.
   */
  async requestRoomToken(
    userId: string,
    groupId: string,
    roomId: string,
  ): Promise<{ roomToken: string }> {
    this.logger.debug(
      `[calls] requestRoomToken user=${userId} group=${groupId} room=${roomId}`,
    );

    const membership = await this.groupMemberRepo.findOne({
      where: { groupId, userId },
    });
    if (!membership) {
      this.logger.warn(
        `[calls] user ${userId} is not a member of group ${groupId}`,
      );
      throw new ForbiddenException('Not a member of this group');
    }

    const roomSecret = process.env.CALL_ROOM_SECRET?.trim();
    if (!roomSecret) {
      throw new ServiceUnavailableException(
        'Call room tokens are not configured on this server',
      );
    }

    const roomToken = jwt.sign(
      { room_id: roomId, sub: userId, group_id: groupId },
      roomSecret,
      { expiresIn: '5m', algorithm: 'HS256' },
    );

    this.logger.debug(
      `[calls] Issued join token for user=${userId} room=${roomId}`,
    );
    return { roomToken };
  }

  /**
   * Returns ICE server configuration for an authenticated group member.
   * Requires a valid `callId` so credentials are scoped per call session.
   */
  async getIceServers(
    userId: string,
    groupId: string,
    callId: string,
  ): Promise<IceServersResponse> {
    this.logger.debug(
      `[ICE] getIceServers user=${userId} group=${groupId} call=${callId}`,
    );

    const membership = await this.groupMemberRepo.findOne({
      where: { groupId, userId },
    });

    if (!membership) {
      this.logger.warn(
        `[ICE] user ${userId} is not a member of group ${groupId}`,
      );
      throw new ForbiddenException('Not a member of this group');
    }

    const cloudflareToken = process.env.CLOUDFLARE_CALLS_API_TOKEN?.trim();
    const turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();

    if (!cloudflareToken || !turnKeyId) {
      this.logger.error(
        '[ICE] Cloudflare TURN is not configured (CLOUDFLARE_CALLS_API_TOKEN and CLOUDFLARE_TURN_KEY_ID required)',
      );
      throw new ServiceUnavailableException(
        'WebRTC TURN is not configured on this server',
      );
    }

    // Refuse new TURN credentials once the monthly relay budget is reached, so we
    // never exceed Cloudflare's free tier and incur overage. All call media is
    // relay-only (the SFU has no public media path), so every call counts.
    const budgetMb = this.turnBudgetGb() * 1000;
    const usedMb = await this.getMonthlyTurnUsageMb();
    if (usedMb >= budgetMb) {
      this.logger.error(
        `[ICE] Monthly TURN budget reached (${usedMb.toFixed(0)}/${budgetMb} MB) - refusing credentials`,
      );
      throw new ServiceUnavailableException(
        'Quota mensuel des appels atteint sur ce serveur. Réessayez le mois prochain.',
      );
    }

    return this.fetchCloudflareIceServers(turnKeyId, cloudflareToken);
  }

  /** Monthly TURN relay budget in GB (Cloudflare free tier is ~1000 GB; default leaves a margin). */
  private turnBudgetGb(): number {
    const v = parseInt(
      process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB || '950',
      10,
    );
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
      MAX_COUNTED_CALL_SEC,
    );
    if (durationSec < 1) return;
    const mb = (this.relayKbpsPerDevice() * durationSec) / 8000;
    const key = monthlyTurnUsageKey();
    await this.redis.incrbyfloat(key, mb);
    await this.redis.expire(key, TURN_USAGE_TTL_SEC);
    this.logger.debug(
      `[ICE] TURN usage +${mb.toFixed(1)} MB (call ${Math.round(durationSec)}s)`,
    );
  }

  /**
   * Records whether this device is currently in an active call (Redis, per user).
   * Used so sibling devices can warn the user on app open.
   */
  async reportCallPresence(
    userId: string,
    deviceId: string,
    body: { active: boolean; callId?: string; groupId?: string },
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
            this.logger.debug(
              `[calls] cleared presence for user=${userId} device=${deviceId}`,
            );
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
    await this.redis.set(
      key,
      JSON.stringify(payload),
      'EX',
      USER_CALL_PRESENCE_TTL_SEC,
    );
    this.logger.debug(
      `[calls] presence active user=${userId} device=${deviceId} call=${body.callId ?? '?'}`,
    );
    return { ok: true };
  }

  /**
   * Returns whether another device of the same user is currently in a call.
   */
  async getSiblingCallStatus(
    userId: string,
    deviceId: string,
  ): Promise<SiblingCallStatusResponse> {
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
    apiToken: string,
  ): Promise<IceServersResponse> {
    const ttl = parseInt(process.env.CLOUDFLARE_TURN_TTL_SECONDS || '7200', 10);
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${turnKeyId}/credentials/generate-ice-servers`;

    this.logger.debug(
      `[ICE] Requesting Cloudflare TURN credentials (ttl=${ttl})`,
    );

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
        `[ICE] Cloudflare TURN API error status=${response.status} body=${body.slice(0, 200)}`,
      );
      throw new ServiceUnavailableException(
        'Failed to generate TURN credentials',
      );
    }

    const data = (await response.json()) as { iceServers?: IceServerConfig[] };
    const iceServers = this.filterIceServers(data.iceServers ?? []);

    if (iceServers.length === 0) {
      this.logger.error('[ICE] Cloudflare returned no usable ICE servers');
      throw new ServiceUnavailableException('No ICE servers available');
    }

    this.logger.debug(
      `[ICE] Cloudflare returned ${iceServers.length} ICE server(s)`,
    );
    return { iceServers };
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
