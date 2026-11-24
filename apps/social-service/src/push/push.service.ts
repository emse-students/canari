import { Injectable, Logger } from '@nestjs/common';
import { clientVersionAtLeast } from '../common/client-version';
import { describeError, errorNameOf } from '../common/log.utils';
import { DELIVERY_TIMEOUT_MS, deliveryUrl } from '../internal/service-urls';
import { MIN_APP_VERSION_DATA_KEY, PUSH_KEY_MIN_CLIENT } from './notification-client-floor';
import { pushContentData, type PushContent } from './push-content';
import { socialDeepLink } from './push-target';

/** One line for a failed delivery call: its name and message, and the budget a timeout ran out of. */
export function describePushFailure(e: unknown): string {
  const detail = describeError(e);
  // Classified on the error's own type, never on the text of its message.
  return errorNameOf(e) === 'TimeoutError'
    ? `${detail} (chat-delivery did not answer within ${DELIVERY_TIMEOUT_MS} ms)`
    : detail;
}

/**
 * Fire-and-forget FCM dispatcher.
 * Calls the chat-delivery-service internal endpoint so that Firebase Admin SDK
 * is only initialised in one place (chat-delivery-service).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly secret = process.env.INTERNAL_SECRET ?? '';

  constructor() {
    if (!this.secret) {
      this.logger.warn(
        '[PUSH] INTERNAL_SECRET not set - FCM notifications from this service are disabled'
      );
    }
  }

  /**
   * Sends one push whose sentence the DEVICE composes, in the reader's own language.
   *
   * The single seam through which every server-side notification now goes: the key and its two
   * data pieces travel in the payload, and `legacyTitle` / `legacyBody` ride along only for clients
   * built before 2026-08-19 that read those fields and know nothing of `contentKey`. When that shim
   * is removed this method stops passing them and `notify` below can take an empty title and body,
   * exactly as the MESSAGE push path already does.
   *
   * THE KEY'S FLOOR IS WRITTEN HERE, and only here (`notification-client-floor.ts`): the first build
   * whose native tables compose `content.key` travels as `minAppVersion`, and chat-delivery skips a
   * device registered below it - so no caller can ring a phone too old to compose its push, and no
   * caller has to remember to say so. It is written AFTER `data`: a caller cannot lower it, and a
   * caller may RAISE it (a post's quiet update, `POST_ACTIVITY_QUIET_MIN_CLIENT_VERSION`) - the
   * higher of the two travels.
   */
  async notifyContent(
    userId: string,
    content: PushContent,
    data: Record<string, string> = {}
  ): Promise<void> {
    const keyFloor = PUSH_KEY_MIN_CLIENT[content.key];
    const asked = data[MIN_APP_VERSION_DATA_KEY];
    const floor =
      keyFloor && asked
        ? clientVersionAtLeast(asked, keyFloor)
          ? asked
          : keyFloor
        : (keyFloor ?? asked);
    await this.notify(userId, content.legacyTitle, content.legacyBody, {
      // The tap target, written once here: iOS opens only what the payload names (see push-target).
      deepLink: socialDeepLink(data),
      ...data,
      ...(floor ? { [MIN_APP_VERSION_DATA_KEY]: floor } : {}),
      ...pushContentData(content),
    });
  }

  async notify(
    userId: string,
    title: string,
    body: string,
    data: Record<string, string> = {}
  ): Promise<void> {
    if (!this.secret) return;
    try {
      const res = await fetch(deliveryUrl('internal/push/notify'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.secret,
        },
        body: JSON.stringify({ userId, title, body, data }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`[PUSH] notify HTTP ${res.status} for user=${userId}`);
      }
    } catch (e: unknown) {
      // THE ERROR IS IN THE MESSAGE: as Nest's second argument it is read as the CONTEXT name and
      // prints as a second, unexplained line. A timeout names the budget it ran out of, so the line
      // says chat-delivery did not answer, not that it refused.
      this.logger.warn(`[PUSH] notify failed for user=${userId}: ${describePushFailure(e)}`);
    }
  }
}
