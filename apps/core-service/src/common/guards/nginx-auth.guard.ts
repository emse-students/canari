import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { verifyInternalToken } from './internal-token';

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
    const userId = (request.headers['x-user-id'] as string | undefined)?.trim().toLowerCase();
    if (!userId) {
      throw new UnauthorizedException(
        'Missing X-User-Id header - ensure the request passes through nginx auth.'
      );
    }

    const internalSecret = process.env.INTERNAL_SHARED_SECRET?.trim();

    // Security: fail closed in production — INTERNAL_SHARED_SECRET is required
    if (!internalSecret && process.env.NODE_ENV === 'production') {
      throw new UnauthorizedException(
        'INTERNAL_SHARED_SECRET is not configured — service cannot verify internal requests'
      );
    }

    if (internalSecret) {
      verifyInternalToken(request.headers, userId, internalSecret);
    }

    return true;
  }
}
