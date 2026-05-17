import {
  Controller,
  Post,
  Body,
  Headers,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { PushToken } from '../entities/push-token.entity';

/**
 * Internal-only push dispatch endpoint — called by other services (e.g. social-service)
 * to send FCM notifications without duplicating Firebase Admin SDK setup.
 *
 * NOT exposed through Nginx: only reachable via Docker-internal networking.
 * Auth: X-Internal-Secret header matched against INTERNAL_SECRET env var.
 */
@Controller('internal')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);
  private readonly secret = process.env.INTERNAL_SECRET ?? '';

  constructor(
    @InjectRepository(PushToken)
    private readonly pushTokenRepo: Repository<PushToken>,
  ) {}

  @Post('push/notify')
  async notifyUser(
    @Headers('x-internal-secret') headerSecret: string,
    @Body()
    body: {
      userId: string;
      title: string;
      body: string;
      data?: Record<string, string>;
    },
  ) {
    // Constant-time comparison to prevent timing attacks on the shared secret.
    const expected = Buffer.from(this.secret);
    const received = Buffer.from(headerSecret ?? '');
    if (
      expected.length === 0 ||
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException();
    }

    if (admin.apps.length === 0) {
      this.logger.warn('[INTERNAL_PUSH] Firebase not initialized — skipping');
      return { sent: 0, failed: 0 };
    }

    const { userId, title, body: notifBody, data = {} } = body;
    if (!userId || !title) return { sent: 0, failed: 0 };

    const tokens = await this.pushTokenRepo.find({ where: { userId } });
    let sent = 0;
    let failed = 0;

    for (const pt of tokens) {
      try {
        await admin.messaging().send({
          token: pt.token,
          notification: { title, body: notifBody },
          data: { ...data, title, body: notifBody },
          android: {
            priority: 'high',
            notification: { channelId: 'canari_messages' },
          },
          apns: { payload: { aps: { sound: 'default' } } },
        });
        sent++;
      } catch (e) {
        failed++;
        const code =
          typeof e === 'object' && e && 'code' in e
            ? String((e as any).code)
            : '';
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          await this.pushTokenRepo.delete({ id: pt.id }).catch(() => {});
        }
        this.logger.warn(
          `[INTERNAL_PUSH] Failed user=${userId} device=${pt.deviceId}: ${String(e)}`,
        );
      }
    }

    this.logger.log(
      `[INTERNAL_PUSH] user=${userId} sent=${sent} failed=${failed}`,
    );
    return { sent, failed };
  }
}
