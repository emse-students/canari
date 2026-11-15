import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { mediaUrl } from './service-urls';
import { readRetentionDays } from '../common/retention-settings';

/** A Docker-network hop: anything slower is a failure, logged. */
const NOTICE_TIMEOUT_MS = 5_000;

/**
 * At this service's boot, HANDS media-service the two retention durations it stamps
 * (docs/wiki/retention-settings.md), read here from `platform_config` and carried in the notice's body.
 *
 * WHY THE VALUES TRAVEL WITH THE NOTICE (2026-11-15, the `1.7.0-alpha.1` rolling deploy on dev). The
 * deploy replaces social-service AFTER media-service (`depends_on`), so on the release that adds
 * `GET /api/internal/retention` media-service boots beside the OLD social-service and its boot read
 * answers 404. The notice used to say only "read again" - and that read went through the mesh, whose
 * target for social-service, while this replica boots, is the service's DNS name: this replica is not
 * listening yet (`onApplicationBootstrap` runs before `listen`; the mesh hands a refused connect to
 * the next address) and the retiring replica, which has no route, answered 404 again. The replica that
 * sent the notice had the values; the read could not reach it. Now the notifier hands over what it
 * provably has, and media-service holds it when it holds nothing (a read orders everything after).
 *
 * Sent beside the boot, never in its way. A failed database read sends no notice (there is nothing to
 * hand over, and a bare notice would only send media-service through the mesh again): it is an ERROR
 * here, and media-service still asks on its next upload that finds nothing held.
 */
@Injectable()
export class RetentionBootNotice implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetentionBootNotice.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  onApplicationBootstrap(): void {
    void this.send();
  }

  /** The notice itself; resolves true when media-service holds the durations. Never rejects. */
  async send(fetchImpl: typeof fetch = fetch): Promise<boolean> {
    let handed: { chatReelDays: number; idleFileDays: number };
    try {
      const days = await readRetentionDays(this.db.manager, this.logger);
      handed = { chatReelDays: days.chatReelDays, idleFileDays: days.idleFileDays };
    } catch (e) {
      this.logger.error(
        `[RETENTION] the retention durations could not be read at this boot, so none were handed to media-service: ${e instanceof Error ? e.message : String(e)}`
      );
      return false;
    }
    try {
      const res = await fetchImpl(mediaUrl('media/internal/retention-changed'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_SECRET ?? '',
        },
        body: JSON.stringify(handed),
        signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => null)) as { refreshed?: unknown } | null;
      if (res.ok && body?.refreshed === true) {
        this.logger.log(
          `[RETENTION] media-service holds the retention durations at this boot (handed chat reels ${handed.chatReelDays} days, idle files ${handed.idleFileDays} days)`
        );
        return true;
      }
      this.logger.warn(
        `[RETENTION] media-service did not take the retention durations at this boot (HTTP ${res.status}, refreshed=${String(body?.refreshed)})`
      );
      return false;
    } catch (e) {
      this.logger.warn(
        `[RETENTION] the boot notice to media-service failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return false;
    }
  }
}
