import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { verifyInternalToken } from './internal-token';

/**
 * Validates that the request was forwarded by nginx with a valid X-User-Id header.
 * Also verifies the per-minute HMAC token in X-Internal-Token to ensure the request
 * genuinely came through nginx and not from a compromised container on the Docker network.
 *
 * FAILS CLOSED IN EVERY ENVIRONMENT (2026-10-17): an unset INTERNAL_SHARED_SECRET used to skip the
 * HMAC outside production, so a bare `X-User-Id` was accepted as proof of itself. Every estate
 * that runs this service already sets the secret (the deploy manifest, the local compose, the CI
 * boot job), and a test that wants the guard supplies one.
 */
@Injectable()
export class NginxAuthGuard implements CanActivate {
  /** Returns true when X-User-Id is present and X-Internal-Token verifies under the configured secret. */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = (request.headers['x-user-id'] as string | undefined)?.trim().toLowerCase();
    if (!userId) {
      throw new UnauthorizedException(
        'Missing X-User-Id header - ensure the request passes through nginx auth.'
      );
    }

    const internalSecret = process.env.INTERNAL_SHARED_SECRET?.trim();

    // Security: fail closed in EVERY environment - INTERNAL_SHARED_SECRET is required
    if (!internalSecret) {
      Logger.error('[AUTH_GUARD] INTERNAL_SHARED_SECRET is not configured - refusing the request');
      throw new UnauthorizedException(
        'INTERNAL_SHARED_SECRET is not configured — service cannot verify internal requests'
      );
    }

    verifyInternalToken(request.headers, userId, internalSecret);

    return true;
  }
}
