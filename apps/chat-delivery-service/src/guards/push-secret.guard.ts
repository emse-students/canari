import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { PushToken } from '../entities/push-token.entity';
import { sanitizeQueryValue } from '../utils/sanitize';

/**
 * The request field {@link PushSecretGuard} writes once the PushSecret is proven: the user it
 * authenticated, for the guards after it (the per-user throttler). Never read from the client.
 */
export const PUSH_SECRET_USER = 'pushSecretUserId';

/**
 * Verifies a `PushSecret` header against the secret stored for `userId:deviceId`, and throws a
 * `403` on any failure. THE one implementation: the push controller's routes and
 * {@link PushSecretGuard} both call it.
 *
 * A legacy plaintext secret is accepted once and migrated to its SHA-256 on the spot.
 */
export async function verifyPushSecret(
  pushTokenRepo: Repository<PushToken>,
  logger: Logger,
  authHeader: string | undefined,
  userId: string,
  deviceId: string
): Promise<void> {
  const secret = authHeader?.startsWith('PushSecret ')
    ? authHeader.slice('PushSecret '.length).trim()
    : null;
  if (!secret) {
    logger.warn(`[PUSH_SECRET] rejected user=${userId} device=${deviceId} reason=header_missing`);
    throw new ForbiddenException('PushSecret header required');
  }
  const pt = await pushTokenRepo.findOne({ where: { userId, deviceId } });
  const stored = pt?.pushSecret;
  if (!stored) {
    logger.warn(`[PUSH_SECRET] rejected user=${userId} device=${deviceId} reason=no_stored_secret`);
    throw new ForbiddenException('Invalid push secret');
  }

  // Try SHA-256 hash first (new format)
  const hashed = crypto.createHash('sha256').update(secret).digest('hex');
  if (stored.length === hashed.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(hashed, 'utf8'))) {
        return; // OK - new format
      }
    } catch {
      /* fall through */
    }
  }

  // Legacy plaintext, backward-compatible and migrated on first sight.
  try {
    if (
      stored.length === secret.length &&
      crypto.timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(secret, 'utf8'))
    ) {
      await pushTokenRepo.update({ userId, deviceId }, { pushSecret: hashed });
      logger.log(`[PUSH_SECRET] migrated to hash for ${userId}:${deviceId}`);
      return; // OK - legacy format, now migrated
    }
  } catch {
    /* fall through */
  }

  logger.warn(`[PUSH_SECRET] rejected user=${userId} device=${deviceId} reason=mismatch`);
  throw new ForbiddenException('Invalid push secret');
}

/**
 * Proves the PushSecret of a route that names the device (`userId`, `deviceId`) - in its BODY, or
 * in its QUERY for a GET (`mls/push/wake`) - BEFORE any
 * guard that counts per user - so a quota is spent only by the device that holds the secret, and a
 * stranger naming someone's ids is refused before it can exhaust theirs.
 */
@Injectable()
export class PushSecretGuard implements CanActivate {
  private readonly logger = new Logger(PushSecretGuard.name);

  constructor(
    @InjectRepository(PushToken)
    private readonly pushTokenRepo: Repository<PushToken>
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    const headers = (req.headers ?? {}) as Record<string, string | undefined>;
    // A GET has no body: its route names the device in the query. Every other verb, in the body.
    // One source per verb, never a merge - a guard that proved one pair while the handler read the
    // other would open the second pair's queue.
    const source = ((req.method === 'GET' ? req.query : req.body) ?? {}) as Record<string, unknown>;
    const userId = sanitizeQueryValue(source.userId ?? '', 'userId');
    const deviceId = sanitizeQueryValue(source.deviceId ?? '', 'deviceId');
    await verifyPushSecret(
      this.pushTokenRepo,
      this.logger,
      headers.authorization,
      userId,
      deviceId
    );
    req[PUSH_SECRET_USER] = userId.toLowerCase();
    return true;
  }
}
