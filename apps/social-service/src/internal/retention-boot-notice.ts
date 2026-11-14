import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { mediaUrl } from './service-urls';

/** A Docker-network hop: anything slower is a failure, logged. */
const NOTICE_TIMEOUT_MS = 5_000;

/**
 * At this service's boot, tells media-service to re-read the retention durations it holds
 * (docs/wiki/retention-settings.md). The deploy replaces social-service AFTER media-service
 * (`depends_on`), so a media-service that booted beside an older social-service - one without
 * `GET /api/internal/retention`, on the release that introduced it - holds nothing until this
 * notice reaches it. Sent beside the boot, never in its way; a failure is logged and changes nothing
 * here (media-service still asks on its next upload that finds nothing held).
 */
@Injectable()
export class RetentionBootNotice implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetentionBootNotice.name);

  onApplicationBootstrap(): void {
    void this.send();
  }

  /** The notice itself; resolves true when media-service re-read. Never rejects. */
  async send(fetchImpl: typeof fetch = fetch): Promise<boolean> {
    try {
      const res = await fetchImpl(mediaUrl('media/internal/retention-changed'), {
        method: 'POST',
        headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
        signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => null)) as { refreshed?: unknown } | null;
      if (res.ok && body?.refreshed === true) {
        this.logger.log('[RETENTION] media-service re-read the retention durations at this boot');
        return true;
      }
      this.logger.warn(
        `[RETENTION] media-service did not re-read the retention durations at this boot (HTTP ${res.status}, refreshed=${String(body?.refreshed)})`
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
