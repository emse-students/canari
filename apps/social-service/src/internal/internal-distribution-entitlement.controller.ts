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

  /**
   * "How did departure N end" - asked by chat-delivery's hourly drain for a key-group departure
   * whose second eviction never arrived. The answer is final: a departure not yet recorded is
   * decided `cancelled` here, and its roster write can then no longer commit
   * ({@link ChannelService.decideDistributionDeparture}). The entitlement above cannot answer this,
   * since it says `true` both before a departure commits and after a rejoin.
   */
  @Post('departure-outcome')
  @HttpCode(200)
  async departureOutcome(
    @Headers('x-internal-secret') secret: string | undefined,
    @Body() body: { groupId?: unknown; userId?: unknown; departure?: unknown }
  ): Promise<{ outcome: 'departed' | 'cancelled' }> {
    assertInternalSecret(secret);
    const groupId = String(body?.groupId ?? '').trim();
    // Exactly as the departure recorded it: chat-delivery names the person by the id this service
    // evicted, so no normalisation may make the two spellings differ.
    const userId = String(body?.userId ?? '');
    const departure = body?.departure;
    if (
      !UUID.test(groupId) ||
      !userId ||
      typeof departure !== 'number' ||
      !Number.isInteger(departure) ||
      departure < 1
    ) {
      this.logger.warn(`[DISTRIBUTION_GROUP] departure outcome refused: malformed body`);
      throw new BadRequestException(
        'groupId (uuid), userId and departure (integer >= 1) are required'
      );
    }
    return { outcome: await this.channels.decideDistributionDeparture(groupId, userId, departure) };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
