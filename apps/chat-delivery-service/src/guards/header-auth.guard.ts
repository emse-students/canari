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
 * is `"true"` the request is allowed through; otherwise a 401 is thrown.
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

    // When INTERNAL_SHARED_SECRET is configured, verify the per-minute HMAC token
    // to ensure the request came through nginx and not from a compromised container.
    const internalSecret = process.env.INTERNAL_SHARED_SECRET?.trim();

    // Security: fail closed in production — INTERNAL_SHARED_SECRET is required
    if (!internalSecret && process.env.NODE_ENV === 'production') {
      throw new UnauthorizedException(
        'INTERNAL_SHARED_SECRET is not configured — service cannot verify internal requests'
      );
    }

    if (internalSecret) {
      const userId =
        (request.headers['x-user-id'] as string | undefined)?.trim().toLowerCase() ?? '';
      verifyInternalToken(request.headers, userId, internalSecret);
    }

    return true;
  }
}
