import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { chatDeliveryUrl } from '../internal/service-urls';
import { describeHttpError } from '../common/http-error-log';

/**
 * How long one call to chat-delivery-service may take. Bounded because nothing awaits it on the
 * user's path, and an unbounded call would hold a socket for a service that is down.
 */
const CALL_TIMEOUT_MS = 10_000;

/**
 * Asks chat-delivery-service to end ONE device's push registration because the session that device
 * was signed in with has ended - the server half of "a sign-out ends the device's push
 * registration" (`docs/wiki/sessions.md`).
 *
 * The push token row lives in chat-delivery-service, the session row here; nothing joins them but
 * `auth_sessions."deviceId"`, which is why the call carries the device the ended session named.
 * Through `INTERNAL_SECRET`, the one service-to-service credential (`internal-secret.util.ts`).
 *
 * WHAT A FAILED CALL LEAVES, said so the error line can be read: the device deletes its own token at
 * every sign-out it runs (`push_registration.rs`), and FCM refusing a deleted token makes the
 * dispatcher drop the row at the next send. A call lost here AND a device that never ran its
 * sign-out (offline for good, uninstalled) is the one case where the row stays.
 */
@Injectable()
export class SessionPushEndService {
  private readonly logger = new Logger(SessionPushEndService.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';

  /** Ends the device's push registration. Never throws; answers whether chat-delivery said so. */
  async endDevice(userId: string, deviceId: string, cause: string): Promise<boolean> {
    const who = `user=${userId.slice(0, 8)} device=${deviceId}`;
    try {
      const res = await axios.delete<{ removed?: number }>(
        chatDeliveryUrl(
          `internal/push/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}`
        ),
        { headers: { 'x-internal-secret': this.internalSecret }, timeout: CALL_TIMEOUT_MS }
      );
      this.logger.log(
        `[PUSH_SESSION_END] ${who} cause=${cause} removed=${res.data?.removed ?? 'unstated'}`
      );
      return true;
    } catch (err) {
      this.logger.error(
        `[PUSH_SESSION_END] ${who} cause=${cause} - the push registration was NOT ended server-side: ` +
          `${describeHttpError(err)}`
      );
      return false;
    }
  }
}
