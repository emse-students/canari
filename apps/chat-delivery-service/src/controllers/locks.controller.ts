import { Controller, Post, Delete, Body, Headers, Inject, UseGuards, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { sanitizeQueryValue } from '../utils/sanitize';
import { acquireAddLock, releaseAddLock, type AddLockAcquisition } from '../utils/add-lock';

/**
 * The JWT-guarded door to the MLS add-lock, which serialises add commits on a group.
 *
 * The lock itself - its key, its owner, its lifetime and its ownership-checked release - is
 * [`utils/add-lock.ts`](../utils/add-lock.ts), shared with the PushSecret door in
 * `push.controller.ts`. Nothing about the lock is decided here: a second implementation is how the
 * two doors came to disagree about how long it lives.
 */
@Controller()
@UseGuards(HeaderAuthGuard)
export class LocksController {
  private readonly logger = new Logger(LocksController.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  @Post('mls/add-lock')
  /**
   * Acquires the group's add-lock for the calling device: `{acquired: true, token}` - the token
   * its release names - or `{acquired: false, retryAfterMs}`, how long the holder's lock has left.
   */
  async acquireAddLock(
    @Body()
    body: { groupId: string; deviceId: string },
    @Headers('x-user-id') userIdRaw?: string
  ): Promise<AddLockAcquisition> {
    const userId = sanitizeQueryValue(userIdRaw ?? '', 'x-user-id');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    return acquireAddLock(this.redis, this.logger, { groupId, userId, deviceId }, 'jwt');
  }

  @Delete('mls/add-lock')
  /**
   * Releases the group's add-lock if it is still the acquisition `token` names. A body with no
   * token (a client that predates it) takes the LEGACY owner-only release (`utils/add-lock.ts`).
   */
  async releaseAddLock(
    @Body() body: { groupId: string; deviceId: string; token?: string },
    @Headers('x-user-id') userIdRaw?: string
  ) {
    const userId = sanitizeQueryValue(userIdRaw ?? '', 'x-user-id');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const token = body.token ? sanitizeQueryValue(body.token, 'token') : undefined;
    const released = await releaseAddLock(
      this.redis,
      this.logger,
      { groupId, userId, deviceId },
      'jwt',
      token
    );
    return { released };
  }
}
