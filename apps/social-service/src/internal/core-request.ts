import { Logger } from '@nestjs/common';

const logger = new Logger('CoreRequest');

/**
 * Axios options for a server-to-server call to core-service's payment routes.
 *
 * These calls go straight to core-service, past nginx, so `NginxAuthGuard` has no `X-User-Id` to
 * read; the shared internal secret is what authenticates the caller. A missing secret is logged
 * where it is read, because core answers 403 with no body and that is all the caller would see.
 */
export function internalCoreRequestConfig(): {
  maxRedirects: number;
  headers: Record<string, string>;
} {
  const secret = process.env.INTERNAL_SECRET?.trim() ?? '';
  if (!secret) {
    logger.warn('INTERNAL_SECRET is not set - core-service payment calls will be refused');
  }
  return { maxRedirects: 0, headers: secret ? { 'x-internal-secret': secret } : {} };
}
