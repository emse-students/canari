import { Controller, Post, Delete, Body, Inject, UseGuards, Logger } from '@nestjs/common';
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
    body: { groupId: string; deviceId: string; ttlMs?: number }
  ) {
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    // Clamp max 60 s : couvre le pire cas mobile (bulk add + Argon2 + commit + Welcomes) sans
    // permettre qu'un device crashe en bloque un autre indefiniment (H1).
    const ttlSec = Math.max(1, Math.min(60, Math.round((body.ttlMs ?? 30_000) / 1000)));
    // Redis SET NX EX: acquires the lock only if the key does not yet exist.
    const lockKey = `mls:addlock:${groupId}`;
    const result = await this.redis.set(lockKey, deviceId, 'EX', ttlSec, 'NX');
    this.logger.log(
      `[ADD_LOCK] group=${groupId} device=${deviceId} acquired=${result === 'OK'} ttl=${ttlSec}s`
    );
    return { acquired: result === 'OK' };
  }

  @Delete('mls/add-lock')
  /** Releases a previously acquired add-lock for a group. */
  async releaseAddLock(@Body() body: { groupId: string; deviceId: string }) {
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const lockKey = `mls:addlock:${groupId}`;
    // Atomic Lua script: releases the lock only if this device still holds it.
    // Separate GET + DEL would be a race condition (another device could interleave).
    const released = await this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
      1,
      lockKey,
      deviceId
    );
    this.logger.log(
      `[RELEASE_LOCK] group=${groupId} device=${deviceId} released=${released === 1}`
    );
    return { released: released === 1 };
  }
}
