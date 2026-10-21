import { Logger } from '@nestjs/common';

const logger = new Logger('ClientAddress');

/**
 * The address of the VISITOR behind a request - the one person-naming address this service sees.
 *
 * `req.ip` is the nginx container for every request (this service is only reached through it), so
 * it names a hop, not a person. nginx resolves the client itself (`real_ip` from the host proxy,
 * 2026-09-30) and forwards it as `X-Real-IP`, overwriting whatever a caller sent; the service port
 * is not published, so no caller reaches it any other way. A request with no header did not come
 * through nginx - a test, or a local call - and is keyed on the socket, said out loud, because in
 * production it would mean every visitor shares one address.
 *
 * Shared by the per-visitor throttle (`ClientIpThrottlerGuard`) and the per-visitor ceiling of a
 * public form's unpaid answers (`guest-visitor.ts`), so the two can never disagree on who a
 * visitor is.
 */
export function clientAddress(req: {
  headers?: Record<string, unknown>;
  ip?: string;
  method?: string;
  url?: string;
}): string {
  const forwarded = req.headers?.['x-real-ip'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded;
  logger.warn(`[ADDRESS] no X-Real-IP on ${req.method} ${req.url}, keyed on the socket`);
  return req.ip ?? '';
}
