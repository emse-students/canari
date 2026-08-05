import { Controller, Get, Headers, Logger, Param } from '@nestjs/common';
import { assertInternalSecret } from './internal-secret.util';
import { ChannelService } from '../channels/channel.service';

/**
 * Session-free community invite preview, called by the web SSR process when it renders the
 * Open Graph head of `/c/join/:token`.
 *
 * The user-facing route (`GET /api/channels/invites/:token`) is behind `NginxAuthGuard`, and an
 * unfurler has no session - so the head renderer needs its own way in. It gets the SAME payload:
 * `getWorkspaceInvitePreview` is already viewer-independent (it answers on the invite's validity
 * and the workspace not being archived, never on who is asking), so this is a re-exposure of one
 * function rather than a second implementation of the rule.
 *
 * NOT reachable through nginx - `/api/internal` has no location - and gated on INTERNAL_SECRET
 * anyway, which fails closed when unset.
 */
@Controller('internal')
export class InternalInvitesController {
  private readonly logger = new Logger(InternalInvitesController.name);

  constructor(private readonly channels: ChannelService) {}

  /** Community name/image behind an invite token, for the shared-link preview. */
  @Get('channel-invites/:token')
  async channelInvitePreview(
    @Param('token') token: string,
    @Headers('x-internal-secret') secret?: string
  ) {
    assertInternalSecret(secret);
    this.logger.debug(`internal channel invite preview token=${token.slice(0, 8)}`);
    return this.channels.getWorkspaceInvitePreview(token);
  }
}
