import { Injectable, Logger } from '@nestjs/common';

/**
 * Fire-and-forget FCM dispatcher.
 * Calls the chat-delivery-service internal endpoint so that Firebase Admin SDK
 * is only initialised in one place (chat-delivery-service).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly deliveryUrl =
    process.env.DELIVERY_INTERNAL_URL ?? 'http://chat-delivery-service:3010';
  private readonly secret = process.env.INTERNAL_SECRET ?? '';

  constructor() {
    if (!this.secret) {
      this.logger.warn(
        '[PUSH] INTERNAL_SECRET non défini - les notifications FCM de ce service sont désactivées'
      );
    }
  }

  async notify(
    userId: string,
    title: string,
    body: string,
    data: Record<string, string> = {}
  ): Promise<void> {
    if (!this.secret) return;
    try {
      const res = await fetch(`${this.deliveryUrl}/internal/push/notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.secret,
        },
        body: JSON.stringify({ userId, title, body, data }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        this.logger.warn(`[PUSH] notify HTTP ${res.status} for user=${userId}`);
      }
    } catch (e: unknown) {
      this.logger.warn(`[PUSH] notify failed for user=${userId}`, e);
    }
  }
}
