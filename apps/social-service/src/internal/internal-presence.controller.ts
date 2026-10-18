import { Body, Controller, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ChannelMember } from '../channels/entities/channel-member.entity';
import { parsePresenceAudienceBody } from '../utils/presence-audience';
import { assertInternalSecret } from './internal-secret.util';

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
   * `NginxAuthGuard` stores ids under; the viewer is never in it. The question is validated by
   * `parsePresenceAudienceBody`, the module chat-delivery's half shares byte for byte: a malformed
   * one is a 400, never an empty answer.
   *
   * The viewer lookup (`WHERE "userId" = viewer`) rides `IDX_channel_members_user` (migration 089);
   * the unique (`workspaceId`, `userId`) cannot serve it.
   */
  @Post('shared-communities')
  @HttpCode(200)
  async sharedCommunities(
    @Headers('x-internal-secret') secret: string | undefined,
    @Body() body: { viewerId?: unknown; userIds?: unknown }
  ): Promise<{ userIds: string[] }> {
    assertInternalSecret(secret);
    const { viewerId, userIds } = parsePresenceAudienceBody(body);
    const targets = userIds.filter((id) => id !== viewerId);
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
