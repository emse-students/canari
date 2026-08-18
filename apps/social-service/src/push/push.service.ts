import { Injectable, Logger } from '@nestjs/common';
import { DELIVERY_TIMEOUT_MS, deliveryUrl } from '../internal/service-urls';
import { pushContentData, type PushContent } from './push-content';

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
   */
  async notifyContent(
    userId: string,
    content: PushContent,
    data: Record<string, string> = {}
  ): Promise<void> {
    await this.notify(userId, content.legacyTitle, content.legacyBody, {
      ...data,
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
      this.logger.warn(`[PUSH] notify failed for user=${userId}`, e);
    }
  }
}
