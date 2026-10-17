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
 * Validates that the `X-User-Id` header is present on the request.
 *
 * In production, this header is injected by nginx after a successful
 * `auth_request` sub-request, so its presence guarantees the caller is
 * authenticated. It must never be accepted from untrusted clients directly.
 *
 * THERE IS NO "LOCAL DEV WITHOUT NGINX", WHICH IS WHY THIS GUARD NO LONGER DECODES A JWT. Until
 * 2026-09-18 the non-production path read an unverified Bearer token, trusted its `sub` claim and
 * forwarded it as `x-user-id` - a signature nobody checked deciding who the caller is. It was kept
 * because `frontend/vite.config.js` was believed to send one route, bare `/channels`, straight to
 * `social-service:3014` past nginx.
 *
 * THAT ROUTE DID NOT EXIST. This service mounts `setGlobalPrefix('api')` over `@Controller('channels')`,
 * so the only path it has ever served is `/api/channels/...`; no line of the frontend requests the
 * bare one; and the proxy rule therefore pointed a path nobody asks for at a service that would have
 * refused it. Every `/api/*` call in local development goes through the local nginx, whose
 * `/api/channels` location sets `X-User-Id` exactly as production's does. The branch guarded a door
 * onto nothing, so it is deleted rather than routed - a fallback is a signal, never a path.
 */
@Injectable()
export class NginxAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = (request.headers['x-user-id'] as string | undefined)?.trim().toLowerCase();

    // FAILS CLOSED IN EVERY ENVIRONMENT (2026-10-17). The secret is required and the per-minute HMAC
    // is verified whatever NODE_ENV says: outside production this used to take the bare `X-User-Id`
    // on trust, and an unset NODE_ENV was refused only because the mode could not be guessed. With
    // one rule for all modes the mode no longer matters. The local nginx is the same file as
    // production's and forwards `X-Internal-Token` on every route this service serves, and the
    // local compose, the dev estate and the CI boot job all set the secret.
    const internalSecret = process.env.INTERNAL_SHARED_SECRET?.trim();
    if (!internalSecret) {
      Logger.error('[AUTH_GUARD] INTERNAL_SHARED_SECRET is not configured - refusing the request');
      throw new UnauthorizedException(
        'INTERNAL_SHARED_SECRET is not configured - service cannot verify internal requests'
      );
    }
    if (!userId) {
      throw new UnauthorizedException(
        'Missing X-User-Id header - ensure the request passes through nginx auth.'
      );
    }

    // HMAC token validation: proves the request came through nginx with a valid JWT.
    verifyInternalToken(request.headers, userId, internalSecret);
    return true;
  }
}
