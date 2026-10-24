import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { ChannelService } from '../channels/channel.service';
import { assertInternalSecret } from './internal-secret.util';

interface EntitlementBody {
  /** Which kind of scope owns the key-distribution group: a community, or a private salon. */
  kind: 'workspace' | 'channel';
  /** The workspace or channel id - `dm_groups.distributionWorkspaceId` / `distributionChannelId`. */
  scopeId: string;
  /** The authenticated committer chat-delivery is about to accept. */
  userId: string;
}

/**
 * "May this person join this key-distribution group" - asked by chat-delivery's commit gate before
 * it accepts an external commit to a community's or a private salon's group (WP-KEYGROUP-JOIN-GATE).
 *
 * chat-delivery cannot answer it: the roster of a key group is `channel_workspace_members` and
 * `allowedUsers`, both owned here. The answer is a boolean, never a refusal, because "not entitled"
 * is a fact the caller acts on - only a malformed question or a wrong secret is an error.
 */
@Controller('internal/distribution-groups')
export class InternalDistributionEntitlementController {
  private readonly logger = new Logger(InternalDistributionEntitlementController.name);

  constructor(private readonly channels: ChannelService) {}

  @Post('entitlement')
  @HttpCode(200)
  async entitlement(
    @Headers('x-internal-secret') secret: string | undefined,
    @Body() body: EntitlementBody
  ): Promise<{ entitled: boolean }> {
    assertInternalSecret(secret);
    const kind = body?.kind;
    const scopeId = String(body?.scopeId ?? '').trim();
    const userId = String(body?.userId ?? '')
      .trim()
      .toLowerCase();
    if ((kind !== 'workspace' && kind !== 'channel') || !scopeId || !userId) {
      this.logger.warn(`[DISTRIBUTION_GROUP] entitlement refused: malformed body kind=${kind}`);
      throw new BadRequestException('kind (workspace|channel), scopeId and userId are required');
    }
    const entitled = await this.channels.isDistributionGroupEntitled(kind, scopeId, userId);
    this.logger.log(
      `[DISTRIBUTION_GROUP] entitlement ${kind}=${scopeId} user=${userId.slice(0, 8)} entitled=${entitled}`
    );
    return { entitled };
  }
}
