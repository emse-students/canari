import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { verifyInternalToken } from './internal-token';

/**
 * NestJS guard that enforces authentication by inspecting the `x-user-logged-in`
 * HTTP header. This header is injected by Nginx after it validates the request
 * against the core-service auth endpoint (`/internal/auth/verify`). If the header
 * is `"true"` AND the per-minute HMAC `X-Internal-Token` verifies for `x-user-id` the request is
 * allowed through; otherwise (an unset INTERNAL_SHARED_SECRET included) a 401 is thrown.
 *
 * This guard must never be used on routes that are intentionally public - those
 * should be excluded from Nginx's `auth_request` directive instead.
 */
@Injectable()
export class HeaderAuthGuard implements CanActivate {
  private readonly logger = new Logger(HeaderAuthGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const loggedIn = request.headers['x-user-logged-in'];

    if (loggedIn !== 'true') {
      const path = String(request?.originalUrl ?? request?.url ?? 'unknown');
      if (path.includes('/push/')) {
        this.logger.warn(
          `[AUTH_GUARD] denied ${String(request?.method ?? 'UNKNOWN')} ${path} ` +
            `x-user-logged-in=${String(loggedIn ?? '')} ` +
            `x-user-id=${String(request?.headers?.['x-user-id'] ?? '')} ` +
            `hasAuth=${request?.headers?.authorization ? 'yes' : 'no'}`
        );
      }
      throw new UnauthorizedException('User is not authenticated');
    }

    // x-user-logged-in is a plain header: nginx sets it, but so can any caller that reaches this
    // container, so it proves nothing by itself. The per-minute HMAC nginx mints for the user is the
    // proof, and it is required in EVERY environment (CodeQL 2547, 2026-10-09: it used to be skipped
    // when the secret was unset outside production, leaving the header alone as the credential).
    const internalSecret = process.env.INTERNAL_SHARED_SECRET?.trim();
    if (!internalSecret) {
      this.logger.error(
        '[AUTH_GUARD] INTERNAL_SHARED_SECRET is not configured - refusing every guarded request'
      );
      throw new UnauthorizedException(
        'INTERNAL_SHARED_SECRET is not configured - service cannot verify internal requests'
      );
    }

    const userId = (request.headers['x-user-id'] as string | undefined)?.trim().toLowerCase() ?? '';
    if (!userId) {
      throw new UnauthorizedException('Missing X-User-Id header');
    }
    verifyInternalToken(request.headers, userId, internalSecret);

    return true;
  }
}
