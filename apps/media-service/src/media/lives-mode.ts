import { ServiceUnavailableException, type Logger } from '@nestjs/common';

/**
 * The lives kill switch as media-service learns it (owner, 2026-10-21).
 *
 * `platform_config.lives_mode` is owned by core-service (migration 015) and read from the database
 * by social-service; media-service has no database, so it asks social-service's internal relay
 * (`GET /api/internal/lives/mode`, `InternalLivesModeController`) on EVERY live segment request that
 * reaches it. No cache here: the public segment route is behind nginx's own `live_segments` cache,
 * so this runs once per segment per cache miss (two minutes for a served segment, ten seconds for a
 * refusal), and the store route once per ingested segment - a Docker-network hop each, cheaper than
 * a cache whose expiry a kill would have to wait out.
 *
 * The same two values as core's `LivesMode` and social-service's `lives-mode.ts`, held together by
 * the column's CHECK constraint (asserted across every copy by the frontend's `livesModesAgree.test.ts`).
 */
export type LivesMode = 'off' | 'on';

/** The two values, the same list as the column's CHECK. */
export const LIVES_MODES: readonly LivesMode[] = ['off', 'on'];

/** How long the relay may take, in milliseconds: a Docker-network hop, so anything slower is a failure. */
export const LIVES_MODE_TIMEOUT_MS = 2_000;

/** Every Nest service in this repo serves its routes under this prefix (each `main.ts`). */
const GLOBAL_PREFIX = 'api';

/**
 * The relay's URL on social-service, the global prefix inserted exactly once - the convention of
 * social-service's `service-urls.ts` (an operator who appends `/api` to the base must not produce
 * `/api/api/...`). The default is the service's name on the compose network, as every other
 * internal base in this repo.
 */
export function livesModeUrl(): string {
  const base = (process.env.SOCIAL_SERVICE_URL ?? 'http://social-service:3014').replace(/\/+$/, '');
  const withPrefix = base.endsWith(`/${GLOBAL_PREFIX}`) ? base : `${base}/${GLOBAL_PREFIX}`;
  return `${withPrefix}/internal/lives/mode`;
}

/**
 * The mode social-service reads RIGHT NOW. FAILS CLOSED: an unreachable relay, a non-2xx answer or a
 * timeout throw a 503 (logged at warn with the cause - the live segment is not served, and nginx
 * does not cache a 503), and a value outside the two throws. A switch that cannot be read is never
 * read as open.
 */
export async function fetchLivesMode(logger: Logger): Promise<LivesMode> {
  let res: Response;
  try {
    res = await fetch(livesModeUrl(), {
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
      signal: AbortSignal.timeout(LIVES_MODE_TIMEOUT_MS),
    });
  } catch (e) {
    logger.warn(
      `[LIVE] the lives kill switch could not be read from social-service: ${e instanceof Error ? e.message : String(e)} - refused`
    );
    throw new ServiceUnavailableException();
  }
  if (!res.ok) {
    logger.warn(`[LIVE] social-service answered ${res.status} for the lives kill switch - refused`);
    throw new ServiceUnavailableException();
  }
  const body = (await res.json()) as { mode?: unknown };
  const mode = LIVES_MODES.find((known) => known === body?.mode);
  if (!mode) {
    throw new Error(`social-service relayed an unknown lives mode: ${String(body?.mode)}`);
  }
  return mode;
}
