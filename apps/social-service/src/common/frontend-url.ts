import { Logger, ServiceUnavailableException } from '@nestjs/common';

const logger = new Logger('FrontendUrl');

/**
 * The app's public origin, for a link this service writes INTO a document someone keeps (a
 * calendar file's URL): the FIRST entry of `FRONTEND_URL`, which is a comma-separated list
 * (`cors-origins.ts`), its trailing slash dropped.
 *
 * NO FALLBACK. An unset `FRONTEND_URL` is a deployment fault, and a link to `http://localhost`
 * written into somebody's agenda would outlive the fix; so the request is refused, 503, and the
 * fault is logged where an operator reads it.
 */
export function frontendBaseUrl(): string {
  const first = (process.env.FRONTEND_URL ?? '').split(',')[0]?.trim().replace(/\/+$/, '') ?? '';
  if (!first) {
    logger.error('[CONFIG] FRONTEND_URL is unset: no link back to the app can be written');
    throw new ServiceUnavailableException({ code: 'frontend-url-unset' });
  }
  return first;
}
