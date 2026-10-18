import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ChannelMember } from '../channels/entities/channel-member.entity';
import { assertInternalSecret } from './internal-secret.util';

/**
 * The most user ids one presence-audience question may carry. The gateway refuses a larger
 * question before asking (`MAX_PRESENCE_USERS` in `apps/chat-gateway/src/presence.rs`), so reaching
 * this bound here is a caller bug, never a user's list.
 */
export const MAX_PRESENCE_AUDIENCE_USERS = 1000;

/**
 * The community half of the presence audience (WP-PRESENCE, decided by the user 2026-10-18): the
 * gateway shows whether X is online only to someone who shares a conversation or a COMMUNITY with
 * X. The conversation half is chat-delivery's `POST /internal/presence/shared-conversations`; each
 * service answers about the tables it owns, and the gateway takes the union.
 *
 * Internal-only: called by `chat-gateway` over the Docker network with `X-Internal-Secret`.
 */
@Controller('internal/presence')
export class InternalPresenceController {
  private readonly logger = new Logger(InternalPresenceController.name);

  constructor(
    @InjectRepository(ChannelMember)
    private readonly memberRepo: Repository<ChannelMember>
  ) {}

  /**
   * Which of `userIds` are members of at least one community (`channel_members` row on a common
   * `workspaceId`) the viewer is also a member of. Answers the SUBSET, lowercased - the spelling
   * `NginxAuthGuard` stores ids under; the viewer is never in it. A malformed question is a 400, never an empty answer: "nobody"
   * would read at the gateway as "every one of them is invisible to you".
   */
  @Post('shared-communities')
  @HttpCode(200)
  async sharedCommunities(
    @Headers('x-internal-secret') secret: string | undefined,
    @Body() body: { viewerId?: unknown; userIds?: unknown }
  ): Promise<{ userIds: string[] }> {
    assertInternalSecret(secret);
    const viewerId = typeof body?.viewerId === 'string' ? body.viewerId.trim().toLowerCase() : '';
    const raw = body?.userIds;
    if (!viewerId || !Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
      this.logger.warn('[PRESENCE_AUDIENCE] refused: malformed body');
      throw new BadRequestException('viewerId and an array of string userIds are required');
    }
    const targets = [
      ...new Set((raw as string[]).map((id) => id.trim().toLowerCase()).filter(Boolean)),
    ].filter((id) => id !== viewerId);
    if (targets.length > MAX_PRESENCE_AUDIENCE_USERS) {
      this.logger.warn(`[PRESENCE_AUDIENCE] refused: ${targets.length} userIds`);
      throw new BadRequestException(`at most ${MAX_PRESENCE_AUDIENCE_USERS} userIds`);
    }
    if (targets.length === 0) return { userIds: [] };

    const viewerRows = await this.memberRepo.find({
      where: { userId: viewerId },
      select: { workspaceId: true },
    });
    const workspaceIds = [...new Set(viewerRows.map((r) => r.workspaceId))];
    if (workspaceIds.length === 0) {
      this.logger.debug(`[PRESENCE_AUDIENCE] viewer=${viewerId.slice(0, 8)} has no community`);
      return { userIds: [] };
    }
    const shared = await this.memberRepo.find({
      where: { workspaceId: In(workspaceIds), userId: In(targets) },
      select: { userId: true },
    });
    const visible = new Set(shared.map((r) => r.userId));
    const answer = targets.filter((id) => visible.has(id));
    this.logger.debug(
      `[PRESENCE_AUDIENCE] viewer=${viewerId.slice(0, 8)} asked=${targets.length} shared=${answer.length}`
    );
    return { userIds: answer };
  }
}
