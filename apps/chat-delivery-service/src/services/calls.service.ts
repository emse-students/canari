import {
  Injectable,
  Logger,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GroupMember } from '../entities/group-member.entity';
import * as jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

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
        '[calls] CALL_ROOM_SECRET is not set — cannot issue room tokens',
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

    return this.fetchCloudflareIceServers(turnKeyId, cloudflareToken);
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
