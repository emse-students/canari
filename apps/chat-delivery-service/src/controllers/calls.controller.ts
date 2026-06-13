import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Headers,
  UseGuards,
  Logger,
  BadRequestException,
  HttpCode,
} from '@nestjs/common';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { CallsService } from '../services/calls.service';
import { sanitizeQueryValue } from '../utils/sanitize';

/** WebRTC TURN credential and room token endpoints for authenticated group members. */
@Controller()
export class CallsController {
  private readonly logger = new Logger(CallsController.name);

  constructor(private readonly callsService: CallsService) {}

  /**
   * Verifies group membership and returns a signed room token + UUID room ID.
   * The client must pass `roomToken` to call-service when sending the `Join` message.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('calls/initiate')
  @HttpCode(200)
  async initiateCall(
    @Body() body: { groupId: string },
    @Headers('x-user-id') userId?: string,
  ) {
    if (!userId) throw new BadRequestException('Missing X-User-Id header');
    const safeGroupId = sanitizeQueryValue(body?.groupId, 'groupId');
    return this.callsService.initiateCall(userId, safeGroupId);
  }

  /**
   * Returns a room access token for an existing room (used by call recipients).
   * The initiator already holds a token from `POST /calls/initiate`; each other
   * participant calls this endpoint with the room ID received via MLS to get theirs.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('calls/room-token')
  async getRoomToken(
    @Query('groupId') groupId: string,
    @Query('roomId') roomId: string,
    @Headers('x-user-id') userId?: string,
  ) {
    if (!userId) throw new BadRequestException('Missing X-User-Id header');
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeRoomId = sanitizeQueryValue(roomId, 'roomId');
    return this.callsService.requestRoomToken(userId, safeGroupId, safeRoomId);
  }

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

  /**
   * Reports whether this device is currently in a call (for sibling-device detection).
   */
  @UseGuards(HeaderAuthGuard)
  @Post('calls/presence')
  @HttpCode(200)
  async reportPresence(
    @Body()
    body: {
      deviceId: string;
      active: boolean;
      callId?: string;
      groupId?: string;
    },
    @Headers('x-user-id') userId?: string,
  ) {
    if (!userId) throw new BadRequestException('Missing X-User-Id header');
    const deviceId = sanitizeQueryValue(body?.deviceId, 'deviceId');
    return this.callsService.reportCallPresence(userId, deviceId, {
      active: !!body?.active,
      callId: body?.callId
        ? sanitizeQueryValue(body.callId, 'callId')
        : undefined,
      groupId: body?.groupId
        ? sanitizeQueryValue(body.groupId, 'groupId')
        : undefined,
    });
  }

  /**
   * Returns whether another device of the same user is currently in a call.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('calls/sibling-status')
  async getSiblingStatus(
    @Query('deviceId') deviceId: string,
    @Headers('x-user-id') userId?: string,
  ) {
    if (!userId) throw new BadRequestException('Missing X-User-Id header');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    return this.callsService.getSiblingCallStatus(userId, safeDeviceId);
  }
}
