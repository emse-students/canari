import { coreUrl } from './service-urls';

/**
 * core-service did not confirm it ended the sessions of a revoked device. Typed so the device
 * delete answers it as a 5xx (the delete is idempotent and is retried), never by reading prose.
 */
export class DeviceSessionsNotEndedError extends Error {
  constructor(readonly detail: string) {
    super(`core-service did not end the device's sessions: ${detail}`);
    this.name = 'DeviceSessionsNotEndedError';
  }
}

/**
 * Asks core-service to end every session of `userId` bound to `deviceId`, except the caller's own
 * session `exceptSessionId` (core-service `InternalSessionsController`). Returns how many ended.
 *
 * Throws {@link DeviceSessionsNotEndedError} on every way it can fail - the secret unset, core
 * unreachable, a non-2xx, an unreadable body - because the owner's revocation is not complete
 * until the sessions are gone, and the caller must say so rather than answer success.
 */
export async function endDeviceSessions(
  userId: string,
  deviceId: string,
  exceptSessionId: string | null
): Promise<number> {
  const secret = process.env.INTERNAL_SECRET ?? '';
  if (!secret) throw new DeviceSessionsNotEndedError('INTERNAL_SECRET unset');
  const path =
    `internal/sessions/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}` +
    (exceptSessionId ? `?exceptSession=${encodeURIComponent(exceptSessionId)}` : '');
  let res: globalThis.Response;
  try {
    res = await fetch(coreUrl(path), {
      method: 'DELETE',
      headers: { 'x-internal-secret': secret },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    throw new DeviceSessionsNotEndedError(
      `unreachable ${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`
    );
  }
  if (!res.ok) throw new DeviceSessionsNotEndedError(`status=${res.status}`);
  let ended: unknown;
  try {
    ended = ((await res.json()) as { ended?: unknown }).ended;
  } catch (e) {
    throw new DeviceSessionsNotEndedError(
      `unreadable body ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (typeof ended !== 'number') throw new DeviceSessionsNotEndedError('no ended count');
  return ended;
}
