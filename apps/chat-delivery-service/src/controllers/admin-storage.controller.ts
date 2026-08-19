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

/**
 * One MLS table, sized and counted.
 *
 * `bytes` is `pg_total_relation_size`, so it includes indexes and TOAST - which is the only figure
 * that answers "what is this costing on the disk". A row count next to it is what separates the two
 * ways a table grows: more rows, or rows that got bigger.
 *
 * DISK OCCUPANCY IS NOT DATA VOLUME, AND ON A QUEUE THE TWO ARE NOT CLOSE. `queued_message` read
 * "73 MB, 817 rows" on 2026-08-19, which says a message averages 90 kB; it averages under 1 kB. One
 * abandoned device had accumulated 28 124 rows on 2026-08-10 (see migration 013), and no VACUUM
 * short of FULL returns a file to the OS - so the table still wears the high-water mark of that
 * incident while holding a thousandth of it. A panel that shows only the first number invites
 * exactly the wrong conclusion about the second, so both are reported, always.
 */
export interface MlsTableUsage {
  table: string;
  bytes: number;
  rows: number;
  /**
   * Bytes of LIVE data, estimated as the summed column widths times the live-row estimate.
   *
   * Free, from the same statistics collector that already supplies `rows` - no scan, no extension.
   * It is an estimate and reads as one in the UI: measured against an exact
   * `sum(pg_column_size(q.*))` on prod it landed 17% low (1017 kB against 1224 kB), which is
   * irrelevant next to the 73 MB it is there to distinguish itself from.
   */
  liveBytes: number;
}

/**
 * The undelivered queue, which is the largest MLS table on this deployment by an order of magnitude
 * and the one WP-GHOST-1 shape that a total cannot show.
 *
 * A queue is SUPPOSED to have rows in it - a device that is offline has messages waiting. What is
 * not supposed to happen is one device accumulating without end, which is what a revoked or dead
 * device looks like: the fleet total stays unremarkable while one queue grows forever. So `deepest`
 * is reported next to the total, because the total alone cannot distinguish forty devices with
 * twenty messages from one device with eight hundred.
 */
export interface MlsQueueUsage {
  rows: number;
  devices: number;
  /** Rows on the single deepest device queue. */
  deepest: number;
  /** Age of the oldest queued row, in ms. A queue that is deep AND old is not a queue, it is a leak. */
  oldestMs: number | null;
  /** Rows created in each of the last four 7-day windows, index 0 being the most recent. */
  rowsByWeek: number[];
}

/**
 * THE GHOST SHAPE, MEASURED RATHER THAN REMEMBERED.
 *
 * A device that holds group memberships but has published no key package cannot be added to
 * anything and cannot receive a Welcome - it is in the membership table and nowhere else. WP-GHOST-1
 * named it after finding it by hand; nothing has measured it since, which means nobody would know
 * if it came back.
 *
 * Zero is the expected answer and is worth showing: a counter that only appears when it is non-zero
 * is a counter nobody trusts when it does appear.
 */
export interface MlsGhostUsage {
  devicesWithMemberships: number;
  devicesWithoutKeyPackage: number;
  orphanMemberships: number;
}

/**
 * What Redis is holding, by key prefix.
 *
 * `keys` is exact (`INFO keyspace`). The prefix breakdown is a bounded SCAN SAMPLE and says so in
 * `sampled`: a census would mean walking every key on a live instance, and the question the panel
 * answers - which prefix dominates - does not need one.
 */
export interface RedisKeyspaceUsage {
  keys: number;
  sampled: number;
  byPrefix: { prefix: string; keys: number }[];
}

export interface MlsUsage {
  tables: MlsTableUsage[];
  queue: MlsQueueUsage | null;
  ghosts: MlsGhostUsage | null;
  redisKeyspace: RedisKeyspaceUsage | null;
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
  /**
   * The MLS half. `null` only when the whole block failed; inside it, each measurement fails on its
   * own, exactly like the four above.
   */
  mls: MlsUsage | null;
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

    const [disk, postgresBytes, redisBytes, media, mls] = await Promise.all([
      this.measureDisk(),
      this.measurePostgres(),
      this.measureRedis(),
      this.measureMedia(),
      this.measureMls(),
    ]);

    return {
      diskTotalBytes: disk?.totalBytes ?? null,
      diskUsedBytes: disk?.usedBytes ?? null,
      postgresBytes,
      redisBytes,
      media,
      mls,
    };
  }

  /**
   * The MLS half of the panel: the tables this service owns, the queue's shape, the ghost count and
   * what Redis is holding.
   *
   * Four independent measurements behind one `Promise.all`, each returning null on its own failure -
   * the same isolation the four above already have, for the same reason: one dependency having a bad
   * day must not blank the panel.
   */
  private async measureMls(): Promise<MlsUsage> {
    const [tables, queue, ghosts, redisKeyspace] = await Promise.all([
      this.measureMlsTables(),
      this.measureQueue(),
      this.measureGhosts(),
      this.measureRedisKeyspace(),
    ]);
    return { tables, queue, ghosts, redisKeyspace };
  }

  /**
   * The tables this service owns, largest first.
   *
   * Named EXPLICITLY rather than discovered from the schema: `pg_class` would also hand back the
   * social, auth and poster tables, and a panel that lists every table in `auth_db` is a panel whose
   * MLS section is a search problem. `n_live_tup` is the planner's estimate and is free; an exact
   * `COUNT(*)` per table would be a sequential scan per render on the largest table here.
   */
  private async measureMlsTables(): Promise<MlsTableUsage[]> {
    const MLS_TABLES = [
      'queued_message',
      'one_time_key_package',
      'key_package',
      'mls_commit_log',
      'mls_group_info',
      'dm_device_group_memberships',
      'revoked_device',
      'pin_verifier',
    ];
    try {
      const rows: { table: string; bytes: string; rows: string; livebytes: string }[] =
        await this.dataSource.query(
          `SELECT c.relname AS table,
                pg_total_relation_size(c.oid) AS bytes,
                COALESCE(s.n_live_tup, 0) AS rows,
                COALESCE(
                  (SELECT SUM(st.avg_width) FROM pg_stats st
                    WHERE st.schemaname = n.nspname AND st.tablename = c.relname), 0
                ) * COALESCE(s.n_live_tup, 0) AS livebytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)
         ORDER BY pg_total_relation_size(c.oid) DESC`,
          [MLS_TABLES]
        );
      return rows.map((r) => ({
        table: r.table,
        bytes: Number(r.bytes),
        rows: Number(r.rows),
        liveBytes: Number(r.livebytes),
      }));
    } catch (err) {
      this.logger.warn(
        `[STORAGE] mls table measurement failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  /**
   * The queue, as four numbers rather than one.
   *
   * The total says how much is waiting; `deepest` says whether it is waiting for FORTY devices or
   * for one. Those are two different populations behind the same total, and only one of them is a
   * defect - a revoked or dead device whose queue grows without end looks unremarkable in a fleet
   * total right up until the table is the largest in the database.
   */
  private async measureQueue(): Promise<MlsQueueUsage | null> {
    try {
      const [totals]: { rows: string; devices: string; oldest: string | null }[] =
        await this.dataSource.query(
          `SELECT COUNT(*) AS rows,
                  COUNT(DISTINCT "deviceId") AS devices,
                  EXTRACT(EPOCH FROM (NOW() - MIN("createdAt"))) * 1000 AS oldest
           FROM queued_message`
        );

      const [deepest]: { deepest: string | null }[] = await this.dataSource.query(
        `SELECT MAX(c) AS deepest
         FROM (SELECT COUNT(*) AS c FROM queued_message GROUP BY "deviceId") q`
      );

      // Four 7-day windows, index 0 being the current week - the same shape the media bars already
      // use, so the panel renders both the same way.
      const weeks: { week: string; c: string }[] = await this.dataSource.query(
        `SELECT FLOOR(EXTRACT(EPOCH FROM (NOW() - "createdAt")) / 604800) AS week, COUNT(*) AS c
         FROM queued_message
         WHERE "createdAt" > NOW() - INTERVAL '28 days'
         GROUP BY 1`
      );
      const rowsByWeek = [0, 0, 0, 0];
      for (const row of weeks) {
        const index = Number(row.week);
        if (index >= 0 && index < rowsByWeek.length) rowsByWeek[index] = Number(row.c);
      }

      return {
        rows: Number(totals?.rows ?? 0),
        devices: Number(totals?.devices ?? 0),
        deepest: Number(deepest?.deepest ?? 0),
        oldestMs:
          totals?.oldest === null || totals?.oldest === undefined ? null : Number(totals.oldest),
        rowsByWeek,
      };
    } catch (err) {
      this.logger.warn(
        `[STORAGE] queue measurement failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /**
   * Devices that hold memberships and have published no key package.
   *
   * One `GROUP BY`-shaped question, asked continuously instead of by hand after an incident. The
   * expected answer is zero and the panel shows the zero: a counter that only appears when it is
   * non-zero is a counter nobody believes the first time it does.
   */
  private async measureGhosts(): Promise<MlsGhostUsage | null> {
    try {
      const [row]: { devices: string; ghosts: string; orphans: string }[] =
        await this.dataSource.query(
          `SELECT COUNT(DISTINCT m."deviceId") AS devices,
                  COUNT(DISTINCT m."deviceId") FILTER (WHERE k."deviceId" IS NULL) AS ghosts,
                  COUNT(*) FILTER (WHERE k."deviceId" IS NULL) AS orphans
           FROM dm_device_group_memberships m
           LEFT JOIN key_package k ON k."deviceId" = m."deviceId"`
        );
      return {
        devicesWithMemberships: Number(row?.devices ?? 0),
        devicesWithoutKeyPackage: Number(row?.ghosts ?? 0),
        orphanMemberships: Number(row?.orphans ?? 0),
      };
    } catch (err) {
      this.logger.warn(
        `[STORAGE] ghost measurement failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /**
   * What Redis holds, by key prefix.
   *
   * The total is exact and free. The breakdown is a BOUNDED SAMPLE - a census means walking every
   * key on a live instance, and the question the panel answers, which prefix dominates, does not
   * need one. `sampled` travels with it so the panel says so rather than implying a census.
   */
  private async measureRedisKeyspace(): Promise<RedisKeyspaceUsage | null> {
    const SAMPLE_LIMIT = 5000;
    try {
      const info = await this.redis.info('keyspace');
      const keysMatch = /keys=(\d+)/.exec(info);
      const keys = keysMatch ? Number(keysMatch[1]) : 0;

      const counts = new Map<string, number>();
      let cursor = '0';
      let sampled = 0;
      do {
        const [next, batch] = await this.redis.scan(cursor, 'COUNT', 500);
        cursor = next;
        for (const key of batch) {
          // Everything before the first separator. Canari's keys are `prefix:rest`, and a breakdown
          // by full key would be a list of every key - the thing this is avoiding.
          const prefix = key.split(':')[0] || '(none)';
          counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
          sampled += 1;
        }
      } while (cursor !== '0' && sampled < SAMPLE_LIMIT);

      const byPrefix = [...counts.entries()]
        .map(([prefix, n]) => ({ prefix, keys: n }))
        .sort((a, b) => b.keys - a.keys)
        .slice(0, 8);

      return { keys, sampled, byPrefix };
    } catch (err) {
      this.logger.warn(
        `[STORAGE] redis keyspace measurement failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
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
