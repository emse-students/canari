import { Controller, Post, Delete, Body, Headers, Inject, UseGuards, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { sanitizeQueryValue } from '../utils/sanitize';

/** Distributed Redis locks for MLS add operations to prevent concurrent commits. */
@Controller()
@UseGuards(HeaderAuthGuard)
export class LocksController {
  private readonly logger = new Logger(LocksController.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  @Post('mls/add-lock')
  /** Acquires a distributed Redis lock for a group to prevent concurrent MLS commits. */
  async acquireAddLock(
    @Body()
    body: { groupId: string; deviceId: string; ttlMs?: number },
    @Headers('x-user-id') userIdRaw?: string
  ) {
    const userId = sanitizeQueryValue(userIdRaw ?? '', 'x-user-id');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    // Clamp to 60 s max: covers the worst-case mobile path (bulk add + state persist + commit +
    // Welcomes) without letting one crashed device block another indefinitely (H1).
    const ttlSec = Math.max(1, Math.min(60, Math.round((body.ttlMs ?? 30_000) / 1000)));
    // Redis SET NX EX: acquires the lock only if the key does not yet exist.
    const lockKey = `mls:addlock:${groupId}`;
    const lockOwner = `${userId}:${deviceId}`;
    const result = await this.redis.set(lockKey, lockOwner, 'EX', ttlSec, 'NX');
    this.logger.log(
      `[ADD_LOCK] group=${groupId} owner=${lockOwner} acquired=${result === 'OK'} ttl=${ttlSec}s`
    );
    return { acquired: result === 'OK' };
  }

  @Delete('mls/add-lock')
  /** Releases a previously acquired add-lock for a group. */
  async releaseAddLock(
    @Body() body: { groupId: string; deviceId: string },
    @Headers('x-user-id') userIdRaw?: string
  ) {
    const userId = sanitizeQueryValue(userIdRaw ?? '', 'x-user-id');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const lockKey = `mls:addlock:${groupId}`;
    const lockOwner = `${userId}:${deviceId}`;
    // Atomic Lua script: releases the lock only if this device still holds it.
    // Separate GET + DEL would be a race condition (another device could interleave).
    const released = await this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
      1,
      lockKey,
      lockOwner
    );
    this.logger.log(
      `[RELEASE_LOCK] group=${groupId} owner=${lockOwner} released=${released === 1}`
    );
    return { released: released === 1 };
  }
}
