import {
  BadRequestException,
  Controller,
  Delete,
  Headers,
  Logger,
  Param,
  Query,
} from '@nestjs/common';
import { assertInternalSecret } from '../internal/internal-secret.util';
import { AuthSessionsService, DEVICE_ID_PATTERN } from './auth-sessions.service';

/** A core-service session id: `auth_sessions.id`, a UUID minted by `randomUUID()`. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Session endings asked by another service, over the Docker network only (`/api/internal` has no
 * nginx location) and gated on `INTERNAL_SECRET`.
 */
@Controller('internal/sessions')
export class InternalSessionsController {
  private readonly logger = new Logger(InternalSessionsController.name);

  constructor(private readonly sessions: AuthSessionsService) {}

  /**
   * Ends every session of `userId` bound to `deviceId`, except the session that asked
   * (`exceptSession`, the caller's own, optional) - chat-delivery's owner device delete, once the
   * device's ban is recorded ({@link AuthSessionsService.endDeviceSessions}). Idempotent: a retry
   * ends nothing more and answers `ended: 0`.
   */
  @Delete('users/:userId/devices/:deviceId')
  async endDeviceSessions(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Query('exceptSession') exceptSession: string | undefined,
    @Headers('x-internal-secret') secret?: string
  ): Promise<{ ended: number }> {
    assertInternalSecret(secret);
    if (!userId || userId.length > 255) throw new BadRequestException('userId');
    if (!DEVICE_ID_PATTERN.test(deviceId)) throw new BadRequestException('deviceId');
    const except = exceptSession ? exceptSession.trim().toLowerCase() : null;
    if (except !== null && !SESSION_ID_PATTERN.test(except)) {
      throw new BadRequestException('exceptSession');
    }
    const ended = await this.sessions.endDeviceSessions(userId, deviceId, except);
    this.logger.log(
      `[SESSION_END] device revoked by its owner user=${userId} device=${deviceId} ended=${ended}` +
        (except ? ` kept caller sid=${except}` : '')
    );
    return { ended };
  }
}
