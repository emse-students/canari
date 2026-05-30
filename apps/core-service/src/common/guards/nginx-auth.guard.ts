import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Validates that the request was forwarded by nginx with a valid X-User-Id header.
 * When INTERNAL_SHARED_SECRET is set, also verifies the per-minute HMAC token
 * in X-Internal-Token to ensure the request genuinely came through nginx and
 * not from a compromised container on the Docker network.
 */
@Injectable()
export class NginxAuthGuard implements CanActivate {
  /** Returns true when X-User-Id is present (and X-Internal-Token is valid if secret is configured). */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = (request.headers['x-user-id'] as string | undefined)
      ?.trim()
      .toLowerCase();
    if (!userId) {
      throw new UnauthorizedException(
        'Missing X-User-Id header - ensure the request passes through nginx auth.',
      );
    }

    const internalSecret = process.env.INTERNAL_SHARED_SECRET?.trim();
    if (internalSecret) {
      verifyInternalToken(request, userId, internalSecret);
    }

    return true;
  }
}

/**
 * Verifies the X-Internal-Token header against the expected HMAC-SHA256 value.
 * Accepts tokens from the current or previous minute to tolerate clock skew.
 * Throws UnauthorizedException on failure.
 */
export function verifyInternalToken(
  request: Request,
  userId: string,
  secret: string,
): void {
  const token = (
    request.headers['x-internal-token'] as string | undefined
  )?.trim();
  if (!token) {
    throw new UnauthorizedException('Missing X-Internal-Token header');
  }
  const epochMinute = Math.floor(Date.now() / 60000);
  const valid = [epochMinute, epochMinute - 1].some((min) => {
    const expected = createHmac('sha256', secret)
      .update(`${userId}:${min}`)
      .digest('hex');
    try {
      return timingSafeEqual(
        Buffer.from(token, 'hex'),
        Buffer.from(expected, 'hex'),
      );
    } catch {
      return false;
    }
  });
  if (!valid) {
    throw new UnauthorizedException('Invalid X-Internal-Token');
  }
}
