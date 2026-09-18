import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

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

    // In production, verify the authenticity of the nginx request.
    // Security: reject requests when NODE_ENV is unset (ambiguous mode)
    if (!process.env.NODE_ENV) {
      throw new UnauthorizedException('NODE_ENV must be set to "production" or "development"');
    }

    if (process.env.NODE_ENV === 'production') {
      // FAIL CLOSED, as `core-service` and `chat-delivery-service` already do. This service was the
      // one that did not, and what it fell back to was not a weaker check but NO check: the branch
      // below used to read `NGINX_AUTH_SECRET`, a variable NOTHING sets - not a compose file, not an
      // env template, not the nginx config, and not the production container (measured 2026-09-17,
      // which reports `INTERNAL_SHARED_SECRET` and `NODE_ENV` and no third name). So its `if` never
      // fired, the else-branch did nothing at all, and control reached `if (userId) return true` -
      // meaning that with the real secret absent, any request carrying an `X-User-Id` header was
      // accepted on the strength of that header alone. It is deleted rather than repaired: a
      // fallback is a signal and never a path, and this one had already decayed into an open door.
      const internalSecret = process.env.INTERNAL_SHARED_SECRET?.trim();
      if (!internalSecret) {
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
      const token = (request.headers['x-internal-token'] as string | undefined)?.trim();
      if (!token) {
        throw new UnauthorizedException('Missing X-Internal-Token header');
      }
      const epochMinute = Math.floor(Date.now() / 60000);
      const valid = [epochMinute, epochMinute - 1].some((min) => {
        const expected = createHmac('sha256', internalSecret)
          .update(`${userId}:${min}`)
          .digest('hex');
        try {
          return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
        } catch {
          return false;
        }
      });
      if (!valid) {
        throw new UnauthorizedException('Invalid X-Internal-Token');
      }
      return true;
    }

    // Outside production the local nginx is STILL in the path - see the class docblock - so the
    // header it sets is read the same way, and a caller that arrives without it has bypassed it.
    //
    // WHAT IS DELIBERATELY NOT ASSERTED HERE IS THE HMAC, and that is the one thing local still
    // takes on trust where production does not. Requiring `X-Internal-Token` outside production is
    // an access-rule change across three services with three different policies, parked as such in
    // `docs/wiki/backlog.md`; it is not smuggled in behind this deletion.
    if (userId) {
      return true;
    }
    throw new UnauthorizedException(
      'Missing X-User-Id header - ensure the request passes through the local nginx.'
    );
  }
}
