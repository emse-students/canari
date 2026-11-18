import { BadRequestException } from '@nestjs/common';

/** A core-service session id: `auth_sessions.id`, a UUID minted by `randomUUID()`. */
const SESSION_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session id a request names, or null when it names none.
 *
 * Absent or empty means the request carries no verified session: nginx forwards an empty
 * `X-Session-Id` for an anonymous request, and since 2026-11-17 verify answers an access token with no
 * `sid` claim as anonymous too. So an authenticated route never sees null, and each one that needs a
 * session refuses it (`SESSION_UNNAMED`); an internal route decides for itself. A value that is present and not a
 * UUID is refused: core-service only ever mints UUIDs, so such a value did not come from it, and
 * storing it - or deleting by it - would bind a registration to nothing.
 */
export function parseSessionId(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!SESSION_ID_REGEX.test(trimmed)) {
    throw new BadRequestException(`${fieldName} is not a session id`);
  }
  return trimmed.toLowerCase();
}
