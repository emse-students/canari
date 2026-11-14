import { ServiceUnavailableException, type Logger } from '@nestjs/common';

/**
 * The retention durations media-service stamps (owner, 2026-11-14; docs/wiki/retention-settings.md).
 *
 * `platform_config.retention_chat_reel_days` and `retention_idle_media_days` are owned by core-service
 * (migration 025, moved at `/admin/platform`) and read from the database by social-service;
 * media-service has no database, so it asks social-service's internal relay
 * (`GET /api/internal/retention`, `InternalRetentionController`) at each upload or chat hold that
 * needs one - the `lives-mode.ts` pattern. No cache: a change holds from the next upload, and the
 * value is stamped on the file's index entry at that moment, so a lowered duration applies to new
 * files only.
 */
export type MediaRetentionDays = {
  /** A CanaReel sent in a conversation (`chat-reel`), from its upload or its chat hold. */
  chatReelDays: number;
  /** A file sent in a conversation (`ephemeral`), from its last download. */
  idleMediaDays: number;
};

/** How long the relay may take, in milliseconds: a Docker-network hop, so anything slower is a failure. */
export const RETENTION_RELAY_TIMEOUT_MS = 2_000;

/** Every Nest service in this repo serves its routes under this prefix (each `main.ts`). */
const GLOBAL_PREFIX = 'api';

/** The relay's URL on social-service, the global prefix inserted exactly once (as `livesModeUrl`). */
export function retentionUrl(): string {
  const base = (process.env.SOCIAL_SERVICE_URL ?? 'http://social-service:3014').replace(/\/+$/, '');
  const withPrefix = base.endsWith(`/${GLOBAL_PREFIX}`) ? base : `${base}/${GLOBAL_PREFIX}`;
  return `${withPrefix}/internal/retention`;
}

/** A whole number of days of at least one, or an error naming the field. */
function wholeDays(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`social-service relayed an unusable ${name}: ${String(value)}`);
  }
  return value;
}

/**
 * The durations social-service reads RIGHT NOW. AN UNREADABLE VALUE IS AN ERROR, NEVER A DEFAULT: an
 * unreachable relay, a non-2xx answer or a timeout throw a 503 (logged at warn with the cause - the
 * upload is refused before a byte is stored), and a value that is not a positive whole number throws.
 */
export async function fetchMediaRetention(logger: Logger): Promise<MediaRetentionDays> {
  let res: Response;
  try {
    res = await fetch(retentionUrl(), {
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
      signal: AbortSignal.timeout(RETENTION_RELAY_TIMEOUT_MS),
    });
  } catch (e) {
    logger.warn(
      `[RETENTION] the retention durations could not be read from social-service: ${e instanceof Error ? e.message : String(e)} - refused`
    );
    throw new ServiceUnavailableException();
  }
  if (!res.ok) {
    logger.warn(
      `[RETENTION] social-service answered ${res.status} for the retention durations - refused`
    );
    throw new ServiceUnavailableException();
  }
  const body = (await res.json()) as { chatReelDays?: unknown; idleMediaDays?: unknown };
  return {
    chatReelDays: wholeDays(body?.chatReelDays, 'chatReelDays'),
    idleMediaDays: wholeDays(body?.idleMediaDays, 'idleMediaDays'),
  };
}
