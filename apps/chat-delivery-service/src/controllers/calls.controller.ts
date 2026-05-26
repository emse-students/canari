import {
  Controller,
  Get,
  Query,
  Headers,
  UseGuards,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { CallsService } from '../services/calls.service';
import { sanitizeQueryValue } from '../utils/sanitize';

/** WebRTC TURN credential endpoints for authenticated group members. */
@Controller()
export class CallsController {
  private readonly logger = new Logger(CallsController.name);

  constructor(private readonly callsService: CallsService) {}

  /**
   * Returns short-lived ICE server configuration (Cloudflare TURN or local Coturn).
   * Caller must be an active member of `groupId`.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('calls/ice-servers')
  async getIceServers(
    @Query('groupId') groupId: string,
    @Query('callId') callId: string,
    @Headers('x-user-id') userId?: string,
  ) {
    if (!userId) {
      throw new BadRequestException('Missing X-User-Id header');
    }

    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeCallId = sanitizeQueryValue(callId, 'callId');

    this.logger.debug(
      `[ICE] ice-servers request user=${userId} group=${safeGroupId} call=${safeCallId}`,
    );

    return this.callsService.getIceServers(userId, safeGroupId, safeCallId);
  }
}
