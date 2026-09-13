import { Controller, Post, Delete, Body, Headers, Inject, UseGuards, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { sanitizeQueryValue } from '../utils/sanitize';
import { acquireAddLock, releaseAddLock } from '../utils/add-lock';

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
  /** Acquires the group's add-lock for the calling device. */
  async acquireAddLock(
    @Body()
    body: { groupId: string; deviceId: string },
    @Headers('x-user-id') userIdRaw?: string
  ) {
    const userId = sanitizeQueryValue(userIdRaw ?? '', 'x-user-id');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const acquired = await acquireAddLock(
      this.redis,
      this.logger,
      { groupId, userId, deviceId },
      'jwt'
    );
    return { acquired };
  }

  @Delete('mls/add-lock')
  /** Releases the group's add-lock, if this device still holds it. */
  async releaseAddLock(
    @Body() body: { groupId: string; deviceId: string },
    @Headers('x-user-id') userIdRaw?: string
  ) {
    const userId = sanitizeQueryValue(userIdRaw ?? '', 'x-user-id');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const released = await releaseAddLock(
      this.redis,
      this.logger,
      { groupId, userId, deviceId },
      'jwt'
    );
    return { released };
  }
}
