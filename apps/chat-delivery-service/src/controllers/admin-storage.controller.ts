import { Controller, Get, ForbiddenException, Inject, Logger, Headers } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { promises as fs } from 'fs';
import Redis from 'ioredis';

/**
 * Backend counterpart of the client's device-storage panel (WP-DEVICESTORAGE-1): reports what the
 * server itself is using, mirroring the four numbers `docs/wiki/infrastructure/storage-forecast.md`
 * was previously only measuring by hand over SSH (`df`, `psql`, `redis-cli`, `du`).
 *
 * Each measurement is independent and fails on its own (`null`), so a stopped or unreachable
 * dependency (e.g. media-service down) never takes the other three numbers down with it - the same
 * per-job isolation the hourly queue-depth report and the account-deletion GC already follow.
 */
/**
 * The media bucket's breakdown, as media-service computes it. Mirrored here rather than imported:
 * the two services share no code, and a structural type is what the HTTP call actually carries.
 * The field docs live with the implementation (`MediaService.getStorageStats`).
 */
export interface MediaBucketUsage {
  totalBytes: number;
  objectCount: number;
  recentBytesByWeek: number[];
  olderBytes: number;
  undatedCount: number;
  overdueCount: number;
  overdueBytes: number;
  overdueOldestMs: number | null;
  untrackedCount: number;
  untrackedBytes: number;
  tombstonedCount: number;
  tombstonedBytes: number;
  publicAssetCount: number;
  publicAssetBytes: number;
  retentionMs: number;
  sweepIntervalMs: number;
}

export interface BackendStorageUsage {
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  postgresBytes: number | null;
  redisBytes: number | null;
  /**
   * The media bucket. Carries its own total and count rather than duplicating them alongside, so
   * the panel cannot end up showing a size and a breakdown that disagree.
   */
  media: MediaBucketUsage | null;
}

@Controller('mls/admin')
export class AdminStorageController {
  private readonly logger = new Logger(AdminStorageController.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject('REDIS_CLIENT') private readonly redis: Redis
  ) {}

  /**
   * `X-Global-Admin` arrives the same way as everywhere else in this service
   * (`security.controller.ts`'s `assertSelfOrGlobalAdmin`): nginx's `auth_request` forwards it from
   * core-service's JWT-backed verify endpoint, so a client cannot forge it directly.
   */
  private assertGlobalAdmin(headerGlobalAdmin?: string): void {
    if (headerGlobalAdmin !== 'true') {
      throw new ForbiddenException('Operation restricted to global admins');
    }
  }

  @Get('storage')
  async getStorageUsage(
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<BackendStorageUsage> {
    this.assertGlobalAdmin(headerGlobalAdmin);

    const [disk, postgresBytes, redisBytes, media] = await Promise.all([
      this.measureDisk(),
      this.measurePostgres(),
      this.measureRedis(),
      this.measureMedia(),
    ]);

    return {
      diskTotalBytes: disk?.totalBytes ?? null,
      diskUsedBytes: disk?.usedBytes ?? null,
      postgresBytes,
      redisBytes,
      media,
    };
  }

  /** The container's root filesystem, which for a bind-mounted Docker volume reports the host disk. */
  private async measureDisk(): Promise<{ totalBytes: number; usedBytes: number } | null> {
    try {
      const stats = await fs.statfs('/');
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bfree * stats.bsize;
      return { totalBytes, usedBytes: totalBytes - freeBytes };
    } catch (err) {
      this.logger.warn(
        `[STORAGE] disk measurement failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /** The whole `auth_db` database - shared by every service, so any one connection sees the total. */
  private async measurePostgres(): Promise<number | null> {
    try {
      const rows: { bytes: string }[] = await this.dataSource.query(
        'SELECT pg_database_size(current_database()) AS bytes'
      );
      return Number(rows[0]?.bytes ?? 0);
    } catch (err) {
      this.logger.warn(
        `[STORAGE] postgres measurement failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  private async measureRedis(): Promise<number | null> {
    try {
      const info = await this.redis.info('memory');
      const match = /^used_memory:(\d+)/m.exec(info);
      return match ? Number(match[1]) : null;
    } catch (err) {
      this.logger.warn(
        `[STORAGE] redis measurement failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /** Server-to-server call to media-service, the only holder of the Garage client. */
  private async measureMedia(): Promise<MediaBucketUsage | null> {
    const mediaUrl = process.env.MEDIA_SERVICE_URL ?? 'http://media-service:3011';
    const internalSecret = process.env.INTERNAL_SECRET ?? '';
    if (!internalSecret) {
      this.logger.warn('[STORAGE] media measurement skipped - INTERNAL_SECRET unset');
      return null;
    }
    try {
      const upstream = await fetch(`${mediaUrl}/api/media/internal/storage-stats`, {
        headers: { 'x-internal-secret': internalSecret },
        signal: AbortSignal.timeout(10_000),
      });
      if (!upstream.ok) {
        // Was silently null before, which is indistinguishable from the secret being unset.
        this.logger.warn(`[STORAGE] media measurement refused (HTTP ${upstream.status})`);
        return null;
      }
      return (await upstream.json()) as MediaBucketUsage;
    } catch (err) {
      this.logger.warn(
        `[STORAGE] media measurement failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }
}
